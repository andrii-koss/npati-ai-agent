import { getStoredAuthToken } from "../AuthContext";

export function authHeaders(): Headers {
  const value = new Headers();
  const token = getStoredAuthToken();
  if (token) value.set("Authorization", "Bearer " + token);
  return value;
}

export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}
