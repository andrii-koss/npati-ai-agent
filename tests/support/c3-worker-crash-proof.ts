import { runTerminalCrashCopyBack } from "./c3-terminal-proof";
import assert from "node:assert/strict";
import { chmod, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { LocalProjectWorkspace } from "../../apps/agent-api/src/project-workspace";
import type { C3ProofFixture } from "./c3-workspace-proof";

/** Disposable runner child. Its only path comes from the parent-owned fixture. */
export async function runC3CrashChild(base: string, stage: string) {
  let saves = 0;
  const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const plan = await Promise.all(["crash-a.ts", "crash-b.ts"].map(async file => {
    const before = await readFile(path.join(base, file), "utf8");
    return { path: file, before, after: before.replace("original", "changed"), existing: true, revision: revision(Buffer.from(before)) };
  }));
  const companyId = path.basename(path.dirname(base)), projectId = path.basename(base);
  const workspace = new LocalProjectWorkspace({ get: async () => ({ id: projectId, companyId, workspaceId: "c3-proof", revision: 1, status: "ready" as const }) }, { root: path.dirname(path.dirname(base)) });
  const port = workspace as unknown as { save(absolute: string, content: string | Buffer, mode?: number): Promise<Buffer> };
  const save = port.save.bind(workspace);
  port.save = async (absolute, content, mode) => {
    if (stage === "staging") {
      const temporary = path.join(base, ".npati-crash-" + randomUUID() + ".tmp");
      await writeFile(temporary, String(content).slice(0, 3), { flag: "wx", mode: 0o600 });
      process.exit(74);
    }
    if (stage === "kill-during-rollback" && absolute.endsWith("crash-b.ts") && content === plan[1]!.after) throw new Error("Force rollback before worker death");
    const result = await save(absolute, content, mode);
    if (stage === "kill-during-rollback") {
      if (absolute.endsWith("crash-a.ts") && content === plan[0]!.before) process.kill(process.pid, "SIGKILL");
      return result;
    }
    saves++;
    if (saves === (stage === "after-second" ? 2 : 1)) {
      if (stage === "pause-after-first") {
        await writeFile(path.join(base, ".npati-paused"), "1");
        process.kill(process.pid, "SIGSTOP");
      }
      else if (stage === "kill-after-first") process.kill(process.pid, "SIGKILL");
      else process.exit(73);
    }
    return result;
  };
  if (stage === "terminal-after-first") { await runTerminalCrashCopyBack(base, workspace); throw new Error("Terminal crash point not reached"); }
  await workspace.applyPatchTransaction({ workspaceId: "c3-proof", userId: "owner-proof", permissions: ["*"] }, companyId, projectId, plan);
  if (stage !== "pause-after-first") throw new Error("Crash injection was not reached");
}
export async function checkC3WorkerCrash(h: C3ProofFixture, bundle: string, stage: string) {
  for (const name of ["crash-a.ts", "crash-b.ts"]) await h.workspace.createFile(h.ctx, h.company.id, h.project.id, name, "\uFEFForiginal\r\n");
  await chmod(h.absolute("crash-a.ts"), 0o640);
  if (stage === "terminal-after-first") await writeFile(h.absolute(".npati-crash-project.json"), JSON.stringify(h.project), { mode: 0o600 });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, "--c3-crash-child", path.dirname(h.absolute("crash-a.ts")), stage], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash child timed out")); }, 10000);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
  if (stage === "kill-after-first" || stage === "kill-during-rollback") assert.equal(result.signal, "SIGKILL", result.stderr);
  else assert.equal(result.code, stage === "staging" ? 74 : 73, result.stderr);
  // Prove that a real mutation happened, except when the child died in staging.
  assert.equal(await readFile(h.absolute("crash-a.ts"), "utf8"), ["staging", "kill-during-rollback"].includes(stage) ? "\uFEFForiginal\r\n" : "\uFEFFchanged\r\n");
  // The child died while holding the real lease. Expire only this disposable
  // crashed lease rather than waiting 60 seconds or altering production timeouts.
  const lease = h.absolute(".npati-write-lock");
  assert.equal((await stat(lease)).isDirectory(), true);
  const expired = new Date(Date.now() - 61000);
  if (!["after-first-immediate", "kill-after-first", "terminal-after-first", "kill-during-rollback"].includes(stage)) await utimes(lease, expired, expired);
  // A new service instance represents a restarted worker, with no in-memory state.
  const restarted = new LocalProjectWorkspace({ get: (ctx, company, project) => h.store.getProject(ctx, company, project) }, { root: h.root });
  for (const name of ["crash-a.ts", "crash-b.ts"]) assert.equal((await restarted.readFile(h.ctx, h.company.id, h.project.id, name)).content, "\uFEFForiginal\r\n");
  assert.equal((await stat(h.absolute("crash-a.ts"))).mode & 0o777, 0o640);
  await assert.rejects(stat(h.absolute(".npati-patch-transaction.json")), { code: "ENOENT" });
  if (stage === "terminal-after-first") assert.equal(await readFile(path.join(h.root, "terminal-crash-projection/.npati-runtime/executions"), "utf8"), "1");
}

export async function checkPausedKernelWriter(h: C3ProofFixture, bundle: string) {
  for (const file of ["crash-a.ts", "crash-b.ts"]) await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "original\n");
  const before = await h.content("crash-b.ts");
  const child = spawn(process.execPath, [bundle, "--c3-crash-child", path.dirname(h.absolute("crash-a.ts")), "pause-after-first"], { stdio: ["ignore", "ignore", "ignore"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const until = Date.now() + 5000;
  try {
    while (true) {
      try { await stat(h.absolute(".npati-paused")); break; } catch {
        if (Date.now() > until) throw new Error("Worker did not reach SIGSTOP barrier");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const expired = new Date(Date.now() - 61000);
    await utimes(h.absolute(".npati-write-lock"), expired, expired);
    let finished = false;
    const peer = h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "crash-b.ts", "peer", before.revision).then(
      () => { finished = true; return "unexpected success"; }, error => { finished = true; return error.code; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, "Expired heartbeat admitted a writer while the old owner still held flock");
    assert.equal(await readFile(h.absolute("crash-a.ts"), "utf8"), "changed\n");
    child.kill("SIGCONT");
    assert.equal(await exited, 0);
    assert.equal(await peer, "revision_conflict");
    for (const file of ["crash-a.ts", "crash-b.ts"]) assert.equal((await h.content(file)).content, "changed\n");
  } finally { if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); } }
}
