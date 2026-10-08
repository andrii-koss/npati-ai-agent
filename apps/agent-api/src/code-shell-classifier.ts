import {
  classifyTerminalCommand,
  normalizeTerminalCommand,
  type TerminalRiskLevel,
} from "./terminal-command-policy";
import { detectPackageManager, type PackageManager } from "./code-deps-policy";
import { DEFAULT_INSTALL_ALLOWLIST } from "./egress-allowlist";
import { detectMigrationAction, type MigrationActionHint } from "./code-migration-safety";

/**
 * C4: shell command classification for the Coding Agent.
 *
 * The Website Builder already had a policy for the interactive terminal
 * (`terminal-command-policy.ts`), but it decides from the executable plus its arguments and therefore
 * cannot see `a && rm -rf /`, command substitution, heredocs or variable indirection. This module
 * extends that policy instead of replacing it:
 *
 * - `parseShellCommand` performs a real (dependency-free) tokenisation of the whole command line.
 * - `classifyShellCommand` keeps the existing three levels (`safe` / `controlled` / `approval`, taken
 *   from `classifyTerminalCommand` per segment) and adds the Coding Agent's fourth level `hard_deny`,
 *   which no mode — not even the owner — may run.
 * - Anything the parser cannot prove safe is escalated to `approval`, never downgraded to `safe`.
 */

export type CodeShellRisk = TerminalRiskLevel | "hard_deny";

export interface ShellSegment {
  argv: string[];
  /** The operator that preceded this segment (`&&`, `||`, `;`, `|`, `&`). */
  operator?: string;
  raw: string;
}

export interface ParsedShellCommand {
  segments: ShellSegment[];
  usesSubshell: boolean;
  usesBackticks: boolean;
  usesHeredoc: boolean;
  usesVariables: boolean;
  redirectsToOutside: boolean;
  parseError?: string;
}

export interface ShellClassification {
  risk: CodeShellRisk;
  reasons: string[];
  /** Hard-deny rules or escalation triggers that fired. */
  matched: string[];
  segments: ShellSegment[];
  parsed: ParsedShellCommand;
  /**
   * C4a: dependency-install hint (manager, action, whether the source is a URL/tarball). It lets the
   * PolicyEngine decide about installs without parsing the command a second time.
   */
  deps?: DepsHint;
  /**
   * C6a: database-migration hint (runner, action, whether the command itself is destructive). The
   * PolicyEngine turns it into a hard deny for a production/external/unknown target and into an approval
   * with a snapshot for destructive work; the classifier only guarantees that a migration command is never
   * `safe` or `controlled`.
   */
  migration?: MigrationActionHint;
}

/** C4a: what a command does with dependencies, as far as the classifier can tell. */
export interface DepsHint {
  manager: PackageManager;
  action: "install" | "add" | "audit" | "script" | "reconfigure";
  /** True when the command installs from a URL, git reference, tarball or local file. */
  fromUrl: boolean;
}

/**
 * C14: one hard-deny rule, named. The table below is exported so the attack catalogue guard can prove that
 * **every** rule id is either exercised by a red-team suite or carries a written exemption — a rule nobody
 * tests is a rule nobody would notice losing.
 */
export interface HardDenyRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

export interface ShellClassifierOptions {
  allowlist?: string[];
  protectedBranches?: string[];
  workspaceRoot?: string;
  /**
   * C14: the hard-deny rule set to evaluate. Defaults to the frozen `HARD_DENY_RULES` and **no production
   * caller passes it**. It exists so a denial can be attributed to a named rule as evidence rather than as a
   * promise: the mutation-sensitivity suite substitutes the set, removes exactly one rule, and shows that the
   * specific denial disappears — if it did not, the control would be decorative.
   *
   * It is deliberately not an off-switch: an empty list is refused instead of silently disabling every
   * hard deny, and the default is always the full frozen table.
   */
  hardDenyRules?: readonly HardDenyRule[];
}

export interface ShellLimits {
  defaultMs?: number;
  installMs?: number;
}

const READ_ONLY_EXECUTABLES = new Set([
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "find", "fd", "tree", "stat", "file", "du", "df",
  "pwd", "echo", "printf", "sed", "awk", "cut", "sort", "uniq", "diff", "jq", "node", "python", "python3",
  "go", "cargo", "rustc", "java", "javac", "php", "composer", "tsc", "vitest", "jest", "pytest", "ruff",
  "eslint", "prettier", "gofmt", "make", "git", "which", "env", "date", "basename", "dirname", "true", "test",
]);

const INSTALL_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "poetry", "uv", "go", "cargo", "composer", "bundle", "apt", "apt-get", "apk"]);
const NETWORK_EXECUTABLES = new Set(["curl", "wget", "nc", "netcat", "ssh", "scp", "rsync", "ftp", "telnet"]);

/**
 * C14: the hard-deny table. Frozen and exported: it is the list the attack catalogue guard enumerates, and a
 * rule that a red-team suite does not exercise must be exempted *by name* in the catalogue instead of
 * quietly existing.
 */
