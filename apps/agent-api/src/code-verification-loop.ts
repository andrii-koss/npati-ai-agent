/**
 * C9: the verification/repair loop.
 *
 * C6 ends a run when the model stops asking for tools. That says nothing about whether the change works, so
 * a run could report success over code that does not compile. C9 adds the missing step: after the change,
 * verify; if verification fails, tell the model exactly what failed and let it try again — a bounded number
 * of times, after which the run **stops and says so** rather than continuing to spend budget on a loop that
 * is not converging.
 *
 * Three deliberate properties.
 *
 * 1. The limit is configuration, not a magic number: `NPATI_CODE_REPAIR_LOOP` existed since C1 and nothing
 *    read it. This module is what makes it real, so "how many attempts" is answerable from the environment.
 * 2. Exhaustion is a **stop**, not a success: the caller gets `verification_failed_after_repair_limit` with
 *    the list of checks that never passed. A run that ends here must not be presented as finished work.
 * 3. The state is a pure object. Nothing here reads a clock, a store or a model, so the decision "repair or
 *    stop" is reproducible and testable without a runner — and it cannot accidentally become a second,
 *    invisible loop.
 *
 * This is deliberately **not** the same loop as `MAX_ARGUMENT_CORRECTIONS`: that one corrects malformed tool
 * arguments inside a single turn and is bounded separately. Mixing them would let a model that sends broken
 * JSON burn the repair budget, and a failing build look like a malformed call.
 */

/** The run stopped because verification never passed within the repair budget. */
export const VERIFICATION_REPAIR_EXHAUSTED = "verification_failed_after_repair_limit";
/** Verification needs a human decision (an approval-gated check); the loop must not work around it. */
export const VERIFICATION_APPROVAL_REQUIRED = "verification_approval_required";
/** No verification could be run at all (no runner, no configured commands). Not a failure of the change. */
export const VERIFICATION_UNAVAILABLE = "verification_unavailable";

/** Versioned vocabulary of the persisted verification report (rule 13). */
export const VERIFICATION_REPORT_SCHEMA_VERSION = 1;

export type VerificationCheckState = "passed" | "failed" | "approval_required" | "unavailable";

export interface VerificationCheckReport {
  /** The requested verification kind: lint, typecheck, test or build. */
  tool: string;
  state: VerificationCheckState;
  /** Machine-readable failure code, never raw output. */
  code?: string;
  /** Bounded, human-readable reason. Bounded on purpose: a summary is not an output dump. */
  message?: string;
}

export type VerificationStatus = "not_run" | "passed" | "failed" | "approval_required" | "unavailable";

export interface VerificationReport {
  schemaVersion: typeof VERIFICATION_REPORT_SCHEMA_VERSION;
  status: VerificationStatus;
  /** How many repair rounds have been requested. */
  attemptsUsed: number;
  maxAttempts: number;
  /** How many times verification actually ran. */
  verificationRuns: number;
  requestedTools: string[];
  checks: VerificationCheckReport[];
  /** The checks that did not pass, in the order they were reported. */
  failedChecks: VerificationCheckReport[];
}

export type VerificationDecision =
  | { decision: "complete"; status: "passed" }
  | { decision: "repair"; attempt: number; maxAttempts: number }
  | { decision: "stop"; code: string; status: Exclude<VerificationStatus, "not_run" | "passed"> };

export interface VerificationLoop {
  /** Records the outcome of one verification run. Does not increment the repair counter. */
  record(checks: readonly VerificationCheckReport[]): VerificationReport;
  /**
   * Decides what happens next. When it returns `repair`, one repair attempt is consumed — calling `decide`
   * twice without recording a new result therefore cannot double-spend the budget.
   */
  decide(): VerificationDecision;
  report(): VerificationReport;
  status(): VerificationStatus;
  attemptsUsed(): number;
  /**
   * C9 (requirement 4): closes the repair budget for the rest of the run.
   *
   * The post-review re-verification is not a repair round, so it must not be able to open one: without this, a
   * failing re-check would ask for a repair, the repair would produce another "model stopped calling tools"
   * turn, and the run would have bought itself extra rounds through the review path. After this call `decide()`
   * still reports the honest status of the checks — it simply never asks for another repair.
   */
  blockFurtherRepairs(): void;
}

export interface VerificationLoopOptions {
  /** Number of repair rounds allowed after a failed verification (the C1 `repairLoopAttempts` limit). */
  maxRepairAttempts: number;
  /** The verification kinds requested for this run. */
  requestedTools: readonly string[];
}

const MESSAGE_LIMIT = 400;

function bound(message: string | undefined): string | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MESSAGE_LIMIT ? `${trimmed.slice(0, MESSAGE_LIMIT - 1)}…` : trimmed;
}

function toCheck(tool: string, raw: { state?: unknown; code?: unknown; message?: unknown }): VerificationCheckReport {
  const state: VerificationCheckState = raw.state === "passed" || raw.state === "approval_required" || raw.state === "unavailable"
    ? raw.state
    : "failed";
  return {
    tool,
    state,
    ...(typeof raw.code === "string" && raw.code ? { code: raw.code } : {}),
    ...(bound(typeof raw.message === "string" ? raw.message : undefined) ? { message: bound(raw.message as string)! } : {}),
  };
}

