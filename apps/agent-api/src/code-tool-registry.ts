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
// All pre-v16 sessions retain schema.apply@1 exactly as published.
const V17_TOOL_SCHEMAS = CODE_TOOL_SCHEMAS.filter(tool => tool.name !== "code.preview.screenshot" || tool.version === 1);
const V16_TOOL_SCHEMAS = V17_TOOL_SCHEMAS.filter(tool => tool.name !== "code.preview.restart");
const LEGACY_TOOL_SCHEMAS = V16_TOOL_SCHEMAS.filter(tool => tool.name !== "code.data.schema.apply" || tool.version === 1);

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
export const C2_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => C2_TOOL_NAMES.includes(tool.name));

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
export const C3_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => C3_TOOL_NAMES.includes(tool.name));

/**
 * The C4 published subset (reads, mutating file tools, sandbox execution and verification). Kept for the
 * same reason as C2/C3: manifest v4 must keep resolving for sessions created before C4a, and its checksum
 * is frozen (see `PUBLISHED_V4_TOOL_SCHEMA_CHECKSUM`).
 */
const C4_TOOL_NAMES: readonly string[] = [
  ...C3_TOOL_NAMES,
  "code.shell.exec",
  "code.shell.process.start",
  "code.shell.process.list",
  "code.shell.process.logs",
  "code.shell.process.stop",
  "code.verify.run",
];
export const C4_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => C4_TOOL_NAMES.includes(tool.name));

/** The C4a dependency subset (inspection, audit and adding a dependency). */
const C4A_TOOL_NAMES: readonly string[] = ["code.deps.inspect", "code.deps.audit", "code.deps.add"];
export const C4A_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => C4A_TOOL_NAMES.includes(tool.name));

/**
 * The C9 published additions (planning metadata): proposing a plan and updating the session todo list.
 *
 * They change session metadata and never the workspace. They are **not** part of the read-only class: the
 * policy engine carries a narrow `PLAN_SAFE_TOOLS` name list for the plan-mode allowance, so a future read
 * tool cannot silently become available in `plan` mode by being "read-only". The three C9 tools share that
 * list, which is why `code.ask_user` is absent from this constant: it was published in v7, and keeping the
 * v6 membership independent of the newest publication is what makes v6 a frozen set rather than a filter.
 */
const C9_TOOL_NAMES: readonly string[] = ["code.plan.propose", "code.plan.update"];

/**
 * The v5 published set (22 tools: everything published through C6b). Listed explicitly rather than as
 * "all tools except the C9 additions" so that a future tool cannot silently leak into an already
 * published manifest — manifest v5 must keep resolving to exactly the set pre-C9 sessions were created
 * with, and its checksum is frozen in `PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM`.
 */
const V5_TOOL_NAMES: readonly string[] = [
  "code.fs.list",
  "code.fs.read",
  "code.fs.grep",
  "code.fs.tree",
  "code.symbols.outline",
  "code.project.info",
  "code.fs.edit",
  "code.fs.apply_patch",
  "code.fs.write",
  "code.fs.move",
  "code.fs.delete",
  "code.fs.diff",
  "code.fs.undo_last_turn",
  "code.shell.exec",
  "code.shell.process.start",
  "code.shell.process.list",
  "code.shell.process.logs",
  "code.shell.process.stop",
  "code.verify.run",
  "code.deps.inspect",
  "code.deps.audit",
  "code.deps.add",
];
export const V5_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => V5_TOOL_NAMES.includes(tool.name));

/**
 * The v6 published set (24 tools: everything published through the C9 planning tools, which is v5 plus
 * `code.plan.propose` and `code.plan.update`). Listed explicitly for exactly the reason v5 is: manifest v7
 * added `code.ask_user`, and a session created before that must keep resolving the 24 tools it started with.
 * "All tools minus the new one" would have leaked the new tool into a manifest that was already served.
 */
const V6_TOOL_NAMES: readonly string[] = [
  ...V5_TOOL_NAMES,
  "code.plan.propose",
  "code.plan.update",
];
export const V6_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => V6_TOOL_NAMES.includes(tool.name));

/**
 * C11: the v7 published set (25 tools: v6 plus `code.ask_user`). Frozen **explicitly**, name by name, for
 * exactly the reason v5 and v6 are: manifest v8 publishes the eleven `code.git.*` tools, and a session
 * created before them must keep resolving the 25 tools it started with. A "filter the current schemas"
 * rule — or a "everything except the git tools" rule — would have looked equivalent today and silently
 * rewritten v7 the next time a tool is published.
 */
const V7_TOOL_NAMES: readonly string[] = [
  ...V6_TOOL_NAMES,
  "code.ask_user",
];
export const V7_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => V7_TOOL_NAMES.includes(tool.name));

