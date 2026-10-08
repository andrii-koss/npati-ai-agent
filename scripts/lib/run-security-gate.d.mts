/**
 * Types for `scripts/lib/run-security-gate.mjs` — the library half of the gate (G1 item 5), so the suites that
 * read the gate's contract can be part of `npm run typecheck:tests` (the same pattern `scripts/scan-web-xss.d.mts`
 * uses for the XSS scanner). `scripts/run-security-gate.d.mts` re-exports this file.
 *
 * The report arguments are `unknown` on purpose: vitest's JSON report is external input, and the gate's
 * readers are written to defend themselves against a missing or malformed shape (that is what
 * `evaluateVitestReport({})` failing is about), so the declaration must not pretend otherwise.
 */

export declare const SECURITY_GATE_TESTS: string[];

/**
 * G1 (item 2, D1): the **database-backed** half of the gate. A separate list on purpose — a database suite in
 * `SECURITY_GATE_TESTS` would make the hermetic gate red wherever PostgreSQL is absent, while the gate fails
 * any run that reports a skipped test. `npm run security-gate:db` requires `DATABASE_URL` and fails without it.
 */
export declare const SECURITY_GATE_DB_TESTS: string[];
export declare const DB_GATE_ARTIFACT_PATH: string;

/** What a database-backed suite gate measured. The members are nullable exactly where a run can stop early. */
export interface DatabaseSuiteGateSummary {
  gate: string;
  suiteList: string;
  suites: { configured: number; present: number; missing: string[] };
  database: { requiredEnv: string; present: boolean };
  tests: { passed: number | null; failed: number | null; skipped: number | null; todo: number | null };
  failedTests: string[];
  missingSuites: string[];
  emptySuites: string[];
  reason: string | null;
  ok: boolean;
}

/**
 * Runs one database-backed suite gate and returns its exit code (0 = passed). `root` defaults to the repository
 * root; the suites are told `NPATI_SECURITY_GATE_DB=1` so a plain `npm test` never reaches them.
 */
export declare function runDatabaseSuiteGate(options: {
  gate: string;
  suiteListName: string;
  suites: readonly string[];
  artifactPath: string;
  root?: string;
}): number;

/**
 * G1 (D20): the durable verdict artifact and its writer. The summary is `unknown` here for the same reason
 * the report arguments are: the writer only serialises it, and the shape it is given is this script's own
 * business. The writer returns a result instead of throwing, so a caller can assert both directions.
 */
export declare const GATE_ARTIFACT_PATH: string;
export declare function writeGateArtifact(root: string, summary: unknown): { ok: boolean; path: string; error: string | null };
/** The same writer under a caller-named repository-relative path (the DB gate's verdict artifact). */
export declare function writeGateArtifactAt(root: string, relativePath: string, summary: unknown): { ok: boolean; path: string; error: string | null };

export interface VitestReportVerdict {
  ok: boolean;
  failures: string[];
  numPassed: number;
  numFailed: number;
  numPending: number;
  numTodo: number;
}

/** One failing test of a report, in the normalised shape both the gate and the quarantine compare. */
export interface VitestFailedTest {
  file: string;
  title: string;
  messages: string[];
}

export declare function findMissingSuiteFiles(root: string, suites: readonly string[]): string[];
export declare function evaluateVitestReport(report: unknown): VitestReportVerdict;
export declare function suiteKey(value: unknown): string;
export declare function findMissingSuites(report: unknown, expected: readonly string[]): string[];
export declare function findEmptySuites(report: unknown): string[];
/** The single traversal of `assertionResults`; `formatFailedTests` prints what this returns. */
export declare function failedTests(report: unknown): VitestFailedTest[];
export declare function formatFailedTests(report: unknown): string[];
export declare function isEntryPoint(argv?: readonly string[], moduleUrl?: string): boolean;

/**
 * G1 (item 5, finding B): the gate's **preparation** phase for the curated typosquat dataset — it generates the
 * dataset of `root` **only when a file is missing**, and reports what it did. A present-but-stale dataset is left
 * to the `--check` guard, which stays RED. `root` defaults to the gate's own repository.
 */
export declare function prepareTyposquatDataset(options?: { root?: string }): {
  ok: boolean;
  generated: boolean;
  reason: string | null;
  missing: string[];
};

/** The gate's own entry point: `--list`, `--db`, `--list --db`, and the hermetic run. Returns the exit code. */
export declare function main(argv?: readonly string[]): number;
