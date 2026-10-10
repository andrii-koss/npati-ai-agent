/* The mutating code capabilities, split out of code-capabilities.ts in step 3d of
 * docs/refactoring/PLAN.md. Declarations are moved verbatim; code-capabilities.ts imports and
 * re-exports them, so every existing import path keeps working.
 */
import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION, WRITE_PERMISSION } from "./code-capabilities-shared";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";


export const CODE_WRITE_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.fs.edit",
    inventoryIds: [355],
    type: "tool",
    domain: "code",
    name: "Edit code file (exact replace)",
    description: "Replace an exact string in one workspace file after the file was read in this session, returning the diff, the new sha256 and the line counts. Every edit is checkpointed.",
    useWhen: [
      "The agent knows the exact current text (from code.fs.read) and wants a minimal, reviewable change.",
      "A small, surgical replacement is safer than rewriting the whole file.",
    ],
    doNotUseWhen: [
      "The file was not read in this session: read-before-write is enforced and the edit will be refused.",
      "The change spans several files or needs structural rewriting: use code.fs.apply_patch.",
      "The file is a secret/credential file or a path outside the workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.edit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.edit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.apply_patch",
    inventoryIds: [356],
    type: "tool",
    domain: "code",
    name: "Apply patch to workspace",
    description: "Apply a unified diff patch to the workspace, optionally as a dry run that reports the changes without writing anything. Conflicts are returned as structured data.",
    useWhen: [
      "The agent must change several hunks or files in one reviewable operation.",
      "The agent wants to preview a change set before writing it (dryRun).",
    ],
    doNotUseWhen: [
      "A single exact replacement is enough: use code.fs.edit.",
      "The patch paths leave the workspace or touch secret files: both are refused.",
      "The change is a whole new file: use code.fs.write.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.apply_patch"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.apply_patch"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.write",
    inventoryIds: [357],
    type: "tool",
    domain: "code",
    name: "Write code file",
    description: "Create or overwrite one workspace file with the given content, returning whether it was created, the byte count, the new sha256 and the diff. Every write is checkpointed.",
    useWhen: [
      "The agent creates a new file (a test, a module, a config) from scratch.",
      "The agent rewrites a small file where a patch would be more fragile than the full text.",
    ],
    doNotUseWhen: [
      "The change is a few lines inside a large file: prefer code.fs.edit so the diff stays reviewable.",
      "The destination is a secret/credential file or outside the workspace.",
      "The file exists and must not be replaced: pass overwrite=false or use code.fs.edit.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.write"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.write"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.move",
    inventoryIds: [358],
    type: "tool",
    domain: "code",
    name: "Move or rename path",
    description: "Move or rename a file or directory inside the workspace, refusing to overwrite an existing destination unless explicitly allowed and refusing to leave the workspace.",
    useWhen: [
      "The agent reorganises files (rename a module, move a test next to its subject).",
      "A path must change without changing its content.",
    ],
    doNotUseWhen: [
      "The content also changes: move first, then edit, so both changes are separate checkpoints.",
      "The destination already exists and must be kept: the move would be refused.",
      "Either path leaves the workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.move"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.move"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.delete",
    inventoryIds: [359],
    type: "tool",
    domain: "code",
    name: "Delete workspace path",
    description: "Delete one file or directory inside the workspace. High risk: it always requires an explicit approval, refuses recursive deletion without the recursive flag and can be pinned to an expected sha256 revision.",
    useWhen: [
      "A file is genuinely obsolete and the owner approved the deletion.",
      "A generated artefact must be removed before a clean rebuild.",
    ],
    doNotUseWhen: [
      "The intent is to replace content: use code.fs.write or code.fs.edit instead of deleting.",
      "The target is a directory with contents and recursive was not set.",
      "The target is a secret file, a path outside the workspace, or anything under version control that should be restored instead.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.delete"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.delete"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.diff",
    inventoryIds: [360],
    type: "tool",
    domain: "code",
    name: "Workspace diff",
    description: "Read-only diff of the current turn (or of one path) with per-file status and line statistics, so the agent and the user can review what changed before anything else happens.",
    useWhen: [
      "The agent wants to verify what its own edits changed before reporting success.",
      "The user needs a summary of the turn (which files, how many lines).",
    ],
    doNotUseWhen: [
      "The agent needs file contents rather than a diff: use code.fs.read.",
      "The agent wants git history: this tool never touches git (that is C4 territory).",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.diff"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.diff"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.undo_last_turn",
    inventoryIds: [361],
    type: "tool",
    domain: "code",
    name: "Undo last turn",
    description: "Restore the workspace to the checkpoint taken at the start of the current turn, returning the restored paths and the checkpoint id used.",
    useWhen: [
      "The agent's edits made things worse and the whole turn should be rolled back.",
      "The user asks to undo the last change set as a unit.",
    ],
    doNotUseWhen: [
      "Only one file should be reverted: edit that file back instead of dropping the whole turn.",
      "The caller cannot pass confirm=true: the tool refuses without an explicit confirmation.",
      "The turn is still running (checkpoints are closed when the turn ends).",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.undo_last_turn"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.undo_last_turn"]!.outputSchema,
    version: 1,
  },
];

/**
 * C4: sandbox execution tools.
 *
 * These are the first tools that run commands rather than touch files, so they are gated by the
 * `code.shell` sub-flag (on top of the master flag) and the two command-launching tools are `high` risk
 * with `requiresConfirmation: true`: a dangerous command must go through the existing approval system
 * before the sandbox runs it. `code.verify.run` only replays the project's configured verification
 * commands, so it stays `medium` and is gated by `code.write`.
 *
 * Secret handling is per call (`secretRefs`): the lease is scoped to one tool call, has a TTL, is
 * revoked when the call ends, and is never inherited by later calls or written into a shell profile.
 *
 * Inventory ids 362-367 continue the catalog (C3 ended at 361).
 */
export const CODE_WRITE_MATRIX: CapabilityMatrixEntry[] = CODE_WRITE_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c3-capabilities.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"],
  status: "VERIFIED_EXISTING",
}));

