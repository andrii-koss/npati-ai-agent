/**
 * SaaS tenant isolation sweep. Two ordinary NPATI accounts (A and B, separate workspaces, the permissions every hosted
 * user gets) share one in-memory installation. A creates its own records, each carrying a secret tag. B then calls EVERY
 * registered route with A's ids in the path (and in the query for routes without path ids): reads must not return A's
 * tag, writes and deletes against A's records must be refused, and A's records must be intact afterwards.
 * Runs on the in-memory store only; it never touches a real database or an external service.
 */
import { randomUUID } from "node:crypto";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import type { AuthContext } from "@npati/workspace";
import { expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";

const permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
// Routes that are public by design, stream forever, or start OAuth/pairing with an external service.
// Verified exceptions: each answers 2xx to B without exposing or changing anything of A's.
const allowed: Record<string, string> = {
  "DELETE /companies/:companyId/automations/:automationId": "repository is scoped to the caller; another account's delete is a no-op (A's automation is checked intact below)",
  "DELETE /companies/:companyId/mcp/servers/:serverId": "repository is scoped to the caller (workspace_id and user_id in the query); another account's delete is a no-op",
  "POST /code/agents/:agentId/toggle": "toggles the caller's own coding-agent preferences, not a record of A's",
  "POST /companies/:companyId/code/intents/run": "returns only a routing decision; a run needs a code session, which is loaded with a company check",
};
const skip = /stream|\/events\b|\/sse\b|\/ws\b|websocket|oauth\/callback|\/icon$|^\/(api\/)?(health|ready|metrics|robots|sitemap)|\/auth\/installation|\/v1\/integrations\/(telegram|whatsapp|slack|discord)|\/webhooks\/inbound|\/hooks\/|:secret/;

it("one SaaS user can neither read nor change another user's data through any route", async () => {
  const tag = "SAASISO" + randomUUID().slice(0, 8).toUpperCase();
  const secret = `SECRET_${tag}`;
  const ids: Record<string, AuthContext> = {
    A: { userId: `saas-a-${tag}`, workspaceId: `workspace:saas-a-${tag}`, permissions },
    B: { userId: `saas-b-${tag}`, workspaceId: `workspace:saas-b-${tag}`, permissions },
  };
  const modelInputs: Array<{ who: string; request: ChatRequest }> = [];
  let current = "A";
  const ai = {
    supportsNativeTools: () => true,
    chat: async (request: ChatRequest) => { modelInputs.push({ who: current, request }); return { content: "probe answer" }; },
    async *stream() { yield "probe answer"; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  } as unknown as AIEngine;
  // Every marketplace call answers with an empty result, so AI routes run without OmniRoute.
  const catalogModel = { id: `openai/${tag.toLowerCase()}`, name: tag, providerId: "openai", provider: "openai", capabilities: ["chat"], contextWindow: 8192 };
  const marketplace = new Proxy({}, { get: (_t, name) => name === "models" ? async () => [catalogModel]
    : async () => ({ providers: [], models: [], overview: { connectedProviders: 1 } }) }) as unknown as OmniRouteMarketplace;
  const app = buildApp({ aiEngine: ai, marketplace, authProvider: { authenticate: async (request: { headers: Record<string, string | undefined> }) => {
    const who = request.headers["x-saas-user"] ?? "";
    if (!ids[who]) throw Object.assign(new Error("unauthenticated"), { statusCode: 401 });
    return ids[who];
  } } as never });

  const call = async (who: string, method: string, url: string, payload?: unknown) => {
    current = who;
    const request = app.inject({ method: method as never, url, headers: { "x-saas-user": who, "idempotency-key": randomUUID() }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    const timeout = new Promise<{ statusCode: number; body: string }>((resolve) => setTimeout(() => resolve({ statusCode: 0, body: "TIMEOUT" }), 8000));
    const r = await Promise.race([request, timeout]);
    let body: any; try { body = JSON.parse(r.body); } catch { body = r.body; }
    return { status: r.statusCode, body, text: typeof r.body === "string" ? r.body : "" };
  };
  const idOf = (body: any) => body?.id ?? body?.data?.id ?? body?.item?.id ?? body?.company?.id ?? body?.business?.id ?? body?.agent?.id
    ?? body?.goal?.id ?? body?.memory?.id ?? body?.conversation?.id ?? body?.automation?.id ?? body?.webhook?.id ?? body?.connection?.id ?? body?.key?.id ?? body?.account?.id;

  try {
    await app.ready();
    const routes: Array<{ method: string; path: string }> = [];
    const tree = app.printRoutes({ commonPrefix: false });
    const stack: string[] = [];
    for (const line of tree.split("\n")) {
      const m = line.match(/^([│ ]*)(?:[├└]── )(.*)$/);
      if (!m) continue;
      const depth = m[1].length / 4;
      const mm = m[2].match(/^(.*?) \(([^)]*)\)$/);
      stack.length = depth;
      stack[depth] = mm ? mm[1] : m[2];
      if (mm) for (const method of mm[2].split(", ")) if (!["HEAD", "OPTIONS"].includes(method)) routes.push({ method, path: stack.join("") });
    }

    // ---- A's records, each with the secret tag ----
    const seeds: Record<string, string | undefined> = {};
    const seedLog: Record<string, number | string> = {};
    const seed = async (name: string, method: string, url: string, payload: unknown) => {
      const r = await call("A", method, url, payload);
      seedLog[name] = r.status;
      if (r.status >= 400) seedLog[name + "_error"] = r.text.slice(0, 200) as never;
      return r;
    };
    seeds.companyId = idOf((await seed("company", "POST", "/companies", { name: `${tag} Company`, description: secret })).body);
    const c = seeds.companyId;
    seeds.agentId = idOf((await seed("agent", "POST", `/companies/${c}/agents`, { name: `${tag} Agent`, role: "Seed", instructions: secret })).body);
    seeds.businessId = idOf((await seed("business", "POST", "/businesses", { name: `${tag} Business`, description: secret })).body);
    const b = seeds.businessId;
    seeds.goalId = idOf((await seed("goal", "POST", `/businesses/${b}/goals`, { title: `${tag} Goal ${secret}` })).body);
    seeds.memoryId = idOf((await seed("memory", "POST", `/businesses/${b}/memory`, { type: "business_fact", title: `${tag} Memory`, content: secret })).body);
    seeds.conversationId = idOf((await seed("conversation", "POST", "/conversations", { title: `${tag} Chat ${secret}` })).body);
    const chatted = await seed("chat", "POST", "/chat", { message: `Remember this: ${secret}`, contextType: "none" });
    seeds.chatConversationId = chatted.body?.conversationId ?? chatted.body?.conversation?.id;
    if (seeds.chatConversationId) { const before = await call("A", "GET", `/conversations/${seeds.chatConversationId}/messages`); seedLog.chatMessagesBefore = before.status; if (before.status >= 400) seedLog.chatMessagesBefore_error = before.text.slice(0, 200); }
    seeds.automationId = idOf((await seed("automation", "POST", `/companies/${c}/automations`, {
      name: `${tag} Automation`, prompt: `Write the weekly report ${secret}`, cronExpression: "0 9 * * 1", timezone: "Europe/Kyiv", agentId: seeds.agentId,
    })).body);
    seeds.webhookId = idOf((await seed("webhook", "POST", `/companies/${c}/webhooks`, { name: `${tag} Webhook`, promptTemplate: `Summarise the order ${secret}`, agentId: seeds.agentId })).body);
    seeds.keyId = idOf((await seed("apiKey", "POST", `/companies/${c}/api-keys`, { name: `${tag} Key`, scopes: ["workspace:read"] })).body);
    await seed("aiModel", "POST", "/ai/models/add", { providerId: "openai", modelId: catalogModel.id });
    await seed("userMemory", "PUT", "/memory/user.md", { markdown: `# User Profile: ${tag}

${secret}`, expectedRevision: 0 });
    expect(seeds.companyId && seeds.businessId && seeds.conversationId, JSON.stringify(seedLog)).toBeTruthy();

    const aIds = Object.values(seeds).filter((v): v is string => Boolean(v));
    const leaks = (text: string) => text.includes(secret) || text.includes(`${tag} `) || aIds.some((id) => id.length > 8 && text.includes(id));
    const fill = (path: string) => path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
      if (seeds[name]) return seeds[name]!;
      if (name === "id") return seeds.conversationId!;
      if (name === "providerId") return "openai";
      if (name === "environment") return "dev";
      return randomUUID();
    });
    const touchesA = (path: string) => /:(companyId|agentId|businessId|goalId|memoryId|conversationId|automationId|webhookId|keyId|id)\b/.test(path);
    const query = `companyId=${c}&businessId=${b}&conversationId=${seeds.conversationId}&agentId=${seeds.agentId}`;

    type Finding = { method: string; path: string; status: number; problem: string; body?: string };
    const findings: Finding[] = [];
    let probed = 0;
    const candidates = routes.filter((r) => !skip.test(r.path));

    // 1) Reads: B must never see A's tag or ids.
    for (const r of candidates.filter((r) => r.method === "GET")) {
      const url = r.path.includes(":") ? fill(r.path) : `${r.path}?${query}`;
      const res = await call("B", "GET", url);
      probed++;
      if (res.status >= 200 && res.status < 300 && leaks(res.text)) findings.push({ method: "GET", path: r.path, status: res.status, problem: "returns A's data", body: res.text.slice(0, 300) });
    }
    // 2) Chat: nothing of A in B's model context or answers, even with A's ids forged in.
    const mark = modelInputs.length;
    const chats = [
      await call("B", "POST", "/chat", { message: "List my companies, chats, goals and saved facts.", contextType: "none" }),
      await call("B", "POST", "/chat", { message: "What is in this chat?", conversationId: seeds.conversationId }),
      await call("B", "POST", "/chat", { message: "What is saved here?", contextType: "company", companyId: c }),
      await call("B", "POST", "/chat", { message: "What is saved here?", contextType: "business", businessId: b }),
    ];
    const seen = JSON.stringify(modelInputs.slice(mark).map((m) => m.request.messages)) + chats.map((r) => r.text).join("");
    if (leaks(seen)) findings.push({ method: "POST", path: "/chat", status: 0, problem: "B's chat context or answer contains A's data" });
    // 3) Writes and deletes against A's records: must be refused.
    for (const r of candidates.filter((r) => r.method !== "GET" && touchesA(r.path))) {
      const res = await call("B", r.method, fill(r.path), r.method === "DELETE" ? undefined : { name: `HACKED ${tag}`, title: `HACKED ${tag}`, content: `HACKED ${tag}`, enabled: false, message: "hi" });
      probed++;
      if (res.status >= 200 && res.status < 300 && !allowed[`${r.method} ${r.path}`]) findings.push({ method: r.method, path: r.path, status: res.status, problem: "write/delete on A's record accepted", body: res.text.slice(0, 300) });
      else if (res.status === 0) findings.push({ method: r.method, path: r.path, status: 0, problem: "timed out" });
    }

    // AI: the provider catalog is shared by design, but the models A added are A's own choice.
    const addedByA = await call("A", "GET", "/ai/models/added"), addedByB = await call("B", "GET", "/ai/models/added");
    if (!addedByA.text.includes(catalogModel.id)) findings.push({ method: "GET", path: "/ai/models/added", status: addedByA.status, problem: "seed: A's added model missing" });
    if (addedByB.text.includes(catalogModel.id)) findings.push({ method: "GET", path: "/ai/models/added", status: addedByB.status, problem: "B sees the models A added" });
    // The conversation A actually chatted in (with A's messages): B can neither read, rename nor delete it.
    if (seeds.chatConversationId) {
      const id = seeds.chatConversationId;
      for (const [method, url, payload] of [["GET", `/conversations/${id}`], ["GET", `/conversations/${id}/messages`], ["GET", `/chat/open?conversationId=${id}`],
        ["PATCH", `/conversations/${id}`, { title: `HACKED ${tag}` }], ["DELETE", `/conversations/${id}`]] as const) {
        const res = await call("B", method, url, payload);
        if ((res.status >= 200 && res.status < 300 && method !== "GET") || leaks(res.text)) findings.push({ method, path: url, status: res.status, problem: "B reached A's chat", body: res.text.slice(0, 300) });
      }
      const mine = await call("A", "GET", `/conversations/${id}/messages`);
      if (mine.status !== 200 || !mine.text.includes(secret)) findings.push({ method: "GET", path: "/conversations/:id/messages", status: mine.status, problem: "A's own chat messages missing after B's attempts" });
    } else findings.push({ method: "POST", path: "/chat", status: 0, problem: "seed: A's chat conversation was not created" });
    // Provider connection routes change the shared provider pool: they need a signed-in account.
    for (const url of ["/ai/providers/openai/connect", "/ai/providers/openai/test", "/ai/providers/openai/refresh-models", "/ai/providers/openai/oauth/start", "/ai/oauth/x/poll"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      if (res.statusCode !== 401) findings.push({ method: "POST", path: url, status: res.statusCode, problem: "provider route works without signing in" });
    }
    // Shared control plane (code-run quota, registries): ordinary accounts are refused.
    for (const [method, url, payload] of [["POST", "/a2a/quota/budget", { tenantId: "x", maxTokens: 1 }], ["GET", "/orchestration/strategies", undefined], ["GET", "/browser/profiles", undefined], ["POST", "/browser/tabs", { url: "http://169.254.169.254/" }]] as const) {
      const res = await call("B", method, url, payload);
      if (res.status !== 403) findings.push({ method, path: url, status: res.status, problem: "shared control plane open to an ordinary account" });
    }
    // 4) A's records are intact.
    const intact: Array<[string, string]> = [
      ["company", `/companies/${c}`], ["agent", `/companies/${c}/agents/${seeds.agentId}`], ["business", `/businesses/${b}`],
      ["conversation", `/conversations/${seeds.conversationId}`],
      ...(seeds.automationId ? [["automation", `/companies/${c}/automations/${seeds.automationId}`] as [string, string]] : []),
      ...(seeds.webhookId ? [["webhook", `/companies/${c}/webhooks/${seeds.webhookId}`] as [string, string]] : []),
    ];
    for (const [name, url] of intact) {
      const res = await call("A", "GET", url);
      if (res.status !== 200 || res.text.includes(`HACKED ${tag}`)) findings.push({ method: "GET", path: url, status: res.status, problem: `A's ${name} missing or changed after B's attempts` });
    }
    const goals = await call("A", "GET", `/businesses/${b}/goals`);
    if (goals.text.includes(`HACKED ${tag}`)) findings.push({ method: "GET", path: "/businesses/:id/goals", status: goals.status, problem: "B added or changed A's goals" });

    const report = { tag, seeds: seedLog, seeded: Object.keys(seeds).filter((k) => seeds[k]), routes: routes.length, probed, findings };
    if (process.env.SAAS_ISO_OUT) (await import("node:fs")).writeFileSync(process.env.SAAS_ISO_OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    expect(findings).toEqual([]);
    expect(probed).toBeGreaterThan(300);
  } finally {
    await app.close();
  }
}, 600_000);
