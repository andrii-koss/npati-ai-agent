import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "./i18n";
import { AsyncWorkspacePanel } from "./code-workspace/AsyncWorkspacePanel";
// C14 (owner decision 3): the aggregated metrics of the company this project belongs to. It is a read-only
// panel and it fetches its own report, so the page keeps holding one session-scoped state and the metrics stay
// company-scoped (they are not a property of one session).
import { CodeMetricsPanel } from "./code-workspace/CodeMetricsPanel";
import { listProjectFiles, readProjectFile } from "./project-files-client";
import { writeActiveCompanyId } from "./active-company";
import {
  type FileEntry,
  type RunEvent,
  type ActivityResponse,
  type ChangesResponse,
  type UsageResponse,
  type PreviewStatus,
  type PendingApproval,
  type ApprovalScope,
  type BottomTab,
  type MobileView,
  SESSION_MODES,
  type SessionMode,
  apiGet,
  apiSend,
  safeExternalUrl,
  flattenFiles,
  eventTitle,
  eventFacts,
} from "./code-workspace-page-types";
import { CodeWorkspaceBottomTabs } from "./code-workspace-bottom-tabs";

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

export function CodeWorkspacePage() {
  const { companyId = "", projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  // Scope changes dispose the old view; late file/activity replies cannot reach the new scope.
  // A new run in the same session keeps inbox/control retry identity and browser continuity.
  return <CodeWorkspaceContent key={JSON.stringify([companyId, projectId, searchParams.get("session") ?? ""])} />;
}

function CodeWorkspaceContent() {
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
  const [activeTab, setActiveTab] = useState<"workspace" | "files" | "changes" | "metrics" | "all">("workspace");

  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [mode, setMode] = useState<SessionMode>("plan");
  const [task, setTask] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const [asyncInboxEnabled, setAsyncInboxEnabled] = useState<boolean | null>(null);
  const asyncBinding = JSON.stringify([companyId, projectId, sessionId]);
  useEffect(() => { setAsyncInboxEnabled(null); }, [asyncBinding]);
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

  const tree = useMemo(() => flattenFiles(files), [files]);

  const [sessions, setSessions] = useState<Array<{ id: string; projectId: string; status: string; mode: SessionMode; summary?: string }>>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [copied, setCopied] = useState(false);

  const filteredTree = useMemo(() => {
    if (!fileFilter.trim()) return tree;
    const q = fileFilter.toLowerCase();
    return tree.filter((f) => f.path.toLowerCase().includes(q) || f.label.toLowerCase().includes(q));
  }, [tree, fileFilter]);

  const getFileIcon = (label: string) => {
    const ext = label.split(".").pop()?.toLowerCase();
    if (ext === "html") return "🌐";
    if (ext === "css") return "🎨";
    if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx") return "⚡";
    if (ext === "json") return "⚙️";
    if (ext === "md" || ext === "txt") return "📝";
    if (["png", "jpg", "jpeg", "svg", "webp", "gif", "ico"].includes(ext ?? "")) return "🖼️";
    return "📄";
  };

  const copyFileContent = () => {
    if (!fileContent) return;
    navigator.clipboard.writeText(fileContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    if (!companyId || !projectId) return;
    let cancelled = false;
    setLoadingSessions(true);
    void apiGet<{ sessions: Array<{ id: string; projectId: string; status: string; mode: SessionMode; summary?: string }> }>(
      `${codeBase}/sessions?projectId=${encodeURIComponent(projectId)}`
    )
      .then((data) => {
        if (cancelled) return;
        const list = (data.sessions ?? []).filter((s) => s.projectId === projectId && s.status !== "archived");
        setSessions(list);
        if (!sessionId && list.length > 0 && list[0]) {
          selectSession(list[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });
    return () => { cancelled = true; };
  }, [codeBase, companyId, projectId, sessionId, selectSession]);

  const createNewSession = async () => {
    if (!companyId || !projectId || taskBusy) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const created = await apiSend<{ id: string }>("POST", `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/code/sessions`, {
        mode,
        summary: isUk ? "Сесія сайту" : "Site session",
      });
      if (created?.id) {
        selectSession(created.id);
      }
    } catch (cause) {
      setTaskError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTaskBusy(false);
    }
  };

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
    if (!task.trim() || taskBusy) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const created = await apiSend<{ id: string }>("POST", `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/code/sessions`, {
          mode,
          summary: task.trim().slice(0, 100),
        });
        activeSessionId = created.id;
        selectSession(activeSessionId);
      }
      const started = await apiSend<{ run: { runId: string } }>("POST", `${codeBase}/runs`, {
        projectId,
        sessionId: activeSessionId,
        prompt: task.trim(),
      });
      const next = new URLSearchParams(searchParams);
      if (!sessionId) next.set("session", activeSessionId);
      next.set("run", started.run.runId);
      setSearchParams(next);
      setTask("");
    } catch (cause) {
      setTaskError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTaskBusy(false);
    }
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



  const changedFiles = changes?.files ?? changes?.changes ?? [];
  const previewUrl = preview?.url ? safeExternalUrl(preview.url) : null;

  return (
    <main className="goals-container automations-container code-workspace" data-project-id={projectId} style={{ maxWidth: 1180, margin: "0 auto", paddingBottom: 60 }}>
      {/* Hero Header matching /settings/email and /settings/automations */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Кодовий агент та розробка" : "Code Agent & Workspace"}</p>
            <h1>
              <Link
                to="/settings/websites"
                className="marketplace-back-button"
                aria-label={isUk ? "Назад" : "Back"}
                title={isUk ? "Повернутися назад" : "Go back"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{isUk ? "Робочий простір кодового агента" : "Coding agent workspace"}</span>
            </h1>
            <p className="hero-copy">
              {isUk
                ? "Автономне середовище AI-розробника для аналізу вихідних файлів, внесення правок та виконання завдань вашого сайту чи проєкту."
                : "Autonomous AI developer environment to inspect, edit, and test website or project source code."}
            </p>
          </div>

          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => void createNewSession()}
              disabled={taskBusy}
              title={isUk ? "Створити нову сесію розробки" : "Create new coding session"}
            >
              + {isUk ? "Нова сесія" : "New session"}
            </button>
            <Link
              to="/settings/websites"
              className="button-secondary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              {isUk ? "До сайтів" : "Websites"}
            </Link>
          </div>
        </div>
      </header>

      {/* Scope & Status Toolbar Card matching EmailSettingsOverviewBlock */}
      <div className="email-scope-toolbar">
        <div className="email-scope-left">
          <div className="email-scope-pill">
            <span className="email-scope-badge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>{isUk ? "Сесія:" : "Session:"}</span>
            </span>
            <div className="email-scope-select-wrap">
              <select
                className="email-scope-select"
                value={sessionId}
                onChange={(e) => selectSession(e.target.value)}
                aria-label={isUk ? "Вибрати сесію" : "Select session"}
              >
                {sessions.length > 0 ? (
                  sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      #{s.id.slice(0, 8)} ({s.mode}) {s.summary ? `— ${s.summary.slice(0, 20)}` : ""}
                    </option>
                  ))
                ) : (
                  <option value="">{isUk ? "Нова сесія" : "New session"}</option>
                )}
              </select>
              <span className="email-scope-select-arrow" aria-hidden="true">▾</span>
            </div>
          </div>

          <span className="data-studio-badge info" style={{ fontWeight: 700, fontSize: "11px", letterSpacing: "0.06em" }}>
            CODE WORKSPACE
          </span>
          {sessionId ? (
            <span className="data-studio-badge success" style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
              {isUk ? `Сесія #${sessionId.slice(0, 8)}` : `Session #${sessionId.slice(0, 8)}`}
            </span>
          ) : (
            <span className="data-studio-badge warning">
              {isUk ? "Нова сесія" : "New session"}
            </span>
          )}
          <span className="data-studio-badge" style={{ background: "#f1f5f9", color: "#475569" }}>
            {isUk ? `Режим: ${mode}` : `Mode: ${mode}`}
          </span>
          <span className="ds-muted" style={{ fontSize: "12px" }}>
            {isUk ? "Проєкт" : "Project"}: <code>{projectId ? projectId.slice(0, 13) : "—"}</code>
          </span>
        </div>

        <div className="email-scope-right">
          {sessionId && (
            <button
              type="button"
              className="button-secondary"
              disabled={stopBusy}
              onClick={() => void stopRun()}
              style={{ fontSize: "12px", color: "#b91c1c" }}
              title={isUk ? "Зупинити активний запуск" : "Stop active run"}
            >
              {stopBusy ? "…" : isUk ? "Зупинити" : "Stop"}
            </button>
          )}
          <button
            type="button"
            className="button-secondary"
            onClick={() => selectSession(sessionId, runId)}
            style={{ fontSize: "12px" }}
          >
            {isUk ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {/* 4 Stat Overview Cards matching EmailSettingsStatsCards */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid" style={{ marginBottom: 20 }}>
        <div>
          <strong>{tree.length}</strong>
          <span>{isUk ? "Файлів проєкту" : "Project files"}</span>
          <small>{isUk ? "Вихідний код сайту" : "Source code files"}</small>
        </div>
        <div>
          <strong>{events.length}</strong>
          <span>{isUk ? "Подій у стрімі" : "Stream events"}</span>
          <small>{isUk ? (runId ? `Активний run #${runId.slice(0, 6)}` : "Очікування запуску") : (runId ? `Active run #${runId.slice(0, 6)}` : "Idle")}</small>
        </div>
        <div>
          <strong>{changedFiles.length}</strong>
          <span>{isUk ? "Змінених файлів" : "Changed files"}</span>
          <small>{isUk ? "Внесено правки" : "Modified by agent"}</small>
        </div>
        <div>
          <strong>{typeof usage?.usage?.costUsd === "number" ? `$${usage.usage.costUsd.toFixed(4)}` : "$0.00"}</strong>
          <span>{isUk ? "Витрати токенів" : "Token cost"}</span>
          <small>{usage?.usage?.totalTokens ? `${usage.usage.totalTokens} tokens` : (isUk ? "0 токенів" : "0 tokens")}</small>
        </div>
      </section>

      {/* Dismissible Notices */}
      {taskError && (
        <div className="workspace-notice" style={{ marginBottom: 16, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <span>⚠️ {taskError}</span>
          <button
            type="button"
            onClick={() => setTaskError(null)}
            style={{ float: "right", background: "none", border: "none", cursor: "pointer", fontWeight: "bold", color: "#991b1b" }}
          >
            ✕
          </button>
        </div>
      )}
      {stopNotice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          <span>{stopNotice}</span>
          <button
            type="button"
            onClick={() => setStopNotice(null)}
            style={{ float: "right", background: "none", border: "none", cursor: "pointer", fontWeight: "bold" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Controls Bar & Tabs matching EmailSettingsHeaderBlock */}
      <div className="inspector-controls automations-controls" style={{ marginBottom: 20 }}>
        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "workspace"}
            className={`inspector-tab ${activeTab === "workspace" ? "active" : ""}`}
            onClick={() => setActiveTab("workspace")}
          >
            <span>🤖 {isUk ? "Завдання та стрім" : "Task & Stream"}</span>
            {runId && <small className="tab-count">run</small>}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            className={`inspector-tab ${activeTab === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            <span>📁 {isUk ? "Файли та код" : "Files & Code"}</span>
            <small className="tab-count">{tree.length}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "changes"}
            className={`inspector-tab ${activeTab === "changes" ? "active" : ""}`}
            onClick={() => setActiveTab("changes")}
          >
            <span>📝 {isUk ? "Зміни коду" : "Code changes"}</span>
            <small className="tab-count">{changedFiles.length}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "metrics"}
            className={`inspector-tab ${activeTab === "metrics" ? "active" : ""}`}
            onClick={() => setActiveTab("metrics")}
          >
            <span>📊 {isUk ? "Метрики" : "Metrics"}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "all"}
            className={`inspector-tab ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            <span>📋 {isUk ? "Усі панелі" : "All panels"}</span>
          </button>
        </div>
      </div>

      {/* TAB 1: WORKSPACE (AI Task Composer + Agent Stream) */}
      {(activeTab === "workspace" || activeTab === "all") && (
        <>
          {/* Modern AI Task Composer */}
          {asyncInboxEnabled !== true && (
            <form className="code-task-composer" onSubmit={startTask}>
              <div className="composer-header">
                <h2 className="composer-title">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d83438" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  {isUk ? "Завдання для Coding Agent" : "Task for Coding Agent"}
                </h2>
                <div className="composer-options">
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569" }}>
                      {isUk ? "Режим роботи:" : "Permission mode:"}
                    </span>
                    <select
                      value={mode}
                      disabled={modeBusy || taskBusy}
                      onChange={(event) => void applyMode(event.target.value as SessionMode)}
                    >
                      <option value="plan">{isUk ? "Plan (лише планування)" : "Plan (plan only)"}</option>
                      <option value="edit">{isUk ? "Edit (з підтвердженням)" : "Edit (with approval)"}</option>
                      <option value="auto">{isUk ? "Auto (автономний)" : "Auto (autonomous)"}</option>
                      <option value="full_auto">{isUk ? "Full Auto (без обмежень)" : "Full Auto (full autonomous)"}</option>
                    </select>
                  </label>
                </div>
              </div>

              <textarea
                className="composer-textarea"
                value={task}
                onChange={(event) => setTask(event.target.value)}
                disabled={taskBusy}
                rows={3}
                placeholder={
                  isUk
                    ? "Опишіть завдання або зміни: наприклад, «Зміни головний колір кнопок на сайті», «Виправ верстку на сторінці checkout», або «Додай скрипт аналітики»…"
                    : "Describe what needs to be done: e.g., 'Change button styles on the landing page', 'Fix checkout layout', or 'Add a new section'…"
                }
              />

              <div className="composer-footer">
                <div className="code-workspace-usage">
                  {usageError && <span className="ds-hint-error">{usageError}</span>}
                  {!usageError && usage?.status === "ok" && usage.usage && (
                    <span className="ds-muted">
                      {isUk ? "Токени" : "Tokens"}: {usage.usage.totalTokens ?? "—"}
                      {usage.usage.estimated ? ` (${isUk ? "оцінка" : "estimate"})` : ""} ·{" "}
                      {isUk ? "вартість" : "cost"}:{" "}
                      {typeof usage.usage.costUsd === "number" ? `$${usage.usage.costUsd.toFixed(4)}` : "—"}
                    </span>
                  )}
                  {!usageError && (!usage || usage.status !== "ok") && (
                    <span className="ds-muted" style={{ fontSize: "12px" }}>
                      💡 {isUk ? "Агент самостійно знайде потрібний файл, внесе правки та виконає перевірку." : "The agent will locate the files, apply edits, and verify changes."}
                    </span>
                  )}
                </div>

                <div className="composer-actions">
                  <button
                    type="submit"
                    className="button-primary automations-action-primary"
                    disabled={taskBusy || !task.trim()}
                    style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "9px 18px", fontWeight: 700 }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {taskBusy
                      ? isUk ? "Запуск агента…" : "Starting agent…"
                      : isUk ? "Запустити агента" : "Run agent"}
                  </button>

                  <Link
                    className="button-secondary"
                    to="/chat"
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    {isUk ? "Продовжити в чаті" : "Continue in chat"}
                  </Link>

                  {sessionId && (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={stopBusy}
                      onClick={() => void stopRun()}
                      style={{ fontSize: "12.5px", color: "#b91c1c" }}
                      title={isUk ? "Зупинити активний запуск" : "Stop active run"}
                    >
                      {stopBusy ? "…" : isUk ? "Зупинити" : "Stop"}
                    </button>
                  )}
                </div>
              </div>
            </form>
          )}

          {/* Agent Stream Card in workspace tab */}
          {activeTab === "workspace" && (
            <div className="project-col" style={{ borderRadius: 12, border: "1px solid #e2e8f0", background: "#ffffff", boxShadow: "0 1px 4px rgba(0,0,0,0.03)", overflow: "hidden", marginBottom: 20 }}>
              <div className="col-header">
                <h3>
                  <span>⚡</span>
                  {isUk ? "Стрім агента" : "Agent stream"}
                </h3>
                {runId ? (
                  <span className="data-studio-badge info" style={{ fontSize: "11px" }}>
                    run #{runId.slice(0, 6)}
                  </span>
                ) : (
                  <span className="ds-muted" style={{ fontSize: "12px" }}>{isUk ? "Очікування" : "Idle"}</span>
                )}
              </div>

              <div className="project-chat-body" style={{ maxHeight: 480 }}>
                {!runId && (
                  <div className="code-empty-state">
                    <div className="code-empty-state-icon">🤖</div>
                    <h4>{isUk ? "Немає активного запуску" : "No active run"}</h4>
                    <p>
                      {isUk
                        ? "Введіть завдання для Coding Agent у полі вище та натисніть «Запустити агента», щоб спостерігати за його кроками тут."
                        : "Enter a task above and click 'Run agent' to observe its real-time actions here."}
                    </p>
                  </div>
                )}

                {runId && streamError && <p className="ds-hint-error">{streamError}</p>}
                {runId && !streamError && events.length === 0 && (
                  <p className="ds-muted" style={{ textAlign: "center", padding: "20px 0" }}>
                    {isUk ? "Ініціалізація та очікування перших подій…" : "Initializing and waiting for first events…"}
                  </p>
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
                          {event.snapshotId && <span className="data-studio-badge info">snapshot</span>}
                        </button>
                        {isOpen && (
                          <div className="code-stream-body">
                            {eventFacts(event).length === 0 && (
                              <p className="ds-muted">{isUk ? "Лише метадані." : "Metadata only."}</p>
                            )}
                            {eventFacts(event).map(([label, value]) => (
                              <div className="code-detail-row" key={`${key}-${label}`} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12px", padding: "2px 0" }}>
                                <span style={{ color: "#64748b" }}>{label}</span>
                                <code style={{ fontSize: "11.5px", background: "#f1f5f9", padding: "1px 5px", borderRadius: "4px" }}>{value}</code>
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
                    <h4 style={{ margin: "0 0 10px", fontSize: "13.5px", fontWeight: 700, color: "#b45309", display: "flex", alignItems: "center", gap: "6px" }}>
                      ⚠️ {isUk ? "Очікують вашого підтвердження" : "Awaiting your approval"}
                    </h4>
                    {approvalError && <p className="ds-hint-error">{approvalError}</p>}
                    {approvals.map((approval) => (
                      <article className="code-approval-card" key={approval.id}>
                        <header>
                          <code>{approval.toolName ?? "code.shell.exec"}</code>
                          {approval.cwd && <span className="ds-muted" style={{ fontSize: "11.5px" }}> cwd: {approval.cwd}</span>}
                        </header>
                        {approval.command && <pre className="code-approval-body">{approval.command}</pre>}
                        {approval.diff && <pre className="code-approval-body">{approval.diff}</pre>}
                        {approval.reason && <p className="ds-muted" style={{ fontSize: "12px", margin: "6px 0" }}>{approval.reason}</p>}
                        <div className="code-approval-actions">
                          <button type="button" className="button-primary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "once")}>
                            {isUk ? "Одноразово" : "Approve once"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "session")}>
                            {isUk ? "На сесію" : "For session"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px" }} disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "approve", "project")}>
                            {isUk ? "На проєкт" : "For project"}
                          </button>
                          <button type="button" className="button-secondary" style={{ padding: "6px 12px", fontSize: "12px", color: "#dc2626" }} disabled={approvalBusy === approval.id} onClick={() => setDenyOpen((current) => ({ ...current, [approval.id]: !current[approval.id] }))}>
                            {isUk ? "Відхилити" : "Deny"}
                          </button>
                        </div>
                        {denyOpen[approval.id] && (
                          <div className="code-approval-deny">
                            <textarea
                              maxLength={500}
                              value={denyComment[approval.id] ?? ""}
                              placeholder={isUk ? "Причина відхилення (повернеться моделі)" : "Reason for rejection (returned to model)"}
                              onChange={(event) => setDenyComment((current) => ({ ...current, [approval.id]: event.target.value }))}
                              style={{ padding: "8px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px" }}
                            />
                            <button type="button" className="button-secondary" disabled={approvalBusy === approval.id} onClick={() => void decide(approval, "deny", "once")} style={{ alignSelf: "flex-start", fontSize: "12px" }}>
                              {isUk ? "Підтвердити відхилення" : "Confirm deny"}
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* TAB 2: FILES & CODE (2-Column IDE) */}
      {(activeTab === "files" || activeTab === "all") && (
        <div className="project-grid-2col" style={{ display: "grid", gridTemplateColumns: activeTab === "all" ? undefined : "280px 1fr", gap: 16, marginBottom: 20 }}>
          {/* Files column */}
          <section className="project-col project-col-files" aria-label={isUk ? "Файли" : "Files"} style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div className="col-header">
              <h3>
                <span>📁</span>
                {isUk ? "Файли проєкту" : "Project files"}
              </h3>
              <span className="file-count">{tree.length}</span>
            </div>

            <div className="file-search-form">
              <input
                className="file-search-input"
                placeholder={isUk ? "🔍 Фільтр файлів..." : "🔍 Filter files..."}
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
            </div>

            <div className="file-tree-container" style={{ maxHeight: 480 }}>
              {filesError && <p className="ds-hint-error" style={{ padding: "8px 12px" }}>{filesError}</p>}
              {!filesError && filteredTree.length === 0 && (
                <p className="ds-muted" style={{ padding: "16px 12px", textAlign: "center", fontSize: "13px" }}>
                  {tree.length === 0
                    ? isUk ? "Файли ще не завантажено." : "No files loaded yet."
                    : isUk ? "Файлів за фільтром не знайдено." : "No files match the filter."}
                </p>
              )}
              <ul className="code-file-tree">
                {filteredTree.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`code-file-tree-item ${selectedPath === file.path ? "active" : ""}`}
                      style={{ paddingLeft: `${10 + file.depth * 14}px` }}
                      onClick={() => void openFile(file.path)}
                    >
                      <span className="file-icon">{getFileIcon(file.label)}</span>
                      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {file.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* File viewer column */}
          <section className="project-col project-col-preview" aria-label={isUk ? "Файл" : "File"} style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div className="col-header">
              <h3>
                <span>📄</span>
                {selectedPath || (isUk ? "Виберіть файл" : "Select a file")}
              </h3>
              {fileContent !== null && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={copyFileContent}
                  style={{ padding: "4px 10px", fontSize: "11.5px" }}
                  title={isUk ? "Скопіювати код у буфер" : "Copy code to clipboard"}
                >
                  {copied ? (isUk ? "✓ Скопійовано" : "✓ Copied") : (isUk ? "Копіювати" : "Copy")}
                </button>
              )}
            </div>

            <div className="project-file-viewer-body" style={{ minHeight: 420 }}>
              {fileError && <p className="ds-hint-error" style={{ margin: "16px" }}>{fileError}</p>}
              {!fileError && fileContent === null && selectedPath && (
                <div className="code-empty-state" style={{ color: "#94a3b8" }}>
                  <p>{isUk ? "Завантаження вмісту файлу…" : "Loading file content…"}</p>
                </div>
              )}
              {!selectedPath && (
                <div className="code-empty-state" style={{ color: "#94a3b8" }}>
                  <div className="code-empty-state-icon">📄</div>
                  <h4 style={{ color: "#f8fafc" }}>{isUk ? "Файл не вибрано" : "No file selected"}</h4>
                  <p>
                    {isUk
                      ? "Виберіть будь-який файл з лівої колонки, щоб переглянути його повний вміст."
                      : "Select any file from the left column to view its source code."}
                  </p>
                </div>
              )}
              {fileContent !== null && <pre className="project-file-browser-pre" style={{ maxHeight: 480 }}>{fileContent}</pre>}
            </div>

            <div className="project-preview-col-footer">
              <span>🔒 {isUk ? "Режим читання (Read-only)" : "Read-only mode"}</span>
              <span>{isUk ? "Правки вносить AI-агент" : "Edits executed via agent"}</span>
            </div>
          </section>
        </div>
      )}

      {/* TAB 3: CHANGES */}
      {(activeTab === "changes" || activeTab === "all") && (
        <div style={{ marginBottom: 20 }}>
          <CodeWorkspaceBottomTabs
            tab="changes"
            setTab={setTab}
            isUk={isUk}
            sessionId={sessionId}
            runId={runId}
            companyId={companyId}
            changesError={changesError}
            changedFiles={changedFiles}
          />
        </div>
      )}

      {/* TAB 4: METRICS */}
      {(activeTab === "metrics" || activeTab === "all") && (
        <div style={{ marginBottom: 20 }}>
          <CodeMetricsPanel companyId={companyId} />
        </div>
      )}

      {/* Async Workspace Panel if available */}
      {contextReady && sessionId && (
        <AsyncWorkspacePanel
          key={asyncBinding}
          scope={{ companyId, projectId, sessionId }}
          runId={runId}
          isUk={isUk}
          onAvailability={setAsyncInboxEnabled}
          onRun={(nextRun) => selectSession(sessionId, nextRun)}
        />
      )}

      {/* Live Preview if running */}
      {preview?.status === "running" && previewUrl && (
        <div style={{ marginBottom: "20px" }}>
          <button type="button" className="button-secondary" onClick={() => setPreviewOpen((current) => !current)}>
            {previewOpen ? (isUk ? "Закрити preview" : "Close preview") : isUk ? "Відкрити preview сайту" : "Open site preview"}
          </button>
        </div>
      )}

      {previewOpen && previewUrl && (
        <div className="project-preview-frame" style={{ marginBottom: 20 }}>
          <iframe src={previewUrl} title={isUk ? "Live preview" : "Live preview"} sandbox="allow-scripts allow-forms allow-same-origin" />
        </div>
      )}

      {/* Bottom Action Controls */}
      <section className="code-workspace-sessions" style={{ display: "flex", gap: 10, marginTop: 24, paddingTop: 16, borderTop: "1px solid #e2e8f0" }}>
        <button
          type="button"
          className="button-secondary"
          onClick={() => selectSession(sessionId, runId)}
        >
          {isUk ? "Оновити сесію" : "Refresh session"}
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
    </main>
  );
}

export default CodeWorkspacePage;
