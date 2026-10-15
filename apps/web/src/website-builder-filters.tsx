import type { websiteBuilderCopy } from "./website-builder-constants";

export interface WebsiteFiltersBarProps {
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  frameworkFilter: string;
  setFrameworkFilter: (val: string) => void;
  statusFilter: "all" | "active" | "archived";
  setStatusFilter: (val: "all" | "active" | "archived") => void;
  t: (typeof websiteBuilderCopy)["en"];
}

export function WebsiteFiltersBar({
  searchQuery,
  setSearchQuery,
  frameworkFilter,
  setFrameworkFilter,
  statusFilter,
  setStatusFilter,
  t,
}: WebsiteFiltersBarProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: "12px",
        marginBottom: "24px",
        flexWrap: "wrap",
        alignItems: "center",
        background: "#ffffff",
        padding: "14px 18px",
        borderRadius: "14px",
        border: "1px solid #e4e4e7",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
      }}
    >
      <div className="inspector-search-box" style={{ flex: "1 1 260px" }}>
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          role="searchbox"
          placeholder={t.searchPlaceholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="inspector-search-input"
          aria-label={t.searchPlaceholder}
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

      <select
        value={frameworkFilter}
        onChange={(e) => setFrameworkFilter(e.target.value)}
        style={{
          height: "44px",
          padding: "0 14px",
          background: "var(--npati-gray-50)",
          border: "1px solid var(--npati-gray-100)",
          borderRadius: "12px",
          color: "#111111",
          fontSize: "13.5px",
          fontWeight: 500,
          cursor: "pointer",
          outline: "none",
        }}
      >
        <option value="all">{t.filterAll}</option>
        <option value="static">HTML / CSS</option>
        <option value="nextjs">Next.js</option>
        <option value="vite">Vite</option>
        <option value="astro">Astro</option>
      </select>

      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "archived")}
        style={{
          height: "44px",
          padding: "0 14px",
          background: "var(--npati-gray-50)",
          border: "1px solid var(--npati-gray-100)",
          borderRadius: "12px",
          color: "#111111",
          fontSize: "13.5px",
          fontWeight: 500,
          cursor: "pointer",
          outline: "none",
        }}
      >
        <option value="active">{t.statusActive}</option>
        <option value="all">{t.filterStatusAll}</option>
        <option value="archived">{t.statusArchived}</option>
      </select>
    </div>
  );
}
