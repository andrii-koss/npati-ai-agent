import { CodeToolError as CanonicalToolError } from "./code-tools-path";
import {
  codeToolLimits, grepFiles, listFiles, readFileLines, symbolsOutline, treeOverview,
  type CodeDirEntry, type CodeReadPort as FsReadPort, type CodeSearchRequest, type CodeSearchResponse,
} from "./code-tools-fs";
import { projectInfo, type ProjectInfoInput, type ProjectInfoResult } from "./code-tools-project";
import { CodeToolError, type CodeReadPort, type CodeToolExecutionContext } from "./code-tool-runtime";

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
