import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext, CodeRunTurnRecord, CodeSession } from "@npati/workspace";
import type { ChatResult } from "@npati/omniroute-adapter";
import { CodingAgentRunner, type CodingAgentRunnerPorts } from "../apps/agent-api/src/coding-agent-runner";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import { CodeRunStateLog, refuseResume, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import { CodeRunReconciler } from "../apps/agent-api/src/code-run-reconciler";

/**
 * C10 security-gate suite: the two columns that had a reader and an updater but **no writer**.
 *
 * `code_run_turns.checkpoint_id` and `code_sessions.run_id` were dead in exactly the same way: the store could
 * write them, some surface read them, and nothing in the product ever passed a value. The consequences were quiet
 * and concrete — `CodeRunBoundary.checkpointId` was always `null`, so the reconciler compared the workspace
 * against "none", and `lastRun`/`usage` were permanently `null`, so no surface could say which run a session was
 * on.
 *
 * This suite pins the writers rather than the columns: a turn's checkpoint is the checkpoint *that turn's writes
 * were based on* — a distinct checkpoint per step, because the pre-C10 runner used one `turnId` for a whole run
 * and therefore could only ever have named the state before turn 1 — a step that wrote nothing carries the
 * checkpoint in force, and the session→run link is written once per run. It also pins that the reconciler's notice
 * is **persisted** (and refuses to be stored if it carries a credential) instead of being dropped by app.ts.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-1",
    workspaceId: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const TOOLS = [
  { name: "code.fs.edit", version: 1, status: "active", description: "edit a file", write: true },
  { name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false },
];

const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}));

function nativeCall(name: string, args: Record<string, unknown>, id: string) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function okResult(tool: string, payload: unknown = { ok: true }): CodeToolInvokeResult {
  return { ok: true, tool, toolVersion: 1, schemaVersion: 1, result: payload, truncated: false, durationMs: 1 };
}

/**
 * A faithful stand-in for `CodeToolRuntime` + `CodeTurnTracker`: the checkpoint is created by the **first write of
 * a turn** and keyed by `(sessionId, turnId)`, exactly as `ensureTurnCheckpoint` does it. A double is used because
 * what this suite pins is the linkage the runner writes; the runtime's own write pre-flight is covered by the C3
 * suite through the real service.
 */
function createHarness(options: { script: ChatResult[]; withTurnTracker?: boolean }) {
  const store = new InMemoryWorkspaceStore();
  const runStateLog = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort });
  const sessionLinks: Array<{ companyId: string; projectId: string; sessionId: string; runId: string }> = [];
  const invocations: Array<{ tool: string; toolCallId: string; turnId: string }> = [];
  const checkpoints = new Map<string, string>();
  const pathsByTurn = new Map<string, string[]>();
  const script = [...options.script];

  const key = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

  const turnSummary = (sessionId: string, turnId: string) => {
    const id = key(sessionId, turnId);
    const paths = pathsByTurn.get(id) ?? [];
    return {
      files: paths.length,
      linesAdded: paths.length,
      linesRemoved: 0,
      changes: paths.map((path) => ({
        path,
        tool: "code.fs.edit",
        status: "modified",
        diff: `--- a/${path}\n+++ b/${path}\n+const x = 1;`,
      })),
      checkpointId: checkpoints.get(id) ?? null,
    };
  };

  const toolRuntime: CodingAgentRunnerPorts["toolRuntime"] = {
    listTools: () => TOOLS.map((tool) => ({ ...tool })),
    invoke: async (_ctx, input) => {
      invocations.push({ tool: input.tool, toolCallId: input.toolCallId, turnId: input.turnId ?? "" });
      if (input.tool !== "code.fs.edit") return okResult(input.tool, { path: "src/read.ts", sha256: "sha-read" });
      const id = key(input.sessionId ?? "", input.turnId ?? "");
      const path = String((input.args as { path?: unknown } | undefined)?.path ?? "src/unknown.ts");
      const paths = pathsByTurn.get(id) ?? [];
      paths.push(path);
      pathsByTurn.set(id, paths);
      // The checkpoint is created once, by the first write of the turn (never per call, never per run).
      if (!checkpoints.has(id)) checkpoints.set(id, `cp-${input.turnId}`);
      return okResult(input.tool, { path, sha256: `sha-${path}` });
    },
    ...(options.withTurnTracker === false ? {} : { turnSummary }),
  };

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime,
    engine: {
      chat: async () => {
        const next = script.shift();
        if (!next) throw new Error("the script ran out of answers");
        return next;
      },
      supportsNativeTools: () => true,
    },
    schemas: SCHEMAS,
    imageAdmission: { admit: async () => ({ reference: "npati/sandbox-node-1@sha256:abc", dev: false }) },
    runState: runStateLog,
    sandbox: { release: async () => undefined },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sessionRunLink: async ({ companyId, projectId, sessionId, runId }) => {
      sessionLinks.push({ companyId, projectId, sessionId, runId });
      return { linked: true };
    },
  };

  const runner = new CodingAgentRunner(ports);
  return {
    store,
    runStateLog,
    sessionLinks,
    invocations,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({
        ctx,
        session: session(),
        prompt: "make the change",
        turnId: "turn-key",
        verificationTools: [],
        ...input,
      }),
  };
}

