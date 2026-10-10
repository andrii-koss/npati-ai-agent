import {
  resolveCodeRetentionWindows,
  type CodeDataLifecycleStore,
  type CodeDataRetentionReport,
  type CodeRetentionWindows,
} from "@npati/workspace";
import type { DataRetentionPortPreview, DataRetentionPortResult } from "./code-reaper";

/**
 * R1-C (item 11) — retention, actually executed.
 *
 * The defect this module closes is small to state and large in effect: `CodeAgentLimits` has declared
 * `toolResultRetentionDays` (30) and `transcriptRetentionDays` (90) since C1, `.env.example` documents both,
 * a test pins the defaults — and **nothing read them**. Grep found three readers, all of them the
 * configuration itself. The consequence was that a run's tool results, turn boundaries, checkpoints, plans,
 * goals, todos, rewind/fork ledgers and questions were kept forever, and the only retention that existed in
 * the whole Coding Agent was the sandbox idle sweep.
 *
 * This module is the missing reader. Three decisions shape it:
 *
 *  1. **The windows are derived, not restated.** `resolveCodeRetentionWindows` (packages/workspace) turns the
 *     two configured limits into the four windows the store's SQL uses. Nothing here invents a number, and
 *     `until_deleted` is not in the table at all: a row that says "keep until the user asks" is never expired
 *     by a clock, only by the explicit erasure of `code-session-erasure.ts`.
 *  2. **The class comes from the row**, not from the caller. The store compares each row's own
 *     `retention_class` against those windows, so raising a session's class really postpones its rows and no
 *     caller can decide that another tenant's data is due.
 *  3. **A missing capability is reported, never assumed.** No data-lifecycle backend means the reaper's step
 *     becomes `skipped: port_unavailable`, and a caller asking for the port gets `undefined` — there is no
 *     "pretend it worked" branch, because the failure mode of a silent retention is the defect being fixed.
 *
 * The `audit_log`/`audit_anchors` journal is **not** part of this contract and must not be: it has its own
 * 365-day retention (`NPATI_AUDIT_RETENTION_DAYS`, `audit-config.ts`) and its own append-only guarantees.
 * `tests/coding-agent-r1c-data-retention.test.ts` pins that the retention port cannot name it at all.
 */

/** The names the retention SQL is allowed to reach. Exported so a suite can pin the closed set. */
export const RETENTION_FAMILY_TABLES: readonly string[] = [
  "code_process_projects",
  "code_session_inboxes",
  "code_run_turns",
  "project_checkpoints",
  "code_run_states",
  "code_session_plans",
  "code_goals",
  "code_session_todos",
  "code_session_rewinds",
  "code_session_forks",
  "code_user_questions",
  "code_session_heads",
] as const;

/**
 * Tables retention may never touch. The list exists so the boundary is a fact a suite can assert rather than a
 * promise in a comment: the audit journal is a separate retention contract, and the append-only evidence
 * tables are refused by the database itself.
 */
export const RETENTION_FORBIDDEN_TABLES: readonly string[] = [
  "audit_log",
  "audit_anchors",
  "execution_snapshots",
  "code_replay_bundles",
  "code_replay_bundle_steps",
  "code_context_summaries",
  "code_run_recovery_notices",
  "code_activity_events",
] as const;

export interface CodeDataRetentionDeps {
  /** The store's optional data-lifecycle port. `undefined` in a backend that cannot delete code data. */
  lifecycle?: CodeDataLifecycleStore;
  /** The two existing limits. Nothing else is read here. */
  limits: { toolResultRetentionDays: number; transcriptRetentionDays: number };
}

export class CodeDataRetention {
  private readonly lifecycle?: CodeDataLifecycleStore;
  readonly windows: CodeRetentionWindows;

  constructor(deps: CodeDataRetentionDeps) {
    this.lifecycle = deps.lifecycle;
    this.windows = resolveCodeRetentionWindows(deps.limits);
  }

  /** True when this deployment can really expire rows. The reaper reports the step as skipped otherwise. */
  get available(): boolean {
    return this.lifecycle !== undefined;
  }

  /** The counts a reaper dry run reports, measured by the real rule (never a guess). */
  async preview(input: { now: number }): Promise<DataRetentionPortPreview> {
    const report = await this.sweep({ now: input.now, dryRun: true });
    return { expired: report.expired, retained: report.retained, retainedReasons: reasonsOf(report) };
  }

  /**
   * The real pass. It returns what it matched (`expired`), what it deleted (`purged`) and what it was
   * forbidden to delete (`retained`), so the reaper's `cleaned` counters can distinguish a purge from a
   * refusal without reading a log line.
   */
  async apply(input: { now: number }): Promise<DataRetentionPortResult> {
    const report = await this.sweep({ now: input.now, dryRun: false });
    return {
      expired: report.expired,
      purged: report.purged,
      retained: report.retained,
      retainedReasons: reasonsOf(report),
    };
  }

  /** One sweep of the whole deployment. Throws when no backend is configured: a caller must know. */
  private async sweep(input: { now: number; dryRun: boolean }): Promise<CodeDataRetentionReport> {
    if (!this.lifecycle) throw new Error("code_data_lifecycle_unavailable");
    return this.lifecycle.planCodeDataRetention({
      // No `companyId`: retention is a system sweep across every Company, and the statement's own tenant
      // predicate is what keeps it from being a way to reach one tenant from another.
      windows: this.windows,
      now: new Date(input.now),
      dryRun: input.dryRun,
    });
  }
}

/** The distinct reasons a sweep reports for the rows it kept. Codes only — never a table's content. */
function reasonsOf(report: CodeDataRetentionReport): string[] {
  const reasons = new Set<string>();
  for (const family of report.families) {
    if (family.retained > 0 && family.retainedReason) reasons.add(family.retainedReason);
  }
  return [...reasons].sort();
}
