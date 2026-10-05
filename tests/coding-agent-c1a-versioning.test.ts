import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CODE_TOOL_MANIFEST_VERSION, CODE_TOOL_SCHEMAS, CodeToolSchemaError, PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  assertManifestConsistent, canonicalToolSchema, currentToolManifest, resolveManifestForSession,
  toolKey, toolManifest, toolSchemaChecksum, type CodeToolSchema,
} from "../apps/agent-api/src/code-tool-registry";
import {
  PERSISTED_SCHEMA_VERSIONS, PersistedSchemaError, upcastPersisted, withSchemaVersion, type Upcaster,
} from "../apps/agent-api/src/persisted-schema-upcast";
import {
  API_VERSION, ApiVersionError, DEPRECATION_WINDOW_DAYS, SUPPORTED_API_VERSIONS, apiVersionInfo, resolveApiVersion, withApiVersion,
} from "../apps/agent-api/src/api-versioning";
// The CI guard exposes its comparison logic so the test does not need to spawn a process.
import { buildSnapshot, canonicalSchema, compareSnapshots, stableJson } from "../scripts/verify-code-tool-schemas.mjs";

const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const tool = (overrides: Partial<CodeToolSchema> = {}): CodeToolSchema => ({
  name: "code.fs.read", version: 1, status: "active", description: "Read a file",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  outputSchema: { type: "object", properties: { content: { type: "string" } } },
  ...overrides,
});

describe("C1a — tool schema registry", () => {
  it("starts empty with a frozen manifest version and checksum", () => {
    expect(CODE_TOOL_SCHEMAS).toHaveLength(0);
    expect(CODE_TOOL_MANIFEST_VERSION).toBe(1);
    expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM).toBe(SHA256_EMPTY);
    expect(toolSchemaChecksum([])).toBe(SHA256_EMPTY);
    expect(() => assertManifestConsistent()).not.toThrow();
    expect(currentToolManifest()).toMatchObject({ version: 1, tools: [], checksum: SHA256_EMPTY });
  });

  it("canonicalises and checksums independently of key order and formatting", () => {
    const a = tool({ inputSchema: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } } } });
    const b = tool({ inputSchema: { properties: { mode: { type: "string" }, path: { type: "string" } }, type: "object" } });
    expect(canonicalToolSchema(a)).toBe(canonicalToolSchema(b));
    expect(toolSchemaChecksum([a])).toBe(toolSchemaChecksum([b]));
    expect(toolKey(a)).toBe("code.fs.read@1");
    // A different set produces a different checksum, and the order of the set does not matter.
    const read = tool();
    const write = tool({ name: "code.fs.write", description: "Write a file" });
    expect(toolSchemaChecksum([read, write])).toBe(toolSchemaChecksum([write, read]));
    expect(toolSchemaChecksum([read, write])).not.toBe(toolSchemaChecksum([read]));
  });

  it("fails when the published schemas change without a manifest version bump", () => {
    const read = tool();
    // Passing a mismatching published checksum is exactly the state of "schema edited, version not bumped".
    expect(() => assertManifestConsistent([read], PUBLISHED_TOOL_SCHEMA_CHECKSUM)).toThrow(CodeToolSchemaError);
    try {
      assertManifestConsistent([read], PUBLISHED_TOOL_SCHEMA_CHECKSUM);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as CodeToolSchemaError).code).toBe("manifest_version_not_bumped");
    }
    // With the matching checksum it passes, i.e. the mechanism (not the current empty registry) is at fault.
    expect(() => assertManifestConsistent([read], toolSchemaChecksum([read]))).not.toThrow();
  });

  it("rejects malformed published schemas: duplicate versions, bad names, missing schemas, pending deprecation", () => {
    const checksum = (schemas: CodeToolSchema[]) => toolSchemaChecksum(schemas);
    const expectCode = (schemas: CodeToolSchema[], code: string) => {
      try {
        assertManifestConsistent(schemas, checksum(schemas));
        throw new Error("expected a failure");
      } catch (error) {
        expect((error as CodeToolSchemaError).code).toBe(code);
      }
    };
    expectCode([tool(), tool()], "duplicate_tool_version");
    expectCode([tool({ name: "Code.Fs" })], "invalid_tool_name");
    expectCode([tool({ version: 0 })], "invalid_tool_version");
    expectCode([tool({ status: "deprecated" })], "missing_deprecation_date");
    expectCode([tool({ inputSchema: {} })], "missing_input_schema");
    expectCode([tool({ outputSchema: {} })], "missing_output_schema");
    // A deprecated publication with a date is valid.
    expect(() => assertManifestConsistent([tool({ status: "deprecated", deprecatedAt: "2026-01-01T00:00:00.000Z" })], toolSchemaChecksum([tool({ status: "deprecated", deprecatedAt: "2026-01-01T00:00:00.000Z" })]))).not.toThrow();
  });

  it("resolves the manifest a session was pinned to and refuses unknown versions", () => {
    expect(resolveManifestForSession(1).version).toBe(1);
    expect(resolveManifestForSession(1).tools).toEqual([]);
    expect(() => resolveManifestForSession(2)).toThrow(CodeToolSchemaError);
    try { resolveManifestForSession(2); } catch (error) { expect((error as CodeToolSchemaError).code).toBe("unknown_tool_manifest"); }
    try { resolveManifestForSession(0); } catch (error) { expect((error as CodeToolSchemaError).code).toBe("invalid_tool_manifest_version"); }
    // A future build can serve an older manifest explicitly.
    const legacy = toolManifest([tool()], 7);
    expect(resolveManifestForSession(7, [legacy]).checksum).toBe(toolSchemaChecksum([tool()]));
  });
});

