import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AppConfig } from "./app";
import type { AuditLogService } from "./audit-log";
import type { AuthProvider } from "./auth";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import type { CompanyApprovalsRepository } from "./approvals-repository";
import type { createCoreServices } from "./core-services";
import type { FeatureFlagService } from "./feature-flags";
import type { GitWriteIntent } from "./code-git-write-policy";
import type { HostGitCredentialPort, ProjectGitService } from "./project-git-service";
import type { McpIntegrationSource } from "./mcp-runtime-transport";
import type { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import type { ProjectSandboxService } from "./project-sandbox-service";
import { activitySinkForKind } from "./code-run-activity-sink";
import { approvalsBackedPort, codeCheckpointPortFromGit, CodeTurnTracker, resolveTurnTrackingOptions } from "./code-workspace-checkpoint";
import { createCodePolicyWiring } from "./code-policy-wiring";
import { createCodeSandboxWiring } from "./code-sandbox-wiring";
import { createEnrichedPolicyEngineWiring } from "./enriched-policy-engine-wiring";
import { createMcpRuntimeRunPath, readMcpRuntimeManifest } from "./mcp-run-path";
import { createProjectWorkspaceWritePort } from "./code-tool-runtime";
import { groupForCapability } from "./code-capability-groups";
import { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import { McpRuntimeTransport } from "./mcp-runtime-transport";
import { McpToolPolicyStore } from "./mcp-tool-policy-repository";
import { ReadTracker, resolveReadTrackerOptions } from "./code-read-tracker";
import { resolveAllowlistForPhase } from "./egress-allowlist";
import { resolveApprovalPolicy } from "./code-edit-approval";
import { createAppCodePolicyWiring } from "./app-code-policy-wiring";

export interface AppCodeEngineWiringDeps {
  app: FastifyInstance;
  config: AppConfig;
  log: FastifyBaseLogger;
  systemWorkspaceId: string;
  agent: ReturnType<typeof createCoreServices>["agent"];
  auditLogService?: AuditLogService;
  authProvider: AuthProvider;
  browserCredentials?: BrowserCredentialsRepository;
  codeWorkspaceRevisions: CodeWorkspaceRevisionGuard;
  featureFlagService: FeatureFlagService;
  projectGitService: ProjectGitService;
  projectSandbox?: ProjectSandboxService;
  projectWorkspace: MountedWorkspaceProvider;
  sandboxRunnerSecret?: string;
  sandboxRunnerUrl?: string;
  workspaceStore: WorkspaceStore;
  approvalsRepo?: CompanyApprovalsRepository;
  getMcpIntegrationSource: () => McpIntegrationSource | null;
}

export function createAppCodeEngineWiring(deps: AppCodeEngineWiringDeps) {
  const {
    app,
    config,
    log,
    systemWorkspaceId,
    agent,
    approvalsRepo,
    auditLogService,
    authProvider,
    browserCredentials,
    codeWorkspaceRevisions,
    featureFlagService,
    projectGitService,
    projectSandbox,
    projectWorkspace,
    sandboxRunnerSecret,
    sandboxRunnerUrl,
    workspaceStore,
    getMcpIntegrationSource,
  } = deps;

  const codeReadTracker = new ReadTracker(resolveReadTrackerOptions());
  const codeTurnTracker = new CodeTurnTracker(resolveTurnTrackingOptions());

  const codeCheckpointPort = codeCheckpointPortFromGit({
    readCheckpointFile: (ctx, companyId, projectId, checkpointId, path) =>
      projectGitService.readCheckpointFile(ctx, companyId, projectId, checkpointId, path),
    createCheckpoint: (ctx, companyId, projectId, input) =>
      projectGitService.createCheckpoint(ctx, companyId, projectId, input),
    restoreCheckpoint: (ctx, companyId, projectId, checkpointId, restoreOptions) =>
      projectGitService.restoreCheckpoint(ctx, companyId, projectId, checkpointId, restoreOptions),
    diff: (ctx, companyId, projectId, diffOptions) =>
      projectGitService.diff(ctx, companyId, projectId, diffOptions),
    isLargeChange: (ctx, companyId, projectId) =>
      projectGitService.isLargeChange(ctx, companyId, projectId),
  });

  const codeApprovalPort = approvalsRepo
    ? approvalsBackedPort(approvalsRepo, { defaultTtlMs: resolveApprovalPolicy().ttlMs })
    : undefined;

  const codeProjectWorkspaceWritePort = createProjectWorkspaceWritePort({
    writeFile: (ctx, companyId, projectId, filePath, content, expectedRevision) =>
      projectWorkspace.writeFile(ctx, companyId, projectId, filePath, content, expectedRevision),
    createFile: (ctx, companyId, projectId, filePath, content, workspaceId, agentId, mode) =>
      projectWorkspace.createFile(ctx, companyId, projectId, filePath, content, workspaceId, agentId, mode),
    editFile: (ctx, companyId, projectId, filePath, find, replacement, expectedRevision) =>
      projectWorkspace.editFile(ctx, companyId, projectId, filePath, find, replacement, expectedRevision),
    moveFile: (ctx, companyId, projectId, from, to, expectedRevision) =>
      projectWorkspace.moveFile(ctx, companyId, projectId, from, to, expectedRevision),
    deleteFile: (ctx, companyId, projectId, filePath, workspaceId, agentId, expectedRevision) =>
      projectWorkspace.deleteFile(ctx, companyId, projectId, filePath, workspaceId, agentId, expectedRevision),
  });

  const sandboxWiring = createCodeSandboxWiring({
    config,
    log,
    app,
    systemWorkspaceId,
    agent,
    auditLogService,
    authProvider,
    browserCredentials,
    codeWorkspaceRevisions,
    projectSandbox,
    sandboxRunnerSecret,
    sandboxRunnerUrl,
    workspaceStore,
  });

  const {
    codeSandboxExecPort,
    secretLeases,
    runnerReadiness,
    egressEnforcement,
    runnerReadinessTimer,
    codeActivitySink,
    networkActivity,
    egressAllowlist,
    codeApprovalScope,
    policyDecisionActivity,
    codePrivilegedAudit,
    automationAllowedPermissions,
    codeMembership,
    codeProtectedBranches,
    hostGitCredentialLease,
  } = sandboxWiring;

  const codeGitPolicyBoundary = {
    assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) =>
      codeProtectedBranches.assertGitWriteAllowed(ctx, companyId, input),
  };

  const mcpToolPolicyStore = new McpToolPolicyStore(config.databaseUrl);
  app.addHook("onClose", async () => {
    await mcpToolPolicyStore.close();
  });

  const mcpRuntimeCapabilities = new McpRuntimeCapabilityStore({ policies: mcpToolPolicyStore });
  const mcpRuntimeTransport = new McpRuntimeTransport({
    allowlist: () => resolveAllowlistForPhase("run", egressAllowlist),
  });

  const readRuntimeMcpManifest = (tenant: { workspaceId: string; companyId: string }) =>
    readMcpRuntimeManifest(mcpRuntimeCapabilities, tenant);

  const { policyEngine } = createCodePolicyWiring({
    config,
    log,
    systemWorkspaceId,
    agent,
    approvalsRepo,
    codeApprovalScope,
    codeProtectedBranches,
    egressEnforcement,
    featureFlagService,
    mcpRuntimeCapabilities,
    policyDecisionActivity,
    runnerReadiness,
    workspaceStore,
  });

  const codePolicyWiring = createAppCodePolicyWiring({
    app,
    config,
    systemWorkspaceId,
    workspaceStore,
    auditLogService,
    authProvider,
    codeMembership,
    codeProtectedBranches,
    codePrivilegedAudit,
    log,
  });
  const {
    codeProjectTrust,
    codeSessionModes,
    codeDataPolicy,
    codeDataPolicyStoreService,
    engineDataPolicyResolver,
    refreshOutboundPolicySnapshot,
  } = codePolicyWiring;

  const codeGroupsForAgent = (tools: readonly string[] | undefined): string[] => {
    const groups = new Set<string>();
    for (const tool of tools ?? []) {
      const group = groupForCapability(tool);
      if (group) groups.add(group);
    }
    return [...groups];
  };

  const enrichedPolicyEngineWiring = createEnrichedPolicyEngineWiring({
    config,
    log,
    policyEngine,
    agent,
    codeGroupsForAgent,
    codeProjectTrust,
    codeMembership,
    workspaceStore,
  });
  const { enrichedPolicyEngine } = enrichedPolicyEngineWiring;

  const mcpRunPath = createMcpRuntimeRunPath({
    store: mcpRuntimeCapabilities,
    transport: mcpRuntimeTransport,
    source: () => getMcpIntegrationSource(),
    flags: featureFlagService,
    policy: enrichedPolicyEngine,
    activity: activitySinkForKind(codeActivitySink, "run_activity"),
    logger: { warn: (message, meta) => log.warn(meta ?? {}, message) },
  });

  const discoverRuntimeMcpCapabilities = (ctx: AuthContext, companyId: string) =>
    mcpRunPath.discover(ctx, companyId);

  return {
    codeReadTracker,
    codeTurnTracker,
    codeCheckpointPort,
    codeApprovalPort,
    codeProjectWorkspaceWritePort,
    sandboxWiring,
    hostGitCredentialLease,
    codeGitPolicyBoundary,
    mcpToolPolicyStore,
    mcpRuntimeCapabilities,
    mcpRuntimeTransport,
    readRuntimeMcpManifest,
    policyEngine,
    enrichedPolicyEngine,
    mcpRunPath,
    discoverRuntimeMcpCapabilities,
    codeSandboxExecPort,
    secretLeases,
    runnerReadiness,
    egressEnforcement,
    runnerReadinessTimer,
    codeActivitySink,
    networkActivity,
    egressAllowlist,
    codeApprovalScope,
    policyDecisionActivity,
    codePrivilegedAudit,
    automationAllowedPermissions,
    codeMembership,
    codeProtectedBranches,
    codeProjectTrust,
    codeSessionModes,
    codeDataPolicy,
    codeDataPolicyStoreService,
    engineDataPolicyResolver,
    refreshOutboundPolicySnapshot,
  };
}
