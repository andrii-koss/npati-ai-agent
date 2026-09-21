import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName?: string;
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
  disconnect(): Promise<void>;
}

const STORAGE_TOKEN_KEY = "npati_agent_access_token";
const STORAGE_REFRESH_KEY = "npati_agent_refresh_token";
const STORAGE_USER_KEY = "npati_agent_user";
const PENDING_PAIRING_KEY = "npati_agent_pending_pairing";
const SSO_SUPPRESSED_KEY = "npati_agent_sso_suppressed";
const NPATI_CENTRAL_API_URL = (import.meta.env.VITE_NPATI_BACKEND_URL || "https://api.npati.com").replace(/\/+$/, "");

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
  try {
    if (user) {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_USER_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(getStoredAuthToken());
  const [user, setUser] = useState<AuthUser | null>(getStoredAuthUser());
  const [isLoading, setIsLoading] = useState<boolean>(!getStoredAuthToken());
  const [error, setError] = useState<string | null>(null);

  const logout = useCallback(async () => {
    const refreshToken = getStoredRefreshToken();
    try {
      await fetch("/api/auth/installation/browser-logout", { method: "POST" }).catch(() => null);
      if (refreshToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        }).catch(() => null);
      }
    } finally {
      sessionStorage.setItem(SSO_SUPPRESSED_KEY, "1");
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

  const disconnect = useCallback(async () => {
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
    sessionStorage.setItem(SSO_SUPPRESSED_KEY, "1");
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

  const checkAuth = useCallback(async () => {
    let officialHosted = false;
    try {
      const statusResponse = await fetch("/api/auth/installation/status");
      const statusPayload = await statusResponse.json().catch(() => null);
      officialHosted = statusResponse.ok && statusPayload?.data?.deploymentType === "npati_hosted";
    } catch {
      // Continue with the existing local-session check when status is unavailable.
    }

    if (officialHosted) {
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
          await fetch("/api/auth/installation/browser-logout", { method: "POST" }).catch(() => null);
          sessionStorage.removeItem(PENDING_PAIRING_KEY);
          setStoredAuthToken(null);
          setStoredRefreshToken(null);
          setStoredAuthUser(null);
          setToken(null);
          setUser(null);
          setError(null);
          setIsLoading(false);
          return;
        }
        if (!approveResponse.ok || !approvePayload?.success) {
          throw new Error(approvePayload?.error?.message || "Could not synchronize the current NPATI account.");
        }
        if (!await completeInstallationConnection(pairing.deviceCode)) {
          throw new Error("NPATI account synchronization is still pending.");
        }
        setIsLoading(false);
        return;
      } catch (cause) {
        await fetch("/api/auth/installation/browser-logout", { method: "POST" }).catch(() => null);
        setStoredAuthToken(null);
        setStoredRefreshToken(null);
        setStoredAuthUser(null);
        setToken(null);
        setUser(null);
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
          await logout();
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
        await logout();
      } else {
        // Server response other than 401: preserve session
      }
    } catch {
      // Network failure or temporary glitch: keep persistent session
    } finally {
      setIsLoading(false);
    }
  }, [completeInstallationConnection, logout]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkAuth();
    };
    window.addEventListener("focus", checkAuth);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", checkAuth);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkAuth]);


  useEffect(() => {
    const handleUnauthorized = async () => {
      const refreshToken = getStoredRefreshToken();
      if (refreshToken) {
        try {
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
              return;
            }
          }
        } catch {
          // ignore refresh error
        }
      }
      try {
        const sessionResponse = await fetch("/api/auth/installation/session", { method: "POST" });
        const sessionData = await sessionResponse.json().catch(() => null);
        if (sessionResponse.ok && sessionData?.data?.accessToken && sessionData.data?.user) {
          setStoredAuthToken(sessionData.data.accessToken);
          setStoredAuthUser(sessionData.data.user);
          setToken(sessionData.data.accessToken);
          setUser(sessionData.data.user);
          return;
        }
      } catch {
        // Installation session is not available.
      }
      void logout();
    };
    window.addEventListener("npati:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("npati:unauthorized", handleUnauthorized);
  }, [logout]);

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

  const beginInstallationConnection = async (): Promise<InstallationPairing> => {
    setError(null);
    sessionStorage.removeItem(SSO_SUPPRESSED_KEY);
    const response = await fetch("/api/auth/installation/start", { method: "POST" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const message = payload?.error?.message || "Could not start NPATI account connection.";
      setError(message);
      throw new Error(message);
    }
    return payload.data;
  };

  const pollInstallationConnection = async (deviceCode: string): Promise<boolean> => {
    return completeInstallationConnection(deviceCode);
  };

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
