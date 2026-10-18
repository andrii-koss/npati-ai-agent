import assert from "node:assert/strict";
import { readFile, writeFile, stat, chmod } from "node:fs/promises";
import path from "node:path";
import type { C3ProofFixture } from "./c3-workspace-proof";
import { LocalProjectWorkspace } from "../../apps/agent-api/src/project-workspace";
import type { PatchMutation } from "../../apps/agent-api/src/code-patch-transaction";

type Save = (absolute: string, content: string | Buffer, mode?: number) => Promise<Buffer>;
function storage(h: C3ProofFixture) { return h.workspace as unknown as { save: Save }; }
async function prepare(h: C3ProofFixture): Promise<PatchMutation[]> {
  const files = [["a.ts", "\uFEFFold-a\r\n"], ["b.ts", "old-b\r\n"]] as const;
  const plan: PatchMutation[] = [];
  for (const [file, content] of files) {
    const before = await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, content);
    plan.push({ path: file, before: content, after: content.replace("old", "new"), existing: true, revision: before.revision });
  }
  return plan;
}
const commit = (h: C3ProofFixture, plan: PatchMutation[]) => h.workspace.applyPatchTransaction(h.ctx, h.company.id, h.project.id, plan);
const journal = (h: C3ProofFixture) => h.absolute(".npati-patch-transaction.json");

