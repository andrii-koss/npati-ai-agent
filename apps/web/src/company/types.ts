export type Company = {
  id: string; businessId?: string; name: string; website?: string; industry?: string; description?: string;
  productsServices?: string; languages: string[]; brandTone?: string; companyInstructions?: string;
  mainAgentId?: string; status: "active" | "inactive"; revision: number;
};
export type Agent = {
  id: string; companyId: string; name: string; role: string; description?: string; systemInstruction?: string;
  promptGuidelines?: string; recommendedPrompts: string[]; modelId?: string; fallbackModelId?: string;
  tools: string[]; isActive: boolean; sortOrder: number; revision: number;
};
export type Edge = { id: string; parentAgentId: string; childAgentId: string; relationType: string };
export type AgentPage = { agents: Agent[]; pagination: { limit: number; nextCursor: string | null } };
export type KnowledgeDocument = { id: string; fileId: string; filename?: string; mimeType?: string; sizeBytes?: number; status: string; errorMessage?: string; chunkCount: number; createdAt: string };
export type CompanyMemory = { id: string; content: string; source: string; revision?: number; updatedAt: string };
export type RunStep = { agentId: string; status: "selected" | "delegated" | "completed" | "failed" | "cancelled" };
export type RunDetails = { run: { id: string; status: string; mainAgentId?: string; selectedAgentIds?: string[]; executionMode?: string; result?: string; errorCode?: string; errorMessage?: string }; steps: RunStep[]; toolAudit: Array<{ toolName?: string; reasonCode?: string; inputSummary?: Record<string, unknown> }> };
export type RunSummary = RunDetails["run"];
export type CompanyDraft = {
  name: string; businessId: string; website: string; industry: string; description: string;
  productsServices: string; languages: string; brandTone: string; companyInstructions: string; status: "active" | "inactive";
};
export type AgentDraft = {
  name: string; role: string; description: string; systemInstruction: string; promptGuidelines: string;
  recommendedPrompts: string; modelId: string; fallbackModelId: string; tools: string[];
  isActive: boolean; parentAgentId: string;
};

export type CapabilityItem = {
  id: string;
  name: string;
  description: string;
  domain: string;
  risk: string;
  requiresConfirmation: boolean;
  requiredPermissions: string[];
  requiredConnections: string[];
};

export const defaultToolOptions: CapabilityItem[] = [
  { id: "storage.agent_knowledge_retrieval", name: "Knowledge", description: "Search uploaded Company Knowledge documents.", domain: "storage", risk: "high", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "storage.company_memory", name: "Company Memory", description: "Read durable Company facts and operating rules.", domain: "storage", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "research.web_search", name: "Web Search", description: "Search the web for current information.", domain: "research", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "browser.web_fetch", name: "Web Fetch", description: "Read a specific web page.", domain: "browser", risk: "medium", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "browser.browser_tab_control", name: "Browser Navigation & Jobs", description: "Navigate with managed profiles and resume paused browser jobs.", domain: "browser", risk: "medium", requiresConfirmation: false, requiredPermissions: ["browser:execute"], requiredConnections: [] },
  { id: "browser.browser_clicktype", name: "Browser Forms & Autonomous Tasks", description: "Fill forms, register accounts, and run approved Browser Use tasks.", domain: "browser", risk: "high", requiresConfirmation: true, requiredPermissions: ["browser:execute"], requiredConnections: [] },
  { id: "browser.browser_screenshots", name: "Browser Screenshots", description: "Capture real Chrome screenshots.", domain: "browser", risk: "medium", requiresConfirmation: false, requiredPermissions: ["browser:execute"], requiredConnections: [] },
  { id: "browser.browser_downloads", name: "Browser File Transfer", description: "Upload approved Company files and manage browser downloads.", domain: "browser", risk: "high", requiresConfirmation: true, requiredPermissions: ["browser:execute"], requiredConnections: [] },
  { id: "web.crawl", name: "Crawler", description: "Crawl multiple pages from a website.", domain: "research", risk: "medium", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "mcp", name: "MCP", description: "Use approved MCP tools.", domain: "system", risk: "medium", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "files", name: "Files", description: "List and read Company files.", domain: "files", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "system.text-to-speech", name: "Text-to-Speech", description: "Generate speech audio with the selected voice.", domain: "system", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "exec", name: "Code Mode / Exec", description: "Validate and run approved JavaScript in an isolated sandbox without host or network access.", domain: "security", risk: "critical", requiresConfirmation: true, requiredPermissions: ["business:manage"], requiredConnections: [] },
];

export const toolTranslationKeys: Record<string, string> = {
  "storage.agent_knowledge_retrieval": "knowledge",
  "storage.company_memory": "companyMemory",
  "research.web_search": "webSearch",
  "browser.web_fetch": "webFetch",
  "web.crawl": "crawler",
  mcp: "mcp",
  files: "files",
  "system.text-to-speech": "textToSpeech",
  exec: "exec",
};

export type Translate = (path: string, params?: Record<string, string | number>) => string;

export function translatedStatus(t: Translate, status: string) {
  const translated = t(`companySettings.status.${status}`);
  return translated === `companySettings.status.${status}` ? status : translated;
}

export function translatedMode(t: Translate, mode?: string) {
  if (!mode) return "";
  const translated = t(`companySettings.mode.${mode}`);
  return translated === `companySettings.mode.${mode}` ? mode : translated;
}

export function translatedTool(t: Translate, tool: CapabilityItem) {
  const key = toolTranslationKeys[tool.id];
  if (!key) return { name: tool.name, description: tool.description };
  return {
    name: t(`companySettings.toolCatalog.${key}Name`),
    description: t(`companySettings.toolCatalog.${key}Desc`),
  };
}

export const emptyCompany: CompanyDraft = { name: "", businessId: "", website: "", industry: "", description: "", productsServices: "", languages: "", brandTone: "", companyInstructions: "", status: "active" };
export const emptyAgent: AgentDraft = { name: "", role: "", description: "", systemInstruction: "", promptGuidelines: "", recommendedPrompts: "", modelId: "", fallbackModelId: "", tools: [], isActive: true, parentAgentId: "" };

export function companyDraft(company?: Company): CompanyDraft {
  return company ? {
    name: company.name, businessId: company.businessId ?? "", website: company.website ?? "", industry: company.industry ?? "",
    description: company.description ?? "", productsServices: company.productsServices ?? "",
    languages: company.languages.join(", "), brandTone: company.brandTone ?? "",
    companyInstructions: company.companyInstructions ?? "", status: company.status,
  } : { ...emptyCompany };
}

export function agentDraft(agent: Agent | undefined, edges: Edge[]): AgentDraft {
  return agent ? {
    name: agent.name, role: agent.role, description: agent.description ?? "", systemInstruction: agent.systemInstruction ?? "",
    promptGuidelines: agent.promptGuidelines ?? "", recommendedPrompts: agent.recommendedPrompts.join("\n"),
    modelId: agent.modelId ?? "", fallbackModelId: agent.fallbackModelId ?? "", tools: agent.tools,
    isActive: agent.isActive, parentAgentId: edges.find((edge) => edge.childAgentId === agent.id)?.parentAgentId ?? "",
  } : { ...emptyAgent };
}
