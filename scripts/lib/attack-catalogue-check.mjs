/**
 * C14: the machine-readable attack catalogue and its guard.
 *
 * `docs/audit/coding-agent/PLAN.md` (G1) asks for a red-team set and for proof that it fails when a protection is
 * removed. A list of attack *classes* in prose cannot do that: it cannot rot loudly. This module makes the
 * catalogue an artifact with a contract, in the same shape as `run-security-gate.mjs`'s fixed suite list:
 *
 *  - **static** (`validateAttackCatalogue`): every row must name a suite file that exists, that suite must be
 *    in the gate's fixed list, the row's `title` must be a test title that really appears in that file, and the
 *    row must carry a written `negativeControl` and a *named* negative-control test. Every hard-deny rule of
 *    the shell classifier must be either exercised by a row or exempted **with a probe command**, and an
 *    exemption that names a rule which no longer exists is stale. A fabricated row therefore cannot survive.
 *  - **dynamic** (`findMissingCatalogueEntries`): the vitest JSON report must contain an assertion with exactly
 *    that title in exactly that suite, so a row whose test was renamed, moved into a `.skip` or deleted is
 *    reported with its catalogue id instead of passing because the file exists.
 *
 * Nothing here is a test framework dependency: the readers defend themselves against a missing or malformed
 * catalogue/report, because the caller may be handing them external input.
 *
 * G1 (item 5): this file is the **library** half of `scripts/attack-catalogue-check.mjs` and carries no
 * shebang. It used to *be* that script, and a `#!/usr/bin/env node` first line is a syntax error once a
 * bundler hands the file to `node:vm` untransformed — which is exactly what happened in a git worktree, where
 * Vite did not transform it and every suite importing it reported "no tests at all". The executable is now the
 * thin wrapper `scripts/attack-catalogue-check.mjs`, which keeps the shebang and calls `main()` from here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The catalogue's location, relative to the repository root. */
export const ATTACK_CATALOGUE_PATH = "docs/audit/coding-agent/attack-catalogue.json";

/** The statuses a row may declare. `measured-limitation` is the honest one: measured, not defended. */
export const CATALOGUE_STATUSES = ["covered", "measured-limitation"];

/** The minimum length of a written negative-control explanation, so "n/a" cannot be one. */
export const NEGATIVE_CONTROL_MIN_CHARS = 40;

/** The same minimum for an exemption's reason. */
export const EXEMPTION_REASON_MIN_CHARS = 40;

/**
 * Every `it("…")` title in a suite's source, in file order.
 *
 * Anchored at the start of a line (after indentation) so a title quoted inside a comment or a JSDoc block is
 * not mistaken for a test, and deliberately restricted to double-quoted titles: the catalogue stores the exact
 * title, and a list of titles that could be produced by two different quoting styles would not be a contract.
 */
export function itTitlesIn(source) {
  const titles = [];
  const text = String(source ?? "");
  const pattern = /^[ \t]*it\(\s*"([^"]*)"/gm;
  let match = pattern.exec(text);
  while (match !== null) {
    titles.push(match[1]);
    match = pattern.exec(text);
  }
  return titles;
}

/**
 * Normalizes a suite path for comparison: the vitest JSON report carries absolute, Windows-style paths while
 * the catalogue stores repository-relative ones, so both sides are reduced to the suffix starting at `tests/`.
 * (The same reduction `run-security-gate.mjs`'s `suiteKey` performs; kept local so this module has no import
 * cycle with the gate that imports it.)
 */
export function normalizeSuiteKey(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const index = normalized.indexOf("tests/");
  return index >= 0 ? normalized.slice(index) : normalized;
}

