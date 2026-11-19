import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Agent, EmailAnalytics } from "./EmailSettingsPage";

export interface EmailSettingsAccountFormSectionProps {
  analytics: EmailAnalytics;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setAnalyticsExpanded: Dispatch<SetStateAction<boolean>>;
  analyticsExpanded: boolean;
}

export function EmailSettingsAccountFormSection({ analytics, t, setAnalyticsExpanded, analyticsExpanded }: EmailSettingsAccountFormSectionProps) {
  return (
<div className="email-analytics-dashboard">
          <div className="email-analytics-dashboard-header">
            <div className="email-analytics-header-left">
              <div className="email-analytics-icon-badge">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M18 9l-5 5-4-4-6 6" />
                </svg>
              </div>
              <div>
                <h3>{t("emailSettings.analytics.dashboardTitle")}</h3>
                <p>{t("emailSettings.analytics.dashboardSubtitle")}</p>
              </div>
            </div>
            <div className="email-analytics-header-right">
              <button
                type="button"
                className="email-analytics-collapse-btn"
                onClick={() => setAnalyticsExpanded((prev) => !prev)}
                aria-expanded={analyticsExpanded}
              >
                {analyticsExpanded ? (
                  <>
                    <span>{t("emailSettings.analytics.hideDetails")}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 15l-6-6-6 6" /></svg>
                  </>
                ) : (
                  <>
                    <span>{t("emailSettings.analytics.showDetails")}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                  </>
                )}
              </button>
            </div>
          </div>

          {analyticsExpanded && (
            <div className="email-analytics-dashboard-content">
              {/* 3 Metric Categories */}
              <div className="email-metrics-categories-grid">
                {/* Category 1: AI & Human Handling */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">🤖</span>
                    <span>{t("emailSettings.analytics.handlingTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-blue" />
                        <span className="email-metric-label">{t("emailSettings.analytics.aiAnswered")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.aiAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-indigo" />
                        <span className="email-metric-label">{t("emailSettings.analytics.humanAnswered")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.humanAnswered}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-emerald" />
                        <span className="email-metric-label">{t("emailSettings.analytics.approvedByHuman")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.approvedByHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-amber" />
                        <span className="email-metric-label">{t("emailSettings.analytics.escalatedToHuman")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.escalatedToHuman}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-purple" />
                        <span className="email-metric-label">{t("emailSettings.analytics.editedAiResponses")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.editedAiResponsesCount}</strong>
                    </div>
                  </div>
                </div>

                {/* Category 2: Speed & Delivery Health */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">⚡</span>
                    <span>{t("emailSettings.analytics.speedTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-cyan" />
                        <span className="email-metric-label">{t("emailSettings.analytics.avgResponse")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageResponseTimeMinutes} {t("emailSettings.analytics.minutesUnit")}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-teal" />
                        <span className="email-metric-label">{t("emailSettings.analytics.avgFirstResponse")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.averageFirstResponseTimeMinutes} {t("emailSettings.analytics.minutesUnit")}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-rose" />
                        <span className="email-metric-label">{t("emailSettings.analytics.failedDeliveries")}</span>
                      </div>
                      <strong className={`email-metric-val ${analytics.failedEmails > 0 ? "val-danger" : ""}`}>
                        {analytics.failedEmails}
                      </strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-metric-dot bg-orange" />
                        <span className="email-metric-label">{t("emailSettings.analytics.bouncedEmails")}</span>
                      </div>
                      <strong className={`email-metric-val ${analytics.bouncedEmails > 0 ? "val-danger" : ""}`}>
                        {analytics.bouncedEmails}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Category 3: AI Confidence Distribution */}
                <div className="email-metric-category-card">
                  <div className="email-metric-category-title">
                    <span className="email-cat-icon">🎯</span>
                    <span>{t("emailSettings.analytics.confidenceTitle")}</span>
                  </div>
                  <div className="email-metric-items-list">
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-high">{t("emailSettings.analytics.highBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.highConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.high}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-med">{t("emailSettings.analytics.medBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.medConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.medium}</strong>
                    </div>
                    <div className="email-metric-item">
                      <div className="email-metric-label-group">
                        <span className="email-confidence-badge conf-low">{t("emailSettings.analytics.lowBadge")}</span>
                        <span className="email-metric-label">{t("emailSettings.analytics.lowConfidence")}</span>
                      </div>
                      <strong className="email-metric-val">{analytics.confidenceDistribution.low}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3 Volume Breakdown Tables */}
              <div className="email-volume-panels-grid">
                {/* Volume by Day */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByDayTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.daysCount").replace("{{count}}", String(analytics.volumeByDay.length))}</span>
                  </div>
                  {analytics.volumeByDay.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByDay")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colDate")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colReceived")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colSent")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByDay.map((row) => (
                            <tr key={row.date}>
                              <td><strong>{row.date}</strong></td>
                              <td style={{ textAlign: "right" }}><span className="email-traffic-pill in">{row.received}</span></td>
                              <td style={{ textAlign: "right" }}><span className="email-traffic-pill out">{row.sent}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Volume by Agent */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByAgentTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.agentsCount").replace("{{count}}", String(analytics.volumeByAgent.length))}</span>
                  </div>
                  {analytics.volumeByAgent.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByAgent")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colAgent")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colMessages")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByAgent.map((row) => (
                            <tr key={row.agentId}>
                              <td>
                                <div className="email-table-agent-cell">
                                  <span className="agent-avatar-mini">🤖</span>
                                  <span>{row.agentName}</span>
                                </div>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <span className="email-traffic-pill msg">{row.count}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Volume by Account */}
                <div className="email-volume-card">
                  <div className="email-volume-card-header">
                    <div className="email-volume-card-title">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                      <h4>{t("emailSettings.analytics.volumeByAccountTitle")}</h4>
                    </div>
                    <span className="email-volume-count-badge">{t("emailSettings.analytics.accountsCount").replace("{{count}}", String(analytics.volumeByAccount.length))}</span>
                  </div>
                  {analytics.volumeByAccount.length === 0 ? (
                    <div className="email-volume-empty">
                      <p>{t("emailSettings.analytics.noVolumeByAccount")}</p>
                    </div>
                  ) : (
                    <div className="email-volume-table-wrap email-account-volume-scroll">
                      <table className="automations-table">
                        <thead>
                          <tr>
                            <th>{t("emailSettings.analytics.colAccount")}</th>
                            <th style={{ textAlign: "right" }}>{t("emailSettings.analytics.colMessages")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.volumeByAccount.map((row) => (
                            <tr key={row.accountId}>
                              <td>
                                <span className="email-truncate-address" title={row.email}>{row.email}</span>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <span className="email-traffic-pill msg">{row.count}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
  );
}
