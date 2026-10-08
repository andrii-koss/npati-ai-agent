/**
 * Types for `scripts/migration-registry-check.mjs`, so a suite that reads the upgrade gate's migration contract
 * can be part of `npm run typecheck:tests` (the same pattern `scripts/run-security-gate.d.mts` uses).
 *
 * The inputs are structural and the registry halves are read from disk by the caller, which is what makes the
 * non-vacuity proof an in-memory edit of a copy rather than a mutation of the tree.
 */

export declare const MIGRATIONS_DIR: string;
export declare const MIGRATION_REGISTRATION_PATH: string;

export interface MigrationRegistryIssue {
  code: string;
  detail: string;
}

export interface MigrationRegistryVersions {
  /** Every version string the store registers, sorted. */
  registered: string[];
  /** The versions with a `WHERE version = '…'` guard (literal or the parameterised tuple loop). */
  guarded: string[];
  /** The versions with an `INSERT INTO schema_migrations` registration (literal or the tuple loop). */
  inserted: string[];
  /** The `001`-style numbers of the migration modules on disk, sorted. */
  files: string[];
  /** The versions registered through the `001..003` tuple loop. */
  loopTuples: string[];
}

export interface MigrationRegistryVerdict {
  ok: boolean;
  issues: MigrationRegistryIssue[];
  versions: MigrationRegistryVersions;
}

/** `migration-001.ts` → `"001"`; `null` for anything that is not a migration module. */
export declare function migrationVersionFromFile(file: unknown): string | null;
/** The `001`-style numbers of the migration modules in a directory listing, sorted. */
export declare function migrationFileVersions(files: readonly string[]): string[];
/** The version strings the store claims to apply, split into guards and registrations. */
export declare function parseRegistration(storeSource: unknown): {
  loopTuples: string[];
  loopIsParameterised: boolean;
  guarded: string[];
  inserted: string[];
};
/** The verdict for one (source, file list) pair — pure, so a mutated copy can be judged by the same function. */
export declare function validateMigrationRegistry(input: { storeSource: unknown; migrationFiles: readonly string[] }): MigrationRegistryVerdict;
/** Reads both halves from the repository, so a caller can validate the real input or a mutated copy of it. */
export declare function readMigrationRegistry(root: string): { storeSource: string; migrationFiles: string[] };
/** Reads both halves from the repository and validates them. */
export declare function checkMigrationRegistry(root: string): MigrationRegistryVerdict;
