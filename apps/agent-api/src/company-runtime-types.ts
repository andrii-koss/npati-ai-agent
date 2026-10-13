import { createHash } from "node:crypto";
import { isChatCapableModel } from "@npati/omniroute-adapter";
import type { AuthContext, Business, Company, CompanyAgent, CompanyAgentRunDetails, CompanyRunMode, Goal, MemoryItem } from "@npati/workspace";
import { SecurityPolicyEngine } from "./security-guardrails";
import { CostTelemetry } from "./cost-telemetry";

export const MAX_CANDIDATES = 60;
export const MAX_SELECTED = 12;
export const DEFAULT_TIMEOUT = 120_000;

export type Mode = Exclude<CompanyRunMode, "auto">;
export type ToolPlan = { agentId: string; tool: string; input: Record<string, unknown> };
export type Plan = { mode: Mode; agentIds: string[]; reviewerAgentId?: string; toolRequests: ToolPlan[] };
export type MemoryScope = { apiKeyId?: string; sessionId?: string };

export interface DurableApprovalGateway {
  requestApproval(ctx: AuthContext, companyId: string, input: { runId: string; agentId: string; toolName: string; riskLevel: "high" | "critical"; actionSummary: string; inputPayload: Record<string, unknown> }): Promise<{ id: string }>;
  consumeApproved(ctx: AuthContext, companyId: string, id: string, input: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> }): Promise<unknown>;
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

export const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export const comboModel = (value: string | null | undefined) => value == null || value === "auto" || !isChatCapableModel({ id: value }) ? "auto/smart" : value;

export function toolName(value: string) {
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
  return ({
    "websearch": "web.search", "web.search": "web.search", "webfetch": "web.fetch", "web.fetch": "web.fetch",
    crawler: "web.crawl", "web.crawl": "web.crawl", "text-to-speech": "audio.speech", tts: "audio.speech", "audio.speech": "audio.speech",
    mcp: "mcp", files: "files", knowledge: "knowledge", exec: "exec", code: "exec", "company.memory": "storage.company_memory", "storage.company.memory": "storage.company_memory"
  } as Record<string, string>)[key] ?? key;
}

export function summary(input: Record<string, unknown>) {
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

export function json(value: unknown, max = 20_000) {
  try { return JSON.stringify(value).slice(0, max); } catch { return "[unserializable]"; }
}

export interface LinkedBusinessContext {
  business?: Business;
  goals?: Goal[];
  memories?: MemoryItem[];
}

export function context(company: Company, includeMemory = true, linked?: LinkedBusinessContext) {
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

export function instruction(company: Company, agent: CompanyAgent, manager = false, includeMemory = true, linked?: LinkedBusinessContext) {
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

export function delegationJson(content: string): Record<string, unknown> | undefined {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < content.length; end++) {
      const char = content[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const value = JSON.parse(content.slice(start, end + 1)) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value) &&
            ("mode" in value || "agentIds" in value || "toolRequests" in value)) {
            return value as Record<string, unknown>;
          }
        } catch { /* Try the next complete object. */ }
        break;
      }
    }
  }
  return undefined;
}

export function parsePlan(content: string, requested: CompanyRunMode): Plan {
  const value = delegationJson(content);
  if (!value) throw new CompanyRuntimeError("INVALID_DELEGATION_PLAN", "Main Agent returned malformed delegation JSON", 502);
  const mode = requested === "auto" ? value.mode : requested;
  if (mode !== "single" && mode !== "pipeline" && mode !== "fusion") throw new CompanyRuntimeError("INVALID_DELEGATION_MODE", "Unsupported delegation mode", 502);
  const agentIds = Array.isArray(value.agentIds) ? value.agentIds.filter((id): id is string => typeof id === "string") : [];
  const reviewerAgentId = typeof value.reviewerAgentId === "string" ? value.reviewerAgentId : undefined;
  const toolRequests = Array.isArray(value.toolRequests) ? value.toolRequests.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.agentId !== "string" || typeof item.tool !== "string") return [];
    return [{
      agentId: item.agentId, tool: item.tool,
      input: item.input && typeof item.input === "object" ? item.input as Record<string, unknown> : {}
    }];
  }) : [];
  return { mode, agentIds: [...new Set(agentIds)], reviewerAgentId, toolRequests };
}
