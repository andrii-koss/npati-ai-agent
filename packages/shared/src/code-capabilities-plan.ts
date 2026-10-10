/* The plan and ask-user code capabilities, split out of code-capabilities.ts in step 3d of
 * docs/refactoring/PLAN.md. Declarations are moved verbatim; code-capabilities.ts imports and
 * re-exports them, so every existing import path keeps working.
 */
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

/**
 * C9: `code.ask_user` (inventory id 373), appended **after** the planning group so that the ids 349–372 keep
 * their exact meaning and membership. A published inventory id that moved would silently re-point at another
 * capability in every stored audit matrix, so a new id is only ever appended.
 *
 * It asks a person to decide and pauses the run (`waiting_for_user`) until they answer. `low` risk,
 * `workspace:read`, no confirmation: the tool cannot change a file, a sandbox or the network, and asking a
 * question must never be gated behind the very permission whose scope is in doubt — an agent that cannot ask
 * would guess instead. It is in the narrow `PLAN_SAFE_TOOLS` list rather than the read-only class for the same
 * reason the plan tools are.
 */
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

/**
 * C11 (owner decision 2): the `code.git.*` workflow capabilities (inventory ids **374–384**), appended after
 * `code.ask_user`'s 373 so every previously published id keeps its exact meaning and membership.
 *
 * They are **adapters over the existing `ProjectGitService`**: no git implementation lives behind them, so
 * there is still exactly one git path (the service that already re-checks the protected-branch policy at its
 * boundary and consumes the approval record with the payload hash of the write). Three published facts are
 * therefore visible in the Capability Inspector and are the contract the executors must honour:
 *
 *  - three tools are **read-only** (`status`, `diff`, `log`); they are also the only git tools a
 *    `REVIEW_CODE` session may call, which is what makes "a review does not write to the repository" a
 *    server-side property rather than a prompt request;
 *  - `code.git.push`, `code.git.pr.create` and `code.git.pr.comment` are `high`/`medium` and
 *    approval-gated, and each carries its **own** approval binding (a branch pair, a `(base, head)` pair, a
 *    comment hash) — so an approval for one of them is never redeemable for another;
 *  - `code.git.restore` is `high` and approval-gated, because discarding uncommitted work is not
 *    recoverable from a checkpoint.
 */
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

/** C9: `code.ask_user`'s audit-matrix entry (inventory id 373). */
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

/**
 * C11: the `code.git.*` workflow tools' audit-matrix entries (inventory ids 374–384). Every one of them
 * delegates to the existing `ProjectGitService`; the matrix names the suite that proves it, so a
 * capability cannot claim to be verified by a file that does not test it.
 */
