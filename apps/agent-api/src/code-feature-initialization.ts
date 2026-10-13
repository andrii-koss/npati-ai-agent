import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { FeatureFlagService } from "./feature-flags";
import { CODE_AGENT_MASTER_FLAG, CODE_AGENT_SUB_FLAGS, FeatureFlagError } from "./feature-flags";

/** Apply the requested all-on defaults once; later user opt-outs survive page reloads. */
export class CodeFeatureInitialization {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly store: WorkspaceStore, private readonly flags: FeatureFlagService) {}
  private async setting(ctx: AuthContext, companyId: string) {
    const company = await this.store.getCompany(ctx, companyId);
    const owner = { ...ctx, userId: company.userId };
    const key = `coding-agent.features.initialized:v1:${companyId}`;
    return { owner, key, row: await this.store.getUserSetting(owner, key) };
  }
  async completed(ctx: AuthContext, companyId: string) { return (await this.setting(ctx, companyId)).row?.value === true; }
  async apply(ctx: AuthContext, companyId: string): Promise<void> {
    if (!(await this.flags.canManage(ctx, companyId))) throw new FeatureFlagError("flag_admin_required", "Only a company owner/admin can initialize coding features", 403);
    const lock = `${ctx.workspaceId}:${companyId}`;
    const existing = this.pending.get(lock);
    if (existing) return existing;
    const operation = this.initialize(ctx, companyId);
    this.pending.set(lock, operation);
    try { await operation; } finally { this.pending.delete(lock); }
  }
  private async initialize(ctx: AuthContext, companyId: string) {
    const setting = await this.setting(ctx, companyId);
    if (setting.row?.value === true) return;
    for (const flagKey of [CODE_AGENT_MASTER_FLAG, ...CODE_AGENT_SUB_FLAGS,
      "code.model_profile.hosted-native-tools", "code.model_profile.hosted-native-tools-small-context", "code.model_profile.local-text-tools"]) {
      await this.flags.setFlag(ctx, { scope: "company", scopeId: companyId, flagKey, enabled: true, stage: "ga" }, { auditCompanyId: companyId });
    }
    const saved = await this.store.setUserSetting(setting.owner, setting.key, true, setting.row?.revision ?? 0);
    if (!saved && !(await this.completed(ctx, companyId))) throw new FeatureFlagError("flag_revision_conflict", "Coding feature initialization changed. Refresh and retry.", 409);
  }
}
