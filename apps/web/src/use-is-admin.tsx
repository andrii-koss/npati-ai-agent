import { type ReactNode, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";

// The same set the server checks (apps/agent-api/src/admin-access.ts): the self-hosted owner, NPATI administrators
// and internal service identities. The server enforces it; the app only hides what an account cannot open.
const ADMIN_PERMISSIONS = ["*", "owner", "admin:all"];

export function hasAdminPermission(permissions: unknown): boolean {
  return Array.isArray(permissions) && permissions.some((permission) => ADMIN_PERMISSIONS.includes(permission));
}

let cached: { token: string | null; value: boolean } | null = null;
let pending: Promise<boolean> | null = null;

function loadIsAdmin(): Promise<boolean> {
  const token = getStoredAuthToken();
  if (cached && cached.token === token) return Promise.resolve(cached.value);
  if (!pending) {
    pending = fetch("/api/auth/me", { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const value = hasAdminPermission(body?.data?.permissions);
        cached = { token, value };
        return value;
      })
      .catch(() => false)
      .finally(() => { pending = null; });
  }
  return pending;
}

/** true or false once known; null while the first check is in flight. */
export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(() => (cached && cached.token === getStoredAuthToken() ? cached.value : null));
  useEffect(() => {
    let alive = true;
    const refresh = () => { void loadIsAdmin().then((value) => { if (alive) setIsAdmin(value); }); };
    const onAuthChanged = () => { cached = null; refresh(); };
    refresh();
    window.addEventListener("npati:auth-changed", onAuthChanged);
    return () => { alive = false; window.removeEventListener("npati:auth-changed", onAuthChanged); };
  }, []);
  return isAdmin;
}

/** Renders its page for administrators; anyone else is sent back to Settings. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  if (isAdmin === null) return null;
  if (!isAdmin) return <Navigate to="/settings" replace />;
  return <>{children}</>;
}
