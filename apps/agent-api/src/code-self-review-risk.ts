import { classifyVerificationChange, type VerificationChangeKind } from "./code-verification-plan";

/**
 * Step 4 — whether this change still needs the separate LLM self-review.
 *
 * The review is not a linter: it reads the goal, the diff, the verification result and the test-integrity result and
 * reports findings. Verification has already passed when this decision is taken, so the question is only whether a
 * **second, model-based opinion** adds enough for this change class to justify another LLM round trip.
 *
 * The rule is deliberately narrow. Historical runs in the local corpus (152 runs with a self-review summary,
 * reconstructed changed paths from the replay ledger) produced blocking findings in 4 runs, **all of them in runs
 * that touched source files**; the 20 style-only runs produced 2 non-blocking findings and no blocking one. That is
 * enough to allow skipping for presentation-only changes and not enough to allow it anywhere else — so:
 *
 * - only stylesheets and assets can be skipped;
 * - the verification must have passed, no repair may have happened, test integrity must be clean and the scope guard
 *   must not have been exceeded;
 * - the change must be small (a size guard, never the criterion) and contain no security-sensitive path.
 *
 * Line count is intentionally **not** a risk criterion on its own: a one-line change to an auth check is `high`, and
 * the tests pin that. Everything except a clean presentation-only change runs the review exactly as before.
 */

export type SelfReviewRisk = "low" | "elevated" | "high";

export interface SelfReviewRiskFile {
  path: string;
  status?: string;
  diff?: string;
}

export interface SelfReviewRiskInput {
  changedFiles: readonly SelfReviewRiskFile[];
  /** The verification verdict this review would be based on. Only `passed` can ever lead to a skip. */
  verificationStatus: "passed" | "failed" | "not_run";
  /** True when verification failed at least once in this run and a repair round happened. */
  hadRepair: boolean;
  testIntegrity?: { flagged: boolean; requiresJustification: boolean } | null;
  scopeExceeded?: boolean;
  totalLinesChanged?: number;
  /**
   * A presentation-only change of an existing site is verified by the system's own Live Preview compilation after the
   * run (style preview), not by a verification tool inside it. For such a change that check counts as the passed
   * verification; it never applies to source, test, dependency or sensitive files.
   */
  previewVerifies?: boolean;
  /** Operator switch; `false` forces the previous behaviour (every change is reviewed). */
  adaptiveEnabled?: boolean;
  maxFiles?: number;
  maxDiffChars?: number;
}

export interface SelfReviewRiskDecision {
  decision: "run" | "skip";
  risk: SelfReviewRisk;
  /** Machine-readable: `presentation_only_verified` for a skip, `risk_<level>` otherwise. */
  reason: string;
  /** Facts that produced the decision, safe to persist (paths are already stored by the run). */
  signals: string[];
}

/** Defaults are part of the contract: a change above either bound is reviewed. */
export const SELF_REVIEW_ADAPTIVE_MAX_FILES = 3;
export const SELF_REVIEW_ADAPTIVE_MAX_DIFF_CHARS = 20_000;

const PRESENTATION_KINDS: readonly VerificationChangeKind[] = ["style", "asset"];

/**
 * Paths whose one-line change can change authority, credentials or data shape. Matched on path segments, so
 * `keyboard.tsx` is not a "key" file and `src/keys.ts` is.
 */
const SENSITIVE_SEGMENT = /(^|[/_.-])(auth|authn|authz|login|logout|session|sessions|permission|permissions|rbac|policy|policies|secret|secrets|credential|credentials|crypto|cipher|jwt|oauth|sso|token|tokens|key|keys)([/_.-]|$)/i;
const SENSITIVE_FILE = /(^|\/)(\.env[^/]*|dockerfile[^/]*|docker-compose[^/]*|package\.json|.*\.lock|.*\.pem|.*\.key|.*\.crt)$/i;
const SENSITIVE_DIR = /(^|\/)(migrations?|prisma|\.github\/workflows?|terraform|k8s|helm)(\/|$)/i;

export function isSecuritySensitivePath(path: string): boolean {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  if (!normalized.trim()) return false;
  return SENSITIVE_SEGMENT.test(normalized) || SENSITIVE_FILE.test(normalized) || SENSITIVE_DIR.test(normalized);
}

function diffChars(files: readonly SelfReviewRiskFile[]): number {
  let total = 0;
  for (const file of files) total += (file.diff ?? "").length;
  return total;
}

/**
 * Decides whether to run the self-review for this change set. Pure: the coordinator passes what it already knows and
 * the decision is reproducible from it.
 */
export function decideSelfReview(input: SelfReviewRiskInput): SelfReviewRiskDecision {
  const files = [...input.changedFiles];
  const kinds = files.map((file) => classifyVerificationChange(file.path));
  const signals: string[] = [];

  if (!files.length) {
    return { decision: "run", risk: "low", reason: "no_changes", signals: ["no_changed_files"] };
  }

  const sensitive = files.filter((file) => isSecuritySensitivePath(file.path)).map((file) => file.path);
  const dependency = kinds.filter((kind) => kind === "dependency").length;
  const tests = kinds.filter((kind) => kind === "test").length;
  const sources = kinds.filter((kind) => kind === "source" || kind === "unknown").length;
  const presentation = kinds.filter((kind) => PRESENTATION_KINDS.includes(kind)).length;
  const lines = Math.max(0, Math.floor(input.totalLinesChanged ?? 0));
  const chars = diffChars(files);
  const maxFiles = Math.max(1, Math.floor(input.maxFiles ?? SELF_REVIEW_ADAPTIVE_MAX_FILES));
  const maxDiffChars = Math.max(1, Math.floor(input.maxDiffChars ?? SELF_REVIEW_ADAPTIVE_MAX_DIFF_CHARS));

  if (sensitive.length) signals.push(`security_sensitive:${sensitive.length}`);
  if (dependency) signals.push(`dependency_change:${dependency}`);
  if (tests) signals.push(`test_files:${tests}`);
  if (sources) signals.push(`source_files:${sources}`);
  if (input.hadRepair) signals.push("verification_repair");
  if (input.testIntegrity?.flagged) signals.push("test_integrity_flagged");
  if (input.testIntegrity?.requiresJustification) signals.push("test_integrity_unjustified");
  if (input.scopeExceeded) signals.push("scope_guard_exceeded");
  if (files.length > maxFiles) signals.push(`many_files:${files.length}`);
  if (lines >= 300) signals.push(`many_lines:${lines}`);
  if (chars > maxDiffChars) signals.push(`large_diff:${chars}`);

  const risk: SelfReviewRisk = sensitive.length || dependency || input.scopeExceeded || files.length > maxFiles || lines >= 300
    ? "high"
    : sources || tests || input.hadRepair || input.testIntegrity?.flagged || input.testIntegrity?.requiresJustification
      ? "elevated"
      : "low";

  const skippable = input.adaptiveEnabled !== false
    && risk === "low"
    && (input.verificationStatus === "passed" || (input.previewVerifies === true && input.verificationStatus === "not_run"))
    && !input.hadRepair
    && !input.testIntegrity?.flagged
    && !input.testIntegrity?.requiresJustification
    && !input.scopeExceeded
    && files.length <= maxFiles
    && chars <= maxDiffChars
    && presentation === files.length;

  if (skippable) {
    return { decision: "skip", risk, reason: "presentation_only_verified", signals: [...signals, "presentation_only"] };
  }
  if (input.verificationStatus !== "passed") signals.push(`verification_${input.verificationStatus}`);
  return { decision: "run", risk, reason: `risk_${risk}`, signals };
}
