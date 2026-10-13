import { getStoredAuthToken } from "./AuthContext";

export interface Goal {
  id: string;
  workspaceId: string;
  businessId: string;
  createdByUserId: string;
  title: string;
  description?: string;
  status: "active" | "completed" | "paused" | "cancelled";
  targetValue?: number | null;
  targetUnit?: string | null;
  currentValue?: number | null;
  targetDate?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalFormData {
  title: string;
  description: string;
  priority: string;
  status: "active" | "completed" | "paused" | "cancelled";
  targetValue: string;
  currentValue: string;
  targetUnit: string;
  targetDate: string;
}

export const initialForm: GoalFormData = {
  title: "",
  description: "",
  priority: "2",
  status: "active",
  targetValue: "",
  currentValue: "",
  targetUnit: "",
  targetDate: "",
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`/api${url}`, {
    ...init,
    headers,
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("npati:unauthorized"));
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    const error = new Error(
      payload?.error?.message ?? `Request failed with HTTP ${response.status}`
    );
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export const GOALS_CACHE_PREFIX = "npati_goals_cache_v1_";
export const GOALS_LATEST_CACHE_KEY = "npati_goals_cache_latest_v1";

export function getCachedGoals(businessId?: string): Goal[] {
  if (!businessId) return [];
  try {
    const raw = sessionStorage.getItem(GOALS_CACHE_PREFIX + businessId) || localStorage.getItem(GOALS_CACHE_PREFIX + businessId);
    if (raw) {
      const parsed = JSON.parse(raw) as Goal[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [];
}

export function updateCachedGoals(businessId: string | undefined, goals: Goal[]) {
  if (!businessId) return;
  try {
    const serialized = JSON.stringify(goals);
    sessionStorage.setItem(GOALS_CACHE_PREFIX + businessId, serialized);
    localStorage.setItem(GOALS_CACHE_PREFIX + businessId, serialized);
    sessionStorage.setItem(GOALS_LATEST_CACHE_KEY, serialized);
    localStorage.setItem(GOALS_LATEST_CACHE_KEY, serialized);
  } catch {}
}
