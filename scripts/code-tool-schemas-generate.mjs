#!/usr/bin/env node
/**
 * C2: regenerates the published tool-schema artifacts from the authored schema source.
 *
 * The registry (`apps/agent-api/src/code-tool-registry.ts`) imports the same JSON, so this script needs
 * no TypeScript loader and cannot drift from the registry: both read
 * `apps/agent-api/src/code-tool-schemas.json`.
 *
 * Usage:
 *   node scripts/code-tool-schemas-generate.mjs [--manifest-version N] [--check]
 *
 * It writes:
 *   - `apps/agent-api/src/code-tool-schemas.published.json` — the artifact the CI guard verifies;
 *   - `tests/fixtures/code-tool-schema-snapshot.json` — the frozen contract.
 * and prints the value for `PUBLISHED_TOOL_SCHEMA_CHECKSUM` (the registry keeps it as a literal so that
 * a schema edit without a version bump shows up in review).
 *
 * With `--check` it writes nothing and exits 1 when the artifacts are stale.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PUBLISHED_PATH, SNAPSHOT_PATH, buildSnapshot, canonicalSchema, sha256Hex } from "./verify-code-tool-schemas.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_SOURCE_PATH = path.resolve(ROOT, "apps/agent-api/src/code-tool-schemas.json");

/** Reads the authored schemas (the single source of truth shared with the registry). */
export async function readAuthoredSchemas(file = SCHEMA_SOURCE_PATH) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("code-tool-schemas.json must contain an array of tool schemas");
  return parsed;
}

/** Builds the published artifact: one entry per tool with its canonical form and per-tool checksum. */
export function buildPublished(schemas, manifestVersion) {
  const tools = schemas
    .map((tool) => {
      const canonical = canonicalSchema(tool);
      return {
        key: `${tool.name}@${tool.version}`,
        name: tool.name,
        version: tool.version,
        status: tool.status,
        checksum: sha256Hex(canonical),
        canonical,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const checksum = sha256Hex(
    tools.map((tool) => `${tool.key}:${tool.canonical}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"),
  );
  return { manifestVersion, checksum, tools };
}

async function main(argv) {
  const check = argv.includes("--check");
  const print = argv.includes("--print");
  const versionIndex = argv.indexOf("--manifest-version");
  const schemas = await readAuthoredSchemas();
  let manifestVersion = versionIndex >= 0 ? Number(argv[versionIndex + 1]) : undefined;
  if (manifestVersion === undefined) {
    try {
      manifestVersion = JSON.parse(await readFile(PUBLISHED_PATH, "utf8")).manifestVersion ?? 1;
    } catch {
      manifestVersion = 1;
    }
  }
  if (!Number.isInteger(manifestVersion) || manifestVersion < 1) throw new Error("manifest version must be a positive integer");

  const published = buildPublished(schemas, manifestVersion);
  const snapshot = buildSnapshot(schemas, manifestVersion);
  const publishedJson = `${JSON.stringify(published, null, 2)}\n`;
  const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;

  const currentPublished = await readFile(PUBLISHED_PATH, "utf8").catch(() => "");
  const currentSnapshot = await readFile(SNAPSHOT_PATH, "utf8").catch(() => "");
  const stale = currentPublished !== publishedJson || currentSnapshot !== snapshotJson;

  if (check) {
    if (stale) {
      console.error("ERROR: published tool-schema artifacts are stale — run `node scripts/code-tool-schemas-generate.mjs`");
      return 1;
    }
    console.log(`tool schema artifacts are up to date: ${published.tools.length} tool(s), manifest v${manifestVersion}`);
    return 0;
  }

  if (print) {
    // Read-only environments (or a caller that wants to review before writing) can capture the exact
    // file contents from stdout instead of letting this script touch the tree.
    console.log(`PUBLISHED_TOOL_SCHEMA_CHECKSUM = "${published.checksum}"`);
    console.log("-----BEGIN code-tool-schemas.published.json-----");
    process.stdout.write(publishedJson);
    console.log("-----END code-tool-schemas.published.json-----");
    console.log("-----BEGIN code-tool-schema-snapshot.json-----");
    process.stdout.write(snapshotJson);
    console.log("-----END code-tool-schema-snapshot.json-----");
    return 0;
  }

  await writeFile(PUBLISHED_PATH, publishedJson, "utf8");
  await writeFile(SNAPSHOT_PATH, snapshotJson, "utf8");
  console.log(`published ${published.tools.length} tool schema(s), manifest v${manifestVersion}`);
  console.log(`PUBLISHED_TOOL_SCHEMA_CHECKSUM = "${published.checksum}"`);
  for (const tool of published.tools) console.log(`  ${tool.key}  ${tool.checksum}`);
  if (stale) console.log("artifacts rewritten");
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(1); });
}
