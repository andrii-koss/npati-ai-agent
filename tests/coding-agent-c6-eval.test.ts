import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  CodeToolRuntime,
  sha256Hex,
  type CodeReadPort,
  type CodeWritePort,
} from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import {
  canonicalExecutors,
  canonicalWriteExecutors,
  canonicalShellExecutors,
  canonicalDepsExecutors,
} from "../apps/agent-api/src/code-tool-executors";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { configuredModelPricing } from "../apps/agent-api/src/cost-telemetry";
import { VERIFICATION_REPAIR_EXHAUSTED } from "../apps/agent-api/src/code-verification-loop";
import {
  CODE_EVAL_SCHEMA_VERSION,
  EVAL_LANGUAGES,
  EVAL_TASK_KINDS,
  evalReportIsGreen,
  loadEvalFixture,
  loadEvalTasks,
  resolveEvalMode,
  runEvalSuite,
  type EvalFixture,
  type EvalReport,
  type EvalStep,
  type EvalTask,
} from "../apps/agent-api/src/code-eval-harness";
import {
  SLO_CALIBRATION_SCHEMA_VERSION,
  buildSloCalibration,
  notMeasuredSloTargets,
} from "../apps/agent-api/src/code-slo-calibration";
import {
  DEFAULT_CODE_ANOMALY_THRESHOLDS,
  anomalyPopulationFrom,
  codeRunAnomalyFactsFromSummary,
  evaluateCodeRunAnomaly,
  resolveCodeAnomalyThresholds,
} from "../apps/agent-api/src/code-anomaly-detection";
import { DEFAULT_CODE_AGENT_LIMITS } from "../apps/agent-api/src/code-agent-config";
import { DEFAULT_CODE_RUN_BUDGET } from "../apps/agent-api/src/code-run-quota";

/**
 * C6/C9 security-gate suite: the eval harness must be deterministic in CI (no network, no Docker, no live
 * model) and must actually EXERCISE THE REAL TOOL PATH. Tool calls go through `CodeToolRuntime` with the
 * canonical executors over an in-memory workspace port, so a passing task proves the production path works
 * — while a deliberately wrong transcript must FAIL, otherwise the harness would be green by construction.
 *
 * C9 added three task-side tools that are all exercised here through that same harness (no second runner):
 * a `check` step that records the exit status of a project check *inside* the transcript, and the
 * `test_integrity`/`self_review`/`repair_loop` verifications, which judge the run's change set with the real
 * C9 guard, the real self-review pass (over a RECORDED provider answer) and the real verification-loop state
 * machine. Every new kind gets a negative control below, because a verification nobody can fail proves
 * nothing.
 *
 * The project's test runner is simulated (the fixture repositories have no Node test runner); that
 * simulation is part of the fixture contract, not of the tool path under test. It evaluates the fixture's own
 * `expect(<fn>(a, b)).toBe(n)` assertions against the source file, honours `.skip`/`.todo` and `.only` the way
 * a real runner does, and is therefore exactly the behaviour the test-integrity guard exists to catch: a
 * suite whose failing case no longer runs reports green.
 *
 * C14 added two more hermetic simulators, because build repair and dependency migration cannot be verified by
 * reading a string: `npm run build` parses the repository's JSON configuration with the **real** `JSON.parse`
 * (a build that cannot read its own config fails), and `npm run deps:check` scans `import`/`require`
 * specifiers and compares them with the manifest **in both directions** (an import nobody declared cannot
 * install; a declaration nobody imports is paid for and unused). All three are named as simulators on purpose:
 * they spawn nothing, resolve no package and know no language. Every simulator is restricted to JavaScript/
 * TypeScript-shaped text, which is why the Python and Go corpus tasks carry no command at all.
 */

const owner: AuthContext = { workspaceId: "ws-eval", userId: "user-eval", permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };

const allowAll = { assertEnabled: async () => true, isEnabled: async () => true } as unknown as FeatureFlagService;

function evalFilePath(): string {
  // `import.meta.dirname` keeps this independent of the process CWD (the same class of defect that once made
  // a security-gate suite load with zero tests).
  return `${import.meta.dirname}/fixtures/coding-agent-eval/tasks.json`;
}

function loadFixtureFile(): EvalFixture {
  return loadEvalFixture(JSON.parse(readFileSync(evalFilePath(), "utf8")));
}

function loadFixture(): EvalTask[] {
  return loadFixtureFile().tasks;
}

function verificationList(task: EvalTask) {
  return Array.isArray(task.verify) ? task.verify : [task.verify];
}

// ---------------------------------------------------------------------------------------------------------
// The fixture's stand-in test runner
// ---------------------------------------------------------------------------------------------------------

const FIXTURE_OPERATORS: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
};

function isFixtureTestPath(path: string): boolean {
  return /(^|\/)tests?\//.test(path);
}

/**
 * The helpers whose meaning the corpus takes for granted when a fixture ships no source file for them (the
 * standalone `tests/assert.js` task only contains an assertion). This is the fixture's own convention, not a
 * guess about arbitrary code: a wrong expectation against `sum` must still be red.
 */
const FIXTURE_DEFAULT_HELPERS: Record<string, (a: number, b: number) => number> = {
  sum: (a, b) => a + b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
};

/**
 * Reads the fixture module's implementation: every source file in the corpus is
 * `export function name(a, b) { return a <op> b; }`. A source file that defines the function in a shape the
 * stand-in runner cannot read is reported as failing rather than guessed at; a function no source file
 * defines falls back to the corpus convention above.
 */
function fixtureImplementation(state: Record<string, string>, fnName: string): ((args: number[]) => number) | null {
  for (const [path, content] of Object.entries(state)) {
    if (isFixtureTestPath(path) || !path.endsWith(".js")) continue;
    const signature = new RegExp(`export\\s+function\\s+${fnName}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\)`).exec(content);
    if (!signature) continue;
    const body = /return\s+([A-Za-z_$][\w$]*)\s*([-+*/])\s*([A-Za-z_$][\w$]*)\s*;/.exec(content);
    if (!body) return null;
    const operator = FIXTURE_OPERATORS[body[2]!]!;
    const params = [signature[1]!, signature[2]!];
    return (args) => {
      const valueOf = (name: string): number => (name === params[0] ? args[0]! : name === params[1] ? args[1]! : Number.NaN);
      return operator(valueOf(body[1]!), valueOf(body[3]!));
    };
  }
  const fallback = FIXTURE_DEFAULT_HELPERS[fnName];
  return fallback ? (args) => fallback(args[0]!, args[1]!) : null;
}

