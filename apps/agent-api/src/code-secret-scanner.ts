/**
 * C4a: secret scanning for text and diffs.
 *
 * Findings never carry the secret itself: the preview is redacted before it leaves this module, so a
 * finding can be attached to an Activity event, an approval payload or a log without leaking the value.
 */
import { CredentialMasker } from "./security-guardrails";

export type SecretKind =
  | "aws_access_key"
  | "github_token"
  | "private_key"
  | "jwt"
  | "database_url"
  | "api_key"
  | "slack_webhook"
  | "discord_webhook"
  | "env_secret";

export interface SecretFinding {
  kind: SecretKind;
  /** 1-based line number within the scanned text (or the new file for a diff). */
  line: number;
  /** Redacted excerpt — safe to log, show in approvals or store in Activity. */
  preview: string;
  /** Present for diff scans. */
  path?: string;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  clean: boolean;
}

export class SecretInDiffError extends Error {
  readonly code = "secret_in_diff";
  readonly status = 403;
  readonly retryable = false;
  readonly details: { findings: SecretFinding[] };
  constructor(findings: SecretFinding[]) {
    super(`Diff contains ${findings.length} potential secret(s); remove or move them to the company vault`);
    this.name = "SecretInDiffError";
    this.details = { findings };
  }
}

interface SecretPattern {
  kind: SecretKind;
  regex: RegExp;
  /** Only used for `env_secret`, where the key name decides whether the value looks secret. */
  keyPattern?: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "aws_access_key", regex: /\b(AKIA[0-9A-Z]{16})\b/g },
  { kind: "github_token", regex: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,100}|gho_[A-Za-z0-9]{36})\b/g },
  { kind: "private_key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { kind: "jwt", regex: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "database_url", regex: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi },
  { kind: "api_key", regex: /\b(sk-[A-Za-z0-9_-]{20,80}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,})\b/g },
  { kind: "slack_webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,}/g },
  { kind: "discord_webhook", regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g },
  {
    kind: "env_secret",
    regex: /^\s*([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(\S{8,})\s*$/gim,
    keyPattern: /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL/i,
  },
];

const PLACEHOLDER_PATTERN = /^(?:changeme|change_me|placeholder|example|dummy|test|xxx+|\$\{[^}]+\}|<[^>]+>|\.\.\.)$/i;

/** Redacts a single matched value while keeping enough shape for a human to recognise the location. */
export function redactSecretValue(value: string): string {
  const masked = CredentialMasker.mask(value);
  if (masked !== value && !masked.includes(value)) return masked;
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…[REDACTED]…${value.slice(-2)}`;
}

function previewFor(line: string, match: string): string {
  const redactedLine = CredentialMasker.mask(line).replace(match, redactSecretValue(match));
  return redactedLine.trim().slice(0, 200);
}

/** Scans free text (file content, command output, a patch body). Never returns the secret value. */
export function scanTextForSecrets(text: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  if (typeof text !== "string" || !text) return { findings, clean: true };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        // `env_secret` captures the key in group 1 and the value in group 2; every other pattern may or
        // may not have a capture group, so fall back to the whole match (full-match-only patterns
        // previously produced `undefined` here and their findings were silently dropped).
        const candidate = pattern.kind === "env_secret" ? match[2]! : (match[1] ?? match[0]);
        if (!candidate || PLACEHOLDER_PATTERN.test(candidate)) continue;
        if (pattern.keyPattern && pattern.kind === "env_secret" && !pattern.keyPattern.test(match[1]!)) continue;
        findings.push({ kind: pattern.kind, line: index + 1, preview: previewFor(line, candidate) });
        if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex += 1;
      }
    }
  }
  return { findings, clean: findings.length === 0 };
}

/**
 * Scans a unified diff, considering only added lines. The reported line number is the line in the new
 * file, which is what a reviewer or an approval payload needs.
 */
export function scanDiffForSecrets(unifiedDiff: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  if (typeof unifiedDiff !== "string" || !unifiedDiff) return { findings, clean: true };
  let currentPath: string | undefined;
  let newLine = 0;
  for (const rawLine of unifiedDiff.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      currentPath = rawLine.slice(4).replace(/^[ab]\//, "").trim();
      continue;
    }
    if (rawLine.startsWith("--- ") || rawLine.startsWith("diff --git")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      newLine = Number.parseInt(hunk[1]!, 10);
      continue;
    }
    if (rawLine.startsWith("+")) {
      const scanned = scanTextForSecrets(rawLine.slice(1));
      for (const finding of scanned.findings) {
        findings.push({ ...finding, line: newLine, path: currentPath });
      }
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-") || rawLine.startsWith("\\")) continue;
    newLine += 1;
  }
  return { findings, clean: findings.length === 0 };
}

/** Guard used before a commit/PR: any secret in the added lines stops the operation. */
export function assertNoSecretsInDiff(unifiedDiff: string): void {
  const { findings } = scanDiffForSecrets(unifiedDiff);
  if (findings.length) throw new SecretInDiffError(findings);
}

/** Convenience for callers that only need the redacted summary (never the value). */
export function summarizeSecretFindings(findings: SecretFinding[]): Array<{ kind: SecretKind; path?: string; line: number }> {
  return findings.map((finding) => ({ kind: finding.kind, path: finding.path, line: finding.line }));
}
