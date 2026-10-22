import { detectEol, toEol } from "./code-text-format";
import { CodeToolError } from "./code-tools-path";
import { buildUnifiedDiff, diffLineStats, sha256, splitLines } from "./code-tools-diff";
import { assertNoPlaceholderInWrite } from "./provider-data-guard";
import { commitPatchMutations } from "./code-patch-transaction";
import {
  assertEditSize, assertMassOperation, guardWritePath, resolveWriteLimits,
  type CodeWritePort, type WriteLimits, type WriteOptions,
} from "./code-tools-write";

/**
 * C3: patch engine (`code.fs.apply_patch`).
 *
 * The patch format is the one the model is asked to emit. It is intentionally simple and strict:
 *
 * ```
 * *** Begin Patch
 * *** Update File: src/orders.ts
 * @@ -10,3 +10,4 @@
 *  const x = 1;
 * -const y = 2;
 * +const y = 3;
 * +const z = 4;
 * *** Add File: src/new.ts
 * +export const value = 1;
 * *** Delete File: src/old.ts
 * *** End Patch
 * ```
 *
 * Guarantees:
 * - the whole patch is parsed and every hunk is validated against the on-disk content **before** a
 *   single byte is written;
 * - a conflict reports the file, the hunk number, the line and the expected versus actual context;
 * - `dryRun` computes the diff and writes nothing;
 * - several hunks for the same file are applied sequentially in memory, so they cannot overwrite each
 *   other.
 */

export type PatchAction = "update" | "add" | "delete";

export interface PatchHunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

export interface PatchFileOp {
  path: string;
  action: PatchAction;
  hunks: PatchHunk[];
  /** Raw added lines for `add` actions. */
  addedLines?: string[];
}

export interface ParsedPatch { files: PatchFileOp[] }

