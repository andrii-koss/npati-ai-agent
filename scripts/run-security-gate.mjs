#!/usr/bin/env node
/**
 * C4a: the mandatory `security-gate` job (SG-1) — the **executable** half of the gate.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/run-security-gate.mjs`, which carries **no shebang**.
 * This file used to be that implementation, and its `#!/usr/bin/env node` first line was the defect: outside
 * the repository's own layout (a git worktree, a copy of the tree) Vite did not transform the imported module
 * and handed the raw text to `node:vm`, where a shebang is a syntax error — so eight gate suites reported
 * "no tests at all" and 109 tests ran nowhere but here. A library module that suites import must be plain
 * JavaScript; only an executable may start with `#!`.
 *
 * What stays here: the shebang, the entry-point decision (with **this** file's `import.meta.url`, because the
 * default parameter of `isEntryPoint` is evaluated in the module that defines it) and the public export
 * surface, so `package.json` (`security-gate`, `security-gate:db`), CI and every existing importer keep
 * working unchanged.
 *
 * Usage: node scripts/run-security-gate.mjs [--list] [--db]
 */
export * from "./lib/run-security-gate.mjs";
export { main } from "./lib/run-security-gate.mjs";
import { isEntryPoint, main } from "./lib/run-security-gate.mjs";

if (isEntryPoint(process.argv, import.meta.url)) process.exit(main());
