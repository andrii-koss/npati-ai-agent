import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodeProcessManager, type CodeProcessSandboxPort } from "../apps/agent-api/src/code-process-manager";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { createCodeProcessControls } from "../apps/agent-api/src/code-process-runtime";
import { CodeAsyncProcessService, type TrackedProcessPort } from "../apps/agent-api/src/code-async-process";
import { MemoryCodeProcessStore } from "../packages/workspace/src/code-process-store-memory";
import type { CodeSession } from "@npati/workspace";
import { CodeShellRuntime } from "../apps/agent-api/src/code-shell-runtime";
import type { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const input = { companyId: "c", projectId: "p", sessionId: "s", command: "npm test" };
function setup(options: { maxProcessesPerSession?: number; logLines?: number; outputChars?: number } = {}) {
  let count = 0;
  const sandbox: CodeProcessSandboxPort = {
    logsAreSnapshots: true,
    start: vi.fn(async () => ({ processId: `process-${++count}` })),
    status: vi.fn(async () => ({ state: "running" as const, exitCode: null })),
    logs: vi.fn(async () => ({ output: "" })),
    stop: vi.fn(async () => ({ exitCode: null, durationMs: 1 })),
  };
  const manager = new CodeProcessManager({ sandbox, flags: new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault: true }), ...options });
  return { manager, sandbox };
}
afterEach(() => vi.useRealTimers());

const services: CodeAsyncProcessService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
function durableSetup() {
  let owner = "worker-a", live = true, terminal = false;
  let status: { status: string; exitCode: number | null } = { status: "running", exitCode: null };
  let output = "";
  const store = new MemoryCodeProcessStore(async () => [{ runId: "run", sessionId: "s", owner, live, terminal }]);
  const port: TrackedProcessPort = {
    supported: vi.fn(async () => true),
    start: vi.fn(async (_ctx, _input, op, beforeStart) => { await beforeStart({ sandboxId: "sandbox", mounted: false, files: [] }); return { ...status, processId: op.processId }; }),
    status: vi.fn(async () => status), stop: vi.fn(async () => ({ status: "stopped", exitCode: null })),
    output: vi.fn(async (_ctx, _op, offset) => { const start = Math.max(offset, output.length - 64000); return { output: output.slice(start), offset: start, lossy: start > offset }; }),
    sync: vi.fn(async () => {}),
  };
  const options = { store, port, flags: { assertEnabled: vi.fn(async () => true) } as unknown as FeatureFlagService,
    session: async (_ctx: AuthContext, companyId: string, sessionId: string) => ({ id: sessionId, companyId, projectId: "p", userId: "u", status: "active", revision: 4, dataClassification: "internal", retentionClass: "standard" } as CodeSession),
    run: async () => ({ leaseOwner: owner, status: live ? "running" : "interrupted" }),
  };
  const create = () => { const service = new CodeAsyncProcessService(options); services.push(service); return service; };
  const service = create();
  const start = { ...input, runId: "run", leaseOwner: owner, toolCallId: "call-1", timeoutMs: 10000 };
  const scope = { companyId: "c", projectId: "p", sessionId: "s", dataClassification: "internal" as const, retentionClass: "standard" as const };
  return { service, create, start, scope, store, port, options, takeover: () => { owner = "worker-b"; }, expire: (isTerminal = false) => { live = false; terminal = isTerminal; }, resume: () => { live = true; terminal = false; },
    finish: (exitCode = 0) => { status = { status: exitCode ? "failed" : "completed", exitCode }; }, write: (text: string) => { output = text; } };
}

