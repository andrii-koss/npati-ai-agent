/**
 * C14 — `known-failures` quarantine gate (owner decision 1).
 *
 * The problem this solves: `npm test` has 15 pre-existing failures, so a CI job that simply runs it is
 * permanently red and therefore ignored. The two dishonest fixes are `--exclude`/`--testNamePattern` (the
 * failures stop being *run* at all) and `continue-on-error` (they stop being *visible*). This script does
 * neither. It runs the **whole** suite — the same invocation `npm test` makes, plus the JSON reporter that
 * `scripts/lib/run-security-gate.mjs` already uses — and then compares what actually failed with what
 * `known-failures.json` declares, under four conditions, **all of which are RED**:
 *
 *   1. **an undocumented failure** — a test that failed and is not in the quarantine. This is the only case
 *      that can hide a regression, so it is the first thing reported.
 *   2. **a stale entry** — a quarantined test that passed. The quarantine must shrink when a test is fixed;
 *      otherwise it rots into a blanket permission that would also swallow the *next* failure of that test.
 *   3. **an expired entry** (`expires_at` in the past) — whether the test is still failing or not. Still-red
 *      means the debt was not paid; now-green means it was paid and the entry is also stale. Either way the
 *      job is RED, because a quarantine without an expiry is a permanent exemption.
 *   4. **a manifest that cannot be trusted** — a malformed entry, a duplicate id, or a run that did not
 *      actually execute every suite file on disk. A quarantine compared against a partial run proves nothing.
 *
 * GREEN therefore means exactly `actual failures ⊆ documented quarantine`, with every entry current. Nothing
 * here weakens an assertion, skips a test or changes a suite: the failures keep happening, loudly, in the log.
 *
 * Usage (through the executable `scripts/check-known-failures.mjs`, which owns the shebang and calls `main`):
 *   node scripts/check-known-failures.mjs                      # run the full suite and compare
 *   node scripts/check-known-failures.mjs --report <path>      # compare against an existing vitest JSON report
 *   node scripts/check-known-failures.mjs --json               # machine-readable verdict on stdout
 *   node scripts/check-known-failures.mjs --artifact <path>    # also write the verdict as a CI artifact
 *   node scripts/check-known-failures.mjs --adopt <path> --reason <text> --expires <YYYY-MM-DD>
 *                                                              # maintenance: rewrite the manifest from a run
 *
 * `--adopt` is deliberately **not** usable from CI and refuses to run without a reason and an expiry: growing
 * the quarantine is a decision somebody signs, never something a pipeline does on its own.
 *
 * Exit codes: 0 = GREEN, 1 = RED (any of the four conditions), 2 = usage/report error (no verdict exists).
 *
 * G1 (item 5): this file is the **library** half of `scripts/check-known-failures.mjs`. It is two directories
 * below the repository root and carries no shebang, because the shebang line of the executable it used to be
 * was a syntax error in `node:vm` whenever a bundler did not transform it — which made a gate suite report
 * "no tests at all" in a git worktree.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failedTests, findEmptySuites, findMissingSuites, isEntryPoint, suiteKey } from "./run-security-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The manifest. One file, so there is one place to look and one place to review. */
export const KNOWN_FAILURES_PATH = path.resolve(ROOT, "known-failures.json");

/** Every field an entry must carry. A missing one makes the entry unusable, so it is a hard error. */
export const REQUIRED_ENTRY_FIELDS = ["file", "title", "reason", "owner", "added_at", "expires_at"];

/** Written at the end of a run, so a diagnostic record of the comparison exists even when nothing is printed. */
export const KNOWN_FAILURES_ARTIFACT_NAME = "known-failures-report.json";

// ---------------------------------------------------------------------------------------------------------
// Identity and manifest
// ---------------------------------------------------------------------------------------------------------

