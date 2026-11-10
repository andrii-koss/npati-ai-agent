import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuditLogService } from "./audit-log";

/**
 * A company setting: "the agent may change this company's project databases without asking each time".
 *
 * Off by default, so a new installation always asks before a database change. Only a company owner or admin
 * can switch it, every switch is written to the audit journal first, and the runtime still records an audit
 * entry for each change it allows this way. It never covers file deletes, git pushes or any non-database tool.
 */
export interface ChatDataAutoAllowView { autoAllow: boolean; revision: number; canChange: boolean }

export class ChatDataAutoAllowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 403) { super(message); }
}

export class ChatDataAutoAllowService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly canManageCompany: (ctx: AuthContext, companyId: string) => Promise<boolean>,
    private readonly audit?: AuditLogService,
  ) {}

  private async setting(ctx: AuthContext, companyId: string) {
    const company = await this.store.getCompany(ctx, companyId);
    // Stored with the company's creator, so every member of the company reads the same value.
    const ownerContext = { ...ctx, userId: company.userId };
    const key = `chat.data-auto-allow:${companyId}`;
    const row = await this.store.getUserSetting(ownerContext, key);
    const value = row?.value as { autoAllow?: unknown } | undefined;
    return { ownerContext, key, row, autoAllow: value?.autoAllow === true };
  }

  async get(ctx: AuthContext, companyId: string): Promise<ChatDataAutoAllowView> {
    const setting = await this.setting(ctx, companyId);
    return { autoAllow: setting.autoAllow, revision: setting.row?.revision ?? 0, canChange: await this.canManageCompany(ctx, companyId) };
  }

  /** What the runtime asks before a database change; any failure counts as "ask the person". */
  async isOn(ctx: AuthContext, companyId: string): Promise<boolean> {
    return (await this.setting(ctx, companyId).catch(() => null))?.autoAllow === true;
  }

  async set(ctx: AuthContext, companyId: string, autoAllow: boolean, expectedRevision: number): Promise<ChatDataAutoAllowView> {
    if (!(await this.canManageCompany(ctx, companyId))) throw new ChatDataAutoAllowError("company_admin_required", "Only a company owner or admin can change this setting");
    if (!this.audit) throw new ChatDataAutoAllowError("audit_unavailable", "Changing this setting requires the audit journal", 503);
    const setting = await this.setting(ctx, companyId);
    await this.audit.record(ctx, { companyId, actor: ctx.userId, actorRole: "owner",
      action: "chat.data_auto_allow.change", resourceType: "chat_data_auto_allow", resourceId: companyId,
      decision: "allowed", payload: { previous: setting.autoAllow, next: autoAllow, expectedRevision } });
    const saved = await this.store.setUserSetting(setting.ownerContext, setting.key, { autoAllow }, expectedRevision);
    if (!saved) throw new ChatDataAutoAllowError("setting_revision_conflict", "The setting changed. Refresh and retry.", 409);
    return this.get(ctx, companyId);
  }
}
