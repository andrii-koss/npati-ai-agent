export interface ProjectClientStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

class MemoryStorage implements ProjectClientStorage {
  private store = new Map<string, string>();
  getItem(key: string) { return this.store.get(key) ?? null; }
  setItem(key: string, value: string) { this.store.set(key, value); }
  removeItem(key: string) { this.store.delete(key); }
}

export interface ProjectUser {
  id: string;
  email: string;
  name?: string;
  roles: string[];
  status: "active" | "suspended" | "pending";
  emailVerified: boolean;
  createdAt: string;
}

export interface ProjectSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  user: ProjectUser;
}

export type AuthChangeEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED";
export type AuthChangeCallback = (event: AuthChangeEvent, session: ProjectSession | null) => void;

export interface QueryFilter {
  field: string;
  operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
  value: unknown;
}

export interface QueryOptions {
  filter?: Record<string, unknown> | QueryFilter[];
  sort?: string | Array<{ field: string; direction: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  page?: number;
  fields?: string[];
  include?: string[];
}

export interface QueryResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  };
}

export class ProjectApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ProjectClientOptions {
  apiUrl: string;
  projectId?: string;
  publishableKey?: string;
  secretKey?: string;
  storage?: ProjectClientStorage;
  fetch?: typeof fetch;
}

export interface ProjectAuthClient {
  signUp(input: { email: string; password: string; name?: string }): Promise<{ user: ProjectUser; session: ProjectSession | null }>;
  signIn(input: { email: string; password: string }): Promise<{ user: ProjectUser; session: ProjectSession }>;
  signOut(): Promise<void>;
  getUser(): Promise<ProjectUser | null>;
  getSession(): Promise<ProjectSession | null>;
  setSession(session: ProjectSession | null): Promise<void>;
  refreshToken(): Promise<ProjectSession | null>;
  verifyEmail(token: string): Promise<{ success: boolean }>;
  forgotPassword(email: string): Promise<{ success: boolean }>;
  resetPassword(input: { token: string; newPassword: string }): Promise<{ success: boolean }>;
  onAuthStateChange(callback: AuthChangeCallback): () => void;
}

export interface ProjectDataCollection<T = Record<string, unknown>> {
  list(options?: QueryOptions): Promise<QueryResult<T>>;
  get(id: string, options?: { fields?: string[]; include?: string[] }): Promise<T>;
  create(values: Partial<T>): Promise<T>;
  update(id: string, values: Partial<T>): Promise<T>;
  delete(id: string): Promise<{ success: boolean; id: string }>;
}

export interface ProjectClient {
  readonly auth: ProjectAuthClient;
  from<T = Record<string, unknown>>(collection: string): ProjectDataCollection<T>;
  fetchRaw(endpoint: string, init?: RequestInit): Promise<Response>;
}

