import { describe, expect, it } from "vitest";
import type { CodeSession } from "@npati/workspace";
import { buildSystemPrompt, SYSTEM_PROMPT_DATA_BOUNDARY } from "../apps/agent-api/src/coding-agent-runner-prompt";
import { CODING_RESPONSE_STYLE, CODING_RESPONSE_PUNCTUATION } from "../apps/agent-api/src/coding-response-style";
import { REVIEW_RULES } from "../apps/agent-api/src/code-self-review-parser";
import { selfReviewUnresolvedNotice, type SelfReviewFinding, type SelfReviewVerdict } from "../apps/agent-api/src/code-self-review";
import { selfReviewFindingsNotice, type CompanyChatLanguage } from "../apps/agent-api/src/company-chat-i18n";

function verdict(findings: SelfReviewFinding[]): SelfReviewVerdict {
  return {
    schemaVersion: 1, status: "unresolved", ran: true,
    findings, unresolved: findings, blocking: findings.filter(f => f.blocking).length,
    iterationsUsed: 1, maxIterations: 1, fixApplied: true,
    reviewHash: "sha256:test", rejectedFindings: 0, reviewRuns: 1,
    inputs: { originalGoal: true, approvedPlan: false, finalDiff: true, changedFiles: 1, verification: true, testIntegrity: true },
  };
}

const finding: SelfReviewFinding = {
  id: "R-1", category: "correctness", severity: "high", file: "script.js",
  reason: "Після виходу кнопка залишається з підписом «Акаунт». Повторний вхід недоступний без перезавантаження.",
  suggested_fix: "Call renderAccount after clearing the session.", blocking: true,
};

describe("coding response presentation", () => {
  it("forbids long dash punctuation in both coding answers and review findings", () => {
    expect(CODING_RESPONSE_STYLE).toContain(CODING_RESPONSE_PUNCTUATION);
    expect(REVIEW_RULES).toContain(CODING_RESPONSE_PUNCTUATION);
    expect(CODING_RESPONSE_PUNCTUATION).toContain("never an em dash or en dash");
  });

  it("places localized, concise Markdown guidance in the instruction prefix", () => {
    const prompt = buildSystemPrompt({
      session: { mode: "auto" } as CodeSession, tools: [],
      environment: { os: "linux", cwd: "/project", date: "2026-11-11" },
      limits: { maxStepsPerRun: 10, maxRunMinutes: 5 },
    });
    expect(prompt.indexOf(CODING_RESPONSE_STYLE)).toBeLessThan(prompt.indexOf(SYSTEM_PROMPT_DATA_BOUNDARY));
    expect(CODING_RESPONSE_STYLE).toContain("checks actually completed");
    expect(CODING_RESPONSE_STYLE).toContain("Keep unresolved problems visible");
    expect(CODING_RESPONSE_STYLE).toContain("explicit user formatting requirements");
  });

  it("separates the warning from readable findings without losing evidence", () => {
    const notice = selfReviewUnresolvedNotice(verdict([finding, { ...finding, id: "R-2", file: "account.js", reason: "Second concrete issue." }]), "Виправ сайт");
    // V6 step 15 (D15-05): the heading carries no warning emoji.
    expect(notice).toMatch(/^\*\*[^\n⚠]+\*\*\n\n- \*\*script\.js\*\*:/);
    expect(notice).toContain(finding.reason);
    expect(notice).toContain("\n\n- **account.js**: Second concrete issue.");
    expect(notice).not.toContain("correctness (");
    expect(notice).not.toContain(finding.suggested_fix);
  });

  it("escapes filename markup while retaining the unresolved warning", () => {
    const notice = selfReviewUnresolvedNotice(verdict([{ ...finding, file: "my_[file]*.js" }]), "Fix the site");
    expect(notice).toContain("**my\\_\\[file\\]\\*.js**");
    expect(notice).toContain(finding.reason);
  });

  it("keeps localized warnings and list separation for every interface language", () => {
    const languages: CompanyChatLanguage[] = ["en", "uk", "ru", "de", "fr", "es", "it", "pl", "pt", "nl", "tr", "zh", "ja", "ko", "ar", "hi"];
    for (const language of languages) {
      const notice = selfReviewFindingsNotice(language, "- **script.js**: Evidence preserved.");
      expect(notice).toMatch(/^\*\*[^\n⚠]+\*\*\n\n- \*\*script\.js\*\*: Evidence preserved\.$/);
      expect(notice).not.toContain("undefined");
    }
  });
});
