import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  AuthContext,
  AuditAnchor,
  CodeApprovalRule,
  CodeApprovalRuleInput,
  CodeApprovalRuleScope,
  CodeToolManifest,
  FeatureFlag,
  FeatureFlagHistoryEntry,
  FeatureFlagInput,
  SandboxImage,
  SandboxImageInput,
  SandboxImageVariant,
} from "./types.js";
import {
  auditAnchorColumns,
  codeApprovalRuleColumns,
  featureFlagColumns,
  sandboxImageColumns,
} from "./postgres-store-schema.js";
import { assertCompany } from "./postgres-store-support.js";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "./types.js";

export async function listSandboxImages(pool: Pool, context: AuthContext): Promise<SandboxImage[]> {
  const result = await pool.query<SandboxImage>(
    `SELECT ${sandboxImageColumns} FROM sandbox_images
     WHERE workspace_id=$1 ORDER BY variant, created_at DESC`,
    [context.workspaceId],
  );
  return result.rows;
}

export async function getSandboxImage(pool: Pool, context: AuthContext, reference: string): Promise<SandboxImage | null> {
  const result = await pool.query<SandboxImage>(
    `SELECT ${sandboxImageColumns} FROM sandbox_images
     WHERE workspace_id=$1 AND reference=$2`,
    [context.workspaceId, reference],
  );
  return result.rows[0] ?? null;
}

export async function upsertSandboxImage(
  pool: Pool,
  context: AuthContext,
  input: SandboxImageInput,
): Promise<SandboxImage> {
  const result = await pool.query<SandboxImage>(
    `INSERT INTO sandbox_images
      (id, workspace_id, variant, reference, digest, status, signature, signature_issuer, sbom_path, scan_tool, scan_at,
       scan_critical, scan_high, waiver_owner, waiver_expires_at, waiver_reason, previous_reference, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (workspace_id, reference) DO UPDATE SET
        variant=$3, digest=$5, status=$6, signature=$7, signature_issuer=$8, sbom_path=$9, scan_tool=$10, scan_at=$11,
        scan_critical=$12, scan_high=$13, waiver_owner=$14, waiver_expires_at=$15, waiver_reason=$16,
        previous_reference=COALESCE($17, sandbox_images.previous_reference), updated_at=now()
      RETURNING ${sandboxImageColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      input.variant,
      input.reference,
      input.digest,
      input.status ?? "unverified",
      input.signature ?? null,
      input.signatureIssuer ?? null,
      input.sbomPath ?? null,
      input.scanTool ?? null,
      input.scanAt ?? null,
      input.scanCritical ?? 0,
      input.scanHigh ?? 0,
      input.waiverOwner ?? null,
      input.waiverExpiresAt ?? null,
      input.waiverReason ?? null,
      input.previousReference ?? null,
      context.userId,
    ],
  );
  return result.rows[0]!;
}

export async function revokeSandboxImage(
  pool: Pool,
  context: AuthContext,
  reference: string,
  input: { actor: string; reason: string },
): Promise<SandboxImage> {
  const result = await pool.query<SandboxImage>(
    `UPDATE sandbox_images
      SET status='revoked', revoked_at=now(), revoked_by=$3, revoke_reason=$4, updated_at=now()
      WHERE workspace_id=$1 AND reference=$2 RETURNING ${sandboxImageColumns}`,
    [context.workspaceId, reference, input.actor, input.reason],
  );
  if (!result.rows[0]) throw new WorkspaceNotFoundError("Sandbox image not found");
  return result.rows[0];
}

export async function latestVerifiedSandboxImage(
  pool: Pool,
  context: AuthContext,
  variant: SandboxImageVariant,
): Promise<SandboxImage | null> {
  const result = await pool.query<SandboxImage>(
    `SELECT ${sandboxImageColumns} FROM sandbox_images
      WHERE workspace_id=$1 AND variant=$2 AND status='verified'
      ORDER BY scan_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [context.workspaceId, variant],
  );
  return result.rows[0] ?? null;
}

export async function listFeatureFlags(pool: Pool, context: AuthContext): Promise<FeatureFlag[]> {
  const result = await pool.query<FeatureFlag>(
    `SELECT ${featureFlagColumns} FROM feature_flags
      WHERE workspace_id=$1 ORDER BY flag_key, scope, scope_id`,
    [context.workspaceId],
  );
  return result.rows;
}

