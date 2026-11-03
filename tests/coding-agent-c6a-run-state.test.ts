import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext, CodeRunToolCallRecord, CodeSession } from "@npati/workspace";
import type { ChatResult } from "@npati/omniroute-adapter";
import {
  assertNoSensitiveRunState,
  CodeRunStateLog,
  type CodeRunStateStorePort,
} from "../apps/agent-api/src/code-run-state";
import {
  CodingAgentRunner,
  type CodingAgentRunnerPorts,
  type CodeRunToolDescriptor,
} from "../apps/agent-api/src/coding-agent-runner";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";

/**
 * C6a security-gate suite: the durable run state.
 *
 * The point of this suite is not that a row can be written — it is that the four properties the recovery
 * depends on actually hold: the state is written as the run advances (not only at the end), every write is
 * idempotent, a lease decides who may write, and a call that was interrupted stays visibly in doubt.
 *
 * The real `InMemoryWorkspaceStore` is used rather than a hand-written double: the sequence guard, the lease
 * transition and the tool-call merge are store semantics, and a fake would let them drift from the postgres
 * implementation that production actually uses.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function setup(options: { now?: () => number; leaseMs?: number; heartbeatMs?: number } = {}) {
  const store = new InMemoryWorkspaceStore();
  const clock = { t: options.now ? options.now() : Date.parse("2026-01-01T00:00:00.000Z") };
  const now = options.now ?? (() => clock.t);
  const log = new CodeRunStateLog({
    store: store as unknown as CodeRunStateStorePort,
    now,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  return { store, log, clock, now };
}

function pendingCall(toolCallId: string, tool: string, readOnly: boolean, at: number): CodeRunToolCallRecord {
  return { toolCallId, tool, readOnly, outcome: "unknown_outcome", startedAt: new Date(at), finishedAt: null };
}

describe("security-gate: C6a run state — written as the run advances", () => {
  it("creates a leased running row and generates a run id when the caller has none", async () => {
    const { store, log } = setup();
    const started = await log.startRun({
      ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a",
    });
    expect(started.runId).toMatch(/^code-run-/);
    const stored = await store.getCodeRunState("company-1", started.runId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("running");
    expect(stored?.leaseOwner).toBe("worker-a");
    expect(stored?.turnIndex).toBe(0);
  });

  it("is idempotent by run id: a retried start cannot rewind the cursor or steal the lease", async () => {
    const { store, log } = setup();
    const started = await log.startRun({
      ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a", runId: "run-1",
    });
    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 3, status: "finished", outcome: "ok" });
    const before = await store.getCodeRunState("company-1", "run-1");
    const restarted = await log.startRun({
      ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-b", runId: "run-1",
    });
    expect(restarted.runId).toBe(started.runId);
    const after = await store.getCodeRunState("company-1", "run-1");
    expect(after?.turnIndex).toBe(before?.turnIndex);
    expect(after?.lastEventSeq).toBe(before?.lastEventSeq);
    // The second worker must not have taken a lease it does not hold.
    expect(after?.leaseOwner).toBe("worker-a");
  });

  it("persists every turn and every tool call immediately, with a strictly increasing sequence", async () => {
    const { store, log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    const seqs: number[] = [];

    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "running" });
    seqs.push((await store.getCodeRunState("company-1", "run-1"))!.lastEventSeq);
    // The turn is readable before any tool call ran: the boundary exists first.
    expect((await store.getCodeRunTurn("company-1", "run-1", 1))?.status).toBe("running");

    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "call-1", tool: "code.fs.read",
      readOnly: true, outcome: "unknown_outcome", finishedAt: null,
    });
    seqs.push((await store.getCodeRunState("company-1", "run-1"))!.lastEventSeq);
    let turn = await store.getCodeRunTurn("company-1", "run-1", 1);
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.toolCalls[0]?.outcome).toBe("unknown_outcome");

    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "call-1", tool: "code.fs.read",
      readOnly: true, outcome: "ok",
    });
    seqs.push((await store.getCodeRunState("company-1", "run-1"))!.lastEventSeq);
    turn = await store.getCodeRunTurn("company-1", "run-1", 1);
    // The terminal write replaced the write-ahead record: one call, not two rows.
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.toolCalls[0]?.outcome).toBe("ok");

    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "finished", outcome: "ok" });
    seqs.push((await store.getCodeRunState("company-1", "run-1"))!.lastEventSeq);

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await store.getCodeRunTurn("company-1", "run-1", 1))?.status).toBe("finished");
  });

  it("ignores a write whose sequence is not greater than the stored one", async () => {
    const { store, log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    const stored = await store.getCodeRunState("company-1", "run-1");
    const seq = stored!.lastEventSeq;
    await store.applyCodeRunStateEvent({ companyId: "company-1", runId: "run-1", seq: seq + 1, turnIndex: 5 });
    const afterFirst = await store.getCodeRunState("company-1", "run-1");
    const replayed = await store.applyCodeRunStateEvent({ companyId: "company-1", runId: "run-1", seq: seq + 1, turnIndex: 9 });
    expect(replayed.turnIndex).toBe(afterFirst?.turnIndex);
    expect(replayed.lastEventSeq).toBe(afterFirst?.lastEventSeq);
    expect(replayed.revision).toBe(afterFirst?.revision);
  });

  it("keeps a second writer alive by adopting the sequence it lost a race to", async () => {
    const { store } = setup();
    const logA = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => 1_000 });
    const logB = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => 1_000 });
    await logA.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    await logA.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "running" });
    // B has never written, so its counter starts at 1 while the row is already at 2: B must not silently drop.
    await logB.markHeartbeat({ companyId: "company-1", runId: "run-1" });
    const after = await store.getCodeRunState("company-1", "run-1");
    expect(after?.heartbeatAt).not.toBeNull();
    expect(after?.lastEventSeq).toBeGreaterThan(2);
  });
});

describe("security-gate: C6a run state — the lease decides who may write", () => {
  it("refuses an acquire while another owner holds a live lease, and allows it after the lease expires", async () => {
    const { store, log, clock } = setup({ leaseMs: 1_000 });
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    const refused = await log.acquireLease({ companyId: "company-1", runId: "run-1", owner: "worker-b" });
    expect(refused.held).toBe(false);
    expect((await store.getCodeRunState("company-1", "run-1"))?.leaseOwner).toBe("worker-a");

    clock.t += 5_000;
    const taken = await log.acquireLease({ companyId: "company-1", runId: "run-1", owner: "worker-b" });
    expect(taken.held).toBe(true);
    expect((await store.getCodeRunState("company-1", "run-1"))?.leaseOwner).toBe("worker-b");
  });

  it("reports `held: false` on renewal by a non-owner and releases only for the owner", async () => {
    const { store, log } = setup({ leaseMs: 60_000 });
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    const renewByStranger = await log.renewLease({ companyId: "company-1", runId: "run-1", owner: "worker-b" });
    expect(renewByStranger.held).toBe(false);

    const renewByOwner = await log.renewLease({ companyId: "company-1", runId: "run-1", owner: "worker-a" });
    expect(renewByOwner.held).toBe(true);
    expect(renewByOwner.state.heartbeatAt).not.toBeNull();

    await log.releaseLease({ companyId: "company-1", runId: "run-1", owner: "worker-b" });
    expect((await store.getCodeRunState("company-1", "run-1"))?.leaseOwner).toBe("worker-a");
    await log.releaseLease({ companyId: "company-1", runId: "run-1", owner: "worker-a" });
    expect((await store.getCodeRunState("company-1", "run-1"))?.leaseOwner).toBeNull();
  });

  it("lists only running rows whose lease is gone", async () => {
    const { store, log, clock } = setup({ leaseMs: 1_000 });
    // Created at T0 with a 1s lease: expired by the time we look.
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "stale" });
    clock.t += 10_000;
    // Created at T0+10s with a 1s lease: still live at T0+10.5s.
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "live" });
    clock.t += 500;

    const stale = await log.listStaleRuns({ now: new Date(clock.t) });
    expect(stale.map((row) => row.runId)).toEqual(["stale"]);

    await log.markFinished({ companyId: "company-1", runId: "stale", status: "completed" });
    clock.t += 10_000;
    // Now the second run's lease is gone too, and a finished run is never listed again.
    const afterFinish = await log.listStaleRuns({ now: new Date(clock.t) });
    expect(afterFinish.map((row) => row.runId)).toEqual(["live"]);
    expect((await store.getCodeRunState("company-1", "stale"))?.status).toBe("completed");
  });
});

describe("security-gate: C6a run state — the recovery boundary", () => {
  it("separates replayable read-only calls from calls whose result must never be repeated", async () => {
    const { log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    // Turn 1 finished cleanly with a checkpoint.
    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "running" });
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "t1-call-1", tool: "code.fs.read",
      readOnly: true, outcome: "ok",
    });
    await log.appendTurn({
      companyId: "company-1", runId: "run-1", turnIndex: 1, status: "finished", outcome: "ok", checkpointId: "cp-1",
    });
    // Turn 2 died with two calls in flight: one read-only, one mutating.
    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running" });
    await log.appendTurn({
      companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running",
      toolCalls: [pendingCall("t2-read", "code.fs.read", true, 1_000)],
    });
    await log.appendTurn({
      companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running",
      toolCalls: [pendingCall("t2-write", "code.fs.edit", false, 1_000)],
    });

    const boundary = await log.loadTurnBoundary("company-1", "run-1");
    expect(boundary).not.toBeNull();
    expect(boundary?.lastFinishedTurn).toBe(1);
    expect(boundary?.checkpointId).toBe("cp-1");
    expect(boundary?.incompleteTurn?.turnIndex).toBe(2);
    expect(boundary?.replayableReadOnlyToolCalls.map((call) => call.toolCallId)).toEqual(["t2-read"]);
    expect(boundary?.unknownOutcomeToolCalls.map((call) => call.toolCallId)).toEqual(["t2-write"]);
  });

  it("never lets a later write downgrade a recorded outcome or flip the read-only flag", async () => {
    const { store, log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "call-1", tool: "code.fs.edit",
      readOnly: false, outcome: "ok",
    });
    // A late duplicate claims the call was read-only and unknown: both claims must be refused.
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "call-1", tool: "code.fs.edit",
      readOnly: true, outcome: "unknown_outcome",
    });
    const turn = await store.getCodeRunTurn("company-1", "run-1", 1);
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.toolCalls[0]?.readOnly).toBe(false);
    // The observed result survives: "we do not know yet" may not erase "we saw it succeed".
    expect(turn?.toolCalls[0]?.outcome).toBe("ok");
  });

  it("marks interrupted and finished states with their reason and timestamp", async () => {
    const { store, log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    await log.markInterrupted({ companyId: "company-1", runId: "run-1", reason: "lease_expired" });
    let state = await store.getCodeRunState("company-1", "run-1");
    expect(state?.status).toBe("interrupted");
    expect(state?.details.interruptedReason).toBe("lease_expired");

    await log.markFinished({ companyId: "company-1", runId: "run-1", status: "completed", reason: "completed" });
    state = await store.getCodeRunState("company-1", "run-1");
    expect(state?.status).toBe("completed");
    expect(state?.finishedAt).not.toBeNull();
  });
});

describe("security-gate: C6a run state — isolation and metadata only", () => {
  it("never reads or writes a run of another company", async () => {
    const { store, log } = setup();
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s", owner: "worker-a", runId: "run-1" });
    expect(await log.loadRunState("company-2", "run-1")).toBeNull();
    expect(await store.getCodeRunTurn("company-2", "run-1", 1)).toBeNull();
    await expect(store.applyCodeRunStateEvent({
      companyId: "company-2", runId: "run-1", seq: 99, status: "completed",
    })).rejects.toMatchObject({ code: "code_run_state_not_found" });
    expect(await log.loadTurnBoundary("company-2", "run-1")).toBeNull();
    expect((await store.getCodeRunState("company-1", "run-1"))?.status).toBe("running");
  });

  it("stores metadata only: a content-shaped field is refused instead of persisted", () => {
    expect(() => assertNoSensitiveRunState({ tool: "code.fs.edit", turnIndex: 2 })).not.toThrow();
    expect(() => assertNoSensitiveRunState({ command: "rm -rf /" })).toThrow(/metadata only/);
    expect(() => assertNoSensitiveRunState({ detail: { diff: "@@ -1 +1 @@" } })).toThrow(/metadata only/);
    expect(() => assertNoSensitiveRunState([{ ok: true }, { content: "secret" }])).toThrow(/metadata only/);
  });
});

/**
 * The reaper's two scans. They are read-only by contract, so this suite asserts that as strongly as it asserts
 * the rows they return: a scan that mutated state would be a very quiet bug, and one that returned a tool call
 * without saying "this one is expected to be slow" would make the reaper kill legitimate work.
 */
