import { getStoredAuthToken } from "../AuthContext";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.error?.message || `HTTP ${response.status}: Request failed`);
  }
  return result as T;
}
