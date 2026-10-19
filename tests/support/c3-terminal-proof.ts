import { createProjectWorkspaceReadPort } from "../../apps/agent-api/src/code-tool-runtime-workspace";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectSandboxService } from "../../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../../apps/agent-api/src/project-terminal-events";
import { safeProjectPath, type ProjectWorkspace } from "../../apps/agent-api/src/project-workspace";
import type { SandboxProvider, SandboxScope, SandboxStatus, SandboxFile, SandboxCommandOptions, SandboxCommandResult } from "../../apps/agent-api/src/sandbox-provider";
import type { C3ProofFixture } from "./c3-workspace-proof";

/** Audit-only transport: real Linux shell in an owned projection inside the
 * read-only/no-network disposable container. Not shared-supervisor certification.
 */
class LinuxCommandProjection implements SandboxProvider {
  readonly id = randomUUID();
  state: SandboxStatus["state"] = "created";
  timeout = 10000;
  commandCount = 0;
  constructor(readonly root: string) {}
  private status(): SandboxStatus { return { id: this.id, state: this.state, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }; }
  async createSandbox() { await mkdir(this.root, { recursive: true }); await mkdir(path.join(this.root, ".npati-runtime")); return this.status(); }
  async startSandbox() { this.state = "running"; return this.status(); }
  async stopSandbox() { this.state = "stopped"; return this.status(); }
  async destroySandbox() { this.state = "destroyed"; }
  async getStatus() { return this.status(); }
  async uploadFiles(_scope: SandboxScope, _id: string, files: SandboxFile[]) {
    for (const file of files) {
      const target = path.join(this.root, safeProjectPath(file.path));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  }
  async downloadFiles() {
    const files: SandboxFile[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(path.join(this.root, dir), { withFileTypes: true })) {
        if (entry.name === ".npati-runtime") continue;
        const file = dir ? dir + "/" + entry.name : entry.name;
        if (entry.isSymbolicLink()) throw new Error("Projection symlink denied");
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files.push({ path: safeProjectPath(file), content: await readFile(path.join(this.root, file), "utf8") });
      }
    };
    await walk(""); return files;
  }
  async executeCommand(_scope: SandboxScope, _id: string, command: string, _options: SandboxCommandOptions): Promise<SandboxCommandResult> {
    assert.equal(process.platform, "linux", "Project commands must run inside the isolated Linux audit container");
    this.commandCount++;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn("/bin/sh", ["-c", command], { cwd: this.root, detached: true,
        env: { PATH: process.env.PATH, HOME: this.root, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.timeout);
      child.stdout.on("data", data => { stdout = (stdout + data).slice(-64000); });
      child.stderr.on("data", data => { stderr = (stderr + data).slice(-64000); });
      child.on("error", error => { clearTimeout(timer); kill(); reject(error); });
      child.on("close", code => {
        clearTimeout(timer); kill();
        resolve({ status: timedOut ? "timed_out" : code === 0 ? "completed" : "failed", exitCode: code ?? 137,
          stdout, stderr, durationMs: Date.now() - started, step: "command", tool: "project.terminal.exec", retryable: false });
      });
    });
  }
  async startProcess(): Promise<SandboxCommandResult> { throw new Error("Not a background-process certification"); }
  async stopProcess(): Promise<SandboxCommandResult> { throw new Error("Unused"); }
  async getProcessStatus(): Promise<SandboxCommandResult> { throw new Error("Unused"); }
  async getLogs() { return ""; }
  async exposePort(): Promise<{ port: number; internalHost: string }> { throw new Error("Not a preview certification"); }
}
async function fixture(h: C3ProofFixture, mounted = false) {
  for (const file of ["terminal-a.ts", "terminal-b.ts"]) await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "\uFEFForiginal\r\n");
  const canonical = path.dirname(h.absolute("terminal-a.ts"));
  const workspacePort: ProjectWorkspace = h.workspace;
  if (mounted) workspacePort.mountFor = async () => ({ source: canonical, target: "/workspace", readOnly: false, mode: "rw" });
  const provider = new LinuxCommandProjection(mounted ? canonical : path.join(h.root, "isolated-projection"));
  const projects = { get: (ctx: typeof h.ctx, company: string, project: string) => h.store.getProject(ctx, company, project) };
  const events = new ProjectTerminalEventsRepository(projects);
  const sandbox = new ProjectSandboxService(projects, h.store, h.workspace, provider, events);
  const execute = (source: string) => sandbox.execute(h.ctx, h.company.id, { projectId: h.project.id, agentId: "system", approved: true,
    command: "node -e '" + source.replace(/'/g, "'\\''") + "'" });
  return { provider, sandbox, execute };
}
const writeBoth = 'const f=require("fs");for(const p of ["terminal-a.ts","terminal-b.ts"])f.writeFileSync(p,"\\uFEFFterminal\\r\\n")';
async function waitFor(file: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { try { await stat(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  throw new Error("Concurrent shell did not reach barrier");
}
export const C3_TERMINAL_CASES: Record<string, (h: C3ProofFixture) => Promise<void>> = {
  "native discovery honors list mtime glob gitignore and real ripgrep filters context modes and literal query isolation": async h => {
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "src/orders.ts", "before\nexport function createOrder() {}\nafter\n");
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "src/orders.js", "const createOrder = () => {};\n");
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "ignored.ts", "createOrder ignored\n");
    const ignore = await h.content(".gitignore");
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, ".gitignore", ignore.content + "\nignored.ts\n", ignore.revision);
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "src/older.ts", "export const older = true;\n");
    await utimes(h.absolute("src/older.ts"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await utimes(h.absolute("src/orders.ts"), new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
    const listed = await h.ok("code.fs.list", { dir: "src", glob: "*.ts", sortByMtime: true });
    assert.deepEqual((listed.result as { data: { entries: Array<{ path: string }> } }).data.entries.map(e => e.path), ["src/orders.ts", "src/older.ts"]);
    const rootList = await h.ok("code.fs.list", { dir: "." });
    assert.equal((rootList.result as { data: { entries: Array<{ path: string }> } }).data.entries.some(e => e.path === "ignored.ts"), false);
    const t = await fixture(h);
    const wired = createProjectWorkspaceReadPort(h.workspace, {
      execute: async () => { throw new Error("Search must use the sanctioned search port"); },
      search: t.sandbox.search.bind(t.sandbox),
    });
    h.read.runSearch = wired.runSearch;
    const data = (r: Awaited<ReturnType<typeof h.ok>>) => (r.result as { data: { matches: Array<{ path: string; context?: unknown[]; count?: number }>; truncated?: boolean } }).data;
    const filtered = data(await h.ok("code.fs.grep", { pattern: "function\\s+createOrder\\(", glob: "src/**/*.ts", type: "ts", contextLines: 1 }));
    assert.deepEqual(filtered.matches.map(m => m.path), ["src/orders.ts"]);
    assert.equal(filtered.matches[0]!.context!.length, 2);
    const typed = data(await h.ok("code.fs.grep", { pattern: "createOrder", type: "ts" }));
    assert.deepEqual(typed.matches.map(m => m.path), ["src/orders.ts"]);
    const globbed = data(await h.ok("code.fs.grep", { pattern: "createOrder", glob: "**/*.js" }));
    assert.deepEqual(globbed.matches.map(m => m.path), ["src/orders.js"]);
    const capped = data(await h.ok("code.fs.grep", { pattern: "createOrder", maxResults: 1 }));
    assert.equal(capped.matches.length, 1);
    assert.equal(capped.truncated, true);
    const read = await h.ok("code.fs.read", { path: "src/orders.ts" });
    assert.equal(JSON.stringify(read.result).includes("export function createOrder()"), true);
    const files = data(await h.ok("code.fs.grep", { pattern: "createOrder", mode: "files_with_matches" }));
    assert.deepEqual(files.matches.map(m => m.path).sort(), ["src/orders.js", "src/orders.ts"]);
    const counted = data(await h.ok("code.fs.grep", { pattern: "createOrder", glob: "src/**/*.ts", mode: "count" }));
    assert.deepEqual(counted.matches, [{ path: "src/orders.ts", count: 1 }]);
    const literal = data(await h.ok("code.fs.grep", { pattern: "$(touch should-not-exist)", fixedStrings: true }));
    assert.deepEqual(literal.matches, []);
    assert.equal(await stat(path.join(t.provider.root, "should-not-exist")).then(() => true, () => false), false);
    const fallback = createProjectWorkspaceReadPort(h.workspace, {
      execute: async (ctx, companyId, request) => {
        const raw = await t.sandbox.execute(ctx, companyId, { projectId: request.projectId, command: request.command, agentId: "system", approved: true }) as { stdout?: string; output?: string; exitCode?: number };
        return { stdout: raw.stdout ?? raw.output ?? "", exitCode: raw.exitCode };
      },
    });
    h.read.runSearch = fallback.runSearch;
    const fallbackFiles = data(await h.ok("code.fs.grep", { pattern: "createOrder", mode: "files_with_matches" }));
    assert.deepEqual(fallbackFiles.matches.map(m => m.path).sort(), ["src/orders.js", "src/orders.ts"]);
    assert.equal(t.provider.commandCount, 8);
  },

  "real Terminal commits multiple projected files through the Workspace transaction": async h => {
    const t = await fixture(h);
    let batches = 0;
    const commit = h.workspace.applyPatchTransaction.bind(h.workspace);
    h.workspace.applyPatchTransaction = async (...args) => { batches++; return commit(...args); };
    await t.execute(writeBoth);
    assert.equal(batches, 1); assert.equal(t.provider.commandCount, 1);
    for (const file of ["terminal-a.ts", "terminal-b.ts"]) assert.equal((await h.content(file)).content, "\uFEFFterminal\r\n");
  },
  "concurrent real Terminal and Workspace reject the entire stale output batch": async h => {
    const t = await fixture(h);
    const command = 'const f=require("fs");f.writeFileSync("terminal-a.ts","terminal-a");f.writeFileSync(".npati-runtime/ready","1");const timer=setInterval(()=>{if(f.existsSync(".npati-runtime/release")){clearInterval(timer);f.writeFileSync("terminal-b.ts","terminal-b")}},5)';
    const running = t.execute(command);
    // Attach the rejection observer immediately so a fault never becomes unhandled.
    const outcome = running.then(() => null, error => error);
    await waitFor(path.join(t.provider.root, ".npati-runtime/ready"));
    const base = await h.content("terminal-b.ts");
    try {
      await h.workspace.applyPatchTransaction(h.ctx, h.company.id, h.project.id, [{ path: "terminal-b.ts", before: base.content, after: "workspace-peer\n", existing: true, revision: base.revision }]);
    } finally { await writeFile(path.join(t.provider.root, ".npati-runtime/release"), "1"); }
    const error = await outcome;
    assert.equal(error?.code, "revision_conflict"); assert.equal(error.retryable, false);
    assert.equal((await h.content("terminal-a.ts")).content, "\uFEFForiginal\r\n");
    assert.equal((await h.content("terminal-b.ts")).content, "workspace-peer\n");
    assert.equal(t.provider.commandCount, 1);
  },
  "real Terminal commit failure restores all files and forbids automatic command replay": async h => {
    const t = await fixture(h);
    const storage = h.workspace as unknown as { save(absolute: string, content: string | Buffer, mode?: number): Promise<Buffer> };
    const save = storage.save.bind(h.workspace);
    let injected = false;
    storage.save = async (absolute, content, mode) => {
      const result = await save(absolute, content, mode);
      if (!injected && absolute.endsWith("terminal-b.ts")) { injected = true; throw new Error("I/O receipt lost"); }
      return result;
    };
    try { await assert.rejects(t.execute(writeBoth), (error: unknown) => (error as { code: string; retryable: boolean }).code === "write_failed" && (error as { retryable: boolean }).retryable === false); }
    finally { storage.save = save; }
    for (const file of ["terminal-a.ts", "terminal-b.ts"]) assert.equal((await h.content(file)).content, "\uFEFForiginal\r\n");
    assert.equal(t.provider.commandCount, 1);
  },
  "real Terminal validates a late protected result before copying any earlier file": async h => {
    const t = await fixture(h);
    const command = 'const f=require("fs");f.writeFileSync("terminal-a.ts","must-not-commit");f.writeFileSync("terminal-b.ts","export const password = \\"actual-private-password\\";")';
    await assert.rejects(t.execute(command), { code: "secret_content" });
    for (const file of ["terminal-a.ts", "terminal-b.ts"]) assert.equal((await h.content(file)).content, "\uFEFForiginal\r\n");
  },
  "real Terminal timeout kills its process and releases the canonical commit lease": async h => {
    const t = await fixture(h); t.provider.timeout = 150;
    await assert.rejects(t.execute('require("fs").writeFileSync("terminal-a.ts","timeout-side-effect");setInterval(()=>{},1000)'), { code: "command_timeout" });
    // Arbitrary command effects are non-transactional; validated produced files
    // still have one atomic copy-back boundary, even on command failure.
    assert.equal((await h.content("terminal-a.ts")).content, "timeout-side-effect");
    const before = await h.content("terminal-b.ts");
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "terminal-b.ts", "next-write", before.revision);
    assert.equal((await h.content("terminal-b.ts")).content, "next-write");
  },
};

C3_TERMINAL_CASES["Git reset during a real Terminal command rejects stale output without losing Git bytes"] = async h => {
  const t = await fixture(h);
  const checkpoint = await h.git.createCheckpoint(h.ctx, h.company.id, h.project.id, { name: "Before Terminal reset" });
  const base = await h.content("terminal-b.ts");
  await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "terminal-b.ts", "pre-reset\n", base.revision);
  const command = 'const f=require("fs");f.writeFileSync("terminal-a.ts","terminal-a");f.writeFileSync(".npati-runtime/ready","1");const timer=setInterval(()=>{if(f.existsSync(".npati-runtime/release")){clearInterval(timer);f.writeFileSync("terminal-b.ts","terminal-b")}},5)';
  const outcome = t.execute(command).then(() => null, error => error);
  await waitFor(path.join(t.provider.root, ".npati-runtime/ready"));
  try { await h.git.restoreCheckpoint(h.ctx, h.company.id, h.project.id, checkpoint.id, { approved: true }); }
  finally { await writeFile(path.join(t.provider.root, ".npati-runtime/release"), "1"); }
  assert.equal((await outcome)?.code, "revision_conflict");
  for (const file of ["terminal-a.ts", "terminal-b.ts"]) assert.equal((await h.content(file)).content, "\uFEFForiginal\r\n");
  assert.equal(t.provider.commandCount, 1);
};
C3_TERMINAL_CASES["Git checkout waits for the existing Workspace lease and preserves its fence"] = async h => {
  await fixture(h);
  await h.git.branch(h.ctx, h.company.id, h.project.id, { action: "create", branch: "coordination-test" });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const held = h.workspace.withFileLease(h.ctx, h.company.id, h.project.id, async () => { entered(); await barrier; });
  await started;
  let finished = false;
  const checkout = h.git.branch(h.ctx, h.company.id, h.project.id, { action: "switch", branch: "main" }).then(result => { finished = true; return result; });
  try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(finished, false); }
  finally { release(); }
  await held; await checkout;
  assert.equal((await stat(h.absolute(".npati-write-fence"))).isFile(), true);
  const before = await h.content("terminal-a.ts");
  await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "terminal-a.ts", "after-checkout", before.revision);
};
C3_TERMINAL_CASES["queued canonical writers complete without starvation while a real Terminal build waits"] = async h => {
  const t = await fixture(h), started = Date.now();
  const command = 'const f=require("fs");f.writeFileSync(".npati-runtime/ready","1");const timer=setInterval(()=>{if(f.existsSync(".npati-runtime/release")){clearInterval(timer)}},5)';
  const running = t.execute(command);
  const outcome = running.then(value => value, error => { throw error; });
  await waitFor(path.join(t.provider.root, ".npati-runtime/ready"));
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.workspace.createFile(h.ctx, h.company.id, h.project.id, "queued-" + i + ".ts", String(i))));
  } finally { await writeFile(path.join(t.provider.root, ".npati-runtime/release"), "1"); }
  await outcome;
  for (let i = 0; i < 12; i++) assert.equal((await h.content("queued-" + i + ".ts")).content, String(i));
  assert.ok(Date.now() - started < 5000, "Short canonical writers were blocked behind the long command");
};

