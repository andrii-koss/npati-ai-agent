import { normalizeBrowserDiagnostic } from "../browser-qa-diagnostics.mjs";
import { browserCheckScriptBlockedNotice, browserCheckUnavailableNotice, resolveCodingConversationLanguage } from "./company-chat-i18n";
import type { CodeSessionRunInput } from "./code-session-run-executor";
import { NOT_CHECKED_SCRIPT, type BrowserQaReportResult } from "./project-browser-qa-service";

/**
 * The report's other errors (a refused form, a fixed API host, a control shown to the wrong visitor). They are not console
 * errors, so before this the repair run was told "errors: []" and the user read a heading with nothing under it.
 */
export function browserQaFindings(qa: Pick<BrowserQaReportResult, "issues" | "consoleErrors">): Array<{ message: string; fix?: string }> {
  const consoleMessages = new Set((qa.consoleErrors ?? []).map((entry) => entry.message));
  return (qa.issues ?? [])
    .filter((issue) => issue.severity === "error" && !consoleMessages.has(issue.message) && !/^\d+ browser console errors$/.test(issue.message) && !/^Local link returned/.test(issue.message))
    .slice(0, 10).map((issue) => ({ message: issue.message, ...(issue.recommendation ? { fix: issue.recommendation } : {}) }));
}

/** What the user reads when the app still breaks: the actual errors, in their language, not a report dump. */
function browserFailureMessage(prompt: string, diagnostics: unknown[], brokenLinks: unknown[], findings: Array<{ message: string }> = []): string {
  const details = [...diagnostics.map((item) => {
    const entry = item as { message?: unknown; text?: unknown } | string;
    return typeof entry === "string" ? entry : String(entry?.message ?? entry?.text ?? JSON.stringify(entry));
  }), ...findings.map((finding) => finding.message), ...brokenLinks.map((link) => String((link as { url?: unknown; href?: unknown })?.url ?? (link as { href?: unknown })?.href ?? link))].map((line) => "- " + line.split("\n")[0]!.slice(0, 200));
  const uk = resolveCodingConversationLanguage(prompt) === "uk";
  const head = uk ? "Проєкт зібрався, але під час відкриття в браузері є помилки, які не вдалося виправити автоматично:" : "The project builds, but opening it in a browser shows errors that could not be fixed automatically:";
  return [head, ...details].join("\n");
}

/** A successful build cannot certify browser hydration or local navigation. Reference runs already have this gate. */
export async function verifyWebsiteRuntime(input: CodeSessionRunInput, result: unknown, inspect: () => Promise<BrowserQaReportResult>): Promise<unknown> {
  const run = result as { status?: string; websitePreview?: { status?: string } };
  if (run?.status !== "completed" || run.websitePreview?.status !== "running" || input.referenceImageRequired || input.readOnlyIntent || input.session.mode === "plan") return result;
  try {
    const qa = await inspect();
    const functionalAcceptance = { status: qa.success ? "passed" : "failed", qaStatus: qa.report.status, reportId: qa.report.id,
      diagnostics: qa.consoleErrors.slice(0, 5).map(normalizeBrowserDiagnostic), brokenLinks: qa.brokenLinks.slice(0, 10), findings: browserQaFindings(qa) };
    // Passed, but a script of the page was never loaded: the user is told it was not fully verified.
    const blocked = (qa.issues ?? []).filter((issue) => issue.message.startsWith(NOT_CHECKED_SCRIPT)).map((issue) => issue.message.slice(NOT_CHECKED_SCRIPT.length));
    if (qa.success && blocked.length) {
      const answer = (run as { message?: string }).message;
      return { ...run, functionalAcceptance: { ...functionalAcceptance, status: "not_verified", blockedScripts: blocked },
        message: `${answer ? `${answer}

` : ""}${browserCheckScriptBlockedNotice(resolveCodingConversationLanguage(input.prompt ?? ""), blocked)}` };
    }
    return qa.success ? { ...run, functionalAcceptance } : { ...run, status: "failed", reason: "website_preview_qa_failed", functionalAcceptance,
      message: browserFailureMessage(input.prompt ?? "", functionalAcceptance.diagnostics, functionalAcceptance.brokenLinks, functionalAcceptance.findings) };
  } catch (error) {
    console.warn(`[website-qa] browser check unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const answer = (run as { message?: string }).message;
    return { ...run, functionalAcceptance: { status: "blocked" },
      message: `${answer ? `${answer}\n\n` : ""}${browserCheckUnavailableNotice(resolveCodingConversationLanguage(input.prompt ?? ""))}` };
  }
}
