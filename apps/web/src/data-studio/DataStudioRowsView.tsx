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
          <div className="search-input-box">
            <input
              type="search"
              placeholder={isUk ? "Пошук по рядках…" : "Search rows…"}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void loadRows()}
            />
            <button type="button" className="button-secondary" onClick={() => void loadRows()}>
              🔍
            </button>
          </div>

          {/* Add filter button */}
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              setFilters((prev) => [
                ...prev,
                { field: currentTable.columns[1]?.name || "id", operator: "eq", value: "" },
              ])
            }
          >
            + {isUk ? "Фільтр" : "Filter"}
          </button>
        </div>

        <div className="toolbar-actions">
          {selectedRowIds.size > 0 && environment === "dev" && (
            <button type="button" className="danger-button" onClick={() => void handleBulkDelete()}>
              {isUk ? `Видалити (${selectedRowIds.size})` : `Delete (${selectedRowIds.size})`}
            </button>
          )}

          <button type="button" className="button-secondary" onClick={() => void handleExport("csv")}>
            📥 CSV
          </button>
          <button type="button" className="button-secondary" onClick={() => void handleExport("json")}>
            📥 JSON
          </button>

          {environment === "dev" && (
            <>
              <button
                type="button"
                className="button-secondary"
                onClick={onOpenImportModal}
              >
                📤 {isUk ? "Імпорт" : "Import"}
              </button>
              <button type="button" className="button-primary" onClick={openCreateRowDrawer}>
                + {isUk ? "Додати рядок" : "New Row"}
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
        {rowsLoading ? (
          <div className="table-loading-spinner">{isUk ? "Завантаження рядків…" : "Loading rows…"}</div>
        ) : rows.length === 0 ? (
          <div className="empty-rows-hint">
            <p>{isUk ? "Рядків у цій колекції ще немає." : "No rows found in this collection."}</p>
          </div>
        ) : (
          <table className="data-studio-table data-rows-table">
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
