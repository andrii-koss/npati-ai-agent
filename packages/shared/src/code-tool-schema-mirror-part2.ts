/* Part 2 of the code-tool schema mirror, split out of code-capabilities.ts in step 3c of
 * docs/refactoring/PLAN.md. Entries are moved verbatim; code-capabilities.ts spreads the parts back
 * together in this exact order, so the resulting object is unchanged, key order included.
 */

import { resultEnvelope, FILE_ENTRY } from "./code-capabilities-shared";

export const CODE_TOOL_SCHEMA_MIRROR_PART2: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
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
};
