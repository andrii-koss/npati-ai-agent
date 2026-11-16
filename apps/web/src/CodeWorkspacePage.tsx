import { isolatedPreviewUrl } from "./preview-origin";
import { CodeWorkspaceHeader } from "./code-workspace/CodeWorkspaceHeader";
import { CodeWorkspaceExecutionPanel } from "./code-workspace/CodeWorkspaceExecutionPanel";
import { CodeWorkspaceFilePanel } from "./code-workspace/CodeWorkspaceFilePanel";
import { approvalDecisionPlan, modeChangeRequest, persistedSessionMode } from "./code-workspace/actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "./i18n";
import { AsyncWorkspacePanel } from "./code-workspace/AsyncWorkspacePanel";
// C14 (owner decision 3): the aggregated metrics of the company this project belongs to. It is a read-only
// panel and it fetches its own report, so the page keeps holding one session-scoped state and the metrics stay
// company-scoped (they are not a property of one session).
import { CodeMetricsPanel } from "./code-workspace/CodeMetricsPanel";
import { listProjectFiles, readProjectFile, writeProjectFile } from "./project-files-client";
import { writeActiveCompanyId } from "./active-company";
import { confirmModal } from "./ConfirmDialog";
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
  type ProjectTerminalRow,
  type MobileView,
  type SessionMode,
  normalizeWorkspaceMode,
  apiGet,
  apiSend,
  safeExternalUrl,
  flattenFiles,
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

  // "Open project terminal" links here with ?tab=terminal; the page opens on that tab instead of Changes.
  const [tab, setTab] = useState<BottomTab>(() => {
    const requested = searchParams.get("tab");
    return requested === "terminal" || requested === "logs" || requested === "activity" || requested === "changes" ? requested : "changes";
  });
  // The project's real commands with their output and exit code (project_terminal_events), shown on the Terminal tab.
  const [terminalEvents, setTerminalEvents] = useState<ProjectTerminalRow[]>([]);
  useEffect(() => {
    if (tab !== "terminal" || !companyId || !projectId) return;
    let active = true;
    const load = () => void apiGet<{ events: ProjectTerminalRow[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/terminal/events`)
      .then((data) => { if (active) setTerminalEvents(data.events ?? []); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tab, companyId, projectId]);
  const [mobileView, setMobileView] = useState<MobileView>("all");
  const [activeTab, setActiveTab] = useState<"all" | "workspace" | "files" | "changes" | "metrics">("all");

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
  const [sessionRevision, setSessionRevision] = useState<number | null>(null);
  const fileRequest = useRef(0);
  const [fileRevision, setFileRevision] = useState<string | undefined>(undefined);

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

  const [isEditingFile, setIsEditingFile] = useState(false);
  const [isFullscreenFile, setIsFullscreenFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const renderFileIcon = (label: string) => {
    const ext = label.split(".").pop()?.toLowerCase() ?? "";
    if (["js", "ts", "jsx", "tsx"].includes(ext)) {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ca8a04" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    }
    if (ext === "html") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    }
    if (ext === "css") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0284c7" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M4 4h16l-2 14-6 2-6-2L4 4z" />
        </svg>
      );
    }
    if (ext === "json") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9333ea" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    }
    if (["png", "jpg", "jpeg", "svg", "webp", "gif", "ico"].includes(ext)) {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    }
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <polyline points="13 2 13 9 20 9" />
      </svg>
    );
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
        mode: persistedSessionMode(mode),
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

  const deleteCurrentSession = async () => {
    if (!sessionId || !companyId || taskBusy) return;
    const agreed = await confirmModal({
      title: isUk ? "Видалити сесію" : "Delete session",
      message: isUk
        ? `Ви дійсно бажаєте видалити сесію #${sessionId.slice(0, 8)}?`
        : `Are you sure you want to delete session #${sessionId.slice(0, 8)}?`,
      isDanger: true,
      confirmText: isUk ? "Видалити" : "Delete",
    });
    if (!agreed) return;

    setTaskBusy(true);
    setTaskError(null);
    try {
      try {
        await apiSend("DELETE", `${codeBase}/sessions/${encodeURIComponent(sessionId)}/data`, { confirm: true });
      } catch {
        await apiSend("POST", `${codeBase}/sessions/${encodeURIComponent(sessionId)}/archive`);
      }
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (remaining.length > 0 && remaining[0]) {
        selectSession(remaining[0].id);
      } else {
        selectSession("");
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
    setSessionRevision(null);
    if (!sessionId) return;
    void apiGet<{ mode: string; status: string; revision: number }>(`${codeBase}/sessions/${encodeURIComponent(sessionId)}`)
      .then(async (session) => {
        if (cancelled) return;
        setMode(normalizeWorkspaceMode(session.mode));
        setSessionRevision(session.revision);
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
          mode: persistedSessionMode(mode),
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
      const requestId = ++fileRequest.current;
      setSelectedPath(path);
      // The open file is part of the address, so a reload shows it again (V6 step 18: the reload closed it).
      setSearchParams((current) => { const next = new URLSearchParams(current); next.set("file", path); return next; }, { replace: true });
      setFileRevision(undefined);
      setSaveSuccess(false);
      setFileContent(null);
      setFileError(null);
      try {
        const data = await readProjectFile({ companyId, projectId }, path);
        if (requestId !== fileRequest.current) return;
        setFileContent(data.content ?? "");
        setFileRevision(data.revision);
        setIsEditingFile(false);
      } catch (cause) {
        if (requestId === fileRequest.current) setFileError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [companyId, projectId, setSearchParams],
  );
  // A file named in the address (after a reload or a shared link) opens once the page starts.
  const initialFile = useRef(searchParams.get("file"));
  useEffect(() => {
    const path = initialFile.current;
    initialFile.current = null;
    if (path) void openFile(path);
  }, [openFile]);

  const saveFile = async () => {
    if (!companyId || !projectId || !selectedPath || fileContent === null || savingFile) return;
    if (!fileRevision) { setFileError("Reload the file before saving: its revision is unavailable."); return; }
    const requestId = fileRequest.current;
    setSavingFile(true);
    setFileError(null);
    try {
      const saved = await writeProjectFile({ companyId, projectId }, selectedPath, fileContent, fileRevision);
      if (requestId !== fileRequest.current) return;
      setFileRevision(saved.revision);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
      void loadFiles();
    } catch (cause) {
      // Another tab or the agent saved this file since it was opened: say so plainly instead of the server's code (V6 step 16).
      const message = cause instanceof Error ? cause.message : String(cause);
      if (requestId === fileRequest.current) setFileError(/revision/i.test(message)
        ? (isUk ? "Файл змінився після відкриття. Ваші зміни не збережено: оновіть файл, щоб не перезаписати нову версію." : "The file changed after you opened it. Your changes were not saved: reload the file so the newer version is not overwritten.")
        : message);
    } finally {
      setSavingFile(false);
    }
  };

  const applyMode = useCallback(
    async (next: SessionMode) => {
      if (!sessionId) { setMode(next); return; }
      setModeBusy(true);
      setModeError(null);
      try {
        if (sessionRevision === null) throw new Error("Reload the session before changing its mode.");
        const request = modeChangeRequest({ companyId, sessionId, mode: next, expectedRevision: sessionRevision });
        const result = await apiSend<{ session: { mode: string; revision: number } }>("PUT", "/api" + request.path, request.body);
        setMode(normalizeWorkspaceMode(result.session.mode));
        setSessionRevision(result.session.revision);
      } catch (cause) {
        setModeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setModeBusy(false);
      }
    },
    [companyId, sessionId, sessionRevision],
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
        const plan = approvalDecisionPlan({ companyId, sessionId, projectId,
          approval: { approvalId: approval.id, action: approval.toolName ?? "code.shell.exec", command: approval.command },
          scope: decision === "deny" ? "deny" : scope, comment });
        if (plan.rule) await apiSend("POST", "/api" + plan.rule.path, plan.rule.body);
        await apiSend("POST", "/api" + plan.decide.path, plan.decide.body);
        setApprovals(current => current.filter(item => item.id !== approval.id));
      } catch (cause) {
        setApprovalError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setApprovalBusy(null);
      }
    },
    [companyId, projectId, sessionId, denyComment],
  );

  const changedFiles = changes?.files ?? changes?.changes ?? [];
  const previewUrl = preview?.url ? safeExternalUrl(preview.url) : null;

  return (
    <main className="goals-container automations-container code-workspace" data-project-id={projectId} style={{ maxWidth: 1180, margin: "0 auto", paddingBottom: 60 }}>
      <CodeWorkspaceHeader isUk={isUk} sessionId={sessionId} runId={runId} selectSession={selectSession} sessions={sessions} deleteCurrentSession={deleteCurrentSession} createNewSession={createNewSession} taskBusy={taskBusy} mode={mode} tree={tree} events={events} changedFiles={changedFiles} usage={usage} />

      {/* Dismissible Notices */}
      {taskError && (
        <div className="workspace-notice" style={{ marginBottom: 16, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <span>{taskError}</span>
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
            aria-selected={activeTab === "all"}
            className={`inspector-tab ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            <span>{isUk ? "Усі панелі" : "All panels"}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "workspace"}
            className={`inspector-tab ${activeTab === "workspace" ? "active" : ""}`}
            onClick={() => setActiveTab("workspace")}
          >
            <span>{isUk ? "Завдання та стрім" : "Task & Stream"}</span>
            {runId && <small className="tab-count">run</small>}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            className={`inspector-tab ${activeTab === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            <span>{isUk ? "Файли та код" : "Files & Code"}</span>
            <small className="tab-count">{tree.length}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "changes"}
            className={`inspector-tab ${activeTab === "changes" ? "active" : ""}`}
            onClick={() => setActiveTab("changes")}
          >
            <span>{isUk ? "Зміни коду" : "Code changes"}</span>
            <small className="tab-count">{changedFiles.length}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "metrics"}
            className={`inspector-tab ${activeTab === "metrics" ? "active" : ""}`}
            onClick={() => setActiveTab("metrics")}
          >
            <span>{isUk ? "Метрики" : "Metrics"}</span>
          </button>
        </div>
      </div>

      <CodeWorkspaceExecutionPanel isUk={isUk} asyncInboxEnabled={asyncInboxEnabled} startTask={startTask} mode={mode} modeError={modeError} modeBusy={modeBusy} taskBusy={taskBusy} applyMode={applyMode} task={task} setTask={setTask} usageError={usageError} usage={usage} sessionId={sessionId} stopBusy={stopBusy} stopRun={stopRun} activeTab={activeTab} runId={runId} streamError={streamError} events={events} expanded={expanded} setExpanded={setExpanded} approvals={approvals} approvalError={approvalError} approvalBusy={approvalBusy} decide={decide} denyOpen={denyOpen} setDenyOpen={setDenyOpen} denyComment={denyComment} setDenyComment={setDenyComment} />

      <CodeWorkspaceFilePanel isUk={isUk} activeTab={activeTab} tree={tree} filteredTree={filteredTree} filesError={filesError} fileFilter={fileFilter} setFileFilter={setFileFilter} selectedPath={selectedPath} openFile={openFile} renderFileIcon={renderFileIcon} isFullscreenFile={isFullscreenFile} setIsFullscreenFile={setIsFullscreenFile} fileContent={fileContent} isEditingFile={isEditingFile} setIsEditingFile={setIsEditingFile} savingFile={savingFile} saveFile={saveFile} copied={copied} copyFileContent={copyFileContent} fileError={fileError} setFileContent={setFileContent} saveSuccess={saveSuccess} />

      {/* TAB 3: CHANGES */}
      {(activeTab === "changes" || activeTab === "all") && (
        <div style={{ marginBottom: 20 }}>
          <CodeWorkspaceBottomTabs
            tab={tab}
            setTab={setTab}
            isUk={isUk}
            sessionId={sessionId}
            runId={runId}
            companyId={companyId}
            changesError={changesError}
            changedFiles={changedFiles}
            events={events}
            terminalEvents={terminalEvents}
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
          <iframe src={isolatedPreviewUrl(previewUrl)} title={isUk ? "Live preview" : "Live preview"} sandbox="allow-scripts allow-forms allow-same-origin" />
        </div>
      )}
    </main>
  );
}

export default CodeWorkspacePage;
