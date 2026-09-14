import { useEffect, useMemo, useState } from "react";
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

type SortField = "id" | "name" | "capabilityId" | "domain" | "type" | "risk" | "status";

function formatStatus(status: string): { label: string; className: string } {
  const s = status.toLowerCase();
  if (s.includes("verified")) return { label: "Verified", className: "verified" };
  if (s.includes("partially")) return { label: "Partial", className: "partial" };
  if (s.includes("not_implemented") || s.includes("not implemented")) return { label: "Not implemented", className: "not-implemented" };
  if (s.includes("blocked")) return { label: "Blocked", className: "blocked" };
  if (s === "allowed") return { label: "Allowed", className: "allowed" };
  if (s === "denied") return { label: "Denied", className: "denied" };
  if (s === "unavailable") return { label: "Unavailable", className: "unavailable" };
  if (s.includes("approval")) return { label: "Approval Req.", className: "requires-approval" };
  return { label: status.replace(/_/g, " "), className: "default" };
}

function formatType(type: string): string {
  switch (type.toLowerCase()) {
    case "runtime": return "Runtime";
    case "configuration": return "Config";
    case "orchestration": return "Orchestr.";
    case "tool": return "Tool";
    case "article": return "Article";
    case "security_ops": return "SecOps";
    default: return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export function getCapabilityDisplayName(item: { capabilityId?: string; name: string }): string {
  if (item.capabilityId === "system.dashboard" || item.name === "Dashboard") {
    return "Connected Services";
  }
  return item.name;
}

export function CapabilityInspectorPage() {
  const [slice, setSlice] = useState<InspectorSlice>("all");
  const [search, setSearch] = useState("");
  const [report, setReport] = useState<InspectorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination & Sorting State
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [sortField, setSortField] = useState<SortField>("id");
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  // Reset page on filter or search change
  useEffect(() => {
    setCurrentPage(1);
  }, [slice, search, pageSize]);

  function copyCanonicalId(id: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(id).catch(() => undefined);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
    setCurrentPage(1);
  }

  const filteredItems = useMemo(() => {
    const raw = report?.items ?? [];
    if (!search.trim()) return raw;
    const term = search.toLowerCase();
    return raw.filter(
      (item) =>
        getCapabilityDisplayName(item).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.capabilityId.toLowerCase().includes(term) ||
        item.domain.toLowerCase().includes(term) ||
        String(item.id).includes(term) ||
        item.type.toLowerCase().includes(term) ||
        item.status.toLowerCase().includes(term)
    );
  }, [report?.items, search]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [filteredItems, sortField, sortAsc]);

  const totalItems = sortedItems.length;
  const totalPages = pageSize === -1 ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const pageItems =
    pageSize === -1
      ? sortedItems
      : sortedItems.slice((validPage - 1) * pageSize, validPage * pageSize);

  const startIdx = totalItems === 0 ? 0 : (validPage - 1) * pageSize + 1;
  const endIdx = pageSize === -1 ? totalItems : Math.min(validPage * pageSize, totalItems);

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
            type="text"
            role="searchbox"
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
        <div className="status-left">
          <span>
            Showing <strong>{startIdx}–{endIdx}</strong> of <strong>{totalItems}</strong> capabilities
            {search ? ` matching "${search}"` : ""}
          </span>
          {copiedId && <span className="copy-notice">✓ Copied {copiedId}</span>}
        </div>
        <div className="status-right">
          <label className="page-size-label">
            <span>Per page:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="page-size-select"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={-1}>All ({totalItems})</option>
            </select>
          </label>
        </div>
      </div>
      {error && <div className="workspace-notice error">{error}</div>}

      {!loading && !error && (
        <>
          <div className="inspector-table-container">
            <table className="inspector-table">
              <thead>
                <tr>
                  <th
                    style={{ width: "46px", textAlign: "center", cursor: "pointer" }}
                    onClick={() => handleSort("id")}
                    title="Sort by ID"
                  >
                    ID {sortField === "id" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ minWidth: "140px", cursor: "pointer" }}
                    onClick={() => handleSort("name")}
                    title="Sort by Name"
                  >
                    Name {sortField === "name" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "170px", cursor: "pointer" }}
                    onClick={() => handleSort("capabilityId")}
                    title="Sort by Canonical ID"
                  >
                    Canonical ID {sortField === "capabilityId" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "85px", cursor: "pointer" }}
                    onClick={() => handleSort("domain")}
                    title="Sort by Domain"
                  >
                    Domain {sortField === "domain" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "85px", cursor: "pointer" }}
                    onClick={() => handleSort("type")}
                    title="Sort by Type"
                  >
                    Type {sortField === "type" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th style={{ width: "90px" }}>Callable</th>
                  <th
                    style={{ width: "70px", cursor: "pointer" }}
                    onClick={() => handleSort("risk")}
                    title="Sort by Risk"
                  >
                    Risk {sortField === "risk" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "88px", cursor: "pointer" }}
                    onClick={() => handleSort("status")}
                    title="Sort by Status"
                  >
                    Status {sortField === "status" && (sortAsc ? "▲" : "▼")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => {
                  const st = formatStatus(item.status);
                  return (
                    <tr key={item.id}>
                      <td style={{ textAlign: "center" }}>
                        <span className="inventory-badge">#{item.id}</span>
                      </td>
                      <td>
                        <strong className="item-name">{getCapabilityDisplayName(item)}</strong>
                      </td>
                      <td>
                        <code
                          className="canonical-code"
                          onClick={() => copyCanonicalId(item.capabilityId)}
                          title="Click to copy canonical ID"
                        >
                          {item.capabilityId}
                        </code>
                      </td>
                      <td>
                        <span className={`domain-badge domain-${item.domain}`}>{item.domain}</span>
                      </td>
                      <td>
                        <span className={`type-badge ${item.type}`}>{formatType(item.type)}</span>
                      </td>
                      <td>
                        <span className={`callable-badge ${item.agentCallable ? "yes" : "no"}`}>
                          <span className="status-dot-sm" />
                          {item.agentCallable ? "Callable" : "Internal"}
                        </span>
                      </td>
                      <td>
                        <span className={`risk-badge ${item.risk}`}>
                          {item.risk.charAt(0).toUpperCase() + item.risk.slice(1)}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${st.className}`}>
                          {st.className === "verified" && "✓ "}
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {pageItems.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "2.5rem 1rem", color: "var(--npati-gray-500)" }}>
                      No capabilities match the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="inspector-pagination">
              <button
                type="button"
                className="pagination-btn"
                disabled={validPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                ← Previous
              </button>
              <div className="pagination-pages">
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  let pageNum = i + 1;
                  if (totalPages > 7) {
                    if (validPage > 4 && validPage < totalPages - 3) {
                      pageNum = validPage - 3 + i;
                    } else if (validPage >= totalPages - 3) {
                      pageNum = totalPages - 6 + i;
                    }
                  }
                  return (
                    <button
                      key={pageNum}
                      type="button"
                      className={`page-number-btn ${validPage === pageNum ? "active" : ""}`}
                      onClick={() => setCurrentPage(pageNum)}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="pagination-btn"
                disabled={validPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
