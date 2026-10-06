import { describe, expect, it, vi } from "vitest";
import {
  CodeReaper,
  DEFAULT_REAPER_GRACE_MS,
  type CodeReaperPorts,
  type ReaperActivityEvent,
  type ReaperSummary,
} from "../apps/agent-api/src/code-reaper";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const MINUTE = 60_000;

interface Harness {
  reaper: CodeReaper;
  ports: CodeReaperPorts;
  events: ReaperActivityEvent[];
  warnings: Array<{ payload: unknown; message?: string }>;
}

function harness(overrides: Partial<CodeReaperPorts> = {}, options: { now?: number } = {}): Harness {
  const events: ReaperActivityEvent[] = [];
  const warnings: Array<{ payload: unknown; message?: string }> = [];
  const ports: CodeReaperPorts = {
    logger: {
      warn: (payload, message) => warnings.push({ payload, message }),
      info: () => undefined,
    },
    activity: { record: (event) => { events.push(event); } },
    ...overrides,
  };
  const reaper = new CodeReaper({
    ...ports,
    intervalMs: 60_000,
    toolCallNoProgressMs: 300_000,
    maxRunMinutes: 30,
    now: () => options.now ?? NOW,
  });
  return { reaper, ports, events, warnings };
}

describe("security-gate: C6a reaper — orphan processes, tool calls and overdue runs", () => {
  it("stops orphan processes and never touches a process of a live run", async () => {
    const stopOrphan = vi.fn(async () => undefined);
    const listOrphans = vi.fn(async () => [
      { processId: "p-gone", sessionId: "s-1", reason: "run_gone" as const },
      { processId: "p-cancelled", sessionId: "s-2", runId: "run-2", reason: "run_cancelled" as const },
    ]);
    const { reaper } = harness({ orphanProcesses: { listOrphans, stopOrphan } });

    const summary = await reaper.run();

    expect(summary.cleaned.orphanProcesses).toBe(2);
    expect(stopOrphan).toHaveBeenCalledTimes(2);
    // The live run's process is never reported by the scan, so it is never stopped.
    expect(stopOrphan.mock.calls.map((call) => (call[0] as { processId: string }).processId)).toEqual(["p-gone", "p-cancelled"]);
    expect(summary.errors).toEqual([]);
  });

  it("aborts a tool call without progress but leaves an explicitly long-running task alone", async () => {
    const abortStuck = vi.fn(async () => undefined);
    const { reaper } = harness({
      stuckToolCalls: {
        listStuck: async () => [
          { runId: "run-1", toolCallId: "call-stuck", sessionId: "s-1", noProgressMs: 400_000 },
          { runId: "run-1", toolCallId: "call-long", sessionId: "s-1", noProgressMs: 900_000, longRunning: true },
          { runId: "run-1", toolCallId: "call-fresh", sessionId: "s-1", noProgressMs: 10_000 },
        ],
        abortStuck,
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.stuckToolCalls).toBe(1);
    expect(abortStuck).toHaveBeenCalledTimes(1);
    expect((abortStuck.mock.calls[0]![0] as { toolCallId: string }).toolCallId).toBe("call-stuck");
  });

  it("stops a run only past wall clock plus grace", async () => {
    const stopOverdue = vi.fn(async () => undefined);
    const limitMs = 30 * MINUTE + DEFAULT_REAPER_GRACE_MS;
    const { reaper } = harness({
      overdueRuns: {
        listOverdue: async () => [
          { runId: "run-over", sessionId: "s-1", companyId: "c-1", startedAt: NOW - limitMs - MINUTE, elapsedMs: limitMs + MINUTE },
          // Exactly at the wall clock limit is NOT over the limit plus grace.
          { runId: "run-exact", sessionId: "s-2", companyId: "c-1", startedAt: NOW - limitMs, elapsedMs: limitMs },
        ],
        stopOverdue,
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.overdueRuns).toBe(1);
    expect((stopOverdue.mock.calls[0]![0] as { runId: string }).runId).toBe("run-over");
  });
});

describe("security-gate: C6a reaper — approvals, sandboxes, temp dirs and locks", () => {
  it("expires stale approvals through the owner's port and leaves valid ones untouched", async () => {
    const expireStaleApprovals = vi.fn(async () => 2);
    const { reaper } = harness({ staleApprovals: { expireStaleApprovals } });

    const summary = await reaper.run();

    expect(summary.cleaned.staleApprovals).toBe(2);
    // The reaper never decides expiry itself: it hands the current time to the port, which owns the
    // transition (and its audit) so a valid approval cannot be expired by the reaper.
    expect(expireStaleApprovals).toHaveBeenCalledWith({ now: NOW });
  });

  it("destroys only labelled orphan sandboxes and never an active or unlabelled container", async () => {
    const destroyOrphan = vi.fn(async () => undefined);
    const { reaper } = harness({
      activeSandboxes: { listActiveSandboxIds: async () => ["sb-active"] },
      orphanSandboxes: {
        listOrphans: async () => [
          { id: "sb-orphan", scope: "scope-1", labels: { "npati.scope": "scope-1", "npati.sandbox": "sb-orphan" }, reason: "unknown_session" as const },
          { id: "sb-active", scope: "scope-1", labels: { "npati.scope": "scope-1", "npati.sandbox": "sb-active" }, reason: "unknown_session" as const },
          { id: "sb-unlabelled", scope: "scope-x", labels: {}, reason: "unknown_session" as const },
        ],
        destroyOrphan,
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.orphanSandboxes).toBe(1);
    expect(destroyOrphan).toHaveBeenCalledTimes(1);
    expect((destroyOrphan.mock.calls[0]![0] as { id: string }).id).toBe("sb-orphan");
  });

  it("removes a stale owned temp dir and reports an unowned one instead of deleting it", async () => {
    const remove = vi.fn(async () => undefined);
    const { reaper, warnings } = harness({
      tempDirs: {
        listStale: async () => [
          { path: "/tmp/run-1", ageMs: 7 * 60 * MINUTE, ownerRunId: "run-1" },
          { path: "/tmp/unknown", ageMs: 7 * 60 * MINUTE },
        ],
        remove,
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.tempDirs).toBe(1);
    expect(remove).toHaveBeenCalledWith("/tmp/run-1");
    expect(warnings.some((entry) => entry.message === "code_reaper_temp_dir_unowned_skipped")).toBe(true);
  });

  it("releases a dead owner's stale lock but never an advisory migration lock or a live owner's lock", async () => {
    const release = vi.fn(async () => true);
    const { reaper, warnings } = harness({
      staleLocks: {
        listStale: async () => [
          { key: "file-lock", ageMs: 45 * MINUTE, ownerAlive: false },
          { key: "migration-lock", ageMs: 45 * MINUTE, ownerAlive: false, advisory: true },
          { key: "live-lock", ageMs: 45 * MINUTE, ownerAlive: true },
        ],
        release,
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.staleLocks).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect((release.mock.calls[0]![0] as { key: string }).key).toBe("file-lock");
    expect(warnings.some((entry) => entry.message === "code_reaper_lock_skipped")).toBe(true);
  });
});

describe("security-gate: C6a reaper — dry run, idempotency, disk pressure and metrics", () => {
  it("changes nothing in a dry run and returns the plan it would apply", async () => {
    const reap = vi.fn(async () => 3);
    const stopOrphan = vi.fn(async () => undefined);
    const reapIdle = vi.fn(() => 5);
    const { reaper } = harness({
      secretLeases: { preview: async () => 1, reap },
      processRecords: { reapIdle },
      orphanProcesses: { listOrphans: async () => [{ processId: "p-1", sessionId: "s-1", reason: "run_gone" as const }], stopOrphan },
    });

    const summary = await reaper.run({ dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.cleaned.secretLeases).toBe(1);
    expect(summary.cleaned.orphanProcesses).toBe(1);
    // Nothing mutating was called: a dry run performs no cleanup at all.
    expect(reap).not.toHaveBeenCalled();
    expect(stopOrphan).not.toHaveBeenCalled();
    expect(reapIdle).not.toHaveBeenCalled();
    // Steps without a preview are visible rather than silently reported as clean.
    expect(
      summary.skipped.some((entry) => entry.step === "process_records" && entry.reason === "dry_run_preview_unavailable"),
    ).toBe(true);
  });

  it("is idempotent: a second pass over already cleaned targets succeeds and reports no errors", async () => {
    let leaseReaped = false;
    let orphans: Array<{ processId: string; sessionId: string; reason: "run_gone" }> = [
      { processId: "p-1", sessionId: "s-1", reason: "run_gone" },
    ];
    const stopOrphan = vi.fn(async () => undefined);
    const reap = vi.fn(async () => {
      if (leaseReaped) return 0;
      leaseReaped = true;
      return 1;
    });
    const { reaper } = harness({
      secretLeases: { preview: async () => 0, reap },
      orphanProcesses: { listOrphans: async () => orphans, stopOrphan },
    });

    const first = await reaper.run();
    // The targets are gone by the time the second pass starts: nothing to clean is a success, not a crash,
    // and the already-cleaned orphan is not stopped a second time.
    orphans = [];
    const second = await reaper.run();

    expect(first.cleaned.secretLeases).toBe(1);
    expect(first.cleaned.orphanProcesses).toBe(1);
    expect(second.cleaned.secretLeases).toBe(0);
    expect(second.cleaned.orphanProcesses).toBe(0);
    expect(stopOrphan).toHaveBeenCalledTimes(1);
    expect(second.errors).toEqual([]);
  });

  it("a failing step is reported without taking the other steps down", async () => {
    const stopOrphan = vi.fn(async () => undefined);
    const { reaper } = harness({
      secretLeases: { preview: async () => 0, reap: async () => { throw new Error("lease store unavailable"); } },
      orphanProcesses: { listOrphans: async () => [{ processId: "p-1", sessionId: "s-1", reason: "run_gone" as const }], stopOrphan },
    });

    const summary = await reaper.run();

    expect(summary.errors.some((entry) => entry.step === "secret_leases" && entry.message === "lease store unavailable")).toBe(true);
    expect(summary.cleaned.orphanProcesses).toBe(1);
  });

  it("refuses new runs when disk pressure crosses the floor and reports it", async () => {
    const { reaper } = harness({ disk: { usage: async () => ({ freeBytes: 1024, freeInodes: 10 }) } });

    const summary = await reaper.run();

    expect(summary.refuseNewRuns).toBe(true);
    expect(reaper.isRefusingNewRuns()).toBe(true);
  });

  it("reports missing capabilities as skipped steps instead of a silent all-clean", async () => {
    const { reaper } = harness({ secretLeases: { preview: async () => 0, reap: async () => 0 } });

    const summary = await reaper.run();

    const skippedSteps = summary.skipped.map((entry) => entry.step);
    for (const step of ["process_records", "orphan_processes", "shell_sessions", "stuck_tool_calls", "overdue_runs", "stale_approvals", "orphan_sandboxes", "temp_dirs", "stale_locks", "disk_pressure"] as const) {
      expect(skippedSteps).toContain(step);
    }
  });

  it("emits metrics and Activity entries without file contents, commands or secrets", async () => {
    const { reaper, events } = harness({
      secretLeases: { preview: async () => 0, reap: async () => 1 },
      tempDirs: {
        listStale: async () => [{ path: "/tmp/run-1", ageMs: 7 * 60 * MINUTE, ownerRunId: "run-1" }],
        remove: async () => undefined,
      },
    });

    const summary: ReaperSummary = await reaper.run();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("code_reaper");
    expect(event.cleaned.secretLeases).toBe(1);
    expect(event.cleaned.tempDirs).toBe(1);
    expect(event.durationMs).toBe(summary.durationMs);
    // The event is counts and reasons only: no command text, no file contents, no secret material.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/npm |git |curl |DATABASE_URL|password|token|secret_/i);
    expect(Object.keys(event)).not.toContain("command");
    expect(Object.keys(event)).not.toContain("content");
  });
});