/** Enumerates both supported wire formats before read, approval and child-scope checks. */
export function patchTargets(patch: string): Array<{ path: string; action: PatchAction }> {
  if (/^\*\*\* (?:Begin Patch|(?:Update|Add|Delete) File:)/m.test(patch)) return parsePatch(patch).files.map(({ path, action }) => ({ path, action }));
  const targets: Array<{ path: string; action: PatchAction }> = [];
  let previous: string | undefined;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("--- ")) previous = line.slice(4).split("\t")[0]!.trim().replace(/^a\//, "");
    if (line.startsWith("+++ ")) {
      const next = line.slice(4).split("\t")[0]!.trim().replace(/^b\//, "");
      const action = next === "/dev/null" ? "delete" : previous === "/dev/null" ? "add" : "update";
      targets.push({ path: action === "delete" ? previous ?? "" : next, action });
    }
  }
  if (!targets.length || targets.some((target) => !target.path || target.path === "/dev/null")) throw new CodeToolError("patch_invalid", "Patch contains no valid file targets", "code.fs.apply_patch");
  return targets;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the patch text. Throws `patch_invalid` with the offending line number. */
export function parsePatch(patch: unknown, tool = "code.fs.apply_patch"): ParsedPatch {
  if (typeof patch !== "string" || !patch.trim()) {
    throw new CodeToolError("patch_invalid", "patch must be a non-empty string", tool);
  }
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFileOp[] = [];
  let index = 0;
  let seenBegin = false;
  let seenEnd = false;
  let current: PatchFileOp | null = null;
  let currentHunk: PatchHunk | null = null;
  const pushHunk = () => {
    if (currentHunk && current) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (current) files.push(current);
    current = null;
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "*** Begin Patch" && !seenBegin && !files.length && !current) { seenBegin = true; continue; }
    if (!seenBegin && line.trim()) throw new CodeToolError("patch_invalid", "Patch must start with *** Begin Patch", tool);
    if (line === "*** End Patch") {
      pushFile();
      seenEnd = true;
      if (lines.slice(index + 1).some((rest) => rest.trim())) throw new CodeToolError("patch_invalid", "Unexpected content after *** End Patch", tool);
      break;
    }
    if (line.startsWith("*** Update File:") || line.startsWith("*** Add File:") || line.startsWith("*** Delete File:")) {
      pushFile();
      const action: PatchAction = line.startsWith("*** Update File:") ? "update" : line.startsWith("*** Add File:") ? "add" : "delete";
      const path = line.slice(line.indexOf(":") + 1).trim();
      if (!path) throw new CodeToolError("patch_invalid", `Missing path on line ${index + 1}`, tool, 400, false, "patch", { line: index + 1 });
      current = { path, action, hunks: [], ...(action === "add" ? { addedLines: [] } : {}) };
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      throw new CodeToolError("patch_invalid", `Unexpected content before any file header on line ${index + 1}`, tool, 400, false, "patch", { line: index + 1 });
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      pushHunk();
      currentHunk = {
        beforeStart: Number.parseInt(header[1]!, 10),
        beforeCount: header[2] === undefined ? 1 : Number.parseInt(header[2]!, 10),
        afterStart: Number.parseInt(header[3]!, 10),
        afterCount: header[4] === undefined ? 1 : Number.parseInt(header[4]!, 10),
        lines: [],
      };
      continue;
    }
    // A header without line ranges ("@@" or "@@ <anchor text>", as Codex-style patches emit it): the hunk is located
    // by its context lines only, and an ambiguous context is still refused in applyHunksToContent.
    if (/^@@(?:\s.*)?$/.test(line) && current.action === "update") {
      pushHunk();
      currentHunk = { beforeStart: -1, beforeCount: -1, afterStart: -1, afterCount: -1, lines: [] };
      continue;
    }
    if (current.action === "add") {
      if (line.startsWith("+")) current.addedLines!.push(line.slice(1));
      else if (line.startsWith("\\")) continue;
      else if (line.trim() === "") current.addedLines!.push("");
      else throw new CodeToolError("patch_invalid", `Added files accept only "+" lines (line ${index + 1})`, tool, 400, false, "patch", { line: index + 1 });
      continue;
    }
    if (current.action === "delete") {
      if (!line.trim()) continue;
      throw new CodeToolError("patch_invalid", `Deleted files take no hunk content (line ${index + 1})`, tool, 400, false, "patch", { line: index + 1 });
    }
    if (!currentHunk) {
      if (!line.trim()) continue;
      throw new CodeToolError("patch_invalid", `Hunk content without a "@@" header on line ${index + 1}`, tool, 400, false, "patch", { line: index + 1 });
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) { currentHunk.lines.push(line); continue; }
    if (line.trim() === "") { currentHunk.lines.push(" "); continue; }
    throw new CodeToolError("patch_invalid", `Unrecognised hunk line on line ${index + 1}`, tool, 400, false, "patch", { line: index + 1 });
  }
  if (!seenBegin) throw new CodeToolError("patch_invalid", "Patch must start with *** Begin Patch", tool);
  if (!seenEnd) throw new CodeToolError("patch_invalid", "Patch is incomplete: missing *** End Patch", tool);
  if (!files.length) throw new CodeToolError("patch_invalid", "Patch contains no file operations", tool);
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (hunk.beforeStart === -1) continue;
      const before = hunk.lines.filter((line) => !line.startsWith("+")).length;
      const after = hunk.lines.filter((line) => !line.startsWith("-")).length;
      if (before !== hunk.beforeCount || after !== hunk.afterCount) throw new CodeToolError("patch_invalid", `Hunk counts do not match the content for "${file.path}"`, tool);
    }
    if (file.action === "update" && !file.hunks.length) {
      throw new CodeToolError("patch_invalid", `Update for "${file.path}" has no hunks`, tool, 400, false, "patch", { path: file.path });
    }
  }
  return { files };
}

interface AppliedHunk { replacements: number }

/**
 * Applies the hunks of one file in memory. Never writes: the caller decides whether to persist.
 * Throws `patch_conflict` with the hunk index, the line and the expected/actual context.
 */
