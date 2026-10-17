import { createHash } from "node:crypto";
import type { AuthContext, Company, CompanyAgent, WorkspaceStore } from "@npati/workspace";
import type { EffectiveCapabilityResolver, RiskApprovalService } from "@npati/shared";
import type { CompanyToolExecutor } from "./company-tool-runtime";
import type { AuditRepository } from "./audit-repository";
import { classifyTerminalCommand, normalizeTerminalCommand } from "./terminal-command-policy";
import { logTerminalPolicy } from "./terminal-policy-log";
import { AutoExecReviewer } from "./auto-exec-reviewer";
import {
  GIT_WRITE_INTENT_REQUIRED,
  gitApprovalPayload,
  gitWriteIntentFromToolInput,
  isGitWriteTool,
  pullRequestApprovalPayload,
} from "./code-git-write-policy";
import {
  CompanyRuntimeError,
  type DurableApprovalGateway,
  hasScopedBrowserAuthorization,
  json,
  summary,
  type ToolPlan,
  toolName,
} from "./company-runtime-types";

interface BrowserTraceEvent {
  status?: string;
  action?: string;
  url?: string;
  detail?: string;
}

interface BrowserExecutionResult {
  _npatiBrowserTrace?: boolean;
  jobId?: string;
  trace?: BrowserTraceEvent[];
}

interface ErrorWithStatusAndCode {
  code?: string;
  status?: number;
}

export interface CompanyRunToolsParams {
  ctx: AuthContext;
  company: Company;
  runId: string;
  plans: ToolPlan[];
  agents: Map<string, CompanyAgent>;
  signal: AbortSignal;
  knowledge: { chunks: Array<{ content: string }>; memories: Array<{ content: string; source?: string; metadata?: Record<string, unknown> }> };
  noMemory?: boolean;
  approvalId?: string;
  allowedProjectPaths?: string[];
  allowedProjectId?: string;
  runProjectId?: string;
  onApprovalPending?: (nextToolIndex: number, evidence: string) => Promise<void>;
  previousEvidence?: string;
  startIndex?: number;
  runType?: string;
  onTool?: (tool: string, path?: string) => void;
  store: WorkspaceStore;
  toolRuntime: CompanyToolExecutor;
  capabilityResolver: EffectiveCapabilityResolver;
  riskApprovalService: RiskApprovalService;
  durableApprovals?: DurableApprovalGateway;
  telemetry?: Pick<AuditRepository, "recordUsage" | "log">;
}

