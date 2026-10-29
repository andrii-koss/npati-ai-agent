import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const auth: AuthContext = { userId: "live-user", workspaceId: "live-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

function engine(route: { coreCapability: string | null; coreMutation: boolean }, main: ChatRequest[]): AIEngine {
  return {
    supportsNativeTools: () => true,
    async chat(request) {
      if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
        const args = { intent: "CHAT", confidence: 0.99, targets: [], entityRead: null, assignsWorkToCompanyAgent: false, externalResearch: false, ...route };
        return { content: "", toolCalls: [{ id: "route", type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(args) } }] };
      }
      const system = request.messages[0];
      if (system?.role !== "system" || !String(system.content).startsWith("You are NPATI Agent")) return { content: "{}" };
      main.push(request);
      request.onTextDelta?.("2 + 2 ");
      request.onTextDelta?.("= 4");
      return { content: "2 + 2 = 4" };
    },
    async *stream() { throw new Error("Native chat must not stream"); },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
}

const deltas = (body: string) => [...body.matchAll(/event: delta\r?\ndata: (\{[^\r\n]+\})/g)].map((match) => JSON.parse(match[1]!).delta as string);

describe("live chat text", () => {
  it("streams a conversational answer as it is generated and does not resend it whole", async () => {
    const main: ChatRequest[] = [];
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: engine({ coreCapability: null, coreMutation: false }, main), marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Скільки буде 2+2?", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(deltas(response.body)).toEqual(["2 + 2 ", "= 4"]);
      expect(response.body).toContain('"message":"2 + 2 = 4"');
    } finally { await app.close(); }
  });

  it("keeps a record action's text until the server outcome is known", async () => {
    const main: ChatRequest[] = [];
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: engine({ coreCapability: "npati_business_profile", coreMutation: true }, main), marketplace });
    try {
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Створи бізнес-профіль Live Cafe.", contextType: "none" } });
      expect(main.length).toBeGreaterThan(0);
      expect(main.every((request) => request.onTextDelta === undefined)).toBe(true);
    } finally { await app.close(); }
  });
});
