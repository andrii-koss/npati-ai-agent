import type { CodeRunStateRecord, CodeRunToolCallRecord } from "@npati/workspace";
import type { CodeRunBoundary, CodeRunStateLog } from "./code-run-state";

/**
 * C6a: the run reconciler.
 *
 * A code run is driven by one process holding a lease. If that process dies — a crash, a redeploy, a killed
 * container — nothing marks the run as finished: the row still says `running` and the last turn has tool
 * calls whose result nobody observed. This module is the only component that turns that situation into a
 * decidable state, and it does so with one rule that must never be relaxed:
 *
 *   **A tool call whose outcome is unknown is replayed only when it is read-only.**
 *
 * Everything else — writes, shell commands, unknown tools — is reported as `unknown_outcome` and handed to
 * the model and the user as a *doubt* together with a workspace comparison against the last checkpoint. The
 * alternative (replaying a write "to be safe") is the one thing that can silently corrupt a repository, so it
 * is never done, not even when the run is resumed by a human.
 *
 * The reconciler runs at startup and then periodically. It is idempotent by construction: the first pass
 * moves the run out of `running`, so a second pass cannot see it again, and a `dryRun` pass changes nothing
 * at all.
 */

export interface CodeRunWorkspaceDiff {
  /** True when the workspace differs from the checkpoint the last finished turn took. */
  changed: boolean;
  files: string[];
  /** Short, human-readable comparison, e.g. "3 file(s) differ from checkpoint cp-12". */
  summary: string;
  checkpointId: string | null;
  /** True when no checkpoint existed, so the comparison could not be made (never "no changes"). */
  unknownBase?: boolean;
}

export interface CodeRunReplayResult {
  ok: boolean;
  errorCode?: string;
}

export interface CodeRunReconcileActivityEvent {
  kind: "run_interrupted" | "run_recovered";
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  reason: string;
  lastFinishedTurn?: number;
  replayedReadOnlyToolCalls?: number;
  unknownOutcomeToolCalls?: number;
  workspaceChanged?: boolean;
}

/** What the model (and the user) are told before a recovered run continues. */
export interface CodeRunRecoveryNotice {
  runId: string;
  status: "interrupted";
  reason: string;
  lastFinishedTurn: number;
  replayedReadOnlyToolCalls: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcomeToolCalls: Array<{ toolCallId: string; tool: string }>;
  workspaceDiff: CodeRunWorkspaceDiff | null;
  /** The structured message handed to the model and shown to the user; never contains file contents. */
  messageForModel: string;
}

export interface CodeRunReconcileReport {
  scanned: number;
  interrupted: string[];
  recovered: CodeRunRecoveryNotice[];
  skipped: number;
  dryRun: boolean;
}

export interface CodeRunReconcilerDeps {
  log: CodeRunStateLog;
  /** This process's lease identity; a live run of our own is never reconciled. */
  owner?: string;
  now?: () => number;
  /** How many stale runs one pass considers. */
  limit?: number;
  /**
   * Workspace comparison against the last checkpoint. When absent the notice says so explicitly instead of
   * implying "nothing changed".
   */
  workspaceDiffFor?: (input: {
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    checkpointId: string | null;
  }) => Promise<CodeRunWorkspaceDiff | null>;
  /**
   * Replays one read-only call. Only ever called for calls whose `readOnly` flag is true **and** whose
   * outcome is unknown — the reconciler refuses to invoke it for anything else.
   */
  replayReadOnly?: (input: {
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    call: CodeRunToolCallRecord;
  }) => Promise<CodeRunReplayResult>;
  activity?: { record(event: CodeRunReconcileActivityEvent): Promise<void> };
  metrics?: { increment(name: string, tags?: Record<string, string>): void };
}

const DEFAULT_LIMIT = 100;

export class CodeRunReconciler {
  private readonly log: CodeRunStateLog;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly workspaceDiffFor?: CodeRunReconcilerDeps["workspaceDiffFor"];
  private readonly replayReadOnly?: CodeRunReconcilerDeps["replayReadOnly"];
  private readonly activity?: CodeRunReconcilerDeps["activity"];
  private readonly metrics?: CodeRunReconcilerDeps["metrics"];

