import type { ProjectGitService } from "./project-git-service";
import type { ProjectDeployService } from "./project-deploy-service";
import type { ProjectBrowserQaService } from "./project-browser-qa-service";
import { ProjectMultiAgentService, type ProjectMultiAgentOptions } from "./project-multi-agent";
import type { ProjectFileLeaseManager } from "./project-file-lock";
import { WEBSITE_FILE_TOOLS } from "./project-agent-capabilities";
import { DataStudioError } from "./data-studio/identifier";
import type { AuthContext, CompanyAgent, CompanyAgentRunDetails, Project, WorkspaceStore } from "@npati/workspace";
import { WorkspaceNotFoundError } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import { PreviewError, type ProjectPreviewService } from "./project-preview-service";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { DataBackendService } from "./data-studio/service";
import type { ProjectRedirectRepository } from "./data-studio/redirect-repository";
import {
  type ProjectCardData, type ProjectProgressEvent, type ProjectActionData, type ProjectIntentDecision, extractFramework,
  canonicalFrameworkName,
  defaultAppScheme,
} from "@npati/shared";
import {
  extractCleanProjectName,
  isModelError,
  ProjectOrchestrationError,
} from "./project-orchestrator-types";
import {
  ensureDataAgent,
  ensureMobileAppAgent,
  ensureWebsiteAgent,
  getSharedProjectContext,
  initSharedProjectContext,
  recordScaffoldFallback,
  registerMobileRedirects,
  resolveMobileDataBackend,
  scaffoldMobileAppProject,
  scaffoldWebsiteProject,
  selectProjectAgent,
} from "./project-orchestrator-scaffold";

export * from "./project-orchestrator-types";

