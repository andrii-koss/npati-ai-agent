/**
 * Types for `scripts/lint-guard.mjs`, so the security-gate suite can exercise the detector directly instead
 * of spawning a process (the same pattern `scripts/scan-web-xss.d.mts` uses).
 */

export type LintEnforcement = "ratchet" | "allowance";

export interface LintRule {
  id: string;
  label: string;
  pattern: RegExp;
  scope(relPath: string): boolean;
  enforcement: LintEnforcement;
  stripLineComments?: boolean;
  detail: string;
}

export interface LintAllowance {
  file: string;
  rule: string;
  occurrences: number;
  reason: string;
}

export interface LintFinding {
  file: string;
  rule: string;
  count: number;
  lines: number[];
}

export interface LintViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

export interface LintStale {
  file: string;
  rule: string;
  recorded: number;
  actual: number;
}

export interface LintVerdict {
  ok: boolean;
  violations: LintViolation[];
  stale: LintStale[];
  allowancesChecked: number;
  allowanceTotal: number;
}

export interface LintBaseline {
  counts: Record<string, Record<string, number>>;
  missing?: boolean;
  error?: string;
}

export interface LintScan {
  scannedFiles: number;
  findings: LintFinding[];
  targets: string[];
}

export declare const BASELINE_PATH: string;
export declare const LINT_RULES: LintRule[];
export declare const RECORDED_ALLOWANCES: LintAllowance[];
export declare function isSourceFile(relPath: string): boolean;
export declare function isTestFile(relPath: string): boolean;
export declare function lintTargets(root?: string): string[];
export declare function scanText(relPath: string, content: string): LintFinding[];
export declare function scanLintSources(root?: string): LintScan;
export declare function baselineFromFindings(findings: LintFinding[]): { _readme: string; counts: Record<string, Record<string, number>> };
export declare function loadBaseline(baselinePath?: string): LintBaseline;
export declare function evaluateScan(
  findings: LintFinding[],
  options?: { baseline?: Record<string, Record<string, number>>; allowances?: LintAllowance[] },
): LintVerdict;
export declare function runSelfTest(): { ok: boolean; checks: number; failures: string[] };
