import type { AuthContext, WorkspaceStore } from "@npati/workspace";

export type ContentLibraryType = "article" | "seo_structure" | "social_post" | "brief";
export interface ContentLibraryOverride {
  runId: string;
  companyId: string;
  businessId?: string;
  title?: string;
  type?: ContentLibraryType;
  content?: string;
  deleted: boolean;
  updatedAt: string;
}

const settingKey = "content_library_overrides_v1";

function parse(value: unknown): Record<string, ContentLibraryOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, ContentLibraryOverride> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Partial<ContentLibraryOverride>;
    if (candidate.runId !== key || typeof candidate.companyId !== "string") continue;
    result[key] = { runId: key, companyId: candidate.companyId, businessId: candidate.businessId, title: candidate.title, type: candidate.type, content: candidate.content, deleted: candidate.deleted === true, updatedAt: String(candidate.updatedAt ?? "") };
  }
  return result;
}

export class ContentLibraryStore {
  constructor(private readonly store: WorkspaceStore) {}

  async list(context: AuthContext): Promise<Record<string, ContentLibraryOverride>> {
    return parse((await this.store.getUserSetting(context, settingKey))?.value);
  }

  async get(context: AuthContext, runId: string): Promise<ContentLibraryOverride | undefined> {
    return (await this.list(context))[runId];
  }

  private async mutate(context: AuthContext, runId: string, change: (current?: ContentLibraryOverride) => ContentLibraryOverride): Promise<ContentLibraryOverride> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const setting = await this.store.getUserSetting(context, settingKey);
      const values = parse(setting?.value);
      const next = change(values[runId]);
      values[runId] = next;
      if (await this.store.setUserSetting(context, settingKey, values, setting?.revision ?? 0)) return next;
    }
    throw new Error("Content library was updated concurrently. Please try again.");
  }

  async update(context: AuthContext, runId: string, companyId: string, input: { title?: string; type?: ContentLibraryType; content?: string; businessId?: string }): Promise<ContentLibraryOverride> {
    if (input.businessId) await this.store.getUserBusiness(context, input.businessId);
    return this.mutate(context, runId, (current) => ({
      runId,
      companyId,
      businessId: input.businessId ?? current?.businessId,
      title: input.title !== undefined ? input.title.trim().slice(0, 300) : current?.title,
      type: input.type !== undefined ? input.type : current?.type,
      content: input.content !== undefined ? input.content.slice(0, 200_000) : current?.content,
      deleted: false,
      updatedAt: new Date().toISOString(),
    }));
  }

  async delete(context: AuthContext, runId: string, companyId: string): Promise<ContentLibraryOverride> {
    return this.mutate(context, runId, (current) => ({
      runId,
      companyId,
      businessId: current?.businessId,
      title: current?.title,
      type: current?.type,
      content: current?.content,
      deleted: true,
      updatedAt: new Date().toISOString(),
    }));
  }
}
