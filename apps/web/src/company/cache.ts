import { getStoredAuthToken } from "../AuthContext";
import type { Company } from "./types";

export const COMPANIES_CACHE_KEY = "npati_companies_cache_v1";
export const SELECTED_COMPANY_ID_KEY = "npati_selected_company_id_v1";

export function getCachedCompanies(): Company[] {
  try {
    const raw = sessionStorage.getItem(COMPANIES_CACHE_KEY) || localStorage.getItem(COMPANIES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* storage may be restricted */ }
  return [];
}

export function getCachedSelectedCompanyId(): string {
  try {
    return sessionStorage.getItem(SELECTED_COMPANY_ID_KEY) || localStorage.getItem(SELECTED_COMPANY_ID_KEY) || "";
  } catch { /* storage may be restricted */ }
  return "";
}

export function updateCachedCompanies(list: Company[], currentId?: string): void {
  try {
    const serialized = JSON.stringify(list);
    sessionStorage.setItem(COMPANIES_CACHE_KEY, serialized);
    localStorage.setItem(COMPANIES_CACHE_KEY, serialized);
    if (currentId) {
      sessionStorage.setItem(SELECTED_COMPANY_ID_KEY, currentId);
      localStorage.setItem(SELECTED_COMPANY_ID_KEY, currentId);
    }
  } catch { /* storage may be restricted */ }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => null) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}
