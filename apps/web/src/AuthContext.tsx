import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  role?: string;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  register(params: { email: string; password: string; username: string; displayName?: string }): Promise<void>;
  logout(): Promise<void>;
}

const STORAGE_TOKEN_KEY = "npati_agent_access_token";
const STORAGE_REFRESH_KEY = "npati_agent_refresh_token";

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

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(getStoredAuthToken());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const logout = useCallback(async () => {
    const refreshToken = getStoredRefreshToken();
    try {
      if (refreshToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        }).catch(() => null);
      }
    } finally {
      setStoredAuthToken(null);
      setStoredRefreshToken(null);
      setToken(null);
      setUser(null);
      setError(null);
      window.dispatchEvent(new Event("npati:auth-changed"));
    }
  }, []);

  const checkAuth = useCallback(async () => {
    const currentToken = getStoredAuthToken();
    if (!currentToken) {
      setUser(null);
      setToken(null);
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
          setUser(payload.data.user);
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
            const newAccess = refreshData.data?.tokens?.accessToken;
            if (newAccess) {
              setStoredAuthToken(newAccess);
              setToken(newAccess);
              if (refreshData.data?.tokens?.refreshToken) {
                setStoredRefreshToken(refreshData.data.tokens.refreshToken);
              }
              const meRes = await fetch("/api/auth/me", {
                headers: { authorization: `Bearer ${newAccess}` },
              });
              if (meRes.ok) {
                const meData = await meRes.json();
                setUser(meData.data?.user || null);
                setIsLoading(false);
                return;
              }
            }
          }
        }
        await logout();
      } else {
        await logout();
      }
    } catch {
      await logout();
    } finally {
      setIsLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const handleUnauthorized = () => {
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
        logout,
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
