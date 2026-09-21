import type { ServiceHealth } from "@npati/shared";

export interface NpatiUser {
  id: string;
  email: string;
  username: string;
  displayName?: string | null;
  avatar?: string | null;
  name?: string | null;
  role?: string;
  status?: string;
  country?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NpatiAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface NpatiAuthResponse {
  user: NpatiUser;
  tokens: NpatiAuthTokens;
}

export interface NpatiRegisterInput {
  email: string;
  password: string;
  username: string;
  displayName?: string;
  country?: string;
}

export interface NpatiLoginInput {
  email: string;
  password: string;
}

export interface NpatiAuthClient {
  register(input: NpatiRegisterInput): Promise<NpatiAuthResponse>;
  login(input: NpatiLoginInput): Promise<NpatiAuthResponse>;
  refresh(refreshToken: string): Promise<{ tokens: NpatiAuthTokens }>;
  logout(refreshToken?: string): Promise<{ success: boolean; message?: string }>;
  getCurrentUser(accessToken: string): Promise<NpatiUser>;
  startInstallationPairing?(input: NpatiInstallationPairingInput): Promise<NpatiInstallationPairing>;
  exchangeInstallationDeviceCode?(deviceCode: string): Promise<NpatiInstallationExchange>;
  createInstallationSession?(installationToken: string): Promise<NpatiInstallationSession>;
  refreshInstallationToken?(installationToken: string): Promise<{ installationId: string; installationToken: string; expiresAt: string }>;
  heartbeatInstallation?(installationToken: string, input?: { domain?: string | null; version?: string | null }): Promise<unknown>;
  revokeInstallation?(accessToken: string, installationId: string): Promise<void>;
}

export interface NpatiInstallationPairingInput {
  installationId: string;
  domain?: string | null;
  version?: string | null;
  deploymentType?: "self_hosted" | "npati_hosted";
  hostedRegistrationToken?: string;
}

export interface NpatiInstallationPairing {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type NpatiInstallationExchange =
  | { status: "authorization_pending" }
  | { status: "authorized"; installationId: string; installationToken: string; expiresAt: string };

export interface NpatiInstallationSession {
  installationId: string;
  accessToken: string;
  user: NpatiUser;
}

export class NpatiHttpAuthClient implements NpatiAuthClient {
  constructor(private readonly baseUrl: string) {}

  private normalizeUrl(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;

    if (base.endsWith("/api/v1")) {
      const stripped = cleanPath.replace(/^\/api\/v1/, "").replace(/^\/api/, "");
      return `${base}${stripped.startsWith("/") ? stripped : `/${stripped}`}`;
    }
    if (base.endsWith("/api")) {
      const stripped = cleanPath.replace(/^\/api/, "");
      const v1Path = stripped.startsWith("/v1") ? stripped : `/v1${stripped}`;
      return `${base}${v1Path}`;
    }

    if (cleanPath.startsWith("/api/v1")) {
      return `${base}${cleanPath}`;
    }
    if (cleanPath.startsWith("/api/")) {
      return `${base}/api/v1${cleanPath.substring(4)}`;
    }
    return `${base}/api/v1${cleanPath}`;
  }

  async register(input: NpatiRegisterInput): Promise<NpatiAuthResponse> {
    const url = this.normalizeUrl("/api/v1/auth/register");
    const body: Record<string, any> = {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      username: input.username,
    };
    if (input.displayName) {
      body.displayName = input.displayName.slice(0, 50);
    }
    if (input.country && input.country.length === 2) {
      body.country = input.country.toUpperCase();
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.success) {
      const message = payload?.message || payload?.error?.issues?.[0]?.message || payload?.error || (payload?.errors ? JSON.stringify(payload.errors) : `Registration failed with HTTP ${response.status}`);
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      (err as any).status = response.status;
      (err as any).code = payload?.code || (response.status === 409 ? "USER_EXISTS" : "REGISTRATION_FAILED");
      throw err;
    }
    return payload.data;
  }

  async login(input: NpatiLoginInput): Promise<NpatiAuthResponse> {
    const url = this.normalizeUrl("/api/v1/auth/login");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.success) {
      const message = payload?.message || payload?.error?.issues?.[0]?.message || payload?.error || `Login failed with HTTP ${response.status}`;
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      (err as any).status = response.status;
      (err as any).code = payload?.code || (response.status === 401 ? "INVALID_CREDENTIALS" : "AUTH_FAILED");
      throw err;
    }
    return payload.data;
  }