/** Child-side Terminal command followed by a crash inside canonical copy-back.
 * The parent supplies only its disposable Project descriptor and owned directory.
 */
export async function runTerminalCrashCopyBack(base: string, workspace: import("../../apps/agent-api/src/project-workspace").LocalProjectWorkspace) {
  let project = JSON.parse(await readFile(path.join(base, ".npati-crash-project.json"), "utf8")) as import("@npati/workspace").Project;
  const ctx = { workspaceId: project.workspaceId, userId: "owner-proof", permissions: ["*"] };
  const projects = { get: async () => project };
  const store = {
    getCompanyAgent: async () => { throw new Error("System-only fixture"); },
    setProjectSandbox: async (_ctx: unknown, _company: string, _project: string, sandboxId: string) => { project = { ...project, sandboxId }; return project; },
  };
  const provider = new LinuxCommandProjection(path.join(path.dirname(path.dirname(base)), "terminal-crash-projection"));
  const sandbox = new ProjectSandboxService(projects, store, workspace, provider, new ProjectTerminalEventsRepository(projects));
  const source = 'const f=require("fs");f.appendFileSync(".npati-runtime/executions","1");for(const p of ["crash-a.ts","crash-b.ts"])f.writeFileSync(p,f.readFileSync(p,"utf8").replace("original","changed"))';
  await sandbox.execute(ctx, project.companyId, { projectId: project.id, agentId: "system", approved: true, command: "node -e '" + source + "'" });
}

