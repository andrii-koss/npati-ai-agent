import { getStoredAuthToken } from "./AuthContext";

export interface WebsiteProject {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  type: "website" | "web_app" | "landing_page" | "mobile_app" | "code_project";
  status: string;
  framework?: string;
  repositoryBranch?: string;
  sandboxId?: string;
  previewUrl?: string;
  previewPort?: number;
  lastBuildStatus?: string;
  deploymentStatus?: string;
  deploymentUrl?: string;
  lastDeployedAt?: string;
  revision: number;
  createdAt?: string;
  updatedAt: string;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch("/api" + path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string }; message?: string }) | null;
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `Request failed with status ${res.status}`);
  }
  return json as T;
}

export const WEBSITES_CACHE_PREFIX = "npati_websites_cache_v1_";
export const WEBSITES_LATEST_CACHE_KEY = "npati_websites_cache_latest_v1";

export function getCachedWebsites(companyId?: string): WebsiteProject[] | null {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(WEBSITES_CACHE_PREFIX + companyId)
        || localStorage.getItem(WEBSITES_CACHE_PREFIX + companyId);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
    const latest = sessionStorage.getItem(WEBSITES_LATEST_CACHE_KEY)
      || localStorage.getItem(WEBSITES_LATEST_CACHE_KEY);
    if (latest) {
      const parsed = JSON.parse(latest);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return null;
}

export function updateCachedWebsites(companyId: string, items: WebsiteProject[]) {
  try {
    const serialized = JSON.stringify(items);
    if (companyId) {
      sessionStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
    }
    sessionStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
    localStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
  } catch {}
}
