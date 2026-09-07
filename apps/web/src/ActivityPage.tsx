import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";

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

export function ActivityPage() {
  const [companies, setCompanies] = useState<CompanyItem[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [runs, setRuns] = useState<CompanyRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [activeRunDetails, setActiveRunDetails] = useState<{
    run: CompanyRun;
    steps: RunStep[];
    toolAudit: ToolAuditItem[];
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
      setError(err instanceof Error ? err.message : "Failed to load activity");
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
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch(`/api/companies/${selectedCompanyId}/runs/${selectedRunId}`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load run details`);
        return (await res.json()) as {
          run: CompanyRun;
          steps: RunStep[];
          toolAudit: ToolAuditItem[];
        };
      })
      .then((data) => setActiveRunDetails(data))
      .catch(() => {});
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
        });
        setViewMode("trace");
        setTaskPrompt("");
        setDispatchNotice({
          type: "success",
          message: `Run dispatched: ${data.run.id.slice(0, 8)} (${data.run.status})`,
        });
        setTimeout(() => setDispatchNotice(null), 4000);
      }
    } catch (err) {
      setDispatchNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to dispatch agent run",
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

  const quickPrompts = [
    { label: "Market & Competitor Audit", prompt: "Conduct comprehensive competitor research and market positioning analysis" },
    { label: "Security & Capability Verification", prompt: "Audit company tool permissions, API access rules, and security gates" },
    { label: "Strategic Growth Roadmap", prompt: "Synthesize target customer ICP and actionable 90-day growth roadmap" },
  ];

  const currentCompany = companies.find((c) => c.id === selectedCompanyId);

  return (
    <main className="activity-page">
      {/* Hero Header matching /settings/capabilities */}
      <header className="marketplace-hero activity-header">
        <div>
          <p className="eyebrow">Observability & Audit</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>Activity & Run Trace</span>
          </h1>
          <p className="hero-copy">
            Detailed real-time execution trace, delegation steps, tool calls, latencies, and security decisions across company agent runs.
          </p>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /settings/capabilities */}
      <section className="overview-grid activity-stats-grid">
        <div>
          <strong>{totalRunsCount}</strong>
          <span>Total Runs</span>
          <small>Recorded agent executions</small>
        </div>
        <div>
          <strong>{completedRunsCount}</strong>
          <span>Completed</span>
          <small>Successful without faults</small>
        </div>
        <div>
          <strong>{activeRunsCount}</strong>
          <span>In Progress / Queued</span>
          <small>Active agent workloads</small>
        </div>
        <div>
          <strong>{totalSecurityDecisions}</strong>
          <span>Security Decisions</span>
          <small>Audited tool checks</small>
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
                Company:
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
              All <span className="tab-count">{totalRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "completed" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("completed"); }}
            >
              Completed <span className="tab-count">{completedRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "running" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("running"); }}
            >
              Running <span className="tab-count">{activeRunsCount}</span>
            </button>
            <button
              type="button"
              className={`activity-tab ${viewMode === "trace" && statusFilter === "failed" ? "active" : ""}`}
              onClick={() => { setViewMode("trace"); setStatusFilter("failed"); }}
            >
              Failed <span className="tab-count">{failedRunsCount}</span>
            </button>
          </div>

          <div className="activity-search-box">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input
              type="text"
              role="searchbox"
              placeholder="Search runs by task or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="activity-search-input"
              aria-label="Search runs"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                title="Clear search"
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
            title="Refresh runs"
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
            <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Task Dispatch Card: Live multi-agent execution runner */}
      <div className="activity-dispatch-card">
        <div className="activity-dispatch-header">
          <div className="activity-dispatch-title">
            <span className="activity-dispatch-icon">⚡</span>
            <div>
              <h3>Dispatch Company Agent Task</h3>
              <p>Trigger an autonomous multi-agent task execution and inspect real-time traces</p>
            </div>
          </div>
          <div className="activity-mode-selector">
            <label htmlFor="activity-mode-select">Execution Mode:</label>
            <select
              id="activity-mode-select"
              value={runMode}
              onChange={(e) => setRunMode(e.target.value as any)}
              className="select-input"
            >
              <option value="auto">Auto Orchestrate (Adaptive)</option>
              <option value="pipeline">Pipeline (Multi-Agent)</option>
              <option value="single">Single Agent (Fast)</option>
              <option value="fusion">Fusion (Multi-Model)</option>
            </select>
          </div>
        </div>

        <div className="activity-dispatch-input-row">
          <input
            type="text"
            className="activity-task-input"
            placeholder={
              currentCompany
                ? `Enter task for ${currentCompany.name} agents (e.g. 'Analyze competitor offerings and pricing')...`
                : "Enter task prompt for company agents..."
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
                <span>Dispatching...</span>
              </>
            ) : (
              <>
                <span>Dispatch Task</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </>
            )}
          </button>
        </div>

        <div className="activity-quick-prompts">
          <span className="quick-prompts-label">Presets:</span>
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

      {loading && <div className="workspace-notice">Loading run history...</div>}
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && companies.length === 0 && (
        <div className="activity-empty-state">
          <h2>No Companies Found</h2>
          <p>Activity & Run Trace tracks multi-agent runs dispatched within an AI Company context.</p>
          <Link to="/company" className="primary-action-btn">
            Create AI Company
          </Link>
        </div>
      )}

      {!loading && companies.length > 0 && (runs.length === 0 || viewMode === "presets") && (
        <div className="activity-empty-state">
          <h2>{runs.length === 0 ? "No Runs Recorded Yet" : "Task Presets & Starter Scenarios"}</h2>
          <p>
            {runs.length === 0
              ? "This company has no dispatched agent runs. Use the task dispatcher above or select a preset to generate real-time execution traces, delegation steps, and security tool audits."
              : "Select a preset below or enter a custom task above to generate real-time execution traces, delegation steps, and security tool audits."}
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
                Dispatch: {qp.label} →
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
                <span>View Execution History & Trace ({runs.length}) →</span>
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
                  <h3>Recent Executions ({filteredRuns.length})</h3>
                  <button
                    type="button"
                    className="sidebar-back-to-presets-btn"
                    onClick={() => setViewMode("presets")}
                    title="Back to presets"
                  >
                    ← 3 Presets
                  </button>
                </div>
              </div>
              {filteredRuns.length === 0 ? (
                <div className="activity-empty-filter">
                  <p>No runs match current filter criteria.</p>
                  <button type="button" className="clear-filter-btn" onClick={() => { setStatusFilter("all"); setSearchQuery(""); }}>
                    Clear Filters
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
                        <strong className="activity-run-task">{r.task}</strong>
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
                        title="Back to presets"
                        aria-label="Back to presets"
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
                          Mode: {activeRunDetails.run.executionMode || activeRunDetails.run.requestedMode || "auto"}
                        </span>
                        {activeRunDetails.run.omnirouteComboName && (
                          <span className="trace-combo-pill">
                            Combo: {activeRunDetails.run.omnirouteComboName}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="trace-header-main">
                      <h2>{activeRunDetails.run.task}</h2>
                    <div className="trace-meta-row">
                      <div className="trace-meta-item">
                        <span>Run ID:</span>
                        <code>{activeRunDetails.run.id}</code>
                        <button
                          type="button"
                          className="copy-btn"
                          onClick={() => copyToClipboard(activeRunDetails.run.id, "runId")}
                          title="Copy Run ID"
                        >
                          {copiedId === "runId" ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="trace-meta-item">
                        <span>Started:</span>
                        <strong>{new Date(activeRunDetails.run.createdAt).toLocaleString()}</strong>
                      </div>
                      {activeRunDetails.run.completedAt && (
                        <div className="trace-meta-item">
                          <span>Completed:</span>
                          <strong>{new Date(activeRunDetails.run.completedAt).toLocaleTimeString()}</strong>
                        </div>
                      )}
                      {activeRunDetails.run.totalDurationMs !== undefined && (
                        <div className="trace-meta-item">
                          <span>Duration:</span>
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
                        <strong>Final Output Result</strong>
                      </div>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={() => copyToClipboard(activeRunDetails.run.result || "", "result")}
                        title="Copy Result"
                      >
                        {copiedId === "result" ? "Copied" : "Copy"}
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
                        <strong>Execution Fault</strong>
                      </div>
                    </div>
                    <p>{activeRunDetails.run.errorMessage}</p>
                  </div>
                )}

                {/* Agent Delegation Steps */}
                <div className="trace-section">
                  <div className="trace-section-header">
                    <h3>
                      Agent Delegation Pipeline ({activeRunDetails.steps?.length ?? 0})
                    </h3>
                    <small>Multi-agent role coordination and handoffs</small>
                  </div>
                  <div className="trace-steps-list">
                    {(activeRunDetails.steps ?? []).map((step, idx) => (
                      <div key={step.id || idx} className="trace-step-item">
                        <span className="step-number">{step.stepOrder || idx + 1}</span>
                        <div className="trace-step-body">
                          <div className="trace-step-top">
                            <span className={`role-badge ${step.role}`}>{step.role}</span>
                            <span className={`step-status-badge ${step.status}`}>{step.status}</span>
                            <code className="trace-agent-id">Agent: {step.agentId.slice(0, 10)}...</code>
                          </div>
                          <div className="trace-step-meta">
                            <span>Model: <strong>{step.modelId || "auto"}</strong></span>
                            {step.lane !== undefined && <span>Lane: {step.lane}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                    {(!activeRunDetails.steps || activeRunDetails.steps.length === 0) && (
                      <div className="trace-empty-notice">
                        No delegation steps recorded for this single-turn task.
                      </div>
                    )}
                  </div>
                </div>

                {/* Tool Executions & Security Decisions */}
                <div className="trace-section">
                  <div className="trace-section-header">
                    <h3>
                      Tool Executions & Security Policy Gates ({activeRunDetails.toolAudit?.length ?? 0})
                    </h3>
                    <small>Canonical capability resolver checks and safety audits</small>
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
                            <span>Policy Reason:</span> <code>{tool.reasonCode}</code>
                          </div>
                        )}
                      </div>
                    ))}
                    {(!activeRunDetails.toolAudit || activeRunDetails.toolAudit.length === 0) && (
                      <div className="trace-empty-notice">
                        No external tool invocations triggered during this run.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="activity-placeholder-card">
                <span className="placeholder-icon">👈</span>
                <h3>Select a Run to Inspect</h3>
                <p>Pick an execution run from the left panel to review its timeline, delegation steps, and security audits.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    )}
  </main>
  );
}

