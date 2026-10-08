#!/usr/bin/env node
/**
 * C14: the machine-readable attack catalogue and its guard — the **executable/public-surface** half.
 *
 * G1 (item 5): the implementation lives in `scripts/lib/attack-catalogue-check.mjs`, which carries **no
 * shebang**, because a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to
 * `node:vm` untransformed — which is what made a gate suite report "no tests at all" in a git worktree. A
 * module that suites import must be plain JavaScript; only an executable may start with `#!`.
 *
 * This module has no `main()` of its own: `scripts/run-security-gate.mjs` is its only caller and imports the
 * readers. The file therefore exists to keep the executable path and the shebang where the runbook documents
 * them, and re-exports the library so every existing importer of `scripts/attack-catalogue-check.mjs` keeps
 * working unchanged.
 */
export * from "./lib/attack-catalogue-check.mjs";
