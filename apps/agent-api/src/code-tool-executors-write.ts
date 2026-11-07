import { javascriptSyntax } from "./code-js-syntax-check";
import { replaceLiteralText } from "./code-text-format";
import { CodeToolError, type CodeToolExecutionContext, type CodeWritePort } from "./code-tool-runtime";
import { simpleUnifiedDiff } from "./code-workspace-checkpoint";
import {
  applyEdit, deletePathSafe, movePathSafe, resolveWriteLimits, writeFileSafe,
  type CodeWritePort as EngineWritePort, type WriteOptions as EngineWriteOptions,
} from "./code-tools-write";
import { applyHunksToContent, type PatchHunk, applyPatch as applyCanonicalPatch } from "./code-tools-patch";
import { buildUnifiedDiff, diffLineStats, sha256 } from "./code-tools-diff";
import { commitPatchMutations } from "./code-patch-transaction";
import {
  type CanonicalExecutorOptions,
  rethrowCanonical,
  stringArg,
} from "./code-tool-executors-common";

export interface CanonicalWriteExecutorOptions extends CanonicalExecutorOptions {
  diffProvider?: (input: { path: string; before: string; after: string }) => { diff: string; linesAdded: number; linesRemoved: number } | null;
  /** Replaces the built-in unified-diff application when the canonical patch module is wired. */
  applyPatchProvider?: (input: { patch: string; files: Map<string, string> }) => Map<string, string>;
  /** Explicit approval granted outside the runtime (tests, maintenance scripts). */
  approved?: boolean;
  /** Optional formatter/syntax hooks; they only ever return warnings. */
  hooks?: EngineWriteOptions["hooks"];
}

interface WriteFileState { content: string; revision: string; sha256: string }

function writePortOf(input: CodeToolExecutionContext): CodeWritePort {
  if (!input.writePort) {
    throw new CodeToolError("write_unavailable", "This deployment cannot apply changes: no write port is configured", 503, "configure", false, input.tool.name);
  }
  return input.writePort;
}

/** Current content, or null when the file does not exist yet (a new file needs no prior revision). */
async function readCurrent(input: CodeToolExecutionContext, path: string): Promise<WriteFileState | null> {
  try {
    const file = await input.port.readFile({
      ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path,
      maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER,
    });
    if (file.truncated) throw new CodeToolError("too_large", `Refusing to edit a truncated read of ${path}`, 413, "read", false, input.tool.name);
    return { content: file.content ?? "", revision: file.revision, sha256: file.sha256 };
  } catch (error) {
    const shaped = error as { code?: string; status?: number };
    if (shaped?.code === "not_a_file" || shaped?.code === "not_found" || shaped?.code === "ENOENT" || shaped?.status === 404) return null;
    rethrowCanonical(error);
  }
}

function expectedRevisionFor(input: CodeToolExecutionContext, path: string, current: WriteFileState | null): string {
  const fromTracker = input.expectedRevisions?.[path];
  if (fromTracker) return fromTracker;
  const explicit = stringArg(input.args, ["expectedRevision", "revision"]);
  if (explicit) return explicit;
  return current?.revision ?? "";
}

/**
 * The revision the caller read for a path, as the canonical engines expect it. Only the read tracker
 * can supply it: the request itself is untrusted, so an `expectedRevision` argument never becomes the
 * lost-update guard.
 */
function readRevisionFor(input: CodeToolExecutionContext, path: string): { revision?: string; sha?: string } | undefined {
  const revision = input.expectedRevisions?.[path];
  return revision ? { revision } : undefined;
}

function diffFor(options: CanonicalWriteExecutorOptions, path: string, before: string, after: string) {
  const provided = options.diffProvider?.({ path, before, after });
  if (provided) return provided;
  return simpleUnifiedDiff(before, after, path);
}

/** Applies a unified diff to one file, refusing when any hunk does not match exactly. */
export function applyUnifiedDiffToFile(path: string, before: string, patch: string): string {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header || /^@@(?:.*@@)?\s*$/.test(line.trim())) {
      current = { beforeStart: header ? Number(header[1]) : -1, afterStart: header ? Number(header[2]) : -1, beforeCount: 0, afterCount: 0, lines: [] };
      hunks.push(current);
    } else if (current && !line.startsWith("+++") && !line.startsWith("---") && /^[ +\-]/.test(line)) {
      current.lines.push(line);
      if (!line.startsWith("+")) current.beforeCount++;
      if (!line.startsWith("-")) current.afterCount++;
    }
  }
  if (!hunks.length) throw new CodeToolError("invalid_arguments", "Patch for " + path + " contains no hunks", 400, "validate_arguments", false, "code.fs.apply_patch");
  try { return applyHunksToContent({ path, content: before, hunks, tool: "code.fs.apply_patch" }).content; }
  catch (error) { rethrowCanonical(error); }
}