  constructor(deps: CodeRunReconcilerDeps) {
    this.log = deps.log;
    this.owner = deps.owner ?? `reconciler-${process.pid}`;
    this.now = deps.now ?? (() => Date.now());
    this.limit = deps.limit ?? DEFAULT_LIMIT;
    if (deps.workspaceDiffFor) this.workspaceDiffFor = deps.workspaceDiffFor;
    if (deps.replayReadOnly) this.replayReadOnly = deps.replayReadOnly;
    if (deps.activity) this.activity = deps.activity;
    if (deps.metrics) this.metrics = deps.metrics;
  }

  /**
   * One pass. `dryRun` reports exactly what a real pass would do without writing anything — it is what an
   * operator (or a test) uses to see the recovery set first.
   */
  async reconcileRuns(options: { dryRun?: boolean; now?: Date } = {}): Promise<CodeRunReconcileReport> {
    const dryRun = options.dryRun === true;
    const now = options.now ?? new Date(this.now());
    const stale = await this.log.listStaleRuns({ limit: this.limit, now });
    const report: CodeRunReconcileReport = { scanned: stale.length, interrupted: [], recovered: [], skipped: 0, dryRun };

    for (const state of stale) {
      if (!this.isReconcilable(state, now)) {
        report.skipped += 1;
        continue;
      }
      const boundary = await this.log.loadTurnBoundary(state.companyId, state.runId);
      const notice = await this.buildNotice(state, boundary, dryRun);
      if (!dryRun) {
        // The run leaves `running`, which is what makes a second pass a no-op.
        await this.log.markInterrupted({
          companyId: state.companyId,
          runId: state.runId,
          reason: "lease_expired",
          ...(state.leaseOwner === this.owner ? { owner: this.owner } : {}),
        });
        await this.markIncompleteTurn(state, boundary);
        this.recordActivity({
          kind: "run_interrupted",
          companyId: state.companyId,
          projectId: state.projectId,
          sessionId: state.sessionId,
          runId: state.runId,
          reason: "lease_expired",
          ...(boundary ? { lastFinishedTurn: boundary.lastFinishedTurn } : {}),
        });
        this.metrics?.increment("code_run_interrupted_total", { company: state.companyId });
      }
      report.interrupted.push(state.runId);
      report.recovered.push(notice);
      if (!dryRun) this.metrics?.increment("code_run_recovered_total", { company: state.companyId });
    }
    return report;
  }

  /**
   * A run is reconcilable when it claims to be running and its lease is gone. A live run of our own process is
   * never touched, even if it happened to be listed.
   */
  private isReconcilable(state: CodeRunStateRecord, now: Date): boolean {
    if (state.status !== "running") return false;
    const leased = state.leaseExpiresAt !== null && state.leaseExpiresAt.getTime() >= now.getTime();
    if (!leased) return true;
    return state.leaseOwner !== this.owner;
  }

  /** Marks the interrupted turn as failed with an unknown outcome, so the boundary is complete. */
  private async markIncompleteTurn(state: CodeRunStateRecord, boundary: CodeRunBoundary | null): Promise<void> {
    const turn = boundary?.incompleteTurn;
    if (!turn || turn.status !== "running") return;
    await this.log.appendTurn({
      companyId: state.companyId,
      runId: state.runId,
      turnIndex: turn.turnIndex,
      status: "failed",
      outcome: "unknown_outcome",
      finishedAt: new Date(this.now()),
    });
  }

