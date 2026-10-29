import type { CapabilityDefinition } from "./capabilities";

/** Additive v17 adapter over the existing scoped Preview service; no arbitrary shell input. */
export const CODE_PREVIEW_RESTART_CAPABILITY: CapabilityDefinition & { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> } = {
  "id": "code.preview.restart",
  "inventoryIds": [
    409
  ],
  "type": "tool",
  "domain": "code",
  "name": "code.preview.restart",
  "version": 1,
  "description": "Restart this project's Live Preview through the existing scoped runtime, replacing the running process even for static or development servers. WHEN: the user asks to restart Preview. NOT WHEN: only checking a page or making an ordinary edit. No source changes, arbitrary commands, or other projects are accepted. RETURNS: actual runtime status, port and framework. Call code.preview.screenshot afterwards to verify loading; never claim restart from a screenshot alone.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "outputSchema": {
    "type": "object",
    "required": [
      "kind",
      "tool",
      "toolVersion",
      "schemaVersion",
      "trust",
      "note",
      "data"
    ],
    "additionalProperties": false,
    "properties": {
      "kind": {
        "const": "code_tool_result"
      },
      "tool": {
        "const": "code.preview.restart"
      },
      "toolVersion": {
        "type": "integer"
      },
      "schemaVersion": {
        "type": "integer"
      },
      "trust": {
        "const": "untrusted_data"
      },
      "note": {
        "type": "string"
      },
      "truncated": {
        "type": "boolean"
      },
      "truncation": {
        "type": "object",
        "additionalProperties": true
      },
      "data": {
        "type": "object"
      }
    }
  },
  "useWhen": [
    "The user asks to restart the selected project Live Preview."
  ],
  "doNotUseWhen": [
    "Only checking the existing preview or making an ordinary source edit."
  ],
  "agentCallable": true,
  "userVisible": true,
  "risk": "medium",
  "requiresConfirmation": false,
  "requiredConnections": [],
  "requiredPermissions": [
    "workspace:write"
  ]
};
