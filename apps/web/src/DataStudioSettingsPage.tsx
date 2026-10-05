import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId, readCachedCompanies } from "./active-company";
import { DataBackendSection } from "./DataBackendSection";
import type { FieldDefinition, FieldType, SchemaOperation } from "./DataStudioPage";

// --- Types ------------------------------------------------------------------

interface CompanySummary {
  id: string;
  name: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  type?: string;
  status?: string;
  framework?: string | null;
  dataBackendId?: string | null;
}

interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
}

interface TableSummary {
  name: string;
  columns: TableColumn[];
  constraints: string[];
  indexes: string[];
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: string[];
}

interface Overview {
  backend: { id: string; name: string; provider: string; status: string };
  environment: {
    environment: "dev" | "prod";
    status: string;
    syncStatus: "synced" | "drift_detected" | "reconciliation_required";
    schemaFingerprint?: string | null;
  };
  schema: { tables: TableSummary[] } | null;
  expectedSchema: unknown | null;
  drift: { actual: string; expected: string; tables: { added: string[]; removed: string[]; changed: string[] } } | null;
  lock: { held: boolean; createdAt?: string; expiresAt?: string };
  migrations: Array<{ id: string; version: number }>;
}

interface TemplateCollection {
  name: string;
  fields: number;
  fieldNames: string[];
}

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  collections: TemplateCollection[];
}

interface PreviewResult {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  diff: { operation: SchemaOperation; beforeFingerprint: string; sql: string };
}

interface AppliedMigration {
  id: string;
  version: number;
  fingerprint: string;
}

type Feedback = { message: string; type: "success" | "info" | "error" };

const FIELD_TYPES: FieldType[] = ["string", "text", "integer", "decimal", "boolean", "date", "datetime", "json", "uuid", "enum"];
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_ROW_COUNT_TABLES = 50;

// --- API --------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & { code?: string; status?: number };
    error.code = result?.error?.code;
    error.status = response.status;
    throw error;
  }
  return result as T;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

// --- Page -------------------------------------------------------------------

