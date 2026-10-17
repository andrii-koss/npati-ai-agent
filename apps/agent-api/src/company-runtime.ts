import { isChatCapableModel, type AIEngine, type AIModelSummary, type ChatResult } from "@npati/omniroute-adapter";
import { chatInferenceCandidates, isUnavailableInferenceError } from "./chat-inference-candidates";
import type { AuthContext, Business, Company, CompanyAgent, CompanyAgentRunDetails, CompanyRunMode, Goal, MemoryItem, WorkspaceStore } from "@npati/workspace";
import { defaultEffectiveCapabilityResolver, EffectiveCapabilityResolver, defaultRiskApprovalService, RiskApprovalService } from "@npati/shared";
import type { CompanyToolExecutor } from "./company-tool-runtime";
import { SecurityPolicyEngine, SecurityPolicyViolation, type CompanyGuardrailPolicy } from "./security-guardrails";
import { CostTelemetry } from "./cost-telemetry";
import type { AuditRepository } from "./audit-repository";
import { chatLanguageInstruction } from "./company-chat-i18n";
import {
  MAX_CANDIDATES,
  MAX_SELECTED,
  DEFAULT_TIMEOUT,
  type Mode,
  type ToolPlan,
  type Plan,
  type MemoryScope,
  type DurableApprovalGateway,
  type LinkedBusinessContext,
  CompanyRuntimeError,
  digest,
  comboModel,
  toolName,
  json,
  instruction,
  parsePlan,
} from "./company-runtime-types";
import { executeCompanyRunTools } from "./company-runtime-tool-executor";

