import { Company, Connection, DiscordBinding, ManageData, Settings, SlackBinding } from "../types";
import { Toggle } from "../ui";

export interface ConnectionGroupsSectionProps {
  draft: Connection;
  settings: Settings;
  data: ManageData;
  companies: Company[];
  groupsText: string;
  setGroupsText: (val: string) => void;
  busy: string;
  updateSettings: (group: keyof Settings, key: string, value: unknown) => void;
  setDiscordBinding: (guildId: string, channelId: string, patch: Partial<DiscordBinding>) => void;
  setSlackBinding: (workspaceId: string, channelId: string, patch: Partial<SlackBinding>) => void;
  save: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ConnectionGroupsSection({
  draft,
  settings,
  data,
  companies,
  groupsText,
  setGroupsText,
  busy,
  updateSettings,
  setDiscordBinding,
  setSlackBinding,
  save,
  t,
}: ConnectionGroupsSectionProps) {
  if (draft.channel === "slack") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.groups.slackHeading")}</h3>
        <p className="integration-help">{t("integrationsPage.drawer.manager.groups.slackHelp")}</p>
        {data.slackCatalog?.workspaces.length ? data.slackCatalog.workspaces.map((workspace) => (
          <div className="discord-guild-card" key={workspace.id}>
            <label className="discord-guild-head">
              <input type="checkbox" checked={settings.slack.allowedWorkspaceIds.includes(workspace.id)} onChange={(event) => updateSettings("slack", "allowedWorkspaceIds", event.target.checked ? [...new Set([...settings.slack.allowedWorkspaceIds, workspace.id])] : settings.slack.allowedWorkspaceIds.filter((id) => id !== workspace.id))} />
              <strong>{workspace.name}</strong>
              <code>{workspace.id}</code>
            </label>
            <div className="discord-channel-list">
              {workspace.channels.map((channel) => {
                const binding = settings.slack.channelBindings.find((item) => item.workspaceId === workspace.id && item.channelId === channel.id);
                const allowed = settings.slack.allowedChannelIds.length === 0 || settings.slack.allowedChannelIds.includes(channel.id);
                return (
                  <div className="discord-channel-row slack-channel-row" key={channel.id}>
                    <label>
                      <input type="checkbox" checked={allowed} onChange={(event) => {
                        const all = data.slackCatalog!.workspaces.flatMap((item) => item.channels.map((entry) => entry.id));
                        updateSettings("slack", "allowedChannelIds", event.target.checked ? [...new Set([...settings.slack.allowedChannelIds, channel.id])] : (settings.slack.allowedChannelIds.length ? settings.slack.allowedChannelIds.filter((id) => id !== channel.id) : all.filter((id) => id !== channel.id)));
                      }} />
                      <strong>{channel.type}: {channel.name}</strong>
                    </label>
                    <select value={binding?.companyId || ""} onChange={(event) => setSlackBinding(workspace.id, channel.id, { companyId: event.target.value || null, agentId: null })}>
                      <option value="">{t("integrationsPage.drawer.manager.groups.defaultConnectionScope")}</option>
                      {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
                    </select>
                    <input value={binding?.agentId || ""} onChange={(event) => setSlackBinding(workspace.id, channel.id, { agentId: event.target.value || null })} placeholder={t("integrationsPage.drawer.manager.groups.optionalAgentId")} />
                    <label>
                      <input type="checkbox" checked={binding?.requireMention ?? settings.slack.requireMention} onChange={(event) => setSlackBinding(workspace.id, channel.id, { requireMention: event.target.checked })} />
                      {t("integrationsPage.drawer.manager.groups.requireMentionCheckbox")}
                    </label>
                    <input value={(binding?.allowedUserIds || []).join(", ")} onChange={(event) => setSlackBinding(workspace.id, channel.id, { allowedUserIds: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} placeholder={t("integrationsPage.drawer.manager.groups.allowedMemberIdsOptional")} />
                    <input value={(binding?.permissions || []).join(", ")} onChange={(event) => setSlackBinding(workspace.id, channel.id, { permissions: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} placeholder={t("integrationsPage.drawer.manager.groups.allowedPermissionsOptional")} />
                  </div>
                );
              })}
            </div>
          </div>
        )) : (
          <div className="empty-inline">
            <strong>{t("integrationsPage.drawer.manager.groups.noSlackChannels")}</strong>
            <span>{t("integrationsPage.drawer.manager.groups.noSlackChannelsHint")}</span>
          </div>
        )}
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.groups.saveWorkspacesChannels")}</button>
      </div>
    );
  }

  if (draft.channel === "discord") {
    return (
      <div className="integration-settings-section">
        <h3>{t("integrationsPage.drawer.manager.groups.discordHeading")}</h3>
        <p className="integration-help">{t("integrationsPage.drawer.manager.groups.discordHelp")}</p>
        {data.discordCatalog?.guilds.length ? data.discordCatalog.guilds.map((guild) => (
          <div className="discord-guild-card" key={guild.id}>
            <label className="discord-guild-head">
              <input type="checkbox" checked={settings.discord.allowedGuildIds.includes(guild.id)} onChange={(event) => updateSettings("discord", "allowedGuildIds", event.target.checked ? [...new Set([...settings.discord.allowedGuildIds, guild.id])] : settings.discord.allowedGuildIds.filter((id) => id !== guild.id))} />
              <strong>{guild.name}</strong>
              <code>{guild.id}</code>
            </label>
            <div className="discord-role-list">
              <span>{t("integrationsPage.drawer.manager.groups.allowedRoles")}</span>
              {guild.roles.filter((role) => role.id !== guild.id).map((role) => (
                <label key={role.id}>
                  <input type="checkbox" checked={settings.discord.allowedRoleIds.includes(role.id)} onChange={(event) => updateSettings("discord", "allowedRoleIds", event.target.checked ? [...new Set([...settings.discord.allowedRoleIds, role.id])] : settings.discord.allowedRoleIds.filter((id) => id !== role.id))} />
                  {role.name}
                </label>
              ))}
            </div>
            <div className="discord-channel-list">
              {guild.channels.map((channel) => {
                const binding = settings.discord.channelBindings.find((item) => item.guildId === guild.id && item.channelId === channel.id);
                const allowed = settings.discord.allowedChannelIds.length === 0 || settings.discord.allowedChannelIds.includes(channel.id);
                return (
                  <div className="discord-channel-row" key={channel.id}>
                    <label>
                      <input type="checkbox" checked={allowed} onChange={(event) => {
                        const all = data.discordCatalog!.guilds.flatMap((item) => item.channels.map((entry) => entry.id));
                        updateSettings("discord", "allowedChannelIds", event.target.checked ? [...new Set([...settings.discord.allowedChannelIds, channel.id])] : (settings.discord.allowedChannelIds.length ? settings.discord.allowedChannelIds.filter((id) => id !== channel.id) : all.filter((id) => id !== channel.id)));
                      }} />
                      <strong>{channel.parentId ? t("integrationsPage.drawer.manager.groups.threadLabel") : t("integrationsPage.drawer.manager.groups.channelLabel")}: {channel.name}</strong>
                    </label>
                    <select value={binding?.companyId || ""} onChange={(event) => setDiscordBinding(guild.id, channel.id, { companyId: event.target.value || null, agentId: null })}>
                      <option value="">{t("integrationsPage.drawer.manager.groups.defaultConnectionScope")}</option>
                      {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
                    </select>
                    <input value={binding?.agentId || ""} onChange={(event) => setDiscordBinding(guild.id, channel.id, { agentId: event.target.value || null })} placeholder={t("integrationsPage.drawer.manager.groups.optionalAgentId")} />
                    <label>
                      <input type="checkbox" checked={binding?.requireMention ?? settings.discord.requireMention} onChange={(event) => setDiscordBinding(guild.id, channel.id, { requireMention: event.target.checked })} />
                      {t("integrationsPage.drawer.manager.groups.requireMentionCheckbox")}
                    </label>
                    <input value={(binding?.permissions || []).join(", ")} onChange={(event) => setDiscordBinding(guild.id, channel.id, { permissions: event.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} placeholder={t("integrationsPage.drawer.manager.groups.allowedPermissionsOptional")} />
                  </div>
                );
              })}
            </div>
          </div>
        )) : (
          <div className="empty-inline">
            <strong>{t("integrationsPage.drawer.manager.groups.noDiscordServers")}</strong>
            <span>{t("integrationsPage.drawer.manager.groups.noDiscordServersHint")}</span>
          </div>
        )}
        <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.groups.saveServersChannels")}</button>
      </div>
    );
  }

  return (
    <div className="integration-settings-section">
      <h3>{t("integrationsPage.drawer.manager.groups.telegramHeading")}</h3>
      <Toggle checked={settings.groups.enabled} onChange={(value) => updateSettings("groups", "enabled", value)} label={t("integrationsPage.drawer.manager.groups.enableTelegramGroups")} description={t("integrationsPage.drawer.manager.groups.telegramGroupsDesc")} />
      <Toggle checked={settings.groups.mentionRequired} onChange={(value) => updateSettings("groups", "mentionRequired", value)} label={t("integrationsPage.drawer.manager.groups.mentionRequired")} description={t("integrationsPage.drawer.manager.groups.mentionRequiredDesc")} />
      <div className="field">
        <label>{t("integrationsPage.drawer.manager.groups.allowedChatIds")}</label>
        <textarea value={groupsText} onChange={(event) => setGroupsText(event.target.value)} placeholder="-1001234567890&#10;-1009876543210" />
        <small>{t("integrationsPage.drawer.manager.groups.allowedChatIdsHint")}</small>
      </div>
      <div className="field">
        <label>{t("integrationsPage.drawer.manager.groups.replyBehavior")}</label>
        <select value={settings.groups.replyMode} onChange={(event) => updateSettings("groups", "replyMode", event.target.value)}>
          <option value="reply">{t("integrationsPage.drawer.manager.groups.replyWithReference")}</option>
          <option value="plain">{t("integrationsPage.drawer.manager.groups.sendWithoutReference")}</option>
        </select>
      </div>
      <div className="integration-topic-list">
        <strong>{t("integrationsPage.drawer.manager.groups.observedChats")}</strong>
        {data.sessions.length ? data.sessions.map((item) => (
          <span key={item.id}>
            {t("integrationsPage.drawer.manager.groups.chatLabel")} {item.externalChatId}{item.externalThreadId ? ` · ${t("integrationsPage.drawer.manager.groups.topicLabel")} ${item.externalThreadId}` : ` · ${t("integrationsPage.drawer.manager.groups.mainThreadLabel")}`}
          </span>
        )) : <small>{t("integrationsPage.drawer.manager.groups.noSessionsObserved")}</small>}
      </div>
      <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.groups.saveGroupSettings")}</button>
    </div>
  );
}
