import { parseShellCommand, readOnlyGitSubcommand } from "./code-shell-classifier";
import { isSensitivePath } from "./code-tools-sensitive";

const HISTORY_SUBCOMMANDS = new Set(["log", "show", "diff", "status", "blame", "ls-files", "rev-parse", "shortlog"]);

/**
 * The sandbox has no .git folder, so reading history through the shell has to run against the project's repository.
 * Returns the git arguments when the command is one plain read of history that names no secret file; otherwise null,
 * and the command takes its normal path.
 */
export function gitHistoryArgs(command: string): string[] | null {
  const parsed = parseShellCommand(command);
  if (parsed.parseError || parsed.segments.length !== 1 || parsed.usesSubshell || parsed.usesBackticks || parsed.usesHeredoc || parsed.usesVariables) return null;
  const [executable, ...args] = parsed.segments[0]!.argv;
  if (executable !== "git" || !readOnlyGitSubcommand(args).safe) return null;
  if (!HISTORY_SUBCOMMANDS.has(args.find((value) => !value.startsWith("-")) ?? "")) return null;
  const namesSecret = args.some((value) => { const path = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value; return !path.startsWith("-") && path.length > 0 && isSensitivePath(path); });
  return namesSecret ? null : args;
}
