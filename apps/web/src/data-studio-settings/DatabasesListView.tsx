import React from "react";
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
  createOpen: boolean;
  createDatabase: (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => Promise<void>;
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
  createOpen,
  createDatabase,
}: DatabasesListViewProps) {
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

      {!companies.length && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "Створіть компанію, щоб працювати з базами даних." : "Create a company to work with databases."}{" "}
          <Link to="/settings/company">{isUk ? "Перейти" : "Open"}</Link>
        </div>
      )}

      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{stats.total}</strong>
          <span>{isUk ? "Баз даних" : "Databases"}</span>
          <small>
            {companyFilter === allCompaniesToken
              ? (isUk ? `у ${companies.length} компаніях` : `across ${companies.length} companies`)
              : (isUk ? "у вибраній компанії" : "in the selected company")}
          </small>
        </div>
        <div>
          <strong>{stats.readyEnvironments} / {stats.totalEnvironments}</strong>
          <span>{isUk ? "Середовищ готово" : "Environments ready"}</span>
          <small>{isUk ? "dev і prod по кожній базі" : "dev and prod per database"}</small>
        </div>
        <div>
          <strong>{stats.tables === null ? "—" : stats.tables}</strong>
          <span>{isUk ? "Таблиць" : "Tables"}</span>
          <small>{isUk ? "у dev по прикріплених проєктах" : "in dev across attached projects"}</small>
        </div>
        <div>
          <strong>{stats.attachedProjects}</strong>
          <span>{isUk ? "Проєктів прикріплено" : "Attached projects"}</span>
          <small>
            {companyFilter === allCompaniesToken
              ? (isUk ? `з ${companyProjects.length} у вибраних компаніях` : `of ${companyProjects.length} in the selected companies`)
              : (isUk ? `з ${companyProjects.length} у компанії` : `of ${companyProjects.length} in the company`)}
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
            <small className="tab-count">{companyBackends.length}</small>
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
            {isUk ? `Показано ${filteredBackends.length} з ${companyBackends.length}` : `Showing ${filteredBackends.length} of ${companyBackends.length}`}
            {searchQuery ? (isUk ? ` за запитом «${searchQuery}»` : ` matching “${searchQuery}”`) : ""}
          </span>
        </div>
      </div>

      {backendsLoading && backends.length === 0 ? (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
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
              {Array.from({ length: 3 }).map((_, index) => (
                <tr key={`skeleton-${index}`} style={{ opacity: 0.5 }}>
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
      ) : backends.length === 0 ? (
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
                const attached = projects.filter((item) => item.dataBackendId === backend.id).length;
                return (
                  <tr key={backend.id}>
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
