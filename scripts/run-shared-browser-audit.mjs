import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const directory = path.resolve("artifacts/coding-agent-audit-2026-10-15");
mkdirSync(directory, { recursive: true });
const stacks = process.argv.includes("--stacks");
if (process.argv.slice(2).some(arg => arg !== "--stacks")) throw new Error("Only --stacks is supported");
const name = "npati-audit-qa-" + randomUUID();
const volume = name + "-projects";
const selection = process.env.NPATI_AUDIT_STACKS ?? "all";
if (!["all", "node", "python", "vite", "next"].includes(selection)) throw new Error("Unsupported audit stack");
const reportFile = stacks ? (selection === "all" ? "live-stacks-browser.json" : selection + "-browser-diagnostic.json") : "shared-browser-qa-live.json";
const runtimeFile = stacks ? (selection === "all" ? "stack-browser-runtime.json" : selection + "-browser-diagnostic-runtime.json") : "shared-browser-runtime.json";
const secret = randomBytes(32).toString("hex");
const docker = (args, timeout = 120000, input) => execFileSync("docker", args, { encoding: "utf8", timeout, windowsHide: true,
  env: { ...process.env, NPATI_SANDBOX_RUNNER_SECRET: secret }, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim();
const evidence = { container: name, image: "npati-audit-shared-runtime:20261016-ws", startedAt: new Date().toISOString(), status: "failed" };
let created = false, volumeCreated = false;
try {
  if (stacks) { docker(["volume", "create", volume]); volumeCreated = true; }
  docker(["run", "--detach", "--name", name, "--read-only", "--cap-drop", "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL", "NET_ADMIN"].flatMap(cap => ["--cap-add", cap]),
    "--security-opt", "no-new-privileges:true", "--security-opt", "seccomp=" + path.resolve("docker/sandbox/project-runtime-seccomp.json"),
    "--security-opt", "apparmor=unconfined", "--security-opt", "systempaths=unconfined",
    "--device", "/dev/net/tun:/dev/net/tun", "--memory", "2g", "--cpus", "2", "--pids-limit", "1024",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", ...(stacks ? ["--mount", "type=volume,source=" + volume + ",target=/projects"] : ["--tmpfs", "/projects:rw,nosuid,nodev,size=512m"]), "--tmpfs", "/runtime-state:rw,nosuid,nodev,size=64m",
    "--env", "NPATI_SANDBOX_RUNNER_SECRET", "--env", "NPATI_PROJECT_RUNTIME_MODE=shared", "--env", "NPATI_SANDBOX_RUNNER_MODE=local",
    "--env", "ALLOWED_HOSTS=registry.npmjs.org", evidence.image]);
  created = true;
  evidence.imageId = docker(["inspect", "--format", "{{.Image}}", name]);
  for (let attempt = 0; ; attempt++) {
    try {
      docker(["exec", name, "node", "-e", "fetch('http://127.0.0.1:7865/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], 10000);
      break;
    } catch (error) { if (attempt >= 29) throw new Error("Audit runtime readiness failed"); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  const verifier = stacks ? "scripts/verify-coding-runtime-live.mjs" : "scripts/verify-shared-browser-qa.mjs";
  const output = stacks ? "/tmp/live-stacks-browser.json" : "/tmp/shared-browser-qa.json";
  try { evidence.execution = docker(["exec", "-i", "-e", "NPATI_SANDBOX_RUNNER_URL=http://127.0.0.1:7865", "-e", "NPATI_AUDIT_OUTPUT=" + output, "-e", "NPATI_AUDIT_STACKS=" + selection, name, "node", "--input-type=module"], stacks ? 900000 : 300000, readFileSync(verifier, "utf8")); }
  finally { writeFileSync(path.join(directory, reportFile), docker(["exec", name, "cat", output])); }
  evidence.status = "passed";
} catch (error) {
  evidence.error = String(error.message).slice(0, 2000);
} finally {
  if (created) {
    try { writeFileSync(path.join(directory, stacks ? "stack-browser-runtime.log" : "shared-browser-runtime.log"), docker(["logs", name], 10000)); } catch { /* diagnostics only */ }
    // The generated name is the only deletion target. Existing services and volumes are untouched.
    if (!/^npati-audit-qa-[0-9a-f-]{36}$/.test(name)) throw new Error("Unsafe cleanup identity");
    try { docker(["rm", "--force", name]); evidence.cleanup = "passed"; }
    catch { evidence.cleanup = "failed"; evidence.status = "failed"; }
  }
  if (volumeCreated) {
    if (!/^npati-audit-qa-[0-9a-f-]{36}-projects$/.test(volume)) throw new Error("Unsafe cleanup volume identity");
    try { docker(["volume", "rm", volume]); evidence.volumeCleanup = "passed"; }
    catch { evidence.volumeCleanup = "failed"; evidence.status = "failed"; }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(directory, runtimeFile), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (evidence.status !== "passed") process.exitCode = 1;
}
