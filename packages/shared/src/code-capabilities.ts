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

/** Every `code.*` capability (reads first, then the mutating file tools, then sandbox execution). */
export const CODE_CAPABILITIES: CapabilityDefinition[] = [
  ...CODE_READ_CAPABILITIES,
  ...CODE_WRITE_CAPABILITIES,
  ...CODE_SHELL_CAPABILITIES,
  ...CODE_DEPS_CAPABILITIES,
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
  ...CODE_SHELL_CAPABILITIES
    .filter((capability) => capability.id.startsWith("code.shell."))
    .map((capability) => [capability.id, "code.shell"] as const),
  // C4a: the dependency audit executes commands in the sandbox (allowlisted registries only) and the
  // dependency add mutates the graph through an install, so both hang off the shell sub-flag; the
  // inspection is pure reading and keeps the default `code.read`.
  ...CODE_DEPS_CAPABILITIES
    .filter((capability) => capability.id !== "code.deps.inspect")
    .map((capability) => [capability.id, "code.shell"] as const),
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