async function turnsFor(store: InMemoryWorkspaceStore, runId: string): Promise<CodeRunTurnRecord[]> {
  return store.listCodeRunTurns("company-1", runId);
}

describe("security-gate: C10 run state — the checkpoint link and the session run link", () => {
  it("writes a distinct checkpoint for every turn that wrote, and carries the last one forward", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" }, "call-a")] },
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "src/b.ts" }, "call-b")] },
        { content: "done" },
      ],
    });
    const result = await harness.run({ runId: "run-1" });
    expect(result.status).toBe("completed");
    expect(result.runId).toBe("run-1");

    const turns = await turnsFor(harness.store, "run-1");
    expect(turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
    // Turn 1 and turn 2 wrote, so each carries the checkpoint taken before its own writes.
    expect(turns[0]!.checkpointId).toBe("cp-turn-key#turn-1");
    expect(turns[1]!.checkpointId).toBe("cp-turn-key#turn-2");
    expect(turns[0]!.checkpointId).not.toBe(turns[1]!.checkpointId);
    // Turn 3 wrote nothing, so it carries the checkpoint in force — "unknown" would be a different claim.
    expect(turns[2]!.checkpointId).toBe("cp-turn-key#turn-2");
    for (const turn of turns) {
      expect(turn.status).toBe("finished");
      expect(turn.outcome).toBe("ok");
    }

    /**
     * The step key the runtime receives is what makes a per-turn checkpoint meaningful: before C10 every call of a
     * run was invoked with the same `turnId`, so only the first turn could ever own a checkpoint.
     */
    expect(harness.invocations.map((entry) => entry.turnId)).toEqual(["turn-key#turn-1", "turn-key#turn-2"]);
  });

  it("feeds the checkpoint into the run boundary the reconciler compares the workspace against", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" }, "call-a")] },
        { content: "done" },
      ],
    });
    await harness.run({ runId: "run-2" });
    const boundary = await harness.runStateLog.loadTurnBoundary("company-1", "run-2");
    expect(boundary).not.toBeNull();
    // This field was permanently `null` before C10, and therefore the diff base the reconciler used.
    expect(boundary?.checkpointId).toBe("cp-turn-key#turn-1");
    expect(boundary?.lastFinishedTurn).toBe(2);
  });

  it("records no checkpoint when the deployment has no turn tracker, rather than inventing one", async () => {
    const harness = createHarness({ script: [{ content: "done" }], withTurnTracker: false });
    const result = await harness.run({ runId: "run-3" });
    expect(result.status).toBe("completed");
    const turns = await turnsFor(harness.store, "run-3");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.checkpointId).toBeNull();
  });

  it("links the session to its run exactly once, and not again when the session already points at it", async () => {
    const harness = createHarness({ script: [{ content: "done" }] });
    const first = await harness.run({ runId: "run-4" });
    expect(first.runId).toBe("run-4");
    expect(harness.sessionLinks).toEqual([
      { companyId: "company-1", projectId: "project-1", sessionId: "session-1", runId: "run-4" },
    ]);

    // A resumed run continues the same run id, so the link is already correct and is not rewritten.
    const second = await harness.run({ runId: "run-4", session: session({ runId: "run-4" }) });
    expect(second.runId).toBe("run-4");
    expect(harness.sessionLinks).toHaveLength(1);
  });

  it("aggregates the run summary across steps, exactly as the single run-scoped entry used to", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" }, "call-a")] },
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "src/b.ts" }, "call-b")] },
        { content: "done" },
      ],
    });
    const result = await harness.run({ runId: "run-5" });
    expect([...result.summary.filesChanged].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.summary.diffStats).toEqual({ files: 2, linesAdded: 2, linesRemoved: 0 });
    expect(result.summary.toolCalls).toBe(2);
  });

  it("keeps one rule for what may be resumed, shared by the log and the resume service", () => {
    expect(refuseResume("waiting_for_user")).toBe("waiting_for_user");
    expect(refuseResume("completed")).toBe("terminal");
    expect(refuseResume("failed")).toBe("terminal");
    expect(refuseResume("cancelled")).toBe("terminal");
    expect(refuseResume("running")).toBeNull();
    expect(refuseResume("interrupted")).toBeNull();
  });
});

