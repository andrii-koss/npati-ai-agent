import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { writeActiveCompanyId } from "./active-company";
import type { Company, Agent, EmailAccount, EmailRule, EmailAnalytics } from "./EmailSettingsPage";
import { readCachedAccounts, readCachedAnalytics } from "./EmailSettingsPage";

export interface EmailSettingsTemplatesSectionProps {
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  editingId: string | null;
  saveAccount: any;
  accountFormError: string | null;
  notice: string | null;
  selectedCompanyId: string;
  setSelectedCompanyId: Dispatch<SetStateAction<string>>;
  setAgentId: Dispatch<SetStateAction<string>>;
  setRuleAgentId: Dispatch<SetStateAction<string>>;
  setRuleWorkflowId: Dispatch<SetStateAction<string>>;
  setRuleCreateTask: Dispatch<SetStateAction<boolean>>;
  setAccounts: Dispatch<SetStateAction<EmailAccount[]>>;
  setAnalytics: Dispatch<SetStateAction<EmailAnalytics | null>>;
  companies: Company[];
  emailAddress: string;
  accountFieldErrors: Record<string, string>;
  setEmailAddress: Dispatch<SetStateAction<string>>;
  setAccountFieldErrors: Dispatch<SetStateAction<Record<string, string>>>;
  displayName: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  agentId: string;
  agents: Agent[];
  provider: EmailAccount["provider"];
  setProvider: Dispatch<SetStateAction<EmailAccount["provider"]>>;
  setMailAuthType: Dispatch<SetStateAction<"password" | "oauth2">>;
  setImapHost: Dispatch<SetStateAction<string>>;
  setImapPort: Dispatch<SetStateAction<number>>;
  setImapSecure: Dispatch<SetStateAction<boolean>>;
  setSmtpHost: Dispatch<SetStateAction<string>>;
  setSmtpPort: Dispatch<SetStateAction<number>>;
  setSmtpSecure: Dispatch<SetStateAction<boolean>>;
  setOauthAuthorizationUrl: Dispatch<SetStateAction<string>>;
  accounts: EmailAccount[];
  setOauthTokenUrl: Dispatch<SetStateAction<string>>;
  setOauthScopes: Dispatch<SetStateAction<string>>;
  outboundPolicy: EmailAccount["outboundPolicy"];
  setOutboundPolicy: Dispatch<SetStateAction<EmailAccount["outboundPolicy"]>>;
  mode: "manual" | "approval" | "autopilot";
  setMode: Dispatch<SetStateAction<"manual" | "approval" | "autopilot">>;
  confidenceThreshold: number;
  setConfidenceThreshold: Dispatch<SetStateAction<number>>;
  testMode: boolean;
  setTestMode: Dispatch<SetStateAction<boolean>>;
  mailAuthType: "password" | "oauth2";
  oauthAccessToken: string;
  setOauthAccessToken: Dispatch<SetStateAction<string>>;
  oauthRefreshToken: string;
  setOauthRefreshToken: Dispatch<SetStateAction<string>>;
  oauthTokenUrl: string;
  oauthAuthorizationUrl: string;
  oauthClientId: string;
  setOauthClientId: Dispatch<SetStateAction<string>>;
  oauthClientSecret: string;
  setOauthClientSecret: Dispatch<SetStateAction<string>>;
  oauthScopes: string;
  oauthRedirectUri: any;
  setOauthRedirectUri: Dispatch<SetStateAction<any>>;
  startOAuthAuthorization: any;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  setImapUser: Dispatch<SetStateAction<string>>;
  imapPass: string;
  setImapPass: Dispatch<SetStateAction<string>>;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  setSmtpUser: Dispatch<SetStateAction<string>>;
  smtpPass: string;
  setSmtpPass: Dispatch<SetStateAction<string>>;
  smtpSecure: boolean;
  senderPolicy: EmailAccount["senderPolicy"];
  setSenderPolicy: Dispatch<SetStateAction<EmailAccount["senderPolicy"]>>;
  requireAuthenticatedSender: boolean;
  setRequireAuthenticatedSender: Dispatch<SetStateAction<boolean>>;
  allowedSenders: string;
  setAllowedSenders: Dispatch<SetStateAction<string>>;
  allowedDomains: string;
  setAllowedDomains: Dispatch<SetStateAction<string>>;
  rules: EmailRule[];
  connectionScope: any;
  maxPerHour: number;
  setMaxPerHour: Dispatch<SetStateAction<number>>;
  maxPerDay: number;
  setMaxPerDay: Dispatch<SetStateAction<number>>;
  maxPerRecipientDaily: number;
  setMaxPerRecipientDaily: Dispatch<SetStateAction<number>>;
  maxCompanyPerHour: number;
  setMaxCompanyPerHour: Dispatch<SetStateAction<number>>;
  maxCompanyPerDay: number;
  setMaxCompanyPerDay: Dispatch<SetStateAction<number>>;
  followupEnabled: boolean;
  setFollowupEnabled: Dispatch<SetStateAction<boolean>>;
  followupDelayDays: number;
  setFollowupDelayDays: Dispatch<SetStateAction<number>>;
  followupMax: number;
  setFollowupMax: Dispatch<SetStateAction<number>>;
  followupAction: "draft" | "auto_send" | "create_task" | "notify_user";
  setFollowupAction: Dispatch<SetStateAction<"draft" | "auto_send" | "create_task" | "notify_user">>;
  greeting: string;
  setGreeting: Dispatch<SetStateAction<string>>;
  signature: string;
  setSignature: Dispatch<SetStateAction<string>>;
  footer: string;
  saving: boolean;
}

