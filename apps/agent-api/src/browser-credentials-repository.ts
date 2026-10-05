import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { BrowserSecurityGuard } from "./browser-security-guard";
import { normalizeCredentialEnvironment, type CredentialEnvironment } from "./credential-environment";

export interface BrowserCredentialSummary {
  id: string;
  label: string;
  fieldNames: string[];
  /** C4 (owner decision): explicit environment marker; `unknown` is never treated as safe. */
  environment: CredentialEnvironment;
  createdAt: string;
  updatedAt: string;
}

export type BrowserCampaignTargetStatus = "pending" | "processing" | "waiting_email" | "registered" | "published" | "failed" | "paused";

export interface BrowserCampaignTarget {
  id: string;
  automationId?: string | null;
  emailAccountId?: string | null;
  credentialId?: string | null;
  siteName: string;
  registrationUrl: string;
  publishUrl?: string | null;
  allowedDomain: string;
  articleTitle?: string | null;
  articleBody?: string | null;
  status: BrowserCampaignTargetStatus;
  resultUrl?: string | null;
  browserJobId?: string | null;
  lastRunId?: string | null;
  errorMessage?: string | null;
  attempts: number;
  priority: number;
  lastAttemptAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserCampaignTargetInput {
  automationId?: string | null;
  emailAccountId?: string | null;
  siteName: string;
  registrationUrl: string;
  publishUrl?: string | null;
  articleTitle?: string | null;
  articleBody?: string | null;
  priority?: number;
  status?: BrowserCampaignTargetStatus;
}

const targetSelect = `SELECT id,automation_id AS "automationId",email_account_id AS "emailAccountId",
  credential_id AS "credentialId",site_name AS "siteName",registration_url AS "registrationUrl",
  publish_url AS "publishUrl",allowed_domain AS "allowedDomain",article_title AS "articleTitle",
  article_body AS "articleBody",status,result_url AS "resultUrl",browser_job_id AS "browserJobId",
  last_run_id AS "lastRunId",error_message AS "errorMessage",attempts,priority,
  last_attempt_at::text AS "lastAttemptAt",completed_at::text AS "completedAt",
  created_at::text AS "createdAt",updated_at::text AS "updatedAt"
  FROM company_browser_campaign_targets`;

function normalizeTargetUrl(raw: string, field: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error(`${field} must be a valid URL`); }
  if (url.protocol !== "https:") throw new Error(`${field} must use HTTPS`);
  const validation = BrowserSecurityGuard.validateUrl(url.toString());
  if (!validation.allowed) throw new Error(validation.reason || `${field} is not allowed`);
  url = new URL(validation.normalizedUrl || url.toString());
  url.hash = "";
  return url;
}

