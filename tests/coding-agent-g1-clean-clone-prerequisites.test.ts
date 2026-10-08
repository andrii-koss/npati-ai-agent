import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TYPOSQUAT_ECOSYSTEMS, typosquatDatasetHash } from "../apps/agent-api/src/code-typosquat-dataset";
import { SECURITY_GATE_TESTS, prepareTyposquatDataset } from "../scripts/lib/run-security-gate.mjs";

/**
 * G1 (item 5, finding B): **the gate's prerequisites are reproducible on a clean clone**.
 *
 * The defect this suite pins: `data/` is in `.gitignore`, `npm ci` does not create it, and the only writer of
 * `data/typosquat/*.json` — `scripts/typosquat-dataset-generate.mjs` without `--check` — was called from
 * nowhere. Five gate suites load that dataset and the gate's own `typosquat dataset guard` step runs with
 * `--check`, so on a truly clean checkout the **mandatory** `security-gate` job could not go green at all.
 *
 * What is pinned here:
 *
 *  1. the generator really writes the curated dataset into **the tree it is told about** (a temp tree that has no
 *     `data/` at all is the clean-clone state), and the gate's preparation phase reports that tree as complete
 *     afterwards — so a fresh clone is one preparation phase away from a green guard step;
 *  2. the preparation phase **does not touch the checkout it lives in** while it prepares another tree, which is
 *     what makes a temp-tree preparation a measurement rather than a side effect;
 *  3. the preparation is sided: with the dataset present it generates nothing and leaves the decision to the
 *     `--check` guard, and a dataset that exists but disagrees with the generator stays **RED**. Generation
 *     removes "missing"; it never repairs "stale";
 *  4. a tree without the generator is reported as a **failure with a reason**, not as a green run over an absent
 *     dataset — the fail-closed direction of the same code path.
 *
 * Scope, stated plainly: this suite proves **the preparation phase and the generator's root handling**, which is
 * what has to happen before the gate's suites and before its `--check` guard. It does not run the whole gate in a
 * temp tree (that would be a second full gate run per test); the temp tree is therefore a copy of the files the
 * preparation phase executes, not a `git clone`, and its other prerequisites (`node_modules`, `apps/**`) are not
 * reproduced. The whole gate is run by the owner's escalated run.
 */

/** The files the preparation phase executes: the generator library, its executable, and the library calling it. */
const PREPARATION_FILES = [
  "scripts/typosquat-dataset-generate.mjs",
  "scripts/lib/typosquat-dataset-generate.mjs",
  "scripts/lib/run-security-gate.mjs",
];
const GENERATOR_PATH = "scripts/typosquat-dataset-generate.mjs";
const GATE_WRAPPER_PATH = "scripts/run-security-gate.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_FILES = TYPOSQUAT_ECOSYSTEMS.map((ecosystem) => `${ecosystem}.json`);

/** A copy of the tree that has no `data/` — the state of a fresh clone for every ignored path. */
function cleanTree(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `npati-clean-${label}-`));
  for (const file of PREPARATION_FILES) {
    const target = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(workspaceRoot, ...file.split("/"))), "utf8");
  }
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Runs the generator exactly as the runbook does (`node scripts/typosquat-dataset-generate.mjs`). Its stdio is
 * inherited rather than captured on purpose: a sandbox that denies `child_process` pipes would otherwise turn
 * "the generator ran" into a spawn error, and this suite must measure the dataset, not the harness.
 */
