/**
 * C9: test-integrity guard.
 *
 * "Make it green" has a cheapest solution that is not a solution: delete the failing test, skip it, focus a
 * single suite, or relax the assertion until it passes. None of those are visible in a green check mark, so
 * a verification loop that only reads pass/fail is trivially defeated by the very agent it is meant to hold
 * accountable.
 *
 * This module answers one question — *did this change reduce the project's ability to detect a regression?*
 * — and it answers it from the change itself, not from the run's own claim about the change. A finding does
 * not block the run and does not silently pass: it makes the verification result **unverified until
 * justified**, so the summary cannot report a clean verification over a weakened suite.
 *
 * Two deliberate limits. The guard never edits anything: it reports. And it can only judge what it is given —
 * with only a unified diff it works from added/removed lines, and with full before/after contents it counts
 * occurrences directly, which is strictly more reliable; callers should pass contents when they have them.
 */

export type TestIntegrityKind =
  | "test_file_deleted"
  | "test_cases_reduced"
  | "test_skipped"
  | "test_focused"
  | "assert_weakened"
  | "test_matrix_reduced";

export interface TestChangeInput {
  path: string;
  /** `added` | `modified` | `deleted` as reported by the change tracker; a deleted file is decisive. */
  status?: string;
  /** Unified diff body, used when the full contents are not available. */
  diff?: string;
  /** Full file contents before/after, when available. Preferred over diff scraping. */
  before?: string;
  after?: string;
}

export interface TestIntegrityFinding {
  path: string;
  kind: TestIntegrityKind;
  detail: string;
  removed?: number;
  added?: number;
}

export interface TestIntegrityVerdict {
  /** True when the change reduced the suite's detection power in any way. */
  flagged: boolean;
  /** Any finding requires a stated justification before verification may be reported as clean. */
  requiresJustification: boolean;
  findings: TestIntegrityFinding[];
  testFilesTouched: string[];
  testFilesDeleted: string[];
}

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//i,
  /(^|\/)test\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  // Java/Kotlin/C# name their tests from both sides: `UserTest.java` and `TestUser.java` are both tests.
  /[A-Za-z0-9_]*Test\.(java|kt|cs)$/,
  /(^|\/)Test[A-Za-z0-9_]*\.(java|kt|cs)$/,
];