/**
 * C12: the v8 published set (36 tools: v7's 25 plus the eleven `code.git.*` workflow tools, inventory ids
 * 374–384). Frozen **explicitly**, name by name, for exactly the reason v5–v7 are: manifest v9 publishes
 * `code.agent.spawn`, and a session created before it must keep resolving the 36 tools it started with. A
 * "filter the current schemas" rule — or an "everything except the delegation tool" rule — would have looked
 * equivalent today and silently rewritten v8 the next time a tool is published.
 */
const V8_TOOL_NAMES: readonly string[] = [
  ...V7_TOOL_NAMES,
  "code.git.status",
  "code.git.diff",
  "code.git.log",
  "code.git.branch.create",
  "code.git.branch.switch",
  "code.git.stage",
  "code.git.commit",
  "code.git.restore",
  "code.git.push",
  "code.git.pr.create",
  "code.git.pr.comment",
];
export const V8_TOOL_SCHEMAS: readonly CodeToolSchema[] = LEGACY_TOOL_SCHEMAS.filter((tool) => V8_TOOL_NAMES.includes(tool.name));

/** Manifest version of the currently published schema set. Bump together with the checksum. */
export const V9_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter((tool) => V8_TOOL_NAMES.includes(tool.name) || tool.name === "code.agent.spawn");
export const PUBLISHED_V9_TOOL_SCHEMA_CHECKSUM = "b498efdc44e06ea1fd8b75860947a770e74f8b9a63dcd92026068a98de963d20";
/** Manifest v15 adds run completion, image/preview viewing, documentation lookup and five Data Studio tools. */
export const V15_ADDED_TOOL_NAMES: readonly string[] = [
  "code.finish", "code.image.view", "code.preview.screenshot", "code.web.fetch", "code.web.search",
  "code.data.query.read", "code.data.rows.seed", "code.data.migrations.list", "code.data.policies.inspect", "code.data.policies.apply",
];
export const V10_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter((tool) => !V15_ADDED_TOOL_NAMES.includes(tool.name) && !tool.name.startsWith("code.data.") && !["code.agent.spawn_async","code.agent.continue","code.agent.send_message","code.agent.interrupt"].includes(tool.name));
export const PUBLISHED_V10_TOOL_SCHEMA_CHECKSUM = "880e0aa6ec32a5ee666864bd9174192e486f559205b8657ea3365c47c7885050";
export const V11_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter(tool => !V15_ADDED_TOOL_NAMES.includes(tool.name) && !tool.name.startsWith("code.data."));
export const V12_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter(tool => !V15_ADDED_TOOL_NAMES.includes(tool.name) && !["code.data.backend.create", "code.data.schema.modify", "code.data.rows.list", "code.data.rows.transfer", "code.data.backend.attach"].includes(tool.name));
export const V13_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter(tool => !V15_ADDED_TOOL_NAMES.includes(tool.name) && tool.name !== "code.data.backend.create");
export const V14_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS.filter(tool => !V15_ADDED_TOOL_NAMES.includes(tool.name));
export const V15_TOOL_SCHEMAS = LEGACY_TOOL_SCHEMAS;
export const CODE_TOOL_MANIFEST_VERSION = 19;

/* Step 6 publishes additive controls and spawn_async in v11; spawn@1 and manifests v1?v10 stay frozen. */

/**
 * Checksum of the published set. It is a literal so that a schema change without a version bump is a
 * visible, reviewable edit instead of a silent re-computation.
 * Regenerate with: `node scripts/code-tool-schemas-generate.mjs --manifest-version N`.
 *
 * v10 (39 tools: the C12 surface, `code.agent.spawn` included). Equals
 * `toolSchemaChecksum(CODE_TOOL_SCHEMAS)` — computed with the registry's own hasher, never a second
 * implementation, and cross-checked against `buildSnapshot(schemas, 10).checksum` in
 * `scripts/verify-code-tool-schemas.mjs` (both hashers agree on the canonical form; they produced the same
 * value for v8 and v9). The committed artifacts (`code-tool-schemas.published.json` and the frozen snapshot) are
 * written by the generator; until that run happens the artifact comparison in
 * `coding-agent-c2-schema-parity.test.ts` and `scripts/verify-code-tool-schemas.mjs --check` are the two
 * places that report the artifact as stale, while `assertManifestConsistent()` — and therefore the manifest
 * the application publishes — is already satisfied.
 */
export const PUBLISHED_TOOL_SCHEMA_CHECKSUM = "6806f5841f30b4bec6b088ec38a01af633c353b5163cc0913e5c01fd55c5249b";

/**
 * Checksum of the v8 published set (36 tools: everything through the eleven `code.git.*` tools). Frozen for
 * the same reason as v2–v7: a session created before the delegation tool was published must keep resolving
 * its own manifest, and editing one of those schemas without publishing a new version must fail the tests
 * instead of rewriting history.
 */
export const PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM = "921d6029dc39122ccda4d71fe426cc4d9c4ca45856c6711fd6908dcdfa7a3233";