export const C3_TRANSACTION_CASES: Record<string, (h: C3ProofFixture) => Promise<void>> = {
  "coordinated patch restores every file after a write replaces bytes then throws": async h => {
    const plan = await prepare(h), port = storage(h), save = port.save.bind(h.workspace);
    if (process.platform !== "win32") await chmod(h.absolute("a.ts"), 0o755);
    let injected = false;
    port.save = async (absolute, content, mode) => {
      const result = await save(absolute, content, mode);
      if (!injected && absolute.endsWith("b.ts")) { injected = true; throw new Error("failure after atomic replacement"); }
      return result;
    };
    try {
      await assert.rejects(commit(h, plan), /failure after atomic replacement/);
      for (const item of plan) assert.equal(await readFile(h.absolute(item.path), "utf8"), item.before);
      if (process.platform !== "win32") assert.equal((await stat(h.absolute("a.ts"))).mode & 0o777, 0o755);
      await assert.rejects(stat(journal(h)), { code: "ENOENT" });
    } finally { port.save = save; }
    await commit(h, plan);
    for (const item of plan) assert.equal((await h.content(item.path)).content, item.after);
    await assert.rejects(commit(h, plan), { code: "revision_conflict" });
    for (const item of plan) assert.equal((await h.content(item.path)).content, item.after);
  },
  "coordinated patch preflights later revision conflicts before any earlier write": async h => {
    const plan = await prepare(h);
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "b.ts", "peer-b\n", plan[1]!.revision!);
    const port = storage(h), save = port.save.bind(h.workspace);
    let writes = 0;
    port.save = async (...args) => { writes++; return save(...args); };
    try {
      await assert.rejects(commit(h, plan), { code: "revision_conflict" });
      assert.equal(writes, 0);
      assert.equal((await h.content("a.ts")).content, plan[0]!.before);
      assert.equal((await h.content("b.ts")).content, "peer-b\n");
    } finally { port.save = save; }
  },
  "independent Workspace instances and readers wait for the complete patch lease": async h => {
    const plan = await prepare(h), port = storage(h), save = port.save.bind(h.workspace);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    port.save = async (absolute, content, mode) => {
      const result = await save(absolute, content, mode);
      if (absolute.endsWith("a.ts")) { entered(); await barrier; }
      return result;
    };
    const transaction = commit(h, plan);
    await started;
    const peer = new LocalProjectWorkspace({ get: (ctx, company, project) => h.store.getProject(ctx, company, project) }, { root: h.root });
    let readerFinished = false, writerFinished = false;
    const read = peer.readFile(h.ctx, h.company.id, h.project.id, "a.ts").then(value => { readerFinished = true; return value; });
    const write = peer.writeFile(h.ctx, h.company.id, h.project.id, "b.ts", "peer\n", plan[1]!.revision!).then(
      () => { writerFinished = true; return "unexpected success"; }, error => { writerFinished = true; return error.code; });
    try {
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(readerFinished, false); assert.equal(writerFinished, false);
    } finally { release(); port.save = save; }
    await transaction;
    assert.equal((await read).content, plan[0]!.after);
    assert.equal(await write, "revision_conflict");
    assert.equal((await h.content("b.ts")).content, plan[1]!.after);
  },
  "failed rollback keeps its protected journal and the next writer recovers before mutation": async h => {
    const plan = await prepare(h), port = storage(h), save = port.save.bind(h.workspace);
    port.save = async (absolute, content, mode) => {
      if (absolute.endsWith("b.ts") || content === plan[0]!.before) throw new Error("storage temporarily unavailable");
      return save(absolute, content, mode);
    };
    try {
      await assert.rejects(commit(h, plan), { code: "transaction_recovery_required" });
      assert.equal(await readFile(h.absolute("a.ts"), "utf8"), plan[0]!.after);
      assert.equal((await stat(journal(h))).isFile(), true);
      await assert.rejects(h.workspace.createFile(h.ctx, h.company.id, h.project.id, "blocked.ts", "must not write"), { code: "transaction_recovery_required" });
      await assert.rejects(stat(h.absolute("blocked.ts")), { code: "ENOENT" });
    } finally { port.save = save; }
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "recovered.ts", "safe\n");
    for (const item of plan) assert.equal((await h.content(item.path)).content, item.before);
    await assert.rejects(stat(journal(h)), { code: "ENOENT" });
    await assert.rejects(h.workspace.readFile(h.ctx, h.company.id, h.project.id, ".npati-patch-transaction.json"), { code: "secret_path" });
  },
  "external writer conflict preserves peer data and blocks recovery instead of claiming atomic success": async h => {
    const plan = await prepare(h), port = storage(h), save = port.save.bind(h.workspace);
    port.save = async (absolute, content, mode) => {
      if (absolute.endsWith("b.ts")) { await writeFile(h.absolute("a.ts"), "peer-a\n"); throw new Error("second target unavailable"); }
      return save(absolute, content, mode);
    };
    try {
      await assert.rejects(commit(h, plan), { code: "transaction_recovery_required" });
      assert.equal(await readFile(h.absolute("a.ts"), "utf8"), "peer-a\n");
      assert.equal(await readFile(h.absolute("b.ts"), "utf8"), plan[1]!.before);
      assert.equal((await stat(journal(h))).isFile(), true);
    } finally { port.save = save; }
    await assert.rejects(h.workspace.createFile(h.ctx, h.company.id, h.project.id, "blocked.ts", "unsafe"), { code: "transaction_recovery_required" });
    assert.equal(await readFile(h.absolute("a.ts"), "utf8"), "peer-a\n");
  },
  "invalid recovery paths cannot restore files outside the project": async h => {
    const outside = path.join(h.root, "neighbor.txt");
    await writeFile(outside, "neighbor");
    await writeFile(journal(h), JSON.stringify({ version: 1, state: "pending", files: [{ path: "../../neighbor.txt", before: "destroy", after: "neighbor", existing: true }] }), { mode: 0o600 });
    await assert.rejects(h.workspace.createFile(h.ctx, h.company.id, h.project.id, "blocked.ts", "unsafe"));
    assert.equal(await readFile(outside, "utf8"), "neighbor");
    assert.equal((await stat(journal(h))).isFile(), true);
  },
  "native patch uses the coordinated transaction and records authoritative post-commit revisions": async h => {
    const plan = await prepare(h);
    await h.ok("code.fs.read", { path: "a.ts" }); await h.ok("code.fs.read", { path: "b.ts" });
    let transactions = 0;
    const original = h.write.applyPatchTransaction!;
    h.write.applyPatchTransaction = input => { transactions++; return original(input); };
    const patch = "*** Begin Patch\n*** Update File: b.ts\n@@ -1 +1 @@\n-old-b\n+new-b\n*** End Patch";
    await h.ok("code.fs.apply_patch", { patch });
    assert.equal(transactions, 1);
    assert.equal((await h.content("b.ts")).content, plan[1]!.after);
    await h.ok("code.fs.edit", { path: "b.ts", old_string: "new-b", new_string: "continued-b" });
    assert.equal((await h.content("b.ts")).content, "continued-b\r\n");
    const events = await h.store.listCodeActivityEvents({ companyId: h.company.id, limit: 100 });
    assert.ok(events.some(event => event.kind === "code_tool_activity" && event.projectId === h.project.id));
    assert.equal(JSON.stringify(events).includes("old-b"), false);
  },
};

