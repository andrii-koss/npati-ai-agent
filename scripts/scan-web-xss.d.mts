export interface WebXssViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

export interface WebXssScanResult {
  violations: WebXssViolation[];
  scannedFiles: number;
  allowlistChecked: string[];
}

export interface WebXssAllowlistEntry {
  file: string;
  pattern: string;
  occurrences: number;
  reason: string;
}

export declare const ALLOWLIST: WebXssAllowlistEntry[];
export declare const BANNED_PATTERNS: string[];
export declare function scanWebSources(root?: string): WebXssScanResult;
