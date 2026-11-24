import { api, Connection, DiscordSettings, ManageData, Settings, SlackSettings } from "../types";
import { Badge, Toggle } from "../ui";

export interface ConnectionAccessSectionProps {
  draft: Connection;
  settings: Settings;
  data: ManageData;
  connectionId: string;
  pairing: string;
  /** Audit L8: server-issued t.me deep link with an unguessable start token (preferred over the 6-digit code). */
  pairingLink?: string;
  inviteUrl: string;
  qr: string;
  usersText: string;
  setUsersText: (val: string) => void;
  busy: string;
  copyPairing: () => void;
  createPairing: () => void;
  updateSettings: (group: keyof Settings, key: string, value: unknown) => void;
  save: () => void;
  saveAccess: () => void;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ConnectionAccessSection({
  draft,
  settings,
  data,
  connectionId,
  pairing,
  pairingLink,
  inviteUrl,
  qr,
  usersText,
  setUsersText,
  busy,
  copyPairing,
  createPairing,
  updateSettings,
  save,
  saveAccess,
  run,
  t,
}: ConnectionAccessSectionProps) {
  const botUrl = draft.botUsername ? `https://t.me/${draft.botUsername.replace(/^@/, "")}` : "";
  const pairingCode = /^\/connect\s+(\d{6})/i.exec(pairing)?.[1];
  const deepLink = pairingLink || (pairingCode && botUrl ? `${botUrl}?start=connect_${pairingCode}` : botUrl);

  if (draft.channel === "slack") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.access.heading")}</h3>
        {data.webhookUrl && (
          <div className="provider-setup-note">
            <strong>{t("integrationsPage.drawer.manager.access.slackEventsUrl")}</strong>
            <code>{data.webhookUrl}</code>
            <button className="button-secondary" onClick={() => void navigator.clipboard.writeText(data.webhookUrl!)}>{t("integrationsPage.drawer.manager.access.copyWebhook")}</button>
          </div>
        )}
        <div className="provider-setup-note">
          <strong>{t("integrationsPage.drawer.manager.access.dmPairingTitle")}</strong>
          <p>{t("integrationsPage.drawer.manager.access.dmPairingDesc")}</p>
          {pairing ? (
            <>
              <code>{pairing}</code>
              <button className="button-secondary" onClick={() => void copyPairing()}>{t("integrationsPage.drawer.manager.access.copyPairing")}</button>
            </>
          ) : (
            <button className="button-secondary" disabled={!!busy} onClick={() => void createPairing()}>{busy || t("integrationsPage.drawer.manager.access.generateDmPairing")}</button>
          )}
        </div>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.access.dmPolicy")}</label>
          <select value={settings.slack.dmPolicy} onChange={(event) => updateSettings("slack", "dmPolicy", event.target.value as SlackSettings["dmPolicy"])}>
            <option value="pairing">{t("integrationsPage.drawer.manager.access.dmPolicyPairing")}</option>
            <option value="allowlist">{t("integrationsPage.drawer.manager.access.dmPolicyAllowlist")}</option>
            <option value="open">{t("integrationsPage.drawer.manager.access.dmPolicyOpen")}</option>
            <option value="disabled">{t("integrationsPage.drawer.manager.access.dmPolicyDisabled")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.access.allowedSlackIds")}</label>
          <textarea value={settings.slack.allowedUserIds.join("\n")} onChange={(event) => updateSettings("slack", "allowedUserIds", event.target.value.split(/[\n,]+/).map((val) => val.trim()).filter(Boolean))} placeholder="U012ABCDEF" />
          <small>{t("integrationsPage.drawer.manager.access.allowedSlackIdsHint")}</small>
        </div>
        <Toggle checked={settings.groups.enabled} onChange={(value) => updateSettings("groups", "enabled", value)} label={t("integrationsPage.drawer.manager.access.enableSlackChannels")} />
        <Toggle checked={settings.slack.requireMention} onChange={(value) => updateSettings("slack", "requireMention", value)} label={t("integrationsPage.drawer.manager.access.requireMention")} description={t("integrationsPage.drawer.manager.access.requireMentionSlackDesc")} />
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.access.saveAccess")}</button>
      </div>
    );
  }

