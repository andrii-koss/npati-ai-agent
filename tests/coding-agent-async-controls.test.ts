import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, activeCodeProcess, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { CodeSessionResumeService } from "../apps/agent-api/src/code-session-resume";
import { CodeSubagentOperationService } from "../apps/agent-api/src/code-subagent-operations";
import { CodingAgentRunner } from "../apps/agent-api/src/coding-agent-runner";
import { createCodeSubagentChildRunner } from "../apps/agent-api/src/code-subagent-child-runner";
import { codeSubagentRunId } from "../apps/agent-api/src/code-agent-spawn-executor";
import { registerCodeAgentControlRoutes } from "../apps/agent-api/src/code-agent-controls";
import { AuthenticationError } from "../apps/agent-api/src/auth";
import { CodeRbac } from "../apps/agent-api/src/code-rbac";
import { CodeToolRuntime } from "../apps/agent-api/src/code-tool-runtime";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const parent: CodeSession = { id: "parent", companyId: "c", projectId: "p", workspaceId: "w", userId: "u", status: "active",
  mode: "auto", dataClassification: "confidential", retentionClass: "standard", revision: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const child: CodeSession = { ...parent, id: "child-session", parentSessionId: parent.id };
const childRunId = codeSubagentRunId("root", "call");
const target = { ctx, companyId: "c", sessionId: parent.id, parentRunId: "root", childRunId };
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function harness() {
  const store = new InMemoryWorkspaceStore();
  const log = new CodeRunStateLog({ store });
  const loadSession = async (input: { ctx: AuthContext; companyId: string; sessionId: string }) =>
    input.ctx.userId === ctx.userId && input.ctx.workspaceId === ctx.workspaceId && input.companyId === "c"
      ? [parent, child].find((s) => s.id === input.sessionId) ?? null : null;
  const inbox = new CodeSessionInboxService({ store: store.codeInbox,
    flags: { assertEnabled: async () => true, isEnabled: async () => true },
    loadSession: (ctx, companyId, sessionId) => loadSession({ ctx, companyId, sessionId }),
    loadRunState: (companyId, runId) => log.loadRunState(companyId, runId), audit: async () => {} });
  closes.push(() => inbox.close(() => {}));
  const resume = new CodeSessionResumeService({ flags: { assertEnabled: async () => true },
    sessions: { get: async (ctx, companyId, sessionId) => {
      const session = await loadSession({ ctx, companyId, sessionId });
      if (!session) throw new Error("missing"); return { ...session, runId: childRunId };
    } }, runState: log, store: {
      getCodeSessionHead: (c, s) => store.getCodeSessionHead(c, s), setCodeSessionHead: (i) => store.setCodeSessionHead(i),
      getLatestCodeRunRecoveryNotice: (c, r) => store.getLatestCodeRunRecoveryNotice(c, r),
      listCodeContextSummaries: (i) => store.listCodeContextSummaries(i), listCodeGoals: (i) => store.listCodeGoals(i),
      getLatestCodeSessionPlan: (c, s) => store.getLatestCodeSessionPlan(c, s), listCodeSessionTodos: (i) => store.listCodeSessionTodos(i),
      listCodeRunTurns: (c, r) => store.listCodeRunTurns(c, r), getCodeRunRequest: (c, r) => store.getCodeRunRequest(c, r),
    }, inbox: { yieldTask: async (i) => { await inbox.yieldTask(i); } } });
  let block = true;
  let releaseModel: (() => void) | undefined;
  const chats: string[][] = [];
  const quotaChecks = vi.fn((_sessionId: string) => ({ allowed: true }));
  const runner = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected tool"); } }, schemas: [], runState: log, inbox,
    quota: { checkQuota: quotaChecks, recordUsage: () => {} },
    engine: { chat: async (request) => {
      chats.push(request.messages.map((m) => String(m.content)));
      if (block) await new Promise<void>((resolve, reject) => {
        releaseModel = resolve;
        if (request.signal?.aborted) reject(request.signal.reason);
        else request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
      return { content: "Finished delegated inspection" };
    } },
  });
  const runAgent = vi.fn(async (input: Parameters<Parameters<typeof createCodeSubagentChildRunner>[0]["runAgent"]>[0]) =>
    runner.run({ ...input, subagentScope: { parentRunId: input.parentRunId, allowedTools: input.allowedTools }, verificationTools: [] }));
  const adapter = createCodeSubagentChildRunner({ loadSession, runAgent });
  const flags = { enabled: true, controls: true };
  const options = { store: store.codeProcesses!, runState: log, loadSession, inbox, childRunner: () => adapter,
    enabled: async () => flags.enabled, controlsEnabled: async () => flags.controls, spawnTool: "code.agent.spawn_async",
    ensureChildSession: async () => child,
    resumeChild: async (input: { ctx: AuthContext; companyId: string; sessionId: string; runId: string; owner: string }) => {
      const boundary = (await log.loadTurnBoundary(input.companyId, input.runId))!;
      if (boundary.unknownOutcomeToolCalls.length) return { prompt: "", turnIndex: boundary.lastFinishedTurn, unknownCalls: boundary.unknownOutcomeToolCalls.length };
      const continued = await resume.resume(input);
      return { prompt: continued.resumePrompt, turnIndex: Math.max(boundary.lastFinishedTurn, boundary.incompleteTurn?.turnIndex ?? 0), unknownCalls: continued.unknownOutcomeToolCalls.length };
    } };
  const service = new CodeSubagentOperationService(options);
  closes.push(() => service.close());
  const fresh = () => { const remote = new CodeSubagentOperationService(options); closes.push(() => remote.close()); return remote; };
  await log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: parent.id, runId: "root", owner: "root-worker" });
  const start = (overrides: Partial<Parameters<CodeSubagentOperationService["startDetached"]>[0]> = {}) => service.startDetached({ ctx, companyId: "c", projectId: "p", sessionId: parent.id, parentRunId: "root",
    parentOwner: "root-worker", toolCallId: "call", childRunId, snapshotId: null, agentType: "explore", capabilityProfile: "explore",
    task: "Inspect parser", paths: ["src"], model: null, maxTurns: 8, readOnly: true, summaryOnly: true, allowedTools: [], toolCallingMode: "text", ...overrides });
  const op = async () => (await service.listChildren({ companyId: "c", projectId: "p", sessionId: parent.id,
    dataClassification: parent.dataClassification, retentionClass: parent.retentionClass }, "root"))[0]!;
  const started = async () => { expect(await start()).toMatchObject({ status: "accepted" }); await vi.waitFor(async () => {
    if (!chats.length && runAgent.mock.results[0]) {
      const state = await op(); expect(state.state, JSON.stringify(state.output)).not.toBe("failed");
    }
    expect(chats).toHaveLength(1);
  }); };
  const paused = async () => { await vi.waitFor(async () => expect((await op()).state).toBe("interrupted")); };
  return { store, log, inbox, service, fresh, flags, chats, runAgent, quotaChecks, start, started, paused, op,
    unblock: () => { block = false; }, finishModel: () => { block = false; releaseModel?.(); } };
}

