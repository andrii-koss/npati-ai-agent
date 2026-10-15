import { getStoredAuthToken } from "../AuthContext";

export function authHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = getStoredAuthToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = authHeaders(init?.headers);
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      window.dispatchEvent(new Event("npati:unauthorized"));
    }
    return res;
  });
}

export const NPATI_API_BASE = (import.meta.env.VITE_NPATI_BACKEND_URL || "https://api.npati.com").replace(/\/+$/, "");
