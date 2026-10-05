import React, { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

type Keys = { apiUrl: string; publishableKey: string; secretKeyMasked: string; corsAllowedOrigins: string[]; rateLimit: { maxRequestsPerMinute: number } };
type Usage = { requestCount: number; databaseBytes: number; collectionsCount: number; maxDatabaseBytes: number; maxRequestsPerMinute: number };
type ApiLog = { id: string; method: string; path: string; statusCode: number; durationMs: number; createdAt: string };

export function DataStudioApiSection({ companyId, projectId, environment, isUk }: { companyId: string; projectId: string; environment: "dev" | "prod"; isUk: boolean }) {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [origins, setOrigins] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const base = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}/api`;
  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    const token = getStoredAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init?.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
    return body as T;
  }, [base]);
  const load = useCallback(async () => {
    try {
      const [keyInfo, usageInfo, requestLogs] = await Promise.all([
        api<Keys>("/keys"), api<Usage>("/usage"), api<ApiLog[]>("/logs?limit=50"),
      ]);
      setKeys(keyInfo);
      setUsage(usageInfo);
      setLogs(requestLogs);
      setOrigins(keyInfo.corsAllowedOrigins.join("\n"));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "API information is unavailable"); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const saveOrigins = async () => {
    setSaving(true);
    try {
      await api("/cors", { method: "PUT", body: JSON.stringify({ origins: origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save origins"); }
    finally { setSaving(false); }
  };
  return <div className="data-studio-pane">
    <div className="pane-header"><h2>{isUk ? "Project API" : "Project API"}</h2></div>
    {error && <div className="data-studio-alert error" role="alert">{error}</div>}
    {keys && <section>
      <p><strong>API URL:</strong> <code>{keys.apiUrl}</code></p>
      <p><strong>PROJECT_PUBLISHABLE_KEY:</strong> <code>{keys.publishableKey}</code></p>
      <p><strong>PROJECT_SECRET_KEY:</strong> {keys.secretKeyMasked} ({isUk ? "лише для серверного середовища" : "server environment only"})</p>
      <p><a href={`/v1/projects/${encodeURIComponent(projectId)}/openapi.json?env=${environment}`} target="_blank" rel="noreferrer">OpenAPI</a></p>
      <label htmlFor="project-api-origins">{isUk ? "Дозволені origins (по одному на рядок)" : "Allowed origins (one per line)"}</label>
      <textarea id="project-api-origins" value={origins} onChange={(event) => setOrigins(event.target.value)} rows={4} />
      <button type="button" disabled={saving} onClick={() => void saveOrigins()}>{isUk ? "Зберегти origins" : "Save origins"}</button>
    </section>}
    {usage && <section><h3>{isUk ? "Використання" : "Usage"}</h3><p>{usage.requestCount} requests · {usage.collectionsCount} collections · {usage.databaseBytes.toLocaleString()} bytes</p></section>}
    <section><h3>{isUk ? "Останні запити" : "Recent requests"}</h3>
      <table className="data-studio-table"><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th></tr></thead>
        <tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.method}</td><td>{log.path}</td><td>{log.statusCode}</td><td>{log.durationMs}</td></tr>)}</tbody></table>
    </section>
  </div>;
}
