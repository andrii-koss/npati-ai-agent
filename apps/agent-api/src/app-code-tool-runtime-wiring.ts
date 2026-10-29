import type { FastifyBaseLogger } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import type { AppConfig } from "./app";
import type { AuditLogService } from "./audit-log";
import type { CodeApprovalScopeService } from "./code-approval-scope";
import type { CodeCheckpointPort } from "./code-workspace-checkpoint";
import type { CodeProcessManager } from "./code-process-manager";
import type { CodeProjectTrustService } from "./code-project-trust";
import type { CodeProtectedBranchService } from "./code-protected-branches";
import type { CodeShellRuntime } from "./code-shell-runtime";
import type { CodeSubagentDetachedRunner, CodeSubagentOperationService } from "./code-subagent-operations";
import type { CodeTurnTracker } from "./code-workspace-checkpoint";
import type { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import type { CompanyApprovalsRepository } from "./approvals-repository";
import type { FeatureFlagService } from "./feature-flags";
import type { McpApprovalReleaseReason } from "./mcp-approval";
import type { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import type { PolicyEngine } from "./code-policy-engine";
import type { ProjectGitService } from "./project-git-service";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectService } from "./project-service";
import type { ReadTracker } from "./code-read-tracker";
import type { SecretLeaseProvider } from "./code-secret-lease";
import type { AgentDataStudioService } from "./data-studio/agent-data-service";
import type { createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import type { CodeAsyncProcessService } from "./code-async-process";
import type { createCodeSandboxWiring } from "./code-sandbox-wiring";
import { assertManifestConsistent, currentToolManifest } from "./code-tool-registry";
import { CodeDataRetention } from "./code-data-retention";
import { CodeToolRuntime, createProjectWorkspaceWritePort } from "./code-tool-runtime";
import { createCodePortsWiring } from "./code-ports-wiring";
import { createCodeToolRuntimeWiring } from "./code-tool-runtime-wiring";
import { createCodeToolWiring } from "./code-tool-wiring";
import { DEFAULT_CODE_AGENT_LIMITS } from "./code-agent-config";

export interface AppCodeToolRuntimeWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  systemWorkspaceId: string;
  workspaceStore: WorkspaceStore;
  approvalsRepo?: CompanyApprovalsRepository;
  codeActivitySink: ReturnType<typeof createCodeSandboxWiring>["codeActivitySink"];
  codeProcessManager: CodeProcessManager;
  codeProjectTrust: CodeProjectTrustService;
  codeSandboxExecPort: ReturnType<typeof createCodeSandboxWiring>["codeSandboxExecPort"];
  codeShellRuntime: CodeShellRuntime;
  codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort> | null;
  featureFlagService: FeatureFlagService;
  mcpApprovalPauseRelease:
    | ((input: {
        companyId: string;
        runId: string;
        approvalId: string;
        reason: McpApprovalReleaseReason;
        answeredBy?: string;
      }) => Promise<unknown>)
    | null;
  projectSandbox?: ProjectSandboxService;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  secretLeases: SecretLeaseProvider;
  trackedProcesses?: CodeAsyncProcessService;
  getCodeRunEnvironment: () => unknown;
  providerDataGuardInstance?: unknown;
  agentDataStudioService?: AgentDataStudioService;
  auditLogService?: AuditLogService;
  codeApprovalPort?: unknown;
  codeApprovalScope: CodeApprovalScopeService;
  codeCheckpointPort: CodeCheckpointPort;
  codeProjectWorkspaceWritePort: ReturnType<typeof createProjectWorkspaceWritePort>;
  codeProtectedBranches: CodeProtectedBranchService;
  codeReadTracker: ReadTracker;
  codeService: import("./code-service").CodeService;
  codeTurnTracker: CodeTurnTracker;
  codeWorkspaceRevisions: CodeWorkspaceRevisionGuard;
  enrichedPolicyEngine: PolicyEngine;
  projectGitService: ProjectGitService;
  subagentChildRunnerWithAck?: CodeSubagentDetachedRunner;
  codeSubagentOperationsRef?: (() => CodeSubagentOperationService) | undefined;
  /** Manifest v15: the existing Browser QA service (created after this wiring) and the web-research provider. */
  getProjectBrowserQaService?: () => import("./project-browser-qa-service").ProjectBrowserQaService | undefined;
  projectPreviewService?: import("./project-preview-service").ProjectPreviewService;
  webResearchProvider?: import("./code-tool-executors-assist").CodeAssistToolOptions["webResearch"];
}

export function createAppCodeToolRuntimeWiring(deps: AppCodeToolRuntimeWiringDeps) {
  const {
    config,
    log,
    systemWorkspaceId,
    workspaceStore,
    approvalsRepo,
    codeActivitySink,
    codeProcessManager,
    codeProjectTrust,
    codeSandboxExecPort,
    codeShellRuntime,
    featureFlagService,
    projectSandbox,
    projectService,
    projectWorkspace,
    secretLeases,
    trackedProcesses,
    getCodeRunEnvironment,
    providerDataGuardInstance,
    agentDataStudioService,
    auditLogService,
    codeApprovalPort,
    codeApprovalScope,
    codeCheckpointPort,
    codeProjectWorkspaceWritePort,
    codeProtectedBranches,
    codeReadTracker,
    codeService,
    codeTurnTracker,
    codeWorkspaceRevisions,
    enrichedPolicyEngine,
    projectGitService,
    subagentChildRunnerWithAck,
    codeSubagentOperationsRef,
  } = deps;

  const codeDataRetention = new CodeDataRetention({
    ...(workspaceStore.codeDataLifecycle ? { lifecycle: workspaceStore.codeDataLifecycle } : {}),
    limits: {
      toolResultRetentionDays:
        config.codeAgentLimits?.toolResultRetentionDays ??
        DEFAULT_CODE_AGENT_LIMITS.toolResultRetentionDays,
      transcriptRetentionDays:
        config.codeAgentLimits?.transcriptRetentionDays ??
        DEFAULT_CODE_AGENT_LIMITS.transcriptRetentionDays,
    },
  });

  const ports = createCodePortsWiring({
    config,
    log,
    approvalsRepo,
    codeActivitySink,
    codeDataRetention,
    get codeUserQuestionReaperPort() { return deps.codeUserQuestionReaperPort; },
    get mcpApprovalPauseRelease() { return deps.mcpApprovalPauseRelease; },
    codeProcessManager,
    codeProjectTrust,
    codeSandboxExecPort,
    codeShellRuntime,
    featureFlagService,
    projectSandbox,
    projectService,
    projectWorkspace,
    secretLeases,
    trackedProcesses,
    resolveVerifyCommands: (ctx, companyId, projectId) => codeService.resolveVerifyCommands(ctx,companyId,projectId),
  });
  const {
    codeReaper,
    codeShellRuntimePort,
    codeVerifyRunnerPort,
    CODE_DEPS_MANIFESTS,
    readWorkspaceText,
    codeInstructionsLoader,
    codeHooksService,
  } = ports;

  const codeCommandIds = ["review", "explain", "test", "fix"] as const;

  const codeToolWiring = createCodeToolWiring({
    config,
    log,
    CODE_DEPS_MANIFESTS,
    codeActivitySink,
    codeCommandIds,
    codeInstructionsLoader,
    getCodeRunEnvironment: getCodeRunEnvironment as never,
    codeShellRuntimePort,
    featureFlagService,
    providerDataGuardInstance: providerDataGuardInstance as never,
    readWorkspaceText,
  });
  const { codeCommandRegistry, codeSkillsService, codeDepsPort, describeCodeRunForPullRequest } =
    codeToolWiring;

  let codeToolRuntimeRef: CodeToolRuntime | undefined;

  const codeToolRuntimeWiring = createCodeToolRuntimeWiring({
    agentDataStudioService,
    config,
    log,
    approvalsRepo,
    auditLogService,
    codeActivitySink,
    codeApprovalPort: codeApprovalPort as never,
    codeApprovalScope,
    codeCheckpointPort,
    codeDepsPort,
    codeHooksService,
    codeProjectWorkspaceWritePort,
    codeProtectedBranches,
    codeReadTracker,
    codeSandboxExecPort,
    codeService,
    codeShellRuntimePort,
    codeSubagentOperationsRef,
    codeToolRuntimeRef,
    codeTurnTracker,
    codeVerifyRunnerPort,
    codeWorkspaceRevisions,
    describeCodeRunForPullRequest,
    enrichedPolicyEngine,
    featureFlagService,
    projectGitService,
    projectService,
    projectWorkspace,
    subagentChildRunnerWithAck,
    trackedProcesses,
    workspaceStore,
    ...(deps.getProjectBrowserQaService ? { getProjectBrowserQaService: deps.getProjectBrowserQaService } : {}),
    ...(deps.projectPreviewService ? { projectPreviewService: deps.projectPreviewService } : {}),
    ...(deps.webResearchProvider ? { webResearchProvider: deps.webResearchProvider } : {}),
  });
  const { codeToolRuntime } = codeToolRuntimeWiring;
  codeToolRuntimeRef = codeToolRuntime;

  try {
    assertManifestConsistent();
    const manifest = currentToolManifest();
    void workspaceStore
      .publishCodeToolManifest(
        { workspaceId: systemWorkspaceId, userId: "system", permissions: ["workspace:read"] },
        { version: manifest.version, tools: manifest.tools, checksum: manifest.checksum },
      )
      .catch(() => undefined);
  } catch (error) {
    log.error({ err: error }, "code_tool_manifest_inconsistent");
  }

  return {
    codeDataRetention,
    codeReaper,
    codeShellRuntimePort,
    codeVerifyRunnerPort,
    codeInstructionsLoader,
    codeHooksService,
    codeCommandRegistry,
    codeSkillsService,
    describeCodeRunForPullRequest,
    codeToolRuntime,
    codeToolRuntimeRef,
  };
}
