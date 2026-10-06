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
import { ReadTracker } from "../apps/agent-api/src/code-read-tracker";
import {
  evalReportIsGreen,
  loadEvalTasks,
  resolveEvalMode,
  runEvalSuite,
  type EvalStep,
  type EvalTask,
} from "../apps/agent-api/src/code-eval-harness";

/**
 * C6 security-gate suite: the eval harness must be deterministic in CI (no network, no Docker, no live
 * model) and must actually EXERCISE THE REAL TOOL PATH. Tool calls go through `CodeToolRuntime` with the
 * canonical executors over an in-memory workspace port, so a passing task proves the production path works
 * — while a deliberately wrong transcript must FAIL, otherwise the harness would be green by construction.
 *
 * The project's test runner is simulated (there is no Node test runner inside the eval fixture); that
 * simulation is part of the fixture contract, not of the tool path under test.
 */

const owner: AuthContext = { workspaceId: "ws-eval", userId: "user-eval", permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };

const allowAll = { assertEnabled: async () => true, isEnabled: async () => true } as unknown as FeatureFlagService;

function evalFilePath(): string {
  // `import.meta.dirname` keeps this independent of the process CWD (the same class of defect that once made
  // a security-gate suite load with zero tests).
  return `${import.meta.dirname}/fixtures/coding-agent-eval/tasks.json`;
}

function loadFixture(): EvalTask[] {
  return loadEvalTasks(JSON.parse(readFileSync(evalFilePath(), "utf8")).tasks);
}

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
    runCommand: async (command: string) => {
      // Deterministic stand-in for the fixture's test runner: the suite "passes" only when the fix landed.
      if (command === "npm test") {
        const assertion = state["tests/assert.js"] ?? "";
        return { exitCode: assertion.includes("toBe(2)") ? 0 : 1, output: assertion };
      }
      return { exitCode: 0 };
    },
    files: () => state,
    usage: () => ({ tokens: tokens++ }),
  };
}

describe("security-gate: C6 eval harness runs the eight deterministic tasks", () => {
  it("passes all eight fixture tasks through the real tool runtime", async () => {
    const tasks = loadFixture();
    expect(tasks).toHaveLength(8);
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
      schemaVersion: 1,
      mode: "recorded" as const,
      tasks: perTask.map((single) => single.tasks[0]!),
      totals: {
        tasks: perTask.length,
        passed: perTask.length,
        failed: 0,
        steps: perTask.reduce((sum, single) => sum + single.totals.steps, 0),
        tokens: perTask.reduce((sum, single) => sum + single.totals.tokens, 0),
        durationMs: perTask.reduce((sum, single) => sum + single.totals.durationMs, 0),
      },
    };
    expect(evalReportIsGreen(combined)).toBe(true);
    expect(combined.totals.steps).toBeGreaterThanOrEqual(8 * 2);
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
  });

  it("keeps every scripted step a legal tool call shape", () => {
    const tasks = loadFixture();
    const names = new Set(CODE_TOOL_SCHEMAS.map((schema) => schema.name));
    for (const task of tasks) {
      for (const step of task.script as EvalStep[]) {
        if (step.kind !== "tool") continue;
        expect(names.has(step.tool), `${task.id} uses unknown tool ${step.tool}`).toBe(true);
      }
    }
  });
});
