/**
 * Types for `scripts/run-security-gate.mjs`, so the suites that read the gate's contract can be part of
 * `npm run typecheck:tests` (the same pattern `scripts/scan-web-xss.d.mts` uses for the XSS scanner).
 *
 * The report arguments are `unknown` on purpose: vitest's JSON report is external input, and the gate's
 * readers are written to defend themselves against a missing or malformed shape (that is what
 * `evaluateVitestReport({})` failing is about), so the declaration must not pretend otherwise.
 */

export declare const SECURITY_GATE_TESTS: string[];

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
