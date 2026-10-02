import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

export const PROJECT_DEPLOY_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "project.deploy.publish",
    inventoryIds: [331],
    type: "tool",
    domain: "orchestration",
    name: "Project Deploy",
    description: "Deploy the project to a hosting provider (Dokploy) with environment, branch, and target configuration. High-risk operation requiring explicit human approval.",
    useWhen: ["An authorized Company agent needs to deploy the website to production, staging, or preview hosting."],
    doNotUseWhen: ["The project is archived, the agent lacks Deploy permission, or explicit human approval has not been granted."],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: ["workspace:write"],
    inputSchema: {
      type: "object",
      required: ["projectId", "credentialId"],
      properties: {
        projectId: { type: "string" },
        credentialId: { type: "string" },
        environment: { type: "string", enum: ["production", "staging", "preview"] },
        provider: { type: "string", enum: ["dokploy"] },
        branch: { type: "string" },
        applicationId: { type: "string" },
        endpoint: { type: "string" },
        domain: { type: "string" },
      },
    },
    version: 1,
  },
  {
    id: "project.deploy.status",
    inventoryIds: [332],
    type: "tool",
    domain: "orchestration",
    name: "Project Deploy Status",
    description: "Inspect the status, target URL, and logs of a project deployment.",
    useWhen: ["An authorized Company agent needs to check whether a deployment has succeeded, failed, or is in progress."],
    doNotUseWhen: ["The project is archived or the agent lacks Deploy permission."],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: ["workspace:read"],
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string" },
        deploymentId: { type: "string" },
      },
    },
    version: 1,
  },
];

export const PROJECT_DEPLOY_MATRIX: CapabilityMatrixEntry[] = PROJECT_DEPLOY_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "orchestration",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/project-deploy.test.ts"],
  status: "VERIFIED_EXISTING",
}));