C3_TERMINAL_CASES["post-dispatch symlink failure never advertises automatic command replay"] = async h => {
  const t = await fixture(h);
  await assert.rejects(t.execute('const f=require("fs");f.writeFileSync("terminal-a.ts","uncommitted");f.symlinkSync("terminal-b.ts","unsafe-link.ts")'),
    (error: unknown) => (error as { code: string }).code === "sandbox_execution_failed" && (error as { retryable: boolean }).retryable === false);
  assert.equal(t.provider.commandCount, 1);
  for (const file of ["terminal-a.ts", "terminal-b.ts"]) assert.equal((await h.content(file)).content, "\uFEFForiginal\r\n");
};

C3_TERMINAL_CASES["Linux kernel fence refuses symlinks without touching the target"] = async h => {
  const fs = await import("node:fs/promises");
  const target = path.join(h.root, "neighbor.txt"), fence = h.absolute(".npati-write-fence");
  await writeFile(target, "neighbor");
  await fs.rm(fence);
  await fs.symlink(target, fence);
  try {
    await assert.rejects(h.workspace.createFile(h.ctx, h.company.id, h.project.id, "blocked.ts", "unsafe"), { code: "workspace_lock_unavailable" });
    assert.equal(await readFile(target, "utf8"), "neighbor");
    await assert.rejects(stat(h.absolute("blocked.ts")), { code: "ENOENT" });
    const native = await h.invoke("code.fs.read", { path: "terminal-a.ts" });
    assert.equal(native.ok, false);
    if (native.ok) throw new Error("Unsafe kernel fence was accepted by native runtime");
    assert.equal(native.error.code, "workspace_lock_unavailable");
    assert.equal(native.error.status, 503);
    assert.equal(native.error.retryable, false);
  } finally { await fs.rm(fence); }
};
C3_TERMINAL_CASES["Linux kernel fence refuses hardlinks without changing a neighbor file"] = async h => {
  const fs = await import("node:fs/promises");
  const target = path.join(h.root, "neighbor.txt"), fence = h.absolute(".npati-write-fence");
  await writeFile(target, "neighbor"); await fs.rm(fence); await fs.link(target, fence);
  try {
    await assert.rejects(h.workspace.createFile(h.ctx, h.company.id, h.project.id, "blocked.ts", "unsafe"), { code: "invalid_path" });
    assert.equal(await readFile(target, "utf8"), "neighbor");
    await assert.rejects(stat(h.absolute("blocked.ts")), { code: "ENOENT" });
  } finally { await fs.rm(fence); }
};

