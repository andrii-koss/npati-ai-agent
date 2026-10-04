import {
  type CapabilityDefinition,
  type CapabilityDomain,
  type CapabilityRegistry,
  defaultCapabilityRegistry,
} from "./capabilities";
import {
  type EffectiveCapabilityResolver,
  type ResolutionContext,
  defaultEffectiveCapabilityResolver,
} from "./effective-capabilities";
import {
  classifyProjectIntent,
  type ProjectIntent,
  type ProjectIntentDecision,
  type ProjectIntentInput,
} from "./project-intent";

export type RouterSignal =
  | "url_detected"
  | "time_sensitive"
  | "browser_action"
  | "crawl_action"
  | "file_action"
  | "pure_explanation"
  | "website_create"
  | "website_edit"
  | "website_build"
  | "website_preview"
  | "website_test"
  | "website_debug"
  | "data_model_action";

export interface RouterDecision {
  isNoTool: boolean;
  primaryDomain?: CapabilityDomain;
  matchedSignals: RouterSignal[];
  candidateTools: CapabilityDefinition[];
  candidateIds: string[];
  filteredOut: Array<{ toolId: string; reason: string }>;
  latencyMs: number;
  projectIntent?: ProjectIntent;
  projectIntentDecision?: ProjectIntentDecision;
}

export interface RouteInput {
  message: string;
  resolutionContext: ResolutionContext;
  maxCandidates?: number;
  conversationHistory?: Array<{ role: string; content: string }>;
  activeProjectId?: string | null;
  hasWorkspace?: boolean;
  lastRunStatus?: string | null;
}

const URL_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/i;
const TIME_SENSITIVE_KEYWORDS = ["today", "сьогодні", "зараз", "новини", "latest", "current", "recent", "fresh", "актуальн", "breaking", "news"];
const BROWSER_KEYWORDS = ["click", "fill form", "submit button", "натисни", "клікни", "відкрий сайт", "відкрий сторінку", "browser", "dom", "cdp", "navigate to"];
const CRAWL_KEYWORDS = ["весь сайт", "веб-сайт", "вебсайт", "crawl", "spider", "deep crawl", "скануй сайт", "проскануй", "crawl site"];
const FILE_KEYWORDS = ["файл", "документ", "pdf", "csv", "excel", "attachment", "document", "file", "downloaded file"];
const EXPLANATION_PREFIXES = ["поясни", "що таке", "як працює", "explain", "what is", "how does", "write greeting", "напиши привітання", "напиши вітання", "напиши текст", "write a poem", "напиши код", "write python code", "факторіал", "difference between", "різниця між", "tell me about", "розкажи про"];

export class HybridRouter {
  constructor(
    private readonly registry: CapabilityRegistry = defaultCapabilityRegistry,
    private readonly resolver: EffectiveCapabilityResolver = defaultEffectiveCapabilityResolver
  ) {}

