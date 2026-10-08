import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACK_CATALOGUE_PATH,
  findMissingCatalogueEntries,
  itTitlesIn,
  loadAttackCatalogue,
  validateAttackCatalogue,
} from "../scripts/lib/attack-catalogue-check.mjs";
import { SECURITY_GATE_TESTS } from "../scripts/lib/run-security-gate.mjs";
import { HARD_DENY_RULES, classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";

/**
 * C14 — the attack catalogue is an artifact with a contract, not prose.
 *
 * `docs/coding-agent/attack-catalogue.json` names one row per attack class: the class, the suite, the exact
 * test title, and *how* the test is shown to be non-vacuous. This suite is the guard that makes those rows
 * un-fabricable, and it proves the guard itself is not vacuous by feeding it fabricated rows:
 *
 *  - a suite file that does not exist;
 *  - a suite that exists but is not in the security gate's fixed list;
 *  - a test title that appears in no file;
 *  - a row with no written negative-control argument;
 *  - a named negative-control test that does not exist;
 *  - in the report check, a catalogued title that simply did not run.
 *
 * `run-security-gate.mjs` runs the same two functions on the real catalogue: the static one before vitest, the
 * report one on the JSON report, so a renamed or skipped attack test is reported against its catalogue id.
 */

const ROOT = process.cwd();

interface CatalogueRow {
  id: string;
  class: string;
  suite: string;
  title: string;
  status: string;
  negativeControl: string;
  negativeControlSuite: string;
  negativeControlTitle: string;
  hardDenyRuleIds?: string[];
}

interface CatalogueExemption {
  ruleId: string;
  probe: string;
  coveredBy: string;
  reason: string;
}

interface Catalogue {
  version: number;
  classes: CatalogueRow[];
  hardDenyRuleExemptions: CatalogueExemption[];
}

const loaded = loadAttackCatalogue(ROOT);
if (loaded.error) throw new Error(`the attack catalogue could not be read: ${loaded.error}`);
const CATALOGUE = loaded.catalogue as Catalogue;
const GATE_SUITES = SECURITY_GATE_TESTS;
const RULE_IDS = HARD_DENY_RULES.map((rule) => rule.id);

function codes(issues: ReadonlyArray<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

describe("security-gate: C14 — the attack catalogue cannot contain a fabricated row", () => {
  it("the catalogue is clean: every row resolves to a real gate suite and a real test title", () => {
    expect(CATALOGUE.version).toBe(1);
    // A catalogue of one row would be trivially clean: the guard requires a real set of attack classes.
    expect(CATALOGUE.classes.length >= 15).toBe(true);
    expect(CATALOGUE.hardDenyRuleExemptions.length > 0).toBe(true);

    const verdict = validateAttackCatalogue({
      root: ROOT,
      catalogue: CATALOGUE,
      suites: GATE_SUITES,
      hardDenyRuleIds: RULE_IDS,
    });
    expect(codes(verdict.issues)).toEqual([]);
    expect(verdict.ok).toBe(true);

    // Every row's suite is one of the fixed gate suites, and the file really exists on disk.
    for (const row of CATALOGUE.classes) {
      expect(GATE_SUITES.includes(row.suite), `row ${row.id} suite`).toBe(true);
      expect(path.isAbsolute(row.suite)).toBe(false);
    }
    // Ids are unique, and every row carries a written non-vacuity argument (not "n/a").
    expect(new Set(CATALOGUE.classes.map((row) => row.id)).size).toBe(CATALOGUE.classes.length);
    expect(CATALOGUE.classes.every((row) => row.negativeControl.trim().length >= 40)).toBe(true);
    expect(ATTACK_CATALOGUE_PATH).toBe("docs/coding-agent/attack-catalogue.json");
  });

  it("every hard-deny rule is either exercised by a catalogued row or exempted with a probe that really fires", () => {
    // Each exemption is *verified*: the probe runs through the real classifier and must fire that rule by id.
    for (const exemption of CATALOGUE.hardDenyRuleExemptions) {
      const result = classifyShellCommand(exemption.probe);
      expect(result.risk, `exemption ${exemption.ruleId} probe must be hard-denied`).toBe("hard_deny");
      expect(result.matched, `exemption ${exemption.ruleId} probe must name the rule`).toContain(exemption.ruleId);
      expect(RULE_IDS.includes(exemption.ruleId), `exemption ${exemption.ruleId} must be a real rule`).toBe(true);
      expect(exemption.reason.trim().length >= 40, `exemption ${exemption.ruleId} needs a reason`).toBe(true);
      expect(exemption.coveredBy.trim().length > 0, `exemption ${exemption.ruleId} needs coveredBy`).toBe(true);
    }
    // Coverage: nothing in the rule table is unaccounted for, and the fork bomb is covered by a real row.
    const covered = new Set<string>();
    for (const row of CATALOGUE.classes) for (const ruleId of row.hardDenyRuleIds ?? []) covered.add(ruleId);
    for (const exemption of CATALOGUE.hardDenyRuleExemptions) covered.add(exemption.ruleId);
    for (const ruleId of RULE_IDS) expect(covered.has(ruleId), `rule ${ruleId} is unaccounted for`).toBe(true);
    expect(covered.size >= RULE_IDS.length).toBe(true);
    const forkBombRows = CATALOGUE.classes.filter((row) => (row.hardDenyRuleIds ?? []).includes("fork_bomb"));
    expect(forkBombRows.length > 0).toBe(true);
  });

  it("negative control: a fabricated row is caught — missing suite file, suite outside the gate, unknown title, empty negative control", () => {
    const template = CATALOGUE.classes[0];
    if (!template) throw new Error("the catalogue has no rows to build a fabrication from");
    const fabrications: Array<{ label: string; row: CatalogueRow; code: string }> = [
      {
        label: "a suite file that does not exist",
        row: { ...template, id: "fabricated.missing_file", suite: "tests/coding-agent-c14-not-written.test.ts" },
        code: "catalogue_missing_suite_file",
      },
      {
        label: "a suite that exists but is not in the gate",
        row: { ...template, id: "fabricated.outside_gate", suite: "tests/project-import.test.ts" },
        code: "catalogue_suite_not_in_gate",
      },
      {
        label: "a test title nobody wrote",
        row: { ...template, id: "fabricated.unknown_title", title: "a red-team test that was never written" },
        code: "catalogue_title_not_found",
      },
      {
        label: "a row with no written negative-control argument",
        row: { ...template, id: "fabricated.no_negative_control", negativeControl: "" },
        code: "catalogue_field_missing",
      },
      {
        label: "a named negative-control test that does not exist",
        row: { ...template, id: "fabricated.unknown_negative_control", negativeControlTitle: "no such negative control" },
        code: "catalogue_negative_control_title_not_found",
      },
      {
        label: "a duplicate row id",
        row: { ...template, id: template.id },
        code: "catalogue_id_duplicate",
      },
      {
        label: "a status outside the vocabulary",
        row: { ...template, id: "fabricated.status", status: "trust-me" },
        code: "catalogue_status_unknown",
      },
    ];
    for (const fabrication of fabrications) {
      // The duplicate-id case needs two rows; every other case is the fabricated row plus the template.
      const rows = fabrication.code === "catalogue_id_duplicate" ? [template, fabrication.row] : [fabrication.row];
      const verdict = validateAttackCatalogue({ root: ROOT, catalogue: { version: 1, classes: rows }, suites: GATE_SUITES });
      expect(verdict.ok, fabrication.label).toBe(false);
      expect(codes(verdict.issues), fabrication.label).toContain(fabrication.code);
    }
    // The real catalogue, judged the same way, is clean — so the guard is not "everything fails".
    expect(validateAttackCatalogue({ root: ROOT, catalogue: CATALOGUE, suites: GATE_SUITES, hardDenyRuleIds: RULE_IDS }).ok).toBe(true);
  });

  it("negative control: the report check catches a catalogued title that did not run, in the right suite", () => {
    const reportOf = (rows: CatalogueRow[]) => ({
      testResults: rows.map((row) => ({
        name: `D:\\npati\\NPATI Agent\\${row.suite.replace(/\//g, "\\")}`,
        assertionResults: [{ title: row.title, status: "passed", ancestorTitles: [] }],
      })),
    });

    // A report in which every catalogued title ran: nothing is missing.
    expect(findMissingCatalogueEntries(reportOf(CATALOGUE.classes), CATALOGUE)).toEqual([]);

    // The first row's title never ran (a rename, a delete, or a suite that failed to load).
    const dropped = CATALOGUE.classes[0];
    if (!dropped) throw new Error("the catalogue has no rows");
    const missing = findMissingCatalogueEntries(reportOf(CATALOGUE.classes.slice(1)), CATALOGUE);
    expect(missing.length).toBe(1);
    expect(missing[0]?.id).toBe(dropped.id);
    expect(missing[0]?.suite).toBe(dropped.suite);
    expect(missing[0]?.title).toBe(dropped.title);

    // The title ran, but in another suite: still reported, which is what makes the check a title + suite pair.
    const elsewhere = {
      testResults: [
        { name: "D:\\npati\\NPATI Agent\\tests\\some-other-suite.test.ts", assertionResults: [{ title: dropped.title, status: "passed" }] },
      ],
    };
    expect(findMissingCatalogueEntries(elsewhere, CATALOGUE).length).toBe(CATALOGUE.classes.length);

    // A malformed report is not a pass: every row is reported as not having run.
    expect(findMissingCatalogueEntries({}, CATALOGUE).length).toBe(CATALOGUE.classes.length);
    expect(findMissingCatalogueEntries(null, CATALOGUE).length).toBe(CATALOGUE.classes.length);
  });

  it("negative control: the title scanner is not vacuous — it finds real titles and ignores commented ones", () => {
    const source = [
      '  it("first title", () => {});',
      '// it("commented out", () => {});',
      ' * it("inside a jsdoc block", () => {});',
      '\tit("tabs are fine", () => {});',
      'it("column zero", () => {});',
      'it(`template titles are not part of the contract`, () => {});',
    ].join("\n");
    expect(itTitlesIn(source)).toEqual(["first title", "tabs are fine", "column zero"]);
    expect(itTitlesIn("").length).toBe(0);
    // And on the real files the catalogue resolves against, the scanner reports the titles it stores.
    for (const row of CATALOGUE.classes.slice(0, 3)) {
      const titles = itTitlesIn(readFileSync(path.join(ROOT, row.suite), "utf8"));
      expect(titles.includes(row.title), `row ${row.id}`).toBe(true);
    }
  });
});