  if (draft.channel === "discord") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.access.heading")}</h3>
        <div className="provider-setup-note">
          <strong>{t("integrationsPage.drawer.manager.access.installDiscordBot")}</strong>
          <p>{t("integrationsPage.drawer.manager.access.installDiscordDesc")}</p>
          {inviteUrl && <a className="button-primary" href={inviteUrl} target="_blank" rel="noreferrer">{t("integrationsPage.drawer.manager.access.addBotToDiscord")}</a>}
          {pairing ? (
            <>
              <code>{pairing}</code>
              <button className="button-secondary" onClick={() => void copyPairing()}>{t("integrationsPage.drawer.manager.access.copyPairing")}</button>
            </>
          ) : (
            <button className="button-secondary" disabled={!!busy} onClick={() => void createPairing()}>{busy || t("integrationsPage.drawer.manager.access.generateDmPairing")}</button>
          )}
        </div>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.access.dmPolicy")}</label>
          <select value={settings.discord.dmPolicy} onChange={(event) => updateSettings("discord", "dmPolicy", event.target.value as DiscordSettings["dmPolicy"])}>
            <option value="pairing">{t("integrationsPage.drawer.manager.access.dmPolicyPairing")}</option>
            <option value="allowlist">{t("integrationsPage.drawer.manager.access.dmPolicyAllowlist")}</option>
            <option value="open">{t("integrationsPage.drawer.manager.access.dmPolicyOpen")}</option>
            <option value="disabled">{t("integrationsPage.drawer.manager.access.dmPolicyDisabled")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.access.allowedDiscordUsers")}</label>
          <textarea value={settings.discord.allowedUserIds.join("\n")} onChange={(event) => updateSettings("discord", "allowedUserIds", event.target.value.split(/[\n,]+/).map((val) => val.trim()).filter(Boolean))} placeholder={t("integrationsPage.drawer.manager.access.allowedDiscordUsersPlaceholder")} />
          <small>{t("integrationsPage.drawer.manager.access.allowedDiscordUsersHint")}</small>
        </div>
        <Toggle checked={settings.groups.enabled} onChange={(value) => updateSettings("groups", "enabled", value)} label={t("integrationsPage.drawer.manager.access.enableDiscordServers")} />
        <Toggle checked={settings.discord.requireMention} onChange={(value) => updateSettings("discord", "requireMention", value)} label={t("integrationsPage.drawer.manager.access.requireMention")} description={t("integrationsPage.drawer.manager.access.requireMentionDiscordDesc")} />
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.access.saveAccess")}</button>
      </div>
    );
  }

  if (draft.channel === "whatsapp") {
    return (
      <div className="integration-settings-section">
        {draft.provider === "qr" && (
          <div className="whatsapp-self-chat-setting">
            <Toggle checked={settings.access.selfChat} onChange={(value) => updateSettings("access", "selfChat", value)} label={t("integrationsPage.drawer.manager.access.selfChatTitle")} description={t("integrationsPage.drawer.manager.access.selfChatDesc")} />
          </div>
        )}
        <h3>{t("integrationsPage.drawer.manager.access.heading")}</h3>
        {draft.provider === "qr" && draft.status !== "connected" && (
          <div className="telegram-pairing-panel">
            <Badge tone="pending">{t("integrationsPage.drawer.manager.access.whatsappScanBadge")}</Badge>
            <h4>{t("integrationsPage.drawer.manager.access.linkWhatsAppTitle")}</h4>
            <ol>
              <li>{t("integrationsPage.drawer.manager.access.step1")}</li>
              <li>{t("integrationsPage.drawer.manager.access.step2")}</li>
              <li>{t("integrationsPage.drawer.manager.access.step3")}</li>
            </ol>
            {qr ? <img className="whatsapp-qr" src={qr} alt="WhatsApp linked-device QR code" /> : <p>{t("integrationsPage.drawer.manager.access.generatingFreshQr")}</p>}
            <small>{t("integrationsPage.drawer.manager.access.qrHint")}</small>
          </div>
        )}
        <dl className="integration-facts">
          <div><dt>{t("integrationsPage.drawer.manager.access.provider")}</dt><dd>{draft.provider === "cloud" ? t("integrationsPage.drawer.manager.access.providerCloud") : t("integrationsPage.drawer.manager.access.providerLinked")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.access.connectionStatus")}</dt><dd>{draft.status}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.access.linkedIdentity")}</dt><dd>{draft.externalUserId || t("integrationsPage.drawer.manager.access.waitingConnection")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.access.authorization")}</dt><dd>{t("integrationsPage.drawer.manager.access.authDmGroupAllowlist")}</dd></div>
        </dl>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.access.allowedWhatsAppUsers")}</label>
          <textarea value={usersText} onChange={(event) => setUsersText(event.target.value)} placeholder="15551234567@s.whatsapp.net" />
          <small>{t("integrationsPage.drawer.manager.access.allowedWhatsAppHint")}</small>
        </div>
        <div className="drawer-actions">
          <button className="button-primary" disabled={!!busy} onClick={() => void saveAccess()}>{busy || t("integrationsPage.drawer.manager.access.saveAccess")}</button>
          {draft.provider === "qr" && <button className="button-secondary" disabled={!!busy} onClick={() => void run(t("integrationsPage.drawer.manager.access.repairingQr"), () => api("/integrations/whatsapp/" + connectionId + "/repair", { method: "POST" }))}>{t("integrationsPage.drawer.manager.access.repairQr")}</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="integration-settings-section">
      <h3>{t("integrationsPage.drawer.manager.access.heading")}</h3>
      {draft.status === "pending" && (
        <div className="telegram-pairing-panel">
          <Badge tone="pending">{t("integrationsPage.drawer.manager.access.telegramActionRequired")}</Badge>
          <h4>{t("integrationsPage.drawer.manager.access.finishTelegramTitle")}</h4>
          <ol>
            <li>{t("integrationsPage.drawer.manager.access.stepTelegram1", { bot: draft.botUsername || t("integrationsPage.drawer.manager.botTypes.telegram") })}</li>
            <li>{t("integrationsPage.drawer.manager.access.stepTelegram2")}</li>
            <li>{t("integrationsPage.drawer.manager.access.stepTelegram3")}</li>
          </ol>
          {pairing ? (
            <>
              <code>{pairing}</code>
              <div className="drawer-actions">
                {botUrl && <a className="button-primary" href={deepLink} target="_blank" rel="noreferrer">{t("integrationsPage.drawer.manager.access.openBotInTelegram")}</a>}
                <button className="button-secondary" onClick={() => void copyPairing()}>{t("integrationsPage.drawer.manager.access.copyCommand")}</button>
              </div>
              <small>{t("integrationsPage.drawer.manager.access.commandValidityHint")}</small>
            </>
          ) : (
            <>
              <p>{t("integrationsPage.drawer.manager.access.codeHiddenHint")}</p>
              <button className="button-primary" disabled={!!busy} onClick={() => void createPairing()}>{busy || t("integrationsPage.drawer.manager.access.generatePairingCommand")}</button>
            </>
          )}
        </div>
      )}
      <dl className="integration-facts">
        <div><dt>{t("integrationsPage.drawer.manager.access.connectionStatus")}</dt><dd>{draft.status === "pending" ? t("integrationsPage.drawer.manager.access.waitingConnection") : draft.status}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.access.allowedTelegramUser")}</dt><dd>{draft.externalUserId || t("integrationsPage.drawer.manager.access.notPairedYet")}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.access.primaryChat")}</dt><dd>{draft.externalChatId || t("integrationsPage.drawer.manager.access.notPairedYet")}</dd></div>
        <div><dt>{t("integrationsPage.drawer.manager.access.authorization")}</dt><dd>{t("integrationsPage.drawer.manager.access.telegramAuthDesc")}</dd></div>
      </dl>
      <p className="integration-help">{t("integrationsPage.drawer.manager.access.inboundCheckHelp")}</p>
      <div className="drawer-actions">
        <button className="button-secondary" disabled={!!busy} onClick={() => void createPairing()}>{t("integrationsPage.drawer.manager.access.generateNewCommand")}</button>
        <button className="button-danger" disabled={!!busy || !draft.externalUserId} onClick={() => void run(t("integrationsPage.drawer.manager.access.revokingAccess"), () => api(`/integrations/messaging/${connectionId}/revoke`, { method: "POST" }))}>{t("integrationsPage.drawer.manager.access.revokeAccess")}</button>
      </div>
      {pairing && draft.status !== "pending" && (
        <div className="provider-setup-note">
          <strong>{t("integrationsPage.drawer.manager.access.oneTimeCommand")}</strong>
          <code>{pairing}</code>
          <span>{t("integrationsPage.drawer.manager.access.valid15Min")}</span>
        </div>
      )}
    </div>
  );
}
