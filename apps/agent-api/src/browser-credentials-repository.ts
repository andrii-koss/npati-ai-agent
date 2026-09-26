import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";

export interface BrowserCredentialSummary {
  id: string;
  label: string;
  fieldNames: string[];
  createdAt: string;
  updatedAt: string;
}

export class BrowserCredentialsRepository {
  private readonly pool: Pool;
  private readonly vault = new CryptoVault();

  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl }); }

  async list(ctx: AuthContext, companyId: string): Promise<BrowserCredentialSummary[]> {
    const result = await this.pool.query<BrowserCredentialSummary>(`
      SELECT id,label,field_names AS "fieldNames",created_at::text AS "createdAt",updated_at::text AS "updatedAt"
      FROM company_browser_credentials
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3
      ORDER BY label,id`, [ctx.workspaceId, companyId, ctx.userId]);
    return result.rows;
  }

  async put(ctx: AuthContext, companyId: string, input: { id?: string; label: string; fields: Record<string, string> }) {
    const id = input.id || randomUUID();
    const label = input.label.trim().slice(0, 120);
    const fields = Object.fromEntries(Object.entries(input.fields)
      .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) && typeof value === "string" && value.length > 0)
      .map(([key, value]) => [key, value.slice(0, 20_000)]));
    if (!label) throw new Error("Credential label is required");
    if (!Object.keys(fields).length) throw new Error("At least one credential field is required");
    const result = await this.pool.query<BrowserCredentialSummary>(`
      INSERT INTO company_browser_credentials(id,workspace_id,company_id,user_id,label,field_names,encrypted_fields)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,field_names=EXCLUDED.field_names,
        encrypted_fields=EXCLUDED.encrypted_fields,updated_at=now()
      WHERE company_browser_credentials.workspace_id=$2 AND company_browser_credentials.company_id=$3
        AND company_browser_credentials.user_id=$4
      RETURNING id,label,field_names AS "fieldNames",created_at::text AS "createdAt",updated_at::text AS "updatedAt"`,
      [id, ctx.workspaceId, companyId, ctx.userId, label, JSON.stringify(Object.keys(fields).sort()), this.vault.encryptJson(fields)]);
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

  async registerEmailWait(ctx: AuthContext, companyId: string, input: { jobId: string; runId: string; profileId: string; senderHint?: string }) {
    await this.pool.query(`INSERT INTO company_browser_email_waits
      (id,workspace_id,company_id,user_id,browser_job_id,run_id,profile_id,sender_hint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(workspace_id,company_id,browser_job_id) DO UPDATE SET
        run_id=EXCLUDED.run_id,profile_id=EXCLUDED.profile_id,sender_hint=EXCLUDED.sender_hint,status='waiting_email',consumed_at=NULL`,
      [randomUUID(),ctx.workspaceId,companyId,ctx.userId,input.jobId,input.runId,input.profileId,input.senderHint?.toLowerCase().slice(0,320) || null]);
  }

  async close() { await this.pool.end(); }
}
