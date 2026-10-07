import { normalizeWorkspacePath } from "./code-tools-path";
import {
  assertMetadataOnlyActivityPayload,
  assertNoSecretsInActivityPayload,
} from "./code-run-activity-sink";

/**
 * C12: the **handoff digest** — the only thing a sub-agent's work returns to its parent.
 *
 * The reason the digest exists at all is a context-budget argument with a security half. A sub-agent that
 * searches a repository reads hundreds of files; if its transcript, its tool results or its file bodies came
 * back, delegating would cost the parent exactly what it was supposed to save, and the parent's prompt would
 * fill with content no human asked for. So the child's answer is **parsed for named metadata fields only** and
 * the parent receives:
 *
 *   - `findings`: short claims, each naming a path and/or a symbol (kind, path, name, ≤200-character detail);
 *   - `files` and `symbols`: where the work happened;
 *   - `toolCalls` and `turns`: how much work it cost;
 *   - `dropped`: how many entries were refused, so "found nothing" and "everything was refused" stay
 *     distinguishable instead of both looking like an empty result.
 *
 * What may **not** ride in the digest is content, and that is enforced structurally rather than promised:
 *
 *   1. `detail` must be a **single line** within `CODE_SUBAGENT_HANDOFF_MAX_DETAIL_CHARS`. A file body, a
 *      diff or a log excerpt is multi-line, so it is dropped rather than truncated into something that reads
 *      like a summary. The count lands in `dropped`, so the loss is visible.
 *   2. Every path goes through the **canonical** path guard (`normalizeWorkspacePath`), so an absolute,
 *      traversing, home-relative or glob path is not metadata this digest will carry.
 *   3. The finished digest is checked by the C6b Activity invariants: `assertMetadataOnlyActivityPayload`
 *      refuses a content-like key outright (the rule the Activity sink already applies), and
 *      `assertNoSecretsInActivityPayload` refuses a credential-shaped value instead of redacting it — the C4a
 *      rule that a secret refuses the record rather than being silently stripped.
 *
 * The last one is why `buildCodeSubagentHandoffDigest` **throws** rather than returning a scrubbed digest: a
 * refused handoff is a real answer the parent must see, and a redacted one would hide the leak from the person
 * who has to fix it. The delegation executor catches it and reports it as a structured failure, which is also
 * what keeps a misbehaving child from taking the parent's run down with it.
 */

/** Bump when the digest shape changes: it is stored in Activity and read by replay (rule 13). */
export const SUBAGENT_HANDOFF_SCHEMA_VERSION = 1;

export const CODE_SUBAGENT_HANDOFF_MAX_FINDINGS = 100;
export const CODE_SUBAGENT_HANDOFF_MAX_FILES = 200;
export const CODE_SUBAGENT_HANDOFF_MAX_SYMBOLS = 200;
/** A claim, not a quotation. Anything longer is content and is refused, never truncated. */
export const CODE_SUBAGENT_HANDOFF_MAX_DETAIL_CHARS = 200;
export const CODE_SUBAGENT_HANDOFF_MAX_NAME_CHARS = 200;
export const CODE_SUBAGENT_HANDOFF_MAX_KIND_CHARS = 40;

export const CODE_SUBAGENT_HANDOFF_FINDING_KINDS = [
  "fact", "file", "symbol", "risk", "open_question",
] as const;
export type CodeSubagentHandoffFindingKind = (typeof CODE_SUBAGENT_HANDOFF_FINDING_KINDS)[number];

export interface CodeSubagentHandoffFinding {
  kind: CodeSubagentHandoffFindingKind;
  /** Workspace-relative path the claim is about, or `null` when the claim is about the repository as a whole. */
  path: string | null;
  /** Symbol or short identifier the claim names, or `null`. */
  name: string | null;
  /** One line, bounded. Never a quotation of file content: a multi-line value is dropped. */
  detail: string;
}

export interface CodeSubagentHandoffSymbol {
  path: string;
  name: string;
  kind: string;
}

export interface CodeSubagentHandoffDigest {
  schemaVersion: number;
  findings: CodeSubagentHandoffFinding[];
  files: string[];
  symbols: CodeSubagentHandoffSymbol[];
  toolCalls: number;
  turns: number;
  /** Entries the child offered that could not be carried as metadata. */
  dropped: number;
}

/** Raised when a child's handoff cannot be carried as metadata; the executor reports it, never scrubs it. */
export class CodeSubagentHandoffError extends Error {
  readonly code: string;
  readonly httpStatus = 400;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodeSubagentHandoffError";
    this.code = code;
  }
}

function singleLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) return null;
  // A newline is the signature of pasted content: a body, a diff, a stack trace or a log excerpt.
  if (/[\r\n]/.test(trimmed)) return null;
  // Control characters other than a tab are never part of a claim.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

/** The canonical path guard, or `null`. A digest carries validated workspace-relative paths or nothing. */
function digestPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) return null;
  try {
    const normalized = normalizeWorkspacePath(value, { tool: "code.agent.spawn", allowEmpty: false });
    return normalized === "." ? null : normalized;
  } catch {
    return null;
  }
}

/**
 * Reads the child's answer as JSON. The `{ … }` slice is the same idiom the project task planner and the QA
 * reporter already use, so a child that wraps its JSON in prose still hands over a usable digest — and a child
 * that returns no JSON at all hands over an empty one instead of failing the parent's run.
 */
