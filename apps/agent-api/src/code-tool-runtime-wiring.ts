
import { BrowserQaError, type ProjectBrowserQaService } from "./project-browser-qa-service";
import type { CodeAssistToolOptions } from "./code-tool-executors-assist";
import { CodeToolError } from "./code-tool-runtime-errors";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { createAuditServices } from "./audit-services";
import { CodeApprovalScopeService, resolveApprovalTimeoutMs } from "./code-approval-scope";
import { createCodeAskUserService } from "./code-ask-user-service";
import { CodeAsyncProcessService } from "./code-async-process";
import { isCodeChatWebsite } from "./code-chat-website";
import { gitWriteIntentForTool, sessionBranchName } from "./code-git-workflow";
import { createCodeHookPolicyPreflight, createCodeHooksService } from "./code-hooks";
import { proposePlan, updateSessionTodos } from "./code-plan-tool";
import { PolicyEngine, isReviewSafeTool } from "./code-policy-engine";
import { CodeProtectedBranchService } from "./code-protected-branches";
import { ReadTracker } from "./code-read-tracker";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { CodeService } from "./code-service";
import { CodeShellRuntime, resolveMigrationTargetConfig } from "./code-shell-runtime";
import { CodeSubagentDetachedRunner, CodeSubagentOperationService } from "./code-subagent-operations";
import { CodeVerifyRunnerPort, allCanonicalExecutors, runSandboxPostWriteHook } from "./code-tool-executors";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { CodeToolRuntime, createProjectWorkspaceReadPort, createProjectWorkspaceWritePort, type SandboxExecPort } from "./code-tool-runtime";
import { CodeTurnTracker, codeCheckpointPortFromGit } from "./code-workspace-checkpoint";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { CodingAgentRunner } from "./coding-agent-runner";
import { createCoreServices } from "./core-services";
import { FeatureFlagService } from "./feature-flags";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectGitService } from "./project-git-service";
import { ProjectService } from "./project-service";
import { CodeShellRuntimePort } from "./code-tool-executors";
import { CodeApprovalPort } from "./code-workspace-checkpoint";
import { createCodeToolWiring } from "./code-tool-wiring";
import { AuthContext } from "@npati/workspace";
import type { AgentDataStudioService } from "./data-studio/agent-data-service";

export interface CodeToolRuntimeWiringDeps {
  agentDataStudioService?: AgentDataStudioService;
  config: AppConfig;
  log: FastifyBaseLogger;
  approvalsRepo: CompanyApprovalsRepository | undefined;
  auditLogService: ReturnType<typeof createAuditServices>["auditLogService"];
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeApprovalPort: CodeApprovalPort | undefined;
  codeApprovalScope: CodeApprovalScopeService;
  codeCheckpointPort: ReturnType<typeof codeCheckpointPortFromGit>;
  codeDepsPort: ReturnType<typeof createCodeToolWiring>["codeDepsPort"];
  codeHooksService: ReturnType<typeof createCodeHooksService>;
  codeProjectWorkspaceWritePort: ReturnType<typeof createProjectWorkspaceWritePort>;
  codeProtectedBranches: CodeProtectedBranchService;
  codeReadTracker: ReadTracker;
  codeSandboxExecPort: SandboxExecPort | undefined;
  codeService: CodeService;
  codeShellRuntimePort: CodeShellRuntimePort | undefined;
  codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;
  codeToolRuntimeRef: CodeToolRuntime | undefined;
  codeTurnTracker: CodeTurnTracker;
  codeVerifyRunnerPort: CodeVerifyRunnerPort | undefined;
  codeWorkspaceRevisions: CodeWorkspaceRevisionGuard;
  describeCodeRunForPullRequest: ReturnType<typeof createCodeToolWiring>["describeCodeRunForPullRequest"];
  enrichedPolicyEngine: PolicyEngine;
  featureFlagService: FeatureFlagService;
  projectGitService: ProjectGitService;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;
  trackedProcesses: CodeAsyncProcessService | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  getProjectBrowserQaService?: () => ProjectBrowserQaService | undefined;
  webResearchProvider?: CodeAssistToolOptions["webResearch"];
}

