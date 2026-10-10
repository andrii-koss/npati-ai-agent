/* The code sandbox wiring of app.ts - the sandbox exec port, the secret leases, the protected
 * branches and the declarations between them - extracted in step 2c-6f of docs/refactoring/PLAN.md.
 * Moved verbatim inside a factory that returns everything app.ts still uses.
 */
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
      /**
       * C11 (owner decision 7): the canonical revision the execution environment is about to receive.
       *
       * The sandbox is an execution environment, never a second source of truth, so the question a build has
       * to be able to answer is "which canonical revision did you see?". The revision is read here — the one
       * place a command leaves the API — and **recorded as the sandbox binding**, so the answer is a stored
       * fact rather than a reconstruction, and a later git operation in the same session is compared against
       * the same canonical digest. Reading it is best effort: a workspace that cannot be enumerated must not
       * break a command that previously ran, and "no revision recorded" is reported as exactly that instead
       * of a fabricated one. The fail-closed half is on the git side, where a moved revision is
       * `workspace_revision_mismatch`.
       */
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
  } : undefined;
  /**
   * C4: the sandbox transport lives here and nowhere else. `ProjectSandboxService.execute/process` is
   * the only way a command or a process leaves the API; every rule on top of it — command
   * classification, approvals, the persistent shell session, output limits, one-call secret leases,
   * the process log ring buffer and verify parsing — comes from the canonical modules
   * (`code-shell-runtime.ts`, `code-process-manager.ts`, `code-secret-lease.ts`,
   * `code-verify-parser.ts`). There is exactly one implementation of each policy.
   * Without a sandbox the ports stay absent and every shell tool fails closed (`tool_not_configured`).
   */
  const secretLeases = new SecretLeaseProvider({
    audit: auditLogService,
    /**
     * Owner decision (C4): the credential's environment decides whether a lease may exist at all.
     * `development`/`staging` are leasable, `unknown` needs an explicit admin override (allowlist +
     * owner/admin + audit), and `production` is never leased. The repository is the authoritative
     * source: its answer wins over any environment marker that arrives with the tool call, so a caller
     * cannot downgrade a production credential by claiming it is a development one.
     */
    resolveCredential: browserCredentials
      ? async (context, companyId, credentialId) => browserCredentials!.describe(context, companyId, credentialId)
      : undefined,
    /**
     * C11 (owner decision 6): the value access the **host** git delivery target needs. Adding it does not
     * enable tmpfs delivery (`materializeFile` also requires `writeSecretFile`, which stays unwired), and
     * the value is only ever read through `SecretLeaseProvider.hostProcessValue`, i.e. for a lease issued
     * with `target: "hostProcess"` and consumed exactly once.
     */
    resolveField: browserCredentials
      ? async (context, companyId, credentialId, field) => {
          const fields = await browserCredentials!.resolve(context, companyId, credentialId);
          const value = fields?.[field];
          return typeof value === "string" ? value : null;
        }
      : undefined,
  });
  /**
   * C11 (owner decision 6): the host-git credential lease. One lease per git operation; the value is read
   * once, used only in the process-scoped environment of that single `git` invocation (see
   * `ProjectGitService.credentialEnvironment`) and revoked by the caller in a `finally`. The lease is
   * issued for `target: "hostProcess"`, which `environmentReferences` refuses — so the same credential can
   * never be delivered into an agent shell's environment.
   */
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
        // A lease that could not be redeemed is revoked immediately: no window in which it stays active.
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
  // C4b (owner decision): the **sandbox runner** is the authoritative component for network enforcement,
  // because it owns the Docker daemon and creates the run network. This process therefore does not probe
  // Docker itself; it asks the runner through an authenticated readiness endpoint and caches the verdict
  // for a short TTL (≤30 s). The `NPATI_SANDBOX_EGRESS_ENFORCED` flag can only switch the feature off —
  // it is never a source of `true`. The local `EgressEnforcement` object stays only for the in-process
  // (no-runner) mode, where this process is the sandbox host itself.
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
  // Refresh the runner verdict so the synchronous policy hook always reads a fresh value.
  const runnerReadinessTimer = runnerReadiness
    ? setInterval(() => { void runnerReadiness.check(true).catch(() => undefined); }, runnerReadiness.ttlMs)
    : undefined;
  runnerReadinessTimer?.unref();
  if (runnerReadiness) void runnerReadiness.check(true).catch(() => undefined);
  // C6b: every Activity event is persisted **and** logged. The sink is the single write path, so the
  // snapshot reference and the metadata-only guarantees live in one place instead of in each caller.
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
  /**
   * C5: scoped approval rules. Every change is audited **before** it is applied (fail closed), so the
   * adapter below is deliberately synchronous with the audit call: no journal, no rule.
   */
  const codeApprovalScope = new CodeApprovalScopeService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId, actor: input.actor, actorRole: "owner", action: input.action,
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
  // C5: structured Activity events for policy decisions (the run-level stream and its
  // ExecutionSnapshot arrive with C6/C6b; until then the sink is the structured log, exactly like the
  // C4 tool activity and the C4b network decision events).
  const policyDecisionActivity = new PolicyDecisionRecorder({
    sink: activitySinkForKind(codeActivitySink, "policy_decision"),
  });
  /**
   * C5a: production operations. `code.prod.operate` is named by no default role, agents and service
   * identities are refused outright, step-up is required by default (two-person is configuration), and the
   * platform executor is the `Null` implementation until the real deploy/promote provider is wired — so a
   * production operation today ends in `production_executor_unavailable` (503) instead of a half-executed
   * deploy. Every step is audited before it is applied.
   */
  const codePrivilegedAudit: CodePrivilegedAuditPort | undefined = auditLogService
    ? {
        record: async (input) => {
          await auditLogService.record(
            { workspaceId: input.workspaceId ?? systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
            {
              companyId: input.companyId,
              actor: input.actor,
              actorRole: "owner",
              action: input.action,
              resourceType: input.resourceType,
              resourceId: input.resourceId,
              decision: input.decision === "deny" ? "denied" : "allowed",
              ...(input.payloadHash ? { payload: { payload_hash: input.payloadHash } } : {}),
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
  /**
   * The production routes take a synchronous context accessor while authentication is async, so the context
   * is resolved once in a path-scoped preHandler (same pattern as the session-mode routes) and read back
   * synchronously: no other route authenticates twice or changes behaviour.
   */
  const codeProductionContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/production-operations(\/request|\/confirm)?$/.test(request.url.split("?")[0] ?? "")) return;
    codeProductionContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeProductionRoutes(app, {
    service: codeProductionOperations,
    getAuthContext: (request) => codeProductionContexts.get(request as object) ?? null,
  });
  /**
   * C5a (owner decision): unattended automations run as a **service identity** limited to the permission
   * inventory in `code-service-identity.ts`, not as the owner with a fixed wide permission set. The
   * allowlist can only be narrowed by configuration; production permissions are rejected and reported.
   */
  const automationAllowedPermissions = resolveAutomationAllowedPermissions(process.env);
  if (automationAllowedPermissions.rejected.length) {
    log.warn({ rejected: automationAllowedPermissions.rejected }, "code_automation_permissions_rejected");
  }
  /**
   * C5a: company membership is the authorisation anchor (user -> company -> project -> session). The store
   * implements the `CodeMembershipStore` port directly, so no adapter is needed; the membership audit
   * entries go to the same journal as the other C5a privileged writes (and without that journal a
   * membership change refuses rather than happening unaudited).
   *
   * Constructed here (rather than next to `registerCodeMembershipRoutes` below) because the protected
   * branch policy needs the company role resolver, and the PolicyEngine needs that policy: the order is
   * membership -> protected branches -> policy engine, so the engine is built with the real port and no
   * late wiring is involved.
   */
  const codeMembership = new CodeMembershipService({
    store: workspaceStore,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    logger: log,
  });
  /**
   * C5a: the protected-branch policy is company policy stored through its own port (not in
   * `Company.memory`, which the generic company PATCH route can rewrite without an owner check or an
   * audit entry). `codeStepUp` is only consulted when the step-up hook is configured; the confirmation
   * flow itself stays in `code-step-up.ts`.
   */
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
