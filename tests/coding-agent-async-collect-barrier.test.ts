import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession, type DurableCodeProcess } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { CodeAsyncProcessService, type TrackedProcessPort } from "../apps/agent-api/src/code-async-process";
import { CodeProcessCompletionService } from "../apps/agent-api/src/code-process-completions";
import { CodingAgentRunner } from "../apps/agent-api/src/coding-agent-runner";
import { collectAsyncOperationChanges } from "../apps/agent-api/src/code-async-collect-changes";
import { CodeTurnTracker } from "../apps/agent-api/src/code-workspace-checkpoint";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const session = { id: "s", companyId: "c", projectId: "p", userId: "u", revision: 1, status: "active", mode: "auto", dataClassification: "confidential", retentionClass: "standard" } as CodeSession;
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function setup(options: { timeoutMs?: number; enabled?: boolean; failChanges?: boolean; cancelFence?: boolean } = {}) {
  const store = new InMemoryWorkspaceStore(), log = new CodeRunStateLog({ store });
  const inbox = new CodeSessionInboxService({ store: store.codeInbox, flags: { assertEnabled: async () => true, isEnabled: async () => true }, loadSession: async () => session, loadRunState: (c, r) => log.loadRunState(c, r), audit: async () => {} });
  let done = false, enabled = options.enabled ?? true;
  const port: TrackedProcessPort = { supported: async () => true,
    start: vi.fn(async (_ctx, _input, op, prepare) => { await prepare({ sandboxId: "sandbox", mounted: false, files: [] }); return { processId: op.processId, status: "running", exitCode: null }; }),
    status: vi.fn(async () => ({ status: done ? "completed" : "running", exitCode: done ? 0 : null })),
    output: async () => ({ output: "", offset: 0, lossy: false }), stop: async () => ({ status: "stopped", exitCode: null }), sync: vi.fn(async () => {}) };
  const processes = new CodeAsyncProcessService({ store: store.codeProcesses!, port, flags: { assertEnabled: async () => true }, session: async () => session, run: (c, r) => log.loadRunState(c, r) });
  inbox.setWakeTask(async () => {});
  const collector = () => { const service = new CodeProcessCompletionService({ store: store.codeProcesses!, processes, inbox, loadSession: async () => session, enabled: async () => true, progress: () => {}, warn: () => {} }); closes.push(() => service.close()); return service; };
  const completions = collector(), barrier = vi.spyOn(completions, "barrier");
  closes.push(() => processes.close(), () => inbox.close(() => {}));
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const transcript: string[] = [], order: string[] = [];
  const invoke = vi.fn(async (_ctx, input: { tool: string }) => {
    order.push(input.tool);
    expect((await processes.list(ctx, scope)).every(op => op.runId !== "r" || !!op.completion?.admission)).toBe(true);
    return { ok: true as const, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { checks: [{ tool: "test", passed: true }] }, truncated: false, durationMs: 1 };
  });
  const changes = vi.fn(async (_ctx, _session, operations: readonly DurableCodeProcess[]) => {
    if (options.failChanges) throw new Error("missing diff");
    return operations.length ? [{ path: "src/child.ts", tool: "code.agent.spawn_async", diff: "--- a/src/child.ts\n+++ b/src/child.ts\n-old\n+new" }] : [];
  });
  const release = vi.fn(async () => { order.push("release"); });
  const runner = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: { listTools: () => [], invoke }, schemas: [], runState: log, inbox, completions,
    asyncCollect: { enabled: async () => enabled, timeoutMs: options.timeoutMs ?? 2000, changes }, sandbox: { release },
    ...(options.cancelFence ? { activeChildren: { settle: async () => false, isUnsettled: async () => true } } : {}),
    engine: { chat: async request => {
      const review = request.messages.some(m => String(m.content).includes("self-review"));
      if (review) { order.push("review"); return { content: JSON.stringify({ status: "clean", findings: [] }) }; }
      transcript.push(request.messages.map(m => String(m.content)).join("\n"));
      if (transcript.length === 1) { entered(); await gate; }
      order.push("model"); return { content: "done" };
    } } });
  const scope = { companyId: "c", projectId: "p", sessionId: "s" }, durableScope = inbox.scope(session);
  const child = async (id = "child") => {
    await store.codeProcesses!.transact(durableScope, { kind: "reserve-child", operationId: id, childRunId: id, toolCallId: id, agentType: "explore", runId: "r", owner: "worker" });
    await store.codeProcesses!.transact(durableScope, { kind: "update-child", childRunId: id, owner: "worker", state: "running" });
  };
  const settle = async (id = "child", state: "completed" | "failed" | "interrupted" = "completed") => {
    await store.codeProcesses!.transact(durableScope, { kind: "update-child", childRunId: id, owner: "worker", state,
      ...(state === "failed" ? { errorCode: "child_check_failed" } : {}), outcome: { answer: '{"findings":[],"files":[],"symbols":[]}', filesChanged: ["src/child.ts"] } });
  };
  const run = (signal?: AbortSignal, initialTurnIndex?: number, owner = "worker") => runner.run({ ctx, session, prompt: "fix src/child.ts", runId: "r", runStateOwner: owner, verificationTools: ["test"], signal, initialTurnIndex });
  return { store, log, inbox, processes, completions, collector, barrier, port, ready, resume, transcript, order, invoke, changes, release, child, settle, run, scope,
    disable: () => { enabled = false; }, finishProcess: () => { done = true; } };
}

