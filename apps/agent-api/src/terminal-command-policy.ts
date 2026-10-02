export type TerminalRiskLevel = "safe" | "controlled" | "approval";
export interface TerminalCommandDecision {
  level: TerminalRiskLevel;
  requiresApproval: boolean;
  timeoutClass: "default" | "install_build";
  reason: string;
}
const result = (level: TerminalRiskLevel, reason: string, timeoutClass: TerminalCommandDecision["timeoutClass"] = "default"): TerminalCommandDecision => ({
  level, requiresApproval: level === "approval", timeoutClass, reason,
});
const relative = (value: string) => /^[A-Za-z0-9._/@+-]+$/.test(value) && !value.startsWith("/") && !value.split("/").includes("..") && !/(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.git)(?:\/|$)/i.test(value);
const packageName = (value: string) => /^[A-Za-z0-9@._/+~-]+$/.test(value) && !value.includes("..") && !value.startsWith("/") && !/^(?:https?:|git\+|file:)/i.test(value);
export function classifyTerminalCommand(command: string): TerminalCommandDecision {
  if (typeof command !== "string" || !command.trim() || command.length > 4096 || command.includes("\0")) throw new Error("Invalid terminal command");
  const clean = command.trim();
  if (/[;&|`$<>\r\n\\(){}\[\]*?!#'"~]/.test(clean)) return result("approval", "Shell syntax or expansion requires approval");
  const words = clean.split(/\s+/);
  const [program, action, ...args] = words;
  if (program === "pwd" && words.length === 1) return result("safe", "Read current directory");
  if (program === "ls" && words.slice(1).every((word) => ["-l", "-a", "-la", "-al"].includes(word) || relative(word))) return result("safe", "List sandbox files");
  if (program === "cat" && words.length === 2 && relative(action!)) return result("safe", "Read sandbox file");
  if (program === "git" && action === "status" && args.every((word) => ["--short", "--porcelain", "-sb"].includes(word))) return result("safe", "Read Git status");
  if (program === "git" && action === "diff" && args.every((word) => ["--stat", "--name-only", "--cached"].includes(word))) return result("safe", "Read Git diff");
  if (["npm", "pnpm", "yarn"].includes(program!) && (action === "test" || (action === "run" && ["build", "test"].includes(args[0] ?? "") && args.length === 1)) && words.length <= 3) return result("safe", "Run sandbox build or tests", "install_build");
  if (["npm", "pnpm", "yarn"].includes(program!) && ["install", "ci"].includes(action!) && args.every((word) => ["--no-audit", "--frozen-lockfile", "--offline", "--prefer-offline"].includes(word) || packageName(word))) return result("controlled", "Install dependencies inside sandbox", "install_build");
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
