/**
 * Per-account AI provider isolation for hosted (SaaS) installations.
 *
 * Every account connects its own providers. Each connection is a separate OmniRoute connection owned by that account,
 * and the account gets its own OmniRoute API key whose `allowedConnections` lists only those connections. Inference
 * for the account runs with that key (see `withOmniRouteCredential` in the adapter), so OmniRoute itself refuses any
 * other account's credentials — for a named model, `auto` routing, combos and fallbacks alike. Another account's
 * connections are never listed, tested, refreshed or deleted on its behalf.
 *
 * Self-hosted installations keep one shared provider pool (the owner's) unless NPATI_AI_PROVIDER_ISOLATION=per_user.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { currentOmniRouteCredential, withOmniRouteCredential, type AIProviderSummary, type OmniRouteCredential, type OmniRouteMarketplace, type ProviderConnectInput } from "@npati/omniroute-adapter";
import { CryptoVault, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { AIPreferencesStore } from "./ai-preferences";

export const TENANT_PROVIDERS_SETTING = "ai.tenant-providers";

export interface TenantConnection { providerId: string; connectionId: string; createdAt: string }
interface TenantProviderRecord { keyId?: string; key?: string; connections: TenantConnection[] }
interface TenantScope extends OmniRouteCredential { account?: AuthContext }

export function aiProviderIsolationEnabled(deploymentType?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NPATI_AI_PROVIDER_ISOLATION === "per_user") return true;
  if (env.NPATI_AI_PROVIDER_ISOLATION === "shared") return false;
  return deploymentType === "npati_hosted";
}

export class TenantProviderError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/** Connection modes an account can bring on a hosted installation: its own API key, nothing on the server's network. */
export function tenantConnectable(provider: Pick<AIProviderSummary, "authType" | "local" | "connectionMode" | "credentialOptional">): string | null {
  if (provider.local || provider.authType === "local" || provider.connectionMode === "local") return "Local providers run on the server and are not available on the hosted service.";
  if (provider.authType === "oauth" || provider.connectionMode === "oauth") return "Sign-in providers are not available on the hosted service yet. Use a provider with an API key.";
  if (provider.authType === "web_session" || provider.connectionMode === "web_session") return "Browser-session providers are not available on the hosted service.";
  if (provider.authType === "none" || provider.credentialOptional) return "Providers without a key of your own are not available on the hosted service.";
  return null;
}

const accountKey = (ctx: AuthContext) => `${ctx.workspaceId}\u0000${ctx.userId}`;

export class TenantAIProviders {
  private readonly vault = new CryptoVault();
  private readonly keys = new Map<string, { key?: string; at: number }>();

  constructor(private readonly deps: { store: WorkspaceStore; marketplace: OmniRouteMarketplace; preferences: AIPreferencesStore; cacheMs?: number }) {}

  private async read(ctx: AuthContext): Promise<{ record: TenantProviderRecord; revision: number }> {
    const setting = await this.deps.store.getUserSetting(ctx, TENANT_PROVIDERS_SETTING);
    const value = (setting?.value ?? {}) as Partial<TenantProviderRecord>;
    return { record: { keyId: value.keyId, key: value.key, connections: Array.isArray(value.connections) ? value.connections : [] }, revision: setting?.revision ?? 0 };
  }