C3_TERMINAL_CASES["writable mounted foreground Terminal serializes canonical writers until command completion"] = async h => {
  const t = await fixture(h, true), before = await h.content("terminal-b.ts");
  const command = 'const f=require("fs");f.writeFileSync("terminal-a.ts","mounted-a");f.writeFileSync(".npati-runtime/ready","1");const timer=setInterval(()=>{if(f.existsSync(".npati-runtime/release")){clearInterval(timer);f.writeFileSync("terminal-b.ts","mounted-b")}},5)';
  const running = t.execute(command);
  const terminal = running.then(value => value, error => { throw error; });
  await waitFor(path.join(t.provider.root, ".npati-runtime/ready"));
  let finished = false;
  const peer = h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "terminal-b.ts", "peer", before.revision).then(
    () => { finished = true; return "unexpected success"; }, error => { finished = true; return error.code; });
  try {
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(finished, false);
    assert.equal(await readFile(h.absolute("terminal-a.ts"), "utf8"), "mounted-a");
    assert.equal(await readFile(h.absolute("terminal-b.ts"), "utf8"), "\uFEFForiginal\r\n");
  } finally { await writeFile(path.join(t.provider.root, ".npati-runtime/release"), "1"); }
  await terminal;
  assert.equal(await peer, "revision_conflict");
  assert.equal((await h.content("terminal-a.ts")).content, "mounted-a");
  assert.equal((await h.content("terminal-b.ts")).content, "mounted-b");
};

