import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AppConfig } from "./app";
import type { AuditLogService } from "./audit-log";
import type { AuthProvider } from "./auth";
import type { CodeMembershipService } from "./code-membership";
import type { CodeProtectedBranchService } from "./code-protected-branches";
import type { CodePrivilegedAuditPort } from "./code-step-up";
import { CodeProjectTrustService } from "./code-project-trust";
import { CodeSessionModeService, registerCodeSessionModeRoutes } from "./code-session-mode-routes";
import { createCodeSessionWiring } from "./code-session-wiring";
import { registerCodeMembershipRoutes } from "./code-membership-routes";
import { ProviderDataPolicyService, type ProviderDataClassification } from "./provider-data-policy";
import {
  createEnginePolicyResolver,
  OutboundPolicySnapshot,
  resolveOutboundPolicyFromSnapshot,
  type ProviderDataPolicyLookupPort,
} from "./provider-data-policy-resolver";
import { createOutboundGuard, setOutboundGuard } from "./outbound-exfiltration-guard";
import { ProviderDataPolicyAdminService } from "./provider-data-policy-service";
import { registerCodeDataPolicyRoutes } from "./code-data-policy-routes";

export interface AppCodePolicyWiringDeps {
  app: FastifyInstance;
  config: AppConfig;
  systemWorkspaceId: string;
  workspaceStore: WorkspaceStore;
  auditLogService?: AuditLogService;
  authProvider: AuthProvider;
  codeMembership: CodeMembershipService;
  codeProtectedBranches: CodeProtectedBranchService;
  codePrivilegedAudit?: CodePrivilegedAuditPort;
  log: FastifyBaseLogger;
}

export function createAppCodePolicyWiring(deps: AppCodePolicyWiringDeps) {
  const {
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
  } = deps;

  const codeProjectTrust = new CodeProjectTrustService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId,
                actor: input.actor,
                actorRole: await auditLogService.resolveActorRole(input.companyId, input.actor),
                action: input.action,
                resourceType: "code_project_trust",
                resourceId: input.resourceId,
                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
  });

  const codeSessionModes = new CodeSessionModeService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId,
                actor: input.actor,
                actorRole: await auditLogService.resolveActorRole(input.companyId, input.actor),
                action: input.action,
                resourceType: "code_session",
                resourceId: input.resourceId,
                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
    suggestionSink: async (suggestion) => {
      log.info(suggestion, "code_session_mode_suggestion");
    },
    logger: log,
  });

  const codeSessionModeContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/sessions\/[^/]+\/mode(\/suggest)?$/.test(request.url.split("?")[0] ?? "")) return;
    codeSessionModeContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeSessionModeRoutes(app, {
    store: workspaceStore,
    service: codeSessionModes,
    getAuthContext: (request) => codeSessionModeContexts.get(request as object) ?? null,
  });

  const codeSessionWiring = createCodeSessionWiring({
    config,
    log,
  });
  const { codeMembershipContexts } = codeSessionWiring;
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/(?:members(?:\/|$)|protected-branches(?:\/|$))/.test(request.url.split("?")[0] ?? "")) return;
    codeMembershipContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeMembershipRoutes(app, {
    service: codeMembership,
    protectedBranches: codeProtectedBranches,
    getAuthContext: (request) => codeMembershipContexts.get(request as object) ?? null,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    findInviteCompanyId: async (tokenHash) =>
      (await workspaceStore.findCompanyInviteByTokenHash(tokenHash))?.companyId ?? null,
    logger: log,
  });

  const codeDataPolicyAudit = codePrivilegedAudit
    ? {
        record: async (input: {
          action: string;
          actor: string;
          companyId: string | null;
          resourceType: string;
          resourceId: string;
          metadata?: Record<string, unknown>;
        }) => {
          await codePrivilegedAudit.record({
            action: input.action,
            actor: input.actor,
            companyId: input.companyId ?? systemWorkspaceId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            metadata: input.metadata ?? {},
          });
        },
      }
    : undefined;
  const codeDataPolicyStoreService = new ProviderDataPolicyService({
    store: workspaceStore,
    ...(codeDataPolicyAudit ? { audit: codeDataPolicyAudit } : {}),
  });

  let refreshOutboundSnapshot: () => void;
  const invalidationWrappedDataPolicyService = new Proxy(codeDataPolicyStoreService, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      if (!/^(?:upsert|update|create|delete|set|revoke|grant)/.test(property)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...args: unknown[]) => unknown).apply(target, args);
        refreshOutboundSnapshot?.();
        return result;
      };
    },
  });

  const engineDataPolicyResolver = createEnginePolicyResolver(
    workspaceStore as unknown as ProviderDataPolicyLookupPort,
  );

  const outboundPolicySnapshot = new OutboundPolicySnapshot(
    workspaceStore as unknown as ProviderDataPolicyLookupPort,
  );
  refreshOutboundSnapshot = () => {
    void outboundPolicySnapshot.refresh().catch((error) => {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "outbound_policy_snapshot_refresh_failed",
      );
    });
  };

  setOutboundGuard(
    createOutboundGuard({
      resolvePolicy: (channel, context) => {
        if (context?.companyId && context.companyId !== outboundPolicySnapshot.getActiveContext()?.companyId) {
          outboundPolicySnapshot.setActiveContext({
            companyId: context.companyId,
            ...(context.projectId ? { projectId: context.projectId } : {}),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.dataClassification ? { dataClassification: context.dataClassification } : {}),
          });
          refreshOutboundSnapshot();
        } else if (context?.companyId) {
          outboundPolicySnapshot.setActiveContext({
            companyId: context.companyId,
            ...(context.projectId ? { projectId: context.projectId } : {}),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.dataClassification ? { dataClassification: context.dataClassification } : {}),
          });
        }
        const resolution = resolveOutboundPolicyFromSnapshot(outboundPolicySnapshot, channel);
        if (!resolution) return null;
        if (resolution.kind === "policy") return resolution.resolved.policy;
        return { code: resolution.code, reason: resolution.reason };
      },
      resolveProjectClassification: (_channel, context) => context?.dataClassification,
      record: (event) => {
        log.info(event, "outbound_decision");
      },
    }),
  );
  refreshOutboundSnapshot();
  const outboundSnapshotTimer = setInterval(refreshOutboundSnapshot, 60_000);
  outboundSnapshotTimer.unref?.();

  const codeDataPolicy = new ProviderDataPolicyAdminService({
    store: workspaceStore,
    policies: invalidationWrappedDataPolicyService,
    resolveRole: (context, companyId) => codeMembership.resolveRoleForUser(context, companyId),
    projectClassification: {
      readProjectClassification: async (context, companyId, projectId) => {
        const project = await workspaceStore.getProject(context, companyId, projectId);
        return (project?.dataClassification as ProviderDataClassification | undefined) ?? null;
      },
    },
    rbac: { ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}), logger: log },
    activity: {
      record: (event) => {
        log.info(event, "provider_policy_decision");
      },
    },
    logger: log,
  });

  const codeDataPolicyContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/data-policy(?:\/|$)/.test(request.url.split("?")[0] ?? "")) return;
    codeDataPolicyContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeDataPolicyRoutes(app, {
    service: codeDataPolicy,
    getAuthContext: (request) => codeDataPolicyContexts.get(request as object) ?? null,
  });

  return {
    codeProjectTrust,
    codeSessionModes,
    codeDataPolicy,
    codeDataPolicyStoreService,
    engineDataPolicyResolver,
    outboundPolicySnapshot,
    refreshOutboundPolicySnapshot: refreshOutboundSnapshot,
    outboundSnapshotTimer,
  };
}