/** Aggregates individual check results into the loop's overall status. */
export function summariseVerification(checks: readonly VerificationCheckReport[]): VerificationStatus {
  if (!checks.length) return "unavailable";
  if (checks.some((check) => check.state === "failed")) return "failed";
  if (checks.some((check) => check.state === "approval_required")) return "approval_required";
  if (checks.every((check) => check.state === "unavailable")) return "unavailable";
  if (checks.some((check) => check.state === "unavailable")) {
    // A partial run of the checks is not a pass: something asked for never ran.
    return "failed";
  }
  return "passed";
}

/**
 * Creates the loop's state machine. The caller records check outcomes and asks for a decision; every decision
 * is derived from what was recorded, so the loop cannot "remember" a pass that did not happen.
 */
export function createVerificationLoop(options: VerificationLoopOptions): VerificationLoop {
  const maxAttempts = Math.max(0, Math.floor(options.maxRepairAttempts));
  const requestedTools = [...options.requestedTools];
  let attemptsUsed = 0;
  let verificationRuns = 0;
  let checks: VerificationCheckReport[] = [];
  let status: VerificationStatus = "not_run";
  let consumedForCurrentFailure = false;
  /**
   * Set once the run has passed the point where a repair round is still meaningful (the post-review
   * re-verification). It is one-way: nothing re-opens the budget, which is what stops the review path from
   * becoming a second, invisible repair loop.
   */
  let repairsBlocked = false;

  const report = (): VerificationReport => ({
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    status,
    attemptsUsed,
    maxAttempts,
    verificationRuns,
    requestedTools,
    checks: checks.map((check) => ({ ...check })),
    failedChecks: checks.filter((check) => check.state !== "passed").map((check) => ({ ...check })),
  });

  return {
    record(input) {
      checks = (input ?? []).map((check) => toCheck(check.tool, check));
      status = summariseVerification(checks);
      verificationRuns += 1;
      consumedForCurrentFailure = false;
      return report();
    },
    decide(): VerificationDecision {
      if (status === "passed") return { decision: "complete", status: "passed" };
      if (status === "not_run") {
        // Nothing was verified and nothing was recorded: the honest answer is that verification did not
        // happen, and a caller that asked for it must treat that as unavailable rather than as a pass.
        return { decision: "stop", code: VERIFICATION_UNAVAILABLE, status: "unavailable" };
      }
      if (status === "approval_required") {
        return { decision: "stop", code: VERIFICATION_APPROVAL_REQUIRED, status: "approval_required" };
      }
      if (status === "unavailable") {
        return { decision: "stop", code: VERIFICATION_UNAVAILABLE, status: "unavailable" };
      }
      if (consumedForCurrentFailure) {
        // The budget was already spent for this failure; ask for the stop rather than spending it twice.
        return { decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED, status: "failed" };
      }
      if (repairsBlocked) {
        // The repair budget is closed for the rest of the run (see the interface comment). The failure is still
        // reported as a failure; it simply can no longer buy a repair round.
        return { decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED, status: "failed" };
      }
      if (attemptsUsed >= maxAttempts) {
        return { decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED, status: "failed" };
      }
      attemptsUsed += 1;
      consumedForCurrentFailure = true;
      return { decision: "repair", attempt: attemptsUsed, maxAttempts };
    },
    report,
    status: () => status,
    attemptsUsed: () => attemptsUsed,
    blockFurtherRepairs() {
      repairsBlocked = true;
    },
  };
}

/**
 * The repair instruction handed back to the model.
 *
 * It names the failing checks and their codes — enough to act on — and it states the two things the model is
 * not allowed to do: weaken the tests, or claim a pass it does not have. The text is fixed apart from the
 * check list, so it can be recorded and replayed without carrying output into a persisted format.
 */
export function formatRepairInstruction(report: VerificationReport): string {
  const failed = report.failedChecks;
  const lines = failed.length
    ? failed.map((check) => `- ${check.tool}: ${check.code ?? "failed"}${check.message ? ` — ${check.message}` : ""}`)
    : ["- verification did not run"];
  return [
    `Verification failed (repair attempt ${report.attemptsUsed} of ${report.maxAttempts}).`,
    "Failing checks:",
    ...lines,
    "Fix the cause of the failure. Do not delete, skip or weaken a test to make the check pass, and do not",
    "report success while a check is failing; if a test change is genuinely required, say why in your summary.",
  ].join("\n");
}

/** Canonical executor transport success is not proof that the requested checks passed. */
export function verificationChecks(outcome: import("./code-tool-runtime").CodeToolInvokeResult | import("./code-tool-runtime").CodeToolInvokeFailure, requested: readonly string[]): VerificationCheckReport[] {
  if(!outcome.ok)return requested.map(tool=>({tool,state:outcome.error.code==="approval_required"?"approval_required":outcome.error.code==="tool_not_configured"||outcome.error.code==="feature_disabled"?"unavailable":"failed",code:String(outcome.error.code),message:outcome.error.message}));
  const object=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"?value as Record<string,unknown>:{};
  const root=object(outcome.result);const payload=object(root.data??root.result??root);
  const reports=Array.isArray(payload.checks)?payload.checks:Array.isArray(payload.results)?payload.results:[];
  return requested.map(tool=>{const value=reports.map(object).find(row=>(row.tool??row.name)===tool);
    if(!value)return {tool,state:"unavailable",code:"verification_result_missing"};
    const passed=value.ok===true||value.passed===true||value.state==="passed"||value.status==="passed";
    return {tool,state:passed?"passed":value.state==="unavailable"?"unavailable":value.state==="approval_required"?"approval_required":"failed",...(typeof value.code==="string"?{code:value.code}:{})};});
}