function patchBlocks(patch: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let path: string | null = null;
  let buffer: string[] = [];
  const flush = () => { if (path) blocks.set(path, buffer.join("\n")); };
  for (const line of patch.split("\n")) {
    const target = /^\+\+\+ b\/(.+)$/.exec(line) ?? /^\+\+\+ (.+)$/.exec(line);
    if (target) { flush(); path = (target[1] ?? "").split("\t")[0]!.replace(/^b\//, "").trim(); buffer = []; continue; }
    if (path) buffer.push(line);
  }
  flush();
  return blocks;
}

/**
 * C3: adapts the runtime's write port (context-first) to the canonical write-engine port (path-first),
 * so the canonical engines (`applyEdit`, `writeFileSafe`, `applyPatch`, `movePathSafe`, `deletePathSafe`)
 * are the only implementations of editing, guarding and diffing.
 */
export function toEngineWritePort(input: CodeToolExecutionContext): EngineWritePort {
  const base = { ctx: input.ctx, companyId: input.companyId, projectId: input.projectId };
  const missing = (error: unknown): boolean => {
    const shaped = error as { code?: string; status?: number };
    return shaped?.code === "not_found" || shaped?.code === "not_a_file" || shaped?.code === "ENOENT" || shaped?.status === 404;
  };
  const stat = async (path: string) => {
    try {
      const file = await input.port.readFile({ ...base, path, maxLines: 1, maxBytes: 1 });
      return { exists: true as const, type: "file" as const, revision: file.revision };
    } catch (error) {
      const slash = path.lastIndexOf("/");
      const parent = slash > 0 ? path.slice(0, slash) : ".";
      try {
        const listing = await input.port.listDir({ ...base, path: parent, depth: 1, limit: 1000 });
        const entry = listing.entries.find((candidate) => candidate.path === path || candidate.path === path.slice(slash + 1));
        if (entry) return { exists: true as const, type: entry.type === "directory" ? ("dir" as const) : ("file" as const), revision: undefined };
        return { exists: false as const };
      } catch (listingError) {
        if (missing(error) || missing(listingError)) return { exists: false as const };
        throw error;
      }
    }
  };
  return {
    ...(input.writePort?.applyPatchTransaction ? { applyPatchTransaction: (plan: readonly import("./code-patch-transaction").PatchMutation[]) => input.writePort!.applyPatchTransaction!({ ...base, plan }) } : {}),
    async readFile(path) {
      const file = await input.port.readFile({ ...base, path, maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
      if (file.truncated) throw new CodeToolError("too_large", `Refusing to edit a truncated read of ${path}`, 413, "read", false, input.tool.name);
      if (file.binary || (file.encoding && !["utf8", "utf8-bom", "utf-8"].includes(file.encoding))) {
        throw new CodeToolError("unsupported_encoding", "Text editing requires supported UTF-8 input; the file was not changed", 415, "read", false, input.tool.name);
      }
      return { content: file.content ?? "", revision: file.revision, encoding: file.encoding, mode: file.mode };
    },
    async writeFile(path, content, opts) {
      const port = writePortOf(input);
      const existing = await stat(path);
      // The workspace is the authority on lost updates: an existing file is always written with the
      // revision the caller read, a new one goes through the separate create path.
      if (existing.exists) {
        const result = await port.writeFile({ ...base, path, content, expectedRevision: opts?.expectedRevision ?? existing.revision ?? "" });
        return { sha256: result.sha256, revision: result.revision };
      }
      const created = await port.createFile({ ...base, path, content, mode: opts?.mode });
      return { sha256: created.sha256, revision: created.revision };
    },
    async deletePath(path, opts) {
      await writePortOf(input).deleteFile({ ...base, path, expectedRevision: opts?.expectedRevision ?? input.expectedRevisions?.[path] });
    },
    async movePath(from, to) {
      const source = await stat(from);
      await writePortOf(input).moveFile({ ...base, from, to, expectedRevision: input.expectedRevisions?.[from] ?? source.revision ?? "" });
    },
    stat,
    async listDir(dir) {
      const listing = await input.port.listDir({ ...base, path: dir, depth: 1, limit: 1000 });
      return listing.entries.map((entry) => ({ name: entry.path.split("/").pop() ?? entry.path, type: entry.type }));
    },
  };
}

/** Canonical engine options for one execution, including the approval the runtime already granted. */
function engineOptions(input: CodeToolExecutionContext, options: CanonicalWriteExecutorOptions): EngineWriteOptions {
  return {
    tool: input.tool.name,
    expectedRevisions: input.expectedRevisions,
    limits: resolveWriteLimits(),
    approved: input.approved === true || options.approved === true,
    hooks: options.hooks,
    // The runtime enforces read-before-write (tracker `sha256` freshness) before any write tool reaches
    // an executor, so the engine does not need a revision from the read to allow the overwrite.
    readVerified: true,
  };
}

/** Accepts the canonical argument names first and keeps the legacy aliases for older callers. */
function canonicalEditArgs(args: Record<string, unknown>): { path: string; old_string: string; new_string: string; replace_all: boolean } {
  const path = stringArg(args, ["path", "file", "filePath"]);
  const oldString = typeof args.old_string === "string" ? args.old_string : stringArg(args, ["find", "oldText", "search"]);
  const newString = typeof args.new_string === "string" ? args.new_string : (stringArg(args, ["replacement", "newText", "replace"]) ?? "");
  return {
    path: path ?? "",
    old_string: oldString ?? "",
    new_string: newString,
    // `replace_all` is the canonical name; `replaceAll` stays supported for older callers.
    replace_all: args.replace_all === true || args.replaceAll === true,
  };
}

/** The canonical patch format (`*** Begin Patch`) is routed to the canonical parser/applier. */
export function isCanonicalPatchFormat(patch: string): boolean {
  return /^\*\*\* Begin Patch\s*$/m.test(patch) || /^\*\*\* (Update|Add|Delete) File: /m.test(patch);
}

/** A JavaScript write reports its syntax, so the agent needs no separate node --check turn. */
async function withSyntax<T>(result: T, filePath: string, content: string | undefined): Promise<T> {
  if (content === undefined || !result || typeof result !== "object") return result;
  const syntax = await javascriptSyntax(filePath, content);
  return syntax ? { ...result, syntax } : result;
}

export function canonicalWriteExecutors(options: CanonicalWriteExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.fs.write": async (input) => {
      const path = stringArg(input.args, ["path", "file", "filePath"]);
      if (!path) throw new CodeToolError("invalid_arguments", "code.fs.write requires a path", 400, "validate_arguments", false, input.tool.name);
      const content = typeof input.args.content === "string" ? input.args.content : input.args.newContent;
      const written = await writeFileSafe(
        {
          path,
          content,
          createDirectories: input.args.createDirectories,
          overwrite: input.args.overwrite,
        },
        toEngineWritePort(input),
        engineOptions(input, options),
        readRevisionFor(input, path),
      );
      return withSyntax(written, path, typeof content === "string" ? content : undefined);
    },

    "code.fs.edit": async (input) => {
      const args = canonicalEditArgs(input.args);
      if (!args.path) throw new CodeToolError("invalid_arguments", "code.fs.edit requires a path", 400, "validate_arguments", false, input.tool.name);
      if (!args.old_string) throw new CodeToolError("invalid_arguments", "code.fs.edit requires old_string", 400, "validate_arguments", false, input.tool.name);
      const edited = await applyEdit(args, toEngineWritePort(input), engineOptions(input, options), readRevisionFor(input, args.path));
      const after = /\.(?:m?js|cjs)$/i.test(args.path) ? await input.port.readFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path: args.path, maxLines: 100_000, maxBytes: 512 * 1024 }).then((file) => file.content).catch(() => undefined) : undefined;
      return withSyntax(edited, args.path, after);
    },

    "code.fs.move": async (input) => {
      const from = stringArg(input.args, ["from", "path", "source"]);
      const to = stringArg(input.args, ["to", "destination", "target"]);
      if (!from || !to) throw new CodeToolError("invalid_arguments", "code.fs.move requires from and to", 400, "validate_arguments", false, input.tool.name);
      return movePathSafe({ from, to, overwrite: input.args.overwrite }, toEngineWritePort(input), engineOptions(input, options));
    },

    "code.fs.delete": async (input) => {
      const path = stringArg(input.args, ["path", "file", "filePath"]);
      if (!path) throw new CodeToolError("invalid_arguments", "code.fs.delete requires a path", 400, "validate_arguments", false, input.tool.name);
      return deletePathSafe(
        { path, recursive: input.args.recursive, expectedRevision: input.expectedRevisions?.[path] ?? input.args.expectedRevision },
        toEngineWritePort(input),
        engineOptions(input, options),
      );
    },

    "code.fs.apply_patch": async (input) => {
      const patch = stringArg(input.args, ["patch", "diff"]);
      const dryRun = input.args.dryRun === true;
      if (patch && isCanonicalPatchFormat(patch)) {
        // Canonical format (`*** Begin Patch`): one parser, one applier, atomic across files. The result
        // keeps the canonical `applied`/`stats` fields and, for callers that read the older shape, the
        // same information as `files`/`path`/`linesAdded`/`linesRemoved`.
        const result = await applyCanonicalPatch({ patch, dryRun }, toEngineWritePort(input), engineOptions(input, options));
        const files = result.applied.map((item) => ({
          path: item.path,
          action: item.action,
          sha256: item.sha256 ?? null,
          linesAdded: item.linesAdded,
          linesRemoved: item.linesRemoved,
          diff: item.diff ?? (result.applied.length === 1 ? result.diff : ""),
        }));
        return {
          ...result,
          files,
          path: files[0]?.path ?? "",
          linesAdded: result.stats.additions,
          linesRemoved: result.stats.deletions,
        };
      }
      const edits = Array.isArray(input.args.edits) ? input.args.edits as Array<Record<string, unknown>>
        : Array.isArray(input.args.changes) ? input.args.changes as Array<Record<string, unknown>> : [];
      const files = Array.isArray(input.args.files) ? input.args.files as Array<Record<string, unknown>> : [];

      // Every result is computed before the first write, so a patch that does not apply cleanly changes
      // nothing at all — and `dryRun` returns that plan without touching the workspace.
      const planned: Array<{ path: string; content: string; before: string; current: WriteFileState | null }> = [];
      if (edits.length) {
        for (const edit of edits) {
          const path = stringArg(edit, ["path", "file", "filePath"]);
          const find = stringArg(edit, ["find", "oldText", "search", "old_string"]);
          const replacement = stringArg(edit, ["replacement", "newText", "replace", "new_string"]) ?? "";
          if (!path || find === null) throw new CodeToolError("invalid_arguments", "Each edit needs path and find", 400, "validate_arguments", false, input.tool.name);
          const current = await readCurrent(input, path);
          if (!current) throw new CodeToolError("not_a_file", `${path} does not exist`, 404, "execute", false, input.tool.name, { path });
          if (!current.content.includes(find)) throw new CodeToolError("patch_conflict", `Edit for ${path} does not match the current content`, 409, "execute", false, input.tool.name, { path });
          planned.push({ path, content: replaceLiteralText(current.content, find, replacement), before: current.content, current });
        }
      } else if (files.length) {
        for (const entry of files) {
          const path = stringArg(entry, ["path", "file", "filePath"]);
          const content = typeof entry.content === "string" ? entry.content : (typeof entry.newContent === "string" ? entry.newContent : null);
          if (!path || content === null) throw new CodeToolError("invalid_arguments", "Each file entry needs path and content", 400, "validate_arguments", false, input.tool.name);
          const current = await readCurrent(input, path);
          planned.push({ path, content, before: current?.content ?? "", current });
        }
      } else if (patch) {
        const blocks = patchBlocks(patch);
        if (!blocks.size) throw new CodeToolError("invalid_arguments", "The patch contains no file blocks", 400, "validate_arguments", false, input.tool.name);
        for (const [path, filePatch] of blocks) {
          const current = await readCurrent(input, path);
          const before = current?.content ?? "";
          const applied = options.applyPatchProvider
            ? options.applyPatchProvider({ patch: filePatch, files: new Map([[path, before]]) }).get(path) ?? before
            : applyUnifiedDiffToFile(path, before, filePatch);
          planned.push({ path, content: applied, before, current });
        }
      } else {
        throw new CodeToolError("invalid_arguments", "code.fs.apply_patch accepts a patch, edits[] or files[]", 400, "validate_arguments", false, input.tool.name);
      }

      const diff = planned.map((item) => buildUnifiedDiff(item.before, item.content, item.path)).filter(Boolean).join("");
      const applied = planned.map((item) => {
        const stats = diffLineStats(buildUnifiedDiff(item.before, item.content, item.path));
        return { path: item.path, action: item.current ? "update" as const : "add" as const, linesAdded: stats.additions, linesRemoved: stats.deletions, sha256: sha256(item.content) };
      });
      const stats = applied.reduce((accumulator, item) => ({
        files: accumulator.files + 1,
        additions: accumulator.additions + item.linesAdded,
        deletions: accumulator.deletions + item.linesRemoved,
      }), { files: 0, additions: 0, deletions: 0 });
      const committed = await commitPatchMutations(planned.map((item) => ({ path: item.path, before: item.before, after: item.content, existing: item.current !== null, revision: expectedRevisionFor(input, item.path, item.current) })), toEngineWritePort(input), engineOptions(input, options), dryRun);
      if (dryRun) {
        return { applied, dryRun: true, diff, stats, files: applied, linesAdded: stats.additions, linesRemoved: stats.deletions };
      }
      const results = committed.map((receipt, index) => ({ ...receipt, ...diffFor(options, receipt.path, planned[index]!.before, planned[index]!.content) }));
      return {
        path: results[0]?.path ?? "",
        applied,
        dryRun: false,
        files: results,
        stats,
        linesAdded: stats.additions,
        linesRemoved: stats.deletions,
        diff: results.map((item) => item.diff).filter(Boolean).join("\n"),
      };
    },
  };
}
