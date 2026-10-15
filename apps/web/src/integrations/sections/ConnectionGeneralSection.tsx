import { FormEvent } from "react";
import { api, Connection, formatDate } from "../types";

export interface ConnectionGeneralSectionProps {
  draft: Connection;
  setDraft: React.Dispatch<React.SetStateAction<Connection | null>>;
  token: string;
  setToken: (val: string) => void;
  pairing: string;
  busy: string;
  connectionId: string;
  save: () => void;
  replaceToken: (event: FormEvent) => void;
  removeConnection: () => void;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ConnectionGeneralSection({
  draft,
  setDraft,
  token,
  setToken,
  pairing,
  busy,
  connectionId,
  save,
  replaceToken,
  removeConnection,
  run,
  t,
}: ConnectionGeneralSectionProps) {
  return (
    <div className="integration-settings-section">
      <h3>{t("integrationsPage.drawer.manager.general.heading")}</h3>
      <div className="field">
        <label>{t("integrationsPage.drawer.manager.general.connectionName")}</label>
        <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
      </div>
      <dl className="integration-facts">
        <div><dt>{t("integrationsPage.drawer.manager.general.status")}</dt><dd>{draft.status}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.general.bot")}</dt><dd>{draft.botUsername || t("integrationsPage.drawer.manager.general.unknown")}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.general.lastInbound")}</dt><dd>{formatDate(draft.lastInboundAt, t("integrationsPage.drawer.manager.general.never"))}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.general.lastOutbound")}</dt><dd>{formatDate(draft.lastOutboundAt, t("integrationsPage.drawer.manager.general.never"))}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.general.lastError")}</dt><dd>{draft.lastError || t("integrationsPage.drawer.manager.general.none")}</dd></div>
      </dl>
      <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.general.saveName")}</button>
      <form onSubmit={replaceToken} className="integration-subform">
        <h4>{t("integrationsPage.drawer.manager.general.replaceTokenHeading")}</h4>
        <p className="integration-subform-hint">{t("integrationsPage.drawer.manager.general.replaceTokenHint")}</p>
        <div className="replace-token-body">
          <div className="field">
            <input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t("integrationsPage.drawer.manager.general.tokenPlaceholder")} required />
          </div>
          <button className="button-secondary" disabled={!!busy || !token.trim()}>{busy || t("integrationsPage.drawer.manager.general.updateToken")}</button>
        </div>
      </form>
      {pairing && (
        <div className="provider-setup-note">
          <strong>{t("integrationsPage.drawer.manager.general.completePairing")}</strong>
          <code>{pairing}</code>
        </div>
      )}
      <div className="drawer-actions">
        <button className="button-secondary" disabled={!!busy} onClick={() => void run(t("integrationsPage.drawer.manager.general.testing"), () => api(`/integrations/messaging/${connectionId}/test`, { method: "POST" }))}>{t("integrationsPage.drawer.manager.general.test")}</button>
        {draft.status === "paused" ? (
          <button className="button-primary" disabled={!!busy} onClick={() => void run(t("integrationsPage.drawer.manager.general.reconnecting"), () => api(`/integrations/messaging/${connectionId}/reconnect`, { method: "POST" }))}>{t("integrationsPage.drawer.manager.general.reconnect")}</button>
        ) : (
          <button className="button-secondary" disabled={!!busy} onClick={() => void run(t("integrationsPage.drawer.manager.general.disconnecting"), () => api(`/integrations/messaging/${connectionId}/disconnect`, { method: "POST" }))}>{t("integrationsPage.drawer.manager.general.disconnect")}</button>
        )}
        <button className="button-danger" disabled={!!busy} onClick={() => void removeConnection()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
          {t("integrationsPage.drawer.manager.general.removeConnection")}
        </button>
      </div>
    </div>
  );
}
