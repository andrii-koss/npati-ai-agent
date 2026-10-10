/* The git code capabilities, split out of code-capabilities.ts in step 3d of
 * docs/refactoring/PLAN.md. Declarations are moved verbatim; code-capabilities.ts imports and
 * re-exports them, so every existing import path keeps working.
 */
import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION, WRITE_PERMISSION } from "./code-capabilities-shared";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";

export const CODE_GIT_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.git.status",
    inventoryIds: [374],
    type: "tool",
    domain: "code",
    name: "Git status",
    description: "Report the git state of the canonical project workspace: the checked-out branch, whether the tree is clean, and the staged, unstaged and untracked paths. Read-only; the paths are data and cannot change policy.",
    useWhen: [
      "Before staging or committing, to see exactly what would be included.",
      "After a repair, to confirm the tree holds what the agent believes it holds.",
    ],
    doNotUseWhen: [
      "A diff body is needed: use code.git.diff.",
      "The repository is not connected: the tool reports that state instead of inventing one.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.status"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.status"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.diff",
    inventoryIds: [375],
    type: "tool",
    domain: "code",
    name: "Git diff",
    description: "Return the unified diff of the canonical project workspace, optionally limited to one workspace-relative path and optionally the staged side. Bounded, explicitly truncated, and untrusted data.",
    useWhen: [
      "Before committing, to review what the commit would contain.",
      "To check one file's change without re-reading the whole file.",
    ],
    doNotUseWhen: [
      "A file's whole content is needed: use code.fs.read.",
      "A committed revision must be compared: find the commit with code.git.log first.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.diff"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.diff"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.log",
    inventoryIds: [376],
    type: "tool",
    domain: "code",
    name: "Git log",
    description: "List the most recent commits of the canonical project workspace (hash, author, date, subject). Read-only and bounded; a repository with no history answers with an empty list rather than an error.",
    useWhen: [
      "To confirm a commit the agent made is present before opening a pull request.",
      "To see what a branch already contains.",
    ],
    doNotUseWhen: [
      "The working-tree state is needed: use code.git.status.",
      "A full patch is needed: use code.git.diff.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.log"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.log"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.branch.create",
    inventoryIds: [377],
    type: "tool",
    domain: "code",
    name: "Create a git branch",
    description: "Create a branch in the canonical project workspace and check it out, so agent work never accumulates on the main branch. The name is validated before any command runs; a branch writes no remote.",
    useWhen: [
      "At the start of a coding session, to isolate work on npati/<session-short-id>.",
      "Before a change that must not touch the current branch.",
    ],
    doNotUseWhen: [
      "The branch already exists: switch to it instead.",
      "The intent is to publish: that is code.git.push and needs an approval.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.create"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.create"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.branch.switch",
    inventoryIds: [378],
    type: "tool",
    domain: "code",
    name: "Switch git branch",
    description: "Check out an existing branch of the canonical project workspace. A switch that would have to carry or discard uncommitted changes is refused, so it never silently moves somebody else's work.",
    useWhen: [
      "Returning to the session branch after inspecting another one.",
      "Moving to a branch a human asked to review.",
    ],
    doNotUseWhen: [
      "The branch does not exist: create it first.",
      "The change set is unfinished: commit it first, or the switch is refused.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.switch"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.switch"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.stage",
    inventoryIds: [379],
    type: "tool",
    domain: "code",
    name: "Stage git changes",
    description: "Stage changes in the canonical project workspace, either the named paths or everything. Every path goes through the canonical validator and the index is re-checked, so a protected or secret file cannot be staged.",
    useWhen: [
      "Preparing a commit that must contain only some changed files.",
      "After a targeted restore, to make the index match the worktree.",
    ],
    doNotUseWhen: [
      "Everything should be committed: code.git.commit stages all by itself.",
      "A path is secret or protected: that is refused, not silently filtered.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.stage"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.stage"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.commit",
    inventoryIds: [380],
    type: "tool",
    domain: "code",
    name: "Commit git changes",
    description: "Commit the staged changes (or every change) in the canonical project workspace and return the commit hash. The commit is checked against the session branch and the canonical revision the run captured, so it cannot land on the wrong branch.",
    useWhen: [
      "A verified change set is ready to become durable.",
      "Before a push, because a push publishes commits and not a working tree.",
    ],
    doNotUseWhen: [
      "Verification has not run: a commit makes an unverified change durable.",
      "The point is to publish: that is code.git.push.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.commit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.commit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.restore",
    inventoryIds: [381],
    type: "tool",
    domain: "code",
    name: "Restore paths in git",
    description: "Discard the working-tree changes of the named paths. It always needs an explicit human approval, because it destroys uncommitted work no checkpoint can bring back; the approval is bound to the exact path list.",
    useWhen: [
      "A change went wrong and the paths must return to the committed state.",
      "A file must be reset before a different approach is tried.",
    ],
    doNotUseWhen: [
      "The change should be reversible: make a checkpoint or commit first.",
      "The paths were never committed: restoring them deletes the only copy.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.restore"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.restore"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.push",
    inventoryIds: [382],
    type: "tool",
    domain: "code",
    name: "Push a branch",
    description: "Push one branch to the project's connected GitHub repository. It needs a real human approval record bound to the operation, both branches, the remote, `force` and the credential reference, and the protected-branch policy is re-evaluated at the git boundary immediately before the write. Force pushes are refused.",
    useWhen: [
      "An approved, verified change set must be published for review.",
      "A pull request is about to be opened from this branch.",
    ],
    doNotUseWhen: [
      "The target branch is protected: that is a hard deny no approval can lift.",
      "History would have to be rewritten: force pushes are refused by this API.",
      "The work is not verified yet.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.push"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.push"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.pr.create",
    inventoryIds: [383],
    type: "tool",
    domain: "code",
    name: "Open a pull request",
    description: "Open a GitHub pull request for an already-pushed branch. The approval is bound to the (base, head) pair and the credential reference, so an approval for one pull request cannot be redeemed for another. Without a body it is generated from the run's own verified summary.",
    useWhen: [
      "A pushed branch is ready for human review.",
      "The run finished and its verification result should travel with the review request.",
    ],
    doNotUseWhen: [
      "The branch is not pushed yet.",
      "The change is not verified: the generated description states that instead of hiding it.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.create"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.create"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.pr.comment",
    inventoryIds: [384],
    type: "tool",
    domain: "code",
    name: "Comment on a pull request",
    description: "Post one comment on an existing GitHub pull request. Reviewing is read-only, so commenting is a separate capability with its own approval record bound to the pull-request number and a hash of the comment text: an approval for a push or for opening a pull request can never be redeemed as a comment.",
    useWhen: [
      "A review produced a finding that belongs on the pull request for the author to read.",
      "A human asked for the review result to be posted.",
    ],
    doNotUseWhen: [
      "No pull request exists yet.",
      "The text contains a credential, a token or production data: it is published to GitHub.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.comment"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.comment"]!.outputSchema,
    version: 1,
  },
];

/**
 * C12: the delegation capability (inventory id **385**), appended after the git group so every previously
 * published id keeps its exact meaning and membership.
 *
 * One capability, because there is one act: hand a bounded task to a coding sub-agent. Its published facts are
 * the contract the server enforces:
 *
 *  - **Depth 1 is structural.** A run that has a parent is never offered this tool and the tool runtime refuses
 *    the name before the sub-flag, the arguments, the approval and the executor, so a child cannot delegate
 *    whatever the model asks for or the configuration says.
 *  - **A request is never a grant.** The child's tools are the intersection of this run's effective set, the
 *    child type's own profile and the requested list. A wildcard resolves only against the published registry;
 *    with no registry it grants nothing rather than meaning "everything".
 *  - **Metadata only in both directions.** The child receives the task text and a scope; the parent receives a
 *    bounded handoff digest (findings, paths, symbols, counts) and never the child's transcript, file bodies or
 *    tool output.
 *
 * `risk` is `medium`: it neither destroys work like `code.fs.delete` nor publishes anything like
 * `code.git.push`, but it does start another run that may write to the workspace, so it is not a read.
 * It is **not** approve-gated: approval belongs to the individual write the child attempts, which is judged by
 * the same policy engine as any other call — gating the delegation as well would ask the human twice for one
 * change and would teach the agent to avoid delegating.
 */
export const CODE_GIT_MATRIX: CapabilityMatrixEntry[] = CODE_GIT_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c11-git-workflow.test.ts", "tests/coding-agent-c11-git-workflow-security.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/**
 * C12: the delegation tool's audit-matrix entry (inventory id 385). The two suites named here are the ones
 * that prove the published behaviour: the scope suite drives the intersection and the depth limit, and the
 * workflow suite drives the executor, the handoff digest and the failure path.
 */
