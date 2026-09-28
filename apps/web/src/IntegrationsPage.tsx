import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { getChannelIcon } from "./integration-icons";
import { useTranslation } from "./i18n";

type Company = { id: string; name: string };
type Agent = { id: string; name: string; role: string; isActive: boolean };
type Channel = { id: string; name: string; available: boolean; capabilities: string[] };
type ConnectionScope = "account" | "company" | "agent";
type DiscordBinding = { guildId: string; channelId: string; companyId?: string | null; agentId?: string | null; requireMention?: boolean; permissions: string[] };
type SlackBinding = { workspaceId: string; channelId: string; companyId?: string | null; agentId?: string | null; requireMention?: boolean; allowedUserIds: string[]; permissions: string[] };
type SlackSettings = { dmPolicy: "pairing" | "allowlist" | "open" | "disabled"; allowedUserIds: string[]; allowedWorkspaceIds: string[]; allowedChannelIds: string[]; requireMention: boolean; channelBindings: SlackBinding[] };
type DiscordSettings = { dmPolicy: "pairing" | "allowlist" | "open" | "disabled"; allowedUserIds: string[]; allowedGuildIds: string[]; allowedChannelIds: string[]; allowedRoleIds: string[]; requireMention: boolean; channelBindings: DiscordBinding[] };
type Settings = { access: { allowedUserIds: string[]; selfChat: boolean }; discord: DiscordSettings; slack: SlackSettings; groups: { enabled: boolean; allowedChatIds: string[]; mentionRequired: boolean; replyMode: "reply" | "plain" }; notifications: { automationResults: boolean; backgroundResults: boolean; errors: boolean; status: boolean }; media: { images: boolean; documents: boolean; audio: boolean; outbound: boolean }; delivery: { typing: boolean; progressive: boolean } };
type Connection = { id: string; companyId?: string | null; agentId?: string | null; scope: ConnectionScope; activeCompanyId?: string | null; activeAgentId?: string | null; channel: string; provider?: "qr" | "cloud" | null; displayName: string; status: string; botUsername?: string | null; externalUserId?: string | null; externalChatId?: string | null; externalThreadId?: string | null; lastInboundAt?: string | null; lastOutboundAt?: string | null; lastError?: string | null; createdAt?: string; updatedAt?: string; settings?: Settings };
type Session = { id: string; externalChatId: string; externalThreadId: string; activeCompanyId?: string | null; activeAgentId?: string | null; runtimeConversationId?: string | null; updatedAt: string };
type DiscordCatalog = { guilds: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number; parentId?: string | null }>; roles: Array<{ id: string; name: string }> }> };
type SlackCatalog = { workspaces: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }> };
type ManageData = { connection: Connection; sessions: Session[]; commands: string[]; transport: string; webhookUrl?: string; discordCatalog?: DiscordCatalog; slackCatalog?: SlackCatalog; capabilities: { typing: boolean; progressiveEditing: boolean; longMessageChunking: boolean; retryBackoff: boolean; deduplication: boolean; sessionPersistence: boolean; inboundMedia: string[]; outboundMedia: string[]; reactions?: boolean; voiceChannel?: boolean } };
type ManageSection = "general" | "access" | "context" | "groups" | "notifications" | "commands" | "media" | "advanced";

const defaults = (): Settings => ({ access: { allowedUserIds: [], selfChat: false }, discord: { dmPolicy: "pairing", allowedUserIds: [], allowedGuildIds: [], allowedChannelIds: [], allowedRoleIds: [], requireMention: true, channelBindings: [] }, slack: { dmPolicy: "pairing", allowedUserIds: [], allowedWorkspaceIds: [], allowedChannelIds: [], requireMention: true, channelBindings: [] }, groups: { enabled: true, allowedChatIds: [], mentionRequired: true, replyMode: "reply" }, notifications: { automationResults: true, backgroundResults: true, errors: true, status: true }, media: { images: true, documents: true, audio: true, outbound: true }, delivery: { typing: true, progressive: true } });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body as T;
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase();
const formatDate = (value?: string | null, neverText = "Never") => value ? new Date(value).toLocaleString() : neverText;

const getScopeLabel = (scope: ConnectionScope, t: (key: any, params?: Record<string, string | number>) => string) => {
  if (scope === "account") return t("integrationsPage.scopes.account");
  if (scope === "company") return t("integrationsPage.scopes.company");
  return t("integrationsPage.scopes.agent");
};

const capabilityKeyMap: Record<string, string> = {
  "Chat": "chat",
  "Tasks": "tasks",
  "Files": "files",
  "Automations": "automations",
  "Company actions": "companyActions",
  "DMs": "dms",
  "Servers": "servers",
  "Threads": "threads",
  "Commands": "commands",
  "Channels": "channels",
  "Voice": "voice",
  "Groups": "groups",
  "Chat Runtime": "chatRuntime",
  "Company Agents": "companyAgents",
  "Approvals": "approvals",
};