export async function setFeatureFlag(
  pool: Pool,
  context: AuthContext,
  input: FeatureFlagInput,
): Promise<FeatureFlag> {
  const scopeId = input.scope === "global" ? "" : (input.scopeId ?? "");
  if (input.scope !== "global" && !scopeId) {
    throw new WorkspaceAccessError("scopeId is required for company and user scoped flags");
  }
  const current = await pool.query<FeatureFlag>(
    `SELECT ${featureFlagColumns} FROM feature_flags
      WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3 AND flag_key=$4`,
    [context.workspaceId, input.scope, scopeId, input.flagKey],
  );
  const previous = current.rows[0] ?? null;
  if (input.expectedRevision !== undefined && previous && previous.revision !== input.expectedRevision) {
    throw new WorkspaceAccessError("Feature flag changed by another request. Reload and try again.");
  }
  const stage = input.stage ?? previous?.stage ?? "off";
  const enabled = input.enabled ?? previous?.enabled ?? false;
  const rolloutPercent = input.rolloutPercent ?? previous?.rolloutPercent ?? 0;
  const allowlist = input.allowlist ?? previous?.allowlist ?? [];
  const result = await pool.query<FeatureFlag>(
    `INSERT INTO feature_flags
      (id, workspace_id, scope, scope_id, flag_key, stage, enabled, rollout_percent, allowlist, revision, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
      ON CONFLICT (workspace_id, scope, scope_id, flag_key) DO UPDATE
        SET stage=$6, enabled=$7, rollout_percent=$8, allowlist=$9,
            revision=feature_flags.revision+1, updated_by=$10, updated_at=now()
      RETURNING ${featureFlagColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      input.scope,
      scopeId,
      input.flagKey,
      stage,
      enabled,
      rolloutPercent,
      JSON.stringify(allowlist),
      context.userId,
    ],
  );
  await pool.query(
    `INSERT INTO feature_flag_history
      (id, workspace_id, flag_key, scope, scope_id, previous_value, next_value, actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      context.workspaceId,
      input.flagKey,
      input.scope,
      scopeId,
      previous ? JSON.stringify(previous) : null,
      JSON.stringify(result.rows[0]!),
      context.userId,
    ],
  );
  return result.rows[0]!;
}

export async function listFeatureFlagHistory(
  pool: Pool,
  context: AuthContext,
  flagKey?: string,
  limit = 100,
): Promise<FeatureFlagHistoryEntry[]> {
  const result = await pool.query<FeatureFlagHistoryEntry>(
    `SELECT id, workspace_id AS "workspaceId", flag_key AS "flagKey",
      scope, scope_id AS "scopeId", previous_value AS "previousValue", next_value AS "nextValue", actor, created_at AS "createdAt"
      FROM feature_flag_history WHERE workspace_id=$1 AND ($2::text IS NULL OR flag_key=$2)
      ORDER BY created_at DESC LIMIT $3`,
    [context.workspaceId, flagKey ?? null, Math.max(1, Math.min(limit, 500))],
  );
  return result.rows;
}

export async function publishCodeToolManifest(
  pool: Pool,
  _context: AuthContext,
  manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string },
): Promise<CodeToolManifest> {
  const result = await pool.query<CodeToolManifest>(
    `INSERT INTO code_tool_manifest (version, tools, checksum)
      VALUES($1,$2,$3)
      ON CONFLICT (version) DO UPDATE SET tools=$2, checksum=$3
      RETURNING version, tools, checksum, created_at AS "createdAt"`,
    [manifest.version, JSON.stringify(manifest.tools), manifest.checksum],
  );
  return result.rows[0]!;
}

