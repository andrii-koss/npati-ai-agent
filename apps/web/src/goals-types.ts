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
  assignedAgentId?: string | null;
  assignedAgent?: { name: string; role: string; companyName: string } | null;
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
