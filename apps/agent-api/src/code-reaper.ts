/**
 * C6a: background reaper for the Coding Agent.
 *
 * This module is deliberately an **orchestrator**: it owns the schedule, the ordering, the dry-run
 * contract, the idempotency guarantees and the metrics, and it calls the reap/cleanup functions that
 * already exist (secret leases, process records, shell sessions, sandboxes, approvals, locks, disk)
 * instead of re-implementing any of them. Every step is declared through a port so a missing capability
 * is reported as `skipped` with a reason — never as a silent gap and never by inventing a second
 * mechanism.
 *
 * Two invariants matter more than the individual steps:
 *  - a run in `dryRun` performs **no** mutation at all (steps without a preview are reported as skipped);
 *  - running the reaper twice in a row is safe: a step that finds nothing to clean succeeds, and a step
 *    whose target disappeared between the scan and the action is reported as a no-op, not as an error.
 */

export type ReaperStep =
  | "secret_leases"
  | "process_records"
  | "orphan_processes"
  | "shell_sessions"
  | "stuck_tool_calls"
  | "overdue_runs"
  | "stale_approvals"
  | "orphan_sandboxes"
  | "temp_dirs"
  | "stale_locks"
  | "disk_pressure"
  /** C9: questions past their TTL, which release the run they were holding as `ask_user_timeout`. */
  | "expire_user_questions"
  /**
   * R1-C (item 11): the retention step. `toolResultRetentionDays` and `transcriptRetentionDays` were declared
   * by C1 and read by nobody, so nothing ever expired: this is the step that executes them, over the rows'
   * own `retention_class` rather than over a second set of numbers invented here.
   */
  | "data_retention";

export interface ReaperCleanedCounts {
  secretLeases: number;
  processRecords: number;
  orphanProcesses: number;
  shellSessions: number;
  stuckToolCalls: number;
  overdueRuns: number;
  staleApprovals: number;
  orphanSandboxes: number;
  tempDirs: number;
  staleLocks: number;
  expiredUserQuestions: number;
  /** R1-C: code rows past the retention window their own `retention_class` names. */
  expiredDataRows: number;
  /**
   * R1-C: rows retention **matched but deliberately kept** because the database forbids deleting them
   * (append-only evidence). Reported next to `expiredDataRows` so a pass cannot look like a clean sweep of
   * evidence it never touched.
   */
  retainedDataRows: number;
}

export interface ReaperSkip {
  step: ReaperStep;
  reason: string;
}

export interface ReaperError {
  step: ReaperStep;
  message: string;
}

export interface ReaperSummary {
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** What was cleaned (in `dryRun`: what *would* be cleaned). */
  cleaned: ReaperCleanedCounts;
  skipped: ReaperSkip[];
  errors: ReaperError[];
  /** Set when free disk space crossed the configured floor: new runs must be refused until it recovers. */
  refuseNewRuns: boolean;
}

export interface ReaperActivityEvent {
  kind: "code_reaper";
  dryRun: boolean;
  cleaned: ReaperCleanedCounts;
  skipped: ReaperSkip[];
  errors: ReaperError[];
  refuseNewRuns: boolean;
  durationMs: number;
  at: number;
}

export interface OrphanProcess {
  processId: string;
  sessionId: string;
  runId?: string;
  /** Why the process is considered orphaned. */
  reason: "run_gone" | "run_cancelled" | "session_gone";
}

export interface StuckToolCall {
  runId: string;
  toolCallId: string;
  sessionId: string;
  /** Milliseconds since the last observed progress for this call. */
  noProgressMs: number;
  /** A long-running task is explicitly declared as such and is never killed by the reaper. */
  longRunning?: boolean;
}

export interface OverdueRun {
  runId: string;
  sessionId: string;
  companyId: string;
  startedAt: number;
  elapsedMs: number;
}

export interface StaleApproval {
  id: string;
  companyId: string;
  expiresAt: number;
}

export interface OrphanSandbox {
  id: string;
  scope: string;
  /** Labels as reported by the provider (`npati.scope`, `npati.sandbox`, …). */
  labels: Record<string, string>;
  reason: "unknown_session" | "run_finished" | "unlabelled_scope_mismatch";
}