export async function latestCodeToolManifest(
  pool: Pool,
  _context: AuthContext,
): Promise<CodeToolManifest | null> {
  const result = await pool.query<CodeToolManifest>(
    `SELECT version, tools, checksum, created_at AS "createdAt"
      FROM code_tool_manifest ORDER BY version DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function createCodeApprovalRule(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  input: CodeApprovalRuleInput,
): Promise<CodeApprovalRule> {
  await assertCompany(pool, context, companyId);
  if (input.scope === "session" && !input.sessionId) {
    throw new WorkspaceAccessError("A session-scoped approval rule must name its session");
  }
  if (!input.projectId) {
    throw new WorkspaceAccessError("An approval rule must name its project");
  }
  const result = await pool.query<CodeApprovalRule>(
    `INSERT INTO code_approval_rules (
       id, workspace_id, company_id, project_id, session_id, created_by, scope, action, decision, reason, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'allow',$9,$10)
     ON CONFLICT (company_id, COALESCE(project_id,''), COALESCE(session_id,''), scope, action) DO UPDATE
       SET reason=EXCLUDED.reason, expires_at=EXCLUDED.expires_at, created_by=EXCLUDED.created_by,
           revision=code_approval_rules.revision+1, updated_at=now()
     RETURNING ${codeApprovalRuleColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      companyId,
      input.projectId,
      input.sessionId ?? null,
      context.userId,
      input.scope,
      input.action,
      input.reason ?? null,
      input.expiresAt ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function listCodeApprovalRules(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {},
): Promise<CodeApprovalRule[]> {
  await assertCompany(pool, context, companyId);
  const result = await pool.query<CodeApprovalRule>(
    `SELECT ${codeApprovalRuleColumns} FROM code_approval_rules
     WHERE workspace_id=$1 AND company_id=$2
       AND ($3::text IS NULL OR project_id=$3)
       AND ($4::text IS NULL OR session_id=$4)
       AND ($5::text IS NULL OR scope=$5)
     ORDER BY created_at DESC`,
    [context.workspaceId, companyId, filters.projectId ?? null, filters.sessionId ?? null, filters.scope ?? null],
  );
  return result.rows;
}

export async function deleteCodeApprovalRule(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  ruleId: string,
): Promise<void> {
  await assertCompany(pool, context, companyId);
  await pool.query(
    "DELETE FROM code_approval_rules WHERE workspace_id=$1 AND company_id=$2 AND id=$3",
    [context.workspaceId, companyId, ruleId],
  );
}

export async function findMatchingCodeApprovalRule(
  pool: Pool,
  context: AuthContext,
  query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string },
): Promise<CodeApprovalRule | null> {
  await assertCompany(pool, context, query.companyId);

  const result = await pool.query<CodeApprovalRule>(
    `SELECT ${codeApprovalRuleColumns} FROM code_approval_rules
     WHERE workspace_id=$1 AND company_id=$2 AND action=$3 AND decision='allow'
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         (scope='session' AND session_id=$4 AND $4::text IS NOT NULL AND project_id=$5 AND $5::text IS NOT NULL)
         OR (scope='project' AND project_id=$5 AND $5::text IS NOT NULL)
       )
     ORDER BY CASE scope WHEN 'session' THEN 0 ELSE 1 END ASC, created_at DESC
     LIMIT 1`,
    [context.workspaceId, query.companyId, query.action, query.sessionId ?? null, query.projectId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function recordAuditAnchor(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null },
): Promise<AuditAnchor> {
  await assertCompany(pool, context, companyId);
  const result = await pool.query<AuditAnchor>(
    `INSERT INTO audit_anchors
      (id, workspace_id, company_id, day, sequence, entry_count, head_hash, anchor_path, signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id, day) DO UPDATE SET sequence=$5, entry_count=$6, head_hash=$7, anchor_path=$8, signature=$9, created_at=now()
      RETURNING ${auditAnchorColumns}`,
    [
      randomUUID(),
      context.workspaceId,
      companyId,
      anchor.day,
      anchor.sequence,
      anchor.entryCount,
      anchor.headHash,
      anchor.anchorPath ?? null,
      anchor.signature ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function systemRecordAuditAnchor(
  pool: Pool,
  workspaceId: string,
  companyId: string,
  anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null },
): Promise<AuditAnchor> {
  const result = await pool.query<AuditAnchor>(
    `INSERT INTO audit_anchors
      (id, workspace_id, company_id, day, sequence, entry_count, head_hash, anchor_path, signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id, day) DO UPDATE SET sequence=$5, entry_count=$6, head_hash=$7, anchor_path=$8, signature=$9, created_at=now()
      RETURNING ${auditAnchorColumns}`,
    [
      randomUUID(),
      workspaceId,
      companyId,
      anchor.day,
      anchor.sequence,
      anchor.entryCount,
      anchor.headHash,
      anchor.anchorPath ?? null,
      anchor.signature ?? null,
    ],
  );
  return result.rows[0]!;
}
