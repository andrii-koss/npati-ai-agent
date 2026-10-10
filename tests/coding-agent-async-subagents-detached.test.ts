import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, activeCodeProcess, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { CodeAsyncProcessService, type TrackedProcessPort } from "../apps/agent-api/src/code-async-process";
import { CodeProcessCompletionService } from "../apps/agent-api/src/code-process-completions";
import { CodeSubagentOperationService, CodeSubagentWriteScopeRegistry, codeSubagentOperationId } from "../apps/agent-api/src/code-subagent-operations";
import { spawnCodeSubagent, CodeSubagentInFlightTracker, codeSubagentRunId, type CodeSubagentChildOutcome, type CodeSubagentChildRunRequest } from "../apps/agent-api/src/code-agent-spawn-executor";
import { resolveCodeSubagentType } from "../apps/agent-api/src/code-subagent-types";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { createCodeSubagentChildRunner } from "../apps/agent-api/src/code-subagent-child-runner";

/**
 * Step 5 security-gate: **detached** async sub-agents.
 *
 * The suite exists because every property the detached path adds is invisible in the happy path of a single
 * delegation: the parent not waiting, the join key surviving a retry, the completion arriving through the Step-4
 * outbox, a required child holding the parent's sandbox, and an unknown outcome not being replayed. Each of those
 * is a way for a second child to be spawned, a sandbox to be destroyed under a running child, or a cancelled run's
 * result to be reported as a completion — so each is pinned here with the fact it is supposed to prevent.
 *
 * The child runner is a fake **on purpose**: what is under test is the durable lifecycle around the child (reserve,
 * join, settle, deliver, fence, recover), not the child's own loop, which has its own suites.
 */

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const session = { id: "s", companyId: "c", projectId: "p", userId: "u", revision: 1, status: "active", mode: "auto", dataClassification: "confidential", retentionClass: "standard" } as CodeSession;
const PARENT = "parent-run";
const TOOL_CALL = "call-1";
const CHILD = codeSubagentRunId(PARENT, TOOL_CALL);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function trackedProcesses(store: InMemoryWorkspaceStore, log: CodeRunStateLog) {
  const port: TrackedProcessPort = { supported: async () => true,
    start: vi.fn(async () => ({ processId: "unused", status: "running", exitCode: null })),
    status: async () => ({ status: "completed", exitCode: 0 }),
    output: async () => ({ output: "", offset: 0, lossy: false }),
    stop: async () => ({ status: "stopped", exitCode: null }), sync: async () => {} };
  return new CodeAsyncProcessService({ store: store.codeProcesses!, port, flags: { assertEnabled: async () => true } as unknown as FeatureFlagService,
    session: async () => session, run: async (companyId, runId) => (await log.loadRunState(companyId, runId))! });
}

