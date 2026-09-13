import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import type { MarketplaceData, Model, Provider, Routing } from "./ai-marketplace-types";

const tabs = ["all", "recommended", "free", "connected"] as const;
const RECOMMENDED_ORDER = [
  "openai", "gemini", "groq", "mistral", "ollama-local", "anthropic", "opencode", "openrouter",
] as const;

function sortRecommended(list: Provider[]): Provider[] {
  return [...list].sort((a, b) => {
    const aIdx = RECOMMENDED_ORDER.indexOf(a.id as (typeof RECOMMENDED_ORDER)[number]);
    const bIdx = RECOMMENDED_ORDER.indexOf(b.id as (typeof RECOMMENDED_ORDER)[number]);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });
}

function searchRelevance(provider: Provider, needle: string): number {
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  const id = provider.id.toLowerCase();
  const name = provider.name.toLowerCase();
  if (id === n || name === n) return 1000;
  if (id.startsWith(n) || name.startsWith(n)) return 600;
  if (name.includes(n) || id.includes(n)) return 300;
  if (provider.description?.toLowerCase().includes(n) || provider.authHint?.toLowerCase().includes(n)) return 100;
  if (provider.capabilities.some((c) => c.toLowerCase().includes(n))) return 50;
  return 10;
}

function sortSearchResults(list: Provider[], needle: string): Provider[] {
  if (!needle.trim()) return list;
  return [...list].sort((a, b) => {
    const aScore = searchRelevance(a, needle);
    const bScore = searchRelevance(b, needle);
    if (bScore !== aScore) return bScore - aScore;
    if (a.connected !== b.connected) return (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
    if (a.recommended !== b.recommended) return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
    return a.name.localeCompare(b.name);
  });
}
const labels: Record<string, string> = {
  api_key: "API key", oauth: "OAuth", none: "No auth", local: "Local", web_session: "Web session", other: "Other",
  free: "Free", free_tier: "Free tier", paid: "Paid", unknown: "Cost unknown",
  not_detected: "Not detected", needs_configuration: "Needs configuration", running: "Running",
};
const connectionModeLabels: Record<Provider["connectionMode"], string> = {
  api_key: "API key", oauth: "OAuth", no_auth: "No auth", web_session: "Web session",
  local: "Local server", local_cli: "Local CLI", embedded_service: "Embedded service",
  cloud_agent: "Cloud agent", internal: "Internal",
};
const availabilityLabels: Record<Provider["availability"], string> = {
  connected: "Connected", ready: "Ready to connect", requires_credentials: "Credentials required",
  requires_login: "Sign-in required", requires_local_runtime: "Local runtime required",
  requires_service: "Service setup required", unavailable: "Unavailable in this runtime", internal: "Internal only",
};

function providerActionLabel(provider: Provider) {
  if (provider.connected) return "Manage";
  if (!provider.connectable) return "View setup";
  if (provider.connectionMode === "oauth") return "Sign in";
  if (provider.connectionMode === "web_session") return "Add session";
  if (provider.connectionMode === "local") return "Configure";
  return "Connect";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(path, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Request failed (${response.status})`);
  return payload as T;
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function ProviderIcon({ providerId, name, size }: { providerId: string; name: string; size?: "small" | "large" }) {
  const [failed, setFailed] = useState(false);
  return <span className={`provider-avatar${size ? ` ${size}` : ""}`} aria-hidden="true">
    <span className="provider-initials">{initials(name)}</span>
    {!failed && <img src={`/api/ai/providers/${encodeURIComponent(providerId)}/icon?surface=light-v3`} alt="" loading="lazy" onError={() => setFailed(true)} />}
  </span>;
}

function formatNumber(value: number) { return new Intl.NumberFormat("en-US").format(value); }

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ai-badge ${tone}`}>{children}</span>;
}

function ProviderBadges({ provider }: { provider: Provider }) {
  return <div className="provider-badges">
    {provider.freeStatus === "free" && <Badge tone="free">FREE</Badge>}
    {provider.freeStatus === "free_tier" && <Badge tone="free">FREE TIER</Badge>}
    {provider.local && <Badge tone="dark">LOCAL</Badge>}
    <Badge>{connectionModeLabels[provider.connectionMode].toUpperCase()}</Badge>
    {provider.availability === "unavailable" && <Badge>UNAVAILABLE</Badge>}
    {provider.availability === "requires_service" && <Badge>SERVICE SETUP</Badge>}
    {provider.connected && <Badge tone="connected">CONNECTED</Badge>}
    {provider.recommended && <Badge tone="red">RECOMMENDED</Badge>}
    {provider.experimental && <Badge>EXPERIMENTAL</Badge>}
  </div>;
}

function ProviderCard({ provider, busy, onOpen, onConnect }: { provider: Provider; busy?: string; onOpen: () => void; onConnect: () => void }) {
  return <article className={`provider-card ${provider.connected ? "is-connected" : ""}`}>
    <button className="provider-card-main" onClick={onOpen}>
      <ProviderIcon providerId={provider.id} name={provider.name} />
      <span className="provider-title"><strong>{provider.name}</strong><small>{provider.local ? "Local & private AI" : provider.category.replaceAll("-", " ")}</small></span>
      <span className={`connection-light ${provider.connected ? "on" : ""}`} aria-label={provider.connected ? "Connected" : "Not connected"} />
    </button>
    <ProviderBadges provider={provider} />
    <p className="provider-description">{(provider.description || provider.authHint || "AI provider available through the Npati registry.").replaceAll("OmniRoute", "Npati")}</p>
    <div className="capability-row">{provider.capabilities.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div>
    <div className="provider-card-footer">
      <span><strong>{formatNumber(provider.modelCount)}</strong> registry models</span>
      <button className={provider.connected ? "button-secondary" : "button-primary"} disabled={!!busy} onClick={onConnect}>
        {busy || providerActionLabel(provider)}
      </button>
    </div>
  </article>;
}

const ROUTING_CACHE_KEY = "npati_ai_routing_cache_v1";
const MODELS_CACHE_KEY = "npati_ai_models_cache_v1";

function getCachedRouting(): Routing | null {
  try {
    const raw = localStorage.getItem(ROUTING_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.mode) return parsed;
    }
  } catch { /* storage unavailable */ }
  return null;
}

function getCachedModels(): Model[] {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* storage unavailable */ }
  return [];
}

