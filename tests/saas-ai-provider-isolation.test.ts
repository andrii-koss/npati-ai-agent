/**
 * Hosted (SaaS) AI provider isolation, end to end through the real OmniRoute engine.
 *
 * Two accounts share one installation. A fake OmniRoute records the API key every inference request is made with, and
 * a stub marketplace stands in for OmniRoute's provider management. One account must never see, use, test, refresh or
 * delete another account's provider connection, and every inference must run with the account's own scoped key —
 * never with the installation key and never with another account's key.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { AIProviderSummary, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import type { AuthContext } from "@npati/workspace";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";

const permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
const accounts: Record<string, AuthContext> = {
  A: { userId: "saas-ai-a", workspaceId: "workspace:saas-ai-a", permissions },
  B: { userId: "saas-ai-b", workspaceId: "workspace:saas-ai-b", permissions },
};

// ---- Fake OmniRoute inference endpoint: records which key each request used ----
const inference: Array<{ path: string; key: string; model: string }> = [];
let server: http.Server;
let baseUrl = "";
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const body = raw ? JSON.parse(raw) : {};
      if (request.url?.startsWith("/api/v1/chat/completions")) {
        inference.push({ path: request.url, key, model: body.model });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "probe answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }
      if (request.url?.startsWith("/api/v1/models")) {
        inference.push({ path: request.url, key, model: "" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---- Stub OmniRoute provider management ----
function stubMarketplace() {
  const provider = (id: string, extra: Partial<AIProviderSummary> = {}): AIProviderSummary => ({
    id, name: id, category: "llm", authType: "api_key", connectionStatus: "not_connected", freeStatus: "paid", local: false, modelCount: 1,
    capabilities: ["chat"], connected: false, recommended: true, experimental: false, credentialOptional: false, connectable: true,
    connectionMode: "api_key" as AIProviderSummary["connectionMode"], availability: "requires_credentials", connections: [], ...extra,
  });
  const catalog = new Map<string, AIProviderSummary>([
    ["openai", provider("openai")],
    ["anthropic", provider("anthropic")],
    ["claude-code", provider("claude-code", { authType: "oauth", connectionMode: "oauth" as AIProviderSummary["connectionMode"] })],
    ["ollama", provider("ollama", { authType: "local", local: true, credentialOptional: true, connectionMode: "local" as AIProviderSummary["connectionMode"] })],
  ]);
  const keys = new Map<string, { key: string; allowed: string[] }>();
  const deleted: string[] = [];
  const snapshot = (p: AIProviderSummary) => ({ ...p, connected: p.connections.length > 0, connectionStatus: (p.connections.length ? "connected" : "not_connected") as AIProviderSummary["connectionStatus"], connections: [...p.connections] });
  const market = {
    keys, deleted, catalog,
    async marketplace(query: { tab?: string } = {}) {
      const all = [...catalog.values()].map(snapshot);
      const providers = query.tab === "connected" ? all.filter((p) => p.connected) : all;
      return { source: { version: "t", commit: "t", registryProviders: 4, routableProviders: 4 },
        overview: { providers: all.length, models: 4, connectedProviders: all.filter((p) => p.connected).length, addedModels: 0 },
        counts: { connected: all.filter((p) => p.connected).length, recommended: 4, free: 0, local: 1, all: 4 },
        availableFilters: { auth: [], cost: [], capabilities: [] }, providers,
        pagination: { offset: 0, limit: 24, returned: providers.length, total: providers.length, hasMore: false } };
    },
    async provider(id: string) {
      const p = catalog.get(id);
      if (!p) throw Object.assign(new Error("Provider not found"), { status: 404 });
      return snapshot(p);
    },
    async models(providerId: string) {
      return [{ id: `${providerId}/model-1`, upstreamId: "model-1", providerId, providerName: providerId, name: "Model 1", capabilities: ["chat"], added: false, local: false, freeStatus: "paid" }];
    },
    async connect(providerId: string, input: { apiKey?: string }, options: { ownedBy?: string } = {}) {
      const p = catalog.get(providerId)!;
      if (!options.ownedBy && p.connections.length) throw Object.assign(new Error("Provider is already configured"), { status: 409 });
      const connectionId = randomUUID();
      p.connections.push({ id: connectionId, name: `owner:${options.ownedBy ?? "shared"} key:${input.apiKey}` } as never);
      return { connected: true, healthy: true, providerId, connectionId, status: "connected", test: { valid: true } };
    },
    async deleteConnection(connectionId: string) {
      deleted.push(connectionId);
      for (const p of catalog.values()) p.connections = p.connections.filter((c) => c.id !== connectionId);
      return { disconnected: true, connectionId };
    },
    async testConnection(connectionId: string) { return { valid: true, connectionId }; },
    async refreshConnectionModels(connectionId: string) { return { refreshed: true, connectionId }; },
    async createScopedApiKey(_name: string, ids: string[]) {
      const id = randomUUID(), key = `scoped-${id.slice(0, 8)}`;
      keys.set(id, { key, allowed: ids.length ? ids : ["00000000-0000-4000-8000-000000000000"] });
      return { id, key };
    },
    async setApiKeyConnections(keyId: string, ids: string[]) {
      keys.get(keyId)!.allowed = ids.length ? ids : ["00000000-0000-4000-8000-000000000000"];
    },
    async disconnect() { throw new Error("shared disconnect must not be used on a hosted installation"); },
    async test() { throw new Error("shared test must not be used on a hosted installation"); },
    async refreshModels() { throw new Error("shared refresh must not be used on a hosted installation"); },
  };
  return market;
}

it("each account uses only its own AI provider connections and key", async () => {
  const market = stubMarketplace();
  const previous = process.env.NPATI_AI_PROVIDER_ISOLATION;
  delete process.env.NPATI_AI_PROVIDER_ISOLATION;
  const app = buildApp({
    deploymentType: "npati_hosted", omnirouteBaseUrl: baseUrl, omnirouteApiKey: "installation-key",
    marketplace: market as unknown as OmniRouteMarketplace,
    authProvider: { authenticate: async (request: { headers: Record<string, string | undefined> }) => {
      const who = request.headers["x-account"] ?? "";
      if (!accounts[who]) throw Object.assign(new Error("unauthenticated"), { statusCode: 401 });
      return accounts[who];
    } } as never,
  });
  const call = async (who: string, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as never, url, headers: { "x-account": who, "idempotency-key": randomUUID() }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    let body: any; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
  const ownedBy = (who: string) => [...market.catalog.values()].flatMap((p) => p.connections.filter((c) => c.name.includes(`owner:${accounts[who].userId}`)).map((c) => ({ provider: p.id, id: c.id })));
  const keyOf = (connectionId: string) => [...market.keys.values()].find((entry) => entry.allowed.includes(connectionId));
  try {
    await app.ready();

    // A connects OpenAI with its own key.
    const aConnect = await call("A", "POST", "/ai/providers/openai/connect", { apiKey: "sk-account-a" });
    expect(aConnect.status, JSON.stringify(aConnect.body)).toBe(200);
    const [aConnection] = ownedBy("A");
    expect(aConnection?.provider).toBe("openai");
    const aKey = keyOf(aConnection.id)!;
    expect(aKey.allowed).toEqual([aConnection.id]);

    // B sees nothing of it and cannot use, test, refresh or remove it.
    const bMarket = await call("B", "GET", "/ai/marketplace");
    expect(bMarket.body.overview.connectedProviders).toBe(0);
    expect(bMarket.body.providers.find((p: AIProviderSummary) => p.id === "openai")).toMatchObject({ connected: false, connections: [] });
    const bProvider = await call("B", "GET", "/ai/providers/openai");
    expect(JSON.stringify(bProvider.body)).not.toContain(aConnection.id);
    expect((await call("B", "GET", "/ai/marketplace?tab=connected")).body.providers).toEqual([]);
    expect((await call("B", "POST", "/chat", { message: "hello", contextType: "none" })).body?.error?.code).toBe("AI_PROVIDER_REQUIRED");
    expect((await call("B", "DELETE", "/ai/providers/openai")).status).toBe(404);
    expect((await call("B", "POST", "/ai/providers/openai/test")).status).toBe(404);
    expect((await call("B", "POST", "/ai/providers/openai/refresh-models")).status).toBe(404);
    expect(ownedBy("A")).toEqual([aConnection]);
    expect(market.deleted).toEqual([]);

    // A sees its own connection.
    const aMarket = await call("A", "GET", "/ai/marketplace?tab=connected");
    expect(aMarket.body.providers.map((p: AIProviderSummary) => p.id)).toEqual(["openai"]);
    expect(aMarket.body.overview.connectedProviders).toBe(1);

    // B connects its own OpenAI key: a separate connection and key; A's key is unchanged.
    expect((await call("B", "POST", "/ai/providers/openai/connect", { apiKey: "sk-account-b" })).status).toBe(200);
    const [bConnection] = ownedBy("B");
    expect(bConnection.id).not.toBe(aConnection.id);
    const bKey = keyOf(bConnection.id)!;
    expect(bKey.key).not.toBe(aKey.key);
    expect(aKey.allowed).toEqual([aConnection.id]);
    expect(bKey.allowed).toEqual([bConnection.id]);
    expect((await call("A", "POST", "/ai/providers/openai/connect", { apiKey: "sk-again" })).status).toBe(409);

    // Each account chats with its own key; `auto` becomes the account's own model; the installation key is never used.
    for (const who of ["A", "B"]) {
      expect((await call(who, "POST", "/ai/models/add", { providerId: "openai", modelId: "openai/model-1" })).status).toBe(200);
    }
    inference.length = 0;
    const aChat = await call("A", "POST", "/chat", { message: "Say hi", contextType: "none" });
    expect(aChat.status, JSON.stringify(aChat.body)).toBe(200);
    const aKeys = new Set(inference.filter((entry) => entry.path.includes("chat")).map((entry) => entry.key));
    expect([...aKeys]).toEqual([aKey.key]);
    expect(inference.filter((entry) => entry.path.includes("chat")).every((entry) => entry.model === "openai/model-1")).toBe(true);
    inference.length = 0;
    expect((await call("B", "POST", "/chat", { message: "Say hi", contextType: "none" })).status).toBe(200);
    expect([...new Set(inference.filter((entry) => entry.path.includes("chat")).map((entry) => entry.key))]).toEqual([bKey.key]);

    // Hosted refusals: sign-in providers, local providers on the server, custom endpoints.
    expect((await call("A", "POST", "/ai/providers/claude-code/oauth/start")).status).toBe(400);
    expect((await call("A", "POST", "/ai/providers/ollama/connect", {})).status).toBe(400);
    expect((await call("A", "POST", "/ai/providers/anthropic/connect", { apiKey: "sk-x", baseUrl: "http://169.254.169.254/" })).status).toBe(400);
    expect(ownedBy("A").map((c) => c.provider)).toEqual(["openai"]);

    // After A disconnects, its key reaches nothing and A cannot chat; B is unaffected.
    expect((await call("A", "DELETE", "/ai/providers/openai")).status).toBe(200);
    expect(market.deleted).toEqual([aConnection.id]);
    expect(aKey.allowed).toEqual(["00000000-0000-4000-8000-000000000000"]);
    expect((await call("A", "POST", "/chat", { message: "hello", contextType: "none" })).body?.error?.code).toBe("AI_PROVIDER_REQUIRED");
    expect(ownedBy("B")).toEqual([bConnection]);

    // No code path reaches the shared pool: an inference outside any account's scope is refused.
    expect(inference.some((entry) => entry.key === "installation-key" && entry.path.includes("chat"))).toBe(false);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.NPATI_AI_PROVIDER_ISOLATION; else process.env.NPATI_AI_PROVIDER_ISOLATION = previous;
  }
}, 120_000);

it("the engine refuses an inference made outside any account's scope on a hosted installation", async () => {
  const { OmniRouteEngine, withOmniRouteCredential } = await import("@npati/omniroute-adapter");
  const engine = new OmniRouteEngine({ baseUrl, apiKey: "installation-key", requireScopedCredential: true });
  inference.length = 0;
  await expect(engine.chat({ messages: [{ role: "user", content: "hi" }], model: "openai/model-1" })).rejects.toMatchObject({ code: "AI_PROVIDER_REQUIRED" });
  await expect(withOmniRouteCredential({}, () => engine.chat({ messages: [{ role: "user", content: "hi" }], model: "openai/model-1" }))).rejects.toMatchObject({ code: "AI_PROVIDER_REQUIRED" });
  await expect(withOmniRouteCredential({ apiKey: "scoped-a" }, () => engine.chat({ messages: [{ role: "user", content: "hi" }] }))).rejects.toMatchObject({ code: "AI_PROVIDER_REQUIRED" });
  expect(inference).toEqual([]);
  const ok = await withOmniRouteCredential({ apiKey: "scoped-a", resolveAutoModel: async () => "openai/model-1" }, () => engine.chat({ messages: [{ role: "user", content: "hi" }], model: "auto" }));
  expect(ok.content).toBe("probe answer");
  expect(inference.map((entry) => [entry.key, entry.model])).toEqual([["scoped-a", "openai/model-1"]]);
  // A self-hosted engine keeps using the installation key outside any scope.
  const shared = new OmniRouteEngine({ baseUrl, apiKey: "installation-key" });
  inference.length = 0;
  await shared.chat({ messages: [{ role: "user", content: "hi" }], model: "openai/model-1" });
  expect(inference.map((entry) => entry.key)).toEqual(["installation-key"]);
});

it("background work runs as its owning account, even inside another account's inherited scope", async () => {
  const { InMemoryWorkspaceStore } = await import("@npati/workspace");
  const { currentOmniRouteCredential, withOmniRouteCredential } = await import("@npati/omniroute-adapter");
  const { TenantAIProviders, setProcessTenantProviders, asAccount } = await import("../apps/agent-api/src/ai-tenant-providers");
  const { AIPreferencesStore } = await import("../apps/agent-api/src/ai-preferences");
  const market = stubMarketplace();
  const store = new InMemoryWorkspaceStore();
  const providers = new TenantAIProviders({ store, marketplace: market as unknown as OmniRouteMarketplace, preferences: new AIPreferencesStore(store) });
  for (const who of ["A", "B"]) await providers.connect(accounts[who], market.catalog.get("openai")!, { apiKey: `sk-${who}` });
  const keyA = await providers.keyFor(accounts.A), keyB = await providers.keyFor(accounts.B);
  expect(keyA && keyB && keyA !== keyB).toBe(true);
  setProcessTenantProviders(providers);
  try {
    const key = () => Promise.resolve(currentOmniRouteCredential()?.apiKey);
    // Started outside any request (a scheduler tick, an inbound message): the owner's key.
    expect(await asAccount(accounts.B, key)).toBe(keyB);
    // Started from inside A's work (a queue drained by A's run): B's work still gets B's key, never A's.
    expect(await withOmniRouteCredential({ apiKey: keyA, account: accounts.A } as never, () => asAccount(accounts.B, key))).toBe(keyB);
    // Already in the owner's own scope: unchanged.
    expect(await withOmniRouteCredential({ apiKey: keyA, account: accounts.A } as never, () => asAccount(accounts.A, key))).toBe(keyA);
    // An account without connections gets no key, so its inference is refused.
    const none = { userId: "saas-ai-none", workspaceId: "workspace:saas-ai-none", permissions };
    expect(await asAccount(none, key)).toBeUndefined();
  } finally {
    setProcessTenantProviders(undefined);
  }
});
