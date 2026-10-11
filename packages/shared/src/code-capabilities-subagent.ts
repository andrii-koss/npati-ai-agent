
import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION } from "./code-capabilities-shared";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";

export const CODE_SUBAGENT_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.agent.spawn",
    inventoryIds: [385],
    type: "tool",
    domain: "code",
    name: "Delegate to a coding sub-agent",
    description: "Delegate one bounded task to a coding sub-agent of a named type (explore for read-only repository search, plan, implement within a file scope, review, or test) and get back a metadata-only handoff digest: findings, file paths, symbols and counts. Depth is 1 by construction — a sub-agent run is never offered this tool and the runtime refuses it for a run that has a parent — and the child's tools are an intersection of this run's effective set, the type's profile and the requested list, so a request can only narrow.",
    useWhen: [
      "A repository-wide search or an architecture survey would flood this conversation with file bodies: delegate it to an explore sub-agent and keep only the digest.",
      "Several independent files or areas have to change and the work can be split without a second planner.",
      "A change needs an independent review or a test-focused pass that should not see this run's reasoning.",
    ],
    doNotUseWhen: [
      "The answer is one known file: read it directly instead of paying for a second run.",
      "The task needs this conversation's context: the child sees the task text only, never the transcript.",
      "The work needs a decision from the user: ask with code.ask_user, because a sub-agent cannot answer for them.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.agent.spawn"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.agent.spawn"]!.outputSchema,
    version: 1,
  },
];

export const CODE_ASYNC_PROCESS_CAPABILITIES: CapabilityDefinition[] = [
  {"id":"code.shell.exec_async","inventoryIds":[386],"type":"tool","domain":"code","name":"Run tracked command","description":"Execute one tracked sandbox process. Wait up to waitTimeoutMs, then return the same handle for explicit collection. Foreground secret leases cannot be promoted.","useWhen":["Continue the run while a sandbox command is still running."],"doNotUseWhen":["The backend does not support durable process identity.","The command requires foreground secret leases."],"agentCallable":true,"userVisible":true,"risk":"high","requiresConfirmation":false,"requiredConnections":[],"requiredPermissions":["workspace:write"],"version":1, inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec_async"]!.inputSchema, outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec_async"]!.outputSchema },
{"id":"code.shell.process.wait","inventoryIds":[387],"type":"tool","domain":"code","name":"Collect tracked process","description":"Collect bounded output and real terminal state of a tracked process. waitTimeoutMs=0 polls; a timeout preserves the same process handle.","useWhen":["Collect the real outcome of a previously started process."],"doNotUseWhen":["The backend does not support durable process identity.","The command requires foreground secret leases."],"agentCallable":true,"userVisible":true,"risk":"low","requiresConfirmation":false,"requiredConnections":[],"requiredPermissions":["workspace:read"],"version":1, inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.wait"]!.inputSchema, outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.wait"]!.outputSchema }
];
export const CODE_ASYNC_PROCESS_MATRIX: CapabilityMatrixEntry[] = CODE_ASYNC_PROCESS_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!, capabilityId: capability.id, name: capability.name, type: "tool", domain: "code", agentCallable: true,
  risk: capability.risk, testType: "integration", testFiles: ["tests/coding-agent-async-process.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"], status: "VERIFIED_EXISTING",
}));
export const CODE_SUBAGENT_MATRIX: CapabilityMatrixEntry[] = CODE_SUBAGENT_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c12-subagent-workflow.test.ts", "tests/coding-agent-c12-subagent-scope.test.ts"],
  status: "VERIFIED_EXISTING",
}));
