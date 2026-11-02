export type TerminalRiskLevel = "safe" | "controlled" | "approval";
export interface TerminalCommandDecision {
  level: TerminalRiskLevel;
  requiresApproval: boolean;
  timeoutClass: "default" | "install_build";
  reason: string;
  policyRule: string;
}
export interface TerminalCommandSpec { command?: string; executable?: string; args?: string[]; cwd?: string; }
export interface NormalizedTerminalCommand { rawCommand: string; command: string; executable: string; args: string[]; cwd: string; }
const result = (level: TerminalRiskLevel, reason: string, timeoutClass: TerminalCommandDecision["timeoutClass"] = "default"): TerminalCommandDecision => ({
  level, requiresApproval: level === "approval", timeoutClass, reason, policyRule: reason.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
});
const relative = (value: string) => /^[A-Za-z0-9._/@+-]+$/.test(value) && !value.startsWith("/") && !value.split("/").includes("..") && !/(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.git)(?:\/|$)/i.test(value);
const packageName = (value: string) => /^[A-Za-z0-9@._/+~-]+$/.test(value) && !value.includes("..") && !value.startsWith("/") && !/^(?:https?:|git\+|file:)/i.test(value);
const packageManager = (value: string) => ["npm", "pnpm", "yarn"].includes(value);
const installFlag = (value: string) => ["--no-audit", "--frozen-lockfile", "--offline", "--prefer-offline", "--ignore-scripts", "--no-fund", "--legacy-peer-deps"].includes(value);
const installArgs = (values: string[]) => values.every((value) => installFlag(value) || (!value.startsWith("-") && packageName(value)));
const serverArgs = (values: string[]) => {
  const args = values[0] === "--" ? values.slice(1) : values;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (["--turbo", "--turbopack", "--strictPort"].includes(value)) continue;
    const [flag, inline] = value.split("=", 2);
    if (!["--host", "--hostname", "--port", "-p", "-H"].includes(flag!)) return false;
    const argument = inline ?? args[++index];
    if (!argument || (["--port", "-p"].includes(flag!) ? !/^[1-9][0-9]{0,4}$/.test(argument) || Number(argument) > 65535 : !["0.0.0.0", "127.0.0.1", "localhost"].includes(argument))) return false;
  }
  return true;
};
const frameworkCli = (value: string) => ["next", "vite", "astro", "nuxt", "remix", "react-scripts", "svelte-kit", "expo"].includes(value);
export function normalizeTerminalCommand(input: string | TerminalCommandSpec): NormalizedTerminalCommand {
  const spec = typeof input === "string" ? { command: input } : input;
  if (!spec || typeof spec !== "object") throw new Error("Invalid terminal command");
  const rawCommand = spec.command ?? spec.executable ?? "";
  if (typeof rawCommand !== "string" || !rawCommand.trim() || rawCommand.length > 4096 || rawCommand.includes("\0")) throw new Error("Invalid terminal command");
  if (spec.executable !== undefined && (typeof spec.executable !== "string" || spec.executable !== rawCommand.trim().split(/\s+/)[0])) throw new Error("Conflicting terminal executable");
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.length > 64 || !spec.args.every((arg) => typeof arg === "string" && /^[A-Za-z0-9._/@+=:-]+$/.test(arg)))) throw new Error("Invalid terminal arguments");
  const rawWords = rawCommand.trim().split(/\s+/);
  const words = spec.command && rawWords.length > 1 ? rawWords : [...rawWords, ...(spec.args ?? [])];
  const command = /[\r\n]/.test(rawCommand) ? rawCommand.trim() + (spec.args?.length && rawWords.length <= 1 ? " " + spec.args.join(" ") : "") : words.join(" ");
  if (command.length > 4096) throw new Error("Invalid terminal command");
  const cwdInput = spec.cwd ?? ".";
  if (typeof cwdInput !== "string") throw new Error("Invalid terminal cwd");
  const cwd = cwdInput === "/workspace" || cwdInput === "." || cwdInput === "" ? "." : cwdInput.startsWith("/workspace/") ? cwdInput.slice(11) : cwdInput;
  if (cwd !== "." && (!/^[A-Za-z0-9._/-]+$/.test(cwd) || cwd.startsWith("/") || cwd.split("/").some((part) => !part || part === "." || part === ".." || /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npati-.*|\.worktrees)$/i.test(part)))) throw new Error("Invalid terminal cwd");
  return { rawCommand, command, executable: words[0]!, args: words.slice(1), cwd };
}
export function classifyTerminalCommand(input: string | TerminalCommandSpec): TerminalCommandDecision {
  const normalized = normalizeTerminalCommand(input);
  const clean = normalized.command;
  if (/^(?:python|python3) (?:--version|-V)$/.test(clean)) return result("safe", "Read Python version");
  if (/^java (?:--version|-version)$/.test(clean)) return result("safe", "Read Java version");
  if (/[;&|`$<>\r\n\\(){}\[\]*?!#'"~]/.test(clean)) return result("approval", "Shell syntax or expansion requires approval");
  const words = [normalized.executable, ...normalized.args];
  const [program, action, ...args] = words;
  if (["node", "npm"].includes(program!) && words.length === 2 && ["-v", "--version"].includes(action ?? "")) return result("safe", "Read Node/npm version");
  if (program === "pwd" && words.length === 1) return result("safe", "Read current directory");
  if (program === "ls" && words.slice(1).every((word) => ["-l", "-a", "-la", "-al"].includes(word) || relative(word))) return result("safe", "List sandbox files");
  if (program === "cat" && words.length === 2 && relative(action!)) return result("safe", "Read sandbox file");
  if (program === "git" && action === "status" && args.every((word) => ["--short", "--porcelain", "-sb"].includes(word))) return result("safe", "Read Git status");
  if (program === "git" && action === "diff" && args.every((word) => ["--stat", "--name-only", "--cached"].includes(word))) return result("safe", "Read Git diff");
  if (program === "corepack" && ["pnpm", "yarn"].includes(action ?? "")) {
    const nested = classifyTerminalCommand([action, ...args].join(" "));
    return nested.requiresApproval ? result("approval", "Corepack command requires approval") : { ...nested, policyRule: "corepack_" + nested.policyRule };
  }
  if (packageManager(program!)) {
    // npm already saves named installs by default; explicit --save has the same scope.
    const installArguments = program === "npm" && action === "install" ? args.filter(arg => arg !== "--save") : args;
    if (["install", "ci"].includes(action!) && installArgs(installArguments) && (action !== "ci" || args.every(installFlag))) return result("controlled", "Install dependencies inside sandbox", "install_build");
    if (action === "test" && args.length === 0) return result("safe", "Run sandbox tests", "install_build");
    if (action === "run" && ["build", "test"].includes(args[0] ?? "") && args.length === 1) return result("safe", "Run sandbox build or tests", "install_build");
    if ((action === "run" && ["dev", "start", "preview"].includes(args[0] ?? "") && serverArgs(args.slice(1))) || (["dev", "start", "preview"].includes(action!) && serverArgs(args))) return result("controlled", "Start sandbox development server");
  }
  const cli = program === "npx" && action === "--yes" ? args[0] : program === "npx" ? action : program === "npm" && action === "exec" && args[0] === "--" ? args[1] : ["pnpm", "yarn"].includes(program!) && action === "exec" ? args[0] : undefined;
  const cliArgs = program === "npx" && action === "--yes" ? args.slice(1) : program === "npx" ? args : program === "npm" && action === "exec" && args[0] === "--" ? args.slice(2) : ["pnpm", "yarn"].includes(program!) && action === "exec" ? args.slice(1) : [];
  const scaffold = cli?.replace(/@latest$/, "");
  if (scaffold && ["create-next-app", "create-vite", "create-astro", "create-remix", "create-react-app"].includes(scaffold) && relative(cliArgs[0] ?? "") && cliArgs.slice(1).every((arg, index, rest) => ["--typescript", "--javascript", "--eslint", "--app", "--src-dir", "--no-src-dir", "--tailwind", "--no-tailwind", "--use-npm", "--use-pnpm", "--use-yarn", "--yes", "-y"].includes(arg) || arg === "--template" && ["react", "react-ts", "vanilla", "vanilla-ts", "vue", "vue-ts", "svelte", "svelte-ts"].includes(rest[index + 1] ?? "") || index > 0 && rest[index - 1] === "--template")) return result("controlled", "Scaffold web project inside sandbox", "install_build");
  if (cli && frameworkCli(cli) && ["build", "dev", "start", "preview", "sync", "export"].includes(cliArgs[0] ?? "") && (cliArgs[0] !== "sync" || cli === "svelte-kit") && serverArgs(cliArgs.slice(1))) return result("controlled", "Run framework CLI inside sandbox", ["build", "export"].includes(cliArgs[0] ?? "") ? "install_build" : "default");
  if (program === "node" && action && relative(action) && /\.(?:js|mjs|cjs)$/.test(action) && serverArgs(args)) return result("controlled", "Run Node project server inside sandbox");
  if (["pip", "pip3"].includes(program!) && action === "install" && (args.every(packageName) || (args.length === 2 && args[0] === "-r" && relative(args[1]!)))) return result("controlled", "Install Python dependencies inside sandbox", "install_build");
  if (program === "composer" && action === "install" && args.every((word) => ["--no-interaction", "--prefer-dist", "--no-progress"].includes(word))) return result("controlled", "Install Composer dependencies inside sandbox", "install_build");
  return result("approval", "Unknown or destructive command requires approval");
}
export function redactTerminalText(value: string, knownSecrets: string[] = []): string {
  let clean = String(value ?? "").slice(0, 128_000);
  for (const secret of knownSecrets.filter((item) => item.length > 0)) clean = clean.split(secret).join("[REDACTED]");
  return clean
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,})\b/g, "[REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s'";]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
