import type { CapabilityDefinition } from "./capabilities";
/** Migration history and RLS inspection/application; the canonical Data Studio catalogue includes these in order. */
export const CODE_DATA_STUDIO_POLICY_CAPABILITIES: (CapabilityDefinition & {
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
})[] = [
    {
        "id": "code.data.migrations.list",
        "inventoryIds": [
            406
        ],
        "type": "tool",
        "domain": "code",
        "name": "code.data.migrations.list",
        "description": "List the migration history of this project's dev database (version, operation, destructive/reversible flags, status). WHEN: you plan a schema change and need to know what was applied, or a change failed. NOT WHEN: you need the current tables (use code.data.schema.inspect). To preview a planned change use code.data.schema.apply or code.data.schema.modify with dryRun. RETURNS: up to 100 migrations, newest first.",
        "useWhen": [
            "Planning a schema change or diagnosing a failed one."
        ],
        "doNotUseWhen": [
            "Only current tables are needed: use code.data.schema.inspect."
        ],
        "agentCallable": true,
        "userVisible": true,
        "risk": "low",
        "requiresConfirmation": false,
        "requiredConnections": [],
        "requiredPermissions": [
            "workspace:read"
        ],
        "version": 1,
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "expectedBackendId"
            ],
            "properties": {
                "expectedBackendId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
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
                    "const": "code.data.migrations.list"
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
    },
    {
        "id": "code.data.policies.inspect",
        "inventoryIds": [
            407
        ],
        "type": "tool",
        "domain": "code",
        "name": "code.data.policies.inspect",
        "description": "Show the row-level access policies (RLS) and auth settings of this project's dev database. WHEN: before adding or changing who may read or write a table, or when an app gets permission errors. NOT WHEN: you need columns (use code.data.schema.inspect). RETURNS: policies per table (rule, owner field, role, actions) and auth settings.",
        "useWhen": [
            "Before changing table access rules, or when the app hits permission errors."
        ],
        "doNotUseWhen": [
            "Columns are needed: use code.data.schema.inspect."
        ],
        "agentCallable": true,
        "userVisible": true,
        "risk": "low",
        "requiresConfirmation": false,
        "requiredConnections": [],
        "requiredPermissions": [
            "workspace:read"
        ],
        "version": 1,
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "expectedBackendId"
            ],
            "properties": {
                "expectedBackendId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
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
                    "const": "code.data.policies.inspect"
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
    },
    {
        "id": "code.data.policies.apply",
        "inventoryIds": [
            408
        ],
        "type": "tool",
        "domain": "code",
        "name": "code.data.policies.apply",
        "description": "Set row-level access policies for tables of this project's dev database. Policies are structured (public, authenticated, owner, role) and compiled by Data Studio into USING and WITH CHECK clauses; no SQL. WHEN: the user asks who may read or change data, or a new table needs owner-only access. NOT WHEN: you have not inspected the current policies. Call with dryRun first; applying always needs a human approval. RETURNS: the compiled policies, or the preview for a dry run.",
        "useWhen": [
            "Table access rules must be created or changed."
        ],
        "doNotUseWhen": [
            "The current policies were not inspected first."
        ],
        "agentCallable": true,
        "userVisible": true,
        "risk": "high",
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
                "expectedBackendId",
                "policies"
            ],
            "properties": {
                "expectedBackendId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                },
                "policies": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 50,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "collection",
                            "rule",
                            "actions"
                        ],
                        "properties": {
                            "collection": {
                                "type": "string",
                                "pattern": "^[a-z][a-z0-9_]{0,62}$"
                            },
                            "rule": {
                                "type": "string",
                                "enum": [
                                    "public",
                                    "authenticated",
                                    "owner",
                                    "role"
                                ]
                            },
                            "ownerField": {
                                "type": "string",
                                "pattern": "^[a-z][a-z0-9_]{0,62}$"
                            },
                            "role": {
                                "type": "string",
                                "enum": [
                                    "admin",
                                    "member",
                                    "user"
                                ]
                            },
                            "actions": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 5,
                                "items": {
                                    "type": "string",
                                    "enum": [
                                        "select",
                                        "insert",
                                        "update",
                                        "delete",
                                        "all"
                                    ]
                                }
                            }
                        }
                    }
                },
                "dryRun": {
                    "type": "boolean",
                    "default": true
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
                    "const": "code.data.policies.apply"
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
    }
];
