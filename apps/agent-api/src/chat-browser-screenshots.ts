import type { AuthContext, Company, CompanyAgentRunDetails } from "@npati/workspace";

type ScreenshotStore = {
  getCompanyAgentRun(context: AuthContext, companyId: string, runId: string): Promise<CompanyAgentRunDetails>;
  getCompany(context: AuthContext, companyId: string): Promise<Company>;
};
type ArtifactSource = { downloadArtifact(context: AuthContext, company: Company, artifactId: string): Promise<{ contentType: string; data: Buffer }> };
type ChatFiles = {
  persist(context: AuthContext, businessId: string | undefined, chatId: string, attachments: Array<{ name: string; mimeType: string; data: Buffer; kind: "image" }>): Promise<Array<{ id: string; name: string }>>;
};

const MAX_SCREENSHOTS = 6;

/**
 * Screenshots a company run took with browser-use, saved as chat images and returned as attachment lines the chat
 * already renders. Before this the reply showed only an artifact ID (V6 step 11, owner decision: show screenshots in
 * the chat). The run's own tool audit names the artifacts, so only this run's screenshots, of this user, are shown.
 */
export async function browserScreenshotAttachments(input: {
  store: ScreenshotStore; auth: AuthContext; companyId: string; runId: string; conversationId?: string;
  browser?: ArtifactSource; chatFiles?: ChatFiles; log?: { warn(details: unknown, message: string): void };
}): Promise<string> {
  const { store, auth, companyId, runId, conversationId, browser, chatFiles } = input;
  if (!browser || !chatFiles || !conversationId) return "";
  try {
    const details = await store.getCompanyAgentRun(auth, companyId, runId);
    const ids = [...new Set(details.toolAudit
      .filter((entry) => entry.toolName === "browser.action.screenshot" && entry.status === "succeeded")
      .map((entry) => String(entry.inputSummary?.detail ?? ""))
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, MAX_SCREENSHOTS);
    if (!ids.length) return "";
    const company = await store.getCompany(auth, companyId);
    const lines: string[] = [];
    for (const id of ids) {
      try {
        const artifact = await browser.downloadArtifact(auth, company, id);
        if (!/^image\//i.test(artifact.contentType) || !artifact.data.length) continue;
        const [saved] = await chatFiles.persist(auth, undefined, conversationId, [{ name: `screenshot-${id.slice(0, 8)}.png`, mimeType: artifact.contentType, data: artifact.data, kind: "image" }]);
        if (saved) lines.push(`[[npati-attachment:image:${saved.id}:${encodeURIComponent(saved.name)}]]`);
      } catch (error) {
        input.log?.warn({ err: error, runId, artifactId: id }, "Browser screenshot could not be attached to the chat");
      }
    }
    return lines.length ? "\n\n" + lines.join("\n") : "";
  } catch (error) {
    input.log?.warn({ err: error, runId }, "Browser screenshots of the run could not be read");
    return "";
  }
}
