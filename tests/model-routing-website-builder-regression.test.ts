import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  isChatCapableModel,
  isEmbeddingModel,
  isNonChatSpecialtyModel,
  type AIEngine,
  type OmniRouteMarketplace,
  type AIModelSummary,
} from "@npati/omniroute-adapter";
import {
  classifyProjectIntent,
  extractFramework,
} from "@npati/shared";
import {
  InMemoryWorkspaceStore,
  type AuthContext,
} from "@npati/workspace";
import { AIPreferencesStore } from "../apps/agent-api/src/ai-preferences";
import { chatInferenceCandidates } from "../apps/agent-api/src/chat-inference-candidates";
import { buildApp } from "../apps/agent-api/src/app";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import { isModelError, ProjectOrchestrator } from "../apps/agent-api/src/project-orchestrator";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import type { SandboxProvider, SandboxScope, SandboxStatus, SandboxCommandResult, SandboxFile } from "../apps/agent-api/src/sandbox-provider";

const testPrompt = "Створи сучасний сайт для хостинг-компанії.\nВикористай Next.js.\nСторінки: Home, Hosting, Domains, Pricing, Contact.\nЗроби адаптивний дизайн і запусти Live Preview.";

function streamResult(body: string): any {
  const match = /event: result\ndata: ([^\n]+)/.exec(body);
  if (!match) throw new Error("Chat stream returned no result: " + body.slice(0, 500));
  return JSON.parse(match[1]!);
}

class MockSandboxProvider implements SandboxProvider {
  public files: SandboxFile[] = [];
  public exposedPort = 3000;
  public commands: string[] = [];
  async createSandbox(_scope: SandboxScope): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "created", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async startSandbox(_scope: SandboxScope, _id: string): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "running", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async stopSandbox(_scope: SandboxScope, _id: string): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "stopped", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async destroySandbox(_scope: SandboxScope, _id: string): Promise<void> {}
  async getStatus(_scope: SandboxScope, _id: string): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "running", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async uploadFiles(_scope: SandboxScope, _id: string, files: SandboxFile[]): Promise<void> {
    this.files = files;
  }
  async downloadFiles(_scope: SandboxScope, _id: string): Promise<SandboxFile[]> {
    return this.files;
  }
  async executeCommand(_scope: SandboxScope, _id: string, command: string): Promise<SandboxCommandResult> {
    this.commands.push(command);
    return { status: "completed", exitCode: 0, stdout: "Build success", stderr: "", durationMs: 50, step: "build", tool: "project.terminal.exec", retryable: false };
  }
  async startProcess(_scope: SandboxScope, _id: string, _command: string): Promise<SandboxCommandResult> {
    return { status: "running", exitCode: null, stdout: "Dev server started", stderr: "", durationMs: 10, step: "preview", tool: "project.terminal.exec", retryable: false, processId: "proc-123" };
  }
  async stopProcess(_scope: SandboxScope, _id: string, _processId: string): Promise<SandboxCommandResult> {
    return { status: "stopped", exitCode: 0, stdout: "", stderr: "", durationMs: 5, step: "preview", tool: "project.terminal.exec", retryable: false };
  }
  async getProcessStatus(_scope: SandboxScope, _id: string, _processId: string): Promise<SandboxCommandResult> {
    return { status: "running", exitCode: null, stdout: "", stderr: "", durationMs: 5, step: "preview", tool: "project.terminal.exec", retryable: false };
  }
  async exposePort(_scope: SandboxScope, _id: string, port: number): Promise<{ port: number; internalHost: string }> {
    this.exposedPort = port;
    return { port, internalHost: "127.0.0.1" };
  }
  async getLogs(_scope: SandboxScope, _id: string): Promise<string> {
    return "Ready on http://localhost:3000";
  }
}