function ChannelIcon({ channel, size }: { channel: Channel; size?: "small" | "large" }) {
  const icon = getChannelIcon(channel.id);
  const [failed, setFailed] = useState(false);
  return (
    <span className={`provider-avatar${size ? ` ${size}` : ""}`} aria-hidden="true">
      <span className="provider-initials">{initial(channel.name)}</span>
      {icon && !failed && (
        <img src={icon} alt="" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ai-badge ${tone}`}>{children}</span>;
}

function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={`integration-toggle${disabled ? " disabled" : ""}`}>
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

const createFallbackManageData = (conn: Connection): ManageData => ({
  connection: { ...conn, settings: conn.settings || defaults() },
  sessions: [],
  commands: ["companies", "company", "agents", "agent", "context", "account", "new", "reset", "stop", "status", "runs", "tasks", "approvals", "approve", "deny"],
  transport: "webhook",
  capabilities: {
    typing: true,
    progressiveEditing: true,
    longMessageChunking: true,
    retryBackoff: true,
    deduplication: true,
    sessionPersistence: true,
    inboundMedia: ["images", "documents", "audio"],
    outboundMedia: ["images", "documents"],
  },
});

function ConnectionManager({ connectionId, companies, initialConnection, initialPairingCommand = "", onChanged, onRemoved }: { connectionId: string; companies: Company[]; initialConnection?: Connection | null; initialPairingCommand?: string; onChanged: () => Promise<void>; onRemoved: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<ManageData | null>(() => initialConnection ? createFallbackManageData(initialConnection) : null);
  const [section, setSection] = useState<ManageSection>(() => initialConnection?.status === "pending" ? "access" : "general");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState(initialPairingCommand);
  const [inviteUrl, setInviteUrl] = useState("");
  const [draft, setDraft] = useState<Connection | null>(() => initialConnection ? { ...initialConnection, settings: initialConnection.settings ? { ...initialConnection.settings, access: { ...defaults().access, ...initialConnection.settings.access }, discord: { ...defaults().discord, ...initialConnection.settings.discord }, slack: { ...defaults().slack, ...initialConnection.settings.slack } } : defaults() } : null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groupsText, setGroupsText] = useState(() => (initialConnection?.settings?.groups?.allowedChatIds || []).join("\n"));
  const [usersText, setUsersText] = useState(() => (initialConnection?.settings?.access?.allowedUserIds || []).join("\n"));
  const [qr, setQr] = useState("");

  const load = async () => {
    const result = await api<ManageData>(`/integrations/messaging/${connectionId}/manage`);
    const settings = { ...defaults(), ...(result.connection.settings || {}), access: { ...defaults().access, ...result.connection.settings?.access }, discord: { ...defaults().discord, ...result.connection.settings?.discord }, slack: { ...defaults().slack, ...result.connection.settings?.slack } };
    result.connection.settings = settings;
    setData(result);
    setDraft((current) => current ? { ...result.connection, displayName: current.displayName, scope: current.scope, companyId: current.companyId, agentId: current.agentId, settings: current.settings ? { ...settings, ...current.settings, access: { ...settings.access, ...current.settings.access }, discord: { ...settings.discord, ...current.settings.discord }, slack: { ...settings.slack, ...current.settings.slack } } : settings } : result.connection);
    setGroupsText((current) => current || settings.groups.allowedChatIds.join("\n"));
    setUsersText((current) => current || settings.access.allowedUserIds.join("\n"));
    if (result.connection.channel === "whatsapp" && result.connection.provider === "qr") {
      void api<{ qrDataUrl?: string }>(`/integrations/whatsapp/${connectionId}/qr`).then((value) => setQr(value.qrDataUrl || ""));
    }
    if (result.connection.channel === "discord") {
      void api<{ inviteUrl: string }>(`/integrations/discord/${connectionId}/setup`).then((value) => setInviteUrl(value.inviteUrl)).catch(() => undefined);
    }
    return result;
  };

  useEffect(() => {
    void load().then((result) => {
      if (result.connection.status === "pending") setSection("access");
    }).catch((error) => setMessage(error.message));
  }, [connectionId]);

  useEffect(() => {
    if (data?.connection.status !== "pending") return;
    const timer = window.setInterval(() => void load().catch((error) => setMessage(error.message)), 5000);
    return () => window.clearInterval(timer);
  }, [connectionId, data?.connection.status]);

  const agentCompanyId = draft?.companyId || data?.sessions[0]?.activeCompanyId || draft?.activeCompanyId;
  useEffect(() => {
    if (!agentCompanyId) {
      setAgents([]);
      return;
    }
    void api<{ agents: Agent[] }>(`/companies/${agentCompanyId}/agents`).then((result) => setAgents(result.agents.filter((agent) => agent.isActive))).catch(() => setAgents([]));
  }, [agentCompanyId]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage("");
    try {
      await action();
      await load();
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const updateSettings = (group: keyof Settings, key: string, value: unknown) => setDraft((current) => current ? { ...current, settings: { ...(current.settings || defaults()), [group]: { ...(current.settings || defaults())[group], [key]: value } } } : current);
  const setDiscordBinding = (guildId: string, channelId: string, patch: Partial<DiscordBinding>) => setDraft((current) => {
    if (!current) return current;
    const currentSettings = current.settings || defaults();
    const existing = currentSettings.discord.channelBindings.find((item) => item.guildId === guildId && item.channelId === channelId) || { guildId, channelId, permissions: [] };
    const channelBindings = [...currentSettings.discord.channelBindings.filter((item) => !(item.guildId === guildId && item.channelId === channelId)), { ...existing, ...patch }];
    return { ...current, settings: { ...currentSettings, discord: { ...currentSettings.discord, channelBindings } } };
  });

  const setSlackBinding = (workspaceId: string, channelId: string, patch: Partial<SlackBinding>) => setDraft((current) => {
    if (!current) return current;
    const currentSettings = current.settings || defaults();
    const existing = currentSettings.slack.channelBindings.find((item) => item.workspaceId === workspaceId && item.channelId === channelId) || { workspaceId, channelId, allowedUserIds: [], permissions: [] };
    const channelBindings = [...currentSettings.slack.channelBindings.filter((item) => !(item.workspaceId === workspaceId && item.channelId === channelId)), { ...existing, ...patch }];
    return { ...current, settings: { ...currentSettings, slack: { ...currentSettings.slack, channelBindings } } };
  });

  const save = () => run(t("integrationsPage.drawer.manager.general.savingName"), async () => {
    if (!draft) return;
    const settings = { ...(draft.settings || defaults()), groups: { ...(draft.settings || defaults()).groups, allowedChatIds: groupsText.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean) } };
    await api(`/integrations/messaging/${connectionId}`, { method: "PATCH", body: JSON.stringify({ displayName: draft.displayName, scope: draft.scope, companyId: draft.companyId || null, agentId: draft.agentId || null, settings }) });
    setMessage(t("integrationsPage.drawer.manager.general.savedMessage"));
  });

  const saveAccess = () => run(t("integrationsPage.drawer.manager.access.savingAccess"), async () => {
    if (!draft) return;
    const allowedUserIds = usersText.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    const settings = { ...(draft.settings || defaults()), access: { ...(draft.settings || defaults()).access, allowedUserIds } };
    await api("/integrations/messaging/" + connectionId, { method: "PATCH", body: JSON.stringify({ displayName: draft.displayName, scope: draft.scope, companyId: draft.companyId || null, agentId: draft.agentId || null, settings }) });
    setMessage(draft.channel === "slack" ? t("integrationsPage.drawer.manager.access.accessSavedSlack") : t("integrationsPage.drawer.manager.access.accessSavedWhatsApp"));
  });

  const replaceToken = (event: FormEvent) => {
    event.preventDefault();
    void run(t("integrationsPage.drawer.manager.general.updatingToken"), async () => {
      const result = await api<{ pairingCommand: string }>(`/integrations/messaging/${connectionId}/token`, { method: "POST", body: JSON.stringify({ botToken: token }) });
      setToken("");
      setPairing(result.pairingCommand);
      setMessage(t("integrationsPage.drawer.manager.general.tokenUpdatedMessage"));
    });
  };

  const removeConnection = async () => {
    setBusy(t("integrationsPage.drawer.manager.general.removingConnection"));
    setMessage("");
    try {
      await api(`/integrations/messaging/${connectionId}`, { method: "DELETE" });
      await onChanged();
      onRemoved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy("");
    }
  };

  if (!data || !draft) return null;
  const settings = draft.settings || defaults();
  const activeSession = data.sessions[0];
  const activeCompanyId = activeSession?.activeCompanyId || draft.activeCompanyId;
  const activeAgentId = activeSession?.activeAgentId || draft.activeAgentId;
  const botUrl = draft.botUsername ? `https://t.me/${draft.botUsername.replace(/^@/, "")}` : "";
  const pairingCode = /^\/connect\s+(\d{6})/i.exec(pairing)?.[1];
  const deepLink = pairingCode && botUrl ? `${botUrl}?start=connect_${pairingCode}` : botUrl;

  const createPairing = () => run(t("integrationsPage.drawer.manager.access.creatingPairing"), async () => {
    const result = await api<{ pairingCommand: string }>(`/integrations/messaging/${connectionId}/pairing`, { method: "POST" });
    setPairing(result.pairingCommand);
    setMessage(t("integrationsPage.drawer.manager.access.pairingCreatedMessage"));
  });

  const copyPairing = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing);
      setMessage(t("integrationsPage.drawer.manager.access.pairingCopied"));
    } catch {
      setMessage(t("integrationsPage.drawer.manager.access.manualCopyFallback", { command: pairing }));
    }
  };

  const sectionLabel = (item: ManageSection) => {
    if (item === "general") return t("integrationsPage.drawer.manager.sectionTabs.general");
    if (item === "access") return t("integrationsPage.drawer.manager.sectionTabs.access");
    if (item === "context") return t("integrationsPage.drawer.manager.sectionTabs.context");
    if (item === "groups") {
      if (draft.channel === "discord") return t("integrationsPage.drawer.manager.sectionTabs.serversChannels");
      if (draft.channel === "slack") return t("integrationsPage.drawer.manager.sectionTabs.workspacesChannels");
      return t("integrationsPage.drawer.manager.sectionTabs.groups");
    }
    if (item === "notifications") return t("integrationsPage.drawer.manager.sectionTabs.notifications");
    if (item === "commands") return t("integrationsPage.drawer.manager.sectionTabs.commands");
    if (item === "media") return t("integrationsPage.drawer.manager.sectionTabs.media");
    if (item === "advanced") return t("integrationsPage.drawer.manager.sectionTabs.advanced");
    return item;
  };

  const defaultBotLabel = draft.channel === "discord"
    ? t("integrationsPage.drawer.manager.botTypes.discord")
    : draft.channel === "whatsapp"
      ? t("integrationsPage.drawer.manager.botTypes.whatsapp")
      : draft.channel === "slack"
        ? t("integrationsPage.drawer.manager.botTypes.slack")
        : t("integrationsPage.drawer.manager.botTypes.telegram");

  return (
    <div className={"connection-manager " + draft.channel}>
      <div className="connection-manager-head">
        <div>
          <strong>{draft.displayName}</strong>
          <small>{draft.botUsername || defaultBotLabel} · {getScopeLabel(draft.scope, t)}</small>
        </div>
        <Badge tone={draft.status === "connected" ? "connected" : "neutral"}>
          {draft.status === "connected" ? t("integrationsPage.badges.connected") : draft.status === "pending" ? t("integrationsPage.badges.pendingPairing") : draft.status.toUpperCase()}
        </Badge>
      </div>
      <nav className="connection-section-tabs">
        {(["general", "access", "context", "groups", "notifications", "commands", "media", "advanced"] as ManageSection[]).map((item) => (
          <button key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>
            {sectionLabel(item)}
          </button>
        ))}
      </nav>
      {message && <div className="inline-message">{message}</div>}
      {section === "access" && draft.channel === "slack" && (
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
      )}
      {section === "groups" && draft.channel === "slack" && (
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
      )}
      {section === "access" && draft.channel === "discord" && (
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
      )}
      {section === "access" && draft.channel === "whatsapp" && draft.provider === "qr" && (
        <div className="whatsapp-self-chat-setting">
          <Toggle checked={settings.access.selfChat} onChange={(value) => updateSettings("access", "selfChat", value)} label={t("integrationsPage.drawer.manager.access.selfChatTitle")} description={t("integrationsPage.drawer.manager.access.selfChatDesc")} />
        </div>
      )}
      {section === "general" && (
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
      )}
      {section === "access" && draft.channel === "whatsapp" && (
        <div className="integration-settings-section">
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
      )}
      {section === "access" && draft.channel !== "slack" && draft.channel !== "discord" && draft.channel !== "whatsapp" && (
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
      )}
      {section === "context" && (
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
      )}
      {section === "groups" && draft.channel === "discord" && (
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
      )}
      {section === "groups" && draft.channel !== "discord" && draft.channel !== "slack" && (
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
      )}
      {section === "notifications" && (
        <div className="integration-settings-section">
          <h3>{t("integrationsPage.drawer.manager.notifications.heading")}</h3>
          <Toggle checked={settings.notifications.automationResults} onChange={(value) => updateSettings("notifications", "automationResults", value)} label={t("integrationsPage.drawer.manager.notifications.automationResults")} />
          <Toggle checked={settings.notifications.backgroundResults} onChange={(value) => updateSettings("notifications", "backgroundResults", value)} label={t("integrationsPage.drawer.manager.notifications.backgroundResults")} description={t("integrationsPage.drawer.manager.notifications.backgroundResultsDesc")} />
          <Toggle checked={settings.notifications.errors} onChange={(value) => updateSettings("notifications", "errors", value)} label={t("integrationsPage.drawer.manager.notifications.errors")} />
          <Toggle checked={settings.notifications.status} onChange={(value) => updateSettings("notifications", "status", value)} label={t("integrationsPage.drawer.manager.notifications.status")} />
          <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.notifications.saveNotifications")}</button>
        </div>
      )}
      {section === "commands" && (
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
      )}
      {section === "media" && (
        <div className="integration-settings-section">
          <h3>{t("integrationsPage.drawer.manager.media.heading")}</h3>
          <Toggle checked={settings.media.images} onChange={(value) => updateSettings("media", "images", value)} label={t("integrationsPage.drawer.manager.media.images")} />
          <Toggle checked={settings.media.documents} onChange={(value) => updateSettings("media", "documents", value)} label={t("integrationsPage.drawer.manager.media.documents")} description={t("integrationsPage.drawer.manager.media.documentsDesc")} />
          <Toggle checked={settings.media.audio} onChange={(value) => updateSettings("media", "audio", value)} label={t("integrationsPage.drawer.manager.media.audio")} description={t("integrationsPage.drawer.manager.media.audioDesc")} />
          <Toggle checked={settings.media.outbound} onChange={(value) => updateSettings("media", "outbound", value)} label={t("integrationsPage.drawer.manager.media.outbound")} />
          <button className="button-primary" disabled={!!busy} onClick={() => void save()}>{busy || t("integrationsPage.drawer.manager.media.saveMedia")}</button>
        </div>
      )}
      {section === "advanced" && (
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
      )}
    </div>
  );
}