/** Deterministic stand-in for the fixture's test runner (see the suite comment). */
function runFixtureTests(state: Record<string, string>): { exitCode: number; output: string } {
  const testFiles = Object.entries(state).filter(([path]) => isFixtureTestPath(path));
  const caseStart = /\b(?:test|it)(\.\s*(?:skip|only|todo))?\s*\(/g;
  const assertion = /expect\(\s*([A-Za-z_$][\w$]*)\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*\)\s*\.toBe\(\s*(-?\d+)\s*\)/g;
  const cases: Array<{ skipped: boolean; focused: boolean; body: string }> = [];
  for (const [, content] of testFiles) {
    const starts: Array<{ index: number; skipped: boolean; focused: boolean }> = [];
    for (const match of content.matchAll(caseStart)) {
      const modifier = match[1] ?? "";
      starts.push({ index: match.index ?? 0, skipped: /skip|todo/.test(modifier), focused: /only/.test(modifier) });
    }
    if (!starts.length) {
      cases.push({ skipped: false, focused: false, body: content });
      continue;
    }
    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1]!.index : content.length;
      cases.push({ skipped: start.skipped, focused: start.focused, body: content.slice(start.index, end) });
    });
  }
  // `.only` disables every case that is not focused — the reason the guard ranks it above `.skip`.
  const hasFocused = cases.some((entry) => entry.focused);
  let executed = 0;
  let failed = 0;
  for (const entry of cases) {
    if (entry.skipped || (hasFocused && !entry.focused)) continue;
    for (const match of entry.body.matchAll(assertion)) {
      const implementation = fixtureImplementation(state, match[1]!);
      executed += 1;
      const actual = implementation ? implementation([Number(match[2]), Number(match[3])]) : Number.NaN;
      if (actual !== Number(match[4])) failed += 1;
    }
  }
  // A suite with nothing left to run reports no failures, which is precisely why the guard cannot be replaced
  // by reading the exit code.
  const green = testFiles.length > 0 && failed === 0;
  return { exitCode: green ? 0 : 1, output: `fixture runner: files=${testFiles.length} executed=${executed} failed=${failed}` };
}

/**
 * The fixture's stand-in build: it reads the project's JSON configuration with the **real** `JSON.parse`, which
 * is what lets a build-repair task be verified by a command instead of by a string match. It compiles nothing
 * and is named a simulator for that reason; a repository with no build configuration at all fails, exactly as
 * a build with nothing to read would.
 */
