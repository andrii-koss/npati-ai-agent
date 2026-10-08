import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  CODE_METRIC_KINDS,
  collectCodeMetrics,
  type CodeMetricsReport,
  type CodeMetricsSourcePort,
} from "../apps/agent-api/src/code-metrics";
import { CODE_METRICS_ACTIONS, registerCodeMetricsRoutes, resolveMetricsQuery, type CodeMetricsRouteDeps } from "../apps/agent-api/src/code-metrics-routes";
import { CodeRbac, DEFAULT_CODE_ROLE_MATRIX, createRoleRegistry, requiredPermissionForAction, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";

/**
 * C14 (owner decision 3) security-gate suite: the metrics aggregation and the route that serves it.
 *
 * What this suite exists to prevent, in the order the assertions appear:
 *
 *  1. **A metric that is really "we do not know" presented as `0`.** Every metric is asserted in both
 *     directions — a run set that produces a real number, and the same metric with its source removed, where the
 *     answer must be `null` **with a reason**. `0 %` reads as "nothing failed" and `$0.0000` as "this was free",
 *     so those two strings are asserted absent from the payload whenever the data cannot support them.
 *  2. **A metric computed from a source it claims but does not use.** Each metric names its `source`; the
 *     non-vacuity cases prove the claim by *removing* the source (an unreadable run read, an empty Activity
 *     window, a payload with no `ok` field) and watching that exact metric degrade — while the others, which
 *     read something else, keep their numbers.
 *  3. **A tenant leak.** The same `InMemoryWorkspaceStore` holds two companies' runs and events, and each
 *     company's report is asserted against its own rows only.
 *  4. **A route that re-computes what the aggregator already computed.** The route's body is asserted equal to
 *     the `CodeMetricsReport` the aggregator returned from the same stores, field by field.
 */

const COMPANY = "company-metrics-a";
const OTHER_COMPANY = "company-metrics-b";
const PROJECT = "project-1";
const WORKSPACE = "ws-1";

const context: AuthContext = {
  userId: "user-1",
  workspaceId: WORKSPACE,
  companyId: COMPANY,
  permissions: ["workspace:read", "workspace:write"],
};

/** One run row, through the real store — no hand-written double can drift from the implementation. */
async function addRun(
  store: InMemoryWorkspaceStore,
  input: {
    companyId?: string;
    runId: string;
    status: "running" | "waiting_for_user" | "interrupted" | "completed" | "failed" | "cancelled";
    startedAt: string;
    estimate?: { turns?: number; costUsd?: number | null };
  },
): Promise<void> {
  const companyId = input.companyId ?? COMPANY;
  await store.createCodeRunState({
    runId: input.runId,
    workspaceId: WORKSPACE,
    companyId,
    projectId: PROJECT,
    sessionId: `session-${input.runId}`,
    owner: "worker-1",
    leaseMs: 60_000,
    now: new Date(input.startedAt),
  });
  await store.applyCodeRunStateEvent({
    companyId,
    runId: input.runId,
    seq: 2,
    status: input.status,
    finishedAt: input.status === "running" ? null : new Date(input.startedAt),
    ...(input.estimate
      ? { details: { estimate: { ...input.estimate, estimated: true, source: "runner_summary_estimate" } } }
      : {}),
  });
}

async function addActivityEvent(
  store: InMemoryWorkspaceStore,
  input: {
    companyId?: string;
    kind: "code_tool_activity" | "policy_decision" | "network_decision" | "run_activity" | "run_reconcile";
    payload: Record<string, unknown>;
    at: string;
  },
): Promise<void> {
  await store.createCodeActivityEvent({
    companyId: input.companyId ?? COMPANY,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    runId: "run-tool",
    kind: input.kind,
    payload: input.payload,
    now: new Date(input.at),
  });
}

/**
 * The two real store reads, wired exactly as the composition root wires them.
 *
 * The run read forwards **every** bound it is handed. A port that answers `limit` and `statuses` but drops the
 * window is not a narrower read, it is a different one: `collectCodeMetrics({ since })` would then aggregate the
 * whole history and report it as the window, which is precisely the "a window presented as the history" lie the
 * truncation flag exists to prevent. `startedAfter`/`startedBefore` are therefore passed through as a pair.
 */
function storePort(store: InMemoryWorkspaceStore, companyId = COMPANY): CodeMetricsSourcePort {
  return {
    listRuns: (input) => store.listCodeRunStates({
      companyId: input.companyId,
      ...(input.statuses ? { statuses: input.statuses } : {}),
      ...(input.startedAfter ? { startedAfter: input.startedAfter } : {}),
      ...(input.startedBefore ? { startedBefore: input.startedBefore } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    }),
    listActivityEvents: (input) => store.listCodeActivityEvents({ companyId: input.companyId, limit: input.limit ?? 500 }),
  };
}

function metricOf(report: CodeMetricsReport, kind: string) {
  const metric = report.metrics.find((entry) => entry.kind === kind);
  if (!metric) throw new Error(`metric ${kind} is missing from the report`);
  return metric;
}

/** A synthetic port, for the cases a real store cannot express (an unreadable read). */
function syntheticPort(input: {
  runs?: Array<{ status: string; startedAt: Date; details: Record<string, unknown> }>;
  events?: Array<{ kind: string; payload: Record<string, unknown> }>;
  failRuns?: boolean;
  failEvents?: boolean;
}): CodeMetricsSourcePort {
  return {
    listRuns: async () => {
      if (input.failRuns) throw new Error("store_down");
      return input.runs ?? [];
    },
    listActivityEvents: async () => {
      if (input.failEvents) throw new Error("store_down");
      return input.events ?? [];
    },
  };
}

const AT = "2026-02-01T10:00:00.000Z";
const LATER = "2026-02-01T11:00:00.000Z";

describe("[C14] [security-gate] metrics are measured from existing run and Activity rows", () => {
  it("computes the success rate from code_run_states.status, excluding runs with no outcome", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "r-ok-1", status: "completed", startedAt: AT });
    await addRun(store, { runId: "r-ok-2", status: "completed", startedAt: AT });
    await addRun(store, { runId: "r-bad", status: "failed", startedAt: AT });
    // A cancelled run states no correctness outcome, so it is not evidence in either direction.
    await addRun(store, { runId: "r-cancel", status: "cancelled", startedAt: AT });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    const success = metricOf(report, "success_rate");
    expect(success.value).toBeCloseTo(2 / 3, 6);
    // Three finished runs contributed; the cancelled one did not.
    expect(success.sampleSize).toBe(3);
    expect(success.observationCount).toBe(4);
    expect(success.source).toContain("code_run_states.status");
    expect(success.unavailable).toBeUndefined();
    expect(report.runs.byStatus).toEqual({ completed: 2, failed: 1, cancelled: 1 });
  });

  it("reports a measured zero success rate when every finished run failed, and never null-as-zero", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "r-1", status: "failed", startedAt: AT });
    await addRun(store, { runId: "r-2", status: "failed", startedAt: AT });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    const success = metricOf(report, "success_rate");
    // `0` here is a measurement ("both finished runs failed") and it carries the sample that proves it.
    expect(success.value).toBe(0);
    expect(success.sampleSize).toBe(2);
    expect(success.unavailable).toBeUndefined();
  });

  it("averages turns and cost only over the runs that recorded them", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "r-1", status: "completed", startedAt: AT, estimate: { turns: 2, costUsd: 0.01 } });
    await addRun(store, { runId: "r-2", status: "completed", startedAt: AT, estimate: { turns: 4, costUsd: 0.03 } });
    // A run that recorded neither is still a run: it belongs in the observation count, not in the divisor.
    await addRun(store, { runId: "r-3", status: "failed", startedAt: AT });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    const turns = metricOf(report, "avg_turns");
    expect(turns.value).toBe(3);
    expect(turns.sampleSize).toBe(2);
    expect(turns.observationCount).toBe(3);
    expect(turns.estimated).toBe(true);
    expect(turns.source).toContain("details.estimate.turns");

    const cost = metricOf(report, "cost_per_run");
    expect(cost.value).toBeCloseTo(0.02, 6);
    expect(cost.sampleSize).toBe(2);
    expect(cost.estimated).toBe(true);
    expect(cost.source).toContain("details.estimate.costUsd");
  });

  it("computes the tool error rate and the failed edit rate from code_tool_activity payloads", async () => {
    const store = new InMemoryWorkspaceStore();
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.read", ok: true }, at: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: true }, at: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: false, errorCode: "revision_conflict" }, at: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.shell.exec", ok: false }, at: LATER });
    // A read that failed is a tool error but not a failed edit: only editing tools count against that rate.
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.read", ok: false }, at: LATER });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    const toolErrors = metricOf(report, "tool_error_rate");
    expect(toolErrors.value).toBeCloseTo(3 / 5, 6);
    expect(toolErrors.sampleSize).toBe(5);

    const failedEdits = metricOf(report, "failed_edit_rate");
    // Two edit events (one failed), three non-edit calls: the denominator is the edit events, not every call.
    expect(failedEdits.value).toBe(0.5);
    expect(failedEdits.sampleSize).toBe(2);
    expect(failedEdits.observationCount).toBe(5);
    expect(failedEdits.source).toContain("code_tool_activity");
  });

  it("computes the approvals share from policy_decision payloads", async () => {
    const store = new InMemoryWorkspaceStore();
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "allow", action: "code.fs.write" }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "require_approval", action: "code.shell.exec" }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "deny", action: "code.shell.exec" }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "require_approval", action: "code.git.push" }, at: LATER });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    const approvals = metricOf(report, "approvals_share");
    expect(approvals.value).toBe(0.5);
    expect(approvals.sampleSize).toBe(4);
    expect(approvals.source).toContain("policy_decision");
  });

  it("says why every metric is unavailable when there is no data — and never reports it as zero", async () => {
    const store = new InMemoryWorkspaceStore();
    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));

    expect(report.metrics.map((metric) => metric.kind)).toEqual([...CODE_METRIC_KINDS]);
    expect(report.runs.total).toBe(0);
    for (const metric of report.metrics) {
      expect({ kind: metric.kind, value: metric.value }).toEqual({ kind: metric.kind, value: null });
      expect(typeof metric.unavailable).toBe("string");
      expect((metric.unavailable ?? "").length).toBeGreaterThan(0);
      expect(metric.sampleSize).toBe(0);
    }
    const reasons = Object.fromEntries(report.metrics.map((metric) => [metric.kind, metric.unavailable]));
    expect(reasons).toEqual({
      success_rate: "no_finished_runs_in_window",
      avg_turns: "no_run_recorded_a_turn_count",
      failed_edit_rate: "no_edit_tool_events_in_window",
      approvals_share: "no_policy_decisions_in_window",
      tool_error_rate: "no_tool_activity_events_in_window",
      cost_per_run: "no_run_recorded_a_cost",
    });
    // The failure mode this assertion exists for: `0` where the truth is "unknown".
    const serialised = JSON.stringify(report);
    expect(serialised.includes("\"value\":0")).toBe(false);
  });

  it("degrades exactly the metrics whose source is gone, and says the source is unreadable", async () => {
    const runs = [
      { status: "completed", startedAt: new Date(AT), details: { estimate: { turns: 2, costUsd: 0.02 } } },
    ];
    const events = [{ kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: true } }];

    // Control: with both sources readable the two halves of the report are measured.
    const control = await collectCodeMetrics(syntheticPort({ runs, events }), { companyId: COMPANY }, () => new Date(AT));
    expect(metricOf(control, "success_rate").value).toBe(1);
    expect(metricOf(control, "tool_error_rate").value).toBe(0);

    // Remove the run source: every run-derived metric becomes unavailable, and the Activity-derived ones stay.
    const noRuns = await collectCodeMetrics(syntheticPort({ events, failRuns: true }), { companyId: COMPANY }, () => new Date(AT));
    for (const kind of ["success_rate", "avg_turns", "cost_per_run"]) {
      expect(metricOf(noRuns, kind)).toMatchObject({ value: null, unavailable: "metrics_source_unreadable", sampleSize: 0 });
    }
    expect(metricOf(noRuns, "tool_error_rate").value).toBe(0);
    expect(metricOf(noRuns, "success_rate").observationCount).toBe(0);

    // Remove the Activity source: the mirror image, proved the other way round.
    const noEvents = await collectCodeMetrics(syntheticPort({ runs, failEvents: true }), { companyId: COMPANY }, () => new Date(AT));
    for (const kind of ["failed_edit_rate", "approvals_share", "tool_error_rate"]) {
      expect(metricOf(noEvents, kind)).toMatchObject({ value: null, unavailable: "metrics_source_unreadable", sampleSize: 0 });
    }
    expect(metricOf(noEvents, "success_rate").value).toBe(1);
    expect(metricOf(noEvents, "avg_turns").value).toBe(2);
    expect(noEvents.runs.total).toBe(1);
  });

  it("counts an activity payload with no outcome instead of reading it as a success", async () => {
    const store = new InMemoryWorkspaceStore();
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: true }, at: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write" }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { action: "code.fs.write" }, at: AT });

    const report = await collectCodeMetrics(storePort(store), { companyId: COMPANY }, () => new Date(AT));
    // Only the payload that stated `ok` counts, so the error rate is 0/1 rather than 0/2.
    expect(metricOf(report, "tool_error_rate").sampleSize).toBe(1);
    expect(metricOf(report, "failed_edit_rate").sampleSize).toBe(1);
    expect(metricOf(report, "approvals_share").value).toBe(null);
    expect(metricOf(report, "approvals_share").unavailable).toBe("no_policy_decisions_in_window");
    expect(report.activityEventsWithoutOutcome).toBe(2);
  });

  it("says when the Activity sample hit its cap instead of presenting a window as the history", async () => {
    const store = new InMemoryWorkspaceStore();
    for (let index = 0; index < 6; index += 1) {
      await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.read", ok: true }, at: AT });
    }
    const capped = await collectCodeMetrics(storePort(store), { companyId: COMPANY, eventLimit: 5 }, () => new Date(AT));
    expect(capped.truncated).toBe(true);
    expect(capped.eventLimit).toBe(5);
    expect(metricOf(capped, "tool_error_rate").sampleSize).toBe(5);

    const full = await collectCodeMetrics(storePort(store), { companyId: COMPANY, eventLimit: 50 }, () => new Date(AT));
    expect(full.truncated).toBe(false);
    expect(metricOf(full, "tool_error_rate").sampleSize).toBe(6);
  });

  it("keeps two companies' runs and events out of each other's metrics", async () => {
    const store = new InMemoryWorkspaceStore();
    // Company A: one success out of two, one failed edit, one approval request out of two decisions.
    await addRun(store, { runId: "a-ok", status: "completed", startedAt: AT, estimate: { turns: 2, costUsd: 0.02 } });
    await addRun(store, { runId: "a-bad", status: "failed", startedAt: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: true }, at: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: false }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "allow" }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "require_approval" }, at: AT });
    // Company B: a completely different shape, in the same store.
    await addRun(store, { companyId: OTHER_COMPANY, runId: "b-ok", status: "completed", startedAt: AT, estimate: { turns: 9, costUsd: 1 } });
    await addActivityEvent(store, { companyId: OTHER_COMPANY, kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: false }, at: AT });

    const a = await collectCodeMetrics(storePort(store, COMPANY), { companyId: COMPANY }, () => new Date(AT));
    expect(a.runs.total).toBe(2);
    expect(metricOf(a, "success_rate").value).toBe(0.5);
    expect(metricOf(a, "avg_turns").value).toBe(2);
    expect(metricOf(a, "cost_per_run").value).toBeCloseTo(0.02, 6);
    expect(metricOf(a, "tool_error_rate").value).toBe(0.5);
    expect(metricOf(a, "failed_edit_rate").value).toBe(0.5);
    expect(metricOf(a, "approvals_share").value).toBe(0.5);

    const b = await collectCodeMetrics(storePort(store, OTHER_COMPANY), { companyId: OTHER_COMPANY }, () => new Date(AT));
    expect(b.runs.total).toBe(1);
    expect(metricOf(b, "success_rate").value).toBe(1);
    expect(metricOf(b, "avg_turns").value).toBe(9);
    expect(metricOf(b, "cost_per_run").value).toBe(1);
    // B's only tool event failed, so 1.0 — not A's 0.5, which is what a missing tenant predicate would produce.
    expect(metricOf(b, "tool_error_rate").value).toBe(1);
    expect(metricOf(b, "failed_edit_rate").value).toBe(1);
    // A's policy decisions must not leak into B's approvals share.
    expect(metricOf(b, "approvals_share")).toMatchObject({ value: null, unavailable: "no_policy_decisions_in_window" });
  });

  it("reads only the tenant it was asked for through the store's own predicate", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "a-1", status: "completed", startedAt: AT });
    await addRun(store, { companyId: OTHER_COMPANY, runId: "b-1", status: "failed", startedAt: AT });

    // The store method itself is the tenant boundary: asking as B must not return A's run, and vice versa.
    const forA = await store.listCodeRunStates({ companyId: COMPANY });
    const forB = await store.listCodeRunStates({ companyId: OTHER_COMPANY });
    expect(forA.map((run) => run.runId)).toEqual(["a-1"]);
    expect(forB.map((run) => run.runId)).toEqual(["b-1"]);
    // No system scope exists on this read: an empty company id returns nothing rather than everything.
    expect(await store.listCodeRunStates({ companyId: "" })).toEqual([]);
  });

  it("filters the run read by status and by window through the store", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "old", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", estimate: { turns: 1 } });
    await addRun(store, { runId: "new", status: "failed", startedAt: "2026-02-01T00:00:00.000Z", estimate: { turns: 3 } });
    await addRun(store, { runId: "newest", status: "completed", startedAt: "2026-03-01T00:00:00.000Z", estimate: { turns: 5 } });

    const completed = await store.listCodeRunStates({ companyId: COMPANY, statuses: ["completed"] });
    expect(completed.map((run) => run.runId)).toEqual(["newest", "old"]);
    const recent = await store.listCodeRunStates({ companyId: COMPANY, startedAfter: new Date("2026-01-15T00:00:00.000Z") });
    expect(recent.map((run) => run.runId)).toEqual(["newest", "new"]);
    // The window is half-open: `startedAfter` includes its own instant (the run started exactly then is in), and
    // `startedBefore` excludes its own (the run started exactly then is out). Both bounds are asserted at the
    // boundary, because that is the only place an inclusive/exclusive mix-up is visible.
    expect((await store.listCodeRunStates({ companyId: COMPANY, startedAfter: new Date("2026-02-01T00:00:00.000Z") }))
      .map((run) => run.runId)).toEqual(["newest", "new"]);
    expect((await store.listCodeRunStates({ companyId: COMPANY, startedBefore: new Date("2026-02-01T00:00:00.000Z") }))
      .map((run) => run.runId)).toEqual(["old"]);
    expect((await store.listCodeRunStates({
      companyId: COMPANY,
      startedAfter: new Date("2026-01-15T00:00:00.000Z"),
      startedBefore: new Date("2026-03-01T00:00:00.000Z"),
    })).map((run) => run.runId)).toEqual(["new"]);
    // Newest first, and the limit truncates the *filtered* set rather than deciding what gets filtered: `limit: 1`
    // on the status filter returns the newest completed run, not "the newest run, if it happens to be completed".
    expect((await store.listCodeRunStates({ companyId: COMPANY, limit: 1 })).map((run) => run.runId)).toEqual(["newest"]);
    expect((await store.listCodeRunStates({ companyId: COMPANY, statuses: ["completed"], limit: 1 }))
      .map((run) => run.runId)).toEqual(["newest"]);
    expect((await store.listCodeRunStates({ companyId: COMPANY, statuses: ["failed"], limit: 1 }))
      .map((run) => run.runId)).toEqual(["new"]);
    // A window that matches nothing is an empty read, not the unfiltered set.
    expect(await store.listCodeRunStates({ companyId: COMPANY, startedAfter: new Date("2026-04-01T00:00:00.000Z") })).toEqual([]);

    // The aggregation applies the same window, so a narrowed request really narrows the numbers.
    const windowed = await collectCodeMetrics(storePort(store), { companyId: COMPANY, since: new Date("2026-01-15T00:00:00.000Z") }, () => new Date(AT));
    expect(windowed.runs.total).toBe(2);
    expect(metricOf(windowed, "success_rate").value).toBe(0.5);
    expect(metricOf(windowed, "success_rate").sampleSize).toBe(2);
    // The mirror image, and the failure mode the port's pass-through exists for: a window that excludes every
    // finished run must degrade to `unavailable`, never to a measured `0` over the whole history.
    const empty = await collectCodeMetrics(storePort(store), { companyId: COMPANY, since: new Date("2026-05-01T00:00:00.000Z") }, () => new Date(AT));
    expect(empty.runs.total).toBe(0);
    expect(metricOf(empty, "success_rate")).toMatchObject({ value: null, unavailable: "no_finished_runs_in_window", sampleSize: 0 });

    // Sorting is total, and it is asserted on a bounded read: two runs started at the same instant come back in
    // ascending `runId` order, so the row a `limit` cuts off cannot depend on insertion order.
    for (const runId of ["tie-b", "tie-a"]) {
      await addRun(store, { runId, status: "completed", startedAt: "2026-04-01T00:00:00.000Z" });
    }
    expect((await store.listCodeRunStates({ companyId: COMPANY, startedAfter: new Date("2026-04-01T00:00:00.000Z") }))
      .map((run) => run.runId)).toEqual(["tie-a", "tie-b"]);
    expect((await store.listCodeRunStates({ companyId: COMPANY, startedAfter: new Date("2026-04-01T00:00:00.000Z"), limit: 1 }))
      .map((run) => run.runId)).toEqual(["tie-a"]);
  });
});

