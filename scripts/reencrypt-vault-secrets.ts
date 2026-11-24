/**
 * Rewrites every CryptoVault ciphertext that only a decrypt-only previous key can read (NPATI_ENCRYPTION_KEY_PREVIOUS)
 * with the current NPATI_ENCRYPTION_KEY. Afterwards the previous key can be removed from the environment.
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/npati_agent \
 *   NPATI_ENCRYPTION_KEY=<new> NPATI_ENCRYPTION_KEY_PREVIOUS=<old> npx tsx scripts/reencrypt-vault-secrets.ts [--dry-run]
 *
 * Every text/varchar/json/jsonb column of every table is scanned, values nested in JSON included, because vault
 * ciphertext is stored in many repositories (API keys, email credentials, browser credentials, Data Studio keys...).
 * Each table is rewritten in its own transaction; a value no key can decrypt is reported and left untouched.
 * Security audit 2026-11-24 (C1). Values are never printed.
 */
import pg from "pg";
import { CryptoVault } from "../packages/workspace/src/crypto-vault";

const CIPHERTEXT = /v1\$[0-9a-f]{32}\$[0-9a-f]{24}\$[0-9a-f]{32}\$[0-9a-f]+/g;
const dryRun = process.argv.includes("--dry-run");

// With `--env-file=.env` the local compose database is reachable on 127.0.0.1 with the .env credentials.
const databaseUrl = process.env.DATABASE_URL || (process.env.NPATI_POSTGRES_PASSWORD
  ? `postgresql://${encodeURIComponent(process.env.NPATI_POSTGRES_USER || "npati")}:${encodeURIComponent(process.env.NPATI_POSTGRES_PASSWORD)}@127.0.0.1:${process.env.NPATI_POSTGRES_PORT || "5432"}/${process.env.NPATI_POSTGRES_DB || "npati_agent"}`
  : undefined);
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!process.env.NPATI_ENCRYPTION_KEY_PREVIOUS) throw new Error("NPATI_ENCRYPTION_KEY_PREVIOUS is required: it names the key being retired");
const vault = new CryptoVault();

let rewritten = 0, current = 0, unreadable = 0;
function reencryptString(value: string): string {
  return value.replace(CIPHERTEXT, (cipher) => {
    try {
      const { plaintext, usedPreviousKey } = vault.decryptWithKeyInfo(cipher);
      if (!usedPreviousKey) { current += 1; return cipher; }
      rewritten += 1;
      return vault.encrypt(plaintext);
    } catch {
      unreadable += 1;
      return cipher;
    }
  });
}
function reencryptJson(value: unknown): unknown {
  if (typeof value === "string") return reencryptString(value);
  if (Array.isArray(value)) return value.map(reencryptJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reencryptJson(item)]));
  return value;
}
const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const columns = await client.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')`);
  for (const column of columns.rows) {
    const table = `${ident(column.table_schema)}.${ident(column.table_name)}`, col = ident(column.column_name);
    const json = column.data_type === "json" || column.data_type === "jsonb";
    const rows = await client.query<{ id: string; value: unknown }>(
      `SELECT ctid::text AS id, ${col} AS value FROM ${table} WHERE ${col}::text ~ $1`, [CIPHERTEXT.source]);
    if (!rows.rowCount) continue;
    const before = rewritten;
    await client.query("BEGIN");
    try {
      for (const row of rows.rows) {
        const next = json ? reencryptJson(row.value) : reencryptString(String(row.value));
        if (JSON.stringify(next) === JSON.stringify(row.value) || dryRun) continue;
        await client.query(`UPDATE ${table} SET ${col} = $1${json ? `::${column.data_type}` : ""} WHERE ctid = $2::tid`, [json ? JSON.stringify(next) : next, row.id]);
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    console.log(`${column.table_schema}.${column.table_name}.${column.column_name}: ${rewritten - before} re-encrypted`);
  }
} finally {
  await client.end();
}
console.log(`${dryRun ? "[dry run] " : ""}re-encrypted ${rewritten}, already current ${current}, unreadable ${unreadable}`);
if (unreadable) process.exitCode = 2;
