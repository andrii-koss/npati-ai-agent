/* The dependency code capabilities, split out of code-capabilities.ts in step 3d of
 * docs/refactoring/PLAN.md. Declarations are moved verbatim; code-capabilities.ts imports and
 * re-exports them, so every existing import path keeps working.
 */
import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION, SHELL_PERMISSION } from "./code-capabilities-shared";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";

export const CODE_DEPS_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.deps.inspect",
    inventoryIds: [368],
    type: "tool",
    domain: "code",
    name: "Inspect dependencies",
    description: "Read the project's dependency manifests and lockfiles and report the declared dependencies, the resolved lockfile and per-ecosystem metadata without installing or touching the network.",
    useWhen: [
      "Before changing dependencies, to see what the project already declares and which lockfile governs it.",
      "To decide whether a lockfile is present and reproducible before an install is attempted.",
    ],
    doNotUseWhen: [
      "An installation or an upgrade is needed: use code.deps.add or a controlled install command.",
      "The manifest lives outside the project workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.inspect"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.inspect"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.deps.audit",
    inventoryIds: [369],
    type: "tool",
    domain: "code",
    name: "Audit dependencies",
    description: "Run a lockfile-based vulnerability audit in the sandbox against allowlisted registries and return a structured advisory report with the configured block-on severities applied.",
    useWhen: [
      "After adding or updating dependencies, to prove no known critical or high advisory was pulled in.",
      "Before proposing a dependency change as finished.",
    ],
    doNotUseWhen: [
      "The project has no lockfile: the result reports lockfile_required instead of auditing a moving target.",
      "The registry is not on the egress allowlist: the audit reports the network isolation state rather than bypassing it.",
      "A fix is expected: this tool only reports.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.audit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.audit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.deps.add",
    inventoryIds: [370],
    type: "tool",
    domain: "code",
    name: "Add a dependency",
    description: "Add one dependency to the project with lifecycle scripts disabled by default and only against allowlisted registries; any non-registry source requires an approval from the existing approval system.",
    useWhen: [
      "The task genuinely needs a new library and the dependency policy allows it.",
      "A specific version must be pinned and recorded in the lockfile.",
    ],
    doNotUseWhen: [
      "The source is a git URL, tarball, plain HTTP URL or a local path: those require an approval and are refused otherwise.",
      "The registry would have to be changed: that needs an approval and is never done implicitly.",
      "Lifecycle scripts would have to run: installs run with scripts disabled.",
      "Production credentials would be involved: they are never issued to the agent.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.add"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.add"]!.outputSchema,
    version: 1,
  },
];

/**
 * C9: planning tools (inventory ids 371-372), appended after the dependency group so the earlier groups keep
 * their exact ids and membership. They are `low` risk and require `workspace:read`: they change session
 * metadata (a plan draft, the todo list), never a workspace file. Marking them read-only is deliberate — it is
 * what lets them run in `plan` mode, the one mode whose purpose is to produce a plan — and it is exactly why
 * both tools are idempotent: C6a recovery repeats read-only tool calls.
 */
export const CODE_DEPS_MATRIX: CapabilityMatrixEntry[] = CODE_DEPS_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c4a-capabilities.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/** C9: the planning tools' audit-matrix entries (inventory ids 371-372). */
