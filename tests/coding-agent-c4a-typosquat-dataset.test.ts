import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  DEFAULT_TYPOSQUAT_MAX_AGE_DAYS, TYPOSQUAT_ECOSYSTEMS, loadTyposquatDataset, typosquatDatasetHash,
} from "../apps/agent-api/src/code-typosquat-dataset";
import { DEFAULT_POPULAR_PACKAGES, checkDependency } from "../apps/agent-api/src/code-deps-guard";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DATASET_DIRECTORY = path.join(REPO_ROOT, "data", "typosquat");
const NOW = new Date("2025-02-01T00:00:00.000Z"); // shortly after the dataset's generatedAt

/** Minimal valid dataset fixture; `overrides` lets a test break exactly one property. */
function fixture(overrides: Record<string, unknown> = {}, names = ["lodash", "react", "express"]) {
  const base = {
    schemaVersion: 1,
    ecosystem: "npm",
    datasetVersion: "test-1",
    generatedAt: "2025-01-15T00:00:00.000Z",
    source: { kind: "curated", description: "test fixture", references: [] },
    hash: typosquatDatasetHash(names),
    packageNames: names,
  };
  return JSON.stringify({ ...base, ...overrides });
}

const readerFrom = (content: string | Error) => async () => {
  if (content instanceof Error) throw content;
  return content;
};

describe("security-gate: C4a curated typosquat dataset", () => {
  it("ships a valid, versioned dataset for every ecosystem", async () => {
    for (const ecosystem of TYPOSQUAT_ECOSYSTEMS) {
      const result = await loadTyposquatDataset(ecosystem, { directory: DATASET_DIRECTORY, now: NOW });
      expect(result.ok, `${ecosystem}: ${result.ok ? "" : result.details}`).toBe(true);
      if (!result.ok) continue;
      expect(result.dataset.schemaVersion).toBe(1);
      expect(result.dataset.ecosystem).toBe(ecosystem);
      expect(result.dataset.packageNames.length).toBeGreaterThanOrEqual(40);
      expect(new Set(result.dataset.packageNames).size).toBe(result.dataset.packageNames.length);
      expect(result.dataset.hash).toBe(typosquatDatasetHash(result.dataset.packageNames));
      expect(result.dataset.source.kind).toBe("curated");
      expect(result.dataset.source.references.length).toBeGreaterThan(0);
    }
  });

  it("reports a missing file, invalid JSON, an unsupported schema and an ecosystem mismatch", async () => {
    const missing = await loadTyposquatDataset("npm", { readFile: readerFrom(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) });
    expect(missing).toMatchObject({ ok: false, reason: "dataset_missing" });

    const broken = await loadTyposquatDataset("npm", { readFile: readerFrom("{not json") });
    expect(broken).toMatchObject({ ok: false, reason: "dataset_invalid" });

    const schema = await loadTyposquatDataset("npm", { readFile: readerFrom(fixture({ schemaVersion: 99 })) });
    expect(schema).toMatchObject({ ok: false, reason: "dataset_unsupported_schema" });

    const mismatch = await loadTyposquatDataset("pypi", { readFile: readerFrom(fixture()) });
    expect(mismatch).toMatchObject({ ok: false, reason: "dataset_ecosystem_mismatch" });
  });

  it("rejects duplicate names and a tampered hash", async () => {
    // Every fixture is evaluated against `NOW`: without it the shipped `generatedAt` would age out and
    // the staleness check would mask the reason actually under test.
    const duplicates = await loadTyposquatDataset("npm", { readFile: readerFrom(fixture({}, ["lodash", "lodash"])), now: NOW });
    expect(duplicates).toMatchObject({ ok: false, reason: "dataset_invalid" });

    // The tampered file keeps a hash that no longer matches its names: the loader must refuse it.
    const tampered = await loadTyposquatDataset("npm", { readFile: readerFrom(fixture({ hash: typosquatDatasetHash(["lodash"]) })), now: NOW });
    expect(tampered).toMatchObject({ ok: false, reason: "dataset_hash_mismatch" });

    // An empty name list is invalid on its own, not merely a hash mismatch.
    const empty = await loadTyposquatDataset("npm", { readFile: readerFrom(fixture({}, [])), now: NOW });
    expect(empty).toMatchObject({ ok: false, reason: "dataset_invalid" });
  });

  it("refuses a stale dataset by age", async () => {
    const stale = await loadTyposquatDataset("npm", { readFile: readerFrom(fixture()), now: new Date("2030-01-01T00:00:00.000Z") });
    expect(stale).toMatchObject({ ok: false, reason: "dataset_stale" });
    expect(DEFAULT_TYPOSQUAT_MAX_AGE_DAYS).toBe(365);
  });

  it("keeps no built-in popular-package list in the guard", () => {
    expect(DEFAULT_POPULAR_PACKAGES).toEqual([]);
  });
});

describe("security-gate: C4a guard escalates when the dataset is unavailable", () => {
  const metadata = async () => ({ exists: true, latestVersion: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" });
  const datasetDir = (result: Awaited<ReturnType<typeof loadTyposquatDataset>>) => async () => result;

  it("never allows a dependency when the dataset cannot be loaded", async () => {
    for (const reason of ["dataset_missing", "dataset_invalid", "dataset_stale", "dataset_hash_mismatch"] as const) {
      const result = await checkDependency({
        manager: "npm", name: "totally-safe-package", registryHost: "registry.npmjs.org", metadataLookup: metadata, now: NOW,
        loadTyposquatDataset: datasetDir({ ok: false, ecosystem: "npm", reason, details: "test" }),
      });
      expect(result.verdict).toBe("require_approval");
      expect(result.reasons.some((entry) => entry.startsWith("typosquat_dataset_unavailable:"))).toBe(true);
    }
  });

  it("flags a typosquat when the real dataset is used", async () => {
    const result = await checkDependency({
      manager: "npm", name: "lodassh", registryHost: "registry.npmjs.org", metadataLookup: metadata, now: NOW,
      typosquatDatasetOptions: { directory: DATASET_DIRECTORY, now: NOW },
    });
    expect(result.verdict).toBe("require_approval");
    expect(result.reasons).toContain("possible_typosquat:lodash");
  });

  it("still allows an ordinary package when the dataset is present and the name is unrelated", async () => {
    const result = await checkDependency({
      manager: "npm", name: "some-quite-unique-internal-package-name", registryHost: "registry.npmjs.org", metadataLookup: metadata, now: NOW,
      typosquatDatasetOptions: { directory: DATASET_DIRECTORY, now: NOW },
    });
    expect(result.verdict).toBe("allow");
  });

  it("keeps an explicitly injected list authoritative (tests and administrator override)", async () => {
    const result = await checkDependency({
      manager: "npm", name: "lodassh", registryHost: "registry.npmjs.org", metadataLookup: metadata, now: NOW,
      policy: { ...devPolicy(), popularPackages: ["lodash"] },
    });
    expect(result.verdict).toBe("require_approval");
    expect(result.reasons).toContain("possible_typosquat:lodash");
  });
});

function devPolicy() {
  return {
    minAgeDays: 7,
    allowYoungWithApproval: false,
    allowedRegistries: ["registry.npmjs.org"],
    popularPackages: [] as string[],
    typoDistance: 2,
  };
}
