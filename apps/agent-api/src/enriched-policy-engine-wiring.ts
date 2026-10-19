import { permissionsForCompanyRole, type CodeMembershipService } from "./code-membership";
import { classifyPrincipal, CODE_PRIVILEGED_PERMISSIONS, hasAdminPermission } from "./code-rbac";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { PolicyEngine } from "./code-policy-engine";
import { CodeProjectTrustService } from "./code-project-trust";
import { createCoreServices } from "./core-services";
import { createCodePolicyWiring } from "./code-policy-wiring";

export interface CreateEnrichedPolicyEngineWiringDeps {
  config: AppConfig;
  policyEngine: ReturnType<typeof createCodePolicyWiring>["policyEngine"];
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  codeGroupsForAgent: (tools: readonly string[] | undefined) => string[];
  codeProjectTrust: CodeProjectTrustService;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  codeMembership: Pick<CodeMembershipService, "resolveRoleForUser">;
}

export function createEnrichedPolicyEngineWiring(deps: CreateEnrichedPolicyEngineWiringDeps) {
  const { config, log, policyEngine, agent, codeGroupsForAgent, codeProjectTrust, workspaceStore, codeMembership } = deps;
  const enrichedPolicyEngine: PolicyEngine = Object.assign(Object.create(Object.getPrototypeOf(policyEngine)) as PolicyEngine, {
    evaluate: async (request: Parameters<PolicyEngine["evaluate"]>[0]) => {
      const enriched = { ...request } as typeof request;
      // Re-read human Company membership per call; a running session is not an authority cache.
      // Lookup failure or revoked membership yields no permission. Never widen the initiating token.
      if (classifyPrincipal(request.ctx) === "user") {
        const role = await codeMembership.resolveRoleForUser(request.ctx, request.companyId).catch(() => null);
        const original = request.ctx.permissions ?? [];
        const permissions = permissionsForCompanyRole(role).filter(permission => original.includes(permission)
          || (!CODE_PRIVILEGED_PERMISSIONS.some(privileged => privileged === permission) && hasAdminPermission(original)));
        enriched.ctx = { ...request.ctx, permissions };
      }
      if (enriched.agentId) {
        const agent = await workspaceStore.getCompanyAgent(enriched.ctx, request.companyId, enriched.agentId).catch(() => null);
        const groups = codeGroupsForAgent((agent as { tools?: string[] } | null)?.tools);
        if (groups.length) {
          enriched.capabilityGroups = {
            agentCapabilityGroups: groups,
            userPermissions: enriched.ctx.permissions ?? [],
            projectRules: null,
          };
        }
      }
      if (enriched.requiresProjectTrust === true && enriched.projectTrusted === undefined && request.projectId) {
        enriched.projectTrusted = await codeProjectTrust
          .isTrusted(request.ctx, request.companyId, request.projectId)
          .catch(() => false);
      }
      return policyEngine.evaluate(enriched);
    },
  });

  return {
    enrichedPolicyEngine,
  };
}