  private async buildNotice(
    state: CodeRunStateRecord,
    boundary: CodeRunBoundary | null,
    dryRun: boolean,
  ): Promise<CodeRunRecoveryNotice> {
    const replayable = boundary?.replayableReadOnlyToolCalls ?? [];
    const unknown = boundary?.unknownOutcomeToolCalls ?? [];
    const replayed: Array<{ toolCallId: string; tool: string; replayed: boolean }> = [];
    for (const call of replayable) {
      // Defence in depth: the port is never invoked for a call that is not read-only with an unknown outcome.
      const eligible = call.readOnly && call.outcome === "unknown_outcome";
      if (!eligible || dryRun || !this.replayReadOnly) {
        replayed.push({ toolCallId: call.toolCallId, tool: call.tool, replayed: false });
        continue;
      }
      try {
        const result = await this.replayReadOnly({
          companyId: state.companyId,
          projectId: state.projectId,
          sessionId: state.sessionId,
          runId: state.runId,
          call,
        });
        replayed.push({ toolCallId: call.toolCallId, tool: call.tool, replayed: result.ok });
      } catch {
        replayed.push({ toolCallId: call.toolCallId, tool: call.tool, replayed: false });
      }
    }

    let workspaceDiff: CodeRunWorkspaceDiff | null = null;
    if (this.workspaceDiffFor) {
      try {
        workspaceDiff = await this.workspaceDiffFor({
          companyId: state.companyId,
          projectId: state.projectId,
          sessionId: state.sessionId,
          runId: state.runId,
          checkpointId: boundary?.checkpointId ?? null,
        });
      } catch {
        workspaceDiff = null;
      }
    }
    if (!workspaceDiff) {
      workspaceDiff = {
        changed: false,
        files: [],
        summary: "No workspace comparison is available in this deployment; the workspace may differ from the last checkpoint.",
        checkpointId: boundary?.checkpointId ?? null,
        unknownBase: true,
      };
    }

    return {
      runId: state.runId,
      status: "interrupted",
      reason: "lease_expired",
      lastFinishedTurn: boundary?.lastFinishedTurn ?? 0,
      replayedReadOnlyToolCalls: replayed,
      unknownOutcomeToolCalls: unknown.map((call) => ({ toolCallId: call.toolCallId, tool: call.tool })),
      workspaceDiff,
      messageForModel: buildRecoveryMessage({
        lastFinishedTurn: boundary?.lastFinishedTurn ?? 0,
        replayed,
        unknown,
        workspaceDiff,
      }),
    };
  }

  private recordActivity(event: CodeRunReconcileActivityEvent): void {
    if (!this.activity) return;
    // Activity is a log, never a gate: a failing sink must not stop a reconciliation pass.
    void this.activity.record(event).catch(() => undefined);
  }
}

/**
 * The structured notice. It states three facts and one rule: where the run stopped, which reads were replayed
 * (and are therefore safe to trust), which calls may or may not have landed, and that those must not be
 * repeated. It never contains file contents — only paths, names and counts.
 */
export function buildRecoveryMessage(input: {
  lastFinishedTurn: number;
  replayed: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknown: readonly CodeRunToolCallRecord[];
  workspaceDiff: CodeRunWorkspaceDiff;
}): string {
  const replayedOk = input.replayed.filter((call) => call.replayed);
  const lines = [
    "The run was interrupted and is being resumed from the last completed turn.",
    `Last completed turn: ${input.lastFinishedTurn}.`,
    input.workspaceDiff.unknownBase
      ? `Workspace comparison: unavailable (${input.workspaceDiff.summary})`
      : `Workspace comparison against checkpoint ${input.workspaceDiff.checkpointId ?? "(none)"}: ${input.workspaceDiff.summary}`,
  ];
  if (input.workspaceDiff.files.length) {
    lines.push(`Files that differ: ${input.workspaceDiff.files.slice(0, 20).join(", ")}`);
  }
  if (replayedOk.length) {
    lines.push(`Re-read (safe, read-only): ${replayedOk.map((call) => call.tool).join(", ")}.`);
  }
  if (input.unknown.length) {
    lines.push(
      `Result UNKNOWN for ${input.unknown.length} call(s) that may have changed the workspace: `
      + `${input.unknown.map((call) => `${call.tool}#${call.toolCallId}`).join(", ")}.`,
      "Do NOT repeat those calls. Inspect the workspace diff above first, then decide: continue from the current state, or ask the user how to proceed.",
    );
  }
  return lines.join("\n");
}