C3_TRANSACTION_CASES["coordinated delete rollback restores ordinary modes and removes newly created targets"] = async h => {
  const port = storage(h), save = port.save.bind(h.workspace);
  for (const mode of [0o755, 0o640]) {
    const file = "deleted-" + mode + ".sh", created = "created-" + mode + ".ts";
    const original = await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "echo original\r\n");
    if (process.platform !== "win32") await chmod(h.absolute(file), mode);
    let injected = false;
    port.save = async (absolute, content, restoredMode) => {
      const result = await save(absolute, content, restoredMode);
      if (!injected && absolute.endsWith(created)) { injected = true; throw new Error("receipt lost after create"); }
      return result;
    };
    try {
      await assert.rejects(commit(h, [
        { path: file, before: original.content, after: "", existing: true, delete: true, revision: original.revision },
        { path: created, before: "", after: "new file\n", existing: false },
      ]), /receipt lost after create/);
      assert.equal((await h.content(file)).content, original.content);
      await assert.rejects(stat(h.absolute(created)), { code: "ENOENT" });
      if (process.platform !== "win32") assert.equal((await stat(h.absolute(file))).mode & 0o777, mode);
    } finally { port.save = save; }
  }
};

C3_TRANSACTION_CASES["transaction preflight refuses unsupported bytes without touching earlier files"] = async h => {
  const plan = await prepare(h), raw = Buffer.from([0xff, 0xfe, 65, 0]);
  await writeFile(h.absolute("unsupported.bin"), raw);
  const current = await h.content("unsupported.bin");
  await assert.rejects(commit(h, [plan[0]!, { path: "unsupported.bin", before: current.content, after: "damaged", existing: true, revision: current.revision }]), { code: "revision_conflict" });
  assert.deepEqual(await readFile(h.absolute("unsupported.bin")), raw);
  assert.equal((await h.content("a.ts")).content, plan[0]!.before);
  await assert.rejects(stat(journal(h)), { code: "ENOENT" });
};
C3_TRANSACTION_CASES["transaction rejects privilege mode bits before publishing its journal or changing files"] = async h => {
  const plan = await prepare(h);
  await assert.rejects(commit(h, [plan[0]!, { path: "privileged.sh", before: "", after: "echo unsafe", existing: false, mode: 0o4755 }]), { code: "invalid_mode" });
  assert.equal((await h.content("a.ts")).content, plan[0]!.before);
  await assert.rejects(stat(h.absolute("privileged.sh")), { code: "ENOENT" });
  await assert.rejects(stat(journal(h)), { code: "ENOENT" });
};

C3_TRANSACTION_CASES["native failed recovery returns a nonretryable diagnosis and keeps peer bytes out of Activity"] = async h => {
  for (const file of ["native-a.ts", "native-b.ts"]) {
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "original\n");
    await h.ok("code.fs.read", { path: file });
  }
  const port = storage(h), save = port.save.bind(h.workspace);
  port.save = async (absolute, content, mode) => {
    if (absolute.endsWith("native-b.ts")) {
      await writeFile(h.absolute("native-a.ts"), "confidential-peer-content\n");
      throw new Error("confidential-storage-error");
    }
    return save(absolute, content, mode);
  };
  const patch = "*** Begin Patch\n*** Update File: native-a.ts\n@@ -1 +1 @@\n-original\n+changed\n*** Update File: native-b.ts\n@@ -1 +1 @@\n-original\n+changed\n*** End Patch";
  try {
    const result = await h.invoke("code.fs.apply_patch", { patch });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Incomplete transaction was reported successful");
    assert.equal(result.error.code, "transaction_recovery_required");
    assert.equal(result.error.retryable, false);
    assert.equal(JSON.stringify(result).includes("confidential-peer-content"), false);
    assert.equal(JSON.stringify(result).includes("confidential-storage-error"), false);
    assert.equal(await readFile(h.absolute("native-a.ts"), "utf8"), "confidential-peer-content\n");
    const events = await h.store.listCodeActivityEvents({ companyId: h.company.id, limit: 100 });
    assert.equal(JSON.stringify(events).includes("confidential-peer-content"), false);
    assert.equal(JSON.stringify(events).includes("confidential-storage-error"), false);
  } finally { port.save = save; }
};
