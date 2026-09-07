import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
    { label: "All", value: "all", count: report?.counts.all ?? 306 },
    { label: "Agent-Callable", value: "agent-callable", count: report?.counts.agentCallable ?? 42 },
    { label: "Runtime-Only", value: "runtime-only", count: report?.counts.runtimeOnly ?? 264 },
    { label: "User-Visible", value: "user-visible", count: report?.counts.userVisible ?? 42 },
    { label: "Automatic", value: "automatic", count: report?.counts.automatic ?? 234 },
    { label: "Allowed", value: "allowed", count: report?.counts.allowed ?? 306 },
    { label: "Requires Approval", value: "requires-approval", count: report?.counts.requiresApproval ?? 23 },
  ];

  return (
    <main className="inspector-page">
      <header className="marketplace-hero inspector-header">
        <div>
          <p className="eyebrow">Governance & Security</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>Capability Inspector</span>
          </h1>
          <p className="hero-copy">
            Explore and audit the 306 canonical capabilities of NPATI Agent. Verify Effective Capability Resolver
            boundaries, tool visibility, and risk policies in actual runtime.
          </p>
        </div>
      </header>

      <section className="overview-grid inspector-stats-grid">
        <div>
          <strong>{report?.counts.all ?? 306}</strong>
          <span>total capabilities</span>
          <small>Verified 1..306 canonical IDs</small>
        </div>
        <div>
          <strong>{report?.counts.agentCallable ?? 42}</strong>
          <span>agent-callable</span>
          <small>Exposed to models via Resolver</small>
        </div>
        <div>
          <strong>{report?.counts.runtimeOnly ?? 264}</strong>
          <span>internal runtime</span>
          <small>Isolated engine operations</small>
        </div>
        <div>
          <strong>{report?.counts.requiresApproval ?? 23}</strong>
          <span>requires approval</span>
          <small>Human-in-the-loop security gate</small>
        </div>
      </section>

      <div className="inspector-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Filter capabilities by name, ID or domain..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label="Filter capabilities"
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          {slices.map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={slice === tab.value}
              className={`inspector-tab ${slice === tab.value ? "active" : ""}`}
              onClick={() => setSlice(tab.value)}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && <small className="tab-count">{tab.count}</small>}
            </button>
          ))}
        </div>
      </div>

      <div className="inspector-table-status">
        <p className="showing-copy">
          Showing <strong>{items.length}</strong> {items.length === 1 ? "capability" : "capabilities"}
          {search ? ` matching "${search}"` : ""}
        </p>
      </div>

      {loading && <div className="workspace-notice">Inspecting capabilities runtime...</div>}
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && !error && (
        <div className="inspector-table-container">
          <table className="inspector-table">
            <thead>
              <tr>
                <th style={{ width: "64px" }}>ID</th>
                <th style={{ minWidth: "160px" }}>Name</th>
                <th style={{ minWidth: "175px" }}>Canonical ID</th>
                <th style={{ width: "95px" }}>Domain</th>
                <th style={{ width: "110px" }}>Type</th>
                <th style={{ width: "105px" }}>Callable</th>
                <th style={{ width: "85px" }}>Risk</th>
                <th style={{ width: "95px" }}>Status</th>
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
                  <td colSpan={8} style={{ textAlign: "center", padding: "2.5rem 1rem", color: "var(--npati-gray-500)" }}>
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
