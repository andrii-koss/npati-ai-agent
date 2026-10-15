import { Agent, Company, Connection, ConnectionScope, ManageData, ManageSection, Settings } from "../types";
import { Toggle } from "../ui";

export interface ConnectionAdvancedSectionsProps {
  section: ManageSection;
  draft: Connection;
  setDraft: React.Dispatch<React.SetStateAction<Connection | null>>;
  settings: Settings;
  data: ManageData;
  companies: Company[];
  agents: Agent[];
  activeCompanyId?: string | null;
  activeAgentId?: string | null;
  busy: string;
  updateSettings: (group: keyof Settings, key: string, value: unknown) => void;
  save: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ConnectionAdvancedSections({
  section,
  draft,
  setDraft,
  settings,
  data,
  companies,
  agents,
  activeCompanyId,
  activeAgentId,
  busy,
  updateSettings,
  save,
  t,
}: ConnectionAdvancedSectionsProps) {
  if (section === "context") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.context.heading")}</h3>
        <div className="field">
          <label>{t("integrationsPage.drawer.manager.context.defaultScope")}</label>
          <select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as ConnectionScope, companyId: event.target.value === "account" ? null : draft.companyId || companies[0]?.id || null, agentId: event.target.value === "agent" ? draft.agentId : null })}>
            <option value="account">{t("integrationsPage.scopes.account")}</option>
            <option value="company">{t("integrationsPage.scopes.company")}</option>
            <option value="agent">{t("integrationsPage.scopes.agent")}</option>
          </select>
        </div>
        {draft.scope !== "account" && (
          <div className="field">
            <label>{t("integrationsPage.drawer.manager.context.companyBinding")}</label>
            <select value={draft.companyId || ""} onChange={(event) => setDraft({ ...draft, companyId: event.target.value, agentId: null })}>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </div>
        )}
        {draft.scope === "agent" && (
          <div className="field">
            <label>{t("integrationsPage.drawer.manager.context.agentBinding")}</label>
            <select value={draft.agentId || ""} onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}>
              <option value="">{t("integrationsPage.drawer.manager.context.selectAgent")}</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}
            </select>
          </div>
        )}
        <dl className="integration-facts">
          <div><dt>{t("integrationsPage.drawer.manager.context.activeCompany")}</dt><dd>{companies.find((item) => item.id === activeCompanyId)?.name || t("integrationsPage.drawer.manager.context.entireAccount")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.context.activeAgent")}</dt><dd>{agents.find((item) => item.id === activeAgentId)?.name || t("integrationsPage.drawer.manager.context.automaticAgent")}</dd></div>
        </dl>
        <button className="button-primary" disabled={!!busy || (draft.scope !== "account" && !draft.companyId) || (draft.scope === "agent" && !draft.agentId)} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.context.saveBinding")}</button>
      </div>
    );
  }

  if (section === "notifications") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.notifications.heading")}</h3>
        <Toggle checked={settings.notifications.automationResults} onChange={(value) => updateSettings("notifications", "automationResults", value)} label={t("integrationsPage.drawer.manager.notifications.automationResults")} />
        <Toggle checked={settings.notifications.backgroundResults} onChange={(value) => updateSettings("notifications", "backgroundResults", value)} label={t("integrationsPage.drawer.manager.notifications.backgroundResults")} description={t("integrationsPage.drawer.manager.notifications.backgroundResultsDesc")} />
        <Toggle checked={settings.notifications.errors} onChange={(value) => updateSettings("notifications", "errors", value)} label={t("integrationsPage.drawer.manager.notifications.errors")} />
        <Toggle checked={settings.notifications.status} onChange={(value) => updateSettings("notifications", "status", value)} label={t("integrationsPage.drawer.manager.notifications.status")} />
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.notifications.saveNotifications")}</button>
      </div>
    );
  }

  if (section === "commands") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.commands.heading")}</h3>
        <p className="integration-help">
          {t("integrationsPage.drawer.manager.commands.helpText", {
            type: draft.channel === "discord"
              ? t("integrationsPage.drawer.manager.commands.discordType")
              : draft.channel === "slack"
                ? t("integrationsPage.drawer.manager.commands.slackType")
                : t("integrationsPage.drawer.manager.commands.telegramType"),
          })}
        </p>
        <div className="integration-command-grid">{data.commands.map((command) => <code key={command}>/{command}</code>)}</div>
      </div>
    );
  }

  if (section === "media") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.media.heading")}</h3>
        <Toggle checked={settings.media.images} onChange={(value) => updateSettings("media", "images", value)} label={t("integrationsPage.drawer.media.images")} />
        <Toggle checked={settings.media.documents} onChange={(value) => updateSettings("media", "documents", value)} label={t("integrationsPage.drawer.media.documents")} description={t("integrationsPage.drawer.media.documentsDesc")} />
        <Toggle checked={settings.media.audio} onChange={(value) => updateSettings("media", "audio", value)} label={t("integrationsPage.drawer.media.audio")} description={t("integrationsPage.drawer.media.audioDesc")} />
        <Toggle checked={settings.media.outbound} onChange={(value) => updateSettings("media", "outbound", value)} label={t("integrationsPage.drawer.media.outbound")} />
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.media.saveMedia")}</button>
      </div>
    );
  }

  if (section === "advanced") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.advanced.heading")}</h3>
        <Toggle checked={settings.delivery.typing} onChange={(value) => updateSettings("delivery", "typing", value)} label={t("integrationsPage.drawer.manager.advanced.typing")} />
        <Toggle checked={settings.delivery.progressive} onChange={(value) => updateSettings("delivery", "progressive", value)} label={t("integrationsPage.drawer.manager.advanced.progressive")} />
        <dl className="integration-facts">
          <div><dt>{t("integrationsPage.drawer.manager.advanced.chunking")}</dt><dd>{data.capabilities.longMessageChunking ? t("integrationsPage.drawer.manager.advanced.statusActive") : t("integrationsPage.drawer.manager.advanced.statusUnavailable")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.advanced.retry")}</dt><dd>{data.capabilities.retryBackoff ? t("integrationsPage.drawer.manager.advanced.statusActive") : t("integrationsPage.drawer.manager.advanced.statusUnavailable")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.advanced.dedup")}</dt><dd>{data.capabilities.deduplication ? t("integrationsPage.drawer.manager.advanced.statusPersistent") : t("integrationsPage.drawer.manager.advanced.statusUnavailable")}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.advanced.transport")}</dt><dd>{data.transport}</dd></div>
          <div><dt>{t("integrationsPage.drawer.manager.advanced.persistence")}</dt><dd>{data.capabilities.sessionPersistence ? t("integrationsPage.drawer.manager.advanced.statusDbBacked") : t("integrationsPage.drawer.manager.advanced.statusUnavailable")}</dd></div>
        </dl>
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.advanced.saveDelivery")}</button>
      </div>
    );
  }

  return null;
}
