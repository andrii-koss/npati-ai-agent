import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { Project } from "./ProjectSection";

type FileEntry = { path: string; name: string; type: "file" | "directory"; size?: number; revision?: string };
type FileContent = { path: string; content: string; size: number; revision: string };
type TerminalEvent = { id: string; commandSummary: string; riskLevel: string; status: string; output: string; errorCode?: string; createdAt: string };
type BottomTab = "changes" | "terminal" | "logs" | "activity";
type DeviceMode = "desktop" | "tablet" | "mobile";
type MobileView = "all" | "files" | "chat" | "preview" | "bottom";

interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
  oldSize?: number;
  newSize?: number;
}

interface ChangesResult {
  summary: { added: number; modified: number; deleted: number; total: number };
  changes: FileChange[];
}

interface PreviewStatusResponse {
  status: string;
  previewUrl?: string | null;
  port?: number | null;
  framework?: string | null;
  lastBuildStatus?: string | null;
  isRunning: boolean;
  error: string | null;
  restartCount: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

interface ProjectRunItem {
  id: string;
  task: string;
  status: string;
  result?: string;
  errorMessage?: string;
  createdAt: string;
}

function authHeaders() {
  const value = new Headers();
  const token = getStoredAuthToken();
  if (token) value.set("Authorization", "Bearer " + token);
  return value;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try { const data = await response.json(); if (data?.error?.message) msg = data.error.message; } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try { const data = await response.json(); if (data?.error?.message) msg = data.error.message; } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

export function ProjectPage() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();

  const [project, setProject] = useState<Project>();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");

  const [bottomTab, setBottomTab] = useState<BottomTab>("changes");
  const [mobileView, setMobileView] = useState<MobileView>("all");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");

  const [previewStatus, setPreviewStatus] = useState<PreviewStatusResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  const [changes, setChanges] = useState<ChangesResult>({ summary: { added: 0, modified: 0, deleted: 0, total: 0 }, changes: [] });
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);

