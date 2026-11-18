/**
 * G1 item 3 (PLAN.md): the **decoy branch** — proof that the real security gate goes red when a guard is
 * removed from the code, and stays green when a line that controls nothing is changed.
 *
 * G1 (item 5): this file carries **no shebang** on purpose. It is imported as a module by
 * `tests/coding-agent-c14-mutation-branch-controls.test.ts`, which pins its verdict reader, and a
 * `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm` untransformed —
 * the mechanism that made the gate suites importing `scripts/lib/*.mjs` report "no tests at all" in a git
 * worktree. Nothing needs the shebang here: `package.json` (`mutation:branch`) and the runbook below both invoke
 * this file as `node scripts/security-gate-mutation-branch.mjs`, never as `./scripts/…`.
 *
 * Why this exists next to `tests/coding-agent-c14-gate-mutation-sensitivity.test.ts`: that suite neutralises
 * five guards **in memory**. It proves each guard is load-bearing *in the seam it exposes*, and it is a real
 * proof — but it never runs the gate, so it cannot answer "would `npm run security-gate` fail if this
 * protection were deleted from the source?". Those are two different claims, and the acceptance criterion of
 * G1 asks for the second one. A decoy branch mutates a file on disk, which also means the workspace-relative
 * path guard (`normalizeWorkspacePath`), which has **no** injection seam, becomes mutation-testable for the
 * first time.
 *
 * The protocol, per row of `security-gate/mutation-controls.json`:
 *
 *   1. `git worktree add --detach <tmp> HEAD` — an isolated checkout. The user's working tree is never edited,
 *      and the worktree lives outside the repository, so `git status` cannot be dirtied by a crash.
 *   2. **Mirror the current state** into it: `git diff --name-status HEAD` says which tracked files differ
 *      (this repository's in-flight G1 work is uncommitted, and a mutation proof against HEAD would be a proof
 *      about code that is not under review), and `git ls-files --others --exclude-standard` adds the untracked
 *      files a gate run needs — the new suites and the matrix itself. Files are **copied**, not patched, so
 *      line endings and bytes are identical to the tree under review.
 *   3. Mirror the **gitignored resources the gate really reads** (`GATE_IGNORED_RESOURCES`). `git diff` and
 *      `git ls-files --others` are blind to `.gitignore`d paths, so a mirror built from them alone is *not*
 *      the tree under review for a gate whose suites read `data/typosquat/**` or write into `artifacts/**`.
 *      The first escalated run of this script proved that the hard way: five suite tests and the gate's own
 *      `typosquat dataset guard` step were red **before any mutation**, which is exactly the confound this
 *      step removes. A declared resource that is absent in the tree under review is created as an **empty**
 *      directory, because that is what the gate's own artifact writer produces on a real run.
 *   4. `node_modules` is a directory junction to the real one (a worktree has none, and `npm ci` per run would
 *      make this step minutes slower for no extra evidence), and every `.gitmodules` path that is checked out in
 *      the tree under review is junctioned the same way: `git worktree add` does **not** materialise submodules,
 *      so without this the worktree would silently be a different tree from the one being judged.
 *   5. **Run the real gate once with no mutation at all** and keep its failures as the *baseline*. This is the
 *      step that makes the rest a proof instead of a correlation: a gate that is already red — for a missing
 *      fixture, a stale dataset, a load error — turns *every* mutation red and would be read as sensitivity.
 *      A baseline that is not green is reported loudly and ends the run as `inconclusive` (exit `3`); no row is
 *      allowed to claim `caught`.
 *   6. Apply exactly **one** mutation (`renderMutation` — the same pure function the gate's guard validates) and
 *      run the gate again. A decoy row must exit non-zero **and** the test the row declares must be among the
 *      failures **that the baseline did not already have**; a cosmetic row must add no failure of its own.
 *   7. Remove the junction, `git worktree remove --force`, `git worktree prune`, and assert the post-conditions:
 *      the worktree is gone, `git worktree list` is back to its previous content, `git status` is byte-identical
 *      to the snapshot taken before the run, and the real `node_modules` is intact.
 *
 * The honesty rule that matters most: a gate run that **could not measure** (vitest failed to start, the spawn
 * was denied, the run timed out) is classified `environment` and the script exits `3` (inconclusive). It is
 * never rounded up to "the mutation was caught" — an environment failure makes the gate exit non-zero too, and
 * reading that as sensitivity is exactly the optimistic result this project has been burned by. A red baseline
 * is the second half of the same rule: the run measured, but measured the *environment*, not the mutation.
 *
 * Usage:
 *   node scripts/security-gate-mutation-branch.mjs [--only <row-id>]... [--dry-run] [--keep] [--json]
 *                                                 [--worktree-dir <path>] [--timeout <ms>]
 *
 * Exit codes: 0 = every selected row behaved as the matrix declares; 1 = the proof FAILED (a real finding: a
 * decoy was not caught, or a cosmetic change went red); 3 = inconclusive, the environment could not run the
 * gate or the worktree baseline was already red. The verdict is also written to
 * `artifacts/security-gate-mutation-branch.json` (evidence; a write failure is reported and never changes the
 * verdict).
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MUTATION_CONTROLS_PATH,
  loadMutationControls,
  renderMutation,
  validateMutationControls,
} from "./lib/mutation-controls-check.mjs";
import { SECURITY_GATE_TESTS } from "./lib/run-security-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the run leaves its durable verdict, relative to the repository root the script was started from. */
export const MUTATION_ARTIFACT_PATH = "artifacts/security-gate-mutation-branch.json";

/** The directory both the verdict and the gate transcripts are written into. */
export const MUTATION_EVIDENCE_DIRECTORY = "artifacts";

/**
 * Where one gate run's **complete** transcript is kept: `artifacts/security-gate-mutation-branch.<label>.log`.
 *
 * The first escalated run proved why this file has to exist. The artifact used to keep only the last 25 lines of
 * the gate's output, and the lines that answer "why did this test fail?" — `suite files: present=…`, `FAILED: N
 * suite(s) reported no tests at all`, `missing:`, and the message under each `FAILED TEST:` — are printed
 * *earlier* than any of that. The evidence therefore truncated exactly the part a verdict has to be diagnosable
 * from, which is how a `wrong_test` and an `unexpected_failure` ended up with no cause attached to them.
 *
 * The label is reduced to a filename-safe token, so a row id can never write outside this directory.
 */
export function mutationTranscriptPath(label) {
  const safe = String(label ?? "run").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "") || "run";
  return `${MUTATION_EVIDENCE_DIRECTORY}/security-gate-mutation-branch.${safe}.log`;
}

