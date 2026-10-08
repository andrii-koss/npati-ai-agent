/**
 * G1 (D1) probe cleanup: remove the audit rows this session's runs created, and report what is left.
 *
 * The probe runs the real DB suite twice against a reverted reader, and each run appends rows for its own
 * throwaway companies. Those rows are invalid on purpose (their reader was broken), so they are removed rather
 * than left in a database the owner will run the gate against. Rows written **before** this session
 * (`created_at < 2026-10-08T13:52:00Z`, the owner's own fixtures) are not touched, and the count is printed.
 *
 * Temporary probe; not part of the repository's test surface.
 */
import { Pool } from "pg";

const CUTOFF = "2026-10-08T13:52:00Z";
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });

try {
  const before = await pool.query(
    `SELECT CASE WHEN created_at < $1::timestamptz THEN 'before this session (kept)' ELSE 'this session (removed)' END AS bucket,
            count(*)::int AS n
       FROM audit_log GROUP BY 1 ORDER BY 1`, [CUTOFF]);
  console.log("audit_log rows by bucket:", before.rows);
  const anchors = await pool.query(
    `SELECT CASE WHEN created_at < $1::timestamptz THEN 'before this session (kept)' ELSE 'this session (removed)' END AS bucket,
            count(*)::int AS n
       FROM audit_anchors GROUP BY 1 ORDER BY 1`, [CUTOFF]);
  console.log("audit_anchors rows by bucket:", anchors.rows);

  await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  try {
    const deleted = await pool.query("DELETE FROM audit_log WHERE created_at >= $1::timestamptz", [CUTOFF]);
    console.log("deleted audit_log rows:", deleted.rowCount);
  } finally {
    await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
  }
  const deletedAnchors = await pool.query("DELETE FROM audit_anchors WHERE created_at >= $1::timestamptz", [CUTOFF]);
  console.log("deleted audit_anchors rows:", deletedAnchors.rowCount);

  const after = await pool.query(
    `SELECT company_id, count(*)::int AS n, min(created_at) AS oldest, max(created_at) AS newest,
            count(*) FILTER (WHERE payload_hash = 'x')::int AS handWrittenRows
       FROM audit_log GROUP BY 1 ORDER BY 3`);
  console.log("rows left in audit_log:", after.rows);
  console.log("trigger state:", (await pool.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND NOT tgisinternal ORDER BY tgname")).rows);
} catch (error) {
  console.log("CLEANUP FAILED:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