export class ProjectOrchestrator {
  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly projectService: ProjectService,
    private readonly projectWorkspace: ProjectWorkspace,
    private readonly sandboxService: ProjectSandboxService | undefined,
    private readonly previewService: ProjectPreviewService,
    private readonly companyRuntime: CompanyDelegationRuntime,
    private readonly gitService?: ProjectGitService,
    private readonly deployService?: ProjectDeployService,
    private readonly qaService?: ProjectBrowserQaService,
    private readonly dataBackends?: DataBackendService,
    private readonly authRedirects?: ProjectRedirectRepository,
    /**
     * C12: **the** deployment's lease manager. `CompanyToolRuntime` holds the same instance, so a path locked by
     * the project task graph and the same path locked by a pair of Company file tools are the same lock. Without
     * this parameter the multi-agent service silently created its own manager, which is how "two ways of locking
     * one file" would have started: each side would have reported a successful acquisition of the same path.
     */
    private readonly leaseManager?: ProjectFileLeaseManager,
    /**
     * C12: the post-merge verification port. It is the **same** `CodeVerifyRunnerPort` `code.verify.run` uses, so
     * the mandatory final check runs the project's configured commands and cannot invent one. Absent means the
     * multi-agent service reports the final verification as `unavailable` rather than as a pass.
     */
    private readonly codeVerification?: ProjectMultiAgentOptions["verification"],
    private readonly prepareWebsiteData?: (ctx: AuthContext, project: Project, prompt: string) => Promise<void>,
  ) {}

  /**
   * Selects an agent for project development tasks based on capabilities, role, and instructions.
   * NEVER checks agent.name. Only agents with the website file tools are eligible.
   */
  async selectProjectAgent(ctx: AuthContext, companyId: string, requiredCapabilities: string[] = [...WEBSITE_FILE_TOOLS]): Promise<CompanyAgent | undefined> {
    return selectProjectAgent(this.workspaceStore, ctx, companyId, requiredCapabilities);
  }

  private async ensureWebsiteAgent(ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
    return ensureWebsiteAgent(this.workspaceStore, ctx, companyId);
  }

  private async ensureDataAgent(ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
    return ensureDataAgent(this.workspaceStore, ctx, companyId);
  }

  /** Mobile projects (D6) get an Expo-focused agent with the same file and preview tools. */
  private async ensureMobileAppAgent(ctx: AuthContext, companyId: string): Promise<CompanyAgent> {
    return ensureMobileAppAgent(this.workspaceStore, ctx, companyId);
  }

  /**
   * Resolves the DataBackend a mobile project must share with the website (D6).
   * Never copies a database: one backend, several projects.
   */
  private async resolveMobileDataBackend(
    ctx: AuthContext,
    companyId: string,
    requested: { dataBackendId?: string; prompt?: string },
  ): Promise<{ backendId?: string; choices?: Array<{ id: string; name: string }> }> {
    return resolveMobileDataBackend(this.dataBackends, ctx, companyId, requested);
  }

  /** Registers the app deep link so verification and reset links can return to the app (D6). */
  private async registerMobileRedirects(ctx: AuthContext, companyId: string, projectId: string, scheme: string): Promise<void> {
    return registerMobileRedirects(this.authRedirects, ctx, companyId, projectId, scheme);
  }

  private async scaffoldMobileAppProject(ctx: AuthContext, companyId: string, projectId: string, projectName: string, scheme: string): Promise<void> {
    return scaffoldMobileAppProject(this.projectWorkspace, ctx, companyId, projectId, projectName, scheme);
  }

  /**
   * Initializes or updates the shared PROJECT.md context in the workspace root.
   */
  async initSharedProjectContext(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    details: { name: string; description?: string; framework?: string; purpose?: string; projectType?: "website" | "mobile_app" | "code_project" }
  ): Promise<string> {
    return initSharedProjectContext(this.projectWorkspace, ctx, companyId, projectId, details);
  }

  async prepareCodingMobile(ctx: AuthContext, project: Project, prompt: string): Promise<Project> {
    const scheme = project.appScheme ?? defaultAppScheme(project.name);
    await this.scaffoldMobileAppProject(ctx, project.companyId, project.id, project.name, scheme);
    await this.registerMobileRedirects(ctx, project.companyId, project.id, scheme);
    await this.projectService.updatePreview(ctx, project.companyId, project.id, { framework: "Expo", runtime: "expo" });
    await this.initSharedProjectContext(ctx, project.companyId, project.id, { name: project.name, description: prompt, framework: "Expo", projectType: "mobile_app" });
    return this.projectService.get(ctx, project.companyId, project.id);
  }

  async prepareCodingWebsite(ctx: AuthContext, project: Project, prompt: string, framework: string): Promise<Project> {
    const canonical = canonicalFrameworkName(framework) ?? framework;
    await this.scaffoldWebsiteProject(ctx, project.companyId, project.id, project.name, canonical, prompt);
    await this.projectService.updatePreview(ctx, project.companyId, project.id, { framework: canonical });
    if (canonical !== "HTML/CSS") await this.initSharedProjectContext(ctx, project.companyId, project.id, { name: project.name, description: prompt, framework: canonical, projectType: "code_project" });
    return this.projectService.get(ctx, project.companyId, project.id);
  }

  private async scaffoldWebsiteProject(ctx: AuthContext, companyId: string, projectId: string, projectName: string, framework: string, prompt?: string): Promise<void> {
    return scaffoldWebsiteProject(this.projectWorkspace, ctx, companyId, projectId, projectName, framework, prompt);
  }

  /**
   * Retrieves the shared PROJECT.md if present.
   */
  async getSharedProjectContext(ctx: AuthContext, companyId: string, projectId: string): Promise<string | undefined> {
    return getSharedProjectContext(this.projectWorkspace, ctx, companyId, projectId);
  }

  private async recordScaffoldFallback(
    ctx: AuthContext, companyId: string, project: Project, idempotencyKey: string,
  ): Promise<CompanyAgentRunDetails> {
    // Static sites are no longer template-scaffolded, so the fallback writes the minimal starter page it announces.
    if (project.framework === "HTML/CSS") {
      const exists = await this.projectWorkspace.readFile(ctx, companyId, project.id, "index.html").then(() => true, () => false);
      const name = project.name.replace(/[<>&"]/g, "");
      if (!exists) await this.projectWorkspace.createFile(ctx, companyId, project.id, "index.html",
        `<!doctype html>\n<html lang="uk">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title></head>\n<body>\n<main><h1>${name}</h1></main>\n</body>\n</html>\n`);
    }
    return recordScaffoldFallback(this.workspaceStore, ctx, companyId, project, idempotencyKey);
  }

  /**
   * Main Project Manager orchestration loop:
   * Resolve Project -> Select Agent -> Inspect -> Modify -> Build (with max 3 repair attempts) -> Preview -> Result.
   */
  async executeWebsiteTask(
    ctx: AuthContext,
    params: {
      companyId: string;
      projectId?: string;
      intentDecision: ProjectIntentDecision;
      prompt: string;
      idempotencyKey?: string;
      onProgress?: (event: ProjectProgressEvent) => void;
    }
  ): Promise<{
    project: Project;
    runDetails: CompanyAgentRunDetails;
    responseMessage: string;
    projectCard: ProjectCardData;
    projectAction: ProjectActionData;
    previewUrl?: string;
    repairAttempts?: number;
    errorDetails?: {
      step: string;
      agentId?: string;
      tool?: string;
      retryable: boolean;
    };
  }> {
    const isRepositoryAction = params.intentDecision.intent === "COMMIT_PROJECT" || params.intentDecision.intent === "CONNECT_REPOSITORY";
    const ukrainian = /[\u0400-\u04ff]/u.test(params.prompt);
    const labels = ukrainian
      ? { project: "Підготовка проєкту", files: "Створення файлів", database: "Підготовка бази даних і авторизації", agent: "Агент аналізує та редагує файли", dependencies: "Встановлення залежностей", build: "Перевірка production build", preview: "Запуск і перевірка Live Preview", ready: "Проєкт готовий" }
      : { project: "Preparing project", files: "Creating project files", database: "Preparing database and authentication", agent: "Agent inspecting and editing files", dependencies: "Installing dependencies", build: "Checking production build", preview: "Starting and checking Live Preview", ready: "Project ready" };
    const report = (stage: ProjectProgressEvent["stage"], status: ProjectProgressEvent["status"] = "active", framework?: string) =>
      params.onProgress?.({ type: "project_progress", stage, status, title: labels[stage], framework });
    report("project");
    const isMobileApp = params.intentDecision.targetDetails?.projectType === "mobile_app";
    const isDataTask = params.intentDecision.intent === "ADD_DATA_MODEL" || params.intentDecision.intent === "EDIT_DATA_MODEL";
    const selectedAgent = isDataTask ? await this.ensureDataAgent(ctx, params.companyId) : isRepositoryAction
      ? await this.selectProjectAgent(ctx, params.companyId, [])
        ?? await this.workspaceStore.getCompanyAgent(ctx, params.companyId, (await this.workspaceStore.getCompany(ctx, params.companyId)).mainAgentId!)
      : isMobileApp
        ? await this.ensureMobileAppAgent(ctx, params.companyId)
        : await this.ensureWebsiteAgent(ctx, params.companyId);
    // A Company created from neutral chat may have no Main Agent yet. The
    // qualified builder must be assigned before the runtime creates its run.
    const taskCompany = await this.workspaceStore.getCompany(ctx, params.companyId);
    if (!taskCompany.mainAgentId) {
      await this.workspaceStore.setCompanyMainAgent(ctx, params.companyId, selectedAgent.id, taskCompany.revision);
    } else {
      const mainAgent = await this.workspaceStore.getCompanyAgent(ctx, params.companyId, taskCompany.mainAgentId);
      if (!mainAgent.isActive) throw new ProjectOrchestrationError("MAIN_AGENT_INACTIVE", "Activate the company's Main Agent before running this project.", 409);
    }
    // 1. Resolve or Create Project
    let project: Project;
    let isCreate = false;

    if (params.projectId) {
      project = await this.projectService.get(ctx, params.companyId, params.projectId);
      if (project.companyId !== params.companyId) {
        throw new ProjectOrchestrationError("PROJECT_COMPANY_MISMATCH", `Project ${params.projectId} does not belong to company ${params.companyId}`, 403);
      }
      if (project.status === "archived") {
        throw new ProjectOrchestrationError("PROJECT_ARCHIVED", `Project ${params.projectId} is archived`, 400);
      }
    } else {
      isCreate = true;
      const name = extractCleanProjectName(
        params.prompt,
        params.intentDecision.targetDetails?.entityName,
      );
      const projectType = isMobileApp ? "mobile_app" : "website";
      if (!params.intentDecision.targetDetails?.framework && !extractFramework(params.prompt) && /магазин|store|shop|crm|saas|api/iu.test(params.prompt)) throw new ProjectOrchestrationError("TECHNOLOGY_SELECTION_REQUIRED", "Choose a supported technology through the AI planner or specify it explicitly before creating this application.", 409);
      let framework = canonicalFrameworkName(params.intentDecision.targetDetails?.framework)
        || extractFramework(params.prompt)
        || "HTML/CSS";
      let dataBackendId: string | undefined;
      if (isMobileApp) {
        const selection = await this.resolveMobileDataBackend(ctx, params.companyId, {
          dataBackendId: params.intentDecision.targetDetails?.dataBackendId,
          prompt: params.prompt,
        });
        if (selection.choices?.length) {
          throw new ProjectOrchestrationError(
            "DATA_BACKEND_CHOICE_REQUIRED",
            `This Company has several DataBackends — tell me which one the mobile app should share (the app never gets its own copy of the database): ${selection.choices.map((choice) => choice.name).join(", ")}.`,
            400,
          );
        }
        dataBackendId = selection.backendId;
        framework = "Expo";
      }

      const { project: created } = await this.projectService.create(ctx, params.companyId, {
        name,
        description: params.prompt,
        type: projectType,
        kind: params.intentDecision.targetDetails?.projectKind,
        dataBackendId,
      }, params.idempotencyKey || `create-proj-${Date.now()}`);
      project = await this.projectService.updatePreview(ctx, params.companyId, created.id, {
        framework,
        ...(isMobileApp ? { runtime: "expo" } : {}),
      });

      if (isMobileApp) {
        const scheme = project.appScheme || defaultAppScheme(project.name);
        report("files", "active", framework);
        await this.scaffoldMobileAppProject(ctx, params.companyId, project.id, project.name, scheme);
        await this.registerMobileRedirects(ctx, params.companyId, project.id, scheme);
      } else if (framework !== "Expo") {
        report("files", "active", framework);
        await this.scaffoldWebsiteProject(ctx, params.companyId, project.id, project.name, framework, params.prompt);
      }

      // Initialize PROJECT.md
      if (framework !== "HTML/CSS") await this.initSharedProjectContext(ctx, params.companyId, project.id, {
        name: project.name,
        framework,
        purpose: params.prompt,
        projectType,
      });
    }

    // 2. Prepare Prompt with Targeted Edits Rule & Shared Context

    const sharedContext = await this.getSharedProjectContext(ctx, params.companyId, project.id);
    const guidelinesHeader = [
      `[PROJECT MANDATE: "${project.name}"]`,
      `Targeted Edits Rule: You are modifying project "${project.name}" (ID: ${project.id}).`,
      isCreate ? "1. This is a new project. Implement the requested content directly in the empty workspace or minimal framework entry points. Read only existing configuration needed for your changes." : "1. Always search and read relevant files BEFORE editing. Do not blindly overwrite entire files or recreate the whole project.",
      "2. Make surgical, minimal modifications to fulfill the user request precisely.",
      "3. Keep all working pages, styles, assets, and configurations functional.",
      isDataTask ? "Use project.data.schema.inspect first. Add fields with project.data.schema.apply and kind add_field. Do not recreate existing collections or apply a template merely to add a column." : "",
      project.dataBackendId ? "A DataBackend is attached. Inspect its schema and available SDK, preserving existing bindings. Do not assume auth pages or form components have been generated. Never simulate form success with alert or local-only storage." : "",
      project.framework === "HTML/CSS" ? "4. This is a static HTML/CSS website. Edit its .html files directly and do not introduce Next.js or a package manager unless the user asks for it." : "",
      project.framework === "Next.js" ? "4. The Next.js project structure, package.json, and layout are ALREADY scaffolded in the workspace. Do not run create-next-app or re-scaffold; inspect and edit the existing files directly." : "",
      project.type === "mobile_app" ? "4. This is an Expo (React Native) app. Minimal Expo configuration exists; implement the requested screens. Do not assume a database or auth/SDK screens exist. Use only a public publishable key when data access is needed; never add PROJECT_SECRET_KEY, DATABASE_URL or any database credentials to the app." : "",
      "5. Focus ONLY on inspecting, creating, and modifying project source files. Do NOT execute 'npm run build', terminal commands, or preview tools (`project.terminal.exec`, `project.preview.start`) manually — the system automatically installs dependencies, executes production build verification, and launches Live Preview immediately after this step.",
      sharedContext ? `\n[Shared Project Context (PROJECT.md)]:\n${sharedContext.slice(0, 2000)}` : "",
      `\nUser Task: ${params.prompt}`,
    ].filter(Boolean).join("\n");

    const idempotencyKey = params.idempotencyKey || `project-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Update status to working / building
    await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, {
      status: isCreate ? "creating" : "working",
    });

    // 4. Execute Run through existing CompanyDelegationRuntime

    // Step 6: Handle COMMIT_PROJECT and CONNECT_REPOSITORY
    if (params.intentDecision.intent === "COMMIT_PROJECT") {
      if (!this.gitService) {
        throw new ProjectOrchestrationError("GIT_NOT_CONFIGURED", "Project Git service is not configured", 500);
      }
      const commitMessage = "Project update";
      const commitRes = await this.gitService.commit(ctx, params.companyId, project.id, {
        message: commitMessage,
        stageAll: true,
      });
      const checkpoint = await this.gitService.createCheckpoint(ctx, params.companyId, project.id, {
        name: `Commit: ${commitMessage.slice(0, 35)}`,
        description: `Commit ${commitRes.commitHash.slice(0, 7)}: ${commitMessage}`,
        trigger: "manual",
      });
      const responseMessage = `✅ Зміни успішно збережено в Git коміт: \`${commitRes.commitHash.slice(0, 7)}\`\nТочка відновлення створена: "${checkpoint.name}"`;
      project = await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: project.previewUrl ? "previewing" : "ready" });
      const { run: loggedRun } = await this.workspaceStore.createCompanyAgentRun(ctx, params.companyId, { task: "Commit project changes", requestedMode: "single", projectId: project.id }, `${idempotencyKey}-git-commit`);
      const completedRun = await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, loggedRun.id, { status: "completed", executionMode: "single", selectedAgentIds: [selectedAgent.id], result: responseMessage });
      return {
        project,
        runDetails: { run: completedRun, steps: [], toolAudit: [], backgroundEvents: [] },
        responseMessage,
        projectCard: {
          id: project.id,
          projectId: project.id,
          name: project.name,
          status: project.status,
          companyId: project.companyId,
          framework: project.framework,
          previewUrl: project.previewUrl,
          lastBuildStatus: project.lastBuildStatus,
        },
        projectAction: {
          action: "edit",
          projectId: project.id,
          projectName: project.name,
          companyId: project.companyId,
        },
      };
    }

    if (params.intentDecision.intent === "CONNECT_REPOSITORY") {
      const match = params.prompt.match(/https?:\/\/[^\s]+/);
      const repoUrl = match ? match[0].replace(/[.,!?;:]+$/, "") : undefined;
      if (repoUrl) {
        if (!this.gitService) throw new ProjectOrchestrationError("GIT_NOT_CONFIGURED", "Project Git service is not configured", 500);
        project = await this.gitService.connectRepository(ctx, params.companyId, project.id, { url: repoUrl });
      }
      const responseMessage = repoUrl
        ? `✅ Репозиторій \`${repoUrl}\` успішно зареєстровано для проєкту "${project.name}".`
        : `ℹ️ Для підключення зовнішнього репозиторію вкажіть його URL, наприклад: "Підключи репозиторій https://github.com/owner/repo"`;
      project = await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: project.previewUrl ? "previewing" : "ready" });
      const { run: loggedRun } = await this.workspaceStore.createCompanyAgentRun(ctx, params.companyId, { task: "Connect project repository", requestedMode: "single", projectId: project.id }, `${idempotencyKey}-git-connect`);
      const completedRun = await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, loggedRun.id, { status: "completed", executionMode: "single", selectedAgentIds: [selectedAgent.id], result: responseMessage });
      return {
        project,
        runDetails: { run: completedRun, steps: [], toolAudit: [], backgroundEvents: [] },
        responseMessage,
        projectCard: {
          id: project.id,
          projectId: project.id,
          name: project.name,
          status: project.status,
          companyId: project.companyId,
          framework: project.framework,
          previewUrl: project.previewUrl,
          lastBuildStatus: project.lastBuildStatus,
        },
        projectAction: {
          action: "edit",
          projectId: project.id,
          projectName: project.name,
          companyId: project.companyId,
        },
      };
    }

    // Step 10: Handle DEPLOY_PROJECT
    if (params.intentDecision.intent === "DEPLOY_PROJECT") {
      if (!this.deployService) {
        throw new ProjectOrchestrationError("DEPLOY_NOT_CONFIGURED", "Project Deploy service is not configured", 500);
      }

      // Check preflight before deploying
      const preflight = await this.deployService.preflight(ctx, params.companyId, project.id, {
        target: { provider: "dokploy", environment: "production" },
      });

      const preflightSummaryText = [
        `🚀 **Підготовка до деплою проєкту "${project.name}"**`,
        `- **Environment**: \`${preflight.environment}\``,
        `- **Branch**: \`${preflight.branch}\``,
        `- **Змінено файлів**: ${preflight.filesChanged}`,
        `- **Статус збірки**: \`${preflight.buildStatus}\``,
        `- **Тести**: \`${preflight.testsStatus}\``,
        `- **Платформа (Target)**: \`${preflight.target.provider}\``,
      ].join("\n");

      const responseMessage = `${preflightSummaryText}\n\n⚠️ **Деплой вимагає підтвердження**: Оберіть облікові дані Dokploy у Company Vault та надайте дозвіл для виконання публікації.`;

      const { run: loggedRun } = await this.workspaceStore.createCompanyAgentRun(
        ctx,
        params.companyId,
        { task: "Deploy website", requestedMode: "single", projectId: project.id },
        `${idempotencyKey}-deploy`
      );
      const completedRun = await this.workspaceStore.updateCompanyAgentRun(
        ctx,
        params.companyId,
        loggedRun.id,
        { status: "completed", executionMode: "single", selectedAgentIds: [selectedAgent.id], result: responseMessage }
      );

      return {
        project,
        runDetails: { run: completedRun, steps: [], toolAudit: [], backgroundEvents: [] },
        responseMessage,
        projectCard: {
          id: project.id,
          projectId: project.id,
          name: project.name,
          status: project.status,
          companyId: project.companyId,
          framework: project.framework,
          previewUrl: project.previewUrl,
          lastBuildStatus: project.lastBuildStatus,
        },
        projectAction: {
          action: "edit",
          projectId: project.id,
          projectName: project.name,
          companyId: project.companyId,
        },
      };
    }

    // Pre-run automatic checkpoint if project has existing files
    if (this.gitService && !isCreate) {
      try {
        const change = await this.gitService.isLargeChange(ctx, params.companyId, project.id);
        await this.gitService.createCheckpoint(ctx, params.companyId, project.id, {
          name: change.isLarge ? "Before large change" : "Before run",
          trigger: "pre_run",
        });
      } catch {}
    }

    let runDetails: CompanyAgentRunDetails;
    report("agent", "active", project.framework ?? undefined);
    let usedMultiAgent = false;
    try {
      const multiAgent = new ProjectMultiAgentService(
        this.workspaceStore,
        this.companyRuntime,
        this.previewService,
        // C12: the shared lease manager (undefined only in a composition that has none, where the service's own
        // default applies). Never a second manager next to `CompanyToolRuntime`'s.
        this.leaseManager,
        this.gitService,
        this.projectWorkspace as any,
        // C12: the mandatory post-merge verification, over the canonical verify runner.
        this.codeVerification ? { verification: this.codeVerification } : undefined,
        this.qaService,
      );
      const multiResult = project.framework !== "HTML/CSS" && ["CREATE_PROJECT", "CREATE_WEBSITE", "EDIT_PROJECT", "EDIT_WEBSITE", "IMPROVE_PROJECT"].includes(params.intentDecision.intent)
        ? await multiAgent.execute(ctx, params.companyId, project.id, params.prompt, sharedContext, idempotencyKey, params.intentDecision.intent === "IMPROVE_PROJECT", true, (stage) => report(stage, "active", project.framework ?? undefined))
        : undefined;
      usedMultiAgent = Boolean(multiResult);
      runDetails = multiResult ?? await this.companyRuntime.execute(
        ctx,
        params.companyId,
        {
          task: guidelinesHeader,
          mode: "single",
          preferredAgentId: selectedAgent.id,
          projectId: project.id,
          onTool: (tool, filePath) => params.onProgress?.({ type: "project_progress", stage: "agent", status: "active", framework: project.framework ?? undefined,
            title: filePath ? `${tool.endsWith("read") ? (ukrainian ? "Читання" : "Reading") : (ukrainian ? "Робота з файлом" : "Working on file")}: ${filePath}` : labels.agent }),
        },
        idempotencyKey
      );
    } catch (runErr) {
      if (isCreate && (project.framework === "Next.js" || project.framework === "HTML/CSS") &&
        ((runErr as { code?: string }).code === "INVALID_DELEGATION_PLAN" ||
          (project.framework === "HTML/CSS" && /sandbox runner is not configured|sandbox_unavailable/i.test(runErr instanceof Error ? runErr.message : String(runErr))))) {
        runDetails = await this.recordScaffoldFallback(ctx, params.companyId, project, idempotencyKey);
      } else {
        const msg = runErr instanceof Error ? runErr.message : String(runErr);
        const isModelFail = isModelError(runErr);
        await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, {
          status: "failed",
          lastBuildStatus: isModelFail ? null : "failed",
        });
        if (isModelFail) {
          throw new ProjectOrchestrationError(
            /404|not found/i.test(msg) ? "MODEL_UNAVAILABLE" : "MODEL_ROUTING_FAILED",
            msg,
            502
          );
        }
        throw runErr;
      }
    }

    if (isCreate && (project.framework === "Next.js" || project.framework === "HTML/CSS") &&
      runDetails.run.status === "failed" && (runDetails.run.errorCode === "INVALID_DELEGATION_PLAN" ||
        (project.framework === "HTML/CSS" && /sandbox runner is not configured|sandbox_unavailable/i.test(runDetails.run.errorMessage ?? "")))) {
      runDetails = await this.recordScaffoldFallback(ctx, params.companyId, project, idempotencyKey);
      usedMultiAgent = false;
    }

    if (project.framework === "Next.js" && runDetails.run.status === "completed") {
      const manifest = JSON.parse((await this.projectWorkspace.readFile(ctx, params.companyId, project.id, "package.json")).content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      if ((!manifest.dependencies?.next && !manifest.devDependencies?.next) || !/\bnext\b/.test(manifest.scripts?.dev ?? "") || !/\bnext\b/.test(manifest.scripts?.build ?? "")) {
        await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: "failed", lastBuildStatus: null });
        throw new ProjectOrchestrationError("FRAMEWORK_MISMATCH", "Next.js was requested, but the generated Project does not contain Next.js", 422);
      }
    }
    // 5. Build Repair Loop (Max 3 attempts)
    let lastBuildStatus: "success" | "failed" | null = null;
    let buildErrorSummary = "";
    let repairAttempts = 0;

    const needsBuild = !isDataTask && (isCreate
      || params.intentDecision.intent === "BUILD_PROJECT"
      || params.intentDecision.intent.startsWith("EDIT_")
      || params.intentDecision.intent === "DEBUG_PROJECT");

    const runErrorMessage = runDetails.run.errorMessage || "";
    const runFailedDueToModel = isModelError(runErrorMessage) || /model_routing_failed|model_unavailable/i.test(runDetails.run.errorCode ?? "");

    if (needsBuild && runDetails.run.status === "failed") {
      lastBuildStatus = null;
    }

    if (needsBuild && project.framework === "HTML/CSS" && runDetails.run.status === "completed") {
      try {
        const home = await this.projectWorkspace.readFile(ctx, params.companyId, project.id, "index.html");
        if (!/<html[\s>]/i.test(home.content) || !/<body[\s>]/i.test(home.content)) throw new Error("index.html is not a complete HTML page");
        lastBuildStatus = "success";
      } catch (error) {
        buildErrorSummary = error instanceof Error ? error.message : String(error);
        lastBuildStatus = "failed";
        await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, runDetails.run.id, { status: "failed", errorMessage: buildErrorSummary });
        runDetails = await this.workspaceStore.getCompanyAgentRun(ctx, params.companyId, runDetails.run.id);
      }
    }
    if (needsBuild && project.framework !== "HTML/CSS" && !usedMultiAgent && runDetails.run.status === "completed") {
      await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: "building" });

      const maxAttempts = 3;
      let buildPassed = false;
      let activeRunId = runDetails.run.id;

      while (repairAttempts < maxAttempts && !buildPassed) {
        repairAttempts++;
        let activeStage: "dependencies" | "build" | "preview" = "dependencies";
        try {
          // Verify the production build before starting the development preview.
          if (typeof this.previewService.buildProject === "function") await this.previewService.buildProject(ctx, params.companyId, project.id, (stage) => { activeStage = stage; report(stage, "active", project.framework ?? undefined); });
          activeStage = "preview";
          report("preview", "active", project.framework ?? undefined);
          const preview = await this.previewService.startPreview(ctx, params.companyId, project.id);
          if (preview.previewUrl) {
            buildPassed = true;
            lastBuildStatus = "success";
            break;
          }
        } catch (buildErr) {
          report(activeStage, "failed", project.framework ?? undefined);
          // Deletion/archive during a build must not spawn a repair run for stale context.
          try {
            const current = await this.projectService.get(ctx, params.companyId, project.id);
            if (current.status === "archived") throw new ProjectOrchestrationError("PROJECT_ARCHIVED", "Проєкт архівовано під час build. Запуск зупинено.", 409);
          } catch (lookupError) {
            if (lookupError instanceof WorkspaceNotFoundError) throw new ProjectOrchestrationError("PROJECT_REMOVED", "Проєкт видалено під час build. Запуск зупинено.", 404);
            throw lookupError;
          }
          const errMessage = buildErr instanceof Error ? buildErr.message : String(buildErr);
          buildErrorSummary = errMessage;
          if (buildErr instanceof PreviewError && buildErr.code === "sandbox_unavailable") {
            lastBuildStatus = "failed";
            break;
          }

          if (repairAttempts < maxAttempts) {
            report("agent", "active", project.framework ?? undefined);
            // Repair step: invoke agent with structured error context
            const repairTask = [
              `[BUILD REPAIR ATTEMPT ${repairAttempts}/${maxAttempts}]`,
              `The build for project "${project.name}" failed with the following error:`,
              "```",
              errMessage.slice(0, 1500),
              "```",
              "Inspect the relevant source files, fix the syntax/import/runtime error with surgical edits, and ensure the project builds cleanly.",
            ].join("\n");

            const repairRun = await this.companyRuntime.execute(
              ctx,
              params.companyId,
              {
                task: repairTask,
                mode: "single",
                preferredAgentId: selectedAgent.id,
                projectId: project.id,
              },
              `${idempotencyKey}-repair-${repairAttempts}`
            );

            activeRunId = repairRun.run.id;

            if (repairRun.run.status === "failed") {
              lastBuildStatus = "failed";
              break;
            }
          } else {
            lastBuildStatus = "failed";
          }
        }
      }

      if (!buildPassed) {
        lastBuildStatus = "failed";
        const failureMessage = repairAttempts >= maxAttempts
          ? `Build repair limit exceeded after ${repairAttempts} attempts: ${buildErrorSummary.slice(0, 300)}`
          : `Build or preview failed after ${repairAttempts} attempt(s): ${buildErrorSummary.slice(0, 300)}`;
        await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, activeRunId, {
          status: "failed",
          errorMessage: failureMessage,
        });
        if (activeRunId !== runDetails.run.id) {
          await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, runDetails.run.id, {
            status: "failed",
            errorMessage: failureMessage,
          });
        }
        runDetails = await this.workspaceStore.getCompanyAgentRun(ctx, params.companyId, runDetails.run.id);
      }
    }


    // Post-run automatic checkpoint on successful run
    if (this.gitService && runDetails.run.status === "completed" && (!needsBuild || lastBuildStatus === "success")) {
      try {
        await this.gitService.createCheckpoint(ctx, params.companyId, project.id, {
          name: "Run completed",
          trigger: "post_run",
          runId: runDetails.run.id,
        });
      } catch {}
    }

    // 6. Update Project Status & Preview URL
    let previewUrl: string | undefined;
    if (project.framework !== "HTML/CSS" && runDetails.run.status === "completed" && lastBuildStatus !== "failed") {
      try {
        const pStatus = await this.previewService.getPreviewStatus(ctx, params.companyId, project.id);
        previewUrl = pStatus.previewUrl || undefined;
      } catch {}
    }

    if (usedMultiAgent && needsBuild && runDetails.run.status === "completed") lastBuildStatus = previewUrl ? "success" : "failed";
    const finalStatus = runDetails.run.status === "awaiting_approval" ? "working" : runDetails.run.status === "failed" || lastBuildStatus === "failed" ? "failed" : previewUrl ? "previewing" : "ready";
    project = await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, {
      status: finalStatus,
      lastBuildStatus,
      previewUrl: previewUrl || null,
    });

    // 7. Formulate Result
    const projectCard: ProjectCardData = {
      id: project.id,
      projectId: project.id,
      name: project.name,
      status: project.status,
      companyId: project.companyId,
      framework: project.framework,
      lastBuildStatus: project.lastBuildStatus,
      buildStatus: lastBuildStatus ?? project.lastBuildStatus ?? null,
      previewUrl,
      agentName: selectedAgent.name,
      agentRole: selectedAgent.role,
      runId: runDetails.run.id,
    };

    const projectAction: ProjectActionData = {
      action: isCreate ? "create" : "edit",
      projectId: project.id,
      projectName: project.name,
      companyId: project.companyId,
      runId: runDetails.run.id,
    };

    const hasInternalCalls = /DSML|<\|[^>]*invoke|<tool_call/i.test(runDetails.run.result ?? "");
    let responseMessage = runDetails.run.status === "awaiting_approval"
      ? `Project "${project.name}" is waiting for command approval. [Open approval](/company?company=${encodeURIComponent(params.companyId)}&runId=${encodeURIComponent(runDetails.run.id)})`
      : runDetails.run.status === "failed"
      ? isCreate && lastBuildStatus === "failed"
        ? `Файли сайту "${project.name}" збережено, але перегляд не запущено.`
        : `Не вдалося ${isCreate ? "створити сайт" : "оновити проєкт"} "${project.name}".`
      : runDetails.run.result?.includes("AI-персоналізацію не завершено")
        ? `${runDetails.run.result}${project.framework === "HTML/CSS" ? " Натисніть Preview, щоб побачити сторінку в чаті." : ""}`
      : project.framework === "HTML/CSS" && isCreate
        ? `Створено HTML/CSS сайт "${project.name}". Натисніть Preview, щоб побачити сторінку в чаті.`
      : hasInternalCalls && !isCreate
        ? `Перегляд показує збережену версію проєкту "${project.name}". ${lastBuildStatus === "success" ? "Build завершено успішно." : ""}`
      : `${isCreate ? "Створено" : "Оновлено"} проєкт «${project.name}».${lastBuildStatus === "success" ? " Build успішний." : ""}${previewUrl ? " Live Preview готовий." : ""}`;

    if (runDetails.run.status === "failed" && runFailedDueToModel) {
      responseMessage += `\n\n⚠️ Model routing failed: ${runErrorMessage.slice(0, 300)}`;
    } else if (runDetails.run.status === "failed" && !buildErrorSummary) {
      responseMessage += `\n\n⚠️ Project agent failed: ${(runErrorMessage || "The project task did not complete.").slice(0, 300)}`;
    } else if (lastBuildStatus === "failed") {
      const failure = buildErrorSummary || runDetails.run.errorMessage || "Preview did not become available.";
      responseMessage += `\n\n⚠️ Build or preview failed: ${failure.slice(0, 300)}`;
    }

    if (runDetails.run.status === "awaiting_approval") params.onProgress?.({ type: "project_progress", stage: "agent", status: "active", title: ukrainian ? "Очікування вашого погодження" : "Waiting for your approval", framework: project.framework ?? undefined });
    else report("ready", lastBuildStatus === "failed" || runDetails.run.status === "failed" ? "failed" : "completed", project.framework ?? undefined);
    return {
      project,
      runDetails,
      responseMessage,
      projectCard,
      projectAction,
      previewUrl,
      repairAttempts,
      errorDetails: (lastBuildStatus === "failed" || runDetails.run.status === "failed") ? {
        step: runFailedDueToModel ? "model_routing_failed" : lastBuildStatus === "failed" ? "build_repair" : "agent_execution",
        agentId: selectedAgent.id,
        tool: runFailedDueToModel ? "ai.inference" : lastBuildStatus === "failed" ? "project.terminal.exec" : undefined,
        retryable: false,
      } : undefined,
    };
  }
}
