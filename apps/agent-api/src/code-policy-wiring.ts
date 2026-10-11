
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { AuthContext, AuthContext as _AuthContext } from "@npati/workspace";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { CodeApprovalScopeService } from "./code-approval-scope";
import { PolicyEngine, isAgentPrincipal, matrixModeFor } from "./code-policy-engine";
import { CodeProtectedBranchService } from "./code-protected-branches";
import { classifyShellCommand } from "./code-shell-classifier";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { createCoreServices } from "./core-services";
import { FeatureFlagService } from "./feature-flags";
import { McpRuntimeCapabilityStore, lookupCapability } from "./mcp-runtime-capabilities";
import { PolicyDecisionRecorder } from "./policy-decision-activity";
import { resolveEgressEnforcement } from "./sandbox-egress-enforcement";
import { RunnerReadinessClient } from "./sandbox-runner-readiness-client";

export interface CreateCodePolicyWiringDeps {
  config: AppConfig;
  systemWorkspaceId: string;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  approvalsRepo: CompanyApprovalsRepository | undefined;
  codeApprovalScope: CodeApprovalScopeService;
  codeProtectedBranches: CodeProtectedBranchService;
  egressEnforcement: ReturnType<typeof resolveEgressEnforcement>;
  featureFlagService: FeatureFlagService;
  mcpRuntimeCapabilities: McpRuntimeCapabilityStore;
  policyDecisionActivity: PolicyDecisionRecorder;
  runnerReadiness: RunnerReadinessClient | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function createCodePolicyWiring(deps: CreateCodePolicyWiringDeps) {
  const { log, systemWorkspaceId, agent, approvalsRepo, codeApprovalScope, codeProtectedBranches, egressEnforcement, featureFlagService, mcpRuntimeCapabilities, policyDecisionActivity, runnerReadiness, workspaceStore } = deps;
  const policyEngine = new PolicyEngine({
    flags: featureFlagService,

    capabilities: {
      get: (id, scope) => {
        const tenant = scope?.companyId
          ? { workspaceId: scope.workspaceId ?? systemWorkspaceId, companyId: scope.companyId }
          : null;
        return lookupCapability(
          {
            staticCapabilities: {
              get: (toolId) => {
                const schema = CODE_TOOL_SCHEMAS.find((tool) => tool.name === toolId);
                return schema ? { id: schema.name, status: schema.status, version: schema.version } : undefined;
              },
            },
            runtimeOverlay: tenant
              ? mcpRuntimeCapabilities.overlayFor(tenant)
              : mcpRuntimeCapabilities.overlayFor({ workspaceId: systemWorkspaceId, companyId: "" }),
          },
          id,
        ).capability;
      },
    },
    classifier: (command) => classifyShellCommand(command),
    approvals: approvalsRepo
      ? {

          requestApproval: async (ctx, companyId, input) => approvalsRepo!.requestApproval(ctx, companyId, input as never),
          consumeApproved: async (ctx, companyId, id, params) => approvalsRepo!.consumeApproved(ctx, companyId, id, params as never),
        }
      : undefined,

    approvalRules: {
      findRule: async (ctx, query) => codeApprovalScope.findRule(ctx, query),
    },

    getApproval: approvalsRepo
      ? async (ctx, companyId, id) => {
          const approval = await approvalsRepo!.get(ctx, companyId, id).catch(() => null);
          return approval ? { status: approval.status, notes: approval.decisionNotes ?? null, comment: approval.decisionNotes ?? null } : null;
        }
      : undefined,
    sessionMode: async (ctx, companyId, sessionId) => {
      const session = await workspaceStore.getCodeSession(ctx, companyId, sessionId).catch(() => null);
      return session?.mode ?? null;
    },

    decisionRecorder: async (request, result) => {
      await policyDecisionActivity.record({
        companyId: request.companyId,
        projectId: request.projectId,
        sessionId: request.sessionId,
        runId: request.runId,
        snapshotId: request.snapshotId,
        tool: request.tool,
        action: request.tool,
        mode: matrixModeFor(request.sessionMode),
        phase: result.phase,
        decision: result.decision,
        code: result.code,
        ruleRef: request.ruleRef ?? null,
        actor: request.ctx.userId ?? request.agentId ?? "unknown",
        actorKind: isAgentPrincipal(request.ctx) ? "agent" : "user",
        agentId: request.agentId,
        approvedBy: result.decision === "allow" && request.approved === true ? request.ctx.userId : undefined,
        approvalId: result.approvalId ?? request.approvalId,
      });
    },

    networkEnforcement: () => runnerReadiness
      ? runnerReadiness.isReadySync()
      : egressEnforcement.lastReport()?.enforced === true,

    protectedBranches: codeProtectedBranches,
    logger: log,
  });

  return { policyEngine };
}
