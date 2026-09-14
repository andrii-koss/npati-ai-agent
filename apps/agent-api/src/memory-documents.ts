import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { MemoryMdManager } from "./memory-md-manager";
import { SecurityPolicyEngine } from "./security-guardrails";
import { UserModelProfileManager } from "./user-model-profile";

const USER_MD_KEY = "memory.user-md.v1";
const MEMORY_MD_FIELD = "memoryMd";
const MAX_DOCUMENT_LENGTH = 64_000;

export interface PersistedMemoryDocument {
  markdown: string;
  revision: number;
  updatedAt: string;
}

function validateMarkdown(kind: "user" | "company", markdown: string) {
  const clean = markdown.trim();
  const label = kind === "user" ? "USER.md" : "MEMORY.md";
  if (!clean) throw new Error(label + " content is required");
  if (clean.length > MAX_DOCUMENT_LENGTH) throw new Error("Memory document cannot exceed 64,000 characters");
  if (kind === "user") {
    if (!/^#\s+User Profile:/m.test(clean)) throw new Error("USER.md must contain a '# User Profile:' heading");
    UserModelProfileManager.parseMarkdown("validation", clean);
  } else {
    if (!/^#\s+Long-Term Memory:/m.test(clean)) throw new Error("MEMORY.md must contain a '# Long-Term Memory:' heading");
    MemoryMdManager.parse("validation", clean);
  }
  return SecurityPolicyEngine.protectText(clean).sanitized;
}

export class MemoryDocumentService {
  constructor(private readonly store: WorkspaceStore) {}

  async getUserDocument(ctx: AuthContext): Promise<PersistedMemoryDocument | null> {
    const setting = await this.store.getUserSetting(ctx, USER_MD_KEY);
    if (!setting || !setting.value || typeof setting.value !== "object") return null;
    const markdown = (setting.value as Record<string, unknown>).markdown;
    if (typeof markdown !== "string" || !markdown.trim()) return null;
    return { markdown, revision: setting.revision, updatedAt: setting.updatedAt };
  }

  async putUserDocument(ctx: AuthContext, markdown: string, expectedRevision: number): Promise<PersistedMemoryDocument> {
    const clean = validateMarkdown("user", markdown);
    const current = await this.getUserDocument(ctx);
    if (current?.markdown === clean) return current;
    const saved = await this.store.setUserSetting(ctx, USER_MD_KEY, { markdown: clean }, expectedRevision);
    if (!saved) throw new Error("USER.md was changed by another request. Reload and try again.");
    return { markdown: clean, revision: saved.revision, updatedAt: saved.updatedAt };
  }

  async deleteUserDocument(ctx: AuthContext, expectedRevision: number): Promise<void> {
    const current = await this.store.getUserSetting(ctx, USER_MD_KEY);
    if (!current) return;
    const saved = await this.store.setUserSetting(ctx, USER_MD_KEY, {}, expectedRevision);
    if (!saved) throw new Error("USER.md was changed by another request. Reload and try again.");
  }

  async getCompanyDocument(ctx: AuthContext, companyId: string): Promise<PersistedMemoryDocument | null> {
    const company = await this.store.getCompany(ctx, companyId);
    const value = company.memory?.[MEMORY_MD_FIELD];
    if (!value || typeof value !== "object") return null;
    const markdown = (value as Record<string, unknown>).markdown;
    if (typeof markdown !== "string" || !markdown.trim()) return null;
    return { markdown, revision: company.revision, updatedAt: company.updatedAt };
  }

  async putCompanyDocument(ctx: AuthContext, companyId: string, markdown: string, expectedRevision: number): Promise<PersistedMemoryDocument> {
    const clean = validateMarkdown("company", markdown);
    const company = await this.store.getCompany(ctx, companyId);
    const existing = company.memory?.[MEMORY_MD_FIELD];
    if (existing && typeof existing === "object" && (existing as Record<string, unknown>).markdown === clean) {
      return { markdown: clean, revision: company.revision, updatedAt: company.updatedAt };
    }
    const updated = await this.store.updateCompany(ctx, companyId, {
      memory: { ...company.memory, [MEMORY_MD_FIELD]: { markdown: clean } },
    }, expectedRevision);
    return { markdown: clean, revision: updated.revision, updatedAt: updated.updatedAt };
  }

  async deleteCompanyDocument(ctx: AuthContext, companyId: string, expectedRevision: number): Promise<void> {
    const company = await this.store.getCompany(ctx, companyId);
    if (!(MEMORY_MD_FIELD in company.memory)) return;
    const nextMemory = { ...company.memory };
    delete nextMemory[MEMORY_MD_FIELD];
    await this.store.updateCompany(ctx, companyId, { memory: nextMemory }, expectedRevision);
  }

  async context(ctx: AuthContext, companyId?: string) {
    const [user, company] = await Promise.all([
      this.getUserDocument(ctx),
      companyId ? this.getCompanyDocument(ctx, companyId) : Promise.resolve(null),
    ]);
    return { userMarkdown: user?.markdown, companyMarkdown: company?.markdown };
  }
}

export const memoryDocumentPrompt = (documents: { userMarkdown?: string; companyMarkdown?: string }) => [
  documents.userMarkdown && `<user_profile_data>\n${documents.userMarkdown}\n</user_profile_data>`,
  documents.companyMarkdown && `<company_long_term_memory_data>\n${documents.companyMarkdown}\n</company_long_term_memory_data>`,
].filter(Boolean).join("\n\n");
