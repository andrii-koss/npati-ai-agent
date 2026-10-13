import type { ChatMessage } from "@npati/omniroute-adapter";

/** Versioned vocabulary of the self-review verdict (rule 13). */
export const SELF_REVIEW_SCHEMA_VERSION = 1;

/**
 * How many fix iterations may follow one self-review. One, and it is a constant rather than a limit table
 * entry: an "at most one" rule that configuration can raise is a rule that a deployment can lose.
 */
export const CODE_SELF_REVIEW_MAX_FIX_ITERATIONS = 1;

export type SelfReviewStatus =
  /** The pass ran and found nothing. The only status an empty `findings` list can produce. */
  | "clean"
  /** The pass ran and reported findings; nothing has been fixed yet. */
  | "findings"
  /** A fix iteration ran after the review. What remains is decided by `unresolved`. */
  | "repaired"
  /** Findings remain that nobody fixed. Never rendered as a clean run. */
  | "unresolved"
  /** The pass never ran (nothing to review, or the operator limited it to zero). Says why in `reason`. */
  | "not_run"
  /** The pass was attempted and could not be completed. Says why in `reason`; never a pass. */
  | "unavailable";

export type SelfReviewFindingCategory =
  | "correctness"
  | "security"
  | "scope"
  | "missing_tests"
  | "test_weakening"
  | "style";

export const SELF_REVIEW_FINDING_CATEGORIES: readonly SelfReviewFindingCategory[] = [
  "correctness",
  "security",
  "scope",
  "missing_tests",
  "test_weakening",
  "style",
];

export type SelfReviewSeverity = "blocking" | "major" | "minor";

export const SELF_REVIEW_SEVERITIES: readonly SelfReviewSeverity[] = ["blocking", "major", "minor"];

/** Exactly the six inputs the owner named, each as a separate labelled block. */
export interface SelfReviewInput {
  /** 1. The original request, verbatim. */
  originalGoal: string;
  /** 2. The approved plan, rendered. `null` when the run had none — stated as such, never invented. */
  approvedPlan: string | null;
  /** 3. The final diff. Already bounded by the caller; this module never reads a file. */
  finalDiff: string;
  /** 4. The changed files, as paths plus the tool that touched them. */
  changedFiles: ReadonlyArray<{ path: string; tool: string; status?: string }>;
  /** 5. The verification outcome, as text. */
  verification: string;
  /** 6. The test-integrity outcome, as text. */
  testIntegrity: string;
}

export interface SelfReviewFinding {
  /** `R-<n>`, stable within one verdict and derived from the model's order, never invented here. */
  id: string;
  category: SelfReviewFindingCategory;
  severity: SelfReviewSeverity;
  /** The path the finding is about. `null` when the review named a mainline file or no file at all. */
  file: string | null;
  /** Why it is a finding. Bounded, and treated as data everywhere it goes. */
  reason: string;
  /** What to do about it. `null` when the review offered nothing; the repair path then says so. */
  suggested_fix: string | null;
  /** True for anything that must be fixed before the run may call itself complete. */
  blocking: boolean;
}

/** Why a verdict is `not_run`/`unavailable`, in the closed vocabulary the summary and tests use. */
export type SelfReviewReason =
  | "no_changes_to_review"
  | "disabled_by_configuration"
  | "review_parser_unavailable"
  | "review_response_empty"
  | "review_call_failed"
  | "review_prompt_refused_by_provider_policy"
  | "review_response_mismatch";

export interface SelfReviewVerdict {
  schemaVersion: typeof SELF_REVIEW_SCHEMA_VERSION;
  status: SelfReviewStatus;
  reason?: SelfReviewReason;
  /** A bounded, non-content explanation of `reason`. Never carries diff or file text. */
  detail?: string;
  /** The pass ran at all (`clean`/`findings`/`repaired`/`unresolved`). `false` for `not_run`/`unavailable`. */
  ran: boolean;
  findings: SelfReviewFinding[];
  blocking: number;
  /** Findings that a human still has to decide about. Empty exactly when nothing is outstanding. */
  unresolved: SelfReviewFinding[];
  /** Fix iterations spent after the review: 0 or 1. */
  iterationsUsed: number;
  /** The hard cap from `CODE_SELF_REVIEW_MAX_FIX_ITERATIONS`. Persisted so "one" is provable after the fact. */
  maxIterations: number;
  /** True when a fix iteration was applied. Makes "was the second verify required?" answerable from the report. */
  fixApplied: boolean;
  /** `sha256:<…>` of the exact review request this verdict belongs to. */
  reviewHash: string;
  /**
   * The five inputs that were supplied. `approvedPlan: false` is the honest record of a run that had no plan:
   * a reviewer without the plan must not be described as having checked against one.
   */
  inputs: {
    originalGoal: boolean;
    approvedPlan: boolean;
    finalDiff: boolean;
    changedFiles: number;
    verification: boolean;
    testIntegrity: boolean;
  };
  /** Findings the review proposed that were refused by the schema and therefore discarded. */
  rejectedFindings: number;
  /** How many times the review was actually requested of the model. 0 or 1, ever. */
  reviewRuns: number;
}

