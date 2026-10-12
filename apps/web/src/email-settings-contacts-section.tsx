import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EmailAccount, DnsCheckResult } from "./EmailSettingsPage";

export interface EmailSettingsContactsSectionProps {
  setDnsDrawerOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  dnsAccount: EmailAccount | null;
  dnsChecking: boolean;
  dnsResult: DnsCheckResult | null;
  name: any;
  footer: string;
}

export function EmailSettingsContactsSection({ setDnsDrawerOpen, t, dnsAccount, dnsChecking, dnsResult, name, footer }: EmailSettingsContactsSectionProps) {
  return (
<div className="company-drawer-backdrop" onMouseDown={() => setDnsDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.dnsDrawer.kicker")}</span>
                <h2>{t("emailSettings.dnsDrawer.titleAudit").replace("{{domain}}", dnsAccount?.emailAddress.split("@")[1] || "Domain")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setDnsDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <div style={{ padding: "20px 24px" }}>
              {dnsChecking ? (
                <div style={{ textAlign: "center", padding: "40px" }}>
                  <p>{t("emailSettings.dnsDrawer.queryingDns")}</p>
                </div>
              ) : dnsResult ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div
                    style={{
                    padding: "14px 16px",
                    borderRadius: "10px",
                    background: dnsResult.verified ? "#ecfdf5" : "#fffbeb",
                    border: `1px solid ${dnsResult.verified ? "#a7f3d0" : "#fde68a"}`,
                    color: dnsResult.verified ? "#065f46" : "#92400e",
                    fontSize: "13px",
                    lineHeight: 1.5,
                  }}
                  >
                    <strong>{dnsResult.verified ? t("emailSettings.dnsDrawer.domainVerified") : t("emailSettings.dnsDrawer.actionRecommended")}</strong>
                    <div>{dnsResult.summary}</div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {dnsResult.records.map((rec) => (
                      <div
                        key={rec.recordType}
                        style={{
                          padding: "14px 16px",
                          borderRadius: "10px",
                          border: "1px solid #e2e8f0",
                          background: "#ffffff",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontWeight: 700, fontSize: "14px" }}>{t("emailSettings.dnsDrawer.recordHeading").replace("{{recordType}}", rec.recordType).replace("{{name}}", rec.name)}</span>
                          <span
                            className={`automation-status-btn ${rec.valid ? "active" : "paused"}`}
                            style={{ cursor: "default" }}
                          >
                            <span className="automation-status-dot" />
                            {rec.valid ? t("emailSettings.dnsDrawer.statusValid") : rec.found ? t("emailSettings.dnsDrawer.statusInvalid") : t("emailSettings.dnsDrawer.statusMissing")}
                          </span>
                        </div>

                        {rec.currentValue && (
                          <div style={{ fontSize: "12px", color: "#475569", marginBottom: 4, fontFamily: "monospace" }}>
                            {t("emailSettings.dnsDrawer.currentValue").replace("{{value}}", rec.currentValue)}
                          </div>
                        )}

                        {rec.recommendation && (
                          <div style={{ fontSize: "12px", color: "#b45309", background: "#fef3c7", padding: "6px 10px", borderRadius: "6px", marginTop: 6 }}>
                            💡 <strong>{t("emailSettings.dnsDrawer.recommendation")}</strong> {rec.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p>{t("emailSettings.dnsDrawer.noResult")}</p>
              )}
            </div>

            <footer style={{ padding: "16px 24px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="button-primary automations-action-primary"
                onClick={() => setDnsDrawerOpen(false)}
              >
                {t("emailSettings.dnsDrawer.closeAudit")}
              </button>
            </footer>
          </aside>
        </div>
  );
}
