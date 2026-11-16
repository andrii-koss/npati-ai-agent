import { CompanyScopeSelect } from "./CompanyScopeSelect";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId } from "./active-company";
import {
  ALL_COMPANIES,
  MAX_ROW_COUNT_TABLES,
  apiFetch,
  dataStudioUnavailableMessage,
  summarizeDatabaseStats,
  errorCode,
  DatabaseDetailView,
  DatabasesListView,
  type AppliedMigration,
  type BackendEnvironment,
  type BackendSummary,
  type DatabaseFilter,
  type Feedback,
  type Overview,
  type PreviewResult,
  type ProjectSummary,
  type QuotaReport,
  type SchemaOperation,
  type TableSummary,
  type TransferResult,
} from "./data-studio-settings";

import { useDataStudioCatalog } from "./data-studio-settings/use-catalog";

export * from "./data-studio-settings/types";

// --- Page -------------------------------------------------------------------

export function DataStudioSettingsPage() {
  const { language } = useTranslation();
  const isUk = language === "uk";
  const navigate = useNavigate();
  const location = useLocation();
  const databaseName = useMatch("/settings/data-studio/:databaseName")?.params.databaseName;
  const [resolvedRoute, setResolvedRoute] = useState<{ name: string; backend: BackendSummary } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

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
  const backendsWarning = null;
  const [tableCounts, setTableCounts] = useState<Record<string, number | null>>({});
  const [quotas, setQuotas] = useState<Record<string, QuotaReport | null>>({});
  const [reloadToken, setReloadToken] = useState(0);

  const [openedBackend, setOpenedBackend] = useState<BackendSummary | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const overviewVersion = useRef(0);
  const overviewAbort = useRef<AbortController | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [databaseFilter, setDatabaseFilter] = useState<DatabaseFilter>("all");
  /** Company filter of the list: `all` or a company id. */
  const [companyFilter, setCompanyFilter] = useState<string>(ALL_COMPANIES);
  const [transferOpen, setTransferOpen] = useState(false);

  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [countingRows, setCountingRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backendBusy, setBackendBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTable, setEditTable] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const catalog = useDataStudioCatalog(companyFilter, searchQuery, databaseFilter, reloadToken);
  const companies = catalog.summary?.companies ?? [];
  const backendsLoading = catalog.loading || catalog.settlingSearch;
  const backendsError = catalog.error ? { message: catalog.error instanceof Error ? catalog.error.message : "Could not load databases", code: errorCode(catalog.error) } : null;

  const notify = useCallback((message: string, type: Feedback["type"] = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  }, []);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const tables = useMemo(() => [...(overview?.schema?.tables ?? [])].sort((left, right) => left.name.localeCompare(right.name)), [overview]);
  const readOnly = environment === "prod";
  const routeHint = (location.state as { dataStudioBackend?: BackendSummary } | null)?.dataStudioBackend;
  const routeBackend = databaseName ? (routeHint?.name === databaseName ? routeHint : resolvedRoute?.name === databaseName ? resolvedRoute.backend : null) : null;
  const detail = routeBackend ? (openedBackend?.id === routeBackend.id ? openedBackend : routeBackend) : null;
  const detailId = detail?.id ?? null;
  const openDatabase = useCallback((backend: BackendSummary, replace = false) => {
    navigate(`/settings/data-studio/${encodeURIComponent(backend.name)}`, { replace, state: { dataStudioBackend: backend } });
  }, [navigate]);
  const setDetailId = useCallback((id: string | null) => {
    if (!id) { navigate("/settings/data-studio"); return; }
    const backend = backends.find(item => item.id === id) ?? catalog.data?.items.find(item => item.id === id) ?? (openedBackend?.id === id ? openedBackend : null);
    if (backend) openDatabase(backend);
  }, [backends, catalog.data, openedBackend, navigate, openDatabase]);
  useEffect(() => {
    setRouteError(null);
    if (!databaseName || routeBackend) return;
    const controller = new AbortController();
    void apiFetch<BackendSummary>(`/data-studio/databases/${encodeURIComponent(databaseName)}`, { signal: controller.signal }).then(backend => {
      if (!controller.signal.aborted) setResolvedRoute({ name: databaseName, backend });
    }).catch(cause => {
      if (!controller.signal.aborted) setRouteError(cause instanceof Error ? cause.message : "Could not load database");
    });
    return () => controller.abort();
  }, [databaseName, routeBackend]);
  /** Databases and tables are company-scoped: the opened database dictates the active company. */
  const activeCompanyId = detail?.companyId ?? companyId;
  const detailProjects = useMemo(() => projects.filter((item) => item.dataBackendId === detailId), [projects, detailId]);
  /** Company the "New database" button creates in. */
  const createTargetCompanyId = companyFilter !== ALL_COMPANIES ? companyFilter : companyId;

  // A single paginated metadata request powers the list; details stay lazy.
  useEffect(() => {
    const data = catalog.data;
    if (!data) return;
    setCompanyId(current => data.companies.some(company => company.id === current) ? current : chooseAvailableCompanyId(data.companies));
    setBackends(data.items);
    setEnvironments(current => ({ ...current, ...Object.fromEntries(data.items.map(item => [item.id, item.environments])) }));
    setTableCounts(current => ({ ...current, ...Object.fromEntries(data.items.map(item => [item.id, item.tableCount])) }));
  }, [catalog.data, catalog.queryKey]);

  useEffect(() => {
    if (!detailId || !activeCompanyId) { setOpenedBackend(null); setProjects([]); setProjectId(""); setQuotas({}); return; }
    const controller = new AbortController();
    setWorkspaceLoading(true); setError(null);
    void apiFetch<{ backend: BackendSummary; projects: ProjectSummary[]; environments: BackendEnvironment[]; quotas: Record<string, QuotaReport | null> }>(
      `/companies/${encodeURIComponent(activeCompanyId)}/data-backends/${encodeURIComponent(detailId)}/workspace`, { signal: controller.signal },
    ).then(result => {
      if (controller.signal.aborted) return;
      setOpenedBackend(result.backend);
      setProjects(result.projects);
      setEnvironments(current => ({ ...current, [detailId]: result.environments }));
      setQuotas(result.quotas);
      const attached = result.projects.filter(item => item.dataBackendId === detailId);
      setProjectId(current => attached.some(item => item.id === current) ? current : attached[0]?.id ?? "");
    }).catch(cause => {
      if (!controller.signal.aborted) setError({ message: cause instanceof Error ? cause.message : "Could not load database", code: errorCode(cause) });
    }).finally(() => { if (!controller.signal.aborted) setWorkspaceLoading(false); });
    return () => controller.abort();
  }, [activeCompanyId, detailId, reloadToken]);

  const loadOverview = useCallback(async () => {
    const version = ++overviewVersion.current;
    overviewAbort.current?.abort();
    if (!detailId || !activeCompanyId || !projectId || project?.dataBackendId !== detailId || project.companyId !== activeCompanyId) { setOverview(null); setLoading(false); return; }
    const controller = new AbortController(); overviewAbort.current = controller;
    setLoading(true);
    try {
      const result = await apiFetch<Overview>(`/companies/${encodeURIComponent(activeCompanyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`, { signal: controller.signal });
      if (version !== overviewVersion.current || controller.signal.aborted) return;
      setOverview(result);
      setError(null);
    } catch (cause) {
      if (version !== overviewVersion.current || controller.signal.aborted) return;
      setOverview(null);
      setError({ message: cause instanceof Error ? cause.message : "Could not load Data Studio", code: errorCode(cause) });
    } finally {
      if (version === overviewVersion.current) setLoading(false);
    }
  }, [detailId, activeCompanyId, projectId, project?.dataBackendId, project?.companyId, environment]);

  useEffect(() => { void loadOverview(); return () => { ++overviewVersion.current; overviewAbort.current?.abort(); }; }, [loadOverview]);
  useEffect(() => { setRowCounts({}); }, [projectId, environment]);

  // --- Database actions -----------------------------------------------------

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const createDatabase = useCallback(async (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => {
    if (!createTargetCompanyId) return;
    setBackendBusy(true);
    try {
      const created = await apiFetch<BackendSummary>(`/companies/${encodeURIComponent(createTargetCompanyId)}/data-backends`, {
        method: "POST",
        body: JSON.stringify({ name: input.name, provider: input.provider, connectionString: input.connectionString || undefined }),
      });
      notify(isUk ? `Базу «${created.name}» створено` : `Database “${created.name}” created`);
      setOpenedBackend({ ...created, companyId: createTargetCompanyId, companyName: companies.find(item => item.id === createTargetCompanyId)?.name ?? "" });
      setCreateOpen(false);
      openDatabase({ ...created, companyId: createTargetCompanyId, companyName: companies.find(item => item.id === createTargetCompanyId)?.name ?? "" });
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
  }, [createTargetCompanyId, companies, isUk, notify, refresh, openDatabase]);

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
      await apiFetch(`/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}/${archiving ? "archive" : "activate"}`, { method: "POST" });
      notify(archiving ? (isUk ? "Базу заархівовано" : "Database archived") : (isUk ? "Базу активовано" : "Database activated"));
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not update the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [isUk, notify, refresh]);

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
      await apiFetch(`/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: clean }),
      });
      notify(isUk ? "Назву оновлено" : "Name updated");
      setBackends(current => current.map(item => item.id === backend.id ? { ...item, name: clean } : item));
      setOpenedBackend(current => current?.id === backend.id ? { ...current, name: clean } : current);
      openDatabase({ ...backend, name: clean }, true);
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not rename the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [isUk, notify, refresh, openDatabase]);

  const deleteDatabase = useCallback(async (backend: BackendSummary) => {
    const confirmed = await confirmModal({
      title: isUk ? "Видалити базу" : "Delete database",
      message: isUk
        ? `Базу «${backend.name}» буде видалено зараз, без очікування. ${backend.provider === "external_postgres" ? "Зовнішня база залишиться у її провайдера; підключення до NPATI буде видалено." : "Бази dev/prod та їхні дані буде фізично видалено."} Усі приєднані проєкти буде відв’язано від цієї бази. Самі проєкти залишаться.`
        : `“${backend.name}” will be deleted now, without waiting. ${backend.provider === "external_postgres" ? "The external database remains with its provider; its NPATI connection will be removed." : "The dev/prod databases and their data will be physically deleted."} All attached projects will be disconnected from this database. The projects will remain.`,
      confirmText: isUk ? "Продовжити" : "Continue",
      isDanger: true,
    });
    if (!confirmed) return;
    const typed = await promptModal({
      title: isUk ? "Підтвердіть видалення" : "Confirm deletion",
      message: isUk ? `База даних:\n${backend.name}\n\nВведіть DELETE, щоб підтвердити видалення.` : `Database:\n${backend.name}\n\nType DELETE to confirm deletion.`,
      placeholder: "DELETE",
      confirmText: isUk ? "Видалити зараз" : "Delete now",
      isDanger: true,
    });
    if (typed?.trim() !== "DELETE") {
      if (typed !== null) notify(isUk ? "Для підтвердження введіть DELETE" : "Type DELETE to confirm", "error");
      return;
    }
    setBackendBusy(true);
    try {
      const result = await apiFetch<{ deleted: boolean; deferred: boolean; removeAfter?: string }>(`/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: backend.name, detachProjects: true, immediate: true }),
      });
      const deadline = result.removeAfter ? new Date(result.removeAfter).toLocaleString(isUk ? "uk-UA" : "en-US") : "";
      notify(result.deferred
        ? (isUk ? `Базу відв’язано від проєктів. Очікує фізичного видалення${deadline ? ` після ${deadline}` : ""}.` : `Database disconnected from projects. Pending physical deletion${deadline ? ` after ${deadline}` : ""}.`)
        : (isUk ? "Базу видалено" : "Database deleted"));
      if (result.deleted) {
        setBackends(current => current.filter(item => item.id !== backend.id));
        setProjects(current => current.map(item => item.dataBackendId === backend.id ? { ...item, dataBackendId: null } : item));
      }
      if (detailId === backend.id) setDetailId(null);
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not delete the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [detailId, isUk, notify, refresh]);

  const deleteDatabases = useCallback(async (targets: BackendSummary[]) => {
    if (!targets.length) return;
    const count = targets.length;
    const confirmed = await confirmModal({
      title: isUk ? "Масове видалення баз даних" : "Bulk delete databases",
      message: isUk
        ? `Буде видалено ${count} баз даних зараз, без очікування. Бази dev/prod та їхні дані буде фізично видалено. Усі приєднані проєкти буде відв’язано від цих баз. Самі проєкти залишаться.`
        : `${count} databases will be deleted now, without waiting. The dev/prod databases and their data will be physically deleted. All attached projects will be disconnected from these databases. The projects will remain.`,
      confirmText: isUk ? "Продовжити" : "Continue",
      isDanger: true,
    });
    if (!confirmed) return;

    const namesSample = targets.slice(0, 5).map((b) => `«${b.name}»`).join(", ");
    const remainingCount = count > 5 ? ` ${isUk ? `та ще ${count - 5}` : `and ${count - 5} more`}` : "";
    const typed = await promptModal({
      title: isUk ? "Підтвердіть масове видалення" : "Confirm bulk deletion",
      message: isUk
        ? `Бази даних (${count}):\n${namesSample}${remainingCount}\n\nВведіть DELETE, щоб підтвердити видалення.`
        : `Databases (${count}):\n${namesSample}${remainingCount}\n\nType DELETE to confirm deletion.`,
      placeholder: "DELETE",
      confirmText: isUk ? `Видалити ${count} баз` : `Delete ${count} databases`,
      isDanger: true,
    });
    if (typed?.trim() !== "DELETE") {
      if (typed !== null) notify(isUk ? "Для підтвердження введіть DELETE" : "Type DELETE to confirm", "error");
      return;
    }

    setBackendBusy(true);
    let succeeded = 0;
    let failed = 0;
    const deletedIds = new Set<string>();

    try {
      for (const [i, backend] of targets.entries()) {
        notify(
          isUk
            ? `Видалення ${i + 1} з ${count}: «${backend.name}»…`
            : `Deleting ${i + 1} of ${count}: “${backend.name}”…`,
          "info"
        );
        try {
          const result = await apiFetch<{ deleted: boolean; deferred: boolean; removeAfter?: string }>(
            `/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}`,
            {
              method: "DELETE",
              body: JSON.stringify({ confirmName: backend.name, detachProjects: true, immediate: true }),
            }
          );
          if (result.deleted) {
            succeeded++;
            deletedIds.add(backend.id);
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      if (deletedIds.size > 0) {
        setBackends((current) => current.filter((item) => !deletedIds.has(item.id)));
        setProjects((current) =>
          current.map((item) =>
            item.dataBackendId && deletedIds.has(item.dataBackendId)
              ? { ...item, dataBackendId: null }
              : item
          )
        );
        if (detailId && deletedIds.has(detailId)) setDetailId(null);
      }

      if (failed === 0) {
        notify(
          isUk
            ? `Успішно видалено ${succeeded} ${succeeded === 1 ? "базу даних" : succeeded < 5 ? "бази даних" : "баз даних"}`
            : `Successfully deleted ${succeeded} database${succeeded === 1 ? "" : "s"}`
        );
      } else {
        notify(
          isUk
            ? `Видалено ${succeeded} баз даних, помилка при видаленні: ${failed}`
            : `Deleted ${succeeded} database(s), failed to delete: ${failed}`,
          "error"
        );
      }
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not delete databases", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [detailId, isUk, notify, refresh]);


  /** Moves a database (with all of its data) into another company of the same workspace. */
  const transferDatabase = useCallback(async (backend: BackendSummary, input: { targetCompanyId: string; confirmName: string }): Promise<void> => {
    setBackendBusy(true);
    try {
      const result = await apiFetch<TransferResult>(
        `/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}/transfer`,
        { method: "POST", body: JSON.stringify(input) },
      );
      notify(isUk
        ? `Базу перенесено до «${result.targetCompanyName}». Від'єднано проєктів: ${result.detachedProjects}.`
        : `Database moved to “${result.targetCompanyName}”. Detached projects: ${result.detachedProjects}.`);
      setTransferOpen(false);
      setDetailId(null);
      setCompanyFilter(ALL_COMPANIES);
      refresh();
    } catch (cause) {
      const code = errorCode(cause);
      notify(dataStudioUnavailableMessage(isUk), "error");
      throw cause;
    } finally {
      setBackendBusy(false);
    }
  }, [isUk, notify, refresh]);

  const attachProject = useCallback(async (targetCompanyId: string, targetProjectId: string, backendId: string | null) => {
    setBackendBusy(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(targetCompanyId)}/projects/${encodeURIComponent(targetProjectId)}/data-backend`, backendId
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
  }, [isUk, notify, projectId, refresh]);

  // --- Schema operations ----------------------------------------------------

  const basePath = `/companies/${encodeURIComponent(activeCompanyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`;

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
      const result = await apiFetch<{ counts: Record<string, number> }>(`${basePath}/collections/counts`, {
        method: "POST", body: JSON.stringify({ collections: tables.slice(0, MAX_ROW_COUNT_TABLES).map(table => table.name) }),
      });
      setRowCounts(result.counts);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not count rows", "error");
    } finally {
      setCountingRows(false);
    }
  }, [basePath, tables, notify]);

  // --- Derived view data ----------------------------------------------------

  const companyBackends = catalog.settlingSearch ? [] : catalog.data?.items ?? [];
  const catalogEnvironments = useMemo(() => Object.fromEntries((catalog.data?.items ?? []).map(item => [item.id, item.environments])), [catalog.data]);
  const catalogTableCounts = useMemo(() => Object.fromEntries((catalog.data?.items ?? []).map(item => [item.id, item.tableCount])), [catalog.data]);
  const companyProjects = projects;
  const stats = catalog.summary?.stats ?? summarizeDatabaseStats(companyBackends, companyProjects, environments, tableCounts);
  const filteredBackends = companyBackends;

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

  /** Projects of the company that owns the opened database. */
  const detailCompanyProjects = useMemo(
    () => (detail ? projects.filter((item) => item.companyId === detail.companyId) : []),
    [detail, projects],
  );
  const unattachedProjects = useMemo(
    () => detailCompanyProjects.filter((item) => !item.dataBackendId),
    [detailCompanyProjects],
  );
  const detailCompanyBackends = useMemo(
    () => (detail ? backends.filter((backend) => backend.companyId === detail.companyId && backend.status === "ready") : []),
    [backends, detail],
  );
  const detailCompanies = useMemo(
    () => (detail ? companies.filter((company) => company.id !== detail.companyId) : []),
    [companies, detail],
  );

  const backButton = (
    <Link to="/settings" className="marketplace-back-button" aria-label={isUk ? "Назад до налаштувань" : "Back to settings"} title={isUk ? "Назад до налаштувань" : "Back to settings"}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </Link>
  );

  // The company selector filters the merged list instead of switching a single company.
  const companySelect = (
    <CompanyScopeSelect
      aria-label={isUk ? "Компанія" : "Company"}
      className="page-size-select"
      value={companyFilter}
      onValueChange={(value) => {
        const next = value;
        setCompanyFilter(next);
        setDetailId(null);
        if (next !== ALL_COMPANIES) setCompanyId(next);
      }}
    >
      <option value={ALL_COMPANIES}>{isUk ? "Усі компанії" : "All companies"}</option>
      {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </CompanyScopeSelect>
  );

  const unavailableNotice = backendsError?.code === "DATA_STUDIO_UNAVAILABLE" && (
    <div className="data-studio-alert error" role="alert">
      {dataStudioUnavailableMessage(isUk)}
    </div>
  );

  // --- Detail view ----------------------------------------------------------

  if (databaseName && !detail) {
    return <main className="automations-container">
      <Link to="/settings/data-studio" className="button-secondary">{isUk ? "Усі бази даних" : "All databases"}</Link>
      <h1>{databaseName}</h1>
      {routeError ? <div className="data-studio-alert error" role="alert">{routeError}</div>
        : <p role="status">{isUk ? "Завантаження бази даних…" : "Loading database…"}</p>}
    </main>;
  }

  if (detail) {
    return (
      <DatabaseDetailView
        isUk={isUk}
        detail={detail}
        environments={environments}
        quotas={quotas}
        overview={overview}
        loading={loading || workspaceLoading}
        backendsLoading={backendsLoading}
        backendBusy={backendBusy}
        busy={busy}
        countingRows={countingRows}
        tables={tables}
        driftRows={driftRows}
        rowCounts={rowCounts}
        error={error}
        readOnly={readOnly}
        detailProjects={detailProjects}
        unattachedProjects={unattachedProjects}
        detailCompanyBackends={detailCompanyBackends}
        detailCompanies={detailCompanies}
        projectId={projectId}
        setProjectId={setProjectId}
        environment={environment}
        setEnvironment={setEnvironment}
        lockRemaining={lockRemaining}
        basePath={basePath}
        editTable={editTable}
        setEditTable={setEditTable}
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        transferOpen={transferOpen}
        setTransferOpen={setTransferOpen}
        feedback={feedback}
        countRows={countRows}
        renameDatabase={renameDatabase}
        toggleArchive={toggleArchive}
        deleteDatabase={deleteDatabase}
        attachProject={attachProject}
        handleDeleteTable={handleDeleteTable}
        previewOperation={previewOperation}
        applyOperation={applyOperation}
        notify={notify}
        transferDatabase={transferDatabase}
        loadOverview={loadOverview}
        refresh={refresh}
        setDetailId={setDetailId}
      />
    );
  }

  // --- Databases list -------------------------------------------------------

  return (
    <DatabasesListView
      isUk={isUk}
      backButton={backButton}
      companySelect={companySelect}
      createTargetCompanyId={createTargetCompanyId}
      setCreateOpen={setCreateOpen}
      feedback={feedback}
      unavailableNotice={unavailableNotice}
      backendsWarning={backendsWarning}
      backendsError={backendsError}
      companies={companies}
      stats={stats}
      statsLoading={!catalog.summary}
      totalMatches={catalog.data?.pagination.total ?? 0}
      totalProjects={catalog.summary?.stats.totalProjects}
      hasMore={Boolean(catalog.data?.pagination.nextCursor)}
      loadingMore={catalog.loadingMore}
      moreError={catalog.moreError instanceof Error ? catalog.moreError.message : catalog.moreError ? "Could not load databases" : null}
      onLoadMore={() => { void catalog.loadMore(); }}
      onSelectAll={async () => {
        try { return await catalog.loadMore(true); }
        catch (cause) { notify(cause instanceof Error ? cause.message : "Could not load databases", "error"); throw cause; }
      }}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      databaseFilter={databaseFilter}
      setDatabaseFilter={setDatabaseFilter}
      companyBackends={companyBackends}
      filteredBackends={filteredBackends}
      companyProjects={companyProjects}
      companyFilter={companyFilter}
      setCompanyFilter={setCompanyFilter}
      allCompaniesToken={ALL_COMPANIES}
      backendsLoading={backendsLoading}
      backends={companyBackends}
      environments={catalogEnvironments}
      projects={projects}
      tableCounts={catalogTableCounts}
      backendBusy={backendBusy}
      setDetailId={setDetailId}
      toggleArchive={toggleArchive}
      deleteDatabase={deleteDatabase}
      deleteDatabases={deleteDatabases}
      createOpen={createOpen}
      createDatabase={createDatabase}
    />
  );
}

export default DataStudioSettingsPage;
