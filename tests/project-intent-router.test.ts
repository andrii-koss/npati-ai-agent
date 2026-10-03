import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyProjectIntent,
  HybridRouter,
} from "@npati/shared";
import {
  InMemoryWorkspaceStore,
  type AuthContext,
  type CompanyAgentRunDetails,
} from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { ProjectOrchestrator } from "../apps/agent-api/src/project-orchestrator";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";
import type { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import type { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const authUserA: AuthContext = {
  workspaceId: "ws-a",
  userId: "user-a",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

const authUserB: AuthContext = {
  workspaceId: "ws-b",
  userId: "user-b",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

describe("Step 5 - Project Intent Classification", () => {
  it("classifies pure questions as CHAT in Ukrainian and English", () => {
    const q1 = classifyProjectIntent({ prompt: "Що таке Next.js і як він працює?" });
    expect(q1.intent).toBe("CHAT");
    expect(q1.isProjectIntent).toBe(false);

    const q2 = classifyProjectIntent({ prompt: "What is React and why do we use components?" });
    expect(q2.intent).toBe("CHAT");
    expect(q2.isProjectIntent).toBe(false);

    const q3 = classifyProjectIntent({ prompt: "Поясни мені різницю між SSR та SSG" });
    expect(q3.intent).toBe("CHAT");
    expect(q3.isProjectIntent).toBe(false);
  });

  it("classifies website creation intents accurately", () => {
    const r1 = classifyProjectIntent({ prompt: "Створи мені сайт для кав'ярні на Next.js" });
    expect(r1.intent).toBe("CREATE_WEBSITE");
    expect(r1.isProjectIntent).toBe(true);
    expect(r1.executable).toBe(true);

    const r2 = classifyProjectIntent({ prompt: "Create a landing page for NovaScale Labs" });
    expect(["CREATE_WEBSITE", "CREATE_PROJECT"]).toContain(r2.intent);
    expect(r2.isProjectIntent).toBe(true);
    expect(r2.executable).toBe(true);
  });

  it("classifies edits differently depending on active project context", () => {
    // With active project -> immediately executable
    const withProj = classifyProjectIntent({
      prompt: "Зроби кнопку на головній більшою і синьою",
      activeProjectId: "proj-123",
      activeCompanyId: "comp-123",
    });
    expect(withProj.intent).toBe("EDIT_PROJECT");
    expect(withProj.isProjectIntent).toBe(true);
    expect(withProj.executable).toBe(true);
    expect(withProj.needsClarification).toBe(false);

    // Without active project -> recognized as edit intent, but flags clarification needed
    const withoutProj = classifyProjectIntent({
      prompt: "Зроби кнопку на головній більшою і синьою",
    });
    expect(withoutProj.intent).toBe("EDIT_PROJECT");
    expect(withoutProj.isProjectIntent).toBe(true);
    expect(withoutProj.needsClarification).toBe(true);
    expect(withoutProj.clarificationMessage).toContain("проєкт");
  });

  it("classifies preview, build, and test intents", () => {
    const p1 = classifyProjectIntent({ prompt: "Покажи прев'ю сайту", activeProjectId: "p1" });
    expect(p1.intent).toBe("PREVIEW_PROJECT");
    expect(p1.executable).toBe(true);

    const b1 = classifyProjectIntent({ prompt: "Запусти білд проєкту", activeProjectId: "p1" });
    expect(b1.intent).toBe("BUILD_PROJECT");
    expect(b1.executable).toBe(true);

    const t1 = classifyProjectIntent({ prompt: "Run project tests", activeProjectId: "p1" });
    expect(t1.intent).toBe("TEST_PROJECT");
    expect(t1.executable).toBe(true);
  });

  it("recognizes Git intents as executable and Deploy as future work", () => {
    const dep = classifyProjectIntent({ prompt: "Deploy website to production" });
    expect(dep.intent).toBe("DEPLOY_PROJECT");
    expect(dep.isProjectIntent).toBe(true);
    expect(dep.executable).toBe(false);
    expect(dep.clarificationMessage?.toLowerCase()).toContain("деплой");

    const git = classifyProjectIntent({ prompt: "Commit changes and push to git repo" });
    expect(["COMMIT_PROJECT", "CONNECT_REPOSITORY"]).toContain(git.intent);
    expect(git.isProjectIntent).toBe(true);
    expect(git.executable).toBe(true);
  });

  it("integrates seamlessly into HybridRouter classifyProject", async () => {
    const router = new HybridRouter();
    const decision = await router.classifyProject({
      prompt: "Створи мені сучасний сайт портфоліо",
      context: { companyId: "c1" },
    });
    expect(decision.intent).toBe("CREATE_WEBSITE");
    expect(decision.executable).toBe(true);
  });
});

describe("Step 5 - Active Project Context & Tenant Isolation", () => {
  let store: InMemoryWorkspaceStore;
  let projectService: ProjectService;
  let workspaceRoot: string;
  let resolver: ActiveContextResolver;

  beforeEach(async () => {
    store = new InMemoryWorkspaceStore();
    await store.initialize();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "npati-step5-test-"));
    roots.push(workspaceRoot);
    projectService = new ProjectService(store);
    resolver = new ActiveContextResolver(store);
  });

  it("resolves active project context when project belongs to company and user workspace", async () => {
    const compA = await store.createCompany(authUserA, {
      name: "Alpha Corp",
    }, "comp-alpha-key");

    const { project } = await projectService.create(
      authUserA,
      compA.id,
      { name: "Alpha Web", type: "website" },
      "alpha-web-key"
    );

    const resolved = await resolver.resolve(authUserA, {
      contextType: "project",
      companyId: compA.id,
      projectId: project.id,
    });

    expect(resolved.context.contextType).toBe("project");
    expect(resolved.context.projectId).toBe(project.id);
    expect(resolved.project?.id).toBe(project.id);
    expect(resolved.project?.name).toBe("Alpha Web");
  });

  it("rejects project context when project belongs to another company or workspace (tenant isolation)", async () => {
    const compA = await store.createCompany(authUserA, {
      name: "Alpha Corp",
    }, "comp-a-key");

    const compB = await store.createCompany(authUserB, {
      name: "Beta Corp",
    }, "comp-b-key");

    const { project: projectB } = await projectService.create(
      authUserB,
      compB.id,
      { name: "Beta Web", type: "website" },
      "beta-web-key"
    );

    // User A trying to access Project B
    await expect(
      resolver.resolve(authUserA, {
        contextType: "project",
        companyId: compA.id,
        projectId: projectB.id,
      })
    ).rejects.toThrow(/not found|does not belong/i);
  });

  it("rejects archived projects from active context", async () => {
    const comp = await store.createCompany(authUserA, {
      name: "Alpha Corp",
    }, "comp-arch-key");

    const { project } = await projectService.create(
      authUserA,
      comp.id,
      { name: "Archived Web", type: "website" },
      "arch-web-key"
    );

    await projectService.archive(authUserA, comp.id, project.id, project.revision);

    await expect(
      resolver.resolve(authUserA, {
        contextType: "project",
        companyId: comp.id,
        projectId: project.id,
      })
    ).rejects.toThrow(/archived/i);
  });
});

describe("Step 5 - Project Orchestrator: Agent Selection, Targeted Edits & Repair Loop", () => {
  let store: InMemoryWorkspaceStore;
  let workspaceRoot: string;
  let projectWorkspace: LocalProjectWorkspace;
  let projectService: ProjectService;
  let orchestrator: ProjectOrchestrator;
  let gitPreviewService: ProjectPreviewService;
  let gitCompanyRuntime: CompanyDelegationRuntime;

  let mockPreviewStartError: string | null = null;
  let previewAttempts = 0;

  beforeEach(async () => {
    store = new InMemoryWorkspaceStore();
    await store.initialize();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "npati-step5-orch-"));
    roots.push(workspaceRoot);
    projectService = new ProjectService(store);
    projectWorkspace = new LocalProjectWorkspace(projectService, { root: workspaceRoot });

    mockPreviewStartError = null;
    previewAttempts = 0;

    // Mock Preview Service
    const mockPreviewService = {
      async startPreview(_ctx: AuthContext, _companyId: string, _projectId: string) {
        previewAttempts++;
        if (mockPreviewStartError) {
          throw new Error(mockPreviewStartError);
        }
        return {
          status: "running",
          previewUrl: "/api/preview-mock/url",
          token: "mock-token",
          port: 3000,
          framework: "Vite",
          command: "npm run dev",
        };
      },
      async getPreviewStatus(_ctx: AuthContext, _companyId: string, _projectId: string) {
        return {
          status: "previewing",
          previewUrl: "/api/preview-mock/url",
          port: 3000,
          framework: "Vite",
        };
      },
    } as unknown as ProjectPreviewService;

    // Mock Company Runtime
    const mockCompanyRuntime = {
      async execute(
        ctx: AuthContext,
        companyId: string,
        params: { task: string; mode: string; preferredAgentId?: string; projectId?: string },
        idempotencyKey: string
      ): Promise<CompanyAgentRunDetails> {
        const { run } = await store.createCompanyAgentRun(
          ctx,
          companyId,
          {
            task: params.task,
            requestedMode: "single",
            projectId: params.projectId,
          },
          idempotencyKey
        );

        await store.updateCompanyAgentRun(ctx, companyId, run.id, {
          status: "completed",
          selectedAgentIds: params.preferredAgentId ? [params.preferredAgentId] : [],
          result: "Task completed successfully by specialist agent.",
        });

        return store.getCompanyAgentRun(ctx, companyId, run.id);
      },
    } as unknown as CompanyDelegationRuntime;

    gitPreviewService = mockPreviewService;
    gitCompanyRuntime = mockCompanyRuntime;
    orchestrator = new ProjectOrchestrator(
      store,
      projectService,
      projectWorkspace,
      undefined,
      mockPreviewService,
      mockCompanyRuntime
    );
  });

  it("connects a repository and records a project commit in Activity", async () => {
    let company = await store.createCompany(authUserA, { name: "Git Company" }, "git-company-key");
    const agent = await store.createCompanyAgent(authUserA, company.id, {
      name: "Project Developer", role: "developer",
      tools: ["project.files.read", "project.files.write", "project.git.commit"],
      isActive: true,
    }, "git-agent-key");
    company = await store.setCompanyMainAgent(authUserA, company.id, agent.id, company.revision);
    const { project } = await projectService.create(authUserA, company.id, { name: "Git Website", type: "website" }, "git-project-key");
    const git = new ProjectGitService(store, projectService, workspaceRoot);
    await git.ensureRepository(authUserA, company.id, project.id);
    const gitOrchestrator = new ProjectOrchestrator(store, projectService, projectWorkspace, undefined, gitPreviewService, gitCompanyRuntime, git);

    const connected = await gitOrchestrator.executeWebsiteTask(authUserA, {
      companyId: company.id, projectId: project.id,
      prompt: "Connect repository https://github.com/example/site.",
      intentDecision: classifyProjectIntent({ prompt: "Connect repository https://github.com/example/site.", activeProjectId: project.id }),
    });
    expect(connected.project.repositoryUrl).toBe("https://github.com/example/site.git");
    expect(connected.runDetails.run.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(connected.project.status).toBe("ready");

    await writeFile(path.join(workspaceRoot, company.id, project.id, "index.html"), "<h1>Git Website</h1>");
    const committed = await gitOrchestrator.executeWebsiteTask(authUserA, {
      companyId: company.id, projectId: project.id,
      prompt: "Commit changes",
      intentDecision: classifyProjectIntent({ prompt: "Commit changes", activeProjectId: project.id }),
    });
    expect(committed.runDetails.run.status).toBe("completed");
    expect((await store.listProjectRuns(authUserA, company.id, project.id)).some((run) => run.id === committed.runDetails.run.id)).toBe(true);
    expect((await git.log(authUserA, company.id, project.id))[0]?.message).toBe("Project update");
  });
  it("selects agent by role and capabilities, NOT by agent.name", async () => {
    const comp = await store.createCompany(authUserA, { name: "Agent Test Co" }, "ag-co-key");

    // Agent 1: Named "Senior Web Developer" but with NO tools and role = "sales"
    await store.createCompanyAgent(authUserA, comp.id, {
      name: "Senior Web Developer",
      role: "sales",
      tools: ["chat.respond"],
      isActive: true,
    }, "ag1-key");

    // Agent 2: Named "Custom Bot 42" but with frontend role and project capabilities
    const specialistAgent = await store.createCompanyAgent(authUserA, comp.id, {
      name: "Custom Bot 42",
      role: "engineer",
      description: "Frontend developer specialist in React and Vite",
      systemInstruction: "Build fast and accessible UI components",
      tools: ["project.files.list", "project.files.search", "project.files.read", "project.files.create", "project.files.write", "project.files.edit", "project.terminal.exec"],
      isActive: true,
    }, "ag2-key");

    const selected = await orchestrator.selectProjectAgent(authUserA, comp.id);
    expect(selected).toBeDefined();
    expect(selected?.id).toBe(specialistAgent.id);
    expect(selected?.name).toBe("Custom Bot 42");
    expect(selected?.role).toBe("engineer");
  });

  it("creates a website builder for a default company and never assigns file tools to the coordinator", async () => {
    let company = await store.createCompany(authUserA, { name: "Hosting Co" }, "hosting-company");
    const coordinator = await store.createCompanyAgent(authUserA, company.id, {
      name: "Coordinator", role: "manager", tools: ["web.search"], isActive: true,
    }, "hosting-coordinator");
    company = await store.setCompanyMainAgent(authUserA, company.id, coordinator.id, company.revision);
    const partial = await store.createCompanyAgent(authUserA, company.id, {
      name: "Partial Developer", role: "frontend developer",
      tools: ["project.files.read", "project.files.write"], isActive: true,
    }, "partial-developer");
    expect(await orchestrator.selectProjectAgent(authUserA, company.id)).toBeUndefined();

    const intentDecision = classifyProjectIntent({ message: "створи мені сайт хостінг компанія" });
    const first = await orchestrator.executeWebsiteTask(authUserA, {
      companyId: company.id, prompt: "створи мені сайт хостінг компанія",
      intentDecision, idempotencyKey: "hosting-website",
    });
    const builder = (await store.listCompanyAgents(authUserA, company.id))
      .find((agent) => agent.name === "Website Builder");
    expect(builder).toBeDefined();
    expect(first.runDetails.run.selectedAgentIds).toContain(builder!.id);
    expect(first.runDetails.run.selectedAgentIds).not.toContain(coordinator.id);
    expect(first.runDetails.run.selectedAgentIds).not.toContain(partial.id);
    expect(first.projectCard.buildStatus).toBe("success");
    expect((await store.getCompanyAgent(authUserA, company.id, coordinator.id)).tools).toEqual(coordinator.tools);

    await orchestrator.executeWebsiteTask(authUserA, {
      companyId: company.id, projectId: first.project.id, prompt: "Update the home page",
      intentDecision: classifyProjectIntent({ message: "Update the home page", activeProjectId: first.project.id }),
      idempotencyKey: "hosting-website-edit",
    });
    expect((await store.listCompanyAgents(authUserA, company.id))
      .filter((agent) => agent.name === "Website Builder")).toHaveLength(1);
  });
  it("builds the prepared Next.js website when delegation JSON remains malformed", async () => {
    let company = await store.createCompany(authUserA, { name: "Hosting Recovery Co" }, "hosting-recovery-company");
    const coordinator = await store.createCompanyAgent(authUserA, company.id, {
      name: "Coordinator", role: "manager", tools: [], isActive: true,
    }, "hosting-recovery-coordinator");
    company = await store.setCompanyMainAgent(authUserA, company.id, coordinator.id, company.revision);
    const failedRuntime = {
      async execute(ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) {
        const { run } = await store.createCompanyAgentRun(ctx, companyId,
          { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(ctx, companyId, run.id, {
          status: "failed", errorCode: "INVALID_DELEGATION_PLAN",
          errorMessage: "Main Agent returned malformed delegation JSON",
        });
        return store.getCompanyAgentRun(ctx, companyId, run.id);
      },
    } as unknown as CompanyDelegationRuntime;
    const recovering = new ProjectOrchestrator(
      store, projectService, projectWorkspace, undefined, gitPreviewService, failedRuntime);
    const result = await recovering.executeWebsiteTask(authUserA, {
      companyId: company.id, prompt: "Створи мені сайт для хостінга",
      intentDecision: classifyProjectIntent({ message: "Створи мені сайт для хостінга" }),
      idempotencyKey: "hosting-recovery-website",
    });
    expect(result.runDetails.run.status).toBe("completed");
    expect(result.projectCard.buildStatus).toBe("success");
    expect(result.previewUrl).toBe("/api/preview-mock/url");
    expect(result.responseMessage).toContain("стартовий сайт");
    expect(result.responseMessage).toContain("AI-персоналізацію не завершено");
    const website = JSON.parse((await projectWorkspace.readFile(authUserA, company.id, result.project.id, "website.config.json")).content);
    expect(website.pages.map((page: { slug: string }) => page.slug)).toContain("/hosting");
    expect(JSON.stringify(website.pages[0].blocks)).not.toContain("Створи мені сайт");
    const originalRuns = await store.listProjectRuns(authUserA, company.id, result.project.id);
    expect(originalRuns.some((run) => run.errorCode === "INVALID_DELEGATION_PLAN")).toBe(true);
  });
  it("reports an agent permission failure without marking an unattempted build as failed", async () => {
    let company = await store.createCompany(authUserA, { name: "Permission Co" }, "permission-company");
    const coordinator = await store.createCompanyAgent(authUserA, company.id, {
      name: "Coordinator", role: "manager", tools: ["web.search"], isActive: true,
    }, "permission-coordinator");
    company = await store.setCompanyMainAgent(authUserA, company.id, coordinator.id, company.revision);
    const failedRuntime = {
      async execute(ctx: AuthContext, companyId: string, input: { task: string; projectId: string }, key: string) {
        const { run } = await store.createCompanyAgentRun(ctx, companyId,
          { task: input.task, requestedMode: "single", projectId: input.projectId }, key);
        await store.updateCompanyAgentRun(ctx, companyId, run.id, {
          status: "failed", errorCode: "TOOL_FORBIDDEN",
          errorMessage: 'Agent "Coordinator" may not use project.files.list',
        });
        return store.getCompanyAgentRun(ctx, companyId, run.id);
      },
    } as unknown as CompanyDelegationRuntime;
    const failedOrchestrator = new ProjectOrchestrator(
      store, projectService, projectWorkspace, undefined, gitPreviewService, failedRuntime);
    const result = await failedOrchestrator.executeWebsiteTask(authUserA, {
      companyId: company.id, prompt: "Create a hosting website",
      intentDecision: classifyProjectIntent({ message: "Create a hosting website" }),
      idempotencyKey: "permission-website",
    });
    expect(result.responseMessage).toContain("Project agent failed");
    expect(result.responseMessage).not.toContain("Build or preview failed");
    expect(result.projectCard.buildStatus).toBeNull();
    expect(result.errorDetails?.step).toBe("agent_execution");
  });
  it("creates and updates shared project context (PROJECT.md) with targeted edit rule", async () => {
    const comp = await store.createCompany(authUserA, { name: "Context Co" }, "ctx-co-key");
    const { project } = await projectService.create(authUserA, comp.id, { name: "Targeted Site", type: "website" }, "tgt-proj-key");

    const content = await orchestrator.initSharedProjectContext(authUserA, comp.id, project.id, {
      name: project.name,
      framework: "Vite + React",
      purpose: "Modern high performance website",
    });

    expect(content).toContain("# Targeted Site");
    expect(content).toContain("Targeted Edits Rule");
    expect(content).toContain("search and inspect relevant files before modifying");
    expect(content).toContain("No Blind Rewrites");

    const readBack = await orchestrator.getSharedProjectContext(authUserA, comp.id, project.id);
    expect(readBack).toBe(content);
  });

  it("executes website task and links run to Activity with project_id", async () => {
    let comp = await store.createCompany(authUserA, { name: "Portal Co" }, "port-co-key");
    const agent = await store.createCompanyAgent(authUserA, comp.id, {
      name: "Web Engineer",
      role: "engineer",
      description: "Frontend developer",
      tools: ["project.files.read", "project.files.write", "project.terminal.exec"],
      isActive: true,
    }, "web-eng-key");

    comp = await store.setCompanyMainAgent(authUserA, comp.id, agent.id, comp.revision);

    const result = await orchestrator.executeWebsiteTask(authUserA, {
      companyId: comp.id,
      prompt: "Create a modern landing page for NovaScale Labs",
      intentDecision: {
        intent: "CREATE_WEBSITE",
        confidence: 0.95,
        isExecutableInStep5: true,
        executable: true,
        isProjectIntent: true,
        needsClarification: false,
        targetDetails: { entityName: "NovaScale Labs", framework: "Vite" },
      },
    });

    expect(result.project).toBeDefined();
    expect(result.project.name).toBe("NovaScale Labs");
    expect(result.projectCard).toBeDefined();
    expect(result.projectCard.projectId).toBe(result.project.id);
    expect(result.projectCard.buildStatus).toBe("success");
    expect(result.previewUrl).toBe("/api/preview-mock/url");

    // Verify run in store has project_id
    const projectRuns = await store.listProjectRuns(authUserA, comp.id, result.project.id);
    expect(projectRuns.length).toBe(1);
    expect(projectRuns[0].projectId).toBe(result.project.id);
    expect(projectRuns[0].status).toBe("completed");
  });

  it("repair loop stops after 3 attempts when build keeps failing", async () => {
    let comp = await store.createCompany(authUserA, { name: "Fail Co" }, "fail-co-key");
    const agent = await store.createCompanyAgent(authUserA, comp.id, {
      name: "Dev Bot",
      role: "developer",
      tools: ["project.files.read", "project.files.write", "project.terminal.exec"],
      isActive: true,
    }, "dev-bot-key");

    comp = await store.setCompanyMainAgent(authUserA, comp.id, agent.id, comp.revision);

    const { project } = await projectService.create(authUserA, comp.id, { name: "Broken Site", type: "website" }, "brk-key");

    // Mock build failure
    mockPreviewStartError = "SyntaxError: Unexpected token in src/App.tsx:12:4";

    const result = await orchestrator.executeWebsiteTask(authUserA, {
      companyId: comp.id,
      projectId: project.id,
      prompt: "Fix the layout issue",
      intentDecision: {
        intent: "EDIT_PROJECT",
        confidence: 0.9,
        isExecutableInStep5: true,
        executable: true,
        isProjectIntent: true,
        needsClarification: false,
      },
    });

    expect(result.repairAttempts).toBe(3);
    expect(result.projectCard.buildStatus).toBe("failed");
    expect(result.errorDetails?.step).toBe("build_repair");
    expect(result.errorDetails?.retryable).toBe(false);

    // Verify run record has failed status
    const runs = await store.listProjectRuns(authUserA, comp.id, project.id);
    expect(runs.length).toBeGreaterThan(0);
    const failedRun = runs.find((run) => run.status === "failed");
    expect(failedRun).toBeDefined();
    expect(failedRun?.errorMessage).toContain("Build repair limit exceeded after 3 attempts");
  });

  it("repair loop recovers if build succeeds on second attempt", async () => {
    let comp = await store.createCompany(authUserA, { name: "Recover Co" }, "rec-co-key");
    const agent = await store.createCompanyAgent(authUserA, comp.id, {
      name: "Healing Dev",
      role: "developer",
      tools: ["project.files.read", "project.files.write", "project.terminal.exec"],
      isActive: true,
    }, "rec-bot-key");

    comp = await store.setCompanyMainAgent(authUserA, comp.id, agent.id, comp.revision);

    const { project } = await projectService.create(authUserA, comp.id, { name: "Recoverable Site", type: "website" }, "rec-proj-key");

    // Fail attempt 1, succeed on attempt 2
    let attemptCounter = 0;
    const mockRecoveringPreview = {
      async startPreview(_ctx: AuthContext, _companyId: string, _projectId: string) {
        attemptCounter++;
        if (attemptCounter === 1) {
          throw new Error("Temporary bundling error in index.html");
        }
        return {
          status: "running",
          previewUrl: "/api/preview-mock/url",
          token: "mock-token",
          port: 3000,
          framework: "Vite",
          command: "npm run dev",
        };
      },
      async getPreviewStatus(_ctx: AuthContext, _companyId: string, _projectId: string) {
        return {
          status: "previewing",
          previewUrl: "/api/preview-mock/url",
          port: 3000,
          framework: "Vite",
        };
      },
    } as unknown as ProjectPreviewService;

    const mockCompanyRuntime = {
      async execute(
        ctx: AuthContext,
        companyId: string,
        params: { task: string; mode: string; preferredAgentId?: string; projectId?: string },
        idempotencyKey: string
      ): Promise<CompanyAgentRunDetails> {
        const { run } = await store.createCompanyAgentRun(
          ctx,
          companyId,
          {
            task: params.task,
            requestedMode: "single",
            projectId: params.projectId,
          },
          idempotencyKey
        );

        await store.updateCompanyAgentRun(ctx, companyId, run.id, {
          status: "completed",
          selectedAgentIds: params.preferredAgentId ? [params.preferredAgentId] : [],
          result: "Fixed bundler configuration",
        });

        return store.getCompanyAgentRun(ctx, companyId, run.id);
      },
    } as unknown as CompanyDelegationRuntime;

    const recoveringOrchestrator = new ProjectOrchestrator(
      store,
      projectService,
      projectWorkspace,
      undefined,
      mockRecoveringPreview,
      mockCompanyRuntime
    );

    const result = await recoveringOrchestrator.executeWebsiteTask(authUserA, {
      companyId: comp.id,
      projectId: project.id,
      prompt: "Add dark mode toggle",
      intentDecision: {
        intent: "EDIT_PROJECT",
        confidence: 0.9,
        isExecutableInStep5: true,
        executable: true,
        isProjectIntent: true,
        needsClarification: false,
      },
    });

    expect(result.repairAttempts).toBe(2);
    expect(result.projectCard.buildStatus).toBe("success");
    expect(result.previewUrl).toBe("/api/preview-mock/url");
  });
});
