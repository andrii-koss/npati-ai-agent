import { CodeToolError as CanonicalToolError } from "./code-tools-path";
import { canonicalCodeAgentControlExecutors } from "./code-agent-controls";
import type { CodeSubagentOperationService } from "./code-subagent-operations";
import {
  codeToolLimits, grepFiles, listFiles, readFileLines, symbolsOutline, treeOverview,
  type CodeDirEntry, type CodeReadPort as FsReadPort, type CodeSearchRequest, type CodeSearchResponse,
} from "./code-tools-fs";
import { projectInfo, type ProjectInfoInput, type ProjectInfoResult } from "./code-tools-project";
import { CodeToolError, type CodeReadPort, type CodeToolExecutionContext, type CodeWritePort } from "./code-tool-runtime";
import { simpleUnifiedDiff } from "./code-workspace-checkpoint";
import {
  applyEdit, deletePathSafe, movePathSafe, resolveWriteLimits, writeFileSafe,
  type CodeWritePort as EngineWritePort, type WriteOptions as EngineWriteOptions,
} from "./code-tools-write";
import { applyPatch as applyCanonicalPatch } from "./code-tools-patch";
import { buildUnifiedDiff, diffLineStats, sha256 } from "./code-tools-diff";
import { CodePlanToolError, type ProposePlanResult, type UpdateTodosResult } from "./code-plan-tool";
import { canonicalGitExecutors, type CanonicalGitExecutorOptions } from "./code-tool-git-executors";
import {
  createCodeAgentSpawnExecutor,
  type CodeAgentSpawnExecutorOptions,
  type CodeSubagentActivityRecorder,
  type CodeSubagentChildRunner,
  type CodeSubagentDetachedPort,
} from "./code-agent-spawn-executor";

/**
 * C2: binds the canonical tool logic (`code-tools-fs.ts`, `code-tools-project.ts`) to the runtime.
 *
 * This file is the *only* place where the two meet: it adapts the runtime's read port to the canonical
 * port shape, and it maps canonical failures to the runtime's structured error codes. It deliberately
 * contains no path policy, no sensitive-file policy and no output wrapping — those live in
 * `code-tools-path.ts`, `code-tools-sensitive.ts` and `code-tools-fs.ts` and are applied by the
 * canonical functions themselves, so there is exactly one policy implementation.
 */

export interface CanonicalExecutorOptions {
  /**
   * Loads the project for `code.project.info`. Without it the tool refuses with
   * `tool_not_configured` (503) instead of inventing project facts.
   */
  projectLoader?: (input: { ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string }) => Promise<ProjectInfoInput["project"] | null>;
  /** Optional ctags runner; when absent `code.symbols.outline` reports `symbols_unavailable`. */
  runCtags?: (input: CodeToolExecutionContext, path: string) => Promise<string | null>;
}

/** Maps a canonical `CodeToolError` onto the runtime's structured failure without losing its code. */
export function rethrowCanonical(error: unknown): never {
  if (error instanceof CanonicalToolError) {
    const shaped = error as CanonicalToolError & { httpStatus?: number };
    throw Object.assign(new Error(error.message), {
      code: error.code,
      httpStatus: shaped.httpStatus ?? 400,
      tool: error.tool,
      step: error.step,
      retryable: error.retryable,
    });
  }
  throw error;
}

/**
 * Adapts the runtime read port to the canonical port. Modes that the underlying port cannot express
 * (`files_with_matches`, `count`) are derived here from line matches, so the port contract stays
 * "return line matches" while `code.fs.grep` still offers all three modes.
 */
