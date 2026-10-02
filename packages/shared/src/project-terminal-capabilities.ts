import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

export const PROJECT_TERMINAL_CAPABILITIES: CapabilityDefinition[] = (["exec", "process"] as const).map((action, index) => ({
  id: `project.terminal.${action}`,
  inventoryIds: [315 + index],
  type: "tool",
  domain: "files",
  name: `Project Terminal ${action === "exec" ? "Execute" : "Process"}`,
  description: "Run a classified command in a project sandbox through the isolated runner.",
  useWhen: ["An authorized Company agent needs to build, test, or install dependencies for a project."],
  doNotUseWhen: ["The project is archived, the agent lacks Terminal permission, or the sandbox runner is unavailable."],
  agentCallable: true,
  userVisible: true,
  risk: "high",
  requiresConfirmation: true,
  requiredConnections: [],
  requiredPermissions: ["tools:execute"],
  inputSchema: { type: "object", required: ["projectId"], properties: {
    projectId: { type: "string" }, command: { type: "string" }, action: { type: "string" }, processId: { type: "string" },
    sandboxId: { type: "string" }, environmentReferences: { type: "object" },
  } },
  version: 1,
}));
export const PROJECT_TERMINAL_MATRIX: CapabilityMatrixEntry[] = PROJECT_TERMINAL_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!, capabilityId: capability.id, name: capability.name,
  type: "tool", domain: "files", agentCallable: true, risk: capability.risk,
  testType: "integration", testFiles: ["tests/project-terminal-policy.test.ts", "tests/project-terminal-integration.test.ts", "tests/project-sandbox-provider.test.ts", "tests/project-sandbox-egress.test.ts"], status: "VERIFIED_EXISTING",
}));