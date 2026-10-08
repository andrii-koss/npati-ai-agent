/**
 * G1 (D1) replica, part 3: are the leftover rows even chains the append path can create?
 *
 * Two of the five leftover companies fail verification, and their per-row hashes do not reproduce under any
 * variant of the material (see `d1-diagnose.out.txt`). This script measures **why**, structurally:
 *
 *  1. `prev_hash` linkage — a real chain has `entry[n].prev_hash === entry[n-1].entry_hash`, because
 *     `appendAuditEntry` reads the head and the migration 066 `audit_log_chain_guard` trigger independently
 *     refuses any INSERT whose `prev_hash` differs from the current head. The failing companies violate it;
 *  2. the guard really does refuse that shape — the identical two rows are inserted into a throwaway company
 *     through the normal path and the second INSERT must be rejected as a chain violation. A row of that
 *     shape can therefore only exist if it was written with the trigger disabled, i.e. never by a writer;
 *  3. `payload_hash` — `AuditLogService.record` always hashes a payload, so `'x'` marks a hand-written row.
 *
 * The throwaway rows are deleted again in the same run. Temporary probe; not part of the repository's tests.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });
const summary: unknown[] = [];

try {
  const companies = await pool.query<{ company_id: string }>("SELECT DISTINCT company_id FROM audit_log ORDER BY 1");
  console.log("=== 1. prev_hash linkage per leftover company (read-only) ===");
  for (const { company_id } of companies.rows) {
    const rows = await pool.query<{ sequence: number; prev_hash: string | null; entry_hash: string; payload_hash: string; actor: string }>(
      `SELECT sequence::int AS sequence, prev_hash, entry_hash, payload_hash, actor FROM audit_log WHERE company_id=$1 ORDER BY sequence`, [company_id]);
    const links = rows.rows.slice(1).map((row, index) => ({
      sequence: row.sequence,
      prevHashEqualsPreviousEntryHash: row.prev_hash === rows.rows[index]!.entry_hash,
    }));
    const report = {
      companyId: company_id, rows: rows.rowCount,
      actors: [...new Set(rows.rows.map((row) => row.actor))],
      payloadHashes: [...new Set(rows.rows.map((row) => row.payload_hash))],
      links,
      chainShapeIsReachable: links.every((link) => link.prevHashEqualsPreviousEntryHash),
    };
    console.log(JSON.stringify(report));
    summary.push(report);
  }

  console.log("\n=== 2. the chain guard refuses that shape (throwaway company, rows removed afterwards) ===");
  const throwaway = `d1-linkage-${randomUUID()}`;
  const first = { id: randomUUID(), sequence: 1, prevHash: null, entryHash: "e".repeat(64), prevHashOfSecond: "a".repeat(64), entryHashOfSecond: "c".repeat(64) };
  const insert = (row: { id: string; sequence: number; prevHash: string | null; entryHash: string }) => pool.query(
    `INSERT INTO audit_log (id, workspace_id, company_id, sequence, created_at, actor, actor_role, action, resource_type, decision, payload_hash, prev_hash, entry_hash, metadata)
     VALUES ($1,'ws-g1-d1-probe',$2,$3,now(),'probe','admin','linkage','test','allowed','x',$4,$5,'{}'::jsonb)`,
    [row.id, throwaway, row.sequence, row.prevHash, row.entryHash]);
  await insert(first);
  const rejected = await insert({ id: randomUUID(), sequence: 2, prevHash: first.prevHashOfSecond, entryHash: first.entryHashOfSecond })
    .then(() => "NOT REJECTED (unexpected)")
    .catch((error: Error) => error.message);
  console.log("second INSERT with prev_hash != head:", rejected);
  // The same two rows with a correct linkage are accepted, which is what makes the refusal specific.
  const accepted = await insert({ id: randomUUID(), sequence: 2, prevHash: first.entryHash, entryHash: "d".repeat(64) })
    .then(() => "accepted (expected: the linkage is what the guard checks)")
    .catch((error: Error) => `rejected (unexpected): ${error.message}`);
  console.log("second INSERT with prev_hash == head:", accepted);
  await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  try { console.log("throwaway rows deleted:", (await pool.query("DELETE FROM audit_log WHERE company_id=$1", [throwaway])).rowCount); }
  finally { await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only"); }
  console.log("rows left for the throwaway company:", (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1", [throwaway])).rows[0]);

  console.log("\n=== MACHINE-READABLE SUMMARY ===");
  console.log(JSON.stringify({ linkage: summary, guardRefusals: { wrongLinkage: rejected, correctLinkage: accepted } }, null, 2));
} catch (error) {
  console.log("\nPROBE FAILED:", error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
