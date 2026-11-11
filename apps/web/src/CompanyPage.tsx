import { FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Model } from "./ai-marketplace-types";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import {
  type Company,
  type Agent,
  type Edge,
  type AgentPage,
  type RunDetails,
  type RunSummary,
  type CompanyDraft,
  type AgentDraft,
  type CapabilityItem,
  defaultToolOptions,
  translatedStatus,
  translatedMode,
  emptyCompany,
  emptyAgent,
  companyDraft,
  agentDraft,
  getCachedCompanies,
  getCachedSelectedCompanyId,
  updateCachedCompanies,
  api,
  OrgChart,
  KnowledgePanel,
  CompanyDrawer,
  AgentDrawer,
  ControlStrip,
  useCompanyKnowledge,
  CompanyHeader,
  CompanyMassDeleteModal,
  BusinessMassDeleteModal,
  AgentMassDeleteModal,
} from "./company";
export function CompanyPage() {
  const { t, language } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCompanyId = searchParams.get("company") ?? "";
  const requestedRunId = searchParams.get("runId") ?? "";
  const { overview, refresh } = useWorkspace();
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
  const [companyEditor, setCompanyEditor] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company>();
  const [agentEditor, setAgentEditor] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent>();
  const [companyForm, setCompanyForm] = useState<CompanyDraft>({ ...emptyCompany });
  const [agentForm, setAgentForm] = useState<AgentDraft>({ ...emptyAgent });
  const [notice, setNotice] = useState("");
  const [massDeleteOpen, setMassDeleteOpen] = useState(false);
  const [massDeleteBusinessOpen, setMassDeleteBusinessOpen] = useState(false);
  const [massDeleteAgentOpen, setMassDeleteAgentOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const companyCreateKey = useRef(crypto.randomUUID());
  const agentCreateKey = useRef(crypto.randomUUID());
  const selected = companies.find((company) => company.id === selectedId);
  const {
    documents,
    knowledgeBusy,
    uploadKnowledge,
    knowledgeActionId,
    downloadKnowledge,
    reprocessKnowledge,
    deleteKnowledge,
    memories,
    memoryText,
    setMemoryText,
    memoryBusy,
    addCompanyMemory,
    editingMemoryId,
    setEditingMemoryId,
    editingMemoryText,
    setEditingMemoryText,
    updateCompanyMemory,
    startEditingMemory,
    deleteCompanyMemory,
  } = useCompanyKnowledge(selected, setNotice);
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
    const all: Company[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const pageUrl: string = `/companies?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await api<{ companies: Company[]; pagination?: { nextCursor?: string | null } }>(pageUrl);
      const list = res?.companies ?? [];
      all.push(...list);
      if (!res?.pagination?.nextCursor || list.length === 0) {
        hasMore = false;
      } else {
        cursor = res.pagination.nextCursor;
      }
    }
    if (preferredId && !all.some((item) => item.id === preferredId)) {
      try { all.push(await api<Company>(`/companies/${encodeURIComponent(preferredId)}`)); } catch { /* Deleted or inaccessible companies are never selected. */ }
    }
    setCompanies(all);
    const nextId = preferredId && all.some((item) => item.id === preferredId) ? preferredId : (all[0]?.id ?? "");
    setSelectedId(nextId);
    updateCachedCompanies(all, nextId);
    return all;
  }
  async function handleCompaniesDeleted(deletedIds: string[]) {
    const nextCompanies = companies.filter((c) => !deletedIds.includes(c.id));
    const nextSelectedId = nextCompanies.some((c) => c.id === selectedId)
      ? selectedId
      : (nextCompanies[0]?.id ?? "");
    if (deletedIds.includes(readActiveCompanyId())) {
      writeActiveCompanyId(nextSelectedId);
    }
    window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "delete_batch", count: deletedIds.length } }));
    setNotice(
      deletedIds.length === 1
        ? t("companySettings.notices.companyDeleted")
        : t("companySettings.notices.companiesDeleted", { count: deletedIds.length })
    );
    await loadCompanies(nextSelectedId);
  }
  async function handleBusinessesDeleted(deletedIds: string[]) {
    if (selected && selected.businessId && deletedIds.includes(selected.businessId)) {
      await updateCompanyBusiness("");
    }
    await refresh();
    setNotice(
      deletedIds.length === 1
        ? t("companySettings.notices.businessDeleted")
        : t("companySettings.notices.businessesDeleted", { count: deletedIds.length })
    );
  }
  async function handleAgentsDeleted(deletedIds: string[]) {
    setAgents((items) => items.filter((agent) => !deletedIds.includes(agent.id)));
    setEdges((items) => items.filter((edge) => !deletedIds.includes(edge.parentAgentId) && !deletedIds.includes(edge.childAgentId)));
    if (selected) {
      const refreshedCompanies = await loadCompanies(selected.id);
      await loadOrganization(selected.id, undefined, false, refreshedCompanies);
    }
    setNotice(
      deletedIds.length === 1
        ? t("companySettings.notices.agentDeleted")
        : t("companySettings.notices.agentsDeleted", { count: deletedIds.length })
    );
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
    void loadOrganization(selectedId);
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
    try {
      await api<Agent>(`/companies/${selected.id}/agents/${mainAgent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ tools: [...mainAgent.tools, "Knowledge"], expectedRevision: mainAgent.revision }),
      });
      await loadOrganization(selected.id);
      setNotice(t("companySettings.notices.knowledgeEnabled", { name: mainAgent.name }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotEnableKnowledge"));
    }
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
      setNotice(t("companySettings.notices.companyDeleted"));
    } catch (error) { setNotice(error instanceof Error ? error.message : t("companySettings.errors.couldNotDelete")); }
  }
  const noticeIsSuccess = Boolean(notice)
    && !/failed|error|could not|unavailable|exceeded|required|conflict|timed out|denied|помилка|не вдалося|nicht|echoué|fallit|błąd/i.test(notice);
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
    <CompanyHeader
      selected={selected}
      notice={notice}
      noticeIsSuccess={noticeIsSuccess}
      onClearNotice={() => setNotice("")}
      onOpenCompanyEditor={openCompanyEditor}
      onOpenAgentEditor={() => openAgentEditor()}
      onDeleteCompany={() => void deleteCompany()}
    />
    {companiesLoading ? null : !selected ? <section className="company-first-run">
      <span className="provider-avatar">CO</span><h2>{t("companySettings.firstRun.title")}</h2>
      <p>{t("companySettings.firstRun.description")}</p>
      <button className="button-primary" onClick={() => openCompanyEditor()}>{t("companySettings.firstRun.createButton")}</button>
    </section> : <>
      <ControlStrip
        companies={companies}
        selected={selected}
        selectedId={selectedId}
        onSelectCompanyId={setSelectedId}
        agents={agents}
        businesses={overview?.businesses}
        onUpdateBusiness={updateCompanyBusiness}
        onOpenMassDelete={() => setMassDeleteOpen(true)}
        onOpenMassDeleteBusiness={() => setMassDeleteBusinessOpen(true)}
        onOpenMassDeleteAgent={() => setMassDeleteAgentOpen(true)}
      />

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
                value={runMode}
                onChange={(event) => setRunMode(event.target.value as "auto" | "single" | "pipeline" | "fusion")}
                className="company-mode-select"
              >
                <option value="auto">{t("companySettings.mode.auto")}</option>
                <option value="single">{t("companySettings.mode.single")}</option>
                <option value="pipeline">{t("companySettings.mode.pipeline")}</option>
                <option value="fusion">{t("companySettings.mode.fusion")}</option>
              </select>
            </div>

            <button
              className="button-primary automations-action-primary company-launch-btn"
              disabled={running || !task.trim()}
            >
              {running ? (
                <>
                  <span className="company-btn-spinner" aria-hidden="true" />
                  <span>{t("companySettings.runtime.runningCompany")}</span>
                </>
              ) : (
                <>
                  <span>{t("companySettings.runtime.runCompany")}</span>
                </>
              )}
            </button>
          </div>
        </form>

        {runDetails && (
          <div className="company-run-details">
            <div className="company-run-status-strip">
              <span className={`connection-status-pill status-${runDetails.run.status === "completed" ? "ok" : runDetails.run.status === "failed" ? "error" : "standby"}`}>
                <span className={`status-indicator-dot ${runDetails.run.status === "completed" ? "ok" : runDetails.run.status === "failed" ? "error" : "standby"}`} />
                {translatedStatus(t, runDetails.run.status)}
              </span>
              {runDetails.run.mainAgentId && (
                <span className="company-run-agent-tag">
                  {t("companySettings.runtime.orchestratorTag")} <strong>{agents.find((a) => a.id === runDetails.run.mainAgentId)?.name ?? runDetails.run.mainAgentId}</strong>
                </span>
              )}
              {runDetails.run.executionMode && (
                <span className="company-run-mode-tag">
                  {t("companySettings.runtime.modeTag")} {translatedMode(t, runDetails.run.executionMode)}
                </span>
              )}
            </div>

            {!runDetails.run.mainAgentId && (
              <div className="company-run-alert alert-warning">
                <span className="company-alert-icon" aria-hidden="true">⚠️</span>
                <span dangerouslySetInnerHTML={{ __html: t("companySettings.runtime.mainAgentNotice") }} />
              </div>
            )}

            {runDetails.run.status === "awaiting_approval" && (
              <div className="company-run-approval-card" role="alert">
                <div className="company-run-approval-content">
                  <div className="company-run-approval-header">
                    <span className="company-run-approval-badge">{t("companySettings.runtime.securityCheckpoint")}</span>
                    <h4>{t("companySettings.runtime.manualApprovalRequired")}</h4>
                  </div>
                  <p>
                    {runDetails.run.errorMessage || t("companySettings.runtime.approvalDesc")}
                  </p>
                  {pendingApprovalId && (
                    <span className="company-run-approval-id">
                      {t("companySettings.runtime.approvalId")} <code>{pendingApprovalId}</code>
                    </span>
                  )}
                  {Boolean(runDetails.toolAudit?.length) && (
                    <div className="company-run-audit-preview">
                      <small>{t("companySettings.runtime.pendingActions")}</small>
                      <ul>
                        {runDetails.toolAudit.map((tool, index) => (
                          <li key={`${tool.toolName ?? "tool"}-${index}`}>
                            <code>{tool.toolName ?? t("companySettings.runtime.unknownTool")}</code>
                            {tool.reasonCode ? <span>({tool.reasonCode})</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="company-run-approval-actions">
                  <button
                    type="button"
                    className="button-primary company-approval-btn approve"
                    disabled={approvalBusy}
                    onClick={() => void decideRunApproval("approved")}
                  >
                    {approvalBusy ? t("companySettings.runtime.approving") : t("companySettings.runtime.approveAndContinue")}
                  </button>
                  <button
                    type="button"
                    className="button-secondary company-approval-btn reject"
                    disabled={approvalBusy}
                    onClick={() => void decideRunApproval("rejected")}
                  >
                    {approvalBusy ? t("companySettings.runtime.rejecting") : t("companySettings.runtime.rejectAndCancel")}
                  </button>
                </div>
              </div>
            )}

            {runDetails.run.errorCode === "APPROVAL_REQUIRED" && runDetails.run.status !== "awaiting_approval" && (
              <div className="company-run-alert alert-info">
                <span className="company-alert-icon" aria-hidden="true">🔒</span>
                <span dangerouslySetInnerHTML={{ __html: t("companySettings.runtime.approvalRequired") }} />
              </div>
            )}

            {runDetails.run.result && (
              <div className="company-run-result">
                <h4>{t("companySettings.runtime.runResult")}</h4>
                <div className="company-run-result-box">{runDetails.run.result}</div>
              </div>
            )}
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

      <KnowledgePanel
        selected={selected}
        agents={agents}
        documents={documents}
        knowledgeBusy={knowledgeBusy}
        uploadKnowledge={uploadKnowledge}
        enableMainAgentKnowledge={enableMainAgentKnowledge}
        knowledgeActionId={knowledgeActionId}
        downloadKnowledge={downloadKnowledge}
        reprocessKnowledge={reprocessKnowledge}
        deleteKnowledge={deleteKnowledge}
        memories={memories}
        memoryText={memoryText}
        setMemoryText={setMemoryText}
        memoryBusy={memoryBusy}
        addCompanyMemory={addCompanyMemory}
        editingMemoryId={editingMemoryId}
        setEditingMemoryId={setEditingMemoryId}
        editingMemoryText={editingMemoryText}
        setEditingMemoryText={setEditingMemoryText}
        updateCompanyMemory={updateCompanyMemory}
        startEditingMemory={startEditingMemory}
        deleteCompanyMemory={deleteCompanyMemory}
      />
    </>}

    <CompanyDrawer
      isOpen={companyEditor}
      onClose={() => setCompanyEditor(false)}
      editingCompany={editingCompany ?? null}
      companyForm={companyForm}
      setCompanyForm={setCompanyForm}
      saveCompany={saveCompany}
      deleteCompany={deleteCompany}
      saving={saving}
      businesses={overview?.businesses}
    />

    <AgentDrawer
      isOpen={agentEditor && Boolean(selected)}
      onClose={() => setAgentEditor(false)}
      editingAgent={editingAgent ?? null}
      agentForm={agentForm}
      setAgentForm={setAgentForm}
      saveAgent={saveAgent}
      deleteAgent={deleteAgent}
      saving={saving}
      models={models}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      availableTools={availableTools}
      language={language}
      agents={agents}
      setMainAgent={setMainAgent}
    />

    <CompanyMassDeleteModal
      isOpen={massDeleteOpen}
      onClose={() => setMassDeleteOpen(false)}
      companies={companies}
      onCompaniesDeleted={handleCompaniesDeleted}
    />

    <BusinessMassDeleteModal
      isOpen={massDeleteBusinessOpen}
      onClose={() => setMassDeleteBusinessOpen(false)}
      businesses={overview?.businesses}
      onBusinessesDeleted={handleBusinessesDeleted}
    />

    {selected && (
      <AgentMassDeleteModal
        isOpen={massDeleteAgentOpen}
        onClose={() => setMassDeleteAgentOpen(false)}
        companyId={selected.id}
        agents={agents}
        onAgentsDeleted={handleAgentsDeleted}
      />
    )}
  </main>;
}
