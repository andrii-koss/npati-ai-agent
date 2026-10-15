import { getStoredAuthToken } from "../AuthContext";

export type Company = { id: string; name: string };
export type Agent = { id: string; name: string; role: string; isActive: boolean };
export type Channel = { id: string; name: string; available: boolean; capabilities: string[] };
export type ConnectionScope = "account" | "company" | "agent";
export type DiscordBinding = { guildId: string; channelId: string; companyId?: string | null; agentId?: string | null; requireMention?: boolean; permissions: string[] };
export type SlackBinding = { workspaceId: string; channelId: string; companyId?: string | null; agentId?: string | null; requireMention?: boolean; allowedUserIds: string[]; permissions: string[] };
export type SlackSettings = { dmPolicy: "pairing" | "allowlist" | "open" | "disabled"; allowedUserIds: string[]; allowedWorkspaceIds: string[]; allowedChannelIds: string[]; requireMention: boolean; channelBindings: SlackBinding[] };
export type DiscordSettings = { dmPolicy: "pairing" | "allowlist" | "open" | "disabled"; allowedUserIds: string[]; allowedGuildIds: string[]; allowedChannelIds: string[]; allowedRoleIds: string[]; requireMention: boolean; channelBindings: DiscordBinding[] };
export type Settings = { access: { allowedUserIds: string[]; selfChat: boolean }; discord: DiscordSettings; slack: SlackSettings; groups: { enabled: boolean; allowedChatIds: string[]; mentionRequired: boolean; replyMode: "reply" | "plain" }; notifications: { automationResults: boolean; backgroundResults: boolean; errors: boolean; status: boolean }; media: { images: boolean; documents: boolean; audio: boolean; outbound: boolean }; delivery: { typing: boolean; progressive: boolean } };
export type Connection = { id: string; companyId?: string | null; agentId?: string | null; scope: ConnectionScope; activeCompanyId?: string | null; activeAgentId?: string | null; channel: string; provider?: "qr" | "cloud" | null; displayName: string; status: string; botUsername?: string | null; externalUserId?: string | null; externalChatId?: string | null; externalThreadId?: string | null; lastInboundAt?: string | null; lastOutboundAt?: string | null; lastError?: string | null; createdAt?: string; updatedAt?: string; settings?: Settings };
export type Session = { id: string; externalChatId: string; externalThreadId: string; activeCompanyId?: string | null; activeAgentId?: string | null; runtimeConversationId?: string | null; updatedAt: string };
export type DiscordCatalog = { guilds: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number; parentId?: string | null }>; roles: Array<{ id: string; name: string }> }> };
export type SlackCatalog = { workspaces: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }> };
export type ManageData = { connection: Connection; sessions: Session[]; commands: string[]; transport: string; webhookUrl?: string; discordCatalog?: DiscordCatalog; slackCatalog?: SlackCatalog; capabilities: { typing: boolean; progressiveEditing: boolean; longMessageChunking: boolean; retryBackoff: boolean; deduplication: boolean; sessionPersistence: boolean; inboundMedia: string[]; outboundMedia: string[]; reactions?: boolean; voiceChannel?: boolean } };
export type ManageSection = "general" | "access" | "context" | "groups" | "notifications" | "commands" | "media" | "advanced";

export const defaults = (): Settings => ({
  access: { allowedUserIds: [], selfChat: false },
  discord: { dmPolicy: "pairing", allowedUserIds: [], allowedGuildIds: [], allowedChannelIds: [], allowedRoleIds: [], requireMention: true, channelBindings: [] },
  slack: { dmPolicy: "pairing", allowedUserIds: [], allowedWorkspaceIds: [], allowedChannelIds: [], requireMention: true, channelBindings: [] },
  groups: { enabled: true, allowedChatIds: [], mentionRequired: true, replyMode: "reply" },
  notifications: { automationResults: true, backgroundResults: true, errors: true, status: true },
  media: { images: true, documents: true, audio: true, outbound: true },
  delivery: { typing: true, progressive: true },
});

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body as unknown as T;
}

export const initial = (name: string) => name.trim().charAt(0).toUpperCase();
export const formatDate = (value?: string | null, neverText = "Never") => value ? new Date(value).toLocaleString() : neverText;

export const getScopeLabel = (scope: ConnectionScope, t: (key: string, params?: Record<string, string | number>) => string) => {
  if (scope === "account") return t("integrationsPage.scopes.account");
  if (scope === "company") return t("integrationsPage.scopes.company");
  return t("integrationsPage.scopes.agent");
};

export const capabilityKeyMap: Record<string, string> = {
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

export const createFallbackManageData = (conn: Connection): ManageData => ({
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
