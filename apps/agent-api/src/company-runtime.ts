import { configureCompanyCombos } from "./company-runtime-combos";
import { companyChatEntityReferencesPrompt, companyChatRecentTurnsPrompt } from "./project-chat-cards";
import { CODING_RESPONSE_STYLE } from "./coding-response-style";
import { canonicalJson, sha256 } from "@npati/workspace";
import { randomUUID } from "node:crypto";

import type { ChatToolDefinition } from "@npati/omniroute-adapter";
import { chatCapabilityParameters } from "./chat-project-data-capabilities";
import { validateArguments } from "./code-tool-runtime-guards";
import { isChatCapableModel, type AIEngine, type AIModelSummary, type ChatResult } from "@npati/omniroute-adapter";
import { chatInferenceCandidates, isUnavailableInferenceError } from "./chat-inference-candidates";
import type { AuthContext, Business, Company, CompanyAgent, CompanyAgentRunDetails, CompanyRunMode, Goal, MemoryItem, WorkspaceStore } from "@npati/workspace";
import { defaultEffectiveCapabilityResolver, EffectiveCapabilityResolver, defaultRiskApprovalService, RiskApprovalService } from "@npati/shared";
import type { CompanyToolExecutor } from "./company-tool-runtime";
import { SecurityPolicyEngine, SecurityPolicyViolation, type CompanyGuardrailPolicy } from "./security-guardrails";
import { CostTelemetry } from "./cost-telemetry";
import type { AuditRepository } from "./audit-repository";
import { chatLanguageInstruction } from "./company-chat-i18n";
import { companyPlanningGuidanceAllowed, MAX_CANDIDATES, MAX_SELECTED, DEFAULT_TIMEOUT, type ToolPlan, type Plan, type MemoryScope, type DurableApprovalGateway, type LinkedBusinessContext, CompanyRuntimeError, comboModel, toolName, json, instruction, parsePlan } from "./company-runtime-types";
import { executeChatCapability, authorizedChatProjectTools, chatCapabilityExecutor } from "./company-runtime-chat-capability";
import { executeAgentStages } from "./company-runtime-stages";
import { executeCompanyRunTools } from "./company-runtime-tool-executor";
import { asAccount } from "./ai-tenant-providers";
export * from "./company-runtime-types";
/**
 * A whole company run has no deadline: only Stop (cancel) ends it. The former 120 s run cap ended a multi-agent
 * report with RUN_TIMEOUT while every model call was still answering (V6 step 12, owner rule: no limits that end a
 * user's work). Each model call keeps its own timeout as a guard against a hung provider. An operator can still set
 * NPATI_COMPANY_RUN_DEADLINE_MS.
 */
/** A run map that reports additions and removals, so the in-process heartbeat starts and stops with the work. */
class ObservedRunMap extends Map<string, AbortController> {
  constructor(private readonly changed: () => void) { super(); }
  override set(key: string, value: AbortController) { super.set(key, value); this.changed?.(); return this; }
  override delete(key: string) { const removed = super.delete(key); this.changed?.(); return removed; }
}

function runDeadline(): AbortSignal {
  const ms = Number(process.env.NPATI_COMPANY_RUN_DEADLINE_MS ?? 0);
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(ms) : new AbortController().signal;
}

/**
 * Company agents whose exact names appear in the task as whole words. Longer names are matched first and blanked, so
 * "Reviewer" is not found inside "Accessibility Reviewer".
 */
export function agentsNamedInTask<T extends { name: string }>(task: string, agents: T[]): T[] {
  let text = task.toLocaleLowerCase();
  const found: T[] = [];
  for (const agent of [...agents].sort((a, b) => b.name.trim().length - a.name.trim().length)) {
    const name = agent.name.trim().toLocaleLowerCase();
    if (name.length < 3) continue;
    const pattern = new RegExp("(?<![\\p{L}\\p{N}])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}])", "gu");
    if (!pattern.test(text)) continue;
    found.push(agent);
    text = text.replace(pattern, " ");
  }
  return agents.filter((agent) => found.includes(agent));
}

/** This process's mark on the runs it executes itself; a worker's claimed runs carry a lease instead. */
const INLINE_RUN_OWNER = `inline:${process.env.HOSTNAME ?? "api"}:${process.pid}:${randomUUID().slice(0, 8)}`;
export const INLINE_RUN_HEARTBEAT_MS = 20_000;
/** A run whose process has not renewed it for this long is closed as interrupted (see failOrphanedInlineCompanyAgentRuns). */
export const INLINE_RUN_STALE_MS = 120_000;

