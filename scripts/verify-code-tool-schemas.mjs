#!/usr/bin/env node
/**
 * C1a (part B): CI guard for the published Coding Agent tool schemas.
 *
 * Guarantees that a published `name@version` schema never changes silently:
 * - a changed canonical schema for an existing `name@version` fails the build
 *   ("schema changed without a version bump");
 * - a removed or added `name@version` fails the build and asks for a manifest version bump plus a
 *   refreshed snapshot.
 *
 * Usage (plain Node, no TypeScript loader required):
 *   node scripts/verify-code-tool-schemas.mjs --check     (default)
 *   node scripts/verify-code-tool-schemas.mjs --update    (rewrite the snapshot from the artifact)
 *
 * The registry itself is TypeScript and cannot be imported by plain Node 22 (type stripping rejects
 * this module graph), so the guard compares two committed JSON artifacts instead:
 *   - `apps/agent-api/src/code-tool-schemas.published.json` — the current published set, regenerated
 *     from the registry by `tests/coding-agent-c1a-tool-schema-artifact.test.ts` (set
 *     `NPATI_UPDATE_PUBLISHED_TOOL_SCHEMAS=1` to rewrite it, then run `--update` here);
 *   - `tests/fixtures/code-tool-schema-snapshot.json` — the frozen contract of what was published.
 * The test ties the registry to the artifact, so a schema change without a version bump fails either
 * the test suite (registry vs artifact) or this guard (artifact vs snapshot).
 *
 * The comparison logic is exported (`buildSnapshot`, `compareSnapshots`, `comparePublished`) so tests
 * exercise it without spawning a process; the CLI only runs when this file is the entry point.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_PATH = path.resolve(ROOT, "tests/fixtures/code-tool-schema-snapshot.json");
export const PUBLISHED_PATH = path.resolve(ROOT, "apps/agent-api/src/code-tool-schemas.published.json");

/** Stable JSON with recursively sorted keys, mirroring the registry's canonicalisation. */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Canonical form of one tool schema, identical to `canonicalToolSchema` in the registry. */
export function canonicalSchema(tool) {
  return stableJson({
    name: tool.name,
    version: tool.version,
    status: tool.status,
    deprecatedAt: tool.deprecatedAt ?? null,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  });
}

