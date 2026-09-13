import { getStoredAuthToken } from "./AuthContext";
import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Model } from "./ai-marketplace-types";
import { useWorkspace } from "./BusinessWorkspace";

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
  { id: "web.crawl", name: "Crawler", description: "Crawl multiple pages from a website.", domain: "research", risk: "medium", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "mcp", name: "MCP", description: "Use approved MCP tools.", domain: "system", risk: "medium", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "files", name: "Files", description: "List and read Company files.", domain: "files", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "system.text-to-speech", name: "Text-to-Speech", description: "Generate speech audio with the selected voice.", domain: "system", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] },
  { id: "exec", name: "Code Mode / Exec", description: "Validate and run approved JavaScript in an isolated sandbox without host or network access.", domain: "security", risk: "critical", requiresConfirmation: true, requiredPermissions: ["business:manage"], requiredConnections: [] },
];
const emptyCompany: CompanyDraft = { name: "", businessId: "", website: "", industry: "", description: "", productsServices: "", languages: "", brandTone: "", companyInstructions: "", status: "active" };
const emptyAgent: AgentDraft = { name: "", role: "", description: "", systemInstruction: "", promptGuidelines: "", recommendedPrompts: "", modelId: "", fallbackModelId: "", tools: [], isActive: true, parentAgentId: "" };

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
  return <span className={`company-agent-model-icon ${agent.modelId ? "provider" : "npati-auto"}`} title={`${agent.modelId ? `${model?.name ?? agent.modelId} via ${providerName}` : "NPATI Auto"} · ${working ? "Working" : "Idle"}`}>
    <img src={source} alt="" onError={(event) => {
      if (useProviderIcon) setProviderIconFailed(true);
      else event.currentTarget.style.visibility = "hidden";
    }} />
    <span className={`company-agent-activity-dot ${working ? "working" : "idle"}`} aria-label={working ? "Agent is working" : "Agent is idle"} />
  </span>;
}