export interface StaleTempDir {
  path: string;
  ageMs: number;
  /** Ownership must be provable: an unowned path is reported, never deleted. */
  ownerRunId?: string;
}

export interface StaleLock {
  key: string;
  ageMs: number;
  /** Only released when the owner is proven dead. Advisory locks are never released blind. */
  ownerAlive?: boolean;
  advisory?: boolean;
}

export interface DiskUsage {
  freeBytes: number;
  freeInodes?: number;
}

/**
 * R1-C (items 11–12): what a retention pass reports. A distinct `retained` list — not a single total — because
 * the interesting fact is *which* family was kept and *why*: an append-only evidence table must never be
 * counted as purged, and a reason is what tells an operator whether a zero means "nothing to do" or
 * "forbidden to do".
 */
export interface DataRetentionPortResult {
  expired: number;
  purged: number;
  /** Rows the sweep matched but is forbidden to delete, with the reasons (codes, never row content). */
  retained: number;
  retainedReasons: string[];
}

export interface DataRetentionPortPreview {
  expired: number;
  retained: number;
  retainedReasons: string[];
}

/**
 * Ports the reaper drives. Every one is optional: an absent port becomes a `skipped` entry with a reason,
 * which is how a missing capability stays visible instead of looking like "nothing to clean".
 */
export interface CodeReaperPorts {
  secretLeases?: {
    /**
     * How many active leases are already past their expiry. It lives in the caller because only the lease
     * module knows its own state vocabulary — the reaper never inspects lease shapes itself (no casts, no
     * assumptions about fields) and a missing preview simply reports the step as skipped in a dry run.
     */
    preview(): Promise<number>;
    reap(): Promise<number>;
  };
  processRecords?: {
    reapIdle(): number;
  };
  orphanProcesses?: {
    listOrphans(): Promise<OrphanProcess[]>;
    stopOrphan(process: OrphanProcess): Promise<void>;
  };
  shellSessions?: {
    reap(): number;
  };
  stuckToolCalls?: {
    listStuck(input: { olderThanMs: number; now: number }): Promise<StuckToolCall[]>;
    abortStuck(call: StuckToolCall): Promise<void>;
  };
  overdueRuns?: {
    listOverdue(input: { maxRunMinutes: number; graceMs: number; now: number }): Promise<OverdueRun[]>;
    stopOverdue(run: OverdueRun): Promise<void>;
  };
  /** Kept as a port so the approvals module can expose a bulk expiry without the reaper touching its pool. */
  staleApprovals?: {
    expireStaleApprovals(input: { now: number }): Promise<number>;
  };
  /**
   * C9: pending user questions whose TTL passed. The port has a genuine preview (the questions themselves), so a
   * dry run reports exactly what a real pass would expire instead of claiming the step is unavailable — a step
   * that cannot be previewed is reported as `dry_run_preview_unavailable`, never as "nothing to clean".
   *
   * Expiring is the only honest outcome: the question becomes `expired`, the run it paused goes to `interrupted`
   * with `ask_user_timeout`, and **no answer is written**. A timeout that guessed a default would be the user's
   * decision made by a clock.
   */
  userQuestions?: {
    previewCodeUserQuestions(input: { now: number }): Promise<Array<{ companyId: string; runId: string; questionId: string }>>;
    expireCodeUserQuestions(input: { now: number }): Promise<number>;
  };
  orphanSandboxes?: {
    listOrphans(input: { activeSandboxIds: string[] }): Promise<OrphanSandbox[]>;
    destroyOrphan(sandbox: OrphanSandbox): Promise<void>;
  };
  /**
   * R1-C (item 11): data retention. The port has a **real** preview — the rows the rule matches can be counted
   * without deleting them — so a dry run reports exactly what a real pass would expire instead of claiming the
   * step is unavailable.
   *
   * Two things this port deliberately does **not** carry:
   *
   *  - any number. The windows come from the existing `CodeAgentLimits` (`toolResultRetentionDays`,
   *    `transcriptRetentionDays`) and the row's own `retention_class`; a second set of limits here is exactly
   *    the defect this step exists to close.
   *  - any row content. The port returns counts, and the reasons it returns are codes
   *    (`append_only_evidence`), never a table's rows.
   */
  dataRetention?: {
    preview(input: { now: number }): Promise<DataRetentionPortPreview>;
    apply(input: { now: number }): Promise<DataRetentionPortResult>;
  };
  /** Which sandboxes belong to a live session; supplied by the caller's store, never guessed. */
  activeSandboxes?: { listActiveSandboxIds(): Promise<string[]> };
  tempDirs?: {
    listStale(input: { olderThanMs: number; now: number }): Promise<StaleTempDir[]>;
    remove(path: string): Promise<void>;
  };
  staleLocks?: {
    listStale(input: { olderThanMs: number; now: number }): Promise<StaleLock[]>;
    release(lock: StaleLock): Promise<boolean>;
  };
  disk?: {
    usage(): Promise<DiskUsage>;
  };
  activity?: { record(event: ReaperActivityEvent): Promise<void> | void };
  logger?: { warn(payload: unknown, message?: string): void; info(payload: unknown, message?: string): void };
}