describe("Step 7 collect barrier before existing C9", () => {
  it("joins two children, admits each once, then verifies and reviews their changed tree", async () => {
    const h = setup(), running = h.run(); await h.ready; await h.child("one"); await h.child("two"); h.resume();
    await vi.waitFor(() => expect(h.barrier).toHaveBeenCalled());
    expect(h.invoke).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    await h.settle("one"); await h.completions.recover(ctx, session);
    expect(h.invoke).not.toHaveBeenCalled(); await h.settle("two");
    const result = await running;
    expect(result.status).toBe("completed"); expect(result.summary.filesChanged).toContain("src/child.ts");
    expect(result.verification?.status).toBe("passed"); expect(result.selfReview?.status).toBe("clean");
    expect(h.order.indexOf("code.verify.run")).toBeLessThan(h.order.indexOf("review")); expect(h.order.at(-1)).toBe("release");
    expect(h.transcript).toHaveLength(2); expect(h.transcript[1]).toContain('"detached":true');
    for (const op of await h.processes.list(ctx, h.scope)) expect(op.events.filter(e => e.type === "result.admitted")).toHaveLength(1);
    expect(h.port.status).not.toHaveBeenCalled(); // Children are never reconciled by the shell process manager.
  });
  it("joins the same tracked process and syncs it before verification", async () => {
    const h = setup(), running = h.run(); await h.ready;
    await h.processes.start(ctx, { ...h.scope, runId: "r", leaseOwner: "worker", toolCallId: "process", command: "npm test", timeoutMs: 10000 });
    h.resume(); await vi.waitFor(() => expect(h.barrier).toHaveBeenCalled()); expect(h.invoke).not.toHaveBeenCalled();
    h.finishProcess(); expect((await running).status).toBe("completed"); expect(h.port.start).toHaveBeenCalledOnce(); expect(h.port.sync).toHaveBeenCalled();
  });
  it("does not wait for a cancelled preparation that never dispatched a producer", async () => {
    const h = setup(), running = h.run(); await h.ready;
    h.port.start = async () => { throw new Error("preparation failed"); };
    await expect(h.processes.start(ctx, { ...h.scope, runId: "r", leaseOwner: "worker", toolCallId: "process", command: "npm test", timeoutMs: 10000 })).rejects.toThrow("preparation failed");
    h.resume(); expect((await running).status).toBe("completed"); expect(h.changes).toHaveBeenCalledWith(ctx, session, []);
  });
  it.each(["interrupted", "unknown_outcome", "timeout"])("withholds verification and release for %s and leaves the same run resumable", async state => {
    const h = setup({ timeoutMs: 10 }), running = h.run(); await h.ready; await h.child();
    if (state === "interrupted") await h.settle("child", "interrupted");
    if (state === "unknown_outcome") await h.store.codeProcesses!.transact(h.inbox.scope(session), { kind: "update", operationId: "child", owner: "worker", generation: 1, state: "unknown_outcome" });
    h.resume(); const result = await running;
    expect(result).toMatchObject({ status: "interrupted", reason: "async_collect_unsettled" }); expect(h.invoke).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    expect(await h.log.loadRunState("c", "r")).toMatchObject({ status: "interrupted", finishedAt: null, leaseOwner: null });
  });
  it("delivers a failed child's structured outcome to the parent before checking the tree", async () => {
    const h = setup(), running = h.run(); await h.ready; await h.child(); await h.settle("child", "failed"); h.resume();
    expect((await running).status).toBe("completed"); expect(h.transcript[1]).toContain("child_check_failed"); expect(h.transcript[1]).toContain('"status":"failed"');
  });
  it("disabled flag preserves the legacy path", async () => {
    const h = setup({ enabled: false }), running = h.run(); await h.ready; await h.child(); h.resume();
    expect((await running).status).toBe("completed"); expect(h.barrier).not.toHaveBeenCalled(); expect(h.changes).not.toHaveBeenCalled();
  });
  it("rollback during collection leaves the pending producer fenced", async () => {
    const h = setup(), running = h.run(); await h.ready; await h.child(); h.resume(); await vi.waitFor(() => expect(h.barrier).toHaveBeenCalled()); h.disable();
    expect((await running).reason).toBe("async_collect_unsettled"); expect(h.invoke).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  });
  it("cancellation breaks a wait and uses the existing terminal cleanup path", async () => {
    const h = setup(), controller = new AbortController(), running = h.run(controller.signal); await h.ready; await h.child(); h.resume();
    await vi.waitFor(() => expect(h.barrier).toHaveBeenCalled()); controller.abort();
    expect((await running).status).toBe("cancelled"); expect(h.invoke).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("cancellation cannot release a sandbox while the existing child settlement fence is held", async () => {
    const h = setup({ cancelFence: true }), controller = new AbortController(), running = h.run(controller.signal); await h.ready; await h.child(); h.resume();
    await vi.waitFor(() => expect(h.barrier).toHaveBeenCalled()); controller.abort();
    expect(await running).toMatchObject({ status: "interrupted", reason: "active_subagent_unsettled" }); expect(h.release).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
  });
  it("refuses a tree whose async diff cannot be reconstructed", async () => {
    const h = setup({ failChanges: true }), running = h.run(); await h.ready; await h.child(); await h.settle(); h.resume();
    expect((await running).reason).toBe("async_collect_unsettled"); expect(h.invoke).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  });
  it("a fresh collector reconstructs its barrier from durable records without spawning", async () => {
    const h = setup(); await h.log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId: "r", owner: "worker" });
    await h.inbox.transact(session, { kind: "open", runId: "r", owner: "worker" }); await h.child(); await h.settle(); await h.completions.close();
    const fresh = h.collector(); expect((await fresh.barrier(ctx, session, "r")).ready).toBe(false);
    const messages = (await h.inbox.transact(session, { kind: "drain", runId: "r", owner: "worker", turnIndex: 1 })).messages;
    const collected = (await fresh.collect(ctx, session, messages[0]!, "r"))!;
    await fresh.admitted(session, collected.notice, { runId: "r", owner: "worker", turnIndex: 1, text: collected.text, source: "inbox" });
    expect((await fresh.barrier(ctx, session, "r")).ready).toBe(true); expect((await fresh.barrier(ctx, session, "other-run")).operations).toEqual([]); expect(h.port.start).not.toHaveBeenCalled();
  });
  it("C10 resumes the same parent after a pending barrier and then verifies settled child changes", async () => {
    const h = setup({ timeoutMs: 10 }), running = h.run(); await h.ready; await h.child(); h.resume();
    expect((await running).reason).toBe("async_collect_unsettled"); await h.settle();
    await h.completions.recover(ctx, session);
    expect((await h.inbox.transact(session, { kind: "read" })).state.messages[0]?.target).toBe("next-turn");
    const cursor = (await h.log.loadRunState("c", "r"))!.turnIndex;
    expect((await h.log.resumeRun({ companyId: "c", runId: "r", owner: "replacement" })).held).toBe(true);
    await expect(h.inbox.transact(session, { kind: "collect-completions", runId: "r", owner: "worker" })).rejects.toThrow("inbox_lease_lost");
    const notice = (await h.processes.list(ctx, h.scope))[0]!.completion!.notice;
    await h.inbox.transact(session, { kind: "completion-submit", notice: { ...notice, eventId: "foreign-event", operationId: "foreign-op", parentRunId: "foreign-run" }, authorId: ctx.userId });
    const resumed = await h.run(undefined, cursor, "replacement");
    expect(resumed.status).toBe("completed"); expect(resumed.verification?.status).toBe("passed");
    expect((await h.processes.list(ctx, h.scope))[0]!.events.filter(e => e.type === "result.admitted")).toHaveLength(1);
    expect((await h.inbox.transact(session, { kind: "read" })).state.messages.find(m => m.completion?.eventId === "foreign-event")).toMatchObject({ target: "next-turn", status: "pending" });
  });
  it("C10's new parent lease adopts and settles the same tracked process without respawn", async () => {
    const h = setup({ timeoutMs: 50 }), running = h.run(); await h.ready;
    const first = await h.processes.start(ctx, { ...h.scope, runId: "r", leaseOwner: "worker", toolCallId: "process", command: "npm test", timeoutMs: 10000 });
    h.resume(); expect((await running).reason).toBe("async_collect_unsettled"); h.finishProcess();
    const cursor = (await h.log.loadRunState("c", "r"))!.turnIndex;
    expect((await h.log.resumeRun({ companyId: "c", runId: "r", owner: "replacement" })).held).toBe(true);
    expect((await h.run(undefined, cursor, "replacement")).status).toBe("completed");
    const op = (await h.processes.list(ctx, h.scope))[0]!;
    expect(op).toMatchObject({ processId: first.processId, owner: "replacement", generation: 2, state: "completed" });
    expect(h.port.start).toHaveBeenCalledOnce(); expect(op.completion?.admission?.runId).toBe("r");
  });
});

