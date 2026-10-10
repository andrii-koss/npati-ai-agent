import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

/**
 * C2/C3: Coding Agent tools.
 *
 * C2 contributed the read-only tools (risk `low`, no approval): they are gated server-side by the
 * `code.read` feature flag plus the C1 workspace boundary. C3 adds the mutating tools (`medium`, and
 * `high` for delete), gated by `code.write` on top of the master `coding_agent.enabled` flag, always
 * checkpointed and still confined to the admitted sandbox.
 *
 * SCHEMA CONTRACT (single source of truth)
 * ----------------------------------------
 * The authoritative argument/result schemas are `apps/agent-api/src/code-tool-schemas.json`: those are
 * the schemas the runtime validates against, the ones published as an artifact, and the ones protected
 * by the CI guard (`node scripts/verify-code-tool-schemas.mjs --check`). Because `packages/shared`
 * cannot import from `apps/agent-api`, this file mirrors them and
 * `tests/coding-agent-c2-schema-parity.test.ts` fails the build if the mirror ever drifts (same
 * required fields, same property names and types, same envelope, same versions).
 *
 * `projectId` is deliberately NOT an argument: the runtime receives it in the invocation envelope
 * (`CodeToolRuntime.invoke(ctx, { companyId, projectId, tool, args, toolCallId })`) and the project is
 * authorised against the caller's tenant before any tool logic runs, so a model can never point a
 * tool at another project by passing an id.
 *
 * Inventory ids 349-354 continue the catalog (the previous group ended at 348).
 */
const READ_PERMISSION = ["workspace:read"];

