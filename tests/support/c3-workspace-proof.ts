import { C3_TRANSACTION_CASES } from "./c3-transaction-proof";
import { DEFAULT_CODE_AGENT_LIMITS } from "../../apps/agent-api/src/code-agent-config";
import { toEngineWritePort } from "../../apps/agent-api/src/code-tool-executors-write";
import { commitPatchMutations } from "../../apps/agent-api/src/code-patch-transaction";
import { AuditLogService } from "../../apps/agent-api/src/audit-log";
import { createCodeRunActivitySink, activitySinkForKind } from "../../apps/agent-api/src/code-run-activity-sink";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore } from "../../packages/workspace/src/in-memory-store";
import type { AuthContext } from "@npati/workspace";
import { LocalProjectWorkspace } from "../../apps/agent-api/src/project-workspace";
import { ProjectGitService } from "../../apps/agent-api/src/project-git-service";
import { FeatureFlagService } from "../../apps/agent-api/src/feature-flags";
import { CodeToolRuntime } from "../../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../../apps/agent-api/src/code-tool-registry";
import { allCanonicalExecutors } from "../../apps/agent-api/src/code-tool-executors";
import { createProjectWorkspaceReadPort, createProjectWorkspaceWritePort } from "../../apps/agent-api/src/code-tool-runtime-workspace";
import { codeCheckpointPortFromGit } from "../../apps/agent-api/src/code-workspace-checkpoint";

