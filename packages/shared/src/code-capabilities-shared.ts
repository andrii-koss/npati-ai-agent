/* The small builders shared by the code capability definitions and the code-tool schema mirror, split
 * out of code-capabilities.ts in step 3c of docs/refactoring/PLAN.md. Moved verbatim except for the
 * `export` keyword each declaration needs so both sides can import it.
 */

export const READ_PERMISSION = ["workspace:read"];
export function resultEnvelope(tool: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    required: ["kind", "tool", "toolVersion", "schemaVersion", "trust", "note", "data"],
    additionalProperties: false,
    properties: {
      kind: { const: "code_tool_result" },
      tool: { const: tool },
      toolVersion: { type: "integer" },
      schemaVersion: { type: "integer" },
      trust: { const: "untrusted_data" },
      note: { type: "string" },
      truncated: { type: "boolean" },
      truncation: { type: "object", additionalProperties: true },
      data,
    },
  };
}
export const FILE_ENTRY = {
  type: "object",
  required: ["path", "type"],
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    type: { enum: ["file", "dir", "symlink"] },
    size: { type: ["integer", "null"] },
    mtimeMs: { type: ["number", "null"] },
  },
};
