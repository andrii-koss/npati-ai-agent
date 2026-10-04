import { getStoredAuthToken } from "./AuthContext";
import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Model } from "./ai-marketplace-types";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import { ProjectSection } from "./ProjectSection";

type Company = {
  id: string; businessId?: string; name: string; website?: string; industry?: string; description?: string;
  productsServices?: string; languages: string[]; brandTone?: string; companyInstructions?: string;
  mainAgentId?: string; status: "active" | "inactive"; revision: number;
};
type Agent = {
  id: string; companyId: string; name: string; role: string; description?: string; systemInstruction?: string;
  promptGuidelines?: string; recommendedPrompts: string[]; modelId?: string; fallbackModelId?: string;
  tools: string[]; isActive: boolean; sortOrder: number; revision: number;
};
type Edge = { id: string; parentAgentId: string; childAgentId: string; relationType: string };
type AgentPage = { agents: Agent[]; pagination: { limit: number; nextCursor: string | null } };
type KnowledgeDocument = { id:string;fileId:string;filename?:string;mimeType?:string;sizeBytes?:number;status:string;errorMessage?:string;chunkCount:number;createdAt:string };
type CompanyMemory = { id:string;content:string;source:string;revision?:number;updatedAt:string };
type RunStep = { agentId: string; status: "selected" | "delegated" | "completed" | "failed" | "cancelled" };
type RunDetails = { run: { id: string; status: string; mainAgentId?: string; selectedAgentIds?: string[]; executionMode?: string; result?: string; errorCode?: string; errorMessage?: string }; steps: RunStep[]; toolAudit: Array<{ toolName?: string; reasonCode?: string; inputSummary?: Record<string, unknown> }> };
type RunSummary = RunDetails["run"];
type CompanyDraft = {
  name: string; businessId: string; website: string; industry: string; description: string;
  productsServices: string; languages: string; brandTone: string; companyInstructions: string; status: "active" | "inactive";
};
type AgentDraft = {
  name: string; role: string; description: string; systemInstruction: string; promptGuidelines: string;
  recommendedPrompts: string; modelId: string; fallbackModelId: string; tools: string[];
  isActive: boolean; parentAgentId: string;
};

type CapabilityItem = {
  id: string;
  name: string;
  description: string;
  domain: string;
  risk: string;
  requiresConfirmation: boolean;
  requiredPermissions: string[];
  requiredConnections: string[];
};

