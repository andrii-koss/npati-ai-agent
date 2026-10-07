import type { AuthContext, CompanyAgentRunDetails, WorkspaceStore } from "@npati/workspace";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { ProjectPreviewService } from "./project-preview-service";
import { SecurityPolicyEngine } from "./security-guardrails";
import { canBuildWebsite } from "./project-agent-capabilities";
import { resolveCodeAgentLimits } from "./code-agent-config";
import { resolveCodeSubagentLimits } from "./code-subagent-limits";
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
import type { ProjectBrowserQaService } from "./project-browser-qa-service";
import {
  createVerificationLoop,
  type VerificationCheckReport,
  type VerificationReport,
} from "./code-verification-loop";

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
  /**
   * C12: how many independent tasks may run in parallel. Absent means the coding agent's configured
   * `subagentParallelism`, which is itself clamped to the canonical hard ceiling — the graph clamps again, so a
   * caller cannot raise the fan-out by passing a larger number.
   */
  parallelism?: number;
  /**
   * C12: the **existing** verification runner — the same `CodeVerifyRunnerPort` `code.verify.run` uses, which
   * replays the project's configured verify commands and never invents one. Absent means the final verification
   * reports `unavailable`, which is a reported state and never a pass.
   */
  verification?: ProjectVerificationPort;
  /** C12: which kinds to run after the merges. The C9 vocabulary, plus `build`. */
  verificationTools?: readonly string[];
}

/** The verification kinds of the C9 loop that a project toolchain can actually run. */
export const PROJECT_VERIFICATION_KINDS = ["lint", "typecheck", "test", "build"] as const;
export type ProjectVerificationKind = (typeof PROJECT_VERIFICATION_KINDS)[number];

/**
 * C12: the post-merge verification port. It is the *canonical* runner (`CodeVerifyRunnerPort`) with the
 * project service's own call shape, so there is no second way to verify a project: the final check the owner
 * asked for runs the project's configured `lint`/`typecheck`/`test`/`build` commands exactly as
 * `code.verify.run` would.
 */
export interface ProjectVerificationPort {
  run(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    tools: ProjectVerificationKind[];
    changedOnly: boolean;
    timeoutMs: number;
  }): Promise<{
    results: Array<{ tool: string; ok: boolean; summary: string; findings: string[] }>;
    stats: { tools: number; passed: number; failed: number; durationMs: number };
  }>;
}

/** Default verification for a project run: the C9 conservative default, plus nothing else. */
export const DEFAULT_PROJECT_VERIFICATION_TOOLS: readonly ProjectVerificationKind[] = ["typecheck", "test"];

/** The C9 stop code the loop reports when checks failed and there is no repair budget left. */
export const PROJECT_VERIFICATION_FAILED = "verification_failed_after_repair_limit";

