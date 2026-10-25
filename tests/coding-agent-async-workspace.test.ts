import * as usageQuotaPolicy from "../apps/agent-api/src/usage-quota-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeAsyncWorkspaceService, registerCodeAsyncWorkspaceRoutes } from "../apps/agent-api/src/code-async-workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { FeatureFlagService, FeatureDisabledError } from "../apps/agent-api/src/feature-flags";
import { CodeSubagentOperationService } from "../apps/agent-api/src/code-subagent-operations";
import { createCodeSubagentChildRunner } from "../apps/agent-api/src/code-subagent-child-runner";
import { CodingAgentRunner } from "../apps/agent-api/src/coding-agent-runner";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import { CodeRunSharedQuota } from "../apps/agent-api/src/code-run-quota";
import { CodeAsyncProcessService } from "../apps/agent-api/src/code-async-process";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const session: CodeSession = { id: "s", companyId: "c", projectId: "p", workspaceId: "w", userId: "u", revision: 1,
  status: "active", mode: "auto", dataClassification: "confidential", retentionClass: "standard", createdAt: "2026-10-10", updatedAt: "2026-10-10" };
const scope = { companyId: "c", projectId: "p", sessionId: "s" };
const durableScope = { ...scope, dataClassification: session.dataClassification, retentionClass: session.retentionClass };
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
async function setup() {
  const store = new InMemoryWorkspaceStore(), log = new CodeRunStateLog({ store });
  await log.startRun({ ctx, ...scope, runId: "root", owner: "worker" });
  await store.codeProcesses!.transact(durableScope, { kind: "reserve-child", operationId: "op", childRunId: "child", toolCallId: "call",
    agentType: "explore", runId: "root", owner: "worker", delegation: { task: "SECRET_TASK", credential: "SECRET_CREDENTIAL" } });
  const flags = { assertEnabled: vi.fn(async () => true as const), isEnabled: vi.fn(async () => true) };
  const make = () => new CodeAsyncWorkspaceService({ store: store.codeProcesses!, flags, session: async () => session });
  return { store, log, flags, make, service: make() };
}

