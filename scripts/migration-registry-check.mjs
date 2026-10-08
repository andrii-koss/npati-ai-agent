#!/usr/bin/env node
/**
 * G1 (item 3): the migration chain, checked as data instead of as a file count.
 *
 * `scripts/upgrade-gate.mjs` used to assert `fs.existsSync(migration-001..024.ts)` and then print
 * "✓ All 24 migrations present with schema_migrations registration and idempotent DDL" — while the repository
 * had **86** migrations and nothing at all was checked about registration or idempotency. The count and the
 * sentence were both false, and the gate reported confidence it had not measured. This module is the real
 * check for the part that needs **no database**:
 *
 *  1. every migration file `packages/workspace/src/migration-NNN.ts` has a **registration** in
 *     `packages/workspace/src/postgres-store.ts` — a version guard (`SELECT … WHERE version = 'NNN_name'`)
 *     *and* an insert (`INSERT INTO schema_migrations(version) VALUES ('NNN_name')`), because a file nobody
 *     applies and a version recorded without its DDL are two different defects;
 *  2. every registered version has its file, and the numbering has **no gap** — the chain is `001..N`, so a
 *     missing middle migration is reported instead of being skipped over;
 *  3. no version is registered twice (a duplicate would be applied once and its second occurrence silently
 *     dead, which is how a "registration" stops meaning anything).
 *
 * What it deliberately does **not** do is claim idempotency: that is a statement about a real database
 * (running the chain twice changes nothing) and it belongs to the DB part of the same gate —
 * `tests/coding-agent-g1-migrations-postgres.test.ts`, reached through `npm run gate:upgrade:db`. A pure
 * function cannot prove it, and printing "idempotent DDL" without running it is the defect this replaced.
 *
 * The parser is pure over `(storeSource, migrationFiles)`, so the non-vacuity proof is a unit test with an
 * in-memory edit (delete one registration line, delete one version pair) rather than a mutation of the tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where the migrations and their registration live, relative to the repository root. */
export const MIGRATIONS_DIR = "packages/workspace/src";
export const MIGRATION_REGISTRATION_PATH = "packages/workspace/src/postgres-store.ts";

/** `migration-001.ts` → `"001"`; anything else (an `.sql` asset, a `.d.ts`) is not a migration module. */
export function migrationVersionFromFile(file) {
  const match = /^migration-(\d{3})\.ts$/.exec(String(file ?? ""));
  return match?.[1] ?? null;
}

/** The migration modules on disk, as `001`-style numbers, sorted ascending. */
export function migrationFileVersions(files) {
  const numbers = [];
  for (const file of files) {
    const version = migrationVersionFromFile(file);
    if (version !== null) numbers.push(version);
  }
  return numbers.sort();
}

/**
 * The version strings `postgres-store.ts` claims to apply, split by the two things a registration must be:
 * a **guard** (a version lookup that makes the migration conditional) and an **insert** (the row that records
 * it). The first three migrations are registered through one loop over a tuple list, which supplies both.
 */
