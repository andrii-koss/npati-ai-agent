import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import { CodeSnapshotPanel } from "./CodeSnapshotPanel";
// C14 (owner decision 3): the aggregated metrics of the company this project belongs to. It is a read-only
// panel and it fetches its own report, so the page keeps holding one session-scoped state and the metrics stay
// company-scoped (they are not a property of one session).
import { CodeMetricsPanel } from "./code-workspace/CodeMetricsPanel";
import { listProjectFiles, readProjectFile } from "./project-files-client";
import { writeActiveCompanyId } from "./active-company";

/**
 * Code Workspace (C7).
 *
 * Read-only-first workspace for a code project: file tree, agent stream (run activity),
 * file viewer, bottom tabs (Changes / Terminal / Logs / Activity) and a control panel
 * (permission mode, Stop, usage, preview) plus approval cards with scope selection.
 *
 * Conventions reused from the existing Website Builder workspace (`ProjectPage.tsx`):
 * `authHeaders()` / `apiGet()` / `apiPost()` helpers, `bottom-tabs-nav` + `bottom-tab-content`,
 * the `project-grid` layout with `mobile-focus-*` classes and the `preview` iframe pattern.
 *
 * Security notes: every server-provided value (file names, paths, diffs, command output,
 * tool results) is rendered as a text node — never as HTML, so `dangerouslySetInnerHTML`
 * is deliberately absent. Links are only rendered for http/https targets.
 */

type FileEntry = {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  children?: FileEntry[];
};

type RunEvent = {
  id?: string;
  kind?: string;
  snapshotId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
};

type ActivityResponse = { events?: RunEvent[]; nextCursor?: string | null };

type Change = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
};

type ChangesResponse = { files?: Change[]; changes?: Change[]; diffStats?: { filesChanged?: number; additions?: number; deletions?: number } };

type UsageResponse = {
  /** The route answers in an envelope: `status`/`reason` describe the answer, `usage` carries the numbers. */
  status?: string;
  reason?: string;
  usage?: {
    tokens?: { input: number | null; output: number | null; total: number };
    totalTokens?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    /** `true` means the numbers come from the runner's summary, not from provider metering. */
    estimated?: boolean;
    costUsd?: number | null;
    costStatus?: string;
    source?: string;
  } | null;
};

type PreviewStatus = { status?: string; url?: string; port?: number; message?: string };

type PendingApproval = {
  id: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  diff?: string;
  reason?: string;
  requestedBy?: string;
  createdAt?: string;
};

type ApprovalScope = "once" | "session" | "project";

type BottomTab = "changes" | "terminal" | "logs" | "activity";
type MobileView = "all" | "files" | "stream" | "file" | "bottom";

const SESSION_MODES = ["plan", "ask", "auto_edit", "full_auto_sandbox"] as const;
type SessionMode = (typeof SESSION_MODES)[number];

function authHeaders(): Headers {
  const headers = new Headers();
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

async function apiSend<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string; code?: string } };
    const code = data?.error?.code ? ` [${data.error.code}]` : "";
    if (data?.error?.message) return `${data.error.message}${code}`;
  } catch {
    /* ignore */
  }
  return `HTTP ${response.status}`;
}

/** Only http/https links are ever rendered; `javascript:`/`data:` are silently dropped. */
function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function flattenFiles(entries: FileEntry[] | undefined, prefix = ""): Array<{ path: string; label: string; depth: number }> {
  if (!entries) return [];
  const out: Array<{ path: string; label: string; depth: number }> = [];
  for (const entry of entries) {
    const raw = entry.path ?? entry.name ?? "";
    if (!raw) continue;
    const path = prefix ? `${prefix}/${raw}` : raw;
    const depth = path.split("/").length - 1;
    if (entry.children && entry.children.length > 0) {
      out.push(...flattenFiles(entry.children, path));
    } else if (entry.type !== "directory") {
      out.push({ path, label: raw, depth });
    }
  }
  return out;
}

function eventTitle(event: RunEvent, isUk: boolean): string {
  const kind = event.kind ?? "event";
  const payload = event.payload ?? {};
  const tool = typeof payload.tool === "string" ? payload.tool : undefined;
  if (tool) return `${kind} · ${tool}`;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (action) return `${kind} · ${action}`;
  return kind || (isUk ? "подія" : "event");
}