describe("Step 8 durable workspace projection and recovery drills", () => {
  it("reconstructs the same child after observer restart without claiming or executing it", async () => {
    const h = await setup(); const before = await h.store.codeProcesses!.transact(durableScope, { kind: "read" });
    expect(await h.make().read(ctx, scope)).toEqual(await h.service.read(ctx, scope));
    expect((await h.service.read(ctx, scope)).operations).toMatchObject([{ operationId: "op", childRunId: "child", state: "accepted" }]);
    expect(await h.store.codeProcesses!.transact(durableScope, { kind: "read" })).toEqual(before);
  });
  it.each(["interrupted", "completed", "failed"] as const)("reads %s without replaying or admitting its completion", async state => {
    const h = await setup(); await h.store.codeProcesses!.transact(durableScope, { kind: "update-child", childRunId: "child", owner: "worker", state,
      outcome: { answer: "SECRET_TRANSCRIPT", filesChanged: ["SECRET_PATH"] } });
    const before = await h.store.codeProcesses!.transact(durableScope, { kind: "read" });
    const view = await h.make().read(ctx, scope);
    expect(view.operations[0]).toMatchObject({ state, collected: false, delivered: false });
    expect(await h.store.codeProcesses!.transact(durableScope, { kind: "read" })).toEqual(before);
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });
  it.each([{ companyId: "foreign" }, { projectId: "foreign" }, { sessionId: "foreign" }])("rejects a mismatched scope %j", async patch => {
    const h = await setup();
    await expect(h.service.read(ctx, { ...scope, ...patch })).rejects.toMatchObject({ code: "session_not_found", httpStatus: 404 });
  });
  it.each([{ userId: "foreign" }, { workspaceId: "foreign" }])("rejects foreign identity %j before reading operations", async patch => {
    const h = await setup(), read = vi.spyOn(h.store.codeProcesses!, "transact");
    await expect(h.service.read({ ...ctx, ...patch }, scope)).rejects.toMatchObject({ code: "session_not_found", httpStatus: 404 });
    expect(read).not.toHaveBeenCalled();
  });
  it("uses the configured self-hosted default and keeps disabled installations dark", async () => {
    for (const enabledByDefault of [true, false]) {
      const flags = new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault });
      expect(await flags.isEnabled(ctx, "code.async_workspace", { companyId: "c" })).toBe(enabledByDefault);
    }
  });
  it("rolls back controls without discarding durable active operations", async () => {
    const h = await setup(); h.flags.isEnabled.mockResolvedValue(false);
    expect(await h.service.read(ctx, scope)).toMatchObject({ capabilities: { inbox: false, controls: false, resume: false }, operations: [{ state: "accepted" }] });
    h.flags.assertEnabled.mockRejectedValue(new FeatureDisabledError("code.async_workspace"));
    await expect(h.service.read(ctx, scope)).rejects.toMatchObject({ code: "feature_disabled" });
    expect((await h.store.codeProcesses!.transact(durableScope, { kind: "read" })).operations).toHaveLength(1);
  });
  it("authenticates and authorizes before reading; HTTP replies contain metadata only and cannot be cached", async () => {
    const h = await setup(), app = Fastify(); closes.push(() => app.close());
    const read = vi.spyOn(h.service, "read"), order: string[] = [];
    registerCodeAsyncWorkspaceRoutes(app, { service: h.service, auth: { authenticate: async () => { order.push("auth"); return ctx; } },
      authorize: async (_ctx, _companyId, input) => { order.push("rbac"); expect(input).toMatchObject({ action: "code.changes.read", permission: "workspace:read", sessionId: "s" }); } });
    const response = await app.inject({ url: "/companies/c/projects/p/code/sessions/s/async-workspace" });
    expect(response.statusCode).toBe(200); expect(order).toEqual(["auth", "rbac"]); expect(read).toHaveBeenCalledOnce();
    expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body).not.toContain("SECRET");
    expect(response.json()).toMatchObject({ schemaVersion: 1, ...scope });
  });
  it("does not disclose storage failure messages or lease owners", async () => {
    const h = await setup(), app = Fastify(); closes.push(() => app.close());
    vi.spyOn(h.service, "read").mockRejectedValue(new Error("SECRET_DATABASE_URI"));
    registerCodeAsyncWorkspaceRoutes(app, { service: h.service, auth: { authenticate: async () => ctx }, authorize: async () => {} });
    const response = await app.inject({ url: "/companies/c/projects/p/code/sessions/s/async-workspace" });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain("SECRET");
  });
  it("cannot read a child transcript or stop a child through shell process controls", async () => {
    const h = await setup(), producer = vi.fn(async (): Promise<never> => { throw new Error("shell producer must not be reached"); });
    const processes = new CodeAsyncProcessService({ store: h.store.codeProcesses!, flags: h.flags, session: async () => session,
      run: (c, r) => h.log.loadRunState(c, r), port: { supported: async () => true, start: producer, status: producer, output: producer, stop: producer, sync: producer } });
    closes.push(() => processes.close());
    const before = await h.store.codeProcesses!.transact(durableScope, { kind: "read" });
    const processId = before.operations[0]!.processId;
    await expect(processes.wait(ctx, { ...scope, processId, waitTimeoutMs: 0 })).rejects.toMatchObject({ code: "process_not_found", httpStatus: 404 });
    await expect(processes.cancel(ctx, { ...scope, processId })).rejects.toMatchObject({ code: "process_not_found", httpStatus: 404 });
    expect(producer).not.toHaveBeenCalled(); expect(await h.store.codeProcesses!.transact(durableScope, { kind: "read" })).toEqual(before);
  });

  it("retired budget algorithm: concurrent children share one root allowance", async () => {
    // Exercise the retained algorithm explicitly; release policy has no runtime activation switch.
    vi.spyOn(usageQuotaPolicy, "usageQuotasEnabled").mockReturnValue(true);
    const store = new InMemoryWorkspaceStore(), log = new CodeRunStateLog({ store });
    const manager = new A2AQuotaManager(), quota = new CodeRunSharedQuota(manager, { limits: { maxTokens: 12_000, maxCostUsd: 1, maxDepth: 2 } });
    const childSessions = ["child-a", "child-b"].map(id => ({ ...session, id, parentSessionId: session.id }));
    const loadSession = async ({ sessionId }: { sessionId: string }) => [session, ...childSessions].find(s => s.id === sessionId) ?? null;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const chat = vi.fn(async () => { await gate; return { content: "Finished inspection", usage: { totalTokens: 6000, promptTokens: 5000, completionTokens: 1000 } }; });
    const runner = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected tool"); } }, schemas: [], runState: log, quota,
      estimatedTokensPerCall: 1000, estimatedCostPerCallUsd: 0, engine: { chat } });
    const runAgent = vi.fn(async (input: Parameters<Parameters<typeof createCodeSubagentChildRunner>[0]["runAgent"]>[0]) => runner.run({
      ...input, subagentScope: { parentRunId: input.parentRunId, allowedTools: input.allowedTools }, verificationTools: [] }));
    const childRunner = createCodeSubagentChildRunner({ loadSession, runAgent });
    const service = new CodeSubagentOperationService({ store: store.codeProcesses!, runState: log, loadSession, childRunner: () => childRunner,
      enabled: async () => true, controlsEnabled: async () => true, spawnTool: "code.agent.spawn_async", ensureChildSession: async ({ childRunId }) => childSessions[childRunId === "a" ? 0 : 1]! });
    closes.push(() => service.close());
    await log.startRun({ ctx, ...scope, runId: "root", owner: "worker" });
    const accepted = await Promise.all(["a", "b"].map(id => service.startDetached({ ctx, ...scope, parentRunId: "root", parentOwner: "worker",
      toolCallId: id, childRunId: id, snapshotId: null, agentType: "explore", capabilityProfile: "explore", task: "Inspect src", paths: ["src"],
      model: null, maxTurns: 4, readOnly: true, summaryOnly: true, allowedTools: [], toolCallingMode: "text", maxParallelism: 2 })));
    expect(accepted.every(result => result.status === "accepted")).toBe(true);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect((await store.codeProcesses!.transact(durableScope, { kind: "read" })).operations.map(op => op.state)).toEqual(["running", "running"]);
    release(); await vi.waitFor(async () => expect((await store.codeProcesses!.transact(durableScope, { kind: "read" })).operations.every(op => op.state === "completed")).toBe(true));
    expect(runAgent.mock.calls.map(([input]) => input.quotaSessionId)).toEqual([session.id, session.id]);
    const root = await runner.run({ ctx, session, prompt: "Continue inspection", runId: "root", runStateOwner: "worker", verificationTools: [] });
    expect(root).toMatchObject({ status: "stopped", reason: "budget_exhausted" }); expect(chat).toHaveBeenCalledTimes(2);
    expect(manager.getBudget(session.id)).toMatchObject({ usedTokens: 12_000 });
    expect(manager.getBudget(childSessions[0]!.id)).toBeUndefined(); expect(manager.getBudget(childSessions[1]!.id)).toBeUndefined();
  });
});
