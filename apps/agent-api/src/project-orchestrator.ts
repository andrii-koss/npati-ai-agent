import type { ProjectGitService } from "./project-git-service";
import type { ProjectDeployService } from "./project-deploy-service";
import type { ProjectBrowserQaService } from "./project-browser-qa-service";
import { ProjectMultiAgentService } from "./project-multi-agent";
import type { AuthContext, Company, CompanyAgent, CompanyAgentRunDetails, Project, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import { PreviewError, type ProjectPreviewService } from "./project-preview-service";
import type { CompanyDelegationRuntime } from "./company-runtime";
import { type ProjectCardData, type ProjectActionData, type ProjectIntentDecision, extractFramework, createDefaultWebsiteDocument, NextJsAdapter } from "@npati/shared";

export class ProjectOrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ProjectOrchestrationError";
  }
}

export function isModelError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/InferenceRouteFailure|SelfHealingExhaustedError|OmniRouteError|model_routing_failed|model_unavailable|No chat-compatible inference model|AI inference failed/i.test(msg)) {
    return true;
  }
  if (/\b(?:401|403|404)\b/i.test(msg) && /\b(?:model|route|provider|unsupported|denied|auth|unauthorized|not found)\b/i.test(msg)) {
    return true;
  }
  if (/\b(?:does not support|unsupported model|no valid candidate)\b/i.test(msg)) {
    return true;
  }
  return false;
}