function changeInput(op: DurableCodeProcess) {
  return { session, operations: [op], childChanges: () => [] as Array<{ path: string; tool: string; diff: string }>, listFiles: async () => [{ path: "new.ts" }], readFile: async () => ({ content: "export const value = 1;\n" }), diff: async () => ({ diff: "" }) };
}
describe("Step 7 trusted async change evidence", () => {
  async function terminal() {
    const h = setup(); await h.log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId: "r", owner: "worker" });
    await h.inbox.transact(session, { kind: "open", runId: "r", owner: "worker" }); await h.child(); await h.settle(); await h.completions.recover(ctx, session);
    const message = (await h.inbox.transact(session, { kind: "read" })).state.messages[0]!;
    const collected = (await h.completions.collect(ctx, session, message, "r"))!;
    await h.completions.admitted(session, collected.notice, { runId: "r", owner: "worker", turnIndex: 1, text: collected.text, source: "inbox" });
    return (await h.processes.list(ctx, h.scope))[0]!;
  }
  it("reads a dedicated child's trusted tracker, never its answer as a diff", async () => {
    const op = await terminal(); op.child!.sessionId = "child-session";
    const input = changeInput(op); input.childChanges = () => [{ path: "src/child.ts", tool: "code.fs.edit", diff: "-old\n+actual" }];
    expect(await collectAsyncOperationChanges(input)).toEqual(input.childChanges());
  });
  it("uses canonical workspace diff after restart and fails closed if it is missing", async () => {
    const input = changeInput(await terminal()); await expect(collectAsyncOperationChanges(input)).rejects.toThrow("evidence_missing");
    input.diff = async () => ({ diff: "-old\n+actual" }); expect((await collectAsyncOperationChanges(input))[0]?.diff).toBe("-old\n+actual");
  });
  it("does not mistake a recovered child's durable file count without paths for zero changes", async () => {
    const input = { ...changeInput(await terminal()), childFileCount: async () => 2 };
    await expect(collectAsyncOperationChanges(input)).rejects.toThrow("evidence_missing");
  });
  it("includes an untracked file from a process, and excludes unchanged snapshot files", async () => {
    const op = await terminal(); op.kind = "process"; op.workspaceSnapshot = { sandboxId: "sandbox", mounted: false, files: [] };
    const input = changeInput(op); expect((await collectAsyncOperationChanges(input))[0]).toMatchObject({ path: "new.ts", status: "added" });
    op.workspaceSnapshot.files = [{ path: "new.ts", revision: "1", hash: createHash("sha256").update((await input.readFile()).content).digest("hex") }];
    expect(await collectAsyncOperationChanges(input)).toEqual([]);
  });
  it("requires v2 mounted baseline and detects mounted edits against hashes without uploading", async () => {
    const op = await terminal(); op.kind = "process"; op.workspaceSnapshot = { sandboxId: "sandbox", mounted: true, files: [] };
    const input = changeInput(op); await expect(collectAsyncOperationChanges(input)).rejects.toThrow("evidence_missing");
    op.workspaceSnapshot.version = 2; expect((await collectAsyncOperationChanges(input))[0]).toMatchObject({ path: "new.ts", status: "added" });
    op.workspaceSnapshot.files = [{ path: "new.ts", revision: "1", hash: "before" }]; input.diff = async () => ({ diff: "-old\n+actual" });
    expect((await collectAsyncOperationChanges(input))[0]).toMatchObject({ status: "modified", diff: "-old\n+actual" });
  });
  it("does not review build artifacts that the existing workspace sync excludes", async () => {
    const op = await terminal(); op.kind = "process"; op.workspaceSnapshot = { sandboxId: "sandbox", mounted: false, files: [] };
    const input = changeInput(op); input.listFiles = async () => [{ path: "node_modules/tool/generated.js" }, { path: "dist/index.js" }];
    expect(await collectAsyncOperationChanges(input)).toEqual([]);
  });
  it("refuses secret diffs and a foreign operation", async () => {
    const input = changeInput(await terminal()); input.diff = async () => ({ diff: "+DATABASE_URL=postgres://admin:password@db.example/test" });
    await expect(collectAsyncOperationChanges(input)).rejects.toThrow("collect_change_secret"); input.operations[0]!.companyId = "foreign";
    await expect(collectAsyncOperationChanges(input)).rejects.toThrow("collect_change_scope");
  });
  it("keeps child tracker evidence session scoped and across Continue turns", () => {
    const tracker = new CodeTurnTracker();
    const change = { path: "a.ts", tool: "code.fs.edit", sha256: "hash", linesAdded: 1, linesRemoved: 0, at: "now", diff: "+new" };
    tracker.recordChange("child", "turn-1", change); tracker.recordChange("child", "turn-2", { ...change, diff: "+latest" }); tracker.recordChange("foreign", "turn-1", { ...change, path: "foreign.ts" });
    expect(tracker.sessionChanges("child")).toMatchObject([{ path: "a.ts", diff: "+latest" }]);
  });
});
