import { getStoredAuthToken } from "./AuthContext";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
type KnowledgeDocument = { id:string;fileId:string;status:string;errorMessage?:string;chunkCount:number;createdAt:string };
type CompanyMemory = { id:string;content:string;source:string;updatedAt:string };
type RunDetails = { run: { id: string; status: string; executionMode?: string; result?: string; errorMessage?: string }; steps: unknown[]; toolAudit: unknown[] };
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

const defaultToolOptions = ["Web Search", "Web Fetch", "Crawler", "MCP", "Files", "Knowledge"];
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

function AgentNode({ agent, main, onClick }: { agent: Agent; main: boolean; onClick(): void }) {
  return <button className={`company-agent-node ${main ? "main" : ""} ${agent.isActive ? "" : "inactive"}`} onClick={onClick}>
    <span className="company-agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
    <span><strong>{agent.name}</strong><small>{agent.role}</small><em>{agent.modelId || "Auto"}</em></span>
    {main && <b>Main</b>}
  </button>;
}

function OrgChart({ agents, edges, mainAgentId, onSelect }: { agents: Agent[]; edges: Edge[]; mainAgentId?: string; onSelect(agent: Agent): void }) {
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
  return <div className="company-org-chart">
    {levels.map((level, index) => <div className="company-chart-level" key={index}>
      {index > 0 && <span className="company-chart-trunk" aria-hidden="true" />}
      <div className="company-chart-row">{level.map((agent) => <AgentNode key={agent.id} agent={agent} main={agent.id === mainAgentId} onClick={() => onSelect(agent)} />)}</div>
    </div>)}
  </div>;
}

