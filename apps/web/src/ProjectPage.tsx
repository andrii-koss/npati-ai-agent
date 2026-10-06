import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import { listProjectFiles, readProjectFile, searchProjectFiles } from "./project-files-client";
import type { Project } from "./ProjectSection";

type FileEntry = { path: string; name: string; type: "file" | "directory"; size?: number; revision?: string };
type FileContent = { path: string; content: string; size: number; revision: string };
type TerminalEvent = { id: string; commandSummary: string; riskLevel: string; status: string; output: string; errorCode?: string; createdAt: string };
type BottomTab = "changes" | "terminal" | "checkpoints" | "deployments" | "qa" | "logs" | "activity";
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

interface CheckpointItem {
  id: string;
  name: string;
  description?: string;
  commitHash?: string;
  trigger: "manual" | "pre_run" | "post_run" | "pre_restore";
  fileCount: number;
  createdAt: string;
}

interface DeploymentItem {
  id: string;
  provider: string;
  environment: string;
  status: string;
  targetUrl?: string;
  commitHash?: string;
  branch?: string;
  errorMessage?: string;
  deployedAt?: string;
  createdAt: string;
}

interface PreflightInfo {
  environment: string;
  branch: string;
  target: string;
  buildStatus: string;
  filesChanged: { staged: number; unstaged: number; untracked: number; total: number };
  tests: { executed: boolean; status: string; passed?: number; failed?: number };
  readyToDeploy: boolean;
  blockers: string[];
}

interface ProjectRunItem {
  id: string;
  task: string;
  status: string;
  result?: string;
  errorMessage?: string;
  createdAt: string;
  tasks?: Array<{ id: string; title: string; role: string; agentId: string; dependsOn: string[]; status: string }>;
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

