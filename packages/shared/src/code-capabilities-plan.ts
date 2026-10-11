
import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION } from "./code-capabilities-shared";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";

export const CODE_PLAN_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.plan.propose",
    inventoryIds: [371],
    type: "tool",
    domain: "code",
    name: "Propose a plan revision",
    description:
      "Record a structured plan for the session (expected files, ordered steps, risks, test strategy) as a new draft revision. The plan is model-produced data: it selects no session mode, changes no workspace file, and nothing is executed until the user approves a revision.",
    useWhen: [
      "The session runs in plan mode and the agent has finished exploring the code it needs to change.",
      "The user asked for a plan before any modification.",
    ],
    doNotUseWhen: [
      "The session is not in plan mode and the change is trivial enough to just do.",
      "The agent wants to change files: the plan is metadata, and the approved revision is what starts execution.",
      "The agent wants to record progress: use code.plan.update instead.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.propose"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.propose"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.plan.update",
    inventoryIds: [372],
    type: "tool",
    domain: "code",
    name: "Update the session todo list",
    description:
      "Replace the session todo list (pending / in_progress / completed). At most one task may be in_progress; a list that breaks that rule is refused instead of normalised, and the whole list is sent every time so a replayed call cannot duplicate tasks.",
    useWhen: [
      "The agent starts, finishes or reorders a task during a run.",
      "The agent needs the user to see current progress in the workspace.",
    ],
    doNotUseWhen: [
      "The agent wants to record a plan before approval: use code.plan.propose instead.",
      "The agent wants to mark work done without verifying it: todo state is not acceptance evidence.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.update"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.update"]!.outputSchema,
    version: 1,
  },
];

export const CODE_ASK_USER_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.ask_user",
    inventoryIds: [373],
    type: "tool",
    domain: "code",
    name: "Ask the user a question",
    description:
      "Ask the user a decision question and pause the run as waiting_for_user until a human answers. The question is a stored row, so the pause survives a restart; only the user can answer it, no default or timeout ever answers for them, and an unanswered question expires with ask_user_timeout instead of being guessed.",
    useWhen: [
      "The choice belongs to the user: an ambiguous requirement, two defensible designs, or a production/dev target the agent must not pick.",
      "The agent would otherwise guess at something that changes the outcome and cannot be discovered by reading the code.",
    ],
    doNotUseWhen: [
      "The answer is in the repository, the plan or the user's earlier message: read it instead of asking again.",
      "The agent wants permission for something the policy engine already decides: that is a policy decision, not a question.",
      "The agent wants to report progress or propose a plan: use code.plan.propose or code.plan.update.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.ask_user"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.ask_user"]!.outputSchema,
    version: 1,
  },
];

export const CODE_PLAN_MATRIX: CapabilityMatrixEntry[] = CODE_PLAN_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c9-plan-tool.test.ts", "tests/coding-agent-c9-plan-mode.test.ts"],
  status: "VERIFIED_EXISTING",
}));

export const CODE_ASK_USER_MATRIX: CapabilityMatrixEntry[] = CODE_ASK_USER_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c9-ask-user.test.ts", "tests/coding-agent-c9-ask-user-runner.test.ts"],
  status: "VERIFIED_EXISTING",
}));