export function toCanonicalPort(input: CodeToolExecutionContext, options: CanonicalExecutorOptions): FsReadPort {
  const { ctx, companyId, projectId, port, limits } = input;
  const port2 = port as CodeReadPort & {
    runSearch(input: { ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; query: string; path?: string; maxResults: number; timeoutMs: number }): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; engine?: "ripgrep" | "fallback" }>;
  };
  const canonical: FsReadPort = {
    async listDir(dir: string): Promise<CodeDirEntry[]> {
      const result = await port2.listDir({ ctx, companyId, projectId, path: dir, limit: 5000 });
      return (result.entries ?? []).map((entry) => ({
        name: entry.path.split("/").filter(Boolean).pop() ?? entry.path,
        type: entry.type === "directory" ? "dir" : "file",
        size: entry.size ?? null,
        mtimeMs: (entry as { mtimeMs?: number | null }).mtimeMs ?? null,
        target: (entry as { target?: string | null }).target ?? null,
      }));
    },
    async readFile(path: string, opts?: { maxBytes?: number }) {
      // The canonical reader needs the whole file to compute line offsets and the content hash; the
      // byte budget is enforced by the port and re-checked by the canonical reader.
      const file = await port2.readFile({
        ctx, companyId, projectId, path,
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: opts?.maxBytes ?? limits.readFileBytes,
      });
      return {
        content: file.content,
        bytes: Buffer.byteLength(file.content, "utf8"),
        truncated: file.truncated === true,
        encoding: "utf-8",
      };
    },
    async runSearch(request: CodeSearchRequest): Promise<CodeSearchResponse> {
      const result = await port2.runSearch({
        ctx, companyId, projectId,
        query: request.pattern,
        ...(request.path ? { path: request.path } : {}),
        maxResults: Math.max(1, Math.min(request.maxResults ?? 200, 1000)),
        timeoutMs: limits.commandTimeoutMs,
      });
      const lines = (result.matches ?? []).map((match) => ({ path: match.path, line: match.line, text: match.text }));
      const mode = request.mode ?? "content";
      if (mode === "files_with_matches") {
        const paths = [...new Set(lines.map((line) => line.path))];
        return { matches: paths.map((path) => ({ path })), truncated: result.truncated === true, engine: result.engine ?? "fallback" };
      }
      if (mode === "count") {
        const counts = new Map<string, number>();
        for (const line of lines) counts.set(line.path, (counts.get(line.path) ?? 0) + 1);
        return {
          matches: [...counts.entries()].map(([path, count]) => ({ path, count })),
          truncated: result.truncated === true,
          engine: result.engine ?? "fallback",
        };
      }
      return { matches: lines, truncated: result.truncated === true, engine: result.engine ?? "fallback" };
    },
  };
  if (options.runCtags) {
    const runner = options.runCtags;
    canonical.runCtags = (path: string) => runner(input, path);
  }
  return canonical;
}

/**
 * C3: the canonical write executors.
 *
 * They are the only place where a change is turned into a workspace call, and they always go through
 * the write port with the revision the caller read, so the workspace refuses a lost update. Diffs are
 * produced per file (an injected `diffProvider` wins; otherwise the bounded fallback in
 * `code-workspace-checkpoint.ts` is used) and returned as statistics plus a unified diff — never as
 * file content in the audit trail.
 *
 * Raw unified-diff patches are applied only when every hunk matches the current content exactly; a
 * mismatch refuses the whole patch before any write. A canonical patch parser (`code-tools-patch.ts`)
 * can replace the fallback by injecting `applyPatchProvider`.
 */
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

function stringArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length) return value;
  }
  return null;
}

/** Current content, or null when the file does not exist yet (a new file needs no prior revision). */
async function readCurrent(input: CodeToolExecutionContext, path: string): Promise<WriteFileState | null> {
  try {
    const file = await input.port.readFile({
      ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path,
      maxLines: Number.MAX_SAFE_INTEGER, maxBytes: input.limits.readFileBytes,
    });
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
  const lines = before.split("\n");
  const hunks: Array<{ start: number; removed: string[]; added: string[] }> = [];
  let current: { start: number; removed: string[]; added: string[] } | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { start: Math.max(0, Number.parseInt(header[1] ?? "1", 10) - 1), removed: [], added: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith(" ")) { current.removed.push(line.slice(1)); current.added.push(line.slice(1)); }
  }
  if (!hunks.length) {
    throw new CodeToolError("invalid_arguments", `Patch for ${path} contains no hunks`, 400, "validate_arguments", false, "code.fs.apply_patch");
  }
  let result = [...lines];
  // Apply from the bottom so earlier line numbers stay valid.
  for (const hunk of [...hunks].sort((a, b) => b.start - a.start)) {
    const existing = result.slice(hunk.start, hunk.start + hunk.removed.length);
    if (existing.length !== hunk.removed.length || existing.some((line, index) => line !== hunk.removed[index])) {
      throw new CodeToolError("patch_conflict", `Patch for ${path} does not match the current content`, 409, "execute", false, "code.fs.apply_patch", { path });
    }
    result = [...result.slice(0, hunk.start), ...hunk.added, ...result.slice(hunk.start + hunk.removed.length)];
  }
  return result.join("\n");
}

