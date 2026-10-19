import { CodeToolError as CanonicalToolError } from "./code-tools-path";
import {
  type CodeDirEntry,
  type CodeReadPort as FsReadPort,
  type CodeSearchRequest,
  type CodeSearchResponse,
} from "./code-tools-fs";
import type { ProjectInfoInput } from "./code-tools-project";
import { CodeToolError, type CodeReadPort, type CodeToolExecutionContext } from "./code-tool-runtime";

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
  const port2 = port;
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
        sha256: file.sha256,
        revision: file.revision,
        ...(file.binary !== undefined ? { binary: file.binary } : {}),
        ...(file.mimeGuess !== undefined ? { mimeGuess: file.mimeGuess } : {}),
        // Raw byte size survives decoding and read truncation; custom ports retain the legacy fallback.
        bytes: file.bytes ?? Buffer.byteLength(file.content, "utf8"),
        truncated: file.truncated === true,
        encoding: file.encoding ?? "utf-8",
      };
    },
    async runSearch(request: CodeSearchRequest): Promise<CodeSearchResponse> {
      const result = await port2.runSearch({
        ctx, companyId, projectId,
        query: request.pattern,
        glob: request.glob, type: request.type, ignoreCase: request.ignoreCase,
        fixedStrings: request.fixedStrings, contextLines: request.contextLines,
        ...(request.path ? { path: request.path } : {}),
        maxResults: Math.max(1, Math.min(request.maxResults ?? 200, 1000)),
        timeoutMs: limits.commandTimeoutMs,
      });
      const lines = (result.matches ?? []).map((match) => ({ path: match.path, line: match.line, text: match.text, ...(match.context ? { context: match.context } : {}) }));
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

export function toolNotConfigured(tool: string, what: string): never {
  throw new CodeToolError(
    "tool_not_configured",
    `${tool} is not available in this deployment: ${what} is not configured`,
    503,
    "dispatch",
    false,
    tool,
  );
}

export function stringArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length) return value;
  }
  return null;
}

export function stringListArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length ? items : undefined;
}

export function envArg(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "string")
    .map(([key, item]) => [key, item as string] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
