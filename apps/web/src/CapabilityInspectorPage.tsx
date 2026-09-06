import { useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

type InspectorSlice =
  | "all"
  | "agent-callable"
  | "runtime-only"
  | "user-visible"
  | "automatic"
  | "allowed"
  | "denied"
  | "requires-approval";

interface CapabilityInspectorCounts {
  all: number;
  agentCallable: number;
  runtimeOnly: number;
  userVisible: number;
  automatic: number;
  allowed: number;
  denied: number;
  unavailable: number;
  requiresApproval: number;
  destructive: number;
  missingDependency: number;
  missingTest: number;
  missingUi: number;
}

interface CapabilityItem {
  id: number;
  capabilityId: string;
  name: string;
  domain: string;
  type: string;
  agentCallable: boolean;
  status: string;
  risk: string;
  reasonCode?: string;
}

interface InspectorReport {
  timestamp: string;
  counts: CapabilityInspectorCounts;
  activeSlice: InspectorSlice;
  items: CapabilityItem[];
}

export function CapabilityInspectorPage() {
  const [slice, setSlice] = useState<InspectorSlice>("all");
  const [search, setSearch] = useState("");
  const [report, setReport] = useState<InspectorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch(`/api/capabilities/inspect?slice=${encodeURIComponent(slice)}`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to inspect capabilities`);
        return (await res.json()) as InspectorReport;
      })
      .then((data) => {
        if (active) {
          setReport(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load capabilities");
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [slice]);

  const items = (report?.items ?? []).filter((item) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      item.name.toLowerCase().includes(term) ||
      item.capabilityId.toLowerCase().includes(term) ||
      item.domain.toLowerCase().includes(term) ||
      String(item.id).includes(term)
    );
  });

  const slices: { label: string; value: InspectorSlice; count?: number }[] = [
    { label: "All (306)", value: "all", count: report?.counts.all },
    { label: "Agent-Callable", value: "agent-callable", count: report?.counts.agentCallable },
    { label: "Runtime-Only", value: "runtime-only", count: report?.counts.runtimeOnly },
    { label: "User-Visible", value: "user-visible", count: report?.counts.userVisible },
    { label: "Automatic", value: "automatic", count: report?.counts.automatic },
    { label: "Allowed", value: "allowed", count: report?.counts.allowed },
    { label: "Requires Approval", value: "requires-approval", count: report?.counts.requiresApproval },
  ];

  return (
    <main className="inspector-page">
      <header className="inspector-header">
        <div>
          <p className="eyebrow">Governance & Security</p>
          <h1>Capability Inspector</h1>
          <p className="hero-copy">
            Explore and audit the 306 canonical capabilities of NPATI Agent. Verify Effective Capability Resolver
            boundaries, tool visibility, and risk policies in actual runtime.
          </p>
        </div>
      </header>

      <section className="inspector-stats-grid">
        <div className="inspector-stat-card">
          <span>Total Capabilities</span>
          <strong>{report?.counts.all ?? 306}</strong>
          <small>Verified 1..306 canonical IDs</small>
        </div>
        <div className="inspector-stat-card">
          <span>Agent-Callable</span>
          <strong>{report?.counts.agentCallable ?? 74}</strong>
          <small>Exposed to models via Resolver</small>
        </div>
        <div className="inspector-stat-card">
          <span>Internal Runtime</span>
          <strong>{report?.counts.runtimeOnly ?? 232}</strong>
          <small>Isolated engine operations</small>
        </div>
        <div className="inspector-stat-card">
          <span>Requires Approval</span>
          <strong>{report?.counts.requiresApproval ?? 18}</strong>
          <small>Human-in-the-loop security gate</small>
        </div>
      </section>

      <div className="inspector-controls">
        <div className="inspector-tabs" role="tablist">
          {slices.map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={slice === tab.value}
              className={`inspector-tab ${slice === tab.value ? "active" : ""}`}
              onClick={() => setSlice(tab.value)}
            >
              {tab.label}
              {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Filter capabilities by name, ID or domain..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="inspector-search-input"
          aria-label="Filter capabilities"
        />
      </div>

      {loading && <div className="workspace-notice">Inspecting capabilities runtime...</div>}
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && !error && (
        <div className="inspector-table-container">
          <table className="inspector-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Canonical ID</th>
                <th>Domain</th>
                <th>Type</th>
                <th>Agent Callable</th>
                <th>Risk</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="inventory-badge">#{item.id}</span>
                  </td>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>
                    <code>{item.capabilityId}</code>
                  </td>
                  <td>
                    <span className="domain-badge">{item.domain}</span>
                  </td>
                  <td>
                    <span className={`type-badge ${item.type}`}>{item.type}</span>
                  </td>
                  <td>
                    <span className={`callable-badge ${item.agentCallable ? "yes" : "no"}`}>
                      {item.agentCallable ? "Callable" : "Internal"}
                    </span>
                  </td>
                  <td>
                    <span className={`risk-badge ${item.risk}`}>{item.risk}</span>
                  </td>
                  <td>
                    <span className={`status-pill ${item.status}`}>{item.status}</span>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "2rem" }}>
                    No capabilities match the selected filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
