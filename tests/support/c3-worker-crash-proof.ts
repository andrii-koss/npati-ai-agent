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
    const result = await save(absolute, content, mode);
    saves++;
    if (saves === (stage === "after-second" ? 2 : 1)) process.exit(73);
    return result;
  };
  await workspace.applyPatchTransaction({ workspaceId: "c3-proof", userId: "owner-proof", permissions: ["*"] }, companyId, projectId, plan);
  throw new Error("Crash injection was not reached");
}
export async function checkC3WorkerCrash(h: C3ProofFixture, bundle: string, stage: string) {
  for (const name of ["crash-a.ts", "crash-b.ts"]) await h.workspace.createFile(h.ctx, h.company.id, h.project.id, name, "\uFEFForiginal\r\n");
  await chmod(h.absolute("crash-a.ts"), 0o640);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, "--c3-crash-child", path.dirname(h.absolute("crash-a.ts")), stage], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash child timed out")); }, 10000);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  assert.equal(result.code, stage === "staging" ? 74 : 73, result.stderr);
  // Prove that a real mutation happened, except when the child died in staging.
  assert.equal(await readFile(h.absolute("crash-a.ts"), "utf8"), stage === "staging" ? "\uFEFForiginal\r\n" : "\uFEFFchanged\r\n");
  // The child died while holding the real lease. Expire only this disposable
  // crashed lease rather than waiting 60 seconds or altering production timeouts.
  const lease = h.absolute(".npati-write-lock");
  assert.equal((await stat(lease)).isDirectory(), true);
  const expired = new Date(Date.now() - 61000);
  await utimes(lease, expired, expired);
  // A new service instance represents a restarted worker, with no in-memory state.
  const restarted = new LocalProjectWorkspace({ get: (ctx, company, project) => h.store.getProject(ctx, company, project) }, { root: h.root });
  for (const name of ["crash-a.ts", "crash-b.ts"]) assert.equal((await restarted.readFile(h.ctx, h.company.id, h.project.id, name)).content, "\uFEFForiginal\r\n");
  assert.equal((await stat(h.absolute("crash-a.ts"))).mode & 0o777, 0o640);
  await assert.rejects(stat(h.absolute(".npati-patch-transaction.json")), { code: "ENOENT" });
}
