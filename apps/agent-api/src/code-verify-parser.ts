/**
 * C4: parsing of verification tool output.
 *
 * The agent needs structured findings (file/line/severity) rather than raw text, but it must never
 * depend on one tool's exact wording. Every parser is therefore best-effort and the module never
 * throws: an unknown tool or an unrecognised format degrades to `findings: []` plus a truncated raw
 * excerpt, with `ok` derived from the exit code.
 */

export type VerifyTool = "tsc" | "eslint" | "pytest" | "jest" | "vitest" | "go" | "cargo" | "unknown";
export type VerifySeverity = "error" | "warning" | "info";

export interface VerifyFinding {
  file?: string;
  line?: number;
  column?: number;
  severity: VerifySeverity;
  message: string;
  code?: string;
}

export interface VerifySummary {
  errors: number;
  warnings: number;
  tests: number;
  passed: number;
  failed: number;
}

export interface VerifyParseResult {
  tool: VerifyTool;
  ok: boolean;
  summary: VerifySummary;
  findings: VerifyFinding[];
  raw?: string;
}

export interface VerifyParseOptions {
  maxFindings?: number;
  maxMessageLength?: number;
  maxRawLength?: number;
}

const DEFAULT_MAX_FINDINGS = 200;
const DEFAULT_MAX_MESSAGE = 500;
const DEFAULT_MAX_RAW = 2000;

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value);

/** Detects the tool from the command, the output header or an explicit hint. */
export function detectVerifyTool(output: string, hint?: string): VerifyTool {
  const probe = `${hint ?? ""}\n${output.slice(0, 4000)}`.toLowerCase();
  if (/\btsc\b|error ts\d{4}/.test(probe)) return "tsc";
  if (/\beslint\b|@typescript-eslint|eslint\//.test(probe)) return "eslint";
  if (/\bpytest\b|::test_|=\s*(?:\d+ (?:passed|failed))/.test(probe) && /pytest|::/.test(probe)) return "pytest";
  if (/\bvitest\b|❯|✕/.test(probe)) return "vitest";
  if (/\bjest\b|tests:\s*\d+/.test(probe)) return "jest";
  if (/--- fail:|\bfail\s+[\w./-]+\s+\d+\.\d+s/.test(probe)) return "go";
  if (/error\[e\d+\]|cargo (?:test|build|check)/.test(probe)) return "cargo";
  return "unknown";
}

function summaryOf(findings: VerifyFinding[]): Pick<VerifySummary, "errors" | "warnings"> {
  return {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
  };
}

function parseTsc(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (const line of lines) {
    const match = line.match(/^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (match) {
      findings.push({
        file: match[1], line: Number(match[2]), column: Number(match[3]),
        severity: match[4] === "error" ? "error" : "warning", code: match[5], message: truncate(match[6]!.trim(), maxMessage),
      });
      continue;
    }
    const plain = line.match(/^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(.*)$/);
    if (plain) findings.push({ file: plain[1], line: Number(plain[2]), column: Number(plain[3]), severity: plain[4] === "error" ? "error" : "warning", message: truncate(plain[5]!.trim(), maxMessage) });
  }
  return findings;
}

function parseEslint(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (const line of lines) {
    const match = line.match(/^(.*?):(\d+):(\d+):\s*(error|warning)\s+(.*?)(?:\s{2,}([\w@/-]+))?$/);
    if (!match) continue;
    findings.push({
      file: match[1], line: Number(match[2]), column: Number(match[3]),
      severity: match[4] === "error" ? "error" : "warning", message: truncate(match[5]!.trim(), maxMessage), code: match[6],
    });
  }
  return findings;
}

function parsePytest(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (const line of lines) {
    const failed = line.match(/^FAILED\s+([^\s:]+)(?:::([^\s]+))?\s*(?:-\s*(.*))?$/);
    if (failed) {
      findings.push({ file: failed[1], severity: "error", message: truncate([failed[2], failed[3]].filter(Boolean).join(" - ") || "test failed", maxMessage), code: failed[2] });
      continue;
    }
    const error = line.match(/^ERROR\s+([^\s:]+)(?:::([^\s]+))?\s*(?:-\s*(.*))?$/);
    if (error) findings.push({ file: error[1], severity: "error", message: truncate([error[2], error[3]].filter(Boolean).join(" - ") || "collection error", maxMessage) });
  }
  return findings;
}

function parseJestLike(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:✕|×|✗|FAIL|●)\s*(.*)$/);
    if (match && match[1]!.trim()) findings.push({ severity: "error", message: truncate(match[1]!.trim(), maxMessage) });
  }
  return findings;
}

