import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { WebResearchService } from "@npati/web-research";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const apps: Array<ReturnType<typeof buildApp>> = [];
const tempDirectories: string[] = [];
function chatContentText(content: ChatRequest["messages"][number]["content"] | undefined): string {
  return Array.isArray(content)
    ? content.map((part) => part.type === "text" ? part.text : "").join("\n")
    : content ?? "";
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent API", () => {
  it("exposes OmniRoute resilience read-only with tenant permission enforcement", async () => {
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read"] };
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    const aiEngine = {
      chat: async () => ({ content: "ok" }), stream: async function* () { yield "ok"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" as const }),
      resilienceStatus: async () => ({ source: "omniroute" as const, configuration: { waitForCooldown: { enabled: true, maxRetries: 2 } },
        runtime: { status: "healthy", providerBreakers: [], lockouts: [], adaptiveAdmission: {}, chatAdmission: {} } }),
    } satisfies AIEngine;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace, aiEngine });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/ai/resilience" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: "omniroute", runtime: { status: "healthy" } });
    active = { ...active, permissions: [] };
    expect((await app.inject({ method: "GET", url: "/ai/resilience" })).statusCode).toBe(403);
  });

  it("isolates AI routing preferences by authenticated tenant and enforces write permission", async () => {
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "workspace:write"] };
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace });
    apps.push(app);

    const changed = await app.inject({ method: "PUT", url: "/ai/routing", payload: { mode: "automatic", preferFree: false } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ automaticModel: "auto", preferFree: false });

    active = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read"] };
    const isolated = await app.inject({ method: "GET", url: "/ai/routing" });
    expect(isolated.json()).toMatchObject({ automaticModel: "auto", preferFree: true });
    const denied = await app.inject({ method: "PUT", url: "/ai/routing", payload: { mode: "automatic", preferFree: false } });
    expect(denied.statusCode).toBe(403);
  });
  it("creates companies idempotently, paginates them, and enforces tenant permissions", async () => {
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] };
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace });
    apps.push(app);

    const request = { method: "POST" as const, url: "/companies", headers: { "idempotency-key": "company-api-request-001" }, payload: { name: "Acme" } };
    const copies = await Promise.all(Array.from({ length: 12 }, () => app.inject(request)));
    expect(copies.every((response) => response.statusCode === 201)).toBe(true);
    expect(new Set(copies.map((response) => response.json().id)).size).toBe(1);
    const companyId = copies[0]!.json().id as string;

    await app.inject({ method: "POST", url: "/companies", headers: { "idempotency-key": "company-api-request-002" }, payload: { name: "Second" } });
    const firstPage = await app.inject({ method: "GET", url: "/companies?limit=1" });
    expect(firstPage.json()).toMatchObject({ companies: [{ id: expect.any(String) }], pagination: { limit: 1, nextCursor: expect.any(String) } });
    const nextCursor = encodeURIComponent(firstPage.json().pagination.nextCursor);
    const secondPage = await app.inject({ method: "GET", url: `/companies?limit=1&cursor=${nextCursor}` });
    expect(secondPage.json().companies).toHaveLength(1);
    expect(secondPage.json().companies[0].id).not.toBe(firstPage.json().companies[0].id);

    active = { ...active, permissions: ["workspace:read"] };
    expect((await app.inject({ method: "POST", url: "/companies", headers: { "idempotency-key": "company-api-request-003" }, payload: { name: "Denied" } })).statusCode).toBe(403);
    active = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read", "business:manage"] };
    expect((await app.inject({ method: "GET", url: "/companies" })).json().companies).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/companies/${companyId}` })).statusCode).toBe(403);
  });

  it("manages configurable company agents, hierarchy, revisions, and tenant isolation", async () => {
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] };
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace });
    apps.push(app);

    const business = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Idea" } });
    const company = await app.inject({ method: "POST", url: "/companies", headers: { "idempotency-key": "company-separated-001" },
      payload: { name: "Operations", businessId: business.json().id } });
    expect(company.statusCode).toBe(201);
    expect(company.json().businessId).toBe(business.json().id);

    const managerRequest = { method: "POST" as const, url: `/companies/${company.json().id}/agents`,
      headers: { "idempotency-key": "agent-manager-001" }, payload: { name: "Manager", role: "Coordinator", tools: ["MCP"] } };
    const invalidModel = await app.inject({ method: "POST", url: `/companies/${company.json().id}/agents`, headers: { "idempotency-key": "agent-invalid-model-001" }, payload: { name: "Invalid", role: "Test", modelId: "hardcoded/not-configured" } });
    expect(invalidModel.statusCode).toBe(400);
    const managerCopies = await Promise.all(Array.from({ length: 10 }, () => app.inject(managerRequest)));
    expect(new Set(managerCopies.map((response) => response.json().id)).size).toBe(1);
    const managerId = managerCopies[0]!.json().id;
    const writer = await app.inject({ method: "POST", url: `/companies/${company.json().id}/agents`,
      headers: { "idempotency-key": "agent-writer-001" }, payload: { name: "Writer", role: "Custom Writer" } });
    const writerId = writer.json().id;

    expect((await app.inject({ method: "PUT", url: `/companies/${company.json().id}/agents/${writerId}/parent`, payload: { parentAgentId: writerId } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/companies/${company.json().id}/agents/${writerId}/parent`, payload: { parentAgentId: managerId } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/companies/${company.json().id}/agents/${managerId}/parent`, payload: { parentAgentId: writerId } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/companies/${company.json().id}/main-agent`, payload: { agentId: managerId, expectedRevision: 1 } })).json().mainAgentId).toBe(managerId);
    expect((await app.inject({ method: "PATCH", url: `/companies/${company.json().id}`, payload: { name: "Stale", expectedRevision: 1 } })).statusCode).toBe(409);

    active = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read", "business:manage"] };
    expect((await app.inject({ method: "GET", url: `/companies/${company.json().id}/agents` })).statusCode).toBe(403);
  });


  it("deletes a Main Agent with both parent and children atomically, idempotently, and with tenant isolation", async () => {
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] };
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace });
    apps.push(app);

    const company = await app.inject({ method: "POST", url: "/companies",
      headers: { "idempotency-key": "delete-company-001" }, payload: { name: "Delete Test" } });
    const companyId = company.json().id as string;
    const root = await app.inject({ method: "POST", url: "/companies/" + companyId + "/agents",
      headers: { "idempotency-key": "delete-root-001" }, payload: { name: "Owner", role: "Root" } });
    const parent = await app.inject({ method: "POST", url: "/companies/" + companyId + "/agents",
      headers: { "idempotency-key": "delete-parent-001" }, payload: { name: "Manager", role: "Main" } });
    const child = await app.inject({ method: "POST", url: "/companies/" + companyId + "/agents",
      headers: { "idempotency-key": "delete-child-001" }, payload: { name: "Writer", role: "Child" } });
    const rootId = root.json().id as string;
    const parentId = parent.json().id as string;
    const childId = child.json().id as string;
    await app.inject({ method: "PUT", url: "/companies/" + companyId + "/agents/" + parentId + "/parent", payload: { parentAgentId: rootId } });
    await app.inject({ method: "PUT", url: "/companies/" + companyId + "/agents/" + childId + "/parent", payload: { parentAgentId: parentId } });
    await app.inject({ method: "PUT", url: "/companies/" + companyId + "/main-agent", payload: { agentId: parentId, expectedRevision: 1 } });

    expect((await app.inject({ method: "DELETE", url: "/companies/" + companyId + "/agents/" + parentId + "?expectedRevision=99" })).statusCode).toBe(409);
    active = { ...active, permissions: ["workspace:read"] };
    expect((await app.inject({ method: "DELETE", url: "/companies/" + companyId + "/agents/" + parentId + "?expectedRevision=1" })).statusCode).toBe(403);
    active = { ...active, permissions: ["workspace:read", "business:manage"] };

    const concurrentDeletes = await Promise.all(Array.from({ length: 8 }, () => app.inject({
      method: "DELETE", url: "/companies/" + companyId + "/agents/" + parentId + "?expectedRevision=1",
    })));
    expect(concurrentDeletes.every((response) => response.statusCode === 204)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/companies/" + companyId + "/agents/" + parentId })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/companies/" + companyId + "/agents/" + rootId })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/companies/" + companyId + "/agents/" + childId })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/companies/" + companyId + "/agent-edges" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/companies/" + companyId })).json().mainAgentId).toBeUndefined();
  });

  it("streams real research progress events before the final result", async () => {
    const aiEngine: AIEngine = {
      chat: async () => ({ content: "Final researched answer." }),
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const webResearch = {
      shouldResearch: () => true,
      run: async (_message: string, _business: unknown, _refresh: boolean, progress?: (event: Record<string, unknown>) => void) => {
        progress?.({ type: "search_started", query: "Hostkoss official website" });
        progress?.({ type: "search_results_received", query: "Hostkoss official website", resultCount: 1 });
        progress?.({ type: "source_discovered", url: "https://hostkoss.com/", title: "Hostkoss" });
        progress?.({ type: "page_fetch_started", url: "https://hostkoss.com/", domain: "hostkoss.com" });
        progress?.({ type: "page_fetch_completed", url: "https://hostkoss.com/", domain: "hostkoss.com", title: "Hostkoss" });
        progress?.({ type: "research_completed", sourceCount: 1, pageCount: 1 });
        return { kind: "web_search" as const, context: "Hostkoss evidence", sources: [{ url: "https://hostkoss.com/", title: "Hostkoss", accessedAt: new Date().toISOString() }] };
      },
    } as unknown as WebResearchService;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace, webResearch });
    apps.push(app);
    const business = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Research Lab", businessStage: "operating" } });
    const conversation = await app.inject({
      method: "POST",
      url: "/businesses/" + business.json().id + "/conversations",
      payload: { title: "New conversation" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: { message: "Analyze Hostkoss and its services", conversationId: conversation.json().id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const types = [...response.body.matchAll(/event: progress\ndata: ({[^\n]+})/g)].map((match) => JSON.parse(match[1]!).type);
    expect(types).toEqual([
      "search_started",
      "search_results_received",
      "source_discovered",
      "page_fetch_started",
      "page_fetch_completed",
      "research_completed",
      "final_generation_started",
      "final_generation_completed",
    ]);
    expect(response.body.indexOf("search_started")).toBeLessThan(response.body.indexOf("event: result"));
    expect(response.body).toContain("Final researched answer.");
    const conversations = await app.inject({ method: "GET", url: "/businesses/" + business.json().id + "/conversations" });
    expect(conversations.json()[0].title).toBe("Analyze Hostkoss and its services");
  });

  it("runs web research and emits SSE progress events in neutral chat (contextType: none)", async () => {
    let receivedSystemPrompt = "";
    const aiEngine: AIEngine = {
      chat: async () => ({
        content: "Researched NPATI website successfully.",
        model: "openai/gpt-4.1-mini",
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      }),
      async *stream(request) {
        receivedSystemPrompt = chatContentText(request.messages.find((m) => m.role === "system")?.content);
        yield "NPATI "; yield "is an online marketplace.";
      },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const webResearch = {
      shouldResearch: (msg: string) => /https?:\/\/|проаналізуй|сайт/i.test(msg),
      run: async (_message: string, _business: unknown, _refresh: boolean, progress?: (event: Record<string, unknown>) => void) => {
        progress?.({ type: "source_discovered", url: "https://www.npati.com/", title: "NPATI" });
        progress?.({ type: "page_fetch_started", url: "https://www.npati.com/", domain: "npati.com" });
        progress?.({ type: "page_fetch_completed", url: "https://www.npati.com/", domain: "npati.com", title: "NPATI Marketplace" });
        progress?.({ type: "research_completed", sourceCount: 1, pageCount: 1 });
        return {
          kind: "url_analysis" as const,
          context: "NPATI is a Free Classified Ads & Video Marketplace.",
          sources: [{ url: "https://www.npati.com/", title: "NPATI Marketplace", accessedAt: new Date().toISOString() }],
        };
      },
    } as unknown as WebResearchService;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace, webResearch });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: { message: "проаналізуй цей сатй https://www.npati.com/", contextType: "none" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const progressEvents = [...response.body.matchAll(/event: progress\ndata: ({[^\n]+})/g)].map((match) => JSON.parse(match[1]!).type);
    expect(progressEvents).toEqual([
      "source_discovered",
      "page_fetch_started",
      "page_fetch_completed",
      "research_completed",
      "final_generation_started",
      "final_generation_completed",
    ]);
    expect(receivedSystemPrompt).toContain("NPATI Web Research & Crawler");
    expect(receivedSystemPrompt).toContain("NPATI is a Free Classified Ads & Video Marketplace.");
    expect(receivedSystemPrompt).toContain("Do NOT claim that you lack real-time web browsing access");
    expect(response.body).toContain('"sources":[{"url":"https://www.npati.com/"');
    expect(response.body).toContain('"used":true');
  });

  it("forwards ordered model deltas through the chat SSE endpoint", async () => {
    const aiEngine: AIEngine = {
      chat: async () => { throw new Error("Non-streaming chat must not be used"); },
      async *stream(request) {
        expect(request.signal).toBeInstanceOf(AbortSignal);
        yield "First "; yield "live "; yield "tokens";
      },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Stream this", contextType: "none" } });

    expect(response.statusCode).toBe(200);
    const deltas=[...response.body.matchAll(/event: delta\ndata: ({[^\n]+})/g)].map(match=>JSON.parse(match[1]!).delta);
    expect(deltas).toEqual(["First ","live ","tokens"]);
    expect(response.body.indexOf("event: delta")).toBeLessThan(response.body.indexOf("event: result"));
    expect(response.body).toContain('"message":"First live tokens"');
  });

  it("names the selected automatic route when chat inference fails", async () => {
    const unavailable = new Error("OmniRoute failed with HTTP 502");
    const aiEngine: AIEngine = {
      chat: async () => { throw unavailable; },
      async *stream() { throw unavailable; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);
    const routing = await app.inject({ method: "PUT", url: "/ai/routing", payload: { mode: "automatic", preferFree: true } });
    expect(routing.statusCode).toBe(200);

    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Hello", contextType: "none" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('NPATI route \\"auto/chat\\"');
    expect(response.body).toContain("Switch to another AI mode");
    expect(response.body).not.toContain("OmniRoute");
  });

  it("aborts Business provider work on client disconnect and never persists a late assistant reply", async () => {
    let markAborted!:()=>void;
    const aborted=new Promise<void>(resolve=>{markAborted=resolve;});
    const aiEngine:AIEngine={
      chat:async request=>new Promise((_resolve,reject)=>{
        if(!request.signal)throw new Error("Business model call did not receive an AbortSignal");
        request.signal.addEventListener("abort",()=>{markAborted();reject(request.signal?.reason??new DOMException("Cancelled","AbortError"));},{once:true});
      }),
      async *stream(){yield "unused";},listModels:async()=>[],getModel:async()=>undefined,
      executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,
      getCapabilities:async()=>["chat"],healthCheck:async()=>({status:"ok"}),
    };
    const marketplace={marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace;
    const app=buildApp({workspaceStore:new InMemoryWorkspaceStore(),aiEngine,marketplace});apps.push(app);
    const business=await app.inject({method:"POST",url:"/businesses",payload:{name:"Cancellation Lab",businessStage:"operating"}});
    const conversation=await app.inject({method:"POST",url:`/businesses/${business.json().id}/conversations`,payload:{title:"Cancel stream"}});
    await app.listen({host:"127.0.0.1",port:0});
    const address=app.server.address() as {port:number};
    const controller=new AbortController(),streamId=crypto.randomUUID();
    const response=await fetch(`http://127.0.0.1:${address.port}/chat/stream`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Write a long answer",contextType:"business",businessId:business.json().id,conversationId:conversation.json().id,streamId}),signal:controller.signal});
    const reader=response.body!.getReader();
    await reader.read();

    const cancellation=await app.inject({method:"POST",url:`/chat/streams/${streamId}/cancel`});
    expect(cancellation.json()).toEqual({cancelled:true});
    controller.abort(new DOMException("Stopped","AbortError"));
    await aborted;
    await new Promise(resolve=>setTimeout(resolve,50));

    const history=await app.inject({method:"GET",url:`/businesses/${business.json().id}/conversations/${conversation.json().id}`});
    expect(history.json().messages.map((message:{role:string})=>message.role)).toEqual(["user"]);
  });

  it("accepts a photo and voice message, transcribes audio, and keeps binary data out of history", async () => {
    let lastChat: ChatRequest | undefined;
    let transcriptionMimeType = "";
    const aiEngine: AIEngine = {
      chat: async (request) => {
        lastChat = request;
        return { content: "The image shows a product suitable for a furniture listing." };
      },
      transcribeAudio: async (input) => {
        transcriptionMimeType = input.mimeType;
        return { text: "I sell furniture in Lviv." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "vision", "audio.transcription"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "npati-attachments-"));
    tempDirectories.push(dataDirectory);
    const app = buildApp({
      workspaceStore: new InMemoryWorkspaceStore(),
      aiEngine,
      marketplace,
      dataDirectory,
      omnirouteVisionModel: "openai/gpt-5.6-luna",
    });
    apps.push(app);
    const business = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Furniture Lab", businessStage: "operating" } });
    const conversation = await app.inject({
      method: "POST",
      url: "/businesses/" + business.json().id + "/conversations",
      payload: { title: "Attachments" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: {
        message: "Create a product listing.",
        conversationId: conversation.json().id,
        attachments: [
          { kind: "image", name: "chair.png", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAElFTkSuQmCC" },
          { kind: "audio", name: "voice.m4a", mimeType: "audio/x-m4a", dataBase64: "AQID" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(lastChat?.model).toBe("openai/gpt-5.6-luna");
    expect(lastChat?.fallbackModel).toBeUndefined();
    expect(transcriptionMimeType).toBe("audio/mp4");
    const userContent = lastChat?.messages.at(-1)?.content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(JSON.stringify(userContent)).toContain("data:image/png;base64,iVBORw0KGgoAAA");
    expect(JSON.stringify(userContent)).toContain("I sell furniture in Lviv.");
    const history = await app.inject({
      method: "GET",
      url: "/businesses/" + business.json().id + "/conversations/" + conversation.json().id,
    });
    expect(history.body).toContain("Transcript: I sell furniture in Lviv.");
    expect(history.body).not.toContain("iVBORw0KGgo=");
    expect(history.body.indexOf("npati-attachment:image:")).toBeLessThan(history.body.indexOf("Create a product listing."));
    const attachmentId = history.body.match(/npati-attachment:image:([0-9a-f-]{36})/)?.[1];
    expect(attachmentId).toBeTruthy();
    const storedImage = await app.inject({ method: "GET", url: "/attachments/" + attachmentId });
    expect(storedImage.statusCode).toBe(200);
    expect(storedImage.headers["content-type"]).toBe("image/png");
    expect(storedImage.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect((await app.inject({ method: "DELETE", url: "/attachments/" + attachmentId })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/attachments/" + attachmentId })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/attachments/" + attachmentId })).statusCode).toBe(404);

    const documentUpload = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: {
        message: "Keep this document.",
        conversationId: conversation.json().id,
        attachments: [{ kind: "document", name: "brief.pdf", mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.7\nNPATI").toString("base64") }],
      },
    });
    expect(documentUpload.statusCode).toBe(200);
    const updatedHistory = await app.inject({
      method: "GET",
      url: "/businesses/" + business.json().id + "/conversations/" + conversation.json().id,
    });
    const documentId = updatedHistory.body.match(/npati-attachment:document:([0-9a-f-]{36})/)?.[1];
    expect(documentId).toBeTruthy();
    expect((await app.inject({ method: "DELETE", url: "/businesses/" + business.json().id })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/attachments/" + documentId })).statusCode).toBe(404);
  });

  it("starts and exposes aggregate health", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      services: { agent: "ok", omniroute: "not_configured", hub: "not_configured" },
    });
  });

  it("requires an AI provider but does not require a Business before opening Chat", async () => {
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 0 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ marketplace });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Start a business" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AI_PROVIDER_REQUIRED");
  });

  it("starts rapid onboarding directly from a free-text business brief", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = chatContentText(request.messages[0]?.content);
        if (instruction.includes("answer validator")) {
          return { content: '{"valid":true,"feedback":"","business":{"name":"Language Lab","description":"online Ukrainian lessons","market":"Poland","businessStage":"idea","teamType":"solo","businessModel":"subscription","presenceType":"online","audienceSummary":"Ukrainian families","productsServicesSummary":"weekly lessons and printable materials"}}' };
        }
        return { content: "What is the first meaningful goal you want to achieve? Example: I want to get my first 1,000 customers." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "I want to launch online Ukrainian lessons in Poland for Ukrainian families. I will start solo with a subscription." } });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      scenario: "starting",
      currentField: "businessGoal",
      currentStep: 1,
      totalFields: 2,
      business: { name: "Language Lab", market: "Poland", teamType: "solo", presenceType: "online" },
    });
    expect(response.json().message).toContain("1,000 customers");
  });

  it("runs conversational onboarding through AI and writes a structured Business Profile", async () => {
    const calls: ChatRequest[] = [];
    const aiEngine: AIEngine = {
      chat: async (request) => {
        calls.push(request);
        const instruction = chatContentText(request.messages[0]?.content);
        if (instruction.includes("answer validator")) {
          if (instruction.includes("Target field: businessGoal")) {
            return { content: '{"valid":true,"feedback":"Ціль збережено.","goalTitle":"Отримати перших 1,000 клієнтів"}' };
          }
          return instruction.includes("asdf qwer zzzz") || instruction.includes("Привіт")
            ? { content: '{"valid":false,"feedback":"Це не схоже на назву бізнесу. Напишіть, будь ласка, його назву."}' }
            : { content: '{"valid":true,"feedback":"","business":{"name":"Happy Candle","niche":"home fragrance","market":"United States","businessStage":"operating","teamType":"solo","businessModel":"B2C","presenceType":"online","audienceSummary":"home decor and gift buyers","productsServicesSummary":"handmade soy candles"}}' };
        }
        if (instruction.includes("conversational business onboarding")) {
          return instruction.includes("Привіт")
            ? { content: "Привіт! Радий познайомитися. Що ви хочете створити або продавати?" }
            : { content: "Схоже, ми почали не з того. Напишіть коротко, що ви хочете створити або продавати." };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Бізнес зрозумілий. Перший етап — залучення трафіку. Для цього бізнесу варто підключити Instagram, TikTok і Facebook до NPATI Hub, щоб разом створювати дописи та планувати публікації. Коли підключите, напишіть мені — я перевірю підключення." };
        }
        const prefix = /[іїєґ]/i.test(instruction.match(/latest answer is: ([^\n]+)/)?.[1] ?? "") ? "Добре. " : "Great. ";
        return { content: prefix + (instruction.match(/intended question is: ([^\n]+)/)?.[1] ?? "Tell me more.") };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = {
      marketplace: async () => ({ overview: { connectedProviders: 1 } }),
    } as unknown as OmniRouteMarketplace;
    const store = new InMemoryWorkspaceStore();
    const app = buildApp({ workspaceStore: store, aiEngine, marketplace });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: "/chat", payload: { onboardingAction: "start", scenario: "existing" } });
    expect(started.statusCode).toBe(200);
    expect(started.json().onboarding).toMatchObject({ currentField: "businessSnapshot", status: "active" });
    expect(calls[0]?.model).toBe("auto");

    const invalid = await app.inject({ method: "POST", url: "/chat", payload: { message: "asdf qwer zzzz" } });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().message).toContain("назву бізнесу");
    expect(invalid.json().onboarding).toMatchObject({ currentField: "businessSnapshot", business: { name: "Business setup" } });
    expect(invalid.json().onboarding.completedFields).not.toContain("businessSnapshot");

    const greeting = await app.inject({ method: "POST", url: "/chat", payload: { message: "Привіт" } });
    expect(greeting.statusCode).toBe(200);
    expect(greeting.json().message).toMatch(/^Привіт!/);
    expect(greeting.json().message).not.toMatch(/[—–]/);
    expect(greeting.json().onboarding.currentField).toBe("businessSnapshot");

    const callsBeforeQuickHelp = calls.length;
    const quickHelp = await app.inject({ method: "POST", url: "/chat", payload: { message: "Поясніть, як працює агент NPATI" } });
    expect(quickHelp.statusCode).toBe(200);
    expect(quickHelp.json().message).toContain("AI-асистент");
    expect(quickHelp.json().onboarding.currentField).toBe("businessSnapshot");
    expect(calls).toHaveLength(callsBeforeQuickHelp);

    const named = await app.inject({ method: "POST", url: "/chat", payload: { message: "Happy Candle sells handmade soy candles online in the United States to home decor and gift buyers. It is a solo B2C operating business." } });
    expect(named.statusCode).toBe(200);
    expect(named.json().onboarding.business).toMatchObject({ name: "Happy Candle", activationStatus: "draft" });
    expect(named.json().onboarding.completedFields).toContain("businessSnapshot");
    expect(named.json().onboarding.business.productsServicesSummary).toContain("soy candles");
    const memory = await app.inject({ method: "GET", url: `/businesses/${named.json().onboarding.businessId}/memory` });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toMatchObject([{ type: "business_fact", source: "chat_onboarding", content: expect.stringContaining("soy candles") }]);

    const localized = await app.inject({ method: "POST", url: "/chat", payload: { message: "Хочу отримати перших 1000 клієнтів." } });
    expect(localized.statusCode).toBe(200);
    expect(localized.json().message).toContain("NPATI Hub");
    expect(localized.json().message).not.toMatch(/[—–]/);
    expect(localized.json().onboarding.status).toBe("completed");
    const goals = await app.inject({ method: "GET", url: `/businesses/${localized.json().onboarding.businessId}/goals` });
    expect(goals.statusCode).toBe(200);
    expect(goals.json()).toMatchObject([{ title: "Отримати перших 1,000 клієнтів", status: "active" }]);

    const context = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(context.json()).toMatchObject({ currentBusiness: { name: "Happy Candle", activationStatus: "active" }, onboarding: null });
    const conversations = await app.inject({ method: "GET", url: `/businesses/${localized.json().onboarding.businessId}/conversations` });
    expect(conversations.json()).toHaveLength(1);

    const createdDraft = await app.inject({
      method: "POST",
      url: "/business-onboarding",
      payload: { scenario: "starting" },
    });
    expect(createdDraft.statusCode).toBe(201);
    expect(createdDraft.json().business.id).not.toBe(localized.json().onboarding.businessId);

    const secondBusiness = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { onboardingAction: "start", scenario: "starting", businessSetup: true },
    });
    expect(secondBusiness.statusCode).toBe(200);
    expect(secondBusiness.json().onboarding.business.id).toBe(createdDraft.json().business.id);
    const contextWithDraft = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(contextWithDraft.json()).toMatchObject({
      currentBusiness: { id: localized.json().onboarding.businessId },
      onboarding: { business: { id: secondBusiness.json().onboarding.business.id }, status: "active" },
      onboardings: [{ businessId: createdDraft.json().business.id }],
    });

    const anotherDraft = await app.inject({
      method: "POST",
      url: "/business-onboarding",
      payload: { scenario: "starting" },
    });
    expect(anotherDraft.statusCode).toBe(201);
    expect(anotherDraft.json().businessId).not.toBe(createdDraft.json().businessId);
    const contextWithTwoDrafts = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(contextWithTwoDrafts.json().onboardings.map((session: { businessId: string }) => session.businessId)).toEqual(
      expect.arrayContaining([createdDraft.json().businessId, anotherDraft.json().businessId]),
    );
  });

  it("accepts a short useful business description without requesting optional details", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = chatContentText(request.messages[0]?.content);
        if (instruction.includes("answer validator")) {
          return { content: JSON.stringify({ valid: false, feedback: "Потрібно більше деталей.", business: { market: "Ukraine", teamType: "solo", presenceType: "online", productsServicesSummary: "tables" } }) };
        }
        return { content: "Якого першого результату ви хочете досягти з продажем столів?" };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Україна, продаю столи, сам працюю, онлайн." } });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      currentField: "businessGoal",
      currentStep: 1,
      business: { market: "Ukraine", teamType: "solo", presenceType: "online", productsServicesSummary: "tables" },
    });
    expect(response.json().message).toContain("конкретної цілі");
  });

  it("rejects an invalid onboarding goal without saving it and continues to traffic guidance", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = chatContentText(request.messages[0]?.content);
        if (instruction.includes("answer validator") && instruction.includes("Target field: businessGoal")) {
          return { content: '{"valid":false,"feedback":"Ця відповідь не підходить для цілі. Додайте ціль вручну в розділі Goals."}' };
        }
        if (instruction.includes("answer validator")) {
          return { content: '{"valid":true,"feedback":"","business":{"name":"Eco Home","description":"online eco home shop","market":"Ukraine","businessStage":"idea","teamType":"solo","businessModel":"B2C","presenceType":"online","audienceSummary":"people reducing single-use plastic","productsServicesSummary":"reusable bottles, bags and containers"}}' };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Бізнес зрозумілий. Перший етап — залучення трафіку. Рекомендую Instagram, TikTok і Facebook. Підключіть їх до NPATI Hub, а потім напишіть мені — я перевірю підключення." };
        }
        return { content: "Якої першої конкретної цілі ви хочете досягти? Наприклад: отримати перших 1000 клієнтів." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const brief = await app.inject({ method: "POST", url: "/chat", payload: { message: "Хочу створити онлайн-магазин екотоварів в Україні для людей, які зменшують використання пластику." } });
    expect(brief.statusCode).toBe(200);
    expect(brief.json().onboarding.currentField).toBe("businessGoal");

    const invalidGoal = await app.inject({ method: "POST", url: "/chat", payload: { message: "asdf qwer zzzz" } });
    expect(invalidGoal.statusCode).toBe(200);
    expect(invalidGoal.json().message).toContain("NPATI Hub");
    expect(invalidGoal.json().onboarding.status).toBe("completed");

    const businessId = invalidGoal.json().onboarding.businessId;
    const goals = await app.inject({ method: "GET", url: `/businesses/${businessId}/goals` });
    expect(goals.json()).toEqual([]);
    const history = await app.inject({ method: "GET", url: `/businesses/${businessId}/conversations` });
    const conversation = await app.inject({ method: "GET", url: `/businesses/${businessId}/conversations/${history.json()[0].id}` });
    const messages = conversation.json().messages;
    expect(messages.at(-2)?.content).toContain("Goals");
    expect(messages.at(-1)?.content).toContain("NPATI Hub");
  });

  it("stores Business and Goal from one short message without asking optional questions", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = chatContentText(request.messages[0]?.content);
        if (instruction.includes("answer validator")) {
          return {
            content: JSON.stringify({
              valid: true,
              feedback: "",
              business: {
                market: "Ukraine",
                country: "Ukraine",
                businessStage: "starting",
                presenceType: "local",
                productsServicesSummary: "oil sold at a market",
              },
              goalTitle: "Заробляти 500 доларів на місяць",
            }),
          };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Для залучення покупців спробуйте Facebook та Instagram. Підключити канали можна тут: https://www.npati.com/hub/ Після підключення напишіть мені, і я перевірю з’єднання." };
        }
        return { content: "Це запитання не повинно з’явитися." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Я хочу продавати олію на базарі в Україні, ціль 500 доларів у місяць." },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      status: "completed",
      business: { market: "Ukraine", presenceType: "local", productsServicesSummary: "oil sold at a market" },
    });
    expect(response.json().message).toContain("https://www.npati.com/hub/?utm_source=NPATI_Agent");
    expect(response.json().message).not.toContain("яку саме олію");
    expect(response.json().message).not.toContain("основним покупцем");

    const businessId = response.json().onboarding.businessId;
    const goals = await app.inject({ method: "GET", url: "/businesses/" + businessId + "/goals" });
    expect(goals.json()).toMatchObject([{ title: "Заробляти 500 доларів на місяць", status: "active" }]);
    const memory = await app.inject({ method: "GET", url: "/businesses/" + businessId + "/memory" });
    expect(memory.json()).toMatchObject([{ type: "business_fact", content: expect.stringContaining("олію") }]);
  });

  it("creates a business through backend-owned local auth context", async () => {
    const app = buildApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST", url: "/businesses",
      headers: { "x-workspace-id": "spoofed-workspace" },
      payload: { name: "North Star Studio", businessStage: "operating" },
    });
    expect(created.statusCode).toBe(201);
    const context = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(context.json()).toMatchObject({
      workspace: { id: "dev-workspace" },
      currentBusiness: { name: "North Star Studio" },
    });
  });
});