export async function createC3ProofFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-c3-proof-"));
  const ctx: AuthContext = { workspaceId: "c3-proof", userId: "owner-proof", permissions: ["*"] };
  const foreign: AuthContext = { workspaceId: "foreign-proof", userId: "foreign-user", permissions: ["*"] };
  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctx);
  const company = await store.createCompany(ctx, { name: "Disposable C3" }, "proof-company");
  const { project } = await store.createProject(ctx, company.id, { name: "Proof", type: "website" }, "proof-project");
  const projects = { get: (auth: AuthContext, companyId: string, projectId: string) => store.getProject(auth, companyId, projectId) };
  const workspace = new LocalProjectWorkspace(projects, { root });
  const git = new ProjectGitService(store, projects, root);
  await git.ensureRepository(ctx, company.id, project.id);
  const audit = new AuditLogService(store);
  const read = createProjectWorkspaceReadPort(workspace);
  const write = createProjectWorkspaceWritePort(workspace);
  let call = 0;
  const runtime = new CodeToolRuntime({
    audit,
    activity: activitySinkForKind(createCodeRunActivitySink({ store, workspaceId: ctx.workspaceId }), "code_tool_activity"),
    store, flags: new FeatureFlagService(store, undefined, { enabledByDefault: true, allowPreGateRollout: true }),
    schemas: CODE_TOOL_SCHEMAS, executors: allCanonicalExecutors(), writePort: write,
    toPort: () => read, checkpoints: codeCheckpointPortFromGit(git),
  });
  const invoke = (tool: string, args: Record<string, unknown>, auth = ctx) => runtime.invoke(auth, {
    companyId: company.id, projectId: project.id, sessionId: "proof-session", turnId: "proof-turn",
    toolCallId: "proof-call-" + ++call, tool, args,
  });
  const ok = async (tool: string, args: Record<string, unknown>) => {
    const result = await invoke(tool, args);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const content = (file: string) => workspace.readFile(ctx, company.id, project.id, file);
  return { root, ctx, foreign, store, company, project, workspace, git, audit, runtime, read, write, invoke, ok, content,
    absolute: (file: string) => path.join(root, company.id, project.id, file),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
export type C3ProofFixture = Awaited<ReturnType<typeof createC3ProofFixture>>;

export const C3_PROOF_CASES: Record<string, (h: C3ProofFixture) => Promise<void>> = {
  "nested directories and CRLF literal edits survive actual disk writes": async (h: C3ProofFixture) => {
    await h.ok("code.fs.write", { path: "src/deep/file.ts", content: "\uFEFFconst value = 1;\r\n// Україна\tOlá\r\n" });
    await h.ok("code.fs.read", { path: "src/deep/file.ts" });
    await h.ok("code.fs.edit", { path: "src/deep/file.ts", old_string: "const value = 1;", new_string: "const value = 2;\n// $& literal" });
    assert.equal((await h.content("src/deep/file.ts")).content, "\uFEFFconst value = 2;\r\n// $& literal\r\n// Україна\tOlá\r\n");
    assert.equal((await stat(h.absolute("src/deep"))).isDirectory(), true);
  },
  "stale real revisions refuse writes and a fresh read allows retry": async (h: C3ProofFixture) => {
    const file = await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "race.ts", "old\n");
    await h.ok("code.fs.read", { path: "race.ts" });
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "race.ts", "external\n", file.revision);
    const stale = await h.invoke("code.fs.write", { path: "race.ts", content: "lost update\n" });
    assert.equal(stale.ok, false);
    assert.equal((await h.content("race.ts")).content, "external\n");
    await h.ok("code.fs.read", { path: "race.ts" });
    await h.ok("code.fs.edit", { path: "race.ts", old_string: "external", new_string: "recovered" });
    assert.equal((await h.content("race.ts")).content, "recovered\n");
  },
  "real Git checkpoint restores multiple patched files and removes added files": async (h: C3ProofFixture) => {
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "a.ts", "one\n");
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "b.ts", "two\r\n");
    await h.ok("code.fs.read", { path: "a.ts" });
    await h.ok("code.fs.read", { path: "b.ts" });
    await h.ok("code.fs.edit", { path: "a.ts", old_string: "one", new_string: "ONE" });
    const patch = "*** Begin Patch\n*** Update File: b.ts\n@@ -1 +1 @@\n-two\n+TWO\n*** Add File: nested/new.ts\n+new\n*** End Patch";
    await h.ok("code.fs.apply_patch", { patch, dryRun: true });
    assert.equal((await h.content("b.ts")).content, "two\r\n");
    const patched = await h.ok("code.fs.apply_patch", { patch });
    const files = (patched.result as { data: { files: Array<{ diff: string }> } }).data.files;
    assert.ok(files.every(file => file.diff.includes("--- a/")));
    assert.equal((await h.content("b.ts")).content, "TWO\r\n");
    assert.equal((await h.content("nested/new.ts")).content, "new\n");
    const checkpoints = await h.git.listCheckpoints(h.ctx, h.company.id, h.project.id);
    assert.equal(checkpoints.length, 1);
    await h.ok("code.fs.diff", { turnOnly: true });
    await h.ok("code.fs.undo_last_turn", { confirm: true });
    assert.equal((await h.content("a.ts")).content, "one\n");
    assert.equal((await h.content("b.ts")).content, "two\r\n");
    await assert.rejects(h.content("nested/new.ts"));
    assert.equal((await h.git.listCheckpoints(h.ctx, h.company.id, h.project.id)).length, 2);
  },
  "actual ownership and path guards protect foreign projects and outside files": async (h: C3ProofFixture) => {
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "retained.ts", "owned\n");
    const outside = path.join(h.root, "outside.txt");
    await writeFile(outside, "outside unchanged\n");
    const denied = await h.invoke("code.fs.write", { path: "retained.ts", content: "foreign\n" }, h.foreign);
    assert.equal(denied.ok, false);
    const traversal = await h.invoke("code.fs.write", { path: "../outside.txt", content: "escaped\n" });
    assert.equal(traversal.ok, false);
    assert.equal((await h.content("retained.ts")).content, "owned\n");
    assert.equal(await readFile(outside, "utf8"), "outside unchanged\n");
    await assert.rejects(h.workspace.readFile(h.ctx, "different-company", h.project.id, "retained.ts"));
  },
};