describe("Step 3 durable tracked execution", () => {
  it("promotes the original process on foreground timeout and explicitly collects its nonzero outcome", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start);
    const receipt = await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 5 });
    expect(receipt).toMatchObject({ kind: "running-process-receipt", processId: op.processId, version: 1, exitCode: null });
    await f.service.promote(ctx, input, op); f.write("failure details"); f.finish(7);
    expect(await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 1000 })).toMatchObject({ kind: "foreground-result", state: "failed", exitCode: 7, output: "failure details" });
    expect(f.port.start).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled();
    expect((await f.service.list(ctx, input))[0]!.events.map((e) => e.type)).toEqual(expect.arrayContaining(["process.accepted", "process.started", "process.promoted", "process.output", "process.settled"]));
  });
  it("returns early completion without a phantom running receipt", async () => {
    const f = durableSetup(); f.finish(); f.write("done");
    const op = await f.service.start(ctx, f.start);
    expect(f.service.receipt(op)).toMatchObject({ kind: "foreground-result", state: "completed", exitCode: 0, output: "done" });
  });
  it("reattaches across manager restart and retries without spawning again", async () => {
    const f = durableSetup(); const first = await f.service.start(ctx, f.start); await f.service.close();
    const restarted = f.create(); const again = await restarted.start(ctx, f.start);
    expect(again.operationId).toBe(first.operationId); expect(again.processId).toBe(first.processId); expect(f.port.start).toHaveBeenCalledOnce();
    await expect(restarted.start(ctx, { ...f.start, command: "npm run build" })).rejects.toMatchObject({ code: "process_request_conflict" });
  });
  it("reconciles an ambiguous dispatch instead of replaying it", async () => {
    const f = durableSetup(); f.port.start = vi.fn(async (_ctx, _input, _op, beforeStart) => { await beforeStart({ sandboxId: "sandbox", mounted: false, files: [] }); throw new Error("response lost after spawn"); });
    await expect(f.service.start(ctx, f.start)).rejects.toThrow("response lost");
    expect((await f.service.list(ctx, input))[0]!.state).toBe("unknown_outcome");
    expect(await f.service.start(ctx, f.start)).toMatchObject({ state: "running" }); expect(f.port.start).toHaveBeenCalledOnce();
  });
  it("records missing producer as lost after restart and installs a cancel tombstone", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); await f.service.close();
    f.port.status = vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "process_not_found" }); });
    expect(await f.create().wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 1000 })).toMatchObject({ state: "lost", exitCode: null });
    expect(f.port.stop).toHaveBeenCalledOnce(); expect(f.port.start).toHaveBeenCalledOnce();
  });
  it("fences the old lease generation when a new worker adopts the same operation", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); await f.service.close(); f.takeover();
    const adopted = await f.create().start(ctx, { ...f.start, leaseOwner: "worker-b" });
    expect(adopted).toMatchObject({ operationId: op.operationId, generation: 2, owner: "worker-b" });
    await expect(f.store.transact(f.scope, { kind: "update", operationId: op.operationId, owner: "worker-a", generation: 1, state: "completed", exitCode: 0 })).rejects.toMatchObject({ code: "process_lease_lost" });
    expect(f.port.start).toHaveBeenCalledOnce();
  });
  it("requires a live C6a lease at dispatch while allowing existing producers to settle after the parent", async () => {
    const f = durableSetup(); f.expire(); await expect(f.service.start(ctx, f.start)).rejects.toMatchObject({ code: "process_lease_lost" }); expect(f.port.start).not.toHaveBeenCalled();
    const preparing = durableSetup(); let release!: () => void, ready!: () => void; let spawned = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    preparing.port.start = vi.fn(async (_ctx, _input, op, beforeStart) => {
      ready(); await gate; await beforeStart({ sandboxId: "sandbox", mounted: false, files: [] });
      spawned++; return { processId: op.processId, status: "running", exitCode: null };
    });
    const pending = preparing.service.start(ctx, preparing.start);
    const refused = expect(pending).rejects.toMatchObject({ code: "process_lease_lost" });
    await entered; preparing.expire(true); release(); await refused;
    expect(spawned).toBe(0); expect((await preparing.service.list(ctx, input))[0]!.state).toBe("stopped");
    const running = durableSetup(); const op = await running.service.start(ctx, running.start);
    running.expire(true); running.finish(7);
    expect(await running.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 1000 })).toMatchObject({ state: "failed", exitCode: 7 });
  });
  it("cancels timed-out preparation and prevents a late provider spawn", async () => {
    const f = durableSetup(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let spawned = 0;
    f.port.start = vi.fn(async (_ctx, _input, op, beforeStart) => { await gate; await beforeStart({ sandboxId: "sandbox", mounted: false, files: [] }); spawned++; return { processId: op.processId, status: "running", exitCode: null }; });
    await expect(f.service.start(ctx, { ...f.start, preparationTimeoutMs: 5 })).rejects.toMatchObject({ code: "process_preparation_timeout" });
    const op = (await f.service.list(ctx, input))[0]!; await expect(f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 0 })).rejects.toMatchObject({ code: "process_start_pending" });
    release(); await f.service.close(); expect(spawned).toBe(0); expect((await f.service.list(ctx, input))[0]!.state).toBe("stopped");
  });
  it("keeps cancellation distinct from success and collects final output", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); f.write("interrupted");
    expect(await f.service.cancel(ctx, { ...input, processId: op.processId })).toMatchObject({ state: "stopped", exitCode: null });
    expect(await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 0 })).toMatchObject({ kind: "foreground-result", state: "stopped", exitCode: null, output: "interrupted" });
  });
  it("preserves a real completed outcome when cancellation races settlement", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); f.port.stop = vi.fn(async () => ({ status: "completed", exitCode: 0 }));
    expect(await f.service.cancel(ctx, { ...input, processId: op.processId })).toMatchObject({ state: "completed", exitCode: 0 }); expect(f.port.sync).toHaveBeenCalled();
  });
  it("returns bounded delta output and explicit eviction loss with stable cursors", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); f.write("a".repeat(70000));
    const first = await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 10 });
    expect(first).toMatchObject({ earliestOffset: 6000, nextOffset: 70000, truncated: true, lossy: true }); expect(first.output).toHaveLength(64000);
    f.write("a".repeat(70000) + "tail");
    expect(await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 10, offset: first.nextOffset })).toMatchObject({ output: "tail", nextOffset: 70004, truncated: false });
  });
  it("rejects foreign sessions and unsupported backends before publication", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start);
    await expect(f.service.wait(ctx, { ...input, sessionId: "other", processId: op.processId, waitTimeoutMs: 0 })).rejects.toMatchObject({ code: "process_not_found" });
    f.port.supported = vi.fn(async () => false);
    await expect(f.service.start(ctx, { ...f.start, toolCallId: "unsupported" })).rejects.toMatchObject({ code: "process_promotion_unavailable" }); expect(f.port.start).toHaveBeenCalledOnce();
  });
  it("pins cleanup while active and fences admission during cleanup", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start);
    expect(await f.service.cleanupGuard("c", "p")).toBeNull(); f.finish(); await f.service.wait(ctx, { ...input, processId: op.processId, waitTimeoutMs: 1000 });
    expect(await f.service.cleanupGuard("c", "p")).toBeNull(); // The parent still holds its C6a lease.
    f.expire(true);
    const release = await f.service.cleanupGuard("c", "p"); expect(release).not.toBeNull(); f.resume();
    await expect(f.service.start(ctx, { ...f.start, toolCallId: "next" })).rejects.toMatchObject({ code: "sandbox_cleanup_in_progress" }); await release!();
    expect(await f.service.start(ctx, { ...f.start, toolCallId: "next" })).toMatchObject({ state: "completed" });
  });
  it("uses the shared shell policy and denies secret promotion while retaining legacy exec", async () => {
    const f = durableSetup(); const execute = vi.fn(async () => ({ exitCode: 0, stdout: "legacy", stderr: "", durationMs: 1 }));
    const policy = { evaluate: vi.fn(async () => ({ decision: "allow", reasons: [] })) } as unknown as PolicyEngine;
    const processes = new CodeProcessManager(); processes.tracked = f.service;
    const shell = new CodeShellRuntime({ processes, sandbox: { execute }, policy });
    await expect(shell.execAsync(ctx, { ...f.start, secretLeaseIds: ["foreground-secret"], background: true })).rejects.toMatchObject({ code: "process_secret_promotion_denied" }); expect(f.port.start).not.toHaveBeenCalled();
    expect(await shell.exec(ctx, f.start)).toMatchObject({ stdout: "legacy" });
    expect(await shell.execAsync(ctx, { ...f.start, waitTimeoutMs: 5 })).toMatchObject({ kind: "running-process-receipt" });
    expect(execute).toHaveBeenCalledOnce(); expect(f.port.start).toHaveBeenCalledOnce(); expect(policy.evaluate).toHaveBeenCalledTimes(3);
  });
  it("adapts legacy logs/kill for durable handles and rejects foreign sessions after restart", async () => {
    const f = durableSetup(); const op = await f.service.start(ctx, f.start); await f.service.close();
    const manager = new CodeProcessManager(); manager.tracked = f.create(); const controls = createCodeProcessControls(manager, new Map()); f.write("first\nsecond");
    expect(await controls.processLogs({ ctx, ...input, processId: op.processId, offset: 0, limit: 1 })).toEqual({ lines: ["first"], nextOffset: 1, eof: false });
    await expect(controls.processLogs({ ctx, ...input, sessionId: "foreign", processId: op.processId, offset: 0, limit: 1 })).rejects.toMatchObject({ code: "process_not_found" });
    await expect(controls.stopProcess({ ctx, ...input, sessionId: "foreign", processId: op.processId })).rejects.toMatchObject({ code: "process_not_found" });
    expect(await controls.stopProcess({ ctx, ...input, processId: op.processId })).toMatchObject({ stopped: true }); expect(f.port.stop).toHaveBeenCalledOnce();
  });
});