/**
 * The persisted, metadata-only shape. It is a **subset** by construction: `findings` here carry no reason
 * text, because the run state is a metadata record and a reviewer's prose can quote file content. The full
 * findings stay on the run result (and in the model's conversation), where they are conversation rather than
 * a durable record.
 */
export interface SelfReviewPersisted {
  schemaVersion: number;
  status: SelfReviewStatus;
  ran: boolean;
  reason?: SelfReviewReason;
  reviewRuns: number;
  iterationsUsed: number;
  maxIterations: number;
  fixApplied: boolean;
  blocking: number;
  unresolved: number;
  findings: Array<{ id: string; category: SelfReviewFindingCategory; severity: SelfReviewSeverity; file: string | null; blocking: boolean }>;
  inputs: SelfReviewVerdict["inputs"];
  reviewHash: string;
}

/** Request the model is asked to answer. It is one `chat` call with no tools, exactly like a verification-free turn. */
export interface SelfReviewRequest {
  messages: ChatMessage[];
  idempotencyKey: string;
  reviewHash: string;
  /** The exact text of the user message, so the guard and the tests can assert what travels to the provider. */
  promptText: string;
}

export type SelfReviewChatResult = { ok: true; content: string } | { ok: false; code: string; message?: string };

export interface SelfReviewExecuteInput {
  /**
   * The six sources. They may be supplied here instead of (or as well as) at construction, which lets a caller
   * that only has the diff late — the runner, whose change set is complete after verification — build the
   * state early and the request late.
   */
  input?: Partial<SelfReviewInput>;
  reviewRequest: SelfReviewRequest;
  chat: (request: SelfReviewRequest) => Promise<SelfReviewChatResult>;
  /** Runs the composed prompt through the existing C5b guard. A rejection fails the pass as unavailable. */
  guardPrompt?: (promptText: string) => Promise<void>;
  /** Model profile used for the review call. Recorded for traceability; the caller resolves it. */
  profileId?: string;
}

export interface SelfReviewState {
  /** The request to send. Always available, even when the pass will not run, so the caller can hash it. */
  request(): SelfReviewRequest;
  /**
   * Runs the pass **once** and finalizes the verdict. The second call returns the first verdict unchanged —
  * this is what makes "exactly one self-review per run" a property of the module.
   */
  execute(input: SelfReviewExecuteInput): Promise<SelfReviewVerdict>;
  report(): SelfReviewVerdict;
  /** The verdict without running anything: used on paths that never reached the review. */
  finalize(): SelfReviewVerdict;
  /** True while a fix iteration is still available for the current verdict. Never true twice. */
  canApplyFix(): boolean;
  /**
   * Consumes the single fix iteration. Returns the instruction for the model, or `null` when there is nothing
   * to fix or the iteration was already used. Calling it a second time is a no-op by construction.
   */
  applyFix(): string | null;
  /** Records that the fix iteration did or did not change the change set. */
  noteFixOutcome(changedCode: boolean): void;
}

// ---------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------

/**
 * Clamps the configured fix-iteration budget to the hard cap. A number above 1 is **reduced**, not honoured:
 * "at most one fix iteration" is the owner's requirement, so a misconfiguration loses to the requirement.
 */
export function resolveSelfReviewFixIterations(configured?: number | null): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return CODE_SELF_REVIEW_MAX_FIX_ITERATIONS;
  const floored = Math.floor(configured);
  if (floored < 0) return 0;
  return Math.min(floored, CODE_SELF_REVIEW_MAX_FIX_ITERATIONS);
}

/** Reads `NPATI_CODE_SELF_REVIEW_FIX_ITERATIONS`. Anything unusable falls back to the hard cap. */
export function selfReviewFixIterationsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NPATI_CODE_SELF_REVIEW_FIX_ITERATIONS;
  if (raw === undefined || raw === "") return CODE_SELF_REVIEW_MAX_FIX_ITERATIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return CODE_SELF_REVIEW_MAX_FIX_ITERATIONS;
  return resolveSelfReviewFixIterations(parsed);
}
