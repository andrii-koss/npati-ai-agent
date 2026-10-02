import { classifyTerminalCommand } from "./terminal-command-policy";
import { createHash } from "node:crypto";
import type { AIEngine, ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, Business, Company, CompanyAgent, CompanyAgentRunDetails, CompanyRunMode, Goal, MemoryItem, WorkspaceStore } from "@npati/workspace";
import { defaultEffectiveCapabilityResolver, EffectiveCapabilityResolver, defaultRiskApprovalService, RiskApprovalService } from "@npati/shared";
import type { CompanyToolExecutor } from "./company-tool-runtime";
import {SecurityPolicyEngine,SecurityPolicyViolation,type CompanyGuardrailPolicy} from "./security-guardrails";
import {AutoExecReviewer} from "./auto-exec-reviewer";
import { CostTelemetry } from "./cost-telemetry";
import type { AuditRepository } from "./audit-repository";
import { chatLanguageInstruction } from "./company-chat-i18n";

const MAX_CANDIDATES = 60, MAX_SELECTED = 12, DEFAULT_TIMEOUT = 120_000;
type Mode = Exclude<CompanyRunMode, "auto">;
type ToolPlan = { agentId: string; tool: string; input: Record<string, unknown> };
type Plan = { mode: Mode; agentIds: string[]; reviewerAgentId?: string; toolRequests: ToolPlan[] };
type MemoryScope = { apiKeyId?: string; sessionId?: string };
export interface DurableApprovalGateway {
  requestApproval(ctx:AuthContext,companyId:string,input:{runId:string;agentId:string;toolName:string;riskLevel:"high"|"critical";actionSummary:string;inputPayload:Record<string,unknown>}):Promise<{id:string}>;
  consumeApproved(ctx:AuthContext,companyId:string,id:string,input:{runId:string;agentId:string;toolName:string;inputPayload:Record<string,unknown>}):Promise<unknown>;
}

