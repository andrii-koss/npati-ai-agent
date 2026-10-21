import React from "react";
import type { FilterItem, FilterOperator } from "./types";

export interface DataStudioRowsViewProps {
  isUk: boolean;
  environment: "dev" | "prod";
  currentTable: { name: string; columns: { name: string; type: string }[] };
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  loadRows: () => Promise<void>;
  filters: FilterItem[];
  setFilters: React.Dispatch<React.SetStateAction<FilterItem[]>>;
  selectedRowIds: Set<string>;
  setSelectedRowIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleBulkDelete: () => Promise<void>;
  handleExport: (format: "csv" | "json") => Promise<void>;
  openCreateRowDrawer: () => void;
  openEditRowDrawer: (row: Record<string, unknown>) => void;
  handleDeleteRow: (rowId: string) => Promise<void>;
  onOpenImportModal: () => void;
  rowsLoading: boolean;
  rows: Record<string, unknown>[];
  sortField: string;
  setSortField: (field: string) => void;
  sortDir: "asc" | "desc";
  setSortDir: React.Dispatch<React.SetStateAction<"asc" | "desc">>;
  pageLimit: number;
  setPageLimit: (limit: number) => void;
  pageOffset: number;
  setPageOffset: React.Dispatch<React.SetStateAction<number>>;
}

