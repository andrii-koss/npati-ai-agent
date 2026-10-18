import { describe, expect, it } from "vitest";
import { filterProviders, isCodingAgentProvider, KNOWN_CODING_AGENT_PROVIDER_IDS, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodePreferencesStore } from "../apps/agent-api/src/code-preferences";
import { resolveModelProfile as resolveCodeModelProfile } from "../apps/agent-api/src/code-model-profiles";
import { buildSystemPrompt } from "../apps/agent-api/src/coding-agent-runner-prompt";
import Fastify from "fastify";
import { registerCodeAgentRoutes } from "../apps/agent-api/src/code-agent-routes";
import type { AuthProvider } from "../apps/agent-api/src/auth";

const testContext: AuthContext = {
  workspaceId: "test-workspace-cagents",
  userId: "test-user-cagents",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

describe("Coding Agent OmniRoute Integration", () => {
  describe("Provider Classification & Scoping", () => {
    it("identifies known coding agent providers correctly", () => {
      expect(isCodingAgentProvider({ id: "claude", name: "Claude Code", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "codex", name: "Codex", category: "developer-tools" })).toBe(true);
      expect(isCodingAgentProvider({ id: "cursor", name: "Cursor", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "opencode", name: "OpenCode", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "zed", name: "Zed", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "trae", name: "Trae", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "kiro", name: "Kiro", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "antigravity", name: "Google Antigravity", category: "coding-agent" })).toBe(true);
      expect(isCodingAgentProvider({ id: "ghe-copilot", name: "GitHub Copilot", category: "developer-tools" })).toBe(true);
    });

    it("distinguishes general LLM providers from coding agents", () => {
      expect(isCodingAgentProvider({ id: "openai", name: "OpenAI", category: "api-key" })).toBe(false);
      expect(isCodingAgentProvider({ id: "gemini", name: "Google Gemini", category: "api-key" })).toBe(false);
      expect(isCodingAgentProvider({ id: "anthropic", name: "Anthropic Claude API", category: "api-key" })).toBe(false);
      expect(isCodingAgentProvider({ id: "groq", name: "Groq", category: "api-key" })).toBe(false);
      expect(isCodingAgentProvider({ id: "mistral", name: "Mistral", category: "api-key" })).toBe(false);
      expect(isCodingAgentProvider({ id: "ollama-local", name: "Ollama", category: "local" })).toBe(false);
      expect(isCodingAgentProvider({ id: "openrouter", name: "OpenRouter", category: "api-key" })).toBe(false);
    });

    it("scopes marketplace queries so ai hides coding agents and code shows only coding agents", () => {
      const sampleProviders = [
        { id: "openai", name: "OpenAI", category: "api-key", connected: true, connectable: true, freeStatus: "paid", local: false, capabilities: ["text"] },
        { id: "claude", name: "Claude Code", category: "coding-agent", connected: true, connectable: true, freeStatus: "paid", local: false, capabilities: ["code"] },
        { id: "codex", name: "Codex", category: "developer-tools", connected: false, connectable: true, freeStatus: "paid", local: false, capabilities: ["code"] },
        { id: "anthropic", name: "Anthropic Claude API", category: "api-key", connected: true, connectable: true, freeStatus: "paid", local: false, capabilities: ["text"] },
        { id: "cursor", name: "Cursor", category: "coding-agent", connected: false, connectable: true, freeStatus: "paid", local: false, capabilities: ["code"] },
      ] as any;

      const aiList = filterProviders(sampleProviders, [], { scope: "ai" });
      const aiProviderIds = aiList.map((p) => p.id);
      expect(aiProviderIds).toContain("openai");
      expect(aiProviderIds).toContain("anthropic");
      expect(aiProviderIds).not.toContain("claude");
      expect(aiProviderIds).not.toContain("codex");
      expect(aiProviderIds).not.toContain("cursor");

      const codeList = filterProviders(sampleProviders, [], { scope: "code" });
      const codeProviderIds = codeList.map((p) => p.id);
      expect(codeProviderIds).toContain("claude");
      expect(codeProviderIds).toContain("codex");
      expect(codeProviderIds).toContain("cursor");
      expect(codeProviderIds).not.toContain("openai");
      expect(codeProviderIds).not.toContain("anthropic");
    });
  });

  describe("Code Preferences Store", () => {
    it("manages active coding agent and enabled agents in workspace store", async () => {
      const store = new InMemoryWorkspaceStore();
      const prefs = new CodePreferencesStore(store);

      const initial = await prefs.get(testContext);
      expect(initial.activeAgentId).toBe("npati");
      expect(initial.activeAgentName).toBe("Npati Code");
      expect(initial.enabledAgentIds).toContain("npati");

      await prefs.setActiveAgent(testContext, "codex", "OpenAI Codex", "codex-mini");
      const updated = await prefs.get(testContext);
      expect(updated.activeAgentId).toBe("codex");
      expect(updated.activeAgentName).toBe("OpenAI Codex");
      expect(updated.activeModelId).toBe("codex-mini");
      expect(updated.enabledAgentIds).toContain("codex");

      await prefs.toggleAgent(testContext, "claude", true);
      const afterToggle = await prefs.get(testContext);
      expect(afterToggle.enabledAgentIds).toContain("claude");

      await prefs.toggleAgent(testContext, "claude", false);
      const afterDisable = await prefs.get(testContext);
      expect(afterDisable.enabledAgentIds).not.toContain("claude");
    });
  });

  describe("Model Profiles & Prompt Parametrization", () => {
    it("maps external coding agents to native tool profiles", () => {
      const resolved = resolveCodeModelProfile({ provider: "claude", model: "claude-code-3.7" });
      expect(resolved).toBeDefined();
      expect(resolved.profile.toolCallingMode).toBe("native");
      expect(resolved.profile.contextWindow).toBeGreaterThanOrEqual(128_000);
    });

    it("embeds custom active coding agent identity into the system prompt", () => {
      const prompt = buildSystemPrompt({
        session: { id: "s1", mode: "standard" } as any,
        tools: [],
        environment: { os: "linux", cwd: "/workspace", date: "2026-10-18" },
        limits: { maxStepsPerRun: 20, maxRunMinutes: 10 },
        agentId: "OpenAI Codex",
      });
      expect(prompt).toContain("You are the OpenAI Codex");
      expect(prompt).not.toContain("You are the NPATI Coding Agent");

      const defaultPrompt = buildSystemPrompt({
        session: { id: "s1", mode: "standard" } as any,
        tools: [],
        environment: { os: "linux", cwd: "/workspace", date: "2026-10-18" },
        limits: { maxStepsPerRun: 20, maxRunMinutes: 10 },
      });
      expect(defaultPrompt).toContain("You are the NPATI Coding Agent");
    });
  });

  describe("Fastify Code Agent Routes Pipeline", () => {
    it("registers /code/preferences and /code/agents with active agent controls", async () => {
      const authProvider: AuthProvider = { authenticate: async () => testContext };
      const marketplace = {
        marketplace: async (query?: { scope?: string }) => ({
          overview: { connectedProviders: 1 },
          providers: [
            { id: "codex", name: "Codex", connected: true, category: "developer-tools", capabilities: ["code"] },
            { id: "claude", name: "Claude Code", connected: false, category: "coding-agent", capabilities: ["code"] },
          ],
          categories: ["coding-agent", "developer-tools"],
          pagination: { total: 2, offset: 0, limit: 100 },
        }),
      } as unknown as OmniRouteMarketplace;

      const store = new InMemoryWorkspaceStore();
      const codePrefs = new CodePreferencesStore(store);
      const aiPrefs = { get: async () => ({ addedModels: [] }) } as any;

      const app = Fastify();
      registerCodeAgentRoutes(app, marketplace, codePrefs, aiPrefs, authProvider);

      // 1. GET /code/preferences
      const prefRes = await app.inject({
        method: "GET",
        url: "/code/preferences",
        headers: { authorization: "Bearer test" },
      });
      expect(prefRes.statusCode).toBe(200);
      const prefBody = JSON.parse(prefRes.body);
      expect(prefBody.activeAgentId).toBe("npati");

      // 2. GET /code/agents
      const agentsRes = await app.inject({
        method: "GET",
        url: "/code/agents",
        headers: { authorization: "Bearer test" },
      });
      expect(agentsRes.statusCode).toBe(200);
      const agentsBody = JSON.parse(agentsRes.body);
      expect(agentsBody.builtIn.id).toBe("npati");
      expect(agentsBody.builtIn.name).toBe("Npati Code");
      expect(agentsBody.providers.length).toBe(2);

      // 3. POST /code/agents/codex/active
      const activeRes = await app.inject({
        method: "POST",
        url: "/code/agents/codex/active",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ name: "Codex External Agent" }),
      });
      expect(activeRes.statusCode).toBe(200);
      const activeBody = JSON.parse(activeRes.body);
      expect(activeBody.activeAgentId).toBe("codex");
      expect(activeBody.activeAgentName).toBe("Codex External Agent");

      // 4. Verify updated /code/preferences
      const checkRes = await app.inject({
        method: "GET",
        url: "/code/preferences",
        headers: { authorization: "Bearer test" },
      });
      expect(JSON.parse(checkRes.body).activeAgentId).toBe("codex");

      await app.close();
    });
  });
});
