// @ts-check
/**
 * C15 (owner decision 2) — the CLI's secret handling.
 *
 * The owner decision says the CLI authenticates with a token, and the acceptance test is that the **CLI token is
 * isolated**. Two things follow, and both are implemented here rather than at the call sites, because a call site
 * that has to remember to redact is a call site that will forget:
 *
 *  1. **The token is never in `argv`.** `ps` on a shared host shows every process's command line, and a shell
 *     history file keeps it forever. The token therefore comes from `NPATI_API_TOKEN` or from a token file
 *     (`--token-file`, `$NPATI_TOKEN_FILE`, or the default per-user config path), and this module is the only
 *     reader. `--token <value>` is refused outright — not ignored, refused — so an operator who tries it is told
 *     what to do instead instead of silently leaking the token.
 *  2. **The token is never printed.** Every message the CLI writes goes through `redactText` with the resolved
 *     token, so an HTTP client that echoes an `Authorization` header, a proxy that puts the request URL in an
 *     error body, or a server that quotes the credential back all end up redacted. The pattern redactor is a
 *     second layer for tokens that are *not* this run's own (`--server-error` text, another process's token in a
 *     shared response).
 *
 * The file is plain ESM JavaScript with JSDoc types on purpose: the package ships a `bin` that must run under
 * every Node version the repository's `engines` field allows (`>=22.22.2 <23 || >=24 <27`), and relying on Node's
 * `--experimental-strip-types` would work only on the 22.6+ half of that range. It is type-checked all the same,
 * through `packages/cli/tsconfig.json` with `checkJs`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The environment variable the token is read from first. */
export const TOKEN_ENV_VAR = "NPATI_API_TOKEN";
/** The environment variable that names a token file. */
export const TOKEN_FILE_ENV_VAR = "NPATI_TOKEN_FILE";
/** The precedence-ordered header names the API accepts, exactly as `auth.ts` reads them. */
export const TOKEN_HEADERS = ["authorization", "x-api-key"];

/** A CLI usage or configuration failure. `code` is stable; `message` is already safe to print. */
export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ exitCode?: number, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 2;
    this.details = options.details ?? {};
  }
}

/**
 * The default token file: `$NPATI_TOKEN_FILE`, else `$XDG_CONFIG_HOME/npati/token`, else
 * `~/.config/npati/token`. Never inside the repository, so a token cannot be committed by accident.
 * @returns {string}
 */
export function defaultTokenFilePath() {
  const explicit = process.env[TOKEN_FILE_ENV_VAR];
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : path.join(homedir(), ".config");
  return path.join(base, "npati", "token");
}

/**
 * Reads the token from the environment or a file. The returned value is the only copy the process keeps, and it is
 * handed to `redactText` on every output path.
 *
 * @param {{ tokenFile?: string | null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ token: string, source: "env" | "file", file?: string }}
 */
export function resolveToken(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim()) return { token: fromEnv.trim(), source: "env" };

  const file = options.tokenFile ?? defaultTokenFilePath();
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error ? String(error.code) : "unreadable";
    throw new CliError(
      "token_missing",
      `No API token found. Set ${TOKEN_ENV_VAR}, or write the token to ${file} ` +
        `(the file could not be read: ${reason}). The token is never accepted on the command line because it ` +
        `would be visible to every process on the host.`,
      { details: { file } },
    );
  }
  // A token file written by hand very often ends in a newline, and a quoted value is a common mistake.
  const token = stripQuotes(raw.trim());
  if (!token) {
    throw new CliError("token_empty", `The token file ${file} is empty. Write the token into it or set ${TOKEN_ENV_VAR}.`, {
      details: { file },
    });
  }
  return { token, source: "file", file };
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Rejects `--token <value>` in any spelling, before anything else happens. Exported so the refusal is testable and
 * so the reason is stated in one place: a command line is readable by every process of the same host.
 *
 * @param {readonly string[]} argv
 */
export function refuseTokenArgument(argv) {
  const forbidden = ["--token", "-t", "--api-token", "--api-key"];
  for (const argument of argv) {
    const name = argument.split("=")[0];
    if (name && forbidden.includes(name)) {
      throw new CliError(
        "token_argument_refused",
        `Refusing ${name}: a token on the command line is visible to every process (ps) and is kept in shell ` +
          `history. Use ${TOKEN_ENV_VAR} or --token-file <path> instead.`,
        { details: { argument: name } },
      );
    }
  }
}

/**
 * Redacts everything that looks like an NPATI credential. This is the layer for **other** tokens (a server error
 * quoting the key prefix, a response body echoing a header): the caller's own token is removed exactly by
 * `redactText`, and this catches the shapes.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactPatterns(text) {
  if (!text) return "";
  return String(text)
    // `npati_live_<hex>` / `rat_<id>` are the two shapes `auth.ts` recognises.
    .replace(/\bnpati_live_[A-Za-z0-9_-]{4,}/g, "npati_live_[REDACTED]")
    .replace(/\brat_[A-Za-z0-9_-]{4,}/g, "rat_[REDACTED]")
    // A `Bearer <value>` or `x-api-key: <value>` echoed back by a proxy.
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(x-api-key)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi, "$1: [REDACTED]");
}

/**
 * @param {string} text
 * @param {string | null | undefined} secret
 * @returns {string}
 */
export function redactText(text, secret) {
  let result = String(text ?? "");
  if (secret) {
    // Longest-first so a full token is never partially replaced into a re-matchable remainder.
    const parts = [secret, secret.trim()].filter((part) => part.length >= 4).sort((left, right) => right.length - left.length);
    for (const part of parts) {
      while (result.includes(part)) result = result.split(part).join("[REDACTED]");
    }
  }
  return redactPatterns(result);
}

/**
 * The headers for one request. `npati_live_` keys go in `x-api-key` (the header `auth.ts` reads first) and every
 * other credential shape goes in `Authorization: Bearer`, which is what the same function falls back to. Both are
 * sent for an `npati_live_` token's sibling case only when the caller asks; sending a key in two headers makes two
 * places to leak it.
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function authHeaders(token) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: "application/json",
    "x-npati-api-version": "v1",
    "user-agent": "npati-cli",
  };
  if (token.startsWith("npati_live_")) {
    headers["x-api-key"] = token;
  } else {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * A URL safe to print: a token accidentally placed in a query string (an old integration, a copy-pasted curl) is
 * removed from any query parameter whose name mentions a credential.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return redactPatterns(url);
  }
  for (const [key] of parsed.searchParams) {
    if (/token|key|secret|password|credential/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
  }
  return redactPatterns(parsed.toString());
}