export function extractCleanProjectName(prompt: string, explicitName?: string): string {
  if (explicitName && explicitName.trim()) {
    const trimmed = explicitName.trim().replace(/^["'«]+|["'»]+$/g, "");
    if (trimmed.length > 0) return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  let cleaned = (prompt || "").trim();

  const commandPatterns = [
    /^(?:створи(?: мені)?|зроби(?: мені)?|розроби(?: мені)?|побудуй|запусти|згенеруй|відкрий)\s+(?:новий\s+)?(?:сучасний\s+)?(?:адаптивний\s+)?(?:веб-?сайт|сайт|проєкт|проект|лендінг|додаток)(?:\s+(?:для|під|про|компанії))?/iu,
    /^(?:створи(?:ти)?|зроби(?:ти)?)\s+(?:новий\s+)?(?:веб-?сайт|сайт|проєкт|проект)/iu,
    /^(?:please\s+)?(?:create|build|make|generate|launch|develop)(?:\s+me)?(?:\s+a)?(?:\s+new)?(?:\s+modern)?(?:\s+responsive)?\s+(?:website|site|project|landing(?:\s+page)?|web\s*app)(?:\s+(?:for|about))?/iu,
  ];

  for (const pattern of commandPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  cleaned = cleaned.replace(/^[,:;—–\-.\s]+/, "").trim();

  const firstSentence = cleaned.split(/(?:\.\s+|\n+)/)[0]?.trim() || "";
  if (firstSentence && firstSentence.length >= 2 && firstSentence.length <= 60) {
    cleaned = firstSentence;
  }

  cleaned = cleaned.replace(/[,:;—–\-.\s]+$/, "").trim();
  cleaned = cleaned.replace(/^["'«]+|["'»]+$/g, "").trim();

  if (!cleaned || cleaned.length < 2) {
    return "Website Project";
  }

  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

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
  ) {}

  /**
   * Selects an agent for project development tasks based on capabilities, role, and instructions.
   * NEVER checks agent.name. Falls back to company.mainAgentId.
   */
  async selectProjectAgent(ctx: AuthContext, companyId: string, requiredCapabilities: string[] = ["project.files.read", "project.files.write"]): Promise<CompanyAgent | undefined> {
    const company = await this.workspaceStore.getCompany(ctx, companyId);
    if (!company) throw new ProjectOrchestrationError("COMPANY_NOT_FOUND", `Company ${companyId} not found`, 404);

    const agents = await this.workspaceStore.listCompanyAgents(ctx, companyId);
    const activeAgents = agents.filter((a) => a.isActive);

    const DEVELOPER_KEYWORDS = /(?:developer|engineer|frontend|fullstack|software|web|coder|programmer|розробник|програміст|верстальник|фронтенд)/i;

    let bestAgent: CompanyAgent | undefined;
    let highestScore = -1;

    for (const agent of activeAgents) {
      let score = 0;
      const tools = agent.tools ?? [];

      // Capability score
      for (const cap of requiredCapabilities) {
        if (tools.includes(cap) || tools.includes("*")) score += 10;
      }
      if (tools.some((t) => t.startsWith("project.terminal."))) score += 5;
      if (tools.some((t) => t.startsWith("project.preview."))) score += 5;
      if (tools.some((t) => t.startsWith("project.git."))) score += 5;
      if (tools.some((t) => t.startsWith("project.deploy."))) score += 5;
      if (tools.some((t) => t.startsWith("project.qa."))) score += 5;

      // Role and instruction semantic relevance (NOT agent.name)
      const roleText = `${agent.role} ${agent.description ?? ""} ${agent.systemInstruction ?? ""}`;
      if (DEVELOPER_KEYWORDS.test(roleText)) score += 20;

      if (score > highestScore) {
        highestScore = score;
        bestAgent = agent;
      }
    }

    // Fallback to Main Agent if no developer scored positively
    if (!bestAgent || highestScore <= 0) {
      if (company.mainAgentId) {
        const main = activeAgents.find((a) => a.id === company.mainAgentId);
        if (main) return main;
      }
    }

    return bestAgent;
  }

  /**
   * Initializes or updates the shared PROJECT.md context in the workspace root.
   */
  async initSharedProjectContext(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    details: { name: string; description?: string; framework?: string; purpose?: string }
  ): Promise<string> {
    const content = [
      `# ${details.name}`,
      "",
      "## Purpose & Overview",
      details.purpose || details.description || "Modern AI-generated web project.",
      "",
      "## Architecture & Tech Stack",
      `- Framework: ${details.framework || "Vite + React"}`,
      "- Language: TypeScript / JavaScript",
      "",
      "## Engineering Mandate & Guidelines",
      "- **Single Source of Truth**: website.config.json defines all pages, blocks, components, styles, and content. When modifying or creating sections, keep website.config.json synchronized so the visual editor and live preview stay in sync.",
      "- **Targeted Edits Rule**: Always search and inspect relevant files before modifying. Make surgical, targeted edits.",
      "- **No Blind Rewrites**: Do NOT recreate the entire project or overwrite unchanged components.",
      "- **Preserve Stability**: Ensure configuration, routing, and functional components remain intact across iterations.",
      "",
      "## Project Status",
      `- Initialized: ${new Date().toISOString()}`,
      "- Mode: Active development",
    ].join("\n");

    try {
      const existing = await this.projectWorkspace.readFile(ctx, companyId, projectId, "PROJECT.md");
      await this.projectWorkspace.writeFile(ctx, companyId, projectId, "PROJECT.md", content, existing.revision);
    } catch {
      await this.projectWorkspace.createFile(ctx, companyId, projectId, "PROJECT.md", content);
    }
    return content;
  }

  private async scaffoldNextProject(ctx: AuthContext, companyId: string, projectId: string, projectName: string, prompt?: string) {
    const doc = createDefaultWebsiteDocument(projectName, "nextjs", { purpose: prompt });
    const adapter = new NextJsAdapter();
    const files = adapter.scaffoldProject(doc);
    for (const [filePath, content] of Object.entries(files)) {
      try { await this.projectWorkspace.readFile(ctx, companyId, projectId, filePath); }
      catch { await this.projectWorkspace.createFile(ctx, companyId, projectId, filePath, content); }
    }
  }
  /**
   * Retrieves the shared PROJECT.md if present.
   */
  async getSharedProjectContext(ctx: AuthContext, companyId: string, projectId: string): Promise<string | undefined> {
    try {
      const file = await this.projectWorkspace.readFile(ctx, companyId, projectId, "PROJECT.md");
      return file.content;
    } catch {
      return undefined;
    }
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
      const framework = params.intentDecision.targetDetails?.framework || extractFramework(params.prompt) || "Next.js";

      const { project: created } = await this.projectService.create(ctx, params.companyId, {
        name,
        description: params.prompt,
        type: "website",
      }, params.idempotencyKey || `create-proj-${Date.now()}`);
      project = await this.projectService.updatePreview(ctx, params.companyId, created.id, { framework });

      if (framework === "Next.js") await this.scaffoldNextProject(ctx, params.companyId, project.id, project.name, params.prompt);

      // Initialize PROJECT.md
      await this.initSharedProjectContext(ctx, params.companyId, project.id, {
        name: project.name,
        framework,
        purpose: params.prompt,
      });
    }

    // 2. Select Agent by capabilities & role (NOT agent.name)
    const selectedAgent = await this.selectProjectAgent(ctx, params.companyId);
    if (!selectedAgent) {
      throw new ProjectOrchestrationError(
        "NO_QUALIFIED_AGENT",
        "No active agent with project capabilities (project.files, project.terminal) was found in this company.",
        400
      );
    }

    // 3. Prepare Prompt with Targeted Edits Rule & Shared Context
    const sharedContext = await this.getSharedProjectContext(ctx, params.companyId, project.id);
    const guidelinesHeader = [
      `[PROJECT MANDATE: "${project.name}"]`,
      `Targeted Edits Rule: You are modifying project "${project.name}" (ID: ${project.id}).`,
      "1. Always search and read relevant files BEFORE editing. Do not blindly overwrite entire files or recreate the whole project.",
      "2. Make surgical, minimal modifications to fulfill the user request precisely.",
      "3. Keep all working pages, styles, assets, and configurations functional.",
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
    let usedMultiAgent = false;
    try {
      const multiAgent = new ProjectMultiAgentService(
        this.workspaceStore,
        this.companyRuntime,
        this.previewService,
        undefined,
        this.gitService,
        this.projectWorkspace as any,
        undefined,
        this.qaService,
      );
      const multiResult = ["CREATE_PROJECT", "CREATE_WEBSITE", "EDIT_PROJECT", "EDIT_WEBSITE", "IMPROVE_PROJECT"].includes(params.intentDecision.intent)
        ? await multiAgent.execute(ctx, params.companyId, project.id, params.prompt, sharedContext, idempotencyKey, params.intentDecision.intent === "IMPROVE_PROJECT")
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
        },
        idempotencyKey
      );
    } catch (runErr) {
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

    const needsBuild = isCreate
      || params.intentDecision.intent === "BUILD_PROJECT"
      || params.intentDecision.intent.startsWith("EDIT_")
      || params.intentDecision.intent === "DEBUG_PROJECT";

    const runErrorMessage = runDetails.run.errorMessage || "";
    const runFailedDueToModel = isModelError(runErrorMessage) || /model_routing_failed|model_unavailable/i.test(runDetails.run.errorCode ?? "");

    if (needsBuild && runDetails.run.status === "failed") {
      lastBuildStatus = runFailedDueToModel ? null : "failed";
    }

    if (needsBuild && !usedMultiAgent && runDetails.run.status === "completed") {
      await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: "building" });

      const maxAttempts = 3;
      let buildPassed = false;
      let activeRunId = runDetails.run.id;

      while (repairAttempts < maxAttempts && !buildPassed) {
        repairAttempts++;
        try {
          // Verify the production build before starting the development preview.
          if (typeof this.previewService.buildProject === "function") await this.previewService.buildProject(ctx, params.companyId, project.id);
          const preview = await this.previewService.startPreview(ctx, params.companyId, project.id);
          if (preview.previewUrl) {
            buildPassed = true;
            lastBuildStatus = "success";
            break;
          }
        } catch (buildErr) {
          const errMessage = buildErr instanceof Error ? buildErr.message : String(buildErr);
          buildErrorSummary = errMessage;
          if (buildErr instanceof PreviewError && buildErr.code === "sandbox_unavailable") {
            lastBuildStatus = "failed";
            break;
          }

          if (repairAttempts < maxAttempts) {
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
    try {
      const pStatus = await this.previewService.getPreviewStatus(ctx, params.companyId, project.id);
      previewUrl = pStatus.previewUrl || undefined;
    } catch {}

    if (usedMultiAgent && needsBuild && runDetails.run.status === "completed") lastBuildStatus = previewUrl ? "success" : "failed";
    const finalStatus = runDetails.run.status === "failed" || lastBuildStatus === "failed" ? "failed" : previewUrl ? "previewing" : "ready";
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

    let responseMessage = runDetails.run.result || (isCreate
      ? `Створено новий проєкт "${project.name}" на базі ${project.framework || "Next.js"}.`
      : `Оновлено проєкт "${project.name}".`);

    if (runDetails.run.status === "failed" && runFailedDueToModel) {
      responseMessage += `\n\n⚠️ Model routing failed: ${runErrorMessage.slice(0, 300)}`;
    } else if (lastBuildStatus === "failed") {
      const failure = buildErrorSummary || runDetails.run.errorMessage || "Preview did not become available.";
      responseMessage += `\n\n⚠️ Build or preview failed: ${failure.slice(0, 300)}`;
    }

    return {
      project,
      runDetails,
      responseMessage,
      projectCard,
      projectAction,
      previewUrl,
      repairAttempts,
      errorDetails: (lastBuildStatus === "failed" || (runDetails.run.status === "failed" && runFailedDueToModel)) ? {
        step: runFailedDueToModel ? "model_routing_failed" : "build_repair",
        agentId: selectedAgent.id,
        tool: runFailedDueToModel ? "ai.inference" : "project.terminal.exec",
        retryable: false,
      } : undefined,
    };
  }
}
