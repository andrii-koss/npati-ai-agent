import React from "react";
import type {
  BottomTab,
  ChangesResult,
  CheckpointItem,
  DeploymentItem,
  FileChange,
  PreflightInfo,
  ProjectRunItem,
  TerminalEvent,
} from "../types";
import { ActivityTab } from "./ActivityTab";
import { ChangesTab } from "./ChangesTab";
import { CheckpointsTab } from "./CheckpointsTab";
import { DeploymentsTab } from "./DeploymentsTab";
import { LogsTab } from "./LogsTab";
import { QaTab } from "./QaTab";
import { TerminalTab } from "./TerminalTab";

interface ProjectBottomDrawerProps {
  language: string;
  companyId: string;
  bottomTab: BottomTab;
  setBottomTab: (tab: BottomTab) => void;
  changes: ChangesResult;
  selectedDiff?: FileChange;
  onSelectDiffPath: (path: string) => void;
  onSnapshotBaseline: () => void;
  sandboxState: string;
  terminalEvents: TerminalEvent[];
  refreshTerminalAndLogs: () => void;
  checkpoints: CheckpointItem[];
  checkpointFeedback: string;
  isCreatingCheckpoint: boolean;
  setIsCreatingCheckpoint: (v: boolean) => void;
  newCheckpointName: string;
  setNewCheckpointName: (v: string) => void;
  handleCreateCheckpoint: (e: React.FormEvent) => void;
  loadCheckpoints: () => void;
  loadingCheckpoints: boolean;
  restoringCheckpointId: string | null;
  handleRestoreCheckpoint: (cp: CheckpointItem) => void;
  deployEnvironment: "production" | "staging";
  setDeployEnvironment: (v: "production" | "staging") => void;
  handleRunPreflight: () => void;
  loadingPreflight: boolean;
  deployCredentialId: string;
  setDeployCredentialId: (v: string) => void;
  handleTriggerDeploy: () => void;
  deploying: boolean;
  loadDeployments: () => void;
  loadingDeployments: boolean;
  deployFeedback: string;
  preflightData: PreflightInfo | null;
  deployments: DeploymentItem[];
  qaPath: string;
  setQaPath: (v: string) => void;
  qaViewport: "desktop" | "tablet" | "mobile";
  setQaViewport: (v: "desktop" | "tablet" | "mobile") => void;
  handleRunQa: () => void;
  runningQa: boolean;
  loadQaReports: () => void;
  loadingQa: boolean;
  qaFeedback: string;
  qaReports: any[];
  activeQaReport: any;
  openQaReport: (id: string) => void;
  qaIssueFilter: string;
  setQaIssueFilter: (v: string) => void;
  logs: string;
  projectRuns: ProjectRunItem[];
  loadProjectRuns: () => void;
  loadingRuns: boolean;
}

export function ProjectBottomDrawer(props: ProjectBottomDrawerProps) {
  const {
    language,
    companyId,
    bottomTab,
    setBottomTab,
    changes,
    selectedDiff,
    onSelectDiffPath,
    onSnapshotBaseline,
    sandboxState,
    terminalEvents,
    refreshTerminalAndLogs,
    checkpoints,
    checkpointFeedback,
    isCreatingCheckpoint,
    setIsCreatingCheckpoint,
    newCheckpointName,
    setNewCheckpointName,
    handleCreateCheckpoint,
    loadCheckpoints,
    loadingCheckpoints,
    restoringCheckpointId,
    handleRestoreCheckpoint,
    deployEnvironment,
    setDeployEnvironment,
    handleRunPreflight,
    loadingPreflight,
    deployCredentialId,
    setDeployCredentialId,
    handleTriggerDeploy,
    deploying,
    loadDeployments,
    loadingDeployments,
    deployFeedback,
    preflightData,
    deployments,
    qaPath,
    setQaPath,
    qaViewport,
    setQaViewport,
    handleRunQa,
    runningQa,
    loadQaReports,
    loadingQa,
    qaFeedback,
    qaReports,
    activeQaReport,
    openQaReport,
    qaIssueFilter,
    setQaIssueFilter,
    logs,
    projectRuns,
    loadProjectRuns,
    loadingRuns,
  } = props;

  return (
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
          <ChangesTab
            language={language}
            changes={changes}
            selectedDiff={selectedDiff}
            onSelectDiffPath={onSelectDiffPath}
            onSnapshotBaseline={onSnapshotBaseline}
          />
        )}
        {bottomTab === "terminal" && (
          <TerminalTab
            sandboxState={sandboxState}
            terminalEvents={terminalEvents}
            onRefresh={refreshTerminalAndLogs}
          />
        )}
        {bottomTab === "checkpoints" && (
          <CheckpointsTab
            language={language}
            checkpoints={checkpoints}
            checkpointFeedback={checkpointFeedback}
            isCreatingCheckpoint={isCreatingCheckpoint}
            setIsCreatingCheckpoint={setIsCreatingCheckpoint}
            newCheckpointName={newCheckpointName}
            setNewCheckpointName={setNewCheckpointName}
            handleCreateCheckpoint={handleCreateCheckpoint}
            loadCheckpoints={loadCheckpoints}
            loadingCheckpoints={loadingCheckpoints}
            restoringCheckpointId={restoringCheckpointId}
            handleRestoreCheckpoint={handleRestoreCheckpoint}
          />
        )}
        {bottomTab === "deployments" && (
          <DeploymentsTab
            language={language}
            deployEnvironment={deployEnvironment}
            setDeployEnvironment={setDeployEnvironment}
            handleRunPreflight={handleRunPreflight}
            loadingPreflight={loadingPreflight}
            deployCredentialId={deployCredentialId}
            setDeployCredentialId={setDeployCredentialId}
            handleTriggerDeploy={handleTriggerDeploy}
            deploying={deploying}
            loadDeployments={loadDeployments}
            loadingDeployments={loadingDeployments}
            deployFeedback={deployFeedback}
            preflightData={preflightData}
            deployments={deployments}
          />
        )}
        {bottomTab === "qa" && (
          <QaTab
            language={language}
            qaPath={qaPath}
            setQaPath={setQaPath}
            qaViewport={qaViewport}
            setQaViewport={setQaViewport}
            handleRunQa={handleRunQa}
            runningQa={runningQa}
            loadQaReports={loadQaReports}
            loadingQa={loadingQa}
            qaFeedback={qaFeedback}
            qaReports={qaReports}
            activeQaReport={activeQaReport}
            openQaReport={openQaReport}
            qaIssueFilter={qaIssueFilter}
            setQaIssueFilter={setQaIssueFilter}
          />
        )}
        {bottomTab === "logs" && (
          <LogsTab logs={logs} onRefresh={refreshTerminalAndLogs} />
        )}
        {bottomTab === "activity" && (
          <ActivityTab
            language={language}
            companyId={companyId}
            projectRuns={projectRuns}
            loadProjectRuns={loadProjectRuns}
            loadingRuns={loadingRuns}
          />
        )}
      </div>
    </section>
  );
}
