/**
 * C2: sensitive-file policy for the read-only code tools.
 *
 * Secrets must not reach the model, the Activity UI or the logs. Two modes are supported:
 * - `deny` (default): a sensitive path is refused with a structured error and the content is never
 *   read into memory;
 * - `redact`: the file is readable, but secret-shaped values are replaced before the result exists.
 *
 * The policy is configuration (`NPATI_CODE_SENSITIVE_POLICY`), never a literal, and it is evaluated on
 * the server for every read — a model cannot opt out of it.
 */
import { CredentialMasker } from "./security-guardrails";
import { CodeToolError } from "./code-tools-path";

export type SensitivePolicy = "deny" | "redact";

export const SENSITIVE_POLICY_ENV = "NPATI_CODE_SENSITIVE_POLICY";

/** Files whose content may hold credentials, tokens or private keys. */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.env\.example$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /credentials/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)secrets?\.[a-z0-9]+$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
];

/** Directories that are never traversed: version-control internals and key stores. */
const SENSITIVE_DIR_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.git($|\/)/i,
  /(^|\/)\.ssh($|\/)/i,
  /(^|\/)\.aws($|\/)/i,
  /(^|\/)\.gnupg($|\/)/i,
];

export function resolveSensitivePolicy(env: NodeJS.ProcessEnv = process.env): SensitivePolicy {
  return env[SENSITIVE_POLICY_ENV] === "redact" ? "redact" : "deny";
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (SENSITIVE_DIR_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isSensitiveDirectory(path: string): boolean {
  const normalized = `${path.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return SENSITIVE_DIR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface SensitiveDecision {
  action: "allow" | "redact";
  reason?: string;
}

/**
 * Decides how a read of `path` must be handled. In `deny` mode the caller must not read the file at
 * all: the decision is returned so the caller can throw without touching the content.
 */
export function decideSensitiveRead(path: string, policy: SensitivePolicy, tool: string): SensitiveDecision {
  if (!isSensitivePath(path)) return { action: "allow" };
  if (policy === "redact") return { action: "redact", reason: "sensitive_path_redacted" };
  throw new CodeToolError(
    "sensitive_file_denied",
    `Reading "${path}" is refused by the sensitive-file policy (${SENSITIVE_POLICY_ENV}=deny)`,
    tool,
    403,
  );
}

/** Redacts secret-shaped values: `KEY=value` pairs, inline tokens and private-key blocks. */
export function redactSecrets(content: string): string {
  if (!content) return content;
  let output = content;
  // Private key blocks first: masking them line by line would leak the body.
  output = output.replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  output = output.replace(/-----BEGIN[^-]*(CERTIFICATE|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END[^-]*\1-----/g, "[REDACTED_KEY_MATERIAL]");
  // KEY=value / "KEY": "value" forms where the key name looks secret-ish.
  output = output.replace(
    /^([ \t]*(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*)(.+)$/gim,
    (_match, prefix: string) => `${prefix}[REDACTED_SECRET]`,
  );
  // Then the shared credential masker for provider-shaped tokens (sk-, ghp_, Bearer JWT, DB URLs, AKIA).
  return CredentialMasker.mask(output);
}

/** Defensive check used before logging: never log raw content, and never log an unredacted path list. */
export function containsSecretShape(content: string): boolean {
  return redactSecrets(content) !== content;
}
