import { parseShellCommand } from "./code-shell-classifier";

/**
 * Actions the company's "act without asking" setting does not cover (V6 step 17, owner decision O17-06): they destroy
 * data or files that cannot be restored, so a person confirms them even when the agents may otherwise act alone.
 * Everything else keeps working without a question.
 */

/** Folders a build or install recreates; deleting them loses nothing. */
const DISPOSABLE = /^(?:\.\/)?(?:node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|\.vite|coverage|tmp|temp|\.tmp|__pycache__|\.pytest_cache|\.mypy_cache|target|\.dart_tool)(?:\/.*)?$/u;
const DELETING_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "dd", "mkfs", "wipefs"]);
const DATABASE_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlite", "mongosh", "mongo", "redis-cli"]);
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:table|database|schema|collection)|truncate\b|delete\s+from|flushall|flushdb|\.drop\(|\.deleteMany\()/iu;

function deletesOnlyDisposable(args: readonly string[]): boolean {
  const targets = args.filter((arg) => !arg.startsWith("-"));
  return targets.length > 0 && targets.every((target) => DISPOSABLE.test(target.replace(/\/+$/u, "")) || /^\/tmp\//u.test(target));
}

export function isIrreversibleShellCommand(command: string | null | undefined): boolean {
  const text = String(command ?? "").trim();
  if (!text) return false;
  let segments: Array<{ argv: string[]; raw: string }>;
  try { segments = parseShellCommand(text).segments; } catch { segments = [{ argv: text.split(/\s+/u), raw: text }]; }
  for (const segment of segments) {
    const [rawProgram = "", ...args] = segment.argv;
    const program = rawProgram.split("/").pop()!.toLowerCase();
    if (program.startsWith("mkfs")) return true;
    if (DELETING_PROGRAMS.has(program)) {
      if ((program === "rm" || program === "rmdir" || program === "unlink") && deletesOnlyDisposable(args)) continue;
      return true;
    }
    if (program === "find" && args.some((arg) => arg === "-delete" || arg === "-exec" && /\brm\b/u.test(segment.raw))) return true;
    if (program === "git") {
      const sub = args.find((arg) => !arg.startsWith("-"));
      if (sub === "clean" && args.some((arg) => /^-[a-z]*f/iu.test(arg))) return true;
      if (sub === "reset" && args.includes("--hard")) return true;
    }
    if (DATABASE_CLIENTS.has(program) && DESTRUCTIVE_SQL.test(segment.raw)) return true;
  }
  return DESTRUCTIVE_SQL.test(text) && segments.some((segment) => DATABASE_CLIENTS.has((segment.argv[0] ?? "").split("/").pop()!.toLowerCase()));
}

/** Deleting rows, a table or a column of a project database. */
export function isIrreversibleDataTool(toolName: string, args: unknown): boolean {
  if (toolName === "code.data.rows.delete") return true;
  if (toolName === "code.data.schema.modify") {
    const operation = (args as { operation?: { kind?: unknown } } | null)?.operation;
    return operation?.kind === "drop_field" || operation?.kind === "drop_collection";
  }
  return false;
}
