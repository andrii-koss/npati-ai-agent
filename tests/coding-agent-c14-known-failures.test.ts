import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_FAILURES_PATH,
  REQUIRED_ENTRY_FIELDS,
  adoptRun,
  buildArtifact,
  evaluateKnownFailures,
  failureKey,
  listSuiteFiles,
  loadKnownFailures,
  parseKnownFailures,
  unevaluatedSuites,
  type KnownFailureEntry,
} from "../scripts/lib/check-known-failures.mjs";
import { failedTests, formatFailedTests } from "../scripts/lib/run-security-gate.mjs";

/**
 * C14 (owner decision 1): the quarantine gate itself is pinned, and the pinned list is the real baseline.
 *
 * Two things are proven here, and they are deliberately separate:
 *
 *  1. **The verdict logic**, on synthetic data, without running a suite. All four RED conditions are exercised
 *     with their own negative control — the same fixture with a single difference reverted is GREEN — because a
 *     condition that fires on everything (or on nothing) would look identical to a working one in a one-sided
 *     test. Nothing here spawns vitest: `npm test`/`security-gate` own the execution, this file owns the rules.
 *
 *  2. **The manifest**, against the literal list of the 15 pre-existing failures. The list below is not derived
 *     from the manifest (that would be `expect(x).toEqual(x)`) — it is transcribed from the escalated full-suite
 *     run's own `FAIL` lines, and the suite asserts the manifest equals it **both ways**: a deleted entry fails
 *     (the gate would then call that failure a regression) and an added one fails too (the gate would then hide
 *     something). The title of every entry is additionally checked against the suite file on disk, so a typo in
 *     a `title` is caught here rather than as a phantom "new failure" in CI.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The known-red baseline, verbatim from the escalated full-suite run
 * (`Test Files 10 failed | 342 passed | 2 skipped (354)`, `Tests 15 failed | 3940 passed | 6 skipped (3961)`).
 * Keys are `failureKey(file, title)` — the same identity the gate compares.
 */
const BASELINE_FAILURES: ReadonlyArray<readonly [string, string]> = [
  ["tests/advanced-memory-production.test.ts", "advanced memory production contracts > injects action-sensitive memory before delegation planning"],
  ["tests/chat-entity-mutations.test.ts", "business and goal mutations through production chat > creates five separate ideas with one goal and memory per chat turn"],
  ["tests/company-orchestration.test.ts", "PHASE 5: Company Main Agent + Specialist Agent Orchestration > successfully orchestrates Main -> Specialist delegation with tool execution"],
  ["tests/company-orchestration.test.ts", "PHASE 5: Company Main Agent + Specialist Agent Orchestration > cancels active run across all delegated agents"],
  ["tests/data-studio-d5-completion.test.ts", "D5 completion — sandbox process environment > starts the Live Preview dev server with the Project API variables and without secrets"],
  ["tests/long-ai-company-chat.test.ts", "long AI Company creation through production chat > creates the company, all named agents, responsibilities, hierarchy, and no unsolicited memory, then remains idempotent"],
  ["tests/long-ai-company-chat.test.ts", "long AI Company creation through production chat > recovers from repeated memory-only model responses using the semantic company plan"],
  ["tests/manual-product-e2e-web.test.ts", "Manual Product E2E: Full Web User Flow > executes the complete user flow from Registration to Run Trace"],
  ["tests/per-request-no-memory-production.test.ts", "Per-request no-memory production wiring > does not create neutral history and blocks Company memory tools with an audited reason"],
  ["tests/production-durable-approvals.test.ts", "Production durable approvals and route tiers > stops a high-risk tool, then consumes one exact approval before execution"],
  ["tests/production-wasm-exec.test.ts", "Production WebAssembly Exec sandbox > runs through Company Agent only after one exact durable approval"],
];

const baselineKeys = BASELINE_FAILURES.map(([file, title]) => failureKey(file, title)).sort();

function entry(file: string, title: string, overrides: Partial<KnownFailureEntry> = {}): KnownFailureEntry {
  return {
    file,
    title,
    reason: "synthetic fixture: this reason is never shown to a user",
    owner: "test-owner",
    added_at: "2026-10-07",
    expires_at: "2026-11-06",
    ...overrides,
  };
}

const fixtureEntries: KnownFailureEntry[] = [
  entry("tests/alpha.test.ts", "alpha suite > the failing case"),
  entry("tests/beta.test.ts", "beta suite > another failing case"),
];

