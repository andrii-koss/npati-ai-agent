import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  BackendEnvironment,
  BackendSummary,
  CompanySummary,
  DatabaseFilter,
  Feedback,
  ProjectSummary,
} from "./types";
import { statusPillClass, syncPillClass } from "./helpers";
import { CreateDatabaseDrawer } from "./CreateDatabaseDrawer";

export interface DatabasesListViewProps {
  isUk: boolean;
  backButton: React.ReactNode;
  companySelect: React.ReactNode;
  createTargetCompanyId: string;
  setCreateOpen: (open: boolean) => void;
  feedback: Feedback | null;
  unavailableNotice: React.ReactNode;
  backendsWarning: string | null;
  backendsError: { code?: string; message: string } | null;
  companies: CompanySummary[];
  stats: {
    total: number;
    ready: number;
    attention: number;
    totalEnvironments: number;
    readyEnvironments: number;
    tables: number | null;
    attachedProjects: number;
    tableCountsKnown?: number;
  };
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  databaseFilter: DatabaseFilter;
  setDatabaseFilter: (filter: DatabaseFilter) => void;
  companyBackends: BackendSummary[];
  filteredBackends: BackendSummary[];
  companyProjects: ProjectSummary[];
  companyFilter: string;
  setCompanyFilter: (filter: string) => void;
  allCompaniesToken: string;
  backendsLoading: boolean;
  backends: BackendSummary[];
  environments: Record<string, BackendEnvironment[]>;
  projects: ProjectSummary[];
  tableCounts: Record<string, number | null>;
  backendBusy: boolean;
  setDetailId: (id: string | null) => void;
  toggleArchive: (backend: BackendSummary) => Promise<void>;
  deleteDatabase: (backend: BackendSummary) => Promise<void>;
  deleteDatabases?: (backends: BackendSummary[]) => Promise<void>;
  createOpen: boolean;
  createDatabase: (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => Promise<void>;
  totalMatches?: number;
  totalProjects?: number;
  statsLoading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string | null;
  onLoadMore?: () => void;
  onSelectAll?: () => Promise<BackendSummary[]>;
}

export function DatabasesListView({
  isUk,
  backButton,
  companySelect,
  createTargetCompanyId,
  setCreateOpen,
  feedback,
  unavailableNotice,
  backendsWarning,
  backendsError,
  companies,
  stats,
  searchQuery,
  setSearchQuery,
  databaseFilter,
  setDatabaseFilter,
  companyBackends,
  filteredBackends,
  companyProjects,
  companyFilter,
  setCompanyFilter,
  allCompaniesToken,
  backendsLoading,
  backends,
  environments,
  projects,
  tableCounts,
  backendBusy,
  setDetailId,
  toggleArchive,
  deleteDatabase,
  deleteDatabases,
  createOpen,
  createDatabase,
  totalMatches,
  totalProjects,
  statsLoading = false,
  hasMore = false,
  loadingMore = false,
  moreError,
  onLoadMore,
  onSelectAll,
}: DatabasesListViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [scrollStarted, setScrollStarted] = useState(() => window.scrollY > 0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const matchingTotal = totalMatches ?? filteredBackends.length;
  const selectionBusy = backendBusy || selectingAll || backendsLoading || loadingMore;
  useEffect(() => {
    const onScroll = () => { if (window.scrollY > 0) setScrollStarted(true); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !scrollStarted || !hasMore || backendsLoading || loadingMore || moreError || !onLoadMore || !globalThis.IntersectionObserver) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting)) onLoadMore();
    }, { rootMargin: "0px 0px 200px 0px" });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [scrollStarted, hasMore, backendsLoading, loadingMore, moreError, onLoadMore]);

  // Reset selection when switching company filter
  useEffect(() => {
    setSelectedIds(new Set());
  }, [companyFilter, searchQuery, databaseFilter]);

  // Clean up selected IDs that are no longer in companyBackends
  useEffect(() => {
    setSelectedIds((prev) => {
      if (!prev.size) return prev;
      const validIds = new Set(companyBackends.map((b) => b.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [companyBackends]);

  const allFilteredSelected = filteredBackends.length > 0 && filteredBackends.length === matchingTotal && filteredBackends.every((b) => selectedIds.has(b.id));
  const someFilteredSelected = filteredBackends.some((b) => selectedIds.has(b.id));

  const handleToggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const b of filteredBackends) next.delete(b.id);
        return next;
      });
    } else {
      void handleSelectAllFiltered();
    }
  };

  const handleSelectAllFiltered = async () => {
    if (selectionBusy) return;
    setSelectingAll(true);
    try {
      const targets = onSelectAll ? await onSelectAll() : filteredBackends;
      setSelectedIds(new Set(targets.map(backend => backend.id)));
    } catch { /* The page reports the error; selection stays unchanged. */ }
    finally { setSelectingAll(false); }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedBackends = useMemo(
    () => companyBackends.filter((b) => selectedIds.has(b.id)),
    [companyBackends, selectedIds]
  );

  const handleBulkDelete = async () => {
    if (!selectedBackends.length) return;
    if (deleteDatabases) {
      await deleteDatabases(selectedBackends);
    } else {
      for (const backend of selectedBackends) {
        await deleteDatabase(backend);
      }
    }
    setSelectedIds(new Set());
  };

  return (
    <main className="automations-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Налаштування · Data Studio" : "Settings · Data Studio"}</p>
            <h1>
              {backButton}
              <span>Data Studio</span>
            </h1>
            <p className="hero-copy">
              {isUk
                ? "Бази даних усіх ваших компаній: у списку видно, якій компанії належить кожна база. Новий сайт підключається до бази автоматично, а таблиці створюються тут або агентом."
                : "Databases across all of your companies: the list shows which company owns each database. Every new site is attached automatically, and tables are created here or by an agent."}
            </p>
          </div>
          <div className="automations-header-actions">
            {companySelect}
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => setCreateOpen(true)}
              disabled={!createTargetCompanyId}
              title={isUk ? "Створити базу в цій компанії" : "Create a database in this company"}
            >
              ＋ {isUk ? "Нова база даних" : "New database"}
            </button>
          </div>
        </div>
      </header>

      {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}
      {unavailableNotice}
      {backendsWarning && <div className="data-studio-alert warning" role="status">{backendsWarning}</div>}
      {backendsError && !unavailableNotice && <div className="data-studio-alert error" role="alert">{backendsError.message}</div>}

      {!backendsLoading && !backendsError && !companies.length && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "Створіть компанію, щоб працювати з базами даних." : "Create a company to work with databases."}{" "}
          <Link to="/settings/company">{isUk ? "Перейти" : "Open"}</Link>
        </div>
      )}

      <section className="overview-grid inspector-stats-grid automations-stats-grid ds-catalog-stats" aria-busy={statsLoading}>
        <div>
          <strong>{statsLoading ? "—" : stats.total}</strong>
          <span>{isUk ? "Баз даних" : "Databases"}</span>
          <small style={statsLoading ? { visibility: "hidden" } : undefined}>
            {companyFilter === allCompaniesToken
              ? (isUk ? `у ${companies.length} компаніях` : `across ${companies.length} companies`)
              : (isUk ? "у вибраній компанії" : "in the selected company")}
          </small>
        </div>
        <div>
          <strong>{statsLoading ? "—" : `${stats.readyEnvironments} / ${stats.totalEnvironments}`}</strong>
          <span>{isUk ? "Середовищ готово" : "Environments ready"}</span>
          <small>{isUk ? "dev і prod по кожній базі" : "dev and prod per database"}</small>
        </div>
        <div>
          <strong>{statsLoading || stats.tables === null ? "—" : stats.tables}</strong>
          <span>{isUk ? "Таблиць" : "Tables"}</span>
          <small>{isUk ? "За збереженою схемою dev" : "From saved dev schema"}{!statsLoading && stats.tableCountsKnown !== undefined ? ` · ${stats.tableCountsKnown}/${stats.total}` : ""}</small>
        </div>
        <div>
          <strong>{statsLoading ? "—" : stats.attachedProjects}</strong>
          <span>{isUk ? "Проєктів прикріплено" : "Attached projects"}</span>
          <small style={statsLoading ? { visibility: "hidden" } : undefined}>
            {companyFilter === allCompaniesToken
              ? (isUk ? `з ${totalProjects ?? companyProjects.length} у вибраних компаніях` : `of ${totalProjects ?? companyProjects.length} in the selected companies`)
              : (isUk ? `з ${totalProjects ?? companyProjects.length} у компанії` : `of ${totalProjects ?? companyProjects.length} in the company`)}
          </small>
        </div>
      </section>

      <div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            className="inspector-search-input"
            placeholder={isUk ? "Пошук за назвою, компанією або провайдером…" : "Search by name, company or provider…"}
            aria-label={isUk ? "Пошук баз даних" : "Search databases"}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && (
            <button type="button" className="search-clear-btn" onClick={() => setSearchQuery("")} aria-label={isUk ? "Очистити пошук" : "Clear search"} title={isUk ? "Очистити пошук" : "Clear search"}>
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={databaseFilter === "all"} className={`inspector-tab ${databaseFilter === "all" ? "active" : ""}`} onClick={() => setDatabaseFilter("all")}>
            <span>{isUk ? "Усі" : "All"}</span>
            <small className="tab-count">{stats.total}</small>
          </button>
          <button type="button" role="tab" aria-selected={databaseFilter === "ready"} className={`inspector-tab ${databaseFilter === "ready" ? "active" : ""}`} onClick={() => setDatabaseFilter("ready")}>
            <span>{isUk ? "Готові" : "Ready"}</span>
            <small className="tab-count">{stats.ready}</small>
          </button>
          <button type="button" role="tab" aria-selected={databaseFilter === "attention"} className={`inspector-tab ${databaseFilter === "attention" ? "active" : ""}`} onClick={() => setDatabaseFilter("attention")}>
            <span>{isUk ? "Потребують уваги" : "Needs attention"}</span>
            <small className="tab-count">{stats.attention}</small>
          </button>
        </div>
      </div>

      <div className="inspector-table-status">
        <div className="status-left">
          <span>
            {isUk ? `Показано ${filteredBackends.length} з ${matchingTotal}` : `Showing ${filteredBackends.length} of ${matchingTotal}`}
            {searchQuery ? (isUk ? ` за запитом «${searchQuery}»` : ` matching “${searchQuery}”`) : ""}
          </span>
          {filteredBackends.length > 0 && selectedIds.size === 0 && (
            <button
              type="button"
              className="ds-bulk-select-link"
              disabled={selectionBusy}
              onClick={handleSelectAllFiltered}
            >
              {isUk ? `Вибрати всі (${matchingTotal})` : `Select all (${matchingTotal})`}
            </button>
          )}
          {selectedIds.size > 0 && (
            <span className="ds-selected-count">
              • {isUk ? `Вибрано: ${selectedIds.size}` : `Selected: ${selectedIds.size}`}
            </span>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div className="ds-bulk-actions">
            {selectedIds.size < matchingTotal && (
              <button
                type="button"
                className="button-secondary"
                disabled={selectionBusy}
                style={{ padding: "4px 10px", fontSize: "12px", height: "auto" }}
                onClick={handleSelectAllFiltered}
              >
                {isUk ? `Вибрати всі (${matchingTotal})` : `Select all (${matchingTotal})`}
              </button>
            )}
            <button
              type="button"
              className="button-secondary"
              style={{ padding: "4px 10px", fontSize: "12px", height: "auto" }}
              onClick={handleClearSelection}
              disabled={selectionBusy}
            >
              {isUk ? "Зняти вибір" : "Deselect"}
            </button>
            <button
              type="button"
              className="automation-action-btn danger"
              style={{ padding: "4px 12px", fontSize: "12px", height: "auto", display: "inline-flex", alignItems: "center", gap: "6px" }}
              disabled={selectionBusy}
              onClick={() => void handleBulkDelete()}
            >
              🗑️ {isUk ? `Видалити вибрані (${selectedIds.size})` : `Delete selected (${selectedIds.size})`}
            </button>
          </div>
        )}
      </div>

      {backendsLoading && backends.length === 0 ? (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "40px", textAlign: "center" }}>
                  <input type="checkbox" disabled aria-label="Select all" />
                </th>
                <th style={{ minWidth: "220px" }}>{isUk ? "Назва" : "Name"}</th>
                <th style={{ minWidth: "160px" }}>{isUk ? "Компанія" : "Company"}</th>
                <th style={{ width: "150px" }}>{isUk ? "Провайдер" : "Provider"}</th>
                <th style={{ width: "130px" }}>{isUk ? "Статус" : "Status"}</th>
                <th style={{ width: "220px" }}>dev / prod</th>
                <th style={{ width: "100px" }}>{isUk ? "Таблиць" : "Tables"}</th>
                <th style={{ width: "100px" }}>{isUk ? "Проєктів" : "Projects"}</th>
                <th style={{ width: "260px", textAlign: "right" }}>{isUk ? "Дії" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 10 }).map((_, index) => (
                <tr key={`skeleton-${index}`} style={{ opacity: 0.5 }}>
                  <td style={{ textAlign: "center", width: "40px" }}><span style={{ display: "inline-block", width: "16px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "3px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "160px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "110px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "90px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "70px", height: "24px", background: "var(--npati-gray-100)", borderRadius: "999px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "140px", height: "24px", background: "var(--npati-gray-100)", borderRadius: "999px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "40px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "40px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "120px", height: "28px", background: "var(--npati-gray-100)", borderRadius: "6px" }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : stats.total === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🗄️</div>
          <h3>{isUk ? "Баз даних ще немає" : "No databases yet"}</h3>
          <p>
            {isUk
              ? "Створіть базу — і кожен новий сайт підключатиметься до неї автоматично."
              : "Create a database — every new site will be attached to it automatically."}
          </p>
          <button type="button" className="button-primary automations-action-primary" onClick={() => setCreateOpen(true)} disabled={!createTargetCompanyId}>
            ＋ {isUk ? "Створити першу базу" : "Create the first database"}
          </button>
        </div>
      ) : filteredBackends.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{isUk ? "Нічого не знайдено" : "Nothing found"}</h3>
          <p>{isUk ? "Змініть запит або фільтр." : "Change the query or the filter."}</p>
          <button type="button" className="button-secondary" onClick={() => { setSearchQuery(""); setDatabaseFilter("all"); setCompanyFilter(allCompaniesToken); }}>
            {isUk ? "Скинути фільтри" : "Clear filters"}
          </button>
        </div>
      ) : (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ width: "40px", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={isUk ? "Вибрати всі бази даних" : "Select all databases"}
                    checked={allFilteredSelected}
                    disabled={selectionBusy}
                    ref={(el) => {
                      if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected;
                    }}
                    onChange={handleToggleSelectAll}
                  />
                </th>
                <th style={{ minWidth: "220px" }}>{isUk ? "Назва" : "Name"}</th>
                <th style={{ minWidth: "160px" }}>{isUk ? "Компанія" : "Company"}</th>
                <th style={{ width: "150px" }}>{isUk ? "Провайдер" : "Provider"}</th>
                <th style={{ width: "130px" }}>{isUk ? "Статус" : "Status"}</th>
                <th style={{ minWidth: "200px" }}>dev / prod</th>
                <th style={{ width: "100px" }}>{isUk ? "Таблиць" : "Tables"}</th>
                <th style={{ width: "100px" }}>{isUk ? "Проєктів" : "Projects"}</th>
                <th style={{ width: "300px", textAlign: "right" }}>{isUk ? "Дії" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {filteredBackends.map((backend) => {
                const list = environments[backend.id] ?? [];
                const attached = backend.attachedProjectCount ?? projects.filter((item) => item.dataBackendId === backend.id).length;
                const isSelected = selectedIds.has(backend.id);
                return (
                  <tr key={backend.id} className={isSelected ? "row-selected" : undefined}>
                    <td style={{ textAlign: "center", width: "40px" }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={selectionBusy}
                        onChange={() => handleToggleSelect(backend.id)}
                        aria-label={isUk ? `Вибрати ${backend.name}` : `Select ${backend.name}`}
                      />
                    </td>
                    <td className="automation-title-cell">
                      <button type="button" className="ds-name-link" onClick={() => setDetailId(backend.id)}>{backend.name}</button>
                      <p>{isUk ? "Оновлено" : "Updated"}: {backend.updatedAt ? new Date(backend.updatedAt).toLocaleDateString(isUk ? "uk-UA" : "en-US") : "—"}</p>
                    </td>
                    <td>
                      <span className="data-studio-badge" title={isUk ? "Компанія-власник бази" : "Owning company"}>{backend.companyName}</span>
                    </td>
                    <td>{backend.provider === "external_postgres" ? (isUk ? "Зовнішня" : "External") : "NPATI Postgres"}</td>
                    <td>
                      <span className={`status-pill ${statusPillClass(backend.status)}`}>
                        {backend.status === "deleting" ? (isUk ? "Очікує видалення" : "Pending deletion") : backend.status}
                      </span>
                      {backend.status === "deleting" && backend.removeAfter && (
                        <small className="ds-muted">{isUk ? " Після " : " After "}{new Date(backend.removeAfter).toLocaleString(isUk ? "uk-UA" : "en-US")}</small>
                      )}
                    </td>
                    <td>
                      {list.length === 0 && <span className="ds-muted">—</span>}
                      {list.map((env) => (
                        <span key={env.environment} className={`status-pill ${syncPillClass(env.syncStatus)}`} title={`${env.environment}: ${env.status}`}>
                          {env.environment}: {env.syncStatus}
                        </span>
                      ))}
                    </td>
                    <td>{tableCounts[backend.id] === undefined ? "—" : tableCounts[backend.id] === null ? (isUk ? "н/д" : "n/a") : tableCounts[backend.id]}</td>
                    <td>{attached}</td>
                    <td>
                      <div className="automation-actions-cell">
                        <button type="button" className="automation-action-btn run-btn" onClick={() => setDetailId(backend.id)}>
                          {isUk ? "Відкрити" : "Open"}
                        </button>
                        <button type="button" className="automation-action-btn" disabled={backendBusy || backend.status === "deleting"} onClick={() => void toggleArchive(backend)}>
                          {backend.status === "ready" ? (isUk ? "Архівувати" : "Archive") : (isUk ? "Активувати" : "Activate")}
                        </button>
                        <button type="button" className="automation-action-btn danger" disabled={backendBusy} onClick={() => void deleteDatabase(backend)}>
                          {isUk ? "Видалити зараз" : "Delete now"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && <div ref={sentinelRef} className="data-studio-catalog-sentinel" style={{ minHeight: 1 }}>
        {(loadingMore || selectingAll) && <div className="loading-state" role="status">{isUk ? "Завантаження…" : "Loading…"}</div>}
        {moreError && <div className="data-studio-alert error" role="alert">{moreError} <button type="button" className="button-secondary" onClick={onLoadMore}>{isUk ? "Повторити" : "Retry"}</button></div>}
      </div>}

      {createOpen && (
        <CreateDatabaseDrawer
          isUk={isUk}
          busy={backendBusy}
          companyName={companies.find((company) => company.id === createTargetCompanyId)?.name}
          onClose={() => setCreateOpen(false)}
          onCreate={createDatabase}
        />
      )}
    </main>
  );
}
