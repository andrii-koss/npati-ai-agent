import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId, readCachedCompanies } from "./active-company";
import { CodeFlagsPanel } from "./CodeFlagsPanel";
import { CodeSandboxImagesPanel } from "./CodeSandboxImagesPanel";
import { CodeDataPolicyPanel } from "./CodeDataPolicyPanel";
// R1 (section A, item 3): the read-only queue/limits panel. It fetches `…/code/runs/queue` and renders it.
import { CodeQueuePanel } from "./CodeQueuePanel";

// --- Types -------------------------------------------------------------------

type DataClassification = "public" | "internal" | "confidential" | "restricted";
type RetentionClass = "ephemeral" | "short" | "standard" | "extended" | "until_deleted";
type SessionMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";
type SessionStatus = "active" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "archived";

interface CompanySummary {
  id: string;
  name: string;
}

interface VerifyCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
  build?: string;
}

interface Toolchain {
  languages?: string[];
  packageManagers?: string[];
  verifyCommands?: VerifyCommands;
  source?: "detected" | "manual";
  detectedAt?: string;
  evidence?: string[];
}

interface CodeProject {
  id: string;
  name: string;
  type?: string;
  status?: string;
  repositoryUrl?: string | null;
  repositoryBranch?: string | null;
  defaultBranch?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  toolchain?: Toolchain | null;
  revision: number;
  updatedAt?: string;
}

interface CodeSession {
  id: string;
  projectId: string;
  projectName?: string;
  mode?: SessionMode;
  modelProfile?: string | null;
  status?: SessionStatus;
  summary?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  agentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface CodeLimits {
  [key: string]: unknown;
}

interface Feedback {
  type: "success" | "error";
  message: string;
}

// --- API ---------------------------------------------------------------------

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

/** Human copy for the error codes the Code API can return. */
function codeErrorMessage(error: unknown, isUk: boolean): string {
  const code = errorCode(error);
  const fallback = error instanceof Error ? error.message : isUk ? "Запит не вдався" : "Request failed";
  switch (code) {
    case "code_unavailable":
    case "project_import_unavailable":
      return isUk
        ? "Модуль Code вимкнено на цій інсталяції (feature flag або відсутній import-сервіс)."
        : "The Code module is disabled on this installation (feature flag or missing import service).";
    case "code_write_denied":
      return isUk ? "Немає права створювати код-проєкти в цій компанії." : "You are not allowed to create code projects in this company.";
    case "invalid_name":
      return isUk ? "Некоректна назва проєкту." : "The project name is invalid.";
    case "invalid_repository_url":
      return isUk ? "Некоректний URL репозиторію (потрібен https:// або git@)." : "Invalid repository URL (https:// or git@ expected).";
    case "repository_import_failed":
      return isUk ? "Не вдалося імпортувати репозиторій. Спробуйте ще раз." : "Repository import failed. Please retry.";
    case "classification_downgrade_denied":
      return isUk ? "Зниження класу даних заборонено." : "Lowering the data classification is not allowed.";
    case "retention_downgrade_denied":
      return isUk ? "Скорочення класу зберігання заборонено." : "Shortening the retention class is not allowed.";
    case "feature_disabled":
      return isUk
        ? "Coding Agent вимкнено (History read-only): створення й зміни недоступні, історія, Activity, Changes/diff, Export і Delete працюють."
        : "The Coding Agent is disabled (History read-only): creation and mutations are unavailable while history, Activity, Changes/diff, Export and Delete still work.";
    case "flag_admin_required":
      return isUk ? "Керувати флагами може лише власник/адміністратор компанії." : "Only the company owner/admin can manage flags.";
    default:
      return fallback;
  }
}

function formatDate(value: string | undefined, isUk: boolean): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(isUk ? "uk-UA" : "en-US", { dateStyle: "short", timeStyle: "short" });
}

const CLASSIFICATIONS: DataClassification[] = ["public", "internal", "confidential", "restricted"];
const RETENTIONS: RetentionClass[] = ["ephemeral", "short", "standard", "extended", "until_deleted"];
const SESSION_MODES: SessionMode[] = ["plan", "ask", "auto_edit", "full_auto_sandbox"];

function classificationLabel(value: DataClassification | undefined, isUk: boolean): string {
  switch (value) {
    case "public": return isUk ? "публічні" : "public";
    case "internal": return isUk ? "внутрішні" : "internal";
    case "confidential": return isUk ? "конфіденційні" : "confidential";
    case "restricted": return isUk ? "суворо обмежені" : "restricted";
    default: return "—";
  }
}

function retentionLabel(value: RetentionClass | undefined, isUk: boolean): string {
  switch (value) {
    case "ephemeral": return isUk ? "ефемерне" : "ephemeral";
    case "short": return isUk ? "коротке" : "short";
    case "standard": return isUk ? "стандартне" : "standard";
    case "extended": return isUk ? "подовжене" : "extended";
    case "until_deleted": return isUk ? "до видалення" : "until deleted";
    default: return "—";
  }
}

function sessionModeLabel(value: SessionMode | string | undefined, isUk: boolean): string {
  switch (value) {
    case "plan": return isUk ? "план" : "plan";
    case "ask": return isUk ? "запит" : "ask";
    case "auto_edit": return isUk ? "авторедагування" : "auto edit";
    case "full_auto_sandbox": return isUk ? "повний авто (sandbox)" : "full auto (sandbox)";
    // Legacy C1 spellings stay renderable: sessions persisted before C5 may still carry them.
    case "edit": return isUk ? "редагування" : "edit";
    case "auto": return isUk ? "авто" : "auto";
    case "full_auto": return isUk ? "повний авто" : "full auto";
    default: return "—";
  }
}

