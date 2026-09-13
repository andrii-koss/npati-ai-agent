import { randomUUID } from "node:crypto";
import {
  PINNED_PROVIDER_CATALOG,
  filterProviders,
  normalizeCatalog,
  normalizeModels,
} from "./normalization";
import { PROVIDER_ICON_OVERRIDES } from "./provider-icon-overrides";
import type {
  AIModelSummary,
  AIProviderSummary,
  MarketplaceQuery,
  MarketplaceResponse,
  OAuthProgressResult,
  OAuthStartResult,
  OmniRouteConfig,
  ProviderConnectInput,
  ProviderConnectionSummary,
} from "./types";

type Json = Record<string, any>;
type ManifestProvider = Json & { id: string; models?: Json[] };
type CacheEntry<T> = { expiresAt: number; value: T };
type OAuthFlow = {
  providerId: string;
  method: "device_code" | "authorization_code";
  deviceCode?: string;
  codeVerifier?: string;
  redirectUri?: string;
  state?: string;
  extraData?: Json;
  expiresAt: number;
};

export class OmniRouteError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = "OMNIROUTE_ERROR") {
    super(message);
  }
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as Json;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error.message === "string") return value.error.message;
  if (typeof value.message === "string") return value.message;
  return fallback;
}

function safeConnection(connection: Json): ProviderConnectionSummary {
  const testStatus = typeof connection.testStatus === "string" ? connection.testStatus : "unknown";
  return {
    id: String(connection.id ?? ""),
    providerId: String(connection.provider ?? ""),
    name: typeof connection.name === "string" ? connection.name : undefined,
    active: connection.isActive !== false,
    status: testStatus === "active" ? "connected" : testStatus === "error" ? "error" : "unknown",
    healthy: testStatus === "active" ? true : testStatus === "error" ? false : null,
    lastError: typeof connection.lastError === "string" ? connection.lastError : undefined,
  };
}

function dockerHostUrl(value?: string) {
  if (!value) return value;
  return value.replace(/^http:\/\/(?:localhost|127\.0\.0\.1)(?=[:/])/, "http://host.docker.internal");
}

function fallbackProviderIcon(provider: Record<string, unknown>) {
  const title = String(provider.name ?? provider.id ?? "AI provider").slice(0, 80).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
  const color = typeof provider.color === "string" && /^#[0-9a-f]{3,8}$/i.test(provider.color) ? provider.color : "#171717";
  const icon = String(provider.icon ?? "").toLowerCase();
  const glyph = /terminal|code/.test(icon)
    ? '<path d="M25 30l15 15-15 15M46 62h25"/>'
    : /rocket/.test(icon)
      ? '<path d="M39 58l-10 9 2-14m26-14 10-10c3-3 4-8 4-13-5 0-10 1-13 4L48 30m9 9-18 18-10-10 19-17m-9 27-2 10 10-2"/><circle cx="57" cy="30" r="4"/>'
      : /hub|router|share|network/.test(icon)
        ? '<circle cx="48" cy="27" r="7"/><circle cx="27" cy="65" r="7"/><circle cx="69" cy="65" r="7"/><path d="M43 33 31 58m22-25 12 25M34 65h28"/>'
        : /group|people|community/.test(icon)
          ? '<circle cx="38" cy="38" r="8"/><circle cx="61" cy="41" r="7"/><path d="M21 68c2-12 9-18 18-18s16 6 18 18m-3-14c10 0 17 5 19 14"/>'
          : /image|photo|palette|video/.test(icon)
            ? '<rect x="22" y="25" width="52" height="46" rx="7"/><circle cx="39" cy="40" r="5"/><path d="m27 64 14-14 10 9 8-8 10 13"/>'
            : /search/.test(icon)
              ? '<circle cx="43" cy="43" r="19"/><path d="m57 57 15 15"/>'
              : /cloud/.test(icon)
                ? '<path d="M29 65h39a11 11 0 0 0 1-22 21 21 0 0 0-40-4 13 13 0 0 0 0 26Z"/>'
                : '<path d="m48 20 5 16 16 5-16 5-5 16-5-16-16-5 16-5 5-16Zm20 37 3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8Z"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" data-fallback-icon="${icon || "generic"}"><title>${title}</title><rect width="96" height="96" rx="24" fill="${color}"/><g fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`;
  return { body: new TextEncoder().encode(svg), contentType: "image/svg+xml" };
}

