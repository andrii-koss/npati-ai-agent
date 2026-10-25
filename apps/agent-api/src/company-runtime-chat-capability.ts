import { SecurityPolicyEngine, type CompanyGuardrailPolicy } from "./security-guardrails";
import { executeCompanyRunTools, type CompanyRunToolsParams } from "./company-runtime-tool-executor";
import { CompanyRuntimeError, type Plan, json } from "./company-runtime-types";

/** Shared execution and approval-resume boundary for a single exact chat capability. No model replanning. */
export async function executeChatCapability(input: Pick<CompanyRunToolsParams,
  "ctx" | "company" | "runId" | "signal" | "noMemory" | "approvalId" | "store" | "toolRuntime" | "capabilityResolver" | "riskApprovalService" | "durableApprovals" | "telemetry">
  & { plan: Plan; policy?: CompanyGuardrailPolicy }) {
  const { ctx, company, runId, plan, store, signal, noMemory, approvalId } = input;
  const started = Date.now(); let output: unknown;
  const agentId = plan.toolRequests[0]!.agentId;
  const agent = await store.getCompanyAgent(ctx, company.id, agentId);
  const projectId = String(plan.toolRequests[0]!.input.projectId);
  await store.getProject(ctx, company.id, projectId);
  try {
    if (!approvalId) await store.updateCompanyAgentRun(ctx, company.id, runId, { status: "running", executionMode: "single", selectedAgentIds: [agent.id] });
    await executeCompanyRunTools({ ...input, plans: plan.toolRequests, agents: new Map([[agent.id, agent]]),
      knowledge: { chunks: [], memories: [] }, allowedProjectId: projectId, runProjectId: projectId,
      onResult: (_name, value) => { output = value; },
      onApprovalPending: async (nextToolIndex, evidence) => { await store.setCompanyRunPendingPlan(ctx, company.id, runId, { plan, nextToolIndex, evidence, noMemory }); },
    });
    // Old approval-blocked audit rows remain as history. Only this execution's result determines success.
    if (output === undefined) throw new CompanyRuntimeError("CAPABILITY_EXECUTION_FAILED", "Capability returned no result; inspect its run trace", 502);
    signal.throwIfAborted();
    const safe = SecurityPolicyEngine.protectObject(SecurityPolicyEngine.redactObject(output, input.policy), input.policy);
    await store.setCompanyRunPendingPlan(ctx, company.id, runId, null);
    await store.updateCompanyAgentRun(ctx, company.id, runId, { status: "completed", result: json(safe), errorCode: "", errorMessage: "", totalDurationMs: Date.now() - started, totalTokens: 0, totalCost: 0 });
    return { output: safe, runId };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "CAPABILITY_EXECUTION_FAILED";
    if (approvalId && ["APPROVAL_INVALID", "APPROVAL_ALREADY_USED", "APPROVAL_EXPIRED"].includes(code)) throw error;
    await store.updateCompanyAgentRun(ctx, company.id, runId, { status: code === "APPROVAL_REQUIRED" ? "awaiting_approval" : signal.aborted ? "cancelled" : "failed", errorCode: code, errorMessage: "Chat capability did not complete: " + code, totalDurationMs: Date.now() - started });
    throw Object.assign(error instanceof Error ? error : new Error("Capability failed"), { runId });
  }
}
