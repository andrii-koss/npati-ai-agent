import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";

interface ToolAuditItem {
  id: string;
  agentId: string;
  toolName: string;
  decision: "allowed" | "denied";
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  reasonCode?: string;
  createdAt: string;
}

interface RunStep {
  id: string;
  agentId: string;
  role: string;
  status: string;
  modelId?: string;
  stepOrder?: number;
  lane?: number;
}

interface BackgroundRunEvent {
  id: string;
  eventType: "queued" | "claimed" | "started" | "retry_scheduled" | "completed" | "failed" | "cancelled";
  runStatus: string;
  workerId?: string;
  attemptCount: number;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface CompletionReport {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  workerId?: string;
  attemptCount: number;
  totalCost: number;
  totalTokens: number;
  totalDurationMs: number;
  completedAt: string;
}

interface CompanyRun {
  id: string;
  companyId: string;
  task: string;
  requestedMode: string;
  executionMode?: string;
  status: string;
  result?: string;
  errorMessage?: string;
  omnirouteComboName?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalCost?: number;
  createdAt: string;
  completedAt?: string;
}

interface CompanyItem {
  id: string;
  name: string;
}

type RunStatusFilter = "all" | "completed" | "running" | "failed";

function visibleRunTask(task: string): string {
  return task.replace(/^\[NPATI_CONTENT:(?:article|seo_blueprint|social_post|brief|strategy|other):[A-Za-z0-9_-]+\]\s*/, "");
}

export function ActivityPage() {
  const { t } = useTranslation();
  const [companies, setCompanies] = useState<CompanyItem[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [runs, setRuns] = useState<CompanyRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [activeRunDetails, setActiveRunDetails] = useState<{
    run: CompanyRun;
    steps: RunStep[];
    toolAudit: ToolAuditItem[];
    backgroundEvents: BackgroundRunEvent[];
    completionReport?: CompletionReport;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter & Search state
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"presets" | "trace">("trace");

  // Dispatch state
  const [taskPrompt, setTaskPrompt] = useState("");
  const [runMode, setRunMode] = useState<"auto" | "single" | "pipeline" | "fusion">("auto");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Fetch initial companies list
  useEffect(() => {
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch("/api/companies?limit=50", { headers })
      .then((res) => (res.ok ? res.json() : { companies: [] }))
      .then((data: { companies?: CompanyItem[] }) => {
        const list = data.companies ?? [];
        setCompanies(list);
        if (list.length > 0 && list[0]) {
          setSelectedCompanyId(list[0].id);
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, []);

  // Fetch runs for the selected company
  const loadRuns = async (companyId: string, isManualRefresh = false) => {
    if (!companyId) return;
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    try {
      const res = await fetch(`/api/companies/${companyId}/runs?limit=50`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load runs`);
      const data = (await res.json()) as { runs?: CompanyRun[] };
      const items = data.runs ?? [];
      setRuns(items);

      if (items.length > 0) {
        // If current selection is still in list keep it, otherwise pick first
        setSelectedRunId((prev) => {
          if (prev && items.some((r) => r.id === prev)) return prev;
          return items[0]?.id ?? "";
        });
      } else {
        setSelectedRunId("");
        setActiveRunDetails(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("activity.errors.loadRunsFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (selectedCompanyId) {
      loadRuns(selectedCompanyId);
    }
  }, [selectedCompanyId]);

  // Fetch run details when selectedRunId changes
  useEffect(() => {
    if (!selectedCompanyId || !selectedRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    const loadDetails = () => fetch(`/api/companies/${selectedCompanyId}/runs/${selectedRunId}`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load run details`);
        return (await res.json()) as {
          run: CompanyRun;
          steps: RunStep[];
          toolAudit: ToolAuditItem[];
          backgroundEvents: BackgroundRunEvent[];
          completionReport?: CompletionReport;
        };
      })
      .then((data) => {
        if (stopped) return;
        setActiveRunDetails(data);
        setRuns((previous) => previous.map((run) => run.id === data.run.id ? data.run : run));
        if (["queued", "planning", "running", "cancelling"].includes(data.run.status)) timer = setTimeout(loadDetails, 1500);
      })
      .catch(() => {});
    void loadDetails();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [selectedCompanyId, selectedRunId]);

  // Handle task dispatch
  const handleDispatch = async (overridePrompt?: string) => {
    const promptToRun = (overridePrompt ?? taskPrompt).trim();
    if (!promptToRun || !selectedCompanyId || dispatching) return;

    setDispatching(true);
    setDispatchNotice(null);

    try {
      const headers: HeadersInit = {
        "content-type": "application/json",
        "idempotency-key": `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      const token = getStoredAuthToken();
      if (token) headers["authorization"] = `Bearer ${token}`;

      const res = await fetch(`/api/companies/${selectedCompanyId}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          task: promptToRun,
          mode: runMode,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || `HTTP ${res.status}: Failed to dispatch task`);
      }

      const data = await res.json();
      if (data.run) {
        setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
        setSelectedRunId(data.run.id);
        setActiveRunDetails({
          run: data.run,
          steps: data.steps ?? [],
          toolAudit: data.toolAudit ?? [],
          backgroundEvents: data.backgroundEvents ?? [],
          completionReport: data.completionReport,
        });
        setViewMode("trace");
        setTaskPrompt("");
        setDispatchNotice({
          type: "success",
          message: t("activity.dispatch.dispatchedNotice", { id: data.run.id.slice(0, 8), status: data.run.status }),
        });
        setTimeout(() => setDispatchNotice(null), 4000);
      }
    } catch (err) {
      setDispatchNotice({
        type: "error",
        message: err instanceof Error ? err.message : t("activity.dispatch.dispatchFailed"),
      });
    } finally {
      setDispatching(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  // Metrics
  const totalRunsCount = runs.length;
  const completedRunsCount = runs.filter((r) => r.status === "completed").length;
  const activeRunsCount = runs.filter((r) => ["running", "planning", "queued"].includes(r.status)).length;
  const failedRunsCount = runs.filter((r) => r.status === "failed").length;
  const totalSecurityDecisions = activeRunDetails?.toolAudit?.length ?? 0;

  // Filtered runs for sidebar
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (statusFilter === "completed" && run.status !== "completed") return false;
      if (statusFilter === "running" && !["running", "planning", "queued"].includes(run.status)) return false;
      if (statusFilter === "failed" && run.status !== "failed") return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTask = run.task.toLowerCase().includes(q);
        const matchId = run.id.toLowerCase().includes(q);
        const matchMode = (run.executionMode || run.requestedMode || "").toLowerCase().includes(q);
        if (!matchTask && !matchId && !matchMode) return false;
      }
      return true;
    });
  }, [runs, statusFilter, searchQuery]);

  const quickPrompts = useMemo(() => [
    { label: t("activity.dispatch.presets.marketAuditLabel"), prompt: t("activity.dispatch.presets.marketAuditPrompt") },
    { label: t("activity.dispatch.presets.securityAuditLabel"), prompt: t("activity.dispatch.presets.securityAuditPrompt") },
    { label: t("activity.dispatch.presets.growthRoadmapLabel"), prompt: t("activity.dispatch.presets.growthRoadmapPrompt") },
  ], [t]);

  const currentCompany = companies.find((c) => c.id === selectedCompanyId);

  return (
    <main className="activity-page">
      {/* Hero Header matching /settings/capabilities */}
      <header className="marketplace-hero activity-header">
        <div>
          <p className="eyebrow">{t("activity.eyebrow")}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={t("activity.backAria")} title={t("activity.backAria")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>{t("activity.title")}</span>
          </h1>
          <p className="hero-copy">
            {t("activity.heroCopy")}
          </p>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /settings/capabilities */}
      <section className="overview-grid activity-stats-grid">
        <div>
          <strong>{totalRunsCount}</strong>
          <span>{t("activity.stats.totalRuns")}</span>
          <small>{t("activity.stats.totalRunsDesc")}</small>
        </div>
        <div>
          <strong>{completedRunsCount}</strong>
          <span>{t("activity.stats.completed")}</span>
          <small>{t("activity.stats.completedDesc")}</small>
        </div>
        <div>
          <strong>{activeRunsCount}</strong>
          <span>{t("activity.stats.inProgress")}</span>
          <small>{t("activity.stats.inProgressDesc")}</small>
        </div>
        <div>
          <strong>{totalSecurityDecisions}</strong>
          <span>{t("activity.stats.securityDecisions")}</span>
          <small>{t("activity.stats.securityDecisionsDesc")}</small>
        </div>
      </section>

      {/* Controls Bar: Company Switcher, Status Filters, Search, Refresh */}
      <div className="activity-controls">
        <div className="activity-controls-row">
          {companies.length > 0 && (
            <div className="activity-company-selector">
              <label htmlFor="activity-company-select">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
                </svg>
                {t("activity.controls.companyLabel")}
              </label>
              <select
                id="activity-company-select"
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="select-input activity-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="activity-status-tabs" role="tablist">
            <button
              type="button"
              className={`activity-tab ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("all"); }}
            >
              {t("activity.controls.all")} <span className="tab-count">{totalRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "completed" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("completed"); }}
            >
              {t("activity.controls.completed")} <span className="tab-count">{completedRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "running" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("running"); }}
            >
              {t("activity.controls.running")} <span className="tab-count">{activeRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "failed" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("failed"); }}
            >
              {t("activity.controls.failed")} <span className="tab-count">{failedRunsCount}</span>
            </button>
          </div>

          <div className="activity-search-box">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input
              type="text"
              role="searchbox"
              placeholder={t("activity.controls.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="activity-search-input"
              aria-label={t("activity.controls.searchAriaLabel")}
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery("")}
                aria-label={t("activity.controls.clearSearch")}
                title={t("activity.controls.clearSearch")}
              >
                ×
              </button>
            )}
          </div>

          <button
            type="button"
            className="activity-refresh-btn"
            onClick={() => selectedCompanyId && loadRuns(selectedCompanyId, true)}
            disabled={refreshing || loading}
            title={t("activity.controls.refreshTitle")}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? "spin" : ""}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>{refreshing ? t("activity.controls.refreshing") : t("activity.controls.refresh")}</span>
          </button>
        </div>
      </div>

      {/* Task Dispatch Card: Live multi-agent execution runner */}
      <div className="activity-dispatch-card">
        <div className="activity-dispatch-header">
          <div className="activity-dispatch-title">
            <span className="activity-dispatch-icon">⚡</span>
            <div>
              <h3>{t("activity.dispatch.title")}</h3>
              <p>{t("activity.dispatch.subtitle")}</p>
            </div>
          </div>
          <div className="activity-mode-selector">
            <label htmlFor="activity-mode-select">{t("activity.dispatch.modeLabel")}</label>
            <select
              id="activity-mode-select"
              value={runMode}
              onChange={(e) => setRunMode(e.target.value as any)}
              className="select-input"
            >
              <option value="auto">{t("activity.dispatch.modes.auto")}</option>
              <option value="pipeline">{t("activity.dispatch.modes.pipeline")}</option>
              <option value="single">{t("activity.dispatch.modes.single")}</option>
              <option value="fusion">{t("activity.dispatch.modes.fusion")}</option>
            </select>
          </div>
        </div>

        <div className="activity-dispatch-input-row">
          <input
            type="text"
            className="activity-task-input"
            placeholder={
              currentCompany
                ? t("activity.dispatch.placeholderWithCompany", { name: currentCompany.name })
                : t("activity.dispatch.placeholderDefault")
            }
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleDispatch();
              }
            }}
          />
          <button
            type="button"
            className="activity-dispatch-submit-btn"
            onClick={() => handleDispatch()}
            disabled={dispatching || !taskPrompt.trim() || !selectedCompanyId}
          >
            {dispatching ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                <span>{t("activity.dispatch.dispatching")}</span>
              </>
            ) : (
              <>
                <span>{t("activity.dispatch.dispatchTask")}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </>
            )}
          </button>
        </div>

        <div className="activity-quick-prompts">
          <span className="quick-prompts-label">{t("activity.dispatch.presetsLabel")}</span>
          {quickPrompts.map((qp, idx) => (
            <button
              key={idx}
              type="button"
              className="quick-prompt-chip"
              onClick={() => {
                setTaskPrompt(qp.prompt);
                handleDispatch(qp.prompt);
              }}
              title={qp.prompt}
            >
              {qp.label}
            </button>
          ))}
        </div>

        {dispatchNotice && (
          <div className={`activity-notice ${dispatchNotice.type}`}>
            {dispatchNotice.type === "success" ? "✓" : "⚠️"} {dispatchNotice.message}
          </div>
        )}
      </div>
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && companies.length === 0 && (
        <div className="activity-empty-state">
          <h2>{t("activity.empty.noCompaniesTitle")}</h2>
          <p>{t("activity.empty.noCompaniesCopy")}</p>
          <Link to="/settings/company" className="button-primary automations-action-primary primary-action-btn">
            {t("activity.empty.createCompanyBtn")}
          </Link>
        </div>
      )}

      {!loading && companies.length > 0 && (runs.length === 0 || viewMode === "presets") && (
        <div className="activity-empty-state">
          <h2>{runs.length === 0 ? t("activity.empty.noRunsTitle") : t("activity.empty.presetsTitle")}</h2>
          <p>
            {runs.length === 0
              ? t("activity.empty.noRunsCopy")
              : t("activity.empty.presetsCopy")}
          </p>
          <div className="activity-empty-actions">
            {quickPrompts.map((qp, idx) => (
              <button
                key={idx}
                type="button"
                className="preset-dispatch-btn"
                onClick={() => {
                  setTaskPrompt(qp.prompt);
                  handleDispatch(qp.prompt);
                  setViewMode("trace");
                }}
              >
                {t("activity.empty.dispatchPresetBtn", { label: qp.label })}
              </button>
            ))}
          </div>
          {runs.length > 0 && (
            <div className="activity-view-trace-row">
              <button
                type="button"
                className="activity-switch-view-btn"
                onClick={() => setViewMode("trace")}
              >
                <span>{t("activity.empty.viewTraceBtn", { count: runs.length })}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && runs.length > 0 && viewMode === "trace" && (
        <div className="activity-layout-wrapper">
          <div className="activity-layout">
            {/* Sidebar: Recent Runs List */}
            <aside className="activity-runs-sidebar" aria-label="Runs list">
              <div className="activity-sidebar-header">
                <div className="sidebar-header-row">
                  <h3>{t("activity.sidebar.recentExecutions", { count: filteredRuns.length })}</h3>
                  <button
                    type="button"
                    className="sidebar-back-to-presets-btn"
                    onClick={() => setViewMode("presets")}
                    title={t("activity.sidebar.backToPresets")}
                  >
                    {t("activity.sidebar.backToPresets")}
                  </button>
                </div>
              </div>
              {filteredRuns.length === 0 ? (
                <div className="activity-empty-filter">
                  <p>{t("activity.sidebar.noFilteredRuns")}</p>
                  <button type="button" className="clear-filter-btn" onClick={() => { setStatusFilter("all"); setSearchQuery(""); }}>
                    {t("activity.sidebar.clearFiltersBtn")}
                  </button>
                </div>
              ) : (
                <div className="activity-run-list">
                  {filteredRuns.map((r) => {
                    const isSelected = selectedRunId === r.id;
                    const dateObj = new Date(r.createdAt);
                    const timeFormatted = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                    const durationFormatted = r.totalDurationMs ? `${(r.totalDurationMs / 1000).toFixed(1)}s` : null;

                    return (
                      <button
                        key={r.id}
                        className={`activity-run-item ${isSelected ? "active" : ""}`}
                        onClick={() => setSelectedRunId(r.id)}
                      >
                        <div className="activity-run-item-top">
                          <span className={`status-pill ${r.status}`}>{r.status}</span>
                          <small className="run-timestamp">{timeFormatted}</small>
                        </div>
                        <strong className="activity-run-task">{visibleRunTask(r.task)}</strong>
                        <div className="activity-run-footer">
                          <span className="activity-run-mode-tag">
                            {r.executionMode || r.requestedMode || "auto"}
                          </span>
                          {durationFormatted && <span className="activity-run-latency">{durationFormatted}</span>}
                          <span className="activity-run-id">#{r.id.slice(0, 8)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </aside>

            {/* Main: Execution Trace & Policy Inspection */}
            <section className="activity-trace-detail">
              {activeRunDetails ? (
                <div className="trace-card">
                  <header className="trace-card-header">
                    <div className="trace-header-top-row">
                      <button
                        type="button"
                        className="trace-back-arrow-btn"
                        onClick={() => setViewMode("presets")}
                        title={t("activity.trace.backToPresetsAria")}
                        aria-label={t("activity.trace.backToPresetsAria")}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <div className="trace-header-badges">
                        <span className={`status-pill ${activeRunDetails.run.status}`}>
                          {activeRunDetails.run.status}
                        </span>
                        <span className="trace-mode-pill">
                          {t("activity.trace.modePrefix", { mode: activeRunDetails.run.executionMode || activeRunDetails.run.requestedMode || "auto" })}
                        </span>
                        {activeRunDetails.run.omnirouteComboName && (
                          <span className="trace-combo-pill">
                            {t("activity.trace.comboPrefix", { combo: activeRunDetails.run.omnirouteComboName })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="trace-header-main">
                      <h2>{visibleRunTask(activeRunDetails.run.task)}</h2>
                    <div className="trace-meta-row">
                      <div className="trace-meta-item">
                        <span>{t("activity.trace.runIdLabel")}:</span>
                        <code>{activeRunDetails.run.id}</code>
                        <button
                          type="button"
                          className="copy-btn"
                          onClick={() => copyToClipboard(activeRunDetails.run.id, "runId")}
                          title={t("activity.trace.copyRunIdTitle")}
                        >
                          {copiedId === "runId" ? t("activity.trace.copied") : t("activity.trace.copy")}
                        </button>
                      </div>
                      <div className="trace-meta-item">
                        <span>{t("activity.trace.startedLabel")}:</span>
                        <strong>{new Date(activeRunDetails.run.createdAt).toLocaleString()}</strong>
                      </div>
                      {activeRunDetails.run.completedAt && (
                        <div className="trace-meta-item">
                          <span>{t("activity.trace.completedLabel")}:</span>
                          <strong>{new Date(activeRunDetails.run.completedAt).toLocaleTimeString()}</strong>
                        </div>
                      )}
                      {activeRunDetails.run.totalDurationMs !== undefined && (
                        <div className="trace-meta-item">
                          <span>{t("activity.trace.durationLabel")}:</span>
                          <strong>{(activeRunDetails.run.totalDurationMs / 1000).toFixed(2)}s</strong>
                        </div>
                      )}
                    </div>
                  </div>
                </header>

                {activeRunDetails.run.result && (
                  <div className="trace-result-box">
                    <div className="trace-box-header">
                      <div className="trace-box-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <strong>{t("activity.trace.finalOutput")}</strong>
                      </div>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={() => copyToClipboard(activeRunDetails.run.result || "", "result")}
                        title={t("activity.trace.copyResultTitle")}
                      >
                        {copiedId === "result" ? t("activity.trace.copied") : t("activity.trace.copy")}
                      </button>
                    </div>
                    <p>{activeRunDetails.run.result}</p>
                  </div>
                )}

                {activeRunDetails.run.errorMessage && (
                  <div className="trace-error-box">
                    <div className="trace-box-header">
                      <div className="trace-box-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        <strong>{t("activity.trace.executionFault")}</strong>
                      </div>
                    </div>
                    <p>{activeRunDetails.run.errorMessage}</p>
                  </div>
                )}

                {activeRunDetails.completionReport && (
                  <div className={`trace-completion-report ${activeRunDetails.completionReport.status}`}>
                    <div>
                      <strong>{t("activity.trace.completionReportTitle")}</strong>
                      <span>{activeRunDetails.completionReport.status}</span>
                    </div>
                    <p>
                      {t("activity.trace.attemptSummary", {
                        attempt: activeRunDetails.completionReport.attemptCount,
                        tokens: activeRunDetails.completionReport.totalTokens,
                        cost: activeRunDetails.completionReport.totalCost.toFixed(6),
                        seconds: (activeRunDetails.completionReport.totalDurationMs / 1000).toFixed(2),
                      })}
                    </p>
                  </div>
                )}

                <div className="trace-section">
                  <div className="trace-section-header">
                    <h3>{t("activity.trace.timelineTitle", { count: activeRunDetails.backgroundEvents?.length ?? 0 })}</h3>
                    <small>{t("activity.trace.timelineDesc")}</small>
                  </div>
                  <div className="background-event-list">
                    {(activeRunDetails.backgroundEvents ?? []).map((event) => (
                      <div key={event.id} className={`background-event-item ${event.eventType}`}>
                        <span className="background-event-dot" aria-hidden="true" />
                        <div>
                          <strong>{event.eventType.replace("_", " ")}</strong>
                          <p>{event.message}</p>
                          <small>{t("activity.trace.attemptLabel", { attempt: event.attemptCount })}{event.workerId ? ` · ${event.workerId}` : ""} · {new Date(event.createdAt).toLocaleTimeString()}</small>
                        </div>
                      </div>
                    ))}
                    {(!activeRunDetails.backgroundEvents || activeRunDetails.backgroundEvents.length === 0) && (
                      <div className="trace-empty-notice">{t("activity.trace.synchronousNotice")}</div>
                    )}
                  </div>
                </div>

                {/* Agent Delegation Steps */}
                <div className="trace-section">
                  <div className="trace-section-header">
                    <h3>
                      {t("activity.trace.delegationTitle", { count: activeRunDetails.steps?.length ?? 0 })}
                    </h3>
                    <small>{t("activity.trace.delegationDesc")}</small>
                  </div>
                  <div className="trace-steps-list">
                    {(activeRunDetails.steps ?? []).map((step, idx) => (
                      <div key={step.id || idx} className="trace-step-item">
                        <span className="step-number">{step.stepOrder || idx + 1}</span>
                        <div className="trace-step-body">
                          <div className="trace-step-top">
                            <span className={`role-badge ${step.role}`}>{step.role}</span>
                            <span className={`step-status-badge ${step.status}`}>{step.status}</span>
                            <code className="trace-agent-id">{t("activity.trace.agentPrefix", { id: step.agentId.slice(0, 10) })}...</code>
                          </div>
                          <div className="trace-step-meta">
                            <span>{t("activity.trace.modelPrefix")} <strong>{step.modelId || "auto"}</strong></span>
                            {step.lane !== undefined && <span>{t("activity.trace.lanePrefix", { lane: step.lane })}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                    {(!activeRunDetails.steps || activeRunDetails.steps.length === 0) && (
                      <div className="trace-empty-notice">
                        {t("activity.trace.noStepsNotice")}
                      </div>
                    )}
                  </div>
                </div>

                {/* Tool Executions & Security Decisions */}
                <div className="trace-section">
                  <div className="trace-section-header">
                    <h3>
                      {t("activity.trace.toolsTitle", { count: activeRunDetails.toolAudit?.length ?? 0 })}
                    </h3>
                    <small>{t("activity.trace.toolsDesc")}</small>
                  </div>
                  <div className="trace-tool-list">
                    {(activeRunDetails.toolAudit ?? []).map((tool, idx) => (
                      <div key={tool.id || idx} className={`trace-tool-item ${tool.decision}`}>
                        <div className="trace-tool-item-header">
                          <span className={`decision-badge ${tool.decision}`}>{tool.decision}</span>
                          <code className="tool-name-code">{tool.toolName}</code>
                          <span className={`status-badge ${tool.status}`}>{tool.status}</span>
                          {tool.latencyMs !== undefined && (
                            <span className="tool-latency-tag">{tool.latencyMs}ms</span>
                          )}
                        </div>
                        {tool.errorMessage && <p className="trace-tool-error">{tool.errorMessage}</p>}
                        {tool.reasonCode && (
                          <div className="trace-tool-reason">
                            <span>{t("activity.trace.policyReason")}</span> <code>{tool.reasonCode}</code>
                          </div>
                        )}
                      </div>
                    ))}
                    {(!activeRunDetails.toolAudit || activeRunDetails.toolAudit.length === 0) && (
                      <div className="trace-empty-notice">
                        {t("activity.trace.noToolsNotice")}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="activity-placeholder-card">
                <span className="placeholder-icon">👈</span>
                <h3>{t("activity.trace.selectRunTitle")}</h3>
                <p>{t("activity.trace.selectRunCopy")}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    )}
  </main>
  );
}
