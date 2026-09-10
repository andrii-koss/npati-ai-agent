import { createHash } from "node:crypto";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, Company, CompanyAgent, CompanyAgentRunDetails, CompanyRunMode, WorkspaceStore } from "@npati/workspace";
import { defaultEffectiveCapabilityResolver, EffectiveCapabilityResolver, defaultRiskApprovalService, RiskApprovalService } from "@npati/shared";
import type { CompanyToolExecutor } from "./company-tool-runtime";

const MAX_CANDIDATES = 60, MAX_SELECTED = 12, DEFAULT_TIMEOUT = 120_000;
type Mode = Exclude<CompanyRunMode, "auto">;
type ToolPlan = { agentId: string; tool: string; input: Record<string, unknown> };
type Plan = { mode: Mode; agentIds: string[]; reviewerAgentId?: string; toolRequests: ToolPlan[] };

export class CompanyRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const comboModel = (value: string | null | undefined) => value == null || value === "auto" ? "auto/smart" : value;
function toolName(value: string) {
  const raw = value.trim().toLowerCase();
  const key = raw.replace(/[ _-]+/g, ".");
  if (raw.startsWith("omniroute_") || key.startsWith("mcp.")) return "mcp";
  if (key.startsWith("files.")) return "files";
  return ({ "websearch": "web.search", "web.search": "web.search", "webfetch": "web.fetch", "web.fetch": "web.fetch",
    crawler: "web.crawl", "web.crawl": "web.crawl", "text-to-speech": "audio.speech", tts: "audio.speech", "audio.speech": "audio.speech",
    mcp: "mcp", files: "files", knowledge: "knowledge", "company.memory":"storage.company_memory", "storage.company.memory":"storage.company_memory" } as Record<string, string>)[key] ?? key;
}
function summary(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).slice(0, 20).map(([key, value]) => [
    key, /token|secret|password|api.?key|authorization/i.test(key) ? "[REDACTED]"
      : typeof value === "string" ? value.slice(0, 500)
      : typeof value === "number" || typeof value === "boolean" || value === null ? value : "[structured value]",
  ]));
}
function json(value: unknown, max = 20_000) {
  try { return JSON.stringify(value).slice(0, max); } catch { return "[unserializable]"; }
}
function context(company: Company) {
  return [
    `Company: ${company.name}`, company.website && `Website: ${company.website}`,
    company.industry && `Industry: ${company.industry}`, company.description && `Description: ${company.description}`,
    company.productsServices && `Products / Services: ${company.productsServices}`,
    company.languages.length && `Languages: ${company.languages.join(", ")}`,
    company.brandTone && `Brand tone: ${company.brandTone}`,
    company.companyInstructions && `Company instructions: ${company.companyInstructions}`,
    company.knowledge.length && `Company knowledge: ${json(company.knowledge, 8_000)}`,
    Object.keys(company.memory).length && `Company memory: ${json(company.memory, 8_000)}`,
  ].filter(Boolean).join("\n");
}
function instruction(company: Company, agent: CompanyAgent, manager = false) {
  return [
    "You are an AI Agent inside an NPATI Company.", context(company), `Agent name: ${agent.name}`,
    `Agent role: ${agent.role}`, agent.description && `Role description: ${agent.description}`,
    agent.systemInstruction && `System instruction: ${agent.systemInstruction}`,
    agent.promptGuidelines && `Prompt guidelines: ${agent.promptGuidelines}`,
    agent.tools.map(toolName).includes("knowledge") && "Grounding rule: when Relevant Company Knowledge or Company Memory is supplied, treat it as authoritative. Copy exact factual values when asked. Never replace them with assumptions or invented facts; if the answer is absent, say that it is not available in Company Knowledge.",
    manager ? "As Main Agent, verify delegated work and return one final answer to the user."
      : "Complete your assigned responsibility and return concrete work to the next agent.",
  ].filter(Boolean).join("\n\n");
}
function parsePlan(content: string, requested: CompanyRunMode): Plan {
  const source = content.match(/\{[\s\S]*\}/)?.[0];
  if (!source) throw new CompanyRuntimeError("INVALID_DELEGATION_PLAN", "Main Agent did not return delegation JSON", 502);
  let value: Record<string, unknown>;
  try { value = JSON.parse(source) as Record<string, unknown>; }
  catch { throw new CompanyRuntimeError("INVALID_DELEGATION_PLAN", "Main Agent returned malformed delegation JSON", 502); }
  const mode = requested === "auto" ? value.mode : requested;
  if (mode !== "single" && mode !== "pipeline" && mode !== "fusion") throw new CompanyRuntimeError("INVALID_DELEGATION_MODE", "Unsupported delegation mode", 502);
  const agentIds = Array.isArray(value.agentIds) ? value.agentIds.filter((id): id is string => typeof id === "string") : [];
  const reviewerAgentId = typeof value.reviewerAgentId === "string" ? value.reviewerAgentId : undefined;
  const toolRequests = Array.isArray(value.toolRequests) ? value.toolRequests.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.agentId !== "string" || typeof item.tool !== "string") return [];
    return [{ agentId: item.agentId, tool: item.tool,
      input: item.input && typeof item.input === "object" ? item.input as Record<string, unknown> : {} }];
  }) : [];
  return { mode, agentIds: [...new Set(agentIds)], reviewerAgentId, toolRequests };
}