export interface CodeReaperOptions extends CodeReaperPorts {
  intervalMs: number;
  /** Tool calls without progress beyond this are aborted unless explicitly long-running. */
  toolCallNoProgressMs: number;
  maxRunMinutes: number;
  /** Runs are stopped only after the wall clock limit plus this grace period. */
  runGraceMs?: number;
  /** Temp directories and locks older than this are candidates (ownership is still required). */
  tempDirTtlMs?: number;
  lockTtlMs?: number;
  /** Below this amount of free disk (or free inodes) new runs are refused. */
  diskFreeFloorBytes?: number;
  diskFreeInodeFloor?: number;
  now?: () => number;
}

export const DEFAULT_REAPER_GRACE_MS = 60_000;
export const DEFAULT_REAPER_TEMP_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REAPER_LOCK_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_REAPER_DISK_FLOOR_BYTES = 512 * 1024 * 1024;
export const DEFAULT_REAPER_INODE_FLOOR = 1_000;

function emptyCounts(): ReaperCleanedCounts {
  return {
    secretLeases: 0,
    processRecords: 0,
    orphanProcesses: 0,
    shellSessions: 0,
    stuckToolCalls: 0,
    overdueRuns: 0,
    staleApprovals: 0,
    orphanSandboxes: 0,
    tempDirs: 0,
    staleLocks: 0,
    expiredUserQuestions: 0,
    expiredDataRows: 0,
    retainedDataRows: 0,
  };
}

export class CodeReaper {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastSummary?: ReaperSummary;
  private refuseNewRuns = false;
  private readonly now: () => number;
  private readonly runGraceMs: number;
  private readonly tempDirTtlMs: number;
  private readonly lockTtlMs: number;
  private readonly diskFreeFloorBytes: number;
  private readonly diskFreeInodeFloor: number;

  constructor(private readonly options: CodeReaperOptions) {
    this.now = options.now ?? (() => Date.now());
    const positive = (value: number | undefined, fallback: number) =>
      Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
    this.runGraceMs = positive(options.runGraceMs, DEFAULT_REAPER_GRACE_MS);
    this.tempDirTtlMs = positive(options.tempDirTtlMs, DEFAULT_REAPER_TEMP_TTL_MS);
    this.lockTtlMs = positive(options.lockTtlMs, DEFAULT_REAPER_LOCK_TTL_MS);
    this.diskFreeFloorBytes = positive(options.diskFreeFloorBytes, DEFAULT_REAPER_DISK_FLOOR_BYTES);
    this.diskFreeInodeFloor = positive(options.diskFreeInodeFloor, DEFAULT_REAPER_INODE_FLOOR);
  }

  /** True while disk pressure is above the configured floor: callers must refuse to start new runs. */
  isRefusingNewRuns(): boolean {
    return this.refuseNewRuns;
  }

