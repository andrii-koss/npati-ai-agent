import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatResult, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryActiveSessionRegistry } from "../apps/agent-api/src/distributed-session-registry";

const owner = { workspaceId: "early-stream-ws", userId: "early-stream-owner", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

async function fixture() {
  const store = new InMemoryWorkspaceStore(), registry = new InMemoryActiveSessionRegistry();
  let entered!: () => void, cancelled!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const chat = vi.fn((request: ChatRequest) => new Promise<ChatResult>((_resolve, reject) => {
    entered();
    if (!request.signal) { reject(new Error("Provider received no cancellation signal")); return; }
    const abort = () => { cancelled(); reject(request.signal?.reason ?? new Error("Cancelled")); };
    if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true });
  }));
  const engine: AIEngine = { chat, async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
    executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }) };
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => owner }, aiEngine: engine, marketplace, activeSessionRegistry: registry });
  apps.push(app);
  const conversation = await store.createNeutralConversation(owner, "Cancel before headers");
  const payload = { streamId: crypto.randomUUID(), message: "Build a website with a gallery", contextType: "none", conversationId: conversation.id };
  return { app, registry, store, chat, started, aborted, conversation, payload };
}
async function listen(app: ReturnType<typeof buildApp>) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
}
async function expectReleased(registry: InMemoryActiveSessionRegistry) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await registry.count(owner.workspaceId, owner.userId) === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await registry.count(owner.workspaceId, owner.userId)).toBe(0);
}

describe("security-gate: real HTTP early chat cancellation", () => {
  it("cancels provider preflight before SSE headers and refuses a duplicate without side effects", async () => {
    const f = await fixture(), base = await listen(f.app);
    const pending = fetch(base + "/chat/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.payload) });
    await f.started;
    const duplicate = await f.app.inject({ method: "POST", url: "/chat/stream", payload: f.payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("STREAM_ALREADY_ACTIVE");
    expect(f.chat).toHaveBeenCalledOnce();
    const cancellation = await f.app.inject({ method: "POST", url: "/chat/streams/" + f.payload.streamId + "/cancel" });
    expect(cancellation.json()).toEqual({ cancelled: true });
    await f.aborted;
    const response = await pending;
    expect(response.status).toBe(499);
    expect((await response.json()).error.code).toBe("CHAT_CANCELLED");
    await expectReleased(f.registry);
    expect((await f.store.getNeutralConversation(owner, f.conversation.id)).messages).toEqual([]);
    expect((await f.store.listCompanies(owner)).items).toEqual([]);
  });

  it("propagates client disconnect while semantic routing is still pending", async () => {
    const f = await fixture(), base = await listen(f.app), controller = new AbortController();
    const pending = fetch(base + "/chat/stream", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(f.payload), signal: controller.signal }).catch(error => error as Error);
    await f.started;
    controller.abort();
    expect((await pending as Error).name).toBe("AbortError");
    await f.aborted;
    await expectReleased(f.registry);
    expect((await f.store.getNeutralConversation(owner, f.conversation.id)).messages).toEqual([]);
  });

  it("returns a retryable coordination error before provider or project work", async () => {
    const f = await fixture();
    vi.spyOn(f.registry, "acquire").mockRejectedValueOnce(new Error("Private coordination endpoint"));
    const response = await f.app.inject({ method: "POST", url: "/chat/stream", payload: f.payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: "CHAT_LEASE_UNAVAILABLE", retryable: true });
    expect(response.body).not.toContain("Private coordination endpoint");
    expect(f.chat).not.toHaveBeenCalled();
    expect((await f.store.listCompanies(owner)).items).toEqual([]);
  });
});
