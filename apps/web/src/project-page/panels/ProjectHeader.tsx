import { isolatedPreviewUrl } from "../../preview-origin";
import { Link } from "react-router-dom";
import type { Project } from "../../ProjectSection";
import type { PreviewStatusResponse } from "../types";

interface ProjectHeaderProps {
  language: string;
  companyId: string;
  project?: Project;
  previewStatus: PreviewStatusResponse | null;
  previewLoading: boolean;
  handleStopPreview: () => void;
  handleStartPreview: () => void;
  refreshProject: () => void;
  error: string;
}

export function ProjectHeader({
  language,
  companyId,
  project,
  previewStatus,
  previewLoading,
  handleStopPreview,
  handleStartPreview,
  refreshProject,
  error,
}: ProjectHeaderProps) {
  return (
    <>
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
                onClick={handleStopPreview}
                disabled={previewLoading}
              >
                {previewLoading ? "Stopping…" : language === "uk" ? "Зупинити Preview" : "Stop Preview"}
              </button>
            ) : (
              <button
                type="button"
                className="button-primary project-start-btn"
                onClick={handleStartPreview}
                disabled={previewLoading}
              >
                {previewLoading ? "Starting…" : language === "uk" ? "▶ Запустити Preview" : "▶ Start Preview"}
              </button>
            )}

            {previewStatus?.previewUrl && (
              <a
                href={isolatedPreviewUrl(previewStatus.previewUrl)}
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
              onClick={refreshProject}
              title="Refresh project state"
            >
              🔄
            </button>
          </div>
        </header>
      ) : !error ? (
        <p>{language === "uk" ? "Завантаження проєкту…" : "Loading project…"}</p>
      ) : null}
    </>
  );
}