/** Writes a gate transcript verbatim. Returns `{ ok, path, bytes, error }` and never throws (it is evidence). */
export function writeGateTranscript(root, label, transcript) {
  const relativePath = mutationTranscriptPath(label);
  const text = String(transcript ?? "");
  try {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    return { ok: true, path: relativePath, bytes: Buffer.byteLength(text, "utf8"), error: null };
  } catch (error) {
    return { ok: false, path: relativePath, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The gate's own sentence that proves vitest really ran and reported numbers. */
const GATE_TESTS_LINE = /^\[security-gate\] tests: passed=(\d+) failed=(\d+) skipped=(\d+) todo=(\d+)\s*$/m;

/** `[security-gate] FAILED TEST: <suite> > <title>`. */
const GATE_FAILED_TEST_LINE = /^\[security-gate\] FAILED TEST: (.+)$/gm;

/** Reads the gate's vitest totals out of its transcript: the sentinel that a measurement happened at all. */
export function parseGateTranscript(transcript) {
  const text = String(transcript ?? "");
  const totals = GATE_TESTS_LINE.exec(text);
  const failedTests = [];
  for (const match of text.matchAll(GATE_FAILED_TEST_LINE)) {
    const line = String(match[1] ?? "").trim();
    const separator = line.indexOf(" > ");
    if (separator < 0) continue;
    failedTests.push({ file: normalizeSuite(line.slice(0, separator)), title: line.slice(separator + 3) });
  }
  return {
    measured: totals !== null,
    tests: totals
      ? { passed: Number(totals[1]), failed: Number(totals[2]), skipped: Number(totals[3]), todo: Number(totals[4]) }
      : null,
    failedTests,
    verdict: /^\[security-gate\] PASSED\s*$/m.test(text) ? "PASSED" : /^\[security-gate\] FAILED\s*$/m.test(text) ? "FAILED" : null,
    /** Everything the gate said about its own inability to start a step, so an environment failure is nameable. */
    environmentLines: text
      .split(/\r?\n/)
      .filter((line) => /FAILED to start|EPERM|ENOENT|timed out|spawn/i.test(line))
      .slice(0, 8),
  };
}

/** Repository-relative of a suite path, the way the gate and the catalogue both normalise it. */
export function normalizeSuite(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const index = normalized.indexOf("tests/");
  return index >= 0 ? normalized.slice(index) : normalized;
}

/**
 * The message lines the gate printed under a `FAILED TEST:` line.
 *
 * `formatFailedTests` indents each message line with five spaces after the `[security-gate]` prefix, so the
 * boundary between two failures is a line that does not carry that indent. The first escalated run of this
 * script recorded only the *tail* of the gate's transcript, which is why "the declared test did not fail" had
 * no cause attached to it: the reason a test failed (a missing `data/typosquat/npm.json`, an unwritable
 * `artifacts/`) was printed hundreds of lines earlier and thrown away. This reader keeps a bounded excerpt of
 * exactly those messages, keyed by the failure they belong to.
 *
 * It is bounded on purpose — this is evidence for a report, not a log; the **complete** transcript of every run
 * is written next to the verdict (`mutationTranscriptPath`) and is never truncated. The bounds here are the
 * gate's own (it prints at most 12 message lines per failure), so a real run loses nothing.
 */
export function parseFailureMessages(transcript, options = {}) {
  const maxPerTest = Number.isFinite(options.maxPerTest) ? Number(options.maxPerTest) : 12;
  const maxTests = Number.isFinite(options.maxTests) ? Number(options.maxTests) : 40;
  const lines = String(transcript ?? "").split(/\r?\n/);
  const messages = [];
  let current = null;
  for (const line of lines) {
    const failed = /^\[security-gate\] FAILED TEST: (.+)$/.exec(line);
    if (failed) {
      const text = String(failed[1] ?? "").trim();
      const separator = text.indexOf(" > ");
      // A failure whose shape the gate did not produce is skipped rather than guessed at, exactly the way
      // `parseGateTranscript` refuses to invent a suite for it.
      current = separator < 0 ? null : { file: normalizeSuite(text.slice(0, separator)), title: text.slice(separator + 3), message: [] };
      if (current && messages.length < maxTests) messages.push(current);
      else current = null;
      continue;
    }
    if (!current || current.message.length >= maxPerTest) continue;
    const detail = /^\[security-gate\]\s{4,}(.*)$/.exec(line);
    if (detail) current.message.push(String(detail[1] ?? "").trim());
  }
  return messages;
}

/**
 * Does a matrix title name a test that the gate reported as failed?
 *
 * The two sides do not use the same string and never did: the matrix stores the bare `it("…")` title — which is
 * what `itTitlesIn` reads out of the suite, and what `validateMutationControls` resolves — while the gate reports
 * the **flattened chain** `describe > … > it`. `security-gate-mutation-branch.mjs`'s first escalated run
 * classified a genuinely caught mutation as `wrong_test` for exactly that reason, so the comparison is the one
 * thing here that must be forgiven: the declared title has to match a **complete trailing chain** of the
 * failure's segments (`observed === expected`, or `observed` ends with `" > " + expected`).
 *
 * It stays strict in the direction that matters: a title nobody wrote, a title from another suite, or a test
 * that merely *contains* the declared text (`"… > the guard refuses X, loudly"` vs `"refuses X"`) does not
 * match, so "the named test did not fail" is still a reportable finding.
 */
export function failureTitleMatches(observedTitle, expectedTitle) {
  const observed = String(observedTitle ?? "").trim();
  const expected = String(expectedTitle ?? "").trim();
  if (!expected || !observed) return false;
  return observed === expected || observed.endsWith(` > ${expected}`);
}

/** The gate's durable verdict artifact, read from the worktree root it was written into. */
export function readGateArtifact(worktree) {
  const file = path.join(worktree, "artifacts", "security-gate-report.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The failing tests of a gate artifact's `failedTests` (`"<suite> > <title>"` strings). */
export function failedTestsFromArtifact(artifact) {
  const entries = Array.isArray(artifact?.failedTests) ? artifact.failedTests : [];
  const out = [];
  for (const entry of entries) {
    const line = String(entry ?? "");
    const separator = line.indexOf(" > ");
    if (separator < 0) continue;
    out.push({ file: normalizeSuite(line.slice(0, separator)), title: line.slice(separator + 3) });
  }
  return out;
}

/**
 * The gate's own lines about **which suites ran** — present/missing files, suites that did not run, suites that
 * reported no tests at all.
 *
 * This is the one part of the gate's transcript that a verdict cannot be inferred from but a *diff* can: a
 * worktree that silently runs fewer tests than the tree under review produces a smaller total with no failing
 * test to point at, and the first escalated run of this script showed exactly that (2029 tests in the worktree
 * against 2124 in the repository, with only six named failures). Without these lines an operator sees a total
 * and has to guess which suites it came from.
 *
 * Returned whole, deliberately: the section is bounded by the gate's own suite list (one line per suite at
 * most), and the whole point is that the part a verdict is diagnosed from must not be truncated.
 */
export function parseSuiteLines(transcript) {
  const pattern =
    /^\[security-gate\] (?:suite files:|FAILED: \d+ configured suite file\(s\)| {2}missing file:|FAILED: \d+ configured suite\(s\) did not run| {2}missing:|FAILED: \d+ suite\(s\) reported no tests at all| {2}empty:|vitest run \()/;
  return String(transcript ?? "")
    .split(/\r?\n/)
    .filter((line) => pattern.test(line));
}

/**
 * Is this value already an observation produced by `observeGateRun`?
 *
 * The distinction matters because `classifyGateRun` accepts the baseline as an *observation* (the runner parses
 * a gate run once and passes the result to every row). Re-reading an observation would find no `transcript` on
 * it and report `measured: false` — which would turn a perfectly good green baseline into "the baseline gate
 * could not measure", i.e. every row `baseline_red`. The mutation-branch suite runs this exact path, which is
 * how that was found before the escalated run had to.
 */
export function isGateRunObservation(value) {
  return Boolean(value) && typeof value === "object" && typeof value.measured === "boolean" && Array.isArray(value.failedTests) && Array.isArray(value.observed);
}

/**
 * One gate run as an observation: what it exited with, whether it measured, and which tests it reported as
 * failed. Both the baseline and every row go through this reader, so "the failures of the baseline" and "the
 * failures of a mutated run" are the same measurement and can be subtracted from one another.
 *
 * Idempotent: a value that already is an observation is returned unchanged rather than re-read.
 */
export function observeGateRun(input) {
  if (isGateRunObservation(input)) return input;
  const transcript = parseGateTranscript(input?.transcript);
  const artifact = input?.artifact ?? null;
  const artifactTests = artifact?.tests ?? null;
  /**
   * "Measured" means vitest really reported a number. `typeof === "number"` and not `Number(...)`: the gate
   * writes `tests: { passed: null, … }` into its artifact when vitest never started, and `Number(null)` is `0`,
   * which would have turned "the gate could not run" into "the gate measured and failed" — the exact optimistic
   * reading this script exists to prevent.
   */
  const artifactMeasured = typeof artifactTests?.passed === "number" && Number.isFinite(artifactTests.passed);
  const failedTests = [
    ...transcript.failedTests,
    ...failedTestsFromArtifact(artifact),
  ].filter((entry, index, all) => all.findIndex((other) => other.file === entry.file && other.title === entry.title) === index);
  return {
    status: input?.status ?? null,
    signal: input?.signal ?? null,
    spawnError: input?.spawnError ?? null,
    measured: transcript.measured || artifactMeasured,
    tests: transcript.tests ?? (artifactMeasured ? { passed: artifactTests.passed, failed: artifactTests.failed, skipped: artifactTests.skipped, todo: artifactTests.todo } : null),
    failedTests,
    observed: failedTests.map((entry) => `${entry.file} > ${entry.title}`),
    verdict: transcript.verdict,
    environmentLines: transcript.environmentLines,
    suiteLines: parseSuiteLines(input?.transcript),
    failureMessages: parseFailureMessages(input?.transcript),
  };
}

/** The reason a baseline is not usable as a reference point, or `null` when it is green. */
export function baselineProblem(baseline) {
  if (!baseline) return null;
  if (baseline.spawnError) return `the baseline gate could not be spawned: ${baseline.spawnError}`;
  if (baseline.status === null || baseline.status === undefined) return "the baseline gate did not return an exit code";
  if (baseline.signal) return `the baseline gate was terminated by signal ${baseline.signal}`;
  if (!baseline.measured) {
    const detail = baseline.environmentLines?.length ? ` (${baseline.environmentLines.join(" | ")})` : "";
    return `the baseline gate ran but vitest never reported a measurement, so "already red" cannot be told from "could not run"${detail}`;
  }
  if (baseline.status !== 0 || baseline.failedTests.length > 0) {
    const listed = baseline.observed.slice(0, 8).join("; ");
    return `the gate is red BEFORE any mutation (baseline exit ${baseline.status}${baseline.failedTests.length ? `, ${baseline.failedTests.length} failing: ${listed}` : ""}), so a red mutated run cannot be attributed to the mutation`;
  }
  return null;
}

/**
 * The verdict of one gate run, as a pure function of what was observed.
 *
 * `decoy` rows must end `caught`: a non-zero exit **and** the declared test among the failures. `cosmetic` rows
 * must end `ok`: a zero exit with vitest having really measured.
 *
 * Any run whose transcript carries no `tests:` line did not measure anything; it is `environment`, never
 * `caught`, whatever its exit code says. That single rule is what keeps this script from reporting sensitivity
 * it did not observe.
 *
 * `baseline` is the observation of the same gate run with **no mutation applied** (`observeGateRun`). When it is
 * supplied and not green, every row is `baseline_red`: the run measured the *environment* rather than the
 * mutation, so the failures are named (and `newFailures` still separates the mutation's own failures from the
 * pre-existing ones for the reader) but no row is allowed to claim `caught`, `wrong_test` or `ok`.
 */
export function classifyGateRun(input) {
  const kind = input?.kind;
  const expectedGateExit = input?.expectedGateExit;
  const expectedSuite = typeof input?.expectedFailingSuite === "string" ? normalizeSuite(input.expectedFailingSuite) : null;
  const expectedTest = typeof input?.expectedFailingTest === "string" && input.expectedFailingTest ? input.expectedFailingTest : null;
  const observedRun = observeGateRun(input);
  const status = observedRun.status;
  const baseline = input?.baseline ? observeGateRun(input.baseline) : null;
  /** The failures this run has that the baseline did not: the only failures a mutation may be credited with. */
  const baselineKeys = new Set((baseline?.failedTests ?? []).map((entry) => `${entry.file} > ${entry.title}`));
  const newFailures = observedRun.failedTests.filter((entry) => !baselineKeys.has(`${entry.file} > ${entry.title}`));
  const preExistingFailures = observedRun.failedTests.filter((entry) => baselineKeys.has(`${entry.file} > ${entry.title}`));
  const base = {
    measured: observedRun.measured,
    tests: observedRun.tests,
    failedTests: observedRun.failedTests,
    observed: observedRun.observed,
    newFailures: newFailures.map((entry) => `${entry.file} > ${entry.title}`),
    preExistingFailures: preExistingFailures.map((entry) => `${entry.file} > ${entry.title}`),
    suiteLines: observedRun.suiteLines,
    exitCode: status,
    expectedGateExit,
  };

  if (observedRun.spawnError) return { ...base, verdict: "environment", reason: `the gate could not be spawned: ${observedRun.spawnError}` };
  if (status === null || status === undefined) return { ...base, verdict: "environment", reason: "the gate did not return an exit code" };
  if (observedRun.signal) return { ...base, verdict: "environment", reason: `the gate was terminated by signal ${observedRun.signal}` };
  if (!observedRun.measured) {
    const detail = observedRun.environmentLines.length ? ` (${observedRun.environmentLines.join(" | ")})` : "";
    return {
      ...base,
      verdict: "environment",
      reason: `the gate ran but vitest never reported a measurement, so its exit code ${status} says nothing about the mutation${detail}`,
    };
  }
  const problem = baselineProblem(baseline);
  if (problem) {
    /**
     * The baseline is the only reference point that can tell "the mutation caused this" from "this was already
     * broken", and it is red here, so the run's honest verdict is `inconclusive` — the rows still record their
     * own `newFailures`, but none of them is allowed to claim `caught`, `wrong_test` or `ok`. Naming the declared
     * test when it is already among the baseline failures is the one piece of diagnosis this state can still
     * give: it says whether the suite covers the guard at all, as opposed to whether the environment works.
     */
    const declaredAlreadyRed = Boolean(
      expectedSuite && expectedTest && baseline.failedTests.some((entry) => entry.file === expectedSuite && failureTitleMatches(entry.title, expectedTest)),
    );
    const note = declaredAlreadyRed
      ? `; note: the declared test ${expectedSuite} > ${expectedTest} is already among the baseline failures, so it exists and is red before the mutation`
      : "";
    return {
      ...base,
      verdict: "baseline_red",
      reason: `${problem}; this row's own new failures are listed separately and no verdict is claimed from them${note}`,
    };
  }

  if (kind === "cosmetic") {
    if (status === 0 && newFailures.length === 0) return { ...base, verdict: "ok", reason: "the gate stayed green on a change that controls nothing" };
    return {
      ...base,
      verdict: "unexpected_failure",
      reason: `a cosmetic change made the gate red (exit ${status}${newFailures.length ? `; failing: ${newFailures.map((entry) => `${entry.file} > ${entry.title}`).slice(0, 5).join("; ")}` : ""})`,
    };
  }

  if (status === 0) {
    return { ...base, verdict: "not_caught", reason: "the gate exited 0 on a weakened guard, so this suite does not catch that mutation" };
  }
  if (expectedSuite && expectedTest) {
    const matched = newFailures.some((entry) => entry.file === expectedSuite && failureTitleMatches(entry.title, expectedTest));
    if (matched) return { ...base, verdict: "caught", reason: `the declared test failed: ${expectedSuite} > ${expectedTest}` };
    return {
      ...base,
      verdict: "wrong_test",
      reason: `the gate went red (exit ${status}) but the test the matrix names did not fail${base.newFailures.length ? `; new failures: ${base.newFailures.slice(0, 5).join("; ")}` : observedRun.observed.length ? `; failing: ${observedRun.observed.slice(0, 5).join("; ")}` : "; the gate reported no failing test at all"}`,
    };
  }
  return { ...base, verdict: "caught", reason: `the gate went red (exit ${status}) and the matrix names no specific test` };
}

// ---------------------------------------------------------------------------------------------------------
// Git plumbing (all of it through `git`, never through a hand-written file edit outside a worktree)
// ---------------------------------------------------------------------------------------------------------

function git(root, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    shell: false,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitOrThrow(root, args, what) {
  const result = git(root, args);
  if (result.error || result.status !== 0) {
    throw new Error(`${what} failed: git ${args.join(" ")} exited ${result.status ?? "?"}${result.error ? ` (${result.error})` : ""}\n${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** The two facts the brief asks to compare before and after: the working tree and the worktree list. */
export function snapshotRepositoryState(root) {
  return {
    status: gitOrThrow(root, ["status", "--porcelain", "--untracked-files=all"], "git status"),
    worktrees: gitOrThrow(root, ["worktree", "list", "--porcelain"], "git worktree list"),
  };
}

/** Copies one tracked file of the repository into the worktree (bytes identical, no patch application). */
function copyIntoWorktree(root, worktree, relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(worktree, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return target;
}

/**
 * The current state of the tree under review, mirrored into the worktree: tracked differences from HEAD plus
 * the untracked files a gate run needs. `git status` is not used to *decide* anything — the diff and the
 * untracked listing are, because they are exact and NUL-separated.
 */
export function mirrorWorkingTree(root, worktree, log = () => {}) {
  const copied = [];
  const deleted = [];
  const statusOutput = gitOrThrow(root, ["diff", "--name-status", "-z", "HEAD"], "git diff --name-status");
  const tokens = statusOutput.split("\0").filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const from = tokens[index + 1];
      const to = tokens[index + 2];
      index += 2;
      if (!from || !to) continue;
      if (code === "R") {
        rmSync(path.join(worktree, from), { force: true });
        deleted.push(from);
      }
      copyIntoWorktree(root, worktree, to);
      copied.push(to);
      continue;
    }
    const file = tokens[index + 1];
    index += 1;
    if (!file) continue;
    if (code === "D") {
      rmSync(path.join(worktree, file), { force: true });
      deleted.push(file);
      continue;
    }
    copyIntoWorktree(root, worktree, file);
    copied.push(file);
  }
  const untrackedOutput = gitOrThrow(root, ["ls-files", "--others", "--exclude-standard", "-z"], "git ls-files --others");
  const untracked = untrackedOutput.split("\0").filter((entry) => entry.length > 0);
  for (const file of untracked) {
    copyIntoWorktree(root, worktree, file);
    copied.push(file);
  }
  /**
   * A parse that lost the NUL fields would copy the wrong paths; comparing the bytes back proves the mirror is
   * the tree under review and turns a silent mis-parse into a loud error before any gate run.
   */
  const drifted = [];
  for (const file of copied) {
    const source = path.join(root, file);
    const target = path.join(worktree, file);
    if (!existsSync(target) || sha256(source) !== sha256(target)) drifted.push(file);
  }
  if (drifted.length) throw new Error(`the mirrored worktree does not match the tree under review for ${drifted.length} file(s): ${drifted.slice(0, 5).join(", ")}`);
  log(`mirrored the tree under review: ${copied.length} file(s) copied and verified byte-identical, ${deleted.length} deletion(s), ${untracked.length} untracked file(s)`);
  return { copied, deleted, untracked };
}

/**
 * The `.gitignore`d resources the gate really reads, with the consumer that proves each entry is not a guess.
 *
 * `mirrorWorkingTree` is built from `git diff HEAD` and `git ls-files --others --exclude-standard`, and both are
 * blind to ignored paths **by construction**. That is the whole defect this list closes: this gate reads a
 * dataset from `data/typosquat/**` (five suite tests plus the gate's own `typosquat dataset guard` step) and
 * writes its verdict and a suite fixture into `artifacts/**`, and neither path survives into a worktree — so a
 * mutation run in that worktree was judging an environment the repository does not have. The first escalated
 * run measured exactly that: `control.comment_only_in_the_guarded_file`, the *cosmetic* row, turned the gate red
 * (`tests=2023/6`), which is what a negative control is for.
 *
 * Each entry names its consumers and a substring of each consumer's source, and the mutation-branch suite
 * asserts those substrings still exist. That is what keeps this list honest: renaming or deleting a consumer
 * fails the suite instead of leaving a dead exemption behind, and a *new* dependency on ignored data cannot be
 * added to the gate without either being declared here or showing up as a red baseline (which the runner now
 * reports loudly instead of reading as sensitivity).
 *
 * The list is deliberately **not** "every ignored path". `.env` is ignored and present, and no gate suite and
 * no gate step reads it (the repository loads no dotenv), so copying a secret-bearing file out of the repository
 * into a temp worktree — which `--keep` can leave behind — would be a risk with no evidence behind it. Every
 * entry here answers "which gate test or gate step fails without this?", and an ignored path that fails that
 * question stays out.
 *
 * Note the hermeticity finding this list recorded (see `security-gate/security-gate-report.md`): the
 * mandatory `security-gate` job depends on `data/typosquat`, which `.gitignore` excludes and which `npm ci` does
 * not create. G1 (item 5) closed the dependency rather than the mirror: the gate's own preparation phase
 * (`prepareTyposquatDataset` in `scripts/lib/run-security-gate.mjs`) generates a **missing** dataset before
 * vitest, so a clean clone is gate-ready, while a dataset that exists but is stale still fails the `--check`
 * guard. The mirror still reproduces the tree under review faithfully; what changed is that the gate no longer
 * needs the resource to be pre-seeded.
 */
export const GATE_IGNORED_RESOURCES = [
  {
    path: "data/typosquat",
    kind: "directory",
    reason:
      "The curated typosquat dataset. `.gitignore` excludes `data/` and `npm ci` does not create it, yet five gate tests load it and the gate's own `typosquat dataset guard` step refuses a missing dataset as stale. Since G1 (item 5) the gate generates a missing dataset in its preparation phase, so this resource is mirrored for the tests that read it rather than to repair the gate.",
    consumers: [
      { file: "tests/coding-agent-c4a-typosquat-dataset.test.ts", evidence: 'path.join(REPO_ROOT, "data", "typosquat")' },
      { file: "tests/coding-agent-c4a-deps-guard.test.ts", evidence: 'path.resolve(import.meta.dirname, "..", "data", "typosquat")' },
      { file: "scripts/lib/typosquat-dataset-generate.mjs", evidence: 'export const DATASET_DIRECTORY_RELATIVE = path.join("data", "typosquat");' },
      { file: "scripts/lib/run-security-gate.mjs", evidence: 'const TYPOSQUAT_GENERATOR_PATH = "scripts/typosquat-dataset-generate.mjs";' },
    ],
  },
  {
    path: "artifacts",
    kind: "directory",
    reason:
      "The gate's evidence directory. The gate writes `artifacts/security-gate-report.json` into it (creating it if needed), while `tests/coding-agent-c15-cli-run-start.test.ts` writes its token fixture into a `mkdtemp` directory of its own (G1 item 5 removed that suite's dependency on this one). A worktree with no `artifacts/` therefore fails a gate test for a reason that has nothing to do with the mutation only if a step really reads it.",
    consumers: [
      { file: "scripts/lib/run-security-gate.mjs", evidence: 'export const GATE_ARTIFACT_PATH = "artifacts/security-gate-report.json";' },
      { file: "tests/coding-agent-c15-cli-run-start.test.ts", evidence: 'mkdtempSync(path.join(tmpdir(), "npati-c15-token-"))' },
    ],
  },
];

/** Is `relativePath` excluded by `.gitignore` in the tree under review? (The only paths this module mirrors.) */
export function isIgnoredPath(root, relativePath) {
  // `check-ignore` answers with exit 0 for an ignored path, 1 for a carried one and 128 for an error; anything
  // other than a plain 0 means the ordinary mirror already carries the path, which is the safe direction.
  return git(root, ["check-ignore", "-q", "--", relativePath]).status === 0;
}

/**
 * Copies one resource directory into the worktree, byte for byte, or creates it empty.
 *
 * An absent resource is **created as an empty directory** on purpose: in the tree under review the gate's own
 * artifact writer is what produces `artifacts/`, and a suite that writes a fixture there only needs a writable
 * directory to exist. Creating nothing would reproduce neither state.
 */
export function mirrorResourceDirectory(source, target, log = () => {}) {
  if (!existsSync(source)) {
    mkdirSync(target, { recursive: true });
    return { copied: [], created: true };
  }
  const copied = [];
  const walk = (relative) => {
    const directory = relative ? path.join(source, relative) : source;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      // A resource is data, not a tree of links: anything that is not a regular file is skipped rather than
      // followed (following a link out of the repository would mirror bytes the tree under review does not own).
      if (!entry.isFile()) continue;
      const to = path.join(target, child);
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(source, child), to);
      copied.push(child.replace(/\\/g, "/"));
    }
  };
  walk("");
  const drifted = copied.filter((file) => sha256(path.join(source, ...file.split("/"))) !== sha256(path.join(target, ...file.split("/"))));
  if (drifted.length) throw new Error(`the mirrored ignored resource ${source} does not match the tree under review for ${drifted.length} file(s): ${drifted.slice(0, 5).join(", ")}`);
  log(`ignored resource ${path.basename(source)}: ${copied.length} file(s) copied and verified byte-identical`);
  return { copied, created: false };
}

/**
 * Mirrors every declared `.gitignore`d resource. A resource that is *not* ignored in the tree under review is
 * reported and left to `mirrorWorkingTree`, so this cannot become a second, disagreeing copy of a tracked file.
 */
export function mirrorIgnoredResources(root, worktree, log = () => {}) {
  const results = [];
  for (const resource of GATE_IGNORED_RESOURCES) {
    if (!isIgnoredPath(root, resource.path)) {
      log(`ignored resource ${resource.path}: NOT ignored in the tree under review, so the ordinary mirror already carries it (declaration reviewed)`);
      results.push({ path: resource.path, mode: "carried_by_the_mirror", files: 0 });
      continue;
    }
    const mirrored = mirrorResourceDirectory(path.join(root, resource.path), path.join(worktree, resource.path), log);
    results.push({ path: resource.path, mode: mirrored.created ? "created_empty" : "copied", files: mirrored.copied.length });
    if (mirrored.created) log(`ignored resource ${resource.path}: absent in the tree under review, so an empty writable directory was created`);
  }
  return results;
}

/** The junction that gives the worktree the real dependency tree (a worktree has no `node_modules`). */
export function linkNodeModules(root, worktree, log = () => {}) {
  const target = path.join(root, "node_modules");
  const link = path.join(worktree, "node_modules");
  if (!existsSync(target)) throw new Error(`the repository has no node_modules at ${target}; run npm ci first`);
  if (existsSync(link)) return { linked: false, reason: "the worktree already has node_modules" };
  symlinkSync(target, link, "junction");
  const sentinel = path.join(link, "vitest", "vitest.mjs");
  if (!existsSync(sentinel)) throw new Error(`the node_modules link does not resolve (${sentinel} is missing)`);
  log(`node_modules junction -> ${target}`);
  return { linked: true, reason: null };
}

/** The submodule paths declared by `.gitmodules`, read as data (no `git submodule` invocation). */
export function declaredSubmodules(source) {
  const paths = [];
  for (const match of String(source ?? "").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    if (match[1] !== undefined && match[1]) paths.push(match[1].replace(/\\/g, "/"));
  }
  return paths;
}

/**
 * A `git worktree` check out does **not** materialise submodules, so a worktree would silently differ from the
 * tree under review wherever a submodule is used. Each checked-out submodule is therefore junctioned like
 * `node_modules`; a submodule that is registered but empty is skipped (the worktree's empty directory is then
 * what the tree under review has too). Nothing here is guessed: a junction that does not resolve fails the run
 * as a preflight error rather than producing a verdict from a different tree.
 */
export function linkSubmodules(root, worktree, log = () => {}) {
  const declared = (() => {
    try {
      return declaredSubmodules(readFileSync(path.join(root, ".gitmodules"), "utf8"));
    } catch {
      return [];
    }
  })();
  const linked = [];
  const skipped = [];
  for (const relative of declared) {
    const target = path.join(root, relative);
    if (!existsSync(target)) {
      skipped.push(`${relative} (absent in the tree under review)`);
      continue;
    }
    if (readdirSync(target).length === 0) {
      skipped.push(`${relative} (empty in the tree under review)`);
      continue;
    }
    const link = path.join(worktree, relative);
    if (existsSync(link)) {
      const entries = readdirSync(link);
      if (entries.length > 0) throw new Error(`the worktree already has content at ${relative}, so it cannot be junctioned`);
      rmdirSync(link);
    }
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
    if (readdirSync(link).length !== readdirSync(target).length) {
      throw new Error(`the junction for ${relative} does not resolve to the same content`);
    }
    linked.push(relative);
    log(`submodule junction ${relative} -> ${target}`);
  }
  if (skipped.length) log(`submodules not junctioned: ${skipped.join("; ")}`);
  return { linked, skipped, declared };
}

/**
 * Removes junctions **without** recursing into them, then proves the real dependency tree is untouched. A
 * recursive delete through a junction would delete the target's contents, which is why this is the only place
 * the worktree's links are removed and why it checks a sentinel afterwards.
 */
export function unlinkJunctions(root, worktree, relativePaths, log = () => {}) {
  const removed = [];
  for (const relative of relativePaths) {
    const link = path.join(worktree, relative);
    if (!existsSync(link)) continue;
    let isLink = false;
    try {
      isLink = lstatSync(link).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (!isLink) continue;
    try {
      rmdirSync(link);
    } catch {
      try {
        unlinkSync(link);
      } catch {
        /* reported by the post-condition below */
      }
    }
    if (!existsSync(link)) removed.push(relative);
  }
  const sentinel = path.join(root, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(sentinel)) throw new Error(`the real node_modules is damaged: ${sentinel} is gone`);
  log(`junctions removed (${removed.join(", ") || "none"}); the real dependency tree is intact`);
  return { removed, intact: true };
}

/** The `node_modules` case of `unlinkJunctions`, kept as its own name because it is the one that matters most. */
export function unlinkNodeModules(root, worktree, log = () => {}) {
  return unlinkJunctions(root, worktree, ["node_modules"], log);
}

/** Restores one file inside the worktree from the tree under review (between rows of one worktree). */
function resetFileInWorktree(root, worktree, relativePath) {
  return copyIntoWorktree(root, worktree, relativePath);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function applyMutation(root, worktree, control) {
  const target = path.join(worktree, control.file);
  if (!existsSync(target)) throw new Error(`the mutated file is not in the worktree: ${control.file}`);
  const before = readFileSync(target, "utf8");
  const rendered = renderMutation(before, control);
  if (!rendered.ok || rendered.text === null) throw new Error(`the mutation did not render: ${rendered.error}`);
  const beforeHash = sha256(target);
  writeFileSync(target, rendered.text, "utf8");
  const afterHash = sha256(target);
  if (beforeHash === afterHash) throw new Error(`the mutation left ${control.file} byte-identical`);
  return { file: control.file, line: rendered.line, beforeHash, afterHash };
}

// ---------------------------------------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------------------------------------

function clearGateArtifact(worktree) {
  const file = path.join(worktree, "artifacts", "security-gate-report.json");
  rmSync(file, { force: true });
  return file;
}

function runGate(worktree, timeoutMs) {
  const script = path.join(worktree, "scripts", "run-security-gate.mjs");
  // The very same entry point CI runs, from the very same list — only the root differs.
  const result = spawnSync(process.execPath, [script], {
    cwd: worktree,
    shell: false,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    env: process.env,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    spawnError: result.error ? result.error.message : null,
    transcript: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const only = [];
  const options = { dryRun: false, keep: false, json: false, worktreeDir: null, timeoutMs: 45 * 60 * 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      const value = argv[index + 1];
      if (!value) throw new Error("--only needs a row id");
      only.push(value);
      index += 1;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--worktree-dir") {
      options.worktreeDir = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--timeout") {
      const value = Number(argv[index + 1] ?? "0");
      options.timeoutMs = Number.isFinite(value) && value > 0 ? value : 0;
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      options.unknown = arg;
    }
  }
  return { only, options };
}

function usage() {
  return [
    "usage: node scripts/security-gate-mutation-branch.mjs [options]",
    "  --only <row-id>        run one matrix row (repeatable); default: every row",
    "  --dry-run              create/mirror/mutate/clean up the worktree, but do not run the gate",
    "  --keep                 keep the worktree for inspection (never in CI; it is printed)",
    "  --json                 print the verdict as JSON as well",
    "  --worktree-dir <path>  where the isolated worktree is created (default: a temp directory)",
    "  --timeout <ms>         kill each gate run after that long (default: 45 minutes)",
    "  The runner always runs the real gate once with NO mutation first (the baseline) and judges every row by",
    "  the failures the row adds to it; a baseline that is not green ends the run as inconclusive (exit 3).",
    "  exit codes: 0 proven, 1 the proof failed (a finding), 3 inconclusive (no measurement, or a red baseline)",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`[mutation-branch] ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  const { only, options } = parsed;
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.unknown) {
    process.stdout.write(`[mutation-branch] unknown argument \`${options.unknown}\`\n${usage()}\n`);
    return 3;
  }

  const summary = {
    gate: "security-gate-mutation-branch",
    script: "scripts/security-gate-mutation-branch.mjs",
    matrix: MUTATION_CONTROLS_PATH,
    root: ROOT,
    worktree: null,
    mirrored: null,
    ignoredResources: null,
    baseline: null,
    selected: [],
    rows: [],
    before: null,
    after: null,
    ok: false,
    verdict: "inconclusive",
    reason: null,
  };

  // The matrix is validated with the same guard the gate runs: a row whose anchor does not resolve is refused
  // here rather than mutated on a guess.
  const state = loadMutationControls(ROOT);
  if (state.error) {
    process.stdout.write(`[mutation-branch] FAILED: ${state.error}\n`);
    summary.reason = state.error;
    return finish(summary, options, 1);
  }
  const validation = validateMutationControls({ root: ROOT, controls: state.controls, suites: SECURITY_GATE_TESTS });
  if (!validation.ok) {
    process.stdout.write(`[mutation-branch] FAILED: the mutation matrix does not validate (${validation.issues.length} issue(s))\n`);
    for (const issue of validation.issues) process.stdout.write(`[mutation-branch]   ${issue.code} [${issue.id}]: ${issue.detail}\n`);
    summary.reason = "the mutation matrix does not validate";
    summary.matrixIssues = validation.issues;
    return finish(summary, options, 1);
  }
  const selected = state.controls.filter((row) => only.length === 0 || only.includes(row?.id));
  if (selected.length === 0) {
    process.stdout.write(`[mutation-branch] FAILED: no matrix row matches ${only.join(", ")}\n`);
    summary.reason = "no row selected";
    return finish(summary, options, 3);
  }
  summary.selected = selected.map((row) => row.id);
  process.stdout.write(
    `[mutation-branch] matrix ${MUTATION_CONTROLS_PATH}: rows=${state.controls.length} selected=${selected.length} ` +
      `(decoy=${selected.filter((row) => row.kind === "decoy").length}, cosmetic=${selected.filter((row) => row.kind === "cosmetic").length})\n`,
  );

  let before;
  try {
    before = snapshotRepositoryState(ROOT);
  } catch (error) {
    process.stdout.write(`[mutation-branch] FAILED (preflight): ${error instanceof Error ? error.message : String(error)}\n`);
    summary.reason = `preflight failed: ${error instanceof Error ? error.message : String(error)}`;
    return finish(summary, options, 3);
  }
  summary.before = { statusLines: before.status.trim().split("\n").filter(Boolean).length, worktrees: worktreePaths(before.worktrees) };
  process.stdout.write(`[mutation-branch] before: git status ${summary.before.statusLines} line(s), worktrees=${summary.before.worktrees.length}\n`);

  /**
   * `git worktree add` wants a path that does not exist yet, so the temp directory is the *parent* and the
   * worktree is its child. `--worktree-dir` names the child directly (the caller owns that choice).
   */
  let tempParent = null;
  let worktree;
  if (options.worktreeDir) {
    worktree = path.resolve(options.worktreeDir);
  } else {
    tempParent = mkdtempSync(path.join(tmpdir(), "npati-mutation-branch-"));
    worktree = path.join(tempParent, "worktree");
  }
  summary.worktree = worktree;
  let createdWorktree = false;
  let exitCode = 3;
  /** Every junction this run created, so cleanup removes exactly those and never recurses into a target. */
  const junctionPaths = [];
  try {
    process.stdout.write(`[mutation-branch] creating an isolated worktree at ${worktree}\n`);
    // A pre-created directory must be empty for `git worktree add`; mkdtempSync gives us one.
    gitOrThrow(ROOT, ["worktree", "add", "--detach", worktree, "HEAD"], "git worktree add");
    createdWorktree = true;
    summary.mirrored = mirrorWorkingTree(ROOT, worktree, (line) => process.stdout.write(`[mutation-branch] ${line}\n`));
    // The gitignored resources the gate reads are invisible to the diff/untracked mirror, so they are mirrored
    // (or created empty) here. Without this step the worktree is not the tree under review for the suites and
    // for the gate's own steps, which is how the first escalated run produced `wrong_test`/`unexpected_failure`.
    summary.ignoredResources = mirrorIgnoredResources(ROOT, worktree, (line) => process.stdout.write(`[mutation-branch] ${line}\n`));
    linkNodeModules(ROOT, worktree, (line) => process.stdout.write(`[mutation-branch] ${line}\n`));
    junctionPaths.push("node_modules");
    const submodules = linkSubmodules(ROOT, worktree, (line) => process.stdout.write(`[mutation-branch] ${line}\n`));
    junctionPaths.push(...submodules.linked);
    summary.submodules = { declared: submodules.declared, linked: submodules.linked, skipped: submodules.skipped };

    /**
     * The baseline gate run: the real gate, in the mirrored worktree, with **no mutation**. This is the
     * measurement that makes the rows a proof rather than a correlation — the gate can be red for reasons that
     * have nothing to do with a removed guard, and the first escalated run of this script is the evidence (its
     * *cosmetic* row turned the gate red because the worktree lacked the ignored dataset the gate reads).
     *
     * The baseline is a full gate run, so it costs minutes; it is not optional, because "already red" and
     * "the mutation was caught" are indistinguishable without it.
     */
    let baseline = null;
    if (!options.dryRun) {
      clearGateArtifact(worktree);
      process.stdout.write("[mutation-branch] baseline: running the real gate in the worktree with NO mutation\n");
      const baselineStarted = Date.now();
      const baselineRun = runGate(worktree, options.timeoutMs);
      const baselineArtifact = readGateArtifact(worktree);
      baseline = observeGateRun({
        status: baselineRun.status,
        signal: baselineRun.signal,
        spawnError: baselineRun.spawnError,
        transcript: baselineRun.transcript,
        artifact: baselineArtifact,
      });
      const problem = baselineProblem(baseline);
      const baselineTranscript = writeGateTranscript(ROOT, "baseline", baselineRun.transcript);
      summary.baseline = {
        exitCode: baseline.status,
        signal: baseline.signal,
        spawnError: baseline.spawnError,
        durationMs: Date.now() - baselineStarted,
        measured: baseline.measured,
        tests: baseline.tests,
        failedTests: baseline.observed.slice(0, 40),
        failureCount: baseline.failedTests.length,
        // The gate's own suite lines, always kept: a total that is lower than the repository's is only
        // diagnosable from whether a suite did not run or reported no tests at all.
        suiteLines: baseline.suiteLines,
        // …and the complete transcript, so nothing a verdict is diagnosed from is truncated away.
        transcript: baselineTranscript,
        green: problem === null,
        problem,
      };
      if (!baselineTranscript.ok) {
        process.stdout.write(`[mutation-branch] notice: the baseline transcript could not be written (${baselineTranscript.error}); the verdict is unaffected\n`);
      }
      process.stdout.write(
        `[mutation-branch] baseline: gate exit ${baseline.status}; tests=${
          baseline.tests ? `${baseline.tests.passed}/${baseline.tests.failed}` : "not measured"
        }; failing=${baseline.failedTests.length}\n`,
      );
      for (const line of baseline.suiteLines) process.stdout.write(`[mutation-branch]   ${line}\n`);
      if (problem === null) {
        process.stdout.write("[mutation-branch] baseline: GREEN — the gate passes in the worktree before any mutation\n");
      } else {
        /**
         * Loud, and in its own words: a red baseline is an `environment` state, not a result. Every failure is
         * named with the gate's own message for it (the first escalated run's artifact kept only the tail of the
         * transcript, which is why "the declared test did not fail" came with no cause), and the run will end
         * `inconclusive` — no row may claim `caught` from this environment.
         */
        process.stdout.write(`[mutation-branch] BASELINE RED: ${problem}\n`);
        for (const failure of baseline.observed.slice(0, 20)) process.stdout.write(`[mutation-branch]   baseline failing: ${failure}\n`);
        if (baseline.failureMessages.length) {
          process.stdout.write("[mutation-branch]   baseline reasons (the gate's own message lines):\n");
          summary.baseline.failureMessages = baseline.failureMessages;
          // Printed without a cap of its own: the parser already keeps every failure the gate printed with the
          // message lines the gate itself bounded, and a red baseline is the case where the whole list matters.
          for (const entry of baseline.failureMessages) {
            process.stdout.write(`[mutation-branch]     ${entry.file} > ${entry.title}\n`);
            for (const line of entry.message) process.stdout.write(`[mutation-branch]       ${line}\n`);
          }
        }
        if (baseline.environmentLines.length) {
          process.stdout.write(`[mutation-branch]   environment lines: ${baseline.environmentLines.join(" | ")}\n`);
        }
      }
    }

    /**
     * One worktree is reused for every row, so **every** file mutated so far is restored before the next row —
     * not only the file the next row edits. Two rows that touch different files would otherwise stack their
     * mutations (the cosmetic control would run against the fork-bomb classifier and go red for a reason the
     * matrix does not declare), and a "clean" negative control is exactly what must not be contaminated.
     */
    const mutatedFiles = new Set();
    for (const row of selected) {
      const rowResult = { id: row.id, kind: row.kind, expectedGateExit: row.expectedGateExit, mutation: null, gate: null, verdict: null, reason: null };
      process.stdout.write(`\n[mutation-branch] row ${row.id} (${row.kind}, expects exit ${row.expectedGateExit})\n`);
      try {
        for (const file of mutatedFiles) resetFileInWorktree(ROOT, worktree, file);
        mutatedFiles.clear();
        rowResult.mutation = applyMutation(ROOT, worktree, row);
        mutatedFiles.add(row.file);
        process.stdout.write(
          `[mutation-branch]   mutated ${row.file}:${rowResult.mutation.line} (sha256 ${rowResult.mutation.beforeHash.slice(0, 12)} -> ${rowResult.mutation.afterHash.slice(0, 12)})\n`,
        );
      } catch (error) {
        rowResult.verdict = "environment";
        rowResult.reason = `the mutation could not be applied: ${error instanceof Error ? error.message : String(error)}`;
        process.stdout.write(`[mutation-branch]   ${rowResult.reason}\n`);
        summary.rows.push(rowResult);
        continue;
      }
      if (options.dryRun) {
        rowResult.verdict = "dry_run";
        rowResult.reason = "the gate was not run (--dry-run)";
        process.stdout.write("[mutation-branch]   --dry-run: the gate was not run\n");
        summary.rows.push(rowResult);
        continue;
      }
      clearGateArtifact(worktree);
      process.stdout.write(`[mutation-branch]   running the real gate: node scripts/run-security-gate.mjs (cwd ${worktree})\n`);
      const started = Date.now();
      const run = runGate(worktree, options.timeoutMs);
      const artifact = readGateArtifact(worktree);
      const verdict = classifyGateRun({
        kind: row.kind,
        expectedGateExit: row.expectedGateExit,
        expectedFailingSuite: row.expectedFailingSuite,
        expectedFailingTest: row.expectedFailingTest,
        status: run.status,
        signal: run.signal,
        spawnError: run.spawnError,
        transcript: run.transcript,
        artifact,
        // The baseline is what separates "this mutation caused it" from "it was already red": every failure the
        // row adds is measured against the unmutated run of the same gate in the same worktree.
        baseline,
      });
      rowResult.gate = {
        exitCode: run.status,
        signal: run.signal,
        spawnError: run.spawnError,
        durationMs: Date.now() - started,
        tests: verdict.tests,
        artifact: artifact ? { ok: artifact.ok === true, tests: artifact.tests ?? null, failedTests: Array.isArray(artifact.failedTests) ? artifact.failedTests.length : null } : null,
        // The complete transcript of this row's run, next to the verdict: the evidence a non-clean verdict has
        // to be diagnosable from without re-running a 150-suite gate by hand.
        transcript: writeGateTranscript(ROOT, row.id, run.transcript),
      };
      if (!rowResult.gate.transcript.ok) {
        process.stdout.write(`[mutation-branch]   notice: the transcript could not be written (${rowResult.gate.transcript.error}); the verdict is unaffected\n`);
      }
      rowResult.verdict = verdict.verdict;
      rowResult.reason = verdict.reason;
      rowResult.observedFailures = verdict.observed.slice(0, 20);
      rowResult.newFailures = verdict.newFailures.slice(0, 20);
      // The tail of the gate's own output is kept as evidence for a row that is not a clean proof, so a red or
      // inconclusive run is diagnosable from the artifact alone. It is bounded: this is evidence, not a log.
      if (verdict.verdict !== "caught" && verdict.verdict !== "ok") {
        rowResult.gateTranscriptTail = run.transcript.split(/\r?\n/).slice(-25);
        rowResult.suiteLines = verdict.suiteLines;
        // …and the gate's own message lines for the failures, which the tail cannot carry: a row that is not a
        // clean proof has to be diagnosable from the artifact without re-running a 150-suite gate by hand.
        const messages = parseFailureMessages(run.transcript);
        if (messages.length) rowResult.failureMessages = messages;
      }
      process.stdout.write(
        `[mutation-branch]   gate exit ${run.status}; tests=${verdict.tests ? `${verdict.tests.passed}/${verdict.tests.failed}` : "not measured"}; verdict=${verdict.verdict}\n` +
          `[mutation-branch]   ${verdict.reason}\n`,
      );
      for (const failure of verdict.observed.slice(0, 10)) process.stdout.write(`[mutation-branch]     failing: ${failure}\n`);
      if (verdict.newFailures.length && verdict.verdict !== "caught") {
        for (const failure of verdict.newFailures.slice(0, 10)) process.stdout.write(`[mutation-branch]     new since baseline: ${failure}\n`);
      }
      summary.rows.push(rowResult);
    }

    const verdicts = summary.rows.map((row) => row.verdict);
    if (summary.baseline && summary.baseline.green === false && verdicts.length > 0) {
      // A red baseline is the environment's verdict, not the mutation's: `inconclusive` (3), never "proven".
      exitCode = 3;
      summary.verdict = "inconclusive";
      summary.reason = `the worktree baseline is not green before any mutation (${summary.baseline.problem}); the rows record which failures the mutations added, but no mutation verdict is claimed from a non-equivalent environment`;
    } else if (verdicts.some((verdict) => verdict === "environment" || verdict === "baseline_red")) {
      exitCode = 3;
      summary.verdict = "inconclusive";
      summary.reason = "at least one row could not be measured (the gate did not run), so no mutation verdict is claimed";
    } else if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "dry_run")) {
      exitCode = 0;
      summary.verdict = "dry_run";
      summary.reason = "the worktree, the mirror and the mutation were exercised, but the gate was not run (--dry-run)";
    } else if (verdicts.every((verdict) => verdict === "caught" || verdict === "ok")) {
      exitCode = 0;
      summary.verdict = "proven";
      summary.reason = "every selected row behaved exactly as the matrix declares, relative to a green baseline of the same gate in the same worktree";
    } else {
      exitCode = 1;
      summary.verdict = "failed";
      summary.reason = "at least one row did not behave as the matrix declares";
    }
  } catch (error) {
    summary.verdict = "inconclusive";
    summary.reason = `the run could not be completed: ${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(`[mutation-branch] FAILED: ${summary.reason}\n`);
    exitCode = 3;
  } finally {
    // Cleanup runs on every path, including the failure paths above: the user's tree must be untouched and the
    // worktree must be gone even when the gate crashed.
    try {
      if (createdWorktree && !options.keep) {
        unlinkJunctions(ROOT, worktree, junctionPaths, (line) => process.stdout.write(`[mutation-branch] ${line}\n`));
        const removed = git(ROOT, ["worktree", "remove", "--force", worktree]);
        if (removed.error || removed.status !== 0) {
          process.stdout.write(`[mutation-branch] notice: git worktree remove failed (${(removed.stderr || removed.error || "").trim()}); pruning\n`);
        }
        git(ROOT, ["worktree", "prune"]);
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        if (tempParent) rmSync(tempParent, { recursive: true, force: true });
      } else if (options.keep) {
        process.stdout.write(`[mutation-branch] --keep: the worktree is left at ${worktree}\n`);
      }
    } catch (error) {
      process.stdout.write(`[mutation-branch] FAILED to clean up the worktree: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
  }

  try {
    const after = snapshotRepositoryState(ROOT);
    summary.after = { statusLines: after.status.trim().split("\n").filter(Boolean).length, worktrees: worktreePaths(after.worktrees) };
    const statusUnchanged = after.status === before.status;
    // `--keep` leaves the worktree on purpose, so it is not a post-condition failure there; it is reported.
    const worktreeGone = options.keep || !worktreePaths(after.worktrees).some((entry) => samePath(entry, worktree));
    summary.postconditions = {
      statusUnchanged,
      worktreeGone,
      kept: options.keep === true,
      worktreesBefore: summary.before.worktrees.length,
      worktreesAfter: summary.after.worktrees.length,
    };
    process.stdout.write(
      `[mutation-branch] after: git status ${statusUnchanged ? "byte-identical" : "CHANGED"}; worktree list ${
        options.keep ? "still contains the worktree (--keep)" : worktreeGone ? "no longer contains the worktree" : "STILL CONTAINS the worktree"
      }\n`,
    );
    if (!statusUnchanged || !worktreeGone) {
      summary.verdict = "failed";
      summary.reason = `post-condition failed: statusUnchanged=${statusUnchanged} worktreeGone=${worktreeGone}`;
      exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`[mutation-branch] FAILED (post-conditions): ${error instanceof Error ? error.message : String(error)}\n`);
    summary.reason = `post-conditions could not be checked: ${error instanceof Error ? error.message : String(error)}`;
    exitCode = exitCode === 0 ? 1 : exitCode;
  }

  return finish(summary, options, exitCode);
}

function worktreePaths(porcelain) {
  const paths = [];
  for (const line of String(porcelain ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

function samePath(left, right) {
  const normalise = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalise(left) === normalise(right);
}

/** Writes the durable verdict. A write failure is reported and never changes the exit code (it is evidence). */
function finish(summary, options, exitCode) {
  summary.ok = exitCode === 0;
  summary.generatedAt = new Date().toISOString();
  summary.exitCode = exitCode;
  try {
    const file = path.join(ROOT, MUTATION_ARTIFACT_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    process.stdout.write(`[mutation-branch] verdict artifact: ${MUTATION_ARTIFACT_PATH}\n`);
  } catch (error) {
    process.stdout.write(`[mutation-branch] notice: the verdict artifact could not be written (${error instanceof Error ? error.message : String(error)}); the verdict is unaffected\n`);
  }
  process.stdout.write(
    `[mutation-branch] ${summary.verdict.toUpperCase()}: ${summary.reason ?? ""}\n` +
      `[mutation-branch] baseline: ${
        summary.baseline
          ? `exit ${summary.baseline.exitCode}, failing=${summary.baseline.failureCount}, ${summary.baseline.green ? "GREEN" : "RED"}`
          : summary.verdict === "dry_run"
            ? "not run (--dry-run)"
            : "not measured"
      }\n` +
      `[mutation-branch] rows: ${summary.rows.map((row) => `${row.id}=${row.verdict}${row.gate ? `(exit ${row.gate.exitCode})` : ""}`).join(", ") || "none"}\n`,
  );
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return exitCode;
}

const invoked = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
if (invoked && path.resolve(invoked).replace(/\\/g, "/").toLowerCase() === modulePath.replace(/\\/g, "/").toLowerCase()) {
  process.exit(main());
}