export function applyHunksToContent(input: { path: string; content: string; hunks: PatchHunk[]; tool: string }): { content: string; applied: AppliedHunk[] } {
  const bom = input.content.startsWith("\uFEFF");
  const original = splitLines(bom ? input.content.slice(1) : input.content);
  let working = [...original.lines];
  let delta = 0;
  const applied: AppliedHunk[] = [];
  for (let index = 0; index < input.hunks.length; index += 1) {
    const hunk = input.hunks[index]!;
    const expected = hunk.lines
      .filter((line) => !line.startsWith("+"))
      .map((line) => line.slice(1));
    const expectedStart = Math.max(0, hunk.beforeStart - 1 + delta);
    const matchesAt = (candidate: number) => candidate >= 0 && candidate + expected.length <= working.length
      && expected.every((line, offset) => working[candidate + offset] === line);
    let foundAt = hunk.beforeStart >= 0 && matchesAt(expectedStart) ? expectedStart : -1;
    let ambiguous = false;
    if (foundAt === -1 && expected.length) {
      for (let candidate = 0; candidate + expected.length <= working.length; candidate++) {
        if (!matchesAt(candidate)) continue;
        if (foundAt !== -1) { ambiguous = true; break; }
        foundAt = candidate;
      }
    } else if (foundAt === -1 && hunk.beforeStart === -1 && !expected.length) foundAt = working.length;
    if (foundAt === -1 || ambiguous) {
      const actual = working.slice(expectedStart, expectedStart + Math.max(1, expected.length)).join("\n");
      throw new CodeToolError("patch_conflict",
        "Hunk " + (index + 1) + " of " + input.path + " at line " + hunk.beforeStart + (ambiguous ? " matches multiple locations; include unique surrounding context" : " does not match current content; re-read the affected range"),
        input.tool, 409, false, "patch", { path: input.path, hunk: index + 1, line: hunk.beforeStart,
          reason: ambiguous ? "ambiguous_context" : "context_not_found", expected: expected.join("\n").slice(0, 1200), actual: actual.slice(0, 1200),
          recovery: "Read the current affected range, then submit one corrected patch with exact, unique context. Do not retry the unchanged patch." });
    }
    const replacement = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    working = [...working.slice(0, foundAt), ...replacement, ...working.slice(foundAt + expected.length)];
    delta += replacement.length - expected.length;
    applied.push({ replacements: hunk.lines.filter((line) => line.startsWith("+")).length });
  }
  const body = working.join("\n");
  const text = original.trailingNewline && body ? body + "\n" : body;
  return { content: (bom ? "\uFEFF" : "") + toEol(text, detectEol(input.content).eol), applied };
}

export interface PatchFileResult {
  diff?: string;
  path: string;
  action: PatchAction | "unchanged";
  linesAdded: number;
  linesRemoved: number;
  sha256?: string;
}

export interface PatchResult {
  applied: PatchFileResult[];
  dryRun: boolean;
  diff: string;
  stats: { files: number; additions: number; deletions: number };
  approved?: boolean;
  warnings?: string[];
}

export interface ApplyPatchInput { patch: unknown; dryRun?: unknown }

/**
 * Validates and applies a patch. Nothing is written until every file and every hunk has been verified
 * and the new contents are known; `dryRun` returns the same diff without touching the workspace.
 */
