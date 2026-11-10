import React from "react";
import { Link } from "react-router-dom";
import { Database, CircleCheck, CircleAlert, Hash } from "lucide-react";
import type {
  BackendEnvironment,
  BackendSummary,
  CompanySummary,
  Feedback,
  Overview,
  PreviewResult,
  ProjectSummary,
  QuotaReport,
  SchemaOperation,
  TableSummary,
} from "./types";
import { formatBytes, statusPillClass, syncPillClass } from "./helpers";
import { SchemaDrawer } from "./SchemaDrawer";
import { TransferDatabaseDrawer } from "./TransferDatabaseDrawer";

export interface DatabaseDetailViewProps {
  isUk: boolean;
  detail: BackendSummary;
  environments: Record<string, BackendEnvironment[]>;
  quotas: Record<string, QuotaReport | null>;
  overview: Overview | null;
  loading: boolean;
  backendsLoading: boolean;
  backendBusy: boolean;
  busy: boolean;
  countingRows: boolean;
  tables: TableSummary[];
  driftRows: string[];
  rowCounts: Record<string, number | null>;
  error: { code?: string; message: string } | null;
  readOnly: boolean;
  detailProjects: ProjectSummary[];
  unattachedProjects: ProjectSummary[];
  detailCompanyBackends: BackendSummary[];
  detailCompanies: CompanySummary[];
  projectId: string;
  setProjectId: (id: string) => void;
  environment: "dev" | "prod";
  setEnvironment: (env: "dev" | "prod") => void;
  lockRemaining: number | null;
  basePath: string;
  editTable: string | null;
  setEditTable: (name: string | null) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  transferOpen: boolean;
  setTransferOpen: (open: boolean) => void;
  feedback: Feedback | null;
  countRows: () => Promise<void>;
  renameDatabase: (detail: BackendSummary) => Promise<void>;
  toggleArchive: (detail: BackendSummary) => Promise<void>;
  deleteDatabase: (detail: BackendSummary) => Promise<void>;
  attachProject: (companyId: string, projectId: string, backendId: string | null) => Promise<void>;
  handleDeleteTable: (table: TableSummary) => Promise<void>;
  previewOperation: (operation: SchemaOperation) => Promise<PreviewResult>;
  applyOperation: (operation: SchemaOperation, preview: PreviewResult) => Promise<void>;
  notify: (message: string, type?: Feedback["type"]) => void;
  transferDatabase: (backend: BackendSummary, input: { targetCompanyId: string; confirmName: string }) => Promise<void>;
  loadOverview: () => Promise<void>;
  refresh: () => void;
  setDetailId: (id: string | null) => void;
}