/** Everything a detached delegation needs, wired exactly as the composition wires it, minus the loop. */
function setup(options: { enabled?: boolean; controlsEnabled?: boolean; childRun?: (request: CodeSubagentChildRunRequest) => Promise<CodeSubagentChildOutcome> } = {}) {
  const store = new InMemoryWorkspaceStore();
  const log = new CodeRunStateLog({ store });
  const inbox = new CodeSessionInboxService({ store: store.codeInbox, flags: { assertEnabled: async () => true, isEnabled: async () => true },
    loadSession: async () => session, loadRunState: (companyId, runId) => log.loadRunState(companyId, runId), audit: async () => {} });
  const processes = trackedProcesses(store, log);
  const progress = vi.fn();
  const completions = new CodeProcessCompletionService({ store: store.codeProcesses!, processes, inbox,
    loadSession: async () => session, enabled: async () => true, progress, warn: vi.fn() });
  cleanups.push(() => completions.close()); cleanups.push(() => processes.close()); cleanups.push(() => inbox.close(() => {}));

  const childRun = vi.fn(options.childRun ?? (async (request: CodeSubagentChildRunRequest) => ({
    runId: request.runId, status: "completed" as const, answer: JSON.stringify({ findings: [{ kind: "fact", path: null, name: null, detail: "looked at it" }], files: ["src/a.ts"], symbols: [] }),
    filesChanged: ["src/a.ts"], toolCalls: 3, turns: 2,
  })));
  const childRunner = { run: childRun };
  const enabled = options.enabled ?? true;
  const operations = new CodeSubagentOperationService({ store: store.codeProcesses!, runState: log,
    childRunner: () => childRunner, loadSession: async () => session, enabled: async () => enabled,
    controlsEnabled: async () => options.controlsEnabled ?? false, spawnTool: "code.agent.spawn" });
  cleanups.push(() => operations.close());

  const start = (overrides: Partial<Parameters<CodeSubagentOperationService["startDetached"]>[0]> = {}) => operations.startDetached({
    ctx, companyId: "c", projectId: "p", sessionId: "s",
    parentRunId: PARENT, parentOwner: "worker", toolCallId: TOOL_CALL, childRunId: CHILD, snapshotId: null,
    agentType: "explore", capabilityProfile: "explore", task: "look at src/a.ts", paths: ["src/a.ts"],
    model: null, maxTurns: 8, readOnly: true, summaryOnly: true, allowedTools: ["code.fs.read"], toolCallingMode: "text",
    ...overrides,
  });
  const scope = { companyId: "c", projectId: "p", sessionId: "s" };
  const beginParent = () => log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId: PARENT, owner: "worker" });
  const childOperation = async () => (await processes.list(ctx, scope)).find((op) => op.kind === "subagent")!;
  const readInbox = () => inbox.transact(session, { kind: "read" });
  return { store, log, inbox, processes, completions, operations, childRun, start, beginParent, childOperation, readInbox, enabled };
}

/** The child's own run, created the way the real runner creates it (its own lease, its own identity). */
async function startChildRun(log: CodeRunStateLog, runId = CHILD, owner = `subagent-${CHILD}`) {
  return log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", runId, owner });
}

describe("security-gate: Step 5 detached subagents — the parent is not awaited", () => {
  it("returns an accepted receipt with the child id while the child is still running", async () => {
    const h = setup();
    await h.beginParent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.childRun.mockImplementation(async (request: CodeSubagentChildRunRequest) => {
      await gate;
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: [], symbols: [] }) };
    });

    const accepted = await h.start();
    // The receipt exists before the child has settled: that is the property, not an implementation detail.
    expect(accepted).toMatchObject({ status: "accepted", childRunId: CHILD, duplicate: false });
    expect(h.childRun).toHaveBeenCalledOnce();

    const operation = await h.childOperation();
    expect(operation).toMatchObject({ kind: "subagent", runId: PARENT, state: "running", child: { runId: CHILD, toolCallId: TOOL_CALL } });
    // The join key is durable, so a reader can go from parent+tool call to the child without any in-memory state.
    expect(operation.operationId).toBe(codeSubagentOperationId(PARENT, TOOL_CALL));
    release();
    await vi.waitFor(async () => expect((await h.childOperation()).state).toBe("completed"));
  });

  it("reserves before it starts, so nothing is spawned for a delegation that could not be recorded", async () => {
    const h = setup();
    // No parent run row: the reserve is refused by the parent-lease check, and nothing may be launched.
    const refused = await h.start();
    expect(refused).toMatchObject({ status: "refused", code: "process_lease_lost" });
    expect(h.childRun).not.toHaveBeenCalled();
    const operations = await h.processes.list(ctx, { companyId: "c", projectId: "p", sessionId: "s" });
    expect(operations.filter((op) => op.kind === "subagent")).toHaveLength(0);
  });

  it("adopts the delegation it already made instead of starting a second child", async () => {
    const h = setup();
    await h.beginParent();
    const first = await h.start();
    const retry = await h.start();
    expect(first).toMatchObject({ status: "accepted", duplicate: false });
    expect(retry).toMatchObject({ status: "accepted", childRunId: CHILD, duplicate: true });
    expect(h.childRun).toHaveBeenCalledOnce();
  });

  it("spends the root's own budget through the parent-run linkage, without a second allowance", async () => {
    const h = setup();
    await h.beginParent();
    await h.start();
    const operation = await h.childOperation();
    // The child's delegation is recorded **against the parent run** — the same key the shared budget is checked
    // at (`subagentDepthForRun(parentRunId)`) — and it has its own run id, so no quota object is duplicated: the
    // only numbers involved are the delegation's own turn ceiling and the deployment's parallel ceiling.
    expect(operation.runId).toBe(PARENT);
    expect(operation.child!.runId).toBe(CHILD);
    expect(operation.child!.runId).not.toBe(PARENT);
    const request = h.childRun.mock.calls[0]![0] as CodeSubagentChildRunRequest;
    expect(request.parentRunId).toBe(PARENT);
    expect(request.maxTurns).toBe(8);
    expect(request.allowedTools).toEqual(["code.fs.read"]);
  });

  it("does not start a child at all while the flag is off", async () => {
    const h = setup({ enabled: false });
    await h.beginParent();
    expect(await h.start()).toMatchObject({ status: "refused", code: "subagent_detached_disabled" });
    expect(h.childRun).not.toHaveBeenCalled();
  });

  it("refuses a delegation whose scope names the delegation tool, so depth stays 1", async () => {
    const h = setup();
    await h.beginParent();
    const refused = await h.start({ allowedTools: ["code.fs.read", "code.agent.spawn"] });
    expect(refused).toMatchObject({ status: "refused", code: "subagent_tool_not_delegable" });
    expect(h.childRun).not.toHaveBeenCalled();
  });
});

