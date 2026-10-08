/**
 * G1 (D1) replica, part 2: **chains written before the fix keep verifying**.
 *
 * The gate database still holds the entries earlier runs of `tests/coding-agent-c1c-audit-postgres.test.ts`
 * appended while the reader was broken — nine rows across five companies, written by the *write* path, which
 * this change does not touch. Re-reading them now measures exactly the compatibility question: does the new
 * read form reproduce the bytes that were hashed back then?
 *
 * It also cross-checks the store's own read path against a direct read with the column list extracted from
 * the store's source, so the two readings cannot disagree.
 *
 * Read-only: this script changes no row. Temporary probe; not part of the repository's test surface.
 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { PostgresWorkspaceStore, auditEntryHash, verifyAuditEntries, type AuditEntry, type AuthContext } from "@npati/workspace";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate";

/** The same context the DB suite uses, because the rows it wrote belong to its workspace and user. */
const suiteContext: AuthContext = {
  workspaceId: "ws-c1c-db",
  userId: "c1c-db-user",
  permissions: ["workspace:read", "business:manage", "admin:all"],
};

const pool = new Pool({ connectionString: DATABASE_URL });
const store = new PostgresWorkspaceStore(DATABASE_URL);
const summary: unknown[] = [];

/** Recomputes each row's hash from the fields the reader returned — the check the verifier performs. */
function recompute(entries: AuditEntry[]) {
  let prev: string | null = null;
  return entries.map((entry) => {
    const recomputed = auditEntryHash(prev, {
      id: entry.id, companyId: entry.companyId, sequence: entry.sequence, createdAt: entry.createdAt,
      actor: entry.actor, actorRole: entry.actorRole,
      requestId: entry.requestId ?? null, correlationId: entry.correlationId ?? null, snapshotId: entry.snapshotId ?? null,
      action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null, decision: entry.decision, payloadHash: entry.payloadHash,
      metadata: entry.metadata ?? {},
    });
    prev = entry.entryHash;
    return { sequence: entry.sequence, action: entry.action, recomputedEqualsStored: recomputed === entry.entryHash };
  });
}

try {
  const storeSource = await readFile(new URL("../packages/workspace/src/postgres-store.ts", import.meta.url), "utf8");
  const afterMarker = storeSource.slice(storeSource.indexOf("const auditEntryColumns = `") + "const auditEntryColumns = `".length);
  const storeColumnList = afterMarker.slice(0, afterMarker.indexOf("`"));
  console.log("store column list (from source):", storeColumnList.replace(/\s+/g, " ").trim());

  const companies = await pool.query<{ company_id: string; n: number; injected: number; oldest: Date; newest: Date }>(
    `SELECT company_id, count(*)::int AS n,
            count(*) FILTER (WHERE metadata = '{"injected":true}'::jsonb)::int AS injected,
            min(created_at) AS oldest, max(created_at) AS newest
       FROM audit_log GROUP BY company_id ORDER BY 4`);
  console.log("companies found after the probe's own cleanup:", companies.rowCount);

  for (const row of companies.rows) {
    const entries = await pool.query<AuditEntry>(`SELECT ${storeColumnList} FROM audit_log WHERE company_id=$1 ORDER BY sequence ASC`, [row.company_id]);
    const raw = verifyAuditEntries(entries.rows);
    let viaStore: unknown;
    try {
      viaStore = await store.verifyAuditChain(suiteContext, row.company_id);
    } catch (error) {
      viaStore = `store.verifyAuditChain refused the read: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`\ncompany ${row.company_id}  rows=${row.n}  written=${row.oldest.toISOString()}..${row.newest.toISOString()}  rowsCarryingTheSuitesDeliberateTamper=${row.injected}`);
    console.log("  row types from the fixed reader:", entries.rows.map((entry) => ({ sequence: entry.sequence, sequenceType: typeof entry.sequence, createdAt: entry.createdAt, createdAtType: typeof entry.createdAt })));
    console.log("  recomputed hash == stored hash:", recompute(entries.rows));
    console.log("  verifyAuditEntries over the direct read:", { ok: raw.ok, entryCount: raw.entryCount, brokenAtSequence: raw.brokenAtSequence ?? null, reason: raw.reason ?? null, headHash: raw.headHash });
    console.log("  store.verifyAuditChain:", typeof viaStore === "string" ? viaStore : { ok: (viaStore as { ok: boolean }).ok, entryCount: (viaStore as { entryCount: number }).entryCount, brokenAtSequence: (viaStore as { brokenAtSequence?: number }).brokenAtSequence ?? null, reason: (viaStore as { reason?: string }).reason ?? null, headHash: (viaStore as { headHash: string | null }).headHash });
    summary.push({
      companyId: row.company_id, rows: row.n, rowsCarryingTheSuitesDeliberateTamper: row.injected,
      allRowHashesReproduce: recompute(entries.rows).every((entry) => entry.recomputedEqualsStored),
      ok: raw.ok, brokenAtSequence: raw.brokenAtSequence ?? null, reason: raw.reason ?? null,
      storePathAgrees: typeof viaStore !== "string" && (viaStore as { ok: boolean }).ok === raw.ok && ((viaStore as { brokenAtSequence?: number }).brokenAtSequence ?? null) === (raw.brokenAtSequence ?? null),
    });
  }
  console.log("\n=== MACHINE-READABLE SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.log("\nPROBE FAILED:", error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error));
  process.exitCode = 1;
} finally {
  await store.close();
  await pool.end();
}