function RoutingPanel({ routing, models, onChange }: { routing: Routing | null; models: Model[]; onChange: (routing: Routing) => void }) {
  const [saving, setSaving] = useState(false);
  const activeRouting: Routing = routing || {
    mode: "manual",
    defaultModelId: null,
    automaticModel: "auto",
    preferFree: true,
    fallbackOnFailure: true,
    balanceQualityCost: true,
    compression: "stacked",
    monthlyBudgetUsd: 20,
    warningPercent: 80,
    stopPaidWhenLimitReached: false,
  };
  const [monthlyBudget, setMonthlyBudget] = useState(() => String(activeRouting.monthlyBudgetUsd));
  const [warningPercent, setWarningPercent] = useState(() => String(activeRouting.warningPercent));

  useEffect(() => {
    if (!routing) return;
    setMonthlyBudget(String(routing.monthlyBudgetUsd));
    setWarningPercent(String(routing.warningPercent));
  }, [routing?.monthlyBudgetUsd, routing?.warningPercent]);

  async function save(patch: Partial<Routing>) {
    setSaving(true);
    try {
      const updated = await api<Routing>("/api/ai/routing", {
        method: "PUT",
        body: JSON.stringify({ mode: activeRouting.mode, defaultModelId: activeRouting.defaultModelId, ...patch }),
      });
      onChange(updated);
      try { localStorage.setItem(ROUTING_CACHE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not update AI mode");
    } finally {
      setSaving(false);
    }
  }

  async function saveBudget(event: FormEvent) {
    event.preventDefault();
    await save({ monthlyBudgetUsd: Number(monthlyBudget), warningPercent: Number(warningPercent) });
  }

  return <section className="routing-panel ai-policy-panel">
    <div className="routing-panel-head"><div><p className="section-kicker">AI mode</p><h2>{activeRouting.mode === "manual" ? "Manual model" : "Automatic AI"}</h2><p>{activeRouting.mode === "manual" ? "NPATI uses your selected model and can fall back to automatic routing." : `Npati route: ${activeRouting.automaticModel ?? "auto"}`}</p></div>
      <div className="mode-switch" aria-label="AI mode">
        <button className={activeRouting.mode !== "manual" ? "active" : ""} disabled={saving} onClick={() => save({ mode: "automatic" })}>Automatic <small>Recommended</small></button>
        <button className={activeRouting.mode === "manual" ? "active" : ""} disabled={saving || models.length === 0} onClick={() => save({ mode: "manual" })}>Manual <small>{models.length ? "Use default" : "Add a model first"}</small></button>
      </div>
    </div>
    <div className="ai-policy-grid">
      <div className="ai-policy-options">
        <label><input type="checkbox" checked={activeRouting.preferFree} disabled={saving} onChange={(event) => save({ preferFree: event.target.checked })} /><span><strong>Prefer free when possible</strong><small>Uses a free auto-route and safely opens the wider pool if needed.</small></span></label>
        <label><input type="checkbox" checked={activeRouting.fallbackOnFailure} disabled={saving} onChange={(event) => save({ fallbackOnFailure: event.target.checked })} /><span><strong>Fallback if provider fails</strong><small>Retries quota, unavailable-model and provider failures through Npati.</small></span></label>
        <label><input type="checkbox" checked={activeRouting.balanceQualityCost} disabled={saving} onChange={(event) => save({ balanceQualityCost: event.target.checked })} /><span><strong>Balance quality and cost</strong><small>Scores health, quota, latency, quality and token price together.</small></span></label>
        <label><input type="checkbox" checked={activeRouting.compression === "stacked"} disabled={saving} onChange={(event) => save({ compression: event.target.checked ? "stacked" : "off" })} /><span><strong>Token compression</strong><small>RTK + Caveman for long business chats and research context.</small></span></label>
      </div>
      <form className="ai-budget-settings" onSubmit={saveBudget}>
        <p className="section-kicker">Budget guard</p>
        <label><span>Monthly AI budget, USD</span><input type="number" min="0" step="1" value={monthlyBudget} onChange={(event) => setMonthlyBudget(event.target.value)} /></label>
        <label><span>Warning at, %</span><input type="number" min="1" max="100" step="1" value={warningPercent} onChange={(event) => setWarningPercent(event.target.value)} /></label>
        <label className="budget-stop"><input type="checkbox" checked={activeRouting.stopPaidWhenLimitReached} disabled={saving} onChange={(event) => save({ stopPaidWhenLimitReached: event.target.checked })} /><span>Stop paid AI at the limit</span></label>
        <button className="button-secondary" disabled={saving}>Save budget</button>
        <small>Npati tracks provider cost and enforces endpoint-key budgets. Free routes remain preferred.</small>
      </form>
    </div>
    <div className="ai-runtime-status"><span>✓ Circuit breakers & cooldown</span><span>✓ PII & prompt-injection guardrails</span><span>✓ Images, audio, embeddings & rerank available</span></div>
  </section>;
}

function MyModels({ models, routing, onChanged }: { models: Model[]; routing: Routing | null; onChanged: () => void }) {
  async function setDefault(modelId: string) { await api("/api/ai/models/default", { method: "PUT", body: JSON.stringify({ modelId }) }); onChanged(); }
  async function remove(modelId: string) { await api("/api/ai/models", { method: "DELETE", body: JSON.stringify({ modelId }) }); onChanged(); }
  return <section className="my-models">
    <div className="section-heading"><div><p className="section-kicker">Library</p><h2>My Models</h2></div><span>{models.length} added</span></div>
    {models.length === 0 ? <div className="empty-inline"><strong>No models added yet.</strong><span>Connect a provider, browse its models, and add the ones NPATI should use.</span></div> :
      <div className="my-model-list">{models.map((model) => <div key={model.id} className="my-model-row">
        <ProviderIcon providerId={model.providerId} name={model.providerName} size="small" />
        <span><strong>{model.name}</strong><small>via {model.providerName}{model.local ? " · Local" : ""}</small></span>
        {routing?.defaultModelId === model.id && <Badge tone="red">DEFAULT</Badge>}
        <button disabled={routing?.defaultModelId === model.id} onClick={() => setDefault(model.id)}>Set as default</button>
        <button className="text-danger" onClick={() => remove(model.id)}>Remove</button>
      </div>)}</div>}
  </section>;
}

function ProviderDrawer({ provider, addedIds, onClose, onChanged, onReady }: { provider: Provider; addedIds: Set<string>; onClose: () => void; onChanged: () => void; onReady: () => void }) {
  const [mode, setMode] = useState<"details" | "models" | "connect">(provider.connected ? "details" : "connect");
  const [models, setModels] = useState<Model[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelOffset, setModelOffset] = useState(0);
  const [modelTotal, setModelTotal] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrlDefault?.replace(/^http:\/\/(localhost|127\.0\.0\.1)/, "http://host.docker.internal") || "");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [oauth, setOauth] = useState<{ flowId: string; method: string; authorizationUrl: string; userCode?: string; interval?: number; message?: string } | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const pollRef = useRef<number | null>(null);

  const loadModels = useCallback(async (reset = true, refresh = false) => {
    setLoadingModels(true);
    try {
      const offset = reset ? 0 : modelOffset;
      const query = new URLSearchParams({ offset: String(offset), limit: "48", ...(modelSearch ? { search: modelSearch } : {}), ...(refresh ? { refresh: "true" } : {}) });
      const result = await api<{ models: Model[]; pagination: { total: number; hasMore: boolean } }>(`/api/ai/providers/${encodeURIComponent(provider.id)}/models?${query}`);
      setModels((current) => reset ? result.models : [...current, ...result.models]);
      setModelOffset(offset + result.models.length); setModelTotal(result.pagination.total);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load models"); }
    finally { setLoadingModels(false); }
  }, [modelOffset, modelSearch, provider.id]);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);
  useEffect(() => { if (mode === "models") void loadModels(true); }, [mode, modelSearch]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 2000);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function connect(event?: FormEvent) {
    event?.preventDefault(); setBusy("Connecting…"); setMessage("");
    try {
      await api(`/api/ai/providers/${encodeURIComponent(provider.id)}/connect`, { method: "POST", body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) }) });
      setApiKey(""); setMessage("Connected successfully — choose a model below"); setMode("models"); onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection failed"); }
    finally { setBusy(""); }
  }

  async function startOauth() {
    setBusy("Starting OAuth…"); setMessage("");
    try {
      const flow = await api<typeof oauth>(`/api/ai/providers/${encodeURIComponent(provider.id)}/oauth/start`, { method: "POST" });
      if (!flow) return; setOauth(flow); window.open(flow.authorizationUrl, "_blank", "noopener,noreferrer");
      if (flow.method === "device_code") {
        const poll = async () => {
          try {
            const result = await api<{ status: string; message?: string }>(`/api/ai/oauth/${flow.flowId}/poll`, { method: "POST" });
            setMessage(result.message || "Waiting for authorization…");
            if (result.status === "connected") { if (pollRef.current) window.clearInterval(pollRef.current); setOauth(null); setMessage("Connected successfully — choose a model below"); setMode("models"); onChanged(); }
          } catch (error) { setMessage(error instanceof Error ? error.message : "OAuth failed"); if (pollRef.current) window.clearInterval(pollRef.current); }
        };
        pollRef.current = window.setInterval(poll, Math.max(3, flow.interval || 5) * 1000); void poll();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "OAuth could not start"); }
    finally { setBusy(""); }
  }

  async function completeOauth() {
    if (!oauth) return; setBusy("Completing…");
    try { await api<{ message?: string }>(`/api/ai/oauth/${oauth.flowId}/complete`, { method: "POST", body: JSON.stringify({ code: oauthCode }) }); setMessage("Connected successfully — choose a model below"); setOauth(null); setMode("models"); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "OAuth failed"); }
    finally { setBusy(""); }
  }

  async function action(kind: "test" | "disconnect" | "refresh-models") {
    setBusy(kind === "test" ? "Testing…" : kind === "disconnect" ? "Disconnecting…" : "Refreshing models…"); setMessage("");
    try {
      const result = await api<Record<string, unknown>>(`/api/ai/providers/${encodeURIComponent(provider.id)}${kind === "disconnect" ? "" : `/${kind}`}`, { method: kind === "disconnect" ? "DELETE" : "POST" });
      setMessage(kind === "test" ? (result.valid ? "Connection is healthy" : String(result.error || "Connection test failed")) : kind === "disconnect" ? "Provider disconnected" : `Models synchronized${result.syncedModels ? `: ${result.syncedModels}` : ""}`);
      onChanged(); if (kind === "disconnect") setMode("connect");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(""); }
  }

  async function addModel(model: Model) {
    await api("/api/ai/models/add", { method: "POST", body: JSON.stringify({ providerId: provider.id, modelId: model.id }) });
    onChanged();
    setModels((items) => items.map((item) => item.id === model.id ? { ...item, added: true } : item));
    onClose();
    if (addedIds.size === 0) onReady();
  }

  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="provider-drawer" aria-label="Provider details">
      <button className="drawer-close" onClick={onClose} aria-label="Close"><span>×</span></button>
      <header className="drawer-header"><ProviderIcon providerId={provider.id} name={provider.name} size="large" /><div><p className="section-kicker">Provider details</p><h2>{provider.name}</h2></div></header>
      <ProviderBadges provider={provider} />
      <div className="drawer-tabs"><button className={mode === "details" ? "active" : ""} onClick={() => setMode("details")}>Overview</button><button className={mode === "models" ? "active" : ""} onClick={() => setMode("models")}>Available Models</button><button className={mode === "connect" ? "active" : ""} onClick={() => setMode("connect")}>{provider.connected ? "Settings" : "Setup"}</button></div>
      {message && <div className="inline-message">{message}</div>}
      {mode === "details" && <div className="details-body">
        <dl><div><dt>Status</dt><dd>{availabilityLabels[provider.availability]}</dd></div><div><dt>Type</dt><dd>{provider.local ? "Local" : "Cloud"}</dd></div><div><dt>Setup</dt><dd>{connectionModeLabels[provider.connectionMode]}</dd></div><div><dt>Registry models</dt><dd>{provider.modelCount}</dd></div>{provider.localStatus && <div><dt>Local status</dt><dd>{labels[provider.localStatus] || provider.localStatus}</dd></div>}</dl>
        {provider.availabilityReason && <p className="provider-availability-note">{provider.availabilityReason}</p>}
        <div className="drawer-actions">{provider.connected ? <><button className="button-primary" onClick={() => setMode("models")}>Browse models</button><button className="button-secondary" disabled={!!busy} onClick={() => action("test")}>Test connection</button><button className="button-secondary" disabled={!!busy} onClick={() => action("refresh-models")}>Refresh models</button><button className="button-danger" disabled={!!busy} onClick={() => action("disconnect")}>Disconnect</button></> : <button className="button-primary" onClick={() => setMode("connect")}>{providerActionLabel(provider)}</button>}</div>
      </div>}
      {mode === "connect" && <div className="connect-body">
        {provider.authHint && <p className="auth-hint">{provider.authHint.replaceAll("OmniRoute", "Npati")}</p>}
        {!provider.connectable ? <div className="provider-setup-note"><strong>{availabilityLabels[provider.availability]}</strong><span>{provider.availabilityReason ?? "This provider cannot be configured from the current NPATI runtime."}</span>{provider.website && <a href={provider.website} target="_blank" rel="noreferrer">Open provider documentation ↗</a>}</div> : provider.authType === "oauth" ? <div className="oauth-flow"><button className="button-primary wide" disabled={!!busy} onClick={startOauth}>{busy || `Continue with ${provider.name}`}</button>{oauth && <><div className="oauth-instructions"><strong>Complete authorization in the new window.</strong>{oauth.userCode && <p>Your code: <code>{oauth.userCode}</code></p>}<a href={oauth.authorizationUrl} target="_blank" rel="noreferrer">Open authorization page ↗</a></div>{oauth.method === "authorization_code" && <div className="field"><label>Authorization code or callback URL</label><textarea value={oauthCode} onChange={(event) => setOauthCode(event.target.value)} /><button className="button-primary" disabled={!oauthCode || !!busy} onClick={completeOauth}>Complete connection</button></div>}</>}</div> :
          <form onSubmit={connect}>{provider.authType === "none" && <div className="no-auth-note"><strong>No API key required.</strong><span>Npati supports this provider without credentials.</span></div>}{provider.authType === "web_session" && <div className="provider-setup-note"><strong>Sign in, then return here with the session credential.</strong><span>Opening the provider website does not connect it automatically. Copy the Bearer token or cookie described above and paste it below.</span>{provider.website && <a href={provider.website} target="_blank" rel="noreferrer">Open provider sign-in ↗</a>}</div>}{provider.local && <div className="field"><label>Server URL</label><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></div>}{!["none", "local"].includes(provider.authType) || !provider.credentialOptional ? <div className="field"><label>{provider.authType === "web_session" ? "Bearer token or session cookie" : "API key"}{provider.credentialOptional ? " (optional)" : ""}</label><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!provider.credentialOptional} /><small>The credential is sent directly to Npati and is never stored in the browser.</small></div> : null}<button className="button-primary wide" disabled={!!busy}>{busy || "Connect provider"}</button></form>}
      </div>}
      {mode === "models" && <div className="models-body">
        <div className="model-toolbar"><input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models…" /><button className="button-secondary" disabled={loadingModels || !provider.connected} onClick={() => loadModels(true, true)}>Refresh models</button></div>
        <p className="showing-copy">Showing {models.length} of {modelTotal} models</p>
        {loadingModels && models.length === 0 ? <div className="loading-state">Loading models…</div> : models.length === 0 ? <div className="empty-inline"><strong>No models returned.</strong><span>{provider.connected ? "Try Refresh models or check the provider connection." : "Connect this provider to discover live models."}</span></div> : <div className="model-list">{models.map((model) => <div className="model-row" key={model.id}><span><strong>{model.name}</strong><small>{model.upstreamId}</small><span className="capability-row">{model.capabilities.slice(0, 4).map((capability) => <i key={capability}>{capability}</i>)}</span></span><button disabled={!provider.connected || model.added || addedIds.has(model.id)} onClick={() => addModel(model)}>{model.added || addedIds.has(model.id) ? "Added" : provider.connected ? "Add to NPATI" : "Connect first"}</button></div>)}</div>}
        {models.length < modelTotal && <button className="load-more" disabled={loadingModels} onClick={() => loadModels(false)}>{loadingModels ? "Loading…" : "Load more"}</button>}
      </div>}
    </aside>
  </div>;
}

