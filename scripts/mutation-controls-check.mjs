#!/usr/bin/env node
/**
 * G1 item 3: the mutation matrix and its guard — the **executable** half.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/mutation-controls-check.mjs`, which carries **no
 * shebang**, because a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to
 * `node:vm` untransformed — which is what made a gate suite report "no tests at all" in a git worktree. A
 * module that suites import must be plain JavaScript; only an executable may start with `#!`.
 *
 * Usage: node scripts/mutation-controls-check.mjs [--root <dir>] [--matrix <path>]
 */
export * from "./lib/mutation-controls-check.mjs";
export { main } from "./lib/mutation-controls-check.mjs";
import { main } from "./lib/mutation-controls-check.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const invoked = process.argv[1];
if (invoked && path.resolve(invoked).replace(/\\/g, "/").toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()) {
  process.exit(main());
}
