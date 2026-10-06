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
import { VERIFICATION_REPAIR_EXHAUSTED } from "../apps/agent-api/src/code-verification-loop";
import {
  CODE_EVAL_SCHEMA_VERSION,
  evalReportIsGreen,
  loadEvalFixture,
  loadEvalTasks,
  resolveEvalMode,
  runEvalSuite,
  type EvalFixture,
  type EvalStep,
  type EvalTask,
} from "../apps/agent-api/src/code-eval-harness";

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

async function evalHarness(task: EvalTask) {
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
  let tokens = 41; // deterministic per-step usage so the metric is asserted, not just present
  return {
    state,
    company,
    invokeTool: async ({ tool, args, toolCallId }: { tool: string; args?: unknown; toolCallId: string; step: number }) => {
      // One turn per task: read-before-write (C3) is scoped to a turn, exactly like the real runner, which
      // reads a file and then edits it inside the same turn.
      const result = await runtime.invoke(owner, { companyId: company.id, projectId: "p-eval", sessionId: "s-eval", tool, args, toolCallId, turnId: "turn-eval" });
      return result.ok ? { ok: true as const } : { ok: false as const, error: { code: result.error.code } };
    },
    runCommand: async (command: string) => (command === "npm test" ? runFixtureTests(state) : { exitCode: 0 }),
    files: () => state,
    usage: () => ({ tokens: tokens++ }),
  };
}

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

describe("security-gate: C6/C9 eval harness runs the seventeen deterministic tasks", () => {
  it("passes all seventeen fixture tasks through the real tool runtime", async () => {
    const tasks = loadFixture();
    // Exact count and exact ids: the corpus is a contract, so a task that silently disappears (or a renamed
    // id) fails here instead of shrinking the evidence.
    expect(tasks).toHaveLength(17);
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
    const combined = {
      schemaVersion: CODE_EVAL_SCHEMA_VERSION,
      mode: "recorded" as const,
      tasks: perTask.map((single) => single.tasks[0]!),
      totals: {
        tasks: perTask.length,
        passed: perTask.length,
        failed: 0,
        steps: perTask.reduce((sum, single) => sum + single.totals.steps, 0),
        checks: perTask.reduce((sum, single) => sum + single.totals.checks, 0),
        tokens: perTask.reduce((sum, single) => sum + single.totals.tokens, 0),
        durationMs: perTask.reduce((sum, single) => sum + single.totals.durationMs, 0),
      },
    };
    expect(evalReportIsGreen(combined)).toBe(true);
    expect(combined.totals.steps).toBeGreaterThanOrEqual(17 * 2);
    // Exact: fourteen `check` steps (2 + 4 + 2 + 2 + 2 + 2) and no more, so a task that stops recording its
    // own failures cannot hide behind the aggregate.
    expect(combined.totals.checks).toBe(14);
    expect(combined.totals.tokens).toBeGreaterThan(0);
  });

  it("fails a task whose transcript does not actually fix anything (negative control)", async () => {
    const task = loadFixture()[0]!;
    const broken: EvalTask = { ...task, script: [{ kind: "message", text: "I think it is fine." }] };
    const report = await runEvalSuite([broken], await evalHarness(broken));
    expect(report.tasks[0]!.ok).toBe(false);
    expect(report.tasks[0]!.reason).toContain("verify_content_mismatch");
    expect(evalReportIsGreen(report)).toBe(false);
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

  it("keeps every scripted step a legal tool call shape and uses only the fixture's check command", () => {
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
    // One command, the stand-in for the fixture's test runner. A task inventing a second command would be
    // checked by a runner no test wires up — which is the same as not being checked.
    expect([...commands]).toEqual(["npm test"]);
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