  /** Read-modify-write with the setting's revision; one retry covers a concurrent change by the same account. */
  private async update(ctx: AuthContext, change: (record: TenantProviderRecord) => Promise<TenantProviderRecord>) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { record, revision } = await this.read(ctx);
      const next = await change(record);
      if (await this.deps.store.setUserSetting(ctx, TENANT_PROVIDERS_SETTING, next, revision)) {
        this.keys.delete(accountKey(ctx));
        return next;
      }
    }
    throw new TenantProviderError("Your AI providers changed at the same time. Try again.", 409, "PROVIDERS_CHANGED");
  }

  async connections(ctx: AuthContext): Promise<TenantConnection[]> {
    return (await this.read(ctx)).record.connections;
  }

  async connectionFor(ctx: AuthContext, providerId: string): Promise<TenantConnection | undefined> {
    return (await this.connections(ctx)).find((connection) => connection.providerId === providerId);
  }

  /** The account's OmniRoute key, or undefined while it has no connection (its inference is then refused). */
  async keyFor(ctx: AuthContext): Promise<string | undefined> {
    const cached = this.keys.get(accountKey(ctx));
    if (cached && Date.now() - cached.at < (this.deps.cacheMs ?? 60_000)) return cached.key;
    const { record } = await this.read(ctx);
    const key = record.key && record.connections.length ? this.vault.decrypt(record.key) : undefined;
    this.keys.set(accountKey(ctx), { key, at: Date.now() });
    return key;
  }

  async resolveAutoModel(ctx: AuthContext): Promise<string | undefined> {
    return (await this.deps.preferences.get(ctx)).routing.defaultModelId ?? undefined;
  }

  async connect(ctx: AuthContext, provider: AIProviderSummary, input: ProviderConnectInput) {
    const refusal = tenantConnectable(provider);
    if (refusal) throw new TenantProviderError(refusal, 400, "PROVIDER_NOT_AVAILABLE");
    // The provider's own endpoint only: an address of the caller's choosing would make the server call it.
    if (input.baseUrl?.trim()) throw new TenantProviderError("A custom endpoint is not available on the hosted service.", 400, "CUSTOM_ENDPOINT_NOT_ALLOWED");
    if (await this.connectionFor(ctx, provider.id)) throw new TenantProviderError("This provider is already connected to your account.", 409, "ALREADY_CONNECTED");
    const result = await this.deps.marketplace.connect(provider.id, { apiKey: input.apiKey, ...(input.providerSpecificData ? { providerSpecificData: input.providerSpecificData } : {}) }, { ownedBy: ctx.userId });
    try {
      await this.update(ctx, async (record) => {
        const connections = [...record.connections.filter((item) => item.providerId !== provider.id), { providerId: provider.id, connectionId: result.connectionId, createdAt: new Date().toISOString() }];
        return this.withKey(ctx, record, connections);
      });
    } catch (error) {
      // Never leave a connection no account owns.
      await this.deps.marketplace.deleteConnection(result.connectionId).catch(() => undefined);
      throw error;
    }
    return result;
  }

  async disconnect(ctx: AuthContext, providerId: string) {
    const connection = await this.connectionFor(ctx, providerId);
    if (!connection) throw new TenantProviderError("This provider is not connected to your account.", 404, "NOT_CONNECTED");
    // Narrow the key first, so the connection is unusable even if deleting it fails.
    await this.update(ctx, async (record) => this.withKey(ctx, record, record.connections.filter((item) => item.connectionId !== connection.connectionId)));
    await this.deps.marketplace.deleteConnection(connection.connectionId).catch(() => undefined);
    return { disconnected: true, providerId };
  }

  async test(ctx: AuthContext, providerId: string) {
    const connection = await this.connectionFor(ctx, providerId);
    if (!connection) throw new TenantProviderError("This provider is not connected to your account.", 404, "NOT_CONNECTED");
    return this.deps.marketplace.testConnection(connection.connectionId);
  }

  async refreshModels(ctx: AuthContext, providerId: string) {
    const connection = await this.connectionFor(ctx, providerId);
    if (!connection) throw new TenantProviderError("This provider is not connected to your account.", 404, "NOT_CONNECTED");
    return this.deps.marketplace.refreshConnectionModels(connection.connectionId);
  }

  /** A provider as this account sees it: connected only through its own connection, other accounts' hidden. */
  view<T extends AIProviderSummary>(provider: T, own: TenantConnection[]): T {
    const mine = own.find((item) => item.providerId === provider.id);
    const connections = mine ? provider.connections.filter((item) => item.id === mine.connectionId) : [];
    const refusal = tenantConnectable(provider);
    return {
      ...provider,
      connected: Boolean(mine),
      connectionStatus: mine ? (connections[0] ? provider.connectionStatus : "connected") : "not_connected",
      connections,
      ...(refusal && !mine ? { connectable: false, availability: "unavailable" as AIProviderSummary["availability"], availabilityReason: refusal } : {}),
    };
  }

  private async withKey(ctx: AuthContext, record: TenantProviderRecord, connections: TenantConnection[]): Promise<TenantProviderRecord> {
    const ids = connections.map((item) => item.connectionId);
    if (record.keyId && record.key) {
      await this.deps.marketplace.setApiKeyConnections(record.keyId, ids);
      return { ...record, connections };
    }
    const created = await this.deps.marketplace.createScopedApiKey(`NPATI account ${ctx.userId}`, ids);
    return { keyId: created.id, key: this.vault.encrypt(created.key), connections };
  }
}

// ---- The marketplace as one account sees it ----

/**
 * The same marketplace, scoped to the account of the current request: provider lists and counts show only its own
 * connections, and connect, disconnect, test and refresh act on its own connection. Routes, chat checks and Settings
 * pages use it unchanged. Without an account in scope nothing counts as connected and every change is refused.
 */
