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
  const [revealedSecret, setRevealedSecret] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const base = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}/api`;
  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    const token = getStoredAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init?.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`/api${base}${path}`, { ...init, headers });
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
      setNotice(isUk ? "Дозволені origins збережено" : "Allowed origins saved");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save origins"); }
    finally { setSaving(false); }
  };
  const revealSecret = async () => {
    const confirmed = window.confirm(isUk
      ? "Показати PROJECT_SECRET_KEY? Використовуйте його лише на сервері й ніколи не додавайте у frontend, мобільний бандл чи sandbox."
      : "Reveal PROJECT_SECRET_KEY? Use it server-side only and never in frontend code, mobile bundles or sandboxes.");
    if (!confirmed) return;
    try {
      setError(""); setNotice("");
      const result = await api<{ secretKey: string }>("/keys/reveal", { method: "POST" });
      setRevealedSecret(result.secretKey);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reveal the secret key"); }
  };
  const rotateKeys = async () => {
    const confirmed = window.confirm(isUk
      ? `Ротувати ключі (${environment})? Старі ключі працюють ще кілька ротацій, але клієнти слід оновити.`
      : `Rotate the ${environment} keys? Previous keys keep working for a few rotations, but clients should be updated.`);
    if (!confirmed) return;
    try {
      setError(""); setNotice("");
      const result = await api<{ newSecretKey?: string }>("/keys/rotate", { method: "POST", body: JSON.stringify({ target: "both" }) });
      setRevealedSecret("");
      setNewSecret(result.newSecretKey || "");
      setNotice(isUk ? "Ключі ротовано. Новий секретний ключ показано один раз." : "Keys rotated. The new secret key is shown once.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rotate keys"); }
  };
  const openOpenApi = async () => {
    try {
      setError("");
      const spec = await api<Record<string, unknown>>("/openapi.json");
      const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the OpenAPI document"); }
  };
  return <div className="data-studio-pane">
    <div className="pane-header"><h2>{isUk ? "Project API" : "Project API"}</h2></div>
    {error && <div className="data-studio-alert error" role="alert">{error}</div>}
    {notice && <div className="data-studio-alert" role="status">{notice}</div>}
    {keys && <section>
      <p><strong>API URL:</strong> <code>{keys.apiUrl}</code></p>
      <p><strong>PROJECT_PUBLISHABLE_KEY:</strong> <code>{keys.publishableKey}</code></p>
      <p><strong>PROJECT_SECRET_KEY:</strong> {revealedSecret ? <code>{revealedSecret}</code> : keys.secretKeyMasked} ({isUk ? "лише для серверного середовища" : "server environment only"})</p>
      {newSecret && <p><strong>{isUk ? "Новий секретний ключ" : "New secret key"}:</strong> <code>{newSecret}</code></p>}
      <div className="pane-actions" style={{ margin: "14px 0" }}>
        <button type="button" className="button-secondary" onClick={() => void revealSecret()}>{isUk ? "Показати секретний ключ" : "Reveal secret key"}</button>
        <button type="button" className="button-secondary" onClick={() => void rotateKeys()}>{isUk ? "Ротувати ключі" : "Rotate keys"}</button>
        <button type="button" className="button-secondary" onClick={() => void openOpenApi()}>OpenAPI</button>
      </div>
      <div style={{ marginTop: "16px" }}>
        <label htmlFor="project-api-origins" style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "6px", color: "#334155" }}>
          {isUk ? "Дозволені origins (по одному на рядок)" : "Allowed origins (one per line)"}
        </label>
        <textarea id="project-api-origins" value={origins} onChange={(event) => setOrigins(event.target.value)} rows={4} style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "13px", fontFamily: "monospace" }} />
        <div style={{ marginTop: "8px" }}>
          <button type="button" className="button-primary" disabled={saving} onClick={() => void saveOrigins()}>{saving ? (isUk ? "Збереження…" : "Saving…") : isUk ? "Зберегти origins" : "Save origins"}</button>
        </div>
      </div>
    </section>}
    {usage && <section>
      <h3>{isUk ? "Використання" : "Usage"}</h3>
      <p>
        {usage.requestCount} requests · {usage.collectionsCount} collections · {usage.databaseBytes.toLocaleString()} / {usage.maxDatabaseBytes.toLocaleString()} bytes
        {" · "}{usage.maxRequestsPerMinute} {isUk ? "запитів/хв на ключ" : "requests/min per key"}
      </p>
    </section>}
    <section><h3>{isUk ? "Останні запити" : "Recent requests"}</h3>
      <table className="data-studio-table"><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th></tr></thead>
        <tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.method}</td><td>{log.path}</td><td>{log.statusCode}</td><td>{log.durationMs}</td></tr>)}</tbody></table>
    </section>
  </div>;
}
