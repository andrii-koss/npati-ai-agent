import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

/**
 * C2: read-only Coding Agent tools.
 *
 * These are the first `code.*` capabilities. They are read-only by design (risk `low`, no approval),
 * and every one of them is gated server-side by the `code.read` feature flag plus the C1 workspace
 * boundary.
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
