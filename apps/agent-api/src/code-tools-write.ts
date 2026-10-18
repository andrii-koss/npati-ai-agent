import { detectEol, detectEncoding, toEol, replaceLiteralText } from "./code-text-format";
export { detectEol, detectEncoding } from "./code-text-format";
import {
  CodeToolError, normalizeWorkspacePath,
} from "./code-tools-path";
import { decideSensitiveRead, isSensitivePath, resolveSensitivePolicy } from "./code-tools-sensitive";
import { resolveCodeAgentLimits } from "./code-agent-config";
import { buildUnifiedDiff, diffLineStats, sha256, splitLines } from "./code-tools-diff";
import { assertNoPlaceholderInWrite } from "./provider-data-guard";

/**
 * C3: write-side engine for the editing tools.
 *
 * Pure logic behind a port: no direct filesystem, no `child_process`, no process state. Every guard
 * that protects a read (path safety, sensitive files) is reused here, and the additional write guards
 * (protected `.git`, edit size, mass-operation approval, read-before-write) live in this module so the
 * runtime only has to wire ports and checkpoints.
 *
 * Invariants:
 * - a write never happens before the whole change has been validated;
 * - encoding, end-of-line style and file mode are preserved unless the caller asks otherwise;
 * - a sensitive or `.git` path is only writable when the caller passes `approved: true`, and the
 *   result carries `approved: true` so the decision is visible in the transcript;
 * - a change larger than the configured budget is refused instead of silently truncated.
 */

export interface CodeWriteFileRead {
  content: string;
  encoding?: string;
  eol?: "lf" | "crlf";
  mode?: number;
  revision?: string;
}

export interface CodeWritePort {
  /** Optional coordinated transaction supplied by the authoritative workspace. */
  applyPatchTransaction?(plan: readonly import("./code-patch-transaction").PatchMutation[]): Promise<Array<{ path: string; sha256?: string; revision?: string }>>;
  readFile(path: string): Promise<CodeWriteFileRead>;
  writeFile(path: string, content: string, opts?: { encoding?: string; eol?: "lf" | "crlf"; mode?: number; expectedRevision?: string }): Promise<{ sha256: string; revision?: string }>;
  deletePath(path: string, opts?: { recursive?: boolean; expectedRevision?: string }): Promise<void>;
  movePath(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>;
  stat(path: string): Promise<{ exists: boolean; type?: "file" | "dir"; mode?: number; size?: number; revision?: string }>;
  listDir?(dir: string): Promise<Array<{ name: string; type: string }>>;
}

export interface WriteLimits {
  maxEditBytes: number;
  maxPatchFiles: number;
  massOperationThreshold: number;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Write-specific limits; the read limits keep coming from `resolveCodeAgentLimits()`. */
export function resolveWriteLimits(env: NodeJS.ProcessEnv = process.env): WriteLimits {
  return {
    maxEditBytes: envInt(env, "NPATI_CODE_MAX_EDIT_BYTES", 512 * 1024, 1024, 16 * 1024 * 1024),
    maxPatchFiles: envInt(env, "NPATI_CODE_MAX_PATCH_FILES", 50, 1, 500),
    massOperationThreshold: envInt(env, "NPATI_CODE_MASS_OP_THRESHOLD", 10, 1, 500),
  };
}

export interface PostWriteHooks {
  /** Wired to the formatter in a later step; a warning never blocks the write. */
  formatChangedFiles?: (paths: string[]) => Promise<{ warnings: string[] }>;
  checkSyntax?: (paths: string[]) => Promise<{ warnings: string[] }>;
}

export interface WriteOptions {
  /** Trusted revisions captured by the runtime read tracker. */
  expectedRevisions?: Readonly<Record<string, string>>;
  limits?: Partial<WriteLimits>;
  hooks?: PostWriteHooks;
  /** Explicit human/runtime approval for a sensitive, `.git` or mass operation. */
  approved?: boolean;
  /** Tool name recorded in errors and results. */
  tool?: string;
  /**
   * Set by a caller that has already enforced read-before-write itself (the C3 runtime checks the read
   * tracker's `sha256` before it calls an executor). Without it, replacing an existing file needs a
   * revision from that read, so a direct caller cannot overwrite a file it never read.
   */
  readVerified?: boolean;
}

function limitsOf(options: WriteOptions): WriteLimits {
  return { ...resolveWriteLimits(), ...options.limits };
}

export interface GuardedPath {
  path: string;
  approved: boolean;
  sensitive: boolean;
}

/**
 * Normalises a write target and applies the write guards. `.git` is never writable by the agent
 * (history rewriting is out of scope for C3), and a sensitive file needs `approved: true`.
 */
export function guardWritePath(input: { raw: unknown; tool: string; approved?: boolean }): GuardedPath {
  const path = normalizeWorkspacePath(input.raw, { tool: input.tool, allowEmpty: false });
  const segments = path.split("/");
  if (segments.includes(".git")) {
    throw new CodeToolError("git_dir_protected", "Git metadata is not writable by the agent", input.tool, 403);
  }
  const sensitive = isSensitivePath(path);
  if (sensitive && !input.approved) {
    // Reuse the canonical policy for the refusal message. In `deny` mode it throws; in `redact` mode it
    // returns a decision, and a write to a credential file must still never happen silently — redaction
    // is a read-time concept.
    decideSensitiveRead(path, resolveSensitivePolicy(), input.tool);
    throw new CodeToolError("sensitive_file_denied", `Refusing to modify the sensitive file "${path}" without approval`, input.tool, 403, false, "guard", { path });
  }
  return { path, approved: Boolean(input.approved && sensitive), sensitive };
}

export function assertEditSize(content: string, tool: string, limits: WriteLimits): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxEditBytes) {
    throw new CodeToolError("edit_too_large", `Refusing to write ${bytes} bytes: the per-change limit is ${limits.maxEditBytes} bytes`, tool, 413, false, "guard", { bytes, limit: limits.maxEditBytes });
  }
}

