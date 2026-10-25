import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodingAgentRunner, type CodingAgentRunnerPorts } from "../apps/agent-api/src/coding-agent-runner";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { registerCodeSessionInboxRoutes } from "../apps/agent-api/src/code-session-inbox-routes";
import { CodeSessionRunExecutor } from "../apps/agent-api/src/code-session-run-executor";
import { CodeRbac } from "../apps/agent-api/src/code-rbac";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import type { AuthProvider } from "../apps/agent-api/src/auth";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };
const session: CodeSession = { id: "s", companyId: "c", projectId: "p", workspaceId: "w", userId: "u", status: "active",
  mode: "auto", dataClassification: "confidential", retentionClass: "standard", revision: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
function setup() {
  const store = new InMemoryWorkspaceStore();
  const log = new CodeRunStateLog({ store });
  const audit = vi.fn(async () => {});
  const inbox = new CodeSessionInboxService({ store: store.codeInbox, flags: { assertEnabled: async () => true, isEnabled: async () => true },
    loadSession: async (_ctx, companyId, sessionId) => companyId === session.companyId && sessionId === session.id ? session : null,
    loadRunState: (companyId, runId) => log.loadRunState(companyId, runId), audit });
  const start = (runId = "r", owner = "worker") => log.startRun({ ctx, companyId: "c", projectId: "p", sessionId: "s", owner, runId });
  const op = (command: Parameters<typeof inbox.transact>[1]) => inbox.transact(session, command);
  const submit = (requestId: string, mode: "queue" | "steer" = "steer", text = requestId) => inbox.submit(ctx, "c", "s", { requestId, mode, text });
  const open = (runId = "r", owner = "worker") => op({ kind: "open", runId, owner });
  return { store, log, inbox, audit, start, op, submit, open };
}

describe("async inbox: durable state and races", () => {
  it("steer targets the boundary; queue waits for the next task", async () => {
    const h = setup(); await h.start(); await h.open();
    expect((await h.submit("database")).messages[0]!.target).toBe("next-step");
    await h.submit("next", "queue");
    const admitted = await h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 2 });
    expect(admitted.messages.map((m) => m.text)).toEqual(["database"]);
    expect(admitted.state.messages.find((m) => m.text === "next")?.status).toBe("pending");
    expect((await h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 3 })).messages).toEqual([]);
  });
  it("deduplicates retried request ids and refuses changed requests", async () => {
    const h = setup();
    const first = await h.submit("req"); const repeated = await h.submit("req");
    expect(repeated.state.revision).toBe(first.state.revision);
    expect(repeated.messages[0]!.id).toBe(first.messages[0]!.id);
    await expect(h.submit("req", "queue")).rejects.toMatchObject({ code: "inbox_request_conflict" });
    await expect(h.submit("req", "queue", "changed")).rejects.toMatchObject({ code: "inbox_request_conflict" });
  });
  it("retries the original submit after a pending edit without undoing the edit", async () => {
    const h = setup();
    const first = (await h.submit("req", "queue", "original")).messages[0]!;
    await h.op({ kind: "edit", id: first.id, text: "edited", expectedRevision: first.revision });
    const repeated = await h.submit("req", "queue", "original");
    expect(repeated.messages[0]!).toMatchObject({ id: first.id, text: "edited", revision: 2 });
    await expect(h.submit("req", "queue", "edited")).rejects.toMatchObject({ code: "inbox_request_conflict" });
  });
  it("serializes two distinct run admissions into one session driver", async () => {
    const h = setup(); await h.start("a", "a"); await h.start("b", "b");
    const results = await Promise.allSettled([h.open("a", "a"), h.open("b", "b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("restores admitted input after ownership takeover and fences stale delivery", async () => {
    const h = setup(); await h.start(); await h.open(); await h.submit("database");
    await h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 2 });
    await h.log.releaseLease({ companyId: "c", runId: "r", owner: "worker" });
    await h.log.acquireLease({ companyId: "c", runId: "r", owner: "new-worker" });
    expect((await h.open("r", "new-worker")).messages.map((m) => m.text)).toEqual(["database"]);
    await expect(h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 3 })).rejects.toMatchObject({ code: "inbox_lease_lost" });
    await h.op({ kind: "close", runId: "r", owner: "worker" });
    expect((await h.op({ kind: "read" })).state.phase).toBe("running");
  });
  it("fences a losing driver's cleanup and holds new admission until cleanup release", async () => {
    const h = setup(); await h.start("winner", "winner"); await h.open("winner", "winner");
    await h.start("loser", "loser");
    await h.log.markFinished({ companyId: "c", runId: "loser", status: "failed", reason: "failed" });
    expect(await h.inbox.mayCleanup(ctx, session, { runId: "loser" })).toBe(false);
    expect(await h.inbox.mayCleanup(ctx, session, { runId: "winner" })).toBe(false);
    await h.op({ kind: "close", runId: "winner", owner: "winner" });
    await h.log.markFinished({ companyId: "c", runId: "winner", status: "completed", reason: "completed" });
    await h.start("next", "next");
    await expect(h.open("next", "next")).rejects.toMatchObject({ code: "session_run_held" });
    expect(await h.inbox.mayCleanup(ctx, session, { runId: "winner" })).toBe(true);
    await h.op({ kind: "release-task", runId: "winner" });
    await h.open("next", "next");
    expect(await h.inbox.mayCleanup(ctx, session, { runId: "winner" })).toBe(false);
  });
  it("edit and claim are revision checked, without rewriting admitted input", async () => {
    const h = setup(); await h.start(); await h.open();
    const m = (await h.submit("db")).messages[0]!;
    await h.op({ kind: "edit", id: m.id, text: "database schema", expectedRevision: 1 });
    await expect(h.op({ kind: "discard", id: m.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "inbox_revision_conflict" });
    await h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 2 });
    await expect(h.op({ kind: "edit", id: m.id, text: "late", expectedRevision: 2 })).rejects.toMatchObject({ code: "inbox_message_not_pending" });
  });
  it("final cutoff either keeps steer in this task or explicitly receipts next-turn", async () => {
    const h = setup(); await h.start(); await h.open();
    await h.submit("before");
    expect((await h.op({ kind: "seal", runId: "r", owner: "worker" })).sealed).toBe(false);
    await h.op({ kind: "drain", runId: "r", owner: "worker", turnIndex: 2 });
    expect((await h.op({ kind: "seal", runId: "r", owner: "worker" })).sealed).toBe(true);
    expect((await h.submit("after")).messages[0]!.target).toBe("next-turn");
  });
  it("does not start queue before terminal settlement AND transport cleanup", async () => {
    const h = setup(); await h.start(); await h.open(); await h.submit("next", "queue");
    await h.op({ kind: "close", runId: "r", owner: "worker" });
    await h.log.markFinished({ companyId: "c", runId: "r", status: "completed", reason: "completed" });
    expect((await h.op({ kind: "take-task" })).messages).toEqual([]);
    await h.op({ kind: "release-task", runId: "r" });
    const first = await h.op({ kind: "take-task" });
    const retry = await h.op({ kind: "take-task" });
    expect(first.messages[0]!.status).toBe("claimed");
    expect(retry.messages[0]!.runId).toBe(first.messages[0]!.runId);
    await h.start(first.messages[0]!.runId!, "next-worker");
    expect((await h.op({ kind: "take-task" })).messages).toEqual([]);
    await h.op({ kind: "open", runId: first.messages[0]!.runId!, owner: "next-worker", initialMessageId: first.messages[0]!.id });
  });
  it("does not execute a queued task using a different author's authority", async () => {
    const h = setup(); await h.submit("queued", "queue");
    expect((await h.op({ kind: "take-task", authorId: "other-user" })).messages).toEqual([]);
    expect((await h.op({ kind: "read" })).state.phase).toBe("idle");
    const task = await h.op({ kind: "take-task", authorId: ctx.userId });
    expect(task.messages).toHaveLength(1);
    expect((await h.op({ kind: "take-task", authorId: "other-user" })).messages).toEqual([]);
    expect((await h.op({ kind: "take-task", authorId: ctx.userId })).messages[0]!.runId).toBe(task.messages[0]!.runId);
  });
  it("refuses credentials and preserves tenant isolation", async () => {
    const h = setup();
    await expect(h.inbox.submit(ctx, "foreign", "s", { requestId: "x", mode: "queue", text: "auth" })).rejects.toMatchObject({ code: "session_not_found" });
    await expect(h.submit("secret", "queue", `sk-${"a".repeat(40)}`)).rejects.toMatchObject({ code: "inbox_credential_refused" });
    expect((await h.op({ kind: "read" })).state.messages).toEqual([]);
  });
  it("uses the configured self-hosted default for the inbox without bypassing disabled installations", async () => {
    const flags = new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault: true });
    expect(await flags.isEnabled(ctx, "coding_agent.enabled")).toBe(true);
    expect(await flags.isEnabled(ctx, "code.async_inbox")).toBe(true);
    const disabled = new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault: false });
    expect(await disabled.isEnabled(ctx, "code.async_inbox")).toBe(false);
  });
  it("does not lose a wake arriving during the prior wake's last await", async () => {
    const h = setup(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    h.inbox.setWakeTask(async () => { count++; if (count === 1) { entered(); await barrier; } });
    const first = h.inbox.wake(ctx, "c", "s");
    await started; await h.inbox.wake(ctx, "c", "s"); release(); await first;
    expect(count).toBe(2);
  });
  it("records dispatch failure without discarding accepted tasks", async () => {
    const h = setup(); await h.submit("queued", "queue");
    h.inbox.setWakeTask(async () => { throw new Error("admission failed"); });
    await h.inbox.wake(ctx, "c", "s");
    const state = (await h.op({ kind: "read" })).state;
    expect(state.lastError).toBe("inbox_dispatch_failed");
    expect(state.messages[0]!.status).toBe("pending");
  });
  it("shutdown cancels and drains wake lifetimes while leaving input durable", async () => {
    const h = setup(); await h.submit("queued", "queue");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    h.inbox.setWakeTask(async (_ctx, _session, signal) => {
      entered(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const running = h.inbox.wake(ctx, "c", "s"); await started;
    const cancel = vi.fn(); await h.inbox.close(cancel); await running;
    expect(cancel).toHaveBeenCalledWith("s");
    expect((await h.op({ kind: "read" })).state.messages[0]!.status).toBe("pending");
  });
});

describe("async inbox: actual runner integration", () => {
  it("next-turn uses a new stable run id in the same Coding Session without replacing the existing chat", async () => {
    const h = setup();
    const chat = await h.store.createNeutralConversation(ctx, "Auth task");
    await h.store.appendNeutralMessage(ctx, chat.id, "user", "Fix auth");
    const existingChat = await h.store.getNeutralConversation(ctx, chat.id);
    const createChat = vi.spyOn(h.store, "createNeutralConversation");
    let entered!: () => void; let release!: () => void;
    const inModel = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[][] = [];
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("No tool requested"); } },
      schemas: [], runState: h.log, inbox: h.inbox,
      engine: { chat: async (request) => {
        calls.push(request.messages.map((m) => String(m.content)));
        if (calls.length === 1) { entered(); await barrier; }
        return { content: calls.length === 1 ? "Auth checked" : "Database checked" };
      } },
    });
    const control = { clearSession: vi.fn(), registerController: vi.fn(), unregisterController: vi.fn() };
    const executor = new CodeSessionRunExecutor({ runner, control });
    const original = structuredClone(session);
    const first = executor.execute({ ctx, session, prompt: "Fix auth", runId: "auth-run", cancelRequested: () => false });
    await inModel;
    const accepted = await h.submit("database-task", "queue", "Check database");
    release();
    expect((await first).terminalStatus).toBe("completed");
    await h.op({ kind: "release-task", runId: "auth-run" });
    const task = (await h.op({ kind: "take-task", authorId: ctx.userId })).messages[0]!;
    const reconnect = await h.submit("database-task", "queue", "Check database");
    expect(reconnect.messages[0]!.id).toBe(accepted.messages[0]!.id);
    expect((await h.op({ kind: "take-task", authorId: ctx.userId })).messages[0]!.runId).toBe(task.runId);
    expect(task.runId).not.toBe("auth-run");
    const next = await executor.execute({ ctx, session, prompt: task.text, runId: task.runId!,
      initialInboxMessageId: task.id, cancelRequested: () => false });
    expect(next.terminalStatus).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("Check database");
    expect(calls[1]).toContain("Check database");
    for (const runId of ["auth-run", task.runId!]) {
      expect(await h.log.loadRunState("c", runId)).toMatchObject({ runId, sessionId: session.id, status: "completed" });
    }
    expect(session).toEqual(original);
    expect(createChat).not.toHaveBeenCalled();
    expect(await h.store.getNeutralConversation(ctx, chat.id)).toEqual(existingChat);
    expect(control.registerController.mock.calls.map(([id]) => id)).toEqual([session.id, session.id]);
    expect((await h.op({ kind: "read" })).state.messages[0]!).toMatchObject({ status: "admitted", runId: task.runId, turnIndex: 0 });
  });
  it("a duplicate deterministic run id cannot fail or dispatch the healthy owner's run", async () => {
    const h = setup(); await h.start("r", "healthy-owner");
    const engine = vi.fn(async () => ({ content: "unexpected" }));
    const runner = new CodingAgentRunner({ flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [], invoke: async () => { throw new Error("unexpected"); } }, engine: { chat: engine }, schemas: [], runState: h.log, inbox: h.inbox });
    const result = await runner.run({ ctx, session, prompt: "auth", runId: "r", runStateOwner: "stale-owner" });
    expect(result.status).toBe("interrupted");
    expect(engine).not.toHaveBeenCalled();
    expect((await h.store.getCodeRunState("c", "r"))?.status).toBe("running");
  });
  it("sees steer after the in-flight response, without consuming next-turn or repeating the first request", async () => {
    const h = setup();
    let resolveModel!: () => void; let entered!: () => void;
    const inModel = new Promise<void>((resolve) => { entered = resolve; });
    const modelGate = new Promise<void>((resolve) => { resolveModel = resolve; });
    const calls: string[][] = [];
    const ports: CodingAgentRunnerPorts = {
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => [{ name: "code.fs.read", description: "Read a workspace file", version: 1, status: "active", write: false }],
        invoke: async () => { throw new Error("No tool requested"); } }, schemas: [],
      runState: h.log, inbox: h.inbox,
      engine: { chat: async (request) => {
        calls.push(request.messages.map((m) => String(m.content)));
        if (calls.length === 1) { entered(); await modelGate; }
        return { content: calls.length === 1 ? "auth findings" : "auth and database findings" };
      } }, limits: { maxStepsPerRun: 5 },
    };
    const running = new CodingAgentRunner(ports).run({ ctx, session, prompt: "fix auth", runId: "r", runStateOwner: "worker", verificationTools: [] });
    await inModel;
    await h.submit("database"); await h.submit("later-task", "queue");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("database");
    resolveModel();
    expect((await running).status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("database");
    expect(calls[1]).not.toContain("later-task");
    expect((await h.op({ kind: "read" })).state.messages.find((m) => m.text === "later-task")?.status).toBe("pending");
  });
});

