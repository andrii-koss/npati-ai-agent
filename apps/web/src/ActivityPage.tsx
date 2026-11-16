import { readSettingsSnapshot, writeSettingsSnapshot } from "./settings-page-cache";
import { SettingsListMore, useProgressiveSettingsItems } from "./useProgressiveSettingsItems";
import { ALL_COMPANIES, loadCompanyScopes } from "./company-scope";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { listProjectCompanies } from "./website-builder-cache";
import { useEffect, useMemo, useRef, useState } from "react";
// C6b: read-only "why did this run act this way" — execution snapshot, snapshot diff and replay status.
import { CodeSnapshotPanel } from "./CodeSnapshotPanel";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import {
  chooseAvailableCompanyId,
  readCachedCompanies,
  writeActiveCompanyId,
  writeCachedCompanies,
} from "./active-company";

import type {
  ToolAuditItem,
  RunStep,
  BackgroundRunEvent,
  CompletionReport,
  CompanyRun,
  CompanyItem,
  RunStatusFilter,
  ProjectTaskItem,
  ActiveRunDetails,
} from "./activity-types";
import {
  visibleRunTask,
  activityRunSummary,
  getCachedRuns,
  updateCachedRuns,
} from "./activity-types";
import { ActivityTraceDetail } from "./activity-trace-detail";
import { ActivityStatsCards } from "./activity-stats-cards";
import { CodeRunMonitor } from "./CodeRunMonitor";