describe("security-gate: Step 5 detached subagents — child completion through the Step-4 outbox", () => {
  it("delivers the child's digest into the inbox and collects it at the parent's next boundary", async () => {
    const h = setup();
    await h.beginParent();
    await h.start();
    await vi.waitFor(async () => expect((await h.childOperation()).completion).toBeDefined());

    await h.completions.recover(ctx, session);
    const message = (await h.readInbox()).state.messages.find((entry) => entry.completion)!;
    expect(message.completion).toMatchObject({ type: "subagent", childRunId: CHILD, childToolCallId: TOOL_CALL, parentRunId: PARENT, status: "completed" });

    const collected = (await h.completions.collect(ctx, session, message, PARENT))!;
    expect(collected.text).toContain("code.agent.spawn");
    // The digest travels, the transcript does not: the answer is the metadata the child runner produced.
    expect(collected.text).toContain("looked at it");
    expect(collected.text).toContain("src/a.ts");
    await h.completions.admitted(session, collected.notice, { runId: PARENT, owner: "worker", turnIndex: 2, text: collected.text, source: "inbox" });
    expect((await h.childOperation()).completion?.admission).toMatchObject({ runId: PARENT, turnIndex: 2 });
  });

  it("reports a child that threw as a settled failure, never as a parent failure", async () => {
    const h = setup({ childRun: async () => { throw Object.assign(new Error("provider down"), { code: "provider_error" }); } });
    await h.beginParent();
    await h.start();
    await vi.waitFor(async () => expect((await h.childOperation()).state).toBe("failed"));
    await h.completions.recover(ctx, session);
    const message = (await h.readInbox()).state.messages.find((entry) => entry.completion)!;
    const collected = (await h.completions.collect(ctx, session, message, PARENT))!;
    expect(collected.text).toContain('"status":"failed"');
    expect(collected.text).toContain("provider_error");
  });
});

