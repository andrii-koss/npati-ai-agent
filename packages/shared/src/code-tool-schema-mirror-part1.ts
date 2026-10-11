
export const CODE_TOOL_SCHEMA_MIRROR_PART1: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
"code.agent.spawn_async": {
  "inputSchema": {
    "type": "object",
    "required": [
      "agentType",
      "task"
    ],
    "additionalProperties": false,
    "properties": {
      "agentType": {
        "enum": [
          "explore",
          "plan",
          "implement",
          "review",
          "test"
        ],
        "description": "The kind of sub-agent. It decides the child's model profile, turn limit and capability profile."
      },
      "task": {
        "type": "string",
        "minLength": 1,
        "maxLength": 8000,
        "description": "A self-contained task. The child sees this text, not this run's conversation."
      },
      "paths": {
        "type": "array",
        "maxItems": 20,
        "items": {
          "type": "string",
          "maxLength": 1024
        },
        "description": "Workspace-relative file or directory scope for the child. Each path passes the canonical path guard, so absolute, traversing and secret paths are refused."
      },
      "tools": {
        "type": "array",
        "maxItems": 64,
        "items": {
          "type": "string",
          "maxLength": 128
        },
        "description": "Tools requested for the child. A request is never a grant: the effective set is the intersection of this run's effective tools, the child type's profile and this list, resolved against the published registry. A wildcard resolves only against that registry."
      },
      "model": {
        "type": "string",
        "maxLength": 200,
        "description": "Optional model override. The child type's model profile still applies, so an override cannot remove its constraints."
      },
      "turnLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 40,
        "description": "Requested cap on the child's model turns. Clamped down to the child type's limit, which is itself clamped to the canonical ceiling: configuration may lower it, never raise it."
      },
      "summaryOnly": {
        "type": "boolean",
        "default": true,
        "description": "Return the metadata-only handoff digest. It is the only result this tool produces, so `false` is refused with `subagent_summary_required` instead of being silently ignored."
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
        "const": "code.agent.spawn_async"
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
        "type": "object",
        "required": [
          "agentType",
          "status",
          "runId",
          "capabilityProfile",
          "limits",
          "tools",
          "handoff",
          "truncated"
        ],
        "additionalProperties": false,
        "properties": {
          "agentType": {
            "enum": [
              "explore",
              "plan",
              "implement",
              "review",
              "test"
            ]
          },
          "status": {
            "enum": [
              "accepted"
            ]
          },
          "runId": {
            "type": [
              "string",
              "null"
            ]
          },
          "errorCode": {
            "type": [
              "string",
              "null"
            ]
          },
          "capabilityProfile": {
            "type": "string"
          },
          "limits": {
            "type": "object",
            "required": [
              "maxTurns",
              "maxParallelism"
            ],
            "additionalProperties": false,
            "properties": {
              "maxTurns": {
                "type": "integer"
              },
              "maxParallelism": {
                "type": "integer"
              }
            }
          },
          "tools": {
            "type": "array",
            "maxItems": 64,
            "items": {
              "type": "string"
            }
          },
          "handoff": {
            "type": "object",
            "required": [
              "schemaVersion",
              "findings",
              "files",
              "symbols",
              "toolCalls",
              "turns",
              "dropped"
            ],
            "additionalProperties": false,
            "properties": {
              "schemaVersion": {
                "type": "integer"
              },
              "findings": {
                "type": "array",
                "maxItems": 100,
                "items": {
                  "type": "object",
                  "required": [
                    "kind",
                    "path",
                    "name",
                    "detail"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "kind": {
                      "enum": [
                        "fact",
                        "file",
                        "symbol",
                        "risk",
                        "open_question"
                      ]
                    },
                    "path": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "name": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "detail": {
                      "type": "string",
                      "maxLength": 200
                    }
                  }
                }
              },
              "files": {
                "type": "array",
                "maxItems": 200,
                "items": {
                  "type": "string"
                }
              },
              "symbols": {
                "type": "array",
                "maxItems": 200,
                "items": {
                  "type": "object",
                  "required": [
                    "path",
                    "name",
                    "kind"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "path": {
                      "type": "string"
                    },
                    "name": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string"
                    }
                  }
                }
              },
              "toolCalls": {
                "type": "integer"
              },
              "turns": {
                "type": "integer"
              },
              "dropped": {
                "type": "integer"
              }
            }
          },
          "truncated": {
            "type": "boolean"
          },
          "detached": {
            "const": true
          },
          "accepted": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "childRunId",
              "operationId",
              "duplicate"
            ],
            "properties": {
              "childRunId": {
                "type": "string"
              },
              "operationId": {
                "type": "string"
              },
              "duplicate": {
                "type": "boolean"
              }
            }
          }
        }
      }
    }
  }
},
"code.agent.continue": {
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "childRunId",
      "requestId"
    ],
    "properties": {
      "childRunId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
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
        "const": "code.agent.continue"
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
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "status",
          "childRunId"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "status": {
            "enum": [
              "accepted",
              "requested",
              "settled",
              "pending_remote"
            ]
          },
          "childRunId": {
            "type": "string"
          },
          "childSessionId": {
            "type": "string"
          },
          "duplicate": {
            "type": "boolean"
          },
          "messageId": {
            "type": "string"
          },
          "target": {
            "enum": [
              "next-step",
              "next-turn"
            ]
          },
          "revision": {
            "type": "integer"
          }
        }
      }
    }
  }
},
"code.agent.send_message": {
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "childRunId",
      "requestId",
      "text"
    ],
    "properties": {
      "childRunId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 8000
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
        "const": "code.agent.send_message"
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
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "status",
          "childRunId"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "status": {
            "enum": [
              "accepted",
              "requested",
              "settled",
              "pending_remote"
            ]
          },
          "childRunId": {
            "type": "string"
          },
          "childSessionId": {
            "type": "string"
          },
          "duplicate": {
            "type": "boolean"
          },
          "messageId": {
            "type": "string"
          },
          "target": {
            "enum": [
              "next-step",
              "next-turn"
            ]
          },
          "revision": {
            "type": "integer"
          }
        }
      }
    }
  }
},
"code.agent.interrupt": {
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "childRunId"
    ],
    "properties": {
      "childRunId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
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
        "const": "code.agent.interrupt"
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
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "status",
          "childRunId"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "status": {
            "enum": [
              "accepted",
              "requested",
              "settled",
              "pending_remote"
            ]
          },
          "childRunId": {
            "type": "string"
          },
          "childSessionId": {
            "type": "string"
          },
          "duplicate": {
            "type": "boolean"
          },
          "messageId": {
            "type": "string"
          },
          "target": {
            "enum": [
              "next-step",
              "next-turn"
            ]
          },
          "revision": {
            "type": "integer"
          }
        }
      }
    }
  }
},
};