export function ActivityPage() {
  const { t, language } = useTranslation();
  const initialCompanies = useMemo(() => readCachedCompanies<CompanyItem>(), []);
  const initialCompanyId = useMemo(
    () => new URLSearchParams(window.location.search).get("company") || (new URLSearchParams(window.location.search).get("runId") ? chooseAvailableCompanyId(initialCompanies) : ALL_COMPANIES),
    [initialCompanies]
  );
  const initialRuns = useMemo(() => readSettingsSnapshot<CompanyRun[]>(`activity:${initialCompanyId}`) ?? getCachedRuns(initialCompanyId), [initialCompanyId]);

  const [companies, setCompanies] = useState<CompanyItem[]>(initialCompanies);
  const companyIdsKey = companies.map(company => company.id).join("\0");
  const runLoadVersion = useRef(0);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(initialCompanyId);
  const [runs, setRuns] = useState<CompanyRun[]>(initialRuns);
  const selectedCompanyRef=useRef(selectedCompanyId);
  selectedCompanyRef.current=selectedCompanyId;
  const [codingCursor,setCodingCursor]=useState<string|null>(null);
  const allCodingCursors = useRef(new Map<string, string | null>());
  const historyCursor=useRef<{companyId:string;cursor:string|null}|null>(null);
  const runsRef=useRef(runs);runsRef.current=runs;
  const queryRunId = new URLSearchParams(window.location.search).get("runId");
  const [selectedRunId, setSelectedRunId] = useState<string>(() => (queryRunId || initialRuns[0]?.id) ?? "");
  const [activeRunDetails, setActiveRunDetails] = useState<{
    run: CompanyRun;
    steps: RunStep[];
    toolAudit: ToolAuditItem[];
    backgroundEvents: BackgroundRunEvent[];
    completionReport?: CompletionReport;
  } | null>(null);

  const [loading, setLoading] = useState(() => initialRuns.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter & Search state
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"presets" | "trace">("trace");

  useEffect(() => {
    if (queryRunId) {
      setSelectedRunId(queryRunId);
      setViewMode("trace");
    }
  }, [queryRunId]);

  // Dispatch state
  const [taskPrompt, setTaskPrompt] = useState("");
  const [runMode, setRunMode] = useState<"auto" | "single" | "pipeline" | "fusion">("auto");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCompanyChange = (companyId: string) => {
    setSelectedCompanyId(companyId);
    if (companyId !== ALL_COMPANIES) writeActiveCompanyId(companyId);
    allCodingCursors.current.clear();
    ++runLoadVersion.current;
    const cachedForNewCompany = readSettingsSnapshot<CompanyRun[]>(`activity:${companyId}`) ?? getCachedRuns(companyId);
    setRuns([]);setSelectedRunId("");setActiveRunDetails(null);setCodingCursor(null);
    if (cachedForNewCompany.length > 0) {
      setRuns(cachedForNewCompany);
      setSelectedRunId(cachedForNewCompany[0]?.id ?? "");
    }
  };

  // Fetch initial companies list
  useEffect(() => {
    listProjectCompanies()
      .then((list) => {
        setCompanies(list);
        writeCachedCompanies(list);
        if (list.length > 0) {
          const nextSelectedId = selectedCompanyId === ALL_COMPANIES ? ALL_COMPANIES : chooseAvailableCompanyId(list, { requested: selectedCompanyId });
          setSelectedCompanyId(nextSelectedId);
          if (nextSelectedId !== ALL_COMPANIES) writeActiveCompanyId(nextSelectedId);
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, []);

  // Fetch runs for the selected company
  const loadRuns = async (companyId: string, isManualRefresh = false) => {
    if (!companyId || companyId === ALL_COMPANIES && !companies.length) return;
    const version = ++runLoadVersion.current;
    const snapshotKey = `activity:${companyId}`;
    if (isManualRefresh) setRefreshing(true);
    else if (runs.length === 0) setLoading(true);
    setError(null);

    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    try {
      const scopeIds = companyId === ALL_COMPANIES ? companies.map(company => company.id) : [companyId];
      const cached = readSettingsSnapshot<CompanyRun[]>(snapshotKey);
      const publish = (pages: Array<{ items: CompanyRun[] }>) => {
        if (version !== runLoadVersion.current || selectedCompanyRef.current !== companyId) return;
        const items = pages.flatMap(page => page.items).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
        const merged = [...items, ...runsRef.current.filter(run => scopeIds.includes(run.companyId) && run.requestedMode.startsWith("coding") && !items.some(item => item.id === run.id))];
        runsRef.current = merged; setRuns(merged); writeSettingsSnapshot(snapshotKey, merged.map(activityRunSummary));
        if (merged.length) { setLoading(false); setSelectedRunId(previous => previous || merged[0]!.id); }
      };
      const pages = await loadCompanyScopes(scopeIds, async id => {
        const [res, coding] = await Promise.all([fetch(`/api/companies/${id}/runs?limit=50`, { headers }), fetch(`/api/companies/${id}/code/monitor/runs`, { headers })]);
        if (!res.ok || !coding.ok) throw new Error(`HTTP ${!res.ok ? res.status : coding.status}: Failed to load runs`);
        const data = await res.json() as { runs?: CompanyRun[] };
        const codeData = await coding.json() as { runs: CompanyRun[]; nextCursor: string | null };
        const items = [...codeData.runs, ...(data.runs ?? [])].map(item => ({ ...item, companyId: id }));
        if (queryRunId && companyId !== ALL_COMPANIES && !items.some(run => run.id === queryRunId)) {
          const linked = await fetch(`/api/companies/${id}/code/monitor/runs/${encodeURIComponent(queryRunId)}?limit=1`, { headers });
          if (linked.ok) items.unshift({ ...(await linked.json()).run, companyId: id });
        }
        return { id, items, cursor: codeData.nextCursor };
      }, { key: `activity:${queryRunId || ""}`, initial: cached ? scopeIds.map(id => ({ id, items: cached.filter(run => run.companyId === id), cursor: allCodingCursors.current.get(id) ?? null })) : undefined, isActive: () => version === runLoadVersion.current && selectedCompanyRef.current === companyId, onProgress: publish });
      if (selectedCompanyRef.current !== companyId || version !== runLoadVersion.current) return;
      const items = pages.flatMap(page => page.items).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
      pages.forEach(page => updateCachedRuns(page.id, page.items));
      if (companyId === ALL_COMPANIES) {
        pages.forEach(page => { if (!allCodingCursors.current.has(page.id)) allCodingCursors.current.set(page.id, page.cursor); });
        setCodingCursor([...allCodingCursors.current.values()].some(Boolean) ? ALL_COMPANIES : null);
      } else {
        if(historyCursor.current?.companyId!==companyId) historyCursor.current={companyId,cursor:pages[0]?.cursor ?? null};
        setCodingCursor(historyCursor.current.cursor);
      }
      publish(pages);

      if (items.length > 0) {
        // If current selection is still in list keep it, otherwise pick first
        setSelectedRunId((prev) => {
          if (prev && (items.some((r) => r.id === prev) || runsRef.current.some(r=>r.companyId===companyId && r.id===prev && r.requestedMode.startsWith("coding")))) return prev;
          return items[0]?.id ?? "";
        });
      } else {
        setSelectedRunId("");
        setActiveRunDetails(null);
      }
    } catch (err) {
      if (version === runLoadVersion.current) setError(err instanceof Error ? err.message : t("activity.errors.loadRunsFailed"));
    } finally {
      if (version === runLoadVersion.current) { setLoading(false); setRefreshing(false); }
    }
  };

  useEffect(() => {
    if (selectedCompanyId) {
      loadRuns(selectedCompanyId);
    }
    return () => { ++runLoadVersion.current; };
  }, [selectedCompanyId, companyIdsKey]);

  const selectedRunCompanyId = runs.find(run => run.id === selectedRunId)?.companyId || (selectedCompanyId === ALL_COMPANIES ? "" : selectedCompanyId);

  // Fetch run details when selectedRunId changes
  useEffect(() => {
    if (!selectedRunCompanyId || !selectedRunId) return;
    if(runs.find(r=>r.id===selectedRunId)?.requestedMode.startsWith("coding")) {setActiveRunDetails(null);return;}
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    const loadDetails = () => fetch(`/api/companies/${selectedRunCompanyId}/runs/${selectedRunId}`, { headers })
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
      .catch((err) => {if(!stopped) {setError(String(err));timer=setTimeout(loadDetails,3000);}});
    void loadDetails();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [selectedRunCompanyId, selectedRunId, runs.find(r=>r.id===selectedRunId)?.requestedMode]);

  useEffect(()=>{
    if(!selectedCompanyId) return;
    const timer=setInterval(()=>{if(!document.hidden) void loadRuns(selectedCompanyId);},selectedCompanyId === ALL_COMPANIES ? 30000 : 10000);
    return()=>clearInterval(timer);
  },[selectedCompanyId, companyIdsKey]);

  const loadOlderCodingRuns=async()=>{
    if(!codingCursor) return;
    if (selectedCompanyId === ALL_COMPANIES) {
      const headers: Record<string, string> = getStoredAuthToken() ? { authorization: `Bearer ${getStoredAuthToken()}` } : {};
      const entries = [...allCodingCursors.current].filter(([, cursor]) => cursor);
      try {
        const pages = await loadCompanyScopes(entries.map(([id]) => id), async id => {
          const response = await fetch(`/api/companies/${id}/code/monitor/runs?cursor=${encodeURIComponent(allCodingCursors.current.get(id)!)}`, { headers });
          if (!response.ok) throw new Error(`Monitoring HTTP ${response.status}`);
          return { id, data: await response.json() as { runs: CompanyRun[]; nextCursor: string | null } };
        });
        if (selectedCompanyRef.current !== ALL_COMPANIES) return;
        pages.forEach(page => allCodingCursors.current.set(page.id, page.data.nextCursor));
        setRuns(previous => [...previous, ...pages.flatMap(page => page.data.runs.map(run => ({ ...run, companyId: page.id }))).filter(run => !previous.some(old => old.id === run.id))]);
        setCodingCursor([...allCodingCursors.current.values()].some(Boolean) ? ALL_COMPANIES : null);
      } catch (error) { setError(String(error)); }
      return;
    }
    try {
      const token=getStoredAuthToken();
      const response=await fetch(`/api/companies/${selectedCompanyId}/code/monitor/runs?cursor=${encodeURIComponent(codingCursor)}`,{headers:token?{authorization:`Bearer ${token}`}:{}});
      if(!response.ok) throw new Error(`Monitoring HTTP ${response.status}`);
      const data=await response.json() as {runs:CompanyRun[];nextCursor:string|null};
      if(selectedCompanyRef.current!==selectedCompanyId) return;
      setRuns(previous=>[...previous,...data.runs.filter(r=>!previous.some(old=>old.id===r.id))]);setCodingCursor(data.nextCursor);historyCursor.current={companyId:selectedCompanyId,cursor:data.nextCursor};
    }catch(error){setError(String(error));}
  };

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
  const taskPlanEvent = activeRunDetails?.backgroundEvents?.find((event) => event.eventKey === "project-plan");
  const projectTasks = Array.isArray(taskPlanEvent?.details.tasks)
    ? taskPlanEvent.details.tasks as Array<{ id: string; title: string; role: string; agentId: string; dependsOn: string[] }>
    : [];

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

  const visiblePage = useProgressiveSettingsItems(filteredRuns, `${selectedCompanyId}:${statusFilter}:${searchQuery}`, 20);
  const selectedVisibleRun = filteredRuns.find(run => run.id === selectedRunId);
  const visibleRuns = selectedVisibleRun && !visiblePage.items.some(run => run.id === selectedRunId)
    ? [...visiblePage.items, selectedVisibleRun] : visiblePage.items;

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
      ) : (runs.length === 0 || viewMode === "presets") ? (
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
      ) : (
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
                  {visibleRuns.map((r) => {
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
                          {r.projectId && <span className="activity-run-project-tag">🌐 Project</span>}
                          {durationFormatted && <span className="activity-run-latency">{durationFormatted}</span>}
                          <span className="activity-run-id">#{r.id.slice(0, 8)}</span>
                        </div>
                      </button>
                    );
                  })}
                  <SettingsListMore state={visiblePage} label={language === "uk" ? "Завантажити ще" : "Load more"} />
                </div>
              )}
              {codingCursor && <button type="button" className="button-secondary" onClick={()=>void loadOlderCodingRuns()}>{language==="uk"?"Попередні Coding Runs":"Older Coding Runs"}</button>}
            </aside>

            {/* Main: Execution Trace & Policy Inspection */}
            <section className="activity-trace-detail">
            {runs.find(r=>r.id===selectedRunId)?.requestedMode.startsWith("coding") ? <CodeRunMonitor key={selectedRunId} companyId={selectedRunCompanyId} runId={selectedRunId} isUk={language==="uk"}/> : <>
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
            {selectedRunId ? (
              <CodeSnapshotPanel companyId={selectedRunCompanyId} runId={selectedRunId} isUk={language === "uk"} />
            ) : null}
          </section>
        </div>
      </div>
    )}
  </main>
  );
}