export class CompanyDelegationRuntime {
  private readonly controllers = new Map<string, AbortController>();
   private readonly toolRuntime: CompanyToolExecutor;
  private readonly capabilityResolver: EffectiveCapabilityResolver;
  private readonly riskApprovalService: RiskApprovalService;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly ai: AIEngine,
    private readonly timeoutMs = DEFAULT_TIMEOUT,
    toolRuntime?: CompanyToolExecutor,
    private readonly knowledgeRetriever?: (ctx: AuthContext, companyId: string, query: string) => Promise<{chunks:Array<{content:string}>;memories:Array<{content:string}>}>,
    capabilityResolver?: EffectiveCapabilityResolver,
    riskApprovalService?: RiskApprovalService,
  ) {
    this.toolRuntime = toolRuntime ?? { execute: async (_context, _company, tool, input) => this.ai.executeTool(tool, input) };
    this.capabilityResolver = capabilityResolver ?? defaultEffectiveCapabilityResolver;
    this.riskApprovalService = riskApprovalService ?? defaultRiskApprovalService;
  }

  async create(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode }, key: string) {
    return this.store.createCompanyAgentRun(ctx, companyId, { task: input.task, requestedMode: input.mode ?? "auto" }, key);
  }

  async execute(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode }, key: string): Promise<CompanyAgentRunDetails> {
    const created = await this.create(ctx, companyId, input, key);
    if (!created.created) return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
    return this.process(ctx, companyId, created.run.id);
  }

  async process(ctx: AuthContext, companyId: string, runId: string): Promise<CompanyAgentRunDetails> {
    const existing = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    const created = { run: existing.run };
    const input = { task: existing.run.task, mode: existing.run.requestedMode };
    const controller = new AbortController(), timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    this.controllers.set(created.run.id, controller);
    try {
      if (!this.ai.a2aSend || !this.ai.ensureCombo || !this.ai.ensureA2AEnabled)
        throw new CompanyRuntimeError("OMNIROUTE_ORCHESTRATION_UNAVAILABLE", "OmniRoute A2A and combo APIs are unavailable", 503);
      // Check permissions prior to planning and tool execution
      if (!ctx.permissions.includes("business:manage") && !ctx.permissions.includes("workspace:write") && !ctx.permissions.includes("workspace:read")) {
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
          status: "failed",
          errorCode: "PERMISSION_REVOKED",
          errorMessage: "User permissions were revoked before run execution",
        });
        throw new CompanyRuntimeError("PERMISSION_REVOKED", "User permissions were revoked before run execution", 403);
      }

      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { status: "planning" });

      let company: Company;
      try {
        company = await this.store.getCompany(ctx, companyId);
      } catch {
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
          status: "failed",
          errorCode: "CONTEXT_DELETED",
          errorMessage: `Company context "${companyId}" was deleted or unavailable`,
        });
        throw new CompanyRuntimeError("CONTEXT_DELETED", `Company context "${companyId}" was deleted or unavailable`, 404);
      }

      if (company.status === "inactive") {
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
          status: "failed",
          errorCode: "COMPANY_INACTIVE",
          errorMessage: `Company "${company.name}" is inactive`,
        });
        throw new CompanyRuntimeError("COMPANY_INACTIVE", `Company "${company.name}" is inactive`, 400);
      }

      let main: CompanyAgent;
      try {
        main = await this.store.getCompanyAgent(ctx, companyId, created.run.mainAgentId);
      } catch {
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
          status: "failed",
          errorCode: "MAIN_AGENT_INACTIVE",
          errorMessage: `Main agent "${created.run.mainAgentId}" was deleted or unavailable`,
        });
        throw new CompanyRuntimeError("MAIN_AGENT_INACTIVE", `Main agent was deleted or unavailable`, 404);
      }

      if (!main.isActive) {
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
          status: "failed",
          errorCode: "MAIN_AGENT_INACTIVE",
          errorMessage: `Main agent "${main.name}" is inactive`,
        });
        throw new CompanyRuntimeError("MAIN_AGENT_INACTIVE", `Main agent "${main.name}" is inactive`, 400);
      }
      const page = await this.store.listCompanyAgentsPage(ctx, companyId, MAX_CANDIDATES);
      const candidates = page.items.filter((agent) => agent.isActive);
      if (!candidates.some((agent) => agent.id === main.id)) candidates.unshift(main);
      await this.ai.ensureA2AEnabled();
      const planned = await this.ai.a2aSend({
        model: main.modelId ?? "auto", timeoutMs: Math.min(60_000, this.timeoutMs), signal,
        idempotencyKey: `${created.run.id}:plan`,
        messages: [
          { role: "system", content: instruction(company, main, true) },
          { role: "user", content: [
            `Task: ${input.task.trim()}`, `Requested mode: ${input.mode ?? "auto"}`,
            "Choose active agents only from this JSON:", json(candidates.map((agent) => ({
              id: agent.id, name: agent.name, role: agent.role, description: agent.description, tools: agent.tools.map(toolName),
            })), 30_000),
            'Return JSON only: {"mode":"single|pipeline|fusion","agentIds":["id"],"reviewerAgentId":"id or omit","toolRequests":[{"agentId":"id","tool":"tool id","input":{}}]}.',
            "Tool input contracts (only request a tool allowed for that agent):",
            'web.search: {"query":"non-empty specific search query","maxResults":5,"searchType":"web or news"}.',
            'web.fetch: {"url":"absolute https URL","format":"markdown"}; web.crawl: {"url":"absolute https URL","query":"research goal","maxPages":5}.',
            'audio.speech: {"text":"text to synthesize","voice":"alloy","format":"mp3"}.',
            'knowledge: {"query":"question about this Company"}; files: {"operation":"list"} or {"operation":"read","key":"known file key"}.',
            'storage.company_memory: {"operation":"list|search|get|create|update|delete","query":"for search","id":"for get/update/delete","content":"for create/update"}.',
            'mcp: {"name":"permitted MCP tool name","arguments":{}}. Never invent tool names, URLs or file keys.',
            "Populate required input fields with concrete values. Omit a tool request if you cannot supply its required input; never emit an empty input for web.search, web.fetch or web.crawl.",
            "Use pipeline for dependent work and fusion for independent parallel perspectives.",
          ].join("\n\n") },
        ],
      });
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { omnirouteTaskId: planned.taskId });
      const plan = parsePlan(planned.content, input.mode ?? "auto"), byId = new Map(candidates.map((agent) => [agent.id, agent]));
      let selected = plan.agentIds.map((id) => byId.get(id)).filter((agent): agent is CompanyAgent => Boolean(agent));
      if (selected.length !== plan.agentIds.length) throw new CompanyRuntimeError("CROSS_COMPANY_AGENT_SELECTION", "Main Agent selected an unavailable agent", 502);
      selected = selected.filter((agent) => agent.id !== main.id);
      if (selected.length > MAX_SELECTED) throw new CompanyRuntimeError("TOO_MANY_DELEGATES", `At most ${MAX_SELECTED} agents may run`);
      const reviewer = plan.reviewerAgentId ? byId.get(plan.reviewerAgentId) : undefined;
      if (plan.reviewerAgentId && !reviewer) throw new CompanyRuntimeError("INVALID_REVIEWER", "Reviewer is not active in this company", 502);
      if (reviewer && reviewer.id !== main.id && !selected.some((agent) => agent.id === reviewer.id)) selected.push(reviewer);

      // Cycle and loop protection
      if (plan.toolRequests.length > 20) {
        throw new CompanyRuntimeError("TOOL_LOOP_DETECTED", "Too many tool requests in delegation plan", 400);
      }
      if (reviewer && selected.length === 1 && selected[0]?.id === reviewer.id) {
        throw new CompanyRuntimeError("CIRCULAR_DELEGATION", "An agent cannot review only its own work", 400);
      }
      // OmniRoute combo stages share the workflow prompt, so fail closed unless every
      // participating agent is explicitly allowed to receive Company Knowledge.
      const knowledgeAllowed = [main,...selected].every(agent=>agent.tools.map(toolName).includes("knowledge"));
      const knowledge = knowledgeAllowed && this.knowledgeRetriever ? await this.knowledgeRetriever(ctx,companyId,input.task).catch(()=>({chunks:[],memories:[]})) : {chunks:[],memories:[]};
      const evidence = await this.tools(ctx, company, created.run.id, plan.toolRequests, byId, signal, knowledge);
      const knowledgeContext = [
        knowledge.memories.length ? "Relevant Company Memory:\n"+knowledge.memories.map(item=>item.content).join("\n") : "",
        knowledge.chunks.length ? "Authoritative Relevant Company Knowledge (use exact facts; do not invent replacements):\n"+knowledge.chunks.map(item=>item.content).join("\n\n---\n\n") : "",
      ].filter(Boolean).join("\n\n");
      const execution = await this.combos(company, main, selected, reviewer, plan.mode, signal);
      const ids = [...new Set([...selected.map((agent) => agent.id), main.id])];
      await this.store.replaceCompanyAgentRunSteps(ctx, companyId, created.run.id, ids.map((id, index) => {
        const agent = byId.get(id) ?? main;
        return { agentId: id, stepOrder: plan.mode === "fusion" && id !== main.id ? 0 : index,
          lane: plan.mode === "fusion" && id !== main.id ? index : 0,
          role: id === main.id ? "manager" as const : reviewer?.id === id ? "reviewer" as const : "worker" as const,
          status: "delegated" as const, modelId: agent.modelId ?? "auto" };
      }));
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id,
        { status: "running", executionMode: execution.mode, selectedAgentIds: ids, omnirouteComboName: execution.model });
      if ((await this.store.getCompanyAgentRun(ctx, companyId, created.run.id)).run.cancelRequested)
        throw new DOMException("Cancelled", "AbortError");
      let result = await this.ai.chat({
        model: execution.model, signal, timeoutMs: this.timeoutMs, idempotencyKey: `${created.run.id}:final`,
        messages: [
          { role: "system", content: instruction(company, main, true) },
          { role: "user", content: [input.task.trim(), knowledgeContext, evidence && `Verified tool evidence:\n${evidence}`].filter(Boolean).join("\n\n") },
        ],
      });
      if (knowledgeContext) {
        result = await this.ai.chat({
          model: comboModel(main.modelId), fallbackModel: comboModel(main.fallbackModelId), signal, timeoutMs: this.timeoutMs, idempotencyKey: `${created.run.id}:grounded-final`,
          messages: [
            { role: "system", content: instruction(company, main, true) + "\n\nYou are the final grounding verifier. Use the authoritative Company Knowledge below as the source of truth. Preserve exact relevant values. Remove unsupported claims. Never omit the direct answer requested by the user." },
            { role: "user", content: [input.task.trim(), knowledgeContext, `Delegated draft to verify:\n${result.content}`, "Return only the corrected, knowledge-grounded final answer."].join("\n\n") },
          ],
        });
      }
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { status: "completed", result: result.content });
    } catch (error) {
      const current = await this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
      const cancelled = current.run.cancelRequested || controller.signal.aborted, timedOut = !cancelled && timeout.aborted;
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
        status: cancelled ? "cancelled" : "failed",
        errorCode: cancelled ? "RUN_CANCELLED" : timedOut ? "RUN_TIMEOUT" : error instanceof CompanyRuntimeError ? error.code : "RUN_FAILED",
        errorMessage: cancelled ? "Company run was cancelled" : timedOut ? "Company run exceeded its timeout" : error instanceof Error ? error.message : String(error),
      });
    } finally { this.controllers.delete(created.run.id); }
    return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
  }

  async list(ctx: AuthContext, companyId: string, limit = 50) {
    return this.store.listCompanyAgentRuns(ctx, companyId, limit);
  }

  async get(ctx: AuthContext, companyId: string, runId: string) {
    return this.store.getCompanyAgentRun(ctx, companyId, runId);
  }

  async cancel(ctx: AuthContext, companyId: string, runId: string) {
    const current = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    if (["completed", "failed", "cancelled"].includes(current.run.status)) return current;
    if (current.run.status === "queued") {
      await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelled", cancelRequested: true, errorCode: "RUN_CANCELLED", errorMessage: "Company run was cancelled" });
      return this.store.getCompanyAgentRun(ctx, companyId, runId);
    }
    await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelling", cancelRequested: true });
    this.controllers.get(runId)?.abort();
    if (current.run.omnirouteTaskId && this.ai.cancelA2ATask)
      await this.ai.cancelA2ATask(current.run.omnirouteTaskId).catch(() => undefined);
    return this.store.getCompanyAgentRun(ctx, companyId, runId);
  }

  private async tools(ctx: AuthContext, company: Company, runId: string, plans: ToolPlan[], agents: Map<string, CompanyAgent>, signal: AbortSignal, knowledge: {chunks:Array<{content:string}>;memories:Array<{content:string}>}) {
    const evidence: string[] = [];
    let sequenceNumber = 1;
    for (const plan of plans.slice(0, 10)) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const agent = agents.get(plan.agentId);
      if (!agent) throw new CompanyRuntimeError("INVALID_TOOL_AGENT", "Tool request references an unavailable agent", 502);
      const tool = toolName(plan.tool), allowed = new Set(agent.tools.map(toolName));
      if (!allowed.has(tool)) {
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(plan.input), errorMessage: "Tool is not permitted", reasonCode: "agent_allowlist", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}`, 403);
      }
      if (tool !== "knowledge") {
        const check = this.capabilityResolver.canExecute({
          auth: ctx,
          activeContext: { contextType: "company", companyId: company.id, businessId: null },
          company: { id: company.id, revision: company.revision },
          agent: { id: agent.id, revision: agent.revision, tools: agent.tools },
        }, tool);
        if (!check.allowed) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
            { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(plan.input), errorMessage: check.reason, reasonCode: check.detail?.reasonCode ?? "policy_denied", sequenceNumber: sequenceNumber++ });
          throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}: ${check.reason}`, 403);
        }
      }

      // Risk & Human Approval Policy Check
      const toolToAssess = plan.tool.includes(".") ? plan.tool : tool;
      if (this.riskApprovalService.requiresApproval(toolToAssess)) {
        const token = typeof plan.input._approvalToken === "string" ? plan.input._approvalToken : undefined;
        if (!token) {
          const req = this.riskApprovalService.createApprovalRequest(ctx, company.id, runId, agent.id, toolToAssess, plan.input);
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(plan.input),
            errorMessage: `Human approval required for high-risk operation '${toolToAssess}'. Approval request ID: ${req.id}`,
            reasonCode: "approval_required",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("APPROVAL_REQUIRED", `Tool "${toolToAssess}" requires human approval before execution. Approval request ID: ${req.id}`, 403);
        }

        const verification = this.riskApprovalService.verifyApprovalToken(token, ctx, company.id, runId, toolToAssess, plan.input);
        if (!verification.valid) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(plan.input),
            errorMessage: verification.reason ?? "Invalid approval token",
            reasonCode: verification.reasonCode ?? "invalid_approval_token",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("INVALID_APPROVAL_TOKEN", verification.reason ?? "Invalid approval token", 403);
        }

        const consumed = this.riskApprovalService.consumeToken(token);
        if (!consumed) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(plan.input),
            errorMessage: "Approval token has already been consumed (replay attempt blocked)",
            reasonCode: "already_consumed",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("APPROVAL_ALREADY_USED", "Approval token has already been consumed", 409);
        }
      }

      await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
        { agentId: agent.id, toolName: tool, decision: "allowed", status: "requested", inputSummary: summary(plan.input), sequenceNumber: sequenceNumber++ });
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
        const result = tool === "knowledge" ? knowledge : await this.toolRuntime.execute(ctx, company, tool, adapterInput, signal);
        const latencyMs = Math.round(performance.now() - toolStart);
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "allowed", status: "succeeded", inputSummary: summary(plan.input), latencyMs, sequenceNumber: sequenceNumber++ });
        evidence.push(`${agent.name} / ${tool}: ${json(result)}`);
      } catch (error) {
        if (signal.aborted) throw error;
        const latencyMs = Math.round(performance.now() - toolStart);
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, { agentId: agent.id, toolName: tool,
          decision: "allowed", status: "failed", inputSummary: summary(plan.input), latencyMs, sequenceNumber: sequenceNumber++,
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        evidence.push(`${agent.name} / ${tool} (failed): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return evidence.join("\n\n");
  }

  private async combos(company: Company, main: CompanyAgent, selected: CompanyAgent[], reviewer: CompanyAgent | undefined, mode: Mode, signal: AbortSignal) {
    if (!this.ai.ensureCombo) throw new CompanyRuntimeError("OMNIROUTE_COMBOS_UNAVAILABLE", "OmniRoute combos are unavailable", 503);
    const unique = [...new Map([...selected, main].map((agent) => [agent.id, agent])).values()], names = new Map<string, string>();
    for (const agent of unique) {
      const primary = comboModel(agent.modelId), fallback = comboModel(agent.fallbackModelId);
      const name = `npati/a/${digest(`${company.workspaceId}:${company.id}:${agent.id}:${agent.revision}`)}`;
      const allowed = agent.tools.map(toolName).map((item) => item.replace(/[^a-z0-9.]/gi, ""));
      await this.ai.ensureCombo({ name, strategy: "priority", models: [...new Set([primary, fallback])],
        description: `NPATI Company agent ${agent.name}`, system_message: instruction(company, agent, agent.id === main.id),
        tool_filter_regex: allowed.length ? `^(?:${allowed.join("|")})$` : "a^",
        config: { maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs } }, signal);
      names.set(agent.id, name);
    }
    const workers = selected.filter((agent) => agent.id !== main.id && agent.id !== reviewer?.id);
    if (mode === "single" && !workers.length && (!reviewer || reviewer.id === main.id))
      return { model: names.get(main.id)!, mode: "single" as const };
    const signature = digest(json({ company: company.id, mode, agents: unique.map((agent) => [agent.id, agent.revision]), reviewer: reviewer?.id }));
    if (mode === "fusion" && workers.length >= 2) {
      const fusion = `npati/f/${signature}`;
      await this.ai.ensureCombo({ name: fusion, strategy: "fusion",
        models: workers.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
        config: { nestedComboMode: "execute", judgeModel: comboModel(main.modelId), timeoutMs: this.timeoutMs,
          fusionTuning: { minPanel: 2, stragglerGraceMs: 4_000, panelHardTimeoutMs: Math.min(90_000, this.timeoutMs), maxPanel: MAX_SELECTED } } }, signal);
      if (!reviewer || reviewer.id === main.id) return { model: fusion, mode: "fusion" as const };
      const final = `npati/p/${digest(signature + ":review")}`;
      await this.ai.ensureCombo({ name: final, strategy: "pipeline", models: [
        { kind: "combo-ref", comboName: fusion }, { kind: "combo-ref", comboName: names.get(reviewer.id)! },
        { kind: "combo-ref", comboName: names.get(main.id)! }],
        config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs } }, signal);
      return { model: final, mode: "fusion" as const };
    }
    const chain = [...workers];
    if (reviewer && reviewer.id !== main.id && !chain.some((agent) => agent.id === reviewer.id)) chain.push(reviewer);
    chain.push(main);
    const pipeline = `npati/p/${signature}`;
    await this.ai.ensureCombo({ name: pipeline, strategy: "pipeline",
      models: chain.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
      config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs } }, signal);
    return { model: pipeline, mode: mode === "single" ? "single" as const : "pipeline" as const };
  }
}
