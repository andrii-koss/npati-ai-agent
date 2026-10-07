import type { CodeRunStateRecord, CodeRunToolCallRecord } from "@npati/workspace";
import type { CodeRunBoundary, CodeRunStateLog } from "./code-run-state";
import { scanTextForSecrets } from "./code-secret-scanner";

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
  /** C6b: snapshot of the run this reconciliation belongs to, when one exists. */
  snapshotId?: string;
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

/**
 * The notice as it is persisted (C10). It is the same information as `CodeRunRecoveryNotice` minus the
 * `status: "interrupted"` literal, which the run state already carries — a second copy of a status in a
 * second table is a second thing that can disagree — plus the tenant identity the store needs.
 */
export interface CodeRunRecoveryNoticeInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  reason: string;
  lastFinishedTurn: number;
  replayedReadOnly: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcome: Array<{ toolCallId: string; tool: string }>;
  /** The comparison against the last checkpoint, as a plain value the store can persist. */
  workspaceDiff: Record<string, unknown> | null;
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
  /**
   * C10: where the notice is stored so it is reachable instead of discarded.
   *
   * Until C10 the notice existed only inside the report this class returns: `app.ts` fired
   * `reconcileRuns()` with a `.catch()` that logged the error and dropped the value, so the one component that
   * knows *why* a run stopped and *which* calls are in doubt produced information nobody could read. With this
   * port the notice becomes a durable, append-only row that a resume and the recovery route both read.
   *
   * Optional, and best effort like `activity`: a deployment without a notice store keeps reconciling exactly as
   * before. A refusal is logged rather than swallowed, because "we could not store the notice" and "there was
   * nothing to store" are different facts and only one of them is a gap.
   */
  notices?: { record(input: CodeRunRecoveryNoticeInput): Promise<void> };
  logger?: { warn(payload: unknown, message?: string): void };
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
  private readonly notices?: CodeRunReconcilerDeps["notices"];
  private readonly logger?: { warn(payload: unknown, message?: string): void };

  constructor(deps: CodeRunReconcilerDeps) {
    this.log = deps.log;
    this.owner = deps.owner ?? `reconciler-${process.pid}`;
    this.now = deps.now ?? (() => Date.now());
    this.limit = deps.limit ?? DEFAULT_LIMIT;
    if (deps.workspaceDiffFor) this.workspaceDiffFor = deps.workspaceDiffFor;
    if (deps.replayReadOnly) this.replayReadOnly = deps.replayReadOnly;
    if (deps.activity) this.activity = deps.activity;
    if (deps.metrics) this.metrics = deps.metrics;
    if (deps.notices) this.notices = deps.notices;
    if (deps.logger) this.logger = deps.logger;
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
        await this.storeNotice(state, notice);
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
   *
   * C9 added `waiting_for_user`, and the check below is written as an explicit refusal rather than relying on the
   * `status !== "running"` line, because that state is the one case where "no live lease" means something other
   * than a crash: the run is paused on a question, a human is expected to answer, and the question row is what
   * keeps it alive. Recovering it would replay work and discard the answer that is on its way.
   */
  private isReconcilable(state: CodeRunStateRecord, now: Date): boolean {
    if (state.status === "waiting_for_user") return false;
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

  /**
   * C10: persists the notice, so the recovery is readable after the report object is gone.
   *
   * A dry run never reaches this method (the caller only stores on a real pass), because a dry run must change
   * nothing at all. A failure here is logged and swallowed: the run has already been moved to `interrupted`
   * with its turn boundary recorded, and un-doing that because a notice could not be written would trade a
   * complete recovery for an incomplete one.
   */
  private async storeNotice(state: CodeRunStateRecord, notice: CodeRunRecoveryNotice): Promise<void> {
    if (!this.notices) return;
    const input: CodeRunRecoveryNoticeInput = {
      companyId: state.companyId,
      projectId: state.projectId,
      sessionId: state.sessionId,
      runId: notice.runId,
      reason: notice.reason,
      lastFinishedTurn: notice.lastFinishedTurn,
      replayedReadOnly: notice.replayedReadOnlyToolCalls,
      unknownOutcome: notice.unknownOutcomeToolCalls,
      // The diff is metadata only (paths, a summary, a boolean); it is stored so a reader does not have to
      // re-derive a comparison against a workspace that has moved on since.
      workspaceDiff: notice.workspaceDiff
        ? {
            changed: notice.workspaceDiff.changed,
            files: notice.workspaceDiff.files,
            summary: notice.workspaceDiff.summary,
            checkpointId: notice.workspaceDiff.checkpointId,
            ...(notice.workspaceDiff.unknownBase === undefined ? {} : { unknownBase: notice.workspaceDiff.unknownBase }),
          }
        : null,
      messageForModel: notice.messageForModel,
    };
    /**
     * The notice is built from metadata — tool names, call ids, paths and counts — but it is about to become a
     * durable row, and "we built it from safe parts" is not a guarantee. A notice that would have to be redacted
     * is **refused** instead of stored, because a sanitised notice would carry a placeholder into the record a
     * resume hands to the model, and a placeholder is a reference that must never reach disk.
     */
    const findings = scanTextForSecrets(JSON.stringify(input)).findings;
    if (findings.length) {
      this.logger?.warn(
        { runId: state.runId, kinds: Array.from(new Set(findings.map((finding) => String(finding.kind)))) },
        "code_run_recovery_notice_refused",
      );
      return;
    }
    try {
      await this.notices.record(input);
    } catch (error) {
      this.logger?.warn({ runId: state.runId, err: error }, "code_run_recovery_notice_store_failed");
    }
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