function runFixtureBuild(state: Record<string, string>): { exitCode: number; output: string } {
  const configs = ["package.json", "tsconfig.json"].filter((path) => state[path] !== undefined);
  if (!configs.length) return { exitCode: 1, output: "fixture build: the repository has no build configuration" };
  for (const path of configs) {
    try {
      JSON.parse(state[path]!);
    } catch (error) {
      return { exitCode: 1, output: `fixture build: ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { exitCode: 0, output: `fixture build: parsed ${configs.join(", ")}` };
}

/** Node builtins a bare specifier may name without being a declared dependency (the fixture's own convention). */
const FIXTURE_NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path", "stream", "url", "util", "zlib",
]);

/**
 * The fixture's stand-in dependency check, in **both** directions: every bare specifier a source file imports
 * must be declared, and every declared dependency must be imported by some source file. That is the whole
 * content of a dependency migration — moving off a package means the import goes AND the declaration goes — so
 * it is what the migration tasks are verified against, and neither half can be satisfied alone.
 *
 * It is a simulator and says so: it scans `import`/`require` specifiers with a regular expression and reads the
 * manifest with `JSON.parse`. It resolves no package, knows no version and touches no registry.
 */
function runFixtureDepsCheck(state: Record<string, string>): { exitCode: number; output: string } {
  const manifest = state["package.json"];
  if (manifest === undefined) return { exitCode: 1, output: "fixture deps: the repository has no package.json" };
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(manifest) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  } catch (error) {
    return { exitCode: 1, output: `fixture deps: package.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const declared = new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]);
  const imported = new Set<string>();
  for (const [path, content] of Object.entries(state)) {
    if (!/\.(?:js|mjs|cjs|ts)$/.test(path)) continue;
    for (const match of content.matchAll(/\bimport\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g)) imported.add(match[1]!);
    for (const match of content.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) imported.add(match[1]!);
  }
  const isBare = (specifier: string): boolean =>
    !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !FIXTURE_NODE_BUILTINS.has(specifier);
  const undeclared = [...imported].filter(isBare).filter((specifier) => !declared.has(specifier)).sort();
  const unused = [...declared].filter((name) => !imported.has(name)).sort();
  const output = `fixture deps: undeclared=${undeclared.join(",") || "-"} unused=${unused.join(",") || "-"}`;
  return { exitCode: undeclared.length || unused.length ? 1 : 0, output };
}

/**
 * The fixture's whole command vocabulary. An unknown command is a **failure**, not a pass: a task naming a
 * command nothing simulates would otherwise be verified by a runner that does not exist. The corpus suite
 * asserts the fixture names only these three.
 */
function runFixtureCommand(state: Record<string, string>, command: string): { exitCode: number; output: string } {
  switch (command) {
    case "npm test":
      return runFixtureTests(state);
    case "npm run build":
      return runFixtureBuild(state);
    case "npm run deps:check":
      return runFixtureDepsCheck(state);
    default:
      return { exitCode: 1, output: `fixture runner: no simulator for '${command}'` };
  }
}

// ---------------------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------------------

/** Mutable in-memory workspace shared by the read port, the write port and the verification step. */
function inMemoryWorkspace(files: Record<string, string>) {
  const state: Record<string, string> = { ...files };
  const revisions = new Map<string, number>();
  const bump = (path: string): string => {
    const next = (revisions.get(path) ?? 0) + 1;
    revisions.set(path, next);
    return `r${next}`;
  };
  for (const path of Object.keys(state)) bump(path);
  const revision = (path: string) => `r${revisions.get(path) ?? 0}`;

  const read: CodeReadPort = {
    async listDir({ path }) {
      const entries = Object.keys(state)
        .filter((file) => (path === "." || path === "" ? true : file.startsWith(`${path}/`)))
        .map((file) => ({ path: file, type: "file" as const }));
      return { entries };
    },
    async readFile({ path, maxLines }) {
      const content = state[path];
      // A typed "not found" is what the runtime expects for a file that does not exist yet (so creating a
      // new file is allowed); an untyped throw looks like an infrastructure failure and refuses the write.
      if (content === undefined) throw Object.assign(new Error(`file not found: ${path}`), { code: "ENOENT" });
      const lines = content.split("\n");
      const digest = sha256Hex(content);
      return {
        path,
        content: lines.slice(0, maxLines).join("\n"),
        // Content-addressed revision: the read tracker and the write freshness check must agree on the
        // same value, otherwise an honest read-then-edit sequence is refused as "changed since read".
        revision: digest,
        sha256: digest,
        totalLines: lines.length,
        truncated: lines.length > maxLines,
      };
    },
    async runSearch({ query, maxResults }) {
      const matches = Object.entries(state)
        .flatMap(([path, content]) => content.split("\n").map((text, index) => ({ path, line: index + 1, text })))
        .filter((entry) => entry.text.includes(query))
        .slice(0, maxResults);
      return { matches, truncated: false };
    },
  };

  const write: CodeWritePort = {
    // Revisions are content-addressed, matching the read port: a caller that read revision R may write only
    // while the content still hashes to R (the same lost-update protection the workspace enforces).
    async writeFile({ path, content, expectedRevision }) {
      const current = state[path];
      if (current !== undefined && expectedRevision !== sha256Hex(current)) throw new Error("revision_conflict");
      state[path] = content;
      return { path, revision: sha256Hex(content), sha256: sha256Hex(content) };
    },
    async createFile({ path, content }) {
      state[path] = content;
      return { path, revision: sha256Hex(content), sha256: sha256Hex(content) };
    },
    async editFile({ path, find, replacement, expectedRevision }) {
      const current = state[path];
      if (current === undefined) throw new Error("file not found");
      if (expectedRevision && expectedRevision !== sha256Hex(current)) throw new Error("revision_conflict");
      if (!current.includes(find)) throw new Error("find_not_found");
      const next = current.replace(find, replacement);
      state[path] = next;
      return { path, revision: sha256Hex(next), sha256: sha256Hex(next) };
    },
    async moveFile({ from, to }) {
      const content = state[from] ?? "";
      state[to] = content;
      delete state[from];
      return { path: to, revision: sha256Hex(content), sha256: sha256Hex(content) };
    },
    async deleteFile({ path }) {
      delete state[path];
    },
  };

  return { state, read, write };
}

async function evalHarness(task: EvalTask, options: { model?: string } = {}) {
  const { state, read, write } = inMemoryWorkspace(task.files);
  const workspace = new InMemoryWorkspaceStore();
  await workspace.initialize();
  const company = await workspace.createCompany(owner, { name: "C6 eval" }, `c6-eval-${task.id}`);
  const runtime = new CodeToolRuntime({
    flags: allowAll,
    store: workspace,
    schemas: CODE_TOOL_SCHEMAS,
    // NOTE: read-before-write enforcement (C3) is deliberately NOT configured here. That gate belongs to
    // `coding-agent-c3-*` suites; this harness measures the loop, the real tool path and post-run
    // verification, and the scripts still read every file before touching it so the transcripts stay honest.
    toPort: () => read,
    writePort: write,
    limits: { readFileLines: 200, toolOutputChars: 20_000 },
    // A real write path always creates a per-turn checkpoint before the first write (C3); the eval supplies
    // an in-memory checkpoint port so the production sequencing (checkpoint → write → verify) is exercised.
    checkpoints: {
      async create({ sessionId, turnId }) {
        return { checkpointId: `cp-${sessionId}-${turnId}`, commitHash: null };
      },
      async restore({ checkpointId }) {
        return { restoredCheckpointId: checkpointId, backupCheckpointId: null };
      },
      async diff() {
        return { diff: "" };
      },
    },
    executors: {
      ...canonicalExecutors({}),
      // The eval measures the loop, not the approval flow (SG-2 covers approvals), so writes are pre-approved.
      ...canonicalWriteExecutors({ approved: true }),
      ...canonicalShellExecutors({}),
      ...canonicalDepsExecutors({}),
    },
  });
  // Deterministic per-step usage, reported as a split that adds up: `costUsd` is only computable when the
  // prompt/completion split is known, so the harness supplies one instead of a bare total (the un-split case is
  // a negative control in the C14 suite).
  let usageIndex = 0;
  return {
    state,
    company,
    invokeTool: async ({ tool, args, toolCallId, turn }: { tool: string; args?: unknown; toolCallId: string; step: number; turn: number }) => {
      // One turn per task: read-before-write (C3) is scoped to a turn, exactly like the real runner, which
      // reads a file and then edits it inside the same turn.
      const result = await runtime.invoke(owner, { companyId: company.id, projectId: "p-eval", sessionId: "s-eval", tool, args, toolCallId, turnId: `turn-${turn}` });
      return result.ok ? { ok: true as const } : { ok: false as const, error: { code: result.error.code } };
    },
    runCommand: async (command: string) => runFixtureCommand(state, command),
    files: () => state,
    usage: () => {
      usageIndex += 1;
      const completionTokens = 10;
      const promptTokens = 30 + usageIndex;
      return { tokens: promptTokens + completionTokens, promptTokens, completionTokens };
    },
    // The price comes from the project's own price configuration, so the eval cost and the production telemetry
    // cost are computed from one table. A model the table does not price yields `null`, never a made-up number.
    price: () => configuredModelPricing(options.model ?? PRICED_EVAL_MODEL),
  };
}

/** A model the project's price table really prices, so the cost metric is a computation rather than a claim. */
const PRICED_EVAL_MODEL = "anthropic/claude-3-5-sonnet";

/** Runs one task through the real runtime and throws with the harness's reason when it is not green. */
async function runOne(task: EvalTask) {
  const report = await runEvalSuite([task], await evalHarness(task));
  return report.tasks[0]!;
}

function fixtureTask(id: string): EvalTask {
  const task = loadFixture().find((entry) => entry.id === id);
  if (!task) throw new Error(`fixture task ${id} is missing`);
  return task;
}

describe("security-gate: C6/C9/C14 eval harness runs the thirty-three deterministic tasks", () => {
  it("passes all thirty-three fixture tasks through the real tool runtime", async () => {
    const tasks = loadFixture();
    // Exact count and exact ids: the corpus is a contract, so a task that silently disappears (or a renamed
    // id) fails here instead of shrinking the evidence.
    expect(tasks).toHaveLength(33);
    expect(tasks.map((task) => task.id)).toEqual([
      "fix-bug-arithmetic",
      "add-function-multiply",
      "refactor-rename-parser",
      "write-unit-test",
      "fix-build-config",
      "fix-failing-test",
      "fix-typescript-type",
      "update-tsconfig",
      "repair-after-failing-check",
      "repair-limit-exhausted-stops",
      "weakened-test-skip-reported",
      "deleted-test-reported",
      "deleted-test-case-reported",
      "focused-test-reported",
      "added-test-not-flagged",
      "self-review-finds-secret",
      "self-review-flags-unrelated-change",
      "python-fix-bug-average",
      "python-feature-clamp",
      "python-refactor-extract-helper",
      "python-tests-add-case",
      "python-multi-file-package",
      "go-fix-bug-off-by-one",
      "go-feature-multiply",
      "go-tests-add-case",
      "typescript-feature-optional-param",
      "typescript-refactor-extract-type",
      "typescript-multi-file-rename-export",
      "build-repair-broken-manifest",
      "build-repair-tsconfig-trailing-comma",
      "dep-migration-replace-left-pad",
      "dep-migration-drop-dead-dependency",
      "javascript-feature-parse-args",
    ]);
    const fixture = loadFixtureFile();
    expect(fixture.schemaVersion).toBe(CODE_EVAL_SCHEMA_VERSION);
    const report = await runEvalSuite(tasks, await evalHarness(tasks[0]!));
    // Each task needs its own workspace: build one harness per task and assert the whole suite.
    const perTask = [];
    for (const task of tasks) perTask.push(await runEvalSuite([task], await evalHarness(task)));
    expect(report.mode).toBe("recorded");
    for (const single of perTask) {
      const result = single.tasks[0]!;
      // Throwing keeps the failure reason visible in every runner (including the CI harness shim).
      if (!result.ok) throw new Error(`eval task ${result.id} failed: ${result.reason ?? "unknown"}`);
    }
    const results = perTask.map((single) => single.tasks[0]!);
    const combined = {
      schemaVersion: CODE_EVAL_SCHEMA_VERSION,
      mode: "recorded" as const,
      tasks: results,
      totals: {
        tasks: results.length,
        passed: results.length,
        failed: 0,
        steps: results.reduce((sum, result) => sum + result.steps, 0),
        turns: results.reduce((sum, result) => sum + result.turns, 0),
        checks: results.reduce((sum, result) => sum + result.checks, 0),
        tokens: results.reduce((sum, result) => sum + result.tokens, 0),
        durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
        diffStats: {
          files: results.reduce((sum, result) => sum + result.diffStats.files, 0),
          linesAdded: results.reduce((sum, result) => sum + result.diffStats.linesAdded, 0),
          linesRemoved: results.reduce((sum, result) => sum + result.diffStats.linesRemoved, 0),
        },
        costUsd: Number(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toFixed(6)),
        costUnavailableTasks: results.filter((result) => result.costUsd === null).length,
      },
    };
    expect(evalReportIsGreen(combined)).toBe(true);
    expect(combined.totals.steps).toBeGreaterThanOrEqual(results.length * 2);
    // Exact: twenty-two `check` steps (fourteen C9 plus eight C14) and no more, so a task that stops recording
    // its own failures cannot hide behind the aggregate.
    expect(combined.totals.checks).toBe(22);
    expect(combined.totals.tokens).toBeGreaterThan(0);
    // C14 scoring: every task really changed something, the change set is counted, the transcript has turns and
    // the cost is a computed number from a priced model (not a placeholder and not `null`).
    expect(results.filter((result) => result.diffStats.files < 1)).toEqual([]);
    expect(combined.totals.diffStats.linesAdded).toBeGreaterThan(0);
    expect(combined.totals.diffStats.linesRemoved).toBeGreaterThan(0);
    expect(combined.totals.turns).toBeGreaterThanOrEqual(results.length);
    expect(combined.totals.costUnavailableTasks).toBe(0);
    expect(combined.totals.costUsd).toBeGreaterThan(0);
    // The aggregate the C14 documentation quotes, pinned so the table cannot drift away from the run. `steps`
    // counts every transcript step, `turns` only the model turns (80 tool calls are grouped into fewer turns),
    // and `costUsd` is the price table applied to the tokens — `durationMs` is deliberately not pinned, since
    // wall-clock time is not a property of the corpus.
    expect({
      steps: combined.totals.steps,
      turns: combined.totals.turns,
      checks: combined.totals.checks,
      tokens: combined.totals.tokens,
      diffStats: combined.totals.diffStats,
      costUsd: combined.totals.costUsd,
    }).toEqual({
      steps: 135,
      turns: 49,
      checks: 22,
      tokens: 3357,
      diffStats: { files: 42, linesAdded: 80, linesRemoved: 43 },
      costUsd: 0.019671,
    });
  });

  /**
   * C14 (owner decision 4): the SLO calibration of **this** run.
   *
   * The numbers below are not a copy of R1's starting table: they are read off the thirty-three task results the
   * test above already produced through the real tool path, and they are the only measurements of the corpus
   * that exist. Three kinds of claim are kept apart on purpose, because collapsing them is exactly what the
   * owner's instruction forbids:
   *
   *  - **measured** — turns, tokens, cost and the change set, per task and per task kind, pinned with the
   *    nearest-rank statistic the calibration module names in every answer;
   *  - **not_measured** — the R1 targets this corpus has no source for (sandbox start, queue wait, tool error
   *    rate, recovery, provider fallback, run latency, approvals share, quota use, production cost median). The
   *    suite asserts they are refused *and* asserts the mechanism that makes them unmeasurable here, so the
   *    refusal rests on a fact about the corpus rather than on a preference;
   *  - **proposed** — the thresholds the measurement does support, asserted equal to the shipped configuration
   *    so a default cannot silently drift away from the calibration it claims to come from.
   */
  it("calibrates the SLO thresholds from this run, and refuses the R1 targets the corpus cannot measure", async () => {
    const tasks = loadFixture();
    const perTask = [];
    for (const task of tasks) perTask.push(await runEvalSuite([task], await evalHarness(task)));
    const results = perTask.map((single) => single.tasks[0]!);
    const combined: EvalReport = {
      schemaVersion: CODE_EVAL_SCHEMA_VERSION,
      mode: "recorded",
      tasks: results,
      totals: {
        tasks: results.length,
        passed: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        steps: results.reduce((sum, result) => sum + result.steps, 0),
        turns: results.reduce((sum, result) => sum + result.turns, 0),
        checks: results.reduce((sum, result) => sum + result.checks, 0),
        tokens: results.reduce((sum, result) => sum + result.tokens, 0),
        durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
        diffStats: {
          files: results.reduce((sum, result) => sum + result.diffStats.files, 0),
          linesAdded: results.reduce((sum, result) => sum + result.diffStats.linesAdded, 0),
          linesRemoved: results.reduce((sum, result) => sum + result.diffStats.linesRemoved, 0),
        },
        costUsd: Number(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toFixed(6)),
        costUnavailableTasks: results.filter((result) => result.costUsd === null).length,
      },
    };

    const calibration = buildSloCalibration({ report: combined, tasks });
    expect(calibration.schemaVersion).toBe(SLO_CALIBRATION_SCHEMA_VERSION);
    expect(calibration.percentileMethod).toBe("nearest_rank");
    // The calibration reads the same aggregate the test above pins — one run, one set of numbers.
    expect(calibration.corpus).toEqual({
      tasks: 33,
      passed: 33,
      failed: 0,
      steps: 135,
      turns: 49,
      checks: 22,
      tokens: 3357,
      toolCalls: 80,
      costUsd: 0.019671,
      costUnavailableTasks: 0,
      diffStats: { files: 42, linesAdded: 80, linesRemoved: 43 },
    });
    expect(calibration.unjoinedResults).toBe(0);
    expect(calibration.byTaskType.every((group) => group.sampleSize > 0)).toBe(true);

    const measured = (quantity: string) => {
      const found = calibration.overall.find((entry) => entry.quantity === quantity);
      if (!found) throw new Error(`no measured distribution for ${quantity}`);
      return found;
    };
    // The real distributions, measured over all thirty-three tasks. `sum` is included so a shifted median
    // cannot pass while the total stays wrong.
    expect({
      steps: [measured("steps").median, measured("steps").p95, measured("steps").max, measured("steps").sum],
      turns: [measured("turns").median, measured("turns").p95, measured("turns").max, measured("turns").sum],
      toolCalls: [measured("tool_calls").median, measured("tool_calls").p95, measured("tool_calls").max],
      checks: [measured("checks").median, measured("checks").p95, measured("checks").max, measured("checks").sum],
      tokens: [measured("tokens").median, measured("tokens").p95, measured("tokens").max, measured("tokens").sum],
      cost: [measured("cost_usd").median, measured("cost_usd").p95, measured("cost_usd").max, measured("cost_usd").sum],
      changeSet: [
        measured("diff_files").median,
        measured("diff_files").p95,
        measured("diff_files").max,
        measured("diff_files").sum,
        measured("diff_lines_added").sum,
        measured("diff_lines_removed").sum,
      ],
    }).toEqual({
      steps: [3, 9, 10, 135],
      turns: [1, 3, 4, 49],
      toolCalls: [2, 5, 7],
      checks: [0, 2, 4, 22],
      tokens: [83, 215, 308, 3357],
      // The median task costs 0.000489 USD and the 95th percentile 0.001245; the largest task in the corpus is
      // 0.001764, which is 3.61x the median — the fact the R1 cost alert is checked against below.
      cost: [0.000489, 0.001245, 0.001764, 0.019671],
      changeSet: [1, 3, 4, 42, 80, 43],
    });
    // Every measured quantity is over the whole corpus, and the wall clock is measured but refused as an SLO.
    for (const entry of calibration.overall) {
      expect(entry.sampleSize).toBe(33);
      expect(entry.unavailable).toBeUndefined();
    }
    expect(measured("duration_ms").usableForSlo).toBe(false);
    expect(measured("duration_ms").note).toContain("wall clock");

    // By task kind: the two-task groups are where a p95 stops being a percentile (rank = ceil(0.95 * 2) = 2, the
    // maximum), which is the measured reason the population floor exists at all.
    const kindOf = (taskType: string) => {
      const group = calibration.byTaskType.find((entry) => entry.taskType === taskType);
      if (!group) throw new Error(`no group for ${taskType}`);
      const pick = (quantity: string) => group.distributions.find((entry) => entry.quantity === quantity)!;
      return group;
    };
    const bugFix = kindOf("bug_fix");
    expect(bugFix.sampleSize).toBe(12);
    expect([bugFix.distributions[1]!.median, bugFix.distributions[1]!.p95, bugFix.distributions[1]!.max]).toEqual([1, 4, 4]);
    expect([bugFix.distributions[2]!.median, bugFix.distributions[2]!.p95]).toEqual([83, 170]);
    const migration = kindOf("dependency_migration");
    expect(migration.sampleSize).toBe(2);
    expect([migration.distributions[0]!.median, migration.distributions[0]!.max]).toEqual([5, 10]);
    expect([migration.distributions[2]!.median, migration.distributions[2]!.p95, migration.distributions[2]!.max]).toEqual([83, 308, 308]);

    // -----------------------------------------------------------------------------------------------------
    // proposed: derived from the measurements above, and equal to the shipped configuration
    // -----------------------------------------------------------------------------------------------------
    const proposalOf = (target: string) => {
      const found = calibration.proposed.find((entry) => entry.target === target);
      if (!found) throw new Error(`no proposal for ${target}`);
      if (found.status !== "proposed") throw new Error(`proposal ${target} is ${found.status}: ${found.reason}`);
      return found;
    };
    // 4x the largest measured transcript (10 steps) is exactly the shipped step limit.
    const steps = proposalOf("code.agent.maxStepsPerRun");
    expect(steps.value).toBe(40);
    expect(steps.basis).toBe("measured");
    expect(steps.appliedTo).toEqual({ quantity: "steps", statistic: "max", measured: 10, sampleSize: 33, headroomMultiplier: 4 });
    expect(steps.value).toBe(DEFAULT_CODE_AGENT_LIMITS.maxStepsPerRun);
    // R1's cost multiple is kept, with what it does to the measured population reported beside it: it flags the
    // single largest task in the corpus (0.001764 > 3 x 0.000489 = 0.001467), which is a discriminating rule.
    const cost = proposalOf("code.anomaly.costMedianMultiplier");
    expect(cost.value).toBe(3);
    expect(cost.basis).toBe("r1_reference");
    expect(cost.appliedTo?.measured).toBe(0.000489);
    expect(cost.measuredEffect).toEqual({ crossed: 1, sampleSize: 33, share: Number((1 / 33).toFixed(6)) });
    expect(cost.value).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.costMedianMultiplier);
    // No R1 number exists for turns, so the measured p95 supplies it: one multiplier places the alert exactly on
    // the 95th percentile, and the corpus's own largest run (4 turns) is the only one above it.
    const turns = proposalOf("code.anomaly.turnP95Multiplier");
    expect(turns.value).toBe(1);
    expect(turns.basis).toBe("measured");
    expect(turns.appliedTo?.measured).toBe(3);
    expect(turns.measuredEffect).toEqual({ crossed: 1, sampleSize: 33, share: Number((1 / 33).toFixed(6)) });
    expect(turns.value).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.turnP95Multiplier);
    // The population floor is derived from the smallest group the corpus really has (two tasks), not chosen.
    const floor = proposalOf("code.anomaly.minPopulationSamples");
    expect(floor.value).toBe(5);
    expect(floor.appliedTo?.measured).toBe(2);
    expect(floor.value).toBe(DEFAULT_CODE_ANOMALY_THRESHOLDS.minPopulationSamples);

    // -----------------------------------------------------------------------------------------------------
    // not_measured: the R1 targets with no corpus source, and the mechanism that makes them unmeasurable
    // -----------------------------------------------------------------------------------------------------
    expect(calibration.notMeasured.map((entry) => entry.code)).toEqual(notMeasuredSloTargets().map((entry) => entry.code));
    expect(calibration.notMeasured).toHaveLength(10);
    expect(calibration.notMeasured.find((entry) => entry.code === "slo.tool_error_rate")?.reason).toContain("expectError");
    // The fact behind that refusal, measured: the corpus contains no failing-call sample at all — every tool call
    // it makes succeeds, and not one step declares an expected error.
    const toolCalls = results.reduce((sum, result) => sum + result.toolCalls, 0);
    const declaredErrors = tasks.reduce((sum, task) => sum + task.script.filter((step) => step.kind === "tool" && step.expectError).length, 0);
    expect(toolCalls).toBe(80);
    expect(declaredErrors).toBe(0);
    expect(results.every((result) => result.failures === 0)).toBe(true);
    // …which is why the tool-error threshold, the run-minute budget and the two run budgets are all refused
    // rather than dressed up with a corpus number three orders of magnitude below the shipped value.
    for (const target of ["code.anomaly.toolErrorRate", "code.agent.maxRunMinutes", "code.runBudget.maxTokens", "code.runBudget.maxCostUsd", "code.agent.maxChangedFiles"]) {
      const entry = calibration.proposed.find((candidate) => candidate.target === target)!;
      expect(entry.status).toBe("not_measured");
      expect(entry.value).toBeNull();
    }
    // R1's 5% is still the shipped threshold: unconfirmed here, not discarded.
    expect(DEFAULT_CODE_ANOMALY_THRESHOLDS.toolErrorRate).toBe(0.05);
    // The corpus is a floor, so the values it cannot justify are reported, not adopted: the costliest corpus task
    // is three orders of magnitude below the shipped per-run budget, and the largest change set is 4 files
    // against a 25-file scope warning. That divergence is the conclusion, and the shipped values stand.
    expect(measured("cost_usd").max).toBeLessThan(DEFAULT_CODE_RUN_BUDGET.maxCostUsd / 100);
    expect(measured("tokens").max).toBeLessThan(DEFAULT_CODE_RUN_BUDGET.maxTokens / 100);
    expect(measured("diff_files").max).toBeLessThan(DEFAULT_CODE_AGENT_LIMITS.maxChangedFiles);

    // -----------------------------------------------------------------------------------------------------
    // The anomaly detector on the measured population: it fires on it, and it does not fire inside it
    // -----------------------------------------------------------------------------------------------------
    const population = anomalyPopulationFrom({
      costUsd: results.map((result) => result.costUsd),
      turns: results.map((result) => result.turns),
      source: "the eval corpus run above",
    });
    expect(population.cost.sampleSize).toBe(33);
    expect(population.cost.median).toBe(0.000489);
    expect(population.turns.p95).toBe(3);
    const thresholds = resolveCodeAnomalyThresholds({});
    // The corpus's own p95 cost and p95 turns: inside every rule, and judged rather than skipped.
    const inside = evaluateCodeRunAnomaly(
      codeRunAnomalyFactsFromSummary("run-corpus-p95", { turns: 3, tokens: 215, toolCalls: 5, costUsd: 0.001245 }, 0),
      population,
      thresholds,
    );
    expect(inside.status).toBe("evaluated");
    expect(inside.anomalous).toBe(false);
    expect(inside.notEvaluated).toEqual([]);
    // The corpus's largest task plus one turn: anomalous on both measured rules, and named.
    const outside = evaluateCodeRunAnomaly(
      codeRunAnomalyFactsFromSummary("run-corpus-max", { turns: 4, tokens: 308, toolCalls: 7, costUsd: 0.001764 }, 0),
      population,
      thresholds,
    );
    expect(outside.status).toBe("evaluated");
    expect(outside.anomalous).toBe(true);
    expect(outside.findings.map((finding) => finding.code)).toEqual(["cost_above_median_multiple", "turns_above_p95_multiple"]);
    expect(outside.findings[0]!.threshold).toBe(0.001467);
    expect(outside.findings[1]!.threshold).toBe(3);
    // A rule that could not run is not a pass: with no population at all the same run is `unavailable`.
    const unmeasurable = evaluateCodeRunAnomaly(
      codeRunAnomalyFactsFromSummary("run-corpus-max", { turns: 4, tokens: 308, toolCalls: 0, costUsd: 0.001764 }, 0),
      anomalyPopulationFrom({ costUsd: [], turns: [], source: "no runs" }),
      thresholds,
    );
    expect(unmeasurable.status).toBe("unavailable");
    expect(unmeasurable.anomalous).toBeNull();
  });

  it("fails a task whose transcript does not actually fix anything (negative control)", async () => {    const task = loadFixture()[0]!;
    const broken: EvalTask = { ...task, script: [{ kind: "message", text: "I think it is fine." }] };
    const report = await runEvalSuite([broken], await evalHarness(broken));
    expect(report.tasks[0]!.ok).toBe(false);
    expect(report.tasks[0]!.reason).toContain("verify_content_mismatch");
    expect(evalReportIsGreen(report)).toBe(false);
    // The scores stay honest in the failing direction too: a run that changed nothing reports an empty change
    // set and zero turns, not the corpus average.
    expect(report.tasks[0]!.diffStats).toEqual({ files: 0, linesAdded: 0, linesRemoved: 0 });
    expect(report.tasks[0]!.turns).toBe(1);
    expect(report.tasks[0]!.toolCalls).toBe(0);
  });

  it("fails when a tool call in the script errors, and reports which tool failed", async () => {
    const task = loadFixture()[0]!;
    const failing: EvalTask = { ...task, script: [{ kind: "tool", tool: "code.fs.nope", args: {} }, { kind: "message", text: "done" }] };
    const report = await runEvalSuite([failing], await evalHarness(failing));
    expect(report.tasks[0]!.ok).toBe(false);
    expect(report.tasks[0]!.reason).toContain("tool_failed:code.fs.nope");
  });

  it("supports asserted failures so a refused tool call is a pass, not an error", async () => {
    const task = loadFixture()[0]!;
    const withRefusal: EvalTask = {
      ...task,
      script: [
        { kind: "tool", tool: "code.fs.nope", args: {}, expectError: "unknown_tool" },
        { kind: "tool", tool: "code.fs.read", args: { path: "src/sum.js" } },
        { kind: "tool", tool: "code.fs.edit", args: { path: "src/sum.js", old_string: "return a - b;", new_string: "return a + b;" } },
      ],
    };
    const report = await runEvalSuite([withRefusal], await evalHarness(withRefusal));
    const asserted = report.tasks[0]!;
    if (!asserted.ok) throw new Error(`asserted-failure task failed: ${asserted.reason ?? "unknown"}`);
    expect(asserted.ok).toBe(true);
  });

  it("stops a task that exceeds its step budget instead of looping forever", async () => {
    const task = loadFixture()[0]!;
    const looping: EvalTask = {
      ...task,
      maxSteps: 2,
      script: [{ kind: "message", text: "a" }, { kind: "message", text: "b" }, { kind: "message", text: "c" }],
    };
    const report = await runEvalSuite([looping], await evalHarness(looping));
    expect(report.tasks[0]!.ok).toBe(false);
    expect(report.tasks[0]!.reason).toContain("max_steps_exceeded");
  });

  it("refuses a live run without a live model and never silently reuses recorded answers", async () => {
    const task = loadFixture()[0]!;
    await expect(runEvalSuite([task], await evalHarness(task), { mode: "live" })).rejects.toMatchObject({ code: "eval_live_model_missing" });
    expect(resolveEvalMode({})).toBe("recorded");
    expect(resolveEvalMode({ NPATI_CODE_EVAL_LIVE: "1" })).toBe("live");
    expect(resolveEvalMode({ NPATI_CODE_EVAL_LIVE: "true" })).toBe("recorded");
  });

  it("rejects malformed fixtures and empty suites instead of skipping them", async () => {
    expect(() => loadEvalTasks([{ id: "x" }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks({} as unknown)).toThrow(/eval_fixture_invalid/);
    await expect(runEvalSuite([], await evalHarness(loadFixture()[0]!))).rejects.toMatchObject({ code: "eval_no_tasks" });
    // A verification kind that does not exist is a typo that would otherwise verify nothing at all.
    const task = loadFixture()[0]!;
    expect(() => loadEvalTasks([{ ...task, verify: { type: "looks_about_right" } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: { type: "test_integrity", expect: "maybe" } }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, script: [{ kind: "check", command: "npm test", expect: "green" }] }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, script: [{ kind: "wish", text: "please pass" }] }])).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalTasks([{ ...task, verify: [] }])).toThrow(/eval_fixture_invalid/);
  });

  it("keeps every scripted step a legal tool call shape and uses only the fixture's three simulated commands", () => {
    const tasks = loadFixture();
    const names = new Set(CODE_TOOL_SCHEMAS.map((schema) => schema.name));
    const commands = new Set<string>();
    for (const task of tasks) {
      for (const step of task.script as EvalStep[]) {
        if (step.kind === "tool") {
          expect(names.has(step.tool), `${task.id} uses unknown tool ${step.tool}`).toBe(true);
          continue;
        }
        if (step.kind === "check") commands.add(step.command);
      }
      for (const verification of verificationList(task)) {
        if (verification.type === "command_succeeds" || verification.type === "command_fails") commands.add(verification.command);
      }
    }
    // Three commands, and every one of them is a simulator wired up below (`runFixtureCommand`): the regex test
    // runner, the JSON-parse build and the two-directional dependency check. The list is exact on purpose — a
    // task inventing a fourth command would be checked by a runner no test wires up, which is the same as not
    // being checked — and anything outside the list is answered with a failure, never with a silent pass.
    expect([...commands].sort()).toEqual(["npm run build", "npm run deps:check", "npm test"]);
  });
});

