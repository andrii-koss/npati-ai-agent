import { redactTerminalText } from "./terminal-command-policy";

export interface TerminalPolicyLogEvent {
  rawCommand: string; normalizedCommand: string; sandboxId?: string; projectId?: string;
  decision: "allow" | "approval" | "deny"; reason: string; policyRule: string;
  toolName: string; executionContext: string; runId: string; agentId: string; runType: string;
}
function safeCommand(value: string): string {
  const limited = value.slice(0, 512);
  if (/(?:token|secret|password|credential|api[_-]?key|authorization|\.env|\.npmrc)/i.test(limited)) return "[REDACTED]";
  return redactTerminalText(limited).replace(/(https?:\/\/)[^\s/]+/g, "$1[REDACTED]");
}
export function logTerminalPolicy(event: TerminalPolicyLogEvent): void {
  console.info("[terminal-policy] " + JSON.stringify({
    ...event, rawCommand: safeCommand(event.rawCommand), normalizedCommand: safeCommand(event.normalizedCommand),
    sandboxId: event.sandboxId ?? null, projectId: event.projectId ?? null,
    buildCommit: process.env.NPATI_BUILD_COMMIT ?? "unknown",
  }));
}
