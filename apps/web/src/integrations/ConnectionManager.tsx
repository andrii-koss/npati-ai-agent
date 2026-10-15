import { FormEvent, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { ConnectionAdvancedSections } from "./sections/ConnectionAdvancedSections";
import { ConnectionAccessSection } from "./sections/ConnectionAccessSection";
import { ConnectionGeneralSection } from "./sections/ConnectionGeneralSection";
import { ConnectionGroupsSection } from "./sections/ConnectionGroupsSection";
import {
  Agent,
  api,
  Company,
  Connection,
  createFallbackManageData,
  defaults,
  DiscordBinding,
  getScopeLabel,
  ManageData,
  ManageSection,
  Settings,
  SlackBinding,
} from "./types";
import { Badge } from "./ui";

export interface ConnectionManagerProps {
  connectionId: string;
  companies: Company[];
  initialConnection?: Connection | null;
  initialPairingCommand?: string;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}

export function ConnectionManager({
  connectionId,
  companies,
  initialConnection,
  initialPairingCommand = "",
  onChanged,
  onRemoved,
}: ConnectionManagerProps) {
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
    const currentSettings = draft.settings || defaults();
    const settings = { ...currentSettings, groups: { ...currentSettings.groups, allowedChatIds: groupsText.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean) } };
    await api(`/integrations/messaging/${connectionId}`, { method: "PATCH", body: JSON.stringify({ displayName: draft.displayName, scope: draft.scope, companyId: draft.companyId || null, agentId: draft.agentId || null, settings }) });
    setMessage(t("integrationsPage.drawer.manager.general.savedMessage"));
  });

  const saveAccess = () => run(t("integrationsPage.drawer.manager.access.savingAccess"), async () => {
    if (!draft) return;
    const allowedUserIds = usersText.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    const currentSettings = draft.settings || defaults();
    const settings = { ...currentSettings, access: { ...currentSettings.access, allowedUserIds } };
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
      {section === "general" && (
        <ConnectionGeneralSection
          draft={draft}
          setDraft={setDraft}
          token={token}
          setToken={setToken}
          pairing={pairing}
          busy={busy}
          connectionId={connectionId}
          save={save}
          replaceToken={replaceToken}
          removeConnection={removeConnection}
          run={run}
          t={t}
        />
      )}
      {section === "access" && (
        <ConnectionAccessSection
          draft={draft}
          settings={settings}
          data={data}
          connectionId={connectionId}
          pairing={pairing}
          inviteUrl={inviteUrl}
          qr={qr}
          usersText={usersText}
          setUsersText={setUsersText}
          busy={busy}
          copyPairing={copyPairing}
          createPairing={createPairing}
          updateSettings={updateSettings}
          save={save}
          saveAccess={saveAccess}
          run={run}
          t={t}
        />
      )}
      {section === "groups" && (
        <ConnectionGroupsSection
          draft={draft}
          settings={settings}
          data={data}
          companies={companies}
          groupsText={groupsText}
          setGroupsText={setGroupsText}
          busy={busy}
          updateSettings={updateSettings}
          setDiscordBinding={setDiscordBinding}
          setSlackBinding={setSlackBinding}
          save={save}
          t={t}
        />
      )}
      {(section === "context" || section === "notifications" || section === "commands" || section === "media" || section === "advanced") && (
        <ConnectionAdvancedSections
          section={section}
          draft={draft}
          setDraft={setDraft}
          settings={settings}
          data={data}
          companies={companies}
          agents={agents}
          activeCompanyId={activeCompanyId}
          activeAgentId={activeAgentId}
          busy={busy}
          updateSettings={updateSettings}
          save={save}
          t={t}
        />
      )}
    </div>
  );
}