export function buildSnapshot(schemas, manifestVersion) {
  const tools = schemas
    .map((tool) => ({
      key: `${tool.name}@${tool.version}`,
      name: tool.name,
      version: tool.version,
      status: tool.status,
      checksum: sha256Hex(canonicalSchema(tool)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const checksum = sha256Hex(
    schemas.map((tool) => `${tool.name}@${tool.version}:${canonicalSchema(tool)}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"),
  );
  return { manifestVersion, checksum, tools };
}

/**
 * Compares a stored snapshot with the current schemas.
 * Returns `{ ok, errors, snapshot }` where `snapshot` is the up-to-date snapshot for `--update`.
 */
export function compareSnapshots(snapshot, schemas, manifestVersion) {
  const errors = [];
  const current = buildSnapshot(schemas, manifestVersion);
  const snapshotTools = new Map((snapshot?.tools ?? []).map((tool) => [tool.key, tool]));
  const currentTools = new Map(current.tools.map((tool) => [tool.key, tool]));

  for (const [key, stored] of snapshotTools) {
    const live = currentTools.get(key);
    if (!live) {
      errors.push(`published tool version removed: ${key} — a published version must stay (mark it deprecated instead) and the manifest version must be bumped`);
      continue;
    }
    if (live.checksum !== stored.checksum) {
      errors.push(`schema changed without a version bump: ${key} — publish ${stored.name}@${Number(stored.version) + 1} (or bump the manifest) and update the snapshot`);
    }
  }
  for (const [key] of currentTools) {
    if (!snapshotTools.has(key)) {
      errors.push(`new tool version ${key} is not in the snapshot — bump CODE_TOOL_MANIFEST_VERSION and run this script with --update`);
    }
  }
  if (snapshot?.manifestVersion !== undefined && snapshot.manifestVersion !== manifestVersion) {
    errors.push(`manifest version changed: snapshot has ${snapshot.manifestVersion}, code has ${manifestVersion} — update the snapshot`);
  }
  if (snapshot?.checksum && snapshot.checksum !== current.checksum) {
    errors.push(`tool schema checksum changed: snapshot has ${snapshot.checksum}, code has ${current.checksum}`);
  }
  return { ok: errors.length === 0, errors, snapshot: current };
}

export async function readSnapshot(file = SNAPSHOT_PATH) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { manifestVersion: 0, checksum: "", tools: [] };
  }
}

export async function readPublished(file = PUBLISHED_PATH) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Compares the frozen snapshot with the published artifact (both plain JSON).
 * The artifact is self-verifying: every per-tool checksum is recomputed from its canonical schema and
 * the aggregate checksum is recomputed from all `key:canonical` pairs, so a hand-edited artifact is
 * caught as well.
 */
export function comparePublished(snapshot, published) {
  const errors = [];
  const publishedTools = published?.tools ?? [];
  const recomputed = publishedTools.map((tool) => `${tool.key}:${tool.canonical}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
  const expectedChecksum = sha256Hex(recomputed);
  if (published?.checksum && published.checksum !== expectedChecksum) {
    errors.push(`published artifact checksum mismatch: file has ${published.checksum}, recomputed ${expectedChecksum} — regenerate it from the registry`);
  }
  for (const tool of publishedTools) {
    const canonical = typeof tool.canonical === "string" ? tool.canonical : null;
    if (!canonical) { errors.push(`published artifact entry ${tool.key ?? "<unknown>"} has no canonical schema — regenerate it from the registry`); continue; }
    const expected = sha256Hex(canonical);
    if (tool.checksum !== expected) errors.push(`published artifact entry ${tool.key} checksum mismatch — regenerate it from the registry`);
  }

  const snapshotTools = new Map((snapshot?.tools ?? []).map((tool) => [tool.key, tool]));
  const currentTools = new Map(publishedTools.map((tool) => [tool.key, tool]));
  for (const [key, stored] of snapshotTools) {
    const live = currentTools.get(key);
    if (!live) {
      errors.push(`published tool version removed: ${key} — a published version must stay (mark it deprecated instead) and the manifest version must be bumped`);
      continue;
    }
    if (live.checksum !== stored.checksum) {
      errors.push(`schema changed without a version bump: ${key} — publish ${stored.name}@${Number(stored.version) + 1} (or bump the manifest) and update the snapshot`);
    }
  }
  for (const [key] of currentTools) {
    if (!snapshotTools.has(key)) {
      errors.push(`new tool version ${key} is not in the snapshot — bump CODE_TOOL_MANIFEST_VERSION and run this script with --update`);
    }
  }
  if (snapshot?.manifestVersion !== undefined && snapshot.manifestVersion !== published?.manifestVersion) {
    errors.push(`manifest version changed: snapshot has ${snapshot.manifestVersion}, artifact has ${published?.manifestVersion} — update the snapshot`);
  }
  if (snapshot?.checksum && published?.checksum && snapshot.checksum !== published.checksum) {
    errors.push(`tool schema checksum changed: snapshot has ${snapshot.checksum}, artifact has ${published.checksum}`);
  }
  return { ok: errors.length === 0, errors, snapshot: { manifestVersion: published?.manifestVersion ?? 0, checksum: published?.checksum ?? "", tools: publishedTools.map(({ canonical, ...rest }) => rest) } };
}

async function main(argv) {
  const update = argv.includes("--update");
  const published = await readPublished();
  const snapshot = await readSnapshot();
  const { ok, errors, snapshot: next } = comparePublished(snapshot, published);

  if (update) {
    await writeFile(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`tool schema snapshot updated: ${next.tools.length} tool(s), manifest v${next.manifestVersion}, checksum ${next.checksum}`);
    return 0;
  }

  if (!ok) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    console.error("Coding Agent tool schema verification failed.");
    return 1;
  }
  console.log(`Coding Agent tool schemas verified: ${next.tools.length} tool(s), manifest v${next.manifestVersion}, checksum ${next.checksum}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(1); });
}