export async function checkPosixModes(h: C3ProofFixture) {
  assert.notEqual(process.platform, "win32", "POSIX permissions require the Linux fixture");
  const tool = CODE_TOOL_SCHEMAS.find(schema => schema.name === "code.fs.apply_patch");
  assert.ok(tool);
  const port = toEngineWritePort({ ctx: h.ctx, companyId: h.company.id, projectId: h.project.id,
    tool, args: {}, port: h.read, writePort: h.write, limits: DEFAULT_CODE_AGENT_LIMITS });
  for (const mode of [0o755, 0o640]) {
    const file = "mode-" + mode + ".sh", failedFile = "fail-" + mode + ".ts";
    await h.workspace.createFile(h.ctx, h.company.id, h.project.id, file, "echo original\n");
    await chmod(h.absolute(file), mode);
    await h.ok("code.fs.read", { path: file });
    await h.ok("code.fs.edit", { path: file, old_string: "original", new_string: "updated" });
    assert.equal((await stat(h.absolute(file))).mode & 0o777, mode);
    const before = await port.readFile(file);
    assert.equal(before.mode, mode);
    const failingPort = { ...port, applyPatchTransaction: undefined, writeFile: async (...args: Parameters<typeof port.writeFile>) => {
      if (args[0] === failedFile) throw new Error("injected second-file I/O failure");
      return port.writeFile(...args);
    } };
    // Explicit fixture approval exercises the existing commit primitive; runtime approval guards stay intact.
    await assert.rejects(commitPatchMutations([
      { path: file, before: before.content, after: "", existing: true, delete: true, mode: before.mode, revision: before.revision },
      { path: failedFile, before: "", after: "unreached", existing: false },
    ], failingPort, { approved: true }), /injected second-file/);
    assert.equal(await readFile(h.absolute(file), "utf8"), before.content);
    assert.equal((await stat(h.absolute(file))).mode & 0o777, mode);
  }
}

C3_PROOF_CASES["turn diff is net state after repeated edits and a revert"] = async h => {
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "net.ts", "original\n");
  await h.ok("code.fs.read", { path: "net.ts" });
  await h.ok("code.fs.edit", { path: "net.ts", old_string: "original", new_string: "temporary" });
  await h.ok("code.fs.edit", { path: "net.ts", old_string: "temporary", new_string: "original" });
  const result = await h.ok("code.fs.diff", { turnOnly: true });
  const data = (result.result as { data: { stats: { files: number; additions: number; deletions: number }; diff: string } }).data;
  assert.equal(data.stats.files, 0);
  assert.equal(data.stats.additions, 0);
  assert.equal(data.stats.deletions, 0);
  assert.equal(data.diff, "");
};

C3_PROOF_CASES["canonical read port retains actual mode metadata for rollback"] = async h => {
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "mode.ts", "mode\n");
  const file = await h.read.readFile({ ctx: h.ctx, companyId: h.company.id, projectId: h.project.id,
    path: "mode.ts", maxLines: 100, maxBytes: 1024 });
  assert.equal(file.mode, (await stat(h.absolute("mode.ts"))).mode & 0o777);
};

C3_PROOF_CASES["actual revision conflicts stop before the fourth write and re-read recovers next turn"] = async h => {
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "bounded.ts", "original\n");
  const original = h.write.writeFile.bind(h.write);
  let peerWrites = 0;
  h.write.writeFile = async input => {
    const current = await h.content(input.path);
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, input.path, "peer-" + ++peerWrites + "\n", current.revision);
    return original(input);
  };
  for (let index = 0; index < 3; index++) {
    await h.ok("code.fs.read", { path: "bounded.ts" });
    assert.equal((await h.invoke("code.fs.write", { path: "bounded.ts", content: "ours\n" })).ok, false);
  }
  await h.ok("code.fs.read", { path: "bounded.ts" });
  const blocked = await h.invoke("code.fs.write", { path: "bounded.ts", content: "ours\n" });
  assert.equal(blocked.ok, false);
  assert.equal(peerWrites, 3);
  assert.equal((await h.content("bounded.ts")).content, "peer-3\n");
  h.write.writeFile = original;
  const read = await h.runtime.invoke(h.ctx, { companyId: h.company.id, projectId: h.project.id,
    sessionId: "proof-session", turnId: "next-user-turn", toolCallId: "next-read", tool: "code.fs.read", args: { path: "bounded.ts" } });
  assert.equal(read.ok, true);
  const recovered = await h.runtime.invoke(h.ctx, { companyId: h.company.id, projectId: h.project.id,
    sessionId: "proof-session", turnId: "next-user-turn", toolCallId: "next-write", tool: "code.fs.write", args: { path: "bounded.ts", content: "recovered\n" } });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal((await h.content("bounded.ts")).content, "recovered\n");
};