function sessionStatusLabel(value: SessionStatus | undefined, isUk: boolean): string {
  switch (value) {
    case "active": return isUk ? "активна" : "active";
    case "paused": return isUk ? "пауза" : "paused";
    case "awaiting_approval": return isUk ? "очікує підтвердження" : "awaiting approval";
    case "completed": return isUk ? "завершена" : "completed";
    case "failed": return isUk ? "помилка" : "failed";
    case "cancelled": return isUk ? "скасована" : "cancelled";
    case "archived": return isUk ? "в архіві" : "archived";
    default: return "—";
  }
}

function projectStatusClass(status: string | undefined): string {
  switch (status) {
    case "active":
    case "ready":
      return "verified";
    case "provisioning":
    case "importing":
      return "partial";
    case "archived":
      return "blocked";
    case "failed":
    case "error":
      return "failed";
    default:
      return "queued";
  }
}

function sessionStatusClass(status: SessionStatus | undefined): string {
  switch (status) {
    case "active": return "running";
    case "paused": return "partial";
    case "awaiting_approval": return "requires-approval";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "blocked";
    case "archived": return "not-implemented";
    default: return "queued";
  }
}

// --- Small building blocks ---------------------------------------------------

function Drawer({ title, subtitle, closeLabel, isUk, onClose, children }: {
  title: string;
  subtitle: string;
  closeLabel: string;
  isUk: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => onClose()}>
      <aside
        className="company-drawer automations-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{subtitle}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="automations-drawer-close" aria-label={isUk ? "Закрити" : "Close"} title={closeLabel} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

function ToolchainCell({ toolchain, isUk }: { toolchain: Toolchain | null | undefined; isUk: boolean }) {
  if (!toolchain) return <span className="ds-muted">{isUk ? "не визначено" : "not detected"}</span>;
  const languages = toolchain.languages ?? [];
  const managers = toolchain.packageManagers ?? [];
  const commands = toolchain.verifyCommands ?? {};
  const title = Object.entries(commands)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return (
    <div className="code-toolchain" title={title || undefined}>
      {languages.length === 0 && managers.length === 0 && <span className="ds-muted">—</span>}
      {languages.map((language) => <span className="data-studio-badge" key={`lang-${language}`}>{language}</span>)}
      {managers.map((manager) => <span className="data-studio-badge" key={`pm-${manager}`}>{manager}</span>)}
      {toolchain.source === "manual" && <span className="data-studio-badge">{isUk ? "вручну" : "manual"}</span>}
    </div>
  );
}

// --- Page --------------------------------------------------------------------

export function CodeSettingsPage() {
  const { language } = useTranslation();
  const isUk = language === "uk";

  const [companies, setCompanies] = useState<CompanySummary[]>(() => readCachedCompanies<CompanySummary>());
  const [companyId, setCompanyId] = useState<string>("");

  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [limits, setLimits] = useState<CodeLimits | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionProjectId, setSessionProjectId] = useState<string>("");
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * C1a: the master flag decides whether mutations are possible. `null` means "not known yet", in
   * which case the page stays usable and the server remains the authority (it answers
   * `feature_disabled` if the flag is off).
   */
  const [masterEnabled, setMasterEnabled] = useState<boolean | null>(null);
  const readOnly = masterEnabled === false;
  const readOnlyTitle = isUk ? "Coding Agent вимкнено (History read-only)" : "Coding Agent is disabled (History read-only)";

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  // Companies: cache first, then the API.
  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ companies: CompanySummary[] }>("/companies?limit=50")
      .then((body) => {
        if (cancelled) return;
        const list = body.companies ?? [];
        setCompanies(list);
        setCompanyId((current) => current || chooseAvailableCompanyId(list, { fallback: "" }));
      })
      .catch(() => {
        if (!cancelled) setCompanyId((current) => current || chooseAvailableCompanyId([], { fallback: "" }));
      });
    return () => { cancelled = true; };
  }, []);

  // Projects, sessions and limits for the selected company.
  useEffect(() => {
    if (!companyId) {
      setProjects([]);
      setSessions([]);
      setLimits(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const base = "/companies/" + encodeURIComponent(companyId);
    void Promise.all([
      apiFetch<{ projects: CodeProject[] }>(`${base}/code/projects?includeArchived=true`).then((body) => body.projects ?? []),
      apiFetch<{ sessions: CodeSession[] }>(`${base}/code/sessions`).then((body) => body.sessions ?? []).catch(() => [] as CodeSession[]),
      apiFetch<{ limits: CodeLimits }>(`${base}/code/limits`).then((body) => body.limits ?? null).catch(() => null),
    ])
      .then(([projectList, sessionList, limitsList]) => {
        if (cancelled) return;
        setProjects(projectList);
        setSessions(sessionList);
        setLimits(limitsList);
        setLimitsError(limitsList ? null : isUk ? "Ліміти недоступні." : "Limits are unavailable.");
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError({ message: codeErrorMessage(cause, isUk), code: errorCode(cause) });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, reloadToken, isUk]);

  const companyName = companies.find((company) => company.id === companyId)?.name ?? "";

  const visibleProjects = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return projects
      .filter((project) => (showArchived ? true : project.status !== "archived"))
      .filter((project) => {
        if (!needle) return true;
        return project.name.toLowerCase().includes(needle)
          || (project.repositoryUrl ?? "").toLowerCase().includes(needle);
      });
  }, [projects, searchQuery, showArchived]);

  const detailProject = detailId ? projects.find((project) => project.id === detailId) ?? null : null;

  const stats = useMemo(() => ({
    projects: projects.filter((project) => project.status !== "archived").length,
    activeSessions: sessions.filter((session) => session.status === "active" || session.status === "awaiting_approval").length,
    repositories: projects.filter((project) => Boolean(project.repositoryUrl)).length,
    toolchains: projects.filter((project) => Boolean(project.toolchain)).length,
  }), [projects, sessions]);

  const createProject = useCallback(async (input: {
    name: string;
    description?: string;
    repositoryUrl?: string;
    branch?: string;
    credentialId?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => {
    if (!companyId) return;
    const base = "/companies/" + encodeURIComponent(companyId);
    const project = await apiFetch<CodeProject>(`${base}/code/projects`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        dataClassification: input.dataClassification,
        retentionClass: input.retentionClass,
      }),
    });
    setCreateOpen(false);
    setFeedback({ type: "success", message: isUk ? `Код-проєкт «${project.name}» створено.` : `Code project “${project.name}” created.` });
    setDetailId(project.id);
    reload();
  }, [companyId, isUk, reload]);

  const detectToolchain = useCallback(async (project: CodeProject) => {
    if (!companyId) return;
    setBusyId(project.id);
    try {
      const updated = await apiFetch<CodeProject>(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(project.id)}/code/detect-toolchain`,
        { method: "POST" },
      );
      const languages = updated.toolchain?.languages ?? [];
      setFeedback({
        type: "success",
        message: languages.length
          ? (isUk ? `Toolchain визначено: ${languages.join(", ")}.` : `Toolchain detected: ${languages.join(", ")}.`)
          : (isUk ? "Toolchain не визначено (ознак не знайдено)." : "No toolchain detected (no evidence found)."),
      });
      reload();
    } catch (cause) {
      setFeedback({ type: "error", message: codeErrorMessage(cause, isUk) });
    } finally {
      setBusyId(null);
    }
  }, [companyId, isUk, reload]);

  const archiveProject = useCallback(async (project: CodeProject) => {
    if (!companyId) return;
    const agreed = await confirmModal({
      title: isUk ? "Архівувати код-проєкт" : "Archive code project",
      message: isUk
        ? `Архівувати «${project.name}»? Проєкт і його сесії лишаться в історії, але стануть недоступними для роботи.`
        : `Archive “${project.name}”? The project and its sessions stay in history but can no longer be worked on.`,
      isDanger: true,
      confirmText: isUk ? "Архівувати" : "Archive",
    });
    if (!agreed) return;
    setBusyId(project.id);
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(project.id)}/archive`,
        { method: "POST", body: JSON.stringify({ expectedRevision: project.revision }) },
      );
      setFeedback({ type: "success", message: isUk ? "Код-проєкт заархівовано." : "Code project archived." });
      if (detailId === project.id) setDetailId(null);
      reload();
    } catch (cause) {
      setFeedback({ type: "error", message: codeErrorMessage(cause, isUk) });
    } finally {
      setBusyId(null);
    }
  }, [companyId, detailId, isUk, reload]);

  const saveProjectSettings = useCallback(async (project: CodeProject, input: {
    verifyCommands: VerifyCommands;
    defaultBranch?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => {
    if (!companyId) return;
    const cleaned: VerifyCommands = {};
    for (const [key, value] of Object.entries(input.verifyCommands)) {
      const text = (value ?? "").trim();
      if (text) (cleaned as Record<string, string>)[key] = text;
    }
    const updated = await apiFetch<CodeProject>(
      `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(project.id)}/code`,
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: project.revision,
          verifyCommands: cleaned,
          ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
          dataClassification: input.dataClassification,
          retentionClass: input.retentionClass,
        }),
      },
    );
    setFeedback({ type: "success", message: isUk ? "Налаштування проєкту збережено." : "Project settings saved." });
    setDetailId(updated.id);
    reload();
  }, [companyId, isUk, reload]);

  const createSession = useCallback(async (projectId: string, input: { mode: SessionMode; summary?: string }) => {
    if (!companyId) return;
    const session = await apiFetch<CodeSession>(
      `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/code/sessions`,
      { method: "POST", body: JSON.stringify({ mode: input.mode, ...(input.summary ? { summary: input.summary } : {}) }) },
    );
    setSessionOpen(false);
    setFeedback({
      type: "success",
      message: isUk ? `Сесію ${session.id.slice(0, 8)} створено (${sessionModeLabel(session.mode, isUk)}).` : `Session ${session.id.slice(0, 8)} created (${sessionModeLabel(session.mode, isUk)}).`,
    });
    reload();
  }, [companyId, isUk, reload]);

  const archiveSession = useCallback(async (session: CodeSession) => {
    if (!companyId) return;
    const agreed = await confirmModal({
      title: isUk ? "Архівувати сесію" : "Archive session",
      message: isUk
        ? `Архівувати сесію ${session.id.slice(0, 8)}? Вона лишиться в історії для аудиту.`
        : `Archive session ${session.id.slice(0, 8)}? It stays in history for auditing.`,
      isDanger: true,
      confirmText: isUk ? "Архівувати" : "Archive",
    });
    if (!agreed) return;
    setBusyId(session.id);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/code/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
      setFeedback({ type: "success", message: isUk ? "Сесію заархівовано." : "Session archived." });
      reload();
    } catch (cause) {
      setFeedback({ type: "error", message: codeErrorMessage(cause, isUk) });
    } finally {
      setBusyId(null);
    }
  }, [companyId, isUk, reload]);

  const unavailable = error?.code === "code_unavailable" || error?.code === "project_import_unavailable";

  return (
    <main className="automations-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Налаштування · Code" : "Settings · Code"}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={isUk ? "Назад до налаштувань" : "Back to settings"} title={isUk ? "Назад до налаштувань" : "Back to settings"}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{isUk ? "Код" : "Code"}</span>
            </h1>
            <p className="hero-copy">
              {isUk
                ? "Код-проєкти та сесії Coding Agent (експериментально, за feature flags)."
                : "Code projects and Coding Agent sessions (experimental, behind feature flags)."}
            </p>
          </div>
          <div className="automations-header-actions">
            {companies.length > 1 && (
              <select
                aria-label={isUk ? "Компанія" : "Company"}
                className="page-size-select"
                value={companyId}
                onChange={(event) => { setCompanyId(event.target.value); setDetailId(null); }}
              >
                {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            )}
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => setCreateOpen(true)}
              disabled={!companyId || readOnly}
              title={readOnly ? readOnlyTitle : undefined}
            >
              ＋ {isUk ? "Новий код-проєкт" : "New code project"}
            </button>
          </div>
        </div>
      </header>

      {feedback && <div className={`data-studio-toast toast-${feedback.type}`} role="status">{feedback.message}</div>}

      <section className="overview-grid inspector-stats-grid automations-stats-grid">
        <div>
          <strong>{stats.projects}</strong>
          <span>{isUk ? "Код-проєктів" : "Code projects"}</span>
          <small>{isUk ? "Активних у цій компанії" : "Active in this company"}</small>
        </div>
        <div>
          <strong>{stats.activeSessions}</strong>
          <span>{isUk ? "Активних сесій" : "Active sessions"}</span>
          <small>{isUk ? "Включно з тими, що чекають підтвердження" : "Including those awaiting approval"}</small>
        </div>
        <div>
          <strong>{stats.repositories}</strong>
          <span>{isUk ? "Прикріплених репозиторіїв" : "Attached repositories"}</span>
          <small>{isUk ? "Проєкти з repositoryUrl" : "Projects with a repositoryUrl"}</small>
        </div>
        <div>
          <strong>{stats.toolchains}</strong>
          <span>{isUk ? "Визначених toolchain" : "Detected toolchains"}</span>
          <small>{isUk ? "Мови, менеджери й verify-команди" : "Languages, managers and verify commands"}</small>
        </div>
      </section>

      <div className="inspector-controls automations-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            className="inspector-search-input"
            aria-label={isUk ? "Пошук код-проєктів" : "Search code projects"}
            placeholder={isUk ? "Пошук за назвою або репозиторієм…" : "Search by name or repository…"}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && (
            <button type="button" className="search-clear-btn" aria-label={isUk ? "Очистити" : "Clear"} onClick={() => setSearchQuery("")}>×</button>
          )}
        </div>
        <label className="ds-checkbox">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <span>{isUk ? "Показати архівовані" : "Show archived"}</span>
        </label>
        <button type="button" className="button-secondary" onClick={reload} disabled={loading || !companyId}>
          {loading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className={`data-studio-alert ${unavailable ? "warning" : "error"}`} role="alert">
          {error.message}
          {unavailable && (
            <> {isUk ? "Функція з'явиться після вмикання flag у C1a." : "The feature appears once the flag is enabled in C1a."}</>
          )}
        </div>
      )}

      {!error && !companies.length && (
        <div className="data-studio-alert info" role="status">
          {isUk ? "Створіть компанію, щоб працювати з код-проєктами." : "Create a company to work with code projects."}{" "}
          <Link to="/settings/company">{isUk ? "Перейти" : "Open"}</Link>
        </div>
      )}

      {!error && companies.length > 0 && (
        <>
          {visibleProjects.length === 0 ? (
            <div className="automations-empty-card">
              <div className="automations-empty-icon">🧑‍💻</div>
              <h3>{isUk ? "Код-проєктів ще немає" : "No code projects yet"}</h3>
              <p>
                {isUk
                  ? "Імпортуйте репозиторій або створіть порожній код-проєкт — далі Code визначить toolchain і verify-команди."
                  : "Import a repository or create an empty code project — Code will then detect the toolchain and verify commands."}
              </p>
              <button type="button" className="button-primary automations-action-primary" onClick={() => setCreateOpen(true)} disabled={!companyId}>
                ＋ {isUk ? "Створити перший код-проєкт" : "Create the first code project"}
              </button>
            </div>
          ) : (
            <div className="automations-table-container">
              <table className="automations-table">
                <thead>
                  <tr>
                    <th>{isUk ? "Проєкт" : "Project"}</th>
                    <th>{isUk ? "Репозиторій" : "Repository"}</th>
                    <th>Toolchain</th>
                    <th>{isUk ? "Класифікація" : "Classification"}</th>
                    <th>Retention</th>
                    <th>{isUk ? "Оновлено" : "Updated"}</th>
                    <th aria-label={isUk ? "Дії" : "Actions"} />
                  </tr>
                </thead>
                <tbody>
                  {visibleProjects.map((project) => (
                    <tr key={project.id}>
                      <td className="automation-title-cell">
                        <strong>{project.name}</strong>
                        <span className={`status-pill ${projectStatusClass(project.status)}`}>{project.status ?? "—"}</span>
                      </td>
                      <td>
                        {project.repositoryUrl ? (
                          <span className="code-repository">
                            <span className="ds-muted">{project.repositoryUrl}</span>
                            {(project.repositoryBranch || project.defaultBranch) && (
                              <span className="data-studio-badge">{project.repositoryBranch || project.defaultBranch}</span>
                            )}
                          </span>
                        ) : <span className="ds-muted">—</span>}
                      </td>
                      <td><ToolchainCell toolchain={project.toolchain} isUk={isUk} /></td>
                      <td><span className="data-studio-badge">{classificationLabel(project.dataClassification, isUk)}</span></td>
                      <td><span className="data-studio-badge">{retentionLabel(project.retentionClass, isUk)}</span></td>
                      <td className="ds-muted">{formatDate(project.updatedAt, isUk)}</td>
                      <td className="automation-actions-cell">
                        <button type="button" className="automation-action-btn run-btn" onClick={() => setDetailId(project.id)}>
                          {isUk ? "Деталі" : "Details"}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          disabled={busyId === project.id || readOnly}
                          title={readOnly ? readOnlyTitle : undefined}
                          onClick={() => void detectToolchain(project)}
                        >
                          {busyId === project.id ? "…" : isUk ? "Визначити toolchain" : "Detect toolchain"}
                        </button>
                        <button
                          type="button"
                          className="automation-action-btn"
                          disabled={readOnly}
                          title={readOnly ? readOnlyTitle : undefined}
                          onClick={() => { setSessionProjectId(project.id); setSessionOpen(true); }}
                        >
                          {isUk ? "Сесії" : "Sessions"}
                        </button>
                        {project.status !== "archived" && (
                          <button
                            type="button"
                            className="automation-action-btn danger"
                            disabled={busyId === project.id || readOnly}
                            title={readOnly ? readOnlyTitle : undefined}
                            onClick={() => void archiveProject(project)}
                          >
                            {isUk ? "Архівувати" : "Archive"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <section className="ds-section-title">
            <div>
              <h2>{isUk ? "Сесії Coding Agent" : "Coding Agent sessions"}</h2>
              <p className="ds-muted">
                {isUk
                  ? "Сесія фіксує режим дозволів, профіль моделі та класифікацію даних для майбутнього циклу агента."
                  : "A session records the permission mode, model profile and data classification for the future agent loop."}
              </p>
            </div>
            <button
              type="button"
              className="button-primary automations-action-primary"
              disabled={!companyId || projects.length === 0 || readOnly}
              title={readOnly ? readOnlyTitle : undefined}
              onClick={() => {
                setSessionProjectId((current) => current || detailId || visibleProjects[0]?.id || projects[0]?.id || "");
                setSessionOpen(true);
              }}
            >
              ＋ {isUk ? "Нова сесія" : "New session"}
            </button>
          </section>

          {sessions.length === 0 ? (
            <div className="data-studio-alert info" role="status">
              {isUk ? "Сесій ще немає. Створіть сесію для код-проєкту, щоб почати роботу." : "No sessions yet. Create one for a code project to get started."}
            </div>
          ) : (
            <div className="automations-table-container">
              <table className="automations-table">
                <thead>
                  <tr>
                    <th>{isUk ? "Сесія" : "Session"}</th>
                    <th>{isUk ? "Проєкт" : "Project"}</th>
                    <th>{isUk ? "Режим" : "Mode"}</th>
                    <th>{isUk ? "Статус" : "Status"}</th>
                    <th>{isUk ? "Класифікація" : "Classification"}</th>
                    <th>{isUk ? "Створено" : "Created"}</th>
                    <th aria-label={isUk ? "Дії" : "Actions"} />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td><code>{session.id.slice(0, 8)}</code></td>
                      <td>{session.projectName ?? projects.find((project) => project.id === session.projectId)?.name ?? "—"}</td>
                      <td>{sessionModeLabel(session.mode, isUk)}</td>
                      <td><span className={`status-pill ${sessionStatusClass(session.status)}`}>{sessionStatusLabel(session.status, isUk)}</span></td>
                      <td><span className="data-studio-badge">{classificationLabel(session.dataClassification, isUk)}</span></td>
                      <td className="ds-muted">{formatDate(session.createdAt, isUk)}</td>
                      <td className="automation-actions-cell">
                        {session.status !== "archived" && (
                          <button
                            type="button"
                            className="automation-action-btn danger"
                            disabled={busyId === session.id || readOnly}
                            title={readOnly ? readOnlyTitle : undefined}
                            onClick={() => void archiveSession(session)}
                          >
                            {isUk ? "Архівувати" : "Archive"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {companyId && (
            <CodeFlagsPanel
              companyId={companyId}
              isUk={isUk}
              notify={(type, message) => setFeedback({ type, message })}
              onMasterEnabledChange={setMasterEnabled}
              onSessionsSuspended={() => reload()}
            />
          )}

          {companyId && (
            <CodeSandboxImagesPanel
              companyId={companyId}
              isUk={isUk}
              notify={(type, message) => setFeedback({ type, message })}
            />
          )}

          {companyId && (
            <CodeDataPolicyPanel
              companyId={companyId}
              isUk={isUk}
              notify={(type, message) => setFeedback({ type, message })}
            />
          )}

          {/* R1 (section A, item 3): the queue's state is visible instead of being inferable only from a refusal. */}
          {companyId && <CodeQueuePanel companyId={companyId} isUk={isUk} />}

          <details className="code-limits">
            <summary>{isUk ? "Ліміти (конфігурація)" : "Limits (configuration)"}</summary>
            {limitsError && <p className="ds-muted">{limitsError}</p>}
            {limits && (
              <ul>
                {Object.entries(limits).map(([key, value]) => (
                  <li key={key}>
                    <code>{key}</code>
                    <span>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}

      {createOpen && companyId && !readOnly && (
        <CreateProjectDrawer
          isUk={isUk}
          companyName={companyName}
          onClose={() => setCreateOpen(false)}
          onSubmit={createProject}
        />
      )}

      {detailProject && companyId && (
        <ProjectDetailsDrawer
          isUk={isUk}
          project={detailProject}
          busy={busyId === detailProject.id}
          readOnly={readOnly}
          readOnlyTitle={readOnlyTitle}
          onClose={() => setDetailId(null)}
          onDetect={() => void detectToolchain(detailProject)}
          onArchive={() => void archiveProject(detailProject)}
          onSave={(input) => saveProjectSettings(detailProject, input)}
        />
      )}

      {sessionOpen && companyId && !readOnly && (
        <CreateSessionDrawer
          isUk={isUk}
          projects={projects.filter((project) => project.status !== "archived")}
          initialProjectId={sessionProjectId}
          onClose={() => setSessionOpen(false)}
          onSubmit={createSession}
        />
      )}
    </main>
  );
}

// --- Drawer: new code project ------------------------------------------------

function CreateProjectDrawer({ isUk, companyName, onClose, onSubmit }: {
  isUk: boolean;
  companyName: string;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    description?: string;
    repositoryUrl?: string;
    branch?: string;
    credentialId?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [dataClassification, setDataClassification] = useState<DataClassification>("confidential");
  const [retentionClass, setRetentionClass] = useState<RetentionClass>("standard");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const urlValid = !repositoryUrl.trim() || /^https:\/\/\S+$/.test(repositoryUrl.trim()) || /^git@\S+:\S+$/.test(repositoryUrl.trim());
  const canSubmit = name.trim().length > 0 && name.trim().length <= 200 && urlValid;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || working) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        repositoryUrl: repositoryUrl.trim() || undefined,
        branch: branch.trim() || undefined,
        credentialId: credentialId.trim() || undefined,
        dataClassification,
        retentionClass,
      });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title={isUk ? "Новий код-проєкт" : "New code project"}
      subtitle={isUk ? "Code" : "Code"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <section>
          <h3>{isUk ? "Проєкт" : "Project"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "Назва" : "Name"} <i className="required-star">*</i></span>
            <input
              ref={nameRef}
              value={name}
              maxLength={200}
              placeholder={isUk ? "Наприклад: API сервіс" : "For example: API service"}
              onChange={(event) => { setName(event.target.value); setLocalError(null); }}
            />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Опис" : "Description"}</span>
            <input
              value={description}
              maxLength={5000}
              placeholder={isUk ? "Коротко, що це за проєкт" : "Short summary of the project"}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </section>

        <section>
          <h3>{isUk ? "Репозиторій" : "Repository"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "URL репозиторію" : "Repository URL"}</span>
            <input
              value={repositoryUrl}
              placeholder="https://github.com/acme/api.git"
              onChange={(event) => { setRepositoryUrl(event.target.value); setLocalError(null); }}
            />
            {!urlValid && (
              <small className="ds-hint-error">{isUk ? "Підтримуються https:// та git@host:owner/repo" : "https:// and git@host:owner/repo are supported"}</small>
            )}
            <small>
              {isUk
                ? "Залиште порожнім, щоб створити порожній код-проєкт без імпорту."
                : "Leave empty to create an empty code project without importing."}
            </small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Гілка" : "Branch"}</span>
            <input value={branch} placeholder="main" onChange={(event) => setBranch(event.target.value)} />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Credential ID (Company vault)" : "Credential ID (Company vault)"}</span>
            <input
              value={credentialId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setCredentialId(event.target.value)}
            />
            <small>
              {isUk
                ? "Приватні репозиторії підключаються через Company vault: вкажіть id credential з полем token. Токен ніколи не потрапляє в проєкт."
                : "Private repositories use the Company vault: pass the credential id whose field holds the token. The token never reaches the project."}
            </small>
          </label>
        </section>

        <section>
          <h3>{isUk ? "Дані" : "Data"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "Класифікація даних" : "Data classification"}</span>
            <select value={dataClassification} onChange={(event) => setDataClassification(event.target.value as DataClassification)}>
              {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{classificationLabel(value, isUk)}</option>)}
            </select>
            <small>{isUk ? "Визначає, які дані проєкту можна передавати моделі (C5b)." : "Decides which project data may reach a model (C5b)."}</small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Клас зберігання" : "Retention class"}</span>
            <select value={retentionClass} onChange={(event) => setRetentionClass(event.target.value as RetentionClass)}>
              {RETENTIONS.map((value) => <option key={value} value={value}>{retentionLabel(value, isUk)}</option>)}
            </select>
          </label>
        </section>

        {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

        <div className="browser-form-footer">
          <div className="browser-form-footer-hint">
            {companyName
              ? (isUk ? `Буде створено в компанії «${companyName}».` : `Created in the company “${companyName}”.`)
              : (isUk ? "Буде створено код-проєкт." : "A code project will be created.")}
          </div>
          <button type="submit" className="button-primary automations-action-primary browser-submit-btn" disabled={!canSubmit || working}>
            {working ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити проєкт" : "Create project"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

// --- Drawer: project details -------------------------------------------------

function ProjectDetailsDrawer({ isUk, project, busy, readOnly, readOnlyTitle, onClose, onDetect, onArchive, onSave }: {
  isUk: boolean;
  project: CodeProject;
  busy: boolean;
  /** C1a: when the master flag is off, editing is disabled (History read-only) but details stay visible. */
  readOnly?: boolean;
  readOnlyTitle?: string;
  onClose: () => void;
  onDetect: () => void;
  onArchive: () => void;
  onSave: (input: {
    verifyCommands: VerifyCommands;
    defaultBranch?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => Promise<void>;
}) {
  const [verifyTest, setVerifyTest] = useState(project.toolchain?.verifyCommands?.test ?? "");
  const [verifyLint, setVerifyLint] = useState(project.toolchain?.verifyCommands?.lint ?? "");
  const [verifyTypecheck, setVerifyTypecheck] = useState(project.toolchain?.verifyCommands?.typecheck ?? "");
  const [verifyBuild, setVerifyBuild] = useState(project.toolchain?.verifyCommands?.build ?? "");
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch ?? project.repositoryBranch ?? "");
  const [dataClassification, setDataClassification] = useState<DataClassification>(project.dataClassification ?? "confidential");
  const [retentionClass, setRetentionClass] = useState<RetentionClass>(project.retentionClass ?? "standard");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVerifyTest(project.toolchain?.verifyCommands?.test ?? "");
    setVerifyLint(project.toolchain?.verifyCommands?.lint ?? "");
    setVerifyTypecheck(project.toolchain?.verifyCommands?.typecheck ?? "");
    setVerifyBuild(project.toolchain?.verifyCommands?.build ?? "");
    setDefaultBranch(project.defaultBranch ?? project.repositoryBranch ?? "");
    setDataClassification(project.dataClassification ?? "confidential");
    setRetentionClass(project.retentionClass ?? "standard");
  }, [project]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await onSave({
        verifyCommands: { test: verifyTest, lint: verifyLint, typecheck: verifyTypecheck, build: verifyBuild },
        defaultBranch: defaultBranch.trim() || undefined,
        dataClassification,
        retentionClass,
      });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={project.name}
      subtitle={isUk ? "Code · проєкт" : "Code · project"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <section>
          <h3>{isUk ? "Стан" : "State"}</h3>
          <div className="code-detail-row"><span>{isUk ? "Статус" : "Status"}</span>
            <span className={`status-pill ${projectStatusClass(project.status)}`}>{project.status ?? "—"}</span>
          </div>
          <div className="code-detail-row"><span>{isUk ? "Тип" : "Type"}</span><code>{project.type ?? "code_project"}</code></div>
          <div className="code-detail-row"><span>ID</span><code>{project.id}</code></div>
          <div className="code-detail-row"><span>{isUk ? "Ревізія" : "Revision"}</span><code>{project.revision}</code></div>
          <div className="code-detail-row"><span>{isUk ? "Оновлено" : "Updated"}</span><span className="ds-muted">{formatDate(project.updatedAt, isUk)}</span></div>
          <div className="code-detail-row"><span>{isUk ? "Репозиторій" : "Repository"}</span><span className="ds-muted">{project.repositoryUrl ?? "—"}</span></div>
        </section>

        <section>
          <h3>Toolchain</h3>
          {project.toolchain ? (
            <>
              <div className="code-detail-row"><span>{isUk ? "Джерело" : "Source"}</span><span className="ds-muted">{project.toolchain.source ?? "detected"}</span></div>
              <div className="code-detail-row"><span>{isUk ? "Визначено" : "Detected at"}</span><span className="ds-muted">{formatDate(project.toolchain.detectedAt, isUk)}</span></div>
              <div className="code-detail-row"><span>{isUk ? "Мови" : "Languages"}</span>
                <span className="code-toolchain">
                  {(project.toolchain.languages ?? []).map((value) => <span className="data-studio-badge" key={value}>{value}</span>)}
                  {(project.toolchain.languages ?? []).length === 0 && <span className="ds-muted">—</span>}
                </span>
              </div>
              <div className="code-detail-row"><span>{isUk ? "Менеджери" : "Package managers"}</span>
                <span className="code-toolchain">
                  {(project.toolchain.packageManagers ?? []).map((value) => <span className="data-studio-badge" key={value}>{value}</span>)}
                  {(project.toolchain.packageManagers ?? []).length === 0 && <span className="ds-muted">—</span>}
                </span>
              </div>
              {(project.toolchain.evidence ?? []).length > 0 && (
                <div className="code-detail-row"><span>{isUk ? "Ознаки" : "Evidence"}</span>
                  <span className="ds-muted">{(project.toolchain.evidence ?? []).join(", ")}</span>
                </div>
              )}
            </>
          ) : <p className="ds-muted">{isUk ? "Toolchain ще не визначено." : "Toolchain is not detected yet."}</p>}
          <button type="button" className="button-secondary" disabled={busy || readOnly} title={readOnly ? readOnlyTitle : undefined} onClick={onDetect}>
            {busy ? "…" : isUk ? "Визначити повторно" : "Detect again"}
          </button>
        </section>

        <section>
          <h3>{isUk ? "Verify-команди" : "Verify commands"}</h3>
          <label className="browser-form-field">
            <span>test</span>
            <input value={verifyTest} placeholder="npm test" onChange={(event) => setVerifyTest(event.target.value)} />
          </label>
          <label className="browser-form-field">
            <span>lint</span>
            <input value={verifyLint} placeholder="npm run lint" onChange={(event) => setVerifyLint(event.target.value)} />
          </label>
          <label className="browser-form-field">
            <span>typecheck</span>
            <input value={verifyTypecheck} placeholder="npm run typecheck" onChange={(event) => setVerifyTypecheck(event.target.value)} />
          </label>
          <label className="browser-form-field">
            <span>build</span>
            <input value={verifyBuild} placeholder="npm run build" onChange={(event) => setVerifyBuild(event.target.value)} />
          </label>
          <p className="ds-muted">
            {isUk
              ? "Порожнє поле означає, що команда не задана (агент не запускатиме її як перевірку)."
              : "An empty field means the command is unset (the agent will not run it as a check)."}
          </p>
        </section>

        <section>
          <h3>{isUk ? "Гілка та політика даних" : "Branch and data policy"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "Гілка за замовчуванням" : "Default branch"}</span>
            <input value={defaultBranch} placeholder="main" onChange={(event) => setDefaultBranch(event.target.value)} />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Класифікація даних" : "Data classification"}</span>
            <select value={dataClassification} onChange={(event) => setDataClassification(event.target.value as DataClassification)}>
              {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{classificationLabel(value, isUk)}</option>)}
            </select>
            <small>{isUk ? "Підвищувати можна; зниження відхиляється сервером." : "Raising is allowed; lowering is refused by the server."}</small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Клас зберігання" : "Retention class"}</span>
            <select value={retentionClass} onChange={(event) => setRetentionClass(event.target.value as RetentionClass)}>
              {RETENTIONS.map((value) => <option key={value} value={value}>{retentionLabel(value, isUk)}</option>)}
            </select>
          </label>
        </section>

        {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

        <div className="browser-form-footer">
          <div className="browser-form-footer-hint">
            {readOnly
              ? (readOnlyTitle ?? (isUk ? "Coding Agent вимкнено (History read-only)" : "Coding Agent is disabled (History read-only)"))
              : isUk ? "Зміни зберігаються з перевіркою revision." : "Changes are saved with a revision check."}
          </div>
          <div className="code-detail-actions">
            {project.status !== "archived" && (
              <button
                type="button"
                className="automation-action-btn danger"
                disabled={busy || readOnly}
                title={readOnly ? readOnlyTitle : undefined}
                onClick={onArchive}
              >
                {isUk ? "Архівувати" : "Archive"}
              </button>
            )}
            <button
              type="submit"
              className="button-primary automations-action-primary browser-submit-btn"
              disabled={saving || readOnly}
              title={readOnly ? readOnlyTitle : undefined}
            >
              {saving ? (isUk ? "Збереження…" : "Saving…") : isUk ? "Зберегти" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}

// --- Drawer: new session -----------------------------------------------------

function CreateSessionDrawer({ isUk, projects, initialProjectId, onClose, onSubmit }: {
  isUk: boolean;
  projects: CodeProject[];
  initialProjectId: string;
  onClose: () => void;
  onSubmit: (projectId: string, input: { mode: SessionMode; summary?: string }) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(() =>
    projects.some((project) => project.id === initialProjectId) ? initialProjectId : projects[0]?.id ?? "");
  const [mode, setMode] = useState<SessionMode>("plan");
  const [summary, setSummary] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const projectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => { projectRef.current?.focus(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || working) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onSubmit(projectId, { mode, summary: summary.trim() || undefined });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title={isUk ? "Нова сесія" : "New session"}
      subtitle={isUk ? "Code · сесія" : "Code · session"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <section>
          <h3>{isUk ? "Параметри сесії" : "Session settings"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "Код-проєкт" : "Code project"}</span>
            <select ref={projectRef} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.length === 0 && <option value="">{isUk ? "Немає активних проєктів" : "No active projects"}</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Режим дозволів" : "Permission mode"}</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
              {SESSION_MODES.map((value) => <option key={value} value={value}>{sessionModeLabel(value, isUk)}</option>)}
            </select>
            <small>
              {isUk
                ? "plan — лише планування; ask — відповіді без змін; auto_edit — правки з підтвердженням; full_auto_sandbox — ширша автономія під політикою проєкту."
                : "plan — planning only; ask — answers without changes; auto_edit — changes with approval; full_auto_sandbox — wider autonomy under the project policy."}
            </small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Короткий опис (необов'язково)" : "Summary (optional)"}</span>
            <input
              value={summary}
              maxLength={500}
              placeholder={isUk ? "Наприклад: виправити тести в модулі auth" : "For example: fix the tests in the auth module"}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
        </section>

        {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

        <div className="browser-form-footer">
          <div className="browser-form-footer-hint">
            {isUk
              ? "Сесія не запускає агента — цикл агента з'явиться в C6, а інструменти в C2–C4."
              : "A session does not start the agent — the loop arrives in C6 and the tools in C2–C4."}
          </div>
          <button type="submit" className="button-primary automations-action-primary browser-submit-btn" disabled={!projectId || working}>
            {working ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити сесію" : "Create session"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export default CodeSettingsPage;