  async refresh(refreshToken: string): Promise<{ tokens: NpatiAuthTokens }> {
    const url = this.normalizeUrl("/api/v1/auth/refresh");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.success) {
      const message = payload?.message || payload?.error || `Token refresh failed with HTTP ${response.status}`;
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      (err as any).status = response.status;
      (err as any).code = "REFRESH_FAILED";
      throw err;
    }
    return payload.data;
  }

  async logout(refreshToken?: string): Promise<{ success: boolean; message?: string }> {
    const url = this.normalizeUrl("/api/v1/auth/logout");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const payload = await response.json().catch(() => null) as any;
    return {
      success: response.ok && (payload?.success ?? true),
      message: payload?.message,
    };
  }

  async getCurrentUser(accessToken: string): Promise<NpatiUser> {
    const url = this.normalizeUrl("/api/v1/users/me");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.success) {
      const message = payload?.error || payload?.reason || payload?.message || `User fetch failed with HTTP ${response.status}`;
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      (err as any).status = response.status;
      (err as any).code = "UNAUTHORIZED";
      throw err;
    }
    return payload.data;
  }

  private async installationRequest<T>(path: string, body: unknown, bearer?: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await fetch(this.normalizeUrl(`/api/v1/agent-installations${path}`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.success) {
      const message = payload?.message || payload?.error?.message || payload?.error || `Installation request failed with HTTP ${response.status}`;
      const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
      (error as any).status = response.status;
      throw error;
    }
    return payload.data as T;
  }

  startInstallationPairing(input: NpatiInstallationPairingInput): Promise<NpatiInstallationPairing> {
    return this.installationRequest("/pairing/start", input, undefined, input.hostedRegistrationToken ? { "x-npati-hosted-token": input.hostedRegistrationToken } : {});
  }

  exchangeInstallationDeviceCode(deviceCode: string): Promise<NpatiInstallationExchange> {
    return this.installationRequest("/pairing/token", { deviceCode });
  }

  createInstallationSession(installationToken: string): Promise<NpatiInstallationSession> {
    return this.installationRequest("/session", {}, installationToken);
  }

  refreshInstallationToken(installationToken: string): Promise<{ installationId: string; installationToken: string; expiresAt: string }> {
    return this.installationRequest("/token/refresh", {}, installationToken);
  }

  heartbeatInstallation(installationToken: string, input: { domain?: string | null; version?: string | null } = {}): Promise<unknown> {
    return this.installationRequest("/heartbeat", input, installationToken);
  }

  async revokeInstallation(accessToken: string, installationId: string): Promise<void> {
    const response = await fetch(this.normalizeUrl(`/api/v1/agent-installations/${encodeURIComponent(installationId)}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw Object.assign(new Error(`Installation revoke failed with HTTP ${response.status}`), { status: response.status });
  }
}

export interface HubClient {
  getConnections(): Promise<unknown[]>;
  getCapabilities(): Promise<string[]>;
  createSocialDraft(input: unknown): Promise<unknown>;
  scheduleSocialPost(input: unknown): Promise<unknown>;
  createListing(input: unknown): Promise<unknown>;
  createWordPressDraft(input: unknown): Promise<unknown>;
  publishWordPressPost(input: unknown): Promise<unknown>;
  healthCheck(): Promise<ServiceHealth>;
  auth?: NpatiAuthClient;
}

export class FoundationHubClient implements HubClient {
  readonly auth?: NpatiAuthClient;

  constructor(
    private readonly configured: boolean,
    baseUrl?: string,
  ) {
    if (baseUrl) {
      this.auth = new NpatiHttpAuthClient(baseUrl);
    }
  }

  getConnections(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  getCapabilities(): Promise<string[]> {
    return Promise.resolve([]);
  }

  private unavailable(): never {
    throw new Error("NPATI Hub operations are not enabled in the foundation milestone");
  }

  createSocialDraft(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  scheduleSocialPost(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  createListing(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  createWordPressDraft(): Promise<unknown> { return Promise.reject(this.unavailable()); }
  publishWordPressPost(): Promise<unknown> { return Promise.reject(this.unavailable()); }

  healthCheck(): Promise<ServiceHealth> {
    return Promise.resolve(
      this.configured
        ? { status: "degraded", detail: "Configured; transport implementation is pending" }
        : { status: "not_configured", detail: "NPATI Hub is optional for local startup" },
    );
  }
}

export function createHubClient(config: { baseUrl?: string; apiKey?: string } = {}): HubClient {
  return new FoundationHubClient(Boolean(config.baseUrl && config.apiKey), config.baseUrl);
}

export function createNpatiAuthClient(baseUrl: string): NpatiAuthClient {
  return new NpatiHttpAuthClient(baseUrl);
}