function generate(root: string): number | null {
  const generator = path.join(root, ...GENERATOR_PATH.split("/"));
  const result = spawnSync(process.execPath, [generator, "--root", root], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  return result.status;
}

/** Runs the generator exactly as the gate's `typosquat dataset guard` step does, against a named root. */
function runCheck(root: string): { status: number | null; output: string } {
  const generator = path.join(root, ...GENERATOR_PATH.split("/"));
  const result = spawnSync(process.execPath, [generator, "--check", "--root", root], { cwd: root, shell: false, encoding: "utf8", env: process.env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** The contents of the repository's own dataset, so the temp tree can be compared against the real bytes. */
function repositoryDatasetFingerprint(): string {
  const directory = path.join(workspaceRoot, "data", "typosquat");
  const hash = createHash("sha256");
  for (const name of DATASET_FILES) {
    const file = path.join(directory, name);
    if (!existsSync(file)) throw new Error(`the repository has no data/typosquat/${name}: this suite compares a generated dataset with the real one, so it cannot run without it (run the preparation phase first)`);
    hash.update(readFileSync(file, "utf8"));
  }
  return hash.digest("hex");
}

describe("security-gate: G1 — a clean clone has its gate prerequisites reproduced", () => {
  it("the clean-clone suite is registered in the gate's fixed list", () => {
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-g1-clean-clone-prerequisites.test.ts");
  });

  it("the generator produces the real dataset for the tree it is told about, and the gate reads that tree as complete", () => {
    const root = cleanTree("generate");
    try {
      // The clean-clone state, asserted rather than assumed: nothing under `data/` exists.
      expect(existsSync(path.join(root, "data"))).toBe(false);

      // Non-vacuity of the preparation phase itself: before the generator runs, the phase reports every
      // ecosystem as missing (that is the state it repairs), and after the generator has run it reports the
      // tree as complete and generates nothing.
      const before = prepareTyposquatDataset({ root });
      expect(before.generated).toBe(true);
      expect([...before.missing].sort()).toEqual([...TYPOSQUAT_ECOSYSTEMS].sort());

      expect(generate(root)).toBe(0);

      const after = prepareTyposquatDataset({ root });
      expect(after.ok, after.reason ?? "").toBe(true);
      expect(after.generated).toBe(false);
      expect(after.missing).toEqual([]);

      for (const ecosystem of TYPOSQUAT_ECOSYSTEMS) {
        const file = path.join(root, "data", "typosquat", `${ecosystem}.json`);
        expect(existsSync(file), `${ecosystem}: the generator produced no file`).toBe(true);
        const dataset = JSON.parse(readFileSync(file, "utf8"));
        expect(dataset.schemaVersion).toBe(1);
        expect(dataset.ecosystem).toBe(ecosystem);
        expect(dataset.source.kind).toBe("curated");
        expect(dataset.source.references.length).toBeGreaterThan(0);
        expect(dataset.packageNames.length).toBeGreaterThanOrEqual(40);
        expect(new Set(dataset.packageNames).size).toBe(dataset.packageNames.length);
        // The hash is derived from the names by the canonical function the loader uses, so a generated file
        // that the loader would refuse as tampered cannot pass here.
        expect(dataset.hash).toBe(typosquatDatasetHash(dataset.packageNames));
      }

      // ...and the tree the gate actually judges is byte-identical to this repository's own dataset, which is
      // why a clean clone's gate run is green: the guard step below compares exactly these bytes.
      const generated = createHash("sha256");
      for (const name of DATASET_FILES) generated.update(readFileSync(path.join(root, "data", "typosquat", name), "utf8"));
      expect(generated.digest("hex")).toBe(repositoryDatasetFingerprint());

      const guard = runCheck(root);
      expect(guard.output).toContain("datasets are up to date");
      expect(guard.status).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("preparing another tree does not write into this checkout, and a stale dataset is never repaired", () => {
    /**
     * The non-vacuity of a temp-tree preparation: a generator that derived its target from its own file location
     * would still report success here while quietly writing into the repository. The repository's own dataset is
     * fingerprinted across the whole test, and the stale direction is checked against the `--check` guard.
     */
    const before = repositoryDatasetFingerprint();
    const root = cleanTree("sided");
    try {
      expect(existsSync(path.join(root, "data"))).toBe(false);
      expect(generate(root)).toBe(0);

      // A second pass finds a complete dataset: it generates nothing, so a *stale* dataset is never silently
      // rewritten into agreement with the generator (the guard is the only thing that judges it).
      const again = prepareTyposquatDataset({ root });
      expect(again.generated).toBe(false);
      expect(again.ok).toBe(true);

      const staleFile = path.join(root, "data", "typosquat", "npm.json");
      const stale = JSON.parse(readFileSync(staleFile, "utf8"));
      stale.packageNames = [...stale.packageNames, "left-pad-not-in-the-curated-list"];
      writeFileSync(staleFile, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

      const staleState = prepareTyposquatDataset({ root });
      expect(staleState.generated).toBe(false);
      expect(staleState.ok).toBe(true);

      const guard = runCheck(root);
      expect(guard.output).toContain("npm: dataset is stale");
      expect(guard.status).toBe(1);

      expect(repositoryDatasetFingerprint()).toBe(before);
    } finally {
      cleanup(root);
    }
  });

  it("a tree without the generator is reported as a failure with a reason, not as a green run", () => {
    const root = cleanTree("missing-generator");
    try {
      rmSync(path.join(root, ...GENERATOR_PATH.split("/")), { force: true });
      const preparation = prepareTyposquatDataset({ root });
      expect(preparation.ok).toBe(false);
      expect(preparation.generated).toBe(false);
      expect(preparation.reason).toContain(GENERATOR_PATH);
    } finally {
      cleanup(root);
    }
  });

  it("the gate's executable is where the runbook and `package.json` say it is, and the library owns the phase", () => {
    // The runbook, `npm run security-gate`, CI and this suite's own reasoning all name the wrapper. It must stay
    // an executable with a shebang (it is what a shell and `npm` invoke) while the library stays shebang-free —
    // that split is the whole point of item 5.
    const wrapper = readFileSync(path.join(workspaceRoot, GATE_WRAPPER_PATH), "utf8");
    expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    const library = readFileSync(path.join(workspaceRoot, "scripts", "lib", "run-security-gate.mjs"), "utf8");
    expect(library.startsWith("#!")).toBe(false);
    expect(library).toContain("export function prepareTyposquatDataset(");
    // The preparation phase and the guard step must name the same generator with the same root handling: two
    // spellings would be a gate that prepares one dataset and checks another.
    expect(library).toContain('const TYPOSQUAT_GENERATOR_PATH = "scripts/typosquat-dataset-generate.mjs";');
    expect(library).toContain('[generator, "--root", root]');
    expect(library).toContain('runStep("typosquat dataset guard", TYPOSQUAT_GENERATOR_PATH, ["--check"])');
  });
});
