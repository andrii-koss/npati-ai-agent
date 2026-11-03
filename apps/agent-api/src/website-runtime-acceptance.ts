import { normalizeBrowserDiagnostic } from "../browser-qa-diagnostics.mjs";
import { browserCheckUnavailableNotice, resolveCodingConversationLanguage } from "./company-chat-i18n";
import type { CodeSessionRunInput } from "./code-session-run-executor";
import type { BrowserQaReportResult } from "./project-browser-qa-service";

/** A successful build cannot certify browser hydration or local navigation. Reference runs already have this gate. */
export async function verifyWebsiteRuntime(input: CodeSessionRunInput, result: unknown, inspect: () => Promise<BrowserQaReportResult>): Promise<unknown> {
  const run = result as { status?: string; websitePreview?: { status?: string } };
  if (run?.status !== "completed" || run.websitePreview?.status !== "running" || input.referenceImageRequired || input.readOnlyIntent || input.session.mode === "plan") return result;
  try {
    const qa = await inspect();
    const functionalAcceptance = { status: qa.success ? "passed" : "failed", qaStatus: qa.report.status, reportId: qa.report.id,
      diagnostics: qa.consoleErrors.slice(0, 5).map(normalizeBrowserDiagnostic), brokenLinks: qa.brokenLinks.slice(0, 10) };
    return qa.success ? { ...run, functionalAcceptance } : { ...run, status: "failed", reason: "website_preview_qa_failed", functionalAcceptance,
      message: "The production build passed, but Browser QA failed. Correct the reported browser diagnostics or broken links in this same project and retry. " + JSON.stringify(functionalAcceptance) };
  } catch (error) {
    console.warn(`[website-qa] browser check unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const answer = (run as { message?: string }).message;
    return { ...run, functionalAcceptance: { status: "blocked" },
      message: `${answer ? `${answer}\n\n` : ""}${browserCheckUnavailableNotice(resolveCodingConversationLanguage(input.prompt ?? ""))}` };
  }
}
