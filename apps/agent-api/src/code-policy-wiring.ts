/* The code policy engine of app.ts, extracted in step 2c-6c of
 * docs/refactoring/PLAN.md. Moved verbatim inside a factory that returns it.
 */
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
    /**
     * C13 (owner decision 5): the capability lookup is `static → runtime → unknown ⇒ deny`, in one function.
     *
     * `lookupCapability` is asked with the request's tenant (the engine passes the scope), so:
     *   - a static code tool resolves exactly as before — the static registry is consulted **first**, so a
     *     runtime provider capability can never shadow one, and the pre-C13 path is byte-identical;
     *   - a runtime MCP tool resolves from that tenant's overlay, carrying `requiresConfirmation` from its own
     *     fail-closed `approvalRequired`, which is the field the approval phase already reads;
     *   - anything else stays `undefined`, so the engine answers `unknown_tool` (404). A discovered MCP tool is
     *     never written into `CODE_TOOL_SCHEMAS`, `CAPABILITY_CATALOG` or `CAPABILITY_MATRIX`.
     */
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
          // Thin adapter to the existing approval system; the policy engine never re-implements it.
          requestApproval: async (ctx, companyId, input) => approvalsRepo!.requestApproval(ctx, companyId, input as never),
          consumeApproved: async (ctx, companyId, id, params) => approvalsRepo!.consumeApproved(ctx, companyId, id, params as never),
        }
      : undefined,
    // C5: scoped approval rules. Consulted only in the approval phase, which runs after hard deny, the
    // session-mode check, project rules and the network gate — so a rule can never bypass any of them.
    approvalRules: {
      findRule: async (ctx, query) => codeApprovalScope.findRule(ctx, query),
    },
    // C5: read-only lookup so a rejection can carry the reviewer's (redacted) comment back to the model.
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
    // C5: every decision (allow, deny, require_approval) is recorded as a structured Activity event
    // answering who/what/mode/rule/outcome. Recording is observability only: the engine calls it after
    // the verdict and ignores failures, so it can never change, delay or weaken a decision.
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
    // C4b: a verified runner readiness report is the only proof of enforcement. The flag is advisory and
    // can only disable; a missing runner, a failed request or a non-ready report all fail closed.
    networkEnforcement: () => runnerReadiness
      ? runnerReadiness.isReadySync()
      : egressEnforcement.lastReport()?.enforced === true,
    // C5a (D9): the company protected-branch policy. The engine consults it in the hard-deny phase, so a
    // `git push` into a protected branch is `protected_branch_write_denied` (and a force push
    // `force_push_denied`) for every principal — owner, `admin:all`, a session rule and `approved: true`
    // included — while a push into an unprotected branch keeps its `approval` class.
    protectedBranches: codeProtectedBranches,
    logger: log,
  });

  return { policyEngine };
}
