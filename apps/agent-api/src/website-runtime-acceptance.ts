import { normalizeBrowserDiagnostic } from "../browser-qa-diagnostics.mjs";
import { browserCheckUnavailableNotice, resolveCodingConversationLanguage } from "./company-chat-i18n";
import type { CodeSessionRunInput } from "./code-session-run-executor";
import type { BrowserQaReportResult } from "./project-browser-qa-service";

/** What the user reads when the app still breaks: the actual errors, in their language, not a report dump. */
function browserFailureMessage(prompt: string, diagnostics: unknown[], brokenLinks: unknown[]): string {
  const details = [...diagnostics.map((item) => {
    const entry = item as { message?: unknown; text?: unknown } | string;
    return typeof entry === "string" ? entry : String(entry?.message ?? entry?.text ?? JSON.stringify(entry));
  }), ...brokenLinks.map((link) => String((link as { url?: unknown; href?: unknown })?.url ?? (link as { href?: unknown })?.href ?? link))].map((line) => "- " + line.split("\n")[0]!.slice(0, 200));
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
      diagnostics: qa.consoleErrors.slice(0, 5).map(normalizeBrowserDiagnostic), brokenLinks: qa.brokenLinks.slice(0, 10) };
    return qa.success ? { ...run, functionalAcceptance } : { ...run, status: "failed", reason: "website_preview_qa_failed", functionalAcceptance,
      message: browserFailureMessage(input.prompt ?? "", functionalAcceptance.diagnostics, functionalAcceptance.brokenLinks) };
  } catch (error) {
    console.warn(`[website-qa] browser check unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const answer = (run as { message?: string }).message;
    return { ...run, functionalAcceptance: { status: "blocked" },
      message: `${answer ? `${answer}\n\n` : ""}${browserCheckUnavailableNotice(resolveCodingConversationLanguage(input.prompt ?? ""))}` };
  }
}
