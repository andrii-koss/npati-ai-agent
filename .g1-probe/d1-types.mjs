/**
 * G1 (D1) probe: what JavaScript types does `pg` hand back for the audit row?
 *
 * Temporary probe; not part of the repository's test surface.
 */
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });
const r = await pool.query(`SELECT 1::bigint AS seq, now() AS ts, 1::bigint AS "sequence",
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso`,
);
const row = r.rows[0];
console.log("types:", Object.fromEntries(Object.entries(row).map(([k, v]) => [k, `${typeof v}${v instanceof Date ? "(Date)" : ""} -> ${JSON.stringify(v)}`])));
console.log("typeof row.sequence === 'string':", typeof row.sequence === "string");
console.log("typeof row.ts === 'object' && Date:", row.ts instanceof Date);
console.log("Date -> canonicalJson:", JSON.stringify(canonicalish(row.ts)));
console.log("SHOW TimeZone:", (await pool.query("SHOW TimeZone")).rows[0]);
await pool.end();

function canonicalish(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return value.map(canonicalish);
  return Object.fromEntries(Object.entries(value));
}
