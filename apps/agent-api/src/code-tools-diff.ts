import { createHash } from "node:crypto";

/**
 * C3: unified diff engine for the editing tools.
 *
 * Dependency-free and pure: the write tools need a diff both to report what they changed and to give
 * the model (and the approval UI) a human-readable view of a change before it is applied. The engine
 * is deliberately conservative — a diff is never invented, and when the input is too large for a
 * precise line diff it degrades to a whole-file replacement hunk instead of lying about hunks.
 */

export interface DiffOptions {
  /** Context lines around a change, as in `git diff -U<n>`. */
  contextLines?: number;
  /** Above this many changed lines on both sides the engine emits one replacement hunk. */
  preciseLineLimit?: number;
}

export interface DiffHunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Splits into lines and remembers whether the text ended with a newline. */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n").map((line) => line.replace(/\r$/, "")), trailingNewline };
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a: readonly string[], b: readonly string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let count = 0;
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

interface EditOp { type: "equal" | "delete" | "insert"; line: string }

/** LCS-based line diff over the trimmed middle part of both sides. */
function diffMiddle(before: readonly string[], after: readonly string[]): EditOp[] {
  const n = before.length;
  const m = after.length;
  if (n === 0) return after.map((line) => ({ type: "insert" as const, line }));
  if (m === 0) return before.map((line) => ({ type: "delete" as const, line }));
  // Trim the common prefix/suffix again after the outer trim, so the DP table stays small.
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, prefix);
  const beforeCore = before.slice(prefix, n - suffix);
  const afterCore = after.slice(prefix, m - suffix);
  const ops: EditOp[] = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ type: "equal", line: before[index]! });
  const table: number[][] = Array.from({ length: beforeCore.length + 1 }, () => new Array<number>(afterCore.length + 1).fill(0));
  for (let i = beforeCore.length - 1; i >= 0; i -= 1) {
    for (let j = afterCore.length - 1; j >= 0; j -= 1) {
      table[i]![j] = beforeCore[i] === afterCore[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < beforeCore.length && j < afterCore.length) {
    if (beforeCore[i] === afterCore[j]) {
      ops.push({ type: "equal", line: beforeCore[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "delete", line: beforeCore[i]! });
      i += 1;
    } else {
      ops.push({ type: "insert", line: afterCore[j]! });
      j += 1;
    }
  }
  while (i < beforeCore.length) { ops.push({ type: "delete", line: beforeCore[i]! }); i += 1; }
  while (j < afterCore.length) { ops.push({ type: "insert", line: afterCore[j]! }); j += 1; }
  for (let index = n - suffix; index < n; index += 1) ops.push({ type: "equal", line: before[index]! });
  return ops;
}

function buildOps(beforeText: string, afterText: string, options: DiffOptions): { ops: EditOp[]; beforeTrailing: boolean; afterTrailing: boolean } {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  if (beforeText === afterText) return { ops: [], beforeTrailing: before.trailingNewline, afterTrailing: after.trailingNewline };
  const prefix = commonPrefix(before.lines, after.lines);
  const suffix = commonSuffix(before.lines, after.lines, prefix);
  const limit = options.preciseLineLimit ?? 4000;
  const beforeMiddle = before.lines.length - prefix - suffix;
  const afterMiddle = after.lines.length - prefix - suffix;
  if (beforeMiddle > limit && afterMiddle > limit) {
    // Too large for a precise diff: one honest replacement hunk instead of an expensive guess.
    const ops: EditOp[] = [];
    for (let index = 0; index < prefix; index += 1) ops.push({ type: "equal", line: before.lines[index]! });
    for (let index = prefix; index < before.lines.length - suffix; index += 1) ops.push({ type: "delete", line: before.lines[index]! });
    for (let index = prefix; index < after.lines.length - suffix; index += 1) ops.push({ type: "insert", line: after.lines[index]! });
    for (let index = before.lines.length - suffix; index < before.lines.length; index += 1) ops.push({ type: "equal", line: before.lines[index]! });
    return { ops, beforeTrailing: before.trailingNewline, afterTrailing: after.trailingNewline };
  }
  return { ops: diffMiddle(before.lines, after.lines), beforeTrailing: before.trailingNewline, afterTrailing: after.trailingNewline };
}

function toHunks(ops: readonly EditOp[], contextLines: number): DiffHunk[] {
  // 1. Find the change regions, then merge regions whose equal gap is fully covered by context.
  const regions: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]!.type === "equal") continue;
    const last = regions[regions.length - 1];
    if (last && index - last.end <= contextLines * 2 + 1) last.end = index + 1;
    else regions.push({ start: index, end: index + 1 });
  }
  const hunks: DiffHunk[] = [];
  let beforeCursor = 1;
  let afterCursor = 1;
  let opIndex = 0;
  for (const region of regions) {
    const start = Math.max(0, region.start - contextLines);
    const end = Math.min(ops.length, region.end + contextLines);
    // Advance the cursors to the hunk start.
    while (opIndex < start) {
      const op = ops[opIndex]!;
      if (op.type !== "insert") beforeCursor += 1;
      if (op.type !== "delete") afterCursor += 1;
      opIndex += 1;
    }
    const beforeStart = beforeCursor;
    const afterStart = afterCursor;
    const lines: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      const op = ops[cursor]!;
      if (op.type === "equal") {
        lines.push(` ${op.line}`);
        beforeCount += 1;
        afterCount += 1;
      } else if (op.type === "delete") {
        lines.push(`-${op.line}`);
        beforeCount += 1;
      } else {
        lines.push(`+${op.line}`);
        afterCount += 1;
      }
    }
    hunks.push({ beforeStart, beforeCount, afterStart, afterCount, lines });
    // Advance the cursors through this hunk.
    while (opIndex < end) {
      const op = ops[opIndex]!;
      if (op.type !== "insert") beforeCursor += 1;
      if (op.type !== "delete") afterCursor += 1;
      opIndex += 1;
    }
  }
  return hunks;
}

/**
 * Builds a unified diff (`--- a/path`, `+++ b/path`, `@@` hunks). An unchanged input yields `""`,
 * which is what the tools report as "nothing to do" instead of a fabricated hunk.
 */
export function buildUnifiedDiff(before: string, after: string, path: string, options: DiffOptions = {}): string {
  const contextLines = Math.max(0, Math.min(options.contextLines ?? 3, 20));
  const { ops } = buildOps(before, after, options);
  if (!ops.length) return "";
  const hunks = toHunks(ops, contextLines);
  const header = `--- a/${path}\n+++ b/${path}\n`;
  const body = hunks.map((hunk) => {
    const head = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`;
    return `${head}\n${hunk.lines.join("\n")}`;
  }).join("\n");
  return `${header}${body}\n`;
}

export interface DiffLineStats { additions: number; deletions: number }

/** Counts added and removed lines in a unified diff (headers excluded). */
export function diffStats(diff: string): DiffLineStats & { files: number } {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { files += 1; continue; }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions, files };
}

/** Per-file line statistics for a single file change. */
export function diffLineStats(diff: string): DiffLineStats {
  const { additions, deletions } = diffStats(diff);
  return { additions, deletions };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Renders the `\ No newline at end of file` marker the way git does when the last line changes. */
export function withNoNewlineMarkers(lines: string[], beforeTrailing: boolean, afterTrailing: boolean): string[] {
  if (beforeTrailing === afterTrailing) return lines;
  return [...lines, NO_NEWLINE_MARKER];
}