export const HARD_DENY_RULES: readonly HardDenyRule[] = Object.freeze([
  { id: "rm_root", pattern: /(?:^|[\s;&|("'`=])rm\s+(?:-[A-Za-z]*\s+)*(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|--recursive\s+--force|--force\s+--recursive)\s+(?:\/|\/\*|~|~\/\*|\$HOME|\/etc|\/usr|\/var|\/bin|\/sbin|\/lib)(?:\s|$|\*|[)"'`;&|])/,
    reason: "recursive forced delete of the filesystem root or a system directory" },
  { id: "mkfs", pattern: /(?:^|[\s;&|("'`=])mkfs(?:\.\w+)?\s/, reason: "filesystem formatting is never allowed" },
  { id: "dd_device", pattern: /(?:^|[\s;&|("'`=])dd\s+[^;&|]*of=\/dev\//, reason: "raw write to a block device" },
  /**
   * C14: `[\s\S]` rather than `.` between the function body's parts. A shell accepts a newline wherever it
   * accepts a space, so `:(){\n:|:&\n};:` is the same fork bomb as the one-liner — with `.` the rule missed
   * it and the command fell back to `approval`, i.e. a human could have approved a fork bomb. Found by
   * `tests/coding-agent-c14-redteam-fork-bomb.test.ts`, which pins both spellings.
   */
  { id: "fork_bomb", pattern: /:\s*\(\s*\)\s*\{[\s\S]*\|[\s\S]*&[\s\S]*\}\s*;?\s*:/, reason: "fork bomb" },
  { id: "chmod_root", pattern: /(?:^|[\s;&|("'`=])chmod\s+(?:-[A-Za-z]+\s+)*777\s+(?:\/|\/\*)\s*(?:$|[;&|])/, reason: "world-writable root" },
  { id: "docker_socket", pattern: /\/var\/run\/docker\.sock/, reason: "the host docker socket is never reachable from the sandbox" },
  { id: "sandbox_network", pattern: /(?:^|[\s;&|("'`=])(?:iptables|ip6tables|nft|ip\s+route|systemctl|mount|umount|insmod|modprobe)\s/, reason: "changing sandbox or host network/system configuration" },
  { id: "host_secrets", pattern: /(?:^|[\s;&|("'`=])(?:cat|less|more|head|tail|cp|scp|tar|base64|xxd)\s+(?:[^;&|]*\s)?(?:\/etc\/shadow|\/etc\/sudoers|\/root\/\.ssh|~\/\.ssh|\/host\/)/, reason: "reading host secrets" },
  { id: "write_outside_workspace", pattern: /(?:>>?|tee\s+(?:-a\s+)?)\s*(?:\/(?!workspace|tmp|dev\/null|proc\/self)[A-Za-z0-9._-]+)/, reason: "writing outside the workspace" },
  { id: "protected_branch_force_push", pattern: /git\s+push\s+(?:[^;&|]*\s)?(?:--force|-f)(?:\s|$)/, reason: "force push is refused in protected branches" },
  // C4a: a download piped into a shell executes code nobody reviewed. Both orders, with or without
  // whitespace, and the process-substitution form are covered.
  { id: "download_pipe_shell", pattern: /(?:curl|wget)\b[^;&|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/, reason: "piping a download into a shell" },
  { id: "download_process_substitution", pattern: /(?:sh|bash|zsh|dash)\s+(?:-c\s+)?<\(\s*(?:curl|wget)\b/, reason: "running a downloaded script through process substitution" },
  /**
   * G1 (D10): four shapes whose *real* content is not visible on the command line. Each of them used to
   * degrade to `approval` — a level a human may grant — which made the approval a formality: nobody can
   * review a command that has to be decoded before it can be read. The rule is deliberately about
   * **unreadability plus execution**, never about a word appearing somewhere (a decoded file written to
   * disk, a literal `eval "echo hi"` or a PATH **read** all keep their previous level).
   */
  // A decoder piped into a shell: `base64 -d payload | sh`, `xxd -r -p <<< … | bash`. The analogue of
  // `download_pipe_shell` for a payload that travels inside the command instead of over the network.
  { id: "decode_pipe_shell", pattern: /(?:^|[\s;&|("'`=])(?:base64|xxd|uudecode|openssl|rev|gzip|zcat|gunzip|bzip2|bunzip2|xz|unxz)\b[^;&|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|eval|source)\b/, reason: "piping decoded or de-obfuscated text into a shell" },
  // `eval`/`source` applied to text the command line does not contain: a substitution, a backtick or a
  // variable. A *literal* `eval "echo hi"` is not matched (it is readable, and it stays an approval).
  { id: "eval_dynamic", pattern: /(?:^|[\s;&|("'`=])(?:eval|source)\s+(?:"|')?(?:\$\(|`|\$\{?[A-Za-z_])/, reason: "evaluating text that the command line does not show" },
  // `alias` / `unalias`: the classifier judges a later segment by **name**, so redefining a name makes the
  // rest of the command line a decision about a label instead of a program. Anchored at the start of a
  // segment (leading `VAR=x` assignments allowed) so `echo alias` is not a hit.
  { id: "shell_alias_definition", pattern: /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:alias|unalias)\b/, reason: "redefining a shell command name, which the classifier decided by name" },
  // Rewriting (or clearing) `PATH`: every per-segment decision above is about a resolved program name, so a
  // PATH prefix can point that name at a different binary. A PATH *read* (`echo $PATH`) is untouched.
  { id: "path_manipulation", pattern: /^\s*(?:(?:export(?:\s+-n)?|declare\s+-x|typeset\s+-x|env)\s+)?(?:PATH\s*=|unset\s+PATH(?:\s|$))/, reason: "rewriting PATH changes which program a name resolves to" },
]);

/** Registry configuration files: writing to them re-points every future install. */
const REGISTRY_CONFIG_FILES = /(?:\.npmrc|\.yarnrc(?:\.yml)?|\.yarnrc|pip\.conf|\.pypirc)\b/;

/** Commands that make a store write or rewrite a registry configuration file. */
const REGISTRY_CONFIG_WRITE = /(?:sed\s+(?:-[A-Za-z]*i[A-Za-z]*|--in-place)|>>?\s*\S*(?:\.npmrc|\.yarnrc|pip\.conf)|tee\s+(?:-a\s+)?\S*(?:\.npmrc|\.yarnrc|pip\.conf))/;

const INSTALL_URL_ARGUMENT = /^(?:https?:\/\/|git\+|git@|file:)|\.(?:tgz|tar\.gz|whl)$/;
const RECONFIGURE_ARGS = /(?:^|\s)(?:config\s+set|set\s+registry|config\s+--set)(?:\s|$)/;
const LIFECYCLE_SCRIPT_ARGS = /(?:^|\s)(?:rebuild|postinstall|preinstall|prepublish|prepare|husky\s+install)(?:\s|$)/;

/** Flags that keep an install reproducible and non-executing. Anything else cancels the downgrade. */
export const REPRODUCIBLE_INSTALL_FLAGS = [
  "--ignore-scripts", "--no-fund", "--no-audit", "--prefer-offline", "--offline", "--frozen-lockfile",
  "--immutable", "--locked", "--only-binary=:all:", "--no-interaction", "--prefer-dist", "--no-progress",
  "--no-root", "--no-ansi", "--frozen", "--no-install-project", "--non-interactive", "--no-dev",
] as const;

/** Flags or arguments that make an install non-reproducible or able to execute code. */
const UNSAFE_INSTALL_ARGS = /--(?:foreground-scripts|scripts-prepend-node-path|ignore-scripts=false)|--registry=|--index-url|--extra-index-url|--no-optional=false/;

/**
 * C4a: recognises a *reproducible install* — an install/fetch shape whose every argument is a
 * hardened, non-executing flag. Only these are lowered to `controlled` at the Coding Agent layer,
 * because C4a must be able to run them without an approval while still refusing anything that can
 * execute code, mutate a registry or fetch from an arbitrary source.
 */
export function reproducibleInstallCommand(executable: string, args: string[]): { controlled: boolean; reason: string } {
  const manager = executable === "npm" || executable === "npx" ? "npm"
    : executable === "pnpm" ? "pnpm"
      : executable === "yarn" ? "yarn"
        : executable === "cargo" ? "cargo"
          : executable === "go" ? "go"
            : executable === "pip" || executable === "pip3" ? "pip"
              : executable === "uv" ? "uv"
                : executable === "poetry" ? "poetry"
                  : executable === "composer" ? "composer" : undefined;
  if (!manager) return { controlled: false, reason: `${executable} is not a package manager install` };
  if (args.some((value) => UNSAFE_INSTALL_ARGS.test(value))) return { controlled: false, reason: "the install passes a flag that can execute code or re-point the registry" };
  const flags = args.filter((value) => value.startsWith("-"));
  const positional = args.filter((value) => !value.startsWith("-"));
  const allowed = (value: string) => (REPRODUCIBLE_INSTALL_FLAGS as readonly string[]).includes(value)
    || (/^-r$/.test(value)) || (/^[A-Za-z0-9@._/+~-]+$/.test(value) && !/^(?:https?|git\+|file:)/.test(value));
  if (!flags.every(allowed)) return { controlled: false, reason: "the install uses a flag that is not part of the hardened set" };

  switch (manager) {
    case "npm":
      // `npm ci` is the only npm install that is reproducible without further flags.
      return positional[0] === "ci"
        ? { controlled: true, reason: "npm ci is a reproducible install with scripts disabled" }
        : { controlled: false, reason: "npm needs `ci` for a reproducible install" };
    case "pnpm":
      return positional[0] === "install" && flags.includes("--frozen-lockfile")
        ? { controlled: true, reason: "pnpm install --frozen-lockfile is a reproducible install" }
        : { controlled: false, reason: "pnpm needs `install --frozen-lockfile`" };
    case "yarn":
      return positional[0] === "install" && (flags.includes("--frozen-lockfile") || flags.includes("--immutable"))
        ? { controlled: true, reason: "yarn install with a frozen lockfile is reproducible" }
        : { controlled: false, reason: "yarn needs `install --frozen-lockfile` or `--immutable`" };
    case "cargo":
      return positional[0] === "fetch" && flags.includes("--locked")
        ? { controlled: true, reason: "cargo fetch --locked is a reproducible fetch" }
        : { controlled: false, reason: "cargo needs `fetch --locked`" };
    case "go":
      return positional[0] === "mod" && positional[1] === "download" && positional.length === 2
        ? { controlled: true, reason: "go mod download is a reproducible fetch" }
        : { controlled: false, reason: "go needs `mod download`" };
    case "pip":
      return positional[0] === "install" && flags.includes("-r") && flags.includes("--only-binary=:all:")
        ? { controlled: true, reason: "pip install --only-binary=:all: -r is reproducible and binary-only" }
        : { controlled: false, reason: "pip needs `install --only-binary=:all: -r <file>`" };
    case "uv":
      return positional[0] === "sync" && flags.includes("--frozen")
        ? { controlled: true, reason: "uv sync --frozen is reproducible" }
        : { controlled: false, reason: "uv needs `sync --frozen`" };
    case "poetry":
      return positional[0] === "install"
        ? { controlled: true, reason: "poetry install --no-root is reproducible" }
        : { controlled: false, reason: "poetry needs `install`" };
    case "composer":
      return positional[0] === "install" && flags.includes("--no-scripts") && flags.includes("--no-plugins")
        ? { controlled: true, reason: "composer install --no-scripts --no-plugins is reproducible" }
        : { controlled: false, reason: "composer needs `install --no-scripts --no-plugins`" };
    default:
      return { controlled: false, reason: `${manager} is not covered by the reproducible install shapes` };
  }
}

/**
 * C4a: derives the dependency hint for a command line. Returns `undefined` when no package manager is
 * involved, so callers can treat the field as "this is an install command".
 */
export function detectDepsHint(command: string): DepsHint | undefined {
  const text = String(command ?? "");
  const lowered = text.toLowerCase();
  // Git-hook installation is dangerous even when no package manager is named: `husky install` writes
  // hooks that run on every commit, so it still gets a `script` hint (and therefore an approval) rather
  // than being reported as "no dependency work involved".
  if (/\bhusky\s+install\b/.test(lowered)) return { manager: "unknown", action: "script", fromUrl: false };
  const manager = detectPackageManager(text);
  if (manager === "unknown") return undefined;
  const fromUrl = /(?:https?:\/\/|git\+|git@|file:)/.test(lowered) || /\.(?:tgz|tar\.gz|whl)(?:\s|$)/.test(lowered);
  const action: DepsHint["action"] = LIFECYCLE_SCRIPT_ARGS.test(lowered) || /\bhusky\s+install\b/.test(lowered) ? "script"
    : RECONFIGURE_ARGS.test(lowered) || /--registry=/.test(lowered) ? "reconfigure"
      : /(?:^|\s)(?:add|i)(?:\s|$)/.test(lowered) ? "add"
        : /(?:^|\s)audit(?:\s|$)/.test(lowered) ? "audit"
          : "install";
  return { manager, action, fromUrl };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

/** A real tokeniser for a shell command line: operators, quoting and escaping are handled. */
export function parseShellCommand(command: string): ParsedShellCommand {
  const segments: ShellSegment[] = [];
  const parsed: ParsedShellCommand = {
    segments, usesSubshell: false, usesBackticks: false, usesHeredoc: false, usesVariables: false,
    redirectsToOutside: false,
  };
  if (typeof command !== "string" || !command.trim()) {
    return { ...parsed, parseError: "empty_command" };
  }
  parsed.usesSubshell = /\$\(/.test(command);
  parsed.usesBackticks = /`[^`]*`/.test(command);
  parsed.usesHeredoc = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(command);
  parsed.usesVariables = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(command);
  parsed.redirectsToOutside = /(?:^|[\s;&|])>>?\s*(?:\/(?!workspace|tmp|dev\/null|proc\/self))/.test(command);

  let current = "";
  let quote: '"' | "'" | null = null;
  let pendingOperator: string | undefined;
  const push = () => {
    const raw = current.trim();
    if (raw) segments.push({ argv: tokenise(raw), operator: pendingOperator, raw });
    current = "";
    pendingOperator = undefined;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      if (char === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; current += char; continue; }
    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||" || two === ">>" || two === "2>") {
      if (two === ">>" || two === "2>") { current += two; index += 1; continue; }
      push();
      pendingOperator = two;
      index += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === "&") {
      if (char === "|" && command[index + 1] === "|") { push(); pendingOperator = "||"; index += 1; continue; }
      push();
      pendingOperator = char;
      continue;
    }
    current += char;
  }
  if (quote) parsed.parseError = "unterminated_quote";
  push();
  if (!segments.length) parsed.parseError = parsed.parseError ?? "no_segments";
  return parsed;
}

function tokenise(raw: string): string[] {
  const argv: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote && raw[index - 1] !== "\\") { quote = null; continue; }
      token += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (char === "\\" && raw[index + 1]) { token += raw[index + 1]; index += 1; continue; }
    if (/\s/.test(char)) { if (token) { argv.push(token); token = ""; } continue; }
    token += char;
  }
  if (token) argv.push(token);
  return argv;
}

function hasRecursiveForce(argv: string[]): boolean {
  return argv.some((value) => /^-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*$|^-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*$/.test(value) || value === "--recursive-force");
}

function targetsOutsideWorkspace(argv: string[], workspaceRoot?: string): boolean {
  return argv.some((value) => {
    if (value.startsWith("/workspace")) return false;
    if (!value.startsWith("/") && !value.startsWith("~")) return false;
    if (value === "/dev/null") return false;
    if (workspaceRoot && value.startsWith(workspaceRoot)) return false;
    return true;
  });
}

/** Exact or subdomain match only: `npmjs.org.evil.com` is not allowlisted by `npmjs.org`. */
export function isAllowlistedHost(host: string, allowlist: string[]): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  if (!target) return false;
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!allowed) return false;
    return target === allowed || target.endsWith(`.${allowed}`);
  });
}

export function resolveCommandLimits(command: string, limits: ShellLimits = {}): { timeoutMs: number; timeoutClass: "default" | "install" } {
  const timeoutClass = classifyShellCommand(command).timeoutClass;
  if (timeoutClass === "install") return { timeoutMs: limits.installMs ?? 600_000, timeoutClass: "install" };
  return { timeoutMs: limits.defaultMs ?? 120_000, timeoutClass: "default" };
}

/** Read-only git subcommands that the Coding Agent may run without approval. */
export const READ_ONLY_GIT_SUBCOMMANDS = [
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "whatchanged", "grep", "cat-file", "show-ref", "for-each-ref", "merge-base",
] as const;

/**
 * Options that turn even a read-only-looking git command into something else: they can run arbitrary
 * programs, read or write files, or point git at another repository. Their presence disables the
 * downgrade entirely (the command stays `approval`).
 */
export const FORBIDDEN_GIT_OPTIONS = [
  "-c", "--config-env", "--exec", "--exec-path", "--upload-pack", "--receive-pack", "--ext-diff",
  "--textconv", "--output", "--no-index", "--git-dir", "--work-tree", "-C", "--force", "--hard",
  "--amend",
] as const;

/** Subcommands and option forms that mutate state: never downgraded. */
export const MUTATING_GIT_FORMS = [
  "push", "commit", "checkout", "switch", "reset", "clean", "rebase", "cherry-pick", "revert", "merge",
  "apply", "am", "gc", "prune", "filter-branch", "update-ref", "worktree", "submodule",
] as const;

/**
 * Read-only utilities the Coding Agent may run without approval. The Website Builder terminal policy
 * is stricter (it also serves the interactive terminal), so the level is lowered **here only**, and
 * only for a command that provably neither writes nor executes anything (see
 * `readOnlyUtilityCommand`).
 */
export const READ_ONLY_UTILITIES = [
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "fd", "tree", "stat", "file", "du", "df", "pwd",
  "echo", "printf", "cut", "sort", "uniq", "diff", "jq", "which", "basename", "dirname", "true", "test",
  "find",
] as const;

/**
 * Options that turn a nominally read-only utility into something that writes or spawns: their
 * presence cancels the downgrade, so the command keeps the base policy's level (`approval`).
 */
const READ_ONLY_FORBIDDEN_OPTIONS = [
  "-i", "--in-place", "--output", "-exec", "-execdir", "-delete", "-fprint", "-fprint0", "-fls",
  "-fprintf", "-ok", "--files0-from",
] as const;

/** Executables that are read-only in their version-query form only (`node -v`, `python --version`). */
const VERSION_ONLY_EXECUTABLES = new Set([
  "node", "python", "python3", "go", "cargo", "rustc", "java", "php", "composer", "npm", "pnpm", "yarn",
  "tsc", "make",
]);
const VERSION_FLAG = /^(?:-v|-V|--version|version)$/;

/**
 * Decides whether a plain utility invocation is provably read-only. Deliberately conservative: any
 * output redirection, any option that can write or spawn, and any executable that can execute code
 * (unless it only reports its version) keeps the base policy's level.
 */
export function readOnlyUtilityCommand(executable: string, args: string[], raw = ""): { safe: boolean; reason: string } {
  if (/>|>>/.test(raw)) return { safe: false, reason: "the command redirects output, so it is not read-only" };
  if (VERSION_ONLY_EXECUTABLES.has(executable)) {
    return args.length > 0 && args.every((value) => VERSION_FLAG.test(value))
      ? { safe: true, reason: `${executable} only reports its version` }
      : { safe: false, reason: `${executable} can execute code and requires approval` };
  }
  if (!(READ_ONLY_UTILITIES as readonly string[]).includes(executable)) {
    return { safe: false, reason: `${executable} is not a whitelisted read-only utility` };
  }
  const forbidden = args.find((value) => READ_ONLY_FORBIDDEN_OPTIONS.some((option) => value === option || value.startsWith(`${option}=`))
    || (executable === "sort" && (value === "-o" || value.startsWith("-o "))));
  if (forbidden) return { safe: false, reason: `option ${forbidden} can write, so the command is not read-only` };
  return { safe: true, reason: `${executable} is a whitelisted read-only utility` };
}

const GIT_GLOBAL_OPTIONS_OK = new Set(["--no-pager", "--literal-pathspecs", "--no-optional-locks"]);const BRANCH_LIST_OPTIONS = /^(?:--list|--all|--remotes|-a|-r|-v|-vv|--verbose|--format=.*|--contains.*|--merged.*|--no-merged.*|--points-at.*|--sort=.*)$/;
const TAG_LIST_OPTIONS = /^(?:--list|-l|--contains.*|--merged.*|--no-merged.*|--points-at.*|--sort=.*|-n\d*)$/;
const REMOTE_READ_OPTIONS = /^(?:-v|--verbose|show|get-url)$/;
const CONFIG_READ_OPTIONS = /^(?:--get|--get-all|--get-regexp|--list|-l)$/;

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
const GIT_FORCE_PUSH_FLAGS = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes"]);

/** Git global options that consume the next token, so the subcommand is not mistaken for their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path",
]);

/** `refs/heads/main`, `+main` and a leading `+` on a refspec all mean the same branch. */
function normalizeGitRef(value: string): string {
  return value.trim().replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

/** `origin main`, `HEAD:main` and `:main` (a remote deletion) all name a remote branch. */
function normalizeGitRefspec(value: string): { branch: string; forced: boolean } | null {
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
  if (typeof command !== "string" || !/\bpush\b/.test(command)) return attempts;
  for (const segment of parseShellCommand(command).segments) {
    const argv = segment.argv;
    let index = 0;
    // Skip leading assignments and wrappers: `FOO=1 sudo git push origin main`.
    while (
      index < argv.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]!) || argv[index] === "sudo" || argv[index] === "env" || argv[index] === "command")
    ) {
      index += 1;
    }
    if ((argv[index] ?? "").split("/").pop() !== "git") continue;
    index += 1;
    while (index < argv.length && argv[index]!.startsWith("-")) {
      index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(argv[index]!) ? 2 : 1;
    }
    if (argv[index] !== "push") continue;
    const rest = argv.slice(index + 1);
    const forced = rest.some(
      (value) => GIT_FORCE_PUSH_FLAGS.has(value) || value.startsWith("--force-with-lease=") || value.startsWith("--force-if-includes="),
    );
    const positionals = rest.filter((value) => !value.startsWith("-"));
    // `git push <remote> <refspec>...`: the first positional is the remote, the rest are the branches.
    const refspecs = positionals.slice(1).map(normalizeGitRefspec).filter((value): value is { branch: string; forced: boolean } => value !== null);
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

/** Decides whether a git invocation is provably read-only (whitelist, opt-in per command). */
export function readOnlyGitSubcommand(args: string[]): { safe: boolean; reason: string } {  const lowered = args.map((value) => value.toLowerCase());
  const forbidden = lowered.find((value) => /^>>?/.test(value) || FORBIDDEN_GIT_OPTIONS.some((option) => value === option || value.startsWith(`${option}=`)));
  if (forbidden) return { safe: false, reason: `git option ${forbidden} is not allowed for a read-only command` };
  const mutating = lowered.find((value) => (MUTATING_GIT_FORMS as readonly string[]).includes(value));
  if (mutating) return { safe: false, reason: `git ${mutating} mutates state and requires approval` };

  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    if (!GIT_GLOBAL_OPTIONS_OK.has(args[index]!)) return { safe: false, reason: `git global option ${args[index]} is not allowed` };
    index += 1;
  }
  const subcommand = lowered[index];
  const rest = lowered.slice(index + 1);
  if (!subcommand) return { safe: false, reason: "git without a subcommand requires approval" };
  if ((READ_ONLY_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return { safe: true, reason: `git ${subcommand} is read-only` };
  }
  if (subcommand === "branch") {
    if (rest.some((value) => /^(?:-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--edit-description|--set-upstream-to|--unset-upstream)/.test(value))) {
      return { safe: false, reason: "git branch with a mutating option requires approval" };
    }
    const branchNames = rest.filter((value) => !value.startsWith("-"));
    if (branchNames.length) return { safe: false, reason: "git branch with a branch name is not read-only" };
    return rest.every((value) => BRANCH_LIST_OPTIONS.test(value))
      ? { safe: true, reason: "git branch --list is read-only" }
      : { safe: false, reason: "git branch with an unrecognised option requires approval" };
  }
  if (subcommand === "tag") {
    return rest.length > 0 && rest.every((value) => TAG_LIST_OPTIONS.test(value))
      ? { safe: true, reason: "git tag --list is read-only" }
      : { safe: false, reason: "git tag requires approval unless it only lists tags" };
  }
  if (subcommand === "remote") {
    return rest.length && REMOTE_READ_OPTIONS.test(rest[0]!) && rest.length <= 2
      ? { safe: true, reason: "git remote read is read-only" }
      : { safe: false, reason: "git remote changes require approval" };
  }
  if (subcommand === "stash") {
    return rest[0] === "list" || rest[0] === "show"
      ? { safe: true, reason: "git stash list is read-only" }
      : { safe: false, reason: "git stash requires approval unless it only lists entries" };
  }
  if (subcommand === "config") {
    return rest.length && CONFIG_READ_OPTIONS.test(rest[0]!)
      ? { safe: true, reason: "git config read is read-only" }
      : { safe: false, reason: "git config changes require approval" };
  }
  return { safe: false, reason: `git ${subcommand} is not on the read-only whitelist` };
}

const RISK_ORDER: Record<CodeShellRisk, number> = { safe: 0, controlled: 1, approval: 2, hard_deny: 3 };
const escalate = (current: CodeShellRisk, next: CodeShellRisk): CodeShellRisk => (RISK_ORDER[next] > RISK_ORDER[current] ? next : current);

export function classifyShellCommand(command: string, options: ShellClassifierOptions = {}): ShellClassification & { timeoutClass: "default" | "install" } {
  const parsed = parseShellCommand(command);
  const reasons: string[] = [];
  const matched: string[] = [];
  let risk: CodeShellRisk = "safe";
  let timeoutClass: "default" | "install" = "default";
  const deps = detectDepsHint(command);
  // C6a: running a database migration is never `safe` or `controlled`. The target check (production,
  // external, unknown → hard deny) and the destructive/snapshot decision live in
  // `code-migration-safety.ts` and are applied by the PolicyEngine, because they need context the command
  // text does not carry. A local `psql`/`sqlite3` session is deliberately *not* a migration action, so
  // existing behaviour for local development is unchanged.
  const migration = detectMigrationAction(command);
  if (migration) {
    risk = escalate(risk, "approval");
    matched.push(`migration:${migration.tool}:${migration.action}`);
    reasons.push(`running a database migration (${migration.tool} ${migration.action}) requires approval`);
  }

  // 1. Hard-deny rules run against the raw command and against every segment: a rule that only
  //    matches inside a subshell, heredoc or a later segment must still fire. The rule set is
  //    `HARD_DENY_RULES` unless a caller substituted it (C14 mutation evidence); an empty set is refused
  //    rather than treated as "no hard denies", so the seam can never be used as an off-switch.
  const hardDenyRules = options.hardDenyRules ?? HARD_DENY_RULES;
  if (!hardDenyRules.length) {
    throw new Error("classifyShellCommand: the hard-deny rule set must not be empty; hard denies cannot be switched off");
  }
  for (const rule of hardDenyRules) {
    const haystacks = [command, ...parsed.segments.map((segment) => segment.raw)];
    if (haystacks.some((value) => rule.pattern.test(value))) {
      if (rule.id === "protected_branch_force_push") {
        // Flags are not branch names: `detectGitWriteAttempts` resolves the refspec (`origin main`,
        // `refs/heads/main`, `HEAD:main`, the `+main` force form) with the same parser the PolicyEngine
        // uses to consult the company policy, so the classifier and the policy cannot disagree.
        const protectedBranches = (options.protectedBranches ?? ["main", "master", "release"]).map(normalizeGitRef);
        const target = detectGitWriteAttempts(command)
          .filter((attempt) => attempt.operation === "force_push")
          .find((attempt) => attempt.branch !== "" && protectedBranches.includes(attempt.branch));
        if (!target) { risk = escalate(risk, "approval"); matched.push(`${rule.id}:unprotected_branch`); reasons.push(`${rule.reason} (branch not protected)`); continue; }
      }
      return { risk: "hard_deny", reasons: [...reasons, rule.reason], matched: [...matched, rule.id], segments: parsed.segments, parsed, timeoutClass, deps, migration };
    }
  }

  // 2. Anything the parser cannot fully prove is escalated: substitution, heredocs and variables can
  //    hide an arbitrary command, so they can never be `safe`.
  if (parsed.parseError) { risk = escalate(risk, "approval"); reasons.push(`command could not be fully parsed (${parsed.parseError})`); matched.push("parse_error"); }
  if (parsed.usesSubshell) { risk = escalate(risk, "approval"); reasons.push("command substitution hides another command"); matched.push("subshell"); }
  if (parsed.usesBackticks) { risk = escalate(risk, "approval"); reasons.push("backtick substitution hides another command"); matched.push("backticks"); }
  if (parsed.usesHeredoc) { risk = escalate(risk, "approval"); reasons.push("heredoc feeds an unverified program body"); matched.push("heredoc"); }
  if (parsed.usesVariables) { risk = escalate(risk, "approval"); reasons.push("variable indirection hides the executed command"); matched.push("variables"); }
  if (parsed.redirectsToOutside) { risk = escalate(risk, "approval"); reasons.push("redirect writes outside the workspace"); matched.push("redirect_outside"); }

  // 3. Per-segment decisions come from the existing Website Builder policy, then get refined here.
  for (const segment of parsed.segments) {
    const [executable = "", ...args] = segment.argv;
    if (!executable) continue;
    // The Website Builder policy validates arguments and throws for shapes it does not recognise;
    // that must escalate to approval, never crash the classifier.
    let base: { level: CodeShellRisk; reason?: string; timeoutClass?: string };
    try {
      base = classifyTerminalCommand({ executable, args, command: segment.raw });
    } catch (error) {
      base = { level: "approval", reason: `terminal policy could not validate this command: ${error instanceof Error ? error.message : String(error)}`, timeoutClass: "default" };
    }
    let segmentRisk: CodeShellRisk = base.level;
    reasons.push(`${executable}: ${base.reason ?? base.level}`);
    // The Website Builder policy already classifies long-running install/build work.
    if (base.timeoutClass === "install_build") timeoutClass = "install";

    const readOnlyUtility = readOnlyUtilityCommand(executable, args, segment.raw);
    if (readOnlyUtility.safe) {
      // Provably read-only utilities (and version queries) do not mutate anything, so they must not
      // require approval even though the shared terminal policy is stricter.
      segmentRisk = "safe";
      reasons.push(readOnlyUtility.reason);
    } else if (!READ_ONLY_EXECUTABLES.has(executable) && !INSTALL_EXECUTABLES.has(executable) && !NETWORK_EXECUTABLES.has(executable)) {
      segmentRisk = escalate(segmentRisk, "approval");
      matched.push(`unknown_executable:${executable}`);
      reasons.push(`unknown executable ${executable} requires approval`);
    }
    if (INSTALL_EXECUTABLES.has(executable) && /(?:^|\s)(?:install|ci|add|sync|download|fetch)(?:\s|$)/.test(` ${args.join(" ")} `)) {
      timeoutClass = timeoutClass === "install" ? timeoutClass : "install";
      if (readOnlyUtility.safe) segmentRisk = "controlled";
    }
    if (executable === "rm" && hasRecursiveForce(args)) {
      if (targetsOutsideWorkspace(args, options.workspaceRoot)) {
        return { risk: "hard_deny", reasons: [...reasons, "recursive delete outside the workspace"], matched: [...matched, "rm_outside_workspace"], segments: parsed.segments, parsed, timeoutClass, deps, migration };
      }
      segmentRisk = escalate(segmentRisk, "approval");
      matched.push("rm_recursive_inside_workspace");
      reasons.push("recursive delete inside the workspace requires approval");
    }
    if (NETWORK_EXECUTABLES.has(executable)) {
      const host = args.find((value) => /^https?:\/\//.test(value)) ? new URL(args.find((value) => /^https?:\/\//.test(value))!).hostname : undefined;
      // Single source of truth for registry hosts: the canonical egress allowlist module. The install
      // phase may reach official registries; git hosts and vendor mirrors are never implicit here.
      const allowlist = options.allowlist ?? [...DEFAULT_INSTALL_ALLOWLIST];
      if (host && isAllowlistedHost(host, allowlist)) {
        // A download from an allowlisted registry is controlled work, not something to review: the
        // base terminal policy returns `approval` for every network call, so the level is set here.
        segmentRisk = "controlled";
        matched.push("network_host_allowlisted");
        reasons.push(`network host ${host} is allowlisted`);
      }
      else { segmentRisk = escalate(segmentRisk, "approval"); matched.push("network_not_allowlisted"); reasons.push(`network host ${host ?? "(unknown)"} is not allowlisted`); }
      if (/(?:\|\s*(?:sh|bash|zsh)\b)/.test(command)) {
        return { risk: "hard_deny", reasons: [...reasons, "piping a download into a shell"], matched: [...matched, "curl_pipe_sh"], segments: parsed.segments, parsed, timeoutClass, deps, migration };
      }
    }
    if (executable === "git") {
      const readOnly = readOnlyGitSubcommand(args);
      if (readOnly.safe) {
        // The Website Builder terminal policy returns `approval` for every git invocation. The Coding
        // Agent plan requires read-only git (status/diff/log/…) to be `safe`, so the level is lowered
        // **only here** and **only** for a provably read-only subcommand without any mutating or
        // dangerous option; the base policy itself is left untouched.
        segmentRisk = "safe";
        reasons.push(readOnly.reason);
      } else {
        const sub = args.find((value) => !value.startsWith("-"));
        if (sub === "push" || sub === "commit") {
          segmentRisk = escalate(segmentRisk, "approval");
          matched.push(`git_${sub}`);
          reasons.push(`git ${sub} requires approval`);
        } else {
          reasons.push(readOnly.reason);
        }
      }
    }
    if (executable === "sh" || executable === "bash" || executable === "zsh") {
      if (/(?:^|\s)-c(?:\s|$)/.test(` ${args.join(" ")} `)) { segmentRisk = escalate(segmentRisk, "approval"); matched.push("shell_dash_c"); reasons.push("an inline shell script requires approval"); }
    }
    // C4a: install-related escalations. None of them lowers a level; `npm ci`,
    // `pnpm install --frozen-lockfile` and `cargo fetch --locked` stay `controlled` as before.
    let installEscalated = false;
    if (INSTALL_EXECUTABLES.has(executable) || executable === "corepack" || executable === "npx") {
      const argsText = ` ${args.join(" ")} `;
      const urlArgument = args.find((value) => INSTALL_URL_ARGUMENT.test(value));
      if (urlArgument) {
        installEscalated = true;
        segmentRisk = escalate(segmentRisk, "approval");
        matched.push("install_from_url");
        reasons.push(`installing from ${urlArgument.startsWith("http") ? "a URL" : "a non-registry source"} requires approval`);
      }
      if (RECONFIGURE_ARGS.test(argsText) || args.some((value) => value.startsWith("--registry="))) {
        installEscalated = true;
        segmentRisk = escalate(segmentRisk, "approval");
        matched.push("registry_reconfigure");
        reasons.push("changing the package registry requires approval");
      }
      if (LIFECYCLE_SCRIPT_ARGS.test(argsText)) {
        installEscalated = true;
        segmentRisk = escalate(segmentRisk, "approval");
        matched.push("lifecycle_scripts");
        reasons.push("running lifecycle scripts requires approval and an explicit allowlist");
      }
      // A reproducible install (hardened flags only, no URL, no script execution) is controlled work:
      // C4a must run it without an approval, while anything else keeps the base policy's level.
      const reproducible = reproducibleInstallCommand(executable, args);
      if (reproducible.controlled && !installEscalated) {
        segmentRisk = "controlled";
        timeoutClass = "install";
        matched.push("reproducible_install");
        reasons.push(reproducible.reason);
      }
    }
    if (REGISTRY_CONFIG_FILES.test(command) && REGISTRY_CONFIG_WRITE.test(command)) {
      segmentRisk = escalate(segmentRisk, "approval");
      matched.push("registry_config_write");
      reasons.push("rewriting a registry configuration file requires approval");
    }
    if (executable === "husky" && args[0] === "install") {
      segmentRisk = escalate(segmentRisk, "approval");
      matched.push("git_hooks_install");
      reasons.push("installing git hooks requires approval");
    }
    // The segment's contribution is applied last, so a whitelisted downgrade cannot mask risk that was
    // detected elsewhere in the same segment or by the global parse checks above.
    risk = escalate(risk, segmentRisk);
  }

  if (!reasons.length) reasons.push("read-only command");
  return { risk, reasons, matched, segments: parsed.segments, parsed, timeoutClass, deps, migration };
}

/** Convenience for callers that only need the level (kept separate from the richer classification). */
export function classifyShellRisk(command: string, options: ShellClassifierOptions = {}): CodeShellRisk {
  return classifyShellCommand(command, options).risk;
}

export { stripQuotes };