function isVerificationKind(value: string): value is ProjectVerificationKind {
  return (PROJECT_VERIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * One bounded line describing a final verification report. It names the status and the checks that did not pass
 * (with their codes) and never quotes a verifier's output: the C9 report is already content-free by
 * construction, and this keeps it that way at the boundary where it becomes run text.
 */
export function summariseProjectVerification(report: VerificationReport): string {
  const failed = report.failedChecks;
  const parts = [`${report.status} (${report.checks.length} check(s))`];
  if (failed.length) {
    parts.push(failed.slice(0, 8).map((check) => `${check.tool}:${check.code ?? check.state}`).join(", "));
  }
  return parts.join(" — ").slice(0, 500);
}

export class ProjectMultiAgentService {
  private readonly worktreeMode: boolean;
  /**
   * C12: the parallel fan-out this service admits. `subagentParallelism` was dead configuration (zero readers)
   * until this line: the graph used a hard-coded 3 while the plan's table said 4 and nothing connected them.
   */
  private readonly parallelism: number;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: CompanyDelegationRuntime,
    private readonly preview: ProjectPreviewService,
    private readonly leaseManager: ProjectFileLeaseManager = new ProjectFileLeaseManager(),
    private readonly gitService?: ProjectGitService,
    private readonly workspace?: LocalProjectWorkspace,
    options?: ProjectMultiAgentOptions,
    private readonly qaService?: ProjectBrowserQaService,
  ) {
    this.worktreeMode = options?.worktreeMode ?? (process.env.NPATI_PROJECT_WORKTREE_MODE === "true");
    const limits = resolveCodeSubagentLimits(resolveCodeAgentLimits());
    const requested = options?.parallelism;
    this.parallelism = typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(1, Math.min(limits.maxParallelism, Math.trunc(requested)))
      : limits.maxParallelism;
    this.verification = options?.verification;
    /**
     * The requested verification kinds, filtered to the C9 vocabulary and **de-duplicated**. An unknown name is
     * not dropped silently: it stays in the list and becomes an `unavailable` check, because C9's rule is that a
     * check which never ran is not a pass.
     */
    const requestedTools = options?.verificationTools ?? DEFAULT_PROJECT_VERIFICATION_TOOLS;
    this.verificationTools = [...new Set(requestedTools.map((tool) => String(tool)))];
  }

  private readonly verification?: ProjectVerificationPort;
  private readonly verificationTools: readonly string[];

  /**
   * C12: the final verification, run **after** every worktree has been merged into `project/main`.
   *
   * It is the C9 loop's state machine over the project's configured checks, and it reports rather than repairs:
   * with `maxRepairAttempts: 0` a failure is a stop, never a second model loop. Three states are kept
   * distinguishable, which is the whole point of reusing the loop instead of writing a boolean:
   *
   *  - `passed` — every requested check ran and passed;
   *  - `failed` — a check failed, or a check that was asked for never ran (C9: a check which never ran is a
   *    failure, not a pass);
   *  - `unavailable` — nothing could be run at all (no port, no configured commands), reported as such.
   *
   * The whole method is deliberately total: a port that throws, a store that refuses the event and an unknown
   * verification name all become reported states. A final check must never be the reason a run hangs.
   */
  async verifyAfterMerge(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    parentRunId: string,
  ): Promise<VerificationReport> {
    const tools = this.verificationTools;
    let checks: VerificationCheckReport[];
    const unknown = tools.filter((tool) => !isVerificationKind(tool));
    const known = tools.filter(isVerificationKind);
    if (!this.verification || !tools.length) {
      checks = tools.map((tool) => ({
        tool,
        state: "unavailable" as const,
        code: "verification_unavailable",
        message: this.verification ? "No verification kind was requested" : "This deployment has no verification runner configured",
      }));
    } else {
      try {
        const outcome = await this.verification.run({
          ctx, companyId, projectId, tools: known, changedOnly: false, timeoutMs: 10 * 60_000,
        });
        const byTool = new Map(outcome.results.map((entry) => [entry.tool, entry]));
        checks = known.map((tool) => {
          const result = byTool.get(tool);
          if (!result) {
            // The runner answered without this check. Reporting it as a pass is exactly the defect C9 exists to
            // prevent, so it is `unavailable`, and `summariseVerification` turns a partial run into a failure.
            return { tool, state: "unavailable" as const, code: "verification_not_run", message: "The verification runner did not report a result for this check" };
          }
          return result.ok
            ? { tool, state: "passed" as const }
            : { tool, state: "failed" as const, code: "verification_check_failed", ...(result.summary ? { message: result.summary } : {}) };
        });
      } catch (error) {
        checks = known.map((tool) => ({
          tool,
          state: "unavailable" as const,
          code: "verification_unavailable",
          message: error instanceof Error ? error.message : "The verification runner failed",
        }));
      }
    }
    checks.push(...unknown.map((tool) => ({
      tool,
      state: "unavailable" as const,
      code: "verification_tool_unknown",
      message: `"${tool}" is not a check this project toolchain can run`,
    })));

    const loop = createVerificationLoop({ maxRepairAttempts: 0, requestedTools: tools });
    loop.record(checks);
    const decision = loop.decide();
    const report = loop.report();
    const status = report.status;

    await this.store.appendCompanyAgentRunEvent(ctx, companyId, parentRunId, {
      eventKey: "project-verification:" + (decision.decision === "complete" ? "passed" : status),
      eventType: decision.decision === "complete" ? "completed" : "failed",
      runStatus: status === "passed" ? "running" : "failed",
      message: "Final verification after merge: " + summariseProjectVerification(report),
      details: {
        // Counts and check names only: the loop's own message field is already bounded and content-free, and a
        // verification summary is not an output dump.
        status,
        decision: decision.decision,
        ...(decision.decision === "stop" ? { code: decision.code } : {}),
        requestedTools: [...tools],
        checks: report.checks.map((check) => ({ tool: check.tool, state: check.state, code: check.code ?? null })),
      },
    }).catch(() => undefined);

    return report;
  }

  async execute(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    prompt: string,
    projectContext: string | undefined,
    idempotencyKey: string,
    improveOnly = false,
    requireWebsiteTools = false,
  ): Promise<CompanyAgentRunDetails | undefined> {
    const company = await this.store.getCompany(ctx, companyId);
    const agents = await this.store.listCompanyAgents(ctx, companyId);
    const specialists = agents.filter((agent) => agent.isActive && agent.id !== company.mainAgentId &&
      (requireWebsiteTools && !improveOnly ? canBuildWebsite(agent) : agent.tools.some((tool) => tool.startsWith("project."))));
    const taskAgents = requireWebsiteTools && !improveOnly ? agents.filter(canBuildWebsite) : agents;
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
        let planResult = "";
        try {
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
          if (planRun.run.status === "completed") {
            planResult = planRun.run.result ?? "";
          }
        } catch {
          // If Main Agent fails planning (e.g. LLM model routing issue), gracefully fallback to standard tasks
        }
        tasks = parseProjectTaskPlan(planResult, prompt);
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
        task.agentId = selectProjectTaskAgent(task.role, taskAgents, edges, company.mainAgentId)?.id;
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
              if (typeof this.preview.buildProject === "function") await this.preview.buildProject(ctx, companyId, projectId);
              await this.preview.startPreview(ctx, companyId, projectId);
            } catch (error) {
              openIssues = ["Preview/build failed: " + clean(error instanceof Error ? error.message : "Unknown error", 300)];
            }
            if (!openIssues.length) {
              let browserQaSummary = "Browser QA was not configured.";
              if (this.qaService) {
                try {
                  const qaResult = await this.qaService.inspect(ctx, companyId, { projectId });
                  browserQaSummary = [qaResult.report.summary, ...qaResult.issues.slice(0, 20).map((item) => `[${item.type}] ${item.message}`)].join("\n").slice(0, 4000);
                  if (qaResult.issues.length > 0) {
                    openIssues = qaResult.issues.map((i) => `[${i.type}] ${i.message}`);
                  }
                } catch {
                  throw new Error("Browser QA results are unavailable");
                }
              }
              const qaRun = await this.runtime.execute(ctx, companyId, {
                task: [
                  "Review this project implementation. Run available build/tests using permitted Project tools, capability `project.qa.inspect`, and inspect preview.",
                  "Return JSON only: {\"issues\":[\"specific issue\"]}. Do not edit files.",
                  "Task: " + task.title, "Project ID: " + projectId,
                  "Task Statuses:\n" + peerStatuses,
                  "Browser QA Results:\n" + browserQaSummary,
                  "Project Context: " + clean(projectContext ?? "", 2000),
                  "Dependencies:\n" + (dependencies || "none"),
                ].join("\n"),
                mode: "single", preferredAgentId: task.agentId, projectId, allowedProjectId: projectId, noMemory: true, callBudget: budget,
              }, idempotencyKey + ":qa:" + iteration);
              if (qaRun.run.status !== "completed") throw new Error(qaRun.run.errorMessage ?? "QA Agent failed");
              const agentIssues = issuesFromResult(qaRun.run.result ?? "");
              openIssues = [...new Set([...openIssues, ...agentIssues])];
            }
            if (!openIssues.length) return "QA passed; preview is available.";
            if (iteration === 1) return "QA finished with open issues: " + openIssues.join("; ");
            const developer = selectProjectTaskAgent("frontend", taskAgents, edges, company.mainAgentId!);
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
            if (repair.run.status !== "completed") throw new Error(repair.run.errorMessage ?? "Developer Agent could not repair QA issues");
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
          /**
           * C12: the worktree slug is derived from the **task**, not from the role.
           *
           * `task.role || task.id` made two parallel tasks of one role resolve to the same slug — so
           * `createAgentWorktree` returned one worktree and one branch (`agent/frontend`) for both, the two
           * children wrote into the same directory, and the two merges were one merge. That is exactly the
           * isolation this path exists to provide, and a plan with two frontend tasks (the common case) silently
           * lost it. `task.id` is validated by `parseProjectTaskPlan` (`^[a-z][a-z0-9_-]{0,31}$`) and the service
           * normalises it, so the slug stays within `safeAgentSlug`.
           */
          const agentSlug = `${task.role}-${task.id}`;
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
              if (typeof this.preview.buildProject === "function") await this.preview.buildProject(ctx, companyId, projectId);
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
        /**
         * C12: progress reporting is **isolated from the run**. This callback writes the step rows and the run
         * event, and a store outage here used to reject the task's promise — which made `Promise.race` throw and
         * took the whole graph (and with it the parent's run) down for a bookkeeping failure. Reporting is
         * therefore best-effort: the run keeps going, and the durable step rows are refreshed on the next
         * transition.
         */
        try {
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
        } catch {
          // Bookkeeping never changes what was decided, and never stops the graph.
        }
      };
      /**
       * C12: the configured (hard-clamped) parallelism instead of a literal 3. `this.leaseManager` is also the
       * **one** lease manager of the deployment: the graph's path locks and the Company tools' file locks must
       * be the same object, or two agents working on one path would each believe they held it.
       */
      await executeProjectTaskGraph(tasks, execute, onStatus, this.parallelism, this.leaseManager, projectId);
      const failed = tasks.filter((task) => task.status === "failed" || task.status === "waiting");
      const hasBudgetFailure = tasks.some((t) => t.error?.includes("model call limit reached") || t.error?.includes("budget"));
      const hasModelFailure = tasks.some((t) => /model_routing_failed|model_unavailable|chat-compatible|AI inference failed|HTTP (?:401|403|404)/i.test(t.error ?? ""));
      /**
       * C12 (owner requirement): the **mandatory final verification after the merges**. It runs the project's
       * configured checks through the existing `ProjectVerificationPort` (the same runner `code.verify.run`
       * uses) and judges them with the existing `createVerificationLoop` — there is no second verification
       * mechanism and no new check vocabulary. `maxRepairAttempts: 0` on purpose: repair belongs to the run
       * that still has a model loop, so this final pass decides and reports rather than opening a second loop.
       *
       * A failing final verification does not hang the run and does not invent a repair: the parent settles with
       * `verification_failed_after_repair_limit` and the failing checks named. `improveOnly` runs change nothing
       * (it is an analysis-only pass), so there is nothing to verify there.
       */
      const verification = improveOnly
        ? null
        : await this.verifyAfterMerge(ctx, companyId, projectId, parent.id);
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
        if (verification) result = (result + "\n\nFinal verification: " + summariseProjectVerification(verification)).slice(0, 4000);
      }
      /**
       * `failed` fails the run; `approval_required` stops it (the loop must not work around a check that needs a
       * human). `unavailable` deliberately does **not** fail the run: C9's own vocabulary defines it as "no
       * verification could be run at all … not a failure of the change", and a deployment with no sandbox would
       * otherwise fail every project run for a reason the change did not cause. It is still *reported* — named in
       * the result and in the Activity event — so it is never mistaken for a pass.
       */
      const verificationFailed = verification !== null
        && (verification.status === "failed" || verification.status === "approval_required");
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, {
        status: failed.length || verificationFailed ? "failed" : "completed", result,
        errorCode: verificationFailed
          ? PROJECT_VERIFICATION_FAILED
          : failed.length ? (hasModelFailure ? "model_routing_failed" : hasBudgetFailure ? "MODEL_CALL_BUDGET_EXCEEDED" : "PROJECT_TASK_FAILED") : undefined,
        errorMessage: verificationFailed
          ? "Final verification: " + summariseProjectVerification(verification!)
          : failed.length ? failed.map((task) => task.id + ": " + (task.error ?? task.status)).join("; ").slice(0, 500) : undefined,
      });
      return this.store.getCompanyAgentRun(ctx, companyId, parent.id);
    } catch (error) {
      const isModel = /model_routing_failed|model_unavailable|chat-compatible|AI inference failed|HTTP (?:401|403|404)/i.test(error instanceof Error ? error.message : String(error));
      const isBudget = (error as { code?: string }).code === "MODEL_CALL_BUDGET_EXCEEDED" ||
        (error instanceof Error && error.message.includes("model call limit reached"));
      await this.store.updateCompanyAgentRun(ctx, companyId, parent.id, {
        status: "failed",
        errorCode: isModel ? "model_routing_failed" : isBudget ? "MODEL_CALL_BUDGET_EXCEEDED" : "PROJECT_TASK_FAILED",
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