export function parseSubagentHandoffAnswer(answer: unknown): Record<string, unknown> | null {
  if (answer && typeof answer === "object" && !Array.isArray(answer)) return answer as Record<string, unknown>;
  if (typeof answer !== "string") return null;
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export interface BuildCodeSubagentHandoffInput {
  /**
   * The child's answer. Parsed for `findings`/`files`/`symbols` only; every other field is ignored on purpose,
   * so a child cannot widen the digest by inventing a field.
   */
  answer?: unknown;
  /** Files the run reports as changed, from the run summary. Validated like every other path. */
  files?: readonly unknown[];
  toolCalls?: unknown;
  turns?: unknown;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * Builds the digest. Throws `CodeSubagentHandoffError` when the result would have to carry a credential; drops
 * (and counts) anything that cannot be expressed as metadata.
 */
export function buildCodeSubagentHandoffDigest(input: BuildCodeSubagentHandoffInput = {}): CodeSubagentHandoffDigest {
  const parsed = parseSubagentHandoffAnswer(input.answer) ?? {};
  let dropped = 0;

  const findings: CodeSubagentHandoffFinding[] = [];
  const offeredFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  for (const entry of offeredFindings) {
    if (findings.length >= CODE_SUBAGENT_HANDOFF_MAX_FINDINGS) { dropped++; continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { dropped++; continue; }
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" && (CODE_SUBAGENT_HANDOFF_FINDING_KINDS as readonly string[]).includes(record.kind)
      ? record.kind as CodeSubagentHandoffFindingKind
      : null;
    const detail = singleLine(record.detail, CODE_SUBAGENT_HANDOFF_MAX_DETAIL_CHARS);
    if (!kind || !detail) { dropped++; continue; }
    // `path` is optional, but when it is present and unusable the finding is refused rather than silently
    // relocated: "found X somewhere else" is worse than "found X, unlocatable".
    const hasPath = record.path !== undefined && record.path !== null && record.path !== "";
    const path = hasPath ? digestPath(record.path) : null;
    if (hasPath && !path) { dropped++; continue; }
    const name = singleLine(record.name, CODE_SUBAGENT_HANDOFF_MAX_NAME_CHARS);
    if (record.name !== undefined && record.name !== null && record.name !== "" && !name) { dropped++; continue; }
    findings.push({ kind, path, name, detail });
  }

  const files: string[] = [];
  const seenFiles = new Set<string>();
  const offeredFiles = [...(Array.isArray(parsed.files) ? parsed.files : []), ...(input.files ?? [])];
  for (const entry of offeredFiles) {
    const path = digestPath(entry);
    if (!path) { dropped++; continue; }
    if (seenFiles.has(path)) continue;
    if (files.length >= CODE_SUBAGENT_HANDOFF_MAX_FILES) { dropped++; continue; }
    seenFiles.add(path);
    files.push(path);
  }

  const symbols: CodeSubagentHandoffSymbol[] = [];
  const offeredSymbols = Array.isArray(parsed.symbols) ? parsed.symbols : [];
  for (const entry of offeredSymbols) {
    if (symbols.length >= CODE_SUBAGENT_HANDOFF_MAX_SYMBOLS) { dropped++; continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { dropped++; continue; }
    const record = entry as Record<string, unknown>;
    const path = digestPath(record.path);
    const name = singleLine(record.name, CODE_SUBAGENT_HANDOFF_MAX_NAME_CHARS);
    const kind = singleLine(record.kind, CODE_SUBAGENT_HANDOFF_MAX_KIND_CHARS);
    if (!path || !name || !kind) { dropped++; continue; }
    symbols.push({ path, name, kind });
  }

  const digest: CodeSubagentHandoffDigest = {
    schemaVersion: SUBAGENT_HANDOFF_SCHEMA_VERSION,
    findings,
    files,
    symbols,
    toolCalls: count(input.toolCalls),
    turns: count(input.turns),
    dropped,
  };

  // The C6b invariants, applied to the digest because the digest is what gets recorded in Activity. A future
  // field named `content`, `output`, `command` or `diff` therefore fails loudly here instead of reaching the
  // sink; a credential-shaped value refuses the digest instead of being redacted out of it.
  try {
    assertMetadataOnlyActivityPayload(digest);
  } catch (error) {
    throw new CodeSubagentHandoffError(
      "subagent_handoff_content_rejected",
      error instanceof Error ? error.message : "The sub-agent handoff must carry metadata only",
    );
  }
  try {
    assertNoSecretsInActivityPayload(digest);
  } catch (error) {
    throw new CodeSubagentHandoffError(
      "subagent_handoff_refused_credential",
      error instanceof Error ? error.message : "The sub-agent handoff must not carry secrets",
    );
  }
  return digest;
}

/** A digest that carries nothing, used when a child failed before it produced an answer. */
export function emptyCodeSubagentHandoffDigest(): CodeSubagentHandoffDigest {
  return {
    schemaVersion: SUBAGENT_HANDOFF_SCHEMA_VERSION,
    findings: [],
    files: [],
    symbols: [],
    toolCalls: 0,
    turns: 0,
    dropped: 0,
  };
}
