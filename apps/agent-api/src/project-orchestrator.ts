import type { ProjectGitService } from "./project-git-service";
import type { AuthContext, Company, CompanyAgent, CompanyAgentRunDetails, Project, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { ProjectCardData, ProjectActionData, ProjectIntentDecision } from "@npati/shared";

export class ProjectOrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ProjectOrchestrationError";
  }
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
      const name = params.intentDecision.targetDetails?.entityName
        || (params.prompt.length > 50 ? `${params.prompt.slice(0, 40)}...` : params.prompt)
        || "Website Project";
      const framework = params.intentDecision.targetDetails?.framework || "Vite";

      const { project: created } = await this.projectService.create(ctx, params.companyId, {
        name,
        description: params.prompt,
        type: "website",
      }, params.idempotencyKey || `create-proj-${Date.now()}`);
      project = created;

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
    try {
      runDetails = await this.companyRuntime.execute(
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
      await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, {
        status: "failed",
        lastBuildStatus: "failed",
      });
      throw runErr;
    }

    // 5. Build Repair Loop (Max 3 attempts)
    let lastBuildStatus: "success" | "failed" | null = null;
    let buildErrorSummary = "";
    let repairAttempts = 0;

    const needsBuild = isCreate
      || params.intentDecision.intent === "BUILD_PROJECT"
      || params.intentDecision.intent.startsWith("EDIT_")
      || params.intentDecision.intent === "DEBUG_PROJECT";

    if (needsBuild && runDetails.run.status === "completed") {
      await this.workspaceStore.updateProjectPreview(ctx, params.companyId, project.id, { status: "building" });

      const maxAttempts = 3;
      let buildPassed = false;
      let activeRunId = runDetails.run.id;

      while (repairAttempts < maxAttempts && !buildPassed) {
        repairAttempts++;
        try {
          // Attempt dev server / preview start or test compilation
          const preview = await this.previewService.startPreview(ctx, params.companyId, project.id);
          if (preview.previewUrl) {
            buildPassed = true;
            lastBuildStatus = "success";
            break;
          }
        } catch (buildErr) {
          const errMessage = buildErr instanceof Error ? buildErr.message : String(buildErr);
          buildErrorSummary = errMessage;

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
        await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, activeRunId, {
          status: "failed",
          errorMessage: `Build repair limit exceeded after ${repairAttempts} attempts: ${buildErrorSummary.slice(0, 300)}`,
        });
        if (activeRunId !== runDetails.run.id) {
          await this.workspaceStore.updateCompanyAgentRun(ctx, params.companyId, runDetails.run.id, {
            status: "failed",
            errorMessage: `Build repair limit exceeded after ${repairAttempts} attempts: ${buildErrorSummary.slice(0, 300)}`,
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

    const finalStatus = lastBuildStatus === "failed" ? "failed" : previewUrl ? "previewing" : "ready";
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
      ? `Створено новий проєкт "${project.name}" на базі ${project.framework || "Vite"}.`
      : `Оновлено проєкт "${project.name}".`);

    if (lastBuildStatus === "failed") {
      responseMessage += `\n\n⚠️ Помилка збірки після 3 спроб автоматичного виправлення: ${buildErrorSummary.slice(0, 300)}`;
    }

    return {
      project,
      runDetails,
      responseMessage,
      projectCard,
      projectAction,
      previewUrl,
      repairAttempts,
      errorDetails: lastBuildStatus === "failed" ? {
        step: "build_repair",
        agentId: selectedAgent.id,
        tool: "project.terminal.exec",
        retryable: false,
      } : undefined,
    };
  }
}