const fixtureActual = fixtureEntries.map((item) => ({ file: item.file, title: item.title }));

// ---------------------------------------------------------------------------------------------------------
// 1. The four conditions, each with its own negative control
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] the quarantine verdict is exactly `actual ⊆ documented`", () => {
  it("(a) GREEN when every actual failure is documented, and RED as soon as one is not observed", () => {
    const green = evaluateKnownFailures({ actual: fixtureActual, entries: fixtureEntries });
    expect(green.ok).toBe(true);
    expect(green.undeclaredFailures).toEqual([]);
    expect(green.staleEntries).toEqual([]);
    // The counting is real: two declared, two observed, and the same keys.
    expect(green.actualCount).toBe(2);
    expect(green.quarantineCount).toBe(2);

    // Negative control: the *same* fixture with one test now passing reports exactly that entry as stale, so
    // `ok` above is the comparison's answer rather than a fixture that can never fail.
    const stale = evaluateKnownFailures({ actual: [fixtureActual[0]!], entries: fixtureEntries });
    expect(stale.ok).toBe(false);
    expect(stale.staleEntries.map((item) => failureKey(item.file, item.title))).toEqual([failureKey("tests/beta.test.ts", "beta suite > another failing case")]);
    expect(stale.failures.join(" ")).toContain("passed");
  });

  it("(b) RED for a NEW failure, naming the test — and GREEN again once it is documented", () => {
    const regression = { file: "tests/alpha.test.ts", title: "alpha suite > a brand new regression" };
    const red = evaluateKnownFailures({ actual: [...fixtureActual, regression], entries: fixtureEntries });
    expect(red.ok).toBe(false);
    expect(red.undeclaredFailures).toEqual([regression]);
    // The new failure is the only complaint: the documented ones are still simply documented.
    expect(red.staleEntries).toEqual([]);
    expect(red.failures.join(" ")).toContain("NOT in the quarantine");

    // Documenting it turns the same run GREEN — the reverse direction of the same fixture.
    const documented = [...fixtureEntries, entry(regression.file, regression.title)];
    expect(evaluateKnownFailures({ actual: [...fixtureActual, regression], entries: documented }).ok).toBe(true);
    // …and it is the *identity* that matters, not the count: two entries with the wrong title are not enough.
    const wrongTitle = [...fixtureEntries, entry(regression.file, "alpha suite > something else")];
    const stillRed = evaluateKnownFailures({ actual: [...fixtureActual, regression], entries: wrongTitle });
    expect(stillRed.ok).toBe(false);
    expect(stillRed.undeclaredFailures).toHaveLength(1);
  });

  it("(c) RED for a stale entry (a quarantined test that passed) and names the entry to delete", () => {
    const red = evaluateKnownFailures({ actual: [fixtureActual[1]!], entries: fixtureEntries });
    expect(red.ok).toBe(false);
    expect(red.staleEntries.map((item) => failureKey(item.file, item.title))).toEqual([fixtureEntries[0]!].map((item) => failureKey(item.file, item.title)));
    expect(red.failures.join(" ")).toContain("remove them from known-failures.json");

    // Negative control: put the test back in the failure list and the entry is current again.
    expect(evaluateKnownFailures({ actual: fixtureActual, entries: fixtureEntries }).ok).toBe(true);
    // An empty quarantine with an empty run is GREEN — "nothing is red" is expressible without a file.
    expect(evaluateKnownFailures({ actual: [], entries: [] }).ok).toBe(true);
  });

  it("(d) RED for an expired entry, distinguishing unpaid debt from an already-paid one", () => {
    const now = new Date("2026-12-01T09:00:00.000Z");
    const expiredStillFailing = fixtureEntries.map((item) => ({ ...item, expires_at: "2026-11-06" }));
    const red = evaluateKnownFailures({ actual: fixtureActual, entries: expiredStillFailing, now });
    expect(red.ok).toBe(false);
    expect(red.expiredEntries).toHaveLength(2);
    expect(red.expiredEntries.every((item) => item.stillFailing)).toBe(true);
    expect(red.failures.join(" ")).toContain("unpaid debt");
    // An expiry is not a stale entry: the test is still failing, so nothing has to be deleted for that reason.
    expect(red.staleEntries).toEqual([]);

    // An expired entry whose test went green is reported as both expired and stale — two independent facts.
    const expiredAndGreen = evaluateKnownFailures({ actual: [fixtureActual[1]!], entries: expiredStillFailing, now });
    expect(expiredAndGreen.ok).toBe(false);
    expect(expiredAndGreen.expiredEntries.find((item) => item.file === "tests/alpha.test.ts")?.stillFailing).toBe(false);
    expect(expiredAndGreen.staleEntries).toHaveLength(1);

    // Negative control: the same run one day earlier, while the entries are still current, is GREEN.
    const before = new Date("2026-11-06T00:00:00.000Z");
    expect(evaluateKnownFailures({ actual: fixtureActual, entries: expiredStillFailing, now: before }).ok).toBe(true);
    // The expiry is inclusive: the entry is current *on* its expires_at day and expired the day after.
    expect(evaluateKnownFailures({ actual: fixtureActual, entries: expiredStillFailing, now: new Date("2026-11-07T00:00:00.000Z") }).ok).toBe(false);
  });

  it("keeps the exit-code contract and the artifact in step with the verdict", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    const green = buildArtifact({ now, verdict: evaluateKnownFailures({ actual: fixtureActual, entries: fixtureEntries }), actualCount: 2 });
    expect(green.status).toBe("green");
    expect(green.actualFailures).toBe(2);
    expect(green.quarantined).toBe(2);
    expect(green.undeclaredFailures).toEqual([]);

    const regression = { file: "tests/alpha.test.ts", title: "alpha suite > a brand new regression" };
    const redVerdict = evaluateKnownFailures({ actual: [...fixtureActual, regression], entries: fixtureEntries });
    const red = buildArtifact({ now, verdict: redVerdict, actualCount: redVerdict.actualCount, manifestErrors: ["broken"], suiteProblems: ["not the full suite"] });
    expect(red.status).toBe("red");
    // The artifact carries the reasons, not only the verdict, so a CI reader does not need the log.
    expect(red.undeclaredFailures).toEqual([regression]);
    expect(red.manifestProblems).toEqual(["broken"]);
    expect(red.suiteProblems).toEqual(["not the full suite"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. The manifest on disk is the real baseline
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] known-failures.json is the recorded baseline, not a growing permission", () => {
  const loaded = loadKnownFailures(KNOWN_FAILURES_PATH);

  it("parses, and equals the remaining baseline failures in both directions", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.ok).toBe(true);
    const entries = loaded.manifest?.entries ?? [];
    // The final audit verified that all 11 quarantined test identities now pass.
    // Keep the historical BASELINE_FAILURES below/above as synthetic input for negative gate tests.
    expect(entries).toEqual([]);
  });

  it("gives every entry a reason, an owner and an expiry that is after it was added", () => {
    const entries = loaded.manifest?.entries ?? [];
    for (const item of entries) {
      for (const field of REQUIRED_ENTRY_FIELDS) {
        expect(typeof item[field as keyof KnownFailureEntry]).toBe("string");
        expect(String(item[field as keyof KnownFailureEntry]).trim().length).toBeGreaterThan(0);
      }
      // `expires_at` is the anti-permanence field: a quarantine entry that expires before it was added, or a
      // reason that is a placeholder, is what turns this file into a blanket exemption.
      expect(item.expires_at >= item.added_at).toBe(true);
      expect(item.reason.length).toBeGreaterThan(40);
      expect(item.owner.length).toBeGreaterThan(0);
      expect(item.evidence ?? "").not.toBe("");
    }
    // No `expires_at` may be an open-ended date: the vocabulary of the field is a calendar day.
    expect(entries.every((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.expires_at))).toBe(true);
  });

  it("names tests that really exist in the suite files it points at", () => {
    const entries = loaded.manifest?.entries ?? [];
    for (const item of entries) {
      const suitePath = path.join(workspaceRoot, item.file);
      expect(existsSync(suitePath)).toBe(true);
      const source = readFileSync(suitePath, "utf8");
      // The last segment of the full title is the `it(...)` name; the middle segments are the describes.
      const segments = item.title.split(" > ");
      const testName = segments[segments.length - 1] ?? "";
      expect(testName.length).toBeGreaterThan(0);
      expect(source).toContain(testName);
      for (const describeName of segments.slice(0, -1)) {
        expect(source).toContain(describeName);
      }
    }
  });

  it("rejects a manifest that cannot be trusted, instead of comparing against it", () => {
    const base = { version: 1, entries: [entry("tests/alpha.test.ts", "alpha suite > one")] };
    expect(parseKnownFailures(JSON.stringify(base)).ok).toBe(true);

    const duplicate = { version: 1, entries: [entry("tests/alpha.test.ts", "alpha suite > one"), entry("tests/alpha.test.ts", "alpha suite > one")] };
    const duplicateResult = parseKnownFailures(JSON.stringify(duplicate));
    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.errors.join(" ")).toContain("duplicate");

    const missingField = { version: 1, entries: [{ file: "tests/alpha.test.ts", title: "alpha suite > one", reason: "why", owner: "who" }] };
    const missingResult = parseKnownFailures(JSON.stringify(missingField));
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join(" ")).toContain("added_at");

    const badDate = { version: 1, entries: [entry("tests/alpha.test.ts", "alpha suite > one", { expires_at: "next tuesday" })] };
    expect(parseKnownFailures(JSON.stringify(badDate)).ok).toBe(false);

    const bornExpired = { version: 1, entries: [entry("tests/alpha.test.ts", "alpha suite > one", { added_at: "2026-11-06", expires_at: "2026-10-07" })] };
    const bornExpiredResult = parseKnownFailures(JSON.stringify(bornExpired));
    expect(bornExpiredResult.ok).toBe(false);
    expect(bornExpiredResult.errors.join(" ")).toContain("before added_at");

    expect(parseKnownFailures("{ not json").ok).toBe(false);
    expect(parseKnownFailures(JSON.stringify([{ file: "x" }])).ok).toBe(false);
    expect(parseKnownFailures(JSON.stringify({ version: 2, entries: [] })).errors.join(" ")).toContain("version");
    // A missing file is not an empty quarantine: "nothing is known to fail" must be said, not assumed.
    expect(loadKnownFailures(path.join(workspaceRoot, "known-failures-that-does-not-exist.json")).ok).toBe(false);
  });

  it("normalises the identity the way the vitest report does", () => {
    expect(failureKey("tests/alpha.test.ts", "suite > case")).toBe("tests/alpha.test.ts > suite > case");
    // Windows-separated and absolute paths reduce to the same key, which is what makes the comparison work.
    expect(failureKey("D:\\repo\\tests\\alpha.test.ts", "suite > case")).toBe(failureKey("tests/alpha.test.ts", "suite > case"));
    expect(failureKey("./tests/alpha.test.ts", "suite > case")).toBe(failureKey("tests/alpha.test.ts", "suite > case"));
    expect(failureKey("tests/alpha.test.ts", "  suite > case  ")).toBe(failureKey("tests/alpha.test.ts", "suite > case"));
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. A partial run cannot satisfy the quarantine
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] the gate refuses a run that did not cover the repository", () => {
  it("walks the two trees vitest includes and skips what the runner ignores", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-known-failures-suites-"));
    try {
      mkdirSync(path.join(root, "tests", "nested"), { recursive: true });
      mkdirSync(path.join(root, "packages", "pkg", "src"), { recursive: true });
      mkdirSync(path.join(root, "tests", "node_modules"), { recursive: true });
      writeFileSync(path.join(root, "tests", "a.test.ts"), "// suite\n", "utf8");
      writeFileSync(path.join(root, "tests", "nested", "b.test.ts"), "// suite\n", "utf8");
      writeFileSync(path.join(root, "packages", "pkg", "src", "c.test.ts"), "// suite\n", "utf8");
      // Not a suite, or not a tree the runner reads: neither may appear.
      writeFileSync(path.join(root, "tests", "helper.ts"), "// not a suite\n", "utf8");
      writeFileSync(path.join(root, "tests", "node_modules", "d.test.ts"), "// dependency\n", "utf8");
      const found = listSuiteFiles(root);
      expect(found).toEqual(["packages/pkg/src/c.test.ts", "tests/a.test.ts", "tests/nested/b.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // And the real repository has suites, so a walker that silently returned nothing cannot pass the line above.
    expect(listSuiteFiles(workspaceRoot).length).toBeGreaterThan(300);
    expect(listSuiteFiles(workspaceRoot)).toContain("tests/company-runtime.test.ts");
  });

  it("names the suites a report did not execute, and stays silent when it executed them all", () => {
    const expected = ["tests/a.test.ts", "tests/b.test.ts"];
    const complete = { testResults: expected.map((name) => ({ name: path.join(workspaceRoot, name), assertionResults: [{ status: "passed" }] })) };
    // The `expected` list is injected here so both directions are decidable inside one suite; the default is the
    // real walk of the repository, which the next assertions use.
    expect(unevaluatedSuites(complete, { expected })).toEqual([]);

    const partial = { testResults: [{ name: path.join(workspaceRoot, "tests/a.test.ts"), assertionResults: [{ status: "passed" }] }] };
    expect(unevaluatedSuites(partial, { expected })).toEqual(["tests/b.test.ts"]);

    // Against the real repository: a one-suite report leaves *every* other suite unevaluated, which is the signal
    // a filtered or truncated run would produce (`--exclude` is exactly this, done on purpose).
    const missing = unevaluatedSuites(partial);
    expect(missing).toContain("tests/company-runtime.test.ts");
    expect(missing).not.toContain("tests/a.test.ts");
    expect(missing.length).toBeGreaterThan(300);
  });

  it("reads a report through the one traversal the gate uses, and the printer shows the same tests", () => {
    const report = {
      testResults: [
        {
          name: path.join(workspaceRoot, "tests", "company-runtime.test.ts"),
          assertionResults: [
            { status: "failed", ancestorTitles: ["Company delegation runtime"], title: "a failing case", failureMessages: ["AssertionError: boom"] },
            { status: "passed", ancestorTitles: ["Company delegation runtime"], title: "a passing case", failureMessages: [] },
          ],
        },
      ],
    };
    // `failedTests` is the single traversal: the quarantine and `formatFailedTests` must agree on the identity,
    // otherwise a test can be red in one reading and green in the other.
    expect(failedTests(report)).toEqual([
      { file: "tests/company-runtime.test.ts", title: "Company delegation runtime > a failing case", messages: ["AssertionError: boom"] },
    ]);
    expect(formatFailedTests(report).join("\n")).toContain("tests/company-runtime.test.ts > Company delegation runtime > a failing case");
    expect(formatFailedTests(report).join("\n")).not.toContain("a passing case");
    expect(failedTests({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. Growing the quarantine is an explicit, reviewed act
// ---------------------------------------------------------------------------------------------------------

describe("[C14] [security-gate] adopting a run rewrites the manifest without hiding anything", () => {
  const existing = [entry("tests/alpha.test.ts", "alpha suite > old"), entry("tests/beta.test.ts", "beta suite > green now", { reason: "kept verbatim because the test still fails: this reason is the reviewer's, not the run's" })];

  it("adds what is missing, drops what went green, and keeps the metadata of what stays red", () => {
    const actual = [
      { file: "tests/alpha.test.ts", title: "alpha suite > old" },
      { file: "tests/gamma.test.ts", title: "gamma suite > newly red" },
    ];
    const result = adoptRun({
      actual,
      entries: existing,
      owner: "release-owner",
      reason: "adopted during the C14 sign-off after checking the failure is unrelated to the change",
      expiresAt: "2026-12-31",
      addedAt: "2026-10-07",
    });
    expect(result.added.map((item) => failureKey(item.file, item.title))).toEqual([failureKey("tests/gamma.test.ts", "gamma suite > newly red")]);
    expect(result.dropped.map((item) => failureKey(item.file, item.title))).toEqual([failureKey("tests/beta.test.ts", "beta suite > green now")]);
    expect(result.retained.map((item) => failureKey(item.file, item.title))).toEqual([failureKey("tests/alpha.test.ts", "alpha suite > old")]);

    // The kept entry is byte-for-byte the old one (an adoption must not silently re-date or re-word a decision).
    expect(result.entries.find((item) => item.file === "tests/alpha.test.ts")).toEqual(existing[0]);
    // The added entry carries the signed reason, the owner and the expiry — and says where it came from.
    const added = result.added[0]!;
    expect(added.owner).toBe("release-owner");
    expect(added.expires_at).toBe("2026-12-31");
    expect(added.added_at).toBe("2026-10-07");
    expect(added.reason).toContain("unrelated to the change");
    expect(added.evidence).toContain("adopt");

    // The rewritten manifest is valid, and the same run against it is GREEN: adoption converges.
    const rewritten = parseKnownFailures(JSON.stringify({ version: 1, default_owner: "release-owner", entries: result.entries }));
    expect(rewritten.errors).toEqual([]);
    expect(evaluateKnownFailures({ actual, entries: rewritten.manifest?.entries ?? [] }).ok).toBe(true);
  });

  it("is not a way to keep a green test: adopting a run with no failures empties the quarantine", () => {
    const result = adoptRun({ actual: [], entries: existing, owner: "release-owner", reason: "everything passes now, deleting the quarantine is the point", expiresAt: "2026-12-31", addedAt: "2026-10-07" });
    expect(result.entries).toEqual([]);
    expect(result.dropped).toHaveLength(2);
    expect(result.added).toEqual([]);
  });
});
