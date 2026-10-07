/**
 * C13 (owner decision 5): the identity vocabulary of a **runtime** MCP capability.
 *
 * A discovered MCP tool never becomes a static catalog entry, so it needs an id space that cannot be
 * confused with one. This module is a pure leaf (no imports at all) on purpose: both the policy engine and
 * the runtime overlay have to agree on that id space, and a shared import between them would be a cycle.
 *
 *   `mcp:<connectionId>/<toolName>`      the runtime tool id the policy lookup and the approval hash use
 *   `mcp:code.mcp`                        its sub-flag: command execution, file writes and third-party
 *                                         server calls are three separate blast radii, so they get three flags
 */

/** Prefix of every runtime MCP capability id. No static capability id contains a `:`, so the spaces are disjoint. */
export const MCP_RUNTIME_TOOL_ID_PREFIX = "mcp:";

/** The provider id the runtime MCP overlay reports (owner decision 5: `RuntimeProviderCapabilityOverlay.providerId`). */
export const MCP_RUNTIME_PROVIDER_ID = "mcp-runtime";

/**
 * The sub-flag that gates runtime MCP tools (`feature-flags.ts` already declares it; this is the reader).
 * `code.mcp` existed in `CODE_AGENT_SUB_FLAGS` and in `CODE_FLAG_KEY_PATTERN` since C13's flag list was
 * written, but nothing consumed it — which made it settable and inert at the same time.
 */
export const MCP_FLAG = "code.mcp";

/** The shape of a runtime MCP tool id: `mcp:<connectionId>/<toolName>`. */
const MCP_RUNTIME_TOOL_ID = /^mcp:([A-Za-z0-9._:-]{1,128})\/([A-Za-z0-9._-]{1,64})$/;

/** True when `tool` names a runtime MCP capability rather than a static catalog one. */
export function isRuntimeMcpTool(tool: string): boolean {
  return MCP_RUNTIME_TOOL_ID.test(tool);
}

/** Builds the runtime id of one tool of one configured connection. */
export function mcpRuntimeToolId(connectionId: string, toolName: string): string {
  return `${MCP_RUNTIME_TOOL_ID_PREFIX}${connectionId}/${toolName}`;
}

/** Splits a runtime MCP tool id back into its connection and tool name; `null` when it is not one. */
export function parseMcpRuntimeToolId(tool: string): { connectionId: string; toolName: string } | null {
  const match = MCP_RUNTIME_TOOL_ID.exec(tool);
  if (!match) return null;
  return { connectionId: match[1]!, toolName: match[2]! };
}

/**
 * The provider id reported for one configured connection, so the combined Inspector view can show which
 * MCP server a runtime tool came from without inventing a second identity for it.
 */
export function mcpConnectionProviderId(connectionId: string): string {
  return `${MCP_RUNTIME_PROVIDER_ID}:${connectionId}`;
}