C3_TERMINAL_CASES["Git full restore preserves coordination metadata even when target ignores nothing"] = async h => {
  await fixture(h);
  const ignore = await h.content(".gitignore");
  const originalIgnore = ignore.content;
  const blank = await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, ".gitignore", "", ignore.revision);
  const legacy = await h.git.commit(h.ctx, h.company.id, h.project.id, { message: "Legacy ignore without internal exclusions", files: [".gitignore"] });
  const target = await h.store.createProjectCheckpoint(h.ctx, h.company.id, h.project.id, { name: "Legacy target", commitHash: legacy.commitHash, trigger: "manual", fileCount: 3 });
  await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, ".gitignore", originalIgnore, blank.revision);
  const fs = await import("node:fs/promises");
  await writeFile(h.absolute(".npati-owned-diagnostic"), "retained");
  await fs.mkdir(h.absolute(".worktrees/owned-test"), { recursive: true });
  await writeFile(h.absolute(".worktrees/owned-test/data.ts"), "retained-worktree");
  await h.git.restoreCheckpoint(h.ctx, h.company.id, h.project.id, target.id, { approved: true });
  assert.equal(await readFile(h.absolute(".gitignore"), "utf8"), "");
  assert.equal(await readFile(h.absolute(".npati-owned-diagnostic"), "utf8"), "retained");
  assert.equal(await readFile(h.absolute(".worktrees/owned-test/data.ts"), "utf8"), "retained-worktree");
  assert.equal((await stat(h.absolute(".npati-write-fence"))).isFile(), true);
};

