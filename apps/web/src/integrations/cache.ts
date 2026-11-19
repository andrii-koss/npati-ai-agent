import { readSettingsSnapshot, requestSettingsRead } from "../settings-page-cache";
import { api, type Channel, type Company, type Connection } from "./types";

export type IntegrationsCatalog = { channels: Channel[]; connections: Connection[]; companies: Company[] };

const CATALOG_KEY = "integrations:catalog";
const STORAGE_CHANNELS_KEY = "npati_integrations_channels";

export function readIntegrationsCatalog() {
  return readSettingsSnapshot<IntegrationsCatalog>(CATALOG_KEY) ?? null;
}

export function requestIntegrationsCatalog() {
  return requestSettingsRead(CATALOG_KEY, async () => {
    const catalog = await api<IntegrationsCatalog>("/integrations/channels?includeCompanies=true");
    // Capability Inspector shares the public channel catalog.
    try { localStorage.setItem(STORAGE_CHANNELS_KEY, JSON.stringify(catalog.channels)); } catch { /* Optional cache. */ }
    return catalog;
  });
}
