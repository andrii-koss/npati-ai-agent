#!/usr/bin/env node
/**
 * C7: web-source XSS invariant — the **executable** half of the scan.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/scan-web-xss.mjs`, which carries **no shebang**,
 * because a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm`
 * untransformed — which is what made a gate suite report "no tests at all" in a git worktree. A module that
 * suites import must be plain JavaScript; only an executable may start with `#!`.
 *
 * Usage: `node scripts/scan-web-xss.mjs [--json]` (exit 1 with `file:line: rule` lines when it finds one).
 */
export * from "./lib/scan-web-xss.mjs";
export { main } from "./lib/scan-web-xss.mjs";
import { main } from "./lib/scan-web-xss.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const invoked = process.argv[1];
if (invoked && path.resolve(invoked).replace(/\\/g, "/").toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()) {
  process.exit(main(process.argv.slice(2)));
}
