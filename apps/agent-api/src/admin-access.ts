import type { AuthContext } from "@npati/workspace";

/**
 * Administrators of an installation: the self-hosted owner ("owner"), NPATI accounts whose central role is admin or
 * moderator ("admin:all"), and internal service identities ("*"). On a hosted (SaaS) installation ordinary accounts are
 * none of these, so routes over shared server state or infrastructure use this check.
 */
export const ADMIN_PERMISSIONS = ["*", "owner", "admin:all"] as const;

export function isAdministrator(scope: Pick<AuthContext, "permissions"> | null | undefined): boolean {
  return Boolean(scope?.permissions?.some((permission) => (ADMIN_PERMISSIONS as readonly string[]).includes(permission)));
}