export function createProjectClient(options: ProjectClientOptions): ProjectClient {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined" && options.secretKey) throw new Error("PROJECT_SECRET_KEY cannot be used in a browser");
  const fetchFn = options.fetch ?? (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);
  if (!fetchFn) {
    throw new Error("No fetch implementation available in current environment");
  }

  // Resolve base URL
  let baseUrl = options.apiUrl.replace(/\/+$/, "");
  if (options.projectId && !baseUrl.includes(options.projectId)) {
    baseUrl = `${baseUrl}/v1/projects/${options.projectId}`;
  }

  // Determine storage
  let storage: ProjectClientStorage;
  if (options.storage) {
    storage = options.storage;
  } else if (typeof (globalThis as { window?: { localStorage?: ProjectClientStorage } }).window?.localStorage !== "undefined") {
    storage = (globalThis as unknown as { window: { localStorage: ProjectClientStorage } }).window.localStorage;
  } else {
    storage = new MemoryStorage();
  }

  const storageKey = `npati_session_${options.projectId || "default"}`;
  const listeners = new Set<AuthChangeCallback>();

  let cachedSession: ProjectSession | null = null;
  let sessionLoaded = false;

  const loadSession = async (): Promise<ProjectSession | null> => {
    if (sessionLoaded) return cachedSession;
    try {
      const raw = await storage.getItem(storageKey);
      if (raw) {
        cachedSession = JSON.parse(raw);
      }
    } catch {
      cachedSession = null;
    }
    sessionLoaded = true;
    return cachedSession;
  };

  const saveSession = async (session: ProjectSession | null) => {
    cachedSession = session;
    sessionLoaded = true;
    try {
      if (session) {
        await storage.setItem(storageKey, JSON.stringify(session));
      } else {
        await storage.removeItem(storageKey);
      }
    } catch {
      // Ignore storage persistence errors in constrained environments
    }
  };

  const notifyListeners = (event: AuthChangeEvent, session: ProjectSession | null) => {
    for (const listener of listeners) {
      try {
        listener(event, session);
      } catch {
        // Ignore subscriber errors
      }
    }
  };

  const request = async <R = unknown>(
    path: string,
    init: RequestInit = {},
    retryOn401 = true,
  ): Promise<R> => {
    const session = await loadSession();
    const headers = new Headers(init.headers || {});

    // Ensure content type
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    // Set project key
    const key = options.secretKey || options.publishableKey;
    if (key && !headers.has("X-Project-Key")) {
      headers.set("X-Project-Key", key);
    }

    // Set authorization header if session exists
    if (session?.accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${session.accessToken}`);
    }

    const fullUrl = path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    const res = await fetchFn(fullUrl, {
      ...init,
      headers,
    });

    // Handle token auto-refresh on 401
    if (res.status === 401 && retryOn401 && session?.refreshToken) {
      const refreshed = await authClient.refreshToken();
      if (refreshed) {
        return request<R>(path, init, false);
      }
    }

    let payload: any;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      payload = await res.json();
    } else {
      payload = await res.text();
    }

    if (!res.ok) {
      const code = payload?.error?.code || (res.status === 404 ? "NOT_FOUND" : res.status === 403 ? "FORBIDDEN" : "API_ERROR");
      const message = payload?.error?.message || (typeof payload === "string" ? payload : res.statusText || "Request failed");
      throw new ProjectApiError(res.status, code, message, payload?.error?.details || payload);
    }

    return payload as R;
  };

  const authClient: ProjectAuthClient = {
    async signUp(input) {
      const res = await request<{ user: ProjectUser; session?: ProjectSession; token?: string; refreshToken?: string; expiresIn?: number }>(
        "/auth/register",
        { method: "POST", body: JSON.stringify(input) },
      );
      let session: ProjectSession | null = null;
      if (res.session) {
        session = res.session;
      } else if (res.token) {
        session = {
          accessToken: res.token,
          refreshToken: res.refreshToken,
          expiresAt: Date.now() + (res.expiresIn ? res.expiresIn * 1000 : 15 * 60 * 1000),
          user: res.user,
        };
      }
      if (session) {
        await saveSession(session);
        notifyListeners("SIGNED_IN", session);
      }
      return { user: res.user, session };
    },

    async signIn(input) {
      const res = await request<{ user: ProjectUser; token: string; refreshToken?: string; expiresIn?: number }>(
        "/auth/login",
        { method: "POST", body: JSON.stringify(input) },
      );
      const session: ProjectSession = {
        accessToken: res.token,
        refreshToken: res.refreshToken,
        expiresAt: Date.now() + (res.expiresIn ? res.expiresIn * 1000 : 15 * 60 * 1000),
        user: res.user,
      };
      await saveSession(session);
      notifyListeners("SIGNED_IN", session);
      return { user: res.user, session };
    },

    async signOut() {
      const session = await loadSession();
      if (session?.refreshToken) {
        try {
          await request("/auth/logout", {
            method: "POST",
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          });
        } catch {
          // Ignore network errors during sign out
        }
      }
      await saveSession(null);
      notifyListeners("SIGNED_OUT", null);
    },

    async getUser() {
      const session = await loadSession();
      if (!session) return null;
      try {
        const res = await request<{ user: ProjectUser }>("/auth/me");
        if (res?.user) {
          session.user = res.user;
          await saveSession(session);
          return res.user;
        }
      } catch {
        // Fall back to cached user if offline or network fails
      }
      return session.user;
    },

    async getSession() {
      return loadSession();
    },

    async setSession(session) {
      await saveSession(session);
      notifyListeners(session ? "USER_UPDATED" : "SIGNED_OUT", session);
    },

    async refreshToken() {
      const session = await loadSession();
      if (!session?.refreshToken) return null;
      try {
        const res = await request<{ token: string; refreshToken?: string; user?: ProjectUser; expiresIn?: number }>(
          "/auth/refresh",
          {
            method: "POST",
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          },
          false,
        );
        const nextSession: ProjectSession = {
          accessToken: res.token,
          refreshToken: res.refreshToken || session.refreshToken,
          expiresAt: Date.now() + (res.expiresIn ? res.expiresIn * 1000 : 15 * 60 * 1000),
          user: res.user || session.user,
        };
        await saveSession(nextSession);
        notifyListeners("TOKEN_REFRESHED", nextSession);
        return nextSession;
      } catch {
        await saveSession(null);
        notifyListeners("SIGNED_OUT", null);
        return null;
      }
    },

    async verifyEmail(token) {
      return request<{ success: boolean }>("/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
    },

    async forgotPassword(email) {
      return request<{ success: boolean }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },

    async resetPassword(input) {
      return request<{ success: boolean }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    onAuthStateChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };

  const from = <T = Record<string, unknown>>(collection: string): ProjectDataCollection<T> => {
    const encodedCol = encodeURIComponent(collection);

    return {
      async list(query = {}) {
        const params = new URLSearchParams();
        if (query.limit !== undefined) params.set("limit", String(query.limit));
        if (query.offset !== undefined) params.set("offset", String(query.offset));
        if (query.page !== undefined) params.set("page", String(query.page));

        if (query.sort) {
          if (Array.isArray(query.sort)) {
            params.set("sort", query.sort.map((s) => `${s.field}:${s.direction}`).join(","));
          } else {
            params.set("sort", query.sort);
          }
        }

        if (query.fields && query.fields.length) {
          params.set("fields", query.fields.join(","));
        }

        if (query.include && query.include.length) {
          params.set("include", query.include.join(","));
        }

        if (query.filter) {
          if (Array.isArray(query.filter)) {
            params.set("filter", JSON.stringify(query.filter));
          } else {
            for (const [key, value] of Object.entries(query.filter)) {
              if (value !== undefined && value !== null) {
                params.set(`filter[${key}]`, typeof value === "object" ? JSON.stringify(value) : String(value));
              }
            }
          }
        }

        const queryStr = params.toString() ? `?${params.toString()}` : "";
        const res = await request<{ data: T[]; meta?: QueryResult<T>["meta"] }>(`/data/${encodedCol}${queryStr}`);
        const defaultMeta = {
          total: res.data?.length ?? 0,
          page: query.page ?? 1,
          limit: query.limit ?? res.data?.length ?? 20,
          hasMore: false,
        };
        return {
          data: res.data ?? [],
          meta: res.meta ?? defaultMeta,
        };
      },

      async get(id, getOptions = {}) {
        const params = new URLSearchParams();
        if (getOptions.fields?.length) params.set("fields", getOptions.fields.join(","));
        if (getOptions.include?.length) params.set("include", getOptions.include.join(","));
        const qs = params.toString() ? `?${params.toString()}` : "";
        const res = await request<{ data: T }>(`/data/${encodedCol}/${encodeURIComponent(id)}${qs}`);
        return res.data;
      },

      async create(values) {
        const res = await request<{ data: T }>(`/data/${encodedCol}`, {
          method: "POST",
          body: JSON.stringify(values),
        });
        return res.data;
      },

      async update(id, values) {
        const res = await request<{ data: T }>(`/data/${encodedCol}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(values),
        });
        return res.data;
      },

      async delete(id) {
        return request<{ success: boolean; id: string }>(`/data/${encodedCol}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      },
    };
  };

  return {
    auth: authClient,
    from,
    fetchRaw: (endpoint, init) => {
      const fullUrl = endpoint.startsWith("http://") || endpoint.startsWith("https://")
        ? endpoint
        : `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
      return fetchFn(fullUrl, init);
    },
  };
}
