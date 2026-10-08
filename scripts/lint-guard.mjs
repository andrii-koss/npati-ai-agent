#!/usr/bin/env node
/**
 * C14: `npm run lint` — the repository's source-invariant lint gate — the **executable** half.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/lint-guard.mjs`, which carries **no shebang**, because
 * a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm`
 * untransformed — which is what made a gate suite report "no tests at all" in a git worktree. A module that
 * suites import must be plain JavaScript; only an executable may start with `#!`.
 *
 * Usage: node scripts/lint-guard.mjs [--json] [--root <dir>] [--update-baseline]
 */
export * from "./lib/lint-guard.mjs";
export { main } from "./lib/lint-guard.mjs";
import { main } from "./lib/lint-guard.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).replace(/\\/g, "/").toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (isMain) process.exit(main());