for (const kind of ["leaf-symlink", "parent-symlink", "leaf-hardlink"] as const) {
  C3_TERMINAL_CASES["descriptor read refuses a post-validation " + kind + " swap without reading peer bytes"] = async h => {
    const disk = await import("node:fs/promises");
    const outside = path.join(h.root, "peer-" + kind);
    await disk.mkdir(outside);
    await disk.writeFile(path.join(outside, "victim.ts"), "peer-private-bytes");
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "read-parent/victim.ts", "project-bytes");
    const port = h.workspace as unknown as { bytes(absolute: string): Promise<Buffer> };
    const original = port.bytes.bind(h.workspace);
    let swapped = false;
    port.bytes = async absolute => {
      if (!swapped && absolute === h.absolute("read-parent/victim.ts")) {
        swapped = true;
        if (kind === "parent-symlink") {
          await disk.rename(h.absolute("read-parent"), h.absolute("saved-parent"));
          await disk.symlink(outside, h.absolute("read-parent"));
        } else {
          await disk.unlink(absolute);
          if (kind === "leaf-hardlink") await disk.link(path.join(outside, "victim.ts"), absolute);
          else await disk.symlink(path.join(outside, "victim.ts"), absolute);
        }
      }
      return original(absolute);
    };
    try {
      await assert.rejects(h.workspace.readFile(h.ctx, h.company.id, h.project.id, "read-parent/victim.ts"), { code: "invalid_path" });
      assert.equal(await disk.readFile(path.join(outside, "victim.ts"), "utf8"), "peer-private-bytes");
      assert.equal(swapped, true);
      if (kind === "leaf-hardlink") {
        const listed = await h.workspace.getFileTree(h.ctx, h.company.id, h.project.id);
        assert.equal(listed.find(file => file.path === "read-parent/victim.ts")?.revision, undefined);
        assert.ok(listed.some(file => file.path === "read-parent/victim.ts"));
      }
    } finally { port.bytes = original; }
  };
}
