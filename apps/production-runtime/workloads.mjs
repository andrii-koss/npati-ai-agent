import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { access, chmod, chown, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

const active = new Map();
const reserved = new Set();
let nextUid = 20000;
const sysValue = name => Number(execFileSync("getconf", [name], { encoding: "utf8" }).trim());
const pageSize = sysValue("PAGESIZE");
const tickMs = 1000 / sysValue("CLK_TCK");
const sampleMs = 100;
const send = (pid, signal) => {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};

function sample() {
  if (!active.size) return;
  const now = performance.now();
  const groups = new Map();
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const uid = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]);
      if (!active.has(uid)) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") continue;
      const group = groups.get(uid) ?? [];
      group.push({ pid: Number(pid), key: `${pid}:${fields[19]}`, cpu: tickMs * (+fields[11] + +fields[12]), rss: pageSize * +fields[21] });
      groups.set(uid, group);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") console.error("Workload accounting:", error.code);
    }
  }
  for (const [uid, workload] of active) {
    const processes = groups.get(uid) ?? [];
    if (workload.stopped) {
      for (const proc of processes) send(proc.pid, "SIGKILL");
      if (workload.exited && !processes.length) active.delete(uid);
      continue;
    }
    const rss = processes.reduce((sum, proc) => sum + proc.rss, 0);
    if (rss > workload.limits.memoryMiB * 1048576) {
      workload.stop(`Memory limit exceeded (${workload.limits.memoryMiB} MiB RSS)`);
      continue;
    }
    const allowance = sampleMs * workload.limits.cpu;
    const used = processes.reduce((sum, proc) => sum + Math.max(0, proc.cpu - (workload.previous.get(proc.key) ?? 0)), 0);
    workload.cpuUsed += used;
    workload.rss = rss;
    workload.previous = new Map(processes.map(proc => [proc.key, proc.cpu]));
    workload.credit = Math.min(allowance, workload.credit + (now - workload.last) * workload.limits.cpu - used);
    workload.last = now;
    const throttle = workload.credit <= 0;
    for (const proc of processes) {
      if (throttle || workload.throttled) send(proc.pid, throttle ? "SIGSTOP" : "SIGCONT");
    }
    workload.throttled = throttle;
  }
}
setInterval(sample, sampleMs).unref();

export function allocateUid() {
  if (nextUid >= 60000) nextUid = 20000;
  while (active.has(nextUid) || reserved.has(nextUid)) nextUid += 1;
  return nextUid++;
}

export function reserveUid(uid, reserve) {
  if (reserve) reserved.add(uid);
  else reserved.delete(uid);
}

export async function setReleaseOwnership(root, uid, writable = false) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("Unsupported file in release");
  if (info.isDirectory()) {
    for (const name of await readdir(root)) await setReleaseOwnership(join(root, name), uid, writable);
  }
  await chown(root, writable ? uid : 0, uid);
  const executable = info.mode & 0o111;
  await chmod(root, info.isDirectory() ? (writable ? 0o700 : 0o750) : (writable ? 0o600 : 0o640) | (executable ? 0o110 : 0));
}

export function launch({ uid, command, args, cwd, temp, limits, log, env = {} }) {
  const child = spawn("/usr/bin/setpriv", [
    "--reuid", String(uid), "--regid", String(uid), "--clear-groups", "--no-new-privs",
    "/usr/bin/prlimit", "--nproc=96:96", "--nofile=512:512", "--fsize=134217728:134217728", "--core=0:0",
    "--", command, ...args,
  ], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: temp, TMPDIR: temp,
      NODE_OPTIONS: `--max-old-space-size=${Math.floor(limits.memoryMiB * 0.65)}`,
      ...env,
    },
  });
  const state = {
    limits, child, previous: new Map(), credit: sampleMs * limits.cpu, last: performance.now(),
    cpuUsed: 0, rss: 0,
    usage: () => ({ cpuUsed: state.cpuUsed, rss: state.rss }),
    stop(reason) {
      if (state.stopped) return;
      state.stopped = true;
      if (reason) log(reason);
      if (child.pid && !state.exited) send(-child.pid, "SIGKILL");
    },
    async stopAndWait() {
      state.stop();
      await state.done;
      for (let attempt = 0; active.get(uid) === state && attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, sampleMs));
      }
      if (active.get(uid) === state) throw new Error("Production processes did not shut down.");
    },
  };
  active.set(uid, state);
  child.stdout.on("data", chunk => log(chunk.toString("utf8")));
  child.stderr.on("data", chunk => log(chunk.toString("utf8")));
  state.done = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => { log(error.message); resolve({ code: null }); });
  }).then(result => {
    state.stop();
    state.exited = true;
    return result;
  });
  return state;
}

export async function runBuild(options) {
  const task = launch(options);
  const timeout = setTimeout(() => task.stop("Build step exceeded 8 minutes"), 480000);
  try {
    const result = await task.done;
    for (let attempt = 0; active.has(options.uid) && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, sampleMs));
    }
    if (active.has(options.uid)) throw new Error("Build processes did not shut down.");
    if (result.code !== 0) throw new Error("Production build failed. See Production logs.");
  } finally {
    clearTimeout(timeout);
  }
}

function probe(socketPath) {
  return new Promise(resolve => {
    const req = request({ socketPath, path: "/", timeout: 1000 }, response => {
      resolve(response.statusCode < 500);
      response.destroy();
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

export async function startApplication({ root, connectionDir, uid, port, limits, log, env, signal }) {
  await rm(connectionDir, { recursive: true, force: true });
  await mkdir(connectionDir, { mode: 0o700 });
  await chown(connectionDir, uid, uid);
  const socketPath = join(connectionDir, "http.sock");
  signal?.throwIfAborted();
  const task = launch({
    uid, cwd: root, temp: connectionDir, limits, log, command: "/usr/local/bin/npm", args: ["start"],
    env: {
      ...env,
      NODE_ENV: "production", HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", PORT: String(port),
      NPATI_APP_SOCKET: socketPath,
      NODE_OPTIONS: `--max-old-space-size=${Math.floor(limits.memoryMiB * 0.65)} --require=/opt/production/unix-listen.cjs`,
    },
  });
  const stop = () => task.stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (let attempt = 0; attempt < 120 && !task.stopped; attempt += 1) {
      if (await probe(socketPath)) return { ...task, socketPath, isRunning: () => !task.stopped };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Application failed its HTTP readiness check. See Production logs.");
  } catch (error) {
    if (!signal?.aborted) task.stop(error.message);
    await task.stopAndWait();
    await rm(connectionDir, { recursive: true, force: true });
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

export async function readPackage(root) {
  if (!(await access(join(root, "package.json")).then(() => true, () => false))) return null;
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}
