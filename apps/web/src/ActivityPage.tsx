import { useEffect, useState } from "react";
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
  createdAt: string;
  completedAt?: string;
}

interface CompanyItem {
  id: string;
  name: string;
}

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
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch(`/api/companies/${selectedCompanyId}/runs?limit=30`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load runs`);
        return (await res.json()) as { runs?: CompanyRun[] };
      })
      .then((data) => {
        const items = data.runs ?? [];
        setRuns(items);
        if (items.length > 0 && items[0]) {
          setSelectedRunId(items[0].id);
        } else {
          setActiveRunDetails(null);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load activity");
        setLoading(false);
      });
  }, [selectedCompanyId]);

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

  return (
    <main className="activity-page">
      <header className="activity-header">
        <div>
          <p className="eyebrow">Observability & Audit</p>
          <h1>Activity & Run Trace</h1>
          <p className="hero-copy">
            Detailed real-time execution trace, delegation steps, tool calls, latencies, and security decisions.
          </p>
        </div>
        {companies.length > 0 && (
          <div className="activity-company-selector">
            <label htmlFor="activity-company-select">Company:</label>
            <select
              id="activity-company-select"
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="select-input"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      {loading && <div className="workspace-notice">Loading run history...</div>}
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && companies.length === 0 && (
        <div className="placeholder-card">
          <span>No companies found</span>
          <h2>Create a Company first</h2>
          <p>Activity and Run Trace track multi-agent runs dispatched within an AI Company context.</p>
        </div>
      )}

      {!loading && companies.length > 0 && runs.length === 0 && (
        <div className="placeholder-card">
          <span>No runs yet</span>
          <h2>No activity recorded for this company</h2>
          <p>Dispatched agent tasks will produce full trace records here.</p>
        </div>
      )}

      {!loading && runs.length > 0 && (
        <div className="activity-layout">
          <aside className="activity-runs-sidebar" aria-label="Runs list">
            <h3>Recent Runs ({runs.length})</h3>
            <div className="activity-run-list">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className={`activity-run-item ${selectedRunId === r.id ? "active" : ""}`}
                  onClick={() => setSelectedRunId(r.id)}
                >
                  <div className="activity-run-item-top">
                    <span className={`status-pill ${r.status}`}>{r.status}</span>
                    <small>{new Date(r.createdAt).toLocaleTimeString()}</small>
                  </div>
                  <strong className="activity-run-task">{r.task.slice(0, 60)}...</strong>
                  <span className="activity-run-meta">
                    Mode: {r.executionMode || r.requestedMode} · ID: {r.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="activity-trace-detail">
            {activeRunDetails ? (
              <div className="trace-card">
                <header className="trace-card-header">
                  <div>
                    <span className={`status-pill ${activeRunDetails.run.status}`}>
                      {activeRunDetails.run.status}
                    </span>
                    <h2>Task: {activeRunDetails.run.task}</h2>
                    <small>
                      Run ID: <code>{activeRunDetails.run.id}</code> · Started:{" "}
                      {new Date(activeRunDetails.run.createdAt).toLocaleString()}
                    </small>
                  </div>
                </header>

                {activeRunDetails.run.result && (
                  <div className="trace-result-box">
                    <strong>Final Result</strong>
                    <p>{activeRunDetails.run.result}</p>
                  </div>
                )}

                {activeRunDetails.run.errorMessage && (
                  <div className="trace-error-box">
                    <strong>Error</strong>
                    <p>{activeRunDetails.run.errorMessage}</p>
                  </div>
                )}

                <div className="trace-section">
                  <h3>Agent Delegation Steps ({activeRunDetails.steps?.length ?? 0})</h3>
                  <div className="trace-steps-list">
                    {(activeRunDetails.steps ?? []).map((step, idx) => (
                      <div key={step.id || idx} className="trace-step-item">
                        <span className="step-number">{idx + 1}</span>
                        <div>
                          <strong>Role: {step.role}</strong>
                          <small>
                            Agent ID: {step.agentId.slice(0, 8)} · Status: {step.status} · Model:{" "}
                            {step.modelId || "auto"}
                          </small>
                        </div>
                      </div>
                    ))}
                    {(!activeRunDetails.steps || activeRunDetails.steps.length === 0) && (
                      <small>No delegation steps recorded.</small>
                    )}
                  </div>
                </div>

                <div className="trace-section">
                  <h3>Tool Executions & Security Decisions ({activeRunDetails.toolAudit?.length ?? 0})</h3>
                  <div className="trace-tool-list">
                    {(activeRunDetails.toolAudit ?? []).map((tool, idx) => (
                      <div key={tool.id || idx} className={`trace-tool-item ${tool.decision}`}>
                        <div className="trace-tool-item-header">
                          <span className={`decision-badge ${tool.decision}`}>{tool.decision}</span>
                          <code>{tool.toolName}</code>
                          <span className={`status-badge ${tool.status}`}>{tool.status}</span>
                          {tool.latencyMs !== undefined && <small>{tool.latencyMs}ms</small>}
                        </div>
                        {tool.errorMessage && <p className="trace-tool-error">{tool.errorMessage}</p>}
                        {tool.reasonCode && <small className="trace-tool-reason">Reason: {tool.reasonCode}</small>}
                      </div>
                    ))}
                    {(!activeRunDetails.toolAudit || activeRunDetails.toolAudit.length === 0) && (
                      <small>No tool executions in this run.</small>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="placeholder-card">
                <p>Select a run from the left panel to inspect its execution trace.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
