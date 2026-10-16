import { createHash } from "node:crypto";
import { normalizeWorkspacePath } from "./code-tools-path";
import { isSensitivePath } from "./code-tools-sensitive";
import { wrapToolResult } from "./code-tools-fs";
import { isCodeGitTool } from "./code-git-workflow";
import { CODE_AGENT_SPAWN_TOOL } from "./code-subagent-limits";
import { currentToolManifest } from "./code-tool-registry";
import { CodeToolError } from "./code-tool-runtime-errors";

/** True when a path is denied by the canonical sensitive-file policy (single source of truth). */
export function isSensitiveWorkspacePath(path: string): boolean {
  return isSensitivePath(path);
}

/**
 * C11: what an approval request for an approval-gated git write asks the human about.
 */
export function describeGitApprovalAction(tool: string): string {
  switch (tool) {
    case "code.git.restore": return "discard the working-tree changes of the named paths";
    case "code.git.push": return "publish a branch to the project's GitHub repository";
    case "code.git.pr.create": return "open a GitHub pull request for a pushed branch";
    case "code.git.pr.comment": return "post a comment on a GitHub pull request";
    default: return "perform a git write";
  }
}

/** C11: the sub-flag a tool needs; git tools hang off their own `code.git` flag rather than `code.write`. */
export function codeSubFlagForTool(tool: string, write: boolean): string {
  if (isCodeGitTool(tool)) return "code.git";
  /**
   * C12: the delegation tool hangs off its own `code.subagents` flag.
   */
  if (tool === "code.agent.spawn_async") return "code.async_subagents";
  if (["code.agent.continue", "code.agent.send_message", "code.agent.interrupt"].includes(tool)) return "code.async_agent_control";
  if (tool === CODE_AGENT_SPAWN_TOOL) return "code.subagents";
  return write ? "code.write" : "code.read";
}

/**
 * Workspace-relative path validation: delegates to the canonical `normalizeWorkspacePath`.
 */
