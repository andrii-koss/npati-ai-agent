import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "./i18n";
import { listProjectFiles, readProjectFile, searchProjectFiles } from "./project-files-client";
import type { Project } from "./ProjectSection";
import { apiGet, apiPost } from "./project-page/api";
import { ProjectBottomDrawer } from "./project-page/drawer/ProjectBottomDrawer";
import { AgentChatColumn } from "./project-page/panels/AgentChatColumn";
import { FilesColumn } from "./project-page/panels/FilesColumn";
import { PreviewColumn } from "./project-page/panels/PreviewColumn";
import { ProjectHeader } from "./project-page/panels/ProjectHeader";
import { ProjectImportPanel } from "./project-page/panels/ProjectImportPanel";
import type {
  BottomTab,
  ChangesResult,
  ChatMessage,
  CheckpointItem,
  DeploymentItem,
  DeviceMode,
  FileContent,
  FileEntry,
  MobileView,
  PreflightInfo,
  PreviewStatusResponse,
  ProjectRunItem,
  TerminalEvent,
} from "./project-page/types";

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

  const [changes, setChanges] = useState<ChangesResult>({
    summary: { added: 0, modified: 0, deleted: 0, total: 0 },
    changes: [],
  });
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

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

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
      setCheckpointFeedback(
        language === "uk" ? "Точку відновлення успішно створено!" : "Checkpoint created successfully!"
      );
      setTimeout(() => setCheckpointFeedback(null), 4000);
      await loadCheckpoints();
    } catch (err: any) {
      alert(err.message || "Failed to create checkpoint");
    }
  };

  const handleRestoreCheckpoint = async (checkpoint: CheckpointItem) => {
    if (!base) return;
    const confirmMessage =
      language === "uk"
        ? `Відновити стан проєкту до "${checkpoint.name}"?\n\nБезпека: NPATI автоматично створить резервну точку (авто-бекап) перед відкатом.`
        : `Restore project to "${checkpoint.name}"?\n\nSafety: NPATI will automatically create a pre-restore backup checkpoint before rolling back.`;
    if (!window.confirm(confirmMessage)) return;

    setRestoringCheckpointId(checkpoint.id);
    try {
      await apiPost(`${base}/checkpoints/${checkpoint.id}/restore`, { approved: true });
      setCheckpointFeedback(
        language === "uk"
          ? `Успішно відновлено до "${checkpoint.name}"!`
          : `Successfully restored to "${checkpoint.name}"!`
      );
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
      alert(
        language === "uk"
          ? "Вкажіть ID облікового запису (credentialId) із Company Vault для Dokploy!"
          : "Please specify Dokploy vault credential ID!"
      );
      return;
    }
    setDeploying(true);
    setDeployFeedback(null);
    try {
      const data = await apiPost<{ deployment: DeploymentItem; approvalRequired?: boolean; previewUrl?: string }>(
        `${base}/deployments`,
        {
          provider: "dokploy",
          environment: deployEnvironment,
          credentialId: deployCredentialId.trim(),
        }
      );
      setDeployFeedback(
        language === "uk"
          ? `Деплой успішно виконано! URL: ${data.previewUrl || data.deployment.targetUrl}`
          : `Deployment successful! URL: ${data.previewUrl || data.deployment.targetUrl}`
      );
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

  const refreshProject = async () => {
    try {
      const [proj, tree, chg, pStatus] = await Promise.all([
        apiGet<Project>(base),
        listProjectFiles({ companyId, projectId }),
        apiGet<ChangesResult>(`${base}/changes`).catch(() => ({
          summary: { added: 0, modified: 0, deleted: 0, total: 0 },
          changes: [],
        })),
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
      const timer = setInterval(() => {
        void loadProjectRuns();
      }, 3000);
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

  const handleStartPreview = async () => {
    setPreviewLoading(true);
    setError("");
    try {
      const result = await apiPost<{
        status: string;
        previewUrl: string;
        token: string;
        port: number;
        framework: string;
      }>(`${base}/preview/start`, {});
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

  const handleStopPreview = async () => {
    setPreviewLoading(true);
    setError("");
    try {
      await apiPost(`${base}/preview/stop`, {});
      setPreviewStatus((prev) => (prev ? { ...prev, isRunning: false, status: "ready" } : null));
      await refreshProject();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to stop preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const openFile = async (filePath: string) => {
    try {
      setError("");
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
      const searchFiles = query
        ? await searchProjectFiles({ companyId, projectId }, query)
        : (await listProjectFiles({ companyId, projectId })).files;
      setFiles(searchFiles as FileEntry[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search unavailable");
    }
  };

  const handleSnapshotBaseline = async () => {
    try {
      await apiPost(`${base}/changes/baseline`);
      const updated = await apiGet<ChangesResult>(`${base}/changes`);
      setChanges(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to snapshot baseline");
    }
  };

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

      const pollInterval = setInterval(async () => {
        try {
          const runStatus = await apiGet<{ run: { status: string; result?: string; errorMessage?: string } }>(
            `/api/companies/${encodeURIComponent(companyId)}/runs/${run.run.id}`
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
    deviceMode === "mobile"
      ? { width: "375px", height: "667px" }
      : deviceMode === "tablet"
      ? { width: "768px", height: "1024px" }
      : { width: "100%", height: "100%" };

  return (
    <main className="company-page project-page-modern">
      <ProjectHeader
        language={language}
        companyId={companyId}
        project={project}
        previewStatus={previewStatus}
        previewLoading={previewLoading}
        handleStopPreview={() => void handleStopPreview()}
        handleStartPreview={() => void handleStartPreview()}
        refreshProject={() => void refreshProject()}
        error={error}
      />

      <ProjectImportPanel
        language={language}
        filesLength={files.length}
        hasProject={Boolean(project)}
        importUrl={importUrl}
        setImportUrl={setImportUrl}
        importBranch={importBranch}
        setImportBranch={setImportBranch}
        importCredentialId={importCredentialId}
        setImportCredentialId={setImportCredentialId}
        handleRepositoryImport={(e) => void handleRepositoryImport(e)}
        importing={importing}
        importFile={importFile}
        setImportFile={setImportFile}
        handleZipImport={() => void handleZipImport()}
      />

      {error && <p className="project-error-banner" role="alert">{error}</p>}

      <div className="project-mobile-tabs" role="tablist" aria-label="Mobile view switcher">
        {(["all", "files", "chat", "preview", "bottom"] as const).map((view) => (
          <button
            key={view}
            type="button"
            className={mobileView === view ? "active" : ""}
            onClick={() => setMobileView(view)}
          >
            {view === "all"
              ? "All"
              : view === "files"
              ? "Files"
              : view === "chat"
              ? "Agent Chat"
              : view === "preview"
              ? "Preview"
              : "Details"}
          </button>
        ))}
      </div>

      {project && (
        <>
          <section className={`project-grid ${mobileView !== "all" ? `mobile-focus-${mobileView}` : ""}`}>
            <FilesColumn
              language={language}
              files={files}
              fileSearchQuery={fileSearchQuery}
              setFileSearchQuery={setFileSearchQuery}
              handleFileSearch={(e) => void handleFileSearch(e)}
              selectedFile={selectedFile}
              openFile={(p) => void openFile(p)}
              onCloseFile={() => setSelectedFile(null)}
            />

            <AgentChatColumn
              language={language}
              chatBusy={chatBusy}
              chatMessages={chatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              handleSendPrompt={(e) => void handleSendPrompt(e)}
              chatScrollRef={chatScrollRef}
            />

            <PreviewColumn
              language={language}
              deviceMode={deviceMode}
              setDeviceMode={setDeviceMode}
              setIframeKey={setIframeKey}
              previewStatus={previewStatus}
              previewLoading={previewLoading}
              handleStartPreview={() => void handleStartPreview()}
              iframeKey={iframeKey}
              deviceWidthStyle={deviceWidthStyle}
            />
          </section>

          <ProjectBottomDrawer
            language={language}
            companyId={companyId}
            bottomTab={bottomTab}
            setBottomTab={setBottomTab}
            changes={changes}
            selectedDiff={selectedDiff}
            onSelectDiffPath={setSelectedDiffPath}
            onSnapshotBaseline={() => void handleSnapshotBaseline()}
            sandboxState={sandboxState}
            terminalEvents={terminalEvents}
            refreshTerminalAndLogs={() => void refreshTerminalAndLogs()}
            checkpoints={checkpoints}
            checkpointFeedback={checkpointFeedback ?? ""}
            isCreatingCheckpoint={isCreatingCheckpoint}
            setIsCreatingCheckpoint={setIsCreatingCheckpoint}
            newCheckpointName={newCheckpointName}
            setNewCheckpointName={setNewCheckpointName}
            handleCreateCheckpoint={(e) => void handleCreateCheckpoint(e)}
            loadCheckpoints={() => void loadCheckpoints()}
            loadingCheckpoints={loadingCheckpoints}
            restoringCheckpointId={restoringCheckpointId}
            handleRestoreCheckpoint={(cp) => void handleRestoreCheckpoint(cp)}
            deployEnvironment={deployEnvironment}
            setDeployEnvironment={setDeployEnvironment}
            handleRunPreflight={() => void handleRunPreflight()}
            loadingPreflight={loadingPreflight}
            deployCredentialId={deployCredentialId}
            setDeployCredentialId={setDeployCredentialId}
            handleTriggerDeploy={() => void handleTriggerDeploy()}
            deploying={deploying}
            loadDeployments={() => void loadDeployments()}
            loadingDeployments={loadingDeployments}
            deployFeedback={deployFeedback ?? ""}
            preflightData={preflightData}
            deployments={deployments}
            qaPath={qaPath}
            setQaPath={setQaPath}
            qaViewport={qaViewport}
            setQaViewport={setQaViewport}
            handleRunQa={() => void handleRunQa()}
            runningQa={runningQa}
            loadQaReports={() => void loadQaReports()}
            loadingQa={loadingQa}
            qaFeedback={qaFeedback ?? ""}
            qaReports={qaReports}
            activeQaReport={activeQaReport}
            openQaReport={(id) => void openQaReport(id)}
            qaIssueFilter={qaIssueFilter}
            setQaIssueFilter={setQaIssueFilter}
            logs={logs}
            projectRuns={projectRuns}
            loadProjectRuns={() => void loadProjectRuns()}
            loadingRuns={loadingRuns}
          />
        </>
      )}
    </main>
  );
}