describe("async inbox: API security", () => {
  it("publishes scoped revision hints after commit, contains observer failures and unsubscribes", async () => {
    const h = setup();
    const revisions: number[] = [], foreign = vi.fn();
    const stop = h.inbox.observe("c", "s", (revision) => revisions.push(revision));
    h.inbox.observe("foreign", "s", foreign);
    h.inbox.observe("c", "s", () => { throw new Error("UI disconnected"); });
    const accepted = await h.submit("observed", "queue");
    expect(revisions).toEqual([accepted.state.revision]);
    expect(foreign).not.toHaveBeenCalled();
    await h.submit("observed", "queue"); // An idempotent transport retry publishes no duplicate hint.
    expect(revisions).toHaveLength(1);
    await h.op({ kind: "read" });
    expect(revisions).toHaveLength(1);
    expect((await h.op({ kind: "read" })).state.messages[0]!.id).toBe(accepted.messages[0]!.id);
    stop(); await h.submit("second", "queue");
    expect(revisions).toHaveLength(1);
  });
  it("uses real RBAC and server author identity before session reads", async () => {
    const h = setup(); const app = Fastify(); const rbac = new CodeRbac({ audit: { record: async () => {} } });
    let caller = ctx;
    registerCodeSessionInboxRoutes(app, { service: h.inbox,
      auth: { authenticate: async () => caller } as unknown as AuthProvider,
      authorize: (auth, companyId, input) => rbac.authorize(auth, companyId, input) });
    try {
      caller = { ...ctx, permissions: ["workspace:read"] };
      expect((await app.inject({ method: "POST", url: "/companies/c/code/sessions/s/messages", payload: { requestId: "r", mode: "queue", text: "auth" } })).statusCode).toBe(403);
      expect(h.audit).not.toHaveBeenCalled();
      caller = ctx;
      const accepted = await app.inject({ method: "POST", url: "/companies/c/code/sessions/s/messages", payload: { requestId: "r", mode: "steer", text: "auth", authorId: "forged" } });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json().receipt).toMatchObject({ authorId: "u", target: "next-turn" });
      expect((await app.inject({ method: "GET", url: "/companies/foreign/code/sessions/s/messages" })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe("a closed epoch of a run that is no longer live", () => {
  it("lets the next run of the session open the inbox, while a live run's closed epoch still fences it", async () => {
    const { applyCodeInbox, emptyCodeInbox } = await import("@npati/workspace");
    const now = new Date("2026-10-25T10:52:58.000Z");
    const opened = applyCodeInbox(emptyCodeInbox(), { kind: "open", runId: "run-a", owner: "w" }, [{ runId: "run-a", owner: "w", live: true, terminal: false }], now).state;
    const settled = applyCodeInbox(opened, { kind: "close", runId: "run-a", owner: "w" }, [{ runId: "run-a", owner: "w", live: true, terminal: false }], now).state;
    expect(settled.phase).toBe("settled");
    // run-a was interrupted when its lease expired: not live and not terminal (it could still be resumed).
    const next = applyCodeInbox(settled, { kind: "open", runId: "run-b", owner: "w" },
      [{ runId: "run-a", owner: null, live: false, terminal: false }, { runId: "run-b", owner: "w", live: true, terminal: false }], now);
    expect(next.state).toMatchObject({ phase: "running", runId: "run-b" });
    expect(() => applyCodeInbox(settled, { kind: "open", runId: "run-b", owner: "w" },
      [{ runId: "run-a", owner: "w", live: true, terminal: false }, { runId: "run-b", owner: "w", live: true, terminal: false }], now)).toThrow("session_run_held");
  });
});
