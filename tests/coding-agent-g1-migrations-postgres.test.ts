import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore } from "@npati/workspace";
import { checkMigrationRegistry } from "../scripts/migration-registry-check.mjs";
import { databaseDescribe, missingDatabaseSkip } from "./support/database-describe";
import { runWithCleanup } from "./support/run-with-cleanup";

/**
 * G1 (item 3): the **database half** of the upgrade gate — the statements `scripts/upgrade-gate.mjs` must not
 * print without measuring.
 *
 * The step used to assert that `migration-001..024.ts` exist and then print "✓ All 24 migrations present with
 * schema_migrations registration and idempotent DDL" — a false count, an unchecked registration and an
 * *unmeasured* claim about idempotency. The static half (`scripts/migration-registry-check.mjs`) now measures
 * files, guards, registrations and chain continuity without a database; this suite measures the two facts no
 * pure function can:
 *
 *  1. **The upgrade path on a clean database.** A database created for this test receives exactly the registered
 *     version set — not a set that "contains" it, the same set, in the same order, with the file numbers matching
 *     one-to-one. A migration that is registered but fails to apply, or a file nobody applies, is a failure here.
 *  2. **Idempotency, measured twice.** A second `initialize()` on the same database changes `schema_migrations`
 *     by nothing — compared by the rows *and* their `applied_at` timestamps, so "ran again and rewrote the rows"
 *     is also a failure. Then the chain is rewound two versions (the recorded rows for `085`/`086` are deleted,
 *     which is what an older deployment looks like) and the same `initialize()` must bring it forward: the DDL of
 *     those migrations really is re-runnable, which is the only way to know that the old sentence was true.
 *
 * `npm run gate:upgrade:db` runs this suite and **requires** `DATABASE_URL` (a missing value fails immediately,
 * never skips); `NPATI_SECURITY_GATE_DB=1` is required as well, so a plain `npm test` never reaches a database.
 * Every database it creates is named after a UUID and dropped in the same run, so it can point at any PostgreSQL
 * 17 with the pgvector extension (the same image `docker-compose.yml` uses). The connection must be allowed to
 * `CREATE DATABASE` — it is the same administrative connection the migrations themselves need, and a role without
 * that privilege fails here with PostgreSQL's own `permission denied to create database` rather than passing.
 */
const databaseUrl = process.env.DATABASE_URL;
const databaseGateRequested = process.env.NPATI_SECURITY_GATE_DB === "1";
const databaseGateRunning = Boolean(databaseUrl) && databaseGateRequested;
const describeDatabase = databaseDescribe(
  databaseGateRunning,
  describe,
  typeof describe.skip === "function"
    ? describe.skip
    : (name: string) => missingDatabaseSkip(name),
);
const databaseNote = databaseGateRunning
  ? ""
  : " [SKIPPED: run `npm run gate:upgrade:db`, which requires DATABASE_URL and is never skipped]";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The same connection string pointed at another database, with every other field untouched. */
function againstDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Creates a throwaway database, runs `body` against it and drops it again. The teardown goes through
 * `runWithCleanup`, so a failing assertion is never replaced by a failing cleanup (`DROP DATABASE` is issued
 * with `IF EXISTS`, so a body that never reached `CREATE DATABASE` still cleans up).
 */
async function withFreshDatabase<T>(body: (input: { store: PostgresWorkspaceStore; pool: Pool }) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: String(databaseUrl) });
  const name = `npati_g1_migrations_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const url = againstDatabase(String(databaseUrl), name);
  const store = new PostgresWorkspaceStore(url);
  const pool = new Pool({ connectionString: url });
  return runWithCleanup(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    return body({ store, pool });
  }, async () => {
    await pool.end();
    await store.close();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });
}

/** Every row of the chain registry, as the database really holds it (epoch text keeps microseconds). */
async function appliedRows(pool: Pool): Promise<{ version: string; applied_at: Date; applied_epoch: string }[]> {
  const result = await pool.query<{ version: string; applied_at: Date; applied_epoch: string }>(
    "SELECT version, applied_at, extract(epoch from applied_at)::text AS applied_epoch FROM schema_migrations ORDER BY version",
  );
  return result.rows;
}

describeDatabase(`upgrade-gate: G1 migration chain on a real database${databaseNote}`, () => {
  it("applies exactly the registered version set to a clean database, and nothing else", async () => {
    // The expectation comes from the same module the static half of the gate uses, so the two halves cannot
    // drift into two different ideas of "the chain".
    const registry = checkMigrationRegistry(root);
    expect(registry.issues).toEqual([]);
    expect(registry.ok).toBe(true);

    await withFreshDatabase(async ({ store, pool }) => {
      await store.initialize();
      const rows = await appliedRows(pool);
      const applied = rows.map((row) => row.version);
      expect(applied).toEqual(registry.versions.registered);
      // One registration per migration module, and the file numbers match the registered versions' numbers:
      // a file without a registration and a registration without a file are both caught here on a real chain.
      expect(applied.length).toBe(registry.versions.files.length);
      expect(applied.map((version) => version.slice(0, 3))).toEqual(registry.versions.files);
      expect(new Set(applied).size).toBe(applied.length);
    });
  }, 180_000);

  it("is idempotent on a second run and brings an older database forward", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      await store.initialize();
      const first = await appliedRows(pool);
      expect(first.length).toBeGreaterThan(0);

      // Second run: the same rows, the same timestamps. "Ran again" is not enough — a run that rewrote the
      // registry would be indistinguishable from one that changed nothing if only the version set were compared.
      await store.initialize();
      const second = await appliedRows(pool);
      expect(second).toEqual(first);

      // An older deployment: the last two registrations are gone while their DDL is still in place. Bringing it
      // forward re-executes those two migrations against objects that already exist, which is the idempotency of
      // the DDL itself — the claim the upgrade gate used to print without running anything.
      const tail = first.slice(-2).map((row) => row.version);
      expect(tail.length).toBe(2);
      const removed = await pool.query("DELETE FROM schema_migrations WHERE version = ANY($1::text[])", [tail]);
      expect(removed.rowCount).toBe(2);
      await store.initialize();
      const recovered = await appliedRows(pool);
      expect(recovered.map((row) => row.version)).toEqual(first.map((row) => row.version));
      // …and the re-applied rows are really new rows: the guard saw them as missing, which is what makes this a
      // forward migration rather than a no-op that "kept" the old timestamps. Compared at the precision the
      // database stores (microseconds), not at the millisecond precision of a JavaScript `Date`.
      expect(recovered.slice(-2).map((row) => row.applied_epoch))
        .not.toEqual(first.slice(-2).map((row) => row.applied_epoch));
    });
  }, 180_000);
});
