import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { chooseAvailableCompanyId, readCachedCompanies, writeActiveCompanyId } from "./active-company";
import { CodeFlagsPanel } from "./CodeFlagsPanel";
import { CodeSandboxImagesPanel } from "./CodeSandboxImagesPanel";
import { CodeDataPolicyPanel } from "./CodeDataPolicyPanel";
import { CodeQueuePanel } from "./CodeQueuePanel";
import { CodeMembershipPanel } from "./CodeMembershipPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { persistedSessionMode } from "./code-workspace/actions";
import {
  type CompanySummary,
  type CodeProject,
  type CodeSession,
  type CodeLimits,
  type Feedback,
  type DataClassification,
  type RetentionClass,
  type SessionMode,
  type VerifyCommands,
  codeErrorMessage,
  errorCode,
  formatDate,
  classificationLabel,
  retentionLabel,
  sessionModeLabel,
  sessionStatusLabel,
  projectStatusClass,
  sessionStatusClass,
  ToolchainCell,
  CreateProjectDrawer,
  ProjectDetailsDrawer,
  CreateSessionDrawer,
} from "./code-settings";

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

function CodeSettingsPageContent() {
  const navigate = useNavigate();
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

  const openSession = useCallback(async (session: Pick<CodeSession, "id" | "projectId" | "status">, chat = false) => {
    setBusyId(session.id);
    try {
      if (session.status !== "archived") {
        const result = await apiFetch<{ persisted: boolean }>(`/companies/${encodeURIComponent(companyId)}/code/active-context`, {
          method: "PUT", body: JSON.stringify({ contextType: "project", projectId: session.projectId, sessionId: session.id }),
        });
        if (!result.persisted) throw new Error(isUk ? "Не вдалося зберегти активну сесію." : "Could not save the active session.");
      }
      writeActiveCompanyId(companyId);
      navigate(chat ? `/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(session.projectId)}`
        : `/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(session.projectId)}?session=${encodeURIComponent(session.id)}`);
    } catch (cause) {
      setFeedback({ type: "error", message: codeErrorMessage(cause, isUk) });
    } finally { setBusyId(null); }
  }, [companyId, isUk, navigate]);

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
        setCompanyId((current) => current || chooseAvailableCompanyId(list));
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

  const companyList = Array.isArray(companies) ? companies : [];
  const projectList = Array.isArray(projects) ? projects : [];
  const sessionList = Array.isArray(sessions) ? sessions : [];

  const companyName = companyList.find((company) => company.id === companyId)?.name ?? "";

  const visibleProjects = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return projectList
      .filter((project) => (showArchived ? true : project.status !== "archived"))
      .filter((project) => {
        if (!needle) return true;
        return (project.name ?? "").toLowerCase().includes(needle)
          || (project.repositoryUrl ?? "").toLowerCase().includes(needle);
      });
  }, [projectList, searchQuery, showArchived]);

  const detailProject = detailId ? projectList.find((project) => project.id === detailId) ?? null : null;

  const stats = useMemo(() => ({
    projects: projectList.filter((project) => project.status !== "archived").length,
    activeSessions: sessionList.filter((session) => session.status === "active" || session.status === "awaiting_approval").length,
    repositories: projectList.filter((project) => Boolean(project.repositoryUrl)).length,
    toolchains: projectList.filter((project) => Boolean(project.toolchain)).length,
  }), [projectList, sessionList]);

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
        { method: "POST", body: JSON.stringify({ mode: persistedSessionMode(input.mode), ...(input.summary ? { summary: input.summary } : {}) }) },
    );
    setSessionOpen(false);
    setFeedback({
      type: "success",
      message: isUk ? `Сесію ${session.id.slice(0, 8)} створено (${sessionModeLabel(session.mode, isUk)}).` : `Session ${session.id.slice(0, 8)} created (${sessionModeLabel(session.mode, isUk)}).`,
    });
    reload();
    await openSession(session);
  }, [companyId, isUk, reload, openSession]);

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
    <main className="automations-container code-agent-settings">
      <header className="inspector-header automations-header marketplace-hero">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Налаштування · Code" : "Settings · Code"}</p>
            <h1>
              <Link to="/settings/code" className="marketplace-back-button" aria-label={isUk ? "Назад до агентів" : "Back to agents"} title={isUk ? "Назад до агентів" : "Back to agents"}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>Npati Code</span>
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
                  ? "Відкрийте сесію, щоб працювати з агентом, або продовжуйте її в чаті."
                  : "Open a session to work with the agent or continue it in chat."}
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

          {sessions.length > 0 && (
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
                        <button type="button" className="automation-action-btn" disabled={busyId === session.id} onClick={() => void openSession(session)}>{isUk ? "Відкрити Workspace" : "Open Workspace"}</button>
                        <button type="button" className="automation-action-btn" disabled={busyId === session.id || readOnly || session.status === "archived"} onClick={() => void openSession(session, true)}>{isUk ? "У чаті" : "Open in chat"}</button>
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
            <ErrorBoundary title={isUk ? "Панель Feature Flags" : "Feature Flags panel"}>
              <CodeFlagsPanel
                companyId={companyId}
                isUk={isUk}
                notify={(type, message) => setFeedback({ type, message })}
                onMasterEnabledChange={setMasterEnabled}
                onSessionsSuspended={() => reload()}
              />
            </ErrorBoundary>
          )}

          {companyId && (
            <ErrorBoundary title={isUk ? "Панель Sandbox Images" : "Sandbox Images panel"}>
              <CodeSandboxImagesPanel
                companyId={companyId}
                isUk={isUk}
                notify={(type, message) => setFeedback({ type, message })}
              />
            </ErrorBoundary>
          )}

          {companyId && (
            <ErrorBoundary title={isUk ? "Панель Data Policy" : "Data Policy panel"}>
              <CodeDataPolicyPanel
                companyId={companyId}
                isUk={isUk}
                notify={(type, message) => setFeedback({ type, message })}
              />
            </ErrorBoundary>
          )}

          {/* R1 (section A, item 3): the queue's state is visible instead of being inferable only from a refusal. */}
          {companyId && (
            <ErrorBoundary title={isUk ? "Панель черги" : "Queue panel"}>
              <CodeQueuePanel companyId={companyId} isUk={isUk} />
            </ErrorBoundary>
          )}

          {/* C5a: Code membership, roles, and denial reasoning */}
          {companyId && (
            <ErrorBoundary title={isUk ? "Панель учасників" : "Membership panel"}>
              <CodeMembershipPanel companyId={companyId} isUk={isUk} />
            </ErrorBoundary>
          )}

          <section className="browser-campaign-card code-limits-panel" aria-label={isUk ? "Ліміти (конфігурація)" : "Limits (configuration)"}>
            <div className="browser-campaign-card-header">
              <div className="browser-card-title-group">
                <span className="browser-card-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="21" x2="4" y2="14" />
                    <line x1="4" y1="10" x2="4" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12" y2="3" />
                    <line x1="20" y1="21" x2="20" y2="16" />
                    <line x1="20" y1="12" x2="20" y2="3" />
                    <line x1="1" y1="14" x2="7" y2="14" />
                    <line x1="9" y1="8" x2="15" y2="8" />
                    <line x1="17" y1="16" x2="23" y2="16" />
                  </svg>
                </span>
                <div>
                  <h3>{isUk ? "Ліміти (конфігурація)" : "Limits (configuration)"}</h3>
                  <p>
                    {isUk
                      ? "Параметри та обмеження ресурсів середовища виконання Coding Agent."
                      : "The state of runtime limits and security bounds. This panel starts and changes nothing."}
                  </p>
                </div>
              </div>
            </div>

            {limitsError && <p className="ds-muted">{limitsError}</p>}
            {limits && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: "10px",
                  marginTop: "6px",
                }}
              >
                {Object.entries(limits).map(([key, value]) => (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      padding: "10px 14px",
                      background: "#ffffff",
                      border: "1px solid var(--npati-gray-100)",
                      borderRadius: "10px",
                      boxShadow: "0 1px 3px rgba(17, 17, 17, 0.03)",
                    }}
                  >
                    <code style={{ color: "var(--npati-black)", fontWeight: 600, fontSize: "12px", fontFamily: "ui-monospace, monospace" }}>{key}</code>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: "12px",
                        color: "var(--npati-red)",
                        background: "#ffffff",
                        border: "1px solid rgba(225, 29, 46, 0.25)",
                        padding: "2px 8px",
                        borderRadius: "6px",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
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

export function CodeSettingsPage() {
  return (
    <ErrorBoundary showBackToAgents title="Помилка завантаження налаштувань кодінг-агента / Code settings error">
      <CodeSettingsPageContent />
    </ErrorBoundary>
  );
}

export default CodeSettingsPage;
