import type { AuthContext, CompanyAgentRunDetails, WorkspaceStore } from "@npati/workspace";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { ProjectPreviewService } from "./project-preview-service";
import { SecurityPolicyEngine } from "./security-guardrails";
import {
  executeProjectTaskGraph,
  parseProjectTaskPlan,
  selectProjectTaskAgent,
  ProjectFileLeaseManager,
  type ProjectTask,
} from "./project-task-graph";
import {
  ProjectGitService,
  GitConflictError,
  GitConflictEscalationError,
} from "./project-git-service";
import type { LocalProjectWorkspace } from "./project-workspace";

function clean(value: string, length = 1500): string {
  return SecurityPolicyEngine.protectText(value).sanitized.slice(0, length);
}

function callLimit(): number {
  const configured = Number(process.env.NPATI_PROJECT_MAX_MODEL_CALLS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(100, Math.floor(configured)) : 40;
}

function issuesFromResult(value: string): string[] {
  try {
    const start = value.indexOf("{"), end = value.lastIndexOf("}");
    const parsed = JSON.parse(value.slice(start, end + 1)) as { issues?: unknown };
    return Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string").slice(0, 10).map((issue) => clean(issue, 300)) : [];
  } catch { return []; }
}

export interface ProjectMultiAgentOptions {
  worktreeMode?: boolean;
}

export class ProjectMultiAgentService {
  private readonly worktreeMode: boolean;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: CompanyDelegationRuntime,
    private readonly preview: ProjectPreviewService,
    private readonly leaseManager: ProjectFileLeaseManager = new ProjectFileLeaseManager(),
    private readonly gitService?: ProjectGitService,
    private readonly workspace?: LocalProjectWorkspace,
    options?: ProjectMultiAgentOptions,
  ) {
    this.worktreeMode = options?.worktreeMode ?? (process.env.NPATI_PROJECT_WORKTREE_MODE === "true");
  }

  async execute(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    prompt: string,
    projectContext: string | undefined,
    idempotencyKey: string,
    improveOnly = false,
  ): Promise<CompanyAgentRunDetails | undefined> {
    const company = await this.store.getCompany(ctx, companyId);
    const agents = await this.store.listCompanyAgents(ctx, companyId);
    const specialists = agents.filter((agent) => agent.isActive && agent.id !== company.mainAgentId &&
      agent.tools.some((tool) => tool.startsWith("project.")));
    if (!improveOnly && specialists.length < 2) return undefined;
    if (!company.mainAgentId) throw new Error("Company Main Agent is required for project task planning");
    const edges = await this.store.listCompanyAgentEdges(ctx, companyId);
    const budget = { remaining: callLimit() };
    const { run: parent, created } = await this.store.createCompanyAgentRun(ctx, companyId, {
      task: clean(prompt, 4000), requestedMode: "pipeline", projectId,
    }, idempotencyKey);
    if (!created) return this.store.getCompanyAgentRun(ctx, companyId, parent.id);
    try {
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, { status: "planning" });
      let tasks: ProjectTask[];
      if (improveOnly) {
        tasks = (["design", "frontend", "seo", "qa", "security"] as const).map((role) => ({
          id: role, title: "Analyze project " + role, role, dependsOn: [], paths: [], status: "queued" as const,
        }));
      } else {
        const planRun = await this.runtime.execute(ctx, companyId, {
          task: [
            "Plan website implementation tasks. Return JSON only: {\"tasks\":[{\"id\":\"short_id\",\"title\":\"specific work\",\"role\":\"design|frontend|seo|qa|security\",\"depends_on\":[\"id\"],\"paths\":[\"relative/file/or/directory\"]}]}",
            "Use dependencies and precise file scopes. Design precedes implementation; QA follows implementation. SEO can run after page structure.",
            "Planning only. Do not call tools or edit files.",
            "Project Context: " + clean(projectContext ?? "", 2000),
            "Request: " + clean(prompt, 2000),
          ].join("\n"),
          mode: "single", preferredAgentId: company.mainAgentId, projectId,
          noMemory: true, suppressTools: true, callBudget: budget,
        }, idempotencyKey + ":plan");
        if (planRun.run.status !== "completed") throw new Error("Main Agent could not create a project task plan");
        tasks = parseProjectTaskPlan(planRun.run.result ?? "", prompt);
        if (!tasks.some((task) => task.role === "qa")) {
          tasks.push({ id: "qa", title: "Build, preview, test, and review the implementation", role: "qa",
            dependsOn: tasks.map((task) => task.id), paths: [], status: "queued" });
        }
        const designIds = tasks.filter((task) => task.role === "design").map((task) => task.id);
        for (const task of tasks) {
          if (task.role === "qa") {
            task.dependsOn = [...new Set([...task.dependsOn, ...tasks.filter((item) => item.role !== "qa").map((item) => item.id)])];
          } else if (task.role === "frontend" || task.role === "seo") {
            task.dependsOn = [...new Set([...task.dependsOn, ...designIds.filter((id) => id !== task.id)])];
          }
        }
        if (tasks.some((task) => task.role !== "qa" && task.dependsOn.some((id) => tasks.find((item) => item.id === id)?.role === "qa")))
          throw new Error("Implementation tasks cannot depend on QA tasks");
      }
      for (const task of tasks) {
        task.agentId = selectProjectTaskAgent(task.role, agents, edges, company.mainAgentId)?.id;
        if (!task.agentId) throw new Error("No active agent available for project task " + task.id);
      }
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, {
        status: "running", executionMode: "pipeline", selectedAgentIds: [...new Set(tasks.map((task) => task.agentId!))],
      });
      const initialSteps = tasks.map((task, index) => ({
        agentId: task.agentId!,
        stepOrder: index,
        lane: task.role === "seo" ? 1 : 0,
        role: task.role === "qa" ? ("reviewer" as const) : ("worker" as const),
        status: "selected" as const,
        modelId: agents.find((a) => a.id === task.agentId)?.modelId ?? "auto",
      }));
      await this.store.replaceCompanyAgentRunSteps(ctx, companyId, parent.id, initialSteps).catch(() => undefined);
      await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
        eventKey: "project-plan", eventType: "started", runStatus: "running",
        message: "Main Agent created a project task plan",
        details: { tasks: tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, agentId: task.agentId, dependsOn: task.dependsOn, paths: task.paths })) },
      });
      if (this.worktreeMode && this.gitService && !improveOnly) {
        await this.gitService.ensureRepository(ctx, companyId, projectId);
        const { branches } = await this.gitService.branch(ctx, companyId, projectId, { action: "list" });
        if (!branches.includes("project/main")) {
          await this.gitService.branch(ctx, companyId, projectId, { action: "create", branch: "project/main" }).catch(() => undefined);
        }
      }
      const execute = async (task: ProjectTask, snapshot: ProjectTask[]): Promise<string> => {
        const dependencies = snapshot.filter((item) => task.dependsOn.includes(item.id))
          .map((item) => item.id + ": " + clean(item.result ?? item.status, 800)).join("\n");
        const peerStatuses = snapshot.map((item) =>
          `- [${item.status.toUpperCase()}] ${item.id} (${item.role}): ${item.title}${item.result ? " -> " + clean(item.result, 120) : ""}`
        ).join("\n");

        if (task.role === "qa" && !improveOnly) {
          let openIssues: string[] = [];
          for (let iteration = 0; iteration < 2; iteration++) {
            try {
              await this.preview.startPreview(ctx, companyId, projectId);
            } catch (error) {
              openIssues = ["Preview/build failed: " + clean(error instanceof Error ? error.message : "Unknown error", 300)];
            }
            if (!openIssues.length) {
              const qaRun = await this.runtime.execute(ctx, companyId, {
                task: [
                  "Review this project implementation. Run available build/tests using permitted Project tools and inspect preview.",
                  "Return JSON only: {\"issues\":[\"specific issue\"]}. Do not edit files.",
                  "Task: " + task.title, "Project ID: " + projectId,
                  "Task Statuses:\n" + peerStatuses,
                  "Project Context: " + clean(projectContext ?? "", 2000),
                  "Dependencies:\n" + (dependencies || "none"),
                ].join("\n"),
                mode: "single", preferredAgentId: task.agentId, projectId, allowedProjectId: projectId, noMemory: true, callBudget: budget,
              }, idempotencyKey + ":qa:" + iteration);
              if (qaRun.run.status !== "completed") throw new Error("QA Agent failed");
              openIssues = issuesFromResult(qaRun.run.result ?? "");
            }
            if (!openIssues.length) return "QA passed; preview is available.";
            if (iteration === 1) return "QA finished with open issues: " + openIssues.join("; ");
            const developer = selectProjectTaskAgent("frontend", agents, edges, company.mainAgentId!);
            if (!developer) throw new Error("Developer Agent unavailable for QA repair");
            const repair = await this.runtime.execute(ctx, companyId, {
              task: [
                "Fix these QA issues with targeted edits. Re-read each file and use expected_revision:",
                ...openIssues,
                "Project ID: " + projectId,
                "Task Statuses:\n" + peerStatuses,
                "Project Context: " + clean(projectContext ?? "", 2000),
              ].join("\n"),
              mode: "single", preferredAgentId: developer.id, projectId, allowedProjectId: projectId, noMemory: true, callBudget: budget,
            }, idempotencyKey + ":qa-repair:" + iteration);
            if (repair.run.status !== "completed") throw new Error("Developer Agent could not repair QA issues");
            openIssues = [];
          }
          return "QA completed";
        }
        const runTask = async (): Promise<string> => {
          const child = await this.runtime.execute(ctx, companyId, {
            task: [
              improveOnly ? "Analyze only. Do not edit any files or invoke write tools." : "Implement only this task. Inspect files before editing and use expected_revision.",
              "Project ID: " + projectId,
              "Task: " + task.title,
              "Role: " + task.role,
              "Task Statuses:\n" + peerStatuses,
              "Allowed file scope: " + (task.paths.join(", ") || "unspecified; coordinate through revision checks"),
              "Project Context: " + clean(projectContext ?? "", 2000),
              "Dependencies and results:\n" + (dependencies || "none"),
              "Original request: " + clean(prompt, 1000),
            ].join("\n"),
            mode: "single", preferredAgentId: task.agentId, projectId,
            allowedProjectId: projectId, allowedProjectPaths: task.paths.length ? task.paths : undefined,
            noMemory: true, suppressTools: improveOnly, callBudget: budget,
          }, idempotencyKey + ":task:" + task.id);
          if (child.run.status !== "completed") throw new Error(child.run.errorMessage ?? "Project task failed");
          return clean(child.run.result ?? "", 1500);
        };

        if (this.worktreeMode && this.gitService && task.role !== "qa" && !improveOnly) {
          const agentSlug = task.role || task.id;
          const { worktreePath, branch, baseBranch } = await this.gitService.createAgentWorktree(ctx, companyId, projectId, {
            agentSlug,
            baseBranch: "project/main",
          });
          if (this.workspace?.registerWorktree && task.agentId) {
            this.workspace.registerWorktree(companyId, projectId, task.agentId, worktreePath);
          }
          await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
            eventKey: "project-worktree:" + task.id,
            eventType: "started",
            runStatus: "running",
            message: `Allocated worktree ${branch} for agent ${task.role}`,
            details: { taskId: task.id, role: task.role, branch, baseBranch, worktreePath },
          });

          try {
            const taskResult = await runTask();

            // Commit worktree
            await this.gitService.commitAgentWorktree(ctx, companyId, projectId, {
              agentSlug,
              message: `Implement ${task.title} (${task.role})`,
            });

            // Review
            const review = await this.gitService.diffAgentWorktree(ctx, companyId, projectId, {
              agentSlug,
              baseBranch: "project/main",
            });
            await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
              eventKey: "project-review:" + task.id,
              eventType: "completed",
              runStatus: "running",
              message: `Reviewed ${branch}: ${review.files.length} file(s) changed`,
              details: { taskId: task.id, role: task.role, branch, files: review.files, diffSnippet: review.diff.slice(0, 1000) },
            });

            // Merge
            await this.gitService.mergeAgentWorktree(ctx, companyId, projectId, {
              agentSlug,
              targetBranch: "project/main",
              message: `Merge ${branch} into project/main for ${task.title}`,
            });
            await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
              eventKey: "project-merge:" + task.id,
              eventType: "completed",
              runStatus: "running",
              message: `Merged ${branch} into project/main`,
              details: { taskId: task.id, role: task.role, branch, targetBranch: "project/main" },
            });

            // Build verification
            try {
              await this.preview.startPreview(ctx, companyId, projectId);
              await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
                eventKey: "project-build:" + task.id,
                eventType: "completed",
                runStatus: "running",
                message: `Build verification passed after merging ${branch}`,
                details: { taskId: task.id, role: task.role, branch },
              });
            } catch (buildErr) {
              await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
                eventKey: "project-build:" + task.id,
                eventType: "failed",
                runStatus: "running",
                message: `Build verification warning after merging ${branch}: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
                details: { taskId: task.id, role: task.role, branch, error: String(buildErr) },
              });
            }

            return taskResult;
          } catch (err) {
            if (err instanceof GitConflictError || err instanceof GitConflictEscalationError) {
              await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
                eventKey: "project-merge-conflict:" + task.id,
                eventType: "failed",
                runStatus: "failed",
                message: `Merge conflict on branch ${branch} in file(s): ${err.conflictingFiles.join(", ")}. Escalating to user intervention.`,
                details: { taskId: task.id, role: task.role, branch, conflictingFiles: err.conflictingFiles, error: err.message },
              });
            }
            throw err;
          } finally {
            if (this.workspace?.unregisterWorktree && task.agentId) {
              this.workspace.unregisterWorktree(companyId, projectId, task.agentId);
            }
            await this.gitService.removeAgentWorktree(ctx, companyId, projectId, {
              agentSlug,
            }).catch(() => undefined);
          }
        }

        return runTask();
      };
      const onStatus = async (task: ProjectTask, currentSnapshot: ProjectTask[]): Promise<void> => {
        const updatedSteps = currentSnapshot.map((t, idx) => {
          const stepStatus = t.status === "completed" ? "completed"
            : t.status === "failed" ? "failed"
            : t.status === "running" ? "delegated"
            : "selected";
          const stepRole = t.role === "qa" ? "reviewer" : "worker";
          return {
            agentId: t.agentId!,
            stepOrder: idx,
            lane: t.role === "seo" ? 1 : 0,
            role: stepRole as "reviewer" | "worker",
            status: stepStatus as "selected" | "delegated" | "completed" | "failed",
            modelId: agents.find((a) => a.id === t.agentId)?.modelId ?? "auto",
          };
        });
        await this.store.replaceCompanyAgentRunSteps(ctx, companyId, parent.id, updatedSteps).catch(() => undefined);
        await this.store.appendCompanyAgentRunEvent(ctx, companyId, parent.id, {
          eventKey: "project-task:" + task.id + ":" + task.status,
          eventType: task.status === "running" ? "started" : task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "queued",
          runStatus: task.status === "failed" ? "failed" : "running",
          message: task.title + " — " + task.status,
          details: { taskId: task.id, role: task.role, agentId: task.agentId, status: task.status, dependsOn: task.dependsOn, paths: task.paths },
        });
      };
      await executeProjectTaskGraph(tasks, execute, onStatus, 3, this.leaseManager, projectId);
      const failed = tasks.filter((task) => task.status === "failed" || task.status === "waiting");
      const hasBudgetFailure = tasks.some((t) => t.error?.includes("model call limit reached") || t.error?.includes("budget"));
      let result: string;
      if (improveOnly) {
        const findings = tasks.map((task) => task.role + ": " + clean(task.result ?? task.error ?? task.status, 600)).join("\n");
        const finalPlan = await this.runtime.execute(ctx, companyId, {
          task: "Create a targeted improvement plan and dependency ordered tasks from these specialist findings. Do not edit files.\n" +
            "Project ID: " + projectId + "\n" + findings,
          mode: "single", preferredAgentId: company.mainAgentId, projectId,
          noMemory: true, suppressTools: true, callBudget: budget,
        }, idempotencyKey + ":improve-plan");
        result = clean(finalPlan.run.result ?? findings, 4000);
      } else {
        result = tasks.map((task) => task.title + ": " + (task.result ?? task.error ?? task.status)).join("\n").slice(0, 4000);
      }
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, {
        status: failed.length ? "failed" : "completed", result,
        errorCode: failed.length ? (hasBudgetFailure ? "MODEL_CALL_BUDGET_EXCEEDED" : "PROJECT_TASK_FAILED") : undefined,
        errorMessage: failed.length ? failed.map((task) => task.id + ": " + (task.error ?? task.status)).join("; ").slice(0, 500) : undefined,
      });
      return this.store.getCompanyAgentRun(ctx, companyId, parent.id);
    } catch (error) {
      const isBudget = (error as { code?: string }).code === "MODEL_CALL_BUDGET_EXCEEDED" ||
        (error instanceof Error && error.message.includes("model call limit reached"));
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, {
        status: "failed",
        errorCode: isBudget ? "MODEL_CALL_BUDGET_EXCEEDED" : "PROJECT_TASK_FAILED",
        errorMessage: clean(error instanceof Error ? error.message : "Project task failed", 500),
      });
      return this.store.getCompanyAgentRun(ctx, companyId, parent.id);
    } finally {
      if (this.worktreeMode && this.gitService) {
        await this.gitService.cleanupAllWorktrees(ctx, companyId, projectId).catch(() => undefined);
      }
    }
  }
}
