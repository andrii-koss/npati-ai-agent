import { readSettingsSnapshot } from "./settings-page-cache";
import { ALL_COMPANIES } from "./company-scope";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeSnapshotPanel } from "./CodeSnapshotPanel";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import { writeActiveCompanyId, writeCachedCompanies } from "./active-company";
import { readBulkRecords } from "./bulk-records-api";
import { RecordCheckbox, RecordSelectionToolbar, useRecordSelection } from "./record-selection";
import { visibleRunTask, type ActiveRunDetails, type CompanyRun, type RunStatusFilter } from "./activity-types";
import { activityPageKey, activityParams, cacheActivityPage, readActivityDetail, readActivityPage, readActivitySnapshot,
  type ActivityDetail, type ActivityFilters, type ActivityPageSummary } from "./activity-page-read";
import { ActivityTraceDetail } from "./activity-trace-detail";
import { ActivityStatsCards } from "./activity-stats-cards";
import { CodeRunMonitor } from "./CodeRunMonitor";

const emptyRuns: CompanyRun[] = [];
const liveStatuses = new Set(["queued", "planning", "running", "cancelling"]);

function pageRuns(page?: ActivityPageSummary | null) {
  if (!page) return emptyRuns;
  const { selected, items } = page;
  return selected && !items.some(run => run.id === selected.id) ? [selected, ...items] : items;
}