export async function executeCompanyRunTools(params: CompanyRunToolsParams): Promise<string> {
  const {
    ctx, company, runId, plans, agents, signal, knowledge,
    noMemory = false, approvalId, allowedProjectPaths, allowedProjectId,
    runProjectId, onApprovalPending, previousEvidence, startIndex = 0,
    runType = "company_run", onTool, store, toolRuntime,
    capabilityResolver, riskApprovalService, durableApprovals, telemetry
  } = params;

  const evidence: string[] = previousEvidence ? [previousEvidence] : [];
  let sequenceNumber = 1;
  for (const [offset, plan] of plans.slice(startIndex, 10).entries()) {
    const planIndex = startIndex + offset;
    const approvedForCurrent = Boolean(approvalId && planIndex === startIndex);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const agent = agents.get(plan.agentId);
    if (!agent) throw new CompanyRuntimeError("INVALID_TOOL_AGENT", "Tool request references an unavailable agent", 502);
    const tool = toolName(plan.tool), allowed = new Set(agent.tools.map(toolName));
    if (allowedProjectId && (tool.startsWith("project.") || tool === "code.agent.spawn") && plan.input.projectId !== allowedProjectId) {
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId, { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: {}, errorMessage: "Tool targets another project", reasonCode: "project_task_tenant", sequenceNumber: sequenceNumber++ });
      evidence.push("Project task target denied " + tool);
      continue;
    }
    if (allowedProjectPaths?.length && (tool.startsWith("project.") || tool === "code.agent.spawn")) {
      const isMedia = tool.startsWith("project.media.");
      const isFiles = tool.startsWith("project.files.");
      const mutation = (isFiles && !["project.files.read", "project.files.list", "project.files.search"].includes(tool)) ||
        (isMedia && !["project.media.list", "project.media.get"].includes(tool));
      const paths = isMedia ? (plan.input.path ? [plan.input.path] : []) : mutation ? (tool === "project.files.delete" && Array.isArray(plan.input.paths) ? plan.input.paths : [plan.input.path, ...(tool === "project.files.move" ? [plan.input.to] : [])]) : [];
      const inScope = (value: unknown) => typeof value === "string" && allowedProjectPaths.some((scope) => value === scope || value.startsWith(scope + "/"));
      if (((!isFiles && !isMedia) || (mutation && paths.length > 0 && !paths.every(inScope)))) {
        await store.appendCompanyAgentToolAudit(ctx, company.id, runId, { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: { path: plan.input.path }, errorMessage: "Tool is outside the assigned project file scope", reasonCode: "project_task_scope", sequenceNumber: sequenceNumber++ });
        evidence.push("Project task scope denied " + tool);
        continue;
      }
    }
    if (noMemory && ["knowledge", "files", "storage.company_memory"].includes(tool)) {
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
        { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "No-memory request blocks persistent context access", reasonCode: "no_memory", sequenceNumber: sequenceNumber++ });
      throw new CompanyRuntimeError("NO_MEMORY_TOOL_FORBIDDEN", `No-memory request may not use ${tool}`, 403);
    }
    if (!allowed.has(tool)) {
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
        { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "Tool is not permitted", reasonCode: "agent_allowlist", sequenceNumber: sequenceNumber++ });
      throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}`, 403);
    }
    if (tool !== "knowledge" && tool !== "exec") {
      const check = capabilityResolver.canExecute({
        auth: ctx,
        activeContext: { contextType: "company", companyId: company.id, businessId: null },
        company: { id: company.id, revision: company.revision },
        agent: { id: agent.id, revision: agent.revision, tools: agent.tools.map(toolName) },
      }, tool);
      if (!check.allowed) {
        await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: check.reason, reasonCode: check.detail?.reasonCode ?? "policy_denied", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}: ${check.reason}`, 403);
      }
    }
    if (tool === "exec" && !ctx.permissions.some((permission) => ["business:manage", "owner", "*"].includes(permission))) {
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
        { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "Exec requires business:manage permission", reasonCode: "tenant_permissions", sequenceNumber: sequenceNumber++ });
      throw new CompanyRuntimeError("TOOL_FORBIDDEN", "Exec requires business:manage permission", 403);
    }
    if (tool === "exec") {
      const code = typeof plan.input.code === "string" ? plan.input.code : "";
      const review = AutoExecReviewer.reviewExecution({ type: "javascript", payload: code });
      if (review.decision === "BLOCKED") {
        await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: review.reasons.join("; "), reasonCode: "auto_exec_reviewer", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("EXEC_REVIEW_BLOCKED", "Exec was blocked by the automatic security reviewer", 403);
      }
    }

    // Risk & Human Approval Policy Check
    const operation = typeof plan.input.operation === "string" ? plan.input.operation.trim().toLowerCase() : "";
    const toolToAssess = operation ? `${tool}.${operation}` : plan.tool.includes(".") ? plan.tool : tool;
    const scopedBrowserAuthorization = hasScopedBrowserAuthorization(ctx, tool, operation, plan.input);
    const isTerminal = tool === "project.terminal.exec" || tool === "project.terminal.process";
    const terminalStarts = tool === "project.terminal.exec" || (tool === "project.terminal.process" && plan.input.action === "start");
    let normalizedTerminal: ReturnType<typeof normalizeTerminalCommand> | undefined;
    if (terminalStarts) {
      try {
        normalizedTerminal = normalizeTerminalCommand({
          command: typeof plan.input.command === "string" ? plan.input.command : undefined,
          executable: typeof plan.input.executable === "string" ? plan.input.executable : undefined,
          args: plan.input.args as string[] | undefined,
          cwd: plan.input.cwd as string | undefined,
        });
      } catch (error) {
        logTerminalPolicy({ rawCommand: String(plan.input.command ?? plan.input.executable ?? ""), normalizedCommand: "", sandboxId: typeof plan.input.sandboxId === "string" ? plan.input.sandboxId : undefined, projectId: String(plan.input.projectId ?? ""), decision: "deny", reason: error instanceof Error ? error.message : "Invalid command", policyRule: "invalid_command_structure", toolName: tool, executionContext: runProjectId ? "project_agent" : "company_generic", runId, agentId: agent.id, runType });
        throw new CompanyRuntimeError("TOOL_FORBIDDEN", "Invalid terminal command structure", 400);
      }
    }
    const terminalDecision = normalizedTerminal ? classifyTerminalCommand({ command: normalizedTerminal.command, cwd: normalizedTerminal.cwd }) : undefined;
    const hasSecretReferences = isTerminal && Object.keys((plan.input.environmentReferences ?? {}) as Record<string, unknown>).length > 0;
    const terminalNeedsApproval = Boolean(terminalDecision?.requiresApproval || hasSecretReferences);
    let sandboxEvaluation: { allowed: boolean; reason: string; sandboxId?: string } = { allowed: false, reason: runProjectId ? "sandbox_adapter_unavailable" : "run_has_no_project" };
    if (isTerminal && !terminalNeedsApproval && runProjectId) {
      try {
        sandboxEvaluation = toolRuntime.evaluateSandboxTerminal
          ? await toolRuntime.evaluateSandboxTerminal(ctx, company, runProjectId, agent.id, tool, plan.input)
          : { allowed: Boolean(toolRuntime.canAutoApproveSandboxTerminal && await toolRuntime.canAutoApproveSandboxTerminal(ctx, company, runProjectId, agent.id, tool, plan.input)), reason: "legacy_sandbox_adapter" };
      } catch (error) {
        logTerminalPolicy({ rawCommand: normalizedTerminal?.rawCommand ?? "", normalizedCommand: normalizedTerminal?.command ?? "", sandboxId: typeof plan.input.sandboxId === "string" ? plan.input.sandboxId : undefined, projectId: String(plan.input.projectId ?? ""), decision: "deny", reason: "sandbox_scope_check_failed", policyRule: "sandbox_scope", toolName: tool, executionContext: "project_agent", runId, agentId: agent.id, runType, cwd: normalizedTerminal?.cwd, rawArgs: normalizedTerminal?.args, commandPolicyRule: terminalDecision?.policyRule });
        throw error;
      }
    }
    const sandboxAutoApproval = isTerminal && !terminalNeedsApproval && sandboxEvaluation.allowed;
    if (isTerminal) logTerminalPolicy({ rawCommand: normalizedTerminal?.rawCommand ?? String(plan.input.command ?? plan.input.executable ?? ""), normalizedCommand: normalizedTerminal?.command ?? "", sandboxId: sandboxEvaluation.sandboxId ?? (typeof plan.input.sandboxId === "string" ? plan.input.sandboxId : undefined), projectId: String(plan.input.projectId ?? ""), decision: sandboxAutoApproval ? "allow" : "approval", reason: terminalDecision?.requiresApproval ? terminalDecision.reason : hasSecretReferences ? "Secret references require approval" : sandboxEvaluation.reason, policyRule: terminalDecision?.requiresApproval ? terminalDecision.policyRule : hasSecretReferences ? "secret_references" : sandboxEvaluation.reason, toolName: tool, executionContext: runProjectId ? "project_agent" : "company_generic", runId, agentId: agent.id, runType, cwd: normalizedTerminal?.cwd, rawArgs: normalizedTerminal?.args, commandPolicyRule: terminalDecision?.policyRule });
    const projectFileRisk = tool.startsWith("project.files.") ? (tool === "project.files.delete" ? "high" : "medium") : tool.startsWith("project.media.") ? (tool === "project.media.delete" ? "high" : "medium") : tool.startsWith("project.terminal.") ? sandboxAutoApproval ? "low" : "high" : tool.startsWith("project.preview.") ? "low" : tool.startsWith("project.deploy.") ? (tool === "project.deploy.publish" ? "high" : "low") : tool.startsWith("project.data.") ? (tool === "project.data.schema.inspect" || tool === "project.data.rows.list" || tool === "project.data.rows.read" || tool === "project.data.migrations.list" || tool === "project.data.templates.list" ? "low" : tool === "project.data.rows.create" || tool === "project.data.rows.update" ? "medium" : "high") : tool === "project.git.push" || tool === "project.git.pr" ? "high" : undefined;

    const gitWriteIntent = isGitWriteTool(tool) ? gitWriteIntentFromToolInput(tool, plan.input as Record<string, unknown>) : null;
    if (isGitWriteTool(tool) && !gitWriteIntent) {
      throw new CompanyRuntimeError(
        GIT_WRITE_INTENT_REQUIRED,
        `Tool "${tool}" performs a remote git write, so it must name the branch it writes to`,
        400,
      );
    }
    const pullRequestTarget = tool === "project.git.pr"
      ? { base: String(plan.input.base ?? "").trim(), head: String(plan.input.head ?? "").trim() }
      : null;
    if (pullRequestTarget && (!pullRequestTarget.base || !pullRequestTarget.head)) {
      throw new CompanyRuntimeError(
        "GIT_PR_TARGET_REQUIRED",
        "A pull request must name the branch it targets (`base`) and the branch under review (`head`): the approval is bound to that pair",
        400,
      );
    }

    const gitRecordTool = gitWriteIntent || pullRequestTarget ? tool : toolToAssess;
    let gitRepositoryState: { initialized: boolean } | null = null;
    if (gitWriteIntent && toolRuntime.inspectRepositoryForApproval) {
      gitRepositoryState = await toolRuntime
        .inspectRepositoryForApproval(ctx, company.id, String(plan.input.projectId ?? ""))
        .catch(() => null);
    }
    const approvalPayload = isTerminal
      ? { projectId: plan.input.projectId, commandHash: createHash("sha256").update(normalizedTerminal?.command ?? String(plan.input.command ?? "")).digest("hex"), cwd: normalizedTerminal?.cwd === "." ? undefined : normalizedTerminal?.cwd, action: plan.input.action, environmentReferenceHash: createHash("sha256").update(JSON.stringify(plan.input.environmentReferences ?? {})).digest("hex") }
      : gitWriteIntent
        ? gitApprovalPayload({
            projectId: String(plan.input.projectId ?? ""),
            tool: gitRecordTool,
            intent: { ...gitWriteIntent, repositoryInitialized: gitRepositoryState?.initialized ?? null },
          })
        : pullRequestTarget
          ? pullRequestApprovalPayload({
              projectId: String(plan.input.projectId ?? ""),
              tool: gitRecordTool,
              base: pullRequestTarget.base,
              head: pullRequestTarget.head,
              credentialId: typeof plan.input.credentialId === "string" ? plan.input.credentialId : null,
            })
          : plan.input;
    if (riskApprovalService.requiresApproval(toolToAssess, projectFileRisk) && !scopedBrowserAuthorization) {
      if (durableApprovals) {
        if (!approvedForCurrent) {
          const cleanPayload = { ...approvalPayload }; delete cleanPayload._approvalToken;
          const req = await durableApprovals.requestApproval(ctx, company.id, {
            runId, agentId: agent.id, toolName: gitRecordTool,
            riskLevel: projectFileRisk === "high" ? "high" : riskApprovalService.classifyRisk(toolToAssess) === "critical" ? "critical" : "high",
            actionSummary: tool === "project.deploy.publish" ? `Deploy ${plan.input.projectId ?? "project"} to ${plan.input.provider ?? "dokploy"} [${plan.input.environment ?? "production"}]` : `${agent.name} requests ${gitRecordTool}`, inputPayload: cleanPayload,
          });
          await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id, toolName: toolToAssess, decision: "denied", status: "blocked",
            inputSummary: summary(cleanPayload), errorMessage: `Human approval required. Approval request ID: ${req.id}`, reasonCode: "approval_required", sequenceNumber: sequenceNumber++
          });
          await onApprovalPending?.(planIndex, evidence.join("\n"));
          throw new CompanyRuntimeError("APPROVAL_REQUIRED", `Tool "${toolToAssess}" requires human approval. Approval request ID: ${req.id}`, 403);
        }
        const cleanPayload = { ...approvalPayload }; delete cleanPayload._approvalToken;
        if (gitWriteIntent || pullRequestTarget) {
          // git write consumes approval at boundary
        } else {
          try { await durableApprovals.consumeApproved(ctx, company.id, approvalId!, { runId, agentId: agent.id, toolName: toolToAssess, inputPayload: cleanPayload }); }
          catch (error) {
            const err = error as ErrorWithStatusAndCode;
            const code = err?.code ?? "APPROVAL_INVALID";
            await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
              agentId: agent.id, toolName: toolToAssess, decision: "denied", status: "blocked",
              inputSummary: summary(cleanPayload), errorMessage: error instanceof Error ? error.message : "Approval denied", reasonCode: String(code).toLowerCase(), sequenceNumber: sequenceNumber++
            });
            throw new CompanyRuntimeError(code, error instanceof Error ? error.message : "Approval denied", Number(err?.status ?? 409));
          }
        }
      } else {
        if (gitWriteIntent || pullRequestTarget) {
          throw new CompanyRuntimeError(
            "GIT_APPROVAL_UNAVAILABLE",
            "A remote git write requires the durable approval store so the git boundary can verify the approval record",
            503,
          );
        }
        const token = typeof plan.input._approvalToken === "string" ? plan.input._approvalToken : undefined;
        if (!token) {
          const req = riskApprovalService.createApprovalRequest(ctx, company.id, runId, agent.id, toolToAssess, approvalPayload);
          await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input),
            errorMessage: `Human approval required for high-risk operation '${toolToAssess}'. Approval request ID: ${req.id}`,
            reasonCode: "approval_required",
            sequenceNumber: sequenceNumber++,
          });
          await onApprovalPending?.(planIndex, evidence.join("\n"));
          throw new CompanyRuntimeError("APPROVAL_REQUIRED", `Tool "${toolToAssess}" requires human approval before execution. Approval request ID: ${req.id}`, 403);
        }

        const verification = riskApprovalService.verifyApprovalToken(token, ctx, company.id, runId, toolToAssess, approvalPayload);
        if (!verification.valid) {
          await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input),
            errorMessage: verification.reason ?? "Invalid approval token",
            reasonCode: verification.reasonCode ?? "invalid_approval_token",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("INVALID_APPROVAL_TOKEN", verification.reason ?? "Invalid approval token", 403);
        }

        const consumed = riskApprovalService.consumeToken(token);
        if (!consumed) {
          await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input),
            errorMessage: "Approval token has already been consumed (replay attempt blocked)",
            reasonCode: "already_consumed",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("APPROVAL_ALREADY_USED", "Approval token has already been consumed", 409);
        }
      }
    }

    await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
      { agentId: agent.id, toolName: tool, decision: "allowed", status: "requested", inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input), sequenceNumber: sequenceNumber++ });
    const toolStart = performance.now();
    try {
      const cleanPayload = { ...plan.input };
      delete cleanPayload._approvalToken;
      const adapterInput = tool === "mcp" && plan.tool.trim().toLowerCase().startsWith("omniroute_")
        ? { ...cleanPayload, name: plan.tool.trim() }
        : tool === "files" && plan.tool.includes(".")
          ? { ...cleanPayload, operation: plan.tool.split(".").at(-1) }
          : cleanPayload;
      if (tool === "web.search" && (!adapterInput.query || typeof adapterInput.query !== "string" || !(adapterInput.query as string).trim())) {
        adapterInput.query = typeof adapterInput.q === "string" && (adapterInput.q as string).trim()
          ? (adapterInput.q as string).trim()
          : typeof adapterInput.topic === "string" && (adapterInput.topic as string).trim()
            ? (adapterInput.topic as string).trim()
            : company.name || "company information";
      }
      if (tool.startsWith("project.files.")) { adapterInput.__npatiAgentId = agent.id; adapterInput.__npatiTaskRunId = runId; if (tool === "project.files.delete") adapterInput.__npatiApprovalGranted = true; }
      if (tool.startsWith("project.terminal.") || tool.startsWith("project.preview.") || tool.startsWith("project.git.") || tool.startsWith("project.deploy.") || tool.startsWith("project.data.") || tool.startsWith("project.auth.") || tool === "project.api.inspect") { adapterInput.__npatiAgentId = agent.id; adapterInput.__npatiTaskRunId = runId; adapterInput.__npatiApprovalGranted = tool === "project.deploy.publish" || tool === "project.data.schema.apply" || tool === "project.data.templates.apply" || tool === "project.data.rows.delete" || tool === "project.auth.configure" ? Boolean(approvedForCurrent || plan.input._approvalToken) : (!terminalNeedsApproval || Boolean(approvedForCurrent || plan.input._approvalToken)); }
      if ((tool === "project.git.push" || tool === "project.git.pr") && approvedForCurrent && approvalId) {
        adapterInput.__npatiApprovalId = approvalId;
      }
      if (tool === "email.send" || tool === "communications.email_send" || tool.startsWith("browser.")) adapterInput.__npatiTaskRunId = runId;
      onTool?.(tool, tool.startsWith("project.files.") && typeof adapterInput.path === "string" ? adapterInput.path : undefined);
      const result = tool === "knowledge" ? knowledge : await toolRuntime.execute(ctx, company, tool, adapterInput, signal);
      const latencyMs = Math.round(performance.now() - toolStart);
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId,
        { agentId: agent.id, toolName: tool, decision: "allowed", status: "succeeded", inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input), latencyMs, sequenceNumber: sequenceNumber++ });
      const browserResult = result as BrowserExecutionResult | null | undefined;
      if (browserResult && typeof browserResult === "object" && browserResult._npatiBrowserTrace === true && Array.isArray(browserResult.trace)) {
        for (const event of browserResult.trace.slice(0, 200)) {
          const eventStatus = event?.status === "failed" ? "failed" : "succeeded";
          const actionName = String(event?.action ?? "unknown").replace(/[^a-z0-9_.-]/gi, "_");
          await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: `browser.action.${actionName}`,
            decision: "allowed",
            status: eventStatus,
            inputSummary: summary({ url: event?.url, detail: event?.detail, browserStatus: event?.status }),
            errorMessage: eventStatus === "failed" ? String(event?.detail ?? "Browser action failed").slice(0, 500) : undefined,
            reasonCode: ["waiting_email", "paused"].includes(event?.status ?? "") ? event.status : "browser_worker_trace",
            sequenceNumber: sequenceNumber++,
          });
          await telemetry?.log(ctx, company.id, {
            action: `browser.${actionName}`,
            category: "automation",
            resourceType: "browser_job",
            resourceId: typeof browserResult.jobId === "string" ? browserResult.jobId : runId,
            details: summary({ runId, agentId: agent.id, url: event?.url, detail: event?.detail, status: event?.status }),
          }).catch(() => undefined);
        }
      }
      evidence.push(`${agent.name} / ${tool}: ${json(result)}`);
    } catch (error) {
      if (signal.aborted) throw error;
      const latencyMs = Math.round(performance.now() - toolStart);
      await store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
        agentId: agent.id, toolName: tool,
        decision: "allowed", status: "failed", inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input), latencyMs, sequenceNumber: sequenceNumber++,
        errorMessage: (error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI").slice(0, 500)
      });
      if (tool.startsWith("browser.")) await telemetry?.log(ctx, company.id, {
        action: "browser.failed", category: "automation", resourceType: "company_agent_run", resourceId: runId,
        details: summary({ agentId: agent.id, tool, error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
      evidence.push(`${agent.name} / ${tool} (failed): ${(error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI")}`);
    }
  }
  return evidence.join("\n\n");
}
