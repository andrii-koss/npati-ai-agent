/**
 * G1 (D1) probe: is the gate database reachable from this sandbox at all?
 *
 * Temporary probe; not part of the repository's test surface.
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate";
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  const r = await pool.query("SELECT current_user, current_database(), version() AS v, now() AS n");
  console.log("CONNECT OK");
  console.log(JSON.stringify(r.rows[0], null, 2));
  const t = await pool.query("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS iso, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') = $1 AS never", [new Date().toISOString()]);
  console.log("TO_CHAR SAMPLE:", JSON.stringify(t.rows[0]));
} catch (error) {
  console.log("CONNECT FAILED:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