  route(input: RouteInput): RouterDecision {
    const start = performance.now();
    const message = input.message.trim();
    const lower = message.toLowerCase();
    const matchedSignals: RouterSignal[] = [];

    // 1. Deterministic Signal Extraction
    const hasUrl = URL_REGEX.test(message);
    if (hasUrl) matchedSignals.push("url_detected");

    const hasTime = TIME_SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw));
    if (hasTime) matchedSignals.push("time_sensitive");

    const hasBrowser = BROWSER_KEYWORDS.some((kw) => lower.includes(kw));
    if (hasBrowser) matchedSignals.push("browser_action");

    const hasCrawl = CRAWL_KEYWORDS.some((kw) => lower.includes(kw));
    if (hasCrawl) matchedSignals.push("crawl_action");

    const hasFile = FILE_KEYWORDS.some((kw) => lower.includes(kw));
    if (hasFile) matchedSignals.push("file_action");

    const isPureExplanation = EXPLANATION_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(prefix));
    if (isPureExplanation) matchedSignals.push("pure_explanation");

    const projectIntentDecision = classifyProjectIntent({
      message,
      conversationHistory: input.conversationHistory,
      activeCompanyId: input.resolutionContext.company?.id ?? input.resolutionContext.activeContext?.companyId,
      activeProjectId: input.activeProjectId ?? input.resolutionContext.activeContext?.projectId,
      hasWorkspace: input.hasWorkspace,
      lastRunStatus: input.lastRunStatus,
    });

    if (projectIntentDecision.intent.startsWith("CREATE_")) matchedSignals.push("website_create");
    else if (projectIntentDecision.intent.startsWith("EDIT_")) matchedSignals.push("website_edit");
    else if (projectIntentDecision.intent === "BUILD_PROJECT") matchedSignals.push("website_build");
    else if (projectIntentDecision.intent === "PREVIEW_PROJECT") matchedSignals.push("website_preview");
    else if (projectIntentDecision.intent === "TEST_PROJECT") matchedSignals.push("website_test");
    else if (projectIntentDecision.intent === "DEBUG_PROJECT") matchedSignals.push("website_debug");
    else if (projectIntentDecision.intent === "ADD_DATA_MODEL" || projectIntentDecision.intent === "EDIT_DATA_MODEL") matchedSignals.push("data_model_action");

    // 2. NO_TOOL Path: Simple explanation / reasoning without action signals
    if (isPureExplanation && !hasUrl && !hasBrowser && !hasCrawl && !hasFile && !hasTime) {
      const elapsed = performance.now() - start;
      return {
        isNoTool: true,
        matchedSignals,
        candidateTools: [],
        candidateIds: [],
        filteredOut: [],
        latencyMs: elapsed,
        projectIntent: projectIntentDecision.intent,
        projectIntentDecision,
      };
    }

    // 3. Domain & Candidate Classification
    let primaryDomain: CapabilityDomain | undefined;
    if (projectIntentDecision.intent === "ADD_DATA_MODEL" || projectIntentDecision.intent === "EDIT_DATA_MODEL") {
      primaryDomain = "storage";
    } else if (hasBrowser) {
      primaryDomain = "browser";
    } else if (hasUrl || hasTime || hasCrawl) {
      primaryDomain = "research";
    } else if (hasFile) {
      primaryDomain = "files";
    }

    // Retrieve all agent-callable tools
    const allTools = this.registry.listAgentCallable();
    const scoredCandidates: Array<{ cap: CapabilityDefinition; score: number }> = [];

    const tokens = lower.split(/\s+/).filter((t) => t.length > 2);

    for (const tool of allTools) {
      let score = 0;

      // Domain match bonus
      if (primaryDomain && tool.domain === primaryDomain) {
        score += 5;
      }

      // Exact tool signal prioritization
      if (hasCrawl && (tool.id.includes("crawl") || tool.id.includes("fetch"))) score += 20;
      if (hasUrl && !hasCrawl && (tool.id.includes("fetch") || tool.id.includes("read"))) score += 15;
      if (hasTime && (tool.id.includes("search") || tool.id.includes("web"))) score += 15;
      if (hasBrowser && tool.domain === "browser") score += 15;
      if (hasFile && (tool.domain === "files" || tool.id.includes("file"))) score += 15;

      // Project capability prioritization
      if ((projectIntentDecision.intent.startsWith("CREATE_") || projectIntentDecision.intent.startsWith("EDIT_") || projectIntentDecision.intent === "DEBUG_PROJECT") && tool.id.startsWith("project.files.")) score += 20;
      if (projectIntentDecision.intent === "BUILD_PROJECT" && tool.id.startsWith("project.terminal.")) score += 20;
      if (projectIntentDecision.intent === "PREVIEW_PROJECT" && tool.id.startsWith("project.preview.")) score += 25;
      if (projectIntentDecision.intent === "TEST_PROJECT" && tool.id.startsWith("project.terminal.")) score += 20;

      // Token overlap with name and useWhen
      for (const token of tokens) {
        if (tool.id.toLowerCase().includes(token)) score += 3;
        if (tool.name.toLowerCase().includes(token)) score += 2;
        if (tool.useWhen.some((u) => u.toLowerCase().includes(token))) score += 2;
      }

      // If score is positive or primary domain matches
      if (score > 0) {
        scoredCandidates.push({ cap: tool, score });
      }
    }

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // 4. Effective Capability Filtering (Deny-Wins & Gating)
    const candidateTools: CapabilityDefinition[] = [];
    const filteredOut: Array<{ toolId: string; reason: string }> = [];
    const max = Math.max(1, Math.min(input.maxCandidates ?? 10, 15));

    for (const item of scoredCandidates) {
      if (candidateTools.length >= max) break;

      const check = this.resolver.canExecute(input.resolutionContext, item.cap.id);
      if (check.allowed) {
        candidateTools.push(item.cap);
      } else {
        filteredOut.push({
          toolId: item.cap.id,
          reason: check.reason,
        });
      }
    }

    // If no candidate scored above threshold or all were filtered out
    const isNoTool = candidateTools.length === 0;
    const elapsed = performance.now() - start;

    return {
      isNoTool,
      primaryDomain,
      matchedSignals,
      candidateTools,
      candidateIds: candidateTools.map((c) => c.id),
      filteredOut,
      latencyMs: elapsed,
      projectIntent: projectIntentDecision.intent,
      projectIntentDecision,
    };
  }

  classifyProject(input: ProjectIntentInput): ProjectIntentDecision {
    return classifyProjectIntent(input);
  }
}

export const defaultHybridRouter = new HybridRouter();
