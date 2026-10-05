import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId, readCachedCompanies } from "./active-company";
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

interface BackendSummary {
  id: string;
  name: string;
  provider: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

interface BackendEnvironment {
  environment: "dev" | "prod";
  status: string;
  syncStatus: string;
  schemaFingerprint?: string | null;
}

interface QuotaReport {
  environment: string;
  usage: { bytes: number; connections: number };
  limits: { maxDatabaseBytes: number; maxConnections?: number };
  state: "ok" | "warning" | "exceeded";
  databasePercent: number;
  writesBlocked: boolean;
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
type DatabaseFilter = "all" | "ready" | "attention";

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

function statusPillClass(status: string): string {
  if (status === "ready") return "allowed";
  if (status === "error" || status === "deleted") return "denied";
  return "requires-approval";
}

function syncPillClass(syncStatus: string | undefined): string {
  return syncStatus === "synced" ? "allowed" : "requires-approval";
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || bytes === undefined) return "—";
  const value = bytes as number;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

  const [backends, setBackends] = useState<BackendSummary[]>([]);
  const [environments, setEnvironments] = useState<Record<string, BackendEnvironment[]>>({});
  const [backendsLoading, setBackendsLoading] = useState(false);
  const [backendsError, setBackendsError] = useState<{ message: string; code?: string } | null>(null);
  const [tableCounts, setTableCounts] = useState<Record<string, number | null>>({});
  const [quotas, setQuotas] = useState<Record<string, QuotaReport | null>>({});
  const [reloadToken, setReloadToken] = useState(0);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [databaseFilter, setDatabaseFilter] = useState<DatabaseFilter>("all");

  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [countingRows, setCountingRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backendBusy, setBackendBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTable, setEditTable] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const notify = useCallback((message: string, type: Feedback["type"] = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  }, []);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const tables = useMemo(() => [...(overview?.schema?.tables ?? [])].sort((left, right) => left.name.localeCompare(right.name)), [overview]);
  const readOnly = environment === "prod";
  const detail = useMemo(() => backends.find((backend) => backend.id === detailId) ?? null, [backends, detailId]);
  const detailProjects = useMemo(() => projects.filter((item) => item.dataBackendId === detailId), [projects, detailId]);

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