export function parseRegistration(storeSource) {
  const source = String(storeSource ?? "");
  const collect = (pattern) => {
    const values = [];
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) values.push(value);
    }
    return values;
  };
  const literalGuarded = collect(/schema_migrations\s+WHERE\s+version\s*=\s*'(\d{3}_[a-z0-9_]+)'/gi);
  const literalInserted = collect(/INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*\)\s*VALUES\s*\(\s*'(\d{3}_[a-z0-9_]+)'/gi);
  const loopTuples = collect(/\[\s*["'](\d{3}_[a-z0-9_]+)["']\s*,\s*migration\d{3}\s*\]/g);
  /** The loop's own statements are parameterised (`WHERE version = $1` / `VALUES ($1)`). */
  const loopIsParameterised = /INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*\)\s*VALUES\s*\(\s*\$1\s*\)/i.test(source)
    && /schema_migrations\s+WHERE\s+version\s*=\s*\$1/i.test(source);
  return {
    loopTuples,
    loopIsParameterised,
    guarded: [...literalGuarded, ...loopTuples],
    inserted: [...literalInserted, ...(loopIsParameterised ? loopTuples : [])],
  };
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * The verdict for one registry. Pure over its input, so a test can mutate a copy of either half and watch the
 * verdict go red without touching the repository.
 */
export function validateMigrationRegistry({ storeSource, migrationFiles }) {
  const issues = [];
  const add = (code, detail) => issues.push({ code, detail });
  const parsed = parseRegistration(storeSource);
  const fileVersions = migrationFileVersions(migrationFiles);
  const registered = [...new Set([...parsed.guarded, ...parsed.inserted])].sort();

  if (registered.length === 0) {
    add("migration_registration_unreadable", "no version is registered in postgres-store.ts, so nothing can be compared");
    return { ok: false, issues, versions: { registered, guarded: parsed.guarded, inserted: parsed.inserted, files: fileVersions, loopTuples: parsed.loopTuples } };
  }
  if (!parsed.loopIsParameterised && parsed.loopTuples.length > 0) {
    add(
      "migration_registration_loop_unpaired",
      `the ${parsed.loopTuples.length} tuple-registered migration(s) have no parameterised SELECT/INSERT pair, so they are named but never applied`,
    );
  }

  for (const version of duplicates(parsed.guarded)) add("migration_registration_duplicate_guard", `${version} is guarded twice`);
  for (const version of duplicates(parsed.inserted)) add("migration_registration_duplicate_insert", `${version} is registered twice`);
  for (const version of duplicates(fileVersions)) add("migration_file_duplicate", `migration-${version}.ts exists more than once`);

  const guarded = new Set(parsed.guarded);
  const inserted = new Set(parsed.inserted);
  const onDisk = new Set(fileVersions);

  for (const version of registered) {
    const number = version.slice(0, 3);
    if (!onDisk.has(number)) add("migration_file_missing", `${version} is registered but migration-${number}.ts does not exist`);
    if (!guarded.has(version)) add("migration_registration_guard_missing", `${version} is inserted without a version guard, so it is not applied conditionally`);
    if (!inserted.has(version)) add("migration_registration_insert_missing", `${version} is guarded but never inserted into schema_migrations`);
  }
  for (const number of fileVersions) {
    if (!registered.some((version) => version.startsWith(`${number}_`))) {
      add("migration_file_unregistered", `migration-${number}.ts exists but no version of it is registered, so it is never applied`);
    }
  }

  // A contiguous chain: the numbers that exist must be exactly `first..last`, so a hole is a defect rather
  // than a shorter list that still "has no missing file" for the set it happens to contain.
  const numeric = fileVersions.map(Number).sort((left, right) => left - right);
  if (numeric.length > 0) {
    const first = numeric[0];
    const last = numeric[numeric.length - 1];
    const present = new Set(numeric);
    for (let value = first; value <= last; value += 1) {
      if (!present.has(value)) add("migration_chain_gap", `migration-${String(value).padStart(3, "0")}.ts is missing, so the chain ${String(first).padStart(3, "0")}..${String(last).padStart(3, "0")} is broken`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    versions: {
      registered,
      guarded: parsed.guarded,
      inserted: parsed.inserted,
      files: fileVersions,
      loopTuples: parsed.loopTuples,
    },
  };
}

/** Reads both halves from the repository, so a caller can validate the real input or a mutated copy of it. */
export function readMigrationRegistry(root) {
  return {
    storeSource: readFileSync(path.join(root, MIGRATION_REGISTRATION_PATH), "utf8"),
    migrationFiles: readdirSync(path.join(root, MIGRATIONS_DIR)),
  };
}

/** Reads both halves from the repository and validates them. */
export function checkMigrationRegistry(root) {
  return validateMigrationRegistry(readMigrationRegistry(root));
}

/** The CLI, so a reviewer can see the numbers the gate saw: `node scripts/migration-registry-check.mjs`. */
function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : process.cwd();
  const verdict = checkMigrationRegistry(root);
  const { registered, files } = verdict.versions;
  process.stdout.write(
    `[migration-registry] files=${files.length} registered=${registered.length} ` +
      `first=${registered[0] ?? "-"} last=${registered[registered.length - 1] ?? "-"} issues=${verdict.issues.length}\n`,
  );
  for (const issue of verdict.issues) process.stdout.write(`[migration-registry]   ${issue.code}: ${issue.detail}\n`);
  process.stdout.write(verdict.ok ? "[migration-registry] OK\n" : "[migration-registry] FAILED\n");
  return verdict.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked.endsWith("migration-registry-check.mjs")) process.exit(main(process.argv.slice(2)));
