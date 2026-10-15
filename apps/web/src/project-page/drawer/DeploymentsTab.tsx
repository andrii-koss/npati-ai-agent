import type { DeploymentItem, PreflightInfo } from "../types";

interface DeploymentsTabProps {
  language: string;
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
}

export function DeploymentsTab({
  language,
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
}: DeploymentsTabProps) {
  return (
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
            onClick={handleRunPreflight}
            disabled={loadingPreflight}
          >
            {loadingPreflight ? "Checking…" : language === "uk" ? "🔍 Перевірити (Preflight)" : "🔍 Run Preflight"}
          </button>
          <input
            type="text"
            value={deployCredentialId}
            onChange={(e) => setDeployCredentialId(e.target.value)}
            placeholder="Company Vault Credential ID (Dokploy)"
            className="deploy-cred-input"
          />
          <button
            type="button"
            className="button-primary deploy-trigger-btn"
            onClick={handleTriggerDeploy}
            disabled={deploying}
          >
            {deploying ? "Deploying…" : language === "uk" ? "🚀 Задеплоїти (Dokploy)" : "🚀 Deploy (Dokploy)"}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={loadDeployments}
            disabled={loadingDeployments}
          >
            {language === "uk" ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {deployFeedback && <div className="deploy-feedback-banner">{deployFeedback}</div>}

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
              <span>
                {preflightData.filesChanged.total} total ({preflightData.filesChanged.staged} staged,{" "}
                {preflightData.filesChanged.unstaged} unstaged)
              </span>
            </div>
            <div className="preflight-item">
              <span className="preflight-label">{language === "uk" ? "Статус білду:" : "Build Status:"}</span>
              <span className={`status-pill status-${preflightData.buildStatus}`}>{preflightData.buildStatus}</span>
            </div>
            <div className="preflight-item">
              <span className="preflight-label">{language === "uk" ? "Тести:" : "Tests:"}</span>
              <span>
                {preflightData.tests.executed
                  ? `${preflightData.tests.status} (${preflightData.tests.passed ?? 0} passed)`
                  : "Not executed"}
              </span>
            </div>
            <div className="preflight-item">
              <span className="preflight-label">{language === "uk" ? "Цільовий провайдер:" : "Target:"}</span>
              <strong>{preflightData.target}</strong>
            </div>
          </div>
          {preflightData.blockers.length > 0 && (
            <div className="preflight-blockers">
              <span className="blocker-title">
                ⚠️ {language === "uk" ? "Блокери деплою:" : "Deployment Blockers:"}
              </span>
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
                  <a href={d.targetUrl} target="_blank" rel="noreferrer" className="button-secondary deploy-view-link">
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
  );
}