C3_PROOF_CASES["binary or unsupported encoded files are refused without changing their bytes"] = async h => {
  const file = h.absolute("utf16.txt");
  await writeFile(file, Buffer.from("\uFEFFhello\n", "utf16le"));
  const before = await readFile(file);
  await h.ok("code.fs.read", { path: "utf16.txt" });
  const result = await h.invoke("code.fs.edit", { path: "utf16.txt", old_string: "\u0000", new_string: "damage", replace_all: true });
  assert.equal(result.ok, false);
  assert.deepEqual(await readFile(file), before);
  const legacyFile = h.absolute("legacy.txt");
  const legacyBytes = Buffer.from([104, 101, 108, 108, 111, 233, 10]);
  await writeFile(legacyFile, legacyBytes);
  const legacy = await h.content("legacy.txt");
  assert.equal(legacy.binary, true);
  await assert.rejects(
    h.workspace.editFile(h.ctx, h.company.id, h.project.id, "legacy.txt", "hello", "changed", legacy.revision),
    { code: "unsupported_encoding" },
  );
  assert.deepEqual(await readFile(legacyFile), legacyBytes);
};

C3_PROOF_CASES["actual persisted Activity correlates tool calls with their turn and session"] = async h => {
  await h.ok("code.fs.write", { path: "activity.ts", content: "const result = 1;\n" });
  const events = await h.store.listCodeActivityEvents({ companyId: h.company.id, limit: 100 });
  const event = events.find(event => event.kind === "code_tool_activity" && event.projectId === h.project.id);
  assert.ok(event);
  assert.equal(event.sessionId, "proof-session");
  assert.equal(event.payload.toolCallId, "proof-call-1");
  assert.equal(event.payload.turnId, "proof-turn");
  assert.equal(JSON.stringify(event).includes("const result"), false);
};

C3_PROOF_CASES["a real failed patch reports incomplete rollback instead of overwriting a concurrent writer"] = async h => {
  // Exercise legacy adapters without the authoritative transaction capability.
  h.write.applyPatchTransaction = undefined;
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "a.ts", "old-a\n");
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "b.ts", "old-b\n");
  await h.ok("code.fs.read", { path: "a.ts" });
  await h.ok("code.fs.read", { path: "b.ts" });
  const original = h.write.writeFile.bind(h.write);
  h.write.writeFile = async input => {
    if (input.path === "b.ts") {
      const current = await h.content("a.ts");
      await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "a.ts", "peer-a\n", current.revision);
      throw new Error("Injected I/O failure after a real first-file write");
    }
    return original(input);
  };
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@ -1 +1 @@\n-old-a\n+new-a\n*** Update File: b.ts\n@@ -1 +1 @@\n-old-b\n+new-b\n*** End Patch";
  const result = await h.invoke("code.fs.apply_patch", { patch });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Partial patch was reported as successful");
  assert.equal(result.error.code, "write_failed");
  assert.equal(result.error.details?.rollbackIncomplete, true);
  assert.equal((await h.content("a.ts")).content, "peer-a\n");
  assert.equal((await h.content("b.ts")).content, "old-b\n");
  h.write.writeFile = original;
  await h.ok("code.fs.undo_last_turn", { confirm: true });
  assert.equal((await h.content("a.ts")).content, "old-a\n");
};
C3_PROOF_CASES["unapproved secrets and Git metadata writes never reach actual files"] = async h => {
  const gitConfig = await readFile(h.absolute(".git/config"));
  for (const file of [".env", ".git/config"]) {
    assert.equal((await h.invoke("code.fs.write", { path: file, content: "example\n" })).ok, false);
  }
  await assert.rejects(readFile(h.absolute(".env")));
  assert.deepEqual(await readFile(h.absolute(".git/config")), gitConfig);
};

C3_PROOF_CASES["successful writes keep the revision fence for the next tool call"] = async h => {
  await h.ok("code.fs.write", { path: "chain.ts", content: "first\n" });
  const read = h.read.readFile.bind(h.read);
  let reads = 0;
  h.read.readFile = async input => {
    if (++reads === 3) {
      const current = await h.content("chain.ts");
      await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "chain.ts", "first\n// concurrent peer\n", current.revision);
    }
    return read(input);
  };
  const result = await h.invoke("code.fs.write", { path: "chain.ts", content: "second\n" });
  assert.equal(result.ok, false);
  assert.equal((await h.content("chain.ts")).content, "first\n// concurrent peer\n");
};