/** Reads the catalogue. Returns `{ catalogue, error }`; `error` is prose for the gate log, never thrown. */
export function loadAttackCatalogue(root) {
  const file = path.join(root, ATTACK_CATALOGUE_PATH);
  if (!existsSync(file)) return { catalogue: null, error: `missing file ${ATTACK_CATALOGUE_PATH}` };
  try {
    return { catalogue: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { catalogue: null, error: `unreadable ${ATTACK_CATALOGUE_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The static guard. `input.hardDenyRuleIds` is optional: a caller that cannot import TypeScript (the gate
 * script itself runs under plain Node) passes nothing and gets the file/title/negative-control checks, while
 * the suite that *does* import `HARD_DENY_RULES` passes the ids and additionally gets rule coverage.
 */
export function validateAttackCatalogue(input) {
  const root = input?.root ?? process.cwd();
  const catalogue = input?.catalogue;
  const suites = Array.isArray(input?.suites) ? input.suites : [];
  const hardDenyRuleIds = Array.isArray(input?.hardDenyRuleIds) ? input.hardDenyRuleIds : null;
  const issues = [];
  const add = (code, id, detail) => issues.push({ code, id, detail });

  if (!catalogue || typeof catalogue !== "object" || Array.isArray(catalogue)) {
    add("catalogue_not_an_object", "-", "the catalogue must be a JSON object");
    return { ok: false, issues };
  }
  const rows = Array.isArray(catalogue.classes) ? catalogue.classes : null;
  if (!rows || rows.length === 0) {
    add("catalogue_classes_empty", "-", "`classes` must be a non-empty array of attack rows");
    return { ok: false, issues };
  }

  const suiteSet = new Set(suites);
  const titlesCache = new Map();
  const titlesFor = (suite) => {
    if (!titlesCache.has(suite)) {
      try {
        titlesCache.set(suite, itTitlesIn(readFileSync(path.join(root, suite), "utf8")));
      } catch {
        titlesCache.set(suite, null);
      }
    }
    return titlesCache.get(suite);
  };

  const seenIds = new Set();
  const declaredRuleIds = new Set();
  for (const row of rows) {
    const id = typeof row?.id === "string" && row.id.trim() ? row.id : "-";
    if (id !== "-") {
      if (seenIds.has(id)) add("catalogue_id_duplicate", id, `the id \`${id}\` is used by more than one row`);
      seenIds.add(id);
    }
    for (const field of ["id", "class", "suite", "title", "status", "negativeControl", "negativeControlSuite", "negativeControlTitle"]) {
      if (typeof row?.[field] !== "string" || !row[field].trim()) {
        add("catalogue_field_missing", id, `field \`${field}\` must be a non-empty string`);
      }
    }
    if (typeof row?.negativeControl === "string" && row.negativeControl.trim().length < NEGATIVE_CONTROL_MIN_CHARS) {
      add("catalogue_negative_control_too_short", id, `\`negativeControl\` must explain the non-vacuity argument in at least ${NEGATIVE_CONTROL_MIN_CHARS} characters`);
    }
    if (typeof row?.status === "string" && row.status && !CATALOGUE_STATUSES.includes(row.status)) {
      add("catalogue_status_unknown", id, `status \`${row.status}\` is not one of ${CATALOGUE_STATUSES.join(", ")}`);
    }
    for (const ruleId of Array.isArray(row?.hardDenyRuleIds) ? row.hardDenyRuleIds : []) declaredRuleIds.add(ruleId);

    if (typeof row?.suite === "string" && row.suite.trim()) {
      if (!existsSync(path.join(root, row.suite))) {
        add("catalogue_missing_suite_file", id, `suite file does not exist: ${row.suite}`);
      } else if (!suiteSet.has(row.suite)) {
        add("catalogue_suite_not_in_gate", id, `suite ${row.suite} is not in the security-gate suite list`);
      } else {
        const titles = titlesFor(row.suite);
        if (!titles) add("catalogue_suite_unreadable", id, `suite file could not be read: ${row.suite}`);
        else if (!titles.includes(row.title)) add("catalogue_title_not_found", id, `no it("${row.title}") in ${row.suite}`);
      }
    }
    if (typeof row?.negativeControlSuite === "string" && row.negativeControlSuite.trim()) {
      if (!existsSync(path.join(root, row.negativeControlSuite))) {
        add("catalogue_missing_negative_control_suite_file", id, `negative-control suite file does not exist: ${row.negativeControlSuite}`);
      } else if (!suiteSet.has(row.negativeControlSuite)) {
        add("catalogue_negative_control_suite_not_in_gate", id, `negative-control suite ${row.negativeControlSuite} is not in the security-gate suite list`);
      } else {
        const titles = titlesFor(row.negativeControlSuite);
        if (!titles) add("catalogue_negative_control_suite_unreadable", id, `negative-control suite could not be read: ${row.negativeControlSuite}`);
        else if (!titles.includes(row.negativeControlTitle)) add("catalogue_negative_control_title_not_found", id, `no it("${row.negativeControlTitle}") in ${row.negativeControlSuite}`);
      }
    }
  }

  const exemptions = Array.isArray(catalogue.hardDenyRuleExemptions) ? catalogue.hardDenyRuleExemptions : [];
  if (hardDenyRuleIds) {
    const known = new Set(hardDenyRuleIds);
    const covered = new Set(declaredRuleIds);
    for (const exemption of exemptions) if (typeof exemption?.ruleId === "string" && exemption.ruleId) covered.add(exemption.ruleId);
    for (const ruleId of known) {
      if (!covered.has(ruleId)) add("catalogue_rule_uncovered", ruleId, `hard-deny rule \`${ruleId}\` is neither exercised by a row nor exempted`);
    }
    for (const ruleId of declaredRuleIds) {
      if (!known.has(ruleId)) add("catalogue_rule_id_unknown", ruleId, `a row claims hard-deny rule \`${ruleId}\`, which the classifier does not define`);
    }
    for (const exemption of exemptions) {
      const ruleId = typeof exemption?.ruleId === "string" && exemption.ruleId ? exemption.ruleId : "-";
      if (ruleId === "-") { add("catalogue_exemption_field_missing", "-", "an exemption has no `ruleId`"); continue; }
      if (!known.has(ruleId)) add("catalogue_exemption_stale", ruleId, `exemption for \`${ruleId}\` is stale: the classifier defines no such rule`);
      if (typeof exemption.probe !== "string" || !exemption.probe.trim()) add("catalogue_exemption_probe_missing", ruleId, "an exemption must carry a `probe` command that really fires the rule");
      if (typeof exemption.coveredBy !== "string" || !exemption.coveredBy.trim()) add("catalogue_exemption_covered_by_missing", ruleId, "an exemption must name the suite that covers the behaviour (`none` plus a reason when nothing does)");
      if (typeof exemption.reason !== "string" || exemption.reason.trim().length < EXEMPTION_REASON_MIN_CHARS) add("catalogue_exemption_reason_too_short", ruleId, `an exemption's \`reason\` must be at least ${EXEMPTION_REASON_MIN_CHARS} characters`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * The dynamic guard: a catalogued row whose test did not run in the report. The match is `suite + title` from
 * `assertionResults[].title`, so renaming a test (or moving it to another file) is reported against its
 * catalogue id rather than being absorbed by the suite merely existing.
 */
export function findMissingCatalogueEntries(report, catalogue) {
  const rows = Array.isArray(catalogue?.classes) ? catalogue.classes : [];
  const ran = new Set();
  for (const file of report?.testResults ?? []) {
    const suite = normalizeSuiteKey(file?.name ?? file?.file ?? "");
    for (const assertion of file?.assertionResults ?? []) {
      ran.add(`${suite}::${String(assertion?.title ?? "")}`);
    }
  }
  return rows
    .filter((row) => !ran.has(`${normalizeSuiteKey(row?.suite ?? "")}::${String(row?.title ?? "")}`))
    .map((row) => ({ id: row?.id ?? "-", suite: row?.suite ?? "", title: row?.title ?? "" }));
}