describe("Model Routing & Website Builder Regression Tests", () => {
  const roots: string[] = [];
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe("1. Embedding and specialty non-chat models excluded from chat & routing", () => {
    it("correctly identifies embedding, image, audio, rerank, and moderation models", () => {
      expect(isEmbeddingModel({ id: "openai/text-embedding-ada-002" })).toBe(true);
      expect(isEmbeddingModel({ id: "text-embedding-3-small" })).toBe(true);
      expect(isEmbeddingModel({ id: "cohere/embed-english-v3.0" })).toBe(true);
      expect(isEmbeddingModel({ id: "openai/gpt-4o" })).toBe(false);

      expect(isNonChatSpecialtyModel({ id: "openai/text-embedding-ada-002" })).toBe(true);
      expect(isNonChatSpecialtyModel({ id: "openai/dall-e-3" })).toBe(true);
      expect(isNonChatSpecialtyModel({ id: "openai/whisper-large-v3" })).toBe(true);
      expect(isNonChatSpecialtyModel({ id: "cohere/rerank-v3.5" })).toBe(true);
      expect(isNonChatSpecialtyModel({ id: "openai/text-moderation-latest" })).toBe(true);
      expect(isNonChatSpecialtyModel({ id: "oc/north-mini-code-free" })).toBe(false);
      expect(isNonChatSpecialtyModel({ id: "anthropic/claude-3-5-sonnet" })).toBe(false);
    });

    it("isChatCapableModel rejects embedding models even if legacy capabilities had text", () => {
      expect(isChatCapableModel({ id: "openai/text-embedding-ada-002", capabilities: ["text"] })).toBe(false);
      expect(isChatCapableModel({ id: "openai/dall-e-3", capabilities: ["text"] })).toBe(false);
      expect(isChatCapableModel({ id: "openai/gpt-4o", capabilities: ["text", "chat"] })).toBe(true);
      expect(isChatCapableModel({ id: "oc/north-mini-code-free" })).toBe(true);
    });

    it("AIPreferencesStore does not set defaultModelId to an embedding model when added", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();
      const prefs = new AIPreferencesStore(store);
      const auth: AuthContext = { workspaceId: "ws-1", userId: "u-1", permissions: ["workspace:write"] };

      const embeddingModel: AIModelSummary = {
        id: "openai/text-embedding-ada-002",
        name: "text-embedding-ada-002",
        providerId: "openai",
        capabilities: ["embedding"],
      };

      const result = await prefs.add(auth, embeddingModel);
      expect(result.routing.defaultModelId).toBeNull();

      // Attempting to setDefault to an embedding model throws an error
      await expect(prefs.setDefault(auth, "openai/text-embedding-ada-002")).rejects.toThrow(
        /not a chat-capable model/i
      );
    });

    it("AIPreferencesStore sanitizes legacy stored defaultModelId if it was an embedding model", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();
      const auth: AuthContext = { workspaceId: "ws-1", userId: "u-1", permissions: ["workspace:write"] };

      const chatModel: AIModelSummary = {
        id: "oc/north-mini-code-free",
        name: "north-mini-code-free",
        providerId: "opencode",
        capabilities: ["text", "chat", "coding"],
      };
      const embeddingModel: AIModelSummary = {
        id: "openai/text-embedding-ada-002",
        name: "text-embedding-ada-002",
        providerId: "openai",
        capabilities: ["embedding"],
      };

      // Manually store legacy preference with embedding model as defaultModelId
      await store.setUserSetting(auth, "ai.preferences", {
        addedModels: [embeddingModel, chatModel],
        routing: {
          mode: "manual",
          defaultModelId: "openai/text-embedding-ada-002",
        },
      }, 0);

      const prefs = new AIPreferencesStore(store);
      const loaded = await prefs.get(auth);
      // It must be sanitized to the chat model, not the embedding model
      expect(loaded.routing.defaultModelId).toBe("oc/north-mini-code-free");
    });
  });

  describe("2. Fallback skips unsupported models and selects next compatible model", () => {
    it("identifies model errors for routing recovery", () => {
      expect(isModelError(new Error("InferenceRouteFailure: openai/text-embedding-ada-002 failed (HTTP 404)"))).toBe(true);
      expect(isModelError(new Error("HTTP 401 unauthorized model denied"))).toBe(true);
      expect(isModelError(new Error("Model does not support chat/completions"))).toBe(true);
      expect(isModelError(new Error("SyntaxError in file app.tsx: unexpected token"))).toBe(false);
    });
  });

  describe("3. Framework selection: Next.js requested creates Next.js project", () => {
    it("extracts Next.js from various prompt formulations", () => {
      expect(extractFramework("Використай Next.js.")).toBe("Next.js");
      expect(extractFramework("Use Next.js")).toBe("Next.js");
      expect(extractFramework("Create a Nextjs website")).toBe("Next.js");
      expect(extractFramework(testPrompt)).toBe("Next.js");
    });

    it("classifyProjectIntent classifies CREATE_WEBSITE with framework Next.js", () => {
      const decision = classifyProjectIntent({ message: testPrompt });
      expect(decision.intent).toBe("CREATE_WEBSITE");
      expect(decision.isExecutableInStep5).toBe(true);
      expect(decision.targetDetails?.framework).toBe("Next.js");
    });
  });

  describe("4. Model failure is not classified as build/preview failure", () => {
    it("marks stage as model_routing_failed rather than build failure", () => {
      const err = new Error("AI inference failed for openai/text-embedding-ada-002 (HTTP 404), then oc/north-mini-code-free (HTTP 401)");
      expect(isModelError(err)).toBe(true);
    });
  });

  describe("5. Full E2E Test through ordinary Chat", () => {
    it("Chat -> CREATE_WEBSITE -> Next.js Project -> AI Developer -> Files -> Sandbox -> Build -> Preview -> Live Preview", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "npati-chat-e2e-"));
      roots.push(root);

      const store = new InMemoryWorkspaceStore();
      await store.initialize();
      const auth: AuthContext = {
        workspaceId: "e2e-ws",
        userId: "e2e-user",
        permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
      };

      const company = await store.createCompany(auth, { name: "Hosting Inc" }, "hosting-inc");
      const agent = await store.createCompanyAgent(auth, company.id, {
        name: "AI Developer",
        role: "frontend developer",
        tools: ["project.files.read", "project.files.write", "project.terminal.exec", "project.preview.start"],
        isActive: true,
      }, "ai-developer-agent");
      await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);

      const attemptedModels: string[] = [];
      const comboRoutes: string[][] = [];
      const aiEngine = {
        chat: async () => ({
          content: "Next.js hosting website created successfully with Home, Hosting, Domains, Pricing, and Contact pages.",
          model: "oc/north-mini-code-free",
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        }),
        async *stream() {
          yield "Next.js hosting website created successfully with Home, Hosting, Domains, Pricing, and Contact pages.";
        },
        listModels: async () => [
          { id: "openai/text-embedding-ada-002", type: "embedding", capabilities: ["embedding"] },
          { id: "test/unsupported", type: "chat", supportedEndpoints: ["/v1/chat/completions"] },
          { id: "oc/north-mini-code-free", name: "north-mini-code-free", capabilities: ["chat", "coding"] },
        ],
        getModel: async () => undefined,
        executeTool: async () => undefined,
        searchMemory: async () => [],
        saveMemory: async () => undefined,
        getCapabilities: async () => ["chat"],
        healthCheck: async () => ({ status: "ok" }),
        ensureA2AEnabled: async () => undefined,
        ensureCombo: async (input: { name: string; models: string[] }) => { comboRoutes.push(input.models); return { name: input.name }; },
        a2aSend: async (request: { model?: string }) => {
          attemptedModels.push(request.model ?? "auto");
          if (request.model === "test/unsupported") throw new Error("HTTP 404: model unsupported for chat/completions");
          return { taskId: "dev-task", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [] }), metadata: {} };
        },
      } as unknown as AIEngine;

      const marketplace = {
        marketplace: async () => ({ overview: { connectedProviders: 1 } }),
      } as OmniRouteMarketplace;

      const authProvider: AuthProvider = { authenticate: async () => auth };

      const projectService = new ProjectService(store);
      const projectWorkspace = new LocalProjectWorkspace(projectService, { root });
      const projectTerminalEvents = new ProjectTerminalEventsRepository(projectService);
      const mockSandbox = new MockSandboxProvider();
      const projectSandbox = new ProjectSandboxService(
        projectService,
        store,
        projectWorkspace,
        mockSandbox,
        projectTerminalEvents,
        undefined
      );

      const app = buildApp({
        workspaceStore: store,
        authProvider,
        aiEngine,
        marketplace,
        projectWorkspaceRoot: root,
        projectSandbox,
      });
      apps.push(app);

      // Execute Chat request with the exact user prompt
      const response = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          message: testPrompt,
          contextType: "company",
          companyId: company.id,
        },
      });

      expect(response.statusCode).toBe(200);
      const result = streamResult(response.body);

      // 1. Chat returned result
      expect(result).toBeDefined();

      // 2. CREATE_WEBSITE intent executed
      expect(result.projectAction?.action).toBe("create");

      // 3. Next.js Project created (NOT Vite)
      expect(result.projectCard?.framework).toBe("Next.js");
      const projectId = result.projectCard?.projectId as string;
      expect(projectId).toBeTruthy();

      // 4. AI Developer was selected and ran
      const projectRuns = await store.listProjectRuns(auth, company.id, projectId);
      expect(projectRuns).toHaveLength(1);
      expect(projectRuns[0]?.selectedAgentIds).toContain(agent.id);
      expect(attemptedModels.slice(0, 2)).toEqual(["test/unsupported", "oc/north-mini-code-free"]);
      expect(comboRoutes.length).toBeGreaterThan(0);
      expect(comboRoutes.every((route) => !route.includes("openai/text-embedding-ada-002"))).toBe(true);

      // 5. Files verified in Workspace
      const filesRes = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${projectId}/files/tree`,
      });
      expect(filesRes.statusCode).toBe(200);
      expect(JSON.stringify(filesRes.json())).toContain("PROJECT.md");
      expect(JSON.stringify(filesRes.json())).toContain("app/page.tsx");
      const manifest = JSON.parse((await projectWorkspace.readFile(auth, company.id, projectId, "package.json")).content);
      expect(manifest.dependencies.next).toBeTruthy();
      expect(manifest.dependencies.vite).toBeUndefined();

      // 6. Build & Sandbox verified
      expect(result.projectCard?.lastBuildStatus).toBe("success");
      expect(mockSandbox.commands).toContain("npm install");
      expect(mockSandbox.commands).toContain("npm run build");

      // 7. Preview & Live Preview URL verified
      expect(result.projectCard?.previewUrl).toBeTruthy();
      expect(result.suggestedActions).toContain(`Preview: ${result.projectCard.name}`);
      expect(result.suggestedActions).toContain(`Open: ${result.projectCard.name}`);
    });
  });
});

describe("Capability-aware inference candidate selection", () => {
  it("rejects embedding, image, audio and completion-only metadata before planning", () => {
    const candidates = chatInferenceCandidates(
      ["provider/embedding", "provider/unsupported"],
      [],
      [
        { id: "provider/embedding", type: "embedding", capabilities: ["text", "embedding"] },
        { id: "provider/image", type: "image" },
        { id: "provider/audio", type: "audio" },
        { id: "provider/completion-only", supportedEndpoints: ["/v1/completions"] },
        { id: "provider/image-output", type: "chat", outputModalities: ["image"] },
        { id: "provider/combo", type: "chat", ownedBy: "combo" },
        { id: "provider/embedding-format", apiFormat: "embedding" },
        { id: "provider/unsupported", type: "chat", supportedEndpoints: ["/v1/chat/completions"] },
        { id: "provider/working", type: "chat", supportedEndpoints: ["/v1/chat/completions"] },
      ],
    );
    expect(candidates).toEqual(["provider/unsupported", "provider/working"]);
  });
});

describe("Project model failure stage", () => {
  it("reports model_routing_failed without labelling the build as failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-model-stage-"));
    try {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();
      const auth: AuthContext = { workspaceId: "stage-ws", userId: "stage-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
      const company = await store.createCompany(auth, { name: "Hosting" }, "stage-company");
      const agent = await store.createCompanyAgent(auth, company.id, { name: "Developer", role: "frontend developer", tools: ["project.files.read", "project.files.write"], isActive: true }, "stage-agent");
      await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
      const projects = new ProjectService(store);
      const workspace = new LocalProjectWorkspace(projects, { root });
      const runtime = { execute: async (_ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) => {
        const { run } = await store.createCompanyAgentRun(auth, companyId, { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(auth, companyId, run.id, { status: "failed", errorCode: "model_routing_failed", errorMessage: "HTTP 404: model does not support chat" });
        return store.getCompanyAgentRun(auth, companyId, run.id);
      } };
      const preview = { getPreviewStatus: async () => ({ previewUrl: null }) };
      const orchestrator = new ProjectOrchestrator(store, projects, workspace, undefined, preview as any, runtime as any);
      const result = await orchestrator.executeWebsiteTask(auth, { companyId: company.id, intentDecision: classifyProjectIntent({ message: testPrompt }), prompt: testPrompt, idempotencyKey: "stage-project" });
      expect(result.errorDetails?.step).toBe("model_routing_failed");
      expect(result.project.lastBuildStatus).not.toBe("failed");
      expect(result.responseMessage).toContain("Model routing failed");
      expect(result.responseMessage).not.toContain("Build or preview failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Explicit Next.js framework", () => {
  it("rejects a generated Vite manifest instead of silently switching frameworks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-next-guard-"));
    try {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();
      const auth: AuthContext = { workspaceId: "framework-ws", userId: "framework-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
      const company = await store.createCompany(auth, { name: "Hosting" }, "framework-company");
      const agent = await store.createCompanyAgent(auth, company.id, { name: "Developer", role: "frontend developer", tools: ["project.files.read", "project.files.write"], isActive: true }, "framework-agent");
      await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
      const projects = new ProjectService(store);
      const workspace = new LocalProjectWorkspace(projects, { root });
      const runtime = { execute: async (_ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) => {
        const file = await workspace.readFile(auth, companyId, input.projectId, "package.json");
        await workspace.writeFile(auth, companyId, input.projectId, "package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, dependencies: { vite: "latest" } }), file.revision);
        const { run } = await store.createCompanyAgentRun(auth, companyId, { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(auth, companyId, run.id, { status: "completed", result: "site created" });
        return store.getCompanyAgentRun(auth, companyId, run.id);
      } };
      const preview = { getPreviewStatus: async () => ({ previewUrl: null }) };
      const orchestrator = new ProjectOrchestrator(store, projects, workspace, undefined, preview as any, runtime as any);
      await expect(orchestrator.executeWebsiteTask(auth, { companyId: company.id, intentDecision: classifyProjectIntent({ message: testPrompt }), prompt: testPrompt, idempotencyKey: "framework-project" }))
        .rejects.toMatchObject({ code: "FRAMEWORK_MISMATCH" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
