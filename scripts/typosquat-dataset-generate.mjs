#!/usr/bin/env node
/**
 * C4a: regenerates the curated typosquat datasets in `data/typosquat/` — the **executable** half.
 *
 * G1 (item 5, finding A): the curated lists, the canonical hash and the readers/writers live in
 * `scripts/lib/typosquat-dataset-generate.mjs`, which carries **no shebang**: a `#!/usr/bin/env node` first line
 * is a syntax error when a bundler hands the module to `node:vm` untransformed. A module that suites import must
 * be plain JavaScript; only an executable may start with `#!`.
 *
 * G1 (item 5, finding B): `--root <dir>` (or `NPATI_TYPOSQUAT_ROOT`) selects the tree to generate for, which is
 * what lets the gate prepare a **clean clone** and lets the clean-clone suite prepare a temp tree without writing
 * into this checkout. Without either, the repository this script lives in is generated, exactly as before.
 *
 * The CLI body is a function called **only** when this file is the entry point: an executable that wrote files as
 * a side effect of being imported would make every importer a writer.
 *
 * Usage: node scripts/typosquat-dataset-generate.mjs [--check] [--root <dir>]
 */
export * from "./lib/typosquat-dataset-generate.mjs";
import { checkDatasets, resolveRoot, writeDatasets } from "./lib/typosquat-dataset-generate.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function main(argv = process.argv.slice(2)) {
  const root = resolveRoot(argv);
  if (argv.includes("--check")) {
    const mismatches = checkDatasets(root);
    for (const mismatch of mismatches) {
      console.error(`[typosquat] ${mismatch.ecosystem}: ${mismatch.missing ? "dataset is missing" : "dataset is stale"}`);
    }
    if (mismatches.length) return 1;
    console.log("[typosquat] datasets are up to date");
    return 0;
  }
  writeDatasets(root);
  return 0;
}

const invoked = process.argv[1];
if (invoked && path.resolve(invoked).replace(/\\/g, "/").toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()) {
  process.exit(main());
}