describe("C1a — persisted format versions and upcasters", () => {
  it("pins the current version of every persisted format", () => {
    expect(PERSISTED_SCHEMA_VERSIONS).toEqual({
      sessionTranscript: 1, sessionSummary: 1, checkpointMetadata: 1, modelProfile: 1, toolResult: 1,
    });
  });

  it("treats a missing schemaVersion as v1 and labels it", () => {
    const upgraded = upcastPersisted("toolResult", { toolCallId: "call-1", ok: true });
    expect(upgraded).toMatchObject({ toolCallId: "call-1", ok: true, schemaVersion: 1 });
    expect(withSchemaVersion("sessionSummary", { text: "done" })).toEqual({ text: "done", schemaVersion: 1 });
  });

  it("refuses a payload written by a newer build instead of guessing", () => {
    try {
      upcastPersisted("sessionTranscript", { schemaVersion: 2, events: [] });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedSchemaError);
      expect((error as PersistedSchemaError).code).toBe("unsupported_schema_version");
      expect((error as PersistedSchemaError).status).toBe(409);
    }
  });

  it("rejects unknown kinds, invalid versions and non-object payloads", () => {
    const expectCode = (run: () => unknown, code: string) => {
      try { run(); throw new Error("expected a failure"); } catch (error) { expect((error as PersistedSchemaError).code).toBe(code); }
    };
    expectCode(() => upcastPersisted("notAKind", {}), "unknown_persisted_kind");
    expectCode(() => upcastPersisted("toolResult", { schemaVersion: 0 }), "invalid_schema_version");
    expectCode(() => upcastPersisted("toolResult", "not an object"), "invalid_persisted_payload");
  });

  it("runs a registered upcaster chain in order once a format reaches v2", () => {
    // Forward-looking test: the chain mechanism must be ready before the first v2 format exists.
    const upcasters = { toolResult: { 1: ((payload: Record<string, unknown>) => ({ ...payload, durationMs: 0 })) as Upcaster } };
    const upgraded = upcastPersisted("toolResult", { toolCallId: "c1" }, { upcasters, versions: { toolResult: 2 } });
    expect(upgraded).toMatchObject({ toolCallId: "c1", durationMs: 0, schemaVersion: 2 });
    // A gap in the chain is a build error, not a silent pass-through.
    try {
      upcastPersisted("toolResult", { toolCallId: "c1" }, { upcasters: { toolResult: {} }, versions: { toolResult: 2 } });
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as PersistedSchemaError).code).toBe("missing_upcaster");
    }
  });
});

