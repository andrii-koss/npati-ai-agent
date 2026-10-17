
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { createAuditServices } from "./audit-services";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { CodeApprovalScopeService } from "./code-approval-scope";
import { CodeMembershipService } from "./code-membership";
import { registerCodeMembershipRoutes } from "./code-membership-routes";
import { PolicyEngine } from "./code-policy-engine";
import { CodeProductionOperations, NullProductionExecutor, registerCodeProductionRoutes } from "./code-prod-operations";
import { CodeProtectedBranchRepository, CodeProtectedBranchService, resolveProtectedBranchGuardConfig } from "./code-protected-branches";
import { CodeRbac } from "./code-rbac";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { SecretLeaseProvider } from "./code-secret-lease";
import { resolveAutomationAllowedPermissions } from "./code-service-identity";
import { CodePrivilegedAuditPort, CodeStepUp, resolveStepUpConfig } from "./code-step-up";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { createCoreServices } from "./core-services";
import { resolveEgressAllowlist, toProxyAllowedHosts } from "./egress-allowlist";
import { NetworkActivityRecorder } from "./network-activity";
import { PolicyDecisionRecorder } from "./policy-decision-activity";
import { ProjectGitService } from "./project-git-service";
import { ProjectSandboxService } from "./project-sandbox-service";
import { resolveEgressEnforcement } from "./sandbox-egress-enforcement";
import { RunnerReadinessClient, resolveRunnerReadinessTtl } from "./sandbox-runner-readiness-client";
import { AuthContext, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "@npati/workspace";
import type { HostGitCredentialPort } from "./project-git-service";

export interface CreateCodeSandboxWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  app: FastifyInstance;
  agent: ReturnType<typeof createCoreServices>["agent"];
  auditLogService: ReturnType<typeof createAuditServices>["auditLogService"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  browserCredentials: BrowserCredentialsRepository | undefined;
  codeWorkspaceRevisions: CodeWorkspaceRevisionGuard;
  projectSandbox: ProjectSandboxService | undefined;
  sandboxRunnerSecret: string | undefined;
  sandboxRunnerUrl: string | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  systemWorkspaceId: string;
}

export function createCodeSandboxWiring(deps: CreateCodeSandboxWiringDeps) {
  const { config, log, app, agent, auditLogService, authProvider, browserCredentials, codeWorkspaceRevisions, projectSandbox, sandboxRunnerSecret, sandboxRunnerUrl, workspaceStore, systemWorkspaceId } = deps;
  let hostGitCredentialLease: HostGitCredentialPort | null;
  const codeSandboxExecPort = projectSandbox ? {
    execute: async (ctx: AuthContext, companyId: string, request: { projectId: string; command: string; cwd?: string; timeoutMs?: number }) => {

      try {
        const snapshot = await codeWorkspaceRevisions.capture({ ctx, companyId, projectId: request.projectId, sessionId: null });
        codeWorkspaceRevisions.recordSandboxBinding(
          { ctx, companyId, projectId: request.projectId, sessionId: null },
          snapshot.revision,
          "sandbox_exec",
        );
      } catch (error) {
        log.warn({ err: error, projectId: request.projectId }, "code_sandbox_revision_unavailable");
      }
      const terminalRequest = { projectId: request.projectId, command: request.command, agentId: "system", ...(request.cwd ? { cwd: request.cwd } : {}) };
      const result = await projectSandbox!.execute(ctx, companyId, terminalRequest);
      const shaped = result as { stdout?: string; output?: string; exitCode?: number };
      return { stdout: shaped?.stdout ?? shaped?.output ?? "", exitCode: shaped?.exitCode };
    },
    search: async (
      ctx: AuthContext,
      companyId: string,
      request: {
        projectId: string;
        query: string;
        path?: string;
        maxResults?: number;
        timeoutMs?: number;
        glob?: string;
        type?: string;
        ignoreCase?: boolean;
        fixedStrings?: boolean;
        contextLines?: number;
      },
    ) => {
      return projectSandbox!.search(ctx, companyId, request);
    },
  } : undefined;

  const secretLeases = new SecretLeaseProvider({
    audit: auditLogService,

    resolveCredential: browserCredentials
      ? async (context, companyId, credentialId) => browserCredentials!.describe(context, companyId, credentialId)
      : undefined,

    resolveField: browserCredentials
      ? async (context, companyId, credentialId, field) => {
          const fields = await browserCredentials!.resolve(context, companyId, credentialId);
          const value = fields?.[field];
          return typeof value === "string" ? value : null;
        }
      : undefined,
  });

  hostGitCredentialLease = {
    acquire: async ({ ctx, companyId, projectId, credentialId, toolCallId, purpose }) => {
      const sessionId = `git:${projectId}`;
      const lease = await secretLeases.issue(ctx, {
        companyId,
        projectId,
        sessionId,
        purpose,
        toolCallId,
        variableName: "NPATI_GIT_TOKEN",
        credentialId,
        field: "token",
        target: "hostProcess",
      });
      try {
        const value = await secretLeases.hostProcessValue(ctx, lease.leaseId, toolCallId, sessionId);
        return { leaseId: lease.leaseId, value: value.value };
      } catch (error) {

        await secretLeases.revoke(lease.leaseId, "acquire_failed").catch(() => undefined);
        throw error;
      }
    },
    revoke: async (leaseId, reason) => {
      await secretLeases.revoke(leaseId, reason).catch(() => undefined);
    },
  };

  /**
   * C4 (owner decision): every code tool execution decision passes through this single server-side
   * engine, in this fixed phase order — the long form of the same list is the engine's header comment
   * (`code-policy-engine.ts`), which is where the order is defined:
   *   1 feature_flag -> 2 rbac -> 3 capability -> 4 capability_groups -> 5 trust -> 6 hard_deny ->
   *   7 session_mode -> 8 project_rules -> 9 network_enforcement -> 10 approval -> 11 risk_classification
   * A direct API or tool call cannot skip it: the shell runtime refuses to run anything when no
   * policy engine is injected.
   */
  const runnerReadiness = sandboxRunnerUrl && sandboxRunnerSecret
    ? new RunnerReadinessClient({
        baseUrl: sandboxRunnerUrl,
        secret: sandboxRunnerSecret,
        ttlMs: resolveRunnerReadinessTtl(process.env),
        timeoutMs: Number.parseInt(process.env.NPATI_SANDBOX_RUNNER_READINESS_TIMEOUT_MS ?? "4000", 10) || 4_000,
        enabled: process.env.NPATI_SANDBOX_EGRESS_ENFORCED !== "false",
        transport: (globalThis as { fetch?: typeof fetch }).fetch,
      })
    : undefined;
  const egressEnforcement = resolveEgressEnforcement(process.env, {
    log: (event, details) => log.warn({ event, ...details }, "egress_enforcement"),
  });

  const runnerReadinessTimer = runnerReadiness
    ? setInterval(() => { void runnerReadiness.check(true).catch(() => undefined); }, runnerReadiness.ttlMs)
    : undefined;
  runnerReadinessTimer?.unref();
  if (runnerReadiness) void runnerReadiness.check(true).catch(() => undefined);

  const codeActivitySink = createCodeRunActivitySink({
    store: workspaceStore,
    workspaceId: systemWorkspaceId,
    classification: {
      resolve: () => ({ dataClassification: DEFAULT_DATA_CLASSIFICATION, retentionClass: DEFAULT_RETENTION_CLASS }),
    },
    log: (event, message) => { log.info(event, message); },
  });
  const networkActivity = new NetworkActivityRecorder({
    sink: activitySinkForKind(codeActivitySink, "network_decision"),
  });
  const egressAllowlist = resolveEgressAllowlist();
  log.info({ proxyHosts: toProxyAllowedHosts(egressAllowlist) }, "egress_allowlist_configured");

  const codeApprovalScope = new CodeApprovalScopeService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId, actor: input.actor, actorRole: await auditLogService.resolveActorRole(input.companyId, input.actor), action: input.action,
                resourceType: "code_approval_rule", resourceId: input.target, decision: "allowed",
                payload: { action: input.action, target: input.target },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
    logger: log,
  });

  const policyDecisionActivity = new PolicyDecisionRecorder({
    sink: activitySinkForKind(codeActivitySink, "policy_decision"),
  });

  const codePrivilegedAudit: CodePrivilegedAuditPort | undefined = auditLogService
    ? {
        record: async (input) => {
          await auditLogService.record(
            { workspaceId: input.workspaceId ?? systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
            {
              companyId: input.companyId,
              actor: input.actor,
              actorRole: await auditLogService.resolveActorRole(input.companyId, input.actor),
              action: input.action,
              resourceType: input.resourceType,
              resourceId: input.resourceId,
              decision: input.decision === "deny" ? "denied" : "allowed",
              ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
              metadata: input.metadata ?? {},
            },
          );
        },
      }
    : undefined;
  const codeStepUp = new CodeStepUp({
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    config: resolveStepUpConfig(process.env),
    logger: log,
  });
  const codeProductionOperations = new CodeProductionOperations({
    rbac: new CodeRbac({ ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}), logger: log }),
    stepUp: codeStepUp,
    executor: new NullProductionExecutor(),
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    logger: log,
  });

  const codeProductionContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/production-operations(\/request|\/confirm)?$/.test(request.url.split("?")[0] ?? "")) return;
    codeProductionContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeProductionRoutes(app, {
    service: codeProductionOperations,
    getAuthContext: (request) => codeProductionContexts.get(request as object) ?? null,
  });

  const automationAllowedPermissions = resolveAutomationAllowedPermissions(process.env);
  if (automationAllowedPermissions.rejected.length) {
    log.warn({ rejected: automationAllowedPermissions.rejected }, "code_automation_permissions_rejected");
  }

  const codeMembership = new CodeMembershipService({
    store: workspaceStore,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    logger: log,
  });

  const codeProtectedBranches = new CodeProtectedBranchService({
    store: new CodeProtectedBranchRepository(config.databaseUrl ? (workspaceStore as any)?.pool : undefined),
    resolveRole: (context, companyId) => codeMembership.resolveRoleForUser(context, companyId),
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    stepUp: codeStepUp,
    guard: resolveProtectedBranchGuardConfig(process.env),
    logger: log,
  });

  return {
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
  };
}