describe("security-gate: Step 5 detached subagents — the active-child fence", () => {
  it("holds the parent's cleanup fence while the child is active, and releases it on settlement", async () => {
    const h = setup();
    await h.beginParent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.childRun.mockImplementation(async (request: CodeSubagentChildRunRequest) => {
      await gate;
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: [], symbols: [] }) };
    });
    await h.start();

    // In flight: both the durable read and the live map answer "required".
    expect(await h.operations.hasRequiredChild({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT })).toBe(true);
    expect(activeCodeProcess(await h.childOperation())).toBe(true);

    release();
    await vi.waitFor(async () => expect(activeCodeProcess(await h.childOperation())).toBe(false));
    expect(await h.operations.hasRequiredChild({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT })).toBe(false);
  });

  it("blocks the sandbox cleanup transaction while a child operation is active", async () => {
    const h = setup();
    await h.beginParent();
    await h.start();
    // The process store's own cleanup accounting — the accounting the sandbox guard already reads — must refuse.
    const acquired = await h.store.codeProcesses!.transact(
      { companyId: "c", projectId: "p", sessionId: "s", dataClassification: "confidential", retentionClass: "standard" },
      { kind: "cleanup-acquire", token: "cleanup-1" },
    );
    expect(acquired.cleanupAcquired).toBe(false);
  });
});

describe("security-gate: Step 5 detached subagents — write-scope disjointness", () => {
  it("refuses a second writing child whose scope overlaps, and allows a disjoint one", async () => {
    const h = setup({ childRun: async (request: CodeSubagentChildRunRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: request.paths, symbols: [] }), filesChanged: [...request.paths] };
    } });
    await h.beginParent();
    await h.start({ toolCallId: "write-1", childRunId: codeSubagentRunId(PARENT, "write-1"), readOnly: false, paths: ["src/a"] });
    // Overlapping (a path inside the claimed directory) is refused before anything is reserved.
    expect(await h.start({ toolCallId: "write-2", childRunId: codeSubagentRunId(PARENT, "write-2"), readOnly: false, paths: ["src/a/deep"] }))
      .toMatchObject({ status: "refused", code: "subagent_write_scope_conflict" });
    expect((await h.processes.list(ctx, { companyId: "c", projectId: "p", sessionId: "s" })).filter((op) => op.kind === "subagent")).toHaveLength(1);
    // Disjoint is admitted.
    expect(await h.start({ toolCallId: "write-3", childRunId: codeSubagentRunId(PARENT, "write-3"), readOnly: false, paths: ["src/b"] }))
      .toMatchObject({ status: "accepted" });
  });

  it("lets a read-only child share a scope, because a read cannot conflict with a write", async () => {
    const h = setup({ childRun: async (request: CodeSubagentChildRunRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: [], symbols: [] }) };
    } });
    await h.beginParent();
    await h.start({ toolCallId: "write-1", childRunId: codeSubagentRunId(PARENT, "write-1"), readOnly: false, paths: ["src/a"] });
    expect(await h.start({ toolCallId: "read-1", childRunId: codeSubagentRunId(PARENT, "read-1"), readOnly: true, paths: ["src/a"] }))
      .toMatchObject({ status: "accepted" });
  });

  it("keeps sibling prefixes distinct and two parents independent", () => {
    const scopes = new CodeSubagentWriteScopeRegistry();
    scopes.claim("parent-1", { operationId: "op-1", childRunId: "c1", paths: ["src/ab"] });
    // `src/a` is a **prefix string** of `src/ab` but not a path prefix: nothing here overlaps.
    expect(scopes.conflict("parent-1", ["src/a"], "op-2")).toBeNull();
    expect(scopes.conflict("parent-1", ["src/ab"], "op-2")).toMatchObject({ childRunId: "c1" });
    expect(scopes.conflict("parent-2", ["src/ab"], "op-3")).toBeNull();
  });
});

