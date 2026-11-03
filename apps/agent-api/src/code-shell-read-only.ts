import { readOnlyGitSubcommand, readOnlyUtilityCommand } from "./code-shell-classifier";

/** True when one plain command provably writes nothing, so nothing has to be copied back from the sandbox. */
export function commandChangesNothing(executable: string, args: string[], raw: string): boolean {
  if (/[<>|;&`$\r\n]/.test(raw)) return false;
  if (executable === "git") return readOnlyGitSubcommand(args).safe;
  if (executable === "npm" && ["ls", "view", "audit"].includes(args[0] ?? "")) return true;
  return readOnlyUtilityCommand(executable, args, raw).safe;
}