/** Envelope every code tool result is wrapped in, so content is always marked as untrusted data. */
function resultEnvelope(tool: string, data: Record<string, unknown>): Record<string, unknown> {
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

const FILE_ENTRY = {
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

/**
 * Mirror of `apps/agent-api/src/code-tool-schemas.json` (tool `name@version` -> schemas).
 * Keep in lockstep: the parity test compares this object with the registry entry by entry.
 */
export const CODE_TOOL_SCHEMA_MIRROR: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
"code.shell.exec_async": {
  "inputSchema": {
    "type": "object",
    "required": [
      "command"
    ],
    "additionalProperties": false,
    "properties": {
      "command": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "The command line to run in the sandbox. Interactive commands and commands needing production credentials are refused."
      },
      "cwd": {
        "type": "string",
        "description": "Workspace-relative working directory; defaults to the workspace root."
      },
      "env": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        },
        "description": "Non-secret environment variables. Secrets must be requested through secretRefs instead."
      },
      "timeoutMs": {
        "type": "integer",
        "minimum": 1000,
        "maximum": 600000,
        "default": 120000
      },
      "secretRefs": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "maxItems": 10,
        "description": "Names of company vault secrets to lease for exactly this call. The lease is revoked when the call ends and is never inherited."
      },
      "approved": {
        "type": "boolean",
        "default": false,
        "description": "Set by the runtime after the approval system granted this exact command; never set it from model output."
      },
      "background": {
        "type": "boolean",
        "default": false
      },
      "waitTimeoutMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 300000,
        "default": 1000
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
        "const": "code.shell.exec_async"
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
          "kind",
          "version",
          "operationId",
          "processId",
          "generation",
          "state",
          "exitCode",
          "output",
          "earliestOffset",
          "nextOffset",
          "truncated",
          "lossy"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "foreground-result",
              "running-process-receipt"
            ]
          },
          "version": {
            "type": "integer",
            "const": 1
          },
          "operationId": {
            "type": "string"
          },
          "processId": {
            "type": "string"
          },
          "generation": {
            "type": "integer",
            "minimum": 1
          },
          "state": {
            "type": "string",
            "enum": [
              "accepted",
              "preparing",
              "dispatching",
              "running",
              "completed",
              "failed",
              "stopped",
              "timed_out",
              "lost",
              "unknown_outcome"
            ]
          },
          "exitCode": {
            "type": [
              "integer",
              "null"
            ]
          },
          "output": {
            "type": "string",
            "maxLength": 64000
          },
          "earliestOffset": {
            "type": "integer",
            "minimum": 0
          },
          "nextOffset": {
            "type": "integer",
            "minimum": 0
          },
          "truncated": {
            "type": "boolean"
          },
          "lossy": {
            "type": "boolean"
          }
        }
      }
    }
  }
},
"code.shell.process.wait": {
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "processId"
    ],
    "properties": {
      "processId": {
        "type": "string",
        "minLength": 1
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "default": 0
      },
      "waitTimeoutMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 300000,
        "default": 1000
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
        "const": "code.shell.process.wait"
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
          "kind",
          "version",
          "operationId",
          "processId",
          "generation",
          "state",
          "exitCode",
          "output",
          "earliestOffset",
          "nextOffset",
          "truncated",
          "lossy"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "foreground-result",
              "running-process-receipt"
            ]
          },
          "version": {
            "type": "integer",
            "const": 1
          },
          "operationId": {
            "type": "string"
          },
          "processId": {
            "type": "string"
          },
          "generation": {
            "type": "integer",
            "minimum": 1
          },
          "state": {
            "type": "string",
            "enum": [
              "accepted",
              "preparing",
              "dispatching",
              "running",
              "completed",
              "failed",
              "stopped",
              "timed_out",
              "lost",
              "unknown_outcome"
            ]
          },
          "exitCode": {
            "type": [
              "integer",
              "null"
            ]
          },
          "output": {
            "type": "string",
            "maxLength": 64000
          },
          "earliestOffset": {
            "type": "integer",
            "minimum": 0
          },
          "nextOffset": {
            "type": "integer",
            "minimum": 0
          },
          "truncated": {
            "type": "boolean"
          },
          "lossy": {
            "type": "boolean"
          }
        }
      }
    }
  }
},
  "code.fs.list": {
    inputSchema: {
      type: "object",
      required: ["dir"],
      additionalProperties: false,
      properties: {
        dir: { type: "string", description: "Workspace-relative directory (use \".\" for the root). Absolute paths and \"..\" are rejected." },
        glob: { type: "string", description: "Optional glob filter applied to the relative path, e.g. \"src/**/*.ts\"." },
        respectGitignore: { type: "boolean", default: true },
        sortByMtime: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      },
    },
    outputSchema: resultEnvelope("code.fs.list", {
      type: "object",
      required: ["entries", "truncated", "total"],
      additionalProperties: false,
      properties: {
        entries: { type: "array", items: FILE_ENTRY },
        truncated: { type: "boolean" },
        total: { type: "integer" },
      },
    }),
  },
  "code.fs.read": {
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        offset: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 2000 },
        maxLineLength: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
      },
    },
    outputSchema: resultEnvelope("code.fs.read", {
      type: "object",
      required: ["path", "truncated", "binary"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        encoding: { type: "string" },
        totalLines: { type: "integer" },
        lines: {
          type: "array",
          items: {
            type: "object",
            required: ["n", "text"],
            additionalProperties: false,
            properties: { n: { type: "integer" }, text: { type: "string" } },
          },
        },
        truncated: { type: "boolean" },
        binary: { type: "boolean" },
        image: { type: "boolean" },
        mimeGuess: { type: ["string", "null"] },
        bytes: { type: "integer" },
        sha256: { type: "string" },
        redacted: { type: "boolean" },
      },
    }),
  },
  "code.fs.grep": {
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 1000 },
        mode: { enum: ["files_with_matches", "content", "count"], default: "content" },
        glob: { type: "string" },
        type: { type: "string", description: "Language/type filter passed to the search engine, e.g. \"ts\"." },
        contextLines: { type: "integer", minimum: 0, maximum: 10, default: 0 },
        maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
        ignoreCase: { type: "boolean", default: false },
        fixedStrings: { type: "boolean", default: false },
        path: { type: "string", description: "Optional workspace-relative subdirectory or file to search." },
      },
    },
    outputSchema: resultEnvelope("code.fs.grep", {
      type: "object",
      required: ["mode", "engine", "matches", "total", "truncated"],
      additionalProperties: false,
      properties: {
        mode: { enum: ["files_with_matches", "content", "count"] },
        engine: { enum: ["ripgrep", "fallback"] },
        matches: { type: "array", items: { type: "object", additionalProperties: true } },
        total: { type: "integer" },
        truncated: { type: "boolean" },
        path: { type: ["string", "null"] },
      },
    }),
  },
  "code.fs.tree": {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dir: { type: "string", default: "." },
        maxDepth: { type: "integer", minimum: 1, maximum: 10, default: 3 },
        maxEntries: { type: "integer", minimum: 1, maximum: 2000, default: 400 },
      },
    },
    outputSchema: resultEnvelope("code.fs.tree", {
      type: "object",
      required: ["root", "text", "entries", "total", "truncated"],
      additionalProperties: false,
      properties: {
        root: { type: "string" },
        text: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "type", "depth"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              type: { enum: ["file", "dir", "symlink"] },
              depth: { type: "integer" },
            },
          },
        },
        total: { type: "integer" },
        truncated: { type: "boolean" },
      },
    }),
  },
  "code.symbols.outline": {
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
      },
    },
    outputSchema: resultEnvelope("code.symbols.outline", {
      type: "object",
      required: ["available", "path", "symbols"],
      additionalProperties: false,
      properties: {
        available: { type: "boolean" },
        reason: { type: ["string", "null"] },
        path: { type: "string" },
        symbols: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "kind", "line"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              kind: { type: "string" },
              line: { type: "integer" },
            },
          },
        },
        truncated: { type: "boolean" },
      },
    }),
  },
  "code.project.info": {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeToolchain: { type: "boolean", default: true },
        includeVerifyCommands: { type: "boolean", default: true },
      },
    },
    outputSchema: resultEnvelope("code.project.info", {
      type: "object",
      required: ["projectId", "name", "type"],
      additionalProperties: false,
      properties: {
        projectId: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        description: { type: ["string", "null"] },
        status: { type: ["string", "null"] },
        repositoryUrl: { type: ["string", "null"] },
        defaultBranch: { type: ["string", "null"] },
        dataClassification: { type: ["string", "null"] },
        retentionClass: { type: ["string", "null"] },
        languages: { type: "array", items: { type: "string" } },
        packageManagers: { type: "array", items: { type: "string" } },
        verifyCommands: { type: "object", additionalProperties: { type: "string" } },
        toolchainSource: { type: ["string", "null"] },
        detectedAt: { type: ["string", "null"] },
      },
    }),
  },
  "code.fs.edit": {
    inputSchema: {
      type: "object",
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative file path that was read earlier in this session." },
        old_string: { type: "string", minLength: 1, maxLength: 100000, description: "Exact text to replace; must match the current file content byte for byte." },
        new_string: { type: "string", maxLength: 100000 },
        replace_all: { type: "boolean", default: false, description: "Replace every occurrence instead of failing when the match is not unique." },
      },
    },
    outputSchema: resultEnvelope("code.fs.edit", {
      type: "object",
      required: ["path", "replacements", "linesAdded", "linesRemoved", "diff", "sha256", "encoding", "eol"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        replacements: { type: "integer" },
        linesAdded: { type: "integer" },
        linesRemoved: { type: "integer" },
        diff: { type: "string" },
        sha256: { type: "string" },
        encoding: { type: "string" },
        eol: { type: "string" },
      },
    }),
  },
  "code.fs.apply_patch": {
    inputSchema: {
      type: "object",
      required: ["patch"],
      additionalProperties: false,
      properties: {
        patch: { type: "string", minLength: 1, maxLength: 1000000, description: "Unified diff (---/+++/@@ hunks) with workspace-relative paths." },
        dryRun: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.fs.apply_patch", {
      type: "object",
      required: ["applied", "dryRun", "diff"],
      additionalProperties: false,
      properties: {
        applied: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
        diff: { type: "string" },
        failed: { type: ["array", "null"], items: { type: "object", additionalProperties: true } },
      },
    }),
  },
  "code.fs.write": {
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", maxLength: 1000000 },
        createDirectories: { type: "boolean", default: true },
        overwrite: { type: "boolean", default: true, description: "When false, refuse to replace an existing file." },
      },
    },
    outputSchema: resultEnvelope("code.fs.write", {
      type: "object",
      required: ["path", "created", "bytes", "sha256", "encoding", "eol", "diff"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        created: { type: "boolean" },
        bytes: { type: "integer" },
        sha256: { type: "string" },
        encoding: { type: "string" },
        eol: { type: "string" },
        diff: { type: "string" },
      },
    }),
  },
  "code.fs.move": {
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: { type: "string", description: "Existing workspace-relative path." },
        to: { type: "string", description: "Destination workspace-relative path." },
        overwrite: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.fs.move", {
      type: "object",
      required: ["from", "to", "moved"],
      additionalProperties: false,
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        moved: { type: "boolean" },
      },
    }),
  },
  "code.fs.delete": {
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative path to delete." },
        recursive: { type: "boolean", default: false, description: "Required to delete a non-empty directory." },
        expectedRevision: { type: "string", description: "Optional sha256 the caller expects the target to still have; a mismatch refuses the delete." },
      },
    },
    outputSchema: resultEnvelope("code.fs.delete", {
      type: "object",
      required: ["path", "deleted", "recursive"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        deleted: { type: "boolean" },
        recursive: { type: "boolean" },
      },
    }),
  },
  "code.fs.diff": {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Optional workspace-relative path to limit the diff to." },
        turnOnly: { type: "boolean", default: true, description: "Limit the diff to changes made in the current turn." },
        maxFiles: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    },
    outputSchema: resultEnvelope("code.fs.diff", {
      type: "object",
      required: ["files", "stats"],
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "status", "additions", "deletions"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              status: { enum: ["added", "modified", "deleted", "renamed"] },
              additions: { type: "integer" },
              deletions: { type: "integer" },
              diff: { type: "string" },
            },
          },
        },
        stats: {
          type: "object",
          required: ["files", "additions", "deletions"],
          additionalProperties: false,
          properties: {
            files: { type: "integer" },
            additions: { type: "integer" },
            deletions: { type: "integer" },
          },
        },
      },
    }),
  },
  "code.fs.undo_last_turn": {
    inputSchema: {
      type: "object",
      required: ["confirm"],
      additionalProperties: false,
      properties: {
        confirm: { type: "boolean", enum: [true], description: "Must be true: the caller confirms it wants the turn rolled back." },
      },
    },
    outputSchema: resultEnvelope("code.fs.undo_last_turn", {
      type: "object",
      required: ["restored", "checkpointId"],
      additionalProperties: false,
      properties: {
        restored: { type: "array", items: { type: "string" } },
        checkpointId: { type: "string" },
      },
    }),
  },
  "code.shell.exec": {
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000, description: "The command line to run in the sandbox. Interactive commands and commands needing production credentials are refused." },
        cwd: { type: "string", description: "Workspace-relative working directory; defaults to the workspace root." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Non-secret environment variables. Secrets must be requested through secretRefs instead." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 120000 },
        secretRefs: { type: "array", items: { type: "string" }, maxItems: 10, description: "Names of company vault secrets to lease for exactly this call. The lease is revoked when the call ends and is never inherited." },
        approved: { type: "boolean", default: false, description: "Set by the runtime after the approval system granted this exact command; never set it from model output." },
      },
    },
    outputSchema: resultEnvelope("code.shell.exec", {
      type: "object",
      required: ["exitCode", "stdout", "stderr", "durationMs", "truncated", "risk"],
      additionalProperties: false,
      properties: {
        exitCode: { type: ["integer", "null"] },
        stdout: { type: "string" },
        stderr: { type: "string" },
        durationMs: { type: "integer" },
        truncated: { type: "boolean" },
        risk: { enum: ["low", "medium", "high"] },
      },
    }),
  },
  "code.shell.process.start": {
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000 },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        approved: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.start", {
      type: "object",
      required: ["processId", "startedAt"],
      additionalProperties: false,
      properties: {
        processId: { type: "string" },
        startedAt: { type: "string" },
      },
    }),
  },
  "code.shell.process.list": {
    inputSchema: { type: "object", required: [], additionalProperties: false, properties: {} },
    outputSchema: resultEnvelope("code.shell.process.list", {
      type: "object",
      required: ["processes"],
      additionalProperties: false,
      properties: {
        processes: {
          type: "array",
          items: {
            type: "object",
            required: ["processId", "command", "status"],
            additionalProperties: false,
            properties: {
              processId: { type: "string" },
              command: { type: "string" },
              status: { enum: ["running", "stopped", "failed"] },
              startedAt: { type: ["string", "null"] },
              exitCode: { type: ["integer", "null"] },
            },
          },
        },
      },
    }),
  },
  "code.shell.process.logs": {
    inputSchema: {
      type: "object",
      required: ["processId"],
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.logs", {
      type: "object",
      required: ["lines", "nextOffset", "eof"],
      additionalProperties: false,
      properties: {
        lines: { type: "array", items: { type: "string" } },
        nextOffset: { type: "integer" },
        eof: { type: "boolean" },
      },
    }),
  },
  "code.shell.process.stop": {
    inputSchema: {
      type: "object",
      required: ["processId"],
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.stop", {
      type: "object",
      required: ["processId", "stopped"],
      additionalProperties: false,
      properties: {
        processId: { type: "string" },
        stopped: { type: "boolean" },
      },
    }),
  },
  "code.verify.run": {
    inputSchema: {
      type: "object",
      required: ["tools"],
      additionalProperties: false,
      properties: {
        tools: { type: "array", minItems: 1, maxItems: 4, items: { enum: ["lint", "typecheck", "test", "build"] } },
        changedOnly: { type: "boolean", default: false, description: "Verify only the files changed in this turn where the tool supports it." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 600000 },
      },
    },
    outputSchema: resultEnvelope("code.verify.run", {
      type: "object",
      required: ["results", "stats"],
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["tool", "ok", "summary", "findings"],
            additionalProperties: false,
            properties: {
              tool: { enum: ["lint", "typecheck", "test", "build"] },
              ok: { type: "boolean" },
              summary: { type: "string" },
              findings: { type: "array", items: { type: "string" } },
              raw: { type: "string" },
            },
          },
        },
        stats: {
          type: "object",
          required: ["tools", "passed", "failed", "durationMs"],
          additionalProperties: false,
          properties: {
            tools: { type: "integer" },
            passed: { type: "integer" },
            failed: { type: "integer" },
            durationMs: { type: "integer" },
          },
        },
      },
    }),
  },
  "code.deps.inspect": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative manifest or lockfile path; defaults to the detected one." },
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"], description: "Restrict the inspection to one package manager; detection is used when omitted." },
      },
    },
    outputSchema: resultEnvelope("code.deps.inspect", {
      type: "object",
      required: ["manager", "lockfile", "declared"],
      additionalProperties: false,
      properties: {
        manager: { type: "string" },
        lockfile: { type: ["string", "null"] },
        declared: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              version: { type: ["string", "null"] },
              scope: { type: "string", enum: ["runtime", "dev", "peer", "optional", "unknown"] },
              source: { type: ["string", "null"] },
            },
          },
        },
        metadata: { type: "object", additionalProperties: true },
      },
    }),
  },
  "code.deps.audit": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"] },
        lockfilePath: { type: "string", description: "Workspace-relative lockfile to audit; defaults to the detected one." },
        blockOn: {
          type: "array",
          items: { type: "string", enum: ["critical", "high", "moderate", "low"] },
          description: "Severities that make the audit result blocked; defaults to critical and high.",
        },
      },
    },
    outputSchema: resultEnvelope("code.deps.audit", {
      type: "object",
      required: ["report", "blocked"],
      additionalProperties: false,
      properties: {
        report: {
          type: "object",
          required: ["critical", "high", "moderate", "low", "advisories"],
          additionalProperties: false,
          properties: {
            critical: { type: "integer" },
            high: { type: "integer" },
            moderate: { type: "integer" },
            low: { type: "integer" },
            advisories: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  package: { type: "string" },
                  severity: { type: "string" },
                  title: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
        },
        blocked: { type: "boolean" },
        reason: { type: "string" },
      },
    }),
  },
  "code.deps.add": {
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 214 },
        version: { type: "string", description: "Version or range; the resolved exact version is reported back." },
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"] },
        dev: { type: "boolean", default: false, description: "Add as a development dependency." },
        source: { type: "string", enum: ["registry", "git", "tarball", "http", "local_path"], default: "registry", description: "Where the dependency comes from. Anything other than registry requires an approval." },
      },
    },
    outputSchema: resultEnvelope("code.deps.add", {
      type: "object",
      required: ["manager", "name", "source", "verdict", "reasons"],
      additionalProperties: false,
      properties: {
        manager: { type: "string" },
        name: { type: "string" },
        version: { type: ["string", "null"] },
        source: { type: "string" },
        verdict: { type: "string", enum: ["added", "require_approval", "denied"] },
        reasons: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
        approvalId: { type: ["string", "null"] },
      },
    }),
  },
  "code.plan.propose": {
    inputSchema: {
      type: "object",
      required: ["steps"],
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          maxItems: 200,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description: "Workspace-relative paths the plan expects to change, so the reviewer sees the blast radius before approving.",
        },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description: "Ordered steps. When the plan is approved these become the session todo list.",
        },
        risks: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 4096 } },
        testStrategy: { type: "string", maxLength: 4000 },
      },
    },
    outputSchema: resultEnvelope("code.plan.propose", {
      type: "object",
      required: ["planRevision", "status", "steps"],
      additionalProperties: false,
      properties: {
        planRevision: { type: "integer" },
        status: { type: "string" },
        steps: { type: "integer" },
      },
    }),
  },
  "code.plan.update": {
    inputSchema: {
      type: "object",
      required: ["tasks"],
      additionalProperties: false,
      properties: {
        tasks: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["taskId", "content", "status"],
            additionalProperties: false,
            properties: {
              taskId: { type: "string", minLength: 1, maxLength: 128 },
              content: { type: "string", minLength: 1, maxLength: 2000 },
              status: { enum: ["pending", "in_progress", "completed"] },
            },
          },
          description: "The complete todo list. States are exactly pending, in_progress and completed.",
        },
      },
    },
    outputSchema: resultEnvelope("code.plan.update", {
      type: "object",
      required: ["tasks", "pending", "inProgress", "completed"],
      additionalProperties: false,
      properties: {
        tasks: { type: "integer" },
        pending: { type: "integer" },
        inProgress: { type: "integer" },
        completed: { type: "integer" },
      },
    }),
  },
  "code.ask_user": {
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "The question, in the user's language. State what is being decided and why the answer changes what happens next; the row stores this text verbatim.",
        },
        choices: {
          type: "array",
          maxItems: 10,
          description: "Options the user may pick from. Every option needs a stable id (that is what comes back) and a label (that is only displayed). Omit to ask for a free-form answer, which then requires allowFreeAnswer.",
          items: {
            type: "object",
            required: ["id", "label"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128 },
              label: { type: "string", minLength: 1, maxLength: 500 },
              description: { type: "string", maxLength: 1000 },
            },
          },
        },
        allowFreeAnswer: {
          type: "boolean",
          description: "Accept a typed answer as well as (or instead of) the offered choices. A question with neither a choice nor this flag is refused, because nobody could answer it and the run would wait forever.",
        },
        expiresInSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "How long the question stays answerable, in seconds. Defaults to 24 hours and is capped there: an expired question releases the run as ask_user_timeout without inventing an answer.",
        },
      },
    },
    outputSchema: resultEnvelope("code.ask_user", {
      type: "object",
      required: ["questionId", "status", "choices", "allowFreeAnswer", "expiresAt"],
      additionalProperties: false,
      properties: {
        questionId: { type: "string" },
        status: { type: "string" },
        choices: { type: "integer" },
        allowFreeAnswer: { type: "boolean" },
        expiresAt: { type: "string" },
      },
    }),
  },
  /**
   * C11 (owner decision 2): the `code.git.*` workflow tools, mirroring `code-tool-schemas.json`.
   *
   * `workspaceRevision` is in every result that can change the tree: the caller compares it with the
   * revision it captured, which is what makes a git operation and a sandbox build provably run against
   * the same canonical revision.
   */
  "code.git.status": {
    inputSchema: { type: "object", required: [], additionalProperties: false, properties: {} },
    outputSchema: resultEnvelope("code.git.status", {
      type: "object",
      required: ["branch", "clean", "staged", "unstaged", "untracked", "truncated", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        clean: { type: "boolean" },
        staged: { type: "array", items: { type: "string" }, maxItems: 500 },
        unstaged: { type: "array", items: { type: "string" }, maxItems: 500 },
        untracked: { type: "array", items: { type: "string" }, maxItems: 500 },
        truncated: { type: "boolean" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.diff": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        file: { type: "string", minLength: 1, maxLength: 500, description: "Workspace-relative path; the canonical validator refuses traversal, absolute and secret paths." },
        staged: { type: "boolean", default: false, description: "Diff the index against HEAD instead of the worktree against the index." },
      },
    },
    outputSchema: resultEnvelope("code.git.diff", {
      type: "object",
      required: ["diff", "truncated", "files", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        diff: { type: "string" },
        truncated: { type: "boolean" },
        files: { type: "array", items: { type: "string" }, maxItems: 500 },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.log": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    },
    outputSchema: resultEnvelope("code.git.log", {
      type: "object",
      required: ["entries", "count"],
      additionalProperties: false,
      properties: {
        entries: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["hash", "author", "date", "message"],
            additionalProperties: false,
            properties: {
              hash: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
      },
    }),
  },
  "code.git.branch.create": {
    inputSchema: {
      type: "object",
      required: ["branch"],
      additionalProperties: false,
      properties: { branch: { type: "string", minLength: 1, maxLength: 100, description: "Branch to create. `..`, `@{`, a trailing `.lock` and an empty name are refused." } },
    },
    outputSchema: resultEnvelope("code.git.branch.create", {
      type: "object",
      required: ["branch", "created", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        created: { type: "boolean" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.branch.switch": {
    inputSchema: {
      type: "object",
      required: ["branch"],
      additionalProperties: false,
      properties: { branch: { type: "string", minLength: 1, maxLength: 100, description: "Existing branch to check out." } },
    },
    outputSchema: resultEnvelope("code.git.branch.switch", {
      type: "object",
      required: ["branch", "previousBranch", "switched"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        previousBranch: { type: ["string", "null"] },
        switched: { type: "boolean" },
      },
    }),
  },
  "code.git.stage": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        files: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths to stage. Omit to stage every change." },
      },
    },
    outputSchema: resultEnvelope("code.git.stage", {
      type: "object",
      required: ["staged", "stagedCount"],
      additionalProperties: false,
      properties: {
        staged: { type: "array", items: { type: "string" }, maxItems: 500 },
        stagedCount: { type: "integer" },
      },
    }),
  },
  "code.git.commit": {
    inputSchema: {
      type: "object",
      required: ["message"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000 },
        files: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths to commit. Omit with stageAll to commit what is already staged." },
        stageAll: { type: "boolean", default: false, description: "Stage every change before committing." },
      },
    },
    outputSchema: resultEnvelope("code.git.commit", {
      type: "object",
      required: ["commitHash", "message", "branch", "stagedCount", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        commitHash: { type: "string" },
        message: { type: "string" },
        branch: { type: "string" },
        stagedCount: { type: "integer" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.restore": {
    inputSchema: {
      type: "object",
      required: ["files"],
      additionalProperties: false,
      properties: {
        files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths whose working-tree changes are discarded. Empty is refused." },
      },
    },
    outputSchema: resultEnvelope("code.git.restore", {
      type: "object",
      required: ["restored", "restoredCount"],
      additionalProperties: false,
      properties: {
        restored: { type: "array", items: { type: "string" }, maxItems: 500 },
        restoredCount: { type: "integer" },
      },
    }),
  },
  "code.git.push": {
    inputSchema: {
      type: "object",
      required: ["targetBranch", "credentialId"],
      additionalProperties: false,
      properties: {
        targetBranch: { type: "string", minLength: 1, maxLength: 100, description: "The branch on the remote this push writes. Required: without a named target the protected-branch policy has nothing to judge." },
        sourceBranch: { type: "string", minLength: 1, maxLength: 100, description: "The local branch to publish. Defaults to targetBranch." },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
        force: { type: "boolean", default: false, description: "Ask for a history rewrite. A protected branch answers force_push_denied; any other branch is refused as unsupported." },
      },
    },
    outputSchema: resultEnvelope("code.git.push", {
      type: "object",
      required: ["pushed", "branch", "remoteBranch", "force"],
      additionalProperties: false,
      properties: {
        pushed: { type: "boolean" },
        branch: { type: "string" },
        remoteBranch: { type: "string" },
        force: { type: "boolean" },
      },
    }),
  },
  "code.git.pr.create": {
    inputSchema: {
      type: "object",
      required: ["title", "base", "head", "credentialId"],
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        body: { type: "string", maxLength: 60000, description: "Body. Omit to reuse the run summary (what changed, verification, risks, unresolved items)." },
        base: { type: "string", minLength: 1, maxLength: 100, description: "The branch the pull request targets." },
        head: { type: "string", minLength: 1, maxLength: 100, description: "The branch under review." },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
      },
    },
    outputSchema: resultEnvelope("code.git.pr.create", {
      type: "object",
      required: ["prNumber", "prUrl", "base", "head", "created", "descriptionSource"],
      additionalProperties: false,
      properties: {
        prNumber: { type: ["integer", "null"] },
        prUrl: { type: ["string", "null"] },
        base: { type: "string" },
        head: { type: "string" },
        created: { type: "boolean" },
        descriptionSource: { type: "string", enum: ["caller", "run_summary", "unavailable"] },
      },
    }),
  },
  "code.git.pr.comment": {
    inputSchema: {
      type: "object",
      required: ["pullNumber", "body", "credentialId"],
      additionalProperties: false,
      properties: {
        pullNumber: { type: "integer", minimum: 1, maximum: 1000000 },
        body: { type: "string", minLength: 1, maxLength: 60000 },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
      },
    },
    outputSchema: resultEnvelope("code.git.pr.comment", {
      type: "object",
      required: ["commentId", "commentUrl", "pullNumber", "created"],
      additionalProperties: false,
      properties: {
        commentId: { type: ["integer", "null"] },
        commentUrl: { type: ["string", "null"] },
        pullNumber: { type: "integer" },
        created: { type: "boolean" },
      },
    }),
  },
  /**
   * C12: the delegation tool. It is a **metadata** tool like the git adapters — the child's transcript,
   * file bodies and tool output never travel back — which is why its result schema is a bounded handoff
   * digest rather than a nested run result.
   */
  "code.agent.spawn": {
    inputSchema: {
      type: "object",
      required: ["agentType", "task"],
      additionalProperties: false,
      properties: {
        agentType: { enum: ["explore", "plan", "implement", "review", "test"], description: "The kind of sub-agent. It decides the child's model profile, turn limit and capability profile." },
        task: { type: "string", minLength: 1, maxLength: 8000, description: "A self-contained task. The child sees this text, not this run's conversation." },
        paths: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1024 }, description: "Workspace-relative file or directory scope for the child. Each path passes the canonical path guard, so absolute, traversing and secret paths are refused." },
        tools: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 }, description: "Tools requested for the child. A request is never a grant: the effective set is the intersection of this run's effective tools, the child type's profile and this list, resolved against the published registry. A wildcard resolves only against that registry." },
        model: { type: "string", maxLength: 200, description: "Optional model override. The child type's model profile still applies, so an override cannot remove its constraints." },
        turnLimit: { type: "integer", minimum: 1, maximum: 40, description: "Requested cap on the child's model turns. Clamped down to the child type's limit, which is itself clamped to the canonical ceiling: configuration may lower it, never raise it." },
        summaryOnly: { type: "boolean", default: true, description: "Return the metadata-only handoff digest. It is the only result this tool produces, so `false` is refused with `subagent_summary_required` instead of being silently ignored." },
      },
    },
    outputSchema: resultEnvelope("code.agent.spawn", {
      type: "object",
      required: ["agentType", "status", "runId", "capabilityProfile", "limits", "tools", "handoff", "truncated"],
      additionalProperties: false,
      properties: {
        agentType: { enum: ["explore", "plan", "implement", "review", "test"] },
        status: { enum: ["completed", "failed"] },
        runId: { type: ["string", "null"] },
        errorCode: { type: ["string", "null"] },
        capabilityProfile: { type: "string" },
        limits: {
          type: "object",
          required: ["maxTurns", "maxParallelism"],
          additionalProperties: false,
          properties: {
            maxTurns: { type: "integer" },
            maxParallelism: { type: "integer" },
          },
        },
        tools: { type: "array", maxItems: 64, items: { type: "string" } },
        handoff: {
          type: "object",
          required: ["schemaVersion", "findings", "files", "symbols", "toolCalls", "turns", "dropped"],
          additionalProperties: false,
          properties: {
            schemaVersion: { type: "integer" },
            findings: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["kind", "path", "name", "detail"],
                additionalProperties: false,
                properties: {
                  kind: { enum: ["fact", "file", "symbol", "risk", "open_question"] },
                  path: { type: ["string", "null"] },
                  name: { type: ["string", "null"] },
                  detail: { type: "string", maxLength: 200 },
                },
              },
            },
            files: { type: "array", maxItems: 200, items: { type: "string" } },
            symbols: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                required: ["path", "name", "kind"],
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  name: { type: "string" },
                  kind: { type: "string" },
                },
              },
            },
            toolCalls: { type: "integer" },
            turns: { type: "integer" },
            dropped: { type: "integer" },
          },
        },
        truncated: { type: "boolean" },
      },
    }),
  },
};

