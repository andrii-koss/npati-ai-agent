import { useRef } from "react";
import { getTokenRefreshDelayMs } from "./auth-token-refresh";
import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | null;
  role?: string;
}

export interface InstallationPairing {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  register(params: { email: string; password: string; username: string; displayName?: string }): Promise<void>;
  beginInstallationConnection(): Promise<InstallationPairing>;
  pollInstallationConnection(deviceCode: string): Promise<boolean>;
  logout(): Promise<void>;
  /** Signs out of NPATI Agent (and npati.com on ai.npati.com); allDevices also revokes the person's other sessions. */
  signOutEverywhere(allDevices?: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

const STORAGE_TOKEN_KEY = "npati_agent_access_token";
const STORAGE_REFRESH_KEY = "npati_agent_refresh_token";
const STORAGE_USER_KEY = "npati_agent_user";
const PENDING_PAIRING_KEY = "npati_agent_pending_pairing";
const SSO_SUPPRESSED_KEY = "npati_agent_sso_suppressed";
const NPATI_CENTRAL_API_URL = ((typeof import.meta !== "undefined" && import.meta.env?.VITE_NPATI_BACKEND_URL) || "https://api.npati.com").replace(/\/+$/, "");

type PendingPairing = { deviceCode: string; verificationUriComplete: string; expiresAt: number };

function readPendingPairing(): PendingPairing | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_PAIRING_KEY) || "null") as PendingPairing | null;
    if (!value?.deviceCode || value.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_PAIRING_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(PENDING_PAIRING_KEY);
    return null;
  }
}