describe("Step 3 process lifecycle foundation", () => {
  it("wait timeout retains exactly the same running handle without another provider start or stop", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    vi.useFakeTimers();
    const waiting = manager.wait(ctx, "s", started.processId, 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({ timedOut: true, process: { processId: started.processId, state: "running" } });
    expect(sandbox.start).toHaveBeenCalledOnce(); expect(sandbox.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns real nonzero terminal outcome before the wait deadline", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    sandbox.status = vi.fn(async () => ({ state: "failed" as const, exitCode: 7 }));
    expect(await manager.wait(ctx, "s", started.processId, 100)).toMatchObject({ timedOut: false, process: { state: "failed", exitCode: 7 } });
    expect(sandbox.start).toHaveBeenCalledOnce();
  });
  it("does not invent successful completion when a provider has no exit code", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    sandbox.status = vi.fn(async () => ({ state: "completed" as const, exitCode: null }));
    await expect(manager.status(ctx, "s", started.processId)).rejects.toMatchObject({ code: "process_outcome_unknown" });
    expect(manager.list("s")[0]?.state).toBe("running");
  });
  it("reports unsupported status capability without starting another command", async () => {
    const { manager, sandbox } = setup(); delete sandbox.status;
    const started = await manager.start(ctx, input);
    await expect(manager.wait(ctx, "s", started.processId, 1)).rejects.toMatchObject({ code: "process_status_unavailable" });
    expect(sandbox.start).toHaveBeenCalledOnce();
  });
  it("bounds wait even while a provider status call is stalled", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    let complete!: (result: { state: "completed"; exitCode: number }) => void;
    sandbox.status = vi.fn(() => new Promise<{ state: "completed"; exitCode: number }>((resolve) => { complete = resolve; }));
    vi.useFakeTimers();
    const waiting = manager.wait(ctx, "s", started.processId, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting).toMatchObject({ timedOut: true });
    complete({ state: "completed", exitCode: 0 });
    await Promise.resolve(); await Promise.resolve();
    expect(manager.list("s")[0]).toMatchObject({ state: "completed", exitCode: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reserves capacity during provider preparation and releases it on failed start", async () => {
    const { manager, sandbox } = setup({ maxProcessesPerSession: 1 });
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    sandbox.start = vi.fn(() => { entered(); return new Promise<{ processId: string }>((_resolve, failure) => { reject = failure; }); });
    const first = manager.start(ctx, input);
    const failure = expect(first).rejects.toThrow("preparation failed");
    await ready;
    await expect(manager.start(ctx, input)).rejects.toMatchObject({ code: "process_limit" });
    reject(new Error("preparation failed")); await failure;
    expect(manager.list("s")).toEqual([]);
    sandbox.start = vi.fn(async () => ({ processId: "retry" }));
    expect(await manager.start(ctx, input)).toMatchObject({ processId: "retry" });
  });
  it("refuses an unpublished handle without publishing a phantom process", async () => {
    const { manager, sandbox } = setup();
    sandbox.start = vi.fn(async () => ({ processId: "" }));
    await expect(manager.start(ctx, input)).rejects.toMatchObject({ code: "process_start_unknown_outcome", retryable: false });
    expect(manager.list("s")).toEqual([]);
  });
  it("deduplicates cumulative provider snapshots and concurrent log refreshes", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    sandbox.logs = vi.fn(async () => ({ output: "first\nsecond" }));
    await Promise.all([manager.fetchLogs(ctx, "s", started.processId), manager.fetchLogs(ctx, "s", started.processId)]);
    expect(sandbox.logs).toHaveBeenCalledOnce();
    const first = manager.readOutput("s", started.processId);
    expect(first.output).toBe("first\nsecond");
    await manager.fetchLogs(ctx, "s", started.processId);
    expect(manager.readOutput("s", started.processId, first.nextOffset).output).toBe("");
    sandbox.logs = vi.fn(async () => ({ output: "first\nsecond extended" }));
    await manager.fetchLogs(ctx, "s", started.processId);
    expect(manager.readOutput("s", started.processId, first.nextOffset).output).toBe(" extended");
  });
  it("keeps absolute cursors after ring eviction and makes loss explicit", async () => {
    const { manager } = setup({ outputChars: 5, logLines: 2 });
    const started = await manager.start(ctx, input);
    manager.appendOutput(started.processId, "01234");
    const first = manager.readOutput("s", started.processId);
    manager.appendOutput(started.processId, "56789");
    expect(manager.readOutput("s", started.processId, first.nextOffset)).toEqual({ output: "56789", earliestOffset: 5, nextOffset: 10, total: 10, truncated: false });
    expect(manager.readOutput("s", started.processId)).toMatchObject({ output: "56789", truncated: true });
    await expect(manager.logs("s", started.processId, { offset: 0 })).resolves.toMatchObject({ nextOffset: 2 });
    manager.appendOutput(started.processId, "third");
    await expect(manager.logs("s", started.processId, { offset: 2 })).resolves.toMatchObject({ lines: ["third"], nextOffset: 3, total: 3 });
  });
  it("does not treat a stop acknowledgement as a successful check and retains failed cleanup ownership", async () => {
    const { manager, sandbox } = setup();
    const first = await manager.start(ctx, input);
    expect(await manager.stop(ctx, "s", first.processId)).toMatchObject({ state: "stopped", exitCode: null });
    const second = await manager.start(ctx, input);
    sandbox.stop = vi.fn(async () => { throw new Error("provider unavailable"); });
    expect(await manager.stopAll(ctx, "s")).toBe(0);
    expect(manager.list("s").find((p) => p.processId === second.processId)?.state).toBe("running");
  });
  it("rejects cross-session status, wait, logs and stop before contacting the provider", async () => {
    const { manager, sandbox } = setup();
    const started = await manager.start(ctx, input);
    await expect(manager.status(ctx, "other", started.processId)).rejects.toMatchObject({ code: "process_not_found" });
    await expect(manager.wait(ctx, "other", started.processId, 10)).rejects.toMatchObject({ code: "process_not_found" });
    await expect(manager.fetchLogs(ctx, "other", started.processId)).rejects.toMatchObject({ code: "process_not_found" });
    await expect(manager.stop(ctx, "other", started.processId)).rejects.toMatchObject({ code: "process_not_found" });
    expect(() => manager.readOutput("other", started.processId)).toThrow("Unknown background process");
    expect(sandbox.status).not.toHaveBeenCalled(); expect(sandbox.logs).not.toHaveBeenCalled(); expect(sandbox.stop).not.toHaveBeenCalled();
  });
  it("scopes the production controls to company, project and calling session; stopped logs remain collectable", async () => {
    const { manager, sandbox } = setup();
    const first = await manager.start(ctx, { ...input, agentId: "project-agent" });
    const second = await manager.start(ctx, { ...input, sessionId: "sibling" });
    const registry = new Map([[first.processId, input], [second.processId, { ...input, sessionId: "sibling" }]]);
    const controls = createCodeProcessControls(manager, registry);
    const caller = { ...input, ctx, processId: first.processId, offset: 0, limit: 200 };
    expect((await controls.listProcesses(caller)).processes.map((p) => p.processId)).toEqual([first.processId]);
    expect(sandbox.start).toHaveBeenCalledWith(expect.objectContaining({ agentId: "project-agent" }));
    expect(sandbox.status).toHaveBeenCalledWith(expect.objectContaining({ agentId: "project-agent" }));
    for (const foreign of [{ sessionId: "sibling" }, { projectId: "foreign" }, { companyId: "foreign" }, { sessionId: undefined }]) {
      await expect(controls.processLogs({ ...caller, ...foreign })).rejects.toMatchObject({ code: "process_not_found" });
      await expect(controls.stopProcess({ ...caller, ...foreign })).rejects.toMatchObject({ code: "process_not_found" });
    }
    expect(sandbox.logs).not.toHaveBeenCalled(); expect(sandbox.stop).not.toHaveBeenCalled();
    await controls.stopProcess(caller);
    sandbox.logs = vi.fn(async () => ({ output: "cancelled output" }));
    expect(await controls.processLogs(caller)).toMatchObject({ lines: ["cancelled output"] });
    expect(sandbox.stop).toHaveBeenCalledWith(expect.objectContaining({ agentId: "project-agent" }));
    expect(sandbox.logs).toHaveBeenCalledWith(expect.objectContaining({ agentId: "project-agent" }));
  });
});