  // 2. Databases + projects of the selected company
  useEffect(() => {
    if (!companyId) {
      setProjects([]); setProjectId(""); setBackends([]); setEnvironments({}); setTableCounts({});
      return;
    }
    let cancelled = false;
    setBackendsLoading(true);
    setBackendsError(null);
    void (async () => {
      try {
        const [projectResult, backendResult] = await Promise.all([
          apiFetch<{ projects: ProjectSummary[] }>(`/companies/${encodeURIComponent(companyId)}/projects`),
          apiFetch<{ backends: BackendSummary[] }>(`/companies/${encodeURIComponent(companyId)}/data-backends`),
        ]);
        if (cancelled) return;
        const projectList = projectResult.projects ?? [];
        const backendList = backendResult.backends ?? [];
        setProjects(projectList);
        setProjectId((current) => {
          if (current && projectList.some((item) => item.id === current)) return current;
          return (projectList.find((item) => item.dataBackendId) ?? projectList[0])?.id ?? "";
        });
        setBackends(backendList);
        const details = await Promise.all(backendList.map((backend) => apiFetch<{ environments: BackendEnvironment[] }>(
          `/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(backend.id)}`,
        ).catch(() => ({ environments: [] as BackendEnvironment[] }))));
        if (cancelled) return;
        setEnvironments(Object.fromEntries(backendList.map((backend, index) => [backend.id, details[index]?.environments ?? []])));

        // Table counts are only used as a hint: silently ignore failures.
        const withProjects = backendList
          .map((backend) => ({ backend, attached: projectList.find((item) => item.dataBackendId === backend.id) }))
          .filter((entry) => Boolean(entry.attached));
        if (!withProjects.length) {
          setTableCounts({});
          return;
        }
        const counts = await Promise.all(withProjects.map(async ({ backend, attached }) => {
          try {
            const result = await apiFetch<{ schema: { tables: unknown[] } | null }>(
              `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(attached!.id)}/data-studio/dev`,
            );
            return [backend.id, result.schema?.tables.length ?? 0] as const;
          } catch {
            return [backend.id, null] as const;
          }
        }));
        if (!cancelled) setTableCounts(Object.fromEntries(counts));
      } catch (cause) {
        if (cancelled) return;
        setBackends([]); setEnvironments({}); setTableCounts({});
        setBackendsError({ message: cause instanceof Error ? cause.message : "Could not load Data Studio", code: errorCode(cause) });
      } finally {
        if (!cancelled) setBackendsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, reloadToken]);

  // 3. Quotas of the opened database
  useEffect(() => {
    if (!companyId || !detailId) { setQuotas({}); return; }
    let cancelled = false;
    void Promise.all((["dev", "prod"] as const).map(async (env) => {
      try {
        const report = await apiFetch<QuotaReport>(`/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(detailId)}/quotas?environment=${env}`);
        return [env, report] as const;
      } catch {
        return [env, null] as const;
      }
    })).then((entries) => { if (!cancelled) setQuotas(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [companyId, detailId, reloadToken]);

  // 4. Table area of the opened database
  useEffect(() => {
    if (!detailId) return;
    const attached = projects.filter((item) => item.dataBackendId === detailId);
    if (!attached.some((item) => item.id === projectId)) setProjectId(attached[0]?.id ?? "");
  }, [detailId, projects, projectId]);

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

  // --- Database actions -----------------------------------------------------

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const createDatabase = useCallback(async (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => {
    setBackendBusy(true);
    try {
      const created = await apiFetch<BackendSummary>(`/companies/${encodeURIComponent(companyId)}/data-backends`, {
        method: "POST",
        body: JSON.stringify({ name: input.name, provider: input.provider, connectionString: input.connectionString || undefined }),
      });
      notify(isUk ? `Базу «${created.name}» створено` : `Database “${created.name}” created`);
      setCreateOpen(false);
      setDetailId(created.id);
      setDatabaseFilter("all");
      refresh();
    } catch (cause) {
      const code = errorCode(cause);
      notify(
        code === "DATABASE_EXISTS"
          ? (isUk ? "База для цього середовища вже існує" : "A database already exists for this environment")
          : code === "PROVISIONER_UNAVAILABLE"
            ? (isUk ? "Провізіонер недоступний — перевірте контейнер postgres-projects" : "Provisioner unavailable — check the postgres-projects container")
            : code === "INVALID_CONNECTION_STRING"
              ? (isUk ? "Рядок підключення має бути у форматі postgres://…" : "The connection string must look like postgres://…")
              : cause instanceof Error ? cause.message : "Could not create the database",
        "error",
      );
      throw cause;
    } finally {
      setBackendBusy(false);
    }
  }, [companyId, isUk, notify, refresh]);

  const toggleArchive = useCallback(async (backend: BackendSummary) => {
    const archiving = backend.status === "ready";
    if (archiving) {
      const confirmed = await confirmModal({
        title: isUk ? "Архівувати базу" : "Archive database",
        message: isUk
          ? `Базу «${backend.name}» буде заархівовано: доступ проєктів до даних зупиниться, дані збережуться.`
          : `“${backend.name}” will be archived: projects lose data access, the data itself is kept.`,
        confirmText: isUk ? "Архівувати" : "Archive",
        isDanger: true,
      });
      if (!confirmed) return;
    }
    setBackendBusy(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(backend.id)}/${archiving ? "archive" : "activate"}`, { method: "POST" });
      notify(archiving ? (isUk ? "Базу заархівовано" : "Database archived") : (isUk ? "Базу активовано" : "Database activated"));
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not update the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [companyId, isUk, notify, refresh]);

  const renameDatabase = useCallback(async (backend: BackendSummary) => {
    const name = await promptModal({
      title: isUk ? "Перейменувати базу" : "Rename database",
      message: isUk ? "Нова назва бази даних" : "New database name",
      placeholder: backend.name,
      defaultValue: backend.name,
    });
    const clean = (name ?? "").trim();
    if (!clean || clean === backend.name) return;
    setBackendBusy(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(backend.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: clean }),
      });
      notify(isUk ? "Назву оновлено" : "Name updated");
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not rename the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [companyId, isUk, notify, refresh]);

  const deleteDatabase = useCallback(async (backend: BackendSummary) => {
    const confirmed = await confirmModal({
      title: isUk ? "Видалити базу" : "Delete database",
      message: isUk
        ? `Базу «${backend.name}» буде видалено. Проєкти втратят доступ до даних, а сама база зникне після вікна збереження бекапів.`
        : `“${backend.name}” will be deleted. Projects lose their data and the database is removed after the backup retention window.`,
      confirmText: isUk ? "Продовжити" : "Continue",
      isDanger: true,
    });
    if (!confirmed) return;
    const typed = await promptModal({
      title: isUk ? "Підтвердіть видалення" : "Confirm deletion",
      message: isUk ? `Введіть назву бази «${backend.name}», щоб підтвердити.` : `Type the database name “${backend.name}” to confirm.`,
      placeholder: backend.name,
    });
    if (typed !== backend.name) {
      if (typed !== null) notify(isUk ? "Назва не збігається — скасовано" : "Name does not match — cancelled", "error");
      return;
    }
    setBackendBusy(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(backend.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: backend.name }),
      });
      notify(isUk ? "Базу позначено на видалення" : "Database marked for deletion");
      if (detailId === backend.id) setDetailId(null);
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not delete the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [companyId, detailId, isUk, notify, refresh]);

  const attachProject = useCallback(async (targetProjectId: string, backendId: string | null) => {
    setBackendBusy(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(targetProjectId)}/data-backend`, backendId
        ? { method: "PUT", body: JSON.stringify({ dataBackendId: backendId }) }
        : { method: "DELETE" });
      notify(backendId ? (isUk ? "Проєкт прикріплено" : "Project attached") : (isUk ? "Проєкт відкріплено" : "Project detached"));
      if (!backendId && projectId === targetProjectId) setOverview(null);
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not update the attachment", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [companyId, isUk, notify, projectId, refresh]);

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
      refresh();
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
  }, [basePath, overview?.environment.schemaFingerprint, notify, isUk, loadOverview, refresh]);

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

  // --- Derived view data ----------------------------------------------------

  const stats = useMemo(() => {
    const readyEnvironments = backends.reduce((total, backend) => {
      const list = environments[backend.id] ?? [];
      return total + list.filter((env) => env.status === "ready").length;
    }, 0);
    const totalEnvironments = backends.reduce((total, backend) => total + Math.max((environments[backend.id] ?? []).length, 0), 0);
    const known = Object.values(tableCounts).filter((count): count is number => typeof count === "number");
    return {
      total: backends.length,
      ready: backends.filter((backend) => backend.status === "ready").length,
      attention: backends.filter((backend) => backend.status !== "ready").length,
      readyEnvironments,
      totalEnvironments: totalEnvironments || backends.length * 2,
      tables: known.length ? known.reduce((total, count) => total + count, 0) : null,
      attachedProjects: projects.filter((item) => item.dataBackendId).length,
    };
  }, [backends, environments, projects, tableCounts]);

  const filteredBackends = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return backends.filter((backend) => {
      if (databaseFilter === "ready" && backend.status !== "ready") return false;
      if (databaseFilter === "attention" && backend.status === "ready") return false;
      if (!query) return true;
      return backend.name.toLowerCase().includes(query) || backend.provider.toLowerCase().includes(query);
    });
  }, [backends, databaseFilter, searchQuery]);

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

  const unattachedProjects = useMemo(() => projects.filter((item) => !item.dataBackendId), [projects]);

  const backButton = (
    <Link to="/settings" className="marketplace-back-button" aria-label={isUk ? "До налаштувань" : "Back to settings"} title={isUk ? "До налаштувань" : "Back to settings"}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </Link>
  );

  const companySelect = companies.length > 1 && (
    <select
      aria-label={isUk ? "Компанія" : "Company"}
      className="page-size-select"
      value={companyId}
      onChange={(event) => { setCompanyId(event.target.value); setDetailId(null); }}
    >
      {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </select>
  );

  const unavailableNotice = backendsError?.code === "DATA_STUDIO_UNAVAILABLE" && (
    <div className="data-studio-alert error" role="alert">
      {isUk
        ? "Data Studio вимкнено на цій інсталяції (немає контейнера postgres-projects або provisioner)."
        : "Data Studio is disabled on this installation (no postgres-projects container / provisioner)."}
    </div>
  );

  // --- Detail view ----------------------------------------------------------

  if (detail) {
    const detailEnvironments = environments[detail.id] ?? [];
    const envOrder: Array<"dev" | "prod"> = ["dev", "prod"];

    return (
      <main className="automations-container">
        <header className="inspector-header automations-header">
          <div className="automations-header-top">
            <div>
              <p className="eyebrow">{isUk ? "Налаштування · Data Studio" : "Settings · Data Studio"}</p>
              <h1>
                <button type="button" className="marketplace-back-button" onClick={() => setDetailId(null)} aria-label={isUk ? "Усі бази даних" : "All databases"} title={isUk ? "Усі бази даних" : "All databases"}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                </button>
                <span>{detail.name}</span>
              </h1>
              <p className="hero-copy">
                <span className={`status-pill ${statusPillClass(detail.status)}`}>{detail.status}</span>{" "}
                <span className="data-studio-badge">{detail.provider === "external_postgres" ? (isUk ? "зовнішня" : "external") : "NPATI"}</span>{" "}
                {detailEnvironments.map((env) => (
                  <span key={env.environment} className={`status-pill ${syncPillClass(env.syncStatus)}`}>{env.environment}: {env.syncStatus}</span>
                ))}
              </p>
            </div>
            <div className="automations-header-actions">
              <button type="button" className="button-secondary" onClick={() => { void loadOverview(); refresh(); }} disabled={loading || backendsLoading}>
                {loading || backendsLoading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити" : "Refresh"}
              </button>
              <button type="button" className="button-secondary" onClick={() => void renameDatabase(detail)} disabled={backendBusy}>
                {isUk ? "Перейменувати" : "Rename"}
              </button>
              <button type="button" className="button-secondary" onClick={() => void toggleArchive(detail)} disabled={backendBusy}>
                {detail.status === "ready" ? (isUk ? "Архівувати" : "Archive") : (isUk ? "Активувати" : "Activate")}
              </button>
              <button type="button" className="button-secondary" onClick={() => void deleteDatabase(detail)} disabled={backendBusy}>
                {isUk ? "Видалити" : "Delete"}
              </button>
            </div>
          </div>
        </header>

        {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}

        <section className="overview-grid inspector-stats-grid automations-stats-grid" aria-label={isUk ? "Середовища" : "Environments"}>
          {envOrder.map((envName) => {
            const info = detailEnvironments.find((env) => env.environment === envName);
            const quota = quotas[envName];
            const showLock = overview?.environment.environment === envName && overview?.lock?.held;
            return (
              <div key={envName}>
                <strong>{envName}</strong>
                <span>{info ? `${info.status} · ${info.syncStatus}` : isUk ? "немає даних" : "no data"}</span>
                <small>
                  {quota
                    ? `${formatBytes(quota.usage.bytes)} / ${formatBytes(quota.limits.maxDatabaseBytes)} · ${quota.state}`
                    : isUk ? "квоти недоступні" : "quotas unavailable"}
                </small>
                {showLock && <small>{isUk ? "міграція виконується" : "migration running"}{lockRemaining !== null ? ` · ${lockRemaining}s` : ""}</small>}
                {info?.schemaFingerprint && <small title={info.schemaFingerprint}>{info.schemaFingerprint.slice(0, 12)}…</small>}
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
            <Link to="/settings/websites">{isUk ? "Створити сайт" : "Create a site"}</Link>
          </div>
        )}

        {detailProjects.length > 0 && (
          <div className="data-studio-attachments">
            {detailProjects.map((item) => (
              <div key={item.id} className="ds-attach-row">
                <span className="data-studio-chip">{item.name}{item.type ? ` · ${item.type}` : ""}</span>
                <Link className="automation-action-btn run-btn" to={`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(item.id)}/data`}>
                  {isUk ? "Відкрити Data Studio" : "Open Data Studio"}
                </Link>
                <button type="button" className="automation-action-btn" disabled={backendBusy} onClick={() => void attachProject(item.id, null)}>
                  {isUk ? "Відкріпити" : "Detach"}
                </button>
              </div>
            ))}
          </div>
        )}

        {unattachedProjects.length > 0 && (
          <div className="data-studio-attachments">
            <h3>{isUk ? "Прикріпити проєкт" : "Attach a project"}</h3>
            {unattachedProjects.map((item) => (
              <label key={item.id}>
                <span>{item.name}</span>
                <select
                  aria-label={isUk ? `База для ${item.name}` : `Database for ${item.name}`}
                  value=""
                  disabled={backendBusy}
                  onChange={(event) => { if (event.target.value) void attachProject(item.id, event.target.value); }}
                >
                  <option value="">{isUk ? "До цієї бази" : "To this database"}</option>
                  {backends.filter((backend) => backend.status === "ready").map((backend) => (
                    <option key={backend.id} value={backend.id}>{backend.name}</option>
                  ))}
                </select>
              </label>
            ))}
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
                        <Link className="automation-action-btn" to={`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data`}>
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
      </main>
    );
  }

  // --- Databases list -------------------------------------------------------

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
                ? "Бази даних вашої компанії: кожен новий сайт підключається до бази автоматично, а таблиці створюються тут або агентом."
                : "Your company databases: every new site is attached automatically, and tables are created here or by an agent."}
            </p>
          </div>
          <div className="automations-header-actions">
            {companySelect}
            <button type="button" className="button-primary automations-action-primary" onClick={() => setCreateOpen(true)} disabled={!companyId}>
              ＋ {isUk ? "Нова база даних" : "New database"}
            </button>
          </div>
        </div>
      </header>

      {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}
      {unavailableNotice}
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
          <small>{isUk ? "DataBackend у цій компанії" : "DataBackends in this company"}</small>
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
          <small>{isUk ? `з ${projects.length} у компанії` : `of ${projects.length} in the company`}</small>
        </div>
      </section>

      <div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            className="inspector-search-input"
            placeholder={isUk ? "Пошук за назвою або провайдером…" : "Search by name or provider…"}
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
            <small className="tab-count">{backends.length}</small>
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
            {isUk ? `Показано ${filteredBackends.length} з ${backends.length}` : `Showing ${filteredBackends.length} of ${backends.length}`}
            {searchQuery ? (isUk ? ` за запитом «${searchQuery}»` : ` matching “${searchQuery}”`) : ""}
          </span>
        </div>
      </div>

      {backendsLoading && backends.length === 0 ? (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "240px" }}>{isUk ? "Назва" : "Name"}</th>
                <th style={{ width: "160px" }}>{isUk ? "Провайдер" : "Provider"}</th>
                <th style={{ width: "140px" }}>{isUk ? "Статус" : "Status"}</th>
                <th style={{ width: "240px" }}>dev / prod</th>
                <th style={{ width: "110px" }}>{isUk ? "Таблиць" : "Tables"}</th>
                <th style={{ width: "260px", textAlign: "right" }}>{isUk ? "Дії" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, index) => (
                <tr key={`skeleton-${index}`} style={{ opacity: 0.5 }}>
                  <td><span style={{ display: "inline-block", width: "160px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "90px", height: "16px", background: "var(--npati-gray-100)", borderRadius: "4px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "70px", height: "24px", background: "var(--npati-gray-100)", borderRadius: "999px" }} /></td>
                  <td><span style={{ display: "inline-block", width: "140px", height: "24px", background: "var(--npati-gray-100)", borderRadius: "999px" }} /></td>
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
          <button type="button" className="button-primary automations-action-primary" onClick={() => setCreateOpen(true)} disabled={!companyId}>
            ＋ {isUk ? "Створити першу базу" : "Create the first database"}
          </button>
        </div>
      ) : filteredBackends.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{isUk ? "Нічого не знайдено" : "Nothing found"}</h3>
          <p>{isUk ? "Змініть запит або фільтр." : "Change the query or the filter."}</p>
          <button type="button" className="button-secondary" onClick={() => { setSearchQuery(""); setDatabaseFilter("all"); }}>
            {isUk ? "Скинути фільтри" : "Clear filters"}
          </button>
        </div>
      ) : (
        <div className="automations-table-container">
          <table className="automations-table">
            <thead>
              <tr>
                <th style={{ minWidth: "240px" }}>{isUk ? "Назва" : "Name"}</th>
                <th style={{ width: "160px" }}>{isUk ? "Провайдер" : "Provider"}</th>
                <th style={{ width: "140px" }}>{isUk ? "Статус" : "Status"}</th>
                <th style={{ minWidth: "220px" }}>dev / prod</th>
                <th style={{ width: "110px" }}>{isUk ? "Таблиць" : "Tables"}</th>
                <th style={{ width: "110px" }}>{isUk ? "Проєктів" : "Projects"}</th>
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
                    <td>{backend.provider === "external_postgres" ? (isUk ? "Зовнішня" : "External") : "NPATI Postgres"}</td>
                    <td><span className={`status-pill ${statusPillClass(backend.status)}`}>{backend.status}</span></td>
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
                        <button type="button" className="automation-action-btn" disabled={backendBusy} onClick={() => void toggleArchive(backend)}>
                          {backend.status === "ready" ? (isUk ? "Архівувати" : "Archive") : (isUk ? "Активувати" : "Activate")}
                        </button>
                        <button type="button" className="automation-action-btn danger" disabled={backendBusy} onClick={() => void deleteDatabase(backend)}>
                          {isUk ? "Видалити" : "Delete"}
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
          onClose={() => setCreateOpen(false)}
          onCreate={createDatabase}
        />
      )}
    </main>
  );
}

// --- Create database drawer -------------------------------------------------

interface CreateDatabaseDrawerProps {
  isUk: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => Promise<void>;
}

function CreateDatabaseDrawer({ isUk, busy, onClose, onCreate }: CreateDatabaseDrawerProps) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"shared_postgres" | "external_postgres">("shared_postgres");
  const [connectionString, setConnectionString] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, []);

  const connectionValid = provider === "shared_postgres" || /^postgres(ql)?:\/\/\S+/.test(connectionString.trim());
  const canSubmit = name.trim().length > 0 && name.trim().length <= 200 && connectionValid;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onCreate({ name: name.trim(), provider, connectionString: provider === "external_postgres" ? connectionString.trim() : undefined });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Could not create the database");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => onClose()}>
      <aside className="company-drawer automations-drawer" role="dialog" aria-modal="true" aria-label={isUk ? "Нова база даних" : "New database"} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{isUk ? "Data Studio" : "Data Studio"}</span>
            <h2>{isUk ? "Нова база даних" : "New database"}</h2>
          </div>
          <button type="button" className="automations-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <form onSubmit={submit}>
          <section>
            <h3>{isUk ? "Параметри бази" : "Database settings"}</h3>
            <label className="browser-form-field">
              <span>{isUk ? "Назва" : "Name"} <i className="required-star">*</i></span>
              <input
                ref={nameRef}
                value={name}
                maxLength={200}
                placeholder={isUk ? "Наприклад: Магазин — дані" : "For example: Shop data"}
                onChange={(event) => { setName(event.target.value); setLocalError(null); }}
              />
            </label>
            <label className="browser-form-field">
              <span>{isUk ? "Провайдер" : "Provider"}</span>
              <select
                value={provider}
                onChange={(event) => { setProvider(event.target.value as "shared_postgres" | "external_postgres"); setLocalError(null); }}
              >
                <option value="shared_postgres">{isUk ? "Керована NPATI (рекомендовано)" : "NPATI managed (recommended)"}</option>
                <option value="external_postgres">{isUk ? "Зовнішня (Neon / Supabase / RDS)" : "External (Neon / Supabase / RDS)"}</option>
              </select>
            </label>
            {provider === "external_postgres" && (
              <label className="browser-form-field">
                <span>Connection string <i className="required-star">*</i></span>
                <input
                  value={connectionString}
                  placeholder="postgres://user:password@host:5432/database"
                  onChange={(event) => { setConnectionString(event.target.value); setLocalError(null); }}
                />
                {connectionString.trim() && !connectionValid && (
                  <small className="ds-hint-error">{isUk ? "Рядок має починатися з postgres://" : "The string must start with postgres://"}</small>
                )}
                <small>{isUk ? "Рядок шифрується й ніколи не повертається API." : "The string is encrypted and never returned by the API."}</small>
              </label>
            )}
          </section>

          {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

          <div className="browser-form-footer">
            <div className="browser-form-footer-hint">
              {isUk
                ? "Буде створено два середовища (dev і prod) з окремими ролями доступу."
                : "Two environments (dev and prod) with separate access roles will be created."}
            </div>
            <button type="submit" className="button-primary automations-action-primary browser-submit-btn" disabled={!canSubmit || working || busy}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {working || busy ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити базу" : "Create database"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

// --- Schema drawer ----------------------------------------------------------

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