function visibleSvgOnLightSurface(body: Uint8Array) {
  const svg = new TextDecoder().decode(body);
  const paints = [...svg.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]!.trim().toLowerCase())
    .filter((paint) => !["none", "transparent"].includes(paint));
  const white = /^(?:white|#fff|#ffff|#ffffff|#ffffffff|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i;
  if (paints.length === 0 || !paints.every((paint) => white.test(paint))) return body;
  const visible = svg.replace(
    /(\b(?:fill|stroke)\s*=\s*["'])(?:white|#fff|#ffff|#ffffff|#ffffffff|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))(["'])/gi,
    "$1#171717$2",
  );
  return new TextEncoder().encode(visible);
}

export class OmniRouteMarketplace {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly managementPassword?: string;
  private readonly timeoutMs: number;
  private readonly catalogTtlMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly oauthFlows = new Map<string, OAuthFlow>();
  private sessionCookie?: string;
  private bootstrappedManagement = false;

  constructor(config: OmniRouteConfig) {
    this.baseUrl = config.baseUrl?.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.managementPassword = config.managementPassword;
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.catalogTtlMs = config.catalogTtlMs ?? 10 * 60_000;
  }

  private headers(json = true): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.sessionCookie ? { cookie: this.sessionCookie } : {}),
    };
  }

  private async raw(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs) {
    if (!this.baseUrl) throw new OmniRouteError("AI Engine is not configured", 503, "NOT_CONFIGURED");
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(init.body !== undefined), ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      throw new OmniRouteError(
        timeout ? "AI provider request timed out" : "AI Engine unavailable",
        503,
        timeout ? "TIMEOUT" : "UNAVAILABLE",
      );
    }
  }

  private async establishManagementAccess() {
    if (this.managementPassword) {
      const response = await this.raw("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: this.managementPassword }),
      });
      if (response.ok) {
        this.sessionCookie = response.headers.get("set-cookie")?.split(";")[0];
        return;
      }
    }
    if (this.bootstrappedManagement) return;
    this.bootstrappedManagement = true;
    const state = await this.raw("/api/settings/require-login");
    const data = await state.json().catch(() => ({})) as Json;
    if (data.hasPassword === false) {
      const response = await this.raw("/api/settings/require-login", {
        method: "POST",
        body: JSON.stringify({ requireLogin: false }),
      });
      if (response.ok) return;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, options: { management?: boolean; timeoutMs?: number } = {}): Promise<T> {
    let response = await this.raw(path, init, options.timeoutMs);
    if (response.status === 401 && options.management) {
      await this.establishManagementAccess();
      response = await this.raw(path, init, options.timeoutMs);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OmniRouteError(errorMessage(payload, `OmniRoute returned HTTP ${response.status}`), response.status);
    }
    return payload as T;
  }

  private async cached<T>(key: string, refresh: boolean, loader: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!refresh && entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await loader();
    this.cache.set(key, { value, expiresAt: Date.now() + this.catalogTtlMs });
    return value;
  }

  invalidate() {
    this.cache.clear();
  }

  async getManifest(refresh = false) {
    return this.cached("manifest", refresh, async () => {
      const payload = await this.request<{ providers?: ManifestProvider[] }>("/api/v1/provider-plugin-manifest");
      return Array.isArray(payload.providers) ? payload.providers : [];
    });
  }

  async getConnections(): Promise<ProviderConnectionSummary[]> {
    const payload = await this.request<{ connections?: Json[] }>("/api/providers", {}, { management: true });
    return (payload.connections ?? []).map(safeConnection).filter((connection) => connection.id && connection.providerId);
  }

  async getProviders(refresh = false): Promise<{ providers: AIProviderSummary[]; manifest: ManifestProvider[]; health: Json }> {
    const [manifest, connections, health] = await Promise.all([
      this.getManifest(refresh),
      this.getConnections(),
      this.request<Json>("/api/monitoring/health"),
    ]);
    return {
      providers: normalizeCatalog(manifest, connections, health.localProviders ?? {}),
      manifest,
      health,
    };
  }

  async marketplace(query: MarketplaceQuery = {}, addedModelIds: string[] = []): Promise<MarketplaceResponse> {
    const { providers, manifest, health } = await this.getProviders(query.refresh === true);
    const allModels = manifest.reduce((sum, provider) => sum + (provider.models?.length ?? 0), 0);
    const visibleProviders = query.connectableOnly
      ? providers.filter((provider) => provider.connected || (
          provider.connectable && provider.connectionMode !== "web_session"
        ))
      : providers;
    const counts = {
      connected: visibleProviders.filter((provider) => provider.connected).length,
      recommended: visibleProviders.filter((provider) => provider.recommended).length,
      free: visibleProviders.filter((provider) => ["free", "free_tier"].includes(provider.freeStatus)).length,
      local: visibleProviders.filter((provider) => provider.local).length,
      all: visibleProviders.length,
    };
    const filtered = filterProviders(visibleProviders, manifest, query);
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 24));
    const page = filtered.slice(offset, offset + limit);
    return {
      source: {
        version: String(health.version ?? PINNED_PROVIDER_CATALOG.sourceVersion),
        commit: PINNED_PROVIDER_CATALOG.sourceCommit,
        registryProviders: Number(health.providerSummary?.catalogCount ?? providers.length),
        routableProviders: manifest.length,
      },
      overview: { providers: visibleProviders.length, models: allModels, connectedProviders: counts.connected, addedModels: addedModelIds.length },
      counts,
      availableFilters: {
        auth: [...new Set(visibleProviders.map((provider) => provider.authType))].sort(),
        cost: [...new Set(visibleProviders.map((provider) => provider.freeStatus))].sort(),
        capabilities: [...new Set(visibleProviders.flatMap((provider) => provider.capabilities))].sort(),
      },
      providers: page,
      pagination: { offset, limit, returned: page.length, total: filtered.length, hasMore: offset + page.length < filtered.length },
    };
  }

  async configureRuntimePolicy(input: {
    compression: "stacked" | "off";
    monthlyBudgetUsd: number;
    warningPercent: number;
    stopPaidWhenLimitReached: boolean;
  }) {
    if (input.compression === "stacked") {
      await this.request("/api/settings/compression", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          defaultMode: "stacked",
          autoTriggerMode: "stacked",
          autoTriggerTokens: 12000,
          preserveSystemPrompt: true,
          stackedPipeline: [
            { engine: "rtk", intensity: "standard" },
            { engine: "caveman", intensity: "full" },
          ],
        }),
      }, { management: true, timeoutMs: 30_000 });
    }
    const budget = await this.request("/api/usage/budget", {
      method: "POST",
      body: JSON.stringify({
        apiKeyId: "env-key",
        dailyLimitUsd: 0,
        weeklyLimitUsd: 0,
        monthlyLimitUsd: input.stopPaidWhenLimitReached ? input.monthlyBudgetUsd : 0,
        warningThreshold: input.warningPercent / 100,
        resetInterval: "monthly",
        resetTime: "00:00",
      }),
    }, { management: true, timeoutMs: 30_000 });
    return { compression: input.compression, budget };
  }

  async provider(providerId: string, refresh = false) {
    const { providers } = await this.getProviders(refresh);
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw new OmniRouteError("Provider not found", 404, "PROVIDER_NOT_FOUND");
    return provider;
  }

  async providerIcon(providerId: string): Promise<{ body: Uint8Array; contentType: string }> {
    return this.cached(`provider-icon:${providerId}`, false, async () => {
      const normalizedId = providerId.toLowerCase();
      const override = PROVIDER_ICON_OVERRIDES[normalizedId];
      if (override) {
        return override;
      }

      const provider = PINNED_PROVIDER_CATALOG.providers.find((item) => item.id === providerId);
      if (!provider) throw new OmniRouteError("Provider not found", 404, "PROVIDER_NOT_FOUND");
      const iconAsset = typeof provider.iconAsset === "string" ? provider.iconAsset : undefined;
      const localPaths = iconAsset ? [iconAsset] : [];

      for (const path of localPaths) {
        const response = await this.raw(path, {}, 5_000);
        if (!response.ok) continue;
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
        if (contentType?.startsWith("image/")) {
          const body = new Uint8Array(await response.arrayBuffer());
          return { body: contentType === "image/svg+xml" ? visibleSvgOnLightSurface(body) : body, contentType };
        }
      }

      if (typeof provider.website === "string" && provider.website) {
        try {
          const u = new URL(provider.website);
          const domain = u.hostname.replace(/^www\./, "");
          const faviconRes = await fetch(`https://www.google.com/s2/favicons?domain=${domain}&sz=128`, {
            signal: AbortSignal.timeout(4_000),
          });
          if (faviconRes.ok) {
            const body = new Uint8Array(await faviconRes.arrayBuffer());
            if (body.byteLength > 400) {
              const contentType = faviconRes.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
              return { body, contentType };
            }
          }
        } catch {
          // Fall through to generic icon
        }
      }

      return fallbackProviderIcon(provider);
    });
  }

  async models(providerId: string, addedModelIds: string[] = [], refresh = false): Promise<AIModelSummary[]> {
    const [provider, manifest] = await Promise.all([this.provider(providerId, refresh), this.getManifest(refresh)]);
    let rawModels = manifest.find((item) => item.id === providerId)?.models ?? [];
    const connection = provider.connections[0];
    if (connection) {
      const suffix = refresh ? "?refresh=true" : "";
      const payload = await this.request<{ models?: Json[] }>(`/api/providers/${encodeURIComponent(connection.id)}/models${suffix}`, {}, { management: true, timeoutMs: 30_000 });
      if (Array.isArray(payload.models)) rawModels = payload.models;
    }
    return normalizeModels(provider, rawModels, new Set(addedModelIds));
  }

  async connect(providerId: string, input: ProviderConnectInput) {
    const provider = await this.provider(providerId);
    if (!provider.connectable) throw new OmniRouteError(provider.availabilityReason ?? "This registry entry cannot be connected", 400, "PROVIDER_SETUP_REQUIRED");
    if (provider.connections.length > 0) throw new OmniRouteError("Provider is already configured", 409, "ALREADY_CONNECTED");
    if (provider.authType === "oauth") throw new OmniRouteError("Use the OAuth connection flow", 400, "OAUTH_REQUIRED");
    const credential = input.apiKey?.trim();
    if (!provider.credentialOptional && !credential) throw new OmniRouteError("A credential is required", 400, "CREDENTIAL_REQUIRED");
    const baseUrl = input.baseUrl?.trim() || (provider.local ? dockerHostUrl(provider.baseUrlDefault) : undefined);
    let validated = false;
    if (credential) {
      try {
        const validation = await this.request<Json>("/api/providers/validate", {
          method: "POST",
          body: JSON.stringify({ provider: providerId, apiKey: credential, ...(baseUrl ? { baseUrl } : {}) }),
        }, { management: true, timeoutMs: 30_000 });
        if (validation.valid !== true && validation.unsupported !== true) {
          throw new OmniRouteError(errorMessage(validation, "Invalid provider credentials"), 401, "INVALID_CREDENTIALS");
        }
        validated = validation.valid === true;
      } catch (error) {
        if (!(error instanceof OmniRouteError) || !/not supported/i.test(error.message)) throw error;
      }
    }
    const providerSpecificData = {
      ...(input.providerSpecificData ?? {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
    const payload = await this.request<Json>("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: providerId,
        name: input.name?.trim() || "NPATI",
        ...(credential ? { apiKey: credential } : {}),
        ...(Object.keys(providerSpecificData).length ? { providerSpecificData } : {}),
        testStatus: validated ? "active" : "unknown",
      }),
    }, { management: true, timeoutMs: 30_000 });
    const connectionId = typeof payload.connection?.id === "string" ? payload.connection.id : "";
    if (!connectionId) {
      this.invalidate();
      throw new OmniRouteError("Provider connection was created without an identifier", 502, "PROVIDER_CONNECT_FAILED");
    }
    let testResult: Json;
    try {
      testResult = await this.request<Json>(`/api/providers/${encodeURIComponent(connectionId)}/test`, {
        method: "POST", body: "{}",
      }, { management: true, timeoutMs: 30_000 });
      if (testResult.valid !== true) throw new OmniRouteError(errorMessage(testResult, "Provider health check failed"), 502, "PROVIDER_TEST_FAILED");
    } catch (error) {
      try {
        await this.request(`/api/providers/${encodeURIComponent(connectionId)}`, { method: "DELETE" }, { management: true });
      } catch {
        // Preserve the actionable health-check error; cleanup is best-effort.
      }
      this.invalidate();
      if (error instanceof OmniRouteError && error.code === "PROVIDER_TEST_FAILED") throw error;
      throw new OmniRouteError(error instanceof Error ? error.message : "Provider health check failed", 502, "PROVIDER_TEST_FAILED");
    }
    this.invalidate();
    return { connected: true, healthy: true, providerId, connectionId, status: "connected", test: testResult };
  }

  async disconnect(providerId: string) {
    const provider = await this.provider(providerId, true);
    for (const connection of provider.connections) {
      await this.request(`/api/providers/${encodeURIComponent(connection.id)}`, { method: "DELETE" }, { management: true });
    }
    this.invalidate();
    return { disconnected: true, providerId };
  }

  async test(providerId: string) {
    const provider = await this.provider(providerId, true);
    const connection = provider.connections[0];
    if (!connection) throw new OmniRouteError("Provider is not connected", 409, "NOT_CONNECTED");
    return this.request<Json>(`/api/providers/${encodeURIComponent(connection.id)}/test`, {
      method: "POST", body: "{}",
    }, { management: true, timeoutMs: 30_000 });
  }

  async refreshModels(providerId: string) {
    const provider = await this.provider(providerId, true);
    const connection = provider.connections[0];
    if (!connection) throw new OmniRouteError("Provider is not connected", 409, "NOT_CONNECTED");
    const result = await this.request<Json>(`/api/providers/${encodeURIComponent(connection.id)}/sync-models`, {
      method: "POST", body: "{}",
    }, { management: true, timeoutMs: 90_000 });
    this.invalidate();
    return result;
  }

  async startOAuth(providerId: string): Promise<OAuthStartResult> {
    const provider = await this.provider(providerId);
    if (provider.authType !== "oauth") throw new OmniRouteError("Provider does not use OAuth", 400);
    let device: Json | null = null;
    try {
      device = await this.request<Json>(`/api/oauth/${encodeURIComponent(providerId)}/device-code`, {}, { management: true, timeoutMs: 30_000 });
    } catch (error) {
      if (!(error instanceof OmniRouteError) || !/does not support device code/i.test(error.message)) throw error;
    }
    const flowId = randomUUID();
    if (device) {
      const deviceCode = String(device.device_code ?? device.deviceCode ?? "");
      const authorizationUrl = String(device.verification_uri_complete ?? device.verificationUriComplete ?? device.verification_uri ?? device.verificationUri ?? "");
      if (!deviceCode || !authorizationUrl) throw new OmniRouteError("OAuth device flow returned an incomplete response", 502);
      const expiresIn = Number(device.expires_in ?? device.expiresIn ?? 900);
      this.oauthFlows.set(flowId, {
        providerId, method: "device_code", deviceCode,
        codeVerifier: typeof device.codeVerifier === "string" ? device.codeVerifier : undefined,
        extraData: device,
        expiresAt: Date.now() + expiresIn * 1_000,
      });
      return {
        flowId, method: "device_code", authorizationUrl,
        userCode: String(device.user_code ?? device.userCode ?? "") || undefined,
        expiresIn, interval: Number(device.interval ?? 5),
      };
    }
    const redirectUri = `http://localhost:3000/settings/ai/oauth/callback?npati_flow=${encodeURIComponent(flowId)}`;
    const auth = await this.request<Json>(`/api/oauth/${encodeURIComponent(providerId)}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`, {}, { management: true, timeoutMs: 30_000 });
    if (auth.supported === false || !auth.authUrl) throw new OmniRouteError(errorMessage(auth, "OAuth is not configured for this provider"), 400);
    this.oauthFlows.set(flowId, {
      providerId, method: "authorization_code", codeVerifier: auth.codeVerifier,
      redirectUri: String(auth.redirectUri ?? redirectUri), state: auth.state,
      expiresAt: Date.now() + 10 * 60_000,
    });
    return { flowId, method: "authorization_code", authorizationUrl: String(auth.authUrl), expiresIn: 600, message: "Complete sign-in, then paste the returned code or callback URL." };
  }

  private oauthFlow(flowId: string) {
    const flow = this.oauthFlows.get(flowId);
    if (!flow || flow.expiresAt < Date.now()) {
      this.oauthFlows.delete(flowId);
      throw new OmniRouteError("OAuth flow expired. Start again.", 410, "OAUTH_EXPIRED");
    }
    return flow;
  }

  async pollOAuth(flowId: string): Promise<OAuthProgressResult> {
    const flow = this.oauthFlow(flowId);
    if (flow.method !== "device_code") throw new OmniRouteError("This OAuth flow is not pollable", 400);
    try {
      const result = await this.request<Json>(`/api/oauth/${encodeURIComponent(flow.providerId)}/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: flow.deviceCode, codeVerifier: flow.codeVerifier, extraData: flow.extraData }),
      }, { management: true, timeoutMs: 30_000 });
      if (result.success === true || result.connection) {
        this.oauthFlows.delete(flowId);
        this.invalidate();
        return { status: "connected", message: "Connected successfully" };
      }
      return { status: "pending", message: errorMessage(result, "Waiting for authorization") };
    } catch (error) {
      if (error instanceof OmniRouteError && /pending|slow_down|authorization_pending/i.test(error.message)) {
        return { status: "pending", message: "Waiting for authorization" };
      }
      throw error;
    }
  }

  async completeOAuth(flowId: string, codeOrUrl: string): Promise<OAuthProgressResult> {
    const flow = this.oauthFlow(flowId);
    if (flow.method !== "authorization_code") throw new OmniRouteError("This OAuth flow does not accept a code", 400);
    let code = codeOrUrl.trim();
    let returnedState: string | undefined;
    try {
      const url = new URL(code);
      code = url.searchParams.get("code") ?? code;
      returnedState = url.searchParams.get("state") ?? undefined;
    } catch { /* A raw authorization code is also valid. */ }
    await this.request<Json>(`/api/oauth/${encodeURIComponent(flow.providerId)}/exchange`, {
      method: "POST",
      body: JSON.stringify({ code, redirectUri: flow.redirectUri, codeVerifier: flow.codeVerifier, state: returnedState ?? flow.state }),
    }, { management: true, timeoutMs: 30_000 });
    this.oauthFlows.delete(flowId);
    this.invalidate();
    return { status: "connected", message: "Connected successfully" };
  }
}