export function ActivityPage() {
  const { t, language } = useTranslation();
  const query = new URLSearchParams(window.location.search);
  const queryRunId = query.get("runId");
  const [selectedCompanyId, setSelectedCompanyId] = useState(query.get("company") || ALL_COMPANIES);
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedSearch(searchQuery.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const filters: ActivityFilters = { company: selectedCompanyId, status: statusFilter, search: appliedSearch };
  const scopeKey = activityPageKey(filters);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const initial = useMemo(() => readActivitySnapshot(filters, queryRunId), []);
  const [page, setPage] = useState<ActivityPageSummary | undefined>(initial);
  const [runs, setRuns] = useState(() => pageRuns(initial));
  const [companies, setCompanies] = useState(initial?.companies ?? []);
  const [selectedRunId, setSelectedRunId] = useState(initial?.selected?.id ?? "");
  const [detail, setDetail] = useState<ActivityDetail | null>(() =>
    readSettingsSnapshot<ActivityDetail>(`activity:detail:${initial?.selected?.id}`) ?? null);
  const [activeRunDetails, setActiveRunDetails] = useState<ActiveRunDetails | null>(detail?.agent ?? null);
  const selectedRunRef = useRef(selectedRunId);
  const runLoadVersion = useRef(0);
  const detailVersion = useRef(0);
  const loadedScope = useRef<string | null>(null);
  const paging = useRef(false);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"presets" | "trace">("trace");

  const [taskPrompt, setTaskPrompt] = useState("");
  const [runMode, setRunMode] = useState<"auto" | "single" | "pipeline" | "fusion">("auto");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function selectRun(id: string, next: ActivityDetail | null) {
    selectedRunRef.current = id;
    setSelectedRunId(id);
    setDetail(next);
    setActiveRunDetails(next?.agent ?? null);
  }

  function handleCompanyChange(companyId: string) {
    if (companyId === selectedCompanyId) return;
    setSelectedCompanyId(companyId);
    if (companyId !== ALL_COMPANIES) writeActiveCompanyId(companyId);
  }

  const loadRuns = async (manual = false) => {
    if (currentScope.current !== scopeKey) return;
    const version = ++runLoadVersion.current;
    const owner = getStoredAuthToken();
    const current = () => version === runLoadVersion.current && currentScope.current === scopeKey && owner === getStoredAuthToken();
    const switching = loadedScope.current !== scopeKey;
    const selectedAtStart = selectedRunRef.current;
    if (manual) setRefreshing(true);
    setError(null);

    try {
      const result = await readActivityPage(filters, switching ? queryRunId ?? undefined : selectedAtStart || undefined);
      if (!current()) return;
      cacheActivityPage(filters, result);
      setCompanies(result.companies);
      writeCachedCompanies(result.companies);
      setPage(result);
      setRuns(pageRuns(result));
      if (switching || selectedRunRef.current === selectedAtStart) {
        ++detailVersion.current;
        selectRun(result.selected?.id ?? "", result.detail);
      }
      loadedScope.current = scopeKey;
      setReadyScope(scopeKey);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : t("activity.errors.loadRunsFailed"));
    } finally {
      if (current()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    const cached = readActivitySnapshot(filters, queryRunId);
    setPage(cached);
    setRuns(pageRuns(cached));
    setLoading(!cached);
    setRefreshing(false);
    setLoadingMore(false);
    paging.current = false;
    const cachedId = cached?.selected?.id ?? "";
    selectRun(cachedId, readSettingsSnapshot<ActivityDetail>(`activity:detail:${cachedId}`) ?? null);
    void loadRuns();
    return () => { ++runLoadVersion.current; ++detailVersion.current; };
  }, [scopeKey, queryRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !paging.current && runs.length <= 21) void loadRuns();
    }, selectedCompanyId === ALL_COMPANIES ? 30_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [scopeKey, runs.length]);

  const selectedRun = runs.find(run => run.id === selectedRunId) ?? (page?.selected?.id === selectedRunId ? page.selected : null);
  const selectedRunCompanyId = selectedRun?.companyId ?? "";
  const currentDetail = detail?.runId === selectedRunId ? detail : null;

  useEffect(() => {
    if (!activeRunDetails || !liveStatuses.has(activeRunDetails.run.status)) return;
    const id = activeRunDetails.run.id;
    const companyId = activeRunDetails.run.companyId;
    let stopped = false;
    const timer = window.setTimeout(() => {
      void readActivityDetail(companyId, id).then(data => {
        if (!stopped && selectedRunRef.current === id && data.agent) {
          setActiveRunDetails(data.agent);
          setRuns(previous => previous.map(run => run.id === id ? { ...run, status: data.agent!.run.status } : run));
        }
      }).catch(() => undefined);
    }, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [activeRunDetails]);

  async function openRun(run: CompanyRun) {
    if (selectedRunRef.current === run.id && currentDetail) return;
    const version = ++detailVersion.current;
    const owner = getStoredAuthToken();
    selectRun(run.id, readSettingsSnapshot<ActivityDetail>(`activity:detail:${run.id}`) ?? null);
    try {
      const data = await readActivityDetail(run.companyId, run.id);
      if (version === detailVersion.current && owner === getStoredAuthToken()) selectRun(run.id, data);
    } catch (cause) {
      if (version === detailVersion.current) setError(String(cause));
    }
  }

  async function loadMore() {
    if (!page?.nextCursor || paging.current) return;
    const version = runLoadVersion.current;
    const owner = getStoredAuthToken();
    paging.current = true;
    setLoadingMore(true);
    try {
      const next = await readActivityPage(filters, undefined, page.nextCursor);
      if (currentScope.current !== scopeKey || version !== runLoadVersion.current || owner !== getStoredAuthToken()) return;
      setPage(previous => previous ? { ...previous, nextCursor: next.nextCursor } : previous);
      setRuns(previous => [...previous, ...next.items.filter(run => !previous.some(item => item.id === run.id))]);
    } catch (cause) {
      if (currentScope.current === scopeKey) setError(String(cause));
    } finally {
      if (currentScope.current === scopeKey) {
        paging.current = false;
        setLoadingMore(false);
      }
    }
  }

  const selection = useRecordSelection({
    resource: "activity",
    scopeKey,
    ready: readyScope === scopeKey && searchQuery.trim() === appliedSearch && Boolean(page?.matchingTotal),
    loadAll: () => readBulkRecords("activity", activityParams(filters)),
    reload: () => loadRuns(true),
  });

  // Handle task dispatch
  const handleDispatch = async (overridePrompt?: string) => {
    const promptToRun = (overridePrompt ?? taskPrompt).trim();
    if (!promptToRun || !selectedCompanyId || selectedCompanyId === ALL_COMPANIES || dispatching) return;

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
        selectedRunRef.current = data.run.id;
        setSelectedRunId(data.run.id);
        setDetail(null);
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

  const previousCounts = readActivitySnapshot({ company: selectedCompanyId, status: "all", search: "" })?.counts;
  const { total: totalRunsCount, completed: completedRunsCount, running: activeRunsCount, failed: failedRunsCount } = page?.counts ?? previousCounts ?? {};
  const totalSecurityDecisions = activeRunDetails?.toolAudit.length ?? (currentDetail || page?.selected === null ? 0 : page?.securityDecisions);
  const taskPlanEvent = activeRunDetails?.backgroundEvents?.find((event) => event.eventKey === "project-plan");
  const projectTasks = Array.isArray(taskPlanEvent?.details.tasks)
    ? taskPlanEvent.details.tasks as Array<{ id: string; title: string; role: string; agentId: string; dependsOn: string[] }>
    : [];

  const matchingTotal = page?.matchingTotal;
  const visibleRuns = runs.filter(run => {
    if (run.id !== page?.selected?.id || page?.items.some(item => item.id === run.id)) return true;
    return !appliedSearch && statusFilter === "all";
  });

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
            <PageGuideLink guide="activity" />
          </h1>
          <p className="hero-copy">
            {t("activity.heroCopy")}
          </p>
        </div>
      </header>

      <ActivityStatsCards
        totalRunsCount={totalRunsCount}
        completedRunsCount={completedRunsCount}
        activeRunsCount={activeRunsCount}
        totalSecurityDecisions={totalSecurityDecisions}
        t={t}
      />

      {/* Controls Bar: Company Switcher, Status Filters, Search, Refresh */}
      <div className="activity-controls">
        <div className="activity-controls-row">
          {(
            <div className="activity-company-selector">
              <label htmlFor="activity-company-select">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
                </svg>
                {t("activity.controls.companyLabel")}
              </label>
              <CompanyScopeSelect
                id="activity-company-select"
                value={selectedCompanyId}
                onValueChange={(value) => handleCompanyChange(value)}
                className="select-input activity-select"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </CompanyScopeSelect>
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
            style={{ minWidth: "105px" }}
            onClick={() => void loadRuns(true)}
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
            disabled={dispatching || !taskPrompt.trim() || !selectedCompanyId || selectedCompanyId === ALL_COMPANIES}
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
      {viewMode === "trace" && <RecordSelectionToolbar selection={selection} matchingTotal={matchingTotal || (selection.message ? 0 : undefined)} />}

      {runs.length === 0 && loading ? (
        <div className="activity-layout-wrapper" style={{ minHeight: "500px", opacity: 0.5 }}>
          <div className="activity-layout">
            <aside className="activity-runs-sidebar" style={{ pointerEvents: "none" }}>
              <div className="activity-run-list">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="activity-run-item" style={{ minHeight: "85px" }} />
                ))}
              </div>
            </aside>
            <section className="activity-trace-detail">
              <div className="trace-card" style={{ minHeight: "450px" }} />
            </section>
          </div>
        </div>
      ) : !loading && companies.length === 0 ? (
        <div className="activity-empty-state">
          <h2>{t("activity.empty.noCompaniesTitle")}</h2>
          <p>{t("activity.empty.noCompaniesCopy")}</p>
          <Link to="/settings/company" className="button-primary automations-action-primary primary-action-btn">
            {t("activity.empty.createCompanyBtn")}
          </Link>
        </div>
      ) : (!totalRunsCount || viewMode === "presets") ? (
        <div className="activity-empty-state">
          <h2>{!totalRunsCount ? t("activity.empty.noRunsTitle") : t("activity.empty.presetsTitle")}</h2>
          <p>
            {!totalRunsCount
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
      ) : (
        <div className="activity-layout-wrapper">
          <div className="activity-layout">
            {/* Sidebar: Recent Runs List */}
            <aside className="activity-runs-sidebar" aria-label="Runs list">
              <div className="activity-sidebar-header">
                <div className="sidebar-header-row">
                  <h3>{t("activity.sidebar.recentExecutions", { count: matchingTotal ?? 0 })}</h3>
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
              {visibleRuns.length === 0 ? (
                <div className="activity-empty-filter">
                  <p>{t("activity.sidebar.noFilteredRuns")}</p>
                  <button type="button" className="clear-filter-btn" onClick={() => { setStatusFilter("all"); setSearchQuery(""); }}>
                    {t("activity.sidebar.clearFiltersBtn")}
                  </button>
                </div>
              ) : (
                <div className="activity-run-list">
                  {visibleRuns.map((r) => {
                    const isSelected = selectedRunId === r.id;
                    const dateObj = new Date(r.createdAt);
                    const timeFormatted = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                    const durationFormatted = r.totalDurationMs ? `${(r.totalDurationMs / 1000).toFixed(1)}s` : null;

                    return (
                      <div className="activity-run-selection-row" key={r.id}>
                        <RecordCheckbox selection={selection} record={{ id: r.id, ownerId: r.companyId }} name={visibleRunTask(r.task)} />
                        <button type="button" className={`activity-run-item ${isSelected ? "active" : ""}`} onClick={() => void openRun(r)}>
                        <div className="activity-run-item-top">
                          <span className={`status-pill ${r.status}`}>{r.status}</span>
                          <small className="run-timestamp">{timeFormatted}</small>
                        </div>
                        <strong className="activity-run-task">{visibleRunTask(r.task)}</strong>
                        <div className="activity-run-footer">
                          <span className="activity-run-mode-tag">
                            {r.executionMode || r.requestedMode || "auto"}
                          </span>
                          {r.projectId && <span className="activity-run-project-tag">🌐 Project</span>}
                          {durationFormatted && <span className="activity-run-latency">{durationFormatted}</span>}
                          <span className="activity-run-id">#{r.id.slice(0, 8)}</span>
                        </div>
                        </button>
                      </div>
                    );
                  })}
                  {page?.nextCursor && (
                    <button type="button" className="button-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                      {language === "uk" ? "Завантажити ще" : "Load more"}
                    </button>
                  )}
                </div>
              )}
            </aside>

            {/* Main: Execution Trace & Policy Inspection */}
            <section className="activity-trace-detail">
            {selectedRun?.requestedMode.startsWith("coding") ? (
              currentDetail?.code && <CodeRunMonitor key={`monitor:${selectedRunId}`} companyId={selectedRunCompanyId} runId={selectedRunId} isUk={language === "uk"} initialData={currentDetail.code} />
            ) : <>
            <ActivityTraceDetail
              activeRunDetails={activeRunDetails}
              projectTasks={projectTasks}
              copiedId={copiedId}
              copyToClipboard={copyToClipboard}
              setViewMode={setViewMode}
              language={language}
              t={t}
            />
            </>}
            {/* C6b: the minimum Run Trace needs to explain a run's environment and policies. A run with no
                snapshot says legacy_no_snapshot rather than rendering an error. */}
            {currentDetail ? (
              <CodeSnapshotPanel key={`snapshot:${selectedRunId}`} companyId={selectedRunCompanyId} runId={selectedRunId} isUk={language === "uk"} initialData={currentDetail.snapshot} />
            ) : null}
          </section>
        </div>
      </div>
    )}
  </main>
  );
}
