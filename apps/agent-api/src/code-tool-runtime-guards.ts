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
export function validateArguments(schema: Record<string, unknown>, args: unknown): Record<string, unknown> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new CodeToolError("invalid_arguments", "Arguments must be an object", 400);
  }
  const value = (args ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  for (const key of required) {
    if (value[key] === undefined) throw new CodeToolError("invalid_arguments", `Missing required argument: ${key}`, 400);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) throw new CodeToolError("invalid_arguments", `Unknown argument: ${key}`, 400);
    }
  }
  for (const [key, raw] of Object.entries(value)) {
    const rule = properties[key];
    if (!rule) continue;
    if (raw === undefined || raw === null) {
      const nullable = raw === null && (rule.type === "null" || (Array.isArray(rule.type) && rule.type.includes("null")));
      if (required.includes(key) && !nullable) throw new CodeToolError("invalid_arguments", `Argument ${key} must not be null`, 400);
      continue;
    }
    const type = rule.type as string | undefined;
    if (type === "string" && typeof raw !== "string") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a string`, 400);
    if (type === "number" && typeof raw !== "number") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a number`, 400);
    if (type === "integer" && (!Number.isInteger(raw))) throw new CodeToolError("invalid_arguments", `Argument ${key} must be an integer`, 400);
    if (type === "boolean" && typeof raw !== "boolean") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a boolean`, 400);
    if (type === "array" && !Array.isArray(raw)) throw new CodeToolError("invalid_arguments", `Argument ${key} must be an array`, 400);
    if (Array.isArray(rule.enum) && !(rule.enum as unknown[]).includes(raw)) {
      throw new CodeToolError("invalid_arguments", `Argument ${key} must be one of: ${(rule.enum as unknown[]).join(", ")}`, 400);
    }
    if (typeof raw === "string") {
      if (typeof rule.maxLength === "number" && raw.length > rule.maxLength) throw new CodeToolError("invalid_arguments", `Argument ${key} exceeds maxLength`, 400);
      if (typeof rule.minLength === "number" && raw.length < rule.minLength) throw new CodeToolError("invalid_arguments", `Argument ${key} is shorter than minLength`, 400);
      if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(raw)) throw new CodeToolError("invalid_arguments", `Argument ${key} does not match the expected pattern`, 400);
    }
    if (typeof raw === "number") {
      if (typeof rule.maximum === "number" && raw > rule.maximum) throw new CodeToolError("invalid_arguments", `Argument ${key} exceeds the maximum`, 400);
      if (typeof rule.minimum === "number" && raw < rule.minimum) throw new CodeToolError("invalid_arguments", `Argument ${key} is below the minimum`, 400);
    }
    if (Array.isArray(raw) && rule.items) {
      const items = rule.items as Record<string, unknown>;
      for (const item of raw) {
        if (items.type === "string" && typeof item !== "string") throw new CodeToolError("invalid_arguments", `Argument ${key} must contain strings only`, 400);
      }
    }
  }
  return value;
}

/** Published manifest version, so a caller can pin the tools a session was created with. */
export function currentManifestVersion(): number {
  return currentToolManifest().version;
}