export const CODE_READ_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.fs.list",
    inventoryIds: [349],
    type: "tool",
    domain: "code",
    name: "List code files (glob)",
    description: "List files in the active code project workspace, optionally filtered by a glob pattern, honouring .gitignore and sorted by modification time.",
    useWhen: [
      "The agent needs to discover which files exist in a code project before reading them.",
      "The agent has a glob or extension hint and wants the matching paths.",
    ],
    doNotUseWhen: [
      "The goal is to modify, create or delete files (the read-only C2 tool set cannot do that).",
      "The agent needs file contents: use code.fs.read or code.fs.grep instead.",
      "The path is outside the project workspace or resolves through a symlink out of it.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.list"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.list"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.read",
    inventoryIds: [350],
    type: "tool",
    domain: "code",
    name: "Read code file",
    description: "Read a text file from the project workspace with line numbers, offset/limit paging and long-line truncation; binary and image files return metadata instead of content.",
    useWhen: [
      "The agent needs the exact content of a known file, or a specific line range of it.",
      "The agent is preparing an edit and must see the current text first.",
    ],
    doNotUseWhen: [
      "The agent wants to find where something is defined across many files: use code.fs.grep first.",
      "The file is outside the workspace, is a symlink leaving the workspace, or is a secret/credential file.",
      "The file is large and only a summary is needed (read a bounded range instead).",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.read"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.read"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.grep",
    inventoryIds: [351],
    type: "tool",
    domain: "code",
    name: "Search code contents",
    description: "Search file contents inside the project workspace with a regular expression, optional glob/type filters and context lines, in files_with_matches, content or count mode.",
    useWhen: [
      "The agent needs to locate a symbol, string or pattern across the codebase.",
      "The agent wants to count or list the files that mention something.",
    ],
    doNotUseWhen: [
      "The agent needs the whole file rather than the matching lines: use code.fs.read.",
      "The search would read secret files or paths outside the workspace.",
      "A cheap path listing is enough: use code.fs.list.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.grep"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.grep"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.tree",
    inventoryIds: [352],
    type: "tool",
    domain: "code",
    name: "Project tree overview",
    description: "Return a compact directory tree of the project workspace with bounded depth and entry count, skipping ignored and generated directories.",
    useWhen: [
      "The agent needs a quick orientation of the repository layout before planning work.",
      "The agent wants to confirm where a module lives without listing every file.",
    ],
    doNotUseWhen: [
      "The agent needs file contents or matches: use code.fs.read or code.fs.grep.",
      "The agent needs metadata of many files: use code.fs.list.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.tree"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.tree"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.symbols.outline",
    inventoryIds: [353],
    type: "tool",
    domain: "code",
    name: "File symbol outline",
    description: "List the symbols (classes, functions, methods) of a source file using universal-ctags when it is present in the sandbox image, and otherwise report the structured reason symbols_unavailable instead of guessing.",
    useWhen: [
      "The agent needs the structure of a single file without reading all of it.",
      "The agent is deciding which function to read or edit next.",
    ],
    doNotUseWhen: [
      "ctags is unavailable in the sandbox image: the tool reports symbols_unavailable rather than parsing heuristically.",
      "The agent needs cross-file references: use code.fs.grep.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.symbols.outline"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.symbols.outline"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.project.info",
    inventoryIds: [354],
    type: "tool",
    domain: "code",
    name: "Code project summary",
    description: "Return the code project metadata and the detected toolchain (languages, package managers, verify commands) recorded in C1, without reading file contents.",
    useWhen: [
      "The agent needs to know which language, package manager and verification commands the project uses.",
      "The agent is about to plan verification steps and needs the recorded commands.",
    ],
    doNotUseWhen: [
      "The agent needs repository contents: use the read tools.",
      "The agent needs another company's project: tenant isolation forbids it.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.project.info"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.project.info"]!.outputSchema,
    version: 1,
  },
];

export const CODE_READ_MATRIX: CapabilityMatrixEntry[] = CODE_READ_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c2-schema-parity.test.ts", "tests/coding-agent-c2-tool-runtime.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/**
 * C3: mutating Coding Agent tools.
 *
 * Every one of them is gated server-side by the `code.write` feature flag (on top of the master
 * `coding_agent.enabled` flag), requires `workspace:write`, runs only in the admitted sandbox, and is
 * checkpointed so a turn can be rolled back. `code.fs.delete` is the only `high` risk tool of the set
 * and the only one that requires an explicit approval; `code.fs.diff` stays read-only (`low`).
 *
 * Inventory ids 355-361 continue the catalog (C2 ended at 354).
 */
const WRITE_PERMISSION = ["workspace:write"];

export const CODE_WRITE_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.fs.edit",
    inventoryIds: [355],
    type: "tool",
    domain: "code",
    name: "Edit code file (exact replace)",
    description: "Replace an exact string in one workspace file after the file was read in this session, returning the diff, the new sha256 and the line counts. Every edit is checkpointed.",
    useWhen: [
      "The agent knows the exact current text (from code.fs.read) and wants a minimal, reviewable change.",
      "A small, surgical replacement is safer than rewriting the whole file.",
    ],
    doNotUseWhen: [
      "The file was not read in this session: read-before-write is enforced and the edit will be refused.",
      "The change spans several files or needs structural rewriting: use code.fs.apply_patch.",
      "The file is a secret/credential file or a path outside the workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.edit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.edit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.apply_patch",
    inventoryIds: [356],
    type: "tool",
    domain: "code",
    name: "Apply patch to workspace",
    description: "Apply a unified diff patch to the workspace, optionally as a dry run that reports the changes without writing anything. Conflicts are returned as structured data.",
    useWhen: [
      "The agent must change several hunks or files in one reviewable operation.",
      "The agent wants to preview a change set before writing it (dryRun).",
    ],
    doNotUseWhen: [
      "A single exact replacement is enough: use code.fs.edit.",
      "The patch paths leave the workspace or touch secret files: both are refused.",
      "The change is a whole new file: use code.fs.write.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.apply_patch"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.apply_patch"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.write",
    inventoryIds: [357],
    type: "tool",
    domain: "code",
    name: "Write code file",
    description: "Create or overwrite one workspace file with the given content, returning whether it was created, the byte count, the new sha256 and the diff. Every write is checkpointed.",
    useWhen: [
      "The agent creates a new file (a test, a module, a config) from scratch.",
      "The agent rewrites a small file where a patch would be more fragile than the full text.",
    ],
    doNotUseWhen: [
      "The change is a few lines inside a large file: prefer code.fs.edit so the diff stays reviewable.",
      "The destination is a secret/credential file or outside the workspace.",
      "The file exists and must not be replaced: pass overwrite=false or use code.fs.edit.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.write"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.write"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.move",
    inventoryIds: [358],
    type: "tool",
    domain: "code",
    name: "Move or rename path",
    description: "Move or rename a file or directory inside the workspace, refusing to overwrite an existing destination unless explicitly allowed and refusing to leave the workspace.",
    useWhen: [
      "The agent reorganises files (rename a module, move a test next to its subject).",
      "A path must change without changing its content.",
    ],
    doNotUseWhen: [
      "The content also changes: move first, then edit, so both changes are separate checkpoints.",
      "The destination already exists and must be kept: the move would be refused.",
      "Either path leaves the workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.move"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.move"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.delete",
    inventoryIds: [359],
    type: "tool",
    domain: "code",
    name: "Delete workspace path",
    description: "Delete one file or directory inside the workspace. High risk: it always requires an explicit approval, refuses recursive deletion without the recursive flag and can be pinned to an expected sha256 revision.",
    useWhen: [
      "A file is genuinely obsolete and the owner approved the deletion.",
      "A generated artefact must be removed before a clean rebuild.",
    ],
    doNotUseWhen: [
      "The intent is to replace content: use code.fs.write or code.fs.edit instead of deleting.",
      "The target is a directory with contents and recursive was not set.",
      "The target is a secret file, a path outside the workspace, or anything under version control that should be restored instead.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.delete"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.delete"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.diff",
    inventoryIds: [360],
    type: "tool",
    domain: "code",
    name: "Workspace diff",
    description: "Read-only diff of the current turn (or of one path) with per-file status and line statistics, so the agent and the user can review what changed before anything else happens.",
    useWhen: [
      "The agent wants to verify what its own edits changed before reporting success.",
      "The user needs a summary of the turn (which files, how many lines).",
    ],
    doNotUseWhen: [
      "The agent needs file contents rather than a diff: use code.fs.read.",
      "The agent wants git history: this tool never touches git (that is C4 territory).",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.diff"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.diff"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.fs.undo_last_turn",
    inventoryIds: [361],
    type: "tool",
    domain: "code",
    name: "Undo last turn",
    description: "Restore the workspace to the checkpoint taken at the start of the current turn, returning the restored paths and the checkpoint id used.",
    useWhen: [
      "The agent's edits made things worse and the whole turn should be rolled back.",
      "The user asks to undo the last change set as a unit.",
    ],
    doNotUseWhen: [
      "Only one file should be reverted: edit that file back instead of dropping the whole turn.",
      "The caller cannot pass confirm=true: the tool refuses without an explicit confirmation.",
      "The turn is still running (checkpoints are closed when the turn ends).",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.undo_last_turn"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.fs.undo_last_turn"]!.outputSchema,
    version: 1,
  },
];

/**
 * C4: sandbox execution tools.
 *
 * These are the first tools that run commands rather than touch files, so they are gated by the
 * `code.shell` sub-flag (on top of the master flag) and the two command-launching tools are `high` risk
 * with `requiresConfirmation: true`: a dangerous command must go through the existing approval system
 * before the sandbox runs it. `code.verify.run` only replays the project's configured verification
 * commands, so it stays `medium` and is gated by `code.write`.
 *
 * Secret handling is per call (`secretRefs`): the lease is scoped to one tool call, has a TTL, is
 * revoked when the call ends, and is never inherited by later calls or written into a shell profile.
 *
 * Inventory ids 362-367 continue the catalog (C3 ended at 361).
 */
const SHELL_PERMISSION = ["workspace:write"];

export const CODE_SHELL_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.shell.exec",
    inventoryIds: [362],
    type: "tool",
    domain: "code",
    name: "Run sandbox command",
    description: "Run one non-interactive command inside the admitted sandbox and return the exit code, stdout, stderr and duration. Dangerous commands require an approval, secrets are leased per call, and output is redacted and truncated.",
    useWhen: [
      "The agent must run a build, a test suite, a formatter or an inspection command that the sandbox image provides.",
      "A verification step needs the project's own tooling rather than a fixed tool call.",
    ],
    doNotUseWhen: [
      "The command is interactive or long-running: use code.shell.process.start.",
      "The command needs production credentials or network access outside the allowlist: it will be refused.",
      "A read/search tool answers the question (code.fs.grep, code.fs.read): running a shell command for that is wasteful and riskier.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    // Approval is decided by the server-side PolicyEngine from the command's risk class, not by the
    // capability contract: a safe command inside an allowed session mode runs without an extra prompt,
    // while an approval-class or hard-denied command is still gated (and hard-denied outright).
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.shell.process.start",
    inventoryIds: [363],
    type: "tool",
    domain: "code",
    name: "Start sandbox process",
    description: "Start a long-running process (a dev server, a watcher) inside the sandbox and return its process id. The process belongs to the sandbox and is stopped when the sandbox is cleaned up.",
    useWhen: [
      "A development server or watcher must keep running while the agent does something else.",
      "A preview needs a background process rather than a blocking command.",
    ],
    doNotUseWhen: [
      "A short command is enough: use code.shell.exec so the output is returned directly.",
      "The process would need production credentials or unapproved network access.",
      "The process is interactive: interactive commands are not supported.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    // See code.shell.exec: the PolicyEngine, not the capability contract, decides approvals.
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.start"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.start"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.shell.process.list",
    inventoryIds: [364],
    type: "tool",
    domain: "code",
    name: "List sandbox processes",
    description: "List the processes this sandbox started, with their status and exit code. Read-only: it starts nothing and reveals no environment values.",
    useWhen: [
      "The agent wants to know whether a previously started process is still running.",
      "Before starting a server, to check whether one is already running.",
    ],
    doNotUseWhen: [
      "The agent needs the process output: use code.shell.process.logs.",
      "The path or process id is not known to this session.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.list"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.list"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.shell.process.logs",
    inventoryIds: [365],
    type: "tool",
    domain: "code",
    name: "Read sandbox process logs",
    description: "Read the buffered output of a sandbox process by offset so a long log can be paged. Secrets are redacted before the output is returned.",
    useWhen: [
      "A background process must be inspected (a failing dev server, a watcher error).",
      "The agent needs the tail of a long log: page it with offset/limit instead of reading everything.",
    ],
    doNotUseWhen: [
      "The process id belongs to another project or sandbox: ownership is enforced and the call is refused.",
      "The agent needs the exit code only: code.shell.process.list already reports it.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.logs"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.logs"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.shell.process.stop",
    inventoryIds: [366],
    type: "tool",
    domain: "code",
    name: "Stop sandbox process",
    description: "Stop a process started through code.shell.process.start. Stopping a process the sandbox does not own is refused.",
    useWhen: [
      "A dev server or watcher is no longer needed and the sandbox should not keep running it.",
      "A process must be restarted after a configuration change.",
    ],
    doNotUseWhen: [
      "The process was started outside this project's sandbox.",
      "The intent is to stop the sandbox itself: that is sandbox lifecycle, not a tool call.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.stop"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.stop"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.verify.run",
    inventoryIds: [367],
    type: "tool",
    domain: "code",
    name: "Verify changes",
    description: "Run the project's configured verification commands (lint, typecheck, test, build) in the sandbox and return structured findings per tool with a pass/fail summary.",
    useWhen: [
      "After changing code, to prove the change does not break the project.",
      "Before proposing a change as finished, so the model sees real results instead of assuming.",
    ],
    doNotUseWhen: [
      "The project has no configured command for the requested tool: the result reports it as unavailable rather than inventing a command.",
      "A single ad-hoc command is needed: use code.shell.exec.",
      "The verification needs network access outside the egress allowlist.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.verify.run"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.verify.run"]!.outputSchema,
    version: 1,
  },
];

/**
 * C4a: dependency tools. `code.deps.inspect` only reads manifests and lockfiles (so it is gated by
 * `code.read`), the audit needs sandbox execution and the allowlisted registries (`code.shell`), and
 * `code.deps.add` mutates the dependency graph, so it is high risk and must be approved through the
 * existing approval system — an install is never a silent side effect.
 */
export const CODE_DEPS_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.deps.inspect",
    inventoryIds: [368],
    type: "tool",
    domain: "code",
    name: "Inspect dependencies",
    description: "Read the project's dependency manifests and lockfiles and report the declared dependencies, the resolved lockfile and per-ecosystem metadata without installing or touching the network.",
    useWhen: [
      "Before changing dependencies, to see what the project already declares and which lockfile governs it.",
      "To decide whether a lockfile is present and reproducible before an install is attempted.",
    ],
    doNotUseWhen: [
      "An installation or an upgrade is needed: use code.deps.add or a controlled install command.",
      "The manifest lives outside the project workspace.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.inspect"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.inspect"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.deps.audit",
    inventoryIds: [369],
    type: "tool",
    domain: "code",
    name: "Audit dependencies",
    description: "Run a lockfile-based vulnerability audit in the sandbox against allowlisted registries and return a structured advisory report with the configured block-on severities applied.",
    useWhen: [
      "After adding or updating dependencies, to prove no known critical or high advisory was pulled in.",
      "Before proposing a dependency change as finished.",
    ],
    doNotUseWhen: [
      "The project has no lockfile: the result reports lockfile_required instead of auditing a moving target.",
      "The registry is not on the egress allowlist: the audit reports the network isolation state rather than bypassing it.",
      "A fix is expected: this tool only reports.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.audit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.audit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.deps.add",
    inventoryIds: [370],
    type: "tool",
    domain: "code",
    name: "Add a dependency",
    description: "Add one dependency to the project with lifecycle scripts disabled by default and only against allowlisted registries; any non-registry source requires an approval from the existing approval system.",
    useWhen: [
      "The task genuinely needs a new library and the dependency policy allows it.",
      "A specific version must be pinned and recorded in the lockfile.",
    ],
    doNotUseWhen: [
      "The source is a git URL, tarball, plain HTTP URL or a local path: those require an approval and are refused otherwise.",
      "The registry would have to be changed: that needs an approval and is never done implicitly.",
      "Lifecycle scripts would have to run: installs run with scripts disabled.",
      "Production credentials would be involved: they are never issued to the agent.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: SHELL_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.add"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.deps.add"]!.outputSchema,
    version: 1,
  },
];

/**
 * C9: planning tools (inventory ids 371-372), appended after the dependency group so the earlier groups keep
 * their exact ids and membership. They are `low` risk and require `workspace:read`: they change session
 * metadata (a plan draft, the todo list), never a workspace file. Marking them read-only is deliberate — it is
 * what lets them run in `plan` mode, the one mode whose purpose is to produce a plan — and it is exactly why
 * both tools are idempotent: C6a recovery repeats read-only tool calls.
 */
export const CODE_PLAN_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.plan.propose",
    inventoryIds: [371],
    type: "tool",
    domain: "code",
    name: "Propose a plan revision",
    description:
      "Record a structured plan for the session (expected files, ordered steps, risks, test strategy) as a new draft revision. The plan is model-produced data: it selects no session mode, changes no workspace file, and nothing is executed until the user approves a revision.",
    useWhen: [
      "The session runs in plan mode and the agent has finished exploring the code it needs to change.",
      "The user asked for a plan before any modification.",
    ],
    doNotUseWhen: [
      "The session is not in plan mode and the change is trivial enough to just do.",
      "The agent wants to change files: the plan is metadata, and the approved revision is what starts execution.",
      "The agent wants to record progress: use code.plan.update instead.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.propose"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.propose"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.plan.update",
    inventoryIds: [372],
    type: "tool",
    domain: "code",
    name: "Update the session todo list",
    description:
      "Replace the session todo list (pending / in_progress / completed). At most one task may be in_progress; a list that breaks that rule is refused instead of normalised, and the whole list is sent every time so a replayed call cannot duplicate tasks.",
    useWhen: [
      "The agent starts, finishes or reorders a task during a run.",
      "The agent needs the user to see current progress in the workspace.",
    ],
    doNotUseWhen: [
      "The agent wants to record a plan before approval: use code.plan.propose instead.",
      "The agent wants to mark work done without verifying it: todo state is not acceptance evidence.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.update"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.plan.update"]!.outputSchema,
    version: 1,
  },
];

/**
 * C9: `code.ask_user` (inventory id 373), appended **after** the planning group so that the ids 349–372 keep
 * their exact meaning and membership. A published inventory id that moved would silently re-point at another
 * capability in every stored audit matrix, so a new id is only ever appended.
 *
 * It asks a person to decide and pauses the run (`waiting_for_user`) until they answer. `low` risk,
 * `workspace:read`, no confirmation: the tool cannot change a file, a sandbox or the network, and asking a
 * question must never be gated behind the very permission whose scope is in doubt — an agent that cannot ask
 * would guess instead. It is in the narrow `PLAN_SAFE_TOOLS` list rather than the read-only class for the same
 * reason the plan tools are.
 */
export const CODE_ASK_USER_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.ask_user",
    inventoryIds: [373],
    type: "tool",
    domain: "code",
    name: "Ask the user a question",
    description:
      "Ask the user a decision question and pause the run as waiting_for_user until a human answers. The question is a stored row, so the pause survives a restart; only the user can answer it, no default or timeout ever answers for them, and an unanswered question expires with ask_user_timeout instead of being guessed.",
    useWhen: [
      "The choice belongs to the user: an ambiguous requirement, two defensible designs, or a production/dev target the agent must not pick.",
      "The agent would otherwise guess at something that changes the outcome and cannot be discovered by reading the code.",
    ],
    doNotUseWhen: [
      "The answer is in the repository, the plan or the user's earlier message: read it instead of asking again.",
      "The agent wants permission for something the policy engine already decides: that is a policy decision, not a question.",
      "The agent wants to report progress or propose a plan: use code.plan.propose or code.plan.update.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.ask_user"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.ask_user"]!.outputSchema,
    version: 1,
  },
];

/**
 * C11 (owner decision 2): the `code.git.*` workflow capabilities (inventory ids **374–384**), appended after
 * `code.ask_user`'s 373 so every previously published id keeps its exact meaning and membership.
 *
 * They are **adapters over the existing `ProjectGitService`**: no git implementation lives behind them, so
 * there is still exactly one git path (the service that already re-checks the protected-branch policy at its
 * boundary and consumes the approval record with the payload hash of the write). Three published facts are
 * therefore visible in the Capability Inspector and are the contract the executors must honour:
 *
 *  - three tools are **read-only** (`status`, `diff`, `log`); they are also the only git tools a
 *    `REVIEW_CODE` session may call, which is what makes "a review does not write to the repository" a
 *    server-side property rather than a prompt request;
 *  - `code.git.push`, `code.git.pr.create` and `code.git.pr.comment` are `high`/`medium` and
 *    approval-gated, and each carries its **own** approval binding (a branch pair, a `(base, head)` pair, a
 *    comment hash) — so an approval for one of them is never redeemable for another;
 *  - `code.git.restore` is `high` and approval-gated, because discarding uncommitted work is not
 *    recoverable from a checkpoint.
 */
export const CODE_GIT_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.git.status",
    inventoryIds: [374],
    type: "tool",
    domain: "code",
    name: "Git status",
    description: "Report the git state of the canonical project workspace: the checked-out branch, whether the tree is clean, and the staged, unstaged and untracked paths. Read-only; the paths are data and cannot change policy.",
    useWhen: [
      "Before staging or committing, to see exactly what would be included.",
      "After a repair, to confirm the tree holds what the agent believes it holds.",
    ],
    doNotUseWhen: [
      "A diff body is needed: use code.git.diff.",
      "The repository is not connected: the tool reports that state instead of inventing one.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.status"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.status"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.diff",
    inventoryIds: [375],
    type: "tool",
    domain: "code",
    name: "Git diff",
    description: "Return the unified diff of the canonical project workspace, optionally limited to one workspace-relative path and optionally the staged side. Bounded, explicitly truncated, and untrusted data.",
    useWhen: [
      "Before committing, to review what the commit would contain.",
      "To check one file's change without re-reading the whole file.",
    ],
    doNotUseWhen: [
      "A file's whole content is needed: use code.fs.read.",
      "A committed revision must be compared: find the commit with code.git.log first.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.diff"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.diff"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.log",
    inventoryIds: [376],
    type: "tool",
    domain: "code",
    name: "Git log",
    description: "List the most recent commits of the canonical project workspace (hash, author, date, subject). Read-only and bounded; a repository with no history answers with an empty list rather than an error.",
    useWhen: [
      "To confirm a commit the agent made is present before opening a pull request.",
      "To see what a branch already contains.",
    ],
    doNotUseWhen: [
      "The working-tree state is needed: use code.git.status.",
      "A full patch is needed: use code.git.diff.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.log"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.log"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.branch.create",
    inventoryIds: [377],
    type: "tool",
    domain: "code",
    name: "Create a git branch",
    description: "Create a branch in the canonical project workspace and check it out, so agent work never accumulates on the main branch. The name is validated before any command runs; a branch writes no remote.",
    useWhen: [
      "At the start of a coding session, to isolate work on npati/<session-short-id>.",
      "Before a change that must not touch the current branch.",
    ],
    doNotUseWhen: [
      "The branch already exists: switch to it instead.",
      "The intent is to publish: that is code.git.push and needs an approval.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.create"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.create"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.branch.switch",
    inventoryIds: [378],
    type: "tool",
    domain: "code",
    name: "Switch git branch",
    description: "Check out an existing branch of the canonical project workspace. A switch that would have to carry or discard uncommitted changes is refused, so it never silently moves somebody else's work.",
    useWhen: [
      "Returning to the session branch after inspecting another one.",
      "Moving to a branch a human asked to review.",
    ],
    doNotUseWhen: [
      "The branch does not exist: create it first.",
      "The change set is unfinished: commit it first, or the switch is refused.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.switch"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.branch.switch"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.stage",
    inventoryIds: [379],
    type: "tool",
    domain: "code",
    name: "Stage git changes",
    description: "Stage changes in the canonical project workspace, either the named paths or everything. Every path goes through the canonical validator and the index is re-checked, so a protected or secret file cannot be staged.",
    useWhen: [
      "Preparing a commit that must contain only some changed files.",
      "After a targeted restore, to make the index match the worktree.",
    ],
    doNotUseWhen: [
      "Everything should be committed: code.git.commit stages all by itself.",
      "A path is secret or protected: that is refused, not silently filtered.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.stage"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.stage"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.commit",
    inventoryIds: [380],
    type: "tool",
    domain: "code",
    name: "Commit git changes",
    description: "Commit the staged changes (or every change) in the canonical project workspace and return the commit hash. The commit is checked against the session branch and the canonical revision the run captured, so it cannot land on the wrong branch.",
    useWhen: [
      "A verified change set is ready to become durable.",
      "Before a push, because a push publishes commits and not a working tree.",
    ],
    doNotUseWhen: [
      "Verification has not run: a commit makes an unverified change durable.",
      "The point is to publish: that is code.git.push.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.commit"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.commit"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.restore",
    inventoryIds: [381],
    type: "tool",
    domain: "code",
    name: "Restore paths in git",
    description: "Discard the working-tree changes of the named paths. It always needs an explicit human approval, because it destroys uncommitted work no checkpoint can bring back; the approval is bound to the exact path list.",
    useWhen: [
      "A change went wrong and the paths must return to the committed state.",
      "A file must be reset before a different approach is tried.",
    ],
    doNotUseWhen: [
      "The change should be reversible: make a checkpoint or commit first.",
      "The paths were never committed: restoring them deletes the only copy.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.restore"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.restore"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.push",
    inventoryIds: [382],
    type: "tool",
    domain: "code",
    name: "Push a branch",
    description: "Push one branch to the project's connected GitHub repository. It needs a real human approval record bound to the operation, both branches, the remote, `force` and the credential reference, and the protected-branch policy is re-evaluated at the git boundary immediately before the write. Force pushes are refused.",
    useWhen: [
      "An approved, verified change set must be published for review.",
      "A pull request is about to be opened from this branch.",
    ],
    doNotUseWhen: [
      "The target branch is protected: that is a hard deny no approval can lift.",
      "History would have to be rewritten: force pushes are refused by this API.",
      "The work is not verified yet.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.push"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.push"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.pr.create",
    inventoryIds: [383],
    type: "tool",
    domain: "code",
    name: "Open a pull request",
    description: "Open a GitHub pull request for an already-pushed branch. The approval is bound to the (base, head) pair and the credential reference, so an approval for one pull request cannot be redeemed for another. Without a body it is generated from the run's own verified summary.",
    useWhen: [
      "A pushed branch is ready for human review.",
      "The run finished and its verification result should travel with the review request.",
    ],
    doNotUseWhen: [
      "The branch is not pushed yet.",
      "The change is not verified: the generated description states that instead of hiding it.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "high",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.create"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.create"]!.outputSchema,
    version: 1,
  },
  {
    id: "code.git.pr.comment",
    inventoryIds: [384],
    type: "tool",
    domain: "code",
    name: "Comment on a pull request",
    description: "Post one comment on an existing GitHub pull request. Reviewing is read-only, so commenting is a separate capability with its own approval record bound to the pull-request number and a hash of the comment text: an approval for a push or for opening a pull request can never be redeemed as a comment.",
    useWhen: [
      "A review produced a finding that belongs on the pull request for the author to read.",
      "A human asked for the review result to be posted.",
    ],
    doNotUseWhen: [
      "No pull request exists yet.",
      "The text contains a credential, a token or production data: it is published to GitHub.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: true,
    requiredConnections: [],
    requiredPermissions: WRITE_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.comment"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.git.pr.comment"]!.outputSchema,
    version: 1,
  },
];

/**
 * C12: the delegation capability (inventory id **385**), appended after the git group so every previously
 * published id keeps its exact meaning and membership.
 *
 * One capability, because there is one act: hand a bounded task to a coding sub-agent. Its published facts are
 * the contract the server enforces:
 *
 *  - **Depth 1 is structural.** A run that has a parent is never offered this tool and the tool runtime refuses
 *    the name before the sub-flag, the arguments, the approval and the executor, so a child cannot delegate
 *    whatever the model asks for or the configuration says.
 *  - **A request is never a grant.** The child's tools are the intersection of this run's effective set, the
 *    child type's own profile and the requested list. A wildcard resolves only against the published registry;
 *    with no registry it grants nothing rather than meaning "everything".
 *  - **Metadata only in both directions.** The child receives the task text and a scope; the parent receives a
 *    bounded handoff digest (findings, paths, symbols, counts) and never the child's transcript, file bodies or
 *    tool output.
 *
 * `risk` is `medium`: it neither destroys work like `code.fs.delete` nor publishes anything like
 * `code.git.push`, but it does start another run that may write to the workspace, so it is not a read.
 * It is **not** approve-gated: approval belongs to the individual write the child attempts, which is judged by
 * the same policy engine as any other call — gating the delegation as well would ask the human twice for one
 * change and would teach the agent to avoid delegating.
 */
export const CODE_SUBAGENT_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "code.agent.spawn",
    inventoryIds: [385],
    type: "tool",
    domain: "code",
    name: "Delegate to a coding sub-agent",
    description: "Delegate one bounded task to a coding sub-agent of a named type (explore for read-only repository search, plan, implement within a file scope, review, or test) and get back a metadata-only handoff digest: findings, file paths, symbols and counts. Depth is 1 by construction — a sub-agent run is never offered this tool and the runtime refuses it for a run that has a parent — and the child's tools are an intersection of this run's effective set, the type's profile and the requested list, so a request can only narrow.",
    useWhen: [
      "A repository-wide search or an architecture survey would flood this conversation with file bodies: delegate it to an explore sub-agent and keep only the digest.",
      "Several independent files or areas have to change and the work can be split without a second planner.",
      "A change needs an independent review or a test-focused pass that should not see this run's reasoning.",
    ],
    doNotUseWhen: [
      "The answer is one known file: read it directly instead of paying for a second run.",
      "The task needs this conversation's context: the child sees the task text only, never the transcript.",
      "The work needs a decision from the user: ask with code.ask_user, because a sub-agent cannot answer for them.",
    ],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: READ_PERMISSION,
    inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.agent.spawn"]!.inputSchema,
    outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.agent.spawn"]!.outputSchema,
    version: 1,
  },
];

/** Every `code.*` capability (reads, mutating file tools, sandbox execution, dependencies, planning). */
export const CODE_ASYNC_PROCESS_CAPABILITIES: CapabilityDefinition[] = [
  {"id":"code.shell.exec_async","inventoryIds":[386],"type":"tool","domain":"code","name":"Run tracked command","description":"Execute one tracked sandbox process. Wait up to waitTimeoutMs, then return the same handle for explicit collection. Foreground secret leases cannot be promoted.","useWhen":["Continue the run while a sandbox command is still running."],"doNotUseWhen":["The backend does not support durable process identity.","The command requires foreground secret leases."],"agentCallable":true,"userVisible":true,"risk":"high","requiresConfirmation":false,"requiredConnections":[],"requiredPermissions":["workspace:write"],"version":1, inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec_async"]!.inputSchema, outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.exec_async"]!.outputSchema },
{"id":"code.shell.process.wait","inventoryIds":[387],"type":"tool","domain":"code","name":"Collect tracked process","description":"Collect bounded output and real terminal state of a tracked process. waitTimeoutMs=0 polls; a timeout preserves the same process handle.","useWhen":["Collect the real outcome of a previously started process."],"doNotUseWhen":["The backend does not support durable process identity.","The command requires foreground secret leases."],"agentCallable":true,"userVisible":true,"risk":"low","requiresConfirmation":false,"requiredConnections":[],"requiredPermissions":["workspace:read"],"version":1, inputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.wait"]!.inputSchema, outputSchema: CODE_TOOL_SCHEMA_MIRROR["code.shell.process.wait"]!.outputSchema }
];
export const CODE_ASYNC_PROCESS_MATRIX: CapabilityMatrixEntry[] = CODE_ASYNC_PROCESS_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!, capabilityId: capability.id, name: capability.name, type: "tool", domain: "code", agentCallable: true,
  risk: capability.risk, testType: "integration", testFiles: ["tests/coding-agent-async-process.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"], status: "VERIFIED_EXISTING",
}));
export const CODE_CAPABILITIES: CapabilityDefinition[] = [
  ...CODE_ASYNC_PROCESS_CAPABILITIES,
  ...CODE_READ_CAPABILITIES,
  ...CODE_WRITE_CAPABILITIES,
  ...CODE_SHELL_CAPABILITIES,
  ...CODE_DEPS_CAPABILITIES,
  ...CODE_PLAN_CAPABILITIES,
  ...CODE_ASK_USER_CAPABILITIES,
  ...CODE_GIT_CAPABILITIES,
  ...CODE_SUBAGENT_CAPABILITIES,
];

export const CODE_WRITE_MATRIX: CapabilityMatrixEntry[] = CODE_WRITE_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c3-capabilities.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"],
  status: "VERIFIED_EXISTING",
}));

export const CODE_SHELL_MATRIX: CapabilityMatrixEntry[] = CODE_SHELL_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c4-capabilities.test.ts", "tests/coding-agent-c3-schema-executor-parity.test.ts"],
  status: "VERIFIED_EXISTING",
}));

export const CODE_DEPS_MATRIX: CapabilityMatrixEntry[] = CODE_DEPS_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c4a-capabilities.test.ts", "tests/coding-agent-c2-schema-parity.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/** C9: the planning tools' audit-matrix entries (inventory ids 371-372). */
export const CODE_PLAN_MATRIX: CapabilityMatrixEntry[] = CODE_PLAN_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c9-plan-tool.test.ts", "tests/coding-agent-c9-plan-mode.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/** C9: `code.ask_user`'s audit-matrix entry (inventory id 373). */
export const CODE_ASK_USER_MATRIX: CapabilityMatrixEntry[] = CODE_ASK_USER_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c9-ask-user.test.ts", "tests/coding-agent-c9-ask-user-runner.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/**
 * C11: the `code.git.*` workflow tools' audit-matrix entries (inventory ids 374–384). Every one of them
 * delegates to the existing `ProjectGitService`; the matrix names the suite that proves it, so a
 * capability cannot claim to be verified by a file that does not test it.
 */
export const CODE_GIT_MATRIX: CapabilityMatrixEntry[] = CODE_GIT_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c11-git-workflow.test.ts", "tests/coding-agent-c11-git-workflow-security.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/**
 * C12: the delegation tool's audit-matrix entry (inventory id 385). The two suites named here are the ones
 * that prove the published behaviour: the scope suite drives the intersection and the depth limit, and the
 * workflow suite drives the executor, the handoff digest and the failure path.
 */
export const CODE_SUBAGENT_MATRIX: CapabilityMatrixEntry[] = CODE_SUBAGENT_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "code",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/coding-agent-c12-subagent-workflow.test.ts", "tests/coding-agent-c12-subagent-scope.test.ts"],
  status: "VERIFIED_EXISTING",
}));

/**
 * Which feature flag gates which code tool. The read/search tools *and* `code.fs.diff` need `code.read`
 * (they only read), every mutating tool needs `code.write`; both sit on top of the master
 * `coding_agent.enabled` flag. The decision is made from the capability's own permission requirement so
 * a read-only tool that happens to live in the write group (like `code.fs.diff`) cannot be reported as
 * write-gated. Exported so the Capability Inspector can show the flag that actually governs each
 * capability instead of assuming one flag for the whole `code` domain.
 */
export const CODE_TOOL_FLAG_KEYS: Record<string, string> = Object.fromEntries(
  CODE_CAPABILITIES.map((capability) => [
    capability.id,
    (capability.requiredPermissions ?? []).includes("workspace:write") ? "code.write" : "code.read",
  ]),
);

/**
 * C4: the sandbox execution tools hang off their own sub-flag (`code.shell`) instead of `code.write`,
 * so an operator can allow file edits while forbidding command execution (or the other way round).
 * `code.verify.run` deliberately stays on `code.write`: it only replays the project's configured
 * verification commands, so it belongs with the change tools it verifies.
 */
export const CODE_TOOL_FLAG_OVERRIDES: Record<string, string> = Object.fromEntries([
  ...CODE_ASYNC_PROCESS_CAPABILITIES.map((capability) => [capability.id, "code.shell"] as const),
  ...CODE_SHELL_CAPABILITIES
    .filter((capability) => capability.id.startsWith("code.shell."))
    .map((capability) => [capability.id, "code.shell"] as const),
  // C4a: the dependency audit executes commands in the sandbox (allowlisted registries only) and the
  // dependency add mutates the graph through an install, so both hang off the shell sub-flag; the
  // inspection is pure reading and keeps the default `code.read`.
  ...CODE_DEPS_CAPABILITIES
    .filter((capability) => capability.id !== "code.deps.inspect")
    .map((capability) => [capability.id, "code.shell"] as const),
  /**
   * C11: every `code.git.*` tool hangs off its own `code.git` sub-flag, including the read-only three.
   * `code.write` and `code.git` are different blast radii: enabling file edits must not enable pushing to
   * a remote, and enabling git must not be reported as "file writes are on". The read-only git tools share
   * the flag because an operator who forbids git must not be left with a working `git status` path that
   * the UI reports as write-gated.
   */
  ...CODE_GIT_CAPABILITIES.map((capability) => [capability.id, "code.git"] as const),
  /**
   * C12: the delegation tool hangs off its own `code.subagents` sub-flag, not `code.read`/`code.write`.
   * Delegation has a different blast radius again: it starts another run that consumes the shared budget and
   * may write, so enabling file edits must not enable spawning children, and enabling git must not either.
   */
  ...CODE_SUBAGENT_CAPABILITIES.map((capability) => [capability.id, "code.subagents"] as const),
]);

export const CODE_TOOL_FLAG_KEYS_RESOLVED: Record<string, string> = {
  ...CODE_TOOL_FLAG_KEYS,
  ...CODE_TOOL_FLAG_OVERRIDES,
};

export function flagKeyForCodeTool(capabilityId: string, domain?: string): string | null {
  const direct = CODE_TOOL_FLAG_KEYS_RESOLVED[capabilityId];
  if (direct) return direct;
  return domain === "code" ? "code.read" : null;
}
