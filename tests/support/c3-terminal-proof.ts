import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectSandboxService } from "../../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../../apps/agent-api/src/project-terminal-events";
import { safeProjectPath } from "../../apps/agent-api/src/project-workspace";
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
async function fixture(h: C3ProofFixture) {
  for (const file of ["terminal-a.ts", "terminal-b.ts"]) await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "\uFEFForiginal\r\n");
  const provider = new LinuxCommandProjection(path.join(h.root, "isolated-projection"));
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