export function DatabaseDetailView({
  isUk,
  detail,
  environments,
  quotas,
  overview,
  loading,
  backendBusy,
  busy,
  countingRows,
  tables,
  driftRows,
  rowCounts,
  error,
  readOnly,
  detailProjects,
  unattachedProjects,
  detailCompanyBackends,
  detailCompanies,
  projectId,
  setProjectId,
  environment,
  setEnvironment,
  lockRemaining,
  basePath,
  editTable,
  setEditTable,
  drawerOpen,
  setDrawerOpen,
  transferOpen,
  setTransferOpen,
  feedback,
  countRows,
  renameDatabase,
  toggleArchive,
  deleteDatabase,
  attachProject,
  handleDeleteTable,
  previewOperation,
  applyOperation,
  notify,
  transferDatabase,
  setDetailId,
}: DatabaseDetailViewProps) {
  const [selectedUnattachedId, setSelectedUnattachedId] = React.useState<string>("");
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const actionsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const actionsId = React.useId();

  React.useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionsOpen(false);
        actionsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen]);
  const detailEnvironments = environments[detail.id] ?? [];
  const envOrder: Array<"dev" | "prod"> = ["dev", "prod"];

  return (
    <main className="automations-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Налаштування · Data Studio" : "Settings · Data Studio"}</p>
            <h1>
              <button
                type="button"
                className="marketplace-back-button"
                onClick={() => setDetailId(null)}
                aria-label={isUk ? "Усі бази даних" : "All databases"}
                title={isUk ? "Усі бази даних" : "All databases"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
              <span>{detail.name}</span>
            </h1>
            <p className="hero-copy">
              <span className="data-studio-badge" title={isUk ? "Компанія-власник бази" : "Owning company"}>
                {isUk ? "Компанія" : "Company"}: {detail.companyName}
              </span>{" "}
              <span className={`status-pill ${statusPillClass(detail.status)}`}>{detail.status}</span>{" "}
              <span className="data-studio-badge">{detail.provider === "external_postgres" ? (isUk ? "зовнішня" : "external") : "NPATI"}</span>{" "}
              {detailEnvironments.map((env) => (
                <span key={env.environment} className={`status-pill ${syncPillClass(env.syncStatus)}`}>{env.environment}: {env.syncStatus}</span>
              ))}
            </p>
          </div>
          <div className="automations-header-actions ds-database-actions">
            <button type="button" className="ds-database-action-trigger" onClick={() => void renameDatabase(detail)} disabled={backendBusy}>
              {isUk ? "Перейменувати" : "Rename"}
            </button>
            <div className="ds-database-actions-dropdown" ref={actionsRef}>
              <button type="button" className="ds-database-action-trigger" ref={actionsTriggerRef} aria-expanded={actionsOpen} aria-controls={actionsId} onClick={() => setActionsOpen(open => !open)} disabled={backendBusy}>
                {isUk ? "Дії" : "Actions"}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {actionsOpen && (
                <div className="ds-database-action-menu" id={actionsId}>
                  <button type="button" onClick={() => { setActionsOpen(false); void toggleArchive(detail); }} disabled={backendBusy || detail.status === "deleting"}>
                    {detail.status === "ready" ? (isUk ? "Архівувати" : "Archive") : (isUk ? "Активувати" : "Activate")}
                  </button>
                  <button type="button" onClick={() => { setActionsOpen(false); setTransferOpen(true); }} disabled={backendBusy}>
                    {isUk ? "Перенести в іншу компанію" : "Move to another company"}
                  </button>
                  <button type="button" className="ds-database-action-danger" onClick={() => { setActionsOpen(false); void deleteDatabase(detail); }} disabled={backendBusy}>
                    {isUk ? "Видалити зараз" : "Delete now"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}

      <section className="overview-grid inspector-stats-grid automations-stats-grid ds-environment-grid" aria-label={isUk ? "Середовища" : "Environments"}>
        {envOrder.map((envName) => {
          const info = detailEnvironments.find((env) => env.environment === envName);
          const quota = quotas[envName];
          const showLock = overview?.environment.environment === envName && overview?.lock?.held;
          const statusClass = !info ? "unknown" : info.status === "ready" && info.syncStatus === "synced"
            ? "ready" : ["error", "failed"].includes(info.status) ? "error" : "warning";
          return (
            <div key={envName} className="ds-environment-card">
              <svg className="ds-environment-waves" viewBox="0 0 640 180" preserveAspectRatio="none" aria-hidden="true">
                <path d="M290 180C375 170 410 126 490 124S575 94 640 76V180Z" fill="#fcecef" />
                <path d="M430 180C515 157 558 101 640 132V180Z" fill="#f9e2e7" fillOpacity="0.65" />
              </svg>
              <div className="ds-environment-heading">
                <div className="ds-environment-icon" aria-hidden="true"><Database size={36} strokeWidth={1.8} /></div>
                <strong className="ds-environment-name">{envName}</strong>
                <span className={`ds-environment-status is-${statusClass}`}>
                  <i aria-hidden="true" />
                  {info ? `${info.status} · ${info.syncStatus}` : isUk ? "немає даних" : "no data"}
                </span>
              </div>
              <div className="ds-environment-metrics">
                {quota ? (
                  <>
                    <span className="ds-environment-usage">
                      <Database size={20} strokeWidth={1.8} aria-hidden="true" />
                      {formatBytes(quota.usage.bytes)} / {formatBytes(quota.limits.maxDatabaseBytes)}
                    </span>
                    <span className={`ds-environment-quota is-${quota.state}`}>
                      {quota.state === "ok"
                        ? <CircleCheck size={20} fill="#197237" stroke="#ffffff" aria-hidden="true" />
                        : <CircleAlert size={20} aria-hidden="true" />}
                      {quota.state}
                    </span>
                  </>
                ) : <span className="ds-environment-usage">{isUk ? "квоти недоступні" : "quotas unavailable"}</span>}
              </div>
              {info?.schemaFingerprint && (
                <div className="ds-environment-fingerprint" title={info.schemaFingerprint}>
                  <Hash size={20} aria-hidden="true" />
                  {info.schemaFingerprint.slice(0, 12)}...
                </div>
              )}
              {showLock && <div className="ds-environment-lock">{isUk ? "міграція виконується" : "migration running"}{lockRemaining !== null ? ` · ${lockRemaining}s` : ""}</div>}
            </div>
          );
        })}
      </section>

      <div className="ds-section-title">
        <h2>{isUk ? "Проєкти" : "Projects"}</h2>
        <span className="ds-muted">{isUk ? "Одна база може обслуговувати кілька проєктів" : "One database can serve several projects"}</span>
      </div>

      {detailProjects.length === 0 && unattachedProjects.length === 0 && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "У цій компанії ще немає проєктів." : "This company has no projects yet."}{" "}
          <Link to="/settings/projects">{isUk ? "Створити проєкт" : "Create a project"}</Link>
        </div>
      )}

      {detailProjects.length > 0 && (
        <div className="data-studio-attachments">
          {detailProjects.map((item) => (
            <div key={item.id} className="ds-attach-row">
              <span className="data-studio-chip">{item.name}{item.type ? ` · ${item.type}` : ""}</span>
              <Link className="automation-action-btn run-btn" to={`/companies/${encodeURIComponent(detail.companyId)}/projects/${encodeURIComponent(item.id)}/data`}>
                {isUk ? "Відкрити Data Studio" : "Open Data Studio"}
              </Link>
              <button type="button" className="automation-action-btn" disabled={backendBusy} onClick={() => void attachProject(detail.companyId, item.id, null)}>
                {isUk ? "Відкріпити" : "Detach"}
              </button>
            </div>
          ))}
        </div>
      )}

      {unattachedProjects.length > 0 && (
        <div className="ds-attach-project-box" style={{ marginTop: "16px", marginBottom: "20px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
            {isUk ? "Прикріпити проєкт" : "Attach a project"}
          </h3>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <select
              aria-label={isUk ? "Оберіть проєкт для прикріплення" : "Select project to attach"}
              style={{
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                minWidth: "260px",
                background: "#fff",
              }}
              value={selectedUnattachedId}
              disabled={backendBusy}
              onChange={(e) => setSelectedUnattachedId(e.target.value)}
            >
              <option value="">{isUk ? "-- Оберіть проєкт для прикріплення --" : "-- Select project to attach --"}</option>
              {unattachedProjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.type ? ` (${item.type})` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="automation-action-btn run-btn"
              disabled={backendBusy || !selectedUnattachedId}
              onClick={() => {
                if (selectedUnattachedId) {
                  void attachProject(detail.companyId, selectedUnattachedId, detail.id).then(() => {
                    setSelectedUnattachedId("");
                  });
                }
              }}
            >
              {isUk ? "＋ Прикріпити до цієї бази" : "＋ Attach to this database"}
            </button>
          </div>
        </div>
      )}

      <div className="ds-section-title">
        <h2>{isUk ? "Таблиці" : "Tables"}</h2>
        <span className="ds-muted">{isUk ? "Схема, RLS і політики проєкту" : "Schema, RLS and policies of the project"}</span>
      </div>

      <div className="ds-detail-toolbar">
        <label>
          <span>{isUk ? "Проєкт" : "Project"}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={!detailProjects.length}>
            {!detailProjects.length && <option value="">{isUk ? "Немає прикріплених проєктів" : "No attached projects"}</option>}
            {detailProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="ds-toolbar-field">
          <span>{isUk ? "Середовище" : "Environment"}</span>
          <div className="env-switcher" role="group" aria-label={isUk ? "Середовище" : "Environment"}>
            <button type="button" className={`env-btn ${environment === "dev" ? "active" : ""}`} onClick={() => setEnvironment("dev")}>dev</button>
            <button type="button" className={`env-btn ${environment === "prod" ? "active" : ""}`} onClick={() => setEnvironment("prod")}>prod</button>
          </div>
        </div>
        <button type="button" className="button-secondary" onClick={() => void countRows()} disabled={countingRows || !tables.length}>
          {countingRows ? (isUk ? "Рахуємо…" : "Counting…") : isUk ? "Порахувати рядки" : "Count rows"}
        </button>
        {!readOnly && (
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={() => { setEditTable(null); setDrawerOpen(true); }}
            disabled={!overview || busy || !detailProjects.length}
          >
            ＋ {isUk ? "Нова таблиця" : "New table"}
          </button>
        )}
      </div>

      {error && (
        <div className="data-studio-alert error" role="alert">
          {error.code === "DATA_BACKEND_NOT_ATTACHED"
            ? (isUk ? "До проєкту не прикріплено DataBackend." : "This project has no attached DataBackend.")
            : error.message}
        </div>
      )}

      {readOnly && (
        <div className="data-studio-alert info" role="status">
          {isUk
            ? "Зміни схеми в prod доступні лише через Promote (Data Studio → проєкт → Promote та квоти). Тут — лише перегляд."
            : "Schema changes in prod are only possible through Promote (Data Studio → project → Promote & Quotas). This view is read-only."}
        </div>
      )}

      {driftRows.length > 0 && (
        <div className="data-studio-alert warning" role="alert">
          <strong>{isUk ? "Виявлено розбіжність схеми" : "Schema drift detected"}</strong>
          <ul>{driftRows.map((row) => <li key={row}>{row}</li>)}</ul>
        </div>
      )}

      {!loading && overview && tables.length === 0 && (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🗂️</div>
          <h3>{isUk ? "У цьому проєкті ще немає таблиць" : "This project has no tables yet"}</h3>
          <p>
            {isUk
              ? "Почніть із готової схеми (магазин, блог, CRM) або створіть таблицю вручну."
              : "Start from a ready schema (shop, blog, CRM) or create a table manually."}
          </p>
          {!readOnly && (
            <button type="button" className="button-primary automations-action-primary" onClick={() => { setEditTable(null); setDrawerOpen(true); }} disabled={!overview || busy}>
              ＋ {isUk ? "Нова таблиця" : "New table"}
            </button>
          )}
        </div>
      )}

      {tables.length > 0 && (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "220px" }}>{isUk ? "Таблиця" : "Table"}</th>
                <th style={{ minWidth: "160px" }}>{isUk ? "Поля" : "Fields"}</th>
                <th style={{ width: "150px" }}>RLS</th>
                <th style={{ width: "110px" }}>{isUk ? "Політики" : "Policies"}</th>
                <th style={{ width: "110px" }}>{isUk ? "Індекси" : "Indexes"}</th>
                <th style={{ width: "100px" }}>Rows</th>
                <th style={{ width: "260px", textAlign: "right" }}>{isUk ? "Дії" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((table) => (
                <tr key={table.name}>
                  <td className="automation-title-cell"><strong><code>{table.name}</code></strong></td>
                  <td title={table.columns.map((column) => `${column.name}: ${column.type}`).join("\n")}>
                    <strong>{table.columns.length}</strong>
                    {table.columns.length > 0 && <span className="ds-muted"> · {table.columns.slice(0, 3).map((column) => column.name).join(", ")}{table.columns.length > 3 ? "…" : ""}</span>}
                  </td>
                  <td>
                    <span className={`status-pill ${table.rlsEnabled ? "allowed" : "denied"}`}>{table.rlsEnabled ? "Enabled" : "Off"}</span>{" "}
                    {table.rlsForced && <span className="status-pill allowed">Forced</span>}
                  </td>
                  <td title={table.policies.join("\n")}>{table.policies.length}</td>
                  <td>{table.indexes.length}</td>
                  <td>{rowCounts[table.name] === undefined ? "—" : Number.isNaN(rowCounts[table.name]!) ? (isUk ? "помилка" : "error") : rowCounts[table.name]}</td>
                  <td>
                    <div className="automation-actions-cell">
                      {!readOnly && (
                        <>
                          <button type="button" className="automation-action-btn" onClick={() => { setEditTable(table.name); setDrawerOpen(true); }} disabled={busy}>
                            {isUk ? "Редагувати" : "Edit"}
                          </button>
                          <button type="button" className="automation-action-btn danger" onClick={() => void handleDeleteTable(table)} disabled={busy}>
                            {isUk ? "Видалити" : "Delete"}
                          </button>
                        </>
                      )}
                      <Link className="automation-action-btn" to={`/companies/${encodeURIComponent(detail.companyId)}/projects/${encodeURIComponent(projectId)}/data`}>
                        {isUk ? "У проєкті" : "In project"}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerOpen && (
        <SchemaDrawer
          isUk={isUk}
          basePath={basePath}
          readOnly={readOnly}
          table={editTable ? tables.find((item) => item.name === editTable) ?? null : null}
          busy={busy}
          onClose={() => { setDrawerOpen(false); setEditTable(null); }}
          onPreview={previewOperation}
          onApply={applyOperation}
          onNotify={notify}
        />
      )}

      {transferOpen && (
        <TransferDatabaseDrawer
          isUk={isUk}
          backend={detail}
          companies={detailCompanies}
          attachedProjects={detailProjects.length}
          busy={backendBusy}
          onClose={() => setTransferOpen(false)}
          onTransfer={(input) => transferDatabase(detail, input)}
        />
      )}
    </main>
  );
}
