import { Pool } from "pg";
const pool = new Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });
console.log(JSON.stringify((await pool.query(`SELECT workspace_id, company_id, count(*)::int AS n, min(created_at) AS first, max(created_at) AS last,
  count(*) FILTER (WHERE metadata = '{"injected":true}'::jsonb)::int AS injected FROM audit_log GROUP BY 1,2 ORDER BY 4`)).rows, null, 2));
console.log("total:", (await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0]);
await pool.end();