function patchBlocks(patch: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let path: string | null = null;
  let buffer: string[] = [];
  const flush = () => { if (path) blocks.set(path, buffer.join("\n")); };
  for (const line of patch.split("\n")) {
    const target = /^\+\+\+ b\/(.+)$/.exec(line) ?? /^\+\+\+ (.+)$/.exec(line);
    if (target) { flush(); path = (target[1] ?? "").replace(/^b\//, "").trim(); buffer = []; continue; }
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
    async readFile(path) {
      const file = await input.port.readFile({ ...base, path, maxLines: Number.MAX_SAFE_INTEGER, maxBytes: input.limits.readFileBytes });
      return { content: file.content ?? "", revision: file.revision, encoding: file.encoding };
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
      const created = await port.createFile({ ...base, path, content });
      return { sha256: created.sha256, revision: created.revision };
    },
    async deletePath(path) {
      await writePortOf(input).deleteFile({ ...base, path });
    },
    async movePath(from, to) {
      const source = await stat(from);
      await writePortOf(input).moveFile({ ...base, from, to, expectedRevision: source.revision ?? "" });
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

export function canonicalWriteExecutors(options: CanonicalWriteExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  /** Writes one file (creating it when it does not exist) and returns the change record. */
  const commit = async (input: CodeToolExecutionContext, path: string, content: string, current: WriteFileState | null) => {
    const port = writePortOf(input);
    const result = current
      ? await port.writeFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path, content, expectedRevision: expectedRevisionFor(input, path, current) })
      : await port.createFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path, content });
    const before = current?.content ?? "";
    const stats = diffFor(options, path, before, content);
    return { path: result.path, sha256: result.sha256, revision: result.revision, linesAdded: stats.linesAdded, linesRemoved: stats.linesRemoved, diff: stats.diff };
  };

  return {
    "code.fs.write": async (input) => {
      const path = stringArg(input.args, ["path", "file", "filePath"]);
      if (!path) throw new CodeToolError("invalid_arguments", "code.fs.write requires a path", 400, "validate_arguments", false, input.tool.name);
      return writeFileSafe(
        {
          path,
          content: typeof input.args.content === "string" ? input.args.content : input.args.newContent,
          createDirectories: input.args.createDirectories,
          overwrite: input.args.overwrite,
        },
        toEngineWritePort(input),
        engineOptions(input, options),
        readRevisionFor(input, path),
      );
    },

    "code.fs.edit": async (input) => {
      const args = canonicalEditArgs(input.args);
      if (!args.path) throw new CodeToolError("invalid_arguments", "code.fs.edit requires a path", 400, "validate_arguments", false, input.tool.name);
      if (!args.old_string) throw new CodeToolError("invalid_arguments", "code.fs.edit requires old_string", 400, "validate_arguments", false, input.tool.name);
      return applyEdit(args, toEngineWritePort(input), engineOptions(input, options), readRevisionFor(input, args.path));
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
        { path, recursive: input.args.recursive, expectedRevision: input.args.expectedRevision },
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
          diff: result.applied.length === 1 ? result.diff : "",
        }));
        return {
          ...result,
          files,
          path: files[0]?.path ?? "",
          linesAdded: result.stats.additions,
          linesRemoved: result.stats.deletions,
        };
      }
      const parsed = patch ? patchBlocks(patch) : null;
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
          planned.push({ path, content: current.content.replace(find, replacement), before: current.content, current });
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
      if (dryRun) {
        return { applied, dryRun: true, diff, stats, files: applied, linesAdded: stats.additions, linesRemoved: stats.deletions };
      }
      const results = [];
      for (const item of planned) results.push(await commit(input, item.path, item.content, item.current));
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

/**
 * C4: the sandbox execution port. It is implemented by the shell runtime (command classification,
 * approval hand-off, secret leases, process table) which itself drives the admitted sandbox. The
 * executors below never run a command themselves: without this port a shell tool fails closed with
 * `tool_not_configured` (503) instead of executing anything on the API host.
 */
export interface CodeShellRuntimePort {
  execAsync?(input: {
    ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; sessionId: string;
    runId: string; leaseOwner: string; toolCallId: string; agentId?: string;
    command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number;
    waitTimeoutMs: number; background: boolean; secretRefs?: string[]; approved: boolean;
  }): Promise<import("./code-async-process").AsyncProcessReceipt>;
  waitProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; sessionId: string;
    processId: string; waitTimeoutMs: number; offset: number; leaseOwner?: string;
  }): Promise<import("./code-async-process").AsyncProcessReceipt>;
  exec(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    turnId?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    secretRefs?: string[];
    approved: boolean;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number; truncated?: boolean; risk?: "low" | "medium" | "high" }>;
  startProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    agentId?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    approved: boolean;
  }): Promise<{ processId: string; startedAt: string }>;
  listProcesses?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
  }): Promise<{ processes: Array<{ processId: string; command: string; status: "running" | "stopped" | "failed"; startedAt?: string | null; exitCode?: number | null }> }>;
  processLogs?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    processId: string;
    offset: number;
    limit: number;
  }): Promise<{ lines: string[]; nextOffset: number; eof: boolean }>;
  stopProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    processId: string;
  }): Promise<{ processId: string; stopped: boolean }>;
}

/**
 * C4: verification runner. It replays the project's configured verify commands (from the C1 toolchain)
 * in the sandbox; it never invents a command. Absent → `verify_unavailable` (503).
 */
export interface CodeVerifyRunnerPort {
  run(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    turnId?: string;
    tools: Array<"lint" | "typecheck" | "test" | "build">;
    changedOnly: boolean;
    timeoutMs: number;
  }): Promise<{
    results: Array<{ tool: "lint" | "typecheck" | "test" | "build"; ok: boolean; summary: string; findings: string[]; raw?: string }>;
    stats: { tools: number; passed: number; failed: number; durationMs: number };
  }>;
}