describe("security-gate: C14 eval corpus — coverage, hermeticity and the limits of the simulators", () => {
  it("covers all seven task kinds and every declared language, with the metadata declared as data", () => {
    const tasks = loadFixture();
    expect(tasks.length).toBeGreaterThanOrEqual(30);
    // Every task declares its kind and language (the loader keeps them optional so old fixtures stay valid;
    // the shipped corpus may not use that escape hatch), and both values are from the closed vocabularies.
    expect(tasks.filter((task) => task.taskType === undefined || task.language === undefined)).toEqual([]);
    const kinds = new Set<string>(tasks.map((task) => task.taskType ?? ""));
    const languages = new Set<string>(tasks.map((task) => task.language ?? ""));
    for (const kind of EVAL_TASK_KINDS) expect(kinds.has(kind), `no task covers ${kind}`).toBe(true);
    // Four programming languages plus JSON configuration. This is a statement about the fixture text: the
    // simulators understand JavaScript/TypeScript expressions and nothing else (see the next test).
    expect(["javascript", "typescript", "python", "go", "json"].filter((language) => !languages.has(language))).toEqual([]);
    for (const language of languages) expect(EVAL_LANGUAGES).toContain(language);
  });

  it("proves hermeticity from the data: file tools only, three simulated commands, no endpoint", async () => {
    const tasks = loadFixture();
    const toolNames = new Set<string>();
    for (const task of tasks) {
      for (const step of task.script as EvalStep[]) if (step.kind === "tool") toolNames.add(step.tool);
      // No fixture file names a network endpoint, so no task can smuggle in a fetch even by accident.
      for (const [path, content] of Object.entries(task.files)) {
        expect(/https?:\/\//.test(content), `${task.id}/${path} names a network endpoint`).toBe(false);
      }
    }
    // Exactly the file tools: no shell, no process control, no dependency installation, no git, no MCP and no
    // sub-agent. A task that needs one of those is not hermetic and cannot be added by accident — it has to
    // change this list, which is the review point.
    expect([...toolNames].sort()).toEqual([
      "code.fs.apply_patch",
      "code.fs.edit",
      "code.fs.move",
      "code.fs.read",
      "code.fs.write",
    ]);
    // The commands are the simulators `runFixtureCommand` implements, and the simulator itself never spawns a
    // process: it is the same function the tool path is measured with, so "no process" is structural here.
    const simulated = runFixtureCommand({}, "docker run alpine");
    expect(simulated.exitCode).toBe(1);
    expect(simulated.output).toContain("no simulator");
  });

  it("gives the Python and Go tasks no command at all, because no simulator reads those languages", () => {
    for (const task of loadFixture()) {
      if (task.language !== "python" && task.language !== "go") continue;
      for (const step of task.script as EvalStep[]) {
        expect(step.kind === "check", `${task.id} runs a check the simulator cannot honour`).toBe(false);
      }
      for (const verification of verificationList(task)) {
        // `file_contains`/`diff_stats` judge the change set, which is what a hermetic run can honestly claim
        // about a language no simulator understands — it never claims the code was executed.
        expect(["file_contains", "diff_stats"]).toContain(verification.type);
      }
    }
  });
});

describe("security-gate: C9 eval corpus — the loop, the guards and the schema are all verifiable from data", () => {
  it("keeps the eight C6 tasks valid verbatim under schema 2 and refuses an unknown schema", async () => {
    const fixture = loadFixtureFile();
    // The C6 eight are exactly the tasks that use neither the C9 `check` step nor a C9 verification kind.
    const schemaOneTasks = fixture.tasks.filter((task) =>
      task.script.every((step) => step.kind !== "check")
      && verificationList(task).every((verification) => verification.type === "file_contains" || verification.type === "command_succeeds"));
    expect(schemaOneTasks).toHaveLength(8);
    const legacy = loadEvalFixture({ schemaVersion: 1, description: "C6 corpus", tasks: schemaOneTasks });
    expect(legacy.schemaVersion).toBe(1);
    for (const task of legacy.tasks) {
      const result = await runOne(task);
      if (!result.ok) throw new Error(`schema-1 task ${task.id} failed: ${result.reason ?? "unknown"}`);
    }
    // Additive means a newer fixture is refused rather than half-read (the field that silently disappears is
    // the verification nobody runs), and a missing version is not "version 1 by accident".
    expect(() => loadEvalFixture({ schemaVersion: CODE_EVAL_SCHEMA_VERSION + 1, tasks: [] })).toThrow(/eval_fixture_version_unsupported/);
    expect(() => loadEvalFixture({ schemaVersion: 0, tasks: [] })).toThrow(/eval_fixture_version_unsupported/);
    expect(() => loadEvalFixture({ tasks: [] })).toThrow(/eval_fixture_invalid/);
    expect(() => loadEvalFixture({ schemaVersion: 2, tasks: [{ id: "x" }] })).toThrow(/eval_fixture_invalid/);
  });

  it("fails a check step whose expected status did not happen, in both directions", async () => {
    const task = fixtureTask("repair-after-failing-check");
    // The repo is red, so a task claiming a green check is claiming a check that never happened.
    const optimistic: EvalTask = { ...task, script: [{ kind: "check", command: "npm test", expect: "pass" }] };
    const failed = await runOne(optimistic);
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain("check_failed:npm test");

    // The mirror: demanding a failure from a repository that already passes is equally untrue.
    const green: EvalTask = {
      ...task,
      files: {
        "src/sum.js": "export function sum(a, b) {\n  return a + b;\n}\n",
        "tests/sum.test.js": "import { sum } from \"../src/sum.js\";\n\ntest(\"sum adds two numbers\", () => {\n  expect(sum(2, 3)).toBe(5);\n});\n",
      },
      script: [{ kind: "check", command: "npm test", expect: "fail" }],
      verify: { type: "command_succeeds", command: "npm test" },
    };
    const mirrored = await runOne(green);
    expect(mirrored.ok).toBe(false);
    expect(mirrored.reason).toContain("check_unexpectedly_passed:npm test");
  });

  it("replays the run's own checks through the real verification loop, so the budget is not decorative", async () => {
    // The corpus task pins the property (three repairs, then the stop code). Here the same recorded checks are
    // replayed against a different budget: a limit of one must change the answer, or the number is decoration.
    const task = fixtureTask("repair-limit-exhausted-stops");
    const tightened: EvalTask = {
      ...task,
      verify: { type: "repair_loop", maxAttempts: 1, expect: { repairs: 3, stopCode: VERIFICATION_REPAIR_EXHAUSTED } },
    };
    const result = await runOne(tightened);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verify_repair_loop_repairs:1!=3");

    // A budget task with no recorded check cannot claim anything about the budget.
    const unrecorded: EvalTask = { ...task, script: [{ kind: "message", text: "I think it is fine." }] };
    const empty = await runOne(unrecorded);
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain("verify_repair_loop_no_checks");
  });

  it("reports a green suite over a weakened test set and refuses to accept a clean claim", async () => {
    // The corpus task is the positive direction: the suite really is green (the failing case was skipped) and
    // the real guard still calls it a weakened change.
    const skipped = await runOne(fixtureTask("weakened-test-skip-reported"));
    if (!skipped.ok) throw new Error(`skip task failed: ${skipped.reason ?? "unknown"}`);
    expect(skipped.checks).toBe(2);

    // The negative direction: a task that insists the change is clean must FAIL on that claim, not be rounded
    // up — otherwise `test_integrity` would be a rubber stamp.
    const task = fixtureTask("weakened-test-skip-reported");
    const optimistic: EvalTask = { ...task, verify: { type: "test_integrity", expect: "clean" } };
    const result = await runOne(optimistic);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verify_test_integrity_flagged:test_skipped");

    // And a named finding kind that the guard did not report is a failure too.
    const wrongKind: EvalTask = { ...task, verify: { type: "test_integrity", expect: "flagged", kinds: ["assert_weakened"] } };
    const kindResult = await runOne(wrongKind);
    expect(kindResult.ok).toBe(false);
    expect(kindResult.reason).toContain("verify_test_integrity_kind_missing:assert_weakened");

    // Adding coverage is not weakening: the guard must stay quiet, which is what keeps it believable.
    const added = await runOne(fixtureTask("added-test-not-flagged"));
    if (!added.ok) throw new Error(`added-test task failed: ${added.reason ?? "unknown"}`);
  });

  it("refuses a recorded self-review answer about a file the run never changed", async () => {
    const task = fixtureTask("self-review-finds-secret");
    const verification = verificationList(task)[0]!;
    if (verification.type !== "self_review") throw new Error("fixture task is not a self-review task");
    // The same recorded answer, pointed at a file nobody touched: the verification must reject the assertion
    // rather than confirm it from the answer text alone.
    const moved: EvalTask = {
      ...task,
      verify: { type: "self_review", answer: verification.answer, expect: [{ category: "security", file: "src/untouched.js" }] },
    };
    const result = await runOne(moved);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verify_self_review_file_not_changed:src/untouched.js");

    // An answer that reports nothing cannot satisfy an expectation either.
    const silent: EvalTask = {
      ...task,
      verify: { type: "self_review", answer: "```npati-self-review\n{\"status\":\"clean\",\"findings\":[]}\n```", expect: [{ category: "security", file: "src/invoice.js" }] },
    };
    const silentResult = await runOne(silent);
    expect(silentResult.ok).toBe(false);
    expect(silentResult.reason).toContain("verify_self_review_finding_missing:security@src/invoice.js");
  });

  it("treats a verification list as a conjunction, not as a menu", async () => {
    const task = fixtureTask("added-test-not-flagged");
    const halfTrue: EvalTask = {
      ...task,
      verify: [...verificationList(task), { type: "file_contains", path: "src/multiply.js", contains: "return a - b;" }],
    };
    const result = await runOne(halfTrue);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verify_content_mismatch:src/multiply.js");
  });
});