export function DataStudioSettingsPage() {
  const { language } = useTranslation();
  const isUk = language === "uk";

  const [companies, setCompanies] = useState<CompanySummary[]>(() => readCachedCompanies<CompanySummary>());
  const [companyId, setCompanyId] = useState<string>("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [environment, setEnvironment] = useState<"dev" | "prod">("dev");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [view, setView] = useState<"tables" | "databases">("tables");
  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [countingRows, setCountingRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTable, setEditTable] = useState<string | null>(null);

  const notify = useCallback((message: string, type: Feedback["type"] = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  }, []);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const tables = useMemo(() => [...(overview?.schema?.tables ?? [])].sort((left, right) => left.name.localeCompare(right.name)), [overview]);
  const readOnly = environment === "prod";

  // 1. Companies
  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ companies: CompanySummary[] }>("/companies?limit=50")
      .then((result) => {
        if (cancelled) return;
        const list = result.companies ?? [];
        setCompanies(list);
        setCompanyId((current) => current || chooseAvailableCompanyId(list, { fallback: list[0]?.id }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // 2. Projects of the selected company
  useEffect(() => {
    if (!companyId) { setProjects([]); setProjectId(""); return; }
    let cancelled = false;
    void apiFetch<{ projects: ProjectSummary[] }>(`/companies/${encodeURIComponent(companyId)}/projects`)
      .then((result) => {
        if (cancelled) return;
        const list = result.projects ?? [];
        setProjects(list);
        setProjectId((current) => {
          if (current && list.some((item) => item.id === current)) return current;
          return (list.find((item) => item.dataBackendId) ?? list[0])?.id ?? "";
        });
      })
      .catch((cause) => { if (!cancelled) setError({ message: cause instanceof Error ? cause.message : "Could not load projects" }); });
    return () => { cancelled = true; };
  }, [companyId]);

  const loadOverview = useCallback(async () => {
    if (!companyId || !projectId || !project?.dataBackendId) { setOverview(null); return; }
    setLoading(true);
    try {
      const result = await apiFetch<Overview>(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`);
      setOverview(result);
      setError(null);
    } catch (cause) {
      setOverview(null);
      setError({ message: cause instanceof Error ? cause.message : "Could not load Data Studio", code: errorCode(cause) });
    } finally {
      setLoading(false);
    }
  }, [companyId, projectId, project?.dataBackendId, environment]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { setRowCounts({}); }, [projectId, environment]);

  // --- Schema operations ----------------------------------------------------

  const basePath = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`;

  const previewOperation = useCallback(async (operation: SchemaOperation): Promise<PreviewResult> => {
    return apiFetch<PreviewResult>(`${basePath}/schema/preview`, { method: "POST", body: JSON.stringify({ operation }) });
  }, [basePath]);

  const applyOperation = useCallback(async (operation: SchemaOperation, preview: PreviewResult): Promise<void> => {
    const fingerprint = overview?.environment.schemaFingerprint ?? undefined;
    setBusy(true);
    try {
      await apiFetch<AppliedMigration>(`${basePath}/schema/apply`, {
        method: "POST",
        body: JSON.stringify({
          operation,
          expectedFingerprint: fingerprint,
          confirmDestructive: preview.destructive || preview.requiresSnapshot ? true : undefined,
        }),
      });
      notify(isUk ? "Зміну застосовано" : "Change applied");
      await loadOverview();
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "STALE_SCHEMA") {
        notify(isUk ? "Схема змінилася — оновіть і повторіть" : "Schema changed — reload and retry", "error");
        await loadOverview();
      } else {
        notify(cause instanceof Error ? cause.message : "Could not apply the change", "error");
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [basePath, overview?.environment.schemaFingerprint, notify, isUk, loadOverview]);

  const handleDeleteTable = useCallback(async (table: TableSummary) => {
    const confirmed = await confirmModal({
      title: isUk ? "Видалити таблицю" : "Delete table",
      message: isUk
        ? `Таблицю «${table.name}» буде видалено разом з усіма її даними. Перед застосуванням автоматично створюється snapshot.`
        : `Table “${table.name}” and all of its data will be deleted. A snapshot is taken automatically before applying.`,
      confirmText: isUk ? "Продовжити" : "Continue",
      isDanger: true,
    });
    if (!confirmed) return;
    const typed = await promptModal({
      title: isUk ? "Підтвердіть видалення" : "Confirm deletion",
      message: isUk ? `Введіть назву таблиці «${table.name}», щоб підтвердити.` : `Type the table name “${table.name}” to confirm.`,
      placeholder: table.name,
    });
    if (typed !== table.name) {
      if (typed !== null) notify(isUk ? "Назва не збігається — видалення скасовано" : "Name does not match — deletion cancelled", "error");
      return;
    }
    try {
      const operation: SchemaOperation = { kind: "drop_collection", collection: table.name };
      const preview = await previewOperation(operation);
      await applyOperation(operation, preview);
      setRowCounts((current) => { const next = { ...current }; delete next[table.name]; return next; });
    } catch {
      // applyOperation already reported the failure
    }
  }, [applyOperation, isUk, notify, previewOperation]);

  const countRows = useCallback(async () => {
    if (!tables.length) return;
    setCountingRows(true);
    try {
      const next: Record<string, number> = {};
      for (const table of tables.slice(0, MAX_ROW_COUNT_TABLES)) {
        try {
          const result = await apiFetch<{ meta: { total: number } }>(`${basePath}/collections/${encodeURIComponent(table.name)}/rows/query`, {
            method: "POST",
            body: JSON.stringify({ limit: 1 }),
          });
          next[table.name] = Number(result.meta?.total ?? 0);
        } catch {
          next[table.name] = Number.NaN;
        }
      }
      setRowCounts(next);
    } finally {
      setCountingRows(false);
    }
  }, [basePath, tables]);

  // --- Render ---------------------------------------------------------------

  const lockRemaining = useMemo(() => {
    if (!overview?.lock?.held || !overview.lock.expiresAt) return null;
    const remaining = Date.parse(overview.lock.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return null;
    return Math.ceil(remaining / 1000);
  }, [overview?.lock]);

  const driftRows = overview?.drift ? [
    ...overview.drift.tables.added.map((name) => `${isUk ? "нова" : "added"}: ${name}`),
    ...overview.drift.tables.removed.map((name) => `${isUk ? "відсутня" : "removed"}: ${name}`),
    ...overview.drift.tables.changed.map((name) => `${isUk ? "змінена" : "changed"}: ${name}`),
  ] : [];

  const viewSwitcher = (
    <div className="ds-segmented inline" role="tablist" aria-label={isUk ? "Розділ Data Studio" : "Data Studio view"}>
      <button
        type="button"
        role="tab"
        aria-selected={view === "tables"}
        className={view === "tables" ? "active" : ""}
        onClick={() => setView("tables")}
      >
        {isUk ? "Таблиці" : "Tables"}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "databases"}
        className={view === "databases" ? "active" : ""}
        onClick={() => setView("databases")}
      >
        {isUk ? "Бази даних" : "Databases"}
      </button>
    </div>
  );

  const companyPicker = companies.length > 1 && (
    <div className="ds-toolbar">
      <label className="ds-toolbar-field">
        <span>{isUk ? "Компанія" : "Company"}</span>
        <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select>
      </label>
    </div>
  );

  // The databases view manages the DataBackends of the selected company; the tables view works
  // inside one project's DataBackend.
  if (view === "databases") {
    return (
      <div className="data-studio-pane">
        <div className="pane-header">
          <div>
            <h2>Data Studio</h2>
            <p>{isUk ? "Бази даних проєктів цієї компанії" : "Project databases for this company"}</p>
          </div>
          <div className="pane-actions">{viewSwitcher}</div>
        </div>

        {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}
        {companyPicker}

        {companyId
          ? <DataBackendSection companyId={companyId} />
          : <div className="data-studio-alert info" role="status">{isUk ? "Створіть компанію, щоб працювати з базами даних." : "Create a company to manage project databases."}</div>}
      </div>
    );
  }

  return (
    <div className="data-studio-pane">
      <div className="pane-header">
        <div>
          <h2>Data Studio</h2>
          <p>{isUk ? "Таблиці, схеми та дані ваших проєктів" : "Tables, schemas and data for your projects"}</p>
        </div>
        <div className="pane-actions">
          {viewSwitcher}
          <button type="button" className="button-secondary" onClick={() => void loadOverview()} disabled={loading || !project?.dataBackendId}>
            {loading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}

      <div className="ds-toolbar">
        {companies.length > 1 && (
          <label className="ds-toolbar-field">
            <span>{isUk ? "Компанія" : "Company"}</span>
            <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
        )}
        <label className="ds-toolbar-field">
          <span>{isUk ? "Проєкт" : "Project"}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={!projects.length}>
            {!projects.length && <option value="">{isUk ? "Немає проєктів" : "No projects"}</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}{item.type ? ` · ${item.type}` : ""}{item.dataBackendId ? "" : isUk ? " (Data Studio не підключено)" : " (Data Studio not attached)"}
              </option>
            ))}
          </select>
        </label>
        <div className="ds-toolbar-field">
          <span>{isUk ? "Середовище" : "Environment"}</span>
          <div className="env-switcher" role="group" aria-label={isUk ? "Середовище" : "Environment"}>
            <button type="button" className={`env-btn ${environment === "dev" ? "active" : ""}`} onClick={() => setEnvironment("dev")}>dev</button>
            <button type="button" className={`env-btn ${environment === "prod" ? "active" : ""}`} onClick={() => setEnvironment("prod")}>prod</button>
          </div>
        </div>
        {!readOnly && (
          <button
            type="button"
            className="button-primary"
            onClick={() => { setEditTable(null); setDrawerOpen(true); }}
            disabled={!overview || busy}
          >
            ＋ {isUk ? "Нова таблиця" : "New table"}
          </button>
        )}
      </div>

      {error && (
        <div className="data-studio-alert error" role="alert">
          {error.code === "DATA_STUDIO_UNAVAILABLE"
            ? (isUk
              ? "Data Studio вимкнено на цій інсталяції (немає підключення до postgres-projects або provisioner)."
              : "Data Studio is disabled on this installation (no postgres-projects / provisioner configured).")
            : error.code === "DATA_BACKEND_NOT_ATTACHED"
              ? (isUk ? "До проєкту не прикріплено DataBackend." : "This project has no attached DataBackend.")
              : error.message}
          {error.code === "DATA_BACKEND_NOT_ATTACHED" && <> <Link to="/settings/company">{isUk ? "Прикріпити DataBackend" : "Attach a DataBackend"}</Link></>}
        </div>
      )}

      {!companies.length && !error && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "Створіть компанію, щоб працювати з даними проєктів." : "Create a company to work with project data."}{" "}
          <Link to="/settings/company">{isUk ? "Перейти" : "Open"}</Link>
        </div>
      )}

      {Boolean(companies.length) && !projects.length && !error && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "У цій компанії ще немає проєктів." : "This company has no projects yet."}{" "}
          <Link to="/settings/websites">{isUk ? "Створити проєкт" : "Create a project"}</Link>
        </div>
      )}

      {project && !project.dataBackendId && (
        <div className="data-studio-alert info" role="status">
          {isUk
            ? "До цього проєкту не прикріплено DataBackend, тому таблиць ще немає."
            : "This project has no attached DataBackend yet, so it has no tables."}{" "}
          <Link to="/settings/company">{isUk ? "Прикріпити DataBackend" : "Attach a DataBackend"}</Link>
        </div>
      )}

      {readOnly && (
        <div className="data-studio-alert info" role="status">
          {isUk
            ? "Зміни схеми в prod доступні лише через Promote (Data Studio → проєкт → Promote та квоти). Тут — лише перегляд."
            : "Schema changes in prod are only possible through Promote (Data Studio → project → Promote & Quotas). This view is read-only."}
        </div>
      )}

      {overview && (
        <div className="ds-status-row">
          <span className="ds-status-item"><strong>{overview.backend.name}</strong> · {overview.backend.provider} · {overview.backend.status}</span>
          <span className={`status-pill ${overview.environment.syncStatus === "synced" ? "verified" : "requires-approval"}`}>
            {overview.environment.syncStatus}
          </span>
          {overview.lock?.held && (
            <span className="status-pill requires-approval" title={overview.lock.expiresAt}>
              {isUk ? "міграція виконується" : "migration running"}{lockRemaining !== null ? ` · ${lockRemaining}s` : ""}
            </span>
          )}
          <span className="ds-status-item">{isUk ? "Таблиць" : "Tables"}: <strong>{tables.length}</strong></span>
          <button type="button" className="button-secondary" onClick={() => void countRows()} disabled={countingRows || !tables.length}>
            {countingRows ? (isUk ? "Рахуємо…" : "Counting…") : isUk ? "Порахувати рядки" : "Count rows"}
          </button>
        </div>
      )}

      {driftRows.length > 0 && (
        <div className="data-studio-alert warning" role="alert">
          <strong>{isUk ? "Виявлено розбіжність схеми" : "Schema drift detected"}</strong>
          <ul>{driftRows.map((row) => <li key={row}>{row}</li>)}</ul>
        </div>
      )}

      {overview && tables.length === 0 && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "Таблиць ще немає. Створіть першу з готової схеми або вручну." : "No tables yet. Create the first one from a template or manually."}
        </div>
      )}

      {overview && tables.length > 0 && (
        <table className="data-studio-table">
          <thead>
            <tr>
              <th>{isUk ? "Таблиця" : "Table"}</th>
              <th>{isUk ? "Поля" : "Fields"}</th>
              <th>RLS</th>
              <th>{isUk ? "Політики" : "Policies"}</th>
              <th>{isUk ? "Індекси" : "Indexes"}</th>
              <th>Rows</th>
              <th>{isUk ? "Дії" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((table) => (
              <tr key={table.name}>
                <td><code>{table.name}</code></td>
                <td title={table.columns.map((column) => `${column.name}: ${column.type}`).join("\n")}>
                  {table.columns.length}
                  {table.columns.length > 0 && <small> · {table.columns.slice(0, 3).map((column) => column.name).join(", ")}{table.columns.length > 3 ? "…" : ""}</small>}
                </td>
                <td>
                  <span className={`status-pill ${table.rlsEnabled ? "allowed" : "denied"}`}>{table.rlsEnabled ? "Enabled" : "Off"}</span>
                  {table.rlsForced && <span className="status-pill allowed" title={isUk ? "FORCE ROW LEVEL SECURITY" : "FORCE ROW LEVEL SECURITY"}>Forced</span>}
                </td>
                <td title={table.policies.join("\n")}>{table.policies.length}</td>
                <td>{table.indexes.length}</td>
                <td>{rowCounts[table.name] === undefined ? "—" : Number.isNaN(rowCounts[table.name]!) ? (isUk ? "помилка" : "error") : rowCounts[table.name]}</td>
                <td className="table-actions">
                  {!readOnly && (
                    <>
                      <button type="button" className="button-secondary" onClick={() => { setEditTable(table.name); setDrawerOpen(true); }} disabled={busy}>
                        {isUk ? "Редагувати" : "Edit"}
                      </button>
                      <button type="button" className="button-secondary" onClick={() => void handleDeleteTable(table)} disabled={busy}>
                        {isUk ? "Видалити" : "Delete"}
                      </button>
                    </>
                  )}
                  <Link className="button-secondary" to={`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data`}>
                    {isUk ? "Відкрити в проєкті" : "Open in project"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    </div>
  );
}

// --- Drawer -----------------------------------------------------------------

interface SchemaDrawerProps {
  isUk: boolean;
  basePath: string;
  readOnly: boolean;
  table: TableSummary | null;
  busy: boolean;
  onClose: () => void;
  onPreview: (operation: SchemaOperation) => Promise<PreviewResult>;
  onApply: (operation: SchemaOperation, preview: PreviewResult) => Promise<void>;
  onNotify: (message: string, type?: Feedback["type"]) => void;
}

function SchemaDrawer({ isUk, basePath, readOnly, table, busy, onClose, onPreview, onApply, onNotify }: SchemaDrawerProps) {
  const editing = Boolean(table);
  const [mode, setMode] = useState<"template" | "manual">(editing ? "manual" : "template");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSummary | null>(null);
  const [seedDemoData, setSeedDemoData] = useState(false);
  const [collectionName, setCollectionName] = useState(table?.name ?? "");
  const [renameTo, setRenameTo] = useState("");
  const [fields, setFields] = useState<FieldDefinition[]>([{ name: "", type: "string", required: false }]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pendingOperation, setPendingOperation] = useState<SchemaOperation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [mode, editing]);

  useEffect(() => {
    if (mode !== "template" || templates.length || templatesLoading) return;
    setTemplatesLoading(true);
    void apiFetch<{ templates: TemplateSummary[] }>(`${basePath}/templates`)
      .then((result) => setTemplates(result.templates ?? []))
      .catch((cause) => setTemplatesError(cause instanceof Error ? cause.message : "Could not load templates"))
      .finally(() => setTemplatesLoading(false));
  }, [basePath, mode, templates.length, templatesLoading]);

  const resetPreview = () => { setPreview(null); setPendingOperation(null); setLocalError(null); };

  const describeOperation = (operation: SchemaOperation): string => {
    switch (operation.kind) {
      case "create_collection": return isUk ? `Створити таблицю ${operation.collection}` : `Create table ${operation.collection}`;
      case "drop_collection": return isUk ? `Видалити таблицю ${operation.collection}` : `Drop table ${operation.collection}`;
      case "rename_collection": return isUk ? `Перейменувати ${operation.collection} → ${operation.next}` : `Rename ${operation.collection} → ${operation.next}`;
      case "add_field": return isUk ? `Додати поле ${operation.field.name}` : `Add field ${operation.field.name}`;
      case "alter_field": return isUk ? `Змінити поле ${operation.field.name}` : `Alter field ${operation.field.name}`;
      case "drop_field": return isUk ? `Видалити поле ${operation.field}` : `Drop field ${operation.field}`;
      default: return operation.kind;
    }
  };

  const runPreview = async (operation: SchemaOperation) => {
    setWorking(true);
    setLocalError(null);
    try {
      const result = await onPreview(operation);
      setPreview(result);
      setPendingOperation(operation);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Preview failed");
    } finally {
      setWorking(false);
    }
  };

  const runApply = async () => {
    if (!pendingOperation || !preview) return;
    if (preview.destructive || preview.requiresSnapshot) {
      const confirmed = await confirmModal({
        title: isUk ? "Підтвердіть зміну" : "Confirm change",
        message: isUk
          ? `${describeOperation(pendingOperation)} — руйнівна зміна. Перед застосуванням автоматично створюється snapshot.`
          : `${describeOperation(pendingOperation)} is destructive. A snapshot is taken automatically before applying.`,
        isDanger: true,
        confirmText: isUk ? "Застосувати" : "Apply",
      });
      if (!confirmed) return;
    }
    setWorking(true);
    try {
      await onApply(pendingOperation, preview);
      resetPreview();
      if (!editing) {
        setCollectionName("");
        setFields([{ name: "", type: "string", required: false }]);
        setSelectedTemplate(null);
        setSeedDemoData(false);
      }
    } catch {
      // the page reports the failure
    } finally {
      setWorking(false);
    }
  };

  const applyTemplate = async (template: TemplateSummary) => {
    const confirmed = await confirmModal({
      title: isUk ? "Застосувати схему" : "Apply schema",
      message: isUk
        ? `Схему «${template.name}» буде застосовано до dev: ${template.collections.length} таблиць. Продовжити?`
        : `Template “${template.name}” will be applied to dev: ${template.collections.length} tables. Continue?`,
      confirmText: isUk ? "Застосувати" : "Apply",
    });
    if (!confirmed) return;
    setWorking(true);
    setLocalError(null);
    try {
      const result = await apiFetch<{ collections: string[]; seededRows?: number }>(`${basePath}/templates/apply`, {
        method: "POST",
        body: JSON.stringify({ templateId: template.id, seedDemoData, approved: true }),
      });
      onNotify(
        isUk
          ? `Схему застосовано: ${result.collections?.length ?? 0} таблиць${result.seededRows ? `, демо-рядків: ${result.seededRows}` : ""}`
          : `Schema applied: ${result.collections?.length ?? 0} tables${result.seededRows ? `, demo rows: ${result.seededRows}` : ""}`,
      );
      onClose();
    } catch (cause) {
      const code = errorCode(cause);
      setLocalError(
        code === "PROMOTE_REQUIRED"
          ? (isUk ? "Шаблони застосовуються лише до dev." : "Templates can only be applied to dev.")
          : code === "APPROVAL_REQUIRED"
            ? (isUk ? "Потрібне підтвердження застосування схеми." : "Applying a schema needs confirmation.")
            : cause instanceof Error ? cause.message : "Template apply failed",
      );
    } finally {
      setWorking(false);
    }
  };

  const manualFieldsValid = fields.length > 0 && fields.every((field) => IDENTIFIER_PATTERN.test(field.name));
  const collectionValid = IDENTIFIER_PATTERN.test(collectionName);

  const buildManualOperations = (): SchemaOperation[] => {
    if (editing && table) {
      const operations: SchemaOperation[] = [];
      if (renameTo.trim() && renameTo.trim() !== table.name && IDENTIFIER_PATTERN.test(renameTo.trim())) {
        operations.push({ kind: "rename_collection", collection: table.name, next: renameTo.trim() });
      }
      for (const field of fields) {
        if (!IDENTIFIER_PATTERN.test(field.name)) continue;
        const existing = table.columns.find((column) => column.name === field.name);
        operations.push(existing
          ? { kind: "alter_field", collection: table.name, field }
          : { kind: "add_field", collection: table.name, field });
      }
      return operations;
    }
    return [{ kind: "create_collection", collection: collectionName, fields }];
  };

  return (
    <div className="data-studio-drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="data-studio-drawer" role="dialog" aria-modal="true" aria-label={editing ? (isUk ? "Редагування таблиці" : "Edit table") : isUk ? "Нова таблиця" : "New table"}>
        <header className="data-studio-drawer-header">
          <h3>{editing ? (isUk ? `Таблиця ${table!.name}` : `Table ${table!.name}`) : isUk ? "Нова таблиця" : "New table"}</h3>
          <button type="button" className="data-studio-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>×</button>
        </header>

        {!editing && (
          <div className="ds-segmented" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "template"} className={mode === "template" ? "active" : ""} onClick={() => { setMode("template"); resetPreview(); }}>
              {isUk ? "Зі схеми" : "From template"}
            </button>
            <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "active" : ""} onClick={() => { setMode("manual"); resetPreview(); }}>
              {isUk ? "Вручну" : "Manual"}
            </button>
          </div>
        )}

        <div className="data-studio-drawer-body">
          {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

          {mode === "template" && !editing && (
            <>
              {templatesLoading && <p>{isUk ? "Завантаження схем…" : "Loading templates…"}</p>}
              {templatesError && <div className="data-studio-alert error" role="alert">{templatesError}</div>}
              <div className="ds-template-list">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`ds-template-card ${selectedTemplate?.id === template.id ? "active" : ""}`}
                    onClick={() => setSelectedTemplate(template)}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                    <div className="data-studio-chip-row">
                      {template.collections.slice(0, 6).map((collection) => (
                        <span key={collection.name} className="data-studio-chip">{collection.name} · {collection.fields}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              {selectedTemplate && (
                <>
                  <div className="ds-drawer-summary">
                    <strong>{isUk ? "Буде створено" : "Will be created"}:</strong>
                    <ul>{selectedTemplate.collections.map((collection) => <li key={collection.name}>{collection.name} — {collection.fields} {isUk ? "полів" : "fields"}</li>)}</ul>
                  </div>
                  <label className="ds-checkbox">
                    <input type="checkbox" checked={seedDemoData} onChange={(event) => setSeedDemoData(event.target.checked)} />
                    <span>{isUk ? "Додати демо-дані (тільки dev)" : "Add demo data (dev only)"}</span>
                  </label>
                  <button type="button" className="button-primary" disabled={working || busy} onClick={() => void applyTemplate(selectedTemplate)}>
                    {working ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати схему" : "Apply schema"}
                  </button>
                </>
              )}
            </>
          )}

          {mode === "manual" && (
            <>
              {!editing && (
                <label className="ds-field-block">
                  <span>{isUk ? "Назва таблиці" : "Table name"}</span>
                  <input
                    ref={firstFieldRef}
                    value={collectionName}
                    onChange={(event) => { setCollectionName(event.target.value.trim().toLowerCase()); resetPreview(); }}
                    placeholder="products"
                    pattern="[a-z][a-z0-9_]*"
                  />
                  {collectionName && !collectionValid && <small className="ds-hint-error">{isUk ? "Лише a-z, 0-9 та _; починається з літери" : "Only a-z, 0-9 and _; must start with a letter"}</small>}
                </label>
              )}

              {editing && (
                <label className="ds-field-block">
                  <span>{isUk ? "Перейменувати таблицю (необовʼязково)" : "Rename table (optional)"}</span>
                  <input value={renameTo} onChange={(event) => { setRenameTo(event.target.value.trim().toLowerCase()); resetPreview(); }} placeholder={table!.name} />
                </label>
              )}

              <div className="ds-fields">
                <strong>{isUk ? "Поля" : "Fields"}</strong>
                {fields.map((field, index) => (
                  <div key={index} className="ds-field-row">
                    <input
                      value={field.name}
                      placeholder={isUk ? "назва" : "name"}
                      onChange={(event) => {
                        const value = event.target.value.trim().toLowerCase();
                        setFields((current) => current.map((item, position) => position === index ? { ...item, name: value } : item));
                        resetPreview();
                      }}
                    />
                    <select
                      value={field.type}
                      onChange={(event) => {
                        const value = event.target.value as FieldType;
                        setFields((current) => current.map((item, position) => position === index ? { ...item, type: value } : item));
                        resetPreview();
                      }}
                    >
                      {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <label className="ds-checkbox">
                      <input
                        type="checkbox"
                        checked={field.required === true}
                        onChange={(event) => {
                          const value = event.target.checked;
                          setFields((current) => current.map((item, position) => position === index ? { ...item, required: value } : item));
                          resetPreview();
                        }}
                      />
                      <span>{isUk ? "Обовʼязкове" : "Required"}</span>
                    </label>
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={isUk ? "Видалити поле" : "Remove field"}
                      disabled={editing && Boolean(table!.columns.find((column) => column.name === field.name))}
                      onClick={() => { setFields((current) => current.filter((_item, position) => position !== index)); resetPreview(); }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="button-secondary" onClick={() => { setFields((current) => [...current, { name: "", type: "string", required: false }]); resetPreview(); }}>
                  + {isUk ? "Додати поле" : "Add field"}
                </button>
              </div>

              {editing && (
                <div className="ds-fields">
                  <strong>{isUk ? "Видалити поле" : "Drop field"}</strong>
                  {table!.columns.map((column) => (
                    <div key={column.name} className="ds-field-row">
                      <code>{column.name}</code>
                      <span>{column.type}</span>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={working || busy}
                        onClick={() => void runPreview({ kind: "drop_field", collection: table!.name, field: column.name })}
                      >
                        {isUk ? "Видалити" : "Drop"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="ds-drawer-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={working || busy || (editing ? false : !(collectionValid && manualFieldsValid))}
                  onClick={() => {
                    const operations = buildManualOperations();
                    if (!operations.length) { setLocalError(isUk ? "Немає змін для застосування" : "Nothing to apply"); return; }
                    void runPreview(operations[0]!);
                  }}
                >
                  {isUk ? "Переглянути" : "Preview"}
                </button>
              </div>
            </>
          )}

          {preview && pendingOperation && (
            <div className="ds-preview">
              <div className="preview-flags">
                <span className={`status-pill ${preview.reversible ? "allowed" : "denied"}`}>{preview.reversible ? "reversible" : "not reversible"}</span>
                <span className={`status-pill ${preview.destructive ? "denied" : "allowed"}`}>{preview.destructive ? "destructive" : "safe"}</span>
                {preview.requiresSnapshot && <span className="status-pill requires-approval">snapshot</span>}
              </div>
              <p><strong>{describeOperation(pendingOperation)}</strong></p>
              <pre className="ds-sql"><code>{preview.upSql}</code></pre>
              <button type="button" className="button-primary" disabled={working || busy} onClick={() => void runApply()}>
                {working ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати" : "Apply"}
              </button>
            </div>
          )}

          {readOnly && <div className="data-studio-alert info" role="status">{isUk ? "prod — лише перегляд" : "prod is read-only"}</div>}
        </div>
      </aside>
    </div>
  );
}

export default DataStudioSettingsPage;