export class CompanyDelegationRuntime {
  private readonly controllers = new ObservedRunMap(() => this.inlineRunsChanged());
  private readonly held = new Set<string>();
  private inlineHeartbeat?: ReturnType<typeof setInterval>;
  /** Keeps a run this process executes outside `process` (a project plan's parent run) marked as alive. */
  holdInline(runId: string): () => void {
    this.held.add(runId); this.inlineRunsChanged();
    return () => { this.held.delete(runId); this.inlineRunsChanged(); };
  }
  private inlineRunsChanged() {
    const active = this.controllers.size + this.held.size > 0;
    if (active && !this.inlineHeartbeat && this.store.heartbeatInlineCompanyAgentRuns) {
      this.inlineHeartbeat = setInterval(() => void this.renewInlineRuns(), INLINE_RUN_HEARTBEAT_MS);
      this.inlineHeartbeat.unref?.();
    } else if (!active && this.inlineHeartbeat) { clearInterval(this.inlineHeartbeat); this.inlineHeartbeat = undefined; }
  }
  async renewInlineRuns() {
    const ids = [...new Set([...this.controllers.keys(), ...this.held])];
    if (ids.length) await this.store.heartbeatInlineCompanyAgentRuns?.(INLINE_RUN_OWNER, ids).catch(() => 0);
  }
  private readonly toolRuntime: CompanyToolExecutor;
  private readonly capabilityResolver: EffectiveCapabilityResolver;
  private readonly riskApprovalService: RiskApprovalService;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly ai: AIEngine,
    private readonly timeoutMs = DEFAULT_TIMEOUT,
    toolRuntime?: CompanyToolExecutor,
    private readonly knowledgeRetriever?: (ctx: AuthContext, companyId: string, query: string, scope?: MemoryScope) => Promise<{ chunks: Array<{ content: string }>; memories: Array<{ content: string; source?: string; metadata?: Record<string, unknown> }> }>,
    capabilityResolver?: EffectiveCapabilityResolver,
    riskApprovalService?: RiskApprovalService,
    private readonly guardrailPolicyResolver?: (ctx: AuthContext, companyId: string) => Promise<CompanyGuardrailPolicy>,
    private readonly durableApprovals?: DurableApprovalGateway,
    private readonly telemetry?: Pick<AuditRepository, "recordUsage" | "log">,
    private readonly userDocumentRetriever?: (ctx: AuthContext) => Promise<string | undefined>,
    private readonly addedModelsResolver?: (ctx: AuthContext) => Promise<AIModelSummary[]>,
    private readonly strictInferenceRouting = false,
  ) {
    this.toolRuntime = toolRuntime ?? { execute: async (_context, _company, tool, input) => this.ai.executeTool(tool, input) };
    this.capabilityResolver = capabilityResolver ?? defaultEffectiveCapabilityResolver;
    this.riskApprovalService = riskApprovalService ?? defaultRiskApprovalService;
  }
  /** The chat loop selects a canonical tool; this runtime keeps its existing authorization, approval and audit boundary. */
  async chatProjectTools(ctx: AuthContext, companyId: string, projectId: string, requested: string[]): Promise<ChatToolDefinition[]> {
    return authorizedChatProjectTools(ctx, companyId, projectId, requested, { store: this.store, capabilityResolver: this.capabilityResolver });
  }
  async executeChatProjectTool(ctx: AuthContext, companyId: string, projectId: string, tool: string, args: Record<string,unknown>, key: string, signal?: AbortSignal, noMemory=false): Promise<{output:unknown;runId:string}> {
    const offered=await this.chatProjectTools(ctx,companyId,projectId,[tool]);
    if(!offered.length)throw new CompanyRuntimeError("TOOL_FORBIDDEN","No active Company agent is authorized for the requested capability",403);
    validateArguments(chatCapabilityParameters(tool),args,tool);
    if(args.projectId!==projectId)throw new CompanyRuntimeError("PROJECT_SCOPE_MISMATCH","Tool targets another project",403);
    const company = await this.store.getCompany(ctx, companyId);
    const main = await chatCapabilityExecutor(ctx, companyId, tool, { store: this.store, capabilityResolver: this.capabilityResolver });
    if (!main) throw new CompanyRuntimeError("TOOL_FORBIDDEN", "No active Company agent is authorized for this capability", 403);
    const task="Chat capability: "+tool+" #"+sha256(canonicalJson(args));
    const created=await this.create(ctx,companyId,{task,projectId,mode:"single"},key);
    if(created.run.task!==task)throw new CompanyRuntimeError("IDEMPOTENCY_CONFLICT","Tool call identity was reused with different arguments",409);
    if(!created.created){const previous=await this.store.getCompanyAgentRun(ctx,companyId,created.run.id);if(previous.run.status!=="completed")throw new CompanyRuntimeError("RUN_NOT_COMPLETED","Previous capability execution did not complete; inspect its run trace",409);return{output:JSON.parse(previous.run.result??"null"),runId:previous.run.id};}
    const plan: Plan = { mode: "single", agentIds: [main.id], toolRequests: [{ agentId: main.id, tool, input: args }] };
    return this.runChatCapability(ctx, company, created.run.id, plan, signal, noMemory);
  }
  private async runChatCapability(ctx: AuthContext, company: Company, runId: string, plan: Plan, parentSignal?: AbortSignal, noMemory = false, approvalId?: string) {
    const controller = new AbortController(); this.controllers.set(runId, controller);
    const signal = AbortSignal.any([controller.signal, runDeadline(), ...(parentSignal ? [parentSignal] : [])]);
    try {
      return await executeChatCapability({ ctx, company, runId, plan, signal, noMemory, approvalId,
        store: this.store, toolRuntime: this.toolRuntime, capabilityResolver: this.capabilityResolver,
        riskApprovalService: this.riskApprovalService, durableApprovals: this.durableApprovals, telemetry: this.telemetry,
        policy: await this.guardrailPolicyResolver?.(ctx, company.id) });
    } finally { this.controllers.delete(runId); }
  }
  async create(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; projectId?: string }, key: string) {
    return this.store.createCompanyAgentRun(ctx, companyId, { task: input.task, requestedMode: input.mode ?? "auto", projectId: input.projectId }, key);
  }
  /** Runs as `ctx`'s account on a hosted installation, so webhook and automation runs use that account's own AI key. */
  async execute(...args: Parameters<CompanyDelegationRuntime["executeInAccountScope"]>): Promise<CompanyAgentRunDetails> {
    return asAccount(args[0], () => this.executeInAccountScope(...args));
  }

  async executeInAccountScope(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; noMemory?: boolean; conversationId?: string; memoryScope?: MemoryScope; preferredAgentId?: string; projectId?: string; suppressTools?: boolean; callBudget?: { remaining: number }; allowedProjectPaths?: string[]; allowedProjectId?: string; onTool?: (tool: string, path?: string) => void }, key: string, signal?: AbortSignal): Promise<CompanyAgentRunDetails> {
    const created = await this.create(ctx, companyId, input, key);
    if (!created.created) return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
    return this.process(ctx, companyId, created.run.id, { noMemory: input.noMemory === true, conversationId: input.conversationId, memoryScope: input.memoryScope, preferredAgentId: input.preferredAgentId, suppressTools: input.suppressTools, callBudget: input.callBudget, allowedProjectPaths: input.allowedProjectPaths, allowedProjectId: input.allowedProjectId, onTool: input.onTool, signal });
  }
  async process(ctx: AuthContext, companyId: string, runId: string, options: { noMemory?: boolean; conversationId?: string; memoryScope?: MemoryScope; preferredAgentId?: string; approvalId?: string; suppressTools?: boolean; callBudget?: { remaining: number }; allowedProjectPaths?: string[]; allowedProjectId?: string; onTool?: (tool: string, path?: string) => void; signal?: AbortSignal } = {}): Promise<CompanyAgentRunDetails> {
    const existing = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    if (options.approvalId && existing.run.status !== "awaiting_approval") throw new CompanyRuntimeError("APPROVAL_INVALID", "Run is not awaiting approval", 409);
    if (!options.approvalId && ["completed", "cancelled", "failed", "awaiting_approval"].includes(existing.run.status)) return existing;
    const pendingState = options.approvalId ? await this.store.getCompanyRunPendingPlan(ctx, companyId, runId) as { plan: Plan; nextToolIndex: number; evidence: string; noMemory?: boolean; conversationId?: string } | null : null;
    if (options.approvalId && (!pendingState || !pendingState.plan || !Number.isInteger(pendingState.nextToolIndex))) throw new CompanyRuntimeError("APPROVAL_INVALID", "Pending run plan is unavailable", 409);
    if (pendingState?.conversationId) options = { ...options, conversationId: pendingState.conversationId };
    if (pendingState?.noMemory) options = { ...options, noMemory: true };
    if (options.approvalId && pendingState && existing.run.task.startsWith("Chat capability: ")) {
      const request = pendingState.plan.toolRequests[0];
      if (pendingState.plan.toolRequests.length !== 1 || !request || !existing.run.projectId
        || request.input.projectId !== existing.run.projectId
        || existing.run.task !== "Chat capability: " + request.tool + " #" + sha256(canonicalJson(request.input)))
        throw new CompanyRuntimeError("APPROVAL_INVALID", "Pending capability does not match its run", 409);
      const offered = await this.chatProjectTools(ctx, companyId, existing.run.projectId, [request.tool]);
      if (!offered.length) throw new CompanyRuntimeError("TOOL_FORBIDDEN", "Capability permission was revoked", 403);
      validateArguments(chatCapabilityParameters(request.tool), request.input, request.tool);
      await this.runChatCapability(ctx, await this.store.getCompany(ctx, companyId), runId, pendingState.plan, options.signal, options.noMemory, options.approvalId);
      return this.store.getCompanyAgentRun(ctx, companyId, runId);
    }
    const created = { run: existing.run };
    const input = { task: existing.run.task, mode: existing.run.requestedMode };
    const controller = new AbortController(), timeout = runDeadline();
    const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const runStartedAt = Date.now();
    let totalCost = 0;
    let totalTokens = 0;
    this.controllers.set(created.run.id, controller);
    try {
      if (!this.ai.a2aSend || !this.ai.ensureCombo || !this.ai.ensureA2AEnabled)
        throw new CompanyRuntimeError("OMNIROUTE_ORCHESTRATION_UNAVAILABLE", "NPATI AI orchestration is unavailable", 503);
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
      if (!options.noMemory && this.userDocumentRetriever) {
        const userMarkdown = await this.userDocumentRetriever(ctx);
        if (userMarkdown) company = { ...company, memory: { ...company.memory, userMd: { markdown: userMarkdown } } };
      }
      let linkedBusiness: Business | undefined;
      let linkedGoals: Goal[] = [];
      let linkedMemories: MemoryItem[] = [];
      if (company.businessId) {
        try {
          linkedBusiness = await this.store.getBusiness(ctx, company.businessId);
          linkedGoals = await this.store.listGoals(ctx, company.businessId);
          if (!options.noMemory) {
            linkedMemories = await this.store.listMemory(ctx, company.businessId);
          }
        } catch {
          // Linked business may have been removed or inaccessible
        }
      }
      const linked: LinkedBusinessContext = { business: linkedBusiness, goals: linkedGoals, memories: linkedMemories };
      const guardrailPolicy = await this.guardrailPolicyResolver?.(ctx, companyId);
      const protect = (text: string) => SecurityPolicyEngine.protectText(text, guardrailPolicy).sanitized;
      const protectedTask = protect(input.task.trim());
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
      // Recent chat turns go to the planner here and to every agent stage in its user message: an agent's OmniRoute combo
      // supplies its own system prompt, so a system-only context never reached the agents.
      const recentTurns = !options.noMemory && options.conversationId ? await companyChatRecentTurnsPrompt(this.store, ctx, options.conversationId, input.task).catch(() => "") : "";
      const entityContext = !options.noMemory && options.conversationId ? await companyChatEntityReferencesPrompt(this.store, ctx, options.conversationId, companyId, existing.run.projectId ?? undefined) + recentTurns : "";
      const mainTools = main.tools.map(toolName);
      const knowledgeRequested =
        /\b(?:find|search|look\s+up|read|extract|summari[sz]e)\b[^.\n]{0,80}\b(?:uploaded|company)\s+(?:document|documents|file|files|spreadsheet)\b|\b(?:excel|xlsx)\b|(?:знайд|пошук|прочита|витяг|проаналіз)[^.\n]{0,80}(?:у|в|із|з)\s+(?:завантажен\w*\s+)?(?:документ|файл|таблиц)\w*|\bексел\w*/iu.test(
          input.task,
        );
      if (!options.noMemory && knowledgeRequested && !mainTools.includes("knowledge")) {
        throw new CompanyRuntimeError(
          "KNOWLEDGE_PERMISSION_REQUIRED",
          `Company Knowledge is disabled for Main Agent "${main.name}". Open Company → edit the Main Agent → enable Knowledge, then retry.`,
          403,
        );
      }
      const page = await this.store.listCompanyAgentsPage(ctx, companyId, MAX_CANDIDATES);
      const candidates = page.items.filter((agent) => agent.isActive);
      if (!candidates.some((agent) => agent.id === main.id)) candidates.unshift(main);
      const projectChoices = candidates.some((agent) => agent.tools.some((tool) => (toolName(tool).startsWith("project.files.") || toolName(tool).startsWith("project.terminal.") || toolName(tool).startsWith("project.preview.") || toolName(tool).startsWith("project.data.") || toolName(tool).startsWith("project.auth."))))
        ? (await this.store.listProjects(ctx, companyId)).slice(0, 50).map((project) => ({ id: project.id, name: project.name, type: project.type })) : [];
      const planningMemory = !options.noMemory && mainTools.includes("knowledge") && this.knowledgeRetriever ? await this.knowledgeRetriever(ctx, companyId, input.task, options.memoryScope).catch(() => ({ chunks: [], memories: [] })) : { chunks: [], memories: [] };
      const actionPlanningContext = planningMemory.memories.filter(memory => memory.source === "action_sensitive").map(memory => memory.content).join("\n");
      if (!pendingState && options.callBudget && --options.callBudget.remaining < 0) throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
      const resolvedAddedModels = typeof this.addedModelsResolver === "function" ? (await this.addedModelsResolver(ctx).catch(() => [])) : [];
      const inferenceModels = this.strictInferenceRouting
        ? resolvedAddedModels.filter(isChatCapableModel).map((model) => model.id)
        : chatInferenceCandidates(
          candidates.map((agent) => agent.modelId).concat(candidates.map((agent) => agent.fallbackModelId)),
          resolvedAddedModels,
          await this.ai.listModels?.().catch(() => []) ?? [],
        );
      if (this.strictInferenceRouting && inferenceModels.length === 0) throw new CompanyRuntimeError("model_unavailable", "No chat-compatible inference model is available for this Project", 503);
      const userAddedModelIds = resolvedAddedModels.map((m) => m.id);
      const planningModels = [...new Set([...userAddedModelIds, main.modelId, main.fallbackModelId, ...inferenceModels].filter((model): model is string => Boolean(model && inferenceModels.includes(model))))];
      const planningRequest: Parameters<NonNullable<AIEngine["a2aSend"]>>[0] = {
        model: planningModels[0] ?? (main.modelId && isChatCapableModel({ id: main.modelId }) ? main.modelId : "auto"), timeoutMs: Math.min(60_000, this.timeoutMs), signal,
        idempotencyKey: `${created.run.id}:plan`,
        messages: [
          { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + entityContext + (actionPlanningContext ? "\n\nMandatory action-sensitive rules:\n" + actionPlanningContext : "")) },
          {
            role: "user", content: protect([
              `Task: ${protectedTask}`, `Requested mode: ${input.mode ?? "auto"}`,
              projectChoices.length ? `Projects available to Project Files and Terminal tools: ${json(projectChoices, 10_000)}` : "",
              "Choose active agents only from this JSON:", json(candidates.map((agent) => ({
                id: agent.id, name: agent.name, role: agent.role, description: agent.description,
                tools: agent.tools.map(toolName).filter((tool) => !options.noMemory || !["knowledge", "files", "storage.company_memory"].includes(tool)),
              })), 30_000),
              'When a named Main Agent authors work for a distinct reviewer, include the author Main Agent ID in agentIds. A sole reviewer cannot review its own output.',
              'Return JSON only: {"mode":"single|pipeline|fusion","agentIds":["id"],"reviewerAgentId":"id or omit","toolRequests":[{"agentId":"id","tool":"tool id","input":{}}]}.',
              "Tool selection rules and input contracts (only request a tool allowed for that agent):",
              'web.search: {"query":"non-empty specific search query","maxResults":5,"searchType":"web or news"}. Use ONLY when live public external web information, competitor research, or current market facts are needed. Do NOT use for internal company data or general capability queries.',
              'web.fetch: {"url":"absolute https URL","format":"markdown"}; web.crawl: {"url":"absolute https URL","query":"research goal","maxPages":5}. Use when an explicit target URL needs to be read or crawled.',
              'audio.speech: {"text":"text to synthesize","voice":"alloy","format":"mp3"}.',
              'knowledge: {"query":"question about this Company"}; files: {"operation":"list"} or {"operation":"read","key":"known file key"}.',
              "Uploaded Company document questions are retrieved through knowledge. Never request files for document-content search; use files only when the agent explicitly has files and the task asks to list objects or read a known file key.",
              'storage.company_memory: {"operation":"list|search|get|create|update|delete","query":"for search","id":"for get/update/delete","content":"for create/update"}.',
              'project.files.list/search/read/create/write/edit/move/delete: input must include projectId (an actual Project ID in this Company). Path is workspace-relative. read/create/write/edit/move/delete need path (delete may use paths); search needs query; create/write need content; write/edit/move need expectedRevision returned by read/create; edit needs find and replacement; move needs to. Never request protected secret files. Delete always requires approval.',
              'A review of an existing Project requires its actual source evidence: list/search the selected Project, then read the relevant files using an authorized agent. Prior assistant descriptions are not source evidence. When no selected agent can read those files, report that exact limitation; do not claim to have reviewed the implementation.',
              'project.media.upload/list/get/delete: manage website media assets (photos, videos, logos, assets) stored in isolated object storage. upload accepts {projectId, name, base64Data, mimeType?, targetDir?}; list accepts {projectId, prefix?}; get accepts {projectId, path}; delete accepts {projectId, path}. Returns public/preview URL for website pages and Live Preview.',
              'project.terminal.exec: {"projectId":"authorized Project ID","command":"sandbox command","environmentReferences":{"NAME":{"id":"Company vault credential UUID","field":"field name"}}}. project.terminal.process: {"projectId":"authorized Project ID","action":"start|status|logs|stop","command":"for start","processId":"for status/logs/stop"}. Commands run only in the remote Project sandbox. Use short, specific commands; unknown, destructive or shell-composed commands require approval. Never include secret values in commands or prompts; use vault references.',
              'project.preview.start: {"projectId":"authorized Project ID","command":"optional dev command","port":optional port}. project.preview.stop: {"projectId":"authorized Project ID"}. project.preview.status: {"projectId":"authorized Project ID"}. Used to launch, stop, and inspect the project preview dev server.',
              'project.git.status/diff/log/branch/stage/commit/restore/checkpoint/restore_checkpoint/push/pr: Git operations and checkpoints for the project workspace. commit needs message; restore needs files; checkpoint needs name; restore_checkpoint needs checkpointId; push and pr require explicit human approval and credentialId referencing a Company vault credential with a token field. Never put the token in tool input.',
              'project.deploy.publish: {"projectId":"authorized Project ID","credentialId":"Company vault credential UUID","environment":"production|staging|preview","provider":"dokploy","branch":"optional branch"}. project.deploy.status: {"projectId":"authorized Project ID","deploymentId":"optional ID"}. Deploy always requires explicit human approval before publishing. Never put API tokens directly in tool input.',
              'mcp: {"name":"permitted MCP tool name","arguments":{}}. Never invent tool names, URLs or file keys.',
              'browser.browser_tab_control: {"operation":"navigate","url":"absolute public https URL","profileId":"optional stable profile"}, {"operation":"extract","url":"optional URL","selector":"CSS selector","mode":"text|attribute","attribute":"when needed"}, {"operation":"pause","jobId":"running browser job id","profileId":"same profile"}, or {"operation":"resume","jobId":"paused/waiting browser job id","profileId":"same profile","resumeInput":{"task":"continuation and verification code/link if available"}}.',
              'browser.browser_clicktype for forms: {"operation":"fill_form","url":"optional URL","profileId":"profile","fields":[{"selector":"CSS selector","value":"non-secret value"},{"selector":"CSS selector","secretRef":"credentialAlias.field"}],"credentialRefs":[{"id":"vault credential id","alias":"credentialAlias"}],"submitSelector":"optional CSS selector"}. Never put passwords, tokens, OTPs or other secret values directly in tool input.',
              'browser.browser_clicktype for registration/autonomy: {"operation":"register_account|task","url":"public URL","allowedDomains":["site.example"],"task":"concrete browser goal mentioning credential aliases only","profileId":"profile","credentialRefs":[{"id":"vault credential id","alias":"account"}],"files":["optional Company attachment UUID"],"maxSteps":50,"waitForEmail":true,"emailHint":"expected sender email/domain"}. Use waitForEmail only after a task expected to send a verification email.',
              'browser.browser_downloads: {"operation":"upload","url":"optional URL","selector":"input[type=file]","files":["Company attachment UUID linked in Company Knowledge"],"profileId":"profile"}; browser.browser_screenshots: {"operation":"screenshot","url":"optional URL","fullPage":true}. A screenshot returns only an artifact ID: you cannot see it, so never describe or cite what it shows; page facts come only from navigate/extract results (V6 step 11: a heading was claimed visible in a screenshot of a page without one).',
              'exec (Code Mode): {"language":"javascript","code":"synchronous JavaScript","timeoutMs":2000}. Generate focused, self-contained code and use console.log for output. It is statically validated, has no filesystem, network, process, environment, require or imports, and always requires human approval.',
              options.noMemory ? "NO-MEMORY IS ACTIVE: toolRequests must not contain knowledge, files, or storage.company_memory." : "",
              "Populate required input fields with concrete values. Omit a tool request if you cannot supply its required input; never emit an empty input for web.search, web.fetch or web.crawl.",
              "Use pipeline for dependent work and fusion for independent parallel perspectives.",
            ].filter(Boolean).filter(line => companyPlanningGuidanceAllowed(line, candidates.flatMap(agent => agent.tools.map(toolName)).filter(tool => !options.noMemory || !["knowledge", "files", "storage.company_memory"].includes(tool)))).join("\n\n")),
          },
        ],
      };
      const projectWorker = existing.run.projectId && options.preferredAgentId
        ? candidates.find((agent) => agent.id === options.preferredAgentId)
        : undefined;
      if (projectWorker) {
        planningRequest.messages = [
          { role: "system", content: protect(
            instruction(company, main, true, !options.noMemory, linked) + entityContext +
            "\n\nPlan this single Project task. Return exactly one valid JSON object with no markdown. " +
            "Use the assigned agent only. Never invent tool names, Project IDs, file revisions, or file contents."
          ) },
          { role: "user", content: protect([
            `Project ID: ${existing.run.projectId}`,
            `Assigned agent ID: ${projectWorker.id}`,
            `Allowed tools: ${projectWorker.tools.map(toolName).join(", ")}`,
            `Task: ${protectedTask.slice(0, 6000)}`,
            "Return JSON with mode single, agentIds containing only the assigned agent ID, and toolRequests. " +
              "Each tool request needs agentId, tool, and input. Project tools need the exact Project ID. " +
              "For file changes, inspect files first and use the revision returned by the file tool; " +
              "omit any operation whose required inputs are unknown.",
          ].join("\n\n")) },
        ];
      }
      let a2aReady = false, planningSequence = 0;
      const sendPlanningRequest = async (request: Parameters<NonNullable<AIEngine["a2aSend"]>>[0]) => {
        // OmniRoute's A2A smart-routing transport has a fixed 30s inner timeout and cannot forward thinking mode.
        // Use the same existing engine for DeepSeek's bounded JSON plan, retaining run policy/cancellation/accounting.
        if (request.model === "deepseek/deepseek-flash") {
          const result = await this.ai.chat({ ...request, reasoningMode: "disabled",
            admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" } });
          const measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "planning", "single", result, planningSequence++);
          totalCost += measured.costUsd; totalTokens += measured.totalTokens;
          return { content: result.content, taskId: undefined, metadata: {} };
        }
        if (!a2aReady) { await this.ai.ensureA2AEnabled!(); a2aReady = true; }
        return this.ai.a2aSend!(request);
      };
      let plan: Plan;
      let plannedModel = planningRequest.model;
      if (pendingState) {
        plan = pendingState.plan;
      } else {
        const planningCandidates = [...planningModels];
        if (!this.strictInferenceRouting) {
          if (!planningCandidates.includes("auto")) planningCandidates.push("auto");
          if (!planningCandidates.includes("auto/smart")) planningCandidates.push("auto/smart");
        }
        const planned = await (async () => {
          let lastError: unknown;
          for (const model of planningCandidates.length ? planningCandidates : [planningRequest.model, "auto"]) {
            try { const result = await sendPlanningRequest({ ...planningRequest, model }); plannedModel = model; return result; }
            catch (error) { lastError = error; if (!isUnavailableInferenceError(error)) throw error; }
          }
          throw new CompanyRuntimeError("model_routing_failed", `All chat-compatible models failed: ${String(lastError)}`, 503);
        })();
        await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { omnirouteTaskId: planned.taskId });
        try {
          plan = parsePlan(planned.content, input.mode ?? "auto");
        } catch (error) {
          if (!(error instanceof CompanyRuntimeError) || error.code !== "INVALID_DELEGATION_PLAN" ||
            !existing.run.projectId || !options.preferredAgentId) throw error;
          if (options.callBudget && --options.callBudget.remaining < 0)
            throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
          const preferred = candidates.find((agent) => agent.id === options.preferredAgentId);
          if (!preferred) throw new CompanyRuntimeError("BOUND_AGENT_UNAVAILABLE", "The bound Company Agent is inactive or unavailable", 409);
          const repaired = await sendPlanningRequest({
            ...planningRequest, model: plannedModel,
            idempotencyKey: `${created.run.id}:plan-repair`,
            messages: [
              { role: "system", content: "Return exactly one valid JSON object. No markdown or explanation. Keys: mode, agentIds, toolRequests. mode must be single. Use only the provided agent ID and permitted tools." },
              { role: "user", content: [
                `Project ID: ${existing.run.projectId}`,
                `Agent ID: ${preferred.id}`,
                `Permitted tools: ${preferred.tools.map(toolName).join(", ")}`,
                `Task: ${protectedTask.slice(0, 3000)}`,
                `Previous response to repair: ${planned.content.slice(0, 3000)}`,
                `Required shape: {"mode":"single","agentIds":["${preferred.id}"],"toolRequests":[]}`,
              ].join("\n") },
            ],
          });
          plan = parsePlan(repaired.content, "single");
          await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { omnirouteTaskId: repaired.taskId });
        }
      }
      const byId = new Map(candidates.map((agent) => [agent.id, agent]));
      if (options.preferredAgentId) {
        const preferred = byId.get(options.preferredAgentId);
        if (!preferred) throw new CompanyRuntimeError("BOUND_AGENT_UNAVAILABLE", "The bound Company Agent is inactive or unavailable", 409);
        plan.mode = "single";
        plan.agentIds = [preferred.id];
        plan.reviewerAgentId = undefined;
        plan.toolRequests = plan.toolRequests.filter((request) => request.agentId === preferred.id);
      }
      // Some models answer with this company's agent names instead of their ids; an exact name of one of the
      // candidates is that agent. Anything else still fails as an unavailable selection.
      const resolveAgentId = (value: string | undefined) => {
        if (!value || byId.has(value)) return value;
        const named = candidates.filter((agent) => agent.name.trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase());
        return named.length === 1 ? named[0]!.id : value;
      };
      plan.agentIds = plan.agentIds.map((id) => resolveAgentId(id)!);
      plan.reviewerAgentId = resolveAgentId(plan.reviewerAgentId);
      plan.toolRequests = plan.toolRequests.map((request) => ({ ...request, agentId: resolveAgentId(request.agentId)! }));
      // Two or more company agents named in the request are its participants: "ask Designer and Reviewer" ran Designer
      // and Accessibility Reviewer, whose name only contains "Reviewer" (V6 step 14, A041).
      const named = agentsNamedInTask(input.task, candidates);
      if (!options.preferredAgentId && named.length >= 2) {
        plan.agentIds = named.map((agent) => agent.id);
        if (plan.mode === "single") plan.mode = "pipeline";
        if (plan.reviewerAgentId && !plan.agentIds.includes(plan.reviewerAgentId)) plan.reviewerAgentId = undefined;
        plan.toolRequests = plan.toolRequests.filter((request) => plan.agentIds.includes(request.agentId));
      }
      if (plan.agentIds.some((id) => !byId.has(id)) && !options.preferredAgentId) {
        // One repair of the agent selection: the plan named agents this company does not have. The repaired plan is
        // validated exactly like the first one, so a second invalid selection still fails the run.
        if (options.callBudget && --options.callBudget.remaining < 0)
          throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
        const roster = candidates.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role }));
        const repaired = await sendPlanningRequest({
          ...planningRequest, model: plannedModel,
          idempotencyKey: `${created.run.id}:selection-repair`,
          messages: [
            ...planningRequest.messages,
            { role: "user", content: `The plan selected agents that do not exist in this company: ${JSON.stringify(plan.agentIds.filter((id) => !byId.has(id))).slice(0, 500)}. Use only these agent IDs: ${JSON.stringify(roster).slice(0, 4000)}. Return the corrected JSON plan only.` },
          ],
        });
        const corrected = parsePlan(repaired.content, input.mode ?? "auto");
        corrected.agentIds = corrected.agentIds.map((id) => resolveAgentId(id)!);
        corrected.reviewerAgentId = resolveAgentId(corrected.reviewerAgentId);
        corrected.toolRequests = corrected.toolRequests.map((request) => ({ ...request, agentId: resolveAgentId(request.agentId)! }));
        plan = corrected;
      }
      // One repair of tool requests the selected agents are not permitted to use: a plan that asks for a forbidden
      // tool again still fails closed with TOOL_FORBIDDEN in the executor, and no forbidden tool ever runs.
      const agentFor = (id: string) => byId.get(id) ?? (id === main.id ? main : undefined);
      const forbiddenRequests = (candidate: typeof plan) => candidate.toolRequests.filter((request) => {
        const agent = agentFor(request.agentId);
        return agent && !agent.tools.map(toolName).includes(toolName(request.tool));
      });
      if (forbiddenRequests(plan).length && !options.preferredAgentId) {
        if (options.callBudget && --options.callBudget.remaining < 0)
          throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
        const permitted = [main, ...candidates.filter((agent) => agent.id !== main.id)].map((agent) => ({ id: agent.id, name: agent.name, tools: agent.tools.map(toolName) }));
        const repaired = await sendPlanningRequest({
          ...planningRequest, model: plannedModel,
          idempotencyKey: `${created.run.id}:tool-repair`,
          messages: [
            ...planningRequest.messages,
            { role: "user", content: `These tool requests are not permitted for their agents: ${JSON.stringify(forbiddenRequests(plan).map((request) => ({ agentId: request.agentId, tool: request.tool }))).slice(0, 1000)}. Each agent may request only its own tools: ${JSON.stringify(permitted).slice(0, 4000)}. Return the corrected JSON plan only; omit a tool request when no permitted tool fits.` },
          ],
        });
        const corrected = parsePlan(repaired.content, input.mode ?? "auto");
        corrected.agentIds = corrected.agentIds.map((id) => resolveAgentId(id)!);
        corrected.reviewerAgentId = resolveAgentId(corrected.reviewerAgentId);
        corrected.toolRequests = corrected.toolRequests.map((request) => ({ ...request, agentId: resolveAgentId(request.agentId)! }));
        plan = corrected;
      }
      const mainAssignedWork = plan.agentIds.includes(main.id);
      let selected = plan.agentIds.map((id) => byId.get(id)).filter((agent): agent is CompanyAgent => Boolean(agent));
      if (selected.length !== plan.agentIds.length) throw new CompanyRuntimeError("CROSS_COMPANY_AGENT_SELECTION", "Main Agent selected an unavailable agent", 502);
      selected = selected.filter((agent) => agent.id !== main.id);
      if (selected.length > MAX_SELECTED) throw new CompanyRuntimeError("TOO_MANY_DELEGATES", `At most ${MAX_SELECTED} agents may run`);
      let reviewer = plan.reviewerAgentId ? byId.get(plan.reviewerAgentId) : undefined;
      if (plan.reviewerAgentId && !reviewer) throw new CompanyRuntimeError("INVALID_REVIEWER", "Reviewer is not active in this company", 502);
      const plannedReviewer = reviewer;
      if (plannedReviewer && plannedReviewer.id !== main.id && !selected.some((agent) => agent.id === plannedReviewer.id)) selected.push(plannedReviewer);
      // Cycle and loop protection
      if (plan.toolRequests.length > 20) {
        throw new CompanyRuntimeError("TOOL_LOOP_DETECTED", "Too many tool requests in delegation plan", 400);
      }
      // An agent never reviews only its own work. When the plan names the sole worker as its reviewer ("доручи QA Tester
      // вичитати текст" makes the QA agent both), it keeps the work and the Main Agent gives the final check instead of
      // failing the user's task.
      if (reviewer && selected.length === 1 && selected[0]?.id === reviewer.id && !mainAssignedWork) reviewer = undefined;
      // Retrieved chunks are injected only into the Main Agent's final/grounding calls.
      // Specialists still require their own allowlist entry for direct knowledge tool calls.
      const knowledgeAllowed = !options.noMemory && mainTools.includes("knowledge");
      const retrieved = knowledgeAllowed && this.knowledgeRetriever ? await this.knowledgeRetriever(ctx, companyId, [input.task, ...plan.toolRequests.map(request=>request.tool)].join(" "), options.memoryScope).catch(() => ({ chunks: [], memories: [] })) : { chunks: [], memories: [] };
      const knowledge = {
        chunks: retrieved.chunks.map(item => ({ content: protect(item.content) })),
        memories: retrieved.memories.map(item => ({ content: protect(item.content), source: item.source, metadata: item.metadata })),
      };
      const normalizedToolRequests = plan.toolRequests.map((request) => {
        const requestingAgent = byId.get(request.agentId);
        const allowed = new Set(requestingAgent?.tools.map(toolName) ?? []);
        if (toolName(request.tool) === "files" && !allowed.has("files") && allowed.has("knowledge") && knowledgeAllowed) {
          return { ...request, tool: "knowledge", input: SecurityPolicyEngine.protectObject({ query: input.task.trim() }, guardrailPolicy) };
        }
        return { ...request, input: SecurityPolicyEngine.protectObject(request.input, guardrailPolicy) };
      });
      const rawEvidence = options.suppressTools ? "" : await this.tools(ctx, company, created.run.id, normalizedToolRequests, byId, signal, knowledge, options.noMemory === true, options.approvalId, options.allowedProjectPaths, options.allowedProjectId ?? existing.run.projectId, existing.run.projectId, async (nextToolIndex, evidence) => { await this.store.setCompanyRunPendingPlan(ctx, companyId, created.run.id, { plan, nextToolIndex, evidence, noMemory: options.noMemory === true, conversationId: options.conversationId }); }, pendingState?.evidence, pendingState?.nextToolIndex ?? 0, existing.run.requestedMode, options.onTool);
      // A plan cannot name files before it has listed them. When project evidence holds only a listing or search, one
      // bounded follow-up planning call may request read-only project.files.read (at most 5) for the selected agents.
      const readers = [main, ...selected.filter((agent) => agent.id !== main.id)].filter((agent) => agent.tools.map(toolName).includes("project.files.read"));
      const plannedTool = (name: string) => plan.toolRequests.some((request) => toolName(request.tool) === name);
      let followUpEvidence = "";
      if (rawEvidence && !pendingState && !options.suppressTools && readers.length && !plannedTool("project.files.read")
        && (plannedTool("project.files.list") || plannedTool("project.files.search"))) {
        if (options.callBudget && --options.callBudget.remaining < 0)
          throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
        const followUp = await sendPlanningRequest({
          ...planningRequest, model: plannedModel,
          idempotencyKey: `${created.run.id}:read-follow-up`,
          messages: [
            ...planningRequest.messages,
            { role: "user", content: protect(`Verified tool evidence:\n${rawEvidence.slice(0, 12_000)}\n\nKeep the same mode and agentIds. Return the JSON plan with toolRequests containing only project.files.read for the listed files this task needs (at most 5, exact projectId and path), by one of these agents: ${json(readers.map((agent) => ({ id: agent.id, name: agent.name })), 2_000)}. Use an empty toolRequests array when no file must be read.`) },
          ],
        });
        let reads: ToolPlan[] = [];
        try { reads = parsePlan(followUp.content, plan.mode).toolRequests; }
        catch (error) { if (!(error instanceof CompanyRuntimeError)) throw error; }
        reads = reads.map((request) => ({ ...request, agentId: resolveAgentId(request.agentId)!, input: SecurityPolicyEngine.protectObject(request.input, guardrailPolicy) }))
          .filter((request) => toolName(request.tool) === "project.files.read" && readers.some((agent) => agent.id === request.agentId)).slice(0, 5);
        if (reads.length) followUpEvidence = await this.tools(ctx, company, created.run.id, reads, new Map([...byId, [main.id, main]]), signal, knowledge, options.noMemory === true, undefined, options.allowedProjectPaths, options.allowedProjectId ?? existing.run.projectId, existing.run.projectId, undefined, undefined, 0, existing.run.requestedMode, options.onTool);
      }
      const combinedEvidence = [rawEvidence, followUpEvidence].filter(Boolean).join("\n\n");
      const evidence = combinedEvidence ? protect(combinedEvidence) : combinedEvidence;
      // A project run whose agents read nothing must not present a source review as done (A041); no tool is granted.
      const sourceLimitation = existing.run.projectId && !combinedEvidence
        ? "\n\nRuntime note: no project source or data was read in this run (no selected agent holds a project read tool). Do not report findings about the project's code or data; state that the result is not based on its source." : "";
      const knowledgeContext = [
        knowledge.memories.length ? "Relevant Company Memory:\n" + knowledge.memories.map(item => item.content).join("\n") : "",
        knowledge.chunks.length ? "Authoritative Relevant Company Knowledge (use exact facts; do not invent replacements):\n" + knowledge.chunks.map(item => item.content).join("\n\n---\n\n") : "",
      ].filter(Boolean).join("\n\n");
      const execution = await this.combos(company, main, selected, reviewer, plan.mode, signal, !options.noMemory, linked, inferenceModels.length ? inferenceModels : undefined, mainAssignedWork);
      const ids = [...new Set([...selected.map((agent) => agent.id), main.id])];
      await this.store.replaceCompanyAgentRunSteps(ctx, companyId, created.run.id, ids.map((id, index) => {
        const agent = byId.get(id) ?? main;
        return {
          agentId: id, stepOrder: plan.mode === "fusion" && id !== main.id ? 0 : index,
          lane: plan.mode === "fusion" && id !== main.id ? index : 0,
          role: id === main.id ? "manager" as const : reviewer?.id === id ? "reviewer" as const : "worker" as const,
          status: "delegated" as const, modelId: this.strictInferenceRouting ? inferenceModels[0]! : agent.modelId ?? "auto"
        };
      }));
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id,
        { status: "running", executionMode: execution.mode, selectedAgentIds: ids, omnirouteComboName: execution.model });
      if ((await this.store.getCompanyAgentRun(ctx, companyId, created.run.id)).run.cancelRequested)
        throw new DOMException("Cancelled", "AbortError");
      let inferenceSequence = 10_001;
      let result = await executeAgentStages({ ai: this.ai, main, selected, reviewer, mainAssignedWork, mode: plan.mode,
        agentModels: execution.agentModels, signal, timeoutMs: this.timeoutMs, task: protectedTask + sourceLimitation, evidence,
        managerInstruction: protect(instruction(company, main, true, !options.noMemory, linked) + entityContext + chatLanguageInstruction(input.task)
          + (existing.run.projectId ? "\n" + CODING_RESPONSE_STYLE + "\nThis response cannot execute tools or save files." : "")),
        knowledgeContext, entityContext, conversationContext: protect(recentTurns.trim()), runId: created.run.id,
        isRuntimeRunId: id => this.store.getCompanyAgentRun(ctx, companyId, id).then(() => true, () => false),
        admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" },
        before: async () => {
          if (options.callBudget && --options.callBudget.remaining < 0) throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
          signal.throwIfAborted();
        },
        completed: async (agentId, answer) => {
          answer.content = SecurityPolicyEngine.protectText(SecurityPolicyEngine.redactText(answer.content, guardrailPolicy), guardrailPolicy).sanitized;
          const measured = await this.recordInference(ctx, companyId, created.run.id, agentId, "agent-result", execution.mode, answer, inferenceSequence++);
          totalCost += measured.costUsd; totalTokens += measured.totalTokens;
          await this.store.updateCompanyAgentRunStep(ctx, companyId, created.run.id, agentId, "completed");
        },
        failed: async (agentId, error) => {
          await this.store.updateCompanyAgentRunStep(ctx, companyId, created.run.id, agentId, signal.aborted ? "cancelled" : "failed");
          await this.store.appendCompanyAgentToolAudit(ctx, companyId, created.run.id, { agentId, toolName: "ai.inference", decision: "allowed", status: "failed", inputSummary: { phase: "agent-result" }, errorMessage: error instanceof CompanyRuntimeError ? error.message : "Agent inference did not complete" });
        },
      });
      let measured: Awaited<ReturnType<CompanyDelegationRuntime["recordInference"]>>;
      if (knowledgeContext) {
        if (options.callBudget && --options.callBudget.remaining < 0) throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
        result = await this.ai.chat({
          model: this.strictInferenceRouting ? inferenceModels[0] : comboModel(main.modelId), fallbackModel: this.strictInferenceRouting ? undefined : comboModel(main.fallbackModelId), signal, timeoutMs: this.timeoutMs, admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" }, idempotencyKey: `${created.run.id}:grounded-final`,
          messages: [
            { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + entityContext + "\n\nYou are the final grounding verifier. Use the authoritative Company Knowledge below as the source of truth. Preserve exact relevant values. Remove unsupported claims. Never omit the direct answer requested by the user." + chatLanguageInstruction(input.task) + (existing.run.projectId ? "\n" + CODING_RESPONSE_STYLE + "\nDo not output source code or proposed edits. This response cannot save files; Build and Preview are handled by the project pipeline." : "")) },
            { role: "user", content: protect([protectedTask, knowledgeContext, `Delegated draft to verify:\n${result.content}`, "Return only the corrected, knowledge-grounded final answer. A screenshot is shown to the user as an image; nobody in this run has seen it, so never state what it shows.", chatLanguageInstruction(input.task).trim()].join("\n\n")) },
          ],
        });
        measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "grounded-final", execution.mode, result, inferenceSequence++);
        totalCost += measured.costUsd;
        totalTokens += measured.totalTokens;
      }
      await this.store.setCompanyRunPendingPlan(ctx, companyId, created.run.id, null);
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
        status: "completed",
        result: result.content,
        errorCode: "",
        errorMessage: "",
        totalCost,
        totalTokens,
        totalDurationMs: Math.max(0, Date.now() - runStartedAt),
      });
    } catch (error) {
      const current = await this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
      const cancelled = current.run.cancelRequested || controller.signal.aborted || Boolean(options.signal?.aborted), timedOut = !cancelled && timeout.aborted;
      const awaitingApproval = !cancelled && !timedOut && error instanceof CompanyRuntimeError && error.code === "APPROVAL_REQUIRED";
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
        status: cancelled ? "cancelled" : awaitingApproval ? "awaiting_approval" : "failed",
        errorCode: cancelled ? "RUN_CANCELLED" : timedOut ? "RUN_TIMEOUT" : error instanceof CompanyRuntimeError ? error.code : error instanceof SecurityPolicyViolation ? error.code : "RUN_FAILED",
        errorMessage: cancelled ? "Company run was cancelled" : timedOut ? "Company run exceeded its timeout" : (error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI"),
        totalCost,
        totalTokens,
        totalDurationMs: Math.max(0, Date.now() - runStartedAt),
      });
      if (!awaitingApproval) for (const step of current.steps.filter(step => step.status === "delegated" || step.status === "selected"))
        await this.store.updateCompanyAgentRunStep(ctx, companyId, created.run.id, step.agentId, "cancelled");
      if (!awaitingApproval) await this.store.setCompanyRunPendingPlan(ctx, companyId, created.run.id, null);
    } finally { this.controllers.delete(created.run.id); }
    return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
  }
  async list(ctx: AuthContext, companyId: string, limit = 50, filter?: { contentOnly?: boolean }) {
    return this.store.listCompanyAgentRuns(ctx, companyId, limit, filter);
  }
  async get(ctx: AuthContext, companyId: string, runId: string) {
    return this.store.getCompanyAgentRun(ctx, companyId, runId);
  }
  async recordBackgroundEvent(ctx: AuthContext, companyId: string, runId: string, entry: Parameters<WorkspaceStore["appendCompanyAgentRunEvent"]>[3]) {
    return this.store.appendCompanyAgentRunEvent(ctx, companyId, runId, entry);
  }
  async cancel(ctx: AuthContext, companyId: string, runId: string) {
    const current = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    if (["completed", "failed", "cancelled"].includes(current.run.status)) return current;
    // A second cancel (the queue's broadcast reaching the worker) after the owning process already requested it: the
    // owner may have finished the run as cancelled meanwhile, and rewriting "cancelling" left it there forever (V6 step 12).
    if (current.run.status === "cancelling" && !this.controllers.has(runId)) return current;
    if (current.run.status === "queued" || current.run.status === "awaiting_approval") {
      await this.store.setCompanyRunPendingPlan(ctx, companyId, runId, null);
      await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelled", cancelRequested: true, errorCode: "RUN_CANCELLED", errorMessage: "Company run was cancelled" });
      const cancelled = await this.store.getCompanyAgentRun(ctx, companyId, runId);
      await this.recordBackgroundEvent(ctx, companyId, runId, {
        eventKey: "cancelled", eventType: "cancelled", runStatus: "cancelled",
        workerId: cancelled.run.workerId, attemptCount: cancelled.run.attemptCount, message: "Background run cancelled by user",
        details: { errorCode: "RUN_CANCELLED" }
      });
      return this.store.getCompanyAgentRun(ctx, companyId, runId);
    }
    await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelling", cancelRequested: true });
    this.controllers.get(runId)?.abort();
    if (current.run.omnirouteTaskId && this.ai.cancelA2ATask)
      await this.ai.cancelA2ATask(current.run.omnirouteTaskId).catch(() => undefined);
    const cancelling = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    await this.recordBackgroundEvent(ctx, companyId, runId, {
      eventKey: `attempt:${cancelling.run.attemptCount}:cancelling`,
      eventType: "cancelled", runStatus: "cancelling", workerId: cancelling.run.workerId,
      attemptCount: cancelling.run.attemptCount, message: "Cancellation requested for active background run"
    });
    return cancelling;
  }
  private async recordInference(
    ctx: AuthContext,
    companyId: string,
    runId: string,
    agentId: string,
    phase: string,
    strategy: string,
    result: ChatResult,
    sequenceNumber: number,
  ) {
    const modelId = result.model ?? "auto";
    const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const upstreamCost = result.telemetry?.costUsd;
    const calculated = CostTelemetry.calculate(modelId, usage);
    const costUsd = upstreamCost ?? calculated.totalCostUsd;
    const costSource = upstreamCost != null ? "upstream" as const : "estimated" as const;
    const providerId = result.telemetry?.provider ?? modelId.split("/", 1)[0] ?? "unknown";
    const inputSummary = {
      phase,
      ...(phase === "agent-result" ? { result: result.content } : {}),
      requestId: result.telemetry?.requestId,
      providerId,
      modelId,
      routingStrategy: result.telemetry?.routingStrategy ?? strategy,
      cacheHit: result.telemetry?.cacheHit ?? false,
      cachedTokens: usage.cachedTokens ?? 0,
      cacheSavingsUsd: result.telemetry?.cacheSavingsUsd ?? 0,
      failoverCount: result.telemetry?.failoverCount ?? 0,
      costSource,
    };
    await this.store.appendCompanyAgentToolAudit(ctx, companyId, runId, {
      agentId,
      toolName: "ai.inference",
      decision: "allowed",
      status: "succeeded",
      inputSummary,
      latencyMs: result.telemetry?.latencyMs ?? 0,
      cost: costUsd,
      tokens: usage.totalTokens,
      reasonCode: "routing_decision",
      sequenceNumber,
    });
    if (this.telemetry) {
      await Promise.all([
        this.telemetry.recordUsage(ctx, companyId, {
          agentId,
          modelId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUsd,
          latencyMs: result.telemetry?.latencyMs ?? 0,
          requestId: result.telemetry?.requestId ?? `${runId}:${phase}`,
          providerId,
          routingStrategy: result.telemetry?.routingStrategy ?? strategy,
          cacheHit: result.telemetry?.cacheHit ?? false,
          cachedTokens: usage.cachedTokens ?? 0,
          cacheSavingsUsd: result.telemetry?.cacheSavingsUsd ?? 0,
          failoverCount: result.telemetry?.failoverCount ?? 0,
          costSource,
        }),
        this.telemetry.log(ctx, companyId, {
          action: "ai.inference.completed",
          category: "agent",
          resourceType: "company_agent_run",
          resourceId: runId,
          details: inputSummary,
        }),
      ]);
    }
    return { costUsd, totalTokens: usage.totalTokens };
  }
  private async tools(
    ctx: AuthContext,
    company: Company,
    runId: string,
    plans: ToolPlan[],
    agents: Map<string, CompanyAgent>,
    signal: AbortSignal,
    knowledge: { chunks: Array<{ content: string }>; memories: Array<{ content: string; source?: string; metadata?: Record<string, unknown> }> },
    noMemory = false,
    approvalId?: string,
    allowedProjectPaths?: string[],
    allowedProjectId?: string,
    runProjectId?: string,
    onApprovalPending?: (nextToolIndex: number, evidence: string) => Promise<void>,
    previousEvidence?: string,
    startIndex = 0,
    runType = "company_run",
    onTool?: (tool: string, path?: string) => void,
  ) {
    return executeCompanyRunTools({
      ctx,
      company,
      runId,
      plans,
      agents,
      signal,
      knowledge,
      noMemory,
      approvalId,
      allowedProjectPaths,
      allowedProjectId,
      runProjectId,
      onApprovalPending,
      previousEvidence,
      startIndex,
      runType,
      onTool,
      store: this.store,
      toolRuntime: this.toolRuntime,
      capabilityResolver: this.capabilityResolver,
      riskApprovalService: this.riskApprovalService,
      durableApprovals: this.durableApprovals,
      telemetry: this.telemetry,
    });
  }
  private combos(...args: Parameters<typeof configureCompanyCombos> extends [unknown, ...infer Args] ? Args : never) {
    return configureCompanyCombos({ ai: this.ai, strictInferenceRouting: this.strictInferenceRouting, timeoutMs: this.timeoutMs }, ...args);
  }
}