function parseGo(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (const line of lines) {
    const fail = line.match(/^---\s+FAIL:\s+(\S+)/);
    if (fail) { findings.push({ severity: "error", message: truncate(`test failed: ${fail[1]}`, maxMessage), code: fail[1] }); continue; }
    const located = line.match(/^\s*([\w./-]+\.go):(\d+):\s*(.*)$/);
    if (located) findings.push({ file: located[1], line: Number(located[2]), severity: "error", message: truncate(located[3]!.trim(), maxMessage) });
  }
  return findings;
}

function parseCargo(lines: string[], maxMessage: number): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]!.match(/^(error|warning)(\[([A-Z]\d+)\])?:\s*(.*)$/);
    if (!header) continue;
    const location = lines.slice(index + 1, index + 4).map((line) => line.match(/^\s*-->\s*([^:]+):(\d+):(\d+)/)).find(Boolean);
    findings.push({
      file: location?.[1], line: location ? Number(location[2]) : undefined, column: location ? Number(location[3]) : undefined,
      severity: header[1] === "error" ? "error" : "warning", code: header[3], message: truncate(header[4]!.trim(), maxMessage),
    });
  }
  return findings;
}

function parseTestCounts(output: string): { tests: number; passed: number; failed: number } {
  const counts = { tests: 0, passed: 0, failed: 0 };
  const patterns = [
    /(\d+)\s+failed[,\s]+(\d+)\s+passed/i,
    /(\d+)\s+passed[,\s]+(\d+)\s+failed/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const isFailedFirst = /failed/i.test(pattern.source) && pattern.source.indexOf("failed") < pattern.source.indexOf("passed");
    counts.failed = isFailedFirst ? first : second;
    counts.passed = isFailedFirst ? second : first;
    counts.tests = counts.failed + counts.passed;
    return counts;
  }
  const vitest = output.match(/Tests:?\s*(?:(\d+)\s+failed[,\s]+)?(?:(\d+)\s+passed)?/i);
  if (vitest && (vitest[1] || vitest[2])) {
    counts.failed = Number(vitest[1] ?? 0);
    counts.passed = Number(vitest[2] ?? 0);
    counts.tests = counts.failed + counts.passed;
    return counts;
  }
  const goOk = output.match(/^ok\s+\S+/m);
  if (goOk) counts.passed = 1;
  return counts;
}

/** Never throws: any unexpected input degrades to an empty finding list plus a raw excerpt. */
export function parseVerifyOutput(
  tool: VerifyTool,
  output: string,
  exitCode: number,
  options: VerifyParseOptions = {},
): VerifyParseResult {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxMessage = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE;
  const maxRaw = options.maxRawLength ?? DEFAULT_MAX_RAW;
  const text = typeof output === "string" ? output : "";
  const resolved: VerifyTool = tool === "unknown" ? detectVerifyTool(text) : tool;
  try {
    const lines = text.split(/\r?\n/);
    let findings: VerifyFinding[];
    switch (resolved) {
      case "tsc": findings = parseTsc(lines, maxMessage); break;
      case "eslint": findings = parseEslint(lines, maxMessage); break;
      case "pytest": findings = parsePytest(lines, maxMessage); break;
      case "jest":
      case "vitest": findings = parseJestLike(lines, maxMessage); break;
      case "go": findings = parseGo(lines, maxMessage); break;
      case "cargo": findings = parseCargo(lines, maxMessage); break;
      default: findings = [];
    }
    const counts = parseTestCounts(text);
    const limited = findings.slice(0, maxFindings);
    const summary = { ...summaryOf(limited), ...counts };
    // A tool that reported nothing parseable still gets the exit code as the verdict.
    const ok = exitCode === 0 && summary.errors === 0 && summary.failed === 0;
    const result: VerifyParseResult = { tool: resolved, ok, summary, findings: limited };
    if (!limited.length) result.raw = truncate(text, maxRaw);
    return result;
  } catch (error) {
    return {
      tool: "unknown", ok: exitCode === 0, findings: [],
      summary: { errors: 0, warnings: 0, tests: 0, passed: 0, failed: 0 },
      raw: truncate(`verification output could not be parsed: ${error instanceof Error ? error.message : String(error)}\n${text}`, maxRaw),
    };
  }
}
