import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext, CodeRunToolCallRecord } from "@npati/workspace";
import { CodeRunStateLog, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import {
  CodeRunReconciler,
  type CodeRunReconcileActivityEvent,
  type CodeRunWorkspaceDiff,
} from "../apps/agent-api/src/code-run-reconciler";

/**
 * C6a security-gate suite: reconciling a run whose process died.
 *
 * The rule this suite exists to protect is one sentence long: **a tool call whose result is unknown may be
 * replayed only when it is read-only.** Everything else — a write, a shell command, an unknown tool — is
 * reported as a doubt together with a workspace comparison, and is never executed again. A regression here
 * would not fail loudly in production; it would silently re-apply a mutation, which is why the rule is
 * asserted from both sides (the replay port is called for the read, and provably not called for the write).
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function setup(options: { leaseMs?: number } = {}) {
  const store = new InMemoryWorkspaceStore();
  const clock = { t: T0 };
  const log = new CodeRunStateLog({
    store: store as unknown as CodeRunStateStorePort,
    now: () => clock.t,
    leaseMs: options.leaseMs ?? 1_000,
  });
  const replayed: Array<{ toolCallId: string; tool: string }> = [];
  const activity: CodeRunReconcileActivityEvent[] = [];
  const diff: CodeRunWorkspaceDiff = {
    changed: true,
    files: ["src/billing.ts"],
    summary: "1 file(s) differ from checkpoint cp-7",
    checkpointId: "cp-7",
  };
  const reconciler = new CodeRunReconciler({
    log,
    now: () => clock.t,
    workspaceDiffFor: async () => diff,
    replayReadOnly: async (input) => {
      replayed.push({ toolCallId: input.call.toolCallId, tool: input.call.tool });
      return { ok: true };
    },
    activity: { record: async (event) => { activity.push(event); } },
  });
  return { store, log, reconciler, clock, replayed, activity, diff };
}

function pending(toolCallId: string, tool: string, readOnly: boolean): CodeRunToolCallRecord {
  return { toolCallId, tool, readOnly, outcome: "unknown_outcome", startedAt: new Date(T0), finishedAt: null };
}

/**
 * A run that finished turn 1 (with a checkpoint) and died inside turn 2 with two calls in flight: a read and
 * a write. This is the shape the reconciler exists for.
 */
async function interruptedRun(log: CodeRunStateLog): Promise<void> {
  await log.startRun({
    ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a", runId: "run-1",
  });
  await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 1, status: "running" });
  await log.appendToolCall({
    companyId: "company-1", runId: "run-1", turnIndex: 1, toolCallId: "t1-read", tool: "code.fs.read",
    readOnly: true, outcome: "ok",
  });
  await log.appendTurn({
    companyId: "company-1", runId: "run-1", turnIndex: 1, status: "finished", outcome: "ok", checkpointId: "cp-7",
  });
  await log.appendTurn({ companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running" });
  await log.appendTurn({
    companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running",
    toolCalls: [pending("t2-read", "code.fs.read", true)],
  });
  await log.appendTurn({
    companyId: "company-1", runId: "run-1", turnIndex: 2, status: "running",
    toolCalls: [pending("t2-write", "code.fs.edit", false)],
  });
}

describe("security-gate: C6a reconciler — a dead run becomes decidable", () => {
  it("turns a running row with an expired lease into `interrupted` and closes the turn as unknown", async () => {
    const { store, log, reconciler, clock } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;

    const report = await reconciler.reconcileRuns({ now: new Date(clock.t) });
    expect(report.interrupted).toEqual(["run-1"]);
    expect(report.recovered).toHaveLength(1);

    const state = await store.getCodeRunState("company-1", "run-1");
    expect(state?.status).toBe("interrupted");
    const turn = await store.getCodeRunTurn("company-1", "run-1", 2);
    expect(turn?.status).toBe("failed");
    expect(turn?.outcome).toBe("unknown_outcome");
    // The finished turn is untouched: recovery resumes from it, not from scratch.
    expect((await store.getCodeRunTurn("company-1", "run-1", 1))?.outcome).toBe("ok");
  });

  it("replays a read-only call whose result is unknown and NEVER replays a mutating one", async () => {
    const { store, log, reconciler, clock, replayed } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;

    const report = await reconciler.reconcileRuns({ now: new Date(clock.t) });
    const notice = report.recovered[0]!;

    // Exactly one replay, and it is the read.
    expect(replayed.map((entry) => entry.toolCallId)).toEqual(["t2-read"]);
    expect(notice.replayedReadOnlyToolCalls).toEqual([
      { toolCallId: "t2-read", tool: "code.fs.read", replayed: true },
    ]);
    // The write is reported as a doubt and was not executed again.
    expect(notice.unknownOutcomeToolCalls).toEqual([{ toolCallId: "t2-write", tool: "code.fs.edit" }]);
    expect(replayed.some((entry) => entry.toolCallId === "t2-write")).toBe(false);
    // The stored outcome of the write stays unknown: nothing claims it succeeded or failed.
    const turn = await store.getCodeRunTurn("company-1", "run-1", 2);
    expect(turn?.toolCalls.find((call) => call.toolCallId === "t2-write")?.outcome).toBe("unknown_outcome");
  });

  it("hands the model and the user the workspace comparison and forbids repeating the doubted calls", async () => {
    const { log, reconciler, clock } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;

    const notice = (await reconciler.reconcileRuns({ now: new Date(clock.t) })).recovered[0]!;
    expect(notice.workspaceDiff?.files).toEqual(["src/billing.ts"]);
    expect(notice.workspaceDiff?.checkpointId).toBe("cp-7");
    expect(notice.messageForModel).toContain("cp-7");
    expect(notice.messageForModel).toContain("src/billing.ts");
    expect(notice.messageForModel).toContain("code.fs.edit#t2-write");
    expect(notice.messageForModel).toContain("Do NOT repeat those calls");
  });

  it("says so explicitly when no workspace comparison is available instead of implying nothing changed", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const log = new CodeRunStateLog({
      store: store as unknown as CodeRunStateStorePort, now: () => clock.t, leaseMs: 1_000,
    });
    await interruptedRun(log);
    clock.t = T0 + 60_000;
    const reconciler = new CodeRunReconciler({ log, now: () => clock.t });

    const notice = (await reconciler.reconcileRuns({ now: new Date(clock.t) })).recovered[0]!;
    expect(notice.workspaceDiff?.unknownBase).toBe(true);
    expect(notice.messageForModel).toContain("unavailable");
    expect(notice.workspaceDiff?.changed).toBe(false);
  });
});

