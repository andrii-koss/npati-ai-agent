import { Pool } from "pg";
const pool = new Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate" });
console.log("audit_log rows total:", (await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0]);
console.log("app role present:", (await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='npati_g1_app'")).rows[0]);
console.log("scratch databases left:", (await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'npati_g1_migrations%'")).rows);
console.log("trigger state:", (await pool.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND NOT tgisinternal ORDER BY tgname")).rows);
await pool.end();