/** One failing test, in the same normalised shape the vitest report yields. */
export function failureKey(file, title) {
  return `${suiteKey(file)} > ${String(title ?? "").trim()}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses and validates the manifest. Validation is not decoration: a typo in a `title` silently turns the
 * entry into two conditions at once (a "new failure" and a "stale entry") that look like a code problem rather
 * than a data problem, so a malformed manifest is reported as its own condition *before* the comparison.
 */
export function parseKnownFailures(text) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`known-failures.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], manifest: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["known-failures.json must be a JSON object with an `entries` array"], manifest: null };
  }
  if (parsed.version !== 1) errors.push(`known-failures.json: unsupported version ${JSON.stringify(parsed.version)} (expected 1)`);
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, errors: [...errors, "known-failures.json: `entries` must be an array"], manifest: null };
  }
  const seen = new Map();
  const entries = parsed.entries.map((entry, index) => {
    const where = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where}: must be an object`);
      return null;
    }
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!isNonEmptyString(entry[field])) errors.push(`${where}.${field}: required, must be a non-empty string`);
    }
    for (const field of ["added_at", "expires_at"]) {
      if (isNonEmptyString(entry[field]) && !ISO_DATE.test(entry[field])) {
        errors.push(`${where}.${field}: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(entry[field])}`);
      }
    }
    // An entry born expired is either a typo or an expired record that should have been deleted; both are
    // rejected here rather than reported as an expiry condition on every single run from now on.
    if (ISO_DATE.test(entry.added_at) && ISO_DATE.test(entry.expires_at) && entry.expires_at < entry.added_at) {
      errors.push(`${where}.expires_at (${entry.expires_at}) is before added_at (${entry.added_at})`);
    }
    if (isNonEmptyString(entry.file) && isNonEmptyString(entry.title)) {
      const key = failureKey(entry.file, entry.title);
      if (seen.has(key)) errors.push(`${where}: duplicate of entries[${seen.get(key)}] (${key})`);
      else seen.set(key, index);
      if (path.isAbsolute(entry.file) || suiteKey(entry.file) !== entry.file.replace(/\\/g, "/")) {
        errors.push(`${where}.file: must be repository-relative and start at the suite tree, got ${JSON.stringify(entry.file)}`);
      }
    }
    return entry;
  });
  return {
    ok: errors.length === 0,
    errors,
    manifest: {
      version: parsed.version,
      comment: parsed.$comment,
      defaultOwner: parsed.default_owner,
      updatedAt: parsed.updated_at,
      entries: entries.filter(Boolean),
    },
  };
}

/** Reads the manifest from disk. A missing file is an error, not an empty quarantine: "nothing is known to fail". */
export function loadKnownFailures(file = KNOWN_FAILURES_PATH) {
  if (!existsSync(file)) {
    return { ok: false, errors: [`${path.relative(ROOT, file)} does not exist: an empty quarantine must be an empty \`entries\` array, not a missing file`], manifest: null };
  }
  return parseKnownFailures(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------------------

/**
 * Compares the actual failures of a run against the manifest. Pure: the caller supplies the failures, so the
 * four conditions are testable on synthetic data without running a suite.
 *
 * `now` is injected for the same reason: an expiry that can only be observed on the day it happens is an
 * expiry nobody tests.
 */
export function evaluateKnownFailures(input) {
  const actual = input.actual ?? [];
  const entries = input.entries ?? [];
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const quarantine = new Map(entries.map((entry) => [failureKey(entry.file, entry.title), entry]));
  const observed = new Map(actual.map((failure) => [failureKey(failure.file, failure.title), failure]));

  const undeclaredFailures = [...observed.values()]
    .filter((failure) => !quarantine.has(failureKey(failure.file, failure.title)))
    .map((failure) => ({ file: suiteKey(failure.file), title: failure.title }));
  const staleEntries = [...quarantine.values()]
    .filter((entry) => !observed.has(failureKey(entry.file, entry.title)))
    .map((entry) => ({ file: entry.file, title: entry.title, expires_at: entry.expires_at }));
  const expiredEntries = entries
    .filter((entry) => ISO_DATE.test(entry.expires_at) && entry.expires_at < today)
    .map((entry) => ({
      file: entry.file,
      title: entry.title,
      expires_at: entry.expires_at,
      // The two readings of an expiry need different words: debt still to pay vs. debt already paid.
      stillFailing: observed.has(failureKey(entry.file, entry.title)),
    }));

  const failures = [];
  if (undeclaredFailures.length) {
    failures.push(`${undeclaredFailures.length} test(s) failed and are NOT in the quarantine: a new failure is a regression until somebody documents it`);
  }
  if (staleEntries.length) {
    failures.push(`${staleEntries.length} quarantined test(s) passed: remove them from known-failures.json (a quarantine that never shrinks hides the next failure of the same test)`);
  }
  if (expiredEntries.length) {
    const stillRed = expiredEntries.filter((entry) => entry.stillFailing).length;
    failures.push(`${expiredEntries.length} quarantine entr(y/ies) passed their expires_at (${stillRed} still failing = unpaid debt, ${expiredEntries.length - stillRed} green = stale)`);
  }

  return {
    ok: failures.length === 0,
    failures,
    undeclaredFailures,
    staleEntries,
    expiredEntries,
    actualCount: observed.size,
    quarantineCount: quarantine.size,
  };
}

// ---------------------------------------------------------------------------------------------------------
// "The full suite really ran"
// ---------------------------------------------------------------------------------------------------------

/**
 * The suite files vitest's `include` covers, walked from disk so the expectation is not a hand-kept list.
 *
 * The walk mirrors `vitest.config.ts` (`tests/**\/*.test.ts`, `packages/**\/*.test.ts`) **and** the runner's own
 * default excludes (dependency, build, coverage and dot directories), because a walker that counts a file the
 * runner legitimately ignores would fail a green build. `apps/**` is deliberately absent: the web project has
 * its own config and its own command (`test:web`), which is why `npm test` does not run it either.
 */
export function listSuiteFiles(root = ROOT) {
  const skipped = new Set(["node_modules", "dist", "build", "coverage", "cypress"]);
  const out = [];
  const walk = (absolute, relative) => {
    let entries = [];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of entries) {
      // `.git`, `.cache`, `.output`, … — vitest's defaults skip every dot entry, so this walker does too.
      if (name.startsWith(".") || skipped.has(name)) continue;
      const child = path.join(absolute, name);
      const childRelative = `${relative}/${name}`;
      let info;
      try {
        info = statSync(child);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(child, childRelative);
      else if (name.endsWith(".test.ts")) out.push(childRelative);
    }
  };
  // Exactly the two trees `vitest.config.ts` includes, so this list and the runner cannot disagree.
  walk(path.join(root, "tests"), "tests");
  walk(path.join(root, "packages"), "packages");
  return out.sort();
}

/**
 * Suites that the run did not execute. Without this, a quarantine could be "satisfied" by a run that silently
 * covered a fraction of the repository — which is the failure mode `--exclude` would have created on purpose.
 *
 * `expected` is injectable so the rule is testable without pretending the whole repository ran (the default is
 * the real walk of the two trees vitest includes).
 */
export function unevaluatedSuites(report, options = {}) {
  const expected = options.expected ?? listSuiteFiles(options.root ?? ROOT);
  return findMissingSuites(report, expected);
}

// ---------------------------------------------------------------------------------------------------------
// Running the suite
// ---------------------------------------------------------------------------------------------------------

/**
 * Runs the full suite. The arguments are the ones `npm test` uses (`vitest run`, no file filter, no
 * `--exclude`) plus the JSON reporter; the same local entry point and the same "no shell" rule as
 * `run-security-gate.mjs`, because `process.execPath` may contain spaces on Windows.
 */
export function runFullSuite(options = {}) {
  const reportPath = options.reportPath ?? path.join(mkdtempSync(path.join(tmpdir(), "npati-known-failures-")), "vitest-report.json");
  const vitestBin = path.resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitestBin, "run", "--reporter=json", `--outputFile=${reportPath}`], {
    cwd: ROOT,
    shell: false,
    encoding: "utf8",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { ok: false, error: `could not start vitest: ${result.error.message}`, reportPath, output };
  if (!existsSync(reportPath)) return { ok: false, error: `vitest produced no JSON report at ${reportPath} (exit ${result.status})`, reportPath, output };
  try {
    return { ok: true, report: JSON.parse(readFileSync(reportPath, "utf8")), reportPath, output, status: result.status };
  } catch (error) {
    return { ok: false, error: `the vitest report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, reportPath, output };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Maintenance: adopting a run into the manifest
// ---------------------------------------------------------------------------------------------------------

/**
 * Rewrites the manifest from a run: entries that are still failing keep their metadata, entries that went green
 * are dropped (the quarantine shrinks), and failures that are not declared yet are added with the **signed**
 * reason/expiry the caller supplies. Pure, so the rewrite rules are testable.
 */
export function adoptRun(input) {
  const actual = input.actual ?? [];
  const existing = input.entries ?? [];
  const { owner, reason, expiresAt, addedAt } = input;
  const byKey = new Map(existing.map((entry) => [failureKey(entry.file, entry.title), entry]));
  const observedKeys = new Set(actual.map((failure) => failureKey(failure.file, failure.title)));
  const kept = [];
  const retained = [];
  const dropped = [];
  for (const entry of existing) {
    if (observedKeys.has(failureKey(entry.file, entry.title))) {
      kept.push(entry);
      retained.push({ file: entry.file, title: entry.title });
    } else {
      dropped.push({ file: entry.file, title: entry.title });
    }
  }
  const added = [];
  for (const failure of actual) {
    const key = failureKey(failure.file, failure.title);
    if (byKey.has(key)) continue;
    const entry = {
      file: suiteKey(failure.file),
      title: failure.title,
      reason,
      owner,
      added_at: addedAt,
      expires_at: expiresAt,
      evidence: "adopted from a vitest JSON report by `node scripts/check-known-failures.mjs --adopt`",
    };
    added.push(entry);
    kept.push(entry);
  }
  kept.sort((a, b) => failureKey(a.file, a.title).localeCompare(failureKey(b.file, b.title)));
  return { entries: kept, added, dropped, retained };
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

/** Splits `--flag value` / `--flag=value` / `--flag` into a map. Unknown flags are the caller's problem. */
export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals > 0) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

function readReport(reportPath) {
  if (!existsSync(reportPath)) throw new Error(`the report ${reportPath} does not exist`);
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

/** The verdict as the CI artifact. Bounded: a failure list of ids, not of stack traces. */
export function buildArtifact(input) {
  return {
    gate: "known-failures",
    at: input.now.toISOString(),
    status: input.verdict.ok ? "green" : "red",
    actualFailures: input.actualCount,
    quarantined: input.verdict.quarantineCount,
    undeclaredFailures: input.verdict.undeclaredFailures,
    staleEntries: input.verdict.staleEntries,
    expiredEntries: input.verdict.expiredEntries,
    manifestProblems: input.manifestErrors ?? [],
    suiteProblems: input.suiteProblems ?? [],
    manifestPath: path.relative(ROOT, KNOWN_FAILURES_PATH),
  };
}

export function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const now = new Date();

  // --- maintenance mode: rewrite the manifest, never a CI path ---
  if (typeof flags.adopt === "string") {
    if (!isNonEmptyString(flags.reason) || !isNonEmptyString(flags.expires) || !ISO_DATE.test(flags.expires)) {
      print("[known-failures] --adopt requires --reason <text> and --expires <YYYY-MM-DD>: growing the quarantine is a signed decision");
      return 2;
    }
    let report;
    try {
      report = readReport(flags.adopt);
    } catch (error) {
      print(`[known-failures] ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const loaded = loadKnownFailures();
    const existing = loaded.manifest?.entries ?? [];
    const result = adoptRun({
      actual: failedTests(report),
      entries: existing,
      owner: isNonEmptyString(flags.owner) ? flags.owner : loaded.manifest?.defaultOwner ?? "unassigned",
      reason: flags.reason,
      expiresAt: flags.expires,
      addedAt: now.toISOString().slice(0, 10),
    });
    const next = {
      ...(loaded.manifest?.comment === undefined ? {} : { $comment: loaded.manifest.comment }),
      version: 1,
      updated_at: now.toISOString().slice(0, 10),
      default_owner: loaded.manifest?.defaultOwner ?? "unassigned",
      entries: result.entries,
    };
    writeFileSync(KNOWN_FAILURES_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    print(`[known-failures] adopted ${result.added.length} new entr(y/ies), kept ${result.retained.length}, dropped ${result.dropped.length} green entr(y/ies)`);
    for (const entry of result.added) print(`[known-failures]   + ${failureKey(entry.file, entry.title)}`);
    for (const entry of result.dropped) print(`[known-failures]   - ${failureKey(entry.file, entry.title)}`);
    print(`[known-failures] wrote ${path.relative(ROOT, KNOWN_FAILURES_PATH)}`);
    return 0;
  }

  const loaded = loadKnownFailures();
  const manifestErrors = loaded.errors;
  if (!loaded.ok) for (const error of manifestErrors) print(`[known-failures] MANIFEST ERROR: ${error}`);

  // --- the run ---
  let report = null;
  if (typeof flags.report === "string") {
    try {
      report = readReport(flags.report);
    } catch (error) {
      print(`[known-failures] ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  } else {
    print("[known-failures] running the full suite (vitest run, no file filter, no --exclude)…");
    const run = runFullSuite();
    if (!run.ok) {
      print(`[known-failures] FAILED: ${run.error}`);
      if (run.output) print(run.output.split("\n").slice(-40).join("\n"));
      return 2;
    }
    report = run.report;
    print(`[known-failures] vitest exit ${run.status}; report ${path.relative(ROOT, run.reportPath)}`);
  }

  const actual = failedTests(report);
  const suiteProblems = [];
  const unevaluated = unevaluatedSuites(report);
  if (unevaluated.length) suiteProblems.push(`${unevaluated.length} suite file(s) on disk were not executed by this run`);
  const empty = findEmptySuites(report);
  if (empty.length) suiteProblems.push(`${empty.length} suite(s) ran no test at all (a file that failed to load looks like this)`);

  const verdict = evaluateKnownFailures({
    actual,
    entries: loaded.manifest?.entries ?? [],
    now,
  });
  const ok = verdict.ok && manifestErrors.length === 0 && suiteProblems.length === 0;

  for (const failure of verdict.undeclaredFailures) print(`[known-failures] NEW FAILURE (not in known-failures.json): ${failureKey(failure.file, failure.title)}`);
  for (const entry of verdict.staleEntries) print(`[known-failures] STALE ENTRY (this test passed — delete it from known-failures.json): ${failureKey(entry.file, entry.title)}`);
  for (const entry of verdict.expiredEntries) {
    print(`[known-failures] EXPIRED ENTRY (${entry.expires_at}) ${entry.stillFailing ? "still failing — unpaid debt, fix or re-sign it" : "now green — also stale"}: ${failureKey(entry.file, entry.title)}`);
  }
  for (const problem of suiteProblems) print(`[known-failures] SUITE PROBLEM: ${problem}`);
  for (const failure of verdict.failures) print(`[known-failures] ${failure}`);
  print(`[known-failures] actual=${verdict.actualCount} quarantined=${verdict.quarantineCount} undeclared=${verdict.undeclaredFailures.length} stale=${verdict.staleEntries.length} expired=${verdict.expiredEntries.length}`);
  print(ok ? "[known-failures] GREEN — every failure is documented, current and expiring" : "[known-failures] RED");

  const artifact = buildArtifact({ now, verdict, actualCount: verdict.actualCount, manifestErrors, suiteProblems });
  const artifactPath = typeof flags.artifact === "string" ? flags.artifact : path.join(ROOT, "artifacts", KNOWN_FAILURES_ARTIFACT_NAME);
  try {
    // The directory is created here rather than by a CI `mkdir` step: a step that can forget it is a step that
    // turns evidence into a `if-no-files-found` warning nobody reads.
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    print(`[known-failures] artifact: ${path.relative(ROOT, artifactPath)}`);
  } catch (error) {
    // The artifact is evidence for a human; failing to write it must not change the verdict, but it is said out loud.
    print(`[known-failures] could not write the artifact (${error instanceof Error ? error.message : String(error)})`);
  }
  if (flags.json === true) print(JSON.stringify(artifact));
  return ok ? 0 : 1;
}

/**
 * Kept for callers that used to import the entry-point test from this module. `run-security-gate.mjs` is the
 * module that defines it; this re-export only exists so a checkout that still imports it from here keeps
 * working, and the executable wrapper is the only place that evaluates it (with its **own** `import.meta.url`,
 * because the default parameter would otherwise be evaluated here and compare this file's path).
 */
export { isEntryPoint };
