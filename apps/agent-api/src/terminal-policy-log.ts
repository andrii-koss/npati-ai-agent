import { buildInfo } from "./build-info";
import { redactTerminalText } from "./terminal-command-policy";

export interface TerminalPolicyLogEvent {
  rawCommand: string; normalizedCommand: string; sandboxId?: string; projectId?: string;
  decision: "allow" | "approval" | "deny"; reason: string; policyRule: string;
  toolName: string; executionContext: string; runId: string; agentId: string; runType: string;
  cwd?: string; rawArgs?: string[]; commandPolicyRule?: string;
}
function safeCommand(value: string): string {
  const limited = value.slice(0, 512);
  if (limited && !/^(?:npm|pnpm|yarn|npx|corepack|node)(?:\s|$)/.test(limited)) return "[REDACTED]";
  if (/(?:token|secret|password|credential|api[_-]?key|authorization|\.env|\.npmrc)/i.test(limited)) return "[REDACTED]";
  return redactTerminalText(limited)
    .replace(/https?:\/\/[^\s]+/g, "[URL_REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]");
}
function safeArg(value: string): string {
  if (!/^[A-Za-z0-9._/@+=:-]{1,128}$/.test(value) || /(?:token|secret|password|credential|api[_-]?key|authorization)/i.test(value) || /[A-Za-z0-9_-]{24,}/.test(value)) return "[REDACTED]";
  return value;
}
export function logTerminalPolicy(event: TerminalPolicyLogEvent): void {
  if (process.env.NPATI_TERMINAL_POLICY_LOG === "false" || (process.env.NODE_ENV === "test" && process.env.NPATI_TERMINAL_POLICY_LOG !== "true")) return;
  console.info("[terminal-policy] " + JSON.stringify({
    ...event, rawCommand: safeCommand(event.rawCommand), normalizedCommand: safeCommand(event.normalizedCommand),
    sandboxId: event.sandboxId ?? null, projectId: event.projectId ?? null, cwd: event.cwd ?? null,
    rawArgs: event.rawArgs?.map(safeArg) ?? [],
    buildCommit: buildInfo.commit, buildFingerprint: buildInfo.fingerprint,
  }));
}