export * from "./company-runtime-types";

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

  async create(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; projectId?: string }, key: string) {
    return this.store.createCompanyAgentRun(ctx, companyId, { task: input.task, requestedMode: input.mode ?? "auto", projectId: input.projectId }, key);
  }

  async execute(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; noMemory?: boolean; memoryScope?: MemoryScope; preferredAgentId?: string; projectId?: string; suppressTools?: boolean; callBudget?: { remaining: number }; allowedProjectPaths?: string[]; allowedProjectId?: string; onTool?: (tool: string, path?: string) => void }, key: string, signal?: AbortSignal): Promise<CompanyAgentRunDetails> {
    const created = await this.create(ctx, companyId, input, key);
    if (!created.created) return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
    return this.process(ctx, companyId, created.run.id, { noMemory: input.noMemory === true, memoryScope: input.memoryScope, preferredAgentId: input.preferredAgentId, suppressTools: input.suppressTools, callBudget: input.callBudget, allowedProjectPaths: input.allowedProjectPaths, allowedProjectId: input.allowedProjectId, onTool: input.onTool, signal });
  }

  async process(ctx: AuthContext, companyId: string, runId: string, options: { noMemory?: boolean; memoryScope?: MemoryScope; preferredAgentId?: string; approvalId?: string; suppressTools?: boolean; callBudget?: { remaining: number }; allowedProjectPaths?: string[]; allowedProjectId?: string; onTool?: (tool: string, path?: string) => void; signal?: AbortSignal } = {}): Promise<CompanyAgentRunDetails> {
    const existing = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    if (options.approvalId && existing.run.status !== "awaiting_approval") throw new CompanyRuntimeError("APPROVAL_INVALID", "Run is not awaiting approval", 409);
    if (!options.approvalId && ["completed", "cancelled", "failed", "awaiting_approval"].includes(existing.run.status)) return existing;
    const pendingState = options.approvalId ? await this.store.getCompanyRunPendingPlan(ctx, companyId, runId) as { plan: Plan; nextToolIndex: number; evidence: string } | null : null;
    if (options.approvalId && (!pendingState || !pendingState.plan || !Number.isInteger(pendingState.nextToolIndex))) throw new CompanyRuntimeError("APPROVAL_INVALID", "Pending run plan is unavailable", 409);
    const created = { run: existing.run };
    const input = { task: existing.run.task, mode: existing.run.requestedMode };
    const controller = new AbortController(), timeout = AbortSignal.timeout(this.timeoutMs);
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
      await this.ai.ensureA2AEnabled();
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
          { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + (actionPlanningContext ? "\n\nMandatory action-sensitive rules:\n" + actionPlanningContext : "")) },
          {
            role: "user", content: protect([
              `Task: ${protectedTask}`, `Requested mode: ${input.mode ?? "auto"}`,
              projectChoices.length ? `Projects available to Project Files and Terminal tools: ${json(projectChoices, 10_000)}` : "",
              "Choose active agents only from this JSON:", json(candidates.map((agent) => ({
                id: agent.id, name: agent.name, role: agent.role, description: agent.description,
                tools: agent.tools.map(toolName).filter((tool) => !options.noMemory || !["knowledge", "files", "storage.company_memory"].includes(tool)),
              })), 30_000),
              'Return JSON only: {"mode":"single|pipeline|fusion","agentIds":["id"],"reviewerAgentId":"id or omit","toolRequests":[{"agentId":"id","tool":"tool id","input":{}}]}.',
              "Tool selection rules and input contracts (only request a tool allowed for that agent):",
              'web.search: {"query":"non-empty specific search query","maxResults":5,"searchType":"web or news"}. Use ONLY when live public external web information, competitor research, or current market facts are needed. Do NOT use for internal company data or general capability queries.',
              'web.fetch: {"url":"absolute https URL","format":"markdown"}; web.crawl: {"url":"absolute https URL","query":"research goal","maxPages":5}. Use when an explicit target URL needs to be read or crawled.',
              'audio.speech: {"text":"text to synthesize","voice":"alloy","format":"mp3"}.',
              'knowledge: {"query":"question about this Company"}; files: {"operation":"list"} or {"operation":"read","key":"known file key"}.',
              "Uploaded Company document questions are retrieved through knowledge. Never request files for document-content search; use files only when the agent explicitly has files and the task asks to list objects or read a known file key.",
              'storage.company_memory: {"operation":"list|search|get|create|update|delete","query":"for search","id":"for get/update/delete","content":"for create/update"}.',
              'project.files.list/search/read/create/write/edit/move/delete: input must include projectId (an actual Project ID in this Company). Path is workspace-relative. read/create/write/edit/move/delete need path (delete may use paths); search needs query; create/write need content; write/edit/move need expectedRevision returned by read/create; edit needs find and replacement; move needs to. Never request protected secret files. Delete always requires approval.',
              'project.media.upload/list/get/delete: manage website media assets (photos, videos, logos, assets) stored in isolated object storage. upload accepts {projectId, name, base64Data, mimeType?, targetDir?}; list accepts {projectId, prefix?}; get accepts {projectId, path}; delete accepts {projectId, path}. Returns public/preview URL for website pages and Live Preview.',
              'project.terminal.exec: {"projectId":"authorized Project ID","command":"sandbox command","environmentReferences":{"NAME":{"id":"Company vault credential UUID","field":"field name"}}}. project.terminal.process: {"projectId":"authorized Project ID","action":"start|status|logs|stop","command":"for start","processId":"for status/logs/stop"}. Commands run only in the remote Project sandbox. Use short, specific commands; unknown, destructive or shell-composed commands require approval. Never include secret values in commands or prompts; use vault references.',
              'project.preview.start: {"projectId":"authorized Project ID","command":"optional dev command","port":optional port}. project.preview.stop: {"projectId":"authorized Project ID"}. project.preview.status: {"projectId":"authorized Project ID"}. Used to launch, stop, and inspect the project preview dev server.',
              'project.git.status/diff/log/branch/stage/commit/restore/checkpoint/restore_checkpoint/push/pr: Git operations and checkpoints for the project workspace. commit needs message; restore needs files; checkpoint needs name; restore_checkpoint needs checkpointId; push and pr require explicit human approval and credentialId referencing a Company vault credential with a token field. Never put the token in tool input.',
              'project.deploy.publish: {"projectId":"authorized Project ID","credentialId":"Company vault credential UUID","environment":"production|staging|preview","provider":"dokploy","branch":"optional branch"}. project.deploy.status: {"projectId":"authorized Project ID","deploymentId":"optional ID"}. Deploy always requires explicit human approval before publishing. Never put API tokens directly in tool input.',
              'mcp: {"name":"permitted MCP tool name","arguments":{}}. Never invent tool names, URLs or file keys.',
              'browser.browser_tab_control: {"operation":"navigate","url":"absolute public https URL","profileId":"optional stable profile"}, {"operation":"extract","url":"optional URL","selector":"CSS selector","mode":"text|attribute","attribute":"when needed"}, {"operation":"pause","jobId":"running browser job id","profileId":"same profile"}, or {"operation":"resume","jobId":"paused/waiting browser job id","profileId":"same profile","resumeInput":{"task":"continuation and verification code/link if available"}}.',
              'browser.browser_clicktype for forms: {"operation":"fill_form","url":"optional URL","profileId":"profile","fields":[{"selector":"CSS selector","value":"non-secret value"},{"selector":"CSS selector","secretRef":"credentialAlias.field"}],"credentialRefs":[{"id":"vault credential id","alias":"credentialAlias"}],"submitSelector":"optional CSS selector"}. Never put passwords, tokens, OTPs or other secret values directly in tool input.',
              'browser.browser_clicktype for registration/autonomy: {"operation":"register_account|task","url":"public URL","allowedDomains":["site.example"],"task":"concrete browser goal mentioning credential aliases only","profileId":"profile","credentialRefs":[{"id":"vault credential id","alias":"account"}],"files":["optional Company attachment UUID"],"maxSteps":50,"waitForEmail":true,"emailHint":"expected sender email/domain"}. Use waitForEmail only after a task expected to send a verification email.',
              'browser.browser_downloads: {"operation":"upload","url":"optional URL","selector":"input[type=file]","files":["Company attachment UUID linked in Company Knowledge"],"profileId":"profile"}; browser.browser_screenshots: {"operation":"screenshot","url":"optional URL","fullPage":true}.',
              'exec (Code Mode): {"language":"javascript","code":"synchronous JavaScript","timeoutMs":2000}. Generate focused, self-contained code and use console.log for output. It is statically validated, has no filesystem, network, process, environment, require or imports, and always requires human approval.',
              options.noMemory ? "NO-MEMORY IS ACTIVE: toolRequests must not contain knowledge, files, or storage.company_memory." : "",
              "Populate required input fields with concrete values. Omit a tool request if you cannot supply its required input; never emit an empty input for web.search, web.fetch or web.crawl.",
              "Use pipeline for dependent work and fusion for independent parallel perspectives.",
            ].filter(Boolean).join("\n\n")),
          },
        ],
      };
      const projectWorker = existing.run.projectId && options.preferredAgentId
        ? candidates.find((agent) => agent.id === options.preferredAgentId)
        : undefined;
      if (projectWorker) {
        planningRequest.messages = [
          { role: "system", content: protect(
            instruction(company, main, true, !options.noMemory, linked) +
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
      let plan: Plan;
      if (pendingState) {
        plan = pendingState.plan;
      } else {
        const planningCandidates = [...planningModels];
        if (!this.strictInferenceRouting) {
          if (!planningCandidates.includes("auto")) planningCandidates.push("auto");
          if (!planningCandidates.includes("auto/smart")) planningCandidates.push("auto/smart");
        }
        let plannedModel = planningRequest.model;
        const planned = await (async () => {
          let lastError: unknown;
          for (const model of planningCandidates.length ? planningCandidates : [planningRequest.model, "auto"]) {
            try { const result = await this.ai.a2aSend!({ ...planningRequest, model }); plannedModel = model; return result; }
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
          const repaired = await this.ai.a2aSend!({
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
      const rawEvidence = options.suppressTools ? "" : await this.tools(ctx, company, created.run.id, normalizedToolRequests, byId, signal, knowledge, options.noMemory === true, options.approvalId, options.allowedProjectPaths, options.allowedProjectId ?? existing.run.projectId, existing.run.projectId, async (nextToolIndex, evidence) => { await this.store.setCompanyRunPendingPlan(ctx, companyId, created.run.id, { plan, nextToolIndex, evidence }); }, pendingState?.evidence, pendingState?.nextToolIndex ?? 0, existing.run.requestedMode, options.onTool);
      const evidence = rawEvidence ? protect(rawEvidence) : rawEvidence;
      const knowledgeContext = [
        knowledge.memories.length ? "Relevant Company Memory:\n" + knowledge.memories.map(item => item.content).join("\n") : "",
        knowledge.chunks.length ? "Authoritative Relevant Company Knowledge (use exact facts; do not invent replacements):\n" + knowledge.chunks.map(item => item.content).join("\n\n---\n\n") : "",
      ].filter(Boolean).join("\n\n");
      const execution = await this.combos(company, main, selected, reviewer, plan.mode, signal, !options.noMemory, linked, inferenceModels.length ? inferenceModels : undefined);
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
      if (options.callBudget && --options.callBudget.remaining < 0) throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
      let result = await this.ai.chat({
        model: execution.model, signal, timeoutMs: this.timeoutMs, admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" }, idempotencyKey: `${created.run.id}:final`,
        messages: [
          { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + chatLanguageInstruction(input.task) + (existing.run.projectId ? "\nThis final response cannot execute tools or save files. Summarize only verified tool results in at most 120 words. Do not output source code, patches, proposed edits or claim that unexecuted changes were saved. Build and Preview are handled by the project pipeline after this response." : "")) },
          { role: "user", content: protect([protectedTask, knowledgeContext, evidence && `Verified tool evidence:\n${evidence}`].filter(Boolean).join("\n\n")) },
        ],
      });
      let measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "final", execution.mode, result, 10_001);
      totalCost += measured.costUsd;
      totalTokens += measured.totalTokens;
      if (knowledgeContext) {
        if (options.callBudget && --options.callBudget.remaining < 0) throw new CompanyRuntimeError("MODEL_CALL_BUDGET_EXCEEDED", "Project model call limit reached", 429);
        result = await this.ai.chat({
          model: this.strictInferenceRouting ? inferenceModels[0] : comboModel(main.modelId), fallbackModel: this.strictInferenceRouting ? undefined : comboModel(main.fallbackModelId), signal, timeoutMs: this.timeoutMs, admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" }, idempotencyKey: `${created.run.id}:grounded-final`,
          messages: [
            { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + "\n\nYou are the final grounding verifier. Use the authoritative Company Knowledge below as the source of truth. Preserve exact relevant values. Remove unsupported claims. Never omit the direct answer requested by the user." + chatLanguageInstruction(input.task) + (existing.run.projectId ? "\nSummarize only verified tool results in at most 120 words. Do not output source code or proposed edits. This response cannot save files; Build and Preview are handled by the project pipeline." : "")) },
            { role: "user", content: protect([protectedTask, knowledgeContext, `Delegated draft to verify:\n${result.content}`, "Return only the corrected, knowledge-grounded final answer."].join("\n\n")) },
          ],
        });
        measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "grounded-final", execution.mode, result, 10_002);
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
      if (!awaitingApproval) await this.store.setCompanyRunPendingPlan(ctx, companyId, created.run.id, null);
    } finally { this.controllers.delete(created.run.id); }
    return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
  }

  async list(ctx: AuthContext, companyId: string, limit = 50) {
    return this.store.listCompanyAgentRuns(ctx, companyId, limit);
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

  private async combos(company: Company, main: CompanyAgent, selected: CompanyAgent[], reviewer: CompanyAgent | undefined, mode: Mode, signal: AbortSignal, includeMemory = true, linked?: LinkedBusinessContext, inferenceModels?: string[]) {
    if (!this.ai.ensureCombo) throw new CompanyRuntimeError("OMNIROUTE_COMBOS_UNAVAILABLE", "NPATI AI routing combinations are unavailable", 503);
    const unique = [...new Map([...selected, main].map((agent) => [agent.id, agent])).values()], names = new Map<string, string>();
    for (const agent of unique) {
      const agentModels = inferenceModels?.length
        ? [...new Set([agent.modelId, agent.fallbackModelId, ...inferenceModels].filter((model): model is string => Boolean(model && inferenceModels.includes(model))))]
        : undefined;
      const primary = agentModels?.[0] ?? comboModel(agent.modelId), fallback = agentModels?.[1] ?? comboModel(agent.fallbackModelId);
      const allowed = agent.tools.map(toolName).map((item) => item.replace(/[^a-z0-9.]/gi, ""));
      const comboCandidateModels = agentModels?.length ? [...agentModels] : [...new Set([primary, fallback])];
      if (!this.strictInferenceRouting) {
        if (!comboCandidateModels.includes("auto")) comboCandidateModels.push("auto");
        if (!comboCandidateModels.includes("auto/smart")) comboCandidateModels.push("auto/smart");
      }
      // OmniRoute keeps an existing combo unchanged. Include its effective routing
      // and prompt in the identity so a Settings change cannot reuse an old provider.
      const systemMessage = instruction(company, agent, agent.id === main.id, includeMemory, linked);
      const name = `npati/a/${digest(JSON.stringify({ workspace: company.workspaceId, company: company.id, agent: agent.id, revision: agent.revision, models: comboCandidateModels, systemMessage, tools: allowed, timeoutMs: this.timeoutMs }))}`;
      await this.ai.ensureCombo({
        name, strategy: "priority", models: comboCandidateModels,
        description: `NPATI Company agent ${agent.name}`, system_message: systemMessage,
        tool_filter_regex: allowed.length ? `^(?:${allowed.join("|")})$` : "a^",
        config: { maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs }
      }, signal);
      names.set(agent.id, name);
    }
    const workers = selected.filter((agent) => agent.id !== main.id && agent.id !== reviewer?.id);
    if (mode === "single" && !workers.length && (!reviewer || reviewer.id === main.id))
      return { model: names.get(main.id)!, mode: "single" as const };
    const signature = digest(json({ company: company.id, mode, agents: unique.map((agent) => [agent.id, names.get(agent.id)]), reviewer: reviewer?.id, judgeModel: this.strictInferenceRouting ? inferenceModels?.[0] : comboModel(main.modelId) }));
    if (mode === "fusion" && workers.length >= 2) {
      const fusion = `npati/f/${signature}`;
      await this.ai.ensureCombo({
        name: fusion, strategy: "fusion",
        models: workers.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
        config: {
          nestedComboMode: "execute", judgeModel: this.strictInferenceRouting ? inferenceModels?.[0] : comboModel(main.modelId), timeoutMs: this.timeoutMs,
          fusionTuning: { minPanel: 2, stragglerGraceMs: 4_000, panelHardTimeoutMs: Math.min(90_000, this.timeoutMs), maxPanel: MAX_SELECTED }
        }
      }, signal);
      if (!reviewer || reviewer.id === main.id) return { model: fusion, mode: "fusion" as const };
      const final = `npati/p/${digest(signature + ":review")}`;
      await this.ai.ensureCombo({
        name: final, strategy: "pipeline", models: [
          { kind: "combo-ref", comboName: fusion }, { kind: "combo-ref", comboName: names.get(reviewer.id)! },
          { kind: "combo-ref", comboName: names.get(main.id)! }],
        config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs }
      }, signal);
      return { model: final, mode: "fusion" as const };
    }
    const chain = [...workers];
    if (reviewer && reviewer.id !== main.id && !chain.some((agent) => agent.id === reviewer.id)) chain.push(reviewer);
    chain.push(main);
    const pipeline = `npati/p/${signature}`;
    await this.ai.ensureCombo({
      name: pipeline, strategy: "pipeline",
      models: chain.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
      config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: this.timeoutMs }
    }, signal);
    return { model: pipeline, mode: mode === "single" ? "single" as const : "pipeline" as const };
  }
}