export function DataStudioRowsView({
  isUk,
  environment,
  currentTable,
  searchQuery,
  setSearchQuery,
  loadRows,
  filters,
  setFilters,
  selectedRowIds,
  setSelectedRowIds,
  handleBulkDelete,
  handleExport,
  openCreateRowDrawer,
  openEditRowDrawer,
  handleDeleteRow,
  onOpenImportModal,
  rowsLoading,
  rows,
  sortField,
  setSortField,
  sortDir,
  setSortDir,
  pageLimit,
  setPageLimit,
  pageOffset,
  setPageOffset,
}: DataStudioRowsViewProps) {
  return (
    <div className="data-view-content">
      {/* Data Toolbar: Search, Filters, Add Row, Import, Export, Bulk Delete */}
      <div className="data-view-toolbar">
        <div className="toolbar-search-filter">
          <div className="search-input-box" style={{ display: "flex", alignItems: "center", position: "relative" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: "10px", color: "#94a3b8", pointerEvents: "none" }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              placeholder={isUk ? "Пошук по рядках…" : "Search rows…"}
              value={searchQuery}
              style={{ paddingLeft: "32px" }}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void loadRows()}
            />
          </div>

          {/* Add filter button */}
          <button
            type="button"
            className="button-secondary"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            onClick={() =>
              setFilters((prev) => [
                ...prev,
                { field: currentTable.columns[1]?.name || "id", operator: "eq", value: "" },
              ])
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            <span>{isUk ? "Фільтр" : "Filter"}</span>
          </button>
        </div>

        <div className="toolbar-actions">
          {selectedRowIds.size > 0 && environment === "dev" && (
            <button type="button" className="danger-button" onClick={() => void handleBulkDelete()}>
              {isUk ? `Видалити (${selectedRowIds.size})` : `Delete (${selectedRowIds.size})`}
            </button>
          )}

          <button
            type="button"
            className="button-secondary"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            onClick={() => void handleExport("csv")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>CSV</span>
          </button>
          <button
            type="button"
            className="button-secondary"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            onClick={() => void handleExport("json")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>JSON</span>
          </button>

          {environment === "dev" && (
            <>
              <button
                type="button"
                className="button-secondary"
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                onClick={onOpenImportModal}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{isUk ? "Імпорт" : "Import"}</span>
              </button>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={openCreateRowDrawer}
              >
                ＋ {isUk ? "Новий рядок" : "New Row"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filter builders if any */}
      {filters.length > 0 && (
        <div className="filter-chips-row">
          {filters.map((f, idx) => (
            <div key={idx} className="filter-chip">
              <select
                value={f.field}
                onChange={(e) => {
                  const next = [...filters];
                  next[idx]!.field = e.target.value;
                  setFilters(next);
                }}
              >
                {currentTable.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={f.operator}
                onChange={(e) => {
                  const next = [...filters];
                  next[idx]!.operator = e.target.value as FilterOperator;
                  setFilters(next);
                }}
              >
                <option value="eq">=</option>
                <option value="ne">≠</option>
                <option value="gt">&gt;</option>
                <option value="gte">&gt;=</option>
                <option value="lt">&lt;</option>
                <option value="lte">&lt;=</option>
              </select>
              <input
                type="text"
                placeholder="value"
                value={f.value}
                onChange={(e) => {
                  const next = [...filters];
                  next[idx]!.value = e.target.value;
                  setFilters(next);
                }}
                onKeyDown={(e) => e.key === "Enter" && void loadRows()}
              />
              <button
                type="button"
                className="remove-chip-btn"
                onClick={() => setFilters((prev) => prev.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="button-secondary apply-filters-btn" onClick={() => void loadRows()}>
            {isUk ? "Застосувати фільтри" : "Apply"}
          </button>
        </div>
      )}

      {/* Rows Table */}
      <div className="data-table-container">
        {rowsLoading && rows.length === 0 ? (
          <div className="table-loading-spinner" style={{ padding: "48px 24px", textAlign: "center", color: "#64748b" }}>
            <div className="ds-table-spinner" />
            <span>{isUk ? "Завантаження рядків…" : "Loading rows…"}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-rows-hint">
            <p>{isUk ? "Рядків у цій колекції ще немає." : "No rows found in this collection."}</p>
          </div>
        ) : (
          <div className="data-table-wrapper" style={{ position: "relative" }}>
            {rowsLoading && <div className="data-table-loading-bar" />}
            <table className="data-studio-table data-rows-table" style={{ opacity: rowsLoading ? 0.65 : 1, transition: "opacity 0.15s ease" }}>
            <thead>
              <tr>
                {environment === "dev" && (
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedRowIds.size === rows.length}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedRowIds(new Set(rows.map((r) => String(r.id))));
                        } else {
                          setSelectedRowIds(new Set());
                        }
                      }}
                      aria-label="Select all rows"
                    />
                  </th>
                )}
                {currentTable.columns.map((col) => (
                  <th
                    key={col.name}
                    className="sortable-header"
                    onClick={() => {
                      if (sortField === col.name) {
                        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      } else {
                        setSortField(col.name);
                        setSortDir("asc");
                      }
                    }}
                  >
                    {col.name}
                    {sortField === col.name && (sortDir === "asc" ? " ▲" : " ▼")}
                  </th>
                ))}
                <th style={{ width: 120 }}>{isUk ? "Дії" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rIdx) => {
                const rowId = String(row.id ?? rIdx);
                const isSelected = selectedRowIds.has(rowId);
                return (
                  <tr key={rowId} className={isSelected ? "selected-row" : ""}>
                    {environment === "dev" && (
                      <td>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            const next = new Set(selectedRowIds);
                            if (e.target.checked) next.add(rowId);
                            else next.delete(rowId);
                            setSelectedRowIds(next);
                          }}
                        />
                      </td>
                    )}
                    {currentTable.columns.map((col) => {
                      const val = row[col.name];
                      return (
                        <td key={col.name} className="cell-content">
                          {val === null || val === undefined ? (
                            <span className="null-val">null</span>
                          ) : typeof val === "boolean" ? (
                            <span className={`bool-val ${val ? "true" : "false"}`}>{String(val)}</span>
                          ) : typeof val === "object" ? (
                            <code>{JSON.stringify(val)}</code>
                          ) : (
                            <span>{String(val)}</span>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <div className="table-row-actions">
                        <button
                          type="button"
                          className="button-secondary table-action-btn"
                          onClick={() => openEditRowDrawer(row)}
                        >
                          {isUk ? "Змінити" : "Edit"}
                        </button>
                        {environment === "dev" && (
                          <button
                            type="button"
                            className="button-secondary table-action-btn danger"
                            onClick={() => void handleDeleteRow(rowId)}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Pagination Controls */}
      <div className="data-table-pagination">
        <div className="page-size-selector">
          <span>{isUk ? "Рядків на сторінці:" : "Rows per page:"}</span>
          <select
            value={pageLimit}
            onChange={(e) => {
              setPageLimit(Number(e.target.value));
              setPageOffset(0);
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>

        <div className="pagination-buttons">
          <button
            type="button"
            className="button-secondary"
            disabled={pageOffset === 0 || rowsLoading}
            onClick={() => setPageOffset((prev) => Math.max(0, prev - pageLimit))}
          >
            ← {isUk ? "Попередня" : "Prev"}
          </button>
          <span className="page-info">
            {isUk
              ? `Рядки ${pageOffset + 1}–${pageOffset + rows.length}`
              : `Rows ${pageOffset + 1}–${pageOffset + rows.length}`}
          </span>
          <button
            type="button"
            className="button-secondary"
            disabled={rows.length < pageLimit || rowsLoading}
            onClick={() => setPageOffset((prev) => prev + pageLimit)}
          >
            {isUk ? "Наступна" : "Next"} →
          </button>
        </div>
      </div>
    </div>
  );
}
