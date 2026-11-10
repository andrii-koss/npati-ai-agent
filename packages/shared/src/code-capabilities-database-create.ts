import type { CapabilityDefinition } from "./capabilities";

export const CODE_DATABASE_CREATION_CAPABILITY: CapabilityDefinition & { inputSchema: Record<string,unknown>; outputSchema: Record<string,unknown> } = {
  "id": "code.data.backend.create",
  "inventoryIds": [
    398
  ],
  "type": "tool",
  "domain": "code",
  "name": "code.data.backend.create",
  "description": "Create and attach a database to the current project only when the user's request or required persistent shared data needs one. Explain the reason. Idempotent: reuse the current attachment on retry. Returns safe database identity and public SDK configuration, never credentials. Tell the user after success.",
  "useWhen": [
    "Create and attach a database to the current project only when the user's request or required persistent shared data needs one. Explain the reason. Idempotent: reuse the current attachment on retry. Returns safe database identity and public SDK configuration, never credentials. Tell the user after success."
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
      "name",
      "reason"
    ],
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      },
      "separate": {
        "type": "boolean",
        "description": "Give this project its own new database when it now shares one with another project: it is detached from the shared database, which the other project keeps unchanged."
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
        "const": "code.data.backend.create"
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