describe("Step 6: controls use the existing runner, inbox and C10 continuation", () => {
  it("interrupts at the runner boundary, retains the fence, resumes the same run and deduplicates Continue", async () => {
    const h = await harness(); await h.started();
    expect(await h.service.interrupt(target)).toBe("requested"); await h.paused();
    expect(activeCodeProcess(await h.op())).toBe(true);
    expect((await h.op()).completion).toBeUndefined();
    expect(await h.log.loadRunState("c", childRunId)).toMatchObject({ sessionId: child.id, status: "interrupted" });
    h.unblock();
    expect(await h.service.continueChild({ ...target, requestId: "continue-1" })).toMatchObject({ childRunId, duplicate: false });
    expect(await h.service.continueChild({ ...target, requestId: "continue-1" })).toMatchObject({ childRunId, duplicate: true });
    await vi.waitFor(async () => expect((await h.op()).state).toBe("completed"));
    expect(h.runAgent).toHaveBeenCalledTimes(2);
    expect(h.runAgent.mock.calls[1]![0].prompt).toContain("Inspect parser");
    expect(h.runAgent.mock.calls.map(([i]) => i.runId)).toEqual([childRunId, childRunId]);
    expect(activeCodeProcess(await h.op())).toBe(false);
    expect(h.quotaChecks.mock.calls.every(([id]) => id === parent.id)).toBe(true);
  });

  it("routes a deduplicated message only to the child and consumes input sent while paused on Continue", async () => {
    const h = await harness(); await h.started();
    await h.service.interrupt(target); await h.paused();
    const message = { ...target, requestId: "message-1", text: "Also inspect database constraints" };
    const first = await h.service.sendMessage(message);
    expect(await h.service.sendMessage(message)).toMatchObject({ messageId: first.messageId });
    expect((await h.inbox.transact(parent, { kind: "read" })).state.messages).toEqual([]);
    h.unblock(); await h.service.continueChild({ ...target, requestId: "resume-message" });
    await vi.waitFor(async () => expect((await h.op()).state).toBe("completed"));
    expect(h.chats.slice(1).flat().join("\n")).toContain(message.text);
    expect((await h.inbox.transact(child, { kind: "read" })).state.messages).toHaveLength(1);
    expect((await h.inbox.transact(child, { kind: "read" })).state.messages[0]!.status).toBe("admitted");
  });

  it("admits live steering at the next boundary without a second driver", async () => {
    const h = await harness(); await h.started();
    expect(await h.service.sendMessage({ ...target, requestId: "steer", text: "Inspect indexes too" })).toMatchObject({ target: "next-step" });
    expect(h.chats).toHaveLength(1); h.finishModel();
    await vi.waitFor(async () => expect((await h.op()).state).toBe("completed"));
    expect(h.chats).toHaveLength(2);
    expect(h.chats[1]!.join("\n")).toContain("Inspect indexes too");
    expect(h.runAgent).toHaveBeenCalledOnce();
  });

  it("serializes concurrent Continue requests through the existing C10 lease", async () => {
    const h = await harness(); await h.started(); await h.service.interrupt(target); await h.paused();
    const responses = await Promise.allSettled([h.service, h.fresh()].map((service, i) => service.continueChild({ ...target, requestId: `concurrent-${i}` })));
    expect(responses.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter((r) => r.status === "rejected")).toHaveLength(1);
    await vi.waitFor(() => expect(h.chats).toHaveLength(2));
    expect(h.runAgent).toHaveBeenCalledTimes(2);
  });

  it("recognizes an older Continue receipt after a later pause and Continue", async () => {
    const h = await harness(); await h.started(); await h.service.interrupt(target); await h.paused();
    await h.service.continueChild({ ...target, requestId: "first" });
    await vi.waitFor(() => expect(h.chats).toHaveLength(2));
    await h.service.interrupt(target); await h.paused();
    await h.service.continueChild({ ...target, requestId: "second" });
    await vi.waitFor(() => expect(h.chats).toHaveLength(3));
    expect(await h.service.continueChild({ ...target, requestId: "first" })).toMatchObject({ duplicate: true });
    expect(h.runAgent).toHaveBeenCalledTimes(3);
  });

  it("parent Stop settles children before the root reaches a terminal state", async () => {
    const h = await harness(); await h.started(); await h.service.interrupt(target); await h.paused();
    const release = vi.fn(async () => {});
    const root = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected"); } }, schemas: [], runState: h.log,
      engine: { chat: async () => { throw new Error("Stop must precede model call"); } }, sandbox: { release },
      activeChildren: { settle: (i) => h.service.settleChildren({ ...i, parentRunId: i.runId, timeoutMs: 1000 }),
        isUnsettled: (i) => h.service.hasRequiredChild({ ...i, parentRunId: i.runId }) } });
    const result = await root.run({ ctx, session: parent, prompt: "Inspect project", runId: "root", runStateOwner: "root-worker", cancelRequested: () => true });
    expect(result.status).toBe("cancelled");
    expect((await h.log.loadRunState("c", "root"))?.status).toBe("cancelled");
    expect((await h.log.loadRunState("c", childRunId))?.status).toBe("cancelled");
    expect(activeCodeProcess(await h.op())).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("a root with an unsettled child remains interrupted and retains its sandbox", async () => {
    const h = await harness(); await h.started();
    const release = vi.fn(async () => {});
    const root = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected"); } }, schemas: [], runState: h.log,
      engine: { chat: async () => ({ content: "Root inspection finished" }) }, sandbox: { release },
      activeChildren: { settle: (i) => h.service.settleChildren({ ...i, parentRunId: i.runId, timeoutMs: 1 }),
        isUnsettled: (i) => h.service.hasRequiredChild({ ...i, parentRunId: i.runId }) } });
    const result = await root.run({ ctx, session: parent, prompt: "Inspect project", runId: "root", runStateOwner: "root-worker", verificationTools: [] });
    expect(result).toMatchObject({ status: "interrupted", reason: "active_subagent_unsettled" });
    expect((await h.log.loadRunState("c", "root"))?.status).toBe("interrupted");
    expect(release).not.toHaveBeenCalled();
  });

  it("delivers remote-owner cancel intent and reconstructs continuation with a fresh service", async () => {
    const h = await harness(); await h.started();
    const remote = h.fresh();
    expect(await remote.interrupt(target)).toBe("pending_remote"); await h.paused();
    await h.service.close(); h.unblock();
    await remote.continueChild({ ...target, requestId: "restart" });
    await vi.waitFor(async () => expect((await h.op()).state).toBe("completed"));
    expect(h.runAgent).toHaveBeenCalledTimes(2);
  });

  it("refuses unknown write outcomes before acquiring a continuation lease or invoking the model", async () => {
    const h = await harness(); await h.started(); await h.service.interrupt(target); await h.paused();
    await h.log.appendToolCall({ companyId: "c", runId: childRunId, turnIndex: 1, toolCallId: "lost-write",
      tool: "code.fs.write", readOnly: false, outcome: "unknown_outcome", finishedAt: null });
    await expect(h.service.continueChild({ ...target, requestId: "unsafe" })).rejects.toMatchObject({ code: "subagent_unknown_outcome" });
    expect(h.runAgent).toHaveBeenCalledOnce();
    expect((await h.log.loadRunState("c", childRunId))?.status).toBe("interrupted");
  });

  it("refuses live takeover and foreign parent, company, workspace and user identities", async () => {
    const h = await harness(); await h.started();
    await expect(h.service.continueChild({ ...target, requestId: "busy" })).rejects.toMatchObject({ code: "subagent_control_busy" });
    for (const override of [{ parentRunId: "other" }, { childRunId: "other" }, { companyId: "other" },
      { ctx: { ...ctx, userId: "other" } }, { ctx: { ...ctx, workspaceId: "other" } }]) {
      await expect(h.service.interrupt({ ...target, ...override })).rejects.toMatchObject({ httpStatus: 404 });
    }
    expect((await h.op()).cancelRequested).toBe(false);
  });

  it("rejects nested dispatch from durable child identity and refuses delegation of control tools", async () => {
    const h = await harness(); await h.started();
    expect(await h.start({ sessionId: child.id, parentRunId: childRunId, parentOwner: `subagent-${childRunId}`,
      toolCallId: "nested", childRunId: "nested-child" })).toMatchObject({ status: "refused", code: "subagent_depth_exceeded" });
    expect(await h.start({ toolCallId: "control-delegation", allowedTools: ["code.agent.continue"] })).toMatchObject({ status: "refused", code: "subagent_tool_not_delegable" });
    expect(h.runAgent).toHaveBeenCalledOnce();
  });

  it("blocks new work after rollback while existing work can still be interrupted and settled by parent Stop", async () => {
    const h = await harness(); await h.started(); h.flags.enabled = false; h.flags.controls = false;
    await expect(h.service.sendMessage({ ...target, requestId: "off", text: "More work" })).rejects.toMatchObject({ code: "subagent_detached_disabled" });
    expect(await h.service.interrupt(target)).toBe("requested"); await h.paused();
    await expect(h.service.continueChild({ ...target, requestId: "off" })).rejects.toMatchObject({ code: "subagent_detached_disabled" });
    expect(await h.service.settleChildren({ ...target, cancel: true, timeoutMs: 1000 })).toBe(true);
    expect((await h.op()).state).toBe("failed");
    expect(activeCodeProcess(await h.op())).toBe(false);
  });

  it("keeps the parent fenced when its child cannot settle before the deadline", async () => {
    const h = await harness(); await h.started();
    expect(await h.service.settleChildren({ ...target, cancel: false, timeoutMs: 1 })).toBe(false);
    expect(activeCodeProcess(await h.op())).toBe(true);
  });

  it("authenticates and authorizes the public control routes before touching a child", async () => {
    const h = await harness(); await h.started(); const app = Fastify(); closes.push(() => app.close());
    const rbac = new CodeRbac({ audit: { record: async () => {} } });
    registerCodeAgentControlRoutes(app, { service: () => h.service,
      auth: { authenticate: async (r) => { if (!r.headers.authorization) throw new AuthenticationError("missing");
        return r.headers.authorization === "reader" ? { ...ctx, permissions: ["workspace:read"], codeRole: "reviewer" } : ctx; } },
      authorize: (ctx, company, input) => rbac.authorize(ctx, company, input) });
    const url = `/companies/c/code/sessions/${parent.id}/runs/root/children/${childRunId}/send_message`;
    expect((await app.inject({ method: "POST", url, payload: { requestId: "api", text: "Check API" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { authorization: "reader" }, payload: { requestId: "api", text: "Check API" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: { authorization: "test" }, payload: { requestId: "api", text: "Check API" } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: url.replace("/runs/root/", "/runs/foreign/"), headers: { authorization: "test" },
      payload: { requestId: "api", text: "Check API" } })).statusCode).toBe(404);
  });

  it("cannot mutate outside a writing child's recorded paths or use shell to escape confinement", async () => {
    const store = new InMemoryWorkspaceStore(); const flags = new FeatureFlagService(store);
    vi.spyOn(flags, "assertEnabled").mockResolvedValue(true);
    const execute = vi.fn(async () => ({}));
    const runtime = new CodeToolRuntime({ flags, executors: { "code.fs.write": execute, "code.fs.move": execute,
      "code.fs.apply_patch": execute, "code.shell.exec": execute } });
    for (const [tool, args] of [
      ["code.fs.write", { path: "other/a.ts", content: "change" }],
      ["code.fs.move", { from: "src/a.ts", to: "other/a.ts" }],
      ["code.fs.apply_patch", { patch: "*** Begin Patch\n*** Add File: other/a.ts\n+change\n*** End Patch" }],
      ["code.shell.exec", { command: "echo change > other/a.ts" }],
    ] as const) {
      const result = await runtime.invoke(ctx, { companyId: "c", projectId: "p", sessionId: child.id, tool, args,
        toolCallId: "scope-call", parentRunId: "root", capabilityScope: [tool], subagentWritePaths: ["src"] });
      expect(result).toMatchObject({ ok: false, error: { code: "subagent_path_outside_scope" } });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("creates the same durable child session on retries and keeps the parent identity intact", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(ctx, { name: "Controls" }, "company");
    const project = await store.createProject(ctx, company.id, { name: "Controls", type: "code_project" }, "project");
    const parent = await store.createCodeSession(ctx, company.id, project.project.id, { mode: "auto" });
    const input = { mode: "auto" as const, parentSessionId: parent.id, childKey: childRunId };
    const [first, repeated] = await Promise.all([store.createCodeSession(ctx, company.id, project.project.id, input), store.createCodeSession(ctx, company.id, project.project.id, input)]);
    expect(first.id).toBe(repeated.id); expect(first.id).not.toBe(parent.id);
    expect(first.parentSessionId).toBe(parent.id);
    expect(await store.getCodeSession(ctx, company.id, parent.id)).toEqual(parent);
  });
});
