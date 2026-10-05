import { canonicalJson, sha256 } from "@npati/workspace";
import authoredSchemas from "./code-tool-schemas.json";

/**
 * C1a (part B): versioned tool schema registry for the Coding Agent.
 *
 * The registry is the single source of truth for `code.*` tool schemas. It is intentionally empty in
 * C1a — the tools themselves arrive in C2–C4 — but the mechanism is complete so that every later step
 * publishes a versioned schema instead of mutating an existing one.
 *
 * Rules encoded here:
 * - A published `name@version` is immutable. Any change to a schema (removing, renaming, retyping or
 *   changing semantics) must publish a new version; additive optional fields may stay on the same
 *   version.
 * - The manifest is the frozen set of versions a session was created with (C1 modelled the column,
 *   C6 consumes it). `CODE_TOOL_MANIFEST_VERSION` only grows when the published set or its content
 *   changes, which is asserted against `PUBLISHED_TOOL_SCHEMA_CHECKSUM`.
 */

export interface CodeToolSchema {
  name: string;
  version: number;
  status: "active" | "deprecated";
  deprecatedAt?: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface CodeToolManifest {
  version: number;
  /** Sorted by `name@version`, so two manifests with the same content compare equal. */
  tools: Array<{ key: string; name: string; version: number; status: "active" | "deprecated"; checksum: string }>;
  checksum: string;
  createdAt: string;
}

export class CodeToolSchemaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) { super(message); }
}

/**
 * Tools published so far. The authored schemas live in `code-tool-schemas.json` so that the plain-Node
 * CI guard (`scripts/code-tool-schemas-generate.mjs` / `verify-code-tool-schemas.mjs`) reads exactly the
 * same source as this registry — one artefact, no duplicated copy to drift.
 */
export const CODE_TOOL_SCHEMAS: readonly CodeToolSchema[] = authoredSchemas as unknown as readonly CodeToolSchema[];

/**
 * The C2 published subset (read/search only). Kept as a named constant because manifest v2 must keep
 * resolving for sessions created before C3, and because its checksum is frozen (see
 * `PUBLISHED_V2_TOOL_SCHEMA_CHECKSUM`).
 */
const C2_TOOL_NAMES: readonly string[] = [
  "code.fs.list",
  "code.fs.read",
  "code.fs.grep",
  "code.fs.tree",
  "code.symbols.outline",
  "code.project.info",
];
export const C2_TOOL_SCHEMAS: readonly CodeToolSchema[] = CODE_TOOL_SCHEMAS.filter((tool) => C2_TOOL_NAMES.includes(tool.name));

/**
 * The C3 published subset (reads plus the mutating file tools). Kept as a named constant for the same
 * reason as the C2 subset: manifest v3 must keep resolving for sessions created before C4, and its
 * checksum is frozen (see `PUBLISHED_V3_TOOL_SCHEMA_CHECKSUM`).
 */
const C3_TOOL_NAMES: readonly string[] = [
  ...C2_TOOL_NAMES,
  "code.fs.edit",
  "code.fs.apply_patch",
  "code.fs.write",
  "code.fs.move",
  "code.fs.delete",
  "code.fs.diff",
  "code.fs.undo_last_turn",
];
export const C3_TOOL_SCHEMAS: readonly CodeToolSchema[] = CODE_TOOL_SCHEMAS.filter((tool) => C3_TOOL_NAMES.includes(tool.name));

/** Manifest version of the currently published schema set. Bump together with the checksum. */
export const CODE_TOOL_MANIFEST_VERSION = 4;

/**
 * Checksum of the published set. It is a literal so that a schema change without a version bump is a
 * visible, reviewable edit instead of a silent re-computation.
 * Regenerate with: `node scripts/code-tool-schemas-generate.mjs --manifest-version N`.
 */
export const PUBLISHED_TOOL_SCHEMA_CHECKSUM = "2575b9535a0e2900a485e954fde3049ed5a751c0163becdf82937768802d425b";

/**
 * Checksum of the C3 published set (13 tools: the reads plus the mutating file tools). Frozen for the
 * same reason as v2: manifest v3 must keep resolving for sessions created before C4, and editing one of
 * those schemas without publishing a new version must fail the tests instead of rewriting history.
 */
export const PUBLISHED_V3_TOOL_SCHEMA_CHECKSUM = "677fb6f897cdf8b2684cd7f59ba574ea3a53897bb7eb9aff6aedec3280072125";

/**
 * Checksum of the C2 published set (the six read/search tools). It is frozen here so that a session
 * pinned to manifest v2 keeps resolving *and* so that mutating one of those six schemas without
 * publishing a new version fails the tests instead of silently rewriting history.
 */
export const PUBLISHED_V2_TOOL_SCHEMA_CHECKSUM = "c1d027c28ade21131aa1b004192bf5350f9d4768c65d37a36f94bdb5f2e4066a";

export function toolKey(tool: Pick<CodeToolSchema, "name" | "version">): string {
  return `${tool.name}@${tool.version}`;
}