describe("security-gate: Step 5 detached subagents — recovery never replays blindly", () => {
  it("claims an undispatched reservation only once when two recovering services compete", async () => {
    const h = setup({ childRun: async () => new Promise(() => {}) });
    await h.beginParent();
    await h.store.codeProcesses!.transact(sessionScope(), {
      kind: "reserve-child", operationId: codeSubagentOperationId(PARENT, TOOL_CALL), childRunId: CHILD,
      toolCallId: TOOL_CALL, agentType: "explore", runId: PARENT, owner: "worker",
      delegation: { agentType: "explore", task: "original task", readOnly: true, allowedTools: ["code.fs.read"], maxTurns: 8 },
    });
    const other = setup2(h);
    const results = await Promise.all([h.operations.recover({ ctx, companyId: "c", sessionId: "s" }),
      other.recover({ ctx, companyId: "c", sessionId: "s" })]);
    expect(results.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);
    expect(h.childRun).toHaveBeenCalledOnce();
    expect(h.childRun.mock.calls[0]![0].task).toBe("original task");
  });

  it("leaves an interrupted child for explicit C10 continuation without replaying the prompt", async () => {
    const h = setup({ childRun: async () => new Promise(() => {}) });
    await h.beginParent();
    await h.start();
    await startChildRun(h.log);
    await h.log.markInterrupted({ companyId: "c", runId: CHILD, reason: "host_restart" });
    const other = setup2(h);
    expect(await other.recover({ ctx, companyId: "c", sessionId: "s" })).toMatchObject({ recovered: 0, skipped: 1 });
    expect(h.childRun).toHaveBeenCalledOnce();
    expect(activeCodeProcess(await h.childOperation())).toBe(true);
  });
  it("does not replay a dispatched child with no run row and an unknown outcome", async () => {
    const h = setup({ childRun: async () => { await new Promise(() => {}); return { runId: CHILD, status: "completed" }; } });
    await h.beginParent();
    // Dispatch crossed the durable running boundary, but no child run row proves its outcome.
    const accepted = await h.start();
    expect(accepted).toMatchObject({ status: "accepted" });
    // The process that launched it is gone; only the durable record remains.
    await h.operations.close();
    const recovered = setup2(h);
    const outcome = await recovered.recover({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT });
    expect(outcome).toMatchObject({ recovered: 0, settled: 0, skipped: 1 });
    // Recovery must keep the original dispatch fenced and never start its task again.
    expect(recovered.childRun).toHaveBeenCalledTimes(1);
    for (const call of recovered.childRun.mock.calls) {
      expect((call[0] as CodeSubagentChildRunRequest).runId).toBe(CHILD);
    }
    expect(activeCodeProcess(await h.childOperation())).toBe(true);
  });

  it("settles a child whose run already ended, without running anything", async () => {
    let finishChild!: () => void;
    const childGate = new Promise<void>((resolve) => { finishChild = resolve; });
    const h = setup({ childRun: async (request: CodeSubagentChildRunRequest) => {
      await childGate;
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: [], symbols: [] }) };
    } });
    await h.beginParent();
    await h.start();
    // The child's own run row, created the way the real runner creates it, and then finished while this process was
    // not looking: the durable state — not the in-flight promise — is what the recovery has to trust.
    await startChildRun(h.log);
    await h.log.markFinished({ companyId: "c", runId: CHILD, status: "completed", reason: "completed", estimate: { tokenCount: 10, costUsd: 0, turns: 4, toolCalls: 7, filesChanged: 1, diffStats: { files: 1, linesAdded: 2, linesRemoved: 0 } } });
    await h.operations.close();
    const recovered = setup2(h);
    const outcome = await recovered.recover({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT });
    expect(outcome).toMatchObject({ recovered: 0, settled: 1 });
    // Nothing new was started: the recovery read the child's own terminal run state and settled from it.
    expect(recovered.childRun).toHaveBeenCalledTimes(1);
    // The digest is rebuilt from the run's own durable estimate: counts and paths, never a transcript.
    const operation = (await recovered.processes.list(ctx, { companyId: "c", projectId: "p", sessionId: "s" })).find((op) => op.kind === "subagent")!;
    expect(operation.state).toBe("completed");
    const stored = JSON.parse(operation.completion!.result.output) as { filesChanged?: string[]; toolCalls?: number; turns?: number };
    expect(stored).toMatchObject({ toolCalls: 7, turns: 4 });
    // Let the abandoned in-flight promise settle so no test leaks a pending task.
    finishChild();
  });

  it("leaves a child whose run still holds a live lease completely alone", async () => {
    const h = setup({ childRun: async () => { await new Promise(() => {}); return { runId: CHILD, status: "completed" }; } });
    await h.beginParent();
    await h.start();
    await startChildRun(h.log);
    const outcome = await h.operations.recover({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT });
    expect(outcome).toMatchObject({ recovered: 0, settled: 0, skipped: 1 });
    expect(h.childRun).toHaveBeenCalledOnce();
  });
});