export function getStoredAuthToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(STORAGE_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setStoredRefreshToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(STORAGE_REFRESH_KEY, token);
    } else {
      localStorage.removeItem(STORAGE_REFRESH_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

export function getStoredAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredAuthUser(user: AuthUser | null) {
  const restored = preserveStoredAvatar(user);
  try {
    if (restored) {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(restored));
    } else {
      localStorage.removeItem(STORAGE_USER_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

/** Local fallback profiles omit central profile fields; omission is not an avatar removal. */
function preserveStoredAvatar(user: AuthUser | null): AuthUser | null {
  if (!user?.id || user.avatar !== undefined) return user;
  const stored = getStoredAuthUser();
  return stored?.id === user.id && stored.avatar !== undefined ? { ...user, avatar: stored.avatar } : user;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(getStoredAuthToken());
  const [user, setUserState] = useState<AuthUser | null>(getStoredAuthUser());
  const setUser = useCallback((value: AuthUser | null) => setUserState(preserveStoredAvatar(value)), []);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const renewalInFlight = useRef<Promise<"ok" | "unauthorized" | "temporary"> | null>(null);
  const authCheckInFlight = useRef<Promise<void> | null>(null);

  const logout = useCallback(async (waitForCheck = true, everywhere = false) => {
    sessionStorage.setItem(SSO_SUPPRESSED_KEY, "1");
    if (waitForCheck) await authCheckInFlight.current?.catch(() => undefined);
    const refreshToken = getStoredRefreshToken();
    const accessToken = getStoredAuthToken();
    try {
      await fetch("/api/auth/installation/browser-logout", { method: "POST" }).catch(() => null);
      // The server revokes the token the page holds (and, everywhere, every token of the person), so a copied token
      // stops working at once instead of when it expires (V6 step 17).
      if (refreshToken || accessToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
          body: JSON.stringify({ ...(refreshToken ? { refreshToken } : {}), ...(everywhere ? { everywhere: true } : {}) }),
        }).catch(() => null);
      }
    } finally {
      sessionStorage.removeItem(PENDING_PAIRING_KEY);
      setStoredAuthToken(null);
      setStoredRefreshToken(null);
      setStoredAuthUser(null);
      setToken(null);
      setUser(null);
      setError(null);
      window.dispatchEvent(new Event("npati:auth-changed"));
    }
  }, []);

  const signOutEverywhere = useCallback(async (allDevices = false) => {
    await logout(true, allDevices);
    if (window.location.hostname === "ai.npati.com") {
      const response = await fetch(`${NPATI_CENTRAL_API_URL}/api/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => null);
      if (!response?.ok) {
        throw new Error("Signed out of NPATI Agent, but could not sign out of npati.com. Please sign out there manually.");
      }
    }
  }, [logout]);

  const disconnect = useCallback(async () => {
    sessionStorage.setItem(SSO_SUPPRESSED_KEY, "1");
    await authCheckInFlight.current?.catch(() => undefined);
    const currentToken = getStoredAuthToken();
    if (!currentToken) throw new Error("An authenticated NPATI session is required.");
    const response = await fetch("/api/auth/installation/disconnect", {
      method: "POST",
      headers: { authorization: "Bearer " + currentToken },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error?.message || "Could not disconnect this NPATI account.");
    }
    setStoredAuthToken(null);
    setStoredRefreshToken(null);
    setStoredAuthUser(null);
    setToken(null);
    setUser(null);
    setError(null);
    sessionStorage.removeItem(PENDING_PAIRING_KEY);
    window.dispatchEvent(new Event("npati:auth-changed"));
  }, []);

  const completeInstallationConnection = useCallback(async (deviceCode: string): Promise<boolean> => {
    const response = await fetch("/api/auth/installation/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 202 || payload?.data?.status === "authorization_pending") return false;
    if (!response.ok || !payload?.success || !payload.data?.accessToken || !payload.data?.user) {
      const message = payload?.error?.message || "NPATI account connection failed.";
      setError(message);
      throw new Error(message);
    }
    sessionStorage.removeItem(PENDING_PAIRING_KEY);
    sessionStorage.removeItem(SSO_SUPPRESSED_KEY);
    setStoredAuthToken(payload.data.accessToken);
    setStoredRefreshToken(null);
    setStoredAuthUser(payload.data.user);
    setToken(payload.data.accessToken);
    setUser(payload.data.user);
    window.dispatchEvent(new Event("npati:auth-changed"));
    return true;
  }, []);

  const checkAuth = useCallback((forceSession = false): Promise<void> => {
    if (authCheckInFlight.current) {
      const inFlight = authCheckInFlight.current;
      return forceSession ? inFlight.then(() => checkAuth(true)) : inFlight;
    }
    const check = (async () => {
    let officialHosted = false;
    try {
      const statusResponse = await fetch("/api/auth/installation/status");
      const statusPayload = await statusResponse.json().catch(() => null);
      if (!statusResponse.ok || !statusPayload?.success || !statusPayload.data?.deploymentType) {
        setIsLoading(false);
        return;
      }
      officialHosted = statusPayload.data.deploymentType === "npati_hosted";
    } catch {
      // Deployment mode is unknown; a temporary status failure must not log the user out.
      setIsLoading(false);
      return;
    }

    if (officialHosted) {
      const currentToken = getStoredAuthToken();
      let tokenRejected = false;
      if (currentToken && !forceSession) {
        try {
          const meResponse = await fetch("/api/auth/me", {
            headers: { authorization: `Bearer ${currentToken}` },
          });
          if (meResponse.ok) {
            const mePayload = await meResponse.json().catch(() => null);
            if (!mePayload?.success || !mePayload.data?.user) {
              setIsLoading(false);
              return;
            }
            setStoredAuthUser(mePayload.data.user);
            setToken(currentToken);
            setUser(mePayload.data.user);
            setError(null);
            setIsLoading(false);
            return;
          }
          if (meResponse.status !== 401 && meResponse.status !== 403) {
            setIsLoading(false);
            return;
          }
          tokenRejected = true;
        } catch {
          // A temporary backend failure must not remove a usable browser session.
          setIsLoading(false);
          return;
        }
      }

      try {
        const sessionResponse = await fetch("/api/auth/installation/session", { method: "POST" });
        if (sessionResponse.ok) {
          const sessionPayload = await sessionResponse.json().catch(() => null);
          if (sessionPayload?.success && sessionPayload.data?.accessToken && sessionPayload.data?.user) {
            setStoredAuthToken(sessionPayload.data.accessToken);
            setStoredRefreshToken(null);
            setStoredAuthUser(sessionPayload.data.user);
            setToken(sessionPayload.data.accessToken);
            setUser(sessionPayload.data.user);
            setError(null);
            setIsLoading(false);
            return;
          }
          setIsLoading(false);
          return;
        }
        if (sessionResponse.status !== 401 && sessionResponse.status !== 403) {
          setIsLoading(false);
          return;
        }
      } catch {
        setIsLoading(false);
        return;
      }

      if (sessionStorage.getItem(SSO_SUPPRESSED_KEY) === "1") {
        setIsLoading(false);
        return;
      }

      try {
        const startResponse = await fetch("/api/auth/installation/start", { method: "POST" });
        const startPayload = await startResponse.json().catch(() => null);
        if (!startResponse.ok || !startPayload?.success) {
          throw new Error(startPayload?.error?.message || "Could not start NPATI SSO.");
        }
        const pairing = startPayload.data as InstallationPairing;
        const approveResponse = await fetch(`${NPATI_CENTRAL_API_URL}/api/v1/auth/agent/pairing/approve`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-npati-agent-sso": "1" },
          body: JSON.stringify({ userCode: pairing.userCode }),
        });
        const approvePayload = await approveResponse.json().catch(() => null);
        if (approveResponse.status === 401) {
          if (!currentToken || tokenRejected) {
            sessionStorage.removeItem(PENDING_PAIRING_KEY);
            setStoredAuthToken(null);
            setStoredRefreshToken(null);
            setStoredAuthUser(null);
            setToken(null);
            setUser(null);
          }
          setError(null);
          setIsLoading(false);
          return;
        }
        if (!approveResponse.ok || !approvePayload?.success) {
          throw new Error(approvePayload?.error?.message || "Could not synchronize the current NPATI account.");
        }
        let connected = false;
        for (let attempt = 0; attempt < 4 && !connected; attempt++) {
          if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 750));
          connected = await completeInstallationConnection(pairing.deviceCode);
        }
        if (!connected) {
          throw new Error("NPATI account synchronization is still pending.");
        }
        setIsLoading(false);
        return;
      } catch (cause) {
        // Only discard credentials when /auth/me explicitly rejected the token.
        if (tokenRejected) {
          setStoredAuthToken(null);
          setStoredRefreshToken(null);
          setStoredAuthUser(null);
          setToken(null);
          setUser(null);
        }
        setError(cause instanceof Error ? cause.message : "Could not synchronize the current NPATI account.");
        setIsLoading(false);
        return;
      }
    }
    const currentToken = getStoredAuthToken();
    if (!currentToken) {
      const pendingPairing = readPendingPairing();
      if (pendingPairing) {
        try {
          if (await completeInstallationConnection(pendingPairing.deviceCode)) {
            setIsLoading(false);
            return;
          }
        } catch {
          sessionStorage.removeItem(PENDING_PAIRING_KEY);
        }
      }
      try {
        const response = await fetch("/api/auth/installation/session", { method: "POST" });
        const payload = await response.json().catch(() => null);
        if (response.ok && payload?.success && payload.data?.accessToken && payload.data?.user) {
          setStoredAuthToken(payload.data.accessToken);
          setStoredAuthUser(payload.data.user);
          setToken(payload.data.accessToken);
          setUser(payload.data.user);
          setIsLoading(false);
          return;
        }
      } catch {
        // An unconnected installation is handled by the connect dialog.
      }
      setUser(null);
      setToken(null);
      setStoredAuthUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/me", {
        headers: {
          authorization: `Bearer ${currentToken}`,
        },
      });

      if (response.ok) {
        const payload = await response.json();
        if (payload.success && payload.data?.user) {
          const verifiedUser: AuthUser = {
            ...payload.data.user,
            id: payload.data.user.id || "dev-user",
            displayName: payload.data.user.displayName || "User",
            email: payload.data.user.email || getStoredAuthUser()?.email || "webuser1@example.com",
            username: payload.data.user.username || "webuser1",
            role: payload.data.user.role || "user",
          };
          setUser(verifiedUser);
          setStoredAuthUser(verifiedUser);
          setToken(currentToken);
        } else {
          await logout(false);
        }
      } else if (response.status === 401) {
        // Try refresh token if available
        const refreshToken = getStoredRefreshToken();
        if (refreshToken) {
          const refreshRes = await fetch("/api/auth/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            const newAccess = refreshData.data?.tokens?.accessToken || refreshData.tokens?.accessToken;
            if (newAccess) {
              setStoredAuthToken(newAccess);
              setToken(newAccess);
              if (refreshData.data?.tokens?.refreshToken || refreshData.tokens?.refreshToken) {
                setStoredRefreshToken(refreshData.data?.tokens?.refreshToken || refreshData.tokens?.refreshToken);
              }
              const meRes = await fetch("/api/auth/me", {
                headers: { authorization: `Bearer ${newAccess}` },
              });
              if (meRes.ok) {
                const meData = await meRes.json();
                const refreshedUser: AuthUser = {
                  ...meData.data?.user,
                  id: meData.data?.user?.id || "dev-user",
                  displayName: meData.data?.user?.displayName || "User",
                  email: meData.data?.user?.email || getStoredAuthUser()?.email || "webuser1@example.com",
                  username: meData.data?.user?.username || "webuser1",
                  role: meData.data?.user?.role || "user",
                };
                setUser(refreshedUser);
                setStoredAuthUser(refreshedUser);
                setIsLoading(false);
                return;
              }
            }
          }
        }
        const installationSession = await fetch("/api/auth/installation/session", { method: "POST" }).catch(() => null);
        if (installationSession?.ok) {
          const installationData = await installationSession.json().catch(() => null);
          if (installationData?.data?.accessToken && installationData.data?.user) {
            setStoredAuthToken(installationData.data.accessToken);
            setStoredAuthUser(installationData.data.user);
            setToken(installationData.data.accessToken);
            setUser(installationData.data.user);
            return;
          }
        }
        // Only a definite refusal ends the session. A reload while the central backend was slow or down (a failed
        // request, a 5xx, a rate limit) used to sign the person out and delete this browser's installation cookie, so
        // the session could not come back on its own. Kept, it is renewed on the next check (focus, timer, reload).
        if (installationSession && (installationSession.status === 401 || installationSession.status === 403)) await logout(false);
      } else {
        // Server response other than 401: preserve session
      }
    } catch {
      // Network failure or temporary glitch: keep persistent session
    } finally {
      setIsLoading(false);
    }
    })().catch((cause) => {
      console.error("NPATI authorization check failed", cause);
      setIsLoading(false);
    });
    authCheckInFlight.current = check;
    void check.finally(() => {
      if (authCheckInFlight.current === check) authCheckInFlight.current = null;
    });
    return check;
  }, [completeInstallationConnection, logout]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkAuth();
    };
    const onFocus = () => { void checkAuth(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkAuth]);


  const renewAccessToken = useCallback((): Promise<"ok" | "unauthorized" | "temporary"> => {
    if (renewalInFlight.current) return renewalInFlight.current;
    const currentToken = getStoredAuthToken();
    if (!currentToken) return Promise.resolve("unauthorized");

    const renewal = (async (): Promise<"ok" | "unauthorized" | "temporary"> => {
      try {
        const response = await fetch("/api/auth/installation/session", { method: "POST" });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (!payload?.data?.accessToken || !payload.data?.user) return "temporary";
          if (getStoredAuthToken() !== currentToken) return "temporary";
          setStoredAuthToken(payload.data.accessToken);
          setStoredAuthUser(payload.data.user);
          setToken(payload.data.accessToken);
          setUser(payload.data.user);
          return "ok";
        }
        if (response.status !== 401 && response.status !== 403) return "temporary";
      } catch {
        return "temporary";
      }

      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) return "unauthorized";
      try {
        const response = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) return response.status === 401 || response.status === 403 ? "unauthorized" : "temporary";
        const payload = await response.json().catch(() => null);
        const tokens = payload?.data?.tokens || payload?.tokens;
        if (!tokens?.accessToken) return "temporary";
        if (getStoredAuthToken() !== currentToken) return "temporary";
        setStoredAuthToken(tokens.accessToken);
        setToken(tokens.accessToken);
        if (tokens.refreshToken) setStoredRefreshToken(tokens.refreshToken);
        return "ok";
      } catch {
        return "temporary";
      }
    })();

    renewalInFlight.current = renewal;
    void renewal.finally(() => {
      if (renewalInFlight.current === renewal) renewalInFlight.current = null;
    });
    return renewal;
  }, []);

  useEffect(() => {
    if (isLoading || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delayMs: number) => {
      timer = setTimeout(async () => {
        const result = await renewAccessToken();
        if (cancelled) return;
        if (result === "unauthorized") {
          await checkAuth(true);
          if (!cancelled && getStoredAuthToken() === token) schedule(30_000);
        } else {
          schedule(result === "ok" ? getTokenRefreshDelayMs(getStoredAuthToken() || token) : 5000);
        }
      }, delayMs);
    };
    schedule(getTokenRefreshDelayMs(token));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, isLoading, renewAccessToken, checkAuth]);

  useEffect(() => {
    const handleUnauthorized = async () => {
      if (!getStoredAuthToken()) return;
      const result = await renewAccessToken();
      if (result === "unauthorized") void checkAuth(true);
    };
    window.addEventListener("npati:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("npati:unauthorized", handleUnauthorized);
  }, [renewAccessToken, checkAuth]);

  const login = async (email: string, password: string) => {
    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        const message = payload?.error?.message || payload?.message || "Invalid email or password.";
        setError(message);
        throw new Error(message);
      }

      const data = payload?.data || payload;
      const authedUser = data?.user || payload?.user;
      const tokens = data?.tokens || payload?.tokens;
      if (!tokens?.accessToken) {
        throw new Error("No access token received from authentication service.");
      }

      setStoredAuthToken(tokens.accessToken);
      if (tokens.refreshToken) {
        setStoredRefreshToken(tokens.refreshToken);
      }
      setStoredAuthUser(authedUser);
      setToken(tokens.accessToken);
      setUser(authedUser);
      window.dispatchEvent(new Event("npati:auth-changed"));
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (params: {
    email: string;
    password: string;
    username: string;
    displayName?: string;
  }) => {
    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        const message = payload?.error?.message || payload?.message || "Registration failed.";
        setError(message);
        throw new Error(message);
      }

      const data = payload?.data || payload;
      const authedUser = data?.user || payload?.user;
      const tokens = data?.tokens || payload?.tokens;
      if (!tokens?.accessToken) {
        throw new Error("No access token received from registration service.");
      }

      setStoredAuthToken(tokens.accessToken);
      if (tokens.refreshToken) {
        setStoredRefreshToken(tokens.refreshToken);
      }
      setToken(tokens.accessToken);
      setUser(authedUser);
      window.dispatchEvent(new Event("npati:auth-changed"));
    } finally {
      setIsLoading(false);
    }
  };

  const beginInstallationConnection = useCallback(async (): Promise<InstallationPairing> => {
    setError(null);
    await authCheckInFlight.current?.catch(() => undefined);
    sessionStorage.removeItem(SSO_SUPPRESSED_KEY);
    const response = await fetch("/api/auth/installation/start", { method: "POST" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const message = payload?.error?.message || "Could not start NPATI account connection.";
      setError(message);
      throw new Error(message);
    }
    return payload.data;
  }, []);

  const pollInstallationConnection = useCallback(async (deviceCode: string): Promise<boolean> => {
    return completeInstallationConnection(deviceCode);
  }, [completeInstallationConnection]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: Boolean(user && token),
        isLoading,
        error,
        login,
        register,
        beginInstallationConnection,
        pollInstallationConnection,
        logout,
        signOutEverywhere,
        disconnect,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
