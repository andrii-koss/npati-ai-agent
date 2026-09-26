import { getStoredAuthToken } from "./AuthContext";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { chooseAvailableCompanyId, writeActiveCompanyId } from "./active-company";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

interface Company {
  id: string;
  name: string;
  mainAgentId?: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface CompanyAutomation {
  id: string;
  workspaceId: string;
  companyId: string;
  agentId?: string | null;
  name: string;
  description?: string | null;
  prompt: string;
  cronExpression: string;
  timezone: string;
  status: "active" | "paused";
  lastRunAt?: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

interface CompanyAutomationRun {
  id: string;
  automationId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  startedAt: string;
  completedAt?: string | null;
}

const PRESET_CRONS = [
  { key: "daily9", cron: "0 9 * * *" },
  { key: "daily18", cron: "0 18 * * *" },
  { key: "mondays9", cron: "0 9 * * 1" },
  { key: "fridays17", cron: "0 17 * * 5" },
  { key: "hourly", cron: "0 * * * *" },
] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export function AutomationsPage() {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCompanyId = searchParams.get("company") ?? "";
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(requestedCompanyId);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [automations, setAutomations] = useState<CompanyAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // Editor Drawer State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formCron, setFormCron] = useState("0 9 * * *");
  const [formAgentId, setFormAgentId] = useState("");
  const [saving, setSaving] = useState(false);

  // Run History Drawer State
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyAutomation, setHistoryAutomation] = useState<CompanyAutomation | null>(null);
  const [runs, setRuns] = useState<CompanyAutomationRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningNowId, setRunningNowId] = useState<string | null>(null);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        const requested = searchParams.get("company");
        const selected = chooseAvailableCompanyId(res.companies, { requested });
        setSelectedCompanyId(selected);
        if (selected) writeActiveCompanyId(selected);
        if (requested) {
          const next = new URLSearchParams(searchParams);
          next.delete("company");
          setSearchParams(next, { replace: true });
        }
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load automations & agents when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    Promise.all([
      api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`),
      api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
    ])
      .then(([autoRes, agentsRes]) => {
        setAutomations(autoRes.automations);
        setAgents(agentsRes.agents);
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, [selectedCompanyId]);

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === selectedCompanyId),
    [companies, selectedCompanyId]
  );

  const filteredAutomations = useMemo(() => {
    return automations.filter((auto) => {
      if (statusFilter !== "all" && auto.status !== statusFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const agentName = agents.find((a) => a.id === auto.agentId)?.name.toLowerCase() || "main agent";
      return (
        auto.name.toLowerCase().includes(q) ||
        (auto.description && auto.description.toLowerCase().includes(q)) ||
        auto.prompt.toLowerCase().includes(q) ||
        auto.cronExpression.toLowerCase().includes(q) ||
        agentName.includes(q)
      );
    });
  }, [automations, searchQuery, statusFilter, agents]);

  const stats = useMemo(() => {
    const total = automations.length;
    const active = automations.filter((a) => a.status === "active").length;
    const paused = automations.filter((a) => a.status === "paused").length;
    const assignedAgentIds = new Set(automations.map((a) => a.agentId).filter(Boolean));
    const agentsCount = assignedAgentIds.size || (automations.length > 0 ? 1 : 0);
    return { total, active, paused, agentsCount };
  }, [automations]);

  const presets = useMemo(
    () => [
      { label: t("automations.presets.daily9"), cron: "0 9 * * *" },
      { label: t("automations.presets.daily18"), cron: "0 18 * * *" },
      { label: t("automations.presets.mondays9"), cron: "0 9 * * 1" },
      { label: t("automations.presets.fridays17"), cron: "0 17 * * 5" },
      { label: t("automations.presets.hourly"), cron: "0 * * * *" },
    ],
    [t]
  );

  const getCronDescription = (cron: string) => {
    const matched = PRESET_CRONS.find((p) => p.cron === cron);
    if (matched) return t(`automations.presets.${matched.key}`);
    if (cron === "0 0 * * *") return t("automations.presets.daily0");
    if (cron === "0 * * * *") return t("automations.presets.hourly");
    return cron;
  };

  const openCreateDrawer = () => {
    setEditingId(null);
    setFormName("");
    setFormDescription("");
    setFormPrompt("");
    setFormCron("0 9 * * *");
    setFormAgentId(selectedCompany?.mainAgentId || "");
    setDrawerOpen(true);
  };

  const openEditDrawer = (auto: CompanyAutomation) => {
    setEditingId(auto.id);
    setFormName(auto.name);
    setFormDescription(auto.description || "");
    setFormPrompt(auto.prompt);
    setFormCron(auto.cronExpression);
    setFormAgentId(auto.agentId || "");
    setDrawerOpen(true);
  };

  const saveAutomation = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setSaving(true);
    setNotice(null);

    try {
      if (editingId) {
        const updated = await api<CompanyAutomation>(
          `/companies/${selectedCompanyId}/automations/${editingId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || null,
            }),
          }
        );
        setAutomations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      } else {
        const created = await api<CompanyAutomation>(
          `/companies/${selectedCompanyId}/automations`,
          {
            method: "POST",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || undefined,
            }),
          }
        );
        setAutomations((prev) => [created, ...prev]);
      }
      setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (auto: CompanyAutomation) => {
    const nextStatus = auto.status === "active" ? "paused" : "active";
    try {
      const updated = await api<CompanyAutomation>(
        `/companies/${selectedCompanyId}/automations/${auto.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      setAutomations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const deleteAutomation = async (id: string) => {
    const confirmed = await confirmModal({
      title: t("automations.dialogs.deleteTitle"),
      message: t("automations.dialogs.deleteMessage"),
      confirmText: t("automations.dialogs.deleteConfirm"),
      cancelText: t("automations.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/companies/${selectedCompanyId}/automations/${id}`, { method: "DELETE" });
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      if (editingId === id) setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const triggerRunNow = async (auto: CompanyAutomation) => {
    setRunningNowId(auto.id);
    setNotice(null);
    try {
      const res = await api<{ message?: string; result?: string }>(
        `/companies/${selectedCompanyId}/automations/${auto.id}/run`,
        { method: "POST" }
      );
      setNotice(
        `${t("automations.notifications.runInitiated", { name: auto.name })}${
          res.result ? ` ${t("automations.notifications.resultReceived")}` : ""
        }`
      );
    } catch (err: any) {
      setNotice(t("automations.notifications.runError", { error: err.message }));
    } finally {
      setRunningNowId(null);
    }
  };

  const openHistory = async (auto: CompanyAutomation) => {
    setHistoryAutomation(auto);
    setHistoryDrawerOpen(true);
    setHistoryLoading(true);
    try {
      const res = await api<{ runs: CompanyAutomationRun[] }>(
        `/companies/${selectedCompanyId}/automations/${auto.id}/runs`
      );
      setRuns(res.runs);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <main className="automations-container">
      {/* Header matching /settings/capabilities */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("automations.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("automations.backAria")} title={t("automations.backAria")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("automations.title")}</span>
            </h1>
            <p className="hero-copy">
              {t("automations.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            {companies.length > 1 && (
              <select
                aria-label={t("automations.selectCompanyAria")}
                value={selectedCompanyId}
                onChange={(e) => {
                  const companyId = e.target.value;
                  setSelectedCompanyId(companyId);
                  writeActiveCompanyId(companyId);
                }}
                className="page-size-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="button-primary automations-action-primary" onClick={openCreateDrawer}>
              {t("automations.newAutomationBtn")}
            </button>
          </div>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{stats.total}</strong>
          <span>{t("automations.stats.total")}</span>
          <small>{t("automations.stats.totalDesc")}</small>
        </div>
        <div>
          <strong>{stats.active}</strong>
          <span>{t("automations.stats.active")}</span>
          <small>{t("automations.stats.activeDesc")}</small>
        </div>
        <div>
          <strong>{stats.paused}</strong>
          <span>{t("automations.stats.paused")}</span>
          <small>{t("automations.stats.pausedDesc")}</small>
        </div>
        <div>
          <strong>{stats.agentsCount}</strong>
          <span>{t("automations.stats.assignedAgents")}</span>
          <small>{t("automations.stats.assignedAgentsDesc")}</small>
        </div>
      </section>

      {/* Search & Tabs Controls bar matching /settings/capabilities */}
      <div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("automations.controls.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label={t("automations.controls.searchAriaLabel")}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label={t("automations.controls.clearSearch")}
              title={t("automations.controls.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "all"}
            className={`inspector-tab ${statusFilter === "all" ? "active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            <span>{t("automations.controls.tabAll")}</span>
            <small className="tab-count">{automations.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "active"}
            className={`inspector-tab ${statusFilter === "active" ? "active" : ""}`}
            onClick={() => setStatusFilter("active")}
          >
            <span>{t("automations.controls.tabActive")}</span>
            <small className="tab-count">{stats.active}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "paused"}
            className={`inspector-tab ${statusFilter === "paused" ? "active" : ""}`}
            onClick={() => setStatusFilter("paused")}
          >
            <span>{t("automations.controls.tabPaused")}</span>
            <small className="tab-count">{stats.paused}</small>
          </button>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      {/* Status summary */}
      <div className="inspector-table-status">
        <div className="status-left">
          <span>
            {t("automations.showingStatus", { count: filteredAutomations.length, total: automations.length })}
            {searchQuery ? ` ${t("automations.matchingQuery", { query: searchQuery })}` : ""}
          </span>
        </div>
      </div>

      {loading ? null : automations.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">⏱️</div>
          <h3>{t("automations.empty.noAutomationsTitle")}</h3>
          <p>{t("automations.empty.noAutomationsDesc")}</p>
          <button type="button" className="button-primary automations-action-primary" onClick={openCreateDrawer}>
            {t("automations.empty.createFirstBtn")}
          </button>
        </div>
      ) : filteredAutomations.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{t("automations.empty.noMatchingTitle")}</h3>
          <p>{t("automations.empty.noMatchingDesc")}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}
          >
            {t("automations.empty.clearFiltersBtn")}
          </button>
        </div>
      ) : (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "110px" }}>{t("automations.table.colStatus")}</th>
                <th style={{ minWidth: "260px" }}>{t("automations.table.colTask")}</th>
                <th style={{ minWidth: "180px" }}>{t("automations.table.colSchedule")}</th>
                <th style={{ minWidth: "160px" }}>{t("automations.table.colAssignedAgent")}</th>
                <th style={{ width: "220px", textAlign: "right" }}>{t("automations.table.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredAutomations.map((auto) => {
                const assignedAgent = agents.find((a) => a.id === auto.agentId);
                const isRunningNow = runningNowId === auto.id;
                const nextDate = auto.nextRunAt ? new Date(auto.nextRunAt) : null;

                return (
                  <tr key={auto.id}>
                    <td>
                      <button
                        type="button"
                        className={`automation-status-btn ${auto.status}`}
                        onClick={() => toggleStatus(auto)}
                        title={auto.status === "active" ? t("automations.table.clickToPause") : t("automations.table.clickToActivate")}
                      >
                        <span className="automation-status-dot" />
                        {auto.status === "active" ? t("automations.table.statusActive") : t("automations.table.statusPaused")}
                      </button>
                    </td>
                    <td className="automation-title-cell">
                      <strong>{auto.name}</strong>
                      {auto.description && <p>{auto.description}</p>}
                      <div className="automation-prompt-preview" title={auto.prompt}>
                        {t("automations.table.promptPrefix")} {auto.prompt}
                      </div>
                    </td>
                    <td>
                      <span className="automation-cron-pill">
                        <code>{auto.cronExpression}</code>
                      </span>
                      <span className="automation-cron-label">
                        {getCronDescription(auto.cronExpression)}
                      </span>
                      {nextDate && (
                        <span className="automation-next-run">
                          {t("automations.table.nextRunPrefix")}{" "}
                          {nextDate.toLocaleString(language === "uk" ? "uk-UA" : language, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="automation-agent-badge">
                        <span>🤖</span>
                        <span>{assignedAgent ? assignedAgent.name : t("automations.table.mainAgent")}</span>
                      </span>
                    </td>
                    <td>
                      <div className="automation-actions-cell">
                        <button
                          type="button"
                          className="automation-action-btn run-btn"
                          disabled={isRunningNow}
                          onClick={() => triggerRunNow(auto)}
                          title={t("automations.table.runNowTitle")}
                        >
                          {isRunningNow ? t("automations.table.running") : t("automations.table.runNow")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => openHistory(auto)}
                          title={t("automations.table.historyTitle")}
                        >
                          {t("automations.table.history")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          onClick={() => openEditDrawer(auto)}
                          title={t("automations.table.editTitle")}
                        >
                          {t("automations.table.edit")}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => deleteAutomation(auto.id)}
                          title={t("automations.table.deleteTitle")}
                        >
                          {t("automations.table.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor Drawer */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("automations.editor.kicker")}</span>
                <h2>{editingId ? t("automations.editor.editTitle") : t("automations.editor.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>
            <form onSubmit={saveAutomation}>
              <section>
                <h3>{t("automations.editor.taskParamsHeading")}</h3>
                <label>
                  <span>{t("automations.editor.taskNameLabel")}</span>
                  <input
                    required
                    placeholder={t("automations.editor.taskNamePlaceholder")}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("automations.editor.descLabel")}</span>
                  <input
                    placeholder={t("automations.editor.descPlaceholder")}
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("automations.editor.assignedAgentLabel")}</span>
                  <select value={formAgentId} onChange={(e) => setFormAgentId(e.target.value)}>
                    <option value="">{t("automations.editor.mainAgentDefault")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>{t("automations.editor.schedulePresetsLabel")}</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {presets.map((p) => (
                      <button
                        type="button"
                        key={p.cron}
                        className={`cron-preset-btn ${formCron === p.cron ? "active" : ""}`}
                        onClick={() => setFormCron(p.cron)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </label>

                <label>
                  <span>{t("automations.editor.cronExpressionLabel")}</span>
                  <input
                    required
                    placeholder="0 9 * * *"
                    value={formCron}
                    onChange={(e) => setFormCron(e.target.value)}
                    style={{ fontFamily: "monospace" }}
                  />
                </label>

                <label>
                  <span>{t("automations.editor.agentPromptLabel")}</span>
                  <textarea
                    required
                    rows={5}
                    placeholder={t("automations.editor.agentPromptPlaceholder")}
                    value={formPrompt}
                    onChange={(e) => setFormPrompt(e.target.value)}
                  />
                </label>
              </section>

              <footer>
                {editingId && (
                  <button type="button" className="danger-button" onClick={() => deleteAutomation(editingId)}>
                    {t("automations.editor.deleteBtn")}
                  </button>
                )}
                <span />
                <button type="button" className="button-secondary" onClick={() => setDrawerOpen(false)}>
                  {t("automations.editor.cancelBtn")}
                </button>
                <button className="button-primary automations-action-primary" disabled={saving}>
                  {saving ? t("automations.editor.savingBtn") : t("automations.editor.saveBtn")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* Run History Drawer */}
      {historyDrawerOpen && historyAutomation && (
        <div className="company-drawer-backdrop" onMouseDown={() => setHistoryDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <header>
              <div>
                <span>{t("automations.history.kicker")}</span>
                <h2>{historyAutomation.name}</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setHistoryDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>
            <section style={{ padding: "20px 26px" }}>
              {historyLoading ? (
                <div className="workspace-notice">{t("automations.history.loading")}</div>
              ) : runs.length === 0 ? (
                <div style={{ textAlign: "center", padding: "32px 0", color: "var(--npati-gray-500)" }}>
                  {t("automations.history.noRuns")}
                </div>
              ) : (
                <div className="history-runs-list">
                  {runs.map((r) => (
                    <div key={r.id} className="history-run-item">
                      <div className="history-run-header">
                        <span className={`status-pill ${r.status}`}>{r.status.toUpperCase()}</span>
                        <small style={{ color: "var(--npati-gray-500)" }}>
                          {new Date(r.startedAt).toLocaleString(language === "uk" ? "uk-UA" : language)}
                        </small>
                      </div>
                      <div className="history-run-meta">
                        <span>{t("automations.history.duration")} <strong>{r.durationMs}ms</strong></span>
                        <code style={{ fontSize: "11px", color: "var(--npati-gray-500)" }}>#{r.id.slice(0, 8)}</code>
                      </div>
                      {r.result && (
                        <div className="history-run-result">
                          <strong style={{ display: "block", marginBottom: 4, color: "#15803d" }}>{t("automations.history.finalResult")}</strong>
                          <p style={{ margin: 0 }}>{r.result}</p>
                        </div>
                      )}
                      {r.errorMessage && (
                        <div className="history-run-error">
                          <strong>{t("automations.history.error")}</strong> {r.errorMessage}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
