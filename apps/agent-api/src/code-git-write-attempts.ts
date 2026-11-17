import { parseShellCommand } from "./code-shell-parser";
/**
 * C5a (D9): the git write a shell command performs, as far as it can be told from the command line.
 *
 * This is the one parser both layers share: `classifyShellCommand` uses it to decide whether a force
 * push targets a protected branch, and `code-policy-engine.ts` uses it to ask the **company**
 * protected-branch policy (`evaluateGitWrite`) about every refspec before any mode, rule or approval is
 * consulted. Keeping a single parser is what stops the classifier and the policy from disagreeing about
 * which branch `git push origin HEAD:main` writes to.
 */
export type GitWriteOperation = "push" | "force_push";
export interface GitWriteAttemptHint {
    operation: GitWriteOperation;
    /** The branch the refspec names, or `""` when the command names none (`git push`, `git push --all`). */
    branch: string;
}
/** Options that make an update forced. `--force-with-lease` is still a force push. */
export const GIT_FORCE_PUSH_FLAGS = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes"]);
/** Git global options that consume the next token, so the subcommand is not mistaken for their value. */
export const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path",
]);
/** `refs/heads/main`, `+main` and a leading `+` on a refspec all mean the same branch. */
export function normalizeGitRef(value: string): string {
    return value.trim().replace(/^\+/, "").replace(/^refs\/heads\//, "");
}
/** `origin main`, `HEAD:main` and `:main` (a remote deletion) all name a remote branch. */
export function normalizeGitRefspec(value: string): {
    branch: string;
    forced: boolean;
} | null {
    const forced = value.startsWith("+");
    const refspec = forced ? value.slice(1) : value;
    const separator = refspec.indexOf(":");
    const target = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    const branch = normalizeGitRef(target);
    return branch ? { branch, forced } : null;
}
/**
 * Every `git push` found in the command line, with the branch each refspec writes to. A push that names
 * no branch reports `branch: ""` — the branch of `git push` is a property of the checkout, not of the
 * command, so it is deliberately *not* guessed here; the caller keeps the command's normal risk class.
 */
export function detectGitWriteAttempts(command: string): GitWriteAttemptHint[] {
    const attempts: GitWriteAttemptHint[] = [];
    if (typeof command !== "string" || !/\bpush\b/.test(command))
        return attempts;
    for (const segment of parseShellCommand(command).segments) {
        const argv = segment.argv;
        let index = 0;
        // Skip leading assignments and wrappers: `FOO=1 sudo git push origin main`.
        while (index < argv.length &&
            (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]!) || argv[index] === "sudo" || argv[index] === "env" || argv[index] === "command")) {
            index += 1;
        }
        if ((argv[index] ?? "").split("/").pop() !== "git")
            continue;
        index += 1;
        while (index < argv.length && argv[index]!.startsWith("-")) {
            index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(argv[index]!) ? 2 : 1;
        }
        if (argv[index] !== "push")
            continue;
        const rest = argv.slice(index + 1);
        const forced = rest.some((value) => GIT_FORCE_PUSH_FLAGS.has(value) || value.startsWith("--force-with-lease=") || value.startsWith("--force-if-includes="));
        const positionals = rest.filter((value) => !value.startsWith("-"));
        // `git push <remote> <refspec>...`: the first positional is the remote, the rest are the branches.
        const refspecs = positionals.slice(1).map(normalizeGitRefspec).filter((value): value is {
            branch: string;
            forced: boolean;
        } => value !== null);
        if (!refspecs.length) {
            attempts.push({ operation: forced ? "force_push" : "push", branch: "" });
            continue;
        }
        for (const refspec of refspecs) {
            attempts.push({ operation: forced || refspec.forced ? "force_push" : "push", branch: refspec.branch });
        }
    }
    return attempts;
}
