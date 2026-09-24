import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";

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

function formatStatus(status: string, t: (key: string) => string): { label: string; className: string } {
  const s = status.toLowerCase();
  if (s.includes("verified")) return { label: t("capabilityInspector.statuses.verified"), className: "verified" };
  if (s.includes("partially")) return { label: t("capabilityInspector.statuses.partial"), className: "partial" };
  if (s.includes("not_implemented") || s.includes("not implemented")) return { label: t("capabilityInspector.statuses.notImplemented"), className: "not-implemented" };
  if (s.includes("blocked")) return { label: t("capabilityInspector.statuses.blocked"), className: "blocked" };
  if (s === "allowed") return { label: t("capabilityInspector.statuses.allowed"), className: "allowed" };
  if (s === "denied") return { label: t("capabilityInspector.statuses.denied"), className: "denied" };
  if (s === "unavailable") return { label: t("capabilityInspector.statuses.unavailable"), className: "unavailable" };
  if (s.includes("approval")) return { label: t("capabilityInspector.statuses.requiresApproval"), className: "requires-approval" };
  return { label: status.replace(/_/g, " "), className: "default" };
}

function formatType(type: string, t: (key: string) => string): string {
  switch (type.toLowerCase()) {
    case "runtime": return t("capabilityInspector.types.runtime");
    case "configuration": return t("capabilityInspector.types.config");
    case "orchestration": return t("capabilityInspector.types.orchestr");
    case "tool": return t("capabilityInspector.types.tool");
    case "article": return t("capabilityInspector.types.article");
    case "security_ops": return t("capabilityInspector.types.secOps");
    default: return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

function formatRisk(risk: string, t: (key: string) => string): string {
  switch (risk.toLowerCase()) {
    case "low": return t("capabilityInspector.risks.low");
    case "medium": return t("capabilityInspector.risks.medium");
    case "high": return t("capabilityInspector.risks.high");
    case "critical": return t("capabilityInspector.risks.critical");
    default: return risk.charAt(0).toUpperCase() + risk.slice(1);
  }
}

export function getCapabilityDisplayName(item: { capabilityId?: string; name: string }, t?: (key: string) => string): string {
  if (item.capabilityId === "system.dashboard" || item.name === "Dashboard") {
    return t ? t("capabilityInspector.connectedServices") : "Connected Services";
  }
  return item.name;
}

export function CapabilityInspectorPage() {
  const { t } = useTranslation();
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
          setError(err instanceof Error ? err.message : t("capabilityInspector.errorLoad"));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [slice, t]);

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
        getCapabilityDisplayName(item, t).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.capabilityId.toLowerCase().includes(term) ||
        item.domain.toLowerCase().includes(term) ||
        String(item.id).includes(term) ||
        item.type.toLowerCase().includes(term) ||
        item.status.toLowerCase().includes(term)
    );
  }, [report?.items, search, t]);

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
    { label: t("capabilityInspector.slices.all"), value: "all", count: report?.counts.all ?? 306 },
    { label: t("capabilityInspector.slices.agentCallable"), value: "agent-callable", count: report?.counts.agentCallable ?? 42 },
    { label: t("capabilityInspector.slices.runtimeOnly"), value: "runtime-only", count: report?.counts.runtimeOnly ?? 264 },
    { label: t("capabilityInspector.slices.userVisible"), value: "user-visible", count: report?.counts.userVisible ?? 42 },
    { label: t("capabilityInspector.slices.automatic"), value: "automatic", count: report?.counts.automatic ?? 234 },
    { label: t("capabilityInspector.slices.allowed"), value: "allowed", count: report?.counts.allowed ?? 306 },
    { label: t("capabilityInspector.slices.requiresApproval"), value: "requires-approval", count: report?.counts.requiresApproval ?? 23 },
  ];

  return (
    <main className="inspector-page">
      <header className="marketplace-hero inspector-header">
        <div>
          <p className="eyebrow">{t("capabilityInspector.eyebrow")}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={t("capabilityInspector.backAria")} title={t("capabilityInspector.backAria")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>{t("capabilityInspector.title")}</span>
          </h1>
          <p className="hero-copy">
            {t("capabilityInspector.heroCopy")}
          </p>
        </div>
      </header>

      <section className="overview-grid inspector-stats-grid">
        <div>
          <strong>{report?.counts.all ?? 306}</strong>
          <span>{t("capabilityInspector.stats.totalLabel")}</span>
          <small>{t("capabilityInspector.stats.totalDesc")}</small>
        </div>
        <div>
          <strong>{report?.counts.agentCallable ?? 42}</strong>
          <span>{t("capabilityInspector.stats.agentCallableLabel")}</span>
          <small>{t("capabilityInspector.stats.agentCallableDesc")}</small>
        </div>
        <div>
          <strong>{report?.counts.runtimeOnly ?? 264}</strong>
          <span>{t("capabilityInspector.stats.runtimeOnlyLabel")}</span>
          <small>{t("capabilityInspector.stats.runtimeOnlyDesc")}</small>
        </div>
        <div>
          <strong>{report?.counts.requiresApproval ?? 23}</strong>
          <span>{t("capabilityInspector.stats.requiresApprovalLabel")}</span>
          <small>{t("capabilityInspector.stats.requiresApprovalDesc")}</small>
        </div>
      </section>

      <div className="inspector-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("capabilityInspector.controls.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label={t("capabilityInspector.controls.searchAriaLabel")}
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label={t("capabilityInspector.controls.clearSearch")}
              title={t("capabilityInspector.controls.clearSearch")}
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
            {t("capabilityInspector.controls.showing", { start: startIdx, end: endIdx, total: totalItems })}
            {search ? ` ${t("capabilityInspector.controls.matching", { term: search })}` : ""}
          </span>
          {copiedId && <span className="copy-notice">{t("capabilityInspector.controls.copied", { id: copiedId })}</span>}
        </div>
        <div className="status-right">
          <label className="page-size-label">
            <span>{t("capabilityInspector.controls.perPage")}</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="page-size-select"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={-1}>{t("capabilityInspector.controls.allCount", { total: totalItems })}</option>
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
                    title={t("capabilityInspector.table.sortId")}
                  >
                    {t("capabilityInspector.table.colId")} {sortField === "id" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ minWidth: "140px", cursor: "pointer" }}
                    onClick={() => handleSort("name")}
                    title={t("capabilityInspector.table.sortName")}
                  >
                    {t("capabilityInspector.table.colName")} {sortField === "name" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "170px", cursor: "pointer" }}
                    onClick={() => handleSort("capabilityId")}
                    title={t("capabilityInspector.table.sortCanonicalId")}
                  >
                    {t("capabilityInspector.table.colCanonicalId")} {sortField === "capabilityId" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "85px", cursor: "pointer" }}
                    onClick={() => handleSort("domain")}
                    title={t("capabilityInspector.table.sortDomain")}
                  >
                    {t("capabilityInspector.table.colDomain")} {sortField === "domain" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "85px", cursor: "pointer" }}
                    onClick={() => handleSort("type")}
                    title={t("capabilityInspector.table.sortType")}
                  >
                    {t("capabilityInspector.table.colType")} {sortField === "type" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th style={{ width: "90px" }}>{t("capabilityInspector.table.colCallable")}</th>
                  <th
                    style={{ width: "70px", cursor: "pointer" }}
                    onClick={() => handleSort("risk")}
                    title={t("capabilityInspector.table.sortRisk")}
                  >
                    {t("capabilityInspector.table.colRisk")} {sortField === "risk" && (sortAsc ? "▲" : "▼")}
                  </th>
                  <th
                    style={{ width: "88px", cursor: "pointer" }}
                    onClick={() => handleSort("status")}
                    title={t("capabilityInspector.table.sortStatus")}
                  >
                    {t("capabilityInspector.table.colStatus")} {sortField === "status" && (sortAsc ? "▲" : "▼")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => {
                  const st = formatStatus(item.status, t);
                  return (
                    <tr key={item.id}>
                      <td style={{ textAlign: "center" }}>
                        <span className="inventory-badge">#{item.id}</span>
                      </td>
                      <td>
                        <strong className="item-name">{getCapabilityDisplayName(item, t)}</strong>
                      </td>
                      <td>
                        <code
                          className="canonical-code"
                          onClick={() => copyCanonicalId(item.capabilityId)}
                          title={t("capabilityInspector.table.copyTooltip")}
                        >
                          {item.capabilityId}
                        </code>
                      </td>
                      <td>
                        <span className={`domain-badge domain-${item.domain}`}>{item.domain}</span>
                      </td>
                      <td>
                        <span className={`type-badge ${item.type}`}>{formatType(item.type, t)}</span>
                      </td>
                      <td>
                        <span className={`callable-badge ${item.agentCallable ? "yes" : "no"}`}>
                          <span className="status-dot-sm" />
                          {item.agentCallable ? t("capabilityInspector.callable.callable") : t("capabilityInspector.callable.internal")}
                        </span>
                      </td>
                      <td>
                        <span className={`risk-badge ${item.risk}`}>
                          {formatRisk(item.risk, t)}
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
                      {t("capabilityInspector.table.empty")}
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
                {t("capabilityInspector.table.prev")}
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
                {t("capabilityInspector.table.next")}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
