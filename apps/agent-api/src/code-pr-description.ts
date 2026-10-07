/**
 * C11 (owner decision 11) — the pull-request description, generated from the run's own summary.
 *
 * There is deliberately **no second summary format**. `CodingAgentRunSummary` is the single record a run
 * produces (`filesChanged`, `diffStats`, `checksRun`, `turns`, `toolCalls`, `verification`, `scope`,
 * `selfReview`), it is already persisted with the run and already rendered to the user, and a pull-request
 * body built from a different shape would eventually describe a different run than the one the user saw.
 *
 * The four sections are the owner's, and each maps onto fields the summary really carries:
 *
 *  - **what changed** — `filesChanged`, `diffStats`, `turns`, `toolCalls`;
 *  - **verification** — `checksRun`, `verification.status`/`attemptsUsed`/`failedChecks`, and the
 *    test-integrity caveat that turns a "passed" into `passed_with_unjustified_test_changes`;
 *  - **risks** — `scope` (unrelated or excessive change set) and the self-review's non-blocking findings;
 *  - **unresolved items** — the self-review's blocking findings that survived the fix iteration, plus the
 *    run's own `remaining` reason.
 *
 * A field that is absent is *said to be absent*. "No verification was recorded" is a different statement
 * from "verification passed", and a reviewer who reads the first will not approve on the strength of it.
 */

import type { CodingAgentRunSummary } from "./coding-agent-runner";

export const PR_DESCRIPTION_SCHEMA_VERSION = 1;

export interface PullRequestDescription {
  schemaVersion: number;
  title: string;
  body: string;
  /** The sections as data, so a caller can render them without re-parsing the markdown. */
  sections: {
    whatChanged: string[];
    verification: string[];
    risks: string[];
    unresolved: string[];
  };
  /** True when the summary carried no verification at all, so nothing here can be read as a pass. */
  verificationMissing: boolean;
}