export function assertSafeWorkspacePath(rawPath: unknown): string {
  return normalizeWorkspacePath(rawPath, { tool: "code.tool", allowEmpty: false });
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Every tool payload is data, never instructions (rule: file content is DATA). */
export function wrapUntrustedResult(tool: string, payload: unknown): unknown {
  return wrapToolResult(tool, payload);
}

/** Minimal JSON Schema validation: enough for the tool contracts, no new dependencies. */
export function validateArguments(schema: Record<string, unknown>, args: unknown, toolName?: string): Record<string, unknown> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Arguments must be an object, received ${Array.isArray(args) ? "array" : typeof args}`, 400);
  }
  const rawObj = (args ?? {}) as Record<string, unknown>;
  const value = { ...rawObj }; // shallow copy: do not mutate caller's original object
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const allowedKeys = Object.keys(properties);

  // Safe normalization: if code.fs.read receives offset === 0, interpret it as start of file (offset: 1)
  const isCodeFsRead = toolName === "code.fs.read" || (!toolName && Boolean(properties.path && properties.maxLineLength && properties.offset && !properties.processId));
  if (isCodeFsRead && value.offset === 0) {
    value.offset = 1;
  }

  // Safe normalization for code.fs.grep: alias 'limit' to 'maxResults'
  const isCodeFsGrep = toolName === "code.fs.grep" || (!toolName && Boolean(properties.pattern && properties.maxResults && properties.contextLines && !properties.processId));
  if (isCodeFsGrep) {
    const hasLimit = Object.prototype.hasOwnProperty.call(value, "limit");
    const hasMaxResults = Object.prototype.hasOwnProperty.call(value, "maxResults");
    if (hasLimit && hasMaxResults) {
      throw new CodeToolError(
        "invalid_arguments",
        `Tool 'code.fs.grep': Conflicting arguments provided ('limit' and 'maxResults'). 'code.fs.grep' uses 'maxResults' (integer 1..1000). Do not provide both. Allowed parameters: [${allowedKeys.join(", ")}].`,
        400,
      );
    }
    if (hasLimit && !hasMaxResults) {
      const limitVal = value.limit;
      if (typeof limitVal !== "number" || !Number.isInteger(limitVal)) {
        throw new CodeToolError(
          "invalid_arguments",
          `Tool 'code.fs.grep': Argument 'limit' must be an integer between 1 and 1000. Got: ${JSON.stringify(limitVal)}. Allowed parameters: [${allowedKeys.join(", ")}].`,
          400,
        );
      }
      if (limitVal < 1) {
        throw new CodeToolError(
          "invalid_arguments",
          `Tool 'code.fs.grep': Argument 'limit' must be >= 1. Got: ${limitVal}. Allowed parameters: [${allowedKeys.join(", ")}].`,
          400,
        );
      }
      if (limitVal > 1000) {
        throw new CodeToolError(
          "invalid_arguments",
          `Tool 'code.fs.grep': Argument 'limit' exceeds maximum of 1000. Got: ${limitVal}. Allowed parameters: [${allowedKeys.join(", ")}].`,
          400,
        );
      }
      value.maxResults = limitVal;
      delete value.limit;
    }
  }

  const required = (schema.required ?? []) as string[];
  for (const key of required) {
    if (value[key] === undefined) {
      throw new CodeToolError(
        "invalid_arguments",
        `Tool '${toolName ?? "unknown"}': Missing required argument: ${key}. Required: [${required.join(", ")}]. Allowed parameters: [${allowedKeys.join(", ")}].`,
        400,
      );
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        throw new CodeToolError(
          "invalid_arguments",
          `Tool '${toolName ?? "unknown"}': Unknown argument: ${key}. Allowed parameters: [${allowedKeys.join(", ")}].`,
          400,
        );
      }
    }
  }
  for (const [key, raw] of Object.entries(value)) {
    const rule = properties[key];
    if (!rule) continue;
    if (raw === undefined || raw === null) {
      const nullable = raw === null && (rule.type === "null" || (Array.isArray(rule.type) && rule.type.includes("null")));
      if (required.includes(key) && !nullable) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must not be null`, 400);
      }
      continue;
    }
    const type = rule.type as string | undefined;
    if (type === "string" && typeof raw !== "string") {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be a string, got ${typeof raw}`, 400);
    }
    if (type === "number" && typeof raw !== "number") {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be a number, got ${typeof raw}`, 400);
    }
    if (type === "integer" && (!Number.isInteger(raw))) {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be an integer, got ${typeof raw === "number" ? "float" : typeof raw}`, 400);
    }
    if (type === "boolean" && typeof raw !== "boolean") {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be a boolean, got ${typeof raw}`, 400);
    }
    if (type === "array" && !Array.isArray(raw)) {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be an array, got ${typeof raw}`, 400);
    }
    if (Array.isArray(rule.enum) && !(rule.enum as unknown[]).includes(raw)) {
      throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must be one of: ${(rule.enum as unknown[]).join(", ")}. Got: ${JSON.stringify(raw)}`, 400);
    }
    if (typeof raw === "string") {
      if (typeof rule.maxLength === "number" && raw.length > rule.maxLength) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} exceeds maxLength ${rule.maxLength} (length: ${raw.length})`, 400);
      }
      if (typeof rule.minLength === "number" && raw.length < rule.minLength) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} is shorter than minLength ${rule.minLength} (length: ${raw.length})`, 400);
      }
      if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(raw)) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} does not match the expected pattern`, 400);
      }
    }
    if (typeof raw === "number") {
      if (typeof rule.maximum === "number" && raw > rule.maximum) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} exceeds the maximum ${rule.maximum}. Got: ${raw}`, 400);
      }
      if (typeof rule.minimum === "number" && raw < rule.minimum) {
        throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} is below the minimum ${rule.minimum}. Got: ${raw}`, 400);
      }
    }
    if (Array.isArray(raw) && rule.items) {
      const items = rule.items as Record<string, unknown>;
      for (const item of raw) {
        if (items.type === "string" && typeof item !== "string") {
          throw new CodeToolError("invalid_arguments", `Tool '${toolName ?? "unknown"}': Argument ${key} must contain strings only`, 400);
        }
      }
    }
  }
  return value;
}

/** Published manifest version, so a caller can pin the tools a session was created with. */
export function currentManifestVersion(): number {
  return currentToolManifest().version;
}