/** True when the path is a test file. Exported so callers and tests agree on one definition. */
export function isTestPath(path: string): boolean {
  const normalized = (path ?? "").replace(/\\/g, "/");
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** True when a changed test file *added* detection power rather than removing it. */
export function isTestAddition(change: TestChangeInput): boolean {
  if ((change.status ?? "").toLowerCase() === "added") return true;
  return change.before === "" && typeof change.after === "string" && change.after.length > 0;
}

interface Counts {
  cases: number;
  describes: number;
  expects: number;
  skips: number;
  focuses: number;
  weakAsserts: number;
  strongAsserts: number;
  eachBlocks: number;
}

const CASE_PATTERN = /\b(?:it|test)\s*(?:\.\s*(?:skip|only|todo|fails|concurrent|each|sequential)\s*)?\(/g;
const DESCRIBE_PATTERN = /\bdescribe\s*(?:\.\s*(?:skip|only|each)\s*)?\(/g;
const EXPECT_PATTERN = /\bexpect\s*\(/g;
const SKIP_PATTERN = /\b(?:xit|xdescribe|it\.skip|test\.skip|describe\.skip|it\.todo|test\.todo|xitEach|it\.fails|test\.fails)\b|\.\s*skip\s*\(|(?:\btest|\bit|\bdescribe)\.todo\b/g;
const FOCUS_PATTERN = /\b(?:fit|fdescribe|it\.only|test\.only|describe\.only)\b|\.\s*only\s*\(/g;
const WEAK_ASSERT_PATTERN = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|not\.toThrow|toBeNull|toBeUndefined|toExist)\s*\(/g;
const STRONG_ASSERT_PATTERN = /\.(?:toEqual|toStrictEqual|toBe|toContain|toMatch|toHaveBeenCalled|toHaveBeenCalledWith|toThrow|toHaveLength|toMatchSnapshot)\s*\(/g;
const EACH_PATTERN = /\.\s*each\s*(?:<[^>]*>)?\s*\(/g;

function countMatches(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (matcher.exec(text) !== null) {
    count += 1;
    if (count > 100_000) break;
  }
  return count;
}

function countAll(text: string): Counts {
  return {
    cases: countMatches(text, CASE_PATTERN),
    describes: countMatches(text, DESCRIBE_PATTERN),
    expects: countMatches(text, EXPECT_PATTERN),
    skips: countMatches(text, SKIP_PATTERN),
    focuses: countMatches(text, FOCUS_PATTERN),
    weakAsserts: countMatches(text, WEAK_ASSERT_PATTERN),
    strongAsserts: countMatches(text, STRONG_ASSERT_PATTERN),
    eachBlocks: countMatches(text, EACH_PATTERN),
  };
}

interface DiffLines {
  added: string;
  removed: string;
}

/**
 * Splits a unified diff into the added and removed bodies. Header lines (`+++`/`---`) are excluded: counting
 * them would make every diff look as if it had added a line containing `it(`-like text.
 */
export function splitDiffLines(diff: string): DiffLines {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of (diff ?? "").split(/\r?\n/)) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added: added.join("\n"), removed: removed.join("\n") };
}

function finding(
  path: string,
  kind: TestIntegrityKind,
  detail: string,
  counts?: { removed?: number; added?: number },
): TestIntegrityFinding {
  return {
    path,
    kind,
    detail,
    ...(counts?.removed !== undefined ? { removed: counts.removed } : {}),
    ...(counts?.added !== undefined ? { added: counts.added } : {}),
  };
}

/**
 * Analyses a change set and reports every way it reduced test coverage or assertion strength.
 *
 * The order of the checks is the order of severity: a deleted test file outranks a skipped case, which
 * outranks a relaxed assertion.
 */
export function analyzeTestIntegrity(
  changes: readonly TestChangeInput[],
  options: { caseTolerance?: number } = {},
): TestIntegrityVerdict {
  const tolerance = Math.max(0, options.caseTolerance ?? 0);
  const findings: TestIntegrityFinding[] = [];
  const testFilesTouched: string[] = [];
  const testFilesDeleted: string[] = [];

  for (const change of changes ?? []) {
    const path = (change.path ?? "").replace(/\\/g, "/");
    if (!path || !isTestPath(path)) continue;
    testFilesTouched.push(path);

    const status = (change.status ?? "").toLowerCase();
    const addedFile = isTestAddition(change);
    if (status === "deleted") {
      testFilesDeleted.push(path);
      findings.push(finding(path, "test_file_deleted", "The test file was deleted."));
      continue;
    }
    // A brand-new test file can only add detection power; there is nothing to weaken.
    if (addedFile) continue;

    const hasContents = typeof change.before === "string" && typeof change.after === "string";
    let before: Counts;
    let after: Counts;
    if (hasContents) {
      before = countAll(change.before!);
      after = countAll(change.after!);
    } else if (typeof change.diff === "string") {
      const { added, removed } = splitDiffLines(change.diff);
      before = countAll(removed);
      after = countAll(added);
    } else {
      // Nothing to inspect. Silence is correct here: guessing from a path alone would produce findings that
      // cannot be justified, and an unjustifiable finding is noise.
      continue;
    }

    if (before.cases - after.cases > tolerance) {
      findings.push(finding(path, "test_cases_reduced", "Fewer test cases remain than before the change.", {
        removed: before.cases - after.cases,
        added: after.cases,
      }));
    }
    if (after.focuses > before.focuses) {
      // `.only` is worse than `.skip`: it silently disables every other case in the file.
      findings.push(finding(path, "test_focused", "A focused test (.only) was added, which disables the rest of the suite.", {
        removed: before.focuses,
        added: after.focuses,
      }));
    }
    if (after.skips > before.skips) {
      findings.push(finding(path, "test_skipped", "A test was skipped or marked todo.", {
        removed: before.skips,
        added: after.skips,
      }));
    }
    if (before.expects - after.expects > tolerance) {
      findings.push(finding(path, "assert_weakened", "Fewer assertions remain than before the change.", {
        removed: before.expects - after.expects,
        added: after.expects,
      }));
    } else if (after.weakAsserts > before.weakAsserts && before.strongAsserts > after.strongAsserts) {
      findings.push(finding(path, "assert_weakened", "A specific assertion was replaced by a weaker existence check.", {
        removed: before.strongAsserts - after.strongAsserts,
        added: after.weakAsserts - before.weakAsserts,
      }));
    }
    if (before.eachBlocks > after.eachBlocks) {
      findings.push(finding(path, "test_matrix_reduced", "A table-driven test block (.each) was removed.", {
        removed: before.eachBlocks - after.eachBlocks,
        added: after.eachBlocks,
      }));
    }
  }

  return {
    flagged: findings.length > 0,
    // One rule, stated once: a flagged change needs the agent to say why, and until it does the verification
    // is not clean. Making this depend on the finding kind would invite a "small enough" exception.
    requiresJustification: findings.length > 0,
    findings,
    testFilesTouched: [...new Set(testFilesTouched)],
    testFilesDeleted: [...new Set(testFilesDeleted)],
  };
}

/** The verdict's one-line form, for a summary or an Activity event (metadata only). */
export function describeTestIntegrity(verdict: TestIntegrityVerdict): string {
  if (!verdict.flagged) return "test integrity: no reduction detected";
  const kinds = [...new Set(verdict.findings.map((item) => item.kind))];
  return `test integrity: ${verdict.findings.length} finding(s) [${kinds.join(", ")}] in ${verdict.testFilesTouched.length} test file(s)`;
}
