/** Frozen published v1 contract, retained for immutable manifest parity. */
export const CODE_PREVIEW_SCREENSHOT_V1 = {
  "id": "code.preview.screenshot",
  "version": 1,
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "path": {
        "type": "string",
        "pattern": "^/(?!/)[A-Za-z0-9/_~.%-]{0,511}$",
        "default": "/",
        "description": "Local preview path, for example /about."
      },
      "viewport": {
        "type": "string",
        "enum": [
          "desktop",
          "tablet",
          "mobile"
        ],
        "default": "desktop"
      },
      "question": {
        "type": "string",
        "maxLength": 500,
        "description": "What to check; used for the text description when the model has no vision."
      }
    }
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
        "const": "code.preview.screenshot"
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
  }
};
