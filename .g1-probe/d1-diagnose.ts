/** Diagnostic: dump every column of the pre-existing rows and brute-force which material variant reproduces each stored hash. */
import { Pool } from "pg";
import { auditEntryHash, canonicalJson, type AuditEntry } from "@npati/workspace";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });
const rows = await pool.query<AuditEntry & { created_at_raw: Date; created_at_text: string }>(
  `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", sequence::int AS "sequence",
          created_at AS created_at_raw,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_text,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_micro,
          actor, actor_role AS "actorRole", request_id AS "requestId", correlation_id AS "correlationId",
          snapshot_id AS "snapshotId", action, resource_type AS "resourceType", resource_id AS "resourceId",
          project_id AS "projectId", decision, payload_hash AS "payloadHash",
          prev_hash AS "prevHash", entry_hash AS "entryHash", metadata
     FROM audit_log ORDER BY company_id, sequence`);

for (const row of rows.rows) {
  console.log(`\n--- company ${row.companyId} sequence ${row.sequence} action=${row.action}`);
  console.log("  id:", row.id);
  console.log("  created_at raw:", row.created_at_raw?.toISOString?.() ?? String(row.created_at_raw), "| to_char MS:", row.created_at_text, "| US:", row.created_at_micro);
  console.log("  actor/role:", JSON.stringify(row.actor), JSON.stringify(row.actorRole));
  console.log("  requestId/correlationId/snapshotId:", JSON.stringify(row.requestId), JSON.stringify(row.correlationId), JSON.stringify(row.snapshotId));
  console.log("  resourceType/resourceId/projectId/decision:", JSON.stringify(row.resourceType), JSON.stringify(row.resourceId), JSON.stringify(row.projectId), JSON.stringify(row.decision));
  console.log("  payloadHash:", row.payloadHash, "| prevHash:", row.prevHash, "| entryHash:", row.entryHash);
  console.log("  metadata:", JSON.stringify(row.metadata));

  const base = {
    id: row.id, companyId: row.companyId, sequence: row.sequence, createdAt: row.created_at_text,
    actor: row.actor, actorRole: row.actorRole,
    requestId: row.requestId ?? null, correlationId: row.correlationId ?? null, snapshotId: row.snapshotId ?? null,
    action: row.action, resourceType: row.resourceType, resourceId: row.resourceId ?? null,
    projectId: row.projectId ?? null, decision: row.decision, payloadHash: row.payloadHash,
    metadata: row.metadata ?? {},
  };
  // Which variant of the material reproduces the stored hash? Each flag varies one decision independently.
  const variants: Array<[string, Record<string, unknown>]> = [];
  for (const nullsAsAbsent of [false, true]) {
    for (const sequenceAsString of [false, true]) {
      for (const metadataAsEmpty of [false, true]) {
        for (const createdAtMicro of [false, true]) {
          const material: Record<string, unknown> = { ...base };
          if (nullsAsAbsent) for (const key of ["requestId", "correlationId", "snapshotId", "resourceId", "projectId"]) delete material[key];
          if (sequenceAsString) material.sequence = String(row.sequence);
          if (metadataAsEmpty) material.metadata = {};
          if (createdAtMicro) material.createdAt = row.created_at_micro;
          variants.push([`nullsAsAbsent=${nullsAsAbsent} seqAsString=${sequenceAsString} emptyMetadata=${metadataAsEmpty} micro=${createdAtMicro}`, material]);
        }
      }
    }
  }
  const matches = variants.filter(([, material]) => auditEntryHash(row.prevHash, material as never) === row.entryHash);
  console.log("  variants reproducing the stored hash:", matches.length ? matches.map(([label]) => label) : "NONE");
  console.log("  hash over the canonical material:", auditEntryHash(row.prevHash, base as never) === row.entryHash);
  console.log("  canonicalJson material:", canonicalJson(base).slice(0, 400));
}
await pool.end();