export function EmailSettingsTemplatesSection({ setDrawerOpen, t, editingId, saveAccount, accountFormError, notice, selectedCompanyId, setSelectedCompanyId, setAgentId, setRuleAgentId, setRuleWorkflowId, setRuleCreateTask, setAccounts, setAnalytics, companies, emailAddress, accountFieldErrors, setEmailAddress, setAccountFieldErrors, displayName, setDisplayName, agentId, agents, provider, setProvider, setMailAuthType, setImapHost, setImapPort, setImapSecure, setSmtpHost, setSmtpPort, setSmtpSecure, setOauthAuthorizationUrl, accounts, setOauthTokenUrl, setOauthScopes, outboundPolicy, setOutboundPolicy, mode, setMode, confidenceThreshold, setConfidenceThreshold, testMode, setTestMode, mailAuthType, oauthAccessToken, setOauthAccessToken, oauthRefreshToken, setOauthRefreshToken, oauthTokenUrl, oauthAuthorizationUrl, oauthClientId, setOauthClientId, oauthClientSecret, setOauthClientSecret, oauthScopes, oauthRedirectUri, setOauthRedirectUri, startOAuthAuthorization, imapHost, imapPort, imapUser, setImapUser, imapPass, setImapPass, imapSecure, smtpHost, smtpPort, smtpUser, setSmtpUser, smtpPass, setSmtpPass, smtpSecure, senderPolicy, setSenderPolicy, requireAuthenticatedSender, setRequireAuthenticatedSender, allowedSenders, setAllowedSenders, allowedDomains, setAllowedDomains, rules, connectionScope, maxPerHour, setMaxPerHour, maxPerDay, setMaxPerDay, maxPerRecipientDaily, setMaxPerRecipientDaily, maxCompanyPerHour, setMaxCompanyPerHour, maxCompanyPerDay, setMaxCompanyPerDay, followupEnabled, setFollowupEnabled, followupDelayDays, setFollowupDelayDays, followupMax, setFollowupMax, followupAction, setFollowupAction, greeting, setGreeting, signature, setSignature, footer, saving }: EmailSettingsTemplatesSectionProps) {
  return (
<div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>{t("emailSettings.accountDrawer.kicker")}</span>
                <h2>{editingId ? t("emailSettings.accountDrawer.editTitle") : t("emailSettings.accountDrawer.newTitle")}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                aria-label={t("common.close")}
                onClick={() => setDrawerOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={saveAccount} noValidate>
              {accountFormError && (
                <div className="workspace-notice" role="alert" style={{ margin: "0 20px 12px", borderColor: "#dc2626", color: "#991b1b" }}>
                  <strong>{t("emailSettings.accountDrawer.alertNotSaved")}</strong> {accountFormError}
                </div>
              )}
              <section>
                <h3>{t("emailSettings.accountDrawer.sectionAssignment")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>
                  {t("emailSettings.accountDrawer.requiredNotice")}
                </p>
                <label>
                  <span>{t("emailSettings.accountDrawer.mailboxOwnerLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select
                    value={selectedCompanyId}
                    onChange={(e) => {
                      const companyId = e.target.value;
                      setSelectedCompanyId(companyId);
                      writeActiveCompanyId(companyId === "personal" ? "" : companyId);
                      setAgentId("");
                      setRuleAgentId("");
                      setRuleWorkflowId("");
                      setRuleCreateTask(false);
                      const cachedAcc = readCachedAccounts(companyId);
                      if (cachedAcc.length > 0) setAccounts(cachedAcc);
                      const cachedAnal = readCachedAnalytics(companyId);
                      if (cachedAnal) setAnalytics(cachedAnal);
                    }}
                  >
                    <option value="personal">{t("emailSettings.scope.personalScope")}</option>
                    {selectedCompanyId && selectedCompanyId !== "personal" && !companies.some((company) => company.id === selectedCompanyId) && (
                      <option key={selectedCompanyId} value={selectedCompanyId} title={selectedCompanyId}>
                        {selectedCompanyId}
                      </option>
                    )}
                    {companies.map((company) => <option key={company.id} value={company.id} title={company.name}>{company.name}</option>)}
                  </select>
                  <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.mailboxOwnerHint")}</small>
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.emailAddressLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <input
                    type="email"
                    placeholder={t("emailSettings.accountDrawer.emailAddressPlaceholder")}
                    value={emailAddress}
                    data-email-field="emailAddress"
                    aria-invalid={Boolean(accountFieldErrors.emailAddress)}
                    style={accountFieldErrors.emailAddress ? { borderColor: "#dc2626" } : undefined}
                    onChange={(e) => { setEmailAddress(e.target.value); setAccountFieldErrors((current) => ({ ...current, emailAddress: "" })); }}
                  />
                  {accountFieldErrors.emailAddress && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.emailAddress}</small>}
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.displayNameLabel")} <small>{t("emailSettings.accountDrawer.optionalSuffix")}</small></span>
                  <input
                    placeholder={t("emailSettings.accountDrawer.displayNamePlaceholder")}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.assignedAgentLabel")} <small>{t("emailSettings.accountDrawer.optionalSuffix")}</small></span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={selectedCompanyId === "personal"}>
                    <option value="">{t("emailSettings.accountDrawer.unassignedOption")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                  <small style={{ color: "#64748b" }}>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.agentPersonalHint") : t("emailSettings.accountDrawer.agentCompanyHint")}</small>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionMode")}</h3>
                <label>
                  <span>Connection method</span>
                  <select value={provider} onChange={(e) => {
                    const next=e.target.value as EmailAccount["provider"];setProvider(next);
                    if(next==="gmail"){setMailAuthType("oauth2");setImapHost("imap.gmail.com");setImapPort(993);setImapSecure(true);setSmtpHost("smtp.gmail.com");setSmtpPort(465);setSmtpSecure(true);setOauthAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth");setOauthTokenUrl("https://oauth2.googleapis.com/token");setOauthScopes("openid email https://mail.google.com/");}
                    if(next==="microsoft"){setMailAuthType("oauth2");setImapHost("outlook.office365.com");setImapPort(993);setImapSecure(true);setSmtpHost("smtp.office365.com");setSmtpPort(587);setSmtpSecure(false);setOauthAuthorizationUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");setOauthTokenUrl("https://login.microsoftonline.com/common/oauth2/v2.0/token");setOauthScopes("openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send");}
                  }}>
                    <option value="gmail">Gmail</option>
                    <option value="microsoft">Microsoft 365 / Outlook</option>
                    <option value="imap_smtp">IMAP / SMTP</option>
                  </select>
                </label>
                <label>
                  <span>Outbound policy</span>
                  <select value={outboundPolicy} onChange={(e) => setOutboundPolicy(e.target.value as EmailAccount["outboundPolicy"])}>
                    <option value="draft_only">Draft only</option>
                    <option value="approval_required">Approval required (default)</option>
                    <option value="auto_send">Auto send</option>
                  </select>
                  <small style={{ color: "#64748b" }}>New recipients require a draft or approval unless Auto send is explicitly enabled.</small>
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.autoLevelLabel")}</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                    <option value="approval">{t("emailSettings.accountDrawer.modeApproval")}</option>
                    <option value="autopilot">{t("emailSettings.accountDrawer.modeAutopilot")}</option>
                    <option value="manual">{t("emailSettings.accountDrawer.modeManual")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.thresholdLabel").replace("{{percent}}", String(Math.round(confidenceThreshold * 100)))}</span>
                  <input
                    type="range"
                    min="0.5"
                    max="0.95"
                    step="0.05"
                    value={confidenceThreshold}
                    onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                  />
                  <small style={{ color: "#64748b", fontSize: "11.5px" }}>
                    {t("emailSettings.accountDrawer.thresholdHint")}
                  </small>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={testMode}
                    onChange={(e) => setTestMode(e.target.checked)}
                  />
                  <span>{t("emailSettings.accountDrawer.testModeLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionImap")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>{t("emailSettings.accountDrawer.imapDesc")}</p>
                <label>
                  <span>{t("emailSettings.accountDrawer.authLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                  <select value={mailAuthType} onChange={(e) => setMailAuthType(e.target.value as "password" | "oauth2")}>
                    <option value="password">{t("emailSettings.accountDrawer.authPassword")}</option>
                    <option value="oauth2">{t("emailSettings.accountDrawer.authOAuth")}</option>
                  </select>
                </label>
                {mailAuthType === "oauth2" && (
                  <>
                    {accountFieldErrors.oauth && <small role="alert" data-email-field="oauth" tabIndex={-1} style={{ color: "#dc2626" }}>{accountFieldErrors.oauth}</small>}
                    <label><span>{t("emailSettings.accountDrawer.oauthAccessTokenLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthAccessTokenPlaceholderKeep") : t("emailSettings.accountDrawer.oauthAccessTokenPlaceholderNew")} value={oauthAccessToken} onChange={(e) => setOauthAccessToken(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthRefreshTokenLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthRefreshTokenPlaceholderKeep") : t("emailSettings.accountDrawer.oauthRefreshTokenPlaceholderNew")} value={oauthRefreshToken} onChange={(e) => setOauthRefreshToken(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthTokenEndpointLabel")}</span><input placeholder="https://oauth2.googleapis.com/token" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthAuthEndpointLabel")}</span><input placeholder="https://accounts.google.com/o/oauth2/v2/auth" value={oauthAuthorizationUrl} onChange={(e) => setOauthAuthorizationUrl(e.target.value)} /></label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <label><span>{t("emailSettings.accountDrawer.oauthClientIdLabel")}</span><input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} /></label>
                      <label><span>{t("emailSettings.accountDrawer.oauthClientSecretLabel")}</span><input type="password" placeholder={editingId ? t("emailSettings.accountDrawer.oauthClientSecretPlaceholderKeep") : t("emailSettings.accountDrawer.oauthClientSecretPlaceholderNew")} value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} /></label>
                    </div>
                    <label><span>{t("emailSettings.accountDrawer.oauthScopesLabel")}</span><input placeholder="openid email https://mail.google.com/" value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} /></label>
                    <label><span>{t("emailSettings.accountDrawer.oauthRedirectUriLabel")}</span><input value={oauthRedirectUri} onChange={(e) => setOauthRedirectUri(e.target.value)} /></label>
                    <button type="button" className="button-secondary" disabled={!editingId || !oauthAuthorizationUrl || !oauthTokenUrl || !oauthClientId} onClick={() => void startOAuthAuthorization()}>
                      {t("emailSettings.accountDrawer.connectOAuthBtn")}
                    </button>
                  </>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.hostLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="imap.company.com"
                      value={imapHost}
                      data-email-field="imapHost"
                      aria-invalid={Boolean(accountFieldErrors.imapHost)}
                      style={accountFieldErrors.imapHost ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapHost(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapHost: "" })); }}
                    />
                    {accountFieldErrors.imapHost && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapHost}</small>}
                  </label>
                  <label>
                    <span>{t("emailSettings.accountDrawer.portLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      type="number"
                      placeholder="993"
                      value={imapPort}
                      data-email-field="imapPort"
                      aria-invalid={Boolean(accountFieldErrors.imapPort)}
                      style={accountFieldErrors.imapPort ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => setImapPort(parseInt(e.target.value, 10))}
                    />
                    {accountFieldErrors.imapPort && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapPort}</small>}
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.usernameLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="support@company.com"
                      value={imapUser}
                      data-email-field="imapUser"
                      aria-invalid={Boolean(accountFieldErrors.imapUser)}
                      style={accountFieldErrors.imapUser ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapUser(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapUser: "" })); }}
                    />
                    {accountFieldErrors.imapUser && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapUser}</small>}
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>{t("emailSettings.accountDrawer.passwordLabel")} {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={imapPass}
                      data-email-field="imapPass"
                      aria-invalid={Boolean(accountFieldErrors.imapPass)}
                      style={accountFieldErrors.imapPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setImapPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, imapPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.passwordKeepHint")}</small>}
                    {accountFieldErrors.imapPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.imapPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.secureLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSmtp")}</h3>
                <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 12 }}>{t("emailSettings.accountDrawer.smtpDesc")}</p>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpHostLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="smtp.company.com"
                      value={smtpHost}
                      data-email-field="smtpHost"
                      aria-invalid={Boolean(accountFieldErrors.smtpHost)}
                      style={accountFieldErrors.smtpHost ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpHost(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpHost: "" })); }}
                    />
                    {accountFieldErrors.smtpHost && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpHost}</small>}
                  </label>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpPortLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      type="number"
                      placeholder="465"
                      value={smtpPort}
                      data-email-field="smtpPort"
                      aria-invalid={Boolean(accountFieldErrors.smtpPort)}
                      style={accountFieldErrors.smtpPort ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => setSmtpPort(parseInt(e.target.value, 10))}
                    />
                    {accountFieldErrors.smtpPort && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpPort}</small>}
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>{t("emailSettings.accountDrawer.smtpUserLabel")} <strong style={{ color: "#dc2626" }}>*</strong></span>
                    <input
                      placeholder="support@company.com"
                      value={smtpUser}
                      data-email-field="smtpUser"
                      aria-invalid={Boolean(accountFieldErrors.smtpUser)}
                      style={accountFieldErrors.smtpUser ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpUser(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpUser: "" })); }}
                    />
                    {accountFieldErrors.smtpUser && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpUser}</small>}
                  </label>
                  {mailAuthType === "password" && <label>
                    <span>{t("emailSettings.accountDrawer.smtpPassLabel")} {!editingId && <strong style={{ color: "#dc2626" }}>*</strong>}</span>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={smtpPass}
                      data-email-field="smtpPass"
                      aria-invalid={Boolean(accountFieldErrors.smtpPass)}
                      style={accountFieldErrors.smtpPass ? { borderColor: "#dc2626" } : undefined}
                      onChange={(e) => { setSmtpPass(e.target.value); setAccountFieldErrors((current) => ({ ...current, smtpPass: "" })); }}
                    />
                    {editingId && <small style={{ color: "#64748b" }}>{t("emailSettings.accountDrawer.passwordKeepHint")}</small>}
                    {accountFieldErrors.smtpPass && <small role="alert" style={{ color: "#dc2626" }}>{accountFieldErrors.smtpPass}</small>}
                  </label>}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.smtpSecureLabel")}</span>
                </label>
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSafety")}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label><span>Sender policy</span><select value={senderPolicy} onChange={(e) => setSenderPolicy(e.target.value as EmailAccount["senderPolicy"])}>
                    <option value="pairing">Pairing</option>
                    <option value="allowlist">Allowlist (recommended)</option>
                    <option value="open">Open</option>
                    <option value="disabled">Disabled</option>
                  </select></label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 22 }}>
                    <input type="checkbox" checked={requireAuthenticatedSender} onChange={(e) => setRequireAuthenticatedSender(e.target.checked)} />
                    <span>Require authenticated sender (SPF / DKIM / DMARC)</span>
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span>Allowed senders</span>
                    <textarea rows={3} value={allowedSenders} onChange={(e) => setAllowedSenders(e.target.value)} placeholder="andrii@example.com&#10;employee@company.com" />
                  </label>
                  <label>
                    <span>Allowed domains</span>
                    <textarea rows={3} value={allowedDomains} onChange={(e) => setAllowedDomains(e.target.value)} placeholder="company.com" />
                    <small style={{ color: "#64748b" }}>Domain rules are active only when explicitly listed.</small>
                  </label>
                </div>
                <div className="provider-setup-note">
                  <strong>Connection scope: {connectionScope === "account" ? "Entire NPATI Account" : connectionScope === "agent" ? "Specific Agent" : "Specific Company"}</strong>
                  <p>Email content and attachments are treated as external untrusted content. Credentials never enter the Agent context.</p>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <label><span>{t("emailSettings.accountDrawer.emailsPerHour")}</span><input type="number" min="1" value={maxPerHour} onChange={(e) => setMaxPerHour(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.emailsPerDay")}</span><input type="number" min="1" value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.perRecipientDaily")}</span><input type="number" min="1" value={maxPerRecipientDaily} onChange={(e) => setMaxPerRecipientDaily(Number(e.target.value))} /></label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label><span>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.personalPerHour") : t("emailSettings.accountDrawer.companyPerHour")}</span><input type="number" min="1" value={maxCompanyPerHour} onChange={(e) => setMaxCompanyPerHour(Number(e.target.value))} /></label>
                  <label><span>{selectedCompanyId === "personal" ? t("emailSettings.accountDrawer.personalPerDay") : t("emailSettings.accountDrawer.companyPerDay")}</span><input type="number" min="1" value={maxCompanyPerDay} onChange={(e) => setMaxCompanyPerDay(Number(e.target.value))} /></label>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={followupEnabled} onChange={(e) => setFollowupEnabled(e.target.checked)} />
                  <span>{t("emailSettings.accountDrawer.enableFollowup")}</span>
                </label>
                {followupEnabled && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <label><span>{t("emailSettings.accountDrawer.delayDays")}</span><input type="number" min="1" value={followupDelayDays} onChange={(e) => setFollowupDelayDays(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.maximum")}</span><input type="number" min="1" value={followupMax} onChange={(e) => setFollowupMax(Number(e.target.value))} /></label>
                  <label><span>{t("emailSettings.accountDrawer.action")}</span><select value={followupAction} onChange={(e) => setFollowupAction(e.target.value as any)}><option value="draft">{t("emailSettings.accountDrawer.actionDraft")}</option><option value="auto_send">{t("emailSettings.accountDrawer.actionAutoSend")}</option><option value="create_task">{t("emailSettings.accountDrawer.actionCreateTask")}</option><option value="notify_user">{t("emailSettings.accountDrawer.actionNotifyUser")}</option></select></label>
                </div>}
              </section>

              <section>
                <h3>{t("emailSettings.accountDrawer.sectionSignatures")}</h3>
                <label>
                  <span>{t("emailSettings.accountDrawer.greetingLabel")}</span>
                  <input
                    placeholder={t("emailSettings.accountDrawer.greetingPlaceholder")}
                    value={greeting}
                    onChange={(e) => setGreeting(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("emailSettings.accountDrawer.signatureLabel")}</span>
                  <textarea
                    rows={3}
                    placeholder={t("emailSettings.accountDrawer.signaturePlaceholder")}
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                  />
                </label>
              </section>

              <footer style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={saving}
                >
                  {saving ? t("emailSettings.accountDrawer.saving") : editingId ? t("emailSettings.accountDrawer.saveChanges") : t("emailSettings.accountDrawer.connectAccount")}
                </button>
              </footer>
            </form>
          </aside>
        </div>
  );
}
