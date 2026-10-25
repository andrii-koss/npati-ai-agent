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
import { isModelError, ProjectOrchestrator, extractCleanProjectName } from "../apps/agent-api/src/project-orchestrator";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
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
  public startedProcesses = 0;
  public stoppedProcesses = 0;
  public destroyedSandboxes = 0;
  async createSandbox(_scope: SandboxScope): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "created", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async startSandbox(_scope: SandboxScope, _id: string): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "running", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async stopSandbox(_scope: SandboxScope, _id: string): Promise<SandboxStatus> {
    return { id: "test-sandbox-id", state: "stopped", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async destroySandbox(_scope: SandboxScope, _id: string): Promise<void> { this.destroyedSandboxes++; }
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
    this.startedProcesses++;
    return { status: "running", exitCode: null, stdout: "Dev server started", stderr: "", durationMs: 10, step: "preview", tool: "project.terminal.exec", retryable: false, processId: "22222222-2222-4222-8222-222222222222" };
  }
  async stopProcess(_scope: SandboxScope, _id: string, _processId: string): Promise<SandboxCommandResult> {
    this.stoppedProcesses++;
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
        upstreamId: "text-embedding-ada-002",
        providerId: "openai",
        providerName: "OpenAI",
        name: "text-embedding-ada-002",
        capabilities: ["embedding"],
        added: true,
        local: false,
        freeStatus: "paid",
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
        upstreamId: "north-mini-code-free",
        providerId: "opencode",
        providerName: "OpenCode",
        name: "north-mini-code-free",
        capabilities: ["text", "chat", "coding"],
        added: true,
        local: false,
        freeStatus: "free",
      };
      const embeddingModel: AIModelSummary = {
        id: "openai/text-embedding-ada-002",
        upstreamId: "text-embedding-ada-002",
        providerId: "openai",
        providerName: "OpenAI",
        name: "text-embedding-ada-002",
        capabilities: ["embedding"],
        added: true,
        local: false,
        freeStatus: "paid",
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
      await store.setUserSetting(auth, "ai.preferences", { addedModels: [
        { id: "test/unsupported", upstreamId: "unsupported", providerId: "test", providerName: "Test", name: "Unsupported", capabilities: ["chat"], added: true, local: false, freeStatus: "free" },
        { id: "oc/north-mini-code-free", upstreamId: "north-mini-code-free", providerId: "oc", providerName: "OpenCode", name: "North Mini", capabilities: ["chat", "coding"], added: true, local: false, freeStatus: "free" },
      ], routing: { mode: "manual", defaultModelId: "oc/north-mini-code-free" } }, 0);

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
      const live = await app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
      expect(live.json().build).toMatchObject({ version: expect.any(String), commit: expect.any(String), fingerprint: expect.any(String) });

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
      expect(attemptedModels).toContain("oc/north-mini-code-free");
      expect(attemptedModels).not.toContain("test/unsupported");
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
      expect(mockSandbox.startedProcesses).toBeGreaterThan(0);

      const previewPath = `/companies/${company.id}/projects/${projectId}/preview`;
      expect((await app.inject({ method: "POST", url: `${previewPath}/stop` })).statusCode).toBe(200);
      expect(mockSandbox.stoppedProcesses).toBeGreaterThan(0);
      expect((await app.inject({ method: "POST", url: `${previewPath}/start`, payload: {} })).statusCode).toBe(200);
      expect(mockSandbox.startedProcesses).toBeGreaterThan(1);
      const currentProject = await projectService.get(auth, company.id, projectId);
      await projectSandbox.destroy(auth, currentProject);
      expect(mockSandbox.destroyedSandboxes).toBe(1);
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
  it("stops without a repair run when the project is deleted during build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-deleted-build-"));
    try {
      const store = new InMemoryWorkspaceStore(); await store.initialize();
      const auth: AuthContext = { workspaceId: "deleted-ws", userId: "deleted-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
      const company = await store.createCompany(auth, { name: "Hosting" }, "deleted-company");
      const agent = await store.createCompanyAgent(auth, company.id, { name: "Developer", role: "frontend developer", tools: ["project.files.read", "project.files.write"], isActive: true }, "deleted-agent");
      await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
      const projects = new ProjectService(store), workspace = new LocalProjectWorkspace(projects, { root });
      let executions = 0;
      const runtime = { execute: async (_ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) => {
        executions++;
        const { run } = await store.createCompanyAgentRun(auth, companyId, { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(auth, companyId, run.id, { status: "completed", result: "done" });
        return store.getCompanyAgentRun(auth, companyId, run.id);
      } };
      const preview = { buildProject: async (_ctx: AuthContext, companyId: string, projectId: string) => {
        await projects.delete(auth, companyId, projectId);
        throw new Error("Build interrupted");
      }, getPreviewStatus: async () => ({ previewUrl: null }) };
      const orchestrator = new ProjectOrchestrator(store, projects, workspace, undefined, preview as any, runtime as any);
      await expect(orchestrator.executeWebsiteTask(auth, { companyId: company.id, intentDecision: classifyProjectIntent({ message: testPrompt }), prompt: testPrompt, idempotencyKey: "deleted-build" })).rejects.toMatchObject({ code: "PROJECT_REMOVED", status: 404 });
      expect(executions).toBe(1);
      expect(await store.listProjects(auth, company.id)).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
  it.each(['I will inspect files. <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="project.files.read">app/page.tsx</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', "A very long implementation report. ".repeat(300)])("streams actual build stages and summarizes the result %#", async (modelResult) => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-progress-"));
    try {
      const store = new InMemoryWorkspaceStore(); await store.initialize();
      const auth: AuthContext = { workspaceId: "progress-ws", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage"] };
      const company = await store.createCompany(auth, { name: "Progress" }, "progress-company");
      const agent = await store.createCompanyAgent(auth, company.id, { name: "Builder", role: "frontend developer", tools: ["project.files.read", "project.files.write"], isActive: true }, "progress-builder");
      await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
      const projects = new ProjectService(store), workspace = new LocalProjectWorkspace(projects, { root });
      const runtime = { execute: async (_ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) => {
        const { run } = await store.createCompanyAgentRun(auth, companyId, { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(auth, companyId, run.id, { status: "completed", result: modelResult });
        return store.getCompanyAgentRun(auth, companyId, run.id);
      } };
      const preview = {
        buildProject: async (_ctx: AuthContext, _company: string, _project: string, onStage: (stage: "dependencies" | "build") => void) => { onStage("dependencies"); onStage("build"); },
        startPreview: async () => ({ previewUrl: "/preview" }), getPreviewStatus: async () => ({ previewUrl: "/preview" }),
      };
      const stages: Array<{ stage: string; status: string }> = [];
      const orchestrator = new ProjectOrchestrator(store, projects, workspace, undefined, preview as any, runtime as any);
      const result = await orchestrator.executeWebsiteTask(auth, { companyId: company.id, intentDecision: classifyProjectIntent({ message: testPrompt }), prompt: testPrompt, idempotencyKey: "progress-project", onProgress: event => stages.push(event) });
      expect(stages.map(event => event.stage)).toEqual(["project", "files", "agent", "dependencies", "build", "preview", "ready"]);
      expect(stages.at(-1)?.status).toBe("completed");
      expect(result.responseMessage).not.toMatch(/DSML|I will inspect|implementation report/);
      expect(result.responseMessage.length).toBeLessThan(220);
      expect(result.responseMessage).toContain(result.project.name);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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

describe("Clean Project Naming for Website Builder", () => {
  it("normalizes 'створи мені сайт, хостінг компанія' to 'Хостінг компанія'", () => {
    const prompt = "створи мені сайт, хостінг компанія";
    const decision = classifyProjectIntent({ message: prompt });
    expect(decision.intent).toBe("CREATE_WEBSITE");
    expect(decision.targetDetails?.entityName).toBe("Хостінг компанія");
    expect(extractCleanProjectName(prompt, decision.targetDetails?.entityName)).toBe("Хостінг компанія");
  });

  it("extracts clean name from multi-line Ukrainian prompt", () => {
    const prompt = "Створи сучасний сайт для хостинг-компанії.\nВикористай Next.js.\nСторінки: Home, Hosting, Domains, Pricing, Contact.";
    const name = extractCleanProjectName(prompt);
    expect(name).toBe("Хостинг-компанії");
  });

  it("extracts clean name from English create prompt", () => {
    const prompt = "Create a modern website for CloudScale Hosting with domain lookup";
    const name = extractCleanProjectName(prompt);
    expect(name).toBe("CloudScale Hosting with domain lookup");
  });
});

describe("Settings default model changes", () => {
  it("changes existing agent and pipeline routes without updating agent revisions", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const auth: AuthContext = {workspaceId:"default-model-ws",userId:"owner",permissions:["workspace:read","workspace:write","business:manage","tools:execute"]};
    let company = await store.createCompany(auth,{name:"Model switch"},"model-switch-company");
    const oldModel="ollama-cloud/gemma4:31b", newModel="openai/gpt-5.6-luna";
    const main=await store.createCompanyAgent(auth,company.id,{name:"Coordinator",role:"manager",modelId:oldModel,tools:[],isActive:true},"model-switch-main");
    const worker=await store.createCompanyAgent(auth,company.id,{name:"Website Builder",role:"frontend developer",modelId:oldModel,tools:[],isActive:true},"model-switch-worker");
    company=await store.setCompanyMainAgent(auth,company.id,main.id,company.revision);
    const preferences=new AIPreferencesStore(store);
    for (const id of [oldModel,newModel]) await preferences.add(auth,{id,name:id,providerId:id.split("/")[0],capabilities:["chat"],added:true} as AIModelSummary);
    await preferences.setDefault(auth,oldModel);
    const registry=new Map<string,any>();
    const executed: string[]=[];
    let expected=oldModel;
    const resolve=(name:string):string[]=>{
      const combo=registry.get(name);
      return combo ? combo.models.flatMap((model:any)=>typeof model === "string" ? [model] : resolve(model.comboName)) : [name];
    };
    const ai={
      ensureA2AEnabled:async()=>{},
      ensureCombo:async(input:any)=>{if(!registry.has(input.name))registry.set(input.name,structuredClone(input));return {name:input.name};},
      a2aSend:async(request:any)=>{expect(request.model).toBe(expected);return {taskId:"plan",content:JSON.stringify({mode:"single",agentIds:[worker.id],toolRequests:[]})};},
      chat:async(request:any)=>{executed.push(request.model);expect(resolve(request.model)).toEqual([expected]);return {content:"Completed"};},
    } as unknown as AIEngine;
    const runtime=new CompanyDelegationRuntime(store,ai,5000,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,
      async ctx=>{const prefs=await preferences.get(ctx);return prefs.addedModels.filter(model=>model.id===prefs.routing.defaultModelId);},true);
    const first=await runtime.execute(auth,company.id,{task:"Create a site",mode:"single",preferredAgentId:worker.id},"switch-first");
    expect(first.run.status).toBe("completed");
    expect(executed).toHaveLength(2);
    expected=newModel;
    await preferences.setDefault(auth,newModel);
    const second=await runtime.execute(auth,company.id,{task:"Create a site",mode:"single",preferredAgentId:worker.id},"switch-second");
    expect(second.run.status).toBe("completed");
    expect(second.steps.every(step=>step.modelId===newModel)).toBe(true);
    expect((await store.getCompanyAgent(auth,company.id,worker.id)).revision).toBe(worker.revision);
    expect(executed).toHaveLength(4);
    expect(executed.slice(2, 4)).not.toEqual(executed.slice(0, 2));
    const third=await runtime.execute(auth,company.id,{task:"Create a site",mode:"single",preferredAgentId:worker.id},"switch-third");
    expect(third.run.status).toBe("completed");
    expect(executed).toHaveLength(6);
    expect(executed.slice(4, 6)).toEqual(executed.slice(2, 4));
  });
  it("classifies empty provider responses as model failures", () => {
    expect(isModelError(new Error("NPATI AI chat failed with HTTP 502: [ollama-cloud/gemma4:31b] Provider returned empty content (reset after 3s)"))).toBe(true);
  });
});

describe("DeepSeek 401 uncredentialed provider failover", () => {
  it("automatically fails over from uncredentialed DeepSeek to 'auto' without throwing model_routing_failed", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const auth: AuthContext = { workspaceId: "deepseek-ws", userId: "deepseek-user", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
    const company = await store.createCompany(auth, { name: "DeepSeek Hosting" }, "deepseek-comp");
    const agent = await store.createCompanyAgent(auth, company.id, {
      name: "DeepSeek Developer",
      role: "frontend developer",
      modelId: "deepseek/deepseek-chat",
      tools: ["project.files.read", "project.files.write"],
      isActive: true,
    }, "deepseek-agent");
    await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);

    const a2aCalls: string[] = [];
    const mockAi: AIEngine = {
      ensureA2AEnabled: async () => undefined,
      ensureCombo: async () => ({ name: "test-combo" }),
      listModels: async () => [{ id: "deepseek/deepseek-chat", name: "DeepSeek Chat", modalities: { input: ["text"], output: ["text"] } }],
      a2aSend: async (req) => {
        a2aCalls.push(req.model ?? "unknown");
        if (req.model === "deepseek/deepseek-chat") {
          throw new Error('NPATI AI A2A message failed with HTTP 500: Skill execution failed: API [401]: {"error":{"message":"No active credentials for provider: deepseek.","type":"authentication_error","code":"invalid_api_key"}}');
        }
        return {
          taskId: "auto-plan-id",
          content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [] }),
          metadata: {},
        };
      },
      chat: async () => ({ content: "Successfully executed with auto fallback" }),
    } as unknown as AIEngine;

    const runtime = new CompanyDelegationRuntime(store, mockAi, 5000);
    const result = await runtime.execute(auth, company.id, {
      task: "створи мені сайт, хостінг компанія",
      mode: "single",
      preferredAgentId: agent.id,
    }, "deepseek-test-key");

    if (result.run.status !== "completed") console.log("DEEPSEEK RUN ERROR:", result.run.errorCode, result.run.errorMessage);
    expect(result.run.status).toBe("completed");
    expect(result.run.result).toBe("Successfully executed with auto fallback");
    expect(a2aCalls).toContain("deepseek/deepseek-chat");
    expect(a2aCalls).toContain("auto");
  });
});

