import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataProvider } from "./data-provider";
import type { DataBackendRepository } from "./repository";
import type { DataBackend } from "./types";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError, quoteIdentifier } from "./identifier";

export interface RowTransferInput {
  source: string; target: string; ids: string[];
  fields: Array<{ source: string; target: string }>;
  mode: "copy" | "move"; expectedFingerprint: string; dryRun?: boolean;
}

/** Explicit rows only; no SQL from the model. Inserts and deletes commit together. */
export async function transferProjectRows(ctx: AuthContext, backend: DataBackend, input: RowTransferInput,
  provisioner: DatabaseProvisioner, provider: DataProvider, repository: DataBackendRepository) {
  const source = quoteIdentifier(input.source), target = quoteIdentifier(input.target);
  if (source === target || !["copy", "move"].includes(input.mode) || !input.expectedFingerprint ||
      !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000 || new Set(input.ids).size !== input.ids.length ||
      input.ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      !Array.isArray(input.fields) || !input.fields.length || input.fields.length > 100 ||
      new Set(input.fields.map(f => f.target)).size !== input.fields.length || input.fields.some(f => f.source === "id" || f.target === "id")) {
    throw new DataStudioError(400, "transfer", "Invalid transfer; select 1–1000 distinct row IDs and explicit field mappings", false, "INVALID_TRANSFER");
  }
  for (const field of input.fields) { quoteIdentifier(field.source); quoteIdentifier(field.target); }
  const stored = await repository.get(ctx, backend.companyId, backend.id);
  const env = await repository.environment(ctx, backend.companyId, backend.id, "dev");
  if (stored.status !== "ready" || env.status !== "ready" || env.syncStatus !== "synced") throw new DataStudioError(409, "transfer", "Database requires reconciliation", false, "DRIFT_BLOCKED");
  const token = randomUUID();
  if (!await repository.acquireLock(backend.id, "dev", token, 120_000)) throw new DataStudioError(409, "transfer", "Migration already in progress", true, "MIGRATION_BUSY");
  let pool: Pool | undefined;
  try {
    pool = new Pool({ ...await provisioner.getConnection(stored, "dev", "migrator"), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      // Deterministic order avoids deadlocks for opposite transfers.
      await client.query("LOCK TABLE " + [source, target].sort().join(",") + " IN SHARE ROW EXCLUSIVE MODE");
      const schema = await provider.introspectSchema(stored, "dev");
      if (provider.schemaFingerprint(schema) !== input.expectedFingerprint || env.schemaFingerprint !== input.expectedFingerprint) throw new DataStudioError(409, "transfer", "Schema changed concurrently", false, "STALE_SCHEMA");
      const from = schema.tables.find(t => t.name === input.source), to = schema.tables.find(t => t.name === input.target);
      if (!from || !to || input.fields.some(f => !from.columns.some(c => c.name === f.source) || !to.columns.some(c => c.name === f.target))) throw new DataStudioError(400, "transfer", "Unknown table or field", false, "INVALID_TRANSFER");
      const usage = await provisioner.getUsage(stored, "dev");
      provider.assertLimits("row_transfer", schema, usage.bytes, input.target);
      // Ownership columns must retain their meaning when transferring shared application data.
      for (const name of ["user_id", "owner_id"]) {
        if (from.columns.some(c => c.name === name) && !input.fields.some(f => f.source === name && f.target === name)) throw new DataStudioError(400, "transfer", "Ownership fields must be preserved", false, "INVALID_TRANSFER");
      }
      const selected = await client.query("SELECT id FROM " + source + " WHERE id=ANY($1::uuid[]) FOR UPDATE", [input.ids]);
      if (selected.rowCount !== input.ids.length) throw new DataStudioError(409, "transfer", "Some source rows no longer exist", false, "SOURCE_ROWS_CHANGED");
      if (input.dryRun) {
        await client.query("ROLLBACK");
        return { dryRun: true, source: input.source, target: input.target, mode: input.mode, rows: input.ids.length, fields: input.fields, preservesIds: true };
      }
      const snapshot = input.mode === "move" ? await provisioner.snapshot(stored, "dev") : undefined;
      const inserted = await client.query("INSERT INTO " + target + " (id," + input.fields.map(f => quoteIdentifier(f.target)).join(",") + ") SELECT id," + input.fields.map(f => quoteIdentifier(f.source)).join(",") + " FROM " + source + " WHERE id=ANY($1::uuid[]) RETURNING id", [input.ids]);
      if (inserted.rowCount !== input.ids.length) throw new DataStudioError(409, "transfer", "Transfer was incomplete", false, "TRANSFER_INCOMPLETE");
      if (input.mode === "move") {
        const deleted = await client.query("DELETE FROM " + source + " WHERE id=ANY($1::uuid[]) RETURNING id", [input.ids]);
        if (deleted.rowCount !== input.ids.length) throw new DataStudioError(409, "transfer", "Source deletion was incomplete", false, "TRANSFER_INCOMPLETE");
      }
      const id = randomUUID();
      await client.query("CREATE TABLE IF NOT EXISTS _npati_data_transfers(id uuid PRIMARY KEY, author_id text NOT NULL, operation jsonb NOT NULL, snapshot_ref text, applied_at timestamptz NOT NULL DEFAULT now())");
      await client.query("INSERT INTO _npati_data_transfers(id,author_id,operation,snapshot_ref) VALUES($1,$2,$3::jsonb,$4)", [id, ctx.userId, JSON.stringify(input), snapshot?.id ?? null]);
      await client.query("COMMIT");
      return { applied: true, transferId: id, source: input.source, target: input.target, mode: input.mode, rows: inserted.rowCount, snapshotId: snapshot?.id ?? null };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } finally { await pool?.end(); await repository.releaseLock(backend.id, "dev", token); }
}