/**
 * Checksum of the v7 published set (25 tools: everything through `code.ask_user`). Frozen for the same
 * reason as v2–v6: a session created before the git tools were published must keep resolving its own
 * manifest, and editing one of those schemas without publishing a new version must fail the tests instead
 * of rewriting history.
 */
export const PUBLISHED_V7_TOOL_SCHEMA_CHECKSUM = "44d742ad69ebebca93daccf91ca2be6f3937d344cfb5e03182d6d493c90740da";

/**
 * Checksum of the v6 published set (24 tools, everything through the C9 planning tools). Frozen for the same
 * reason as v2–v5: a session created before `code.ask_user` was published must keep resolving its own
 * manifest, and editing one of those schemas without publishing a new version must fail the tests instead of
 * rewriting history.
 */
export const PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM = "1708d76804e810257fb0f1b122c6d3c8a07c68378e5ed5edec0b5109290d1b73";

/**
 * Checksum of the v5 published set (22 tools, everything before C9 added the planning tools). Frozen for
 * the same reason as v2–v4: a session created before C9 must keep resolving its manifest, and editing one
 * of those schemas without publishing a new version must fail the tests instead of rewriting history.
 */
export const PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM = "ea9cf82b2bb4ca1e2e29b5b364d10a0895e9ded6e94f9dc3cf82d600717d9f19";

/**
 * Checksum of the C4 published set (19 tools: reads, mutating file tools, sandbox execution and
 * verification). Frozen so manifest v4 keeps resolving for sessions created before C4a and so that
 * editing one of those schemas without publishing a new version fails the tests instead of rewriting
 * history.
 */
export const PUBLISHED_V4_TOOL_SCHEMA_CHECKSUM = "2575b9535a0e2900a485e954fde3049ed5a751c0163becdf82937768802d425b";

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
 * tools) stay available so a session created before C3 still resolves; C9 added v6 (the planning tools) and
 * v7 (`code.ask_user`), C11 added v8 (the eleven `code.git.*` tools) and C12 added v9 (`code.agent.spawn`),
 * and every older version was frozen as it was published, so a session created before any of them keeps
 * resolving the exact set it started with. Older versions are never rewritten — that is the whole point of a
 * published manifest.
 */
export const KNOWN_TOOL_MANIFESTS: readonly CodeToolManifest[] = [
  toolManifest([], 1),
  toolManifest(C2_TOOL_SCHEMAS, 2),
  toolManifest(C3_TOOL_SCHEMAS, 3),
  toolManifest(C4_TOOL_SCHEMAS, 4),
  toolManifest(V5_TOOL_SCHEMAS, 5),
  toolManifest(V6_TOOL_SCHEMAS, 6),
  toolManifest(V7_TOOL_SCHEMAS, 7),
  toolManifest(V8_TOOL_SCHEMAS, 8),
  toolManifest(V9_TOOL_SCHEMAS, 9),
  toolManifest(V10_TOOL_SCHEMAS, 10),
  toolManifest(V11_TOOL_SCHEMAS, 11),
  toolManifest(V12_TOOL_SCHEMAS, 12),
  toolManifest(V13_TOOL_SCHEMAS, 13),
  toolManifest(V14_TOOL_SCHEMAS, 14),
  toolManifest(V15_TOOL_SCHEMAS, 15),
  toolManifest(V16_TOOL_SCHEMAS, 16),
  toolManifest(V17_TOOL_SCHEMAS, 17),
  // v19 only adds rename_field to code.data.schema.modify, so a session started on v18 keeps working with the same set.
  toolManifest(CODE_TOOL_SCHEMAS, 18),
  toolManifest(CODE_TOOL_SCHEMAS, CODE_TOOL_MANIFEST_VERSION),
];

/** Convenience for callers that need both the manifest and the consistency assertion. */
export function currentToolManifest(): CodeToolManifest {
  assertManifestConsistent();
  return toolManifest();
}

/** Resolve the exact published schemas named by a session manifest; never substitute the latest version. */
export function schemasForToolManifest(manifestVersion: number): readonly CodeToolSchema[] {
  const manifest = resolveManifestForSession(manifestVersion);
  return manifest.tools.map(published => {
    const schema = CODE_TOOL_SCHEMAS.find(candidate => candidate.name === published.name && candidate.version === published.version);
    if (!schema || sha256(canonicalToolSchema(schema)) !== published.checksum) {
      throw new CodeToolSchemaError("pinned_tool_schema_unavailable", "The session pinned a tool schema this build cannot serve: " + published.key, 409);
    }
    return schema;
  });
}

/** Resolve the exact published version for policy; unknown versions retain the existing mismatch denial. */
export function publishedSchemaForPolicy(name: string, version?: number): CodeToolSchema | undefined {
  return CODE_TOOL_SCHEMAS.find(tool => tool.name === name && (version === undefined || tool.version === version))
    ?? CODE_TOOL_SCHEMAS.find(tool => tool.name === name);
}