export function createCodeToolRuntimeWiring(deps: CodeToolRuntimeWiringDeps) {
  const { log, approvalsRepo, auditLogService, codeActivitySink, codeApprovalPort, codeApprovalScope, codeCheckpointPort, codeDepsPort, codeHooksService, codeProjectWorkspaceWritePort, codeProtectedBranches, codeReadTracker, codeSandboxExecPort, codeService, codeShellRuntimePort, codeSubagentOperationsRef, codeToolRuntimeRef, codeTurnTracker, codeVerifyRunnerPort, codeWorkspaceRevisions, config, describeCodeRunForPullRequest, enrichedPolicyEngine, featureFlagService, projectGitService, projectService, projectWorkspace, subagentChildRunnerWithAck, trackedProcesses, workspaceStore } = deps;
  const codeToolRuntime = new CodeToolRuntime({
    flags: featureFlagService,
    store: workspaceStore,
    audit: auditLogService,
    tracker: codeReadTracker,
    limits: config.codeAgentLimits,

    executors: allCanonicalExecutors({
      // Manifest v15: viewing and documentation tools over the existing workspace, Browser QA and web research.
      readWorkspaceFile: ({ ctx, companyId, projectId, path }) => projectWorkspace.readFile(ctx, companyId, projectId, path) as never,
      ...(deps.getProjectBrowserQaService ? { previewScreenshot: previewScreenshotPort(deps.getProjectBrowserQaService, featureFlagService) } : {}),
      ...(deps.webResearchProvider ? { webResearch: deps.webResearchProvider } : {}),
      projectData: deps.agentDataStudioService,
      dataPolicy: enrichedPolicyEngine,
      projectLoader: async ({ ctx, companyId, projectId }) => {
        const project = await projectService.get(ctx, companyId, projectId);
        return project && (project.type === "code_project" || isCodeChatWebsite(project)) ? project as never : null;
      },

      shellRuntime: codeShellRuntimePort,
      verifyRunner: codeVerifyRunnerPort,

      deps: codeDepsPort,

      codeAskUserService: createCodeAskUserService({ store: workspaceStore }),

      planTool: {
        propose: async ({ ctx, companyId, projectId, sessionId, plan, createdBy }) => {
          const session = await codeService.getSession(ctx, companyId, sessionId);
          return proposePlan(workspaceStore, {
            companyId,
            projectId,
            sessionId,
            plan,
            createdBy: createdBy ?? null,
            dataClassification: session.dataClassification,
            retentionClass: session.retentionClass,
          });
        },
        updateTodos: async ({ ctx, companyId, projectId, sessionId, tasks }) => {
          const session = await codeService.getSession(ctx, companyId, sessionId);
          return updateSessionTodos(workspaceStore, {
            companyId,
            projectId,
            sessionId,
            tasks,
            dataClassification: session.dataClassification,
            retentionClass: session.retentionClass,
          });
        },
      },

      runCtags: async (input, path): Promise<string | null> => {
        if (!codeSandboxExecPort) return null;
        const quoted = `'${String(path).replace(/'/g, "'\\''")}'`;
        const attempts = [

          `ctags -f - --output-format=json --fields=+n --sort=no -- ${quoted}`,
          `ctags -f - --fields=+n -n -- ${quoted}`,
        ];
        for (const command of attempts) {
          try {
            const result = await codeSandboxExecPort.execute(input.ctx, input.companyId, {
              projectId: input.projectId,
              command,
            });
            const stdout = result.stdout ?? result.output ?? "";
            if (result.exitCode === 0 && stdout.trim().length > 0) return stdout;
          } catch {

          }
        }
        return null;
      },

      git: projectGitService,
      revisions: codeWorkspaceRevisions,
      assertProtectedBranch: async ({ ctx, companyId, intent }) => {
        const decision = await codeProtectedBranches.evaluateGitWrite(ctx, companyId, intent);
        return {
          allowed: decision.allowed,
          branch: decision.branch,
          ...(decision.code ? { code: decision.code } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
      },
      sessionBranch: async ({ sessionId }) => (sessionId ? sessionBranchName(sessionId) : null),
      describeRun: describeCodeRunForPullRequest,

      subagentCanonicalTools: () => codeToolRuntimeRef?.listTools().map((entry) => entry.name) ?? CODE_TOOL_SCHEMAS.map((entry) => entry.name),
      subagentChildRunner: () => subagentChildRunnerWithAck,

      subagentDetached: {
        isEnabled: async ({ ctx, companyId }) => await featureFlagService.isEnabled(ctx, "code.async_subagents", { companyId })
          && !!trackedProcesses && !!workspaceStore.codeProcesses,
        start: async (request) => {
          if (!trackedProcesses || !workspaceStore.codeProcesses) {
            return { status: "refused" as const, code: "tool_not_configured", message: "Detached sub-agents need the durable process store" };
          }
          return codeSubagentOperationsRef!().startDetached({
            ctx: request.ctx,
            companyId: request.companyId,
            projectId: request.projectId,
            sessionId: request.sessionId,
            parentRunId: request.parentRunId,
            parentOwner: request.parentOwner,
            toolCallId: request.toolCallId,
            childRunId: request.childRunId,
            snapshotId: request.snapshotId ?? null,
            agentType: request.resolution.type,
            capabilityProfile: request.resolution.capabilityProfile,
            task: request.task,
            paths: [...request.paths],
            model: request.resolution.model,
            maxTurns: request.resolution.maxTurns,
            maxParallelism: request.resolution.maxParallelism,
            readOnly: request.resolution.readOnly,
            summaryOnly: request.resolution.summaryOnly,
            allowedTools: [...request.allowedTools],
            toolCallingMode: request.resolution.toolCallingMode,
          });
        },
      },
      subagentControls: () => codeSubagentOperationsRef?.(),
      subagentActivity: codeActivitySink,
    }),
    checkpoints: codeCheckpointPort,
    approvals: codeApprovalPort,

    approvalRules: { findRule: async (ctx, query) => codeApprovalScope.findRule(ctx, query) },

    approvalDecision: approvalsRepo ? {
      timeoutMs: resolveApprovalTimeoutMs(process.env),
      wait: async ({ ctx, companyId, approvalId }) => {
        const report = await approvalsRepo!.get(ctx, companyId, approvalId).catch(() => null);
        if (!report) return null;
        if (report.status === "approved") return { status: "approved" as const };
        if (report.status === "rejected") return { status: "rejected" as const, comment: report.decisionNotes ?? null };
        return { status: "pending" as const };
      },
      onTimeout: async ({ approvalId, waitedMs, action }) => {
        await codeApprovalScope.recordTimeout(approvalId, waitedMs);
        log.warn({ approvalId, waitedMs, action, kind: "approval_timeout" }, "code_approval_timeout");
      },
    } : undefined,
    turns: codeTurnTracker,
    writePort: codeProjectWorkspaceWritePort,

    repositoryState: {
      inspect: async ({ ctx, companyId, projectId }) => {
        const state = await projectGitService.inspectRepository(ctx, companyId, projectId);
        return { initialized: state.initialized };
      },
    },

    postWriteHooks: codeSandboxExecPort ? {
      format: async ({ ctx, companyId, projectId, paths }) => runSandboxPostWriteHook(codeSandboxExecPort, ctx, companyId, projectId, process.env.NPATI_CODE_FORMAT_COMMAND, paths),
      checkSyntax: async ({ ctx, companyId, projectId, paths }) => runSandboxPostWriteHook(codeSandboxExecPort, ctx, companyId, projectId, process.env.NPATI_CODE_SYNTAX_COMMAND, paths),
    } : undefined,
    toPort: () => createProjectWorkspaceReadPort(projectWorkspace, codeSandboxExecPort),
    activity: activitySinkForKind(codeActivitySink, "code_tool_activity"),

    gitPolicy: {
      evaluate: async ({ ctx, companyId, projectId, sessionId, tool, args, toolCallId, agentId }) => {
        const intent = gitWriteIntentForTool(tool, args);
        const result = await enrichedPolicyEngine.evaluate({
          ctx, companyId, projectId,
          ...(sessionId ? { sessionId } : {}),
          ...(agentId ? { agentId } : {}),
          tool,
          toolCallId,
          git: intent,
          approvalDeferredByBoundary: true,
        });
        return {
          decision: result.decision === "deny" ? "deny" : result.decision === "require_approval" ? "require_approval" : "allow",
          ...(result.code ? { code: result.code } : {}),
          ...(result.reasons ? { reasons: result.reasons } : {}),
          status: result.status ?? 200,
        };
      },
    },
    reviewScope: { allows: (tool: string) => isReviewSafeTool(tool) },
    revisions: codeWorkspaceRevisions,

    hooks: codeHooksService,

    preToolPolicy: createCodeHookPolicyPreflight({
      evaluate: (request) => enrichedPolicyEngine.evaluate(request),
      migrationTargets: () => resolveMigrationTargetConfig(),
    }),
  });

  return {
    codeToolRuntime,
  };
}

/**
 * `code.preview.screenshot` over the existing Browser QA capture (the same call the visual acceptance makes), gated by
 * `code.shell` exactly as that path is. A Browser QA refusal keeps its reason (for example `preview_not_running`).
 */
function previewScreenshotPort(
  getService: () => ProjectBrowserQaService | undefined,
  flags: Pick<FeatureFlagService, "assertEnabled">,
): NonNullable<CodeAssistToolOptions["previewScreenshot"]> {
  return async ({ ctx, companyId, projectId, path, viewport, runId }) => {
    const service = getService();
    if (!service) throw new CodeToolError("visual_screenshot_unavailable", "Browser QA is not configured in this deployment", 503, "configure", false, "code.preview.screenshot");
    await flags.assertEnabled(ctx, "code.shell", { companyId });
    try {
      const report = await service.inspect(ctx, companyId, {
        projectId, path, viewport, checks: ["screenshot"], screenshotMode: "visual", maxScreenshotBytes: 2_000_000, agentId: "system", ...(runId ? { runId } : {}),
      });
      const shot = report.screenshots[0];
      if (!shot) throw new CodeToolError("visual_screenshot_unavailable", "The preview runner returned no screenshot", 503, "execute", true, "code.preview.screenshot");
      return { mimeType: shot.mimeType, base64Data: shot.base64Data, sizeBytes: shot.sizeBytes, issues: report.issues.length };
    } catch (error) {
      if (error instanceof BrowserQaError) {
        throw new CodeToolError("visual_screenshot_unavailable", `${error.code}: ${error.message}`, error.status, "execute", error.code === "preview_not_running", "code.preview.screenshot");
      }
      throw error;
    }
  };
}