const OVERVIEW_CACHE_KEY = "npati_ai_overview_cache_v1";

function getCachedOverview(): { providers: number; models: number; connectedProviders: number; addedModels: number } | null {
  try {
    const raw = localStorage.getItem(OVERVIEW_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.providers === "number") return parsed;
    }
  } catch { /* storage unavailable */ }
  return null;
}

export function AIProviderMarketplace() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof tabs)[number]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [type, setType] = useState(""); const [auth, setAuth] = useState(""); const [cost, setCost] = useState(""); const [capability, setCapability] = useState("");
  const [data, setData] = useState<MarketplaceData | null>(null);
  const [overview, setOverview] = useState(() => getCachedOverview());
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(""); const [selected, setSelected] = useState<Provider | null>(null);
  const [models, setModels] = useState<Model[]>(() => getCachedModels());
  const [routing, setRouting] = useState<Routing | null>(() => getCachedRouting());
  const [version, setVersion] = useState(0);

  const cacheRef = useRef<Map<string, { data: MarketplaceData; providers: Provider[] }>>(new Map());

  const getCacheKey = useCallback((t: string, s: string, ty: string, au: string, co: string, ca: string, off: number) => {
    return `${t}|${s}|${ty}|${au}|${co}|${ca}|${off}`;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadLibrary = useCallback(async () => {
    const [added, route] = await Promise.all([api<Model[]>("/api/ai/models/added"), api<Routing>("/api/ai/routing")]);
    setModels(added);
    setRouting(route);
    try {
      localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(added));
      localStorage.setItem(ROUTING_CACHE_KEY, JSON.stringify(route));
    } catch { /* storage unavailable */ }
  }, []);

  const switchTab = useCallback((nextTab: (typeof tabs)[number]) => {
    setTab(nextTab);
    const key = getCacheKey(nextTab, debouncedSearch, nextTab === "all" ? type : "", nextTab === "all" ? auth : "", nextTab === "all" ? cost : "", nextTab === "all" ? capability : "", 0);
    const cached = cacheRef.current.get(key);
    if (cached) {
      const providersList = debouncedSearch ? sortSearchResults(cached.providers, debouncedSearch) : (nextTab === "recommended" ? sortRecommended(cached.providers) : cached.providers);
      setData({ ...cached.data, providers: providersList });
      setProviders(providersList);
      setLoading(false);
    }
  }, [debouncedSearch, type, auth, cost, capability, getCacheKey]);

  const load = useCallback(async (offset = 0, refresh = false) => {
    if (refresh) {
      cacheRef.current.clear();
    }
    const key = getCacheKey(tab, debouncedSearch, tab === "all" ? type : "", tab === "all" ? auth : "", tab === "all" ? cost : "", tab === "all" ? capability : "", offset);
    if (!refresh && offset === 0 && cacheRef.current.has(key)) {
      const cached = cacheRef.current.get(key)!;
      setData(cached.data);
      setProviders(cached.providers);
      setLoading(false);
      return;
    }

    offset ? setLoadingMore(true) : setLoading(true); setError("");
    try {
      const query = new URLSearchParams({
        tab,
        connectableOnly: "true",
        offset: String(offset),
        limit: "24",
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(tab === "all" && type ? { type } : {}),
        ...(tab === "all" && auth ? { auth } : {}),
        ...(tab === "all" && cost ? { cost } : {}),
        ...(tab === "all" && capability ? { capability } : {}),
        ...(refresh ? { refresh: "true" } : {})
      });
      const result = await api<MarketplaceData>(`/api/ai/marketplace?${query}`);
      const resultProviders = debouncedSearch ? sortSearchResults(result.providers, debouncedSearch) : (tab === "recommended" ? sortRecommended(result.providers) : result.providers);
      const normalizedResult = { ...result, providers: resultProviders };
      setData(normalizedResult);
      if (result.overview) {
        setOverview(result.overview);
        try {
          localStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify(result.overview));
        } catch { /* storage unavailable */ }
      }
      setProviders((current) => {
        const next = offset ? [...current, ...resultProviders] : resultProviders;
        cacheRef.current.set(key, { data: normalizedResult, providers: next });
        return next;
      });

      // Pre-warm default tabs so switching between all/recommended/free/connected is instant without any flicker
      if (offset === 0 && !debouncedSearch && !type && !auth && !cost && !capability) {
        const others = tabs.filter((t) => t !== tab);
        for (const other of others) {
          const otherKey = getCacheKey(other, "", "", "", "", "", 0);
          if (!cacheRef.current.has(otherKey)) {
            api<MarketplaceData>(`/api/ai/marketplace?tab=${other}&connectableOnly=true&offset=0&limit=24`)
              .then((res) => {
                const resProviders = other === "recommended" ? sortRecommended(res.providers) : res.providers;
                cacheRef.current.set(otherKey, { data: { ...res, providers: resProviders }, providers: resProviders });
              })
              .catch(() => undefined);
          }
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI Engine unavailable");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [tab, debouncedSearch, type, auth, cost, capability, getCacheKey]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => { void loadLibrary().catch(() => undefined); }, [loadLibrary, version]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data === "npati-oauth-success") {
        cacheRef.current.clear();
        setVersion((value) => value + 1);
      }
    };
    window.addEventListener("message", receive); return () => window.removeEventListener("message", receive);
  }, []);
  const addedIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const changed = () => {
    cacheRef.current.clear();
    setVersion((value) => value + 1);
    if (selected) {
      const selectedId = selected.id;
      api<Provider>(`/api/ai/providers/${encodeURIComponent(selectedId)}`)
        .then((updated) => setSelected((current) => current?.id === selectedId ? updated : current))
        .catch(() => undefined);
    }
  };

  return <main className="ai-marketplace">
    <header className="marketplace-hero">
      <div>
        <p className="eyebrow">Settings · AI</p>
        <h1>
          <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <span>AI Provider</span>
        </h1>
        <p>Connect AI providers and choose the models NPATI Agent can use.</p>
      </div>
    </header>
    <section className="overview-grid">
      <div><strong>{overview ? formatNumber(overview.providers) : (data ? formatNumber(data.overview.providers) : "—")}</strong><span>providers available</span></div>
      <div><strong>{overview ? formatNumber(overview.models) : (data ? formatNumber(data.overview.models) : "—")}</strong><span>models available</span></div>
      <div><strong>{overview ? overview.connectedProviders : (data ? data.overview.connectedProviders : "—")}</strong><span>providers connected</span></div>
      <div><strong>{overview ? overview.addedModels : (data ? data.overview.addedModels : "—")}</strong><span>models added</span></div>
    </section>
    <RoutingPanel routing={routing} models={models} onChange={setRouting} />
    {(overview?.connectedProviders || data?.overview.connectedProviders || models.length > 0) ? <MyModels models={models} routing={routing} onChanged={changed} /> : null}
    <section className="explore-section"><div className="section-heading"><div><p className="section-kicker">Discovery</p><h2>Explore AI Providers</h2></div></div>
      <div className="marketplace-controls"><div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setDebouncedSearch(search); }} placeholder="Search providers or models..." />{search && (<button type="button" className="search-clear-btn" onClick={() => { setSearch(""); setDebouncedSearch(""); }} aria-label="Clear search" title="Clear search">×</button>)}</div><div className="marketplace-tabs">{tabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => switchTab(item)}><span>{item.charAt(0).toUpperCase() + item.slice(1)}</span><small>{data?.counts[item] ?? "—"}</small></button>)}</div></div>
      {tab === "all" && data && <div className="filter-row"><select value={type} onChange={(event) => setType(event.target.value)}><option value="">All types</option><option value="cloud">Cloud</option><option value="local">Local</option></select><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="">All authentication</option>{data.availableFilters.auth.map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select><select value={cost} onChange={(event) => setCost(event.target.value)}><option value="">All costs</option>{data.availableFilters.cost.map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select><select value={capability} onChange={(event) => setCapability(event.target.value)}><option value="">All capabilities</option>{data.availableFilters.capabilities.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>}
      {error ? <div className="engine-error"><strong>AI Engine unavailable</strong><p>NPATI Agent cannot load providers right now. {error}</p><button className="button-primary" onClick={() => load()}>Retry</button></div> : (loading && !data && providers.length === 0) ? <div className="loading-state">Loading providers…</div> : providers.length === 0 ? <div className="engine-error"><strong>{tab === "connected" ? "No AI providers connected yet." : "No providers found."}</strong><p>{tab === "connected" ? "Explore the marketplace and connect your first provider." : "Try a different search or filter."}</p>{tab === "connected" && <button className="button-primary" onClick={() => switchTab("recommended")}>Explore providers</button>}</div> : <><p className="showing-copy">Showing {providers.length} of {data?.pagination.total ?? providers.length} providers</p><div className="provider-grid">{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} onOpen={() => setSelected(provider)} onConnect={() => setSelected(provider)} />)}</div>{data?.pagination.hasMore && <button className="load-more" disabled={loadingMore} onClick={() => load(providers.length)}>{loadingMore ? "Loading…" : "Load more providers"}</button>}</>}
    </section>
    {selected && <ProviderDrawer key={selected.id} provider={selected} addedIds={addedIds} onClose={() => setSelected(null)} onChanged={changed} onReady={() => navigate("/chat")} />}
  </main>;
}

export function OAuthCallback() {
  const location = useLocation();
  const [status, setStatus] = useState("Completing provider connection…");
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const flowId = query.get("npati_flow");
    const code = query.get("code");
    if (!flowId || !code) { setStatus("The callback is missing its flow or authorization code. Return to NPATI and paste the callback URL."); return; }
    api<{ message?: string }>(`/api/ai/oauth/${encodeURIComponent(flowId)}/complete`, { method: "POST", body: JSON.stringify({ code: window.location.href }) })
      .then((result) => { setStatus(result.message || "Connected successfully"); window.opener?.postMessage("npati-oauth-success", window.location.origin); window.setTimeout(() => window.close(), 900); })
      .catch((error) => setStatus(error instanceof Error ? error.message : "OAuth connection failed"));
  }, [location.search]);
  return <main className="oauth-callback-page"><span className="provider-avatar large">AI</span><h1>{status}</h1><p>You can close this window and return to the AI Provider Marketplace.</p><Link to="/settings/ai">Back to Marketplace</Link></main>;
}
