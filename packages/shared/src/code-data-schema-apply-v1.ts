import type { CapabilityDefinition } from "./capabilities";

/** Frozen published v1 contract, retained only for immutable manifest parity. */
export const CODE_DATA_SCHEMA_APPLY_V1: CapabilityDefinition = {
  "id": "code.data.schema.apply",
  "inventoryIds": [
    393
  ],
  "type": "tool",
  "domain": "code",
  "name": "code.data.schema.apply",
  "description": "Create a table (create_collection), add a field (add_field), or create an index (create_index) in this project attached dev database. Inspect first and pass expectedFingerprint. Use dryRun to preview. Cannot execute raw SQL, delete tables/fields, or modify production. If no backend is attached, configure it in Data Studio first.",
  "useWhen": [
    "Create a table (create_collection), add a field (add_field), or create an index (create_index) in this project attached dev database. Inspect first and pass expectedFingerprint. Use dryRun to preview. Cannot execute raw SQL, delete tables/fields, or modify production. If no backend is attached, configure it in Data Studio first."
  ],
  "doNotUseWhen": [
    "The target is outside this owner/company, or direct production access is required."
  ],
  "agentCallable": true,
  "userVisible": true,
  "risk": "medium",
  "requiresConfirmation": false,
  "requiredConnections": [],
  "requiredPermissions": [
    "workspace:write"
  ],
  "version": 1,
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operation",
      "expectedFingerprint"
    ],
    "properties": {
      "expectedFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "dryRun": {
        "type": "boolean"
      },
      "operation": {
        "type": "object",
        "required": [
          "kind",
          "collection"
        ],
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "create_collection",
              "add_field",
              "create_index"
            ]
          },
          "collection": {
            "type": "string",
            "minLength": 1,
            "maxLength": 63
          },
          "fields": {
            "type": "array",
            "items": {}
          },
          "field": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "name",
              "type"
            ],
            "properties": {
              "name": {
                "type": "string"
              },
              "type": {
                "type": "string",
                "enum": [
                  "string",
                  "text",
                  "integer",
                  "decimal",
                  "boolean",
                  "date",
                  "datetime",
                  "json",
                  "uuid",
                  "enum",
                  "file_reference"
                ]
              },
              "required": {
                "type": "boolean"
              },
              "default": {
                "type": [
                  "string",
                  "number",
                  "boolean",
                  "null"
                ]
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          "unique": {
            "type": "boolean"
          }
        }
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
        "const": "code.data.schema.apply"
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
