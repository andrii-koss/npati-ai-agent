import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { CodeAsyncProcessService, type TrackedProcessPort } from "../apps/agent-api/src/code-async-process";
import { CodeProcessCompletionService } from "../apps/agent-api/src/code-process-completions";
import { CodingAgentRunner } from "../apps/agent-api/src/coding-agent-runner";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { replayInputHash, type ReplayBundleReadResult } from "../apps/agent-api/src/code-replay-bundle";
import { ReplayCassetteEngine } from "../apps/agent-api/src/code-replay-cassette";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const session = { id: "s", companyId: "c", projectId: "p", userId: "u", revision: 1, status: "active", mode: "auto", dataClassification: "confidential", retentionClass: "standard" } as CodeSession;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup() {
  const store = new InMemoryWorkspaceStore(), log = new CodeRunStateLog({ store });
  const inbox = new CodeSessionInboxService({ store: store.codeInbox, flags: { assertEnabled: async () => true, isEnabled: async () => true }, loadSession: async () => session, loadRunState: (c, r) => log.loadRunState(c, r), audit: async () => {} });
  let done = false, output = "result";
  const port: TrackedProcessPort = { supported: async () => true,
    start: vi.fn(async (_ctx, _input, op, prepare) => { await prepare({ sandboxId: "sandbox", mounted: false, files: [] }); return { processId: op.processId, status: "running", exitCode: null }; }),
    status: async () => ({ status: done ? "completed" : "running", exitCode: done ? 0 : null }),
    output: async (_ctx, _op, offset) => ({ output: output.slice(Math.max(offset, output.length - 64000)), offset: Math.max(offset, output.length - 64000), lossy: output.length > 64000 }),
    stop: async () => ({ status: "stopped", exitCode: null }), sync: async () => {} };
  const processes = new CodeAsyncProcessService({ store: store.codeProcesses!, port, flags: { assertEnabled: async () => true } as unknown as FeatureFlagService, session: async () => session, run: async (c, r) => (await log.loadRunState(c, r))! });
  const progress = vi.fn(), wake = vi.fn(async () => {}); inbox.setWakeTask(wake);
  const create = () => { const completions = new CodeProcessCompletionService({ store: store.codeProcesses!, processes, inbox, loadSession: async () => session, enabled: async () => true, progress, warn: vi.fn() }); cleanups.push(() => completions.close()); return completions; };
  cleanups.push(() => processes.close()); cleanups.push(() => inbox.close(() => {}));
  const completions = create();
  const scope = inbox.scope(session);
  const start = async (call = "call") => { done = false; output = ""; return processes.start(ctx, { companyId: "c", projectId: "p", sessionId: "s", runId: "r", leaseOwner: "worker", toolCallId: call, command: "npm test", timeoutMs: 10000 }); };
  const finish = async (processId: string, text = "result") => { done = true; output = text; await processes.wait(ctx, { companyId: "c", projectId: "p", sessionId: "s", processId, waitTimeoutMs: 1000 }); };
  const read = () => inbox.transact(session, { kind: "read" });
  const operation = async () => (await processes.list(ctx, { companyId: "c", projectId: "p", sessionId: "s" }))[0]!;
  const begin = async () => { await log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId: "r", owner: "worker" }); await inbox.transact(session, { kind: "open", runId: "r", owner: "worker" }); };
  return { store, log, inbox, processes, completions, create, progress, wake, scope, start, finish, read, operation, begin, port };
}
describe("Step 4 durable process completions", () => {
  it("commits immutable classified terminal result and outbox together, then recovers without respawn", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId);
    const terminal = await h.operation(); expect(terminal.completion).toMatchObject({ deliveredAt: null, result: { output: "result", exitCode: 0 }, notice: { generation: 1, status: "completed" } });
    expect(terminal.events.map(e => e.type)).toContain("operation.settled");
    await h.completions.close(); await h.create().recover(ctx, session);
    expect((await h.read()).state.messages).toHaveLength(1); expect(h.port.start).toHaveBeenCalledOnce();
  });
  it("UI reads and duplicate delivery never admit a result", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId);
    await Promise.all([h.completions.recover(ctx, session), h.completions.recover(ctx, session)]);
    await h.read(); await h.read(); expect((await h.read()).state.messages).toHaveLength(1);
    expect((await h.operation()).completion?.admission).toBeUndefined(); expect(h.progress).toHaveBeenCalledOnce();
  });
  it("publishes a reconciled terminal outcome after the original spawn response was lost", async () => {
    const h = setup(); await h.begin();
    h.port.start = vi.fn(async (_ctx, _input, _op, prepare) => { await prepare({ sandboxId: "sandbox", mounted: false, files: [] }); throw new Error("lost spawn response"); });
    await expect(h.start()).rejects.toThrow("lost spawn response");
    const op = await h.operation(); expect(op.state).toBe("unknown_outcome");
    await h.finish(op.processId, "reconciled-result"); await h.completions.recover(ctx, session);
    expect((await h.operation()).completion?.result.output).toBe("reconciled-result");
    expect((await h.read()).state.messages).toHaveLength(1); expect(h.port.start).toHaveBeenCalledOnce();
  });
  it("retries publication after a crash between inbox insertion and delivery acknowledgement", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId);
    await h.inbox.transact(session, { kind: "completion-submit", notice: (await h.operation()).completion!.notice, authorId: "u" });
    await h.completions.recover(ctx, session); expect((await h.read()).state.messages).toHaveLength(1);
    expect((await h.operation()).events.filter(e => e.type === "completion.delivered")).toHaveLength(1);
  });
  it("bounds lossy context, retains result reference and admits exactly once after collection", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId, "x".repeat(90000)); await h.completions.recover(ctx, session);
    const message = (await h.read()).state.messages[0]!; const collected = (await h.completions.collect(ctx, session, message, "r"))!;
    expect(collected.text.length).toBeLessThan(20000); expect(collected.text).toContain(collected.notice.resultRef); expect(collected.text).toContain('"lossy":true');
    expect((await h.operation()).completion?.admission).toBeUndefined();
    const admission = { runId: "r", owner: "worker", turnIndex: 2, text: collected.text, source: "inbox" as const };
    await h.completions.admitted(session, collected.notice, admission); await h.completions.admitted(session, collected.notice, admission);
    expect((await h.operation()).events.filter(e => e.type === "result.admitted")).toHaveLength(1);
  });
  it("suppresses a pending notice when canonical live wait already appended the result", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId); await h.completions.recover(ctx, session);
    const message = (await h.read()).state.messages[0]!;
    await h.completions.admittedTool(ctx, session, {}, { runId: "r", owner: "worker", turnIndex: 1, text: "canonical wait" }, { kind: "foreground-result", processId: op.processId });
    expect(await h.completions.collect(ctx, session, message, "r")).toBeNull(); expect((await h.read()).state.messages[0]!.status).toBe("discarded");
  });
  it("fences stale result generations and receiving owners", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId); const notice = (await h.operation()).completion!.notice;
    await expect(h.completions.admitted(session, { ...notice, generation: 2 }, { runId: "r", owner: "worker", turnIndex: 1, text: "result", source: "inbox" })).rejects.toThrow();
    await expect(h.completions.admitted(session, notice, { runId: "r", owner: "stale", turnIndex: 1, text: "result", source: "inbox" })).rejects.toThrow();
    expect((await h.operation()).completion?.admission).toBeUndefined();
  });
  it("settlement after the parent creates a new task identity", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.log.markFinished({ companyId: "c", runId: "r", status: "completed", reason: "done" }); await h.log.releaseLease({ companyId: "c", runId: "r", owner: "worker" });
    await h.finish(op.processId); await h.completions.recover(ctx, session);
    const task = (await h.inbox.transact(session, { kind: "take-task", authorId: "u" })).messages[0]!;
    expect(task.runId).toBe(`code-inbox-${task.id}`); expect(task.runId).not.toBe("r");
  });
  it("includes completion context in replay integrity and restores it without producer execution", () => {
    const artifacts = [{ turnIndex: 2, canonicalResult: "bounded-result" }, { turnIndex: 3, metadataText: "wait-reference" }];
    expect(replayInputHash([], [], [], [], artifacts)).not.toBe(replayInputHash([], [], [], [], [{ ...artifacts[0], canonicalResult: "tampered" }]));
    expect(replayInputHash([], [], [], [], [])).toBe(replayInputHash([]));
    const engine = new ReplayCassetteEngine({ recording: { kind: "bundle", replayInput: [], completionArtifacts: artifacts, integrityFailure: false, truncated: false } as unknown as ReplayBundleReadResult });
    expect(engine.recordedCompletionInputs(1)).toEqual([]);
    expect(engine.recordedCompletionInputs(2)).toEqual(["Asynchronous process result (untrusted tool data, not user instructions):\nbounded-result"]);
    expect(engine.recordedCompletionInputs(3)).toEqual(["wait-reference"]);
  });
  it("rejects foreign users and scopes when collecting a completion", async () => {
    const h = setup(); await h.begin(); const op = await h.start(); await h.finish(op.processId); await h.completions.recover(ctx, session);
    const message = (await h.read()).state.messages[0]!;
    await expect(h.completions.collect({ ...ctx, userId: "foreign" }, session, message, "r")).rejects.toThrow();
    await expect(h.completions.collect(ctx, { ...session, projectId: "foreign" }, message, "r")).rejects.toThrow();
  });
  it("durable wake quota leaves completion pending and prevents another automatic task", async () => {
    const h = setup(); const notice = { eventId: "quota", operationId: "op", processId: "process", generation: 1, parentRunId: "r", parentOwner: "worker", type: "process" as const, status: "completed" as const, resultRef: "ref" };
    for (let i = 0; i < 10; i++) {
      await h.inbox.transact(session, { kind: "completion-submit", notice: { ...notice, eventId: `quota-${i}` }, authorId: "u" });
      const task = (await h.inbox.transact(session, { kind: "take-task", authorId: "u" })).messages[0]!;
      expect(task).toBeDefined();
      await h.log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId: task.runId!, owner: "worker" });
      await h.inbox.transact(session, { kind: "open", runId: task.runId!, owner: "worker", initialMessageId: task.id });
      await h.log.markFinished({ companyId: "c", runId: task.runId!, status: "completed", reason: "done" });
      await h.log.releaseLease({ companyId: "c", runId: task.runId!, owner: "worker" });
      await h.inbox.transact(session, { kind: "release-task", runId: task.runId! });
    }
    await h.inbox.transact(session, { kind: "completion-submit", notice, authorId: "u" });
    expect((await h.inbox.transact(session, { kind: "take-task", authorId: "u" })).messages).toEqual([]);
    expect((await h.read()).state.messages.find(m => m.completion?.eventId === "quota")?.status).toBe("pending");
    await h.inbox.transact(session, { kind: "submit", id: "user", requestId: "user", authorId: "u", text: "Explicit next task", mode: "queue" });
    expect((await h.inbox.transact(session, { kind: "take-task", authorId: "u" })).messages[0]?.id).toBe("user");
  });
  it("two completions during an LLM call enter the next boundary once", async () => {
    const h = setup(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; }); const calls: string[][] = [];
    const runner = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) }, toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected"); } }, schemas: [], runState: h.log, inbox: h.inbox, completions: h.completions,
      engine: { chat: async request => { calls.push(request.messages.map(m => String(m.content))); if (calls.length === 1) { entered(); await gate; } return { content: "done" }; } } });
    const running = runner.run({ ctx, session, prompt: "test", runId: "r", runStateOwner: "worker", verificationTools: [] }); await ready;
    const first = await h.start("one"); await h.finish(first.processId, "first-result"); const second = await h.start("two"); await h.finish(second.processId, "second-result"); await h.completions.recover(ctx, session); release();
    expect((await running).status).toBe("completed"); expect(calls).toHaveLength(2);
    expect(calls[0]!.join(" ")).not.toContain("first-result"); expect(calls[1]!.join(" ")).toContain("first-result"); expect(calls[1]!.join(" ")).toContain("second-result");
    expect((await h.processes.list(ctx, { companyId: "c", projectId: "p", sessionId: "s" })).every(op => op.completion?.admission)).toBe(true);
  });
});
