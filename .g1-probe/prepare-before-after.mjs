/**
 * TEMP probe (G1 item 5, finding B): the "clean clone" state before and after the preparation phase, measured
 * in-process (the sandbox denies `child_process` stdio pipes, so the guard's reader functions are called
 * directly — they are the same functions the `--check` step uses).
 *
 * Run: node .g1-probe/prepare-before-after.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDatasets, writeDatasets } from "../scripts/lib/typosquat-dataset-generate.mjs";
import { prepareTyposquatDataset } from "../scripts/lib/run-security-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = [
  "scripts/typosquat-dataset-generate.mjs",
  "scripts/lib/typosquat-dataset-generate.mjs",
  "scripts/lib/run-security-gate.mjs",
];

const root = mkdtempSync(path.join(tmpdir(), "npati-before-after-"));
for (const file of FILES) {
  const target = path.join(root, ...file.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(path.join(ROOT, ...file.split("/"))), "utf8");
}

try {
  console.log(`clean tree: ${root}`);
  const before = checkDatasets(root);
  console.log(`\n[before] the guard's own reader on a clean clone: ${before.length} mismatch(es), all missing=${before.every((entry) => entry.missing)}`);
  console.log(`[before] verdict: ${before.length ? "RED (exit 1 is what the gate's guard step returned)" : "green"}`);

  /**
   * The gate's preparation phase calls `writeDatasets` through the generator executable, and the sandbox denies
   * that spawn (`spawn EPERM`, see `.g1-probe/stdio-probe.cjs`), so its *decision* is measured here and the
   * generation is performed with the very library function the executable calls. The escalated owner's run
   * measures the whole path.
   */
  const preparation = prepareTyposquatDataset({ root });
  console.log(`\n[after] prepareTyposquatDataset -> generated=${preparation.generated} missing=${preparation.missing.length} ok=${preparation.ok} reason=${preparation.reason ?? "none"}`);
  console.log("[after] (the sandbox denies child_process pipes, so the generator is invoked in-process here)");
  writeDatasets(root, { log: false });

  const after = checkDatasets(root);
  console.log(`[after] the same reader: ${after.length} mismatch(es) -> ${after.length === 0 ? "GREEN (--check exits 0)" : "RED"}`);

  // The bytes the preparation phase produced are the bytes the loader reads, so this is the dataset the five
  // gate suites load in a clean clone.
  const npm = JSON.parse(readFileSync(path.join(root, "data", "typosquat", "npm.json"), "utf8"));

  // The stale direction: the preparation phase must not touch an existing dataset.
  const tampered = { ...npm, packageNames: [...npm.packageNames, "left-pad-not-in-the-curated-list"] };
  writeFileSync(path.join(root, "data", "typosquat", "npm.json"), `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const stalePreparation = prepareTyposquatDataset({ root });
  const stale = checkDatasets(root);
  console.log(`\n[stale] preparation generated=${stalePreparation.generated}; reader mismatches=${stale.length} (${stale.map((entry) => entry.ecosystem).join(",")}) -> ${stale.length ? "still RED" : "unexpectedly green"}`);

  /**
   * `preparation.ok` is `false` here for one reason only: the sandbox denied the spawn. The generator itself is
   * proven independently — it ran with `--root` and produced all six files, byte-identical to the repository's
   * dataset, in `.g1-probe/gate-pieces-harness.mjs` and in the clean-clone suite. So this probe's criterion is the
   * decision, not the sandbox's spawn permission.
   */
  const ok = before.length === 6 && before.every((entry) => entry.missing)
    && preparation.generated === true && preparation.missing.length === 6
    && after.length === 0
    && stalePreparation.generated === false && stale.length === 1;
  console.log(`\n[probe] clean clone RED before (${before.length}/6 missing) -> GREEN after (${after.length} mismatches); stale stays RED: ${ok}`);
  console.log("[probe] preparation.ok=false above is the sandbox's spawn denial, not the phase's decision; the generator's own run is measured in .g1-probe/gate-pieces-harness.mjs");
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