function sessionScope() {
  return { companyId: session.companyId, projectId: session.projectId, sessionId: session.id,
    dataClassification: session.dataClassification, retentionClass: session.retentionClass };
}

describe("security-gate: detached admission is atomic across service instances", () => {
  it("enforces the parallel ceiling across simultaneous admissions", async () => {
    const h = setup({ childRun: async () => new Promise(() => {}) });
    await h.beginParent();
    const receipts = await Promise.all(["one", "two"].map((id) => h.start({
      childRunId: codeSubagentRunId(PARENT, id), toolCallId: id, maxParallelism: 1,
    })));
    expect(receipts.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(receipts.find((r) => r.status === "refused")).toMatchObject({ code: "subagent_parallelism_exceeded" });
    expect(h.childRun).toHaveBeenCalledOnce();
  });

  it("rejects overlapping writers in the store even when live registries are independent", async () => {
    const h = setup({ childRun: async () => new Promise(() => {}) });
    await h.beginParent();
    const other = setup2(h);
    await h.start({ readOnly: false, paths: ["src/a"] });
    const receipt = await other.operations.startDetached({ ctx, companyId: "c", projectId: "p", sessionId: "s",
      parentRunId: PARENT, parentOwner: "worker", childRunId: "other-child", toolCallId: "other-call",
      agentType: "explore", capabilityProfile: "explore", task: "edit", paths: ["src/a/file.ts"],
      model: null, maxTurns: 8, readOnly: false, summaryOnly: true, allowedTools: ["code.fs.read"], toolCallingMode: "text" });
    expect(receipt).toMatchObject({ status: "refused", code: "subagent_write_scope_conflict" });
    expect(h.childRun).toHaveBeenCalledOnce();
  });
});

describe("security-gate: Step 6 interrupt foundation", () => {
  it("allows existing child interruption to drain after control flag rollback", async () => {
    const h = setup({ childRun: async () => new Promise(() => {}) });
    await h.beginParent(); await h.start();
    expect(await h.operations.interrupt({ ctx, companyId: "c", sessionId: "s", parentRunId: PARENT, childRunId: CHILD })).toBe("requested");
    expect((await h.childOperation()).cancelRequested).toBe(true);
  });

  it("passes the same abort signal through the child adapter and retains cleanup until settlement", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const runAgent = vi.fn(async (input: { signal?: AbortSignal }) => {
      await gate;
      expect(input.signal?.aborted).toBe(true);
      return { status: "cancelled", reason: "cancelled", message: "cancelled", summary: {} };
    });
    const adapter = createCodeSubagentChildRunner({ loadSession: async () => session, runAgent });
    const h = setup({ controlsEnabled: true, childRun: (request) => adapter.run(request) });
    await h.beginParent(); await h.start();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    const target = { ctx, companyId: "c", sessionId: "s", parentRunId: PARENT, childRunId: CHILD };
    expect(await h.operations.interrupt(target)).toBe("requested");
    expect(await h.operations.interrupt(target)).toBe("requested");
    expect(runAgent.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect((await h.childOperation()).cancelRequested).toBe(true);
    expect(await h.operations.hasRequiredChild(target)).toBe(true);
    expect((await h.store.codeProcesses!.transact(sessionScope(), { kind: "cleanup-acquire", token: "early" })).cleanupAcquired).toBe(false);
    finish();
    await vi.waitFor(async () => expect((await h.childOperation()).state).toBe("failed"));
    expect(await h.operations.interrupt(target)).toBe("settled");
    expect((await h.childOperation()).completion?.notice.type).toBe("subagent");
    expect(h.childRun).toHaveBeenCalledOnce();
  });

  it("refuses another parent's child without writing cancel intent", async () => {
    const h = setup({ controlsEnabled: true, childRun: async () => new Promise(() => {}) });
    await h.beginParent(); await h.start();
    await expect(h.operations.interrupt({ ctx, companyId: "c", sessionId: "s", parentRunId: "foreign-parent", childRunId: CHILD }))
      .rejects.toThrow("subagent_child_not_found");
    expect((await h.childOperation()).cancelRequested).toBe(false);
  });
});

/**
 * A second service over the **same** store, standing in for a restarted process: the durable records, the child
 * runs and the operation rows are all that survived, and the live map of the first service is deliberately gone.
 */
function setup2(h: ReturnType<typeof setup>) {
  const childRun = h.childRun;
  const operations = new CodeSubagentOperationService({ store: h.store.codeProcesses!, runState: h.log,
    childRunner: () => ({ run: childRun }), loadSession: async () => session, enabled: async () => true, spawnTool: "code.agent.spawn" });
  cleanups.push(() => operations.close());
  return { ...h, operations, recover: (input: { ctx: AuthContext; companyId: string; sessionId: string; parentRunId?: string | null }) => operations.recover(input) };
}

describe("security-gate: Step 5 detached subagents — the executor's own acceptance list", () => {
  it("returns an accepted receipt through spawnCodeSubagent without awaiting the child, and keeps the blocking path intact", async () => {
    const h = setup();
    await h.beginParent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.childRun.mockImplementation(async (request: CodeSubagentChildRunRequest) => {
      await gate;
      return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [], files: [], symbol: [] }) };
    });
    const type = resolveCodeSubagentType({ type: "explore" });
    const started = vi.fn();
    const receipt = await spawnCodeSubagent(
      { ctx, companyId: "c", projectId: "p", sessionId: "s", parentRunId: PARENT, parentOwner: "worker", toolCallId: TOOL_CALL, args: { agentType: "explore", task: "look", paths: ["src/a.ts"] } },
      {
        childRunner: () => ({ run: h.childRun }),
        canonicalTools: () => ["code.fs.read", "code.search", "code.agent.spawn"],
        detached: {
          isEnabled: async () => true,
          start: async (input) => {
            started(input.toolCallId);
            const accepted = await h.start({ toolCallId: input.toolCallId, childRunId: input.childRunId, agentType: type.type, allowedTools: [...input.allowedTools] });
            return accepted.status === "accepted" ? accepted : { status: "refused" as const, code: accepted.code, message: accepted.message };
          },
        },
        activity: { record: async () => ({ persisted: true }) },
      },
      new CodeSubagentInFlightTracker(),
    );
    expect(receipt).toMatchObject({ status: "accepted", detached: true, runId: CHILD, accepted: { childRunId: CHILD } });
    expect(started).toHaveBeenCalledWith(TOOL_CALL);
    // The receipt carries an empty digest and says why, so "no findings yet" cannot read as "found nothing".
    expect(receipt.handoff.findings).toEqual([]);
    release();
    await vi.waitFor(async () => expect((await h.childOperation()).state).toBe("completed"));
  });

  it("keeps the C12 blocking path when no detached port is wired", async () => {
    const childRunner = { run: vi.fn(async (request: CodeSubagentChildRunRequest) => ({ runId: request.runId, status: "completed" as const, answer: JSON.stringify({ findings: [{ kind: "fact", path: null, name: null, detail: "blocking" }], files: [], symbols: [] }) })) };
    const outcome = await spawnCodeSubagent(
      { ctx, companyId: "c", projectId: "p", sessionId: "s", parentRunId: PARENT, parentOwner: "worker", toolCallId: TOOL_CALL, args: { agentType: "explore", task: "look" } },
      { childRunner: () => childRunner, canonicalTools: () => ["code.fs.read", "code.search", "code.agent.spawn"] },
      new CodeSubagentInFlightTracker(),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.detached).toBeUndefined();
    expect(outcome.handoff.findings[0]!.detail).toBe("blocking");
    expect(childRunner.run).toHaveBeenCalledOnce();
  });
});
