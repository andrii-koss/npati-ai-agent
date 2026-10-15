import { Link } from "react-router-dom";
import type { ProjectRunItem } from "../types";

interface ActivityTabProps {
  language: string;
  companyId: string;
  projectRuns: ProjectRunItem[];
  loadProjectRuns: () => void;
  loadingRuns: boolean;
}

export function ActivityTab({
  language,
  companyId,
  projectRuns,
  loadProjectRuns,
  loadingRuns,
}: ActivityTabProps) {
  return (
    <div className="activity-tab-pane">
      <div className="activity-tab-toolbar">
        <p className="activity-hint">
          {language === "uk"
            ? "Історія запусків та активності для цього проєкту"
            : "Agent runs & activity history for this project"}
        </p>
        <button type="button" className="button-secondary" onClick={loadProjectRuns} disabled={loadingRuns}>
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
                <Link
                  to={r.status === "awaiting_approval" ? `/company?company=${companyId}&runId=${r.id}` : `/activity?runId=${r.id}`}
                  className="button-secondary view-run-btn"
                >
                  {language === "uk" ? "Переглянути Run →" : "View Run →"}
                </Link>
              </div>
              <p className="run-task-text">{r.task}</p>
              {r.tasks && r.tasks.length > 0 && (
                <div className="project-task-list" aria-label="Project task plan">
                  <div className="project-task-team">
                    <span className="task-team-label">{language === "uk" ? "Команда агентів:" : "Agent team:"}</span>
                    {[...new Set(r.tasks.map((t) => `${t.role} (${t.agentId.slice(0, 8)})`))].map((label, idx) => (
                      <span key={idx} className="task-agent-badge">
                        {label}
                      </span>
                    ))}
                  </div>
                  {r.tasks.map((task) => (
                    <div key={task.id} className="project-task-row">
                      <span className={`status-pill status-${task.status}`}>{task.status}</span>
                      <strong>{task.title}</strong>
                      <span>
                        {task.role} · {task.agentId.slice(0, 8)}
                      </span>
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
  );
}
