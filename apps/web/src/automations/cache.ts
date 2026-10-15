import { getStoredAuthToken } from "../AuthContext";
import type { CompanyAutomation, Agent } from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export const AUTOMATIONS_CACHE_PREFIX = "npati_automations_cache_v1_";
export const AUTOMATIONS_AGENTS_CACHE_PREFIX = "npati_automations_agents_cache_v1_";
export const AUTOMATIONS_LATEST_CACHE_KEY = "npati_automations_cache_latest_v1";

export function getCachedAutomations(companyId?: string): CompanyAutomation[] {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(AUTOMATIONS_CACHE_PREFIX + companyId)
        || localStorage.getItem(AUTOMATIONS_CACHE_PREFIX + companyId);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    }
    const latest = sessionStorage.getItem(AUTOMATIONS_LATEST_CACHE_KEY)
      || localStorage.getItem(AUTOMATIONS_LATEST_CACHE_KEY);
    if (latest) {
      const parsed = JSON.parse(latest);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [];
}

export function updateCachedAutomations(companyId: string, items: CompanyAutomation[]): void {
  try {
    const serialized = JSON.stringify(items);
    if (companyId) {
      sessionStorage.setItem(AUTOMATIONS_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(AUTOMATIONS_CACHE_PREFIX + companyId, serialized);
    }
    if (items.length > 0) {
      sessionStorage.setItem(AUTOMATIONS_LATEST_CACHE_KEY, serialized);
      localStorage.setItem(AUTOMATIONS_LATEST_CACHE_KEY, serialized);
    }
  } catch {}
}

export function getCachedAgents(companyId?: string): Agent[] {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(AUTOMATIONS_AGENTS_CACHE_PREFIX + companyId)
        || localStorage.getItem(AUTOMATIONS_AGENTS_CACHE_PREFIX + companyId);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch {}
  return [];
}

export function updateCachedAgents(companyId: string, agents: Agent[]): void {
  try {
    if (companyId) {
      const serialized = JSON.stringify(agents);
      sessionStorage.setItem(AUTOMATIONS_AGENTS_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(AUTOMATIONS_AGENTS_CACHE_PREFIX + companyId, serialized);
    }
  } catch {}
}