export function companyRunTelemetryHeaders(details: CompanyAgentRunDetails) {
  const inference = details.toolAudit.filter((entry) => entry.toolName === "ai.inference");
  const latest = inference.at(-1)?.inputSummary ?? {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return CostTelemetry.getRunTelemetryHeaders({
    requestId: details.run.id,
    modelId: typeof latest.modelId === "string" ? latest.modelId : details.run.omnirouteComboName,
    provider: typeof latest.providerId === "string" ? latest.providerId : undefined,
    strategy: typeof latest.routingStrategy === "string" ? latest.routingStrategy : details.run.executionMode ?? details.run.requestedMode,
    totalTokens: details.run.totalTokens,
    totalCostUsd: details.run.totalCost,
    latencyMs: details.run.totalDurationMs,
    cacheHit: inference.some((entry) => entry.inputSummary.cacheHit === true),
    cachedTokens: inference.reduce((total, entry) => total + number(entry.inputSummary.cachedTokens), 0),
    cacheSavingsUsd: inference.reduce((total, entry) => total + number(entry.inputSummary.cacheSavingsUsd), 0),
    failoverCount: inference.reduce((total, entry) => total + number(entry.inputSummary.failoverCount), 0),
    costSource: inference.some((entry) => entry.inputSummary.costSource === "upstream") ? "upstream" : "estimated",
  });
}

export class CompanyRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const comboModel = (value: string | null | undefined) => value == null || value === "auto" ? "auto/smart" : value;
function toolName(value: string) {
  const raw = value.trim().toLowerCase();
  const key = raw.replace(/[ _-]+/g, ".");
  const displayKey = raw.replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
  const browserDisplayAliases: Record<string, string> = {
    "browser.navigation.jobs": "browser.browser_tab_control",
    "browser.forms.autonomous.tasks": "browser.browser_clicktype",
    "browser.screenshots": "browser.browser_screenshots",
    "browser.file.transfer": "browser.browser_downloads",
  };
  if (browserDisplayAliases[displayKey]) return browserDisplayAliases[displayKey]!;
  const browserAliases: Record<string, string> = {
    "browser.browser.tab.control": "browser.browser_tab_control",
    "browser.browser.clicktype": "browser.browser_clicktype",
    "browser.browser.snapshots": "browser.browser_snapshots",
    "browser.browser.screenshots": "browser.browser_screenshots",
    "browser.browser.downloads": "browser.browser_downloads",
  };
  if (browserAliases[key]) return browserAliases[key]!;
  if (raw.startsWith("omniroute_") || key.startsWith("mcp.")) return "mcp";
  if (key.startsWith("files.")) return "files";
  return ({ "websearch": "web.search", "web.search": "web.search", "webfetch": "web.fetch", "web.fetch": "web.fetch",
    crawler: "web.crawl", "web.crawl": "web.crawl", "text-to-speech": "audio.speech", tts: "audio.speech", "audio.speech": "audio.speech",
    mcp: "mcp", files: "files", knowledge: "knowledge", exec: "exec", code: "exec", "company.memory":"storage.company_memory", "storage.company.memory":"storage.company_memory" } as Record<string, string>)[key] ?? key;
}
function summary(input: Record<string, unknown>) {
  return SecurityPolicyEngine.redactObject(Object.fromEntries(Object.entries(input).slice(0, 20).map(([key, value]) => [
    key, /token|secret|password|api.?key|authorization|content|replacement|find/i.test(key) ? "[REDACTED]"
      : typeof value === "string" ? value.slice(0, 500)
      : typeof value === "number" || typeof value === "boolean" || value === null ? value : "[structured value]",
  ])));
}
export function hasScopedBrowserAuthorization(
  ctx: AuthContext,
  tool: string,
  operation: string,
  input: Record<string, unknown>,
) {
  if (ctx.permissions.includes("browser:resume_email") &&
      tool === "browser.browser_tab_control" && operation === "resume") {
    return typeof input.jobId === "string" && Boolean(input.jobId.trim());
  }
  if (!ctx.permissions.includes("automation:execute_browser") ||
      tool !== "browser.browser_clicktype" ||
      !["register_account", "task"].includes(operation)) return false;
  const domains = Array.isArray(input.allowedDomains)
    ? input.allowedDomains.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 50)
    : [];
  if (!domains.length || typeof input.url !== "string") return false;
  try {
    const hostname = new URL(input.url).hostname.toLowerCase();
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
function json(value: unknown, max = 20_000) {
  try { return JSON.stringify(value).slice(0, max); } catch { return "[unserializable]"; }
}
interface LinkedBusinessContext {
  business?: Business;
  goals?: Goal[];
  memories?: MemoryItem[];
}

function context(company: Company, includeMemory = true, linked?: LinkedBusinessContext) {
  const parts: (string | false | undefined | null)[] = [
    `Company: ${company.name}`,
    company.website && `Website: ${company.website}`,
    company.industry && `Industry: ${company.industry}`,
    company.description && `Description: ${company.description}`,
    company.productsServices && `Products / Services: ${company.productsServices}`,
    company.languages.length > 0 && `Languages: ${company.languages.join(", ")}`,
    company.brandTone && `Brand tone: ${company.brandTone}`,
    company.companyInstructions && `Company instructions: ${company.companyInstructions}`,
  ];

  if (linked?.business) {
    const b = linked.business;
    parts.push(
      `\n=== LINKED BUSINESS IDEA / PROFILE ===`,
      `Business Idea Name: ${b.name}`,
      `Stage: ${b.businessStage}`,
      b.industry && `Industry: ${b.industry}`,
      b.niche && `Niche: ${b.niche}`,
      b.market && `Market: ${b.market}`,
      b.country && `Country: ${b.country}`,
      b.teamType && `Team: ${b.teamType}`,
      b.presenceType && `Presence: ${b.presenceType}`,
      b.businessModel && `Business Model: ${b.businessModel}`,
      b.website && `Website: ${b.website}`,
      b.description && `Description: ${b.description}`,
      b.productsServicesSummary && `Products / Services: ${b.productsServicesSummary}`,
      b.audienceSummary && `Target Audience: ${b.audienceSummary}`,
    );
  }

  if (linked?.goals && linked.goals.length > 0) {
    parts.push(
      `\n=== LINKED BUSINESS GOALS ===`,
      ...linked.goals.map((g, i) => `${i + 1}. [${g.status.toUpperCase()}] ${g.title}${g.description ? `: ${g.description}` : ""}${g.targetValue ? ` (Target: ${g.targetValue} ${g.targetUnit ?? ""})` : ""}${g.targetDate ? ` (Due: ${g.targetDate})` : ""}`),
    );
  }

  if (includeMemory && linked?.memories && linked.memories.length > 0) {
    parts.push(
      `\n=== LINKED BUSINESS MEMORY ===`,
      ...linked.memories.map((m, i) => `${i + 1}. [${m.type}] ${m.title}: ${m.content}`),
    );
  }

  if (includeMemory && company.knowledge.length) {
    parts.push(`Company knowledge: ${json(company.knowledge, 8_000)}`);
  }
  if (includeMemory && Object.keys(company.memory).length) {
    parts.push(`Company memory: ${json(company.memory, 8_000)}`);
  }

  return parts.filter(Boolean).join("\n");
}

function instruction(company: Company, agent: CompanyAgent, manager = false, includeMemory = true, linked?: LinkedBusinessContext) {
  return [
    "You are an AI Agent inside an NPATI Company.",
    context(company, includeMemory, linked),
    linked?.business && `AWARENESS MANDATE: You represent Company "${company.name}" linked to Business Idea "${linked.business.name}". You have complete immediate awareness of this company, its business idea, its goals, and its memory. NEVER ask the user which company, business idea, goal, or memory is active — you already know all of them seamlessly! When asked, answer directly with full knowledge from this context without hesitation.`,
    `Agent name: ${agent.name}`,
    `Agent role: ${agent.role}`,
    agent.description && `Role description: ${agent.description}`,
    agent.systemInstruction && `System instruction: ${agent.systemInstruction}`,
    agent.promptGuidelines && `Prompt guidelines: ${agent.promptGuidelines}`,
    includeMemory && agent.tools.map(toolName).includes("knowledge") && "Grounding rule: when Relevant Company Knowledge or Company Memory is supplied, treat it as authoritative. Copy exact factual values when asked. Never replace them with assumptions or invented facts; if the answer is absent, say that it is not available in Company Knowledge.",
    !includeMemory && "Private no-memory request: do not read, request, infer, or write Company Knowledge, Company Memory, Files, or prior conversation memory.",
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
    private readonly knowledgeRetriever?: (ctx: AuthContext, companyId: string, query: string, scope?: MemoryScope) => Promise<{chunks:Array<{content:string}>;memories:Array<{content:string;source?:string;metadata?:Record<string,unknown>}>}>,
    capabilityResolver?: EffectiveCapabilityResolver,
    riskApprovalService?: RiskApprovalService,
    private readonly guardrailPolicyResolver?: (ctx:AuthContext,companyId:string)=>Promise<CompanyGuardrailPolicy>,
    private readonly durableApprovals?: DurableApprovalGateway,
    private readonly telemetry?: Pick<AuditRepository, "recordUsage" | "log">,
    private readonly userDocumentRetriever?: (ctx: AuthContext) => Promise<string | undefined>,
  ) {
    this.toolRuntime = toolRuntime ?? { execute: async (_context, _company, tool, input) => this.ai.executeTool(tool, input) };
    this.capabilityResolver = capabilityResolver ?? defaultEffectiveCapabilityResolver;
    this.riskApprovalService = riskApprovalService ?? defaultRiskApprovalService;
  }

  async create(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; projectId?: string }, key: string) {
    return this.store.createCompanyAgentRun(ctx, companyId, { task: input.task, requestedMode: input.mode ?? "auto", projectId: input.projectId }, key);
  }

  async execute(ctx: AuthContext, companyId: string, input: { task: string; mode?: CompanyRunMode; noMemory?: boolean; memoryScope?: MemoryScope; preferredAgentId?: string; projectId?: string }, key: string, signal?:AbortSignal): Promise<CompanyAgentRunDetails> {
    const created = await this.create(ctx, companyId, input, key);
    if (!created.created) return this.store.getCompanyAgentRun(ctx, companyId, created.run.id);
    return this.process(ctx, companyId, created.run.id, { noMemory: input.noMemory === true, memoryScope: input.memoryScope, preferredAgentId: input.preferredAgentId, signal });
  }

  async process(ctx: AuthContext, companyId: string, runId: string, options: { noMemory?: boolean; memoryScope?: MemoryScope; preferredAgentId?: string; approvalId?:string;signal?:AbortSignal } = {}): Promise<CompanyAgentRunDetails> {
    const existing = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    const created = { run: existing.run };
    const input = { task: existing.run.task, mode: existing.run.requestedMode };
    const controller = new AbortController(), timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout,...(options.signal?[options.signal]:[])]);
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
      const guardrailPolicy=await this.guardrailPolicyResolver?.(ctx,companyId);
      const protect=(text:string)=>SecurityPolicyEngine.protectText(text,guardrailPolicy).sanitized;
      const protectedTask=protect(input.task.trim());

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
      const projectChoices = candidates.some((agent) => agent.tools.some((tool) => (toolName(tool).startsWith("project.files.") || toolName(tool).startsWith("project.terminal.") || toolName(tool).startsWith("project.preview."))))
        ? (await this.store.listProjects(ctx, companyId)).slice(0, 50).map((project) => ({ id: project.id, name: project.name, type: project.type })) : [];
      const planningMemory = !options.noMemory && mainTools.includes("knowledge") && this.knowledgeRetriever ? await this.knowledgeRetriever(ctx,companyId,input.task,options.memoryScope).catch(()=>({chunks:[],memories:[]})) : {chunks:[],memories:[]};
      const actionPlanningContext=planningMemory.memories.filter(memory=>memory.source==="action_sensitive").map(memory=>memory.content).join("\n");
      await this.ai.ensureA2AEnabled();
      const planned = await this.ai.a2aSend({
        model: main.modelId ?? "auto", timeoutMs: Math.min(60_000, this.timeoutMs), signal,
        idempotencyKey: `${created.run.id}:plan`,
        messages: [
          { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked)+(actionPlanningContext?"\n\nMandatory action-sensitive rules:\n"+actionPlanningContext:"")) },
          { role: "user", content: protect([
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
            'project.terminal.exec: {"projectId":"authorized Project ID","command":"sandbox command","environmentReferences":{"NAME":{"id":"Company vault credential UUID","field":"field name"}}}. project.terminal.process: {"projectId":"authorized Project ID","action":"start|status|logs|stop","command":"for start","processId":"for status/logs/stop"}. Commands run only in the remote Project sandbox. Use short, specific commands; unknown, destructive or shell-composed commands require approval. Never include secret values in commands or prompts; use vault references.',
            'project.preview.start: {"projectId":"authorized Project ID","command":"optional dev command","port":optional port}. project.preview.stop: {"projectId":"authorized Project ID"}. project.preview.status: {"projectId":"authorized Project ID"}. Used to launch, stop, and inspect the project preview dev server.',
            'project.git.status/diff/log/branch/stage/commit/restore/checkpoint/restore_checkpoint/push/pr: Git operations and checkpoints for the project workspace. commit needs message; restore needs files; checkpoint needs name; restore_checkpoint needs checkpointId; push and pr require explicit human approval and credentialId referencing a Company vault credential with a token field. Never put the token in tool input.',
            'mcp: {"name":"permitted MCP tool name","arguments":{}}. Never invent tool names, URLs or file keys.',
            'browser.browser_tab_control: {"operation":"navigate","url":"absolute public https URL","profileId":"optional stable profile"}, {"operation":"extract","url":"optional URL","selector":"CSS selector","mode":"text|attribute","attribute":"when needed"}, {"operation":"pause","jobId":"running browser job id","profileId":"same profile"}, or {"operation":"resume","jobId":"paused/waiting browser job id","profileId":"same profile","resumeInput":{"task":"continuation and verification code/link if available"}}.',
            'browser.browser_clicktype for forms: {"operation":"fill_form","url":"optional URL","profileId":"profile","fields":[{"selector":"CSS selector","value":"non-secret value"},{"selector":"CSS selector","secretRef":"credentialAlias.field"}],"credentialRefs":[{"id":"vault credential id","alias":"credentialAlias"}],"submitSelector":"optional CSS selector"}. Never put passwords, tokens, OTPs or other secret values directly in tool input.',
            'browser.browser_clicktype for registration/autonomy: {"operation":"register_account|task","url":"public URL","allowedDomains":["site.example"],"task":"concrete browser goal mentioning credential aliases only","profileId":"profile","credentialRefs":[{"id":"vault credential id","alias":"account"}],"files":["optional Company attachment UUID"],"maxSteps":50,"waitForEmail":true,"emailHint":"expected sender email/domain"}. Use waitForEmail only after a task expected to send a verification email.',
            'browser.browser_downloads: {"operation":"upload","url":"optional URL","selector":"input[type=file]","files":["Company attachment UUID linked in Company Knowledge"],"profileId":"profile"}; browser.browser_screenshots: {"operation":"screenshot","url":"optional URL","fullPage":true}.',
            'exec (Code Mode): {"language":"javascript","code":"synchronous JavaScript","timeoutMs":2000}. Generate focused, self-contained code and use console.log for output. It is statically validated, has no filesystem, network, process, environment, require or imports, and always requires human approval.',
            options.noMemory ? "NO-MEMORY IS ACTIVE: toolRequests must not contain knowledge, files, or storage.company_memory." : "",
            "Populate required input fields with concrete values. Omit a tool request if you cannot supply its required input; never emit an empty input for web.search, web.fetch or web.crawl.",
            "Use pipeline for dependent work and fusion for independent parallel perspectives.",
          ].join("\n\n")) },
        ],
      });
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, { omnirouteTaskId: planned.taskId });
      const plan = parsePlan(planned.content, input.mode ?? "auto"), byId = new Map(candidates.map((agent) => [agent.id, agent]));
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
      const retrieved = knowledgeAllowed && this.knowledgeRetriever ? await this.knowledgeRetriever(ctx,companyId,[input.task,...plan.toolRequests.map(request=>request.tool)].join(" "),options.memoryScope).catch(()=>({chunks:[],memories:[]})) : {chunks:[],memories:[]};
      const knowledge={
        chunks:retrieved.chunks.map(item=>({content:protect(item.content)})),
        memories:retrieved.memories.map(item=>({content:protect(item.content),source:item.source,metadata:item.metadata})),
      };
      const normalizedToolRequests = plan.toolRequests.map((request) => {
        const requestingAgent = byId.get(request.agentId);
        const allowed = new Set(requestingAgent?.tools.map(toolName) ?? []);
        if (toolName(request.tool) === "files" && !allowed.has("files") && allowed.has("knowledge") && knowledgeAllowed) {
          return { ...request, tool: "knowledge", input: SecurityPolicyEngine.protectObject({ query: input.task.trim() },guardrailPolicy) };
        }
        return {...request,input:SecurityPolicyEngine.protectObject(request.input,guardrailPolicy)};
      });
      const rawEvidence = await this.tools(ctx, company, created.run.id, normalizedToolRequests, byId, signal, knowledge, options.noMemory === true,options.approvalId);
      const evidence=rawEvidence?protect(rawEvidence):rawEvidence;
      const knowledgeContext = [
        knowledge.memories.length ? "Relevant Company Memory:\n"+knowledge.memories.map(item=>item.content).join("\n") : "",
        knowledge.chunks.length ? "Authoritative Relevant Company Knowledge (use exact facts; do not invent replacements):\n"+knowledge.chunks.map(item=>item.content).join("\n\n---\n\n") : "",
      ].filter(Boolean).join("\n\n");
      const execution = await this.combos(company, main, selected, reviewer, plan.mode, signal, !options.noMemory, linked);
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
        model: execution.model, signal, timeoutMs: this.timeoutMs, admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" }, idempotencyKey: `${created.run.id}:final`,
        messages: [
          { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + chatLanguageInstruction(input.task)) },
          { role: "user", content: protect([protectedTask, knowledgeContext, evidence && `Verified tool evidence:\n${evidence}`].filter(Boolean).join("\n\n")) },
        ],
      });
      let measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "final", execution.mode, result, 10_001);
      totalCost += measured.costUsd;
      totalTokens += measured.totalTokens;
      if (knowledgeContext) {
        result = await this.ai.chat({
          model: comboModel(main.modelId), fallbackModel: comboModel(main.fallbackModelId), signal, timeoutMs: this.timeoutMs, admission: { tenantId: ctx.workspaceId, tier: ctx.permissions.includes("admin:all") ? "enterprise" : "pro" }, idempotencyKey: `${created.run.id}:grounded-final`,
          messages: [
            { role: "system", content: protect(instruction(company, main, true, !options.noMemory, linked) + "\n\nYou are the final grounding verifier. Use the authoritative Company Knowledge below as the source of truth. Preserve exact relevant values. Remove unsupported claims. Never omit the direct answer requested by the user." + chatLanguageInstruction(input.task)) },
            { role: "user", content: protect([protectedTask, knowledgeContext, `Delegated draft to verify:\n${result.content}`, "Return only the corrected, knowledge-grounded final answer."].join("\n\n")) },
          ],
        });
        measured = await this.recordInference(ctx, companyId, created.run.id, main.id, "grounded-final", execution.mode, result, 10_002);
        totalCost += measured.costUsd;
        totalTokens += measured.totalTokens;
      }
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
      await this.store.updateCompanyAgentRun(ctx, companyId, created.run.id, {
        status: cancelled ? "cancelled" : "failed",
        errorCode: cancelled ? "RUN_CANCELLED" : timedOut ? "RUN_TIMEOUT" : error instanceof CompanyRuntimeError ? error.code : error instanceof SecurityPolicyViolation ? error.code : "RUN_FAILED",
        errorMessage: cancelled ? "Company run was cancelled" : timedOut ? "Company run exceeded its timeout" : (error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI"),
        totalCost,
        totalTokens,
        totalDurationMs: Math.max(0, Date.now() - runStartedAt),
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

  async recordBackgroundEvent(ctx: AuthContext, companyId: string, runId: string, entry: Parameters<WorkspaceStore["appendCompanyAgentRunEvent"]>[3]) {
    return this.store.appendCompanyAgentRunEvent(ctx, companyId, runId, entry);
  }

  async cancel(ctx: AuthContext, companyId: string, runId: string) {
    const current = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    if (["completed", "failed", "cancelled"].includes(current.run.status)) return current;
    if (current.run.status === "queued") {
      await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelled", cancelRequested: true, errorCode: "RUN_CANCELLED", errorMessage: "Company run was cancelled" });
      const cancelled = await this.store.getCompanyAgentRun(ctx, companyId, runId);
      await this.recordBackgroundEvent(ctx, companyId, runId, { eventKey: "cancelled", eventType: "cancelled", runStatus: "cancelled",
        workerId: cancelled.run.workerId, attemptCount: cancelled.run.attemptCount, message: "Background run cancelled by user",
        details: { errorCode: "RUN_CANCELLED" } });
      return this.store.getCompanyAgentRun(ctx, companyId, runId);
    }
    await this.store.updateCompanyAgentRun(ctx, companyId, runId, { status: "cancelling", cancelRequested: true });
    this.controllers.get(runId)?.abort();
    if (current.run.omnirouteTaskId && this.ai.cancelA2ATask)
      await this.ai.cancelA2ATask(current.run.omnirouteTaskId).catch(() => undefined);
    const cancelling = await this.store.getCompanyAgentRun(ctx, companyId, runId);
    await this.recordBackgroundEvent(ctx, companyId, runId, { eventKey: `attempt:${cancelling.run.attemptCount}:cancelling`,
      eventType: "cancelled", runStatus: "cancelling", workerId: cancelling.run.workerId,
      attemptCount: cancelling.run.attemptCount, message: "Cancellation requested for active background run" });
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

  private async tools(ctx: AuthContext, company: Company, runId: string, plans: ToolPlan[], agents: Map<string, CompanyAgent>, signal: AbortSignal, knowledge: {chunks:Array<{content:string}>;memories:Array<{content:string}>}, noMemory = false, approvalId?:string) {
    const evidence: string[] = [];
    let sequenceNumber = 1;
    for (const plan of plans.slice(0, 10)) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const agent = agents.get(plan.agentId);
      if (!agent) throw new CompanyRuntimeError("INVALID_TOOL_AGENT", "Tool request references an unavailable agent", 502);
      const tool = toolName(plan.tool), allowed = new Set(agent.tools.map(toolName));
      if (noMemory && ["knowledge", "files", "storage.company_memory"].includes(tool)) {
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "No-memory request blocks persistent context access", reasonCode: "no_memory", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("NO_MEMORY_TOOL_FORBIDDEN", `No-memory request may not use ${tool}`, 403);
      }
      if (!allowed.has(tool)) {
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "Tool is not permitted", reasonCode: "agent_allowlist", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}`, 403);
      }
      if (tool !== "knowledge" && tool !== "exec") {
        const check = this.capabilityResolver.canExecute({
          auth: ctx,
          activeContext: { contextType: "company", companyId: company.id, businessId: null },
          company: { id: company.id, revision: company.revision },
          agent: { id: agent.id, revision: agent.revision, tools: agent.tools.map(toolName) },
        }, tool);
        if (!check.allowed) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
            { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: check.reason, reasonCode: check.detail?.reasonCode ?? "policy_denied", sequenceNumber: sequenceNumber++ });
          throw new CompanyRuntimeError("TOOL_FORBIDDEN", `Agent "${agent.name}" may not use ${tool}: ${check.reason}`, 403);
        }
      }
      if (tool === "exec" && !ctx.permissions.some((permission) => ["business:manage", "owner", "*"].includes(permission))) {
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: "Exec requires business:manage permission", reasonCode: "tenant_permissions", sequenceNumber: sequenceNumber++ });
        throw new CompanyRuntimeError("TOOL_FORBIDDEN", "Exec requires business:manage permission", 403);
      }
      if (tool === "exec") {
        const code = typeof plan.input.code === "string" ? plan.input.code : "";
        const review = AutoExecReviewer.reviewExecution({ type: "javascript", payload: code });
        if (review.decision === "BLOCKED") {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
            { agentId: agent.id, toolName: tool, decision: "denied", status: "blocked", inputSummary: summary(tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, action: plan.input.action } : plan.input), errorMessage: review.reasons.join("; "), reasonCode: "auto_exec_reviewer", sequenceNumber: sequenceNumber++ });
          throw new CompanyRuntimeError("EXEC_REVIEW_BLOCKED", "Exec was blocked by the automatic security reviewer", 403);
        }
      }

      // Risk & Human Approval Policy Check
      const operation=typeof plan.input.operation==="string"?plan.input.operation.trim().toLowerCase():"";
      const toolToAssess = operation ? `${tool}.${operation}` : plan.tool.includes(".") ? plan.tool : tool;
      const scopedBrowserAuthorization = hasScopedBrowserAuthorization(ctx, tool, operation, plan.input);
      const terminalDecision = tool.startsWith("project.terminal.") && (tool === "project.terminal.exec" || plan.input.action === "start") ? classifyTerminalCommand(String(plan.input.command ?? "")) : undefined;
      const terminalNeedsApproval = Boolean(terminalDecision?.requiresApproval || (tool.startsWith("project.terminal.") && Object.keys((plan.input.environmentReferences ?? {}) as Record<string, unknown>).length));
      const projectFileRisk = tool.startsWith("project.files.") ? (tool === "project.files.delete" ? "high" : "medium") : tool.startsWith("project.terminal.") ? terminalNeedsApproval ? "high" : "low" : tool.startsWith("project.preview.") ? "low" : undefined;
      const approvalPayload = tool.startsWith("project.terminal.") ? { projectId: plan.input.projectId, commandHash: createHash("sha256").update(String(plan.input.command ?? "")).digest("hex"), action: plan.input.action, environmentReferenceHash: createHash("sha256").update(JSON.stringify(plan.input.environmentReferences ?? {})).digest("hex") } : plan.input;
      if (this.riskApprovalService.requiresApproval(toolToAssess, projectFileRisk) && !scopedBrowserAuthorization) {
        if(this.durableApprovals){
          if(!approvalId){
            const cleanPayload={...approvalPayload};delete cleanPayload._approvalToken;
            const req=await this.durableApprovals.requestApproval(ctx,company.id,{
              runId,agentId:agent.id,toolName:toolToAssess,
              riskLevel:projectFileRisk === "high" ? "high" : this.riskApprovalService.classifyRisk(toolToAssess)==="critical"?"critical":"high",
              actionSummary:`${agent.name} requests ${toolToAssess}`,inputPayload:cleanPayload,
            });
            await this.store.appendCompanyAgentToolAudit(ctx,company.id,runId,{agentId:agent.id,toolName:toolToAssess,decision:"denied",status:"blocked",
              inputSummary:summary(cleanPayload),errorMessage:`Human approval required. Approval request ID: ${req.id}`,reasonCode:"approval_required",sequenceNumber:sequenceNumber++});
            throw new CompanyRuntimeError("APPROVAL_REQUIRED",`Tool "${toolToAssess}" requires human approval. Approval request ID: ${req.id}`,403);
          }
          const cleanPayload={...approvalPayload};delete cleanPayload._approvalToken;
          try{await this.durableApprovals.consumeApproved(ctx,company.id,approvalId,{runId,agentId:agent.id,toolName:toolToAssess,inputPayload:cleanPayload});}
          catch(error){
            const code=(error as any)?.code??"APPROVAL_INVALID";
            await this.store.appendCompanyAgentToolAudit(ctx,company.id,runId,{agentId:agent.id,toolName:toolToAssess,decision:"denied",status:"blocked",
              inputSummary:summary(cleanPayload),errorMessage:error instanceof Error?error.message:"Approval denied",reasonCode:String(code).toLowerCase(),sequenceNumber:sequenceNumber++});
            throw new CompanyRuntimeError(code,error instanceof Error?error.message:"Approval denied",Number((error as any)?.status??409));
          }
        } else {
        const token = typeof plan.input._approvalToken === "string" ? plan.input._approvalToken : undefined;
        if (!token) {
          const req = this.riskApprovalService.createApprovalRequest(ctx, company.id, runId, agent.id, toolToAssess, approvalPayload);
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
            agentId: agent.id,
            toolName: toolToAssess,
            decision: "denied",
            status: "blocked",
            inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input),
            errorMessage: `Human approval required for high-risk operation '${toolToAssess}'. Approval request ID: ${req.id}`,
            reasonCode: "approval_required",
            sequenceNumber: sequenceNumber++,
          });
          throw new CompanyRuntimeError("APPROVAL_REQUIRED", `Tool "${toolToAssess}" requires human approval before execution. Approval request ID: ${req.id}`, 403);
        }

        const verification = this.riskApprovalService.verifyApprovalToken(token, ctx, company.id, runId, toolToAssess, approvalPayload);
        if (!verification.valid) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
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

        const consumed = this.riskApprovalService.consumeToken(token);
        if (!consumed) {
          await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
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

      await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
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
        if (tool.startsWith("project.files.")) { adapterInput.__npatiAgentId = agent.id; if (tool === "project.files.delete") adapterInput.__npatiApprovalGranted = true; }
        if (tool.startsWith("project.terminal.") || tool.startsWith("project.preview.") || tool.startsWith("project.git.")) { adapterInput.__npatiAgentId = agent.id; adapterInput.__npatiTaskRunId = runId; adapterInput.__npatiApprovalGranted = !terminalNeedsApproval || Boolean(approvalId || plan.input._approvalToken); }
        if (tool === "email.send" || tool === "communications.email_send" || tool.startsWith("browser.")) adapterInput.__npatiTaskRunId = runId;
        const result = tool === "knowledge" ? knowledge : await this.toolRuntime.execute(ctx, company, tool, adapterInput, signal);
        const latencyMs = Math.round(performance.now() - toolStart);
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId,
          { agentId: agent.id, toolName: tool, decision: "allowed", status: "succeeded", inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input), latencyMs, sequenceNumber: sequenceNumber++ });
        if (result && typeof result === "object" && (result as any)._npatiBrowserTrace === true && Array.isArray((result as any).trace)) {
          for (const event of (result as any).trace.slice(0, 200)) {
            const eventStatus = event?.status === "failed" ? "failed" : "succeeded";
            const actionName = String(event?.action ?? "unknown").replace(/[^a-z0-9_.-]/gi, "_");
            await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, {
              agentId: agent.id,
              toolName: `browser.action.${actionName}`,
              decision: "allowed",
              status: eventStatus,
              inputSummary: summary({ url: event?.url, detail: event?.detail, browserStatus: event?.status }),
              errorMessage: eventStatus === "failed" ? String(event?.detail ?? "Browser action failed").slice(0, 500) : undefined,
              reasonCode: ["waiting_email", "paused"].includes(event?.status) ? event.status : "browser_worker_trace",
              sequenceNumber: sequenceNumber++,
            });
            await this.telemetry?.log(ctx, company.id, {
              action: `browser.${actionName}`,
              category: "automation",
              resourceType: "browser_job",
              resourceId: typeof (result as any).jobId === "string" ? (result as any).jobId : runId,
              details: summary({ runId, agentId: agent.id, url: event?.url, detail: event?.detail, status: event?.status }),
            }).catch(() => undefined);
          }
        }
        evidence.push(`${agent.name} / ${tool}: ${json(result)}`);
      } catch (error) {
        if (signal.aborted) throw error;
        const latencyMs = Math.round(performance.now() - toolStart);
        await this.store.appendCompanyAgentToolAudit(ctx, company.id, runId, { agentId: agent.id, toolName: tool,
          decision: "allowed", status: "failed", inputSummary: summary(tool.startsWith("project.terminal.") ? approvalPayload : plan.input), latencyMs, sequenceNumber: sequenceNumber++,
          errorMessage: (error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI").slice(0, 500) });
        if (tool.startsWith("browser.")) await this.telemetry?.log(ctx, company.id, {
          action: "browser.failed", category: "automation", resourceType: "company_agent_run", resourceId: runId,
          details: summary({ agentId: agent.id, tool, error: error instanceof Error ? error.message : String(error) }),
        }).catch(() => undefined);
        evidence.push(`${agent.name} / ${tool} (failed): ${(error instanceof Error ? error.message : String(error)).replace(/OmniRoute/gi, "NPATI AI")}`);
      }
    }
    return evidence.join("\n\n");
  }

  private async combos(company: Company, main: CompanyAgent, selected: CompanyAgent[], reviewer: CompanyAgent | undefined, mode: Mode, signal: AbortSignal, includeMemory = true, linked?: LinkedBusinessContext) {
    if (!this.ai.ensureCombo) throw new CompanyRuntimeError("OMNIROUTE_COMBOS_UNAVAILABLE", "NPATI AI routing combinations are unavailable", 503);
    const unique = [...new Map([...selected, main].map((agent) => [agent.id, agent])).values()], names = new Map<string, string>();
    for (const agent of unique) {
      const primary = comboModel(agent.modelId), fallback = comboModel(agent.fallbackModelId);
      const name = `npati/a/${digest(`${company.workspaceId}:${company.id}:${agent.id}:${agent.revision}`)}`;
      const allowed = agent.tools.map(toolName).map((item) => item.replace(/[^a-z0-9.]/gi, ""));
      await this.ai.ensureCombo({ name, strategy: "priority", models: [...new Set([primary, fallback])],
        description: `NPATI Company agent ${agent.name}`, system_message: instruction(company, agent, agent.id === main.id, includeMemory, linked),
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