describe("C1a — API versioning", () => {
  it("defaults to the current version and accepts it explicitly", () => {
    expect(API_VERSION).toBe("v1");
    expect(SUPPORTED_API_VERSIONS).toEqual(["v1"]);
    expect(resolveApiVersion()).toBe("v1");
    expect(resolveApiVersion({ "x-npati-api-version": "v1" })).toBe("v1");
    expect(resolveApiVersion({ "X-NPATI-API-Version": "V1" })).toBe("v1");
    expect(resolveApiVersion({ "accept-version": "v1" })).toBe("v1");
    // A Headers-like object (Fastify/undici) works as well.
    expect(resolveApiVersion({ get: (name: string) => (name.toLowerCase() === "x-npati-api-version" ? "v1" : undefined) })).toBe("v1");
  });

  it("rejects an unsupported version with a structured error", () => {
    try {
      resolveApiVersion({ "x-npati-api-version": "v2" });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiVersionError);
      expect((error as ApiVersionError).code).toBe("unsupported_api_version");
      expect((error as ApiVersionError).status).toBe(400);
    }
  });

  it("stamps responses and exposes discovery metadata", () => {
    expect(withApiVersion({ projects: [] })).toEqual({ projects: [], apiVersion: "v1" });
    const info = apiVersionInfo(new Date("2026-01-01T00:00:00.000Z"));
    expect(info).toMatchObject({ apiVersion: "v1", supported: ["v1"], deprecationWindowDays: DEPRECATION_WINDOW_DAYS, header: "x-npati-api-version", asOf: "2026-01-01T00:00:00.000Z" });
  });
});

describe("security-gate: C1a tool schema CI guard", () => {
  it("passes on the committed snapshot and agrees with the registry checksum", () => {
    const stored = JSON.parse(readFileSync(path.resolve("tests/fixtures/code-tool-schema-snapshot.json"), "utf8")) as { manifestVersion: number; checksum: string; tools: unknown[] };
    expect(stored.manifestVersion).toBe(CODE_TOOL_MANIFEST_VERSION);
    expect(stored.checksum).toBe(toolSchemaChecksum(CODE_TOOL_SCHEMAS));
    expect(stored.checksum).toBe(SHA256_EMPTY);
    expect(compareSnapshots(stored, CODE_TOOL_SCHEMAS, CODE_TOOL_MANIFEST_VERSION)).toMatchObject({ ok: true, errors: [] });
  });

  it("fails when a published schema changes without a version bump", () => {
    const read = tool();
    const stored = buildSnapshot([read], 1);
    // Same version, different description/fields → must be rejected.
    const changed = tool({ description: "Read a file (changed)" });
    const result = compareSnapshots(stored, [changed], 1);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("schema changed without a version bump: code.fs.read@1");
    // A new version of the same tool satisfies the guard (old version stays published as well).
    const bumped = compareSnapshots(stored, [read, tool({ version: 2 })], 1);
    expect(bumped.ok).toBe(false);
    expect(bumped.errors.join("\n")).toContain("new tool version code.fs.read@2");
    const both = buildSnapshot([read, tool({ version: 2 })], 2);
    expect(compareSnapshots(both, [read, tool({ version: 2 })], 2)).toMatchObject({ ok: true });
  });

  it("fails when a published version disappears or the manifest version changes", () => {
    const read = tool();
    const write = tool({ name: "code.fs.write" });
    const stored = buildSnapshot([read, write], 1);
    const removed = compareSnapshots(stored, [read], 1);
    expect(removed.ok).toBe(false);
    expect(removed.errors.join("\n")).toContain("published tool version removed: code.fs.write@1");
    const versionChanged = compareSnapshots(stored, [read, write], 2);
    expect(versionChanged.ok).toBe(false);
    expect(versionChanged.errors.join("\n")).toContain("manifest version changed");
  });

  it("keeps the guard's canonicalisation identical to the registry's", () => {
    const schemas = [tool(), tool({ name: "code.fs.write", version: 2, status: "deprecated", deprecatedAt: "2026-02-01T00:00:00.000Z" })];
    expect(buildSnapshot(schemas, 3).checksum).toBe(toolSchemaChecksum(schemas));
    for (const schema of schemas) expect(canonicalSchema(schema)).toBe(canonicalToolSchema(schema));
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
