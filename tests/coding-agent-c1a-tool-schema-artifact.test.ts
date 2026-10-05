import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  CODE_TOOL_MANIFEST_VERSION, CODE_TOOL_SCHEMAS, assertManifestConsistent, canonicalToolSchema, toolSchemaChecksum,
} from "../apps/agent-api/src/code-tool-registry";
import {
  PUBLISHED_PATH, SNAPSHOT_PATH, comparePublished, readPublished, readSnapshot, sha256Hex,
} from "../scripts/verify-code-tool-schemas.mjs";

/**
 * C1a: the CI guard runs on plain Node (which cannot import the TypeScript registry), so it compares
 * two committed JSON artifacts. This suite is the missing link that ties the *registry* to those
 * artifacts: a schema change without a version bump fails here, and the guard fails on artifact drift.
 *
 * Regeneration workflow (documented in the guard header):
 *   1. change the registry and bump the version / CODE_TOOL_MANIFEST_VERSION;
 *   2. NPATI_UPDATE_PUBLISHED_TOOL_SCHEMAS=1 npx vitest run tests/coding-agent-c1a-tool-schema-artifact.test.ts
 *   3. node scripts/verify-code-tool-schemas.mjs --update
 *   4. commit both JSON files.
 */
function artifactFromRegistry() {
  const tools = CODE_TOOL_SCHEMAS
    .map((tool) => {
      const canonical = canonicalToolSchema(tool);
      return {
        key: `${tool.name}@${tool.version}`, name: tool.name, version: tool.version,
        status: tool.status, checksum: sha256Hex(canonical), canonical,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { manifestVersion: CODE_TOOL_MANIFEST_VERSION, checksum: toolSchemaChecksum(CODE_TOOL_SCHEMAS), tools };
}

describe("C1a — published tool schema artifacts", () => {
  it("keeps the registry, the published artifact and the frozen snapshot in agreement", async () => {
    const artifact = artifactFromRegistry();
    const published = await readPublished();
    const snapshot = await readSnapshot();

    if (process.env.NPATI_UPDATE_PUBLISHED_TOOL_SCHEMAS === "1") {
      await writeFile(PUBLISHED_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    }

    expect(artifact).toEqual(published);
    expect(published.manifestVersion).toBe(CODE_TOOL_MANIFEST_VERSION);
    // The guard's independent checksum implementation must agree with the registry's.
    expect(comparePublished(published, published).ok).toBe(true);
    // The frozen contract and the current artifact must agree (this is what the guard checks in CI).
    const comparison = comparePublished(snapshot, published);
    expect(comparison.errors).toEqual([]);
    expect(comparison.ok).toBe(true);
    expect(() => assertManifestConsistent()).not.toThrow();
  });
});

describe("security-gate: C1a tool schema CI guard", () => {
  const canonical = "{\"a\":1}";
  const snapshot = {
    manifestVersion: 1,
    checksum: sha256Hex(`code.fs.read@1:${canonical}`),
    tools: [{ key: "code.fs.read@1", name: "code.fs.read", version: 1, status: "active", checksum: sha256Hex(canonical) }],
  };
  const published = {
    manifestVersion: 1,
    checksum: snapshot.checksum,
    tools: [{ ...snapshot.tools[0]!, canonical }],
  };

  it("accepts an unchanged published set", () => {
    expect(comparePublished(snapshot, published).ok).toBe(true);
  });

  it("fails a changed schema that keeps the same version", () => {
    const drifted = { ...published, checksum: sha256Hex("code.fs.read@1:{\"a\":2}"), tools: [{ ...published.tools[0]!, canonical: "{\"a\":2}", checksum: sha256Hex("{\"a\":2}") }] };
    const result = comparePublished(snapshot, drifted);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("schema changed without a version bump");
  });

  it("fails a removed or newly published version", () => {
    const removed = comparePublished(snapshot, { manifestVersion: 2, checksum: sha256Hex(""), tools: [] });
    expect(removed.errors.join(" ")).toContain("published tool version removed");
    const added = comparePublished(snapshot, {
      ...published,
      checksum: sha256Hex([`code.fs.read@1:${canonical}`, "code.fs.write@1:{\"b\":1}"].sort().join("\n")),
      tools: [...published.tools, { key: "code.fs.write@1", name: "code.fs.write", version: 1, status: "active", checksum: sha256Hex("{\"b\":1}"), canonical: "{\"b\":1}" }],
    });
    expect(added.errors.join(" ")).toContain("new tool version");
  });

  it("detects a hand-edited artifact (tampered checksum or missing canonical schema)", () => {
    const tampered = comparePublished(snapshot, { ...published, tools: [{ ...published.tools[0]!, checksum: "0".repeat(64) }] });
    expect(tampered.ok).toBe(false);
    expect(tampered.errors.join(" ")).toContain("checksum mismatch");
    const stripped = comparePublished(snapshot, { ...published, tools: [{ key: "code.fs.read@1", name: "code.fs.read", version: 1, status: "active", checksum: snapshot.tools[0]!.checksum }] });
    expect(stripped.ok).toBe(false);
    expect(stripped.errors.join(" ")).toContain("no canonical schema");
  });

  it("keeps the snapshot path pinned to the committed fixture", () => {
    expect(SNAPSHOT_PATH.endsWith("tests/fixtures/code-tool-schema-snapshot.json") || SNAPSHOT_PATH.endsWith("tests\\fixtures\\code-tool-schema-snapshot.json")).toBe(true);
    expect(PUBLISHED_PATH.endsWith("code-tool-schemas.published.json")).toBe(true);
  });
});