// --- route level -----------------------------------------------------------------------------------------

interface Route { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<unknown> }

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return { get: record("get"), post: record("post"), patch: record("patch"), put: record("put"), delete: record("delete") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

/** The real RBAC gate over the shipped role matrix, so the route's authorization is not a stub. */
function rbacGate(): { authorize: CodeMetricsRouteDeps["authorize"] } {
  const rbac = new CodeRbac({ registry: createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX), audit: { record: async () => {} } as CodeAuthorizationAuditPort });
  return { authorize: (ctx, companyId, input) => rbac.authorize(ctx, companyId, input) };
}

async function metricsRoute(deps: Partial<CodeMetricsRouteDeps>): Promise<Route> {
  const routes: Route[] = [];
  const gate = rbacGate();
  await registerCodeMetricsRoutes(fakeInstance(routes), {
    ...gate,
    getAuthContext: () => ({ ...context, role: "developer" }),
    ...deps,
  });
  const route = routes.find((entry) => entry.method === "get" && entry.url.endsWith("/code/metrics"));
  if (!route) throw new Error("metrics route was not registered");
  return route;
}

describe("[C14] [security-gate] the metrics route serves the aggregator's numbers under RBAC", () => {
  it("returns exactly the report the aggregator produced from the same stores", async () => {
    const store = new InMemoryWorkspaceStore();
    await addRun(store, { runId: "r-ok", status: "completed", startedAt: AT, estimate: { turns: 3, costUsd: 0.05 } });
    await addRun(store, { runId: "r-bad", status: "failed", startedAt: AT });
    await addActivityEvent(store, { kind: "code_tool_activity", payload: { tool: "code.fs.write", ok: false }, at: AT });
    await addActivityEvent(store, { kind: "policy_decision", payload: { decision: "require_approval" }, at: AT });

    const expected = await collectCodeMetrics(storePort(store), { companyId: COMPANY, runLimit: 500, eventLimit: 500 }, () => new Date(AT));
    const route = await metricsRoute({ metrics: async () => expected });
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY }, query: {} }, reply);

    const body = state.body as { status: string; apiVersion: string; report: CodeMetricsReport };
    expect(state.status).toBe(200);
    expect(body.status).toBe("ok");
    // Versioned like every other code route, so a client can pin the contract.
    expect(body.apiVersion).toBe("v1");
    // Field by field, not merely "a report came back": a route that re-derived the numbers would differ here.
    expect(body.report).toEqual(expected);
    expect(body.report.metrics).toHaveLength(6);
    expect(metricOf(body.report, "success_rate").value).toBe(0.5);
    expect(metricOf(body.report, "tool_error_rate").value).toBe(1);
    expect(metricOf(body.report, "approvals_share").value).toBe(1);
  });

  it("answers unavailable when this deployment wired no metrics source", async () => {
    const route = await metricsRoute({});
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY }, query: {} }, reply);

    const body = state.body as { status: string; reason: string; report: unknown };
    expect(body.status).toBe("unavailable");
    expect(body.reason).toBe("metrics_source_not_configured");
    expect(body.report).toBe(null);
    // No empty report with zeroes in it: absent data is stated, not tabulated.
    expect(JSON.stringify(body).includes("\"value\":0")).toBe(false);
  });

  it("refuses a permission/action mismatch through the real gate and never runs the aggregation", async () => {
    expect(requiredPermissionForAction(CODE_METRICS_ACTIONS.read)).toBe("workspace:read");
    // An unmapped action is a refusal by default, which is why the action has to be in the vocabulary at all.
    expect(requiredPermissionForAction("code.metrics.write")).toBeNull();

    const called: Array<{ action: string; permission: string }> = [];
    const rbac = new CodeRbac({ registry: createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX), audit: { record: async () => {} } as CodeAuthorizationAuditPort });
    const route = await metricsRoute({
      metrics: async () => { throw new Error("the aggregation must not run for a refused action"); },
      // The real gate, fed the caller's own convenient label instead of the mapped permission — exactly the
      // substitution `permission_action_mismatch` exists to catch.
      authorize: async (ctx, companyId, input) => {
        called.push({ action: input.action, permission: input.permission });
        return rbac.authorize(ctx, companyId, { ...input, permission: "business:manage" });
      },
    });
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY }, query: {} }, reply);

    expect(called).toEqual([{ action: "code.metrics.read", permission: "workspace:read" }]);
    expect(state.status).toBe(403);
    expect((state.body as { error: { code: string } }).error.code).toBe("permission_action_mismatch");
  });

  it("refuses a malformed bound instead of silently ignoring it", async () => {
    expect(() => resolveMetricsQuery({ runLimit: "abc" })).toThrowError(/runLimit/);
    expect(() => resolveMetricsQuery({ since: "not-a-date" })).toThrowError(/since/);
    // Bounds are clamped rather than trusted, so a caller cannot ask for an unbounded read.
    expect(resolveMetricsQuery({ runLimit: "100000" }).runLimit).toBe(500);
    expect(resolveMetricsQuery({ eventLimit: "0" }).eventLimit).toBe(1);
    expect(resolveMetricsQuery({}).since).toBe(null);

    const route = await metricsRoute({ metrics: async () => { throw new Error("must not run"); } });
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY }, query: { runLimit: "abc" } }, reply);
    expect(state.status).toBe(400);
    expect((state.body as { error: { code: string } }).error.code).toBe("invalid_arguments");
  });

  it("requires an authenticated context even before RBAC runs", async () => {
    // `getAuthContext` returning null is what a missing preHandler produces in the built app, and the answer is
    // 401 — never a report computed for an unidentified caller.
    const routes: Route[] = [];
    await registerCodeMetricsRoutes(fakeInstance(routes), {
      ...rbacGate(),
      getAuthContext: () => null,
      metrics: async () => { throw new Error("must not run"); },
    });
    const guarded = routes.find((entry) => entry.url.endsWith("/code/metrics"));
    if (!guarded) throw new Error("metrics route was not registered");
    const { reply, state } = fakeReply();
    await guarded.handler({ params: { companyId: COMPANY }, query: {} }, reply);
    expect(state.status).toBe(401);
    expect((state.body as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("is registered in the security gate and wired in the composed application", () => {
    const gate = readFileSync(new URL("../scripts/run-security-gate.mjs", import.meta.url), "utf8");
    expect(gate).toContain("tests/coding-agent-c14-metrics-aggregation.test.ts");
    const app = readFileSync(new URL("../apps/agent-api/src/app.ts", import.meta.url), "utf8");
    // A route module that is never registered is a surface nobody can reach: the composition is part of the
    // contract, and the context map must have a writer (the C10 wiring guard makes the same demand).
    expect(app).toContain("registerCodeMetricsRoutes(app, {");
    expect(app).toContain("codeMetricsContexts.set(request, await authProvider.authenticate(request));");
    expect(app).toContain("workspaceStore.listCodeRunStates(");
    expect(app).toContain("workspaceStore.listCodeActivityEvents(");
  });
});
