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
  it("finishes business idea and memory creation when the memory planner returns NO_ACTION", async () => {
    const store = new InMemoryWorkspaceStore();
    const message = "\u0421\u0442\u0432\u043e\u0440\u0438 \u0431\u0456\u0437\u043d\u0435\u0441, \u0456\u0434\u0435\u044e, \u0456 \u043c\u0435\u043c\u043e\u0440\u0456, \u043f\u0440\u043e\u0441\u0442\u043e \u0434\u043b\u044f \u0442\u0435\u0441\u0442\u0430";
    const businessReply = block("business-action", { action: "create", profile: { name: "NovaScale Test", businessStage: "idea", description: "A test business idea." } });
    const ai: AIEngine = {
      chat: async () => ({ content: "NO_ACTION" }),
      async *stream() { yield businessReply; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const completed = result(response.body);
      expect(completed.businessAction?.action).toBe("create");
      expect(completed.workspaceAction?.action).toBe("memory.create");
      expect(completed.goalAction).toBeUndefined();
      expect(completed.message).toContain("NovaScale Test");
      expect(completed.message).not.toContain("NO_ACTION");
      expect(completed.message).not.toContain("\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0431\u0435\u0437\u043f\u0435\u0447\u043d\u043e");
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses).toHaveLength(1);
      expect(await store.listGoals(auth, businesses[0]!.id)).toHaveLength(0);
      expect(await store.listMemory(auth, businesses[0]!.id)).toEqual([
        expect.objectContaining({ type: "business_fact", title: "NovaScale Test", content: expect.stringContaining("A test business idea.") }),
      ]);
    } finally { await app.close(); }
  });
  it("uses the newly created business for planned memory even when other businesses exist", async () => {
    const store = new InMemoryWorkspaceStore();
    const older = await store.createBusiness(auth, { name: "Older idea", businessStage: "idea" });
    const message = "Create a business idea and save its memory";
    const businessReply = block("business-action", { action: "create", profile: { name: "Fresh idea", businessStage: "idea", description: "Fresh test context." } });
    const plannedMemory = block("workspace-action", { action: "memory.create", intro: "Memory saved.", memory: { type: "business_fact", title: "Fresh context", content: "Fresh idea tests onboarding.", confidence: 1 } });
    const ai: AIEngine = {
      chat: async () => ({ content: plannedMemory }),
      async *stream() { yield businessReply; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const completed = result(response.body);
      const businesses = await store.listUserBusinesses(auth);
      const fresh = businesses.find((item) => item.name === "Fresh idea");
      expect(fresh).toBeDefined();
      expect(completed.businessAction?.businessId).toBe(fresh!.id);
      expect(completed.workspaceAction).toMatchObject({ action: "memory.create", businessId: fresh!.id });
      expect(await store.listMemory(auth, older.id)).toHaveLength(0);
      expect(await store.listMemory(auth, fresh!.id)).toEqual([expect.objectContaining({ title: "Fresh context" })]);
      expect(await store.listGoals(auth, fresh!.id)).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("moves a planned memory away from an older business to the newly created idea", async () => {
    const store = new InMemoryWorkspaceStore();
    const older = await store.createBusiness(auth, { name: "Older idea", businessStage: "idea" });
    const message = "Create a business idea and memory for testing";
    const businessReply = block("business-action", { action: "create", profile: { name: "Current idea", businessStage: "idea", description: "Current verified description." } });
    const plannedMemory = block("workspace-action", { action: "memory.create", businessId: older.id, memory: { type: "business_fact", title: "Wrong target", content: "Should not remain in the older business." } });
    const ai: AIEngine = {
      chat: async () => ({ content: plannedMemory }),
      async *stream() { yield businessReply; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const current = (await store.listUserBusinesses(auth)).find((item) => item.name === "Current idea");
      expect(current).toBeDefined();
      expect(result(response.body).workspaceAction).toMatchObject({ action: "memory.create", businessId: current!.id });
      expect(await store.listMemory(auth, older.id)).toHaveLength(0);
      expect(await store.listMemory(auth, current!.id)).toEqual([expect.objectContaining({ title: "Current idea" })]);
    } finally { await app.close(); }
  });
});
