import { Pool } from "pg";
import { assertCompany } from "./postgres-store-support";
import { randomUUID } from "node:crypto";
import type { AuditAnchor, AuditChainState, AuditChainVerification, AuditEntry, AuditEntryInput, AuthContext } from "./types";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { auditAnchorColumns, auditEntryColumns } from "./postgres-store-schema";
export async function appendAuditEntry(pool: Pool, context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> {
    await assertCompany(pool, context, companyId);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`audit:${companyId}`]);
        const head = await client.query<{
            sequence: string;
            entry_hash: string;
        }>("SELECT sequence, entry_hash FROM audit_log WHERE company_id=$1 ORDER BY sequence DESC LIMIT 1", [companyId]);
        const prevHash = head.rows[0]?.entry_hash ?? null;
        const sequence = head.rows[0] ? Number(head.rows[0].sequence) + 1 : 1;
        const createdAt = new Date().toISOString();
        const id = randomUUID();
        const metadata = input.metadata ?? {};
        const entryHash = auditEntryHash(prevHash, {
            id, companyId, sequence, createdAt, actor: input.actor, actorRole: input.actorRole,
            requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
            action: input.action, resourceType: input.resourceType, resourceId: input.resourceId ?? null,
            projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash, metadata,
        });
        const inserted = await client.query<AuditEntry>(`INSERT INTO audit_log
        (id, workspace_id, company_id, sequence, created_at, actor, actor_role, request_id, correlation_id, snapshot_id,
         action, resource_type, resource_id, project_id, decision, payload_hash, prev_hash, entry_hash, metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING ${auditEntryColumns}`, [id, context.workspaceId, companyId, sequence, createdAt, input.actor, input.actorRole,
            input.requestId ?? null, input.correlationId ?? null, input.snapshotId ?? null,
            input.action, input.resourceType, input.resourceId ?? null, input.projectId ?? null,
            input.decision, input.payloadHash, prevHash, entryHash, JSON.stringify(metadata)]);
        await client.query("COMMIT");
        return inserted.rows[0]!;
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}
export async function listAuditEntries(pool: Pool, context: AuthContext, companyId: string, filters: {
    actor?: string;
    requestId?: string;
    correlationId?: string;
    action?: string;
    limit?: number;
    fromSequence?: number;
} = {}): Promise<AuditEntry[]> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text IS NULL OR actor=$3)
        AND ($4::text IS NULL OR request_id=$4)
        AND ($5::text IS NULL OR correlation_id=$5)
        AND ($6::text IS NULL OR action=$6)
        AND ($7::bigint IS NULL OR sequence >= $7)
      ORDER BY sequence ASC LIMIT $8`, [context.workspaceId, companyId, filters.actor ?? null, filters.requestId ?? null, filters.correlationId ?? null,
        filters.action ?? null, filters.fromSequence ?? null, Math.max(1, Math.min(filters.limit ?? 200, 1000))]);
    return result.rows;
}
export async function verifyAuditChain(pool: Pool, context: AuthContext, companyId: string, range: {
    fromSequence?: number;
    toSequence?: number;
} = {}): Promise<AuditChainVerification> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::bigint IS NULL OR sequence <= $3)
      ORDER BY sequence ASC`, [context.workspaceId, companyId, range.toSequence ?? null]);
    return { ...verifyAuditEntries(result.rows), companyId,
        entryCount: result.rows.filter(entry => range.fromSequence === undefined || entry.sequence >= range.fromSequence).length };
}
export async function auditChainState(pool: Pool, context: AuthContext, companyId: string): Promise<AuditChainState> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<{
        entry_count: string;
        head_sequence: string | null;
        head_hash: string | null;
    }>("SELECT count(*)::text AS entry_count, max(sequence)::text AS head_sequence, (array_agg(entry_hash ORDER BY sequence DESC))[1] AS head_hash FROM audit_log WHERE company_id=$1", [companyId]);
    const row = result.rows[0];
    return {
        companyId,
        entryCount: Number(row?.entry_count ?? 0),
        headSequence: Number(row?.head_sequence ?? 0),
        headHash: row?.head_hash ?? null,
    };
}
export async function listAuditAnchors(pool: Pool, context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<AuditAnchor>(`SELECT ${auditAnchorColumns} FROM audit_anchors
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY day DESC LIMIT $3`, [context.workspaceId, companyId, Math.max(1, Math.min(limit, 365))]);
    return result.rows;
}
export async function auditCompanies(pool: Pool, context: AuthContext): Promise<string[]> {
    const result = await pool.query<{
        company_id: string;
    }>("SELECT DISTINCT company_id FROM audit_log WHERE workspace_id=$1 ORDER BY company_id", [context.workspaceId]);
    return result.rows.map((row) => row.company_id);
}
export async function systemAuditChains(pool: Pool, workspaceId: string) {
    const companies = await pool.query<{
        company_id: string;
    }>("SELECT company_id FROM audit_log WHERE workspace_id=$1 UNION SELECT company_id FROM audit_anchors WHERE workspace_id=$1 ORDER BY company_id", [workspaceId]);
    const result: Array<{
        companyId: string;
        state: AuditChainState;
        verification: AuditChainVerification;
        anchor: AuditAnchor | null;
        anchorVerification?: AuditChainVerification;
    }> = [];
    for (const row of companies.rows) {
        const entries = await pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
        WHERE workspace_id=$1 AND company_id=$2 ORDER BY sequence ASC`, [workspaceId, row.company_id]);
        const verification = verifyAuditEntries(entries.rows);
        const last = entries.rows[entries.rows.length - 1];
        const anchors = await pool.query<AuditAnchor>(`SELECT ${auditAnchorColumns} FROM audit_anchors WHERE workspace_id=$1 AND company_id=$2 ORDER BY day DESC LIMIT 1`, [workspaceId, row.company_id]);
        const anchor = anchors.rows[0] ?? null;
        result.push({
            companyId: row.company_id,
            state: { companyId: row.company_id, entryCount: entries.rows.length, headSequence: last?.sequence ?? 0, headHash: last?.entryHash ?? null },
            verification: { ...verification, companyId: row.company_id }, anchor,
            anchorVerification: anchor ? { ...verifyAuditEntries(entries.rows.filter(entry => entry.sequence <= anchor.sequence)), companyId: row.company_id } : undefined,
        });
    }
    return result;
}