  const [terminalEvents, setTerminalEvents] = useState<TerminalEvent[]>([]);
  const [logs, setLogs] = useState("");
  const [sandboxState, setSandboxState] = useState("unavailable");

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const [projectRuns, setProjectRuns] = useState<ProjectRunItem[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

  const [error, setError] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

  // Load runs for activity tab
  const loadProjectRuns = async () => {
    setLoadingRuns(true);
    try {
      const data = await apiGet<{ runs: ProjectRunItem[] }>(`${base}/runs`);
      setProjectRuns(data.runs || []);
    } catch {
      // ignore
    } finally {
      setLoadingRuns(false);
    }
  };

  // Load project initial state & files
  const refreshProject = async () => {
    try {
      const [proj, tree, chg, pStatus] = await Promise.all([
        apiGet<Project>(base),
        apiGet<{ files: FileEntry[] }>(`${base}/files/tree`),
        apiGet<ChangesResult>(`${base}/changes`).catch(() => ({ summary: { added: 0, modified: 0, deleted: 0, total: 0 }, changes: [] })),
        apiGet<PreviewStatusResponse>(`${base}/preview/status`).catch(() => null),
      ]);
      setProject(proj);
      setFiles(tree.files);
      setChanges(chg);
      if (pStatus) setPreviewStatus(pStatus);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project unavailable");
    }
  };

  useEffect(() => {
    void refreshProject();
  }, [base]);

  // Terminal & Logs refresher
  const refreshTerminalAndLogs = async () => {
    try {
      const [history, runtime] = await Promise.all([
        apiGet<{ events: TerminalEvent[] }>(`${base}/terminal/events`),
        apiGet<{ logs: string; status: { state: string } | null }>(`${base}/terminal/logs`),
      ]);
      setTerminalEvents(history.events);
      setLogs(runtime.logs);
      setSandboxState(runtime.status?.state ?? "not started");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Terminal info unavailable");
    }
  };

  useEffect(() => {
    if (bottomTab === "terminal" || bottomTab === "logs") {
      void refreshTerminalAndLogs();
    } else if (bottomTab === "changes") {
      apiGet<ChangesResult>(`${base}/changes`).then(setChanges).catch(() => {});
    } else if (bottomTab === "activity") {
      void loadProjectRuns();
    }
  }, [bottomTab, base]);

  // Preview Start
  const handleStartPreview = async () => {
    setPreviewLoading(true);
    setError("");
    try {
      const result = await apiPost<{ status: string; previewUrl: string; token: string; port: number; framework: string }>(`${base}/preview/start`, {});
      setPreviewStatus({
        status: "previewing",
        previewUrl: result.previewUrl,
        port: result.port,
        framework: result.framework,
        isRunning: true,
        error: null,
        restartCount: 0,
      });
      setIframeKey((k) => k + 1);
      await refreshProject();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  // Preview Stop
  const handleStopPreview = async () => {
    setPreviewLoading(true);
    setError("");
    try {
      await apiPost(`${base}/preview/stop`, {});
      setPreviewStatus((prev) => prev ? { ...prev, isRunning: false, status: "ready" } : null);
      await refreshProject();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to stop preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  // File open & search
  const openFile = async (filePath: string) => {
    try {
      setError("");
      const content = await apiGet<FileContent>(`${base}/files/read?path=${encodeURIComponent(filePath)}`);
      setSelectedFile(content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to open file");
    }
  };

  const handleFileSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError("");
      const url = fileSearchQuery.trim()
        ? `${base}/files/search?query=${encodeURIComponent(fileSearchQuery.trim())}`
        : `${base}/files/tree`;
      const result = await apiGet<{ files: FileEntry[] }>(url);
      setFiles(result.files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search unavailable");
    }
  };

  // Snapshot Baseline
  const handleSnapshotBaseline = async () => {
    try {
      await apiPost(`${base}/changes/baseline`);
      const updated = await apiGet<ChangesResult>(`${base}/changes`);
      setChanges(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to snapshot baseline");
    }
  };

  // Chat / Agent Run
  const handleSendPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const task = chatInput.trim();
    if (!task || chatBusy) return;

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      role: "user",
      content: task,
      timestamp: new Date().toLocaleTimeString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setChatBusy(true);

    try {
      const run = await apiPost<{ run: { id: string } }>(`/api/companies/${encodeURIComponent(companyId)}/runs`, {
        task,
        projectId,
        mode: "auto",
      });

      // Poll run status
      const pollInterval = setInterval(async () => {
        try {
          const runStatus = await apiGet<{ run: { status: string; result?: string; errorMessage?: string } }>(
            `/api/companies/${encodeURIComponent(companyId)}/runs/${run.run.id}`,
          );
          if (runStatus.run.status === "completed" || runStatus.run.status === "failed") {
            clearInterval(pollInterval);
            setChatBusy(false);
            const assistantMsg: ChatMessage = {
              id: String(Date.now()),
              role: "assistant",
              content: runStatus.run.result || runStatus.run.errorMessage || "Completed task.",
              timestamp: new Date().toLocaleTimeString(),
            };
            setChatMessages((prev) => [...prev, assistantMsg]);
            void refreshProject();
            void refreshTerminalAndLogs();
            void loadProjectRuns();
          }
        } catch {
          clearInterval(pollInterval);
          setChatBusy(false);
        }
      }, 1500);
    } catch (cause) {
      setChatBusy(false);
      const errMsg: ChatMessage = {
        id: String(Date.now()),
        role: "system",
        content: cause instanceof Error ? cause.message : "Error executing run",
        timestamp: new Date().toLocaleTimeString(),
      };
      setChatMessages((prev) => [...prev, errMsg]);
    }
  };

  useEffect(() => {
    chatScrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatBusy]);

  const selectedDiff = changes.changes.find((c) => c.path === selectedDiffPath) ?? changes.changes[0];

  const deviceWidthStyle =
    deviceMode === "mobile" ? { width: "375px", height: "667px" }
    : deviceMode === "tablet" ? { width: "768px", height: "1024px" }
    : { width: "100%", height: "100%" };

  return (
    <main className="company-page project-page-modern">
      {/* Top Navigation & Header */}
      <div className="project-topbar">
        <Link to={`/settings/company?company=${encodeURIComponent(companyId)}`} className="project-back-link">
          {language === "uk" ? "← До компанії" : "← Back to Company"}
        </Link>
        {project && (
          <div className="project-header-badges">
            <span className={`project-status-pill ${project.status}`}>{project.status}</span>
            <span className="project-branch-pill">🌿 {project.repositoryBranch || "main"}</span>
            {project.framework && <span className="project-framework-pill">⚡ {project.framework}</span>}
            <span className={`project-build-pill ${project.lastBuildStatus || "ready"}`}>
              {project.lastBuildStatus ? `Build: ${project.lastBuildStatus}` : "Ready"}
            </span>
          </div>
        )}
      </div>

      {project ? (
        <header className="project-header">
          <div className="project-title-area">
            <h1>{project.name}</h1>
            {project.description && <p className="project-desc">{project.description}</p>}
          </div>

          <div className="project-header-actions">
            {previewStatus?.isRunning ? (
              <button
                type="button"
                className="button-secondary project-stop-btn"
                onClick={() => void handleStopPreview()}
                disabled={previewLoading}
              >
                {previewLoading ? "Stopping…" : language === "uk" ? "Зупинити Preview" : "Stop Preview"}
              </button>
            ) : (
              <button
                type="button"
                className="button-primary project-start-btn"
                onClick={() => void handleStartPreview()}
                disabled={previewLoading}
              >
                {previewLoading ? "Starting…" : language === "uk" ? "▶ Запустити Preview" : "▶ Start Preview"}
              </button>
            )}

            {previewStatus?.previewUrl && (
              <a
                href={previewStatus.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="button-secondary project-ext-btn"
                title="Open preview in new tab"
              >
                ↗ {language === "uk" ? "Нова вкладка" : "New Tab"}
              </a>
            )}

            <button
              type="button"
              className="button-secondary"
              onClick={() => void refreshProject()}
              title="Refresh project state"
            >
              🔄
            </button>
          </div>
        </header>
      ) : !error ? (
        <p>{language === "uk" ? "Завантаження проєкту…" : "Loading project…"}</p>
      ) : null}

      {error && <p className="project-error-banner" role="alert">{error}</p>}

      {/* Mobile view selector */}
      <div className="project-mobile-tabs" role="tablist" aria-label="Mobile view switcher">
        {(["all", "files", "chat", "preview", "bottom"] as const).map((view) => (
          <button
            key={view}
            type="button"
            className={mobileView === view ? "active" : ""}
            onClick={() => setMobileView(view)}
          >
            {view === "all" ? "All" : view === "files" ? "Files" : view === "chat" ? "Agent Chat" : view === "preview" ? "Preview" : "Details"}
          </button>
        ))}
      </div>

      {project && (
        <>
          {/* Main 3-Column Working Grid */}
          <section className={`project-grid ${mobileView !== "all" ? `mobile-focus-${mobileView}` : ""}`}>
            {/* Column 1: Files */}
            <aside className="project-col project-col-files" aria-label="Project files">
              <div className="col-header">
                <h3>{language === "uk" ? "Файли" : "Files"}</h3>
                <span className="file-count">{files.length}</span>
              </div>

              <form onSubmit={handleFileSearch} className="file-search-form">
                <input
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  placeholder={language === "uk" ? "Шукати файл…" : "Search files…"}
                  className="file-search-input"
                />
              </form>

              <div className="file-tree-container">
                {files.length === 0 ? (
                  <p className="no-files-hint">{language === "uk" ? "Файлів ще немає" : "No files yet"}</p>
                ) : (
                  files.map((entry) => (
                    <div key={entry.path} className="file-tree-row">
                      {entry.type === "file" ? (
                        <button
                          type="button"
                          className={`file-row-btn ${selectedFile?.path === entry.path ? "active" : ""}`}
                          onClick={() => void openFile(entry.path)}
                          style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length * 12, 120)}px` }}
                        >
                          📄 {entry.name}
                        </button>
                      ) : (
                        <div
                          className="dir-row"
                          style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length * 12, 120)}px` }}
                        >
                          📁 {entry.name}/
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {selectedFile && (
                <div className="file-quick-viewer">
                  <div className="quick-viewer-header">
                    <span>{selectedFile.path}</span>
                    <button type="button" onClick={() => setSelectedFile(null)}>✕</button>
                  </div>
                  <pre><code>{selectedFile.content}</code></pre>
                </div>
              )}
            </aside>

            {/* Column 2: Chat & Agent Activity */}
            <section className="project-col project-col-chat" aria-label="Agent chat">
              <div className="col-header">
                <h3>{language === "uk" ? "Чат з Агентом" : "Developer Agent"}</h3>
                {chatBusy && <span className="agent-typing-pill">🤖 Working…</span>}
              </div>

              <div className="project-chat-messages">
                {chatMessages.length === 0 ? (
                  <div className="chat-empty-state">
                    <p>💡 {language === "uk" ? "Введіть запит для генерації або редагування сайту:" : "Prompt your Developer Agent to create or update the website:"}</p>
                    <button
                      type="button"
                      className="button-secondary sample-prompt-btn"
                      onClick={() => setChatInput("Create a simple landing page with modern hero section, features grid and contact footer")}
                    >
                      "Create a simple landing page"
                    </button>
                  </div>
                ) : (
                  chatMessages.map((msg) => (
                    <div key={msg.id} className={`chat-bubble chat-bubble-${msg.role}`}>
                      <div className="bubble-header">
                        <strong>{msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}</strong>
                        <span className="bubble-time">{msg.timestamp}</span>
                      </div>
                      <div className="bubble-content">{msg.content}</div>
                    </div>
                  ))
                )}
                {chatBusy && (
                  <div className="chat-bubble chat-bubble-assistant working-bubble">
                    <p>⏳ {language === "uk" ? "Агент виконує зміни у sandbox..." : "Agent is updating files & building sandbox..."}</p>
                  </div>
                )}
                <div ref={chatScrollRef} />
              </div>

              <form onSubmit={handleSendPrompt} className="project-chat-form">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={language === "uk" ? "Опишіть завдання (наприклад: Додай навігацію та кнопку CTA)..." : "Describe changes or ask the agent to build..."}
                  rows={3}
                  disabled={chatBusy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendPrompt(e);
                    }
                  }}
                />
                <button type="submit" className="button-primary send-chat-btn" disabled={chatBusy || !chatInput.trim()}>
                  {language === "uk" ? "Надіслати" : "Send"}
                </button>
              </form>
            </section>

            {/* Column 3: Live Preview */}
            <section className="project-col project-col-preview" aria-label="Live Preview">
              <div className="col-header preview-col-header">
                <h3>{language === "uk" ? "Live Preview" : "Live Preview"}</h3>
                <div className="device-mode-toggles">
                  <button
                    type="button"
                    className={`device-btn ${deviceMode === "desktop" ? "active" : ""}`}
                    onClick={() => setDeviceMode("desktop")}
                    title="Desktop (100%)"
                  >
                    🖥️
                  </button>
                  <button
                    type="button"
                    className={`device-btn ${deviceMode === "tablet" ? "active" : ""}`}
                    onClick={() => setDeviceMode("tablet")}
                    title="Tablet (768px)"
                  >
                    📱 Tab
                  </button>
                  <button
                    type="button"
                    className={`device-btn ${deviceMode === "mobile" ? "active" : ""}`}
                    onClick={() => setDeviceMode("mobile")}
                    title="Mobile (375px)"
                  >
                    📱 Mobile
                  </button>
                  <button
                    type="button"
                    className="reload-iframe-btn"
                    onClick={() => setIframeKey((k) => k + 1)}
                    title="Reload Preview iframe"
                  >
                    🔄
                  </button>
                </div>
              </div>

              <div className="preview-viewport-wrapper">
                {previewStatus?.error ? (
                  <div className="preview-error-card">
                    <h4>⚠️ {language === "uk" ? "Помилка dev server" : "Dev Server / Build Error"}</h4>
                    <p>{previewStatus.error}</p>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void handleStartPreview()}
                    >
                      {language === "uk" ? "Спробувати знову" : "Retry Server"}
                    </button>
                  </div>
                ) : previewStatus?.isRunning && previewStatus?.previewUrl ? (
                  <div className="device-screen-container" style={deviceWidthStyle}>
                    <iframe
                      key={iframeKey}
                      src={previewStatus.previewUrl}
                      title="Website Preview"
                      className="preview-iframe"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    />
                  </div>
                ) : (
                  <div className="preview-placeholder">
                    <div className="placeholder-content">
                      <span className="placeholder-icon">🌐</span>
                      <h4>{language === "uk" ? "Preview не запущено" : "Preview is not running"}</h4>
                      <p>
                        {language === "uk"
                          ? "Натисніть «Запустити Preview» угорі або попросіть агента створити сайт."
                          : 'Click "Start Preview" above or prompt the agent to build the landing page.'}
                      </p>
                      <button
                        type="button"
                        className="button-primary"
                        onClick={() => void handleStartPreview()}
                        disabled={previewLoading}
                      >
                        {language === "uk" ? "▶ Запустити зараз" : "▶ Start Preview"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </section>

          {/* Bottom Tabs Panel: Changes, Terminal, Logs, Activity */}
          <section className="project-bottom-drawer" aria-label="Inspection drawer">
            <div className="bottom-tabs-nav" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "changes"}
                onClick={() => setBottomTab("changes")}
                className={bottomTab === "changes" ? "active" : ""}
              >
                {language === "uk" ? "Зміни (Changes)" : "Changes"}
                {changes.summary.total > 0 && <span className="tab-badge">{changes.summary.total}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "terminal"}
                onClick={() => setBottomTab("terminal")}
                className={bottomTab === "terminal" ? "active" : ""}
              >
                Terminal
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "logs"}
                onClick={() => setBottomTab("logs")}
                className={bottomTab === "logs" ? "active" : ""}
              >
                Logs
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "activity"}
                onClick={() => setBottomTab("activity")}
                className={bottomTab === "activity" ? "active" : ""}
              >
                Activity
              </button>
            </div>

            <div className="bottom-tab-content">
              {bottomTab === "changes" && (
                <div className="changes-tab-pane">
                  <div className="changes-summary-bar">
                    <span className="badge-added">+{changes.summary.added} added</span>
                    <span className="badge-modified">~{changes.summary.modified} modified</span>
                    <span className="badge-deleted">-{changes.summary.deleted} deleted</span>
                    <button
                      type="button"
                      className="button-secondary baseline-btn"
                      onClick={() => void handleSnapshotBaseline()}
                      title="Set current files as new baseline"
                    >
                      {language === "uk" ? "Зафіксувати стан як базовий" : "Snapshot Baseline"}
                    </button>
                  </div>

                  <div className="changes-diff-layout">
                    <div className="changes-file-list">
                      {changes.changes.length === 0 ? (
                        <p className="no-changes-hint">{language === "uk" ? "Змін відносно базового стану немає" : "No changes detected relative to baseline"}</p>
                      ) : (
                        changes.changes.map((item) => (
                          <button
                            key={item.path}
                            type="button"
                            className={`change-file-item ${selectedDiff?.path === item.path ? "active" : ""}`}
                            onClick={() => setSelectedDiffPath(item.path)}
                          >
                            <span className={`status-tag status-${item.status}`}>{(item.status[0] ?? "").toUpperCase()}</span>
                            <span className="change-path">{item.path}</span>
                          </button>
                        ))
                      )}
                    </div>

                    <div className="changes-diff-viewer">
                      {selectedDiff ? (
                        <div className="diff-card">
                          <div className="diff-header">
                            <strong>{selectedDiff.path}</strong>
                            <span className={`diff-status-label ${selectedDiff.status}`}>{selectedDiff.status}</span>
                          </div>
                          <pre className="diff-pre">
                            <code>
                              {selectedDiff.diff.split("\n").map((line, idx) => (
                                <span
                                  key={idx}
                                  className={
                                    line.startsWith("+") && !line.startsWith("+++")
                                      ? "diff-line-add"
                                      : line.startsWith("-") && !line.startsWith("---")
                                      ? "diff-line-del"
                                      : line.startsWith("@@")
                                      ? "diff-line-hdr"
                                      : "diff-line"
                                  }
                                >
                                  {line + "\n"}
                                </span>
                              ))}
                            </code>
                          </pre>
                        </div>
                      ) : (
                        <p className="no-diff-selected">{language === "uk" ? "Виберіть змінений файл для перегляду diff" : "Select a modified file to view diff"}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {bottomTab === "terminal" && (
                <div className="terminal-tab-pane">
                  <div className="terminal-status-row">
                    <span>Sandbox State: <strong>{sandboxState}</strong></span>
                    <button type="button" className="button-secondary" onClick={() => void refreshTerminalAndLogs()}>
                      Refresh
                    </button>
                  </div>
                  {terminalEvents.length === 0 ? (
                    <p className="empty-terminal-hint">No agent commands recorded yet.</p>
                  ) : (
                    terminalEvents.map((evt) => (
                      <article key={evt.id} className="terminal-event-card">
                        <div className="event-meta">
                          <code>{evt.commandSummary}</code>
                          <span>{evt.status} · {new Date(evt.createdAt).toLocaleTimeString()}</span>
                        </div>
                        {evt.output && <pre><code>{evt.output}</code></pre>}
                      </article>
                    ))
                  )}
                </div>
              )}

              {bottomTab === "logs" && (
                <div className="logs-tab-pane">
                  <div className="logs-toolbar">
                    <button type="button" className="button-secondary" onClick={() => void refreshTerminalAndLogs()}>
                      Refresh Logs
                    </button>
                  </div>
                  <pre className="raw-logs-pre"><code>{logs || "No logs available yet."}</code></pre>
                </div>
              )}

              {bottomTab === "activity" && (
                <div className="activity-tab-pane">
                  <div className="activity-tab-toolbar">
                    <p className="activity-hint">{language === "uk" ? "Історія запусків та активності для цього проєкту" : "Agent runs & activity history for this project"}</p>
                    <button type="button" className="button-secondary" onClick={() => void loadProjectRuns()} disabled={loadingRuns}>
                      {language === "uk" ? "Оновити" : "Refresh"}
                    </button>
                  </div>
                  {projectRuns.length === 0 ? (
                    <div className="empty-runs-state">
                      <p>{language === "uk" ? "Запусків для цього проєкту ще не зафіксовано." : "No runs recorded for this project yet."}</p>
                    </div>
                  ) : (
                    <div className="project-runs-list">
                      {projectRuns.map((r) => (
                        <article key={r.id} className="project-run-card">
                          <div className="run-card-header">
                            <span className={`status-pill status-${r.status}`}>{r.status}</span>
                            <span className="run-card-time">{new Date(r.createdAt).toLocaleString()}</span>
                            <Link to={`/activity?runId=${r.id}`} className="button-secondary view-run-btn">
                              {language === "uk" ? "Переглянути Run →" : "View Run →"}
                            </Link>
                          </div>
                          <p className="run-task-text">{r.task}</p>
                          {r.result && <p className="run-result-text">✓ {r.result.slice(0, 180)}...</p>}
                          {r.errorMessage && <p className="run-error-text">⚠️ {r.errorMessage}</p>}
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
