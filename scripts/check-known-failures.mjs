#!/usr/bin/env node
/**
 * C14 — the `known-failures` quarantine gate (owner decision 1) — the **executable** half.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/check-known-failures.mjs`, which carries **no
 * shebang**, because a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to
 * `node:vm` untransformed — which is what made a gate suite report "no tests at all" in a git worktree. A
 * module that suites import must be plain JavaScript; only an executable may start with `#!`.
 *
 * The entry-point test is passed **this** module's URL explicitly: the default parameter of `isEntryPoint` is
 * evaluated in the library that defines it, so calling it with no arguments here would compare this file's
 * path against that file's path and silently do nothing.
 *
 * Usage: node scripts/check-known-failures.mjs [--report <path>] [--json] [--artifact <path>] [--adopt …]
 */
export * from "./lib/check-known-failures.mjs";
export { main } from "./lib/check-known-failures.mjs";
import { isEntryPoint, main } from "./lib/check-known-failures.mjs";

if (isEntryPoint(process.argv, import.meta.url)) process.exit(main(process.argv.slice(2)));
