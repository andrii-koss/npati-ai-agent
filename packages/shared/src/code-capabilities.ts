import type { CapabilityDefinition } from "./capabilities";
import { CODE_DATA_CAPABILITIES } from "./code-capabilities-data";
import { CODE_ASSIST_CAPABILITIES } from "./code-capabilities-assist";
export { CODE_ASSIST_CAPABILITIES, CODE_ASSIST_MATRIX } from "./code-capabilities-assist";
export { CODE_DATA_CAPABILITIES, CODE_DATA_MATRIX } from "./code-capabilities-data";
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

export const CODE_CAPABILITIES: CapabilityDefinition[] = [
  ...CODE_DATA_CAPABILITIES,
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
  ...CODE_ASSIST_CAPABILITIES,
];

export const CODE_TOOL_FLAG_KEYS: Record<string, string> = Object.fromEntries(
  CODE_CAPABILITIES.map((capability) => [
    capability.id,
    (capability.requiredPermissions ?? []).includes("workspace:write") ? "code.write" : "code.read",
  ]),
);

export const CODE_TOOL_FLAG_OVERRIDES: Record<string, string> = Object.fromEntries([
  ...CODE_ASYNC_PROCESS_CAPABILITIES.map((capability) => [capability.id, "code.shell"] as const),
  ...CODE_SHELL_CAPABILITIES
    .filter((capability) => capability.id.startsWith("code.shell."))
    .map((capability) => [capability.id, "code.shell"] as const),

  ...CODE_DEPS_CAPABILITIES
    .filter((capability) => capability.id !== "code.deps.inspect")
    .map((capability) => [capability.id, "code.shell"] as const),

  ...CODE_GIT_CAPABILITIES.map((capability) => [capability.id, "code.git"] as const),

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
