import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

const actions = ["list", "read", "search", "create", "write", "edit", "move", "delete"] as const;
export const PROJECT_FILE_CAPABILITIES: CapabilityDefinition[] = actions.map((action, index) => ({
  id: `project.files.${action}`,
  inventoryIds: [307 + index],
  type: "tool",
  domain: "files",
  name: `Project Files ${action[0]!.toUpperCase()}${action.slice(1)}`,
  description: `Use the ${action} operation on files in a company project workspace.`,
  useWhen: [`An authorized Company agent needs to ${action} a project file.`],
  doNotUseWhen: ["The project does not belong to the active company or the agent lacks Project access."],
  agentCallable: true,
  userVisible: true,
  risk: action === "delete" ? "high" : ["create", "write", "edit", "move"].includes(action) ? "medium" : "low",
  requiresConfirmation: action === "delete",
  requiredConnections: [],
  requiredPermissions: [["list", "read", "search"].includes(action) ? "workspace:read" : "workspace:write"],
  inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "string" } } },
  version: 1,
}));
export const PROJECT_FILE_MATRIX: CapabilityMatrixEntry[] = PROJECT_FILE_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!, capabilityId: capability.id, name: capability.name,
  type: "tool", domain: "files", agentCallable: true, risk: capability.risk,
  testType: "integration", testFiles: ["tests/project-workspace.test.ts", "tests/project-files-integration.test.ts"], status: "VERIFIED_EXISTING",
}));