export function assertMassOperation(fileCount: number, tool: string, limits: WriteLimits, approved?: boolean): void {
  if (fileCount > limits.maxPatchFiles) {
    throw new CodeToolError("patch_too_large", `Refusing a change touching ${fileCount} files: the limit is ${limits.maxPatchFiles}`, tool, 413, false, "guard", { fileCount, limit: limits.maxPatchFiles });
  }
  if (fileCount > limits.massOperationThreshold && !approved) {
    throw new CodeToolError("approval_required", `A change touching ${fileCount} files needs approval`, tool, 409, false, "approval", { fileCount, threshold: limits.massOperationThreshold });
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Whitespace-tolerant search for the best matching region: the model often gets indentation slightly
 * wrong, and a hint with the closest block is far more useful than a bare "no match".
 */
export function findWhitespaceTolerantMatch(content: string, needle: string): { line: number; snippet: string } | null {
  const contentLines = splitLines(content).lines;
  const needleLines = splitLines(needle).lines.map((line) => line.trim());
  if (!needleLines.length || needleLines.length > contentLines.length) return null;
  const normalizedContent = contentLines.map((line) => line.trim());
  for (let start = 0; start + needleLines.length <= contentLines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needleLines.length; offset += 1) {
      if (normalizedContent[start + offset] !== needleLines[offset]) { matches = false; break; }
    }
    if (!matches) continue;
    const end = Math.min(contentLines.length, start + needleLines.length + 2);
    return { line: start + 1, snippet: contentLines.slice(start, end).join("\n") };
  }
  return null;
}

export interface EditInput {
  path: unknown;
  old_string: unknown;
  new_string: unknown;
  replace_all?: unknown;
}

export interface WriteResult {
  path: string;
  created?: boolean;
  replacements?: number;
  linesAdded: number;
  linesRemoved: number;
  bytes?: number;
  sha256: string;
  encoding: string;
  eol: "lf" | "crlf";
  diff: string;
  approved?: boolean;
  warnings?: string[];
  eolMixed?: boolean;
}

async function runHooks(options: WriteOptions, paths: string[]): Promise<string[] | undefined> {
  const hooks = options.hooks;
  if (!hooks) return undefined;
  const warnings: string[] = [];
  if (hooks.formatChangedFiles) {
    try {
      const result = await hooks.formatChangedFiles(paths);
      warnings.push(...(result.warnings ?? []));
    } catch (error) {
      warnings.push(`formatter hook failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (hooks.checkSyntax) {
    try {
      const result = await hooks.checkSyntax(paths);
      warnings.push(...(result.warnings ?? []));
    } catch (error) {
      warnings.push(`syntax hook failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return warnings.length ? warnings : undefined;
}

/**
 * Exact string replacement with uniqueness enforcement, EOL/encoding/mode preservation and an
 * optimistic-concurrency revision when the port provides one.
 */
export async function applyEdit(
  input: EditInput,
  port: CodeWritePort,
  options: WriteOptions = {},
  readRevision?: { revision?: string; sha?: string },
): Promise<WriteResult> {
  const tool = options.tool ?? "code.fs.edit";
  const limits = limitsOf(options);
  const guarded = guardWritePath({ raw: input.path, tool, approved: options.approved });
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    throw new CodeToolError("invalid_argument", "old_string and new_string must be strings", tool);
  }
  if (oldString === newString) {
    throw new CodeToolError("unchanged", "old_string and new_string are identical; nothing to change", tool);
  }
  const replaceAll = input.replace_all === true;
  const before = await port.readFile(guarded.path);
  const encoding = detectEncoding(before.content);
  const { eol, mixed } = detectEol(before.content);
  const body = encoding.bom ? before.content.slice(1) : before.content;
  const occurrences = countOccurrences(body, oldString);
  if (occurrences === 0) {
    const tolerant = findWhitespaceTolerantMatch(body, oldString);
    throw new CodeToolError(
      "edit_no_match",
      tolerant
        ? `old_string was not found verbatim, but a similar block exists at line ${tolerant.line}; match the existing indentation exactly or use code.fs.write to update the file`
        : "old_string was not found in the file; check indentation or use code.fs.write",
      tool, 409, false, "edit",
      tolerant ? { hint: tolerant.snippet, line: tolerant.line } : {},
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new CodeToolError("edit_not_unique", `old_string matches ${occurrences} places; add surrounding context or set replace_all`, tool, 409, false, "edit", { occurrences });
  }
  const nextBody = replaceLiteralText(body, oldString, newString, replaceAll);
  const nextContent = encoding.bom ? `\uFEFF${nextBody}` : nextBody;
  assertEditSize(nextContent, tool, limits);
  // C5b: a redaction placeholder is a reference to a value the model never saw, so it must never reach
  // disk. This runs before the write (and before hooks) so a refused edit leaves the file untouched.
  assertNoPlaceholderInWrite(nextContent, { tool, path: guarded.path });
  const diff = buildUnifiedDiff(toEol(body, "lf"), toEol(nextBody, "lf"), guarded.path);
  const written = await port.writeFile(guarded.path, nextContent, {
    encoding: encoding.encoding,
    eol,
    mode: before.mode,
    expectedRevision: readRevision?.revision ?? before.revision,
  });
  const stats = diffLineStats(diff);
  const warnings = await runHooks(options, [guarded.path]);
  return {
    path: guarded.path,
    replacements: replaceAll ? occurrences : 1,
    linesAdded: stats.additions,
    linesRemoved: stats.deletions,
    bytes: Buffer.byteLength(nextContent, "utf8"),
    sha256: written.sha256 ?? sha256(nextContent),
    encoding: encoding.encoding,
    eol,
    diff,
    ...(options.approved ? { approved: true } : {}),
    ...(mixed ? { eolMixed: true } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

export interface WriteFileInput {
  path: unknown;
  content: unknown;
  createDirectories?: unknown;
  overwrite?: unknown;
}

/** Creates or replaces a whole file. Overwriting an existing file requires `overwrite` and a read revision. */
export async function writeFileSafe(
  input: WriteFileInput,
  port: CodeWritePort,
  options: WriteOptions = {},
  readRevision?: { revision?: string; sha?: string },
): Promise<WriteResult> {
  const tool = options.tool ?? "code.fs.write";
  const limits = limitsOf(options);
  const guarded = guardWritePath({ raw: input.path, tool, approved: options.approved });
  if (typeof input.content !== "string") {
    throw new CodeToolError("invalid_argument", "content must be a string", tool);
  }
  const createDirectories = input.createDirectories !== false;
  const overwrite = input.overwrite !== false;
  assertEditSize(input.content, tool, limits);
  // C5b: never persist a redaction placeholder — it references a value the model never received. Checked
  // before any stat/read so a refused write has no side effects at all.
  assertNoPlaceholderInWrite(input.content, { tool, path: guarded.path });
  const existing = await port.stat(guarded.path);
  if (existing.exists && existing.type === "dir") {
    throw new CodeToolError("not_a_file", `"${guarded.path}" is a directory`, tool);
  }
  if (existing.exists && !overwrite) {
    throw new CodeToolError("already_exists", `"${guarded.path}" already exists and overwrite is false`, tool, 409, false, "guard", { path: guarded.path });
  }
  if (existing.exists && !readRevision && !options.approved && !options.readVerified) {
    throw new CodeToolError("not_read", `Reading "${guarded.path}" before overwriting it is required`, tool, 409, false, "read_before_write", { path: guarded.path });
  }
  if (!createDirectories) {
    const slash = guarded.path.lastIndexOf("/");
    if (slash > 0) {
      const parent = guarded.path.slice(0, slash);
      const parentStat = await port.stat(parent);
      if (!parentStat.exists) {
        throw new CodeToolError("not_a_directory", `Directory "${parent}" does not exist and createDirectories is false`, tool, 409);
      }
    }
  }
  const before = existing.exists ? (await port.readFile(guarded.path)).content : "";
  const encoding = detectEncoding(input.content);
  const { eol } = detectEol(input.content);
  const diff = existing.exists ? buildUnifiedDiff(before, input.content, guarded.path) : [
    `--- /dev/null`, `+++ b/${guarded.path}`, `@@ -0,0 +1,${splitLines(input.content).lines.length} @@`,
    ...splitLines(input.content).lines.map((line) => `+${line}`), "",
  ].join("\n");
  const written = await port.writeFile(guarded.path, input.content, {
    encoding: encoding.encoding,
    eol,
    mode: existing.mode,
    expectedRevision: readRevision?.revision ?? existing.revision,
  });
  const stats = diffLineStats(diff);
  const warnings = await runHooks(options, [guarded.path]);
  return {
    path: guarded.path,
    created: !existing.exists,
    linesAdded: stats.additions,
    linesRemoved: stats.deletions,
    bytes: Buffer.byteLength(input.content, "utf8"),
    sha256: written.sha256 ?? sha256(input.content),
    encoding: encoding.encoding,
    eol,
    diff,
    ...(options.approved ? { approved: true } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

export interface MoveInput { from: unknown; to: unknown; overwrite?: unknown }

export async function movePathSafe(input: MoveInput, port: CodeWritePort, options: WriteOptions = {}): Promise<{ from: string; to: string; moved: boolean; approved?: boolean }> {
  const tool = options.tool ?? "code.fs.move";
  const from = guardWritePath({ raw: input.from, tool, approved: options.approved });
  const to = guardWritePath({ raw: input.to, tool, approved: options.approved });
  const source = await port.stat(from.path);
  if (!source.exists) throw new CodeToolError("not_a_file", `"${from.path}" does not exist`, tool, 404);
  const target = await port.stat(to.path);
  if (target.exists && input.overwrite !== true) {
    throw new CodeToolError("already_exists", `"${to.path}" already exists and overwrite is false`, tool, 409);
  }
  await port.movePath(from.path, to.path, { overwrite: input.overwrite === true });
  return { from: from.path, to: to.path, moved: true, ...(options.approved ? { approved: true } : {}) };
}

export interface DeleteInput { path: unknown; recursive?: unknown; expectedRevision?: unknown }

export async function deletePathSafe(input: DeleteInput, port: CodeWritePort, options: WriteOptions = {}): Promise<{ path: string; deleted: boolean; recursive: boolean; approved?: boolean }> {
  const tool = options.tool ?? "code.fs.delete";
  const guarded = guardWritePath({ raw: input.path, tool, approved: options.approved });
  const recursive = input.recursive === true;
  if (guarded.path === ".") {
    throw new CodeToolError("invalid_path", "Refusing to delete the workspace root", tool, 403);
  }
  if (recursive && !options.approved) {
    throw new CodeToolError("approval_required", `Recursive deletion of "${guarded.path}" needs approval`, tool, 409, false, "approval", { path: guarded.path });
  }
  const existing = await port.stat(guarded.path);
  if (!existing.exists) throw new CodeToolError("not_a_file", `"${guarded.path}" does not exist`, tool, 404);
  if (existing.type === "dir" && !recursive) {
    throw new CodeToolError("not_a_file", `"${guarded.path}" is a directory; set recursive to delete it`, tool, 409);
  }
  const expectedRevision = typeof input.expectedRevision === "string" ? input.expectedRevision : undefined;
  await port.deletePath(guarded.path, { recursive, expectedRevision });
  return { path: guarded.path, deleted: true, recursive, ...(options.approved ? { approved: true } : {}) };
}

export interface EditProfile {
  preferredEditTool?: unknown;
  preferred_edit_tool?: unknown;
  smallFileBytes?: unknown;
}

/**
 * Chooses the recommended editing tool from a model profile. No model names are hardcoded: the profile
 * carries the preference, and the default is the safest option (exact-match edit).
 */
export function preferredEditTool(profile: EditProfile | null | undefined, options: { fileBytes?: number } = {}): "code.fs.edit" | "code.fs.apply_patch" | "code.fs.write" {
  const raw = typeof profile?.preferredEditTool === "string"
    ? profile.preferredEditTool
    : typeof profile?.preferred_edit_tool === "string" ? profile.preferred_edit_tool : "edit";
  const preference = raw.toLowerCase();
  const smallFileBytes = typeof profile?.smallFileBytes === "number" && Number.isFinite(profile.smallFileBytes) ? profile.smallFileBytes : 4096;
  if ((preference === "write_whole_file_for_small" || preference === "code.fs.write") && typeof options.fileBytes === "number" && options.fileBytes <= smallFileBytes) {
    return "code.fs.write";
  }
  if (preference === "apply_patch" || preference === "code.fs.apply_patch") return "code.fs.apply_patch";
  return "code.fs.edit";
}

/** Re-exported so callers do not need to import the limits module twice. */
export const writeEngineLimits = resolveCodeAgentLimits;
