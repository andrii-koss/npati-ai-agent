import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";

const auth: AuthContext = { userId: "entity-mutation-user", workspaceId: "entity-mutation-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const block = (kind: string, value: object) => `Done.\n\n\`\`\`${kind}\n${JSON.stringify(value)}\n\`\`\``;
const result = (body: string): Record<string, any> => {
  const event = body.split("\n\n").find((part) => part.includes("event: result"));
  const line = event?.split("\n").find((part) => part.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
};

describe("business and goal mutations through production chat", () => {
  it("updates the requested business and goal, then deletes the goal and business", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(auth, { name: "Eco Cafe", businessStage: "operating", industry: "Food" });
    const goal = await store.createGoal(auth, business.id, { title: "Open second location", priority: 2, status: "active" });
    const directives: Record<string, string> = {
      "Update business industry": block("business-action", { action: "update", businessId: business.id, profile: { industry: "Hospitality" } }),
      "Update goal title": block("goal-action", { action: "update", businessId: business.id, goalId: goal.id, goal: { title: "Open three locations", priority: 2, status: "active" } }),
      "Delete goal": block("goal-action", { action: "delete", businessId: business.id, goalId: goal.id }),
      "Delete business idea": block("business-action", { action: "delete", businessId: business.id }),
    };
    const output = (request: Parameters<AIEngine["chat"]>[0]) => {
      const user = [...request.messages].reverse().find((item) => item.role === "user")?.content;
      return directives[String(user)] ?? "No matching request";
    };
    const ai: AIEngine = {
      chat: async (request) => ({ content: output(request) }),
      async *stream(request) { yield output(request); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      for (const [message, kind, action] of [
        ["Update business industry", "businessAction", "update"],
        ["Update goal title", "goalAction", "update"],
        ["Delete goal", "goalAction", "delete"],
        ["Delete business idea", "businessAction", "delete"],
      ]) {
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
        expect(response.statusCode, message).toBe(200);
        expect(result(response.body)[kind!]?.action, message).toBe(action);
        if (message === "Update business industry") expect(await store.getUserBusiness(auth, business.id)).toMatchObject({ name: "Eco Cafe", industry: "Hospitality" });
        if (message === "Update goal title") expect((await store.listGoals(auth, business.id))[0]?.title).toBe("Open three locations");
        if (message === "Delete goal") expect(await store.listGoals(auth, business.id)).toHaveLength(0);
      }
      expect(await store.listUserBusinesses(auth)).toHaveLength(0);
    } finally { await app.close(); }
  });
});