export async function applyPatch(
  input: ApplyPatchInput,
  port: CodeWritePort,
  options: WriteOptions = {},
): Promise<PatchResult & { failed?: { path: string; hunk: number; reason: string; line: number } }> {
  const tool = options.tool ?? "code.fs.apply_patch";
  const limits: WriteLimits = { ...resolveWriteLimits(), ...options.limits };
  const dryRun = input.dryRun === true;
  const parsed = parsePatch(input.patch, tool);
  if (!dryRun && !options.approved && parsed.files.some((file) => file.action === "delete")) throw new CodeToolError("approval_required", "Deleting files through a patch requires approval", tool, 409, false, "approval");
  assertMassOperation(parsed.files.length, tool, limits, options.approved);
  // Phase 1: resolve every target and compute every new content in memory.
  const planned: Array<{ op: PatchFileOp; before: string; after: string; guarded: ReturnType<typeof guardWritePath>; existing: boolean; mode?: number; revision?: string }> = [];
  const seen = new Set<string>();
  for (const op of parsed.files) {
    const guarded = guardWritePath({ raw: op.path, tool, approved: options.approved });
    if (seen.has(guarded.path)) {
      throw new CodeToolError("patch_invalid", `File "${guarded.path}" appears more than once in the patch`, tool, 400, false, "patch", { path: guarded.path });
    }
    seen.add(guarded.path);
    const stat = await port.stat(guarded.path);
    if (op.action === "add") {
      if (stat.exists) throw new CodeToolError("already_exists", `"${guarded.path}" already exists`, tool, 409, false, "patch", { path: guarded.path });
      const content = `${(op.addedLines ?? []).join("\n")}\n`;
      planned.push({ op, before: "", after: content, guarded, existing: false });
      continue;
    }
    if (!stat.exists) throw new CodeToolError("not_a_file", `"${guarded.path}" does not exist`, tool, 404, false, "patch", { path: guarded.path });
    const current = await port.readFile(guarded.path);
    const expected = options.expectedRevisions?.[guarded.path];
    if (expected && current.revision !== expected) {
      throw new CodeToolError("revision_conflict", "Patch target changed since the session read; re-read it before retrying", tool, 409, true, "revision", { path: guarded.path, currentRevision: current.revision });
    }
    if (op.action === "delete") {
      planned.push({ op, before: current.content, after: "", guarded, existing: true, mode: current.mode, revision: current.revision });
      continue;
    }
    const { content } = applyHunksToContent({ path: guarded.path, content: current.content, hunks: op.hunks, tool });
    planned.push({ op, before: current.content, after: content, guarded, existing: true, mode: current.mode, revision: current.revision });
  }
  // Phase 2: build the combined diff (and refuse anything oversized before writing).
  const diffParts: string[] = [];
  for (const item of planned) {
    assertEditSize(item.after, tool, limits);
    if (item.op.action !== "add" && item.before === item.after) continue;
    diffParts.push(buildUnifiedDiff(item.before, item.after, item.guarded.path));
  }
  const diff = diffParts.filter(Boolean).join("");
  const stats = diffParts.reduce((accumulator, part) => {
    const partStats = diffLineStats(part);
    return { files: accumulator.files + (part ? 1 : 0), additions: accumulator.additions + partStats.additions, deletions: accumulator.deletions + partStats.deletions };
  }, { files: 0, additions: 0, deletions: 0 });
  const applied: PatchFileResult[] = planned.map((item) => {
    const itemDiff = item.op.action === "add" ? buildUnifiedDiff("", item.after, item.guarded.path) : buildUnifiedDiff(item.before, item.after, item.guarded.path);
    const itemStats = diffLineStats(itemDiff);
    return {
      path: item.guarded.path,
      diff: itemDiff,
      action: item.op.action,
      linesAdded: itemStats.additions,
      linesRemoved: itemStats.deletions,
      ...(item.after ? { sha256: sha256(item.after) } : {}),
    };
  });
  if (dryRun) {
    return { applied, dryRun: true, diff, stats, ...(options.approved ? { approved: true } : {}) };
  }
  // Phase 3: write. A failure mid-way restores what was already written, so the engine never leaves a
  // half-applied patch behind (the runtime additionally records a checkpoint for the whole turn).
  // C5b: a redaction placeholder must never reach disk, and the check runs over the whole plan *before* the
  // first write so a refused patch cannot leave a partially applied change behind.
  for (const item of planned) {
    if (item.op.action !== "delete") {
      assertNoPlaceholderInWrite(item.after, { tool: "code.fs.apply_patch", path: item.guarded.path });
    }
  }
  await commitPatchMutations(planned.map((item) => ({ path: item.guarded.path, before: item.before, after: item.after, existing: item.existing, delete: item.op.action === "delete", mode: item.mode, revision: item.revision })), port, options);
  return { applied, dryRun: false, diff, stats, ...(options.approved ? { approved: true } : {}) };
}

export interface TurnDiffEntry { path: string; before: string; after: string }
export interface TurnDiff { files: Array<{ path: string; linesAdded: number; linesRemoved: number; diff: string }>; stats: { files: number; additions: number; deletions: number } }

/** Pure builder for `code.fs.diff`: the diff of the current turn, or of a single path. */
export function collectTurnDiff(entries: readonly TurnDiffEntry[], options: { path?: string; maxFiles?: number } = {}): TurnDiff {
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 50, 200));
  const filtered = options.path ? entries.filter((entry) => entry.path === options.path) : entries;
  const files: TurnDiff["files"] = [];
  for (const entry of filtered.slice(0, maxFiles)) {
    const diff = buildUnifiedDiff(entry.before, entry.after, entry.path);
    const stats = diffLineStats(diff);
    files.push({ path: entry.path, linesAdded: stats.additions, linesRemoved: stats.deletions, diff });
  }
  return {
    files,
    stats: files.reduce((accumulator, file) => ({
      files: accumulator.files + 1,
      additions: accumulator.additions + file.linesAdded,
      deletions: accumulator.deletions + file.linesRemoved,
    }), { files: 0, additions: 0, deletions: 0 }),
  };
}

/** `code.fs.undo_last_turn` validates its confirmation here; the restore itself is the runtime's job. */
export function validateUndoRequest(input: { confirm?: unknown }, tool = "code.fs.undo_last_turn"): { confirmed: true } {
  if (input.confirm !== true) {
    throw new CodeToolError("approval_required", "undo_last_turn requires confirm: true", tool, 409, false, "approval");
  }
  return { confirmed: true };
}