/** A short branch-safe title: the goal if the caller has one, else the change set. */
function titleFor(input: { summary: CodingAgentRunSummary; title?: string }): string {
  const explicit = String(input.title ?? "").trim();
  if (explicit) return explicit.slice(0, 300);
  const files = input.summary.filesChanged ?? [];
  if (files.length === 0) return "Coding agent run (no file changes)";
  if (files.length === 1) return `Change ${files[0]}`;
  return `Change ${files.length} files (${files[0]} and ${files.length - 1} more)`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildPullRequestDescription(input: {
  summary: CodingAgentRunSummary;
  /** A caller-supplied title (the model's, or the plan's goal). */
  title?: string;
  /** The branch under review, when the caller knows it. Metadata only. */
  head?: string | null;
  base?: string | null;
}): PullRequestDescription {
  const summary = input.summary;
  const files = [...new Set(summary.filesChanged ?? [])];
  const stats = summary.diffStats ?? { files: 0, linesAdded: 0, linesRemoved: 0 };

  const whatChanged: string[] = [
    files.length === 0
      ? "No file was changed by this run."
      : `${plural(files.length, "file", "files")} changed (+${stats.linesAdded}/-${stats.linesRemoved} lines).`,
    `${plural(summary.turns ?? 0, "assistant turn", "assistant turns")}, ${plural(summary.toolCalls ?? 0, "tool call", "tool calls")}.`,
  ];
  if (files.length > 0) {
    const shown = files.slice(0, 20);
    whatChanged.push(`Files: ${shown.join(", ")}${files.length > shown.length ? ` (+${files.length - shown.length} more)` : ""}`);
  }
  if (input.base || input.head) {
    whatChanged.push(`Branches: ${input.head ?? "(head not recorded)"} -> ${input.base ?? "(base not recorded)"}.`);
  }

  const verification: string[] = [];
  const checksRun = summary.checksRun ?? [];
  const verificationSummary = summary.verification;
  const verificationMissing = !verificationSummary && checksRun.length === 0;
  if (verificationMissing) {
    verification.push("No verification was recorded for this run. Nothing here should be read as a passing check.");
  } else if (!verificationSummary) {
    verification.push(`Checks requested: ${checksRun.join(", ") || "(none named)"}; no outcome was recorded.`);
  } else {
    verification.push(`Verification: ${verificationSummary.status} (${verificationSummary.attemptsUsed}/${verificationSummary.maxAttempts} repair attempts, ${verificationSummary.verificationRuns} run(s)).`);
    verification.push(`Checks: ${verificationSummary.requestedTools.join(", ") || "(none)"}.`);
    if (verificationSummary.failedChecks.length > 0) {
      verification.push(`Failing checks: ${verificationSummary.failedChecks.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`).join(", ")}.`);
    }
    if (verificationSummary.testIntegrity?.flagged) {
      verification.push(
        verificationSummary.testIntegrity.justificationProvided
          ? "The change set touches tests; a justification was provided and is reviewed with this pull request."
          : "The change set reduces the suite's detection power (removed or weakened tests) and no justification was recorded.",
      );
    }
  }

  const risks: string[] = [];
  if (summary.scope) {
    if (summary.scope.exceeded) {
      risks.push(`The change set exceeded the scope limit (${summary.scope.changedFiles}/${summary.scope.limit}, severity ${summary.scope.severity}).`);
    }
    if (summary.scope.relatednessUnknown) {
      risks.push("The run had no stated focus, so relatedness of the changed files could not be judged.");
    }
    for (const warning of summary.scope.warnings ?? []) {
      risks.push(`${warning.severity}: ${warning.message}`);
    }
    const unrelated = summary.scope.unrelatedPaths ?? [];
    if (unrelated.length > 0) risks.push(`Paths outside the stated focus: ${unrelated.slice(0, 20).join(", ")}.`);
  }
  const nonBlocking = (summary.selfReview?.findings ?? []).filter((finding) => !finding.blocking);
  for (const finding of nonBlocking.slice(0, 10)) {
    risks.push(`self-review (${finding.severity}): ${finding.reason}`);
  }
  if (risks.length === 0) risks.push("No scope or self-review risk was recorded for this run.");

  const unresolved: string[] = [];
  const blocking = (summary.selfReview?.findings ?? []).filter((finding) => finding.blocking);
  for (const finding of blocking.slice(0, 10)) {
    unresolved.push(`${finding.file ?? "(no file)"}: ${finding.reason}${finding.suggestedFix ? ` — suggested: ${finding.suggestedFix}` : ""}`);
  }
  if ((summary.selfReview?.unresolved ?? 0) > 0 && blocking.length === 0) {
    unresolved.push(`${summary.selfReview!.unresolved} self-review finding(s) remained unresolved (detail not carried in the summary).`);
  }
  if (summary.selfReview && (summary.selfReview.status === "not_run" || summary.selfReview.status === "unavailable")) {
    unresolved.push(`Self-review did not run: ${summary.selfReview.status}${summary.selfReview.reason ? ` (${summary.selfReview.reason})` : ""}. The change was not reviewed.`);
  }
  if (summary.selfReview?.status === "unresolved") {
    unresolved.push("Self-review findings were not resolved; the review did not reach a clean verdict.");
  }
  if (summary.remaining && summary.remaining !== "completed") {
    unresolved.push(`The run's own remaining item: ${summary.remaining}.`);
  }
  if (unresolved.length === 0) unresolved.push("None recorded.");

  const body = [
    "## What changed",
    "",
    ...whatChanged.map((line) => `- ${line}`),
    "",
    "## Verification",
    "",
    ...verification.map((line) => `- ${line}`),
    "",
    "## Risks",
    "",
    ...risks.map((line) => `- ${line}`),
    "",
    "## Unresolved items",
    "",
    ...unresolved.map((line) => `- ${line}`),
    "",
    "_Generated from the run's own summary (CodingAgentRunSummary); it is a record of what the run did, not a claim about the code._",
  ].join("\n");

  return {
    schemaVersion: PR_DESCRIPTION_SCHEMA_VERSION,
    title: titleFor({ summary, ...(input.title ? { title: input.title } : {}) }),
    body,
    sections: { whatChanged, verification, risks, unresolved },
    verificationMissing,
  };
}
