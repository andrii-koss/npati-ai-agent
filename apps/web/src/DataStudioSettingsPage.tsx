import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId, readCachedCompanies } from "./active-company";
import {
  ALL_COMPANIES,
  MAX_ENVIRONMENT_BACKENDS,
  MAX_ROW_COUNT_TABLES,
  MAX_TABLE_COUNT_BACKENDS,
  apiFetch,
  dataStudioUnavailableMessage,
  errorCode,
  DatabaseDetailView,
  DatabasesListView,
  type AppliedMigration,
  type BackendEnvironment,
  type BackendSummary,
  type CompanySummary,
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

export * from "./data-studio-settings/types";

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
  const [backendsWarning, setBackendsWarning] = useState<string | null>(null);
  const [tableCounts, setTableCounts] = useState<Record<string, number | null>>({});
  const [quotas, setQuotas] = useState<Record<string, QuotaReport | null>>({});
  const [reloadToken, setReloadToken] = useState(0);

  const [detailId, setDetailId] = useState<string | null>(null);
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

  const notify = useCallback((message: string, type: Feedback["type"] = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  }, []);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const tables = useMemo(() => [...(overview?.schema?.tables ?? [])].sort((left, right) => left.name.localeCompare(right.name)), [overview]);
  const readOnly = environment === "prod";
  const detail = useMemo(() => backends.find((backend) => backend.id === detailId) ?? null, [backends, detailId]);
  /** Databases and tables are company-scoped: the opened database dictates the active company. */
  const activeCompanyId = detail?.companyId ?? companyId;
  const detailProjects = useMemo(() => projects.filter((item) => item.dataBackendId === detailId), [projects, detailId]);
  const companyKey = useMemo(() => companies.map((company) => company.id).join(","), [companies]);
  /** Company the "New database" button creates in. */
  const createTargetCompanyId = companyFilter !== ALL_COMPANIES ? companyFilter : companyId;

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

  // 2. Databases + projects of every company (the list is merged and tagged with its company)
  useEffect(() => {
    if (!companies.length) {
      setProjects([]); setProjectId(""); setBackends([]); setEnvironments({}); setTableCounts({});
      return;
    }
    let cancelled = false;
    setBackendsLoading(true);
    setBackendsError(null);
    setBackendsWarning(null);
    void (async () => {
      try {
        const failures: Array<string | undefined> = [];
        const perCompany = await Promise.all(companies.map(async (company) => {
          const base = `/companies/${encodeURIComponent(company.id)}`;
          const [projectResult, backendResult] = await Promise.all([
            apiFetch<{ projects: ProjectSummary[] }>(`${base}/projects`)
              .catch(() => ({ projects: [] as ProjectSummary[] })),
            apiFetch<{ backends: BackendSummary[] }>(`${base}/data-backends`)
              .catch((cause) => { failures.push(errorCode(cause)); return { backends: [] as BackendSummary[] }; }),
          ]);
          return {
            company,
            projects: (projectResult.projects ?? []).map((item) => ({ ...item, companyId: company.id })),
            backends: (backendResult.backends ?? []).map((item) => ({ ...item, companyId: company.id, companyName: company.name })),
          };
        }));
        if (cancelled) return;

        const projectList = perCompany.flatMap((entry) => entry.projects);
        const backendList = perCompany.flatMap((entry) => entry.backends);

        if (!backendList.length && failures.length === perCompany.length && failures.some(Boolean)) {
          setProjects(projectList);
          setBackends([]); setEnvironments({}); setTableCounts({});
          setBackendsWarning(null);
          setBackendsError({
            message: failures[0] === "DATA_STUDIO_UNAVAILABLE"
              ? dataStudioUnavailableMessage(isUk)
              : (isUk ? "Не вдалося завантажити бази даних" : "Could not load the databases"),
            code: failures[0],
          });
          return;
        }

        setBackendsWarning(failures.some(Boolean)
          ? (isUk
            ? "Частину компаній не вдалося завантажити — показано доступні бази."
            : "Some companies could not be loaded — showing the available databases.")
          : null);
        setProjects(projectList);
        setProjectId((current) => {
          if (current && projectList.some((item) => item.id === current)) return current;
          return (projectList.find((item) => item.dataBackendId) ?? projectList[0])?.id ?? "";
        });
        setBackends(backendList);

        const detailed = backendList.slice(0, MAX_ENVIRONMENT_BACKENDS);
        const details = await Promise.all(detailed.map((backend) => apiFetch<{ environments: BackendEnvironment[] }>(
          `/companies/${encodeURIComponent(backend.companyId)}/data-backends/${encodeURIComponent(backend.id)}`,
        ).catch(() => ({ environments: [] as BackendEnvironment[] }))));
        if (cancelled) return;
        setEnvironments(Object.fromEntries(detailed.map((backend, index) => [backend.id, details[index]?.environments ?? []])));
      } catch (cause) {
        if (cancelled) return;
        setProjects([]); setBackends([]); setEnvironments({}); setTableCounts({});
        setBackendsError({ message: cause instanceof Error ? cause.message : "Could not load Data Studio", code: errorCode(cause) });
      } finally {
        if (!cancelled) setBackendsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyKey, companies, isUk, reloadToken]);

  // 3. Quotas of the opened database (the database carries its own company)
  useEffect(() => {
    if (!activeCompanyId || !detailId) { setQuotas({}); return; }
    let cancelled = false;
    void Promise.all((["dev", "prod"] as const).map(async (env) => {
      try {
        const report = await apiFetch<QuotaReport>(`/companies/${encodeURIComponent(activeCompanyId)}/data-backends/${encodeURIComponent(detailId)}/quotas?environment=${env}`);
        return [env, report] as const;
      } catch {
        return [env, null] as const;
      }
    })).then((entries) => { if (!cancelled) setQuotas(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [activeCompanyId, detailId, reloadToken]);

  // 4. Table area of the opened database
  useEffect(() => {
    if (!detailId) return;
    const attached = projects.filter((item) => item.dataBackendId === detailId);
    if (!attached.some((item) => item.id === projectId)) setProjectId(attached[0]?.id ?? "");
  }, [detailId, projects, projectId]);

  const loadOverview = useCallback(async () => {
    if (!activeCompanyId || !projectId || !project?.dataBackendId) { setOverview(null); return; }
    setLoading(true);
    try {
      const result = await apiFetch<Overview>(`/companies/${encodeURIComponent(activeCompanyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`);
      setOverview(result);
      setError(null);
    } catch (cause) {
      setOverview(null);
      setError({ message: cause instanceof Error ? cause.message : "Could not load Data Studio", code: errorCode(cause) });
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, projectId, project?.dataBackendId, environment]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
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
  }, [createTargetCompanyId, isUk, notify, refresh]);

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
      refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not rename the database", "error");
    } finally {
      setBackendBusy(false);
    }
  }, [isUk, notify, refresh]);

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

  /** Everything below the company filter: statistics, tabs and the list all use this slice. */
  const companyBackends = useMemo(
    () => (companyFilter === ALL_COMPANIES ? backends : backends.filter((backend) => backend.companyId === companyFilter)),
    [backends, companyFilter],
  );
  const companyProjects = useMemo(
    () => (companyFilter === ALL_COMPANIES ? projects : projects.filter((item) => item.companyId === companyFilter)),
    [companyFilter, projects],
  );

  const stats = useMemo(() => {
    const readyEnvironments = companyBackends.reduce((total, backend) => {
      const list = environments[backend.id] ?? [];
      return total + list.filter((env) => env.status === "ready").length;
    }, 0);
    const totalEnvironments = companyBackends.reduce((total, backend) => total + Math.max((environments[backend.id] ?? []).length, 0), 0);
    const known = companyBackends
      .map((backend) => tableCounts[backend.id])
      .filter((count): count is number => typeof count === "number");
    return {
      total: companyBackends.length,
      ready: companyBackends.filter((backend) => backend.status === "ready").length,
      attention: companyBackends.filter((backend) => backend.status !== "ready").length,
      readyEnvironments,
      totalEnvironments: totalEnvironments || companyBackends.length * 2,
      tables: known.length ? known.reduce((total, count) => total + count, 0) : null,
      attachedProjects: companyProjects.filter((item) => item.dataBackendId).length,
    };
  }, [companyBackends, companyProjects, environments, tableCounts]);

  const filteredBackends = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return companyBackends.filter((backend) => {
      if (databaseFilter === "ready" && backend.status !== "ready") return false;
      if (databaseFilter === "attention" && backend.status === "ready") return false;
      if (!query) return true;
      return backend.name.toLowerCase().includes(query)
        || backend.provider.toLowerCase().includes(query)
        || backend.companyName.toLowerCase().includes(query);
    });
  }, [companyBackends, databaseFilter, searchQuery]);

  // Table counts are a hint: only the visible slice is fetched, the rest stays unknown ("—").
  const tableCountKey = useMemo(
    () => filteredBackends.slice(0, MAX_TABLE_COUNT_BACKENDS).map((backend) => {
      const attached = projects.find((item) => item.dataBackendId === backend.id);
      return `${backend.companyId}:${backend.id}:${attached?.id ?? ""}`;
    }).join("|"),
    [filteredBackends, projects],
  );

  useEffect(() => {
    if (!tableCountKey) return;
    const targets = tableCountKey.split("|").flatMap((entry) => {
      const [companyOfBackend = "", backendId = "", attachedProjectId = ""] = entry.split(":");
      return attachedProjectId ? [{ companyOfBackend, backendId, attachedProjectId }] : [];
    });
    if (!targets.length) return;
    let cancelled = false;
    void Promise.all(targets.map(async (target) => {
      try {
        const result = await apiFetch<{ schema: { tables: unknown[] } | null }>(
          `/companies/${encodeURIComponent(target.companyOfBackend)}/projects/${encodeURIComponent(target.attachedProjectId)}/data-studio/dev`,
        );
        return [target.backendId, result.schema?.tables.length ?? 0] as const;
      } catch {
        return [target.backendId, null] as const;
      }
    })).then((counts) => {
      if (cancelled) return;
      setTableCounts((current) => ({ ...current, ...Object.fromEntries(counts) }));
    });
    return () => { cancelled = true; };
  }, [tableCountKey, reloadToken]);

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
  const companySelect = companies.length > 0 && (
    <select
      aria-label={isUk ? "Компанія" : "Company"}
      className="page-size-select"
      value={companyFilter}
      onChange={(event) => {
        const next = event.target.value;
        setCompanyFilter(next);
        setDetailId(null);
        if (next !== ALL_COMPANIES) setCompanyId(next);
      }}
    >
      <option value={ALL_COMPANIES}>{isUk ? "Усі компанії" : "All companies"}</option>
      {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </select>
  );

  const unavailableNotice = backendsError?.code === "DATA_STUDIO_UNAVAILABLE" && (
    <div className="data-studio-alert error" role="alert">
      {dataStudioUnavailableMessage(isUk)}
    </div>
  );

  // --- Detail view ----------------------------------------------------------

  if (detail) {
    return (
      <DatabaseDetailView
        isUk={isUk}
        detail={detail}
        environments={environments}
        quotas={quotas}
        overview={overview}
        loading={loading}
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
      backends={backends}
      environments={environments}
      projects={projects}
      tableCounts={tableCounts}
      backendBusy={backendBusy}
      setDetailId={setDetailId}
      toggleArchive={toggleArchive}
      deleteDatabase={deleteDatabase}
      createOpen={createOpen}
      createDatabase={createDatabase}
    />
  );
}

export default DataStudioSettingsPage;
