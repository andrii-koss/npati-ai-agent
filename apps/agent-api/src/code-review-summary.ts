import type {
  CodingAgentSelfReviewFinding,
  CodingAgentSelfReviewSummary,
  CodingAgentVerificationSummary,
} from "./coding-agent-runner-contracts";
import type { SelfReviewFinding, SelfReviewVerdict } from "./code-self-review-types";
import type { VerificationReport } from "./code-verification-loop";
import type { VerificationPlan } from "./code-verification-plan";

/**
 * Step 4 — the two summary builders.
 *
 * They are pure projections of a verdict/report into the persisted run summary. Extracted from the coordinator so the
 * summary shape can be tested without a runner and so the coordinator stays under the repository's file-size guard;
 * no decision moved here — every value is passed in by the caller that made the decision.
 */

export function toSelfReviewFindingSummary(finding: SelfReviewFinding): CodingAgentSelfReviewFinding {
  return {
    id: finding.id,
    category: finding.category,
    severity: finding.severity,
    file: finding.file,
    reason: finding.reason,
    suggestedFix: finding.suggested_fix,
    blocking: finding.blocking,
  };
}

export interface VerificationSummaryInput {
  report: VerificationReport;
  plan: VerificationPlan | null;
  reused: boolean;
  /** How many recorded runs were replays of a cached result (they are not executions). */
  reuses: number;
  integrity: {
    flagged: boolean;
    requiresJustification: boolean;
    findings: Array<{ path: string; kind: string; detail: string }>;
    testFilesTouched: string[];
    testFilesDeleted: string[];
  } | null;
}

export function buildVerificationSummary(input: VerificationSummaryInput): CodingAgentVerificationSummary {
  const { report, plan, integrity } = input;
  const unjustified = integrity?.requiresJustification === true && report.status === "passed";
  return {
    schemaVersion: report.schemaVersion,
    status: unjustified ? "passed_with_unjustified_test_changes" : report.status,
    attemptsUsed: report.attemptsUsed,
    maxAttempts: report.maxAttempts,
    /** Real executions: a replayed cached result is recorded for the decision but is not a run of the checks. */
    verificationRuns: Math.max(0, report.verificationRuns - input.reuses),
    requestedTools: [...report.requestedTools],
    /**
     * Step 2: what actually ran. `requestedTools` stays the run's configured list (the Live Preview gate reads it
     * and `build` is never dropped), while these two fields state the executed subset and what was skipped.
     */
    ...(plan ? {
      executedTools: [...plan.tools],
      skippedChecks: plan.skipped.map((entry) => ({ tool: entry.tool, reason: entry.reason })),
      reused: input.reused,
    } : {}),
    failedChecks: report.failedChecks.map((check) => ({ tool: check.tool, ...(check.code ? { code: check.code } : {}) })),
    ...(integrity ? {
      testIntegrity: {
        flagged: integrity.flagged,
        requiresJustification: integrity.requiresJustification,
        justificationProvided: false,
        findings: integrity.findings.map((finding) => ({ path: finding.path, kind: finding.kind, detail: finding.detail })),
        testFilesTouched: [...integrity.testFilesTouched],
        testFilesDeleted: [...integrity.testFilesDeleted],
      },
    } : {}),
  };
}

export interface SelfReviewSummaryInput {
  verdict: SelfReviewVerdict;
  risk: "low" | "elevated" | "high" | null;
}

export function buildSelfReviewSummary(input: SelfReviewSummaryInput): CodingAgentSelfReviewSummary {
  const { verdict, risk } = input;
  return {
    schemaVersion: verdict.schemaVersion,
    status: verdict.status,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.detail ? { detail: verdict.detail } : {}),
    ...(risk ? { risk } : {}),
    ...(verdict.reason === "adaptive_low_risk_skip" ? { adaptiveSkip: true } : {}),
    ran: verdict.ran,
    reviewRuns: verdict.reviewRuns,
    iterationsUsed: verdict.iterationsUsed,
    maxIterations: verdict.maxIterations,
    fixApplied: verdict.fixApplied,
    findingsCount: verdict.findings.length,
    blocking: verdict.blocking,
    unresolved: verdict.unresolved.length,
    findings: verdict.findings.map(toSelfReviewFindingSummary),
    inputs: verdict.inputs,
    reviewHash: verdict.reviewHash,
  };
}
