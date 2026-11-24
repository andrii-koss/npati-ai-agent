/**
 * Line changes between the file before an agent run and its current text, shaped like an editor's change gutter:
 * added lines, modified lines (a replaced block) and the places where lines were deleted.
 */
export type DiffOp = { type: "equal" | "add" | "del"; text: string; oldLine?: number; newLine?: number };
export type LineChange = { kind: "added" | "modified"; line: number; old?: string[] } | { kind: "deleted"; line: number; old: string[] };
export type FileChanges = { ops: DiffOp[]; changes: LineChange[]; added: number; removed: number };

/** Above this many cells the middle block is reported as replaced instead of being diffed line by line. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function diffLines(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const ops: DiffOp[] = [];
  for (let index = 0; index < start; index++) ops.push({ type: "equal", text: after[index]!, oldLine: index, newLine: index });
  const a = before.slice(start, endBefore), b = after.slice(start, endAfter);
  if (a.length * b.length > MAX_CELLS) {
    a.forEach((text, index) => ops.push({ type: "del", text, oldLine: start + index }));
    b.forEach((text, index) => ops.push({ type: "add", text, newLine: start + index }));
  } else {
    // Longest common subsequence over the changed middle only; edits are usually small.
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ type: "equal", text: b[j]!, oldLine: start + i, newLine: start + j }); i++; j++; }
      // Removed lines come before the lines that replace them, as an editor shows a change.
      else if (i < a.length && (j >= b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { ops.push({ type: "del", text: a[i]!, oldLine: start + i }); i++; }
      else { ops.push({ type: "add", text: b[j]!, newLine: start + j }); j++; }
    }
  }
  for (let index = 0; index < before.length - endBefore; index++) ops.push({ type: "equal", text: before[endBefore + index]!, oldLine: endBefore + index, newLine: endAfter + index });
  return ops;
}

/** `before` null: the run created the file, so every line is new. */
export function fileChanges(before: string | null, current: string): FileChanges {
  const ops = diffLines(before === null ? [] : splitLines(before), splitLines(current));
  const changes: LineChange[] = [];
  let added = 0, removed = 0;
  for (let index = 0; index < ops.length;) {
    if (ops[index]!.type === "equal") { index++; continue; }
    const deleted: string[] = [], addedLines: number[] = [];
    let nextNewLine = 0;
    while (index < ops.length && ops[index]!.type !== "equal") {
      const op = ops[index]!;
      if (op.type === "del") deleted.push(op.text); else addedLines.push(op.newLine!);
      index++;
    }
    nextNewLine = index < ops.length ? ops[index]!.newLine! : splitLines(current).length;
    added += addedLines.length; removed += deleted.length;
    if (!addedLines.length) changes.push({ kind: "deleted", line: nextNewLine, old: deleted });
    else addedLines.forEach((line, position) => changes.push(deleted.length
      ? { kind: "modified", line, ...(position === 0 ? { old: deleted } : {}) }
      : { kind: "added", line }));
  }
  return { ops, changes, added, removed };
}
