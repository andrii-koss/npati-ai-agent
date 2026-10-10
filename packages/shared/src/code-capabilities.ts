import type { CapabilityDefinition } from "./capabilities";
import { READ_PERMISSION, resultEnvelope, FILE_ENTRY } from "./code-capabilities-shared";
import { CODE_TOOL_SCHEMA_MIRROR_PART1 } from "./code-tool-schema-mirror-part1";
import { CODE_TOOL_SCHEMA_MIRROR_PART2 } from "./code-tool-schema-mirror-part2";
import { CODE_TOOL_SCHEMA_MIRROR_PART3 } from "./code-tool-schema-mirror-part3";
import { CODE_TOOL_SCHEMA_MIRROR_PART4 } from "./code-tool-schema-mirror-part4";
import type { CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";
import { CODE_READ_CAPABILITIES, CODE_READ_MATRIX } from "./code-capabilities-read";
import { CODE_WRITE_CAPABILITIES, CODE_WRITE_MATRIX } from "./code-capabilities-write";
import { CODE_SHELL_CAPABILITIES, CODE_SHELL_MATRIX } from "./code-capabilities-shell";
import { CODE_DEPS_CAPABILITIES, CODE_DEPS_MATRIX } from "./code-capabilities-deps";
import { CODE_PLAN_CAPABILITIES, CODE_ASK_USER_CAPABILITIES, CODE_PLAN_MATRIX, CODE_ASK_USER_MATRIX } from "./code-capabilities-plan";
import { CODE_GIT_CAPABILITIES, CODE_GIT_MATRIX } from "./code-capabilities-git";
import { CODE_SUBAGENT_CAPABILITIES, CODE_ASYNC_PROCESS_CAPABILITIES, CODE_SUBAGENT_MATRIX, CODE_ASYNC_PROCESS_MATRIX } from "./code-capabilities-subagent";
import { CODE_AGENT_CONTROL_CAPABILITIES, CODE_AGENT_CONTROL_MATRIX } from "./code-capabilities-agent-control";

export { CODE_TOOL_SCHEMA_MIRROR } from "./code-tool-schema-mirror";
export { CODE_READ_CAPABILITIES, CODE_READ_MATRIX } from "./code-capabilities-read";
export { CODE_WRITE_CAPABILITIES, CODE_WRITE_MATRIX } from "./code-capabilities-write";
export { CODE_SHELL_CAPABILITIES, CODE_SHELL_MATRIX } from "./code-capabilities-shell";
export { CODE_DEPS_CAPABILITIES, CODE_DEPS_MATRIX } from "./code-capabilities-deps";
export { CODE_PLAN_CAPABILITIES, CODE_ASK_USER_CAPABILITIES, CODE_PLAN_MATRIX, CODE_ASK_USER_MATRIX } from "./code-capabilities-plan";
export { CODE_GIT_CAPABILITIES, CODE_GIT_MATRIX } from "./code-capabilities-git";
export { CODE_SUBAGENT_CAPABILITIES, CODE_ASYNC_PROCESS_CAPABILITIES, CODE_SUBAGENT_MATRIX, CODE_ASYNC_PROCESS_MATRIX } from "./code-capabilities-subagent";
export { CODE_AGENT_CONTROL_CAPABILITIES, CODE_AGENT_CONTROL_MATRIX } from "./code-capabilities-agent-control";
/**
 * C2/C3: Coding Agent tools.
 *
 * C2 contributed the read-only tools (risk `low`, no approval): they are gated server-side by the
 * `code.read` feature flag plus the C1 workspace boundary. C3 adds the mutating tools (`medium`, and
 * `high` for delete), gated by `code.write` on top of the master `coding_agent.enabled` flag, always
 * checkpointed and still confined to the admitted sandbox.
 *
 * SCHEMA CONTRACT (single source of truth)
 * ----------------------------------------
 * The authoritative argument/result schemas are `apps/agent-api/src/code-tool-schemas.json`: those are
 * the schemas the runtime validates against, the ones published as an artifact, and the ones protected
 * by the CI guard (`node scripts/verify-code-tool-schemas.mjs --check`). Because `packages/shared`
 * cannot import from `apps/agent-api`, this file mirrors them and
 * `tests/coding-agent-c2-schema-parity.test.ts` fails the build if the mirror ever drifts (same
 * required fields, same property names and types, same envelope, same versions).
 *
 * `projectId` is deliberately NOT an argument: the runtime receives it in the invocation envelope
 * (`CodeToolRuntime.invoke(ctx, { companyId, projectId, tool, args, toolCallId })`) and the project is
 * authorised against the caller's tenant before any tool logic runs, so a model can never point a
 * tool at another project by passing an id.
 *
 * Inventory ids 349-354 continue the catalog (the previous group ended at 348).
 */

/** Envelope every code tool result is wrapped in, so content is always marked as untrusted data. */


/**
 * Mirror of `apps/agent-api/src/code-tool-schemas.json` (tool `name@version` -> schemas).
 * Keep in lockstep: the parity test compares this object with the registry entry by entry.
 */
export const CODE_CAPABILITIES: CapabilityDefinition[] = [
  ...CODE_AGENT_CONTROL_CAPABILITIES,
  ...CODE_ASYNC_PROCESS_CAPABILITIES,
  ...CODE_READ_CAPABILITIES,
  ...CODE_WRITE_CAPABILITIES,
  ...CODE_SHELL_CAPABILITIES,
  ...CODE_DEPS_CAPABILITIES,
  ...CODE_PLAN_CAPABILITIES,
  ...CODE_ASK_USER_CAPABILITIES,
  ...CODE_GIT_CAPABILITIES,
  ...CODE_SUBAGENT_CAPABILITIES,
];

export const CODE_TOOL_FLAG_KEYS: Record<string, string> = Object.fromEntries(
  CODE_CAPABILITIES.map((capability) => [
    capability.id,
    (capability.requiredPermissions ?? []).includes("workspace:write") ? "code.write" : "code.read",
  ]),
);

/**
 * C4: the sandbox execution tools hang off their own sub-flag (`code.shell`) instead of `code.write`,
 * so an operator can allow file edits while forbidding command execution (or the other way round).
 * `code.verify.run` deliberately stays on `code.write`: it only replays the project's configured
 * verification commands, so it belongs with the change tools it verifies.
 */
export const CODE_TOOL_FLAG_OVERRIDES: Record<string, string> = Object.fromEntries([
  ...CODE_ASYNC_PROCESS_CAPABILITIES.map((capability) => [capability.id, "code.shell"] as const),
  ...CODE_SHELL_CAPABILITIES
    .filter((capability) => capability.id.startsWith("code.shell."))
    .map((capability) => [capability.id, "code.shell"] as const),
  // C4a: the dependency audit executes commands in the sandbox (allowlisted registries only) and the
  // dependency add mutates the graph through an install, so both hang off the shell sub-flag; the
  // inspection is pure reading and keeps the default `code.read`.
  ...CODE_DEPS_CAPABILITIES
    .filter((capability) => capability.id !== "code.deps.inspect")
    .map((capability) => [capability.id, "code.shell"] as const),
  /**
   * C11: every `code.git.*` tool hangs off its own `code.git` sub-flag, including the read-only three.
   * `code.write` and `code.git` are different blast radii: enabling file edits must not enable pushing to
   * a remote, and enabling git must not be reported as "file writes are on". The read-only git tools share
   * the flag because an operator who forbids git must not be left with a working `git status` path that
   * the UI reports as write-gated.
   */
  ...CODE_GIT_CAPABILITIES.map((capability) => [capability.id, "code.git"] as const),
  /**
   * C12: the delegation tool hangs off its own `code.subagents` sub-flag, not `code.read`/`code.write`.
   * Delegation has a different blast radius again: it starts another run that consumes the shared budget and
   * may write, so enabling file edits must not enable spawning children, and enabling git must not either.
   */
  ...CODE_SUBAGENT_CAPABILITIES.map((capability) => [capability.id, "code.subagents"] as const),
]);

export const CODE_TOOL_FLAG_KEYS_RESOLVED: Record<string, string> = {
  ...CODE_TOOL_FLAG_KEYS,
  ...CODE_TOOL_FLAG_OVERRIDES,
};

export function flagKeyForCodeTool(capabilityId: string, domain?: string): string | null {
  const direct = CODE_TOOL_FLAG_KEYS_RESOLVED[capabilityId];
  if (direct) return direct;
  return domain === "code" ? "code.read" : null;
}