export class BrowserCredentialsRepository {
  private readonly pool: Pool;
  private readonly vault = new CryptoVault();

  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl }); }

  async list(ctx: AuthContext, companyId: string): Promise<BrowserCredentialSummary[]> {
    const result = await this.pool.query<BrowserCredentialSummary>(`
      SELECT id,label,field_names AS "fieldNames",environment,created_at::text AS "createdAt",updated_at::text AS "updatedAt"
      FROM company_browser_credentials
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3
      ORDER BY label,id`, [ctx.workspaceId, companyId, ctx.userId]);
    return result.rows;
  }

  /**
   * Authoritative environment lookup for the SecretLease policy. Callers must use this instead of
   * trusting an environment marker that travelled with a tool call, which could be spoofed.
   */
  async describe(ctx: AuthContext, companyId: string, id: string): Promise<{ id: string; label: string; environment: CredentialEnvironment } | null> {
    const result = await this.pool.query<{ id: string; label: string; environment: string }>(`
      SELECT id,label,environment FROM company_browser_credentials
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`,
      [id, ctx.workspaceId, companyId, ctx.userId]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, label: row.label, environment: normalizeCredentialEnvironment(row.environment) };
  }

  async put(ctx: AuthContext, companyId: string, input: { id?: string; label: string; fields: Record<string, string>; environment?: string }) {
    const id = input.id || randomUUID();
    const label = input.label.trim().slice(0, 120);
    const environment = input.environment === undefined ? undefined : normalizeCredentialEnvironment(input.environment);
    const fields = Object.fromEntries(Object.entries(input.fields)
      .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) && typeof value === "string" && value.length > 0)
      .map(([key, value]) => [key, value.slice(0, 20_000)]));
    if (!label) throw new Error("Credential label is required");
    if (!Object.keys(fields).length) throw new Error("At least one credential field is required");
    const result = await this.pool.query<BrowserCredentialSummary>(`
      INSERT INTO company_browser_credentials(id,workspace_id,company_id,user_id,label,field_names,encrypted_fields,environment)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,COALESCE($8,'unknown'))
      ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,field_names=EXCLUDED.field_names,
        encrypted_fields=EXCLUDED.encrypted_fields,
        environment=COALESCE($8,company_browser_credentials.environment),updated_at=now()
      WHERE company_browser_credentials.workspace_id=$2 AND company_browser_credentials.company_id=$3
        AND company_browser_credentials.user_id=$4
      RETURNING id,label,field_names AS "fieldNames",environment,created_at::text AS "createdAt",updated_at::text AS "updatedAt"`,
      [id, ctx.workspaceId, companyId, ctx.userId, label, JSON.stringify(Object.keys(fields).sort()), this.vault.encryptJson(fields), environment ?? null]);
    if (!result.rowCount) throw Object.assign(new Error("Credential is not available in this tenant"), { status: 404 });
    return result.rows[0]!;
  }

  async resolve(ctx: AuthContext, companyId: string, id: string): Promise<Record<string, string>> {
    const result = await this.pool.query<{ encryptedFields: string }>(`
      SELECT encrypted_fields AS "encryptedFields" FROM company_browser_credentials
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`,
      [id, ctx.workspaceId, companyId, ctx.userId]);
    if (!result.rowCount) throw Object.assign(new Error("Browser credential reference was not found for this Company"), { status: 404, code: "BROWSER_CREDENTIAL_NOT_FOUND" });
    return this.vault.decryptJson<Record<string, string>>(result.rows[0]!.encryptedFields);
  }

  async delete(ctx: AuthContext, companyId: string, id: string) {
    return Boolean((await this.pool.query(`DELETE FROM company_browser_credentials
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [id, ctx.workspaceId, companyId, ctx.userId])).rowCount);
  }

  async listTargets(ctx: AuthContext, companyId: string): Promise<BrowserCampaignTarget[]> {
    const result = await this.pool.query<BrowserCampaignTarget>(`${targetSelect}
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3
      ORDER BY priority,created_at,id`, [ctx.workspaceId, companyId, ctx.userId]);
    return result.rows;
  }

  async getTarget(ctx: AuthContext, companyId: string, id: string): Promise<BrowserCampaignTarget | null> {
    const result = await this.pool.query<BrowserCampaignTarget>(`${targetSelect}
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [id, ctx.workspaceId, companyId, ctx.userId]);
    return result.rows[0] ?? null;
  }

  async createTarget(ctx: AuthContext, companyId: string, input: BrowserCampaignTargetInput): Promise<BrowserCampaignTarget> {
    const registration = normalizeTargetUrl(input.registrationUrl, "Registration URL");
    const publish = input.publishUrl?.trim() ? normalizeTargetUrl(input.publishUrl, "Publish URL") : null;
    if (publish && publish.hostname !== registration.hostname) throw new Error("Registration and publish URLs must use the same domain");
    const siteName = input.siteName.trim().slice(0, 160);
    if (!siteName) throw new Error("Site name is required");
    const id = randomUUID();
    await this.pool.query(`INSERT INTO company_browser_campaign_targets
      (id,workspace_id,company_id,user_id,automation_id,email_account_id,site_name,registration_url,publish_url,
       allowed_domain,article_title,article_body,priority,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
      id, ctx.workspaceId, companyId, ctx.userId, input.automationId || null, input.emailAccountId || null,
      siteName, registration.toString(), publish?.toString() || null, registration.hostname.toLowerCase(),
      input.articleTitle?.trim().slice(0, 500) || null, input.articleBody?.trim().slice(0, 100_000) || null,
      Math.max(0, Math.min(10_000, input.priority ?? 100)), input.status === "paused" ? "paused" : "pending",
    ]);
    return (await this.getTarget(ctx, companyId, id))!;
  }

  async updateTarget(ctx: AuthContext, companyId: string, id: string, input: Partial<BrowserCampaignTargetInput>): Promise<BrowserCampaignTarget> {
    const existing = await this.getTarget(ctx, companyId, id);
    if (!existing) throw Object.assign(new Error("Browser campaign target was not found"), { status: 404 });
    const registration = normalizeTargetUrl(input.registrationUrl ?? existing.registrationUrl, "Registration URL");
    const publishRaw = input.publishUrl === undefined ? existing.publishUrl : input.publishUrl;
    const publish = publishRaw?.trim() ? normalizeTargetUrl(publishRaw, "Publish URL") : null;
    if (publish && publish.hostname !== registration.hostname) throw new Error("Registration and publish URLs must use the same domain");
    const nextStatus = input.status ?? existing.status;
    await this.pool.query(`UPDATE company_browser_campaign_targets SET automation_id=$5,email_account_id=$6,
      site_name=$7,registration_url=$8,publish_url=$9,allowed_domain=$10,article_title=$11,article_body=$12,
      priority=$13,status=$14,attempts=CASE WHEN $14='pending' THEN 0 ELSE attempts END,
      error_message=CASE WHEN $14='pending' THEN NULL ELSE error_message END,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [id, ctx.workspaceId, companyId, ctx.userId,
      input.automationId === undefined ? existing.automationId : input.automationId || null,
      input.emailAccountId === undefined ? existing.emailAccountId : input.emailAccountId || null,
      (input.siteName ?? existing.siteName).trim().slice(0, 160), registration.toString(), publish?.toString() || null,
      registration.hostname.toLowerCase(), input.articleTitle === undefined ? existing.articleTitle : input.articleTitle?.trim().slice(0, 500) || null,
      input.articleBody === undefined ? existing.articleBody : input.articleBody?.trim().slice(0, 100_000) || null,
      Math.max(0, Math.min(10_000, input.priority ?? existing.priority)), nextStatus]);
    return (await this.getTarget(ctx, companyId, id))!;
  }

  async deleteTarget(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    return Boolean((await this.pool.query(`DELETE FROM company_browser_campaign_targets
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [id, ctx.workspaceId, companyId, ctx.userId])).rowCount);
  }

  async claimTargets(ctx: AuthContext, companyId: string, automationId: string, limit = 10): Promise<BrowserCampaignTarget[]> {
    const result = await this.pool.query<BrowserCampaignTarget>(`WITH claimed AS (
      SELECT id FROM company_browser_campaign_targets
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND automation_id=$4
        AND status IN ('pending','failed') AND attempts < 3
      ORDER BY priority,created_at FOR UPDATE SKIP LOCKED LIMIT $5
    ) UPDATE company_browser_campaign_targets t SET status='processing',attempts=t.attempts+1,
      last_attempt_at=now(),error_message=NULL,updated_at=now() FROM claimed WHERE t.id=claimed.id
      RETURNING t.id,t.automation_id AS "automationId",t.email_account_id AS "emailAccountId",
      t.credential_id AS "credentialId",t.site_name AS "siteName",t.registration_url AS "registrationUrl",
      t.publish_url AS "publishUrl",t.allowed_domain AS "allowedDomain",t.article_title AS "articleTitle",
      t.article_body AS "articleBody",t.status,t.result_url AS "resultUrl",t.browser_job_id AS "browserJobId",
      t.last_run_id AS "lastRunId",t.error_message AS "errorMessage",t.attempts,t.priority,
      t.last_attempt_at::text AS "lastAttemptAt",t.completed_at::text AS "completedAt",
      t.created_at::text AS "createdAt",t.updated_at::text AS "updatedAt"`,
      [ctx.workspaceId, companyId, ctx.userId, automationId, Math.max(1, Math.min(10, limit))]);
    return result.rows;
  }

  async ensureTargetCredential(ctx: AuthContext, companyId: string, target: BrowserCampaignTarget, email: string) {
    if (target.credentialId) return target.credentialId;
    const credential = await this.put(ctx, companyId, {
      label: `campaign-${target.id}`,
      fields: { email, username: email, password: randomBytes(24).toString("base64url") },
    });
    await this.pool.query(`UPDATE company_browser_campaign_targets SET credential_id=$2,updated_at=now()
      WHERE id=$1 AND workspace_id=$3 AND company_id=$4 AND user_id=$5`,
      [target.id, credential.id, ctx.workspaceId, companyId, ctx.userId]);
    return credential.id;
  }

  async recordTargetResult(ctx: AuthContext, companyId: string, id: string, input: {
    status: "waiting_email" | "registered" | "published" | "failed";
    resultUrl?: string; browserJobId?: string; runId?: string; errorMessage?: string;
  }): Promise<void> {
    await this.pool.query(`UPDATE company_browser_campaign_targets SET status=$5,result_url=COALESCE($6,result_url),
      browser_job_id=COALESCE($7,browser_job_id),last_run_id=COALESCE($8,last_run_id),error_message=$9,
      completed_at=CASE WHEN $5 IN ('registered','published') THEN now() ELSE NULL END,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`,
      [id, ctx.workspaceId, companyId, ctx.userId, input.status, input.resultUrl || null, input.browserJobId || null,
        input.runId || null, input.errorMessage?.slice(0, 4000) || null]);
  }

  async registerEmailWait(ctx: AuthContext, companyId: string, input: { jobId: string; runId: string; profileId: string; senderHint?: string; campaignTargetId?: string }) {
    await this.pool.query(`INSERT INTO company_browser_email_waits
      (id,workspace_id,company_id,user_id,browser_job_id,run_id,profile_id,sender_hint,campaign_target_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(workspace_id,company_id,browser_job_id) DO UPDATE SET
        run_id=EXCLUDED.run_id,profile_id=EXCLUDED.profile_id,sender_hint=EXCLUDED.sender_hint,
        campaign_target_id=EXCLUDED.campaign_target_id,status='waiting_email',consumed_at=NULL`,
      [randomUUID(),ctx.workspaceId,companyId,ctx.userId,input.jobId,input.runId,input.profileId,
        input.senderHint?.toLowerCase().slice(0,320) || null,input.campaignTargetId || null]);
  }

  async close() { await this.pool.end(); }
}