/** Metadata-only summary: string/number/boolean leaves only, no nested content, bounded. */
function eventFacts(event: RunEvent): Array<[string, string]> {
  const payload = event.payload ?? {};
  const facts: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      facts.push([key, text.length > 200 ? `${text.slice(0, 200)}…` : text]);
    }
    if (facts.length >= 12) break;
  }
  return facts;
}

export function CodeWorkspacePage() {
  const { companyId = "", projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { language } = useTranslation();
  const isUk = language === "uk";

  const base = `/api/companies/${companyId}/projects/${projectId}`;
  const codeBase = `/api/companies/${companyId}/code`;

  const sessionId = searchParams.get("session") ?? "";
  const runId = searchParams.get("run") ?? "";

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [tab, setTab] = useState<BottomTab>("changes");
  const [mobileView, setMobileView] = useState<MobileView>("all");

  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [mode, setMode] = useState<SessionMode>("plan");
  const [task, setTask] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [stopBusy, setStopBusy] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [denyComment, setDenyComment] = useState<Record<string, string>>({});
  const [denyOpen, setDenyOpen] = useState<Record<string, boolean>>({});

  const tree = useMemo(() => flattenFiles(files), [files]);

  useEffect(() => {
    let cancelled = false;
    setContextReady(false);
    if (!sessionId) return;
    void apiGet<{ mode: SessionMode; status: string }>(`${codeBase}/sessions/${encodeURIComponent(sessionId)}`)
      .then(async (session) => {
        if (cancelled) return;
        setMode(session.mode);
        if (session.status === "archived") return;
        const stored = await apiSend<{ persisted: boolean }>("PUT", `${codeBase}/active-context`, { contextType: "project", projectId, sessionId });
        if (!cancelled) {
          if (!stored.persisted) throw new Error("The active code session could not be saved");
          writeActiveCompanyId(companyId);
          setContextReady(true);
          setTaskError(null);
        }
      }).catch((cause) => { if (!cancelled) setTaskError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [codeBase, companyId, projectId, sessionId]);

  const startTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!contextReady || !task.trim() || taskBusy) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const started = await apiSend<{ run: { runId: string } }>("POST", `${codeBase}/runs`, { projectId, sessionId, prompt: task.trim() });
      const next = new URLSearchParams(searchParams);
      next.set("run", started.run.runId);
      setSearchParams(next);
      setTask("");
    } catch (cause) { setTaskError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTaskBusy(false); }
  };

  const loadFiles = useCallback(async () => {
    try {
      // Shared adapter (C7): the code workspace no longer hand-builds a Website Builder files URL, so a change
      // to that surface cannot break this page silently.
      const data = await listProjectFiles({ companyId, projectId });
      setFiles((data.files ?? []) as FileEntry[]);
      setFilesError(null);
    } catch (cause) {
      setFiles([]);
      setFilesError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [companyId, projectId]);

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await apiGet<PreviewStatus>(`${base}/preview/status`));
    } catch {
      setPreview(null);
    }
  }, [base]);

  const loadStream = useCallback(async () => {
    if (!runId) {
      setEvents([]);
      setStreamError(null);
      return;
    }
    try {
      const data = await apiGet<ActivityResponse>(`${codeBase}/runs/${runId}/activity`);
      setEvents(data.events ?? []);
      setStreamError(null);
    } catch (cause) {
      setEvents([]);
      setStreamError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [codeBase, runId]);

  const loadChanges = useCallback(async () => {
    if (!sessionId) {
      setChanges(null);
      setChangesError(null);
      return;
    }
    try {
      setChanges(await apiGet<ChangesResponse>(`${codeBase}/sessions/${sessionId}/changes`));
      setChangesError(null);
    } catch (cause) {
      setChanges(null);
      setChangesError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [codeBase, sessionId]);

  const loadUsage = useCallback(async () => {
    if (!sessionId) {
      setUsage(null);
      setUsageError(null);
      return;
    }
    try {
      setUsage(await apiGet<UsageResponse>(`${codeBase}/sessions/${sessionId}/usage`));
      setUsageError(null);
    } catch (cause) {
      setUsage(null);
      setUsageError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [codeBase, sessionId]);

  const loadApprovals = useCallback(async () => {
    try {
      const data = await apiGet<{ approvals?: PendingApproval[]; items?: PendingApproval[] }>(
        `/api/companies/${companyId}/approvals?status=pending`,
      );
      setApprovals(data.approvals ?? data.items ?? []);
    } catch {
      setApprovals([]);
    }
  }, [companyId]);

  useEffect(() => {
    void loadFiles();
    void loadPreview();
    void loadApprovals();
  }, [loadFiles, loadPreview, loadApprovals]);

  useEffect(() => {
    void loadStream();
    void loadChanges();
    void loadUsage();
  }, [loadStream, loadChanges, loadUsage]);

  useEffect(() => {
    if (!runId) return;
    const timer = window.setInterval(() => {
      void loadStream(); void loadChanges(); void loadUsage(); void loadApprovals(); void loadFiles();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [runId, loadStream, loadChanges, loadUsage, loadApprovals, loadFiles]);

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setFileContent(null);
      setFileError(null);
      try {
        // Shared adapter (C7): one implementation of the file read (`{ path, content, size, revision }`),
        // used by both the Website Builder workspace and this page.
        const data = await readProjectFile({ companyId, projectId }, path);
        setFileContent(data.content ?? "");
      } catch (cause) {
        setFileError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [companyId, projectId],
  );

  const applyMode = useCallback(
    async (next: SessionMode) => {
      if (!sessionId) return;
      setModeBusy(true);
      setModeError(null);
      try {
        await apiSend("PUT", `${codeBase}/sessions/${sessionId}/mode`, { mode: next });
        setMode(next);
      } catch (cause) {
        setModeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setModeBusy(false);
      }
    },
    [codeBase, sessionId],
  );

  const stopRun = useCallback(async () => {
    if (!sessionId) return;
    setStopBusy(true);
    setStopNotice(null);
    try {
      await apiSend("POST", `${codeBase}/sessions/${sessionId}/stop`);
      setStopNotice(isUk ? "Зупинку надіслано." : "Stop requested.");
      void loadStream();
    } catch (cause) {
      setStopNotice(
        `${isUk ? "Зупинка недоступна" : "Stop is unavailable"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setStopBusy(false);
    }
  }, [codeBase, isUk, loadStream, sessionId]);

  const decide = useCallback(
    async (approval: PendingApproval, decision: "approve" | "deny", scope: ApprovalScope) => {
      setApprovalBusy(approval.id);
      setApprovalError(null);
      const comment = (denyComment[approval.id] ?? "").slice(0, 500);
      try {
        // The decide route's schema accepts exactly `decision: "approved" | "rejected"` plus an optional
        // `notes`. Sending `approve`/`deny`/`comment`/`scope` failed schema validation (400), which made both
        // buttons dead rather than merely wrong. Scope is expressed by creating a standing rule below — the
        // decision itself carries no scope, and the server refuses privileged actions for session/project.
        if (decision === "deny") {
          await apiSend("POST", `/api/companies/${companyId}/approvals/${approval.id}/decide`, {
            decision: "rejected",
            notes: comment || undefined,
          });
        } else if (scope === "once") {
          await apiSend("POST", `/api/companies/${companyId}/approvals/${approval.id}/decide`, {
            decision: "approved",
          });
        } else {
          // `session`/`project` create a standing rule (C5); privileged actions are refused
          // by the server for these scopes, and the error is surfaced verbatim.
          await apiSend("POST", `${codeBase}/approval-rules`, {
            action: approval.toolName ?? "code.shell.exec",
            scope,
            command: approval.command,
            reason: isUk ? "Схвалено з Code Workspace" : "Approved from Code Workspace",
          });
          await apiSend("POST", `/api/companies/${companyId}/approvals/${approval.id}/decide`, {
            decision: "approved",
            notes: comment || undefined,
          });
        }
        setApprovals((current) => current.filter((item) => item.id !== approval.id));
      } catch (cause) {
        setApprovalError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setApprovalBusy(null);
      }
    },
    [codeBase, companyId, denyComment, isUk],
  );

  const selectSession = useCallback(
    (nextSession: string, nextRun?: string) => {
      const params = new URLSearchParams(searchParams);
      if (nextSession) params.set("session", nextSession);
      else params.delete("session");
      if (nextRun) params.set("run", nextRun);
      else params.delete("run");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const changedFiles = changes?.files ?? changes?.changes ?? [];
  const previewUrl = preview?.url ? safeExternalUrl(preview.url) : null;

  return (
    <div className="project-page code-workspace" data-project-id={projectId}>
      <header className="project-header">
        <div>
          <p className="eyebrow">{isUk ? "Code Workspace" : "Code Workspace"}</p>
          <h1>{isUk ? "Робочий простір кодового агента" : "Coding agent workspace"}</h1>
        </div>
        <div className="project-header-actions">
          <Link className="marketplace-back-button" to="/settings/code">
            {isUk ? "← До код-проєктів" : "← Code projects"}
          </Link>
        </div>
      </header>

      {!sessionId && (
        <div className="data-studio-alert">
          {isUk
            ? "Сесію не вибрано. Відкрийте Workspace зі списку сесій (Settings → Code) або додайте ?session=<id> до адреси."
            : "No session selected. Open the workspace from the session list (Settings → Code) or add ?session=<id> to the URL."}
        </div>
      )}

      <form className="code-workspace-controls" onSubmit={startTask}>
        <label className="browser-form-field">
          <span>{isUk ? "Завдання для Coding Agent" : "Task for Coding Agent"}</span>
          <textarea value={task} onChange={(event) => setTask(event.target.value)} disabled={!contextReady || taskBusy} rows={3} placeholder={isUk ? "Поясни код, виправ помилку або додай тест…" : "Explain code, fix a bug or add a test…"} />
        </label>
        <button type="submit" className="button-primary" disabled={!contextReady || !task.trim() || taskBusy}>{taskBusy ? (isUk ? "Запуск…" : "Starting…") : (isUk ? "Запустити агента" : "Run agent")}</button>
        {contextReady && <Link className="button-secondary" to="/chat">{isUk ? "Продовжити в чаті" : "Continue in chat"}</Link>}
        {taskError && <p role="alert" className="ds-hint-error">{taskError}</p>}
      </form>

      <div className="mobile-view-switch" role="tablist" aria-label={isUk ? "Панелі" : "Panels"}>
        {(["all", "files", "stream", "file", "bottom"] as MobileView[]).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={mobileView === view}
            className={`mobile-view-button ${mobileView === view ? "active" : ""}`}
            onClick={() => setMobileView(view)}
          >
            {view === "all"
              ? isUk ? "Усе" : "All"
              : view === "files"
                ? isUk ? "Файли" : "Files"
                : view === "stream"
                  ? isUk ? "Стрім" : "Stream"
                  : view === "file"
                    ? isUk ? "Файл" : "File"
                    : isUk ? "Вкладки" : "Tabs"}
          </button>
        ))}
      </div>

      <div className={`project-grid ${mobileView !== "all" ? `mobile-focus-${mobileView}` : ""}`}>
        <section className="project-panel project-files" aria-label={isUk ? "Файли" : "Files"}>
          <h2 className="ds-section-title">{isUk ? "Файли" : "Files"}</h2>
          {filesError && <p className="ds-hint-error">{filesError}</p>}
          {!filesError && tree.length === 0 && (
            <p className="ds-muted">{isUk ? "Файли ще не завантажено." : "No files loaded yet."}</p>
          )}
          <ul className="code-file-tree">
            {tree.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className={`code-file-tree-item ${selectedPath === file.path ? "active" : ""}`}
                  style={{ paddingLeft: `${8 + file.depth * 12}px` }}
                  onClick={() => void openFile(file.path)}
                >
                  {file.label}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="project-panel project-chat" aria-label={isUk ? "Стрім агента" : "Agent stream"}>
          <h2 className="ds-section-title">{isUk ? "Стрім агента" : "Agent stream"}</h2>
          {!runId && (
            <p className="ds-muted">
              {isUk
                ? "Активного run-у немає — стрім з'явиться, коли сесія почне run."
                : "No active run — the stream appears once the session starts a run."}
            </p>
          )}
          {runId && streamError && <p className="ds-hint-error">{streamError}</p>}
          {runId && !streamError && events.length === 0 && (
            <p className="ds-muted">{isUk ? "Подій ще немає." : "No events yet."}</p>
          )}
          <ol className="code-stream">
            {events.map((event, index) => {
              const key = event.id ?? `${event.kind ?? "event"}-${index}`;
              const isOpen = expanded[key] ?? false;
              return (
                <li key={key} className="code-stream-item">
                  <button
                    type="button"
                    className="code-stream-toggle"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded((current) => ({ ...current, [key]: !isOpen }))}
                  >
                    <span className="code-stream-kind">{eventTitle(event, isUk)}</span>
                    {event.snapshotId && <span className="data-studio-badge">snapshot</span>}
                  </button>
                  {isOpen && (
                    <div className="code-stream-body">
                      {eventFacts(event).length === 0 && (
                        <p className="ds-muted">{isUk ? "Лише метадані." : "Metadata only."}</p>
                      )}
                      {eventFacts(event).map(([label, value]) => (
                        <div className="code-detail-row" key={`${key}-${label}`}>
                          <span>{label}</span>
                          <code>{value}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {approvals.length > 0 && (
            <div className="code-approvals">
              <h3 className="ds-section-title">{isUk ? "Очікують підтвердження" : "Awaiting approval"}</h3>
              {approvalError && <p className="ds-hint-error">{approvalError}</p>}
              {approvals.map((approval) => (
                <article className="code-approval-card" key={approval.id}>
                  <header>
                    <code>{approval.toolName ?? "code.shell.exec"}</code>
                    {approval.cwd && <span className="ds-muted"> cwd: {approval.cwd}</span>}
                  </header>
                  {approval.command && <pre className="code-approval-body">{approval.command}</pre>}
                  {approval.diff && <pre className="code-approval-body">{approval.diff}</pre>}
                  {approval.reason && <p className="ds-muted">{approval.reason}</p>}
                  <div className="code-approval-actions">
                    <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "once")}>
                      {isUk ? "Одноразово" : "Approve once"}
                    </button>
                    <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "session")}>
                      {isUk ? "На сесію" : "For session"}
                    </button>
                    <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "project")}>
                      {isUk ? "На проєкт" : "For project"}
                    </button>
                    <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => setDenyOpen((current) => ({ ...current, [approval.id]: !current[approval.id] }))}>
                      {isUk ? "Відхилити" : "Deny"}
                    </button>
                  </div>
                  {denyOpen[approval.id] && (
                    <div className="code-approval-deny">
                      <textarea
                        maxLength={500}
                        value={denyComment[approval.id] ?? ""}
                        placeholder={isUk ? "Причина (повернеться моделі)" : "Reason (returned to the model)"}
                        onChange={(event) => setDenyComment((current) => ({ ...current, [approval.id]: event.target.value }))}
                      />
                      <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "deny", "once")}>
                        {isUk ? "Підтвердити відхилення" : "Confirm deny"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="project-panel project-preview" aria-label={isUk ? "Файл" : "File"}>
          <h2 className="ds-section-title">{selectedPath || (isUk ? "Виберіть файл" : "Select a file")}</h2>
          {fileError && <p className="ds-hint-error">{fileError}</p>}
          {!fileError && fileContent === null && selectedPath && (
            <p className="ds-muted">{isUk ? "Завантаження…" : "Loading…"}</p>
          )}
          {fileContent !== null && <pre className="project-file-browser-pre">{fileContent}</pre>}
          <p className="ds-muted">
            {isUk
              ? "Перегляд лише для читання; ручні правки — через інструменти з підтвердженням."
              : "Read-only view; manual edits go through the approved tools."}
          </p>
        </section>
      </div>

      <section className="code-workspace-controls" aria-label={isUk ? "Керування" : "Controls"}>
        <label className="browser-form-field">
          <span>{isUk ? "Режим дозволів" : "Permission mode"}</span>
          <select
            value={mode}
            disabled={!sessionId || modeBusy}
            onChange={(event) => void applyMode(event.target.value as SessionMode)}
          >
            {SESSION_MODES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        {modeError && <p className="ds-hint-error">{modeError}</p>}

        <div className="code-workspace-usage">
          {usageError && <span className="ds-hint-error">{usageError}</span>}
          {!usageError && usage?.status === "unavailable" && (
            <span className="ds-muted">
              {isUk ? "Облік токенів/вартості недоступний" : "Token/cost accounting is unavailable"}
              {usage.reason ? ` (${usage.reason})` : ""}.
            </span>
          )}
          {!usageError && usage?.status === "ok" && usage.usage && (
            <span className="ds-muted">
              {isUk ? "Токени" : "Tokens"}: {usage.usage.totalTokens === undefined ? "—" : usage.usage.totalTokens}
              {usage.usage.estimated ? ` (${isUk ? "оцінка" : "estimate"})` : ""} ·{" "}
              {isUk ? "вартість" : "cost"}:{" "}
              {typeof usage.usage.costUsd === "number"
                ? `$${usage.usage.costUsd.toFixed(4)}${usage.usage.estimated ? ` (${isUk ? "оцінка" : "estimate"})` : ""}`
                : "—"}
            </span>
          )}
        </div>

        <button type="button" className="button-secondary" disabled={!sessionId || stopBusy} onClick={() => void stopRun()}>
          {stopBusy ? "…" : isUk ? "Зупинити" : "Stop"}
        </button>
        {stopNotice && <p className="ds-muted">{stopNotice}</p>}

        {preview?.status === "running" && previewUrl && (
          <button type="button" className="button-secondary" onClick={() => setPreviewOpen((current) => !current)}>
            {previewOpen ? (isUk ? "Закрити preview" : "Close preview") : isUk ? "Відкрити preview" : "Open preview"}
          </button>
        )}
        {preview?.status && preview.status !== "running" && (
          <span className="ds-muted">{isUk ? "Preview недоступний: " : "Preview unavailable: "}{preview.status}</span>
        )}
      </section>

      {previewOpen && previewUrl && (
        <div className="project-preview-frame">
          <iframe src={previewUrl} title={isUk ? "Live preview" : "Live preview"} sandbox="allow-scripts allow-forms allow-same-origin" />
        </div>
      )}

      <CodeMetricsPanel companyId={companyId} />

      <section className="bottom-tabs">
        <div className="bottom-tabs-nav" role="tablist">
          {(["changes", "terminal", "logs", "activity"] as BottomTab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`bottom-tab-button ${tab === value ? "active" : ""}`}
              onClick={() => setTab(value)}
            >
              {value === "changes"
                ? isUk ? "Зміни" : "Changes"
                : value === "terminal"
                  ? "Terminal"
                  : value === "logs"
                    ? "Logs"
                    : "Activity"}
            </button>
          ))}
        </div>

        <div className="bottom-tab-content">
          {tab === "changes" && (
            <div>
              {!sessionId && <p className="ds-muted">{isUk ? "Сесію не вибрано." : "No session selected."}</p>}
              {sessionId && changesError && <p className="ds-hint-error">{changesError}</p>}
              {sessionId && !changesError && changedFiles.length === 0 && (
                <p className="ds-muted">{isUk ? "Змін немає." : "No changes."}</p>
              )}
              <ul className="code-changes-list">
                {changedFiles.map((change) => (
                  <li key={change.path}>
                    <div className="code-change-header">
                      <code>{change.path}</code>
                      <span className="ds-muted">
                        {change.status ?? "modified"}
                        {change.additions !== undefined ? ` +${change.additions}` : ""}
                        {change.deletions !== undefined ? ` -${change.deletions}` : ""}
                      </span>
                    </div>
                    {change.diff && <pre className="code-diff">{change.diff}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "terminal" && (
            <p className="ds-muted">
              {isUk
                ? "Вивід команд відображається в стрімі агента як результат tool call; окремий термінал — у Website Builder."
                : "Command output appears in the agent stream as a tool-call result; a standalone terminal lives in Website Builder."}
            </p>
          )}

          {tab === "logs" && (
            <p className="ds-muted">
              {isUk
                ? "Логи run-у доступні в Activity (метадані) та в AuditLog для привілейованих дій."
                : "Run logs are available in Activity (metadata) and in the AuditLog for privileged actions."}
            </p>
          )}

          {tab === "activity" && (
            runId ? (
              <CodeSnapshotPanel companyId={companyId} runId={runId} isUk={isUk} />
            ) : (
              <p className="ds-muted">
                {isUk ? "Activity з'явиться, коли сесія почне run." : "Activity appears once the session starts a run."}
              </p>
            )
          )}
        </div>
      </section>

      <section className="code-workspace-sessions">
        <button
          type="button"
          className="button-secondary"
          onClick={() => selectSession(sessionId, runId)}
        >
          {isUk ? "Оновити" : "Refresh"}
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            void loadFiles();
            void loadStream();
            void loadChanges();
            void loadUsage();
            void loadPreview();
            void loadApprovals();
          }}
        >
          {isUk ? "Перезавантажити все" : "Reload all"}
        </button>
      </section>
    </div>
  );
}

export default CodeWorkspacePage;