export function CompanyPage() {
  const { overview } = useWorkspace();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [runMode, setRunMode] = useState<"auto" | "single" | "pipeline" | "fusion">("auto");
  const [runDetails, setRunDetails] = useState<RunDetails>();
  const [running, setRunning] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]);
  const [memories,setMemories]=useState<CompanyMemory[]>([]);
  const [memoryText,setMemoryText]=useState("");
  const [knowledgeBusy,setKnowledgeBusy]=useState(false);
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

  const [availableTools, setAvailableTools] = useState<CapabilityItem[]>([]);

  useEffect(() => {
    api<{ capabilities: CapabilityItem[] }>("/capabilities?agentCallable=true")
      .then((res) => { if (res.capabilities?.length) setAvailableTools(res.capabilities); })
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
    const page = await api<AgentPage>(`/companies/${companyId}/agents?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    let nextAgents = append ? [...agents, ...page.agents] : page.agents;
    const mainId = companySnapshot.find((company) => company.id === companyId)?.mainAgentId;
    if (mainId && !nextAgents.some((agent) => agent.id === mainId)) {
      nextAgents = [await api<Agent>(`/companies/${companyId}/agents/${mainId}`), ...nextAgents];
    }
    nextAgents = [...new Map(nextAgents.map((agent) => [agent.id, agent])).values()];
    const ids = nextAgents.map((agent) => agent.id).join(",");
    const nextEdges = ids ? await api<Edge[]>(`/companies/${companyId}/agent-edges?agentIds=${encodeURIComponent(ids)}`) : [];
    setAgents(nextAgents); setEdges(nextEdges); setAgentCursor(page.pagination.nextCursor);
  }

  useEffect(() => {
    void loadCompanies().then((items) => {
      const first = items[0];
      if (first) void loadOrganization(first.id, undefined, false, items);
    });
    void api<{ models: Model[] }>("/ai/models/added").then((value) => setModels(value.models ?? [])).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadOrganization(selectedId);
    void api<{ documents: KnowledgeDocument[] }>(`/companies/${selectedId}/knowledge/documents`).then((value) => setDocuments(value.documents ?? [])).catch(() => setDocuments([]));
    void api<{ memories: CompanyMemory[] }>(`/companies/${selectedId}/knowledge/memory`).then((value) => setMemories(value.memories ?? [])).catch(() => setMemories([]));
  }, [selectedId]);

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
    try {
      const result = await api<RunDetails>(`/companies/${selected.id}/runs`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ task: task.trim(), mode: runMode }),
      });
      setRunDetails(result);
      if (result.run.status === "completed") setNotice("Company run completed.");
      else setNotice(result.run.errorMessage ?? `Company run ${result.run.status}.`);
      setRunning(!["completed", "failed", "cancelled"].includes(result.run.status));
    } catch (error) { setRunning(false); setNotice(error instanceof Error ? error.message : "Company run failed"); }
  }

  async function uploadKnowledge(file:File){
    if(!selected)return;setKnowledgeBusy(true);setNotice("");
    try{const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.readAsDataURL(file);});
      await api(`/companies/${selected.id}/knowledge/documents`,{method:"POST",headers:{"idempotency-key":crypto.randomUUID()},body:JSON.stringify({filename:file.name,mimeType:file.type||"application/octet-stream",data})});
      const value=await api<{documents:KnowledgeDocument[]}>(`/companies/${selected.id}/knowledge/documents`);setDocuments(value.documents);setNotice("Document uploaded and queued for processing.");
    }catch(error){setNotice(error instanceof Error?error.message:"Document upload failed");}finally{setKnowledgeBusy(false);}
  }
  async function addCompanyMemory(){if(!selected||!memoryText.trim())return;try{await api(`/companies/${selected.id}/knowledge/memory`,{method:"POST",body:JSON.stringify({content:memoryText.trim()})});setMemoryText("");const v=await api<{memories:CompanyMemory[]}>(`/companies/${selected.id}/knowledge/memory`);setMemories(v.memories);}catch(error){setNotice(error instanceof Error?error.message:"Memory save failed");}}
  async function deleteKnowledge(id:string){if(!selected)return;await api(`/companies/${selected.id}/knowledge/documents/${id}`,{method:"DELETE"});setDocuments(items=>items.filter(item=>item.id!==id));}
  async function reprocessKnowledge(id:string){if(!selected)return;await api(`/companies/${selected.id}/knowledge/documents/${id}/reprocess`,{method:"POST"});const value=await api<{documents:KnowledgeDocument[]}>(`/companies/${selected.id}/knowledge/documents`);setDocuments(value.documents);setNotice("Document queued for reprocessing.");}
  async function deleteCompanyMemory(id:string){if(!selected)return;await api(`/companies/${selected.id}/knowledge/memory/${id}`,{method:"DELETE"});setMemories(items=>items.filter(item=>item.id!==id));}

  async function deleteCompany() {
    if (!selected || !window.confirm(`Delete company "${selected.name}" and all its agents?`)) return;
    try {
      await api(`/companies/${selected.id}`, { method: "DELETE" });
      setCompanyEditor(false); setEditingCompany(undefined); await loadCompanies();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not delete company"); }
  }

  return <main className="company-page company-refined">
    <header className="company-page-header inspector-header automations-header">
      <div>
        <p className="eyebrow">Settings · AI Company</p>
        <div className="company-title-row">
          <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">←</Link>
          {companies.length > 0
            ? <select aria-label="Select company" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
              </select>
            : <h1>Build your AI company</h1>}
          {selected && <span className={`company-status ${selected.status}`}>{selected.status}</span>}
        </div>
        <p>{selected?.description || "Create a configurable team of AI agents over OmniRoute."}</p>
      </div>
      <div className="company-header-actions">
        <button className="button-secondary" onClick={() => openCompanyEditor()}>New Company</button>
        {selected && <button className="button-secondary" onClick={() => openCompanyEditor(selected)}>Company Settings</button>}
        {selected && <button className="button-primary" onClick={() => openAgentEditor()}>+ Add Agent</button>}
      </div>
    </header>

    {notice && <div className={`workspace-notice ${/saved/i.test(notice) ? "" : "error"}`}>{notice}</div>}

    {!selected ? <section className="company-first-run">
      <span className="provider-avatar">CO</span><h2>Create your first Company</h2>
      <p>Company is separate from Business and contains its own agents, instructions, models, tools and organization scheme.</p>
      <button className="button-primary" onClick={() => openCompanyEditor()}>Create Company</button>
    </section> : <>
      <section className="company-control-strip">
        <label><span>Main Agent</span><select value={selected.mainAgentId ?? ""} onChange={(event) => void setMainAgent(event.target.value)}>
          <option value="">Not selected</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}  -  {agent.role}</option>)}
        </select></label>
        <div><span>Linked Business</span><strong>{overview?.businesses.find((business) => business.id === selected.businessId)?.name ?? "Independent company"}</strong></div>
        <div><span>Agents</span><strong>{agents.length}</strong></div>
        <div><span>Active</span><strong>{agents.filter((agent) => agent.isActive).length}</strong></div>
      </section>
      <section className="company-run-card">
        <div className="company-section-heading"><div><span>Runtime</span><h2>Delegate a task</h2></div><small>Main Agent plans through A2A; execution uses OmniRoute Auto, Pipeline or Fusion.</small></div>
        <form onSubmit={runCompany} className="company-run-form">
          <textarea required rows={3} maxLength={20000} placeholder="Give your AI company a task..." value={task} onChange={(event) => setTask(event.target.value)} />
          <select aria-label="Execution mode" value={runMode} onChange={(event) => setRunMode(event.target.value as typeof runMode)}>
            <option value="auto">Auto by Main Agent</option><option value="single">Single</option>
            <option value="pipeline">Pipeline</option><option value="fusion">Fusion</option>
          </select>
          <button className="button-primary" disabled={running || !selected.mainAgentId}>{running ? "Running..." : "Run Company"}</button>
        </form>
        {!selected.mainAgentId && <small className="company-field-hint">Select a Main Agent before running the company.</small>}
        {runDetails && <p role="status" aria-live="polite">Run status: {runDetails.run.status}{runDetails.run.errorMessage ? ` — ${runDetails.run.errorMessage}` : ""}</p>}
        {runDetails?.run.result && <div className="company-run-result"><strong>Final response</strong><p>{runDetails.run.result}</p><small>{runDetails.run.executionMode} � {runDetails.run.status}</small></div>}
      </section>
      <section className="company-run-card company-knowledge-card">
        <div className="company-section-heading"><div><span>Context</span><h2>Company Knowledge</h2></div><small>Private MinIO documents, OmniRoute embeddings and rerank.</small></div>
        <label className="button-secondary">{knowledgeBusy?"Uploading...":"Upload Document"}<input hidden type="file" disabled={knowledgeBusy} accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.json,.xml" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadKnowledge(f);e.currentTarget.value="";}} /></label>
        <div className="company-knowledge-list">{documents.map(doc=><div key={doc.id}><strong>{doc.status}</strong><span>{doc.chunkCount} chunks</span>{doc.errorMessage&&<small>{doc.errorMessage}</small>}<a href={`/api/companies/${selected.id}/knowledge/documents/${doc.id}/content`}>Download</a>{doc.status==="failed"&&<button className="button-secondary" onClick={()=>void reprocessKnowledge(doc.id)}>Retry</button>}<button className="danger-button" onClick={()=>void deleteKnowledge(doc.id)}>Delete</button></div>)}{!documents.length&&<p>No Company documents yet.</p>}</div>
        <div className="company-memory-editor"><textarea rows={2} placeholder="Add an important Company fact or rule..." value={memoryText} onChange={e=>setMemoryText(e.target.value)}/><button className="button-secondary" onClick={()=>void addCompanyMemory()}>Add Memory</button></div>
        {memories.length>0&&<ul>{memories.slice(0,5).map(memory=><li key={memory.id}>{memory.content}<button className="danger-button" onClick={()=>void deleteCompanyMemory(memory.id)}>Delete</button></li>)}</ul>}
      </section>
      <section className="company-chart-card">
        <div className="company-section-heading"><div><span>Organization</span><h2>AI Agent Org Chart</h2></div><small>Only 60 agents are loaded per page. Click an agent to edit it.</small></div>
        <div className="company-chart-scroll" role="region" aria-label="Agent organization chart" tabIndex={0}>
          <OrgChart agents={agents} edges={edges} mainAgentId={selected.mainAgentId} onSelect={openAgentEditor} />
        </div>
        {agentCursor && <button className="button-secondary company-load-more" onClick={() => void loadOrganization(selected.id, agentCursor, true)}>Load more agents</button>}
      </section>
    </>}

    {companyEditor && <div className="company-drawer-backdrop" onMouseDown={() => setCompanyEditor(false)}>
      <aside className="company-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>Company</span><h2>{editingCompany ? "Company Settings" : "New Company"}</h2></div><button aria-label="Close" onClick={() => setCompanyEditor(false)}>x</button></header>
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
          <footer>{editingCompany && <button type="button" className="danger-button" onClick={() => void deleteCompany()}>Delete Company</button>}<span /><button type="button" onClick={() => setCompanyEditor(false)}>Cancel</button><button className="button-primary" disabled={saving}>{saving ? "Saving&" : "Save Company"}</button></footer>
        </form>
      </aside>
    </div>}

    {agentEditor && selected && <div className="company-drawer-backdrop" onMouseDown={() => setAgentEditor(false)}>
      <aside className="company-drawer agent-editor" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>AI Agent</span><h2>{editingAgent ? editingAgent.name : "Add Agent"}</h2></div><button aria-label="Close" onClick={() => setAgentEditor(false)}>x</button></header>
        <form onSubmit={saveAgent}>
          <section><h3>General</h3>
            <div className="company-form-grid"><label><span>Name</span><input required value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} /></label>
            <label><span>Role</span><input required placeholder="Any custom role" value={agentForm.role} onChange={(event) => setAgentForm({ ...agentForm, role: event.target.value })} /></label></div>
            <label><span>Description</span><textarea value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} /></label>
          </section>
          <section><h3>AI</h3>
            <div className="company-form-grid"><label><span>Model</span><select value={agentForm.modelId} onChange={(event) => setAgentForm({ ...agentForm, modelId: event.target.value })}>
              <option value="">Auto  -  OmniRoute</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label>
            <label><span>Fallback Model</span><select value={agentForm.fallbackModelId} onChange={(event) => setAgentForm({ ...agentForm, fallbackModelId: event.target.value })}>
              <option value="">Auto  -  OmniRoute</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
            </select></label></div>
            {models.length === 0 && <small className="company-field-hint">No concrete models in My Models. Auto still uses OmniRoute routing; add models in AI Providers.</small>}
          </section>
          <section><h3>Instructions</h3>
            <label><span>System Instruction</span><textarea rows={5} value={agentForm.systemInstruction} onChange={(event) => setAgentForm({ ...agentForm, systemInstruction: event.target.value })} /></label>
            <label><span>Prompt Guidelines</span><textarea rows={4} value={agentForm.promptGuidelines} onChange={(event) => setAgentForm({ ...agentForm, promptGuidelines: event.target.value })} /></label>
            <label><span>Recommended Prompts</span><textarea rows={4} placeholder="One prompt per line" value={agentForm.recommendedPrompts} onChange={(event) => setAgentForm({ ...agentForm, recommendedPrompts: event.target.value })} /></label>
          </section>
          <section>
            <h3>Tools & Capabilities</h3>
            <div className="company-tool-grid">
              {(availableTools.length > 0
                ? availableTools
                : defaultToolOptions.map((name) => ({ id: name.toLowerCase().replace(/\s+/g, "."), name, description: "", domain: "general", risk: "low", requiresConfirmation: false, requiredPermissions: [], requiredConnections: [] }))
              ).map((tool) => {
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
          <footer>{editingAgent && <button type="button" className="danger-button" onClick={() => void deleteAgent()}>Delete Agent</button>}<span /><button type="button" onClick={() => setAgentEditor(false)}>Cancel</button><button className="button-primary" disabled={saving}>{saving ? "Saving&" : "Save Agent"}</button></footer>
        </form>
      </aside>
    </div>}
  </main>;
}