describe("security-gate: C6a reconciler — idempotent, dry-run safe, lease aware", () => {
  it("does not interrupt a worker that resumed after the stale scan", async () => {
    const { store, log, reconciler, clock, replayed } = setup();
    await interruptedRun(log); clock.t = T0 + 60_000;
    const scan = log.listStaleRuns.bind(log);
    vi.spyOn(log, "listStaleRuns").mockImplementationOnce(async input => {
      const stale = await scan(input);
      await log.acquireLease({ companyId: "company-1", runId: "run-1", owner: "resumed-worker" });
      return stale;
    });
    const report = await reconciler.reconcileRuns();
    expect(report.interrupted).toEqual([]); expect(report.skipped).toBe(1);
    expect(replayed).toEqual([]);
    expect(await store.getCodeRunState("company-1", "run-1")).toMatchObject({ status: "running", leaseOwner: "resumed-worker" });
  });

  it("allows only one of two concurrent reconcilers to replay a stale read", async () => {
    const { log, clock, replayed } = setup();
    await interruptedRun(log); clock.t = T0 + 60_000;
    const make = () => new CodeRunReconciler({ log, now: () => clock.t, replayReadOnly: async ({ call }) => { replayed.push(call); return { ok: true }; } });
    const reports = await Promise.all([make().reconcileRuns(), make().reconcileRuns()]);
    expect(reports.flatMap(report => report.interrupted)).toEqual(["run-1"]);
    expect(replayed).toHaveLength(1);
  });

  it("changes nothing on a dry run and reports the same recovery set", async () => {
    const { store, log, reconciler, clock, replayed } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;

    const report = await reconciler.reconcileRuns({ dryRun: true, now: new Date(clock.t) });
    expect(report.dryRun).toBe(true);
    expect(report.interrupted).toEqual(["run-1"]);
    expect(replayed).toEqual([]);
    expect((await store.getCodeRunState("company-1", "run-1"))?.status).toBe("running");
    expect((await store.getCodeRunTurn("company-1", "run-1", 2))?.status).toBe("running");
  });

  it("is idempotent: a second pass finds nothing and adds no duplicate turns or tool calls", async () => {
    const { store, log, reconciler, clock } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;
    await reconciler.reconcileRuns({ now: new Date(clock.t) });
    const turnsAfterFirst = await store.listCodeRunTurns("company-1", "run-1");

    const second = await reconciler.reconcileRuns({ now: new Date(clock.t) });
    expect(second.interrupted).toEqual([]);
    expect(second.recovered).toEqual([]);
    const turnsAfterSecond = await store.listCodeRunTurns("company-1", "run-1");
    expect(turnsAfterSecond).toHaveLength(turnsAfterFirst.length);
    expect(turnsAfterSecond.flatMap((turn) => turn.toolCalls)).toHaveLength(3);
  });

  it("leaves a run with a live lease alone", async () => {
    const { store, log, reconciler, clock, replayed } = setup({ leaseMs: 600_000 });
    await interruptedRun(log);
    clock.t = T0 + 60_000;

    const report = await reconciler.reconcileRuns({ now: new Date(clock.t) });
    expect(report.scanned).toBe(0);
    expect(report.interrupted).toEqual([]);
    expect(replayed).toEqual([]);
    expect((await store.getCodeRunState("company-1", "run-1"))?.status).toBe("running");
  });

  it("records why it acted, without content, and keeps the tenant of the row it reconciled", async () => {
    const { log, reconciler, clock, activity } = setup();
    await interruptedRun(log);
    clock.t = T0 + 60_000;
    await reconciler.reconcileRuns({ now: new Date(clock.t) });

    expect(activity).toHaveLength(1);
    const event = activity[0]!;
    expect(event.kind).toBe("run_interrupted");
    expect(event.companyId).toBe("company-1");
    expect(event.reason).toBe("lease_expired");
    expect(event.lastFinishedTurn).toBe(1);
    // Metadata only: no command, diff or file content ever reaches the event.
    expect(JSON.stringify(event)).not.toMatch(/@@|rm -rf|content/);
  });

  it("recovers a run of another company under its own tenant", async () => {
    const { store, log, reconciler, clock, activity } = setup();
    await log.startRun({
      ctx, companyId: "company-9", projectId: "project-9", sessionId: "session-9", owner: "worker-a", runId: "run-9",
    });
    await log.appendTurn({ companyId: "company-9", runId: "run-9", turnIndex: 1, status: "running" });
    await log.appendTurn({
      companyId: "company-9", runId: "run-9", turnIndex: 1, status: "running",
      toolCalls: [pending("c9-read", "code.fs.read", true)],
    });
    clock.t = T0 + 60_000;

    const report = await reconciler.reconcileRuns({ now: new Date(clock.t) });
    expect(report.interrupted).toEqual(["run-9"]);
    expect(activity[0]?.companyId).toBe("company-9");
    expect((await store.getCodeRunState("company-9", "run-9"))?.status).toBe("interrupted");
    // A company-scoped reader of a different tenant sees nothing of it.
    expect(await log.loadRunState("company-1", "run-9")).toBeNull();
  });
});