export function tenantMarketplace(base: OmniRouteMarketplace, providers: () => TenantAIProviders | undefined): OmniRouteMarketplace {
  const account = () => (currentOmniRouteCredential() as TenantScope | null | undefined)?.account;
  const registry = () => {
    const value = providers();
    if (!value) throw new TenantProviderError("AI providers are not ready yet.", 503, "PROVIDERS_NOT_READY");
    return value;
  };
  const required = () => {
    const ctx = account();
    if (!ctx) throw new TenantProviderError("Sign in to manage your AI providers.", 401, "AUTH_REQUIRED");
    return ctx;
  };
  const own = async () => { const ctx = account(); return ctx ? registry().connections(ctx) : []; };
  const sso = "Sign-in providers are not available on the hosted service yet. Use a provider with an API key.";
  const overrides: Record<string, unknown> = {
    async marketplace(query: Parameters<OmniRouteMarketplace["marketplace"]>[0] = {}, addedModelIds: string[] = []) {
      const connections = await own();
      const connectedTab = query.tab === "connected";
      const listing = await base.marketplace(connectedTab ? { ...query, tab: undefined, offset: 0, limit: 1000 } : query, addedModelIds);
      let visible = listing.providers.map((provider) => registry().view(provider, connections));
      let pagination = listing.pagination;
      if (connectedTab) {
        const all = visible.filter((provider) => provider.connected);
        const offset = Math.max(0, query.offset ?? 0), limit = Math.max(1, query.limit ?? 24);
        visible = all.slice(offset, offset + limit);
        pagination = { offset, limit, returned: visible.length, total: all.length, hasMore: offset + visible.length < all.length };
      }
      return { ...listing, providers: visible, pagination,
        counts: { ...listing.counts, connected: connections.length },
        overview: { ...listing.overview, connectedProviders: connections.length } };
    },
    async provider(providerId: string, refresh?: boolean) {
      return registry().view(await base.provider(providerId, refresh), await own());
    },
    async connect(providerId: string, input: ProviderConnectInput) {
      return registry().connect(required(), await base.provider(providerId, true), input);
    },
    async disconnect(providerId: string) { return registry().disconnect(required(), providerId); },
    async test(providerId: string) { return registry().test(required(), providerId); },
    async refreshModels(providerId: string) { return registry().refreshModels(required(), providerId); },
    async startOAuth() { throw new TenantProviderError(sso, 400, "PROVIDER_NOT_AVAILABLE"); },
    async pollOAuth() { throw new TenantProviderError(sso, 400, "PROVIDER_NOT_AVAILABLE"); },
    async completeOAuth() { throw new TenantProviderError(sso, 400, "PROVIDER_NOT_AVAILABLE"); },
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ---- Request and job scopes ----

/** Every HTTP request runs in its own scope; authentication fills in the account and its key. */
export function installTenantScope(app: FastifyInstance) {
  app.addHook("onRequest", (_request, _reply, done) => {
    const scope: TenantScope = {};
    withOmniRouteCredential(scope, done);
  });
}

async function fillScope(scope: TenantScope, ctx: AuthContext, providers: TenantAIProviders) {
  // One request belongs to one account: a second, different identity never takes over the first one's key.
  if (scope.account && accountKey(scope.account) !== accountKey(ctx)) return;
  scope.account = ctx;
  scope.apiKey = await providers.keyFor(ctx).catch(() => undefined);
  scope.resolveAutoModel = () => providers.resolveAutoModel(ctx);
}

/** The same AuthProvider, recording the authenticated account in the request scope. */
export function tenantScopedAuth(auth: AuthProvider, providers: () => TenantAIProviders | undefined): AuthProvider {
  return new Proxy(auth, {
    get(target, property, receiver) {
      if (property === "authenticate") {
        return async (request: FastifyRequest) => {
          const ctx = await target.authenticate(request);
          const scope = currentOmniRouteCredential() as TenantScope | null | undefined;
          const registry = providers();
          if (scope && registry) await fillScope(scope, ctx, registry);
          return ctx;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Background work (automations, workers, inbound messages) runs as its owning account. */
export async function runAsAccount<T>(providers: TenantAIProviders | undefined, ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
  if (!providers) return fn();
  const scope: TenantScope = {};
  await fillScope(scope, ctx, providers);
  return withOmniRouteCredential(scope, fn);
}

// One AI provider registry per process (an installation runs one app). Background work that starts outside an HTTP
// request — automations, inbound messages, email drafts, webhook runs — reaches the AI as its owning account.
let processProviders: TenantAIProviders | undefined;
export function setProcessTenantProviders(providers: TenantAIProviders | undefined) { processProviders = providers; }

/** Runs `fn` as `ctx`'s account, unless the current scope already belongs to it (then nothing changes). */
export async function asAccount<T>(ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
  const providers = processProviders;
  if (!providers) return fn();
  const scope = currentOmniRouteCredential() as TenantScope | null | undefined;
  if (scope?.account && accountKey(scope.account) === accountKey(ctx)) return fn();
  return runAsAccount(providers, ctx, fn);
}