C3_PROOF_CASES["real Git undo waits for a durable audit intent before restoring files"] = async h => {
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "audited.ts", "before\n");
  await h.ok("code.fs.read", { path: "audited.ts" });
  await h.ok("code.fs.edit", { path: "audited.ts", old_string: "before", new_string: "after" });
  const append = h.store.appendAuditEntry.bind(h.store);
  h.store.appendAuditEntry = async () => { throw new Error("Injected audit storage failure"); };
  const refused = await h.invoke("code.fs.undo_last_turn", { confirm: true });
  assert.equal(refused.ok, false);
  assert.equal((await h.content("audited.ts")).content, "after\n");
  assert.equal((await h.git.listCheckpoints(h.ctx, h.company.id, h.project.id)).length, 1);
  assert.ok(h.runtime.turnSummary("proof-session", "proof-turn").checkpointId);
  h.store.appendAuditEntry = append;
  await h.ok("code.fs.undo_last_turn", { confirm: true });
  assert.equal((await h.content("audited.ts")).content, "before\n");
  const entries = await h.audit.list(h.ctx, h.company.id);
  assert.ok(entries.some(entry => entry.metadata.action === "pre_undo_last_turn"));
};

C3_PROOF_CASES["revision retry budget survives changing model turns inside one run"] = async h => {
  await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "run-race.ts", "initial\n");
  const original = h.write.writeFile.bind(h.write);
  let peers = 0;
  h.write.writeFile = async input => {
    const file = await h.content("run-race.ts");
    await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "run-race.ts", "peer-" + ++peers + "\n", file.revision);
    return original(input);
  };
  let call = 0;
  const invoke = (tool: string, args: Record<string, unknown>, turn: number, runId = "stable-run") => h.runtime.invoke(h.ctx, {
    companyId: h.company.id, projectId: h.project.id, sessionId: "proof-session", runId,
    turnId: "request#turn-" + turn, toolCallId: "run-scope-" + ++call, tool, args,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await invoke("code.fs.read", { path: "run-race.ts" }, attempt * 2)).ok, true);
    assert.equal((await invoke("code.fs.write", { path: "run-race.ts", content: "ours-" + attempt + "\n" }, attempt * 2 + 1)).ok, false);
  }
  await invoke("code.fs.read", { path: "run-race.ts" }, 6);
  const refused = await invoke("code.fs.write", { path: "run-race.ts", content: "fourth\n" }, 7);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "revision_conflict_exhausted");
  assert.equal(peers, 3);
  assert.equal((await h.content("run-race.ts")).content, "peer-3\n");
  h.write.writeFile = original;
  await invoke("code.fs.read", { path: "run-race.ts" }, 1, "new-run");
  const recovered = await invoke("code.fs.write", { path: "run-race.ts", content: "recovered\n" }, 2, "new-run");
  assert.equal(recovered.ok, true);
  assert.equal((await h.content("run-race.ts")).content, "recovered\n");
};

C3_PROOF_CASES["tool-result cache is isolated by run while replay within a run stays idempotent"] = async h => {
  const file = await h.workspace.createFile(h.ctx, h.company.id, h.project.id, "cached.ts", "cached-before\n");
  const invoke = (runId: string) => h.runtime.invoke(h.ctx, {
    companyId: h.company.id, projectId: h.project.id, sessionId: "proof-session", runId,
    turnId: runId + "#turn-1", toolCallId: "provider-reused-id", tool: "code.fs.read", args: { path: "cached.ts" },
  });
  assert.equal((await invoke("first-run")).ok, true);
  await h.workspace.writeFile(h.ctx, h.company.id, h.project.id, "cached.ts", "cached-after\n", file.revision);
  const second = await invoke("second-run");
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.cached === true, false);
  assert.ok(JSON.stringify(second).includes("cached-after"));
  const replay = await invoke("second-run");
  assert.equal(replay.ok && replay.cached, true);
};

C3_PROOF_CASES["stateless runner scope also bounds retries across model turns"] = async h => {
  const invoke = h.runtime.invoke.bind(h.runtime);
  h.runtime.invoke = (ctx, input) => invoke(ctx, { ...input, runId: undefined, runScopeId: input.runId });
  await C3_PROOF_CASES["revision retry budget survives changing model turns inside one run"]!(h);
};

Object.assign(C3_PROOF_CASES, C3_TRANSACTION_CASES);
