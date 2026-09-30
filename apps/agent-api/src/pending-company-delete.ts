import type { AuthContext, Company, WorkspaceStore } from "@npati/workspace";
import type { CompanyChatLanguage } from "./company-chat-i18n";
import { companyDeleteCopy } from "./company-delete-i18n";

const languages: CompanyChatLanguage[] = ["en", "uk", "fr", "de", "es", "it", "pl", "pt", "nl", "tr", "ru", "zh", "ja", "ko", "ar", "hi"];

/** Only an exact confirmation question previously emitted by the server can authorize a short affirmative reply. */
export async function pendingCompanyDelete(store: WorkspaceStore, auth: AuthContext, previousAssistant: string): Promise<Company | undefined> {
  const question = previousAssistant.trim();
  if (!question) return undefined;
  let cursor: string | undefined;
  do {
    const page = await store.listCompanies(auth, 100, cursor);
    for (const company of page.items) {
      const displayedName = company.name.replace(/```/g, "'''").trim();
      if (languages.some((language) => companyDeleteCopy(language, displayedName).selected === question)) return company;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}