describe("security-gate: C10 recovery notice — persisted, not discarded", () => {
  async function interruptedRun(runId: string): Promise<{ store: InMemoryWorkspaceStore; log: CodeRunStateLog }> {
    const store = new InMemoryWorkspaceStore();
    const log = new CodeRunStateLog({
      store: store as unknown as CodeRunStateStorePort,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    await log.startRun({
      ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", owner: "worker-a", runId,
    });
    await log.appendTurn({ companyId: "company-1", runId, turnIndex: 1, status: "running" });
    await log.appendToolCall({
      companyId: "company-1", runId, turnIndex: 1, toolCallId: "call-1", tool: "code.shell.exec",
      readOnly: false, outcome: "unknown_outcome", finishedAt: null,
    });
    await log.appendToolCall({
      companyId: "company-1", runId, turnIndex: 1, toolCallId: "call-2", tool: "code.fs.read",
      readOnly: true, outcome: "unknown_outcome", finishedAt: null,
    });
    return { store, log };
  }

  it("stores the notice through the port so a route and a resume can read it", async () => {
    const { store, log } = await interruptedRun("run-9");
    const recorded: Array<Record<string, unknown>> = [];
    const reconciler = new CodeRunReconciler({
      log,
      now: () => Date.parse("2026-01-01T01:00:00.000Z"),
      notices: {
        record: async (input) => {
          recorded.push(input as unknown as Record<string, unknown>);
          await store.createCodeRunRecoveryNotice({ ...input, workspaceDiff: input.workspaceDiff ?? null });
        },
      },
    });
    const report = await reconciler.reconcileRuns({ now: new Date("2026-01-01T01:00:00.000Z") });
    expect(report.interrupted).toEqual(["run-9"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      sessionId: "session-1",
      runId: "run-9",
      reason: "lease_expired",
      lastFinishedTurn: 0,
    });

    const stored = await store.getLatestCodeRunRecoveryNotice("company-1", "run-9");
    expect(stored).not.toBeNull();
    expect(stored?.unknownOutcome).toEqual([{ toolCallId: "call-1", tool: "code.shell.exec" }]);
    expect(stored?.replayedReadOnly.map((call) => call.toolCallId)).toEqual(["call-2"]);
    expect(stored?.messageForModel).toContain("Do NOT repeat those calls");
    // Tenant-scoped: another company does not see it.
    expect(await store.getLatestCodeRunRecoveryNotice("company-2", "run-9")).toBeNull();
  });

  it("writes no notice on a dry run, because a dry run must change nothing at all", async () => {
    const { store, log } = await interruptedRun("run-10");
    const written: unknown[] = [];
    const reconciler = new CodeRunReconciler({
      log,
      now: () => Date.parse("2026-01-01T01:00:00.000Z"),
      notices: { record: async (input) => { written.push(input); } },
    });
    const report = await reconciler.reconcileRuns({ dryRun: true, now: new Date("2026-01-01T01:00:00.000Z") });
    expect(report.dryRun).toBe(true);
    expect(report.recovered).toHaveLength(1);
    expect(written).toHaveLength(0);
    expect(await store.listCodeRunRecoveryNotices({ companyId: "company-1", runId: "run-10" })).toHaveLength(0);
  });

  it("refuses to persist a notice that carries a credential instead of scrubbing it", async () => {
    const { store, log } = await interruptedRun("run-11");
    const warnings: Array<{ payload: unknown; message?: string }> = [];
    const reconciler = new CodeRunReconciler({
      log,
      now: () => Date.parse("2026-01-01T01:00:00.000Z"),
      logger: { warn: (payload, message) => warnings.push({ payload, ...(message === undefined ? {} : { message }) }) },
      // The diff summary flows into `messageForModel`, so a credential planted here must refuse the whole notice.
      workspaceDiffFor: async () => ({
        changed: true,
        files: ["src/a.ts"],
        summary: "token sk_live_0123456789abcdefghijkl was found in the diff",
        checkpointId: null,
      }),
      notices: { record: async (input) => { await store.createCodeRunRecoveryNotice({ ...input, workspaceDiff: input.workspaceDiff ?? null }); } },
    });
    const report = await reconciler.reconcileRuns({ now: new Date("2026-01-01T01:00:00.000Z") });
    // The run is still recovered (the interruption is real); only the notice is refused.
    expect(report.interrupted).toEqual(["run-11"]);
    expect(await store.listCodeRunRecoveryNotices({ companyId: "company-1", runId: "run-11" })).toHaveLength(0);
    expect(warnings.map((warning) => warning.message)).toContain("code_run_recovery_notice_refused");
    expect((warnings[0]?.payload as { kinds?: string[] }).kinds?.length).toBeGreaterThan(0);
  });
});
