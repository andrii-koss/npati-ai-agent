import { Channel, Company, Connection } from "./types";

export const DEFAULT_CHANNELS: Channel[] = [
  { id: "telegram", name: "Telegram", available: true, capabilities: ["Chat", "Tasks", "Files", "Automations", "Company actions"] },
  { id: "discord", name: "Discord", available: true, capabilities: ["DMs", "Servers", "Threads", "Files", "Commands", "Automations"] },
  { id: "slack", name: "Slack", available: true, capabilities: ["DMs", "Channels", "Threads", "Files", "Commands", "Automations"] },
  { id: "whatsapp", name: "WhatsApp", available: true, capabilities: ["Chat", "Tasks", "Files", "Voice", "Groups", "Automations"] },
  { id: "email", name: "Email", available: true, capabilities: ["Chat Runtime", "Company Agents", "Threads", "Files", "Approvals", "Automations"] },
];

export const STORAGE_CHANNELS_KEY = "npati_integrations_channels";
export const STORAGE_CONNECTIONS_KEY = "npati_integrations_connections";
export const STORAGE_COMPANIES_KEY = "npati_integrations_companies";

export function getCachedChannels(): Channel[] {
  try {
    const raw = localStorage.getItem(STORAGE_CHANNELS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_CHANNELS;
}

export function getCachedConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(STORAGE_CONNECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function getCachedCompanies(): Company[] {
  try {
    const raw = localStorage.getItem(STORAGE_COMPANIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}