export interface CanonicalShellExecutorOptions extends CanonicalWriteExecutorOptions {
  /** Sandbox command execution, classification, approvals and secret leases. */
  shellRuntime?: CodeShellRuntimePort;
  /** Verification runner built on the project's configured verify commands. */
  verifyRunner?: CodeVerifyRunnerPort;
}

function toolNotConfigured(tool: string, what: string): never {
  throw new CodeToolError(
    "tool_not_configured",
    `${tool} is not available in this deployment: ${what} is not configured`,
    503,
    "dispatch",
    false,
    tool,
  );
}

function stringListArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length ? items : undefined;
}

function envArg(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "string")
    .map(([key, item]) => [key, item as string] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * C4: sandbox execution tools. Every call goes through the injected shell runtime, which owns command
 * classification, the approval hand-off, secret leases and output redaction; `approved` is forwarded so
 * the runtime can prove the approval covers *this* command. No port → fail closed.
 */
export function canonicalShellExecutors(options: CanonicalShellExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const shell = () => {
    if (!options.shellRuntime) toolNotConfigured("code.shell", "the sandbox shell runtime");
    return options.shellRuntime;
  };

  return {
    "code.shell.exec_async": async (input) => {
      const runtime = shell();
      if (!runtime.execAsync) toolNotConfigured(input.tool.name, "tracked execution");
      try {
        return await runtime.execAsync({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId,
          sessionId: input.sessionId ?? "", runId: input.runId ?? "", leaseOwner: input.leaseOwner ?? "", toolCallId: input.toolCallId ?? "", agentId: input.agentId,
          command: stringArg(input.args, ["command"]) ?? "", cwd: stringArg(input.args, ["cwd"]) ?? undefined, env: envArg(input.args.env),
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.commandTimeoutMs,
          waitTimeoutMs: typeof input.args.waitTimeoutMs === "number" ? input.args.waitTimeoutMs : 1000,
          background: input.args.background === true, secretRefs: stringListArg(input.args.secretRefs), approved: input.approved === true });
      } catch (error) { rethrowCanonical(error); }
    },
    "code.shell.process.wait": async (input) => {
      const runtime = shell();
      if (!runtime.waitProcess) toolNotConfigured(input.tool.name, "tracked process collection");
      try {
        return await runtime.waitProcess({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId,
          sessionId: input.sessionId ?? "", processId: stringArg(input.args, ["processId"]) ?? "", leaseOwner: input.leaseOwner,
          waitTimeoutMs: typeof input.args.waitTimeoutMs === "number" ? input.args.waitTimeoutMs : 1000,
          offset: typeof input.args.offset === "number" ? input.args.offset : 0 });
      } catch (error) { rethrowCanonical(error); }
    },
    "code.shell.exec": async (input) => {
      const command = stringArg(input.args, ["command", "cmd", "commandLine"]);
      if (!command) throw new CodeToolError("invalid_arguments", "code.shell.exec requires a command", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      try {
        const result = await runtime.exec({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          command,
          cwd: stringArg(input.args, ["cwd", "workingDirectory"]) ?? undefined,
          env: envArg(input.args.env),
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.commandTimeoutMs,
          secretRefs: stringListArg(input.args.secretRefs),
          approved: input.approved === true || input.args.approved === true,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          truncated: result.truncated === true,
          risk: result.risk ?? "medium",
        };
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.start": async (input) => {
      const command = stringArg(input.args, ["command", "cmd", "commandLine"]);
      if (!command) throw new CodeToolError("invalid_arguments", "code.shell.process.start requires a command", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.startProcess) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.startProcess({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          command,
          cwd: stringArg(input.args, ["cwd", "workingDirectory"]) ?? undefined,
          env: envArg(input.args.env),
          approved: input.approved === true || input.args.approved === true,
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.list": async (input) => {
      const runtime = shell();
      if (!runtime.listProcesses) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.listProcesses({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.logs": async (input) => {
      const processId = stringArg(input.args, ["processId", "id"]);
      if (!processId) throw new CodeToolError("invalid_arguments", "code.shell.process.logs requires a processId", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.processLogs) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.processLogs({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          processId,
          sessionId: input.sessionId,
          offset: typeof input.args.offset === "number" ? input.args.offset : 0,
          limit: typeof input.args.limit === "number" ? input.args.limit : 200,
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.stop": async (input) => {
      const processId = stringArg(input.args, ["processId", "id"]);
      if (!processId) throw new CodeToolError("invalid_arguments", "code.shell.process.stop requires a processId", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.stopProcess) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.stopProcess({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, processId });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.verify.run": async (input) => {
      if (!options.verifyRunner) toolNotConfigured(input.tool.name, "the verification runner");
      const requested = stringListArg(input.args.tools) ?? [];
      const tools = requested.filter((tool): tool is "lint" | "typecheck" | "test" | "build" =>
        ["lint", "typecheck", "test", "build"].includes(tool));
      if (!tools.length) throw new CodeToolError("invalid_arguments", "code.verify.run requires at least one of lint, typecheck, test, build", 400, "validate_arguments", false, input.tool.name);
      try {
        return await options.verifyRunner.run({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          tools,
          changedOnly: input.args.changedOnly === true,
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.installBuildTimeoutMs,
        });
      } catch (error) { rethrowCanonical(error); }
    },
  };
}

/**
 * C4a: dependency port. It is implemented by the dependency modules (policy, guard, audit) and the
 * sandbox, so the executors below never install anything themselves: without the port a dependency tool
 * fails closed with `tool_not_configured` (503).
 */
export interface CodeDepsPort {
  inspect(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    path?: string;
    manager?: string;
  }): Promise<{ manager: string; lockfile: string | null; declared: Array<{ name: string; version?: string | null; scope?: string; source?: string | null }>; metadata?: Record<string, unknown> }>;
  audit(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    manager?: string;
    lockfilePath?: string;
    blockOn?: string[];
  }): Promise<{ report: { critical: number; high: number; moderate: number; low: number; advisories: Array<Record<string, unknown>> }; blocked: boolean; reason?: string }>;
  add(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    name: string;
    version?: string;
    manager?: string;
    dev?: boolean;
    source?: string;
    approved: boolean;
    toolCallId?: string;
  }): Promise<{ manager: string; name: string; version: string | null; source: string; verdict: "added" | "require_approval" | "denied"; reasons: string[]; metadata?: Record<string, unknown>; approvalId?: string | null }>;
}

export interface CanonicalDepsExecutorOptions extends CanonicalShellExecutorOptions {
  /** Dependency inspection, audit and install; absent → the dependency tools fail closed. */
  deps?: CodeDepsPort;
}

/**
 * C4a: dependency tools. Inspection is pure reading, the audit runs the ecosystem's audit command in the
 * sandbox through the injected runner, and adding a dependency goes through the dependency guard so the
 * verdict (allow / require approval / deny) and the reasons come from one place.
 */
export function canonicalDepsExecutors(options: CanonicalDepsExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const deps = (tool: string) => {
    if (!options.deps) toolNotConfigured(tool, "the dependency policy/guard/audit wiring");
    return options.deps;
  };

  return {
    "code.deps.inspect": async (input) => {
      const port = deps(input.tool.name);
      try {
        return await port.inspect({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          ...(typeof input.args.path === "string" ? { path: input.args.path } : {}),
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.deps.audit": async (input) => {
      const port = deps(input.tool.name);
      const blockOn = Array.isArray(input.args.blockOn)
        ? input.args.blockOn.filter((value): value is string => typeof value === "string")
        : undefined;
      try {
        return await port.audit({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
          ...(typeof input.args.lockfilePath === "string" ? { lockfilePath: input.args.lockfilePath } : {}),
          ...(blockOn?.length ? { blockOn } : {}),
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.deps.add": async (input) => {
      const port = deps(input.tool.name);
      const name = stringArg(input.args, ["name", "package", "packageName"]);
      if (!name) throw new CodeToolError("invalid_arguments", "code.deps.add requires a package name", 400, "validate_arguments", false, input.tool.name);
      try {
        return await port.add({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          name,
          ...(typeof input.args.version === "string" ? { version: input.args.version } : {}),
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
          ...(typeof input.args.dev === "boolean" ? { dev: input.args.dev } : {}),
          ...(typeof input.args.source === "string" ? { source: input.args.source } : {}),
          approved: input.approved === true || input.args.approved === true,
        });
      } catch (error) { rethrowCanonical(error); }
    },
  };
}

/**
 * C9: planning tools. They are dispatch-only adapters: validation, idempotency and the "at most one
 * in_progress" rule live in `code-plan-tool.ts`, and the structured refusal keeps its own reason so the model
 * learns what was wrong instead of seeing a generic argument error.
 */
export interface CodePlanToolPort {
  propose(request: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    plan: unknown;
    createdBy?: string | null;
  }): Promise<ProposePlanResult>;
  updateTodos(request: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    tasks: unknown;
  }): Promise<UpdateTodosResult>;
}

export interface CanonicalPlanExecutorOptions extends CanonicalDepsExecutorOptions {
  /** Planning service; absent → both planning tools fail closed with `tool_not_configured`. */
  planTool?: CodePlanToolPort;
}

function rethrowPlan(error: unknown, tool: string): never {
  if (error instanceof CodePlanToolError) {
    throw new CodeToolError(
      "invalid_arguments",
      error.message,
      error.httpStatus,
      "validate_arguments",
      error.retryable,
      tool,
      { reason: error.code, ...error.details },
    );
  }
  throw error;
}

export function canonicalPlanExecutors(options: CanonicalPlanExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const plan = (tool: string): CodePlanToolPort => {
    if (!options.planTool) toolNotConfigured(tool, "the planning service wiring");
    return options.planTool;
  };
  const sessionOrFail = (input: CodeToolExecutionContext): string => {
    if (!input.sessionId) {
      throw new CodeToolError("invalid_arguments", `${input.tool.name} requires a session`, 400, "validate_arguments", false, input.tool.name);
    }
    return input.sessionId;
  };

  return {
    "code.plan.propose": async (input) => {
      const port = plan(input.tool.name);
      const sessionId = sessionOrFail(input);
      try {
        return await port.propose({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          // The whole argument object is handed over: the service validates it and keeps only the four fields a
          // plan may carry, so an unexpected key (a mode, for instance) never reaches storage.
          plan: input.args,
          createdBy: input.ctx.userId,
        });
      } catch (error) { rethrowPlan(error, input.tool.name); }
    },

    "code.plan.update": async (input) => {
      const port = plan(input.tool.name);
      const sessionId = sessionOrFail(input);
      try {
        return await port.updateTodos({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          tasks: input.args.tasks,
        });
      } catch (error) { rethrowPlan(error, input.tool.name); }
    },
  };
}

/**
 * Read-only, write, sandbox, git and delegation executors merged, which is what the application wires into the
 * runtime.
 *
 * C11: the `code.git.*` bodies come from `canonicalGitExecutors`, which delegates to the existing
 * `ProjectGitService` — there is no second git implementation anywhere under `apps/agent-api/src`, and the
 * git executors contain no git command of their own.
 *
 * C12: `code.agent.spawn` comes from `createCodeAgentSpawnExecutor`, which delegates the child run to the
 * existing `CodingAgentRunner` through a narrow port. There is likewise **no second orchestration engine**:
 * the executor validates, intersects capabilities with the existing `SubagentToolPolicyGuard` and forwards.
 */
export function allCanonicalExecutors(
  options: CanonicalAskUserExecutorOptions & CanonicalGitExecutorOptions & CanonicalSubagentExecutorOptions = {},
): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    ...canonicalExecutors(options),
    ...canonicalWriteExecutors(options),
    ...canonicalShellExecutors(options),
    ...canonicalDepsExecutors(options),
    ...canonicalPlanExecutors(options),
    ...canonicalAskUserExecutors(options),
    ...canonicalGitExecutors(options),
    ...canonicalSubagentExecutors(options),
  };
}

/**
 * C12: the delegation executor. One entry, and it is an **adapter**: the type table, the capability
 * intersection, the child runner and the handoff digest all live in their own modules, so this is the single
 * place that binds them to the runtime.
 *
 * Without `childRunner` the tool fails closed with `tool_not_configured` — a published tool with no wiring is
 * the `runCtags` defect class, and claiming to have delegated when nothing ran would be worse.
 */
export interface CanonicalSubagentExecutorOptions {
  subagentControls?: () => CodeSubagentOperationService | undefined;
  /** Late-bound because the composition builds the executors before the runner exists. */
  subagentChildRunner?: () => CodeSubagentChildRunner | undefined;
  /**
   * Step 5: the detached delegation port. Absent, or its `isEnabled` false, means `code.agent.spawn` keeps the C12
   * blocking behaviour; present and enabled, the same executor returns an accepted receipt instead of the child's
   * outcome. The port carries no policy of its own — every validation, scope and limit stays in the executor.
   */
  subagentDetached?: CodeSubagentDetachedPort;
  /** The published registry (`CodeToolRuntime.listTools()`), i.e. the canonical tool universe. */
  subagentCanonicalTools?: () => readonly string[];
  /** The C6b Activity sink, so the delegation is recorded as a nested event with its snapshot. */
  subagentActivity?: CodeSubagentActivityRecorder;
  subagentModelProfiles?: CodeAgentSpawnExecutorOptions["modelProfiles"];
  subagentEnv?: NodeJS.ProcessEnv;
}

export function canonicalSubagentExecutors(
  options: CanonicalSubagentExecutorOptions = {},
): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    ...canonicalCodeAgentControlExecutors(options.subagentControls),
    "code.agent.spawn": createCodeAgentSpawnExecutor({
      ...(options.subagentChildRunner ? { childRunner: options.subagentChildRunner } : {}),
      ...(options.subagentCanonicalTools ? { canonicalTools: options.subagentCanonicalTools } : {}),
      ...(options.subagentActivity ? { activity: options.subagentActivity } : {}),
      ...(options.subagentModelProfiles ? { modelProfiles: options.subagentModelProfiles } : {}),
      ...(options.subagentEnv ? { env: options.subagentEnv } : {}),
    }),
    "code.agent.spawn_async": async (input) => {
      if (!options.subagentDetached || !await options.subagentDetached.isEnabled({ ctx: input.ctx, companyId: input.companyId })) {
        throw new CodeToolError("subagent_detached_disabled", "Detached sub-agents are disabled", 409, "policy", false, input.tool.name);
      }
      return createCodeAgentSpawnExecutor({ childRunner: options.subagentChildRunner,
        detached: { ...options.subagentDetached, isEnabled: async () => true },
        canonicalTools: options.subagentCanonicalTools, activity: options.subagentActivity,
        modelProfiles: options.subagentModelProfiles, env: options.subagentEnv })(input);
    },
  };
}

/**
 * C9: `code.ask_user`. A dispatch-only adapter as well: the rules (prompt/choice bounds, one question per tool
 * call, the human-only answer, expiry without a guess) live in `code-ask-user-service.ts` and the store behind
 * it, and the *run* is paused by the runner, which is the component that owns the run state and the loop.
 *
 * The port is the service's `ask` alone, so a test can pass the smallest possible fake and so the executor
 * cannot reach any other part of the question lifecycle.
 *
 * Two refusals are the point of this adapter:
 *   - a call with no run (or no tool-call id) is refused with `invalid_arguments`, because a question nobody
 *     can attribute to a run could never be answered or expired;
 *   - the model's arguments are passed to the service unchanged, so the service — not this shim — decides
 *     what a legal question is.
 */
export interface CodeAskUserToolPort {
  ask(input: {
    ctx: { userId?: string | null; externalSubject?: string | null };
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    toolCallId: string;
    prompt: string;
    choices: Array<{ id: string; label: string; description?: string }>;
    allowFreeAnswer?: boolean;
    ttlMs?: number;
    createdBy?: string | null;
  }): Promise<{ question: { id: string; status: string; choices: Array<{ id: string }>; allowFreeAnswer: boolean; expiresAt: Date }; created: boolean; runPaused: boolean }>;
}

export interface CanonicalAskUserExecutorOptions extends CanonicalPlanExecutorOptions {
  /**
   * The question service; absent → `code.ask_user` fails closed with `tool_not_configured` instead of appearing
   * to ask. A published tool with no wiring is the `runCtags` defect class: visible everywhere, unable to work.
   */
  codeAskUserService?: CodeAskUserToolPort;
}

/** A service refusal keeps its own reason code, so the model learns what was wrong instead of seeing "tool failed". */
function rethrowAskUser(error: unknown, tool: string): never {
  const shaped = error as {
    code?: unknown; httpStatus?: unknown; status?: unknown; message?: unknown;
    retryable?: unknown; details?: unknown;
  };
  if (shaped && typeof shaped.code === "string") {
    const details = shaped.details && typeof shaped.details === "object" && !Array.isArray(shaped.details)
      ? shaped.details as Record<string, unknown>
      : {};
    throw new CodeToolError(
      "invalid_arguments",
      typeof shaped.message === "string" ? shaped.message : `The question was refused (${shaped.code})`,
      typeof shaped.httpStatus === "number" ? shaped.httpStatus : (typeof shaped.status === "number" ? shaped.status : 400),
      "validate_arguments",
      shaped.retryable === true,
      tool,
      // The service's own fields are kept and `reason` is the machine code: the human-readable text is already the
      // message, and a reader of `details` needs the code to branch on.
      { ...details, reason: shaped.code },
    );
  }
  throw error;
}

/** `expiresInSeconds` is the schema's unit; the store caps the TTL at 24h, so a bad value can only shorten it. */
function ttlMsFromArgs(args: Record<string, unknown>): number | undefined {
  const seconds = args.expiresInSeconds;
  if (seconds === undefined || seconds === null) return undefined;
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) return undefined;
  return Math.trunc(Number(seconds) * 1000);
}

export function canonicalAskUserExecutors(options: CanonicalAskUserExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.ask_user": async (input) => {
      const tool = input.tool.name;
      if (!options.codeAskUserService) toolNotConfigured(tool, "the user-question service wiring");
      const service = options.codeAskUserService;
      const sessionId = input.sessionId;
      // Both identities come from the invocation envelope. Without them the question could not be found again
      // (no run to pause, no tool call to be idempotent on), so the call is refused rather than half-recorded.
      if (!sessionId || !input.runId || !input.toolCallId) {
        throw new CodeToolError(
          "invalid_arguments",
          `${tool} requires an active run: it pauses the run until a human answers`,
          400,
          "validate_arguments",
          false,
          tool,
        );
      }
      const choices = Array.isArray(input.args.choices)
        ? input.args.choices as Array<{ id: string; label: string; description?: string }>
        : [];
      const ttlMs = ttlMsFromArgs(input.args);
      try {
        const result = await service.ask({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          prompt: String(input.args.prompt ?? ""),
          choices,
          ...(input.args.allowFreeAnswer === undefined ? {} : { allowFreeAnswer: input.args.allowFreeAnswer === true }),
          ...(ttlMs === undefined ? {} : { ttlMs }),
          createdBy: input.ctx.userId ?? null,
        });
        // Metadata only: the question text is the user's to read, and the model must not be handed back a
        // "result" it could mistake for an answer. It learns that the run is paused, and nothing more.
        return {
          questionId: result.question.id,
          status: result.question.status,
          choices: result.question.choices.length,
          allowFreeAnswer: result.question.allowFreeAnswer,
          expiresAt: result.question.expiresAt.toISOString(),
        };
      } catch (error) { rethrowAskUser(error, tool); }
    },
  };
}

/**
 * C3 post-write hook: runs a deployment-configured command (formatter, syntax check) in the sandbox over
 * the files a change touched. It returns warnings only — the hook never blocks a write, never rewrites a
 * file behind the caller's back and never runs when no command is configured.
 */
export async function runSandboxPostWriteHook(
  sandbox: { execute(ctx: CodeToolExecutionContext["ctx"], companyId: string, request: { projectId: string; command: string; timeoutMs?: number }): Promise<{ stdout?: string; output?: string; exitCode?: number }> },
  ctx: CodeToolExecutionContext["ctx"],
  companyId: string,
  projectId: string,
  command: string | undefined,
  paths: string[],
): Promise<string[] | undefined> {
  if (!command || !paths.length) return undefined;
  const quoted = paths.map((path) => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  const result = await sandbox.execute(ctx, companyId, { projectId, command: `${command} ${quoted}`, timeoutMs: 120_000 });
  const output = (result.stdout ?? result.output ?? "").trim();
  const lines = output ? output.split("\n").slice(0, 20) : [];
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return lines.length ? lines : [`command exited with code ${result.exitCode}`];
  }
  return lines.length ? lines : undefined;
}

/**
 * The canonical executors, keyed by tool name exactly as the registry publishes them. Each one calls
 * the pure implementation with the adapted port and the configured limits; nothing is re-implemented.
 */
export function canonicalExecutors(options: CanonicalExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.fs.list": async (input) => {
      const args = input.args as { dir?: string; glob?: string; respectGitignore?: boolean; sortByMtime?: boolean; limit?: number };
      return listFiles({
        port: toCanonicalPort(input, options),
        dir: args.dir ?? ".",
        ...(args.glob !== undefined ? { glob: args.glob } : {}),
        ...(args.respectGitignore !== undefined ? { respectGitignore: args.respectGitignore } : {}),
        ...(args.sortByMtime !== undefined ? { sortByMtime: args.sortByMtime } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.read": async (input) => {
      const args = input.args as { path: string; offset?: number; limit?: number; maxLineLength?: number };
      return readFileLines({
        port: toCanonicalPort(input, options),
        path: args.path,
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.maxLineLength !== undefined ? { maxLineLength: args.maxLineLength } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.grep": async (input) => {
      const args = input.args as { pattern: string; mode?: CodeSearchRequest["mode"]; glob?: string; type?: string; contextLines?: number; maxResults?: number; ignoreCase?: boolean; fixedStrings?: boolean; path?: string };
      return grepFiles({
        port: toCanonicalPort(input, options),
        pattern: args.pattern,
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.glob !== undefined ? { glob: args.glob } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.contextLines !== undefined ? { contextLines: args.contextLines } : {}),
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        ...(args.ignoreCase !== undefined ? { ignoreCase: args.ignoreCase } : {}),
        ...(args.fixedStrings !== undefined ? { fixedStrings: args.fixedStrings } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.tree": async (input) => {
      const args = input.args as { dir?: string; maxDepth?: number; maxEntries?: number };
      return treeOverview({
        port: toCanonicalPort(input, options),
        ...(args.dir !== undefined ? { dir: args.dir } : {}),
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        ...(args.maxEntries !== undefined ? { maxEntries: args.maxEntries } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.symbols.outline": async (input) => {
      const args = input.args as { path: string; limit?: number };
      return symbolsOutline({
        port: toCanonicalPort(input, options),
        path: args.path,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        tool: input.tool.name,
      });
    },
    "code.project.info": async (input): Promise<ProjectInfoResult> => {
      if (!options.projectLoader) {
        // Runtime-shaped error so the HTTP layer reports 503 (tool_not_configured) rather than guessing.
        throw new CodeToolError(
          "tool_not_configured",
          "code.project.info has no project loader configured",
          503,
          "configure",
          false,
          input.tool.name,
        );
      }
      const args = input.args as { includeToolchain?: boolean; includeVerifyCommands?: boolean };
      const project = await options.projectLoader({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId });
      if (!project) {
        throw new CodeToolError("project_not_found", `Project ${input.projectId} is not available`, 404, "resolve", false, input.tool.name);
      }
      return projectInfo({
        project,
        ...(args.includeToolchain !== undefined ? { includeToolchain: args.includeToolchain } : {}),
        ...(args.includeVerifyCommands !== undefined ? { includeVerifyCommands: args.includeVerifyCommands } : {}),
      });
    },
  };
}