function IntegrationDrawer({ channel, connections, companies, initialConnectionId, onClose, onChanged }: { channel: Channel; connections: Connection[]; companies: Company[]; initialConnectionId?: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"details" | "manage" | "connect">(initialConnectionId ? "manage" : connections.length ? "details" : "connect");
  const [manageId, setManageId] = useState(initialConnectionId || "");
  const [scope, setScope] = useState<ConnectionScope>("account");
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState(() => channel.id === "whatsapp" ? t("integrationsPage.drawer.connect.defaultBotNames.whatsapp") : channel.id === "discord" ? t("integrationsPage.drawer.connect.defaultBotNames.discord") : channel.id === "slack" ? t("integrationsPage.drawer.connect.defaultBotNames.slack") : t("integrationsPage.drawer.connect.defaultBotNames.telegram"));
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [pairing, setPairing] = useState<{ command: string; bot?: string } | null>(null);
  const [waMethod, setWaMethod] = useState<"qr" | "cloud">("qr");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [slackMethod, setSlackMethod] = useState<"socket" | "http">("socket");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  useEffect(() => {
    if (channel.id === "whatsapp") setName(t("integrationsPage.drawer.connect.defaultBotNames.whatsapp"));
    else if (channel.id === "discord") setName(t("integrationsPage.drawer.connect.defaultBotNames.discord"));
    else if (channel.id === "slack") setName(t("integrationsPage.drawer.connect.defaultBotNames.slack"));
    else setName(t("integrationsPage.drawer.connect.defaultBotNames.telegram"));
  }, [channel.id]);

  useEffect(() => {
    setAgentId("");
    if (scope !== "agent" || !companyId) {
      setAgents([]);
      return;
    }
    void api<{ agents: Agent[] }>(`/companies/${companyId}/agents`).then((result) => setAgents(result.agents.filter((agent) => agent.isActive))).catch((error) => setMessage(error.message));
  }, [companyId, scope]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string }>("/integrations/telegram", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, botToken: token, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      setPairing({ command: result.pairingCommand, bot: result.connection.botUsername || undefined });
      setManageId(result.connection.id);
      setMode("manage");
      setMessage(t("integrationsPage.drawer.connect.messages.telegramSuccess"));
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectWhatsApp(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; webhookUrl?: string }>("/integrations/whatsapp", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, method: waMethod, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}), ...(waMethod === "cloud" ? { phoneNumberId, accessToken, appSecret, verifyToken } : {}) }),
      });
      setManageId(result.connection.id);
      setMode("manage");
      setMessage(waMethod === "qr" ? t("integrationsPage.drawer.connect.messages.whatsappQrSuccess") : t("integrationsPage.drawer.connect.messages.whatsappCloudSuccess", { url: result.webhookUrl || "public webhook URL unavailable" }));
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectDiscord(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string; inviteUrl: string }>("/integrations/discord", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, botToken: token, clientId, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      setPairing({ command: result.pairingCommand, bot: result.connection.botUsername || undefined });
      setManageId(result.connection.id);
      setMode("manage");
      setMessage(t("integrationsPage.drawer.connect.messages.discordSuccess"));
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function generateSlackManifest() {
    setBusy(t("integrationsPage.drawer.connect.generatingManifest"));
    setMessage("");
    try {
      const result = await api<{ manifest: unknown }>("/integrations/slack/manifest", { method: "POST", body: JSON.stringify({ method: slackMethod }) });
      const blob = new Blob([JSON.stringify(result.manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "npati-slack-app-manifest.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage(t("integrationsPage.drawer.connect.messages.manifestGenerated"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectSlack(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string; webhookUrl?: string }>("/integrations/slack", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, method: slackMethod, botToken: token, ...(slackMethod === "socket" ? { appToken } : { signingSecret }), ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      setAppToken("");
      setSigningSecret("");
      setPairing({ command: result.pairingCommand, bot: result.connection.botUsername || undefined });
      setManageId(result.connection.id);
      setMode("manage");
      setMessage(result.webhookUrl ? t("integrationsPage.drawer.connect.messages.slackHttpSuccess") : t("integrationsPage.drawer.connect.messages.slackSocketSuccess"));
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  const hasConnected = connections.some((item) => item.status === "connected");
  const hasPending = !hasConnected && connections.some((item) => item.status === "pending");

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="provider-drawer" aria-label={`${channel.name} integration`}>
        <button className="drawer-close" onClick={onClose} aria-label={t("integrationsPage.drawer.closeAria")}>
          <span>×</span>
        </button>
        <header className="drawer-header">
          <ChannelIcon channel={channel} size="large" />
          <div>
            <p className="section-kicker">{t("integrationsPage.drawer.kicker")}</p>
            <h2>{channel.name}</h2>
          </div>
        </header>
        <div className="provider-badges">
          <Badge>{t("integrationsPage.badges.channel")}</Badge>
          {channel.available ? <Badge tone="connected">{t("integrationsPage.badges.available")}</Badge> : <Badge>{t("integrationsPage.badges.comingSoon")}</Badge>}
          {hasConnected ? <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge> : hasPending && <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>}
        </div>
        <div className="drawer-tabs">
          <button className={mode === "details" ? "active" : ""} onClick={() => setMode("details")}>{t("integrationsPage.drawer.tabs.overview")}</button>
          {manageId && <button className={mode === "manage" ? "active" : ""} onClick={() => setMode("manage")}>{t("integrationsPage.drawer.tabs.manage")}</button>}
          {channel.available && <button className={mode === "connect" ? "active" : ""} onClick={() => setMode("connect")}>{connections.length ? t("integrationsPage.drawer.tabs.addConnection") : t("integrationsPage.drawer.tabs.setup")}</button>}
        </div>
        {message && <div className="inline-message">{message}</div>}
        {mode === "details" && (
          <div className="details-body">
            {!channel.available ? (
              <div className="provider-setup-note">
                <strong>{t("integrationsPage.drawer.overview.comingSoonTitle", { name: channel.name })}</strong>
              </div>
            ) : connections.length === 0 ? (
              <div className="empty-inline">
                <strong>{t("integrationsPage.drawer.overview.noConnections")}</strong>
              </div>
            ) : (
              <div className="model-list">
                {connections.map((connection) => (
                  <div className="model-row" key={connection.id}>
                    <span>
                      <strong>{connection.displayName}</strong>
                      <small>{getScopeLabel(connection.scope, t)} · {connection.status} · {t("integrationsPage.drawer.overview.lastActivity", { time: formatDate(connection.lastInboundAt || connection.lastOutboundAt, t("integrationsPage.drawer.manager.general.never")) })}</small>
                    </span>
                    <button onClick={() => { setManageId(connection.id); setMode("manage"); }}>{t("integrationsPage.drawer.tabs.manage")}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {mode === "manage" && manageId && (
          <ConnectionManager key={manageId} connectionId={manageId} initialConnection={connections.find((item) => item.id === manageId)} companies={companies} initialPairingCommand={pairing?.command} onChanged={onChanged} onRemoved={() => { setManageId(""); setMode("details"); void onChanged(); }} />
        )}
        {mode === "connect" && channel.id === "slack" && (
          <div className="connect-body">
            <p className="auth-hint">{t("integrationsPage.drawer.connect.slackHint")}</p>
            <div className="drawer-actions">
              <button type="button" className="button-secondary" disabled={!!busy} onClick={() => void generateSlackManifest()}>{busy || t("integrationsPage.drawer.connect.generateManifest")}</button>
              <a className="button-secondary" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">{t("integrationsPage.drawer.connect.createSlackApp")}</a>
            </div>
            <form onSubmit={connectSlack}>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionScope")}</label>
                <select value={scope} onChange={(event) => setScope(event.target.value as ConnectionScope)}>
                  <option value="account">{t("integrationsPage.scopes.account")}</option>
                  <option value="company">{t("integrationsPage.scopes.company")}</option>
                  <option value="agent">{t("integrationsPage.scopes.agent")}</option>
                </select>
              </div>
              {scope !== "account" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.company")}</label>
                  <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
                    {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </div>
              )}
              {scope === "agent" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.agent")}</label>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                    <option value="">{t("integrationsPage.drawer.connect.selectAgent")}</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionMethod")}</label>
                <select value={slackMethod} onChange={(event) => setSlackMethod(event.target.value as "socket" | "http")}>
                  <option value="socket">{t("integrationsPage.drawer.connect.socketMode")}</option>
                  <option value="http">{t("integrationsPage.drawer.connect.httpEvents")}</option>
                </select>
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.botTokenSlack")}</label>
                <input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} required />
              </div>
              {slackMethod === "socket" ? (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.appLevelToken")}</label>
                  <input type="password" autoComplete="new-password" value={appToken} onChange={(event) => setAppToken(event.target.value)} required />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.signingSecret")}</label>
                    <input type="password" autoComplete="new-password" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.webhookUrl")}</label>
                    <input value={t("integrationsPage.drawer.connect.webhookGeneratedAfter")} readOnly />
                  </div>
                </>
              )}
              <button className="button-primary wide" disabled={!!busy || !token.trim() || (slackMethod === "socket" ? !appToken.trim() : !signingSecret.trim()) || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
                {busy || t("integrationsPage.drawer.connect.connectSlack")}
              </button>
            </form>
          </div>
        )}
        {mode === "connect" && channel.id === "discord" && (
          <div className="connect-body">
            <p className="auth-hint">{t("integrationsPage.drawer.connect.discordHint")}</p>
            <form onSubmit={connectDiscord}>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionScope")}</label>
                <select value={scope} onChange={(event) => setScope(event.target.value as ConnectionScope)}>
                  <option value="account">{t("integrationsPage.scopes.account")}</option>
                  <option value="company">{t("integrationsPage.scopes.company")}</option>
                  <option value="agent">{t("integrationsPage.scopes.agent")}</option>
                </select>
              </div>
              {scope !== "account" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.company")}</label>
                  <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
                    {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </div>
              )}
              {scope === "agent" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.agent")}</label>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                    <option value="">{t("integrationsPage.drawer.connect.selectAgent")}</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.botToken")}</label>
                <input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.clientId")}</label>
                <input value={clientId} onChange={(event) => setClientId(event.target.value)} inputMode="numeric" required />
              </div>
              <button className="button-primary wide" disabled={!!busy || !token.trim() || !clientId.trim() || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
                {busy || t("integrationsPage.drawer.connect.connectDiscord")}
              </button>
            </form>
          </div>
        )}
        {mode === "connect" && channel.id === "whatsapp" && (
          <div className="connect-body">
            <p className="auth-hint">{t("integrationsPage.drawer.connect.whatsAppHint")}</p>
            <form onSubmit={connectWhatsApp}>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionScope")}</label>
                <select value={scope} onChange={(event) => setScope(event.target.value as ConnectionScope)}>
                  <option value="account">{t("integrationsPage.scopes.account")}</option>
                  <option value="company">{t("integrationsPage.scopes.company")}</option>
                  <option value="agent">{t("integrationsPage.scopes.agent")}</option>
                </select>
              </div>
              {scope !== "account" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.company")}</label>
                  <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
                    {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </div>
              )}
              {scope === "agent" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.agent")}</label>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                    <option value="">{t("integrationsPage.drawer.connect.selectAgent")}</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionMethod")}</label>
                <select value={waMethod} onChange={(event) => setWaMethod(event.target.value as "qr" | "cloud")}>
                  <option value="qr">{t("integrationsPage.drawer.connect.whatsAppMethodQr")}</option>
                  <option value="cloud">{t("integrationsPage.drawer.connect.whatsAppMethodCloud")}</option>
                </select>
              </div>
              {waMethod === "cloud" && (
                <>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.phoneNumberId")}</label>
                    <input value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.accessToken")}</label>
                    <input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.appSecret")}</label>
                    <input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.verifyToken")}</label>
                    <input type="password" value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t("integrationsPage.drawer.connect.webhookUrl")}</label>
                    <input value={t("integrationsPage.drawer.connect.webhookGeneratedAfter")} readOnly />
                  </div>
                </>
              )}
              <button className="button-primary wide" disabled={!!busy || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
                {busy || t("integrationsPage.drawer.connect.connectWhatsApp")}
              </button>
            </form>
          </div>
        )}
        {mode === "connect" && channel.available && (
          <div className="connect-body">
            <p className="auth-hint">{t("integrationsPage.drawer.connect.telegramHint")}</p>
            <form onSubmit={connect}>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionScope")}</label>
                <select value={scope} onChange={(event) => setScope(event.target.value as ConnectionScope)}>
                  <option value="account">{t("integrationsPage.scopes.account")}</option>
                  <option value="company">{t("integrationsPage.scopes.company")}</option>
                  <option value="agent">{t("integrationsPage.scopes.agent")}</option>
                </select>
              </div>
              {scope !== "account" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.company")}</label>
                  <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
                    {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </div>
              )}
              {scope === "agent" && (
                <div className="field">
                  <label>{t("integrationsPage.drawer.connect.agent")}</label>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                    <option value="">{t("integrationsPage.drawer.connect.selectAgent")}</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.botToken")}</label>
                <input type="password" value={token} onChange={(event) => setToken(event.target.value)} required />
              </div>
              <button className="button-primary wide" disabled={!!busy || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
                {busy || t("integrationsPage.drawer.connect.connectTelegram")}
              </button>
            </form>
            {pairing && (
              <div className="provider-setup-note">
                <strong>{t("integrationsPage.drawer.connect.finishPairingInBot", { bot: pairing.bot || "your bot" })}</strong>
                <code>{pairing.command}</code>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

const DEFAULT_CHANNELS: Channel[] = [
  { id: "telegram", name: "Telegram", available: true, capabilities: ["Chat", "Tasks", "Files", "Automations", "Company actions"] },
  { id: "discord", name: "Discord", available: true, capabilities: ["DMs", "Servers", "Threads", "Files", "Commands", "Automations"] },
  { id: "slack", name: "Slack", available: true, capabilities: ["DMs", "Channels", "Threads", "Files", "Commands", "Automations"] },
  { id: "whatsapp", name: "WhatsApp", available: true, capabilities: ["Chat", "Tasks", "Files", "Voice", "Groups", "Automations"] },
  { id: "email", name: "Email", available: true, capabilities: ["Chat Runtime", "Company Agents", "Threads", "Files", "Approvals", "Automations"] },
];
const STORAGE_CHANNELS_KEY = "npati_integrations_channels";
const STORAGE_CONNECTIONS_KEY = "npati_integrations_connections";
const STORAGE_COMPANIES_KEY = "npati_integrations_companies";

function getCachedChannels(): Channel[] {
  try {
    const raw = localStorage.getItem(STORAGE_CHANNELS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_CHANNELS;
}

function getCachedConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(STORAGE_CONNECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function getCachedCompanies(): Company[] {
  try {
    const raw = localStorage.getItem(STORAGE_COMPANIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<Channel[]>(getCachedChannels);
  const [connections, setConnections] = useState<Connection[]>(getCachedConnections);
  const [companies, setCompanies] = useState<Company[]>(getCachedCompanies);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "available" | "coming" | "connected">("all");
  const [selected, setSelected] = useState<Channel | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem(STORAGE_CHANNELS_KEY));
    } catch {
      return false;
    }
  });
  const [loading, setLoading] = useState<boolean>(() => !hasLoaded);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const [catalog, companyResult] = await Promise.all([
        api<{ channels: Channel[]; connections: Connection[] }>("/integrations/channels"),
        api<{ companies: Company[] }>("/companies"),
      ]);
      setChannels((prev) => JSON.stringify(prev) === JSON.stringify(catalog.channels) ? prev : catalog.channels);
      setConnections((prev) => JSON.stringify(prev) === JSON.stringify(catalog.connections) ? prev : catalog.connections);
      setCompanies((prev) => JSON.stringify(prev) === JSON.stringify(companyResult.companies) ? prev : companyResult.companies);
      try {
        localStorage.setItem(STORAGE_CHANNELS_KEY, JSON.stringify(catalog.channels));
        localStorage.setItem(STORAGE_CONNECTIONS_KEY, JSON.stringify(catalog.connections));
        localStorage.setItem(STORAGE_COMPANIES_KEY, JSON.stringify(companyResult.companies));
      } catch {}
      setError("");
      setHasLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const connectedChannels = useMemo(() => new Set(connections.map((connection) => connection.channel)), [connections]);
  const visible = useMemo(
    () => channels.filter(
      (channel) => channel.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (tab === "all" ||
          (tab === "available" && channel.available) ||
          (tab === "coming" && !channel.available) ||
          (tab === "connected" && connectedChannels.has(channel.id))),
    ),
    [channels, search, tab, connectedChannels],
  );
  const counts = useMemo(
    () => ({
      all: channels.length,
      available: channels.filter((item) => item.available).length,
      coming: channels.filter((item) => !item.available).length,
      connected: channels.filter((item) => connectedChannels.has(item.id)).length,
    }),
    [channels, connectedChannels],
  );

  const open = (channel: Channel, connectionId?: string) => {
    if (channel.id === "email") {
      navigate("/settings/email");
      return;
    }
    setSelectedConnectionId(connectionId || null);
    setSelected(channel);
  };

  const getTabLabel = (item: "all" | "available" | "coming" | "connected") => {
    if (item === "all") return t("integrationsPage.tabs.all");
    if (item === "available") return t("integrationsPage.tabs.available");
    if (item === "coming") return t("integrationsPage.tabs.coming");
    return t("integrationsPage.tabs.connected");
  };

  const getCapabilityLabel = (cap: string) => {
    const key = capabilityKeyMap[cap];
    if (key) {
      const translated = t(`integrationsPage.capabilities.${key}` as any);
      if (translated) return translated;
    }
    return cap;
  };

  return (
    <main className="ai-marketplace">
      <header className="marketplace-hero">
        <div>
          <p className="eyebrow">{t("integrationsPage.eyebrow")}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={t("integrationsPage.backAria")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            </Link>
            <span>{t("integrationsPage.title")}</span>
          </h1>
          <p>{t("integrationsPage.description")}</p>
        </div>
      </header>
      <section className="overview-grid">
        <div><strong>{channels.length || "—"}</strong><span>{t("integrationsPage.stats.channelsAvailable")}</span></div>
        <div><strong>{counts.available}</strong><span>{t("integrationsPage.stats.readyToConnect")}</span></div>
        <div><strong>{counts.connected}</strong><span>{t("integrationsPage.stats.channelsConnected")}</span></div>
        <div><strong>{connections.length}</strong><span>{t("integrationsPage.stats.connectionsAdded")}</span></div>
      </section>
      <section className="my-models">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{t("integrationsPage.myConnections.kicker")}</p>
            <h2>{t("integrationsPage.myConnections.heading")}</h2>
          </div>
          <span>{t("integrationsPage.myConnections.addedCount", { count: connections.length })}</span>
        </div>
        {!hasLoaded && loading && connections.length === 0 ? (
          <div className="empty-inline" style={{ minHeight: "84px", display: "grid", placeItems: "center" }}>
            <span>{t("integrationsPage.myConnections.loading")}</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="empty-inline" style={{ minHeight: "84px" }}>
            <strong>{t("integrationsPage.myConnections.emptyTitle")}</strong>
            <span>{t("integrationsPage.myConnections.emptyDesc")}</span>
          </div>
        ) : (
          <div className="my-model-list">
            {connections.map((connection) => {
              const channel = channels.find((item) => item.id === connection.channel) || { id: connection.channel, name: connection.channel, available: true, capabilities: [] };
              return (
                <div className="my-model-row" key={connection.id}>
                  <ChannelIcon channel={channel} size="small" />
                  <span>
                    <strong>{connection.displayName}</strong>
                    <small>{t("integrationsPage.myConnections.via")} {channel.name} · {getScopeLabel(connection.scope, t)}</small>
                  </span>
                  {connection.status === "connected" ? (
                    <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge>
                  ) : connection.status === "pending" ? (
                    <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>
                  ) : (
                    <Badge>{connection.status.toUpperCase()}</Badge>
                  )}
                  <button onClick={() => open(channel, connection.id)}>{t("integrationsPage.myConnections.manage")}</button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="explore-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{t("integrationsPage.explore.kicker")}</p>
            <h2>{t("integrationsPage.explore.heading")}</h2>
          </div>
        </div>
        <div className="marketplace-controls">
          <div className="search-box">
            <span>⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("integrationsPage.explore.searchPlaceholder")} />
          </div>
          <div className="marketplace-tabs">
            {(["all", "available", "coming", "connected"] as const).map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
                <span>{getTabLabel(item)}</span>
                <small>{counts[item]}</small>
              </button>
            ))}
          </div>
        </div>
        {error && channels.length === 0 ? (
          <div className="engine-error">
            <strong>{t("integrationsPage.explore.unavailable")}</strong>
            <p>{error}</p>
          </div>
        ) : loading && channels.length === 0 ? (
          <div className="loading-state">{t("integrationsPage.explore.loading")}</div>
        ) : (
          <>
            <p className="showing-copy">{t("integrationsPage.explore.showingCount", { visible: visible.length, total: channels.length })}</p>
            <div className="provider-grid">
              {visible.map((channel) => {
                const linked = connections.filter((item) => item.channel === channel.id);
                const hasConnection = linked.length > 0;
                const connected = linked.some((item) => item.status === "connected");
                const pending = !connected && linked.some((item) => item.status === "pending");
                const openChannel = () => open(channel, linked.length === 1 ? linked[0]!.id : undefined);
                return (
                  <article className={`provider-card ${hasConnection ? "is-connected" : ""}`} key={channel.id}>
                    <button className="provider-card-main" onClick={openChannel}>
                      <ChannelIcon channel={channel} />
                      <span className="provider-title">
                        <strong>{channel.name}</strong>
                        <small>{channel.available ? t("integrationsPage.explore.messagingChannel") : t("integrationsPage.explore.plannedAdapter")}</small>
                      </span>
                      <span className={`connection-light ${connected ? "on" : pending ? "pending" : ""}`} />
                    </button>
                    <div className="provider-badges">
                      <Badge>{t("integrationsPage.badges.channel")}</Badge>
                      {connected ? (
                        <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge>
                      ) : pending && (
                        <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>
                      )}
                      {channel.available ? (
                        <Badge tone="red">{t("integrationsPage.badges.recommended")}</Badge>
                      ) : (
                        <Badge>{t("integrationsPage.badges.comingSoon")}</Badge>
                      )}
                    </div>
                    <p className="provider-description">
                      {channel.available
                        ? t("integrationsPage.explore.channelDescription")
                        : t("integrationsPage.explore.futureAdapterDescription", { name: channel.name })}
                    </p>
                    <div className="capability-row">
                      {channel.available
                        ? channel.capabilities.slice(0, 4).map((item) => <span key={item}>{getCapabilityLabel(item)}</span>)
                        : <span>{t("integrationsPage.explore.adapterReady")}</span>}
                    </div>
                    <div className="provider-card-footer">
                      <span>{t("integrationsPage.explore.connectionsCount", { count: linked.length })}</span>
                      <button className={hasConnection ? "button-secondary" : "button-primary"} onClick={openChannel}>
                        {channel.available ? (hasConnection ? t("integrationsPage.explore.manage") : t("integrationsPage.explore.connect")) : t("integrationsPage.explore.view")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
      {selected && (
        <IntegrationDrawer
          key={`${selected.id}:${selectedConnectionId || "catalog"}`}
          channel={selected}
          connections={connections.filter((item) => item.channel === selected.id)}
          companies={companies}
          initialConnectionId={selectedConnectionId}
          onClose={() => { setSelected(null); setSelectedConnectionId(null); }}
          onChanged={load}
        />
      )}
    </main>
  );
}