  const [importUrl, setImportUrl] = useState("");
  const [importBranch, setImportBranch] = useState("main");
  const [importCredentialId, setImportCredentialId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [projectRuns, setProjectRuns] = useState<ProjectRunItem[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [newCheckpointName, setNewCheckpointName] = useState("");
  const [isCreatingCheckpoint, setIsCreatingCheckpoint] = useState(false);
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null);
  const [checkpointFeedback, setCheckpointFeedback] = useState<string | null>(null);

  const loadCheckpoints = async () => {
    if (!base) return;
    setLoadingCheckpoints(true);
    try {
      const data = await apiGet<{ checkpoints: CheckpointItem[] }>(`${base}/checkpoints`);
      setCheckpoints(data.checkpoints ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  const handleCreateCheckpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!base || !newCheckpointName.trim()) return;
    try {
      await apiPost(`${base}/checkpoints`, { name: newCheckpointName.trim() });
      setNewCheckpointName("");
      setIsCreatingCheckpoint(false);
      setCheckpointFeedback(language === "uk" ? "Точку відновлення успішно створено!" : "Checkpoint created successfully!");
      setTimeout(() => setCheckpointFeedback(null), 4000);
      await loadCheckpoints();
    } catch (err: any) {
      alert(err.message || "Failed to create checkpoint");
    }
  };

  const handleRestoreCheckpoint = async (checkpoint: CheckpointItem) => {
    if (!base) return;
    const confirmMessage = language === "uk"
      ? `Відновити стан проєкту до "${checkpoint.name}"?\n\nБезпека: NPATI автоматично створить резервну точку (авто-бекап) перед відкатом.`
      : `Restore project to "${checkpoint.name}"?\n\nSafety: NPATI will automatically create a pre-restore backup checkpoint before rolling back.`;
    if (!window.confirm(confirmMessage)) return;

    setRestoringCheckpointId(checkpoint.id);
    try {
      await apiPost(`${base}/checkpoints/${checkpoint.id}/restore`, { approved: true });
      setCheckpointFeedback(language === "uk" ? `Успішно відновлено до "${checkpoint.name}"!` : `Successfully restored to "${checkpoint.name}"!`);
      setTimeout(() => setCheckpointFeedback(null), 5000);
      await refreshProject();
      await loadCheckpoints();
    } catch (err: any) {
      alert(err.message || "Failed to restore checkpoint");
    } finally {
      setRestoringCheckpointId(null);
    }
  };

  const [loadingRuns, setLoadingRuns] = useState(false);

  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [loadingDeployments, setLoadingDeployments] = useState(false);
  const [preflightData, setPreflightData] = useState<PreflightInfo | null>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [deployCredentialId, setDeployCredentialId] = useState("");
  const [deployEnvironment, setDeployEnvironment] = useState<"production" | "staging">("production");
  const [deploying, setDeploying] = useState(false);
  const [deployFeedback, setDeployFeedback] = useState<string | null>(null);

  const [qaReports, setQaReports] = useState<any[]>([]);
  const [activeQaReport, setActiveQaReport] = useState<any | null>(null);
  const [loadingQa, setLoadingQa] = useState(false);
  const [runningQa, setRunningQa] = useState(false);
  const [qaPath, setQaPath] = useState("/");
  const [qaViewport, setQaViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [qaIssueFilter, setQaIssueFilter] = useState<string>("all");
  const [qaFeedback, setQaFeedback] = useState<string | null>(null);

  const [error, setError] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

  const loadDeployments = async () => {
    if (!base) return;
    setLoadingDeployments(true);
    try {
      const data = await apiGet<{ deployments: DeploymentItem[] }>(`${base}/deployments`);
      setDeployments(data.deployments ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingDeployments(false);
    }
  };

  const handleRunPreflight = async () => {
    if (!base) return;
    setLoadingPreflight(true);
    setDeployFeedback(null);
    try {
      const data = await apiPost<{ preflight: PreflightInfo }>(`${base}/deployments/preflight`, {
        provider: "dokploy",
        environment: deployEnvironment,
      });
      setPreflightData(data.preflight);
    } catch (err: any) {
      setDeployFeedback(`Preflight error: ${err.message || err}`);
    } finally {
      setLoadingPreflight(false);
    }
  };

  const handleTriggerDeploy = async () => {
    if (!base) return;
    if (!deployCredentialId.trim()) {
      alert(language === "uk" ? "Вкажіть ID облікового запису (credentialId) із Company Vault для Dokploy!" : "Please specify Dokploy vault credential ID!");
      return;
    }
    setDeploying(true);
    setDeployFeedback(null);
    try {
      const data = await apiPost<{ deployment: DeploymentItem; approvalRequired?: boolean; previewUrl?: string }>(`${base}/deployments`, {
        provider: "dokploy",
        environment: deployEnvironment,
        credentialId: deployCredentialId.trim(),
      });
      setDeployFeedback(language === "uk" ? `Деплой успішно виконано! URL: ${data.previewUrl || data.deployment.targetUrl}` : `Deployment successful! URL: ${data.previewUrl || data.deployment.targetUrl}`);
      await refreshProject();
      await loadDeployments();
    } catch (err: any) {
      setDeployFeedback(`Deploy error: ${err.message || err}`);
    } finally {
      setDeploying(false);
    }
  };

  const loadQaReports = async () => {
    if (!base) return;
    setLoadingQa(true);
    try {
      const data = await apiGet<{ reports: any[] }>(`${base}/qa/reports`);
      setQaReports(data.reports ?? []);
      if (data.reports?.length > 0 && !activeQaReport) {
        const detail = await apiGet<{ report: any }>(`${base}/qa/reports/${encodeURIComponent(data.reports[0].id)}`);
        setActiveQaReport(detail.report);
      }
    } catch {
      // ignore
    } finally {
      setLoadingQa(false);
    }
  };

  const openQaReport = async (reportId: string) => {
    try {
      const data = await apiGet<{ report: any }>(`${base}/qa/reports/${encodeURIComponent(reportId)}`);
      setActiveQaReport(data.report);
      setQaFeedback(null);
    } catch (err: any) {
      setQaFeedback(err.message || String(err));
    }
  };
  const handleRunQa = async () => {
    if (!base) return;
    setRunningQa(true);
    setQaFeedback(null);
    try {
      const data = await apiPost<any>(`${base}/qa/inspect`, {
        path: qaPath,
        viewport: qaViewport,
      });
      setActiveQaReport(data.report);
      setQaReports((prev) => [data.report, ...prev]);
      setQaFeedback(
        language === "uk"
          ? `Browser QA успішно виконано (статус: ${data.report.status.toUpperCase()})`
          : `Browser QA completed (status: ${data.report.status.toUpperCase()})`
      );
      setTimeout(() => setQaFeedback(null), 5000);
    } catch (err: any) {
      setQaFeedback(`Browser QA Error: ${err.message || err}`);
    } finally {
      setRunningQa(false);
    }
  };

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
        // Shared adapter (C7): the tree comes from the same client module the code workspace uses.
        listProjectFiles({ companyId, projectId }),
        apiGet<ChangesResult>(`${base}/changes`).catch(() => ({ summary: { added: 0, modified: 0, deleted: 0, total: 0 }, changes: [] })),
        apiGet<PreviewStatusResponse>(`${base}/preview/status`).catch(() => null),
      ]);
      setProject(proj);
      setFiles(tree.files as FileEntry[]);
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
    } else if (bottomTab === "checkpoints") {
      void loadCheckpoints();
    } else if (bottomTab === "deployments") {
      void loadDeployments();
    } else if (bottomTab === "qa") {
      void loadQaReports();
    } else if (bottomTab === "activity") {
      void loadProjectRuns();
      const timer = setInterval(() => { void loadProjectRuns(); }, 3000);
      return () => clearInterval(timer);
    }
  }, [bottomTab, base]);

  const finishImport = async () => {
    await refreshProject();
    await loadProjectRuns();
    setImportUrl("");
    setImportFile(null);
  };

  const handleRepositoryImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!importUrl.trim() || importing) return;
    setImporting(true);
    setError("");
    try {
      await apiPost(`${base}/import/repository`, {
        url: importUrl.trim(),
        branch: importBranch.trim() || "main",
        credentialId: importCredentialId.trim() || undefined,
      });
      await finishImport();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Repository import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleZipImport = async () => {
    if (!importFile || importing) return;
    if (importFile.size > 10 * 1024 * 1024) {
      setError("ZIP upload must be 10 MB or less");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read ZIP file"));
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.readAsDataURL(importFile);
      });
      await apiPost(`${base}/import/zip`, { filename: importFile.name, contentBase64 });
      await finishImport();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ZIP import failed");
    } finally {
      setImporting(false);
    }
  };

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
      // Shared adapter (C7): one implementation of the project file read for every page.
      const content = await readProjectFile({ companyId, projectId }, filePath);
      setSelectedFile(content as FileContent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to open file");
    }
  };

  const handleFileSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError("");
      const query = fileSearchQuery.trim();
      const files = query
        ? await searchProjectFiles({ companyId, projectId }, query)
        : (await listProjectFiles({ companyId, projectId })).files;
      setFiles(files as FileEntry[]);
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

            {project?.deploymentUrl && (
              <a
                href={project.deploymentUrl}
                target="_blank"
                rel="noreferrer"
                className="button-secondary project-ext-btn deploy-live-btn"
                title={`Open deployed live site: ${project.deploymentUrl}`}
              >
                🚀 {language === "uk" ? "Live сайт" : "Live Site"}
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

      {project && files.length === 0 && (
        <section className="project-import-panel" aria-label="Import project">
          <h2>{language === "uk" ? "Імпорт проєкту" : "Import project"}</h2>
          <p>{language === "uk" ? "Підключіть GitHub репозиторій або завантажте ZIP. NPATI перевірить файли, встановить залежності в sandbox і запустить Preview." : "Connect a GitHub repository or upload a ZIP. NPATI inspects files, installs dependencies in the sandbox, and starts Preview."}</p>
          <form className="project-import-form" onSubmit={(event) => void handleRepositoryImport(event)}>
            <input type="url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://github.com/owner/repository" aria-label="GitHub repository URL" required />
            <input type="text" value={importBranch} onChange={(event) => setImportBranch(event.target.value)} placeholder="main" aria-label="Git branch" />
            <input type="text" value={importCredentialId} onChange={(event) => setImportCredentialId(event.target.value)} placeholder={language === "uk" ? "ID ключа в Company vault (для приватного репозиторію)" : "Company vault credential ID (private repository)"} aria-label="Company vault credential ID" />
            <button className="button-primary" type="submit" disabled={importing}>{importing ? "Importing…" : language === "uk" ? "Імпортувати GitHub" : "Import GitHub"}</button>
          </form>
          <div className="project-import-zip">
            <input type="file" accept=".zip,application/zip" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} aria-label="Project ZIP file" />
            <button className="button-secondary" type="button" disabled={!importFile || importing} onClick={() => void handleZipImport()}>{language === "uk" ? "Завантажити ZIP" : "Upload ZIP"}</button>
          </div>
        </section>
      )}

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
                aria-selected={bottomTab === "checkpoints"}
                onClick={() => setBottomTab("checkpoints")}
                className={bottomTab === "checkpoints" ? "active" : ""}
              >
                {language === "uk" ? "Версії (Checkpoints)" : "Checkpoints"}
                {checkpoints.length > 0 && <span className="tab-badge">{checkpoints.length}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "deployments"}
                onClick={() => setBottomTab("deployments")}
                className={bottomTab === "deployments" ? "active" : ""}
              >
                🚀 {language === "uk" ? "Деплой (Deploy)" : "Deploy"}
                {deployments.length > 0 && <span className="tab-badge">{deployments.length}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "qa"}
                onClick={() => setBottomTab("qa")}
                className={bottomTab === "qa" ? "active" : ""}
              >
                Browser QA
                {qaReports.length > 0 && <span className="tab-badge">{qaReports.length}</span>}
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


              {bottomTab === "checkpoints" && (
                <div className="checkpoints-tab-pane">
                  <div className="checkpoints-toolbar">
                    <div className="checkpoints-toolbar-info">
                      <p className="checkpoints-hint">
                        {language === "uk"
                          ? "Точки відновлення дозволяють безпечно повертатися до будь-якої стабільної версії проєкту."
                          : "Checkpoints let you roll back project state safely at any point."}
                      </p>
                      {checkpointFeedback && <span className="checkpoint-success-msg">{checkpointFeedback}</span>}
                    </div>
                    <div className="checkpoints-toolbar-actions">
                      {!isCreatingCheckpoint ? (
                        <button
                          type="button"
                          className="button-primary create-checkpoint-btn"
                          onClick={() => setIsCreatingCheckpoint(true)}
                        >
                          + {language === "uk" ? "Створити Checkpoint" : "Create Checkpoint"}
                        </button>
                      ) : (
                        <form className="create-checkpoint-inline-form" onSubmit={handleCreateCheckpoint}>
                          <input
                            type="text"
                            placeholder={language === "uk" ? "Назва точки (напр. Перед редизайном)" : "Checkpoint name (e.g. Before redesign)"}
                            value={newCheckpointName}
                            onChange={(e) => setNewCheckpointName(e.target.value)}
                            autoFocus
                            required
                          />
                          <button type="submit" className="button-primary">
                            {language === "uk" ? "Зберегти" : "Save"}
                          </button>
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => {
                              setIsCreatingCheckpoint(false);
                              setNewCheckpointName("");
                            }}
                          >
                            {language === "uk" ? "Скасувати" : "Cancel"}
                          </button>
                        </form>
                      )}
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void loadCheckpoints()}
                        disabled={loadingCheckpoints}
                      >
                        {language === "uk" ? "Оновити" : "Refresh"}
                      </button>
                    </div>
                  </div>

                  {checkpoints.length === 0 ? (
                    <div className="empty-checkpoints-state">
                      <p>
                        {language === "uk"
                          ? "Точок відновлення ще не створено. Створіть вручну або виконайте команду в чаті."
                          : "No checkpoints recorded yet. Create one manually or run a task in chat."}
                      </p>
                    </div>
                  ) : (
                    <div className="checkpoints-list">
                      {checkpoints.map((cp) => (
                        <article key={cp.id} className="checkpoint-card">
                          <div className="checkpoint-card-header">
                            <span className={`trigger-badge trigger-${cp.trigger}`}>
                              {cp.trigger === "manual" && (language === "uk" ? "Вручну" : "Manual")}
                              {cp.trigger === "pre_run" && (language === "uk" ? "Перед запуском" : "Pre-run")}
                              {cp.trigger === "post_run" && (language === "uk" ? "Після запуску" : "Post-run")}
                              {cp.trigger === "pre_restore" && (language === "uk" ? "Авто-бекап" : "Pre-restore")}
                            </span>
                            {cp.commitHash && (
                              <code className="checkpoint-hash" title={`Git Commit: ${cp.commitHash}`}>
                                {cp.commitHash.slice(0, 7)}
                              </code>
                            )}
                            <span className="checkpoint-files-count">
                              {cp.fileCount} {language === "uk" ? "файлів" : "files"}
                            </span>
                            <span className="checkpoint-time">{new Date(cp.createdAt).toLocaleString()}</span>
                            <button
                              type="button"
                              className="button-secondary restore-checkpoint-btn"
                              disabled={restoringCheckpointId === cp.id}
                              onClick={() => void handleRestoreCheckpoint(cp)}
                            >
                              {restoringCheckpointId === cp.id
                                ? (language === "uk" ? "Відновлення..." : "Restoring...")
                                : (language === "uk" ? "Відновити ↺" : "Restore ↺")}
                            </button>
                          </div>
                          <h4 className="checkpoint-name">{cp.name}</h4>
                          {cp.description && <p className="checkpoint-description">{cp.description}</p>}
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {bottomTab === "deployments" && (
                <div className="deployments-tab-pane">
                  <div className="deployments-toolbar">
                    <div className="deployments-controls">
                      <label className="deploy-env-label">
                        <span>{language === "uk" ? "Середовище:" : "Environment:"}</span>
                        <select
                          value={deployEnvironment}
                          onChange={(e) => setDeployEnvironment(e.target.value as "production" | "staging")}
                          className="deploy-env-select"
                        >
                          <option value="production">Production</option>
                          <option value="staging">Staging</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void handleRunPreflight()}
                        disabled={loadingPreflight}
                      >
                        {loadingPreflight ? "Checking…" : language === "uk" ? "🔍 Перевірити (Preflight)" : "🔍 Run Preflight"}
                      </button>
                      <input
                        type="text"
                        value={deployCredentialId}
                        onChange={(e) => setDeployCredentialId(e.target.value)}
                        placeholder={language === "uk" ? "Company Vault Credential ID (Dokploy)" : "Company Vault Credential ID (Dokploy)"}
                        className="deploy-cred-input"
                      />
                      <button
                        type="button"
                        className="button-primary deploy-trigger-btn"
                        onClick={() => void handleTriggerDeploy()}
                        disabled={deploying}
                      >
                        {deploying ? "Deploying…" : language === "uk" ? "🚀 Задеплоїти (Dokploy)" : "🚀 Deploy (Dokploy)"}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void loadDeployments()}
                        disabled={loadingDeployments}
                      >
                        {language === "uk" ? "Оновити" : "Refresh"}
                      </button>
                    </div>
                  </div>

                  {deployFeedback && (
                    <div className="deploy-feedback-banner">
                      {deployFeedback}
                    </div>
                  )}

                  {preflightData && (
                    <section className="preflight-summary-card" aria-label="Deployment preflight summary">
                      <h4>📋 {language === "uk" ? "Переддеплойна перевірка (Preflight Inspection)" : "Preflight Inspection"}</h4>
                      <div className="preflight-grid">
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Середовище:" : "Environment:"}</span>
                          <strong>{preflightData.environment}</strong>
                        </div>
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Гілка:" : "Branch:"}</span>
                          <code>{preflightData.branch}</code>
                        </div>
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Змінені файли:" : "Files Changed:"}</span>
                          <span>{preflightData.filesChanged.total} total ({preflightData.filesChanged.staged} staged, {preflightData.filesChanged.unstaged} unstaged)</span>
                        </div>
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Статус білду:" : "Build Status:"}</span>
                          <span className={`status-pill status-${preflightData.buildStatus}`}>{preflightData.buildStatus}</span>
                        </div>
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Тести:" : "Tests:"}</span>
                          <span>{preflightData.tests.executed ? `${preflightData.tests.status} (${preflightData.tests.passed ?? 0} passed)` : "Not executed"}</span>
                        </div>
                        <div className="preflight-item">
                          <span className="preflight-label">{language === "uk" ? "Цільовий провайдер:" : "Target:"}</span>
                          <strong>{preflightData.target}</strong>
                        </div>
                      </div>
                      {preflightData.blockers.length > 0 && (
                        <div className="preflight-blockers">
                          <span className="blocker-title">⚠️ {language === "uk" ? "Блокери деплою:" : "Deployment Blockers:"}</span>
                          <ul>
                            {preflightData.blockers.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </section>
                  )}

                  {deployments.length === 0 ? (
                    <div className="empty-deployments-state">
                      <p>
                        {language === "uk"
                          ? "Деплоїв для цього проєкту ще не було. Виконайте деплой або попросіть агента: «Задеплой проєкт на dokploy»."
                          : "No deployments recorded yet. Deploy manually or prompt your agent: 'Deploy this project to dokploy'."}
                      </p>
                    </div>
                  ) : (
                    <div className="deployments-list">
                      {deployments.map((d) => (
                        <article key={d.id} className="deployment-card">
                          <div className="deployment-card-header">
                            <span className={`status-pill status-${d.status}`}>{d.status}</span>
                            <span className="deploy-provider-badge">📦 {d.provider}</span>
                            <span className="deploy-env-badge">{d.environment}</span>
                            {d.commitHash && <code className="deploy-hash">{d.commitHash.slice(0, 7)}</code>}
                            <span className="deploy-time">{new Date(d.createdAt).toLocaleString()}</span>
                            {d.targetUrl && (
                              <a
                                href={d.targetUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="button-secondary deploy-view-link"
                              >
                                ↗ {language === "uk" ? "Відкрити сайт" : "Open Target"}
                              </a>
                            )}
                          </div>
                          {d.errorMessage && <p className="deploy-error-text">⚠️ {d.errorMessage}</p>}
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {bottomTab === "qa" && (
                <div className="qa-tab-pane">
                  <div className="qa-toolbar">
                    <label>
                      {language === "uk" ? "Шлях" : "Path"}
                      <input value={qaPath} onChange={(event) => setQaPath(event.target.value)} placeholder="/" />
                    </label>
                    <label>
                      {language === "uk" ? "Екран" : "Viewport"}
                      <select value={qaViewport} onChange={(event) => setQaViewport(event.target.value as typeof qaViewport)}>
                        <option value="desktop">Desktop</option>
                        <option value="tablet">Tablet</option>
                        <option value="mobile">Mobile</option>
                      </select>
                    </label>
                    <button type="button" className="button-primary" onClick={() => void handleRunQa()} disabled={runningQa}>
                      {runningQa ? (language === "uk" ? "Перевірка…" : "Inspecting…") : (language === "uk" ? "Запустити Browser QA" : "Run Browser QA")}
                    </button>
                    <button type="button" className="button-secondary" onClick={() => void loadQaReports()} disabled={loadingQa}>
                      {language === "uk" ? "Оновити" : "Refresh"}
                    </button>
                  </div>
                  <p className="activity-hint">{language === "uk" ? "Спочатку запустіть Preview. Знімок показує лише розташування елементів." : "Start Preview first. The screenshot shows element layout only."}</p>
                  {qaFeedback && <p role="status">{qaFeedback}</p>}
                  <div className="qa-report-layout">
                    <div className="qa-report-list">
                      {qaReports.length === 0 ? <p>{language === "uk" ? "Звітів ще немає." : "No reports yet."}</p> : qaReports.map((report) => (
                        <button key={report.id} type="button" className={activeQaReport?.id === report.id ? "button-secondary active" : "button-secondary"} onClick={() => void openQaReport(report.id)}>
                          <span className={`status-pill status-${report.status}`}>{report.status}</span>
                          <span>{new Date(report.createdAt).toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                    {activeQaReport && (
                      <section className="qa-report-detail" aria-label="Browser QA report">
                        <h3>{language === "uk" ? "Звіт Browser QA" : "Browser QA report"}</h3>
                        <p>{activeQaReport.summary}</p>
                        <div className="qa-metrics">
                          <span>Load: {activeQaReport.metrics?.loadTimeMs ?? 0} ms</span>
                          <span>Console: {activeQaReport.metrics?.consoleErrorsCount ?? 0}</span>
                          <span>Links: {activeQaReport.metrics?.brokenLinksCount ?? 0}</span>
                          <span>A11y: {activeQaReport.metrics?.a11yViolationsCount ?? 0}</span>
                        </div>
                        <label>
                          {language === "uk" ? "Показати issues" : "Show issues"}
                          <select value={qaIssueFilter} onChange={(event) => setQaIssueFilter(event.target.value)}>
                            <option value="all">{language === "uk" ? "Усі" : "All"}</option>
                            <option value="error">Error</option>
                            <option value="warning">Warning</option>
                          </select>
                        </label>
                        <ul className="qa-issue-list">
                          {(activeQaReport.issues ?? []).filter((item: any) => qaIssueFilter === "all" || item.severity === qaIssueFilter).map((item: any) => (
                            <li key={item.id}><strong>{item.type}</strong> · {item.message}</li>
                          ))}
                        </ul>
                        {(activeQaReport.screenshots ?? []).map((shot: any, index: number) => (
                          <figure key={index} className="qa-screenshot">
                            <img src={`data:image/png;base64,${shot.base64Data}`} alt={language === "uk" ? "Знімок макета з прихованим вмістом" : "Layout screenshot with hidden content"} />
                            <figcaption>{shot.name} · {shot.viewport.width} × {shot.viewport.height}</figcaption>
                          </figure>
                        ))}
                      </section>
                    )}
                  </div>
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
                            <Link to={r.status === "awaiting_approval" ? `/company?company=${companyId}&runId=${r.id}` : `/activity?runId=${r.id}`} className="button-secondary view-run-btn">
                              {language === "uk" ? "Переглянути Run →" : "View Run →"}
                            </Link>
                          </div>
                          <p className="run-task-text">{r.task}</p>
                          {r.tasks && r.tasks.length > 0 && (
                            <div className="project-task-list" aria-label="Project task plan">
                              <div className="project-task-team">
                                <span className="task-team-label">{language === "uk" ? "Команда агентів:" : "Agent team:"}</span>
                                {[...new Set(r.tasks.map((t) => `${t.role} (${t.agentId.slice(0, 8)})`))].map((label, idx) => (
                                  <span key={idx} className="task-agent-badge">{label}</span>
                                ))}
                              </div>
                              {r.tasks.map((task) => (
                                <div key={task.id} className="project-task-row">
                                  <span className={`status-pill status-${task.status}`}>{task.status}</span>
                                  <strong>{task.title}</strong>
                                  <span>{task.role} · {task.agentId.slice(0, 8)}</span>
                                  {task.dependsOn && task.dependsOn.length > 0 && (
                                    <small className="task-depends-on">After: {task.dependsOn.join(", ")}</small>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
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
