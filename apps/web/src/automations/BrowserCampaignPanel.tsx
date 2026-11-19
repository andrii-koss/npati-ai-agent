import type { FormEvent } from "react";
import type {
  BrowserCampaignTarget,
  BrowserEmailAccount,
  CompanyAutomation,
  TargetFormState,
} from "./types";

export interface BrowserCampaignPanelProps {
  automations: Array<Pick<CompanyAutomation, "id" | "name">>;
  browserTargets: BrowserCampaignTarget[];
  browserEmails: BrowserEmailAccount[];
  browserSaving: boolean;
  targetForm: TargetFormState;
  setTargetForm: React.Dispatch<React.SetStateAction<TargetFormState>>;
  revealedCredentials: Record<string, Record<string, string>>;
  seedBrowserTargets: () => void | Promise<void>;
  seedDemoTitle: string;
  createBrowserTarget: (e: FormEvent) => void | Promise<void>;
  revealBrowserCredential: (target: BrowserCampaignTarget) => void | Promise<void>;
  toggleBrowserTarget: (target: BrowserCampaignTarget) => void | Promise<void>;
  deleteBrowserTarget: (target: BrowserCampaignTarget) => void | Promise<void>;
}

export function BrowserCampaignPanel({
  automations,
  browserTargets,
  browserEmails,
  browserSaving,
  targetForm,
  setTargetForm,
  revealedCredentials,
  seedBrowserTargets,
  seedDemoTitle,
  createBrowserTarget,
  revealBrowserCredential,
  toggleBrowserTarget,
  deleteBrowserTarget,
}: BrowserCampaignPanelProps) {
  return (
    <section className="browser-campaign-section" aria-labelledby="browser-campaign-title">
      <div className="inspector-header browser-campaign-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">Browser agent campaign</p>
            <h2 id="browser-campaign-title">Website registration and publishing</h2>
            <p className="hero-copy">The active automation processes at most 10 pending websites per run. Passwords are generated automatically and kept encrypted.</p>
          </div>
          <button
            type="button"
            className="button-secondary browser-demo-seed-btn"
            disabled={browserSaving || !targetForm.automationId || !targetForm.emailAccountId}
            onClick={seedBrowserTargets}
            title={seedDemoTitle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add 2 paused demo sites
          </button>
        </div>
      </div>

      <form onSubmit={createBrowserTarget} className="browser-campaign-card">
        <div className="browser-campaign-card-header">
          <div className="browser-card-title-group">
            <span className="browser-card-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </span>
            <div>
              <h3>Add target website</h3>
              <p>Register directory profiles and automatically publish tailored company content</p>
            </div>
          </div>
        </div>

        <div className="browser-campaign-form-grid">
          <label className="browser-form-field">
            <span>Site name <i className="required-star">*</i></span>
            <input required value={targetForm.siteName} onChange={(event) => setTargetForm({ ...targetForm, siteName: event.target.value })} placeholder="Example directory" />
          </label>
          <label className="browser-form-field">
            <span>Registration URL <i className="required-star">*</i></span>
            <input required type="url" value={targetForm.registrationUrl} onChange={(event) => setTargetForm({ ...targetForm, registrationUrl: event.target.value })} placeholder="https://example.com/register" />
          </label>
          <label className="browser-form-field">
            <span>Publishing URL</span>
            <input type="url" value={targetForm.publishUrl} onChange={(event) => setTargetForm({ ...targetForm, publishUrl: event.target.value })} placeholder="https://example.com/new-article" />
          </label>
          <label className="browser-form-field">
            <span>Automation <i className="required-star">*</i></span>
            <select required value={targetForm.automationId} onChange={(event) => setTargetForm({ ...targetForm, automationId: event.target.value })}>
              <option value="">Select automation</option>
              {automations.map((automation) => <option key={automation.id} value={automation.id}>{automation.name}</option>)}
            </select>
          </label>
          <label className="browser-form-field">
            <span>Company email <i className="required-star">*</i></span>
            <select required value={targetForm.emailAccountId} onChange={(event) => setTargetForm({ ...targetForm, emailAccountId: event.target.value })}>
              <option value="">Select connected email</option>
              {browserEmails.map((account) => <option key={account.id} value={account.id}>{account.emailAddress} ({account.status})</option>)}
            </select>
          </label>
          <label className="browser-form-field">
            <span>Article title</span>
            <input value={targetForm.articleTitle} onChange={(event) => setTargetForm({ ...targetForm, articleTitle: event.target.value })} placeholder="Title to publish" />
          </label>
          <label className="browser-form-field browser-form-field-full">
            <span>Article body</span>
            <textarea rows={3} value={targetForm.articleBody} onChange={(event) => setTargetForm({ ...targetForm, articleBody: event.target.value })} placeholder="Article content. The agent also receives the linked Business and Company Knowledge context." />
            <small className="browser-form-hint">The agent dynamically adapts this content with company tone, keywords, and domain background.</small>
          </label>
        </div>

        <div className="browser-form-footer">
          <div className="browser-form-footer-hint">
            {!automations.length ? (
              <span className="warning-text">⚠️ Create at least one automation to dispatch runs.</span>
            ) : !browserEmails.length ? (
              <span className="warning-text">⚠️ Connect an email account in Email settings to verify registrations.</span>
            ) : (
              <span>Ready to queue automatic browser runs</span>
            )}
          </div>
          <button
            type="submit"
            className="button-primary automations-action-primary browser-submit-btn"
            disabled={browserSaving || !automations.length || !browserEmails.length}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {browserSaving ? "Saving…" : "Add website"}
          </button>
        </div>
      </form>

      <div className="automations-table-container">
        <table className="automations-table browser-targets-table">
          <thead>
            <tr>
              <th style={{ width: "140px" }}>Status</th>
              <th style={{ minWidth: "260px" }}>Website</th>
              <th style={{ minWidth: "210px" }}>Email / automation</th>
              <th style={{ minWidth: "160px" }}>Result</th>
              <th style={{ width: "170px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!browserTargets.length ? (
              <tr>
                <td colSpan={5} className="browser-table-empty-cell">
                  <div className="browser-empty-state">
                    <div className="browser-empty-icon" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    </div>
                    <h4>No websites added yet</h4>
                    <p>Add a website above or load the paused demo rows to test automated directory registration and publishing.</p>
                    <button
                      type="button"
                      className="button-secondary browser-demo-seed-btn"
                      disabled={browserSaving || !targetForm.automationId || !targetForm.emailAccountId}
                      onClick={seedBrowserTargets}
                      title={seedDemoTitle}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Add 2 paused demo sites
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              browserTargets.map((target) => {
                const account = browserEmails.find((item) => item.id === target.emailAccountId);
                const automation = automations.find((item) => item.id === target.automationId);
                const statusClass =
                  target.status === "published" || target.status === "registered"
                    ? "active"
                    : target.status === "pending"
                    ? "pending"
                    : target.status === "processing" || target.status === "waiting_email"
                    ? "processing"
                    : target.status === "failed"
                    ? "failed"
                    : "paused";

                return (
                  <tr key={target.id}>
                    <td>
                      <span className={`automation-status-btn ${statusClass}`}>
                        <span className="automation-status-dot" />
                        {target.status.replace("_", " ")}
                      </span>
                      <span className="browser-target-attempt">Attempt {target.attempts}/3</span>
                    </td>
                    <td className="automation-title-cell">
                      <strong className="browser-target-name">{target.siteName}</strong>
                      <div className="browser-target-links">
                        <a href={target.registrationUrl} className="browser-link-pill" target="_blank" rel="noreferrer">
                          Registration ↗
                        </a>
                        {target.publishUrl ? (
                          <a href={target.publishUrl} className="browser-link-pill" target="_blank" rel="noreferrer">
                            Publishing ↗
                          </a>
                        ) : null}
                      </div>
                      <div className="browser-target-cred-row">
                        {target.credentialId ? (
                          <span className="browser-cred-badge saved">
                            🔒 Credentials saved securely ·{" "}
                            <button type="button" className="company-doc-link" onClick={() => revealBrowserCredential(target)}>
                              Reveal for 30s
                            </button>
                          </span>
                        ) : (
                          <span className="browser-cred-badge generated">
                            🔑 Credentials will be generated on first run
                          </span>
                        )}
                      </div>
                      {revealedCredentials[target.id] ? (
                        <div className="browser-revealed-credentials">
                          {Object.entries(revealedCredentials[target.id] ?? {}).map(([name, value]) => (
                            <div key={name} className="browser-cred-item">
                              <span>{name}:</span> <code>{value}</code>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="browser-email-info">
                        <span className="browser-email-pill">
                          ✉️ {account?.emailAddress || "Email not selected"}
                        </span>
                        <span className="automation-agent-badge" style={{ marginTop: 6 }}>
                          ⚡ {automation?.name || "Automation not selected"}
                        </span>
                      </div>
                    </td>
                    <td>
                      {target.resultUrl ? (
                        <a href={target.resultUrl} className="browser-result-badge" target="_blank" rel="noreferrer">
                          <span>View result</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </a>
                      ) : (
                        <span className="browser-target-empty-dash">—</span>
                      )}
                      {target.errorMessage ? (
                        <p className="browser-target-error-msg">{target.errorMessage}</p>
                      ) : null}
                    </td>
                    <td>
                      <div className="automation-actions-cell" style={{ justifyContent: "flex-end" }}>
                        {!['processing', 'waiting_email'].includes(target.status) && (
                          <button
                            type="button"
                            className="automation-action-btn"
                            onClick={() => toggleBrowserTarget(target)}
                            title={target.status === "pending" ? "Pause" : target.status === "paused" ? "Activate" : "Run again"}
                          >
                            {target.status === "pending" ? "Pause" : target.status === "paused" ? "Activate" : "Run again"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="automation-action-btn danger"
                          onClick={() => deleteBrowserTarget(target)}
                          title="Delete target"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
