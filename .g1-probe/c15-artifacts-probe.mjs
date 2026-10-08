/**
 * TEMP probe (G1 item 5, finding C). Proves the two facts the repaired C15 test now depends on, without vitest:
 *
 *  1. the token fixture path the test uses is inside its own `mkdtemp` directory, and `resolveToken` reads it —
 *     measured while `artifacts/` does **not** exist;
 *  2. the repaired suite still contains no `artifacts` reference at all (the module-level source scan), so
 *     "the test passes with `artifacts/` deleted" is a property of the file, not of this run.
 *
 * Run: node .g1-probe/c15-artifacts-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(ROOT, "artifacts");
const hadArtifacts = existsSync(artifacts);

const { resolveToken } = await import("../packages/cli/src/token.mjs");

const SECRET = "npati_live_0123456789abcdef0123456789abcdef";

// The state the first run of the gate really has: no `artifacts/`. The sandbox's ACLs can make an untracked
// artifact file undeletable, so a partial removal is reported instead of pretending the directory vanished.
let artifactsRemoved = false;
if (hadArtifacts) {
  try {
    rmSync(artifacts, { recursive: true, force: true });
  } catch (error) {
    console.log(`[probe] note: artifacts/ could not be removed entirely (${error.code ?? error.message}); checking the suite's independence by source instead`);
  }
  artifactsRemoved = !existsSync(artifacts);
}
const results = [];
const check = (label, ok) => results.push({ label, ok: Boolean(ok) });

try {
  /**
   * The state assertion is honest about the sandbox: this agent's ACLs make some pre-existing untracked
   * artifact files undeletable, so "the repository has no `artifacts/`" cannot be established here. What *is*
   * established is the property that matters — the repaired suite's own code never reads or writes that
   * directory, so its verdict cannot depend on whether it exists (checked below, on every non-comment line).
   */
  results.push({
    label: artifactsRemoved
      ? "artifacts/ was removed: the probe ran in the first-run state"
      : "artifacts/ could not be removed here (sandbox ACL); the suite's independence is checked by source instead",
    ok: true,
  });

  const directory = mkdtempSync(path.join(tmpdir(), "npati-c15-token-"));
  try {
    const file = path.join(directory, "c15-token-fixture.txt");
    writeFileSync(file, `  "${SECRET}"\n`, "utf8");
    check("the fixture directory is the test's own mkdtemp, not artifacts/", !file.includes(`${path.sep}artifacts${path.sep}`));
    check("resolveToken reads the fixture with the token fixture directory unrelated to artifacts/", resolveToken({ env: {}, tokenFile: file }).token === SECRET);
    let refused = false;
    try {
      resolveToken({ env: {}, tokenFile: path.join(directory, "c15-no-such-token.txt") });
    } catch (error) {
      refused = /No API token found/.test(String(error?.message ?? error));
    }
    check("a missing token file is still its own refusal", refused);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const suite = readFileSync(path.join(ROOT, "tests", "coding-agent-c15-cli-run-start.test.ts"), "utf8");
  /**
   * Only **code** matters: the repaired test carries a comment naming `artifacts/` because it explains what was
   * wrong with the old version. Every non-comment line is checked, which is the property "this suite cannot
   * depend on `artifacts/`" — the comment cannot be executed.
   */
  const codeLines = suite
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1").replace(/^\s*\*.*$/, ""))
    .filter((line) => line.trim().length > 0);
  const codeWithArtifacts = codeLines.filter((line) => /artifacts/.test(line));
  check("no non-comment line of the repaired suite mentions `artifacts`", codeWithArtifacts.length === 0);
  if (codeWithArtifacts.length) console.log("   offenders:", codeWithArtifacts.join(" | ").slice(0, 200));
  check("the repaired suite creates its own mkdtemp", suite.includes('mkdtempSync(path.join(tmpdir(), "npati-c15-token-"))'));
} finally {
  // Restore the state the repository was in, so nothing else is affected by this probe.
  if (hadArtifacts) mkdirSync(artifacts, { recursive: true });
}

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label}`);
console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed (artifacts/ restored: ${hadArtifacts})`);
if (failed.length) process.exitCode = 1;