const defaultToolOptions: CapabilityItem[] = [
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
const toolTranslationKeys: Record<string, string> = {
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

type Translate = (path: string, params?: Record<string, string | number>) => string;

function translatedStatus(t: Translate, status: string) {
  const translated = t(`companySettings.status.${status}`);
  return translated === `companySettings.status.${status}` ? status : translated;
}

function translatedMode(t: Translate, mode?: string) {
  if (!mode) return "";
  const translated = t(`companySettings.mode.${mode}`);
  return translated === `companySettings.mode.${mode}` ? mode : translated;
}

function translatedTool(t: Translate, tool: CapabilityItem) {
  const key = toolTranslationKeys[tool.id];
  if (!key) return { name: tool.name, description: tool.description };
  return {
    name: t(`companySettings.toolCatalog.${key}Name`),
    description: t(`companySettings.toolCatalog.${key}Desc`),
  };
}

const emptyCompany: CompanyDraft = { name: "", businessId: "", website: "", industry: "", description: "", productsServices: "", languages: "", brandTone: "", companyInstructions: "", status: "active" };
const emptyAgent: AgentDraft = { name: "", role: "", description: "", systemInstruction: "", promptGuidelines: "", recommendedPrompts: "", modelId: "", fallbackModelId: "", tools: [], isActive: true, parentAgentId: "" };

const COMPANIES_CACHE_KEY = "npati_companies_cache_v1";
const SELECTED_COMPANY_ID_KEY = "npati_selected_company_id_v1";

function getCachedCompanies(): Company[] {
  try {
    const raw = sessionStorage.getItem(COMPANIES_CACHE_KEY) || localStorage.getItem(COMPANIES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* storage may be restricted */ }
  return [];
}

function getCachedSelectedCompanyId(): string {
  try {
    return sessionStorage.getItem(SELECTED_COMPANY_ID_KEY) || localStorage.getItem(SELECTED_COMPANY_ID_KEY) || "";
  } catch { /* storage may be restricted */ }
  return "";
}

function updateCachedCompanies(list: Company[], currentId?: string) {
  try {
    const serialized = JSON.stringify(list);
    sessionStorage.setItem(COMPANIES_CACHE_KEY, serialized);
    localStorage.setItem(COMPANIES_CACHE_KEY, serialized);
    if (currentId) {
      sessionStorage.setItem(SELECTED_COMPANY_ID_KEY, currentId);
      localStorage.setItem(SELECTED_COMPANY_ID_KEY, currentId);
    }
  } catch { /* storage may be restricted */ }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => null) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function companyDraft(company?: Company): CompanyDraft {
  return company ? {
    name: company.name, businessId: company.businessId ?? "", website: company.website ?? "", industry: company.industry ?? "",
    description: company.description ?? "", productsServices: company.productsServices ?? "",
    languages: company.languages.join(", "), brandTone: company.brandTone ?? "",
    companyInstructions: company.companyInstructions ?? "", status: company.status,
  } : { ...emptyCompany };
}

function agentDraft(agent: Agent | undefined, edges: Edge[]): AgentDraft {
  return agent ? {
    name: agent.name, role: agent.role, description: agent.description ?? "", systemInstruction: agent.systemInstruction ?? "",
    promptGuidelines: agent.promptGuidelines ?? "", recommendedPrompts: agent.recommendedPrompts.join("\n"),
    modelId: agent.modelId ?? "", fallbackModelId: agent.fallbackModelId ?? "", tools: agent.tools,
    isActive: agent.isActive, parentAgentId: edges.find((edge) => edge.childAgentId === agent.id)?.parentAgentId ?? "",
  } : { ...emptyAgent };
}

function AgentModelIcon({ agent, model, working }: { agent: Agent; model?: Model; working: boolean }) {
  const [providerIconFailed, setProviderIconFailed] = useState(false);
  useEffect(() => setProviderIconFailed(false), [agent.modelId]);
  const providerId = model?.providerId ?? agent.modelId?.split("/")[0];
  const providerName = model?.providerName ?? providerId ?? "NPATI";
  const useProviderIcon = Boolean(agent.modelId && providerId && !providerIconFailed);
  const source = useProviderIcon
    ? `/api/ai/providers/${encodeURIComponent(providerId!)}/icon?surface=light-v2`
    : "/npati-auto.png";
  const { t } = useTranslation();
  return <span className={`company-agent-model-icon ${agent.modelId ? "provider" : "npati-auto"}`} title={`${agent.modelId ? t("companySettings.orgChart.modelVia", { model: model?.name ?? agent.modelId, provider: providerName }) : "NPATI Auto"} · ${working ? t("companySettings.orgChart.working") : t("companySettings.orgChart.idle")}`}>
    <img src={source} alt="" onError={(event) => {
      if (useProviderIcon) setProviderIconFailed(true);
      else event.currentTarget.style.visibility = "hidden";
    }} />
    <span className={`company-agent-activity-dot ${working ? "working" : "idle"}`} aria-label={working ? t("companySettings.orgChart.working") : t("companySettings.orgChart.idle")} />
  </span>;
}

function AgentNode({ agent, main, model, working, onClick }: { agent: Agent; main: boolean; model?: Model; working: boolean; onClick(): void }) {
  const { t } = useTranslation();
  return <button className={`company-agent-node ${main ? "main" : ""} ${agent.isActive ? "" : "inactive"} ${working ? "working" : ""}`} onClick={onClick}>
    <AgentModelIcon agent={agent} model={model} working={working} />
    <span><strong>{agent.name}</strong><small>{agent.role}</small><em>{agent.modelId || t("companySettings.orgChart.auto")}</em></span>
    {main && <b>{t("companySettings.orgChart.main")}</b>}
  </button>;
}

function OrgChart({ agents, edges, mainAgentId, models, workingAgentIds, onSelect }: { agents: Agent[]; edges: Edge[]; mainAgentId?: string; models: Model[]; workingAgentIds: Set<string>; onSelect(agent: Agent): void }) {
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const animationKey = useMemo(() => [
    ...agents.map((agent) => agent.id).sort(),
    "edges",
    ...edges.map((edge) => `${edge.parentAgentId}>${edge.childAgentId}`).sort(),
  ].join("|"), [agents, edges]);
  const levels = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const parentByChild = new Map(edges.map((edge) => [edge.childAgentId, edge.parentAgentId]));
    const children = new Map<string, string[]>();
    for (const edge of edges) children.set(edge.parentAgentId, [...(children.get(edge.parentAgentId) ?? []), edge.childAgentId]);
    const roots = agents.filter((agent) => !parentByChild.has(agent.id)).sort((a, b) => Number(b.id === mainAgentId) - Number(a.id === mainAgentId));
    const rows: Agent[][] = []; const visited = new Set<string>(); let current = roots;
    while (current.length) {
      rows.push(current); current.forEach((agent) => visited.add(agent.id));
      current = current.flatMap((agent) => children.get(agent.id) ?? []).map((id) => byId.get(id)).filter((agent): agent is Agent => Boolean(agent) && !visited.has(agent!.id));
    }
    const detached = agents.filter((agent) => !visited.has(agent.id));
    if (detached.length) rows.push(detached);
    return rows;
  }, [agents, edges, mainAgentId]);

  const { t } = useTranslation();
  if (!agents.length) return <div className="company-chart-empty"><strong>{t("companySettings.orgChart.emptyTitle")}</strong><p>{t("companySettings.orgChart.emptyDesc")}</p></div>;
  return <div className="company-org-chart" key={animationKey}>
    {levels.map((level, index) => <div className="company-chart-level" key={index} style={{ "--chart-level-delay": `${Math.max(0, index - 1) * 1.5}s`, "--chart-line-inset": `calc(${50 / level.length}% - ${((level.length - 1) * 24) / (2 * level.length)}px)` } as CSSProperties}>
      {index > 0 && <span className="company-chart-trunk" aria-hidden="true" />}
      <div className="company-chart-row">
        {index > 0 && level.map((agent, nodeIndex) => {
          const targetPercent = ((nodeIndex + .5) * 100) / level.length;
          const targetOffset = ((2 * nodeIndex - level.length + 1) * 24) / (2 * level.length);
          return <i className="company-chart-branch-pulse" key={`pulse-${agent.id}`} style={{ "--chart-pulse-target": `calc(${targetPercent}% + ${targetOffset}px)` } as CSSProperties} aria-hidden="true" />;
        })}
        {level.map((agent, nodeIndex) => {
          const precedingAgentCount = levels.slice(1, index).reduce((count, row) => count + row.length, 0);
          const cardDelay = Math.max(0, levels.length - 2) * 1.5 + 2.1 + (precedingAgentCount + nodeIndex) * .18;
          return <span className="company-chart-node-slot" key={agent.id} style={{ "--chart-card-delay": `${cardDelay}s` } as CSSProperties}><AgentNode agent={agent} main={agent.id === mainAgentId} model={agent.modelId ? modelById.get(agent.modelId) : undefined} working={workingAgentIds.has(agent.id)} onClick={() => onSelect(agent)} /></span>;
        })}
      </div>
    </div>)}
  </div>;
}

export function CompanyPage() {
  const { t, language } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCompanyId = searchParams.get("company") ?? "";
  const requestedRunId = searchParams.get("runId") ?? "";
  const { overview } = useWorkspace();
  const cachedCompaniesRef = useRef(getCachedCompanies());
  const [companies, setCompanies] = useState<Company[]>(cachedCompaniesRef.current);
  const [companiesLoading, setCompaniesLoading] = useState(() => cachedCompaniesRef.current.length === 0);
  const [companiesLoadError, setCompaniesLoadError] = useState("");
  const [selectedId, setSelectedId] = useState(() => requestedCompanyId || getCachedSelectedCompanyId() || cachedCompaniesRef.current[0]?.id || "");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [agentsPageLoading, setAgentsPageLoading] = useState(false);
  const [task, setTask] = useState("");
  const [runMode, setRunMode] = useState<"auto" | "single" | "pipeline" | "fusion">("auto");
  const [runDetails, setRunDetails] = useState<RunDetails>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [workingAgentIds, setWorkingAgentIds] = useState<Set<string>>(() => new Set());
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]);
  const [memories,setMemories]=useState<CompanyMemory[]>([]);
  const [memoryText,setMemoryText]=useState("");
  const [knowledgeBusy,setKnowledgeBusy]=useState(false);
  const [knowledgeActionId,setKnowledgeActionId]=useState("");
  const [memoryBusy,setMemoryBusy]=useState(false);
  const [editingMemoryId,setEditingMemoryId]=useState("");
  const [editingMemoryText,setEditingMemoryText]=useState("");
  const [companyEditor, setCompanyEditor] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company>();
  const [agentEditor, setAgentEditor] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent>();
  const [companyForm, setCompanyForm] = useState<CompanyDraft>({ ...emptyCompany });
  const [agentForm, setAgentForm] = useState<AgentDraft>({ ...emptyAgent });
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const companyCreateKey = useRef(crypto.randomUUID());
  const agentCreateKey = useRef(crypto.randomUUID());
  const selected = companies.find((company) => company.id === selectedId);

  useEffect(() => {
    if (!selectedId || !/^[0-9a-f-]{36}$/i.test(requestedRunId)) return;
    void api<RunDetails>(`/companies/${selectedId}/runs/${requestedRunId}`).then((details) => {
      setRunDetails(details);
      setRunning(!["completed", "failed", "cancelled", "awaiting_approval"].includes(details.run.status));
    }).catch(() => undefined);
  }, [selectedId, requestedRunId]);

  const [availableTools, setAvailableTools] = useState<CapabilityItem[]>(defaultToolOptions);

  useEffect(() => {
    api<CapabilityItem[]>("/capabilities?callable=true")
      .then((capabilities) => {
        if (!Array.isArray(capabilities)) return;
        const catalog = new Map(capabilities.map((tool) => [tool.id, tool]));
        setAvailableTools(defaultToolOptions.map((fallback) => {
          const capability = catalog.get(fallback.id);
          return capability ? { ...capability, name: fallback.name, description: fallback.description } : fallback;
        }));
      })
      .catch(() => {});
  }, []);

  async function loadCompanies(preferredId?: string) {
    const data = await api<{ companies: Company[] }>("/companies?limit=100");
    const list = data.companies ?? [];
    if (preferredId && !list.some((item) => item.id === preferredId)) {
      try { list.push(await api<Company>(`/companies/${encodeURIComponent(preferredId)}`)); } catch { /* Deleted or inaccessible companies are never selected. */ }
    }
    setCompanies(list);
    const nextId = preferredId && list.some((item) => item.id === preferredId) ? preferredId : (list[0]?.id ?? "");
    setSelectedId(nextId);
    updateCachedCompanies(list, nextId);
    return list;
  }

  async function loadOrganization(companyId: string, cursor?: string, append = false, companySnapshot = companies) {
    if (agentsPageLoading) return;
    setAgentsPageLoading(true);
    try {
      const page = await api<AgentPage>(`/companies/${companyId}/agents?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const mainId = companySnapshot.find((company) => company.id === companyId)?.mainAgentId;
      let mainAgent: Agent | undefined;
      const accumulated = append ? [...agents] : [];
      if (mainId && !accumulated.some((agent) => agent.id === mainId) && !page.agents.some((agent) => agent.id === mainId)) {
        mainAgent = await api<Agent>(`/companies/${companyId}/agents/${mainId}`);
      }
      const pageAgents = mainAgent ? [mainAgent, ...page.agents] : page.agents;
      const nextAgents = [...new Map([...accumulated, ...pageAgents].map((agent) => [agent.id, agent])).values()];
      const pageIds = [...new Set(pageAgents.map((agent) => agent.id))];
      const pageEdges = pageIds.length
        ? await api<Edge[]>(`/companies/${companyId}/agent-edges?agentIds=${encodeURIComponent(pageIds.join(","))}`)
        : [];
      const loadedIds = new Set(nextAgents.map((agent) => agent.id));
      const nextEdges = [...new Map([...(append ? edges : []), ...pageEdges].map((edge) => [edge.id, edge])).values()].filter(
        (edge) => loadedIds.has(edge.parentAgentId) && loadedIds.has(edge.childAgentId),
      );
      setAgents(nextAgents);
      setEdges(nextEdges);
      setAgentCursor(page.pagination.nextCursor);
    } finally {
      setAgentsPageLoading(false);
    }
  }

  async function loadAddedModels(showError = false) {
    setModelsLoading(true);
    setModelsError("");
    try {
      const value = await api<Model[] | { models: Model[] }>("/ai/models/added");
      const list = Array.isArray(value) ? value : (value.models ?? []);
      setModels([...new Map(list.map((model) => [model.id, model])).values()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("companySettings.errors.couldNotLoadModels");
      setModelsError(message);
      if (showError) setNotice(message);
    } finally {
      setModelsLoading(false);
    }
  }

  useEffect(() => {
    void initializeCompanies();
    void loadAddedModels();
  }, []);

  useEffect(() => {
    if (!requestedCompanyId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("company");
    setSearchParams(next, { replace: true });
  }, [requestedCompanyId]);

  useEffect(() => {
    if (requestedCompanyId && companies.some((company) => company.id === requestedCompanyId)) setSelectedId(requestedCompanyId);
  }, [requestedCompanyId, companies]);

  useEffect(() => {
    const refreshCompanies = () => { void loadCompanies(selectedId || requestedCompanyId).then((items) => {
      const active = items.find((company) => company.id === (selectedId || requestedCompanyId));
      if (active) void loadOrganization(active.id, undefined, false, items);
    }).catch(() => undefined); };
    window.addEventListener("npati:company-changed", refreshCompanies);
    return () => window.removeEventListener("npati:company-changed", refreshCompanies);
  }, [selectedId, requestedCompanyId]);

  async function initializeCompanies() {
    if (companies.length === 0) setCompaniesLoading(true);
    setCompaniesLoadError("");
    try {
      const targetId = requestedCompanyId || selectedId;
      const items = await loadCompanies(targetId);
      const first = items.find((company) => company.id === targetId) ?? items[0];
      if (first) await loadOrganization(first.id, undefined, false, items);
    } catch (error) {
      setCompaniesLoadError(error instanceof Error ? error.message : t("companySettings.errors.couldNotLoadCompanies"));
    } finally {
      setCompaniesLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedId) return;
    setMemoryText("");
    setEditingMemoryId("");
    setEditingMemoryText("");
    void loadOrganization(selectedId);
    void api<{ documents: KnowledgeDocument[] }>(`/companies/${selectedId}/knowledge/documents`).then((value) => setDocuments(value.documents ?? [])).catch(() => setDocuments([]));
    void api<{ memories: CompanyMemory[] }>(`/companies/${selectedId}/knowledge/memory`).then((value) => setMemories(value.memories ?? [])).catch(() => setMemories([]));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setWorkingAgentIds(new Set());
      return;
    }
    let active = true;
    const refreshWorkingAgents = async () => {
      try {
        const value = await api<{ runs: RunSummary[] }>(`/companies/${selectedId}/runs?limit=20`);
        const activeRuns = (value.runs ?? []).filter((run) => ["queued", "planning", "running", "cancelling"].includes(run.status));
        const details = await Promise.all(activeRuns.map((run) => api<RunDetails>(`/companies/${selectedId}/runs/${run.id}`)));
        const ids = new Set<string>();
        for (const detail of details) {
          if (!["queued", "planning", "running", "cancelling"].includes(detail.run.status)) continue;
          if (detail.run.mainAgentId) ids.add(detail.run.mainAgentId);
          if (detail.run.status === "running" || detail.run.status === "cancelling") {
            for (const agentId of detail.run.selectedAgentIds ?? []) ids.add(agentId);
            for (const step of detail.steps ?? []) {
              if (step.status === "selected" || step.status === "delegated") ids.add(step.agentId);
            }
          }
        }
        if (active) setWorkingAgentIds(ids);
      } catch {
        if (active) setWorkingAgentIds(new Set());
      }
    };
    void refreshWorkingAgents();
    const timer = window.setInterval(() => void refreshWorkingAgents(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !documents.some((document) => document.status === "uploaded" || document.status === "processing")) return;
    const timer = window.setInterval(() => {
      void api<{ documents: KnowledgeDocument[] }>(`/companies/${selectedId}/knowledge/documents`)
        .then((value) => setDocuments(value.documents ?? []))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedId, documents]);

  useEffect(() => { setRunDetails(undefined); setRunning(false); }, [selectedId]);
  useEffect(() => {
    if (!runDetails || !selectedId || ["completed", "failed", "cancelled", "awaiting_approval"].includes(runDetails.run.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api<RunDetails>(`/companies/${selectedId}/runs/${runDetails.run.id}`).then((details) => {
        if (!active) return;
        setRunDetails(details);
        const terminal = ["completed", "failed", "cancelled"].includes(details.run.status);
        setRunning(!terminal);
        if (terminal) setNotice(details.run.status === "completed" ? t("companySettings.notices.runCompleted") : details.run.errorMessage ?? t("companySettings.notices.runEnded", { status: translatedStatus(t, details.run.status) }));
      }).catch((error) => {
        if (!active) return;
        setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotApply"));
        setRunning(false);
      });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedId, runDetails]);

  function openCompanyEditor(company?: Company) {
    setEditingCompany(company); setCompanyForm(companyDraft(company)); setCompanyEditor(true); setAgentEditor(false); setNotice("");
  }
  function openAgentEditor(agent?: Agent) {
    setEditingAgent(agent); setAgentForm(agentDraft(agent, edges)); setAgentEditor(true); setCompanyEditor(false); setNotice("");
    void loadAddedModels(true);
  }

  async function saveCompany(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const payload = { ...companyForm, businessId: companyForm.businessId || undefined,
        languages: companyForm.languages.split(",").map((item) => item.trim()).filter(Boolean) };
      let saved: Company;
      if (editingCompany) {
        saved = await api<Company>(`/companies/${editingCompany.id}`, {
          method: "PATCH", body: JSON.stringify({ ...payload, expectedRevision: editingCompany.revision }),
        });
      } else {
        saved = await api<Company>("/companies", {
          method: "POST", headers: { "idempotency-key": companyCreateKey.current }, body: JSON.stringify(payload),
        });
        companyCreateKey.current = crypto.randomUUID();
      }
      if (!editingCompany && !readActiveCompanyId()) writeActiveCompanyId(saved.id);
      window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: editingCompany ? "update" : "create", companyId: saved.id } }));
      setCompanyEditor(false); setEditingCompany(undefined); await loadCompanies(saved.id);
      setNotice(t("companySettings.notices.companySaved"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("companySettings.errors.couldNotSave");
      if (/changed by another request|revision|conflict/i.test(msg)) {
        setNotice(t("companySettings.errors.revisionConflictCompany"));
      } else {
        setNotice(msg);
      }
    }
    finally { setSaving(false); }
  }

  async function saveAgent(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setNotice("");
    try {
      const { parentAgentId, ...draft } = agentForm;
      const canonicalTools = [...new Set(draft.tools.map((value) =>
        availableTools.find((tool) => tool.id === value || tool.name === value)?.id ?? value,
      ))];
      const payload = { ...draft, tools: canonicalTools, modelId: draft.modelId || undefined, fallbackModelId: draft.fallbackModelId || undefined,
        recommendedPrompts: draft.recommendedPrompts.split("\n").map((item) => item.trim()).filter(Boolean) };
      let saved: Agent;
      if (editingAgent) {
        saved = await api<Agent>(`/companies/${selected.id}/agents/${editingAgent.id}`, {
          method: "PATCH", body: JSON.stringify({ ...payload, expectedRevision: editingAgent.revision }),
        });
      } else {
        saved = await api<Agent>(`/companies/${selected.id}/agents`, {
          method: "POST", headers: { "idempotency-key": agentCreateKey.current }, body: JSON.stringify(payload),
        });
        agentCreateKey.current = crypto.randomUUID();
      }
      await api(`/companies/${selected.id}/agents/${saved.id}/parent`, {
        method: "PUT", body: JSON.stringify({ parentAgentId: parentAgentId || null }),
      });
      setAgentEditor(false); setEditingAgent(undefined); await loadOrganization(selected.id); setNotice(t("companySettings.notices.agentSaved"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("companySettings.errors.couldNotSaveAgent");
      if (/changed by another request|revision|conflict/i.test(msg)) {
        setNotice(t("companySettings.errors.revisionConflictAgent"));
      } else {
        setNotice(msg);
      }
    }
    finally { setSaving(false); }
  }

  async function setMainAgent(agentId: string) {
    if (!selected) return;
    try {
      const updated = await api<Company>(`/companies/${selected.id}/main-agent`, {
        method: "PUT", body: JSON.stringify({ agentId: agentId || null, expectedRevision: selected.revision }),
      });
      setCompanies((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (error) { setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotSetMain")); }
  }

  async function enableMainAgentKnowledge() {
    if (!selected?.mainAgentId) return;
    const mainAgent = agents.find((agent) => agent.id === selected.mainAgentId);
    if (!mainAgent || mainAgent.tools.some((tool) => tool === "Knowledge" || tool === "storage.agent_knowledge_retrieval" || tool.toLowerCase() === "knowledge")) return;
    setKnowledgeBusy(true); setNotice("");
    try {
      await api<Agent>(`/companies/${selected.id}/agents/${mainAgent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ tools: [...mainAgent.tools, "Knowledge"], expectedRevision: mainAgent.revision }),
      });
      await loadOrganization(selected.id);
      setNotice(t("companySettings.notices.knowledgeEnabled", { name: mainAgent.name }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotEnableKnowledge"));
    } finally { setKnowledgeBusy(false); }
  }

  async function updateCompanyBusiness(businessId: string) {
    if (!selected) return;
    try {
      const updated = await api<Company>(`/companies/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ businessId: businessId || null, expectedRevision: selected.revision }),
      });
      setCompanies((items) => items.map((item) => item.id === updated.id ? updated : item));
      setNotice(t("companySettings.notices.businessUpdated"));
    } catch (error) { setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotUpdateBusiness")); }
  }

  async function deleteAgent() {
    if (!selected || !editingAgent) return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteAgentTitle"),
      message: t("companySettings.dialogs.deleteAgentMessage", { name: editingAgent.name }),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      const deletingId = editingAgent.id;
      await api(`/companies/${selected.id}/agents/${deletingId}?expectedRevision=${editingAgent.revision}`, { method: "DELETE" });
      setAgentEditor(false); setEditingAgent(undefined);
      setAgents((items) => items.filter((agent) => agent.id !== deletingId));
      setEdges((items) => items.filter((edge) => edge.parentAgentId !== deletingId && edge.childAgentId !== deletingId));
      const refreshedCompanies = await loadCompanies(selected.id);
      await loadOrganization(selected.id, undefined, false, refreshedCompanies);
      setNotice(t("companySettings.notices.agentDeleted"));
    } catch (error) { setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotDeleteAgent")); }
  }

  async function runCompany(event: FormEvent) {
    event.preventDefault();
    if (!selected || !task.trim() || running) return;
    setRunning(true); setNotice(""); setRunDetails(undefined);
    if (selected.mainAgentId) setWorkingAgentIds((ids) => new Set([...ids, selected.mainAgentId!]));
    try {
      const result = await api<RunDetails>(`/companies/${selected.id}/runs`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ task: task.trim(), mode: runMode }),
      });
      setRunDetails(result);
      if (result.run.status === "completed") setNotice(t("companySettings.notices.runCompleted"));
      else setNotice(result.run.errorMessage ?? t("companySettings.notices.runEnded", { status: translatedStatus(t, result.run.status) }));
      const remainsActive = !["completed", "failed", "cancelled", "awaiting_approval"].includes(result.run.status);
      setRunning(remainsActive);
      if (!remainsActive) setWorkingAgentIds(new Set());
    } catch (error) { setRunning(false); setWorkingAgentIds(new Set()); setNotice(error instanceof Error ? error.message : t("companySettings.notices.runFailed")); }
  }

  const pendingApprovalId = runDetails?.run.errorCode === "APPROVAL_REQUIRED"
    ? runDetails.run.errorMessage?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0]
    : undefined;

  async function decideRunApproval(decision: "approved" | "rejected") {
    if (!selected || !runDetails || !pendingApprovalId || approvalBusy) return;
    setApprovalBusy(true); setNotice("");
    try {
      await api(`/companies/${selected.id}/approvals/${pendingApprovalId}/decide`, {
        method: "POST", body: JSON.stringify({ decision }),
      });
      if (decision === "rejected") {
        const cancelled = await api<RunDetails>(`/companies/${selected.id}/runs/${runDetails.run.id}/cancel`, { method: "POST" });
        setRunDetails(cancelled);
        setRunning(false);
        setNotice(t("companySettings.notices.executionRejected"));
        return;
      }
      setRunning(true);
      const resumed = await api<RunDetails>(`/companies/${selected.id}/runs/${runDetails.run.id}/resume`, {
        method: "POST", body: JSON.stringify({ approvalId: pendingApprovalId }),
      });
      setRunDetails(resumed);
      const remainsActive = !["completed", "failed", "cancelled", "awaiting_approval"].includes(resumed.run.status);
      setRunning(remainsActive);
      setNotice(resumed.run.status === "completed" ? t("companySettings.notices.approvedCompleted") : resumed.run.errorMessage ?? t("companySettings.notices.runEnded", { status: translatedStatus(t, resumed.run.status) }));
    } catch (error) {
      setRunning(false);
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotApply"));
    } finally { setApprovalBusy(false); }
  }

  async function readFileAsBase64(file:File){
    return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error??new Error(t("companySettings.errors.couldNotReadDocument")));reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.readAsDataURL(file);});
  }
  async function uploadKnowledge(files:File[]){
    if(!selected||!files.length)return;
    const companyId=selected.id;
    setKnowledgeBusy(true);setNotice("");
    let uploaded=0;
    const failures:string[]=[];
    for(const file of files){
      try{
        if(file.size===0)throw new Error(t("companySettings.errors.fileIsEmpty"));
        if(file.size>25*1024*1024)throw new Error(t("companySettings.errors.fileSizeLimitExceeded"));
        const data=await readFileAsBase64(file);
        const document=await api<KnowledgeDocument>(`/companies/${companyId}/knowledge/documents`,{method:"POST",headers:{"idempotency-key":crypto.randomUUID()},body:JSON.stringify({filename:file.name,mimeType:file.type||"application/octet-stream",data})});
        setDocuments(items=>[document,...items.filter(item=>item.id!==document.id)]);
        uploaded++;
      }catch(error){failures.push(`${file.name}: ${error instanceof Error?error.message:t("companySettings.errors.uploadFailed")}`);}
    }
    try{const value=await api<{documents:KnowledgeDocument[]}>(`/companies/${companyId}/knowledge/documents`);setDocuments(value.documents??[]);}catch{}
    setKnowledgeBusy(false);
    setNotice(failures.length ? t("companySettings.notices.uploadedWithErrors", { count: String(uploaded), errors: failures.join("; ") }) : t("companySettings.notices.uploadedAndQueued", { count: String(uploaded) }));
  }
  async function addCompanyMemory(){
    const content=memoryText.trim();if(!selected||!content||memoryBusy)return;
    setMemoryBusy(true);setNotice("");
    try{const created=await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory`,{method:"POST",body:JSON.stringify({content})});setMemoryText("");setMemories(items=>[created,...items.filter(item=>item.id!==created.id)]);setNotice(t("companySettings.notices.memoryAdded"));}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.memorySaveFailed"));}finally{setMemoryBusy(false);}
  }
  function startEditingMemory(memory:CompanyMemory){setEditingMemoryId(memory.id);setEditingMemoryText(memory.content);}
  async function updateCompanyMemory(){
    const content=editingMemoryText.trim();if(!selected||!editingMemoryId||!content||memoryBusy)return;
    setMemoryBusy(true);setNotice("");
    try{const updated=await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory/${editingMemoryId}`,{method:"PUT",body:JSON.stringify({content})});setMemories(items=>items.map(item=>item.id===updated.id?updated:item));setEditingMemoryId("");setEditingMemoryText("");setNotice(t("companySettings.notices.memoryUpdated"));}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.memoryUpdateFailed"));}finally{setMemoryBusy(false);}
  }
  async function deleteKnowledge(id:string){
    if(!selected||knowledgeActionId)return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteDocTitle"),
      message: t("companySettings.dialogs.deleteDocMessage"),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if(!confirmed) return;
    setKnowledgeActionId(id);setNotice("");
    try{await api(`/companies/${selected.id}/knowledge/documents/${id}`,{method:"DELETE"});setDocuments(items=>items.filter(item=>item.id!==id));setNotice(t("companySettings.notices.docDeleted"));}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.docDeleteFailed"));}finally{setKnowledgeActionId("");}
  }
  async function downloadKnowledge(doc:KnowledgeDocument){
    if(!selected||knowledgeActionId)return;setKnowledgeActionId(doc.id);setNotice("");
    try{const headers=new Headers();const token=getStoredAuthToken();if(token)headers.set("authorization",`Bearer ${token}`);const response=await fetch(`/api/companies/${selected.id}/knowledge/documents/${doc.id}/content`,{headers});if(!response.ok){const body=await response.json().catch(()=>null) as {error?:{message?:string}}|null;throw new Error(body?.error?.message??`${t("companySettings.errors.downloadFailedStatus")} (${response.status})`);}const url=URL.createObjectURL(await response.blob());const link=document.createElement("a");link.href=url;link.download=doc.filename||"company-document";document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.docDownloadFailed"));}finally{setKnowledgeActionId("");}
  }
  async function reprocessKnowledge(id:string){
    if(!selected||knowledgeActionId)return;setKnowledgeActionId(id);setNotice("");
    try{const document=await api<KnowledgeDocument>(`/companies/${selected.id}/knowledge/documents/${id}/reprocess`,{method:"POST"});setDocuments(items=>items.map(item=>item.id===id?document:item));setNotice(t("companySettings.notices.docReprocessing"));}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.docRetryFailed"));}finally{setKnowledgeActionId("");}
  }
  async function deleteCompanyMemory(id:string){
    if(!selected||memoryBusy)return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteMemoryTitle"),
      message: t("companySettings.dialogs.deleteMemoryMessage"),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if(!confirmed) return;
    setMemoryBusy(true);setNotice("");
    try{await api(`/companies/${selected.id}/knowledge/memory/${id}`,{method:"DELETE"});setMemories(items=>items.filter(item=>item.id!==id));if(editingMemoryId===id){setEditingMemoryId("");setEditingMemoryText("");}setNotice(t("companySettings.notices.memoryDeleted"));}
    catch(error){setNotice(error instanceof Error?error.message:t("companySettings.errors.memoryDeleteFailed"));}finally{setMemoryBusy(false);}
  }

  async function deleteCompany() {
    if (!selected) return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteCompanyTitle"),
      message: t("companySettings.dialogs.deleteCompanyMessage", { name: selected.name }),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/companies/${selected.id}`, { method: "DELETE" });
      if (readActiveCompanyId() === selected.id) writeActiveCompanyId("");
      window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "delete", companyId: selected.id } }));
      setCompanyEditor(false); setEditingCompany(undefined); await loadCompanies();
    } catch (error) { setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotDelete")); }
  }

  const noticeIsSuccess = Boolean(notice)
    && /saved|uploaded|queued|added|updated|deleted|completed/i.test(notice)
    && !/failed|error|could not|unavailable|exceeded|required|conflict|timed out|denied/i.test(notice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);


  if (companiesLoadError) return <main className="company-page company-refined company-initial-state">
    <strong>{t("companySettings.errors.couldNotLoad")}</strong>
    <p>{companiesLoadError}</p>
    <button className="button-primary" type="button" onClick={() => void initializeCompanies()}>{t("companySettings.errors.tryAgain")}</button>
  </main>;

  return <main className="company-page company-refined">
    <header className="company-page-header">
      <div>
        <p className="eyebrow">{t("companySettings.header.eyebrow")}</p>
        <div className="company-title-row">
          <Link
            to="/settings"
            className="marketplace-back-button"
            aria-label={t("companySettings.header.backToSettings")}
            title={t("companySettings.header.backToSettings")}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1
            className="company-header-title"
            title={selected ? selected.name : t("companySettings.header.buildTitle")}
          >
            {selected ? selected.name : t("companySettings.header.buildTitle")}
          </h1>
          {selected && <span className={`company-status ${selected.status}`}>{translatedStatus(t, selected.status)}</span>}

          {selected && (
            <div className="company-title-actions">
              <button
                type="button"
                className="content-action-btn edit-btn"
                onClick={() => openCompanyEditor(selected)}
                title={t("companySettings.header.editCompanyTitle")}
              >
                {t("companySettings.header.editCompany")}
              </button>
              <button
                type="button"
                className="content-action-btn delete-btn"
                onClick={() => void deleteCompany()}
                title={t("companySettings.header.deleteTitle")}
              >
                {t("companySettings.header.deleteBtn")}
              </button>
            </div>
          )}
        </div>
        {selected?.description && selected.description !== selected.name && selected.description !== "New Company" && (
          <p className="company-header-desc">{selected.description}</p>
        )}
      </div>
      <div className="company-header-actions">
        <button className="button-secondary" onClick={() => openCompanyEditor()}>
          {t("companySettings.header.newCompany")}
        </button>
        {selected && (
          <button className="button-primary automations-action-primary" onClick={() => openAgentEditor()}>
            {t("companySettings.header.addAgent")}
          </button>
        )}
      </div>
    </header>

    {notice && (
      <div className={`company-notice-banner ${noticeIsSuccess ? "success" : "error"}`}>
        <span className="company-notice-icon" aria-hidden="true">
          {noticeIsSuccess ? "✓" : "⚠"}
        </span>
        <div className="company-notice-content">
          <strong>{noticeIsSuccess ? t("companySettings.notices.updateCompleted") : t("companySettings.notices.systemAlert")}</strong>
          <span>{notice}</span>
        </div>
        <button
          type="button"
          className="company-notice-close"
          onClick={() => setNotice("")}
          aria-label={t("companySettings.misc.dismissNotice")}
        >
          ×
        </button>
      </div>
    )}

    {companiesLoading ? null : !selected ? <section className="company-first-run">
      <span className="provider-avatar">CO</span><h2>{t("companySettings.firstRun.title")}</h2>
      <p>{t("companySettings.firstRun.description")}</p>
      <button className="button-primary" onClick={() => openCompanyEditor()}>{t("companySettings.firstRun.createButton")}</button>
    </section> : <>
      <section className="company-control-strip">
        {/* Block 1: Обираємо компанію */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">{t("companySettings.strip.company")}</span>
            <span className="company-strip-badge badge-active">{t("companySettings.strip.active")}</span>
          </div>
          <div className="company-strip-control-row">
            <select
              aria-label={t("companySettings.strip.selectCompany")}
              value={selectedId}
              onChange={(event) => {
                const next = event.target.value;
                setSelectedId(next);
                try {
                  sessionStorage.setItem(SELECTED_COMPANY_ID_KEY, next);
                  localStorage.setItem(SELECTED_COMPANY_ID_KEY, next);
                } catch {}
              }}
              className="company-strip-select"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
          <span
            className="company-strip-footer-text"
            title={`${t("companySettings.strip.mainOrchestrator")} ${agents.find((a) => a.id === selected.mainAgentId)?.name ?? t("companySettings.header.addAgent")}`}
          >
            {t("companySettings.strip.mainOrchestrator")} {agents.find((a) => a.id === selected.mainAgentId)?.name ?? t("companySettings.header.addAgent")}
          </span>
        </div>

        {/* Block 2: Обираємо бізнес який є створений і підходить */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">{t("companySettings.strip.linkedBusiness")}</span>
            <span className="company-strip-badge badge-linked">{t("companySettings.strip.linked")}</span>
          </div>
          <div className="company-strip-control-row">
            <select
              aria-label={t("companySettings.strip.selectLinkedBusiness")}
              value={selected.businessId ?? ""}
              onChange={(event) => void updateCompanyBusiness(event.target.value)}
              className="company-strip-select"
            >
              <option value="">{t("companySettings.strip.independent")}</option>
              {overview?.businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </select>
          </div>
          <span
            className="company-strip-footer-text"
            title={t("companySettings.strip.contextConnected")}
          >
            {t("companySettings.strip.contextConnected")}
          </span>
        </div>

        {/* Block 3: Кількість агентів */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">{t("companySettings.strip.totalAgents")}</span>
            <span className="company-strip-badge badge-hierarchy">{t("companySettings.strip.hierarchy")}</span>
          </div>
          <div className="company-strip-control-row">
            <strong>{t("companySettings.strip.agentsCount", { count: String(agents.length) })}</strong>
          </div>
          <span className="company-strip-footer-text" title={t("companySettings.strip.readyForTasks")}>
            {t("companySettings.strip.readyForTasks")}
          </span>
        </div>
      </section>

      <section className="company-run-card">
        <div className="company-section-heading">
          <div>
            <span>{t("companySettings.runtime.kicker")}</span>
            <h2>{t("companySettings.runtime.title")}</h2>
          </div>
          <small>{t("companySettings.runtime.subtitle")}</small>
        </div>

        <form onSubmit={runCompany} className="company-run-form">
          <textarea
            required
            rows={3}
            maxLength={20000}
            placeholder={t("companySettings.runtime.taskPlaceholder")}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="company-run-textarea"
          />

          <div className="company-run-actions-bar">
            <div className="company-run-mode-field">
              <label htmlFor="company-run-mode" className="company-mode-label">
                {t("companySettings.runtime.executionMode")}
              </label>
              <select
                id="company-run-mode"
                aria-label={t("companySettings.misc.executionModeAriaLabel")}
                value={runMode}
                onChange={(event) => setRunMode(event.target.value as typeof runMode)}
                className="company-mode-select"
              >
                <option value="auto">{t("companySettings.runtime.autoMode")}</option>
                <option value="single">{t("companySettings.runtime.singleMode")}</option>
                <option value="pipeline">{t("companySettings.runtime.pipelineMode")}</option>
                <option value="fusion">{t("companySettings.runtime.fusionMode")}</option>
              </select>
            </div>

            <button
              type="submit"
              className="button-primary automations-action-primary company-run-button"
              disabled={running || !selected.mainAgentId}
            >
              {running ? (
                <>
                  <span className="company-run-spinner" aria-hidden="true" />
                  <span>{t("companySettings.runtime.runningCompany")}</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>{t("companySettings.runtime.runCompany")}</span>
                </>
              )}
            </button>
          </div>
        </form>

        {!selected.mainAgentId && (
          <div className="company-field-notice-box">
            <span className="company-notice-bulb" aria-hidden="true">ℹ</span>
            <span dangerouslySetInnerHTML={{ __html: t("companySettings.runtime.mainAgentNotice") }} />
          </div>
        )}

        {runDetails && (
          <div className="company-run-status-strip">
            <span
              className={`status-indicator-dot ${
                runDetails.run.status === "completed"
                  ? "ok"
                  : runDetails.run.status === "failed"
                  ? "error"
                  : "standby"
              }`}
            />
            <span>
              {t("companySettings.runtime.runStatus")} <strong>{translatedStatus(t, runDetails.run.status)}</strong>
              {runDetails.run.errorMessage ? ` — ${runDetails.run.errorMessage}` : ""}
            </span>
          </div>
        )}

        {pendingApprovalId && (
          <div className="company-field-notice-box company-approval-box">
            <span className="company-notice-bulb" aria-hidden="true">!</span>
            <span>
              <span dangerouslySetInnerHTML={{ __html: t("companySettings.runtime.approvalRequired") }} />
              <code className="company-approval-preview">{JSON.stringify([...(runDetails?.toolAudit ?? [])].reverse().find((item) => item.reasonCode === "approval_required")?.inputSummary ?? {})}</code>
            </span>
            <div className="company-approval-actions">
              <button type="button" className="button-secondary" disabled={approvalBusy} onClick={() => void decideRunApproval("rejected")}>{t("companySettings.runtime.reject")}</button>
              <button type="button" className="button-primary" disabled={approvalBusy} onClick={() => void decideRunApproval("approved")}>{approvalBusy ? t("companySettings.runtime.applying") : t("companySettings.runtime.approve")}</button>
            </div>
          </div>
        )}

        {runDetails?.run.result && (
          <div className="company-run-result">
            <div className="company-run-result-header">
              <div className="company-result-title-group">
                <span className="company-result-badge">{t("companySettings.runtime.result")}</span>
                <strong>{t("companySettings.runtime.finalResponse")}</strong>
              </div>
              <small className="company-result-meta">
                {translatedMode(t, runDetails.run.executionMode)} · {translatedStatus(t, runDetails.run.status)}
              </small>
            </div>
            <div className="company-result-body">
              <p>{runDetails.run.result}</p>
            </div>
          </div>
        )}
      </section>

      <section className="company-chart-card">
        <div className="company-section-heading"><div><span>{t("companySettings.orgChart.kicker")}</span><h2>{t("companySettings.orgChart.title")}</h2></div><small>{t("companySettings.orgChart.subtitle")}</small></div>
        <div className="company-chart-scroll" role="region" aria-label={t("companySettings.misc.orgChartAriaLabel")} tabIndex={0}>
          <OrgChart agents={agents} edges={edges} mainAgentId={selected.mainAgentId} models={models} workingAgentIds={workingAgentIds} onSelect={openAgentEditor} />
        </div>
        {agentCursor && (
          <button
            className="button-secondary company-load-more"
            disabled={agentsPageLoading}
            onClick={() => void loadOrganization(selected.id, agentCursor, true)}
          >
            {agentsPageLoading ? t("companySettings.orgChart.loadingAgents") : t("companySettings.orgChart.loadMore")}
          </button>
        )}
      </section>

      <section className="company-run-card company-knowledge-card">
        <div className="company-section-heading">
          <div>
            <span>{t("companySettings.knowledge.kicker")}</span>
            <h2>{t("companySettings.knowledge.title")}</h2>
          </div>
          <small>{t("companySettings.knowledge.subtitle")}</small>
        </div>

        {/* Sub-block 1: Document Knowledge */}
        <div className="company-knowledge-block">
          <div className="company-knowledge-subhead">
            <div className="company-subhead-title">
              <span className="company-subhead-icon" aria-hidden="true">📁</span>
              <h3>{t("companySettings.knowledge.documentsTitle")}</h3>
              <small className="tab-count">{documents.length}</small>
            </div>

            <label className="button-secondary company-upload-label">
              <input
                hidden
                type="file"
                multiple
                disabled={knowledgeBusy}
                accept=".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.xml"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) void uploadKnowledge(files);
                  e.currentTarget.value = "";
                }}
              />
              <span className="upload-icon" aria-hidden="true">↑</span>
              <span>{t(knowledgeBusy ? "companySettings.knowledge.uploading" : "companySettings.knowledge.uploadDoc")}</span>
            </label>
          </div>

          {documents.some((document) => document.status === "ready") && selected.mainAgentId && !agents.find((agent) => agent.id === selected.mainAgentId)?.tools.some((tool) => tool === "Knowledge" || tool === "storage.agent_knowledge_retrieval" || tool.toLowerCase() === "knowledge") && (
            <div className="company-knowledge-permission-alert" role="alert">
              <div>
                <strong>{t("companySettings.knowledge.mainAgentCannotSearch")}</strong>
                <small>{t("companySettings.knowledge.enableKnowledgeDesc")}</small>
              </div>
              <button type="button" disabled={knowledgeBusy} onClick={() => void enableMainAgentKnowledge()}>
                {knowledgeBusy ? t("companySettings.knowledge.enabling") : t("companySettings.knowledge.enableKnowledge")}
              </button>
            </div>
          )}

          <div className="company-knowledge-list">
            {documents.map((doc) => (
              <div key={doc.id} className="company-doc-item">
                <div className="company-doc-item-left">
                  <span className="company-doc-icon">📄</span>
                  <div className="company-doc-details">
                    <strong title={doc.filename}>{doc.filename||t("companySettings.knowledge.companyDocument")}</strong>
                    <div className="company-doc-meta">
                      <span className={`connection-status-pill status-${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`}>
                        <span className={`status-indicator-dot ${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`} />
                        {translatedStatus(t, doc.status)}
                      </span>
                      <span className="company-chunk-badge">{t("companySettings.knowledge.chunks", { count: String(doc.chunkCount) })}</span>
                      {typeof doc.sizeBytes==="number"&&<span className="company-doc-size">{doc.sizeBytes<1024*1024?`${Math.max(1,Math.round(doc.sizeBytes/1024))} KB`:`${(doc.sizeBytes/1024/1024).toFixed(1)} MB`}</span>}
                    </div>
                  </div>
                </div>
                {doc.errorMessage && <small className="company-doc-error">{doc.errorMessage}</small>}
                <div className="company-doc-actions">
                  <button type="button" className="company-doc-link" disabled={knowledgeActionId===doc.id} onClick={()=>void downloadKnowledge(doc)}>{t("companySettings.knowledge.download")}</button>
                  {doc.status === "failed" && (
                    <button
                      type="button"
                      className="button-secondary company-doc-btn"
                      disabled={knowledgeActionId===doc.id}
                      onClick={() => void reprocessKnowledge(doc.id)}
                    >
                      {t("companySettings.knowledge.retry")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="content-action-btn delete-btn company-doc-btn"
                    disabled={knowledgeActionId===doc.id}
                    onClick={() => void deleteKnowledge(doc.id)}
                  >
                    {t("companySettings.knowledge.delete")}
                  </button>
                </div>
              </div>
            ))}

            {!documents.length && (
              <div className="company-empty-docs-box">
                <span className="company-empty-icon" aria-hidden="true">📄</span>
                <strong>{t("companySettings.knowledge.noDocsTitle")}</strong>
                <p>{t("companySettings.knowledge.noDocsDesc")}</p>
              </div>
            )}
          </div>
        </div>

        {/* Sub-block 2: Durable Memory / Facts */}
        <div className="company-knowledge-block company-memory-block">
          <div className="company-knowledge-subhead">
            <div className="company-subhead-title">
              <span className="company-subhead-icon" aria-hidden="true">💡</span>
              <h3>{t("companySettings.memory.durableTitle")}</h3>
              <small className="tab-count">{memories.length}</small>
            </div>
          </div>

          <div className="company-memory-editor-row">
            <textarea
              rows={2}
              placeholder={t("companySettings.memory.addPlaceholder")}
              value={memoryText}
              onChange={(e) => setMemoryText(e.target.value)}
              disabled={memoryBusy}
              className="company-memory-textarea"
            />
            <button
              type="button"
              className="button-primary automations-action-primary company-add-memory-btn"
              onClick={() => void addCompanyMemory()}
              disabled={!memoryText.trim()||memoryBusy}
            >
              {memoryBusy?t("companySettings.memory.saving"):t("companySettings.memory.addMemory")}
            </button>
          </div>

          {memories.length > 0 && (
            <ul className="company-memory-list">
              {memories.map((memory) => (
                <li key={memory.id} className="company-memory-item">
                  {editingMemoryId===memory.id?<textarea rows={2} className="company-memory-textarea" value={editingMemoryText} disabled={memoryBusy} onChange={(event)=>setEditingMemoryText(event.target.value)}/>:<div className="company-memory-item-content"><span className="memory-bullet" aria-hidden="true">📌</span><p>{memory.content}</p></div>}
                  <div className="company-memory-actions">
                    {editingMemoryId===memory.id?<><button type="button" className="button-primary company-memory-edit-btn" disabled={!editingMemoryText.trim()||memoryBusy} onClick={()=>void updateCompanyMemory()}>{t("companySettings.memory.save")}</button><button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>{setEditingMemoryId("");setEditingMemoryText("");}}>{t("companySettings.memory.cancel")}</button></>:<button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>startEditingMemory(memory)}>{t("companySettings.memory.edit")}</button>}
                    <button type="button" className="content-action-btn delete-btn company-memory-delete-btn" disabled={memoryBusy} onClick={() => void deleteCompanyMemory(memory.id)} title={t("companySettings.memory.deleteFact")}>{t("companySettings.memory.delete")}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    <ProjectSection companyId={selected.id} />
    </>}

    {companyEditor && <div className="company-drawer-backdrop" onMouseDown={() => setCompanyEditor(false)}>
      <aside className="company-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>{t("companySettings.companyDrawer.company")}</span><h2>{editingCompany ? t("companySettings.companyDrawer.companySettings") : t("companySettings.companyDrawer.newCompany")}</h2></div>
          <button type="button" className="company-drawer-close" aria-label={t("companySettings.misc.closeDrawer")} onClick={() => setCompanyEditor(false)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveCompany}>
          <section><h3>{t("companySettings.companyDrawer.companyContext")}</h3>
            <label><span>{t("companySettings.companyDrawer.companyName")}</span><input required value={companyForm.name} onChange={(event) => setCompanyForm({ ...companyForm, name: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.linkedBusiness")}</span><select value={companyForm.businessId} onChange={(event) => setCompanyForm({ ...companyForm, businessId: event.target.value })}>
              <option value="">{t("companySettings.companyDrawer.independent")}</option>{overview?.businesses.map((business) => <option value={business.id} key={business.id}>{business.name}</option>)}
            </select></label>
            <div className="company-form-grid"><label><span>{t("companySettings.companyDrawer.website")}</span><input value={companyForm.website} onChange={(event) => setCompanyForm({ ...companyForm, website: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.industry")}</span><input value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} /></label></div>
            <label><span>{t("companySettings.companyDrawer.description")}</span><textarea value={companyForm.description} onChange={(event) => setCompanyForm({ ...companyForm, description: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.productsServices")}</span><textarea value={companyForm.productsServices} onChange={(event) => setCompanyForm({ ...companyForm, productsServices: event.target.value })} /></label>
            <div className="company-form-grid"><label><span>{t("companySettings.companyDrawer.languages")}</span><input placeholder={t("companySettings.companyDrawer.languagesPlaceholder")} value={companyForm.languages} onChange={(event) => setCompanyForm({ ...companyForm, languages: event.target.value })} /></label>
            <label><span>{t("companySettings.companyDrawer.brandTone")}</span><input value={companyForm.brandTone} onChange={(event) => setCompanyForm({ ...companyForm, brandTone: event.target.value })} /></label></div>
            <label><span>{t("companySettings.companyDrawer.companyInstructions")}</span><textarea rows={5} value={companyForm.companyInstructions} onChange={(event) => setCompanyForm({ ...companyForm, companyInstructions: event.target.value })} /></label>
          </section>
          <footer>{editingCompany && <button type="button" className="danger-button" onClick={() => void deleteCompany()}>{t("companySettings.companyDrawer.deleteCompany")}</button>}<span /><button type="button" className="button-secondary" onClick={() => setCompanyEditor(false)}>{t("companySettings.companyDrawer.cancel")}</button><button className="button-primary" disabled={saving}>{saving ? t("companySettings.companyDrawer.saving") : t("companySettings.companyDrawer.save")}</button></footer>
        </form>
      </aside>
    </div>}

    {agentEditor && selected && <div className="company-drawer-backdrop" onMouseDown={() => setAgentEditor(false)}>
      <aside className="company-drawer agent-editor" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>{t("companySettings.agentDrawer.aiAgent")}</span><h2>{editingAgent ? editingAgent.name : t("companySettings.agentDrawer.addAgent")}</h2></div>
          <button type="button" className="company-drawer-close" aria-label={t("companySettings.misc.closeDrawer")} onClick={() => setAgentEditor(false)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveAgent}>
          <section><h3>{t("companySettings.agentDrawer.general")}</h3>
            <div className="company-form-grid"><label><span>{t("companySettings.agentDrawer.name")}</span><input required value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} /></label>
            <label><span>{t("companySettings.agentDrawer.role")}</span><input required placeholder={t("companySettings.agentDrawer.rolePlaceholder")} value={agentForm.role} onChange={(event) => setAgentForm({ ...agentForm, role: event.target.value })} /></label></div>
            <label><span>{t("companySettings.agentDrawer.description")}</span><textarea value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} /></label>
          </section>
          <section><h3>{t("companySettings.agentDrawer.ai")}</h3>
            <div className="company-form-grid"><label><span>{t("companySettings.agentDrawer.model")}</span><select value={agentForm.modelId} onChange={(event) => setAgentForm({ ...agentForm, modelId: event.target.value })}>
              <option value="">{t("companySettings.agentDrawer.autoNpati")}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label>
            <label><span>{t("companySettings.agentDrawer.fallbackModel")}</span><select value={agentForm.fallbackModelId} onChange={(event) => setAgentForm({ ...agentForm, fallbackModelId: event.target.value })}>
              <option value="">{t("companySettings.agentDrawer.autoNpati")}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label></div>
            {modelsLoading && <small className="company-field-hint">{t("companySettings.agentDrawer.loadingModels")}</small>}
            {!modelsLoading && modelsError && <small className="company-field-hint">{t("companySettings.agentDrawer.couldNotLoadModels")} {modelsError}</small>}
            {!modelsLoading && !modelsError && models.length === 0 && <small className="company-field-hint">{t("companySettings.agentDrawer.noModelsHint")}</small>}
          </section>
          <section><h3>{t("companySettings.agentDrawer.instructions")}</h3>
            <label><span>{t("companySettings.agentDrawer.systemInstruction")}</span><textarea rows={5} value={agentForm.systemInstruction} onChange={(event) => setAgentForm({ ...agentForm, systemInstruction: event.target.value })} /></label>
            <label><span>{t("companySettings.agentDrawer.promptGuidelines")}</span><textarea rows={4} value={agentForm.promptGuidelines} onChange={(event) => setAgentForm({ ...agentForm, promptGuidelines: event.target.value })} /></label>
            <label><span>{t("companySettings.agentDrawer.recommendedPrompts")}</span><textarea rows={4} placeholder={t("companySettings.agentDrawer.onePerLine")} value={agentForm.recommendedPrompts} onChange={(event) => setAgentForm({ ...agentForm, recommendedPrompts: event.target.value })} /></label>
          </section>
          <section>
            <h3>{t("companySettings.agentDrawer.toolsCapabilities")}</h3>
            <small className="company-field-hint">{t("companySettings.agentDrawer.toolsHint")}</small>
            <div className="company-tool-grid">
              {([{
                label: language === "uk" ? "Читання файлів" : "Project Read",
                ids: ["project.files.list", "project.files.read", "project.files.search"],
              }, {
                label: language === "uk" ? "Запис файлів" : "Project Write",
                ids: ["project.files.create", "project.files.write", "project.files.edit", "project.files.move", "project.files.delete"],
              }, {
                label: language === "uk" ? "Термінал" : "Terminal",
                ids: ["project.terminal.exec", "project.terminal.process"],
              }, {
                label: language === "uk" ? "Попередній перегляд" : "Preview",
                ids: ["project.preview.start", "project.preview.stop", "project.preview.status"],
              }, {
                label: "Git",
                ids: ["project.git.status", "project.git.diff", "project.git.log", "project.git.branch", "project.git.stage", "project.git.commit", "project.git.restore", "project.git.checkpoint", "project.git.restore_checkpoint", "project.git.push", "project.git.pr"],
              }, {
                label: language === "uk" ? "Деплой" : "Deploy",
                ids: ["project.deploy.publish", "project.deploy.status"],
              }, {
                label: language === "uk" ? "Browser QA" : "Browser QA",
                ids: ["project.qa.inspect", "project.qa.report"],
              }]).map((permission) => <label className="company-tool" key={permission.label}>
                <input type="checkbox" checked={permission.ids.every((id) => agentForm.tools.includes(id))} onChange={(event) => setAgentForm({
                  ...agentForm,
                  tools: event.target.checked
                    ? [...new Set([...agentForm.tools, ...permission.ids])]
                    : agentForm.tools.filter((id) => !permission.ids.includes(id)),
                })} />
                <span><strong>{permission.label}</strong></span>
              </label>)}
              {availableTools.filter((tool) => !tool.id.startsWith("project.files.") && !tool.id.startsWith("project.terminal.") && !tool.id.startsWith("project.preview.") && !tool.id.startsWith("project.git.") && !tool.id.startsWith("project.deploy.") && !tool.id.startsWith("project.qa.")).map((tool) => {
                const translated = translatedTool(t, tool);
                const isChecked = agentForm.tools.includes(tool.name) || agentForm.tools.includes(tool.id);
                return (
                  <label className="company-tool" key={tool.id} title={translated.description || translated.name}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(event) => {
                        const val = tool.id;
                        setAgentForm({
                          ...agentForm,
                          tools: event.target.checked
                            ? [...agentForm.tools.filter((item) => item !== tool.name && item !== tool.id), val]
                            : agentForm.tools.filter((item) => item !== tool.name && item !== tool.id),
                        });
                      }}
                    />
                    <span>
                      <strong>{translated.name}</strong>
                      {tool.risk && tool.risk !== "low" && <span className={`risk-badge ${tool.risk}`}>{translatedStatus(t, tool.risk)}</span>}
                      {tool.requiresConfirmation && <span className="confirm-badge">{t("companySettings.agentDrawer.approvalRequired")}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
          <section><h3>{t("companySettings.agentDrawer.organization")}</h3>
            <label><span>{t("companySettings.agentDrawer.parentAgent")}</span><select value={agentForm.parentAgentId} onChange={(event) => setAgentForm({ ...agentForm, parentAgentId: event.target.value })}>
              <option value="">{t("companySettings.agentDrawer.noParent")}</option>{agents.filter((agent) => agent.id !== editingAgent?.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}  -  {agent.role}</option>)}
            </select></label>
            <label className="company-switch"><input type="checkbox" checked={agentForm.isActive} onChange={(event) => setAgentForm({ ...agentForm, isActive: event.target.checked })} /><span>{t("companySettings.agentDrawer.agentActive")}</span></label>
            {editingAgent && <button type="button" className="button-secondary" onClick={() => void setMainAgent(editingAgent.id)}>{t("companySettings.agentDrawer.setMainAgent")}</button>}
          </section>
          <footer>{editingAgent && <button type="button" className="danger-button" onClick={() => void deleteAgent()}>{t("companySettings.agentDrawer.deleteAgent")}</button>}<span /><button type="button" className="button-secondary" onClick={() => setAgentEditor(false)}>{t("companySettings.agentDrawer.cancel")}</button><button className="button-primary" disabled={saving}>{saving ? t("companySettings.agentDrawer.saving") : t("companySettings.agentDrawer.save")}</button></footer>
        </form>
      </aside>
    </div>}
  </main>;
}
