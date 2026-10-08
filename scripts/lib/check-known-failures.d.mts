/**
 * Types for `scripts/lib/check-known-failures.mjs` — the library half of the quarantine gate (G1 item 5), so the
 * C14 quarantine suite exercises the verdict logic directly instead of spawning the script (the same pattern
 * `scripts/lint-guard.d.mts` uses). `scripts/check-known-failures.d.mts` re-exports this file.
 *
 * The vitest report is `unknown` for the same reason it is in `run-security-gate.d.mts`: it is external input,
 * and the readers are written to defend themselves against a malformed shape rather than to assume one.
 */

export interface KnownFailureEntry {
  file: string;
  title: string;
  reason: string;
  owner: string;
  added_at: string;
  expires_at: string;
  evidence?: string;
}

export interface KnownFailuresManifest {
  version: number;
  comment?: unknown;
  defaultOwner?: string;
  updatedAt?: string;
  entries: KnownFailureEntry[];
}

export interface KnownFailuresLoad {
  ok: boolean;
  errors: string[];
  manifest: KnownFailuresManifest | null;
}

export interface KnownFailureObservation {
  file: string;
  title: string;
}

export interface KnownFailuresVerdict {
  ok: boolean;
  failures: string[];
  undeclaredFailures: Array<{ file: string; title: string }>;
  staleEntries: Array<{ file: string; title: string; expires_at: string }>;
  expiredEntries: Array<{ file: string; title: string; expires_at: string; stillFailing: boolean }>;
  actualCount: number;
  quarantineCount: number;
}

export interface AdoptRunResult {
  entries: KnownFailureEntry[];
  added: KnownFailureEntry[];
  dropped: Array<{ file: string; title: string }>;
  retained: Array<{ file: string; title: string }>;
}

export declare const KNOWN_FAILURES_PATH: string;
export declare const REQUIRED_ENTRY_FIELDS: string[];
export declare const KNOWN_FAILURES_ARTIFACT_NAME: string;
export declare function failureKey(file: string, title: string): string;
export declare function parseKnownFailures(text: string): KnownFailuresLoad;
export declare function loadKnownFailures(file?: string): KnownFailuresLoad;
export declare function evaluateKnownFailures(input: {
  actual?: readonly KnownFailureObservation[];
  entries?: readonly KnownFailureEntry[];
  now?: Date;
}): KnownFailuresVerdict;
export declare function listSuiteFiles(root?: string): string[];
export declare function unevaluatedSuites(
  report: unknown,
  options?: { root?: string; expected?: readonly string[] },
): string[];
export declare function runFullSuite(options?: { reportPath?: string }): {
  ok: boolean;
  report?: unknown;
  reportPath: string;
  output?: string;
  status?: number | null;
  error?: string;
};
export declare function adoptRun(input: {
  actual?: readonly KnownFailureObservation[];
  entries?: readonly KnownFailureEntry[];
  owner: string;
  reason: string;
  expiresAt: string;
  addedAt: string;
}): AdoptRunResult;
export declare function parseArgs(argv: readonly string[]): Record<string, string | true>;
export declare function buildArtifact(input: {
  now: Date;
  verdict: KnownFailuresVerdict;
  actualCount: number;
  manifestErrors?: string[];
  suiteProblems?: string[];
}): Record<string, unknown>;

/** The CLI body, called by the executable wrapper `scripts/check-known-failures.mjs`. */
export declare function main(argv?: readonly string[]): number;
/** Re-exported from the gate library for callers that used to import it from the script. */
export declare function isEntryPoint(argv?: readonly string[], moduleUrl?: string): boolean;