  lastReport(): ReaperSummary | undefined {
    return this.lastSummary ? { ...this.lastSummary, cleaned: { ...this.lastSummary.cleaned } } : undefined;
  }

  /**
   * Runs every step once. Never throws: a failing step is reported in `errors` so one broken capability
   * cannot take down the others (or the server that hosts the reaper).
   */
  async run(options: { dryRun?: boolean } = {}): Promise<ReaperSummary> {
    const dryRun = options.dryRun === true;
    const startedAt = this.now();
    const cleaned = emptyCounts();
    const skipped: ReaperSkip[] = [];
    const errors: ReaperError[] = [];

    const step = async (name: ReaperStep, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ step: name, message });
        this.options.logger?.warn({ step: name, message }, "code_reaper_step_failed");
      }
    };

    // 1. Secret leases: the provider already owns `reap()`; the preview uses its public `list`.
    if (!this.options.secretLeases) skipped.push({ step: "secret_leases", reason: "port_unavailable" });
    else if (dryRun) {
      await step("secret_leases", async () => {
        cleaned.secretLeases = await this.options.secretLeases!.preview();
      });
    } else {
      await step("secret_leases", async () => {
        cleaned.secretLeases = await this.options.secretLeases!.reap();
      });
    }

    // 2. Process records: the existing `reapIdle()` only forgets idle/stopped records and never kills a
    //    running process, so it is safe to call directly. It has no preview, so dry runs report it.
    if (!this.options.processRecords) skipped.push({ step: "process_records", reason: "port_unavailable" });
    else if (dryRun) skipped.push({ step: "process_records", reason: "dry_run_preview_unavailable" });
    else {
      await step("process_records", async () => {
        cleaned.processRecords = this.options.processRecords!.reapIdle();
      });
    }

    // 3. Orphan processes: only processes whose run is gone/cancelled. Requires an owner-supplied scan.
    if (!this.options.orphanProcesses) skipped.push({ step: "orphan_processes", reason: "port_unavailable" });
    else {
      await step("orphan_processes", async () => {
        const orphans = await this.options.orphanProcesses!.listOrphans();
        // An orphan is only actionable when the reason is provable; otherwise it is left alone.
        const actionable = orphans.filter((process) => process.reason !== undefined);
        cleaned.orphanProcesses = actionable.length;
        if (dryRun) return;
        let stopped = 0;
        for (const process of actionable) {
          try {
            await this.options.orphanProcesses!.stopOrphan(process);
            stopped += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "orphan_processes", message });
            this.options.logger?.warn({ step: "orphan_processes", processId: process.processId, message }, "code_reaper_orphan_stop_failed");
          }
        }
        cleaned.orphanProcesses = stopped;
      });
    }

    // 4. Shell sessions: forgets idle sessions and their environment.
    if (!this.options.shellSessions) skipped.push({ step: "shell_sessions", reason: "port_unavailable" });
    else if (dryRun) skipped.push({ step: "shell_sessions", reason: "dry_run_preview_unavailable" });
    else {
      await step("shell_sessions", async () => {
        cleaned.shellSessions = this.options.shellSessions!.reap();
      });
    }

    // 5. Tool calls without progress. Long-running tasks are explicitly declared and never killed here.
    if (!this.options.stuckToolCalls) skipped.push({ step: "stuck_tool_calls", reason: "port_unavailable" });
    else {
      await step("stuck_tool_calls", async () => {
        const now = this.now();
        const stuck = await this.options.stuckToolCalls!.listStuck({ olderThanMs: this.options.toolCallNoProgressMs, now });
        const actionable = stuck.filter((call) => call.longRunning !== true && call.noProgressMs >= this.options.toolCallNoProgressMs);
        cleaned.stuckToolCalls = actionable.length;
        if (dryRun) return;
        let aborted = 0;
        for (const call of actionable) {
          try {
            await this.options.stuckToolCalls!.abortStuck(call);
            aborted += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "stuck_tool_calls", message });
            this.options.logger?.warn({ step: "stuck_tool_calls", toolCallId: call.toolCallId, message }, "code_reaper_tool_call_abort_failed");
          }
        }
        cleaned.stuckToolCalls = aborted;
      });
    }

    // 6. Runs past wall clock + grace.
    if (!this.options.overdueRuns || this.options.maxRunMinutes <= 0) skipped.push({ step: "overdue_runs", reason: this.options.maxRunMinutes <= 0 ? "unlimited" : "port_unavailable" });
    else {
      await step("overdue_runs", async () => {
        const now = this.now();
        const overdue = await this.options.overdueRuns!.listOverdue({
          maxRunMinutes: this.options.maxRunMinutes,
          graceMs: this.runGraceMs,
          now,
        });
        const cutoffMs = this.options.maxRunMinutes * 60_000 + this.runGraceMs;
        const actionable = overdue.filter((run) => run.elapsedMs > cutoffMs);
        cleaned.overdueRuns = actionable.length;
        if (dryRun) return;
        let stopped = 0;
        for (const run of actionable) {
          try {
            await this.options.overdueRuns!.stopOverdue(run);
            stopped += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "overdue_runs", message });
            this.options.logger?.warn({ step: "overdue_runs", runId: run.runId, message }, "code_reaper_overdue_stop_failed");
          }
        }
        cleaned.overdueRuns = stopped;
      });
    }

    // 7. Stale approvals: the approvals module owns the bulk transition (and its audit); until it exposes
    //    one, this step is reported as skipped instead of being reimplemented against its private pool.
    if (!this.options.staleApprovals) skipped.push({ step: "stale_approvals", reason: "port_unavailable" });
    else {
      await step("stale_approvals", async () => {
        const now = this.now();
        if (dryRun) {
          // The approvals port only exposes the bulk transition (no preview), so dry runs report it.
          skipped.push({ step: "stale_approvals", reason: "dry_run_preview_unavailable" });
          return;
        }
        cleaned.staleApprovals = await this.options.staleApprovals!.expireStaleApprovals({ now });
      });
    }

    // 8. Orphan sandboxes: identified by the provider's own labels (`npati.scope` / `npati.sandbox`) and
    //    cross-checked against live sessions. Unlabelled containers are never touched.
    if (!this.options.orphanSandboxes || !this.options.activeSandboxes) {
      skipped.push({ step: "orphan_sandboxes", reason: "port_unavailable" });
    } else {
      await step("orphan_sandboxes", async () => {
        const active = new Set(await this.options.activeSandboxes!.listActiveSandboxIds());
        const orphans = await this.options.orphanSandboxes!.listOrphans({ activeSandboxIds: [...active] });
        const actionable = orphans.filter((sandbox) => {
          if (!sandbox.labels["npati.sandbox"] || !sandbox.labels["npati.scope"]) return false;
          return !active.has(sandbox.id);
        });
        cleaned.orphanSandboxes = actionable.length;
        if (dryRun) return;
        let destroyed = 0;
        for (const sandbox of actionable) {
          try {
            await this.options.orphanSandboxes!.destroyOrphan(sandbox);
            destroyed += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "orphan_sandboxes", message });
            this.options.logger?.warn({ step: "orphan_sandboxes", sandboxId: sandbox.id, message }, "code_reaper_sandbox_destroy_failed");
          }
        }
        cleaned.orphanSandboxes = destroyed;
      });
    }

    // 9. Temp directories: ownership must be provable (an owner run id), and the path must be older than
    //    the TTL. Unowned paths are logged and left in place.
    if (!this.options.tempDirs) skipped.push({ step: "temp_dirs", reason: "port_unavailable" });
    else {
      await step("temp_dirs", async () => {
        const stale = await this.options.tempDirs!.listStale({ olderThanMs: this.tempDirTtlMs, now: this.now() });
        const actionable = stale.filter((entry) => entry.ownerRunId !== undefined && entry.ageMs >= this.tempDirTtlMs);
        const unowned = stale.length - actionable.length;
        if (unowned > 0) {
          this.options.logger?.warn({ step: "temp_dirs", unowned }, "code_reaper_temp_dir_unowned_skipped");
        }
        cleaned.tempDirs = actionable.length;
        if (dryRun) return;
        let removed = 0;
        for (const entry of actionable) {
          try {
            await this.options.tempDirs!.remove(entry.path);
            removed += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "temp_dirs", message });
            this.options.logger?.warn({ step: "temp_dirs", path: entry.path, message }, "code_reaper_temp_dir_remove_failed");
          }
        }
        cleaned.tempDirs = removed;
      });
    }

    // 10. Stale locks: only released when the TTL expired *and* the owner is proven dead. Advisory locks
    //     (migrations) are never released blind — a live migration lock released by the reaper would be
    //     worse than the lock itself.
    if (!this.options.staleLocks) skipped.push({ step: "stale_locks", reason: "port_unavailable" });
    else {
      await step("stale_locks", async () => {
        const stale = await this.options.staleLocks!.listStale({ olderThanMs: this.lockTtlMs, now: this.now() });
        const actionable = stale.filter((lock) => {
          if (lock.advisory === true) return false;
          if (lock.ownerAlive === true) return false;
          return lock.ownerAlive === false && lock.ageMs >= this.lockTtlMs;
        });
        const advisory = stale.filter((lock) => lock.advisory === true).length;
        const alive = stale.filter((lock) => lock.ownerAlive === true).length;
        if (advisory + alive > 0) {
          this.options.logger?.warn({ step: "stale_locks", advisory, alive }, "code_reaper_lock_skipped");
        }
        cleaned.staleLocks = actionable.length;
        if (dryRun) return;
        let released = 0;
        for (const lock of actionable) {
          try {
            const ok = await this.options.staleLocks!.release(lock);
            if (ok) released += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ step: "stale_locks", message });
            this.options.logger?.warn({ step: "stale_locks", key: lock.key, message }, "code_reaper_lock_release_failed");
          }
        }
        cleaned.staleLocks = released;
      });
    }

    // 11. Disk / inode pressure. The reaper does not delete anything on its own account: it only raises
    //     the refusal flag that callers consult before starting a new run.
    if (!this.options.disk) skipped.push({ step: "disk_pressure", reason: "port_unavailable" });
    else {
      await step("disk_pressure", async () => {
        const usage = await this.options.disk!.usage();
        const inodesLow = usage.freeInodes !== undefined && usage.freeInodes < this.diskFreeInodeFloor;
        const bytesLow = usage.freeBytes < this.diskFreeFloorBytes;
        this.refuseNewRuns = bytesLow || inodesLow;
        if (this.refuseNewRuns) {
          this.options.logger?.warn(
            { step: "disk_pressure", freeBytes: usage.freeBytes, freeInodes: usage.freeInodes },
            "code_reaper_disk_pressure",
          );
        }
      });
    }

    // 12. Expired user questions. A run paused on `code.ask_user` is held by a question row with a TTL, so a
    //     question nobody answered must release the run instead of leaving it waiting forever. This is the one
    //     step whose "cleanup" is a deliberate *non*-action on the interesting field: the question becomes
    //     `expired`, the run becomes `interrupted` with reason `ask_user_timeout`, and no answer is written.
    //     Guessing a choice on the user's behalf is exactly what the owner forbade, so a timeout is reported as a
    //     timeout and the run stops where the question was asked.
    if (!this.options.userQuestions) skipped.push({ step: "expire_user_questions", reason: "port_unavailable" });
    else {
      await step("expire_user_questions", async () => {
        const now = this.now();
        if (dryRun) {
          // A real preview: the expired questions are listed, so a dry run reports the count it would release.
          const expired = await this.options.userQuestions!.previewCodeUserQuestions({ now });
          cleaned.expiredUserQuestions = expired.length;
          return;
        }
        cleaned.expiredUserQuestions = await this.options.userQuestions!.expireCodeUserQuestions({ now });
      });
    }

    // 13. R1-C (item 11): data retention. `toolResultRetentionDays`/`transcriptRetentionDays` were configured
    //     and read by nobody, so a run's tool results, turn boundaries, checkpoints, plans, goals, todos,
    //     ledgers and questions were kept forever. The step executes the configuration that already existed:
    //     the windows are derived from those two limits (never restated here), the class comes from the row,
    //     and `until_deleted` is never expired by a clock.
    //
    //     What it deliberately does NOT do: touch `audit_log`/`audit_anchors` (their own 365-day retention is
    //     a separate contract), touch a `projects` row of another type (the shared table is only ever joined
    //     through `code_project`), or claim a purge it did not perform. A family the database forbids deleting
    //     is reported as `retained` with its reason, so "0 purged" and "0 expired" stay distinguishable.
    if (!this.options.dataRetention) skipped.push({ step: "data_retention", reason: "port_unavailable" });
    else if (dryRun) {
      await step("data_retention", async () => {
        const preview = await this.options.dataRetention!.preview({ now: this.now() });
        cleaned.expiredDataRows = preview.expired;
        cleaned.retainedDataRows = preview.retained;
        if (preview.retained > 0) {
          // Counts and reasons only: which family was kept and why, never a row.
          this.options.logger?.warn(
            { step: "data_retention", retained: preview.retained, reasons: preview.retainedReasons },
            "code_reaper_retention_dry_run_retained",
          );
        }
      });
    } else {
      await step("data_retention", async () => {
        // A real pass performs **one** transaction: `apply` returns both what it purged and what it matched but
        // was forbidden to purge, so the step never has to run the sweep twice to report a number.
        const applied = await this.options.dataRetention!.apply({ now: this.now() });
        cleaned.expiredDataRows = applied.purged;
        cleaned.retainedDataRows = applied.retained;
        if (applied.retained > 0) {
          this.options.logger?.warn(
            { step: "data_retention", retained: applied.retained, reasons: applied.retainedReasons },
            "code_reaper_retention_retained",
          );
        }
      });
    }

    const finishedAt = this.now();
    const summary: ReaperSummary = {
      dryRun,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      cleaned,
      skipped,
      errors,
      refuseNewRuns: this.refuseNewRuns,
    };
    this.lastSummary = summary;
    // Metrics/Activity carry counts and reasons only — never file contents, commands or secrets.
    try {
      await this.options.activity?.record({
        kind: "code_reaper",
        dryRun,
        cleaned: { ...cleaned },
        skipped: skipped.map((entry) => ({ ...entry })),
        errors: errors.map((entry) => ({ ...entry })),
        refuseNewRuns: this.refuseNewRuns,
        durationMs: summary.durationMs,
        at: finishedAt,
      });
    } catch (error) {
      // Recording must never change the outcome of the reaper.
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn({ step: "activity", message }, "code_reaper_activity_failed");
    }
    return summary;
  }

  /** Starts the periodic run. Overlapping ticks are skipped, so a slow pass cannot pile up. */
  start(onRun?: (summary: ReaperSummary) => void): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const summary = await this.run();
        if (summary.errors.length > 0 || summary.skipped.length > 0) onRun?.(summary);
      } catch (error) {
        // `run()` already absorbs step failures; this guard covers a defect in the orchestrator itself.
        this.options.logger?.warn({ message: error instanceof Error ? error.message : String(error) }, "code_reaper_failed");
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => { void tick(); }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Structural probe for the approvals bulk expiry.
 *
 * The reaper must not reach into the approvals repository's private pool, so the capability is detected:
 * when the approvals module exposes `expireStaleApprovals` (its owner adds it with its own audit), the
 * port is wired; otherwise the step is reported as `port_unavailable` and stays visible in the metrics.
 */
export interface StaleApprovalReaperPort {
  expireStaleApprovals(input: { now: number }): Promise<number>;
}

interface OptionalStaleApprovalReaper {
  expireStaleApprovals?(input: { now: number }): Promise<number>;
}

export function asStaleApprovalReaper(value: unknown): StaleApprovalReaperPort | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as OptionalStaleApprovalReaper;
  if (typeof candidate.expireStaleApprovals !== "function") return undefined;
  return { expireStaleApprovals: (input) => candidate.expireStaleApprovals!(input) };
}