describe("security-gate: C6a run state — scans for the reaper", () => {
  async function seeded() {
    const { store, log, clock } = setup({ leaseMs: 60_000 * 60 });
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s1", owner: "w-a", runId: "run-1" });
    await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "running" });
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "stuck-edit", tool: "code.fs.edit",
      readOnly: false, outcome: "unknown_outcome", finishedAt: null,
    });
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "stuck-deps", tool: "code.deps.add",
      readOnly: false, outcome: "unknown_outcome", finishedAt: null,
    });
    await log.appendToolCall({
      companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "done-read", tool: "code.fs.read",
      readOnly: true, outcome: "ok",
    });
    // A second tenant, so isolation is observable rather than assumed.
    await log.startRun({ ctx, companyId: "company-9", projectId: "p9", sessionId: "s9", owner: "w-b", runId: "run-9" });
    await log.appendTurn({ companyId: "company-9", runId: "run-9", turnIndex: 1, status: "running" });
    await log.appendToolCall({
      companyId: "company-9", runId: "run-9", turnIndex: 1, toolCallId: "stuck-9", tool: "code.fs.edit",
      readOnly: false, outcome: "unknown_outcome", finishedAt: null,
    });
    // Ten minutes later nothing has progressed.
    clock.t += 600_000;
    return { store, log, clock };
  }

  it("returns calls with no progress, explains which are expected to be slow, and never invents one", async () => {
    const { log, clock } = await seeded();
    const scan = await log.listStuckToolCalls({ companyId: "company-1", now: new Date(clock.t) });
    expect(scan.items.map((item) => item.toolCallId).sort()).toEqual(["stuck-deps", "stuck-edit"]);
    const edit = scan.items.find((item) => item.toolCallId === "stuck-edit")!;
    const deps = scan.items.find((item) => item.toolCallId === "stuck-deps")!;
    // `code.deps.add` gets the install/build timeout (600 s) which exceeds the 300 s no-progress threshold, so
    // it is explicitly long-running; a plain edit is not.
    expect(deps.longRunning).toBe(true);
    expect(deps.declaredTimeoutMs).toBe(600_000);
    expect(edit.longRunning).toBe(false);
    expect(edit.declaredTimeoutMs).toBe(120_000);
    expect(edit.companyId).toBe("company-1");
    expect(edit.sessionId).toBe("s1");
    // A finished read is not "stuck" in any sense.
    expect(scan.items.some((item) => item.toolCallId === "done-read")).toBe(false);
  });

  it("lets an operator declare a tool long-running without touching code", async () => {
    const { log, clock } = await seeded();
    const scan = await log.listStuckToolCalls({
      companyId: "company-1", now: new Date(clock.t), longRunningTools: ["code.fs.edit"],
    });
    expect(scan.items.find((item) => item.toolCallId === "stuck-edit")?.longRunning).toBe(true);
  });

  it("is read-only and tenant-scoped: a scan changes nothing and never crosses companies", async () => {
    const { store, log, clock } = await seeded();
    const before = JSON.stringify(await store.listCodeRunTurns("company-1", "run-1"));
    const stateBefore = await store.getCodeRunState("company-1", "run-1");

    const scoped = await log.listStuckToolCalls({ companyId: "company-1", now: new Date(clock.t) });
    expect(scoped.items.every((item) => item.companyId === "company-1")).toBe(true);
    // The system scope is the reaper's, and it is the only caller that sees more than one tenant.
    const system = await log.listStuckToolCalls({ companyId: null, now: new Date(clock.t) });
    expect(new Set(system.items.map((item) => item.companyId))).toEqual(new Set(["company-1", "company-9"]));

    const after = JSON.stringify(await store.listCodeRunTurns("company-1", "run-1"));
    const stateAfter = await store.getCodeRunState("company-1", "run-1");
    expect(after).toBe(before);
    expect(stateAfter?.lastEventSeq).toBe(stateBefore?.lastEventSeq);
    expect(stateAfter?.revision).toBe(stateBefore?.revision);
  });

  it("pages the stuck-call scan and stops with a null cursor at the end", async () => {
    const { log, clock } = await seeded();
    const first = await log.listStuckToolCalls({ companyId: null, now: new Date(clock.t), limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await log.listStuckToolCalls({
      companyId: null, now: new Date(clock.t), limit: 2, cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items].map((item) => item.toolCallId).sort();
    expect(seen).toEqual(["stuck-9", "stuck-deps", "stuck-edit"]);
  });

  it("returns the fields a reaper needs and nothing that looks like content", async () => {
    const { log, clock } = await seeded();
    const scan = await log.listStuckToolCalls({ companyId: "company-1", now: new Date(clock.t) });
    for (const item of scan.items) {
      expect(Object.keys(item).sort()).toEqual([
        "companyId", "declaredTimeoutMs", "lastProgressAt", "longRunning", "runId", "sessionId",
        "startedAt", "toolCallId", "toolName",
      ]);
    }
    expect(JSON.stringify(scan.items)).not.toMatch(/command|diff|content|secret/);
  });

  it("reports a run as overdue only after maxRunMinutes plus the grace period", async () => {
    const { store, log, clock } = setup({ leaseMs: 60_000 * 60 });
    const start = clock.t;
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "inside-grace", owner: "w", runId: "run-grace" });
    clock.t = start + 31 * 60_000;
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "overdue", owner: "w", runId: "run-overdue" });
    clock.t = start + 40 * 60_000;

    const scan = await log.listOverdueRuns({ companyId: "company-1", maxRunMinutes: 30, now: new Date(clock.t) });
    // run-grace is 40 min old (overdue), run-overdue is 9 min old (not).
    expect(scan.items.map((item) => item.runId)).toEqual(["run-grace"]);
    const overdue = scan.items[0]!;
    expect(overdue.elapsedMs).toBe(40 * 60_000);
    expect(overdue.sessionId).toBe("inside-grace");
    expect(overdue.heartbeatAt).not.toBeNull();

    // At exactly maxRunMinutes (plus zero grace) it must not be reported: the grace is the whole point.
    const strict = await log.listOverdueRuns({
      companyId: "company-1", now: new Date(clock.t), maxRunMinutes: 30, graceMs: 15 * 60_000,
    });
    expect(strict.items).toEqual([]);

    // A finished run is never overdue, however long it took.
    clock.t = start + 90 * 60_000;
    await log.markFinished({ companyId: "company-1", runId: "run-grace", status: "completed" });
    const afterFinish = await log.listOverdueRuns({ companyId: "company-1", now: new Date(clock.t) });
    expect(afterFinish.items.map((item) => item.runId)).not.toContain("run-grace");
    expect((await store.getCodeRunState("company-1", "run-grace"))?.status).toBe("completed");
  });

  it("scopes and pages the overdue scan", async () => {
    const { log, clock } = setup({ leaseMs: 60_000 * 60 });
    const start = clock.t;
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s1", owner: "w", runId: "run-a" });
    await log.startRun({ ctx, companyId: "company-1", projectId: "p", sessionId: "s2", owner: "w", runId: "run-b" });
    await log.startRun({ ctx, companyId: "company-9", projectId: "p9", sessionId: "s9", owner: "w", runId: "run-c" });
    clock.t = start + 60 * 60_000;

    const scoped = await log.listOverdueRuns({ companyId: "company-1", maxRunMinutes: 30, now: new Date(clock.t) });
    expect(scoped.items.map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    const firstPage = await log.listOverdueRuns({ companyId: null, maxRunMinutes: 30, now: new Date(clock.t), limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await log.listOverdueRuns({
      companyId: null, maxRunMinutes: 30, now: new Date(clock.t), limit: 2, cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map((item) => item.runId)).toEqual(["run-c"]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

/**
 * The integration half: the real runner over the real log over the real store. The log suite proves the
 * semantics in isolation; this proves the loop actually uses them, and in the order that makes recovery
 * possible — a write-ahead record that exists *before* the tool runs, and a run that stops when its lease is
 * taken away.
 */
describe("security-gate: C6a runner — durable state while the loop runs", () => {
  const SESSION: CodeSession = {
    id: "session-1",
    workspaceId: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const TOOLS: CodeRunToolDescriptor[] = [
    { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
    { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
  ];

  function runnerHarness(options: { script?: Array<ChatResult | Error>; toolDelayMs?: number; heartbeatMs?: number; renewHeld?: () => boolean; quotaDenied?: boolean } = {}) {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: Date.parse("2026-01-01T00:00:00.000Z") };
    const log = new CodeRunStateLog({
      store: store as unknown as CodeRunStateStorePort,
      now: () => clock.t,
      leaseMs: 60_000,
    });
    const script = [...(options.script ?? [{ content: "done" }])];
    /** Records, for each call, the stored outcome observed *while the tool was still running*. */
    const outcomeDuringCall: Array<{ toolCallId: string; outcome: string | undefined }> = [];
    const invocations: string[] = [];

    const ports: CodingAgentRunnerPorts = {
      ...(options.quotaDenied ? { quota: { checkQuota: () => ({ allowed: false, error: "Budget exhausted" }), recordUsage() {} } } : {}),
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: {
        listTools: () => TOOLS.map((tool) => ({ ...tool })),
        invoke: async (_ctx, input) => {
          invocations.push(input.toolCallId);
          const runId = [...(await store.listStaleCodeRunStates({ now: new Date(clock.t + 10 * 60_000), limit: 10 }))]
            .map((row) => row.runId)[0];
          const turn = runId
            ? (await store.listCodeRunTurns("company-1", runId)).flatMap((row) => row.toolCalls)
              .find((call) => call.toolCallId === input.toolCallId)
            : undefined;
          outcomeDuringCall.push({ toolCallId: input.toolCallId, outcome: turn?.outcome });
          if (options.toolDelayMs) await new Promise((resolve) => setTimeout(resolve, options.toolDelayMs));
          return {
            ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1,
            result: { ok: true }, truncated: false, durationMs: 1,
          } satisfies CodeToolInvokeResult;
        },
      },
      engine: {
        chat: async () => {
          const next = script.shift();
          if (next instanceof Error) throw next;
          return next ?? { content: "done" };
        },
      },
      schemas: TOOLS.map((tool) => ({
        ...tool,
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      })),
      runState: {
        startRun: async (input) => log.startRun({ ...input, owner: input.owner }),
        renewLease: async (input) => (options.renewHeld ? { held: options.renewHeld() } : log.renewLease(input)),
        releaseLease: async (input) => log.releaseLease(input),
        appendTurn: async (input) => log.appendTurn(input),
        appendToolCall: async (input) => log.appendToolCall(input),
        markFinished: async (input) => log.markFinished(input),
      },
      limits: { maxStepsPerRun: 6, maxRunMinutes: 5, runHeartbeatMs: options.heartbeatMs ?? 60_000 },
      now: () => clock.t,
    };

    return {
      store, log, clock,
      outcomeDuringCall,
      invocations,
      run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
        new CodingAgentRunner(ports).run({ ctx, session: SESSION, prompt: "fix the failing test", ...input }),
      setClock: (value: number) => { clock.t = value; },
    };
  }

  const nativeCall = (name: string, args: Record<string, unknown>, id: string) => ({
    id, type: "function" as const, function: { name, arguments: JSON.stringify(args) },
  });

  it("persists budget exhaustion as a failed run instead of a completed task", async () => {
    const harness = runnerHarness({ quotaDenied: true });
    const result = await harness.run({ runId: "budget-limited" });
    expect(result.reason).toBe("budget_exhausted");
    expect(result.status).toBe("stopped");
    expect(await harness.store.getCodeRunState("company-1", "budget-limited")).toMatchObject({ status: "failed", details: { stopReason: "budget_exhausted" } });
  });

  it("records the tool call before it runs and persists each turn as the loop advances", async () => {
    const harness = runnerHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "a.ts" }, "call-1")] } as ChatResult,
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "b.ts" }, "call-2")] } as ChatResult,
        { content: "done" } as ChatResult,
      ],
    });

    const result = await harness.run({ runId: "run-int" });
    expect(result.runId).toBe("run-int");

    // Write-ahead: at the moment each tool ran, its record already existed as `unknown_outcome`, so a crash
    // would have left evidence that the call started.
    expect(harness.outcomeDuringCall).toEqual([
      { toolCallId: "call-1", outcome: "unknown_outcome" },
      { toolCallId: "call-2", outcome: "unknown_outcome" },
    ]);

    // The state is durable and terminal: no row is left claiming to be running.
    const state = await harness.store.getCodeRunState("company-1", "run-int");
    expect(state?.status).toBe("completed");
    expect(state?.turnIndex).toBeGreaterThanOrEqual(2);
    const turns = await harness.store.listCodeRunTurns("company-1", "run-int");
    expect(turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
    // Turn 3 produced no tool calls, so it closes as finished with an ok outcome.
    expect(turns[2]?.status).toBe("finished");
    // Both calls reached their terminal outcome in storage.
    const calls = turns.flatMap((turn) => turn.toolCalls);
    expect(calls.map((call) => `${call.toolCallId}:${call.outcome}`)).toEqual(["call-1:ok", "call-2:ok"]);
  });

  it("stops as `interrupted` when the lease is taken away, without touching the workspace again", async () => {
    const harness = runnerHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "a.ts" }, "call-1")] } as ChatResult,
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "b.ts" }, "call-2")] } as ChatResult,
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "c.ts" }, "call-3")] } as ChatResult,
      ],
      // The heartbeat fires at 1s and always reports the lease as lost; the single tool call takes 1.5 s, so
      // the loss is observed as soon as that call returns.
      heartbeatMs: 1_000,
      renewHeld: () => false,
      toolDelayMs: 1_500,
    });

    const result = await harness.run({ runId: "run-lease" });
    expect(result.status).toBe("interrupted");
    expect(result.reason).toBe("interrupted");
    // Exactly the call that was already running completed; nothing after it was started.
    expect(harness.invocations).toEqual(["call-1"]);
    expect((await harness.store.getCodeRunState("company-1", "run-lease"))?.status).toBe("interrupted");
  }, 15_000);
});

describe("terminal state survives a concurrent heartbeat", () => {
  it("does not lose markFinished when a lease renewal of the same run is in flight", async () => {
    const { store, log } = setup();
    const started = await log.startRun({ ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a" });
    await Promise.all([
      log.renewLease({ companyId: "company-1", runId: started.runId, owner: "worker-a" }),
      log.markFinished({ companyId: "company-1", runId: started.runId, status: "completed", reason: "completed" }),
    ]);
    const stored = await store.getCodeRunState("company-1", started.runId);
    expect(stored?.status).toBe("completed");
    expect(stored?.finishedAt).not.toBeNull();
  });

  it("re-applies a terminal write whose sequence another process already used", async () => {
    const { store, log } = setup();
    const started = await log.startRun({ ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a" });
    const other = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort });
    await other.markHeartbeat({ companyId: "company-1", runId: started.runId });
    await log.markFinished({ companyId: "company-1", runId: started.runId, status: "completed", reason: "completed" });
    expect((await store.getCodeRunState("company-1", started.runId))?.status).toBe("completed");
  });
});