/** Stable serialisation: object keys are sorted recursively so formatting never changes a checksum. */
export function canonicalToolSchema(tool: CodeToolSchema): string {
  return canonicalJson({
    name: tool.name,
    version: tool.version,
    status: tool.status,
    deprecatedAt: tool.deprecatedAt ?? null,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  });
}

/** Order-independent checksum over the whole published set. */
export function toolSchemaChecksum(schemas: readonly CodeToolSchema[] = CODE_TOOL_SCHEMAS): string {
  const parts = [...schemas]
    .map((tool) => `${toolKey(tool)}:${canonicalToolSchema(tool)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(parts.join("\n"));
}

/** Builds the manifest for a schema set (defaults to the published set). */
export function toolManifest(schemas: readonly CodeToolSchema[] = CODE_TOOL_SCHEMAS, version = CODE_TOOL_MANIFEST_VERSION): CodeToolManifest {
  const tools = [...schemas]
    .map((tool) => ({
      key: toolKey(tool),
      name: tool.name,
      version: tool.version,
      status: tool.status,
      checksum: sha256(canonicalToolSchema(tool)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { version, tools, checksum: toolSchemaChecksum(schemas), createdAt: new Date().toISOString() };
}

/**
 * Fails when the published set no longer matches the frozen manifest version/checksum, i.e. when
 * somebody changed a schema without bumping `CODE_TOOL_MANIFEST_VERSION` and the published checksum.
 */
export function assertManifestConsistent(
  schemas: readonly CodeToolSchema[] = CODE_TOOL_SCHEMAS,
  publishedChecksum = PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  manifestVersion = CODE_TOOL_MANIFEST_VERSION,
): void {
  const seen = new Set<string>();
  for (const tool of schemas) {
    if (!tool.name || !/^[a-z][a-z0-9_.]*$/.test(tool.name)) {
      throw new CodeToolSchemaError("invalid_tool_name", `Tool name must be lowercase and dotted: "${tool.name}"`, 500);
    }
    if (!Number.isInteger(tool.version) || tool.version < 1) {
      throw new CodeToolSchemaError("invalid_tool_version", `Tool ${tool.name} has an invalid version`, 500);
    }
    if (tool.status === "deprecated" && !tool.deprecatedAt) {
      throw new CodeToolSchemaError("missing_deprecation_date", `Deprecated tool ${toolKey(tool)} must record deprecatedAt`, 500);
    }
    const key = toolKey(tool);
    if (seen.has(key)) throw new CodeToolSchemaError("duplicate_tool_version", `Duplicate published tool version: ${key}`, 500);
    seen.add(key);
    // A published version must carry both schemas: consumers validate arguments and results with them.
    if (!tool.inputSchema || Object.keys(tool.inputSchema).length === 0) {
      throw new CodeToolSchemaError("missing_input_schema", `Tool ${key} has no input schema`, 500);
    }
    if (!tool.outputSchema || Object.keys(tool.outputSchema).length === 0) {
      throw new CodeToolSchemaError("missing_output_schema", `Tool ${key} has no output schema`, 500);
    }
  }
  const actual = toolSchemaChecksum(schemas);
  if (actual !== publishedChecksum) {
    throw new CodeToolSchemaError(
      "manifest_version_not_bumped",
      "Published tool schemas changed without bumping CODE_TOOL_MANIFEST_VERSION/PUBLISHED_TOOL_SCHEMA_CHECKSUM "
      + `(expected ${publishedChecksum}, got ${actual}, manifest version ${manifestVersion})`,
      500,
    );
  }
}

/**
 * Resolves the manifest a session was created with (C1 stores `tool_manifest_version`).
 * Unknown versions are a structured error rather than a silent fallback to "latest", because replay
 * and resume must use exactly the versions the session started with.
 */
export function resolveManifestForSession(manifestVersion: number, manifests: readonly CodeToolManifest[] = KNOWN_TOOL_MANIFESTS): CodeToolManifest {
  if (!Number.isInteger(manifestVersion) || manifestVersion < 1) {
    throw new CodeToolSchemaError("invalid_tool_manifest_version", "Tool manifest version must be a positive integer", 400);
  }
  const found = manifests.find((manifest) => manifest.version === manifestVersion);
  if (!found) {
    throw new CodeToolSchemaError("unknown_tool_manifest", `Unknown tool manifest version: ${manifestVersion}`, 409);
  }
  return found;
}

/**
 * Manifests this build can serve. Version 1 (the empty C1a set) and version 2 (the C2 read/search
 * tools) stay available so a session created before C3 still resolves; C6/C10 extend the list when they
 * keep older sessions.
 */
export const KNOWN_TOOL_MANIFESTS: readonly CodeToolManifest[] = [
  toolManifest([], 1),
  toolManifest(C2_TOOL_SCHEMAS, 2),
  toolManifest(C3_TOOL_SCHEMAS, 3),
  toolManifest(CODE_TOOL_SCHEMAS, CODE_TOOL_MANIFEST_VERSION),
];

/** Convenience for callers that need both the manifest and the consistency assertion. */
export function currentToolManifest(): CodeToolManifest {
  assertManifestConsistent();
  return toolManifest();
}