function AgentNode({ agent, main, model, working, onClick }: { agent: Agent; main: boolean; model?: Model; working: boolean; onClick(): void }) {
  return <button className={`company-agent-node ${main ? "main" : ""} ${agent.isActive ? "" : "inactive"} ${working ? "working" : ""}`} onClick={onClick}>
    <AgentModelIcon agent={agent} model={model} working={working} />
    <span><strong>{agent.name}</strong><small>{agent.role}</small><em>{agent.modelId || "Auto"}</em></span>
    {main && <b>Main</b>}
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

  if (!agents.length) return <div className="company-chart-empty"><strong>Your AI company has no agents yet.</strong><p>Add the first agent, then build the hierarchy with Parent Agent.</p></div>;
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
  const { overview } = useWorkspace();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [companiesLoadError, setCompaniesLoadError] = useState("");
  const [selectedId, setSelectedId] = useState("");
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
    setCompanies(list);
    const nextId = preferredId && list.some((item) => item.id === preferredId) ? preferredId : (list[0]?.id ?? "");
    setSelectedId(nextId);
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
      const message = error instanceof Error ? error.message : "Could not load connected models";
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

  async function initializeCompanies() {
    setCompaniesLoading(true);
    setCompaniesLoadError("");
    try {
      const items = await loadCompanies();
      const first = items[0];
      if (first) await loadOrganization(first.id, undefined, false, items);
    } catch (error) {
      setCompaniesLoadError(error instanceof Error ? error.message : "Could not load companies");
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
    if (!runDetails || !selectedId || ["completed", "failed", "cancelled"].includes(runDetails.run.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api<RunDetails>(`/companies/${selectedId}/runs/${runDetails.run.id}`).then((details) => {
        if (!active) return;
        setRunDetails(details);
        const terminal = ["completed", "failed", "cancelled"].includes(details.run.status);
        setRunning(!terminal);
        if (terminal) setNotice(details.run.status === "completed" ? "Company run completed." : details.run.errorMessage ?? `Company run ${details.run.status}.`);
      }).catch((error) => {
        if (!active) return;
        setNotice(error instanceof Error ? error.message : "Could not refresh run status");
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
      setCompanyEditor(false); setEditingCompany(undefined); await loadCompanies(saved.id); setNotice("Company saved.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not save company";
      if (/changed by another request|revision|conflict/i.test(msg)) {
        setNotice("Revision conflict detected: Another tab or user modified this company. Please reload.");
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
      const payload = { ...draft, modelId: draft.modelId || undefined, fallbackModelId: draft.fallbackModelId || undefined,
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
      setAgentEditor(false); setEditingAgent(undefined); await loadOrganization(selected.id); setNotice("Agent saved.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not save agent";
      if (/changed by another request|revision|conflict/i.test(msg)) {
        setNotice("Revision conflict detected: Another tab or user modified this agent. Please reload.");
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
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not set main agent"); }
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
      setNotice(`Knowledge enabled for Main Agent "${mainAgent.name}".`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not enable Knowledge for the Main Agent");
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
      setNotice("Linked business updated.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not update linked business"); }
  }

  async function deleteAgent() {
    if (!selected || !editingAgent || !window.confirm(`Delete agent "${editingAgent.name}"?`)) return;
    try {
      const deletingId = editingAgent.id;
      await api(`/companies/${selected.id}/agents/${deletingId}?expectedRevision=${editingAgent.revision}`, { method: "DELETE" });
      setAgentEditor(false); setEditingAgent(undefined);
      setAgents((items) => items.filter((agent) => agent.id !== deletingId));
      setEdges((items) => items.filter((edge) => edge.parentAgentId !== deletingId && edge.childAgentId !== deletingId));
      const refreshedCompanies = await loadCompanies(selected.id);
      await loadOrganization(selected.id, undefined, false, refreshedCompanies);
      setNotice("Agent deleted.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not delete agent"); }
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
      if (result.run.status === "completed") setNotice("Company run completed.");
      else setNotice(result.run.errorMessage ?? `Company run ${result.run.status}.`);
      const remainsActive = !["completed", "failed", "cancelled"].includes(result.run.status);
      setRunning(remainsActive);
      if (!remainsActive) setWorkingAgentIds(new Set());
    } catch (error) { setRunning(false); setWorkingAgentIds(new Set()); setNotice(error instanceof Error ? error.message : "Company run failed"); }
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
        setRunDetails((current) => current ? { ...current, run: { ...current.run, errorCode: "APPROVAL_REJECTED", errorMessage: "Execution rejected by the user." } } : current);
        setNotice("Execution rejected. Nothing was run.");
        return;
      }
      setRunning(true);
      const resumed = await api<RunDetails>(`/companies/${selected.id}/runs/${runDetails.run.id}/resume`, {
        method: "POST", body: JSON.stringify({ approvalId: pendingApprovalId }),
      });
      setRunDetails(resumed);
      const remainsActive = !["completed", "failed", "cancelled"].includes(resumed.run.status);
      setRunning(remainsActive);
      setNotice(resumed.run.status === "completed" ? "Approved execution completed." : resumed.run.errorMessage ?? `Company run ${resumed.run.status}.`);
    } catch (error) {
      setRunning(false);
      setNotice(error instanceof Error ? error.message : "Could not apply approval decision");
    } finally { setApprovalBusy(false); }
  }

  async function readFileAsBase64(file:File){
    return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error??new Error("Could not read the document"));reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.readAsDataURL(file);});
  }
  async function uploadKnowledge(files:File[]){
    if(!selected||!files.length)return;
    const companyId=selected.id;
    setKnowledgeBusy(true);setNotice("");
    let uploaded=0;
    const failures:string[]=[];
    for(const file of files){
      try{
        if(file.size===0)throw new Error("The file is empty");
        if(file.size>25*1024*1024)throw new Error("The 25 MB limit was exceeded");
        const data=await readFileAsBase64(file);
        const document=await api<KnowledgeDocument>(`/companies/${companyId}/knowledge/documents`,{method:"POST",headers:{"idempotency-key":crypto.randomUUID()},body:JSON.stringify({filename:file.name,mimeType:file.type||"application/octet-stream",data})});
        setDocuments(items=>[document,...items.filter(item=>item.id!==document.id)]);
        uploaded++;
      }catch(error){failures.push(`${file.name}: ${error instanceof Error?error.message:"upload failed"}`);}
    }
    try{const value=await api<{documents:KnowledgeDocument[]}>(`/companies/${companyId}/knowledge/documents`);setDocuments(value.documents??[]);}catch{}
    setKnowledgeBusy(false);
    setNotice(failures.length?`${uploaded} document(s) uploaded. ${failures.join("; ")}`:`${uploaded} document(s) uploaded and queued for processing.`);
  }
  async function addCompanyMemory(){
    const content=memoryText.trim();if(!selected||!content||memoryBusy)return;
    setMemoryBusy(true);setNotice("");
    try{const created=await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory`,{method:"POST",body:JSON.stringify({content})});setMemoryText("");setMemories(items=>[created,...items.filter(item=>item.id!==created.id)]);setNotice("Company memory added.");}
    catch(error){setNotice(error instanceof Error?error.message:"Memory save failed");}finally{setMemoryBusy(false);}
  }
  function startEditingMemory(memory:CompanyMemory){setEditingMemoryId(memory.id);setEditingMemoryText(memory.content);}
  async function updateCompanyMemory(){
    const content=editingMemoryText.trim();if(!selected||!editingMemoryId||!content||memoryBusy)return;
    setMemoryBusy(true);setNotice("");
    try{const updated=await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory/${editingMemoryId}`,{method:"PUT",body:JSON.stringify({content})});setMemories(items=>items.map(item=>item.id===updated.id?updated:item));setEditingMemoryId("");setEditingMemoryText("");setNotice("Company memory updated.");}
    catch(error){setNotice(error instanceof Error?error.message:"Memory update failed");}finally{setMemoryBusy(false);}
  }
  async function deleteKnowledge(id:string){
    if(!selected||knowledgeActionId||!window.confirm("Delete this document?"))return;setKnowledgeActionId(id);setNotice("");
    try{await api(`/companies/${selected.id}/knowledge/documents/${id}`,{method:"DELETE"});setDocuments(items=>items.filter(item=>item.id!==id));setNotice("Document deleted.");}
    catch(error){setNotice(error instanceof Error?error.message:"Document delete failed");}finally{setKnowledgeActionId("");}
  }
  async function downloadKnowledge(doc:KnowledgeDocument){
    if(!selected||knowledgeActionId)return;setKnowledgeActionId(doc.id);setNotice("");
    try{const headers=new Headers();const token=getStoredAuthToken();if(token)headers.set("authorization",`Bearer ${token}`);const response=await fetch(`/api/companies/${selected.id}/knowledge/documents/${doc.id}/content`,{headers});if(!response.ok){const body=await response.json().catch(()=>null) as {error?:{message?:string}}|null;throw new Error(body?.error?.message??`Download failed (${response.status})`);}const url=URL.createObjectURL(await response.blob());const link=document.createElement("a");link.href=url;link.download=doc.filename||"company-document";document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);}
    catch(error){setNotice(error instanceof Error?error.message:"Document download failed");}finally{setKnowledgeActionId("");}
  }
  async function reprocessKnowledge(id:string){
    if(!selected||knowledgeActionId)return;setKnowledgeActionId(id);setNotice("");
    try{const document=await api<KnowledgeDocument>(`/companies/${selected.id}/knowledge/documents/${id}/reprocess`,{method:"POST"});setDocuments(items=>items.map(item=>item.id===id?document:item));setNotice("Document queued for reprocessing.");}
    catch(error){setNotice(error instanceof Error?error.message:"Document retry failed");}finally{setKnowledgeActionId("");}
  }
  async function deleteCompanyMemory(id:string){
    if(!selected||memoryBusy||!window.confirm("Delete this Company memory?"))return;setMemoryBusy(true);setNotice("");
    try{await api(`/companies/${selected.id}/knowledge/memory/${id}`,{method:"DELETE"});setMemories(items=>items.filter(item=>item.id!==id));if(editingMemoryId===id){setEditingMemoryId("");setEditingMemoryText("");}setNotice("Company memory deleted.");}
    catch(error){setNotice(error instanceof Error?error.message:"Memory delete failed");}finally{setMemoryBusy(false);}
  }

  async function deleteCompany() {
    if (!selected || !window.confirm(`Delete company "${selected.name}" and all its agents?`)) return;
    try {
      await api(`/companies/${selected.id}`, { method: "DELETE" });
      setCompanyEditor(false); setEditingCompany(undefined); await loadCompanies();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not delete company"); }
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
    <strong>Could not load your AI Company</strong>
    <p>{companiesLoadError}</p>
    <button className="button-primary" type="button" onClick={() => void initializeCompanies()}>Try Again</button>
  </main>;

  return <main className="company-page company-refined">
    <header className="company-page-header">
      <div>
        <p className="eyebrow">Settings · AI Company</p>
        <div className="company-title-row">
          <Link
            to="/settings"
            className="marketplace-back-button"
            aria-label="Back to settings"
            title="Back to settings"
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
            title={selected ? selected.name : "Build your AI company"}
          >
            {selected ? selected.name : "Build your AI company"}
          </h1>
          {selected && <span className={`company-status ${selected.status}`}>{selected.status}</span>}

          {selected && (
            <div className="company-title-actions">
              <button
                type="button"
                className="content-action-btn edit-btn"
                onClick={() => openCompanyEditor(selected)}
                title="Edit company name, instructions and linked business"
              >
                ✎ Edit Company
              </button>
              <button
                type="button"
                className="content-action-btn delete-btn"
                onClick={() => void deleteCompany()}
                title="Delete this company"
              >
                🗑 Delete
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
          + New Company
        </button>
        {selected && (
          <button className="button-primary automations-action-primary" onClick={() => openAgentEditor()}>
            + Add Agent
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
          <strong>{noticeIsSuccess ? "Update completed" : "System Alert"}</strong>
          <span>{notice}</span>
        </div>
        <button
          type="button"
          className="company-notice-close"
          onClick={() => setNotice("")}
          aria-label="Dismiss notice"
        >
          ×
        </button>
      </div>
    )}

    {!selected ? <section className="company-first-run">
      <span className="provider-avatar">CO</span><h2>Create your first Company</h2>
      <p>Company is separate from Business and contains its own agents, instructions, models, tools and organization scheme.</p>
      <button className="button-primary" onClick={() => openCompanyEditor()}>Create Company</button>
    </section> : <>
      <section className="company-control-strip">
        {/* Block 1: Обираємо компанію */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">Company</span>
            <span className="company-strip-badge badge-active">Active</span>
          </div>
          <div className="company-strip-control-row">
            <select
              aria-label="Select company"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
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
            title={`Main Orchestrator: ${agents.find((a) => a.id === selected.mainAgentId)?.name ?? "Add Agent"}`}
          >
            Main Orchestrator: {agents.find((a) => a.id === selected.mainAgentId)?.name ?? "Add Agent"}
          </span>
        </div>

        {/* Block 2: Обираємо бізнес який є створений і підходить */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">Linked Business</span>
            <span className="company-strip-badge badge-linked">Linked</span>
          </div>
          <div className="company-strip-control-row">
            <select
              aria-label="Select linked business"
              value={selected.businessId ?? ""}
              onChange={(event) => void updateCompanyBusiness(event.target.value)}
              className="company-strip-select"
            >
              <option value="">Independent (No business linked)</option>
              {overview?.businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </select>
          </div>
          <span
            className="company-strip-footer-text"
            title="Workspace business context connected"
          >
            Workspace business context connected
          </span>
        </div>

        {/* Block 3: Кількість агентів */}
        <div className="company-strip-card">
          <div className="company-strip-eyebrow">
            <span className="company-strip-label">Total Agents</span>
            <span className="company-strip-badge badge-hierarchy">Hierarchy</span>
          </div>
          <div className="company-strip-control-row">
            <strong>{agents.length} Agents</strong>
          </div>
          <span className="company-strip-footer-text" title="Ready for delegated company tasks">
            Ready for delegated company tasks
          </span>
        </div>
      </section>

      <section className="company-run-card">
        <div className="company-section-heading">
          <div>
            <span>Runtime</span>
            <h2>Delegate a task</h2>
          </div>
          <small>Main Agent plans through A2A; execution uses NPATI Auto, Pipeline or Fusion.</small>
        </div>

        <form onSubmit={runCompany} className="company-run-form">
          <textarea
            required
            rows={3}
            maxLength={20000}
            placeholder="Give your AI company a task (e.g. Audit competitor offerings, synthesize buyer ICP, and generate marketing blueprints)..."
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="company-run-textarea"
          />

          <div className="company-run-actions-bar">
            <div className="company-run-mode-field">
              <label htmlFor="company-run-mode" className="company-mode-label">
                Execution Mode:
              </label>
              <select
                id="company-run-mode"
                aria-label="Execution mode"
                value={runMode}
                onChange={(event) => setRunMode(event.target.value as typeof runMode)}
                className="company-mode-select"
              >
                <option value="auto">Auto by Main Agent</option>
                <option value="single">Single Agent</option>
                <option value="pipeline">Sequential Pipeline</option>
                <option value="fusion">Fusion (Multi-agent Consensus)</option>
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
                  <span>Running Company...</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>Run Company</span>
                </>
              )}
            </button>
          </div>
        </form>

        {!selected.mainAgentId && (
          <div className="company-field-notice-box">
            <span className="company-notice-bulb" aria-hidden="true">ℹ</span>
            <span>Select a <strong>Main Agent</strong> in the control strip above before running the company.</span>
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
              Run status: <strong>{runDetails.run.status}</strong>
              {runDetails.run.errorMessage ? ` — ${runDetails.run.errorMessage}` : ""}
            </span>
          </div>
        )}

        {pendingApprovalId && (
          <div className="company-field-notice-box company-approval-box">
            <span className="company-notice-bulb" aria-hidden="true">!</span>
            <span>
              <strong>Human approval required.</strong> Review the requested Code Mode / Exec action before it runs.
              <code className="company-approval-preview">{JSON.stringify([...(runDetails?.toolAudit ?? [])].reverse().find((item) => item.reasonCode === "approval_required")?.inputSummary ?? {})}</code>
            </span>
            <div className="company-approval-actions">
              <button type="button" className="button-secondary" disabled={approvalBusy} onClick={() => void decideRunApproval("rejected")}>Reject</button>
              <button type="button" className="button-primary" disabled={approvalBusy} onClick={() => void decideRunApproval("approved")}>{approvalBusy ? "Applying..." : "Approve & continue"}</button>
            </div>
          </div>
        )}

        {runDetails?.run.result && (
          <div className="company-run-result">
            <div className="company-run-result-header">
              <div className="company-result-title-group">
                <span className="company-result-badge">Result</span>
                <strong>Final response</strong>
              </div>
              <small className="company-result-meta">
                {runDetails.run.executionMode} · {runDetails.run.status}
              </small>
            </div>
            <div className="company-result-body">
              <p>{runDetails.run.result}</p>
            </div>
          </div>
        )}
      </section>

      <section className="company-chart-card">
        <div className="company-section-heading"><div><span>Organization</span><h2>AI Agent Org Chart</h2></div><small>Only 60 agents are loaded per page. Click an agent to edit it.</small></div>
        <div className="company-chart-scroll" role="region" aria-label="Agent organization chart" tabIndex={0}>
          <OrgChart agents={agents} edges={edges} mainAgentId={selected.mainAgentId} models={models} workingAgentIds={workingAgentIds} onSelect={openAgentEditor} />
        </div>
        {agentCursor && (
          <button
            className="button-secondary company-load-more"
            disabled={agentsPageLoading}
            onClick={() => void loadOrganization(selected.id, agentCursor, true)}
          >
            {agentsPageLoading ? "Loading agents…" : "Load more agents"}
          </button>
        )}
      </section>

      <section className="company-run-card company-knowledge-card">
        <div className="company-section-heading">
          <div>
            <span>Context</span>
            <h2>Company Knowledge</h2>
          </div>
          <small>Private MinIO documents, NPATI embeddings and rerank.</small>
        </div>

        {/* Sub-block 1: Document Knowledge */}
        <div className="company-knowledge-block">
          <div className="company-knowledge-subhead">
            <div className="company-subhead-title">
              <span className="company-subhead-icon" aria-hidden="true">📁</span>
              <h3>Knowledge Documents</h3>
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
              <span>{knowledgeBusy ? "Uploading..." : "Upload Document"}</span>
            </label>
          </div>

          {documents.some((document) => document.status === "ready") && selected.mainAgentId && !agents.find((agent) => agent.id === selected.mainAgentId)?.tools.some((tool) => tool === "Knowledge" || tool === "storage.agent_knowledge_retrieval" || tool.toLowerCase() === "knowledge") && (
            <div className="company-knowledge-permission-alert" role="alert">
              <div>
                <strong>Main Agent cannot search these documents yet</strong>
                <small>Enable the Knowledge capability to use ready files from Company chat.</small>
              </div>
              <button type="button" disabled={knowledgeBusy} onClick={() => void enableMainAgentKnowledge()}>
                {knowledgeBusy ? "Enabling…" : "Enable Knowledge for Main Agent"}
              </button>
            </div>
          )}

          <div className="company-knowledge-list">
            {documents.map((doc) => (
              <div key={doc.id} className="company-doc-item">
                <div className="company-doc-item-left">
                  <span className="company-doc-icon">📄</span>
                  <div className="company-doc-details">
                    <strong title={doc.filename}>{doc.filename||"Company document"}</strong>
                    <div className="company-doc-meta">
                      <span className={`connection-status-pill status-${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`}>
                        <span className={`status-indicator-dot ${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`} />
                        {doc.status}
                      </span>
                      <span className="company-chunk-badge">{doc.chunkCount} chunks</span>
                      {typeof doc.sizeBytes==="number"&&<span className="company-doc-size">{doc.sizeBytes<1024*1024?`${Math.max(1,Math.round(doc.sizeBytes/1024))} KB`:`${(doc.sizeBytes/1024/1024).toFixed(1)} MB`}</span>}
                    </div>
                  </div>
                </div>
                {doc.errorMessage && <small className="company-doc-error">{doc.errorMessage}</small>}
                <div className="company-doc-actions">
                  <button type="button" className="company-doc-link" disabled={knowledgeActionId===doc.id} onClick={()=>void downloadKnowledge(doc)}>Download</button>
                  {doc.status === "failed" && (
                    <button
                      type="button"
                      className="button-secondary company-doc-btn"
                      disabled={knowledgeActionId===doc.id}
                      onClick={() => void reprocessKnowledge(doc.id)}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="content-action-btn delete-btn company-doc-btn"
                    disabled={knowledgeActionId===doc.id}
                    onClick={() => void deleteKnowledge(doc.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}

            {!documents.length && (
              <div className="company-empty-docs-box">
                <span className="company-empty-icon" aria-hidden="true">📄</span>
                <strong>No Company documents yet</strong>
                <p>Upload PDF, DOCX, XLSX, TXT, MD, CSV, TSV, JSON, or XML files (up to 25 MB each).</p>
              </div>
            )}
          </div>
        </div>

        {/* Sub-block 2: Durable Memory / Facts */}
        <div className="company-knowledge-block company-memory-block">
          <div className="company-knowledge-subhead">
            <div className="company-subhead-title">
              <span className="company-subhead-icon" aria-hidden="true">💡</span>
              <h3>Durable Company Memory</h3>
              <small className="tab-count">{memories.length}</small>
            </div>
          </div>

          <div className="company-memory-editor-row">
            <textarea
              rows={2}
              placeholder="Add an important Company fact or rule (e.g. Refund terms, brand boundary, operating guidelines)..."
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
              {memoryBusy?"Saving...":"+ Add Memory"}
            </button>
          </div>

          {memories.length > 0 && (
            <ul className="company-memory-list">
              {memories.map((memory) => (
                <li key={memory.id} className="company-memory-item">
                  {editingMemoryId===memory.id?<textarea rows={2} className="company-memory-textarea" value={editingMemoryText} disabled={memoryBusy} onChange={(event)=>setEditingMemoryText(event.target.value)}/>:<div className="company-memory-item-content"><span className="memory-bullet" aria-hidden="true">📌</span><p>{memory.content}</p></div>}
                  <div className="company-memory-actions">
                    {editingMemoryId===memory.id?<><button type="button" className="button-primary company-memory-edit-btn" disabled={!editingMemoryText.trim()||memoryBusy} onClick={()=>void updateCompanyMemory()}>Save</button><button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>{setEditingMemoryId("");setEditingMemoryText("");}}>Cancel</button></>:<button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>startEditingMemory(memory)}>Edit</button>}
                    <button type="button" className="content-action-btn delete-btn company-memory-delete-btn" disabled={memoryBusy} onClick={() => void deleteCompanyMemory(memory.id)} title="Delete fact">Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>}

    {companyEditor && <div className="company-drawer-backdrop" onMouseDown={() => setCompanyEditor(false)}>
      <aside className="company-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>Company</span><h2>{editingCompany ? "Company Settings" : "New Company"}</h2></div>
          <button type="button" className="company-drawer-close" aria-label="Close" onClick={() => setCompanyEditor(false)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveCompany}>
          <section><h3>Company Context</h3>
            <label><span>Company Name</span><input required value={companyForm.name} onChange={(event) => setCompanyForm({ ...companyForm, name: event.target.value })} /></label>
            <label><span>Linked Business</span><select value={companyForm.businessId} onChange={(event) => setCompanyForm({ ...companyForm, businessId: event.target.value })}>
              <option value="">Independent company</option>{overview?.businesses.map((business) => <option value={business.id} key={business.id}>{business.name}</option>)}
            </select></label>
            <div className="company-form-grid"><label><span>Website</span><input value={companyForm.website} onChange={(event) => setCompanyForm({ ...companyForm, website: event.target.value })} /></label>
            <label><span>Industry</span><input value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} /></label></div>
            <label><span>Description</span><textarea value={companyForm.description} onChange={(event) => setCompanyForm({ ...companyForm, description: event.target.value })} /></label>
            <label><span>Products / Services</span><textarea value={companyForm.productsServices} onChange={(event) => setCompanyForm({ ...companyForm, productsServices: event.target.value })} /></label>
            <div className="company-form-grid"><label><span>Languages</span><input placeholder="Ukrainian, English" value={companyForm.languages} onChange={(event) => setCompanyForm({ ...companyForm, languages: event.target.value })} /></label>
            <label><span>Brand Tone</span><input value={companyForm.brandTone} onChange={(event) => setCompanyForm({ ...companyForm, brandTone: event.target.value })} /></label></div>
            <label><span>Company Instructions</span><textarea rows={5} value={companyForm.companyInstructions} onChange={(event) => setCompanyForm({ ...companyForm, companyInstructions: event.target.value })} /></label>
          </section>
          <footer>{editingCompany && <button type="button" className="danger-button" onClick={() => void deleteCompany()}>Delete Company</button>}<span /><button type="button" className="button-secondary" onClick={() => setCompanyEditor(false)}>Cancel</button><button className="button-primary" disabled={saving}>{saving ? "Saving…" : "Save Company"}</button></footer>
        </form>
      </aside>
    </div>}

    {agentEditor && selected && <div className="company-drawer-backdrop" onMouseDown={() => setAgentEditor(false)}>
      <aside className="company-drawer agent-editor" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>AI Agent</span><h2>{editingAgent ? editingAgent.name : "Add Agent"}</h2></div>
          <button type="button" className="company-drawer-close" aria-label="Close" onClick={() => setAgentEditor(false)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveAgent}>
          <section><h3>General</h3>
            <div className="company-form-grid"><label><span>Name</span><input required value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} /></label>
            <label><span>Role</span><input required placeholder="Any custom role" value={agentForm.role} onChange={(event) => setAgentForm({ ...agentForm, role: event.target.value })} /></label></div>
            <label><span>Description</span><textarea value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} /></label>
          </section>
          <section><h3>AI</h3>
            <div className="company-form-grid"><label><span>Model</span><select value={agentForm.modelId} onChange={(event) => setAgentForm({ ...agentForm, modelId: event.target.value })}>
              <option value="">Auto  -  NPATI</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label>
            <label><span>Fallback Model</span><select value={agentForm.fallbackModelId} onChange={(event) => setAgentForm({ ...agentForm, fallbackModelId: event.target.value })}>
              <option value="">Auto  -  NPATI</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label></div>
            {modelsLoading && <small className="company-field-hint">Loading connected models...</small>}
            {!modelsLoading && modelsError && <small className="company-field-hint">Could not load connected models: {modelsError}</small>}
            {!modelsLoading && !modelsError && models.length === 0 && <small className="company-field-hint">No models in My Models. Auto uses NPATI routing; add models in AI Providers.</small>}
          </section>
          <section><h3>Instructions</h3>
            <label><span>System Instruction</span><textarea rows={5} value={agentForm.systemInstruction} onChange={(event) => setAgentForm({ ...agentForm, systemInstruction: event.target.value })} /></label>
            <label><span>Prompt Guidelines</span><textarea rows={4} value={agentForm.promptGuidelines} onChange={(event) => setAgentForm({ ...agentForm, promptGuidelines: event.target.value })} /></label>
            <label><span>Recommended Prompts</span><textarea rows={4} placeholder="One prompt per line" value={agentForm.recommendedPrompts} onChange={(event) => setAgentForm({ ...agentForm, recommendedPrompts: event.target.value })} /></label>
          </section>
          <section>
            <h3>Tools & Capabilities</h3>
            <small className="company-field-hint">Knowledge searches uploaded documents. Company Memory gives this agent access to durable Company facts and rules.</small>
            <div className="company-tool-grid">
              {availableTools.map((tool) => {
                const isChecked = agentForm.tools.includes(tool.name) || agentForm.tools.includes(tool.id);
                return (
                  <label className="company-tool" key={tool.id} title={tool.description || tool.name}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(event) => {
                        const val = tool.name;
                        setAgentForm({
                          ...agentForm,
                          tools: event.target.checked
                            ? [...agentForm.tools, val]
                            : agentForm.tools.filter((item) => item !== val && item !== tool.id),
                        });
                      }}
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      {tool.risk && tool.risk !== "low" && <span className={`risk-badge ${tool.risk}`}>{tool.risk}</span>}
                      {tool.requiresConfirmation && <span className="confirm-badge">Approval required</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
          <section><h3>Organization</h3>
            <label><span>Parent Agent</span><select value={agentForm.parentAgentId} onChange={(event) => setAgentForm({ ...agentForm, parentAgentId: event.target.value })}>
              <option value="">No parent / top level</option>{agents.filter((agent) => agent.id !== editingAgent?.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}  -  {agent.role}</option>)}
            </select></label>
            <label className="company-switch"><input type="checkbox" checked={agentForm.isActive} onChange={(event) => setAgentForm({ ...agentForm, isActive: event.target.checked })} /><span>Agent active</span></label>
            {editingAgent && <button type="button" className="button-secondary" onClick={() => void setMainAgent(editingAgent.id)}>Set as Main Agent</button>}
          </section>
          <footer>{editingAgent && <button type="button" className="danger-button" onClick={() => void deleteAgent()}>Delete Agent</button>}<span /><button type="button" className="button-secondary" onClick={() => setAgentEditor(false)}>Cancel</button><button className="button-primary" disabled={saving}>{saving ? "Saving…" : "Save Agent"}</button></footer>
        </form>
      </aside>
    </div>}
  </main>;
}
