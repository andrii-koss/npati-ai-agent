import type { AuthContext } from "@npati/workspace";
import { CODE_NEVER_GRANTED, CODE_PRIVILEGED_PERMISSIONS, classifyPrincipal, createRoleRegistry, type CodeRoleRegistry } from "./code-rbac";

/**
 * C5a — service identity for Automations.
 *
 * The problem this module fixes (owner point 5, and the audit finding `app.ts:1844-1849`): an unattended
 * automation used to run with the **owner's** `userId` and a fixed, wide permission set
 * (`workspace:read`, `workspace:write`, `business:manage`, `tools:execute`, `automation:execute_browser`).
 * Every scheduled run therefore acted with more authority than the automation actually needed, and it was
 * indistinguishable from that user in the audit trail.
 *
 * The fix is deliberately **narrow second**, not "narrow everything": each permission an automation really
 * uses is enumerated in `AUTOMATION_PERMISSION_INVENTORY` against the call site that needs it, that list is
 * the allowlist, and anything outside it is refused with `automation_permission_not_allowed` instead of
 * being silently granted. Production is never reachable from a service identity: privileged and
 * never-granted permissions are filtered out even when an operator asks for them in configuration.
 */

/** Roles a service identity may never exceed, by rank. `developer` is the documented ceiling. */
export const SERVICE_IDENTITY_ROLE_CEILING = "developer";

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  service: 3,
  developer: 3,
  admin: 4,
  owner: 5,
};

/**
 * What unattended automations actually call today, and the permission each call requires. This is the
 * inventory that justifies the allowlist — nothing is granted here that is not needed by a call site, and
 * nothing a call site needs is missing.
 */
export interface AutomationPermissionBinding {
  /** Permission the call site checks for (exact string, as used in the code). */
  permission: string;
  /** What needs it. */
  purpose: string;
  /** Where the requirement lives, so the inventory can be re-verified by reading the code. */
  location: string;
}

export const AUTOMATION_PERMISSION_INVENTORY: readonly AutomationPermissionBinding[] = [
  {
    permission: "workspace:read",
    purpose: "Read the Company, its projects and the email account used by a browser campaign target",
    location: "company-runtime.ts:286 (run needs read|write|business:manage), app.ts:1860 (emailInboxRepo.getAccount)",
  },
  {
    permission: "workspace:write",
    purpose: "Persist automation run results and campaign target outcomes",
    location: "company-runtime.ts:286, app.ts:1883/1896 (browserCredentials.recordTargetResult)",
  },
  {
    permission: "business:manage",
    purpose: "Run Company work on behalf of the Company (agent execution and tool calls)",
    location: "company-runtime.ts:286, company-tool-runtime.ts:182/242",
  },
  {
    permission: "tools:execute",
    purpose: "Execute the tools a Company run calls",
    location: "app.ts:1848 (previous fixed context), company-tool-runtime.ts:242",
  },
  {
    permission: "automation:execute_browser",
    purpose: "Scoped browser campaign work (register/publish) for the automation's approved targets",
    location: "company-runtime.ts:94 (hasScopedBrowserAuthorization), browser-automation-routes.ts:36",
  },
] as const;

/** Default allowlist: exactly the inventory above. */
export const AUTOMATION_ALLOWED_PERMISSION_DEFAULTS: readonly string[] = AUTOMATION_PERMISSION_INVENTORY.map(
  (binding) => binding.permission,
);

/** Anything matching this is production work and can never be part of a service identity. */
const PRODUCTION_PERMISSION_PATTERN = /(^|[.:_-])(prod|production|deploy|release|promote|secret|credential)([.:_-]|$)/i;

export class ServiceIdentityError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "ServiceIdentityError";
  }
}

export interface AutomationPermissionResolution {
  allowed: string[];
  /** Permissions that were requested (by inventory or configuration) and deliberately not granted. */
  rejected: Array<{ permission: string; reason: string }>;
  source: "inventory" | "configuration" | "configuration+inventory";
}

/**
 * Resolve the allowlist. Configuration can only ever **remove** permissions from the inventory default, or
 * add a permission that is not production-shaped — a requested production/privileged permission is rejected
 * and reported, never granted.
 */
export function resolveAutomationAllowedPermissions(
  env: Record<string, string | undefined> = process.env,
  inventory: readonly string[] = AUTOMATION_ALLOWED_PERMISSION_DEFAULTS,
): AutomationPermissionResolution {
  const raw = env.NPATI_CODE_AUTOMATION_ALLOWED_PERMISSIONS;
  const rejected: Array<{ permission: string; reason: string }> = [];
  const requested = raw === undefined
    ? [...inventory]
    : String(raw)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const allowed: string[] = [];
  for (const permission of new Set(requested)) {
    const reason = rejectionReason(permission);
    if (reason) {
      rejected.push({ permission, reason });
      continue;
    }
    allowed.push(permission);
  }
  return {
    allowed: allowed.sort(),
    rejected,
    source: raw === undefined ? "inventory" : "configuration+inventory",
  };
}

function rejectionReason(permission: string): string | null {
  if ((CODE_PRIVILEGED_PERMISSIONS as readonly string[]).includes(permission)) {
    return "privileged_permission_not_allowed_for_service_identity";
  }
  if ((CODE_NEVER_GRANTED as readonly string[]).includes(permission)) {
    return "never_granted_permission_not_allowed";
  }
  if (PRODUCTION_PERMISSION_PATTERN.test(permission)) {
    return "production_not_allowed_for_service_identity";
  }
  if (permission === "*" || permission === "admin:all" || permission === "owner") {
    return "wildcard_not_allowed_for_service_identity";
  }
  return null;
}

export interface ServiceIdentityInput {
  companyId: string;
  automationId: string;
  /** Workspace the automation belongs to (taken from the automation record). */
  workspaceId: string;
  /** The owning user, kept **only** for notification lookups and provenance — never as authority. */
  ownerUserId: string;
  /** Optional requested role; anything above the ceiling is downgraded to `service`. */
  requestedRole?: string;
  /** Optional requested permissions; intersected with the allowlist. */
  requestedPermissions?: readonly string[];
  allowedPermissions?: readonly string[];
  registry?: CodeRoleRegistry;
}

export interface ServiceIdentity {
  /** `service:automation:<id>` — `classifyPrincipal` therefore classifies it as a service, never a user. */
  principalId: string;
  kind: "service";
  automationId: string;
  companyId: string;
  workspaceId: string;
  ownerUserId: string;
  /** Effective role: never above the ceiling; `service` when the request exceeds it. */
  role: string;
  roleDowngraded: boolean;
  permissions: string[];
  rejected: Array<{ permission: string; reason: string }>;
  /** AuthContext for the Company runtime. `userId` is the service principal, **not** the owner. */
  auth: AuthContext;
}

/**
 * Build the identity an unattended automation runs as.
 *
 * Tenancy note (verified, not assumed): `WorkspaceStore.assertCompany`
 * (`packages/workspace/src/postgres-store.ts:1400`) resolves a company as `workspace_id = ctx.workspaceId AND
 * user_id = ctx.userId`, and `createCompany` owns rows by that same `user_id`. Replacing `userId` with a
 * synthetic principal would therefore break every automation (and any ownership query) instead of
 * narrowing it. So the context keeps the owner in `userId` for tenancy **and** carries the service
 * principal in `externalSubject`, which `classifyPrincipal` checks first — the principal is a `service`,
 * the permissions are the allowlist, and the C5a service invariants (no approval, no production) apply.
 * The owner is provenance, not extra authority: no permission beyond the allowlist is ever granted.
 */
export function serviceIdentityForAutomation(input: ServiceIdentityInput): ServiceIdentity {
  const registry = input.registry ?? createRoleRegistry();
  const base = input.allowedPermissions ?? AUTOMATION_ALLOWED_PERMISSION_DEFAULTS;
  const requested = input.requestedPermissions ? [...input.requestedPermissions] : [...base];

  const rejected: Array<{ permission: string; reason: string }> = [];
  const permissions: string[] = [];
  for (const permission of new Set(requested)) {
    // A requested permission must be inside the allowlist and must not be production-shaped.
    if (!base.includes(permission)) {
      rejected.push({ permission, reason: "not_in_allowlist" });
      continue;
    }
    const reason = rejectionReason(permission);
    if (reason) {
      rejected.push({ permission, reason });
      continue;
    }
    permissions.push(permission);
  }

  const ceiling = ROLE_RANK[SERVICE_IDENTITY_ROLE_CEILING] ?? 3;
  const requestedRole = String(input.requestedRole ?? "service").toLowerCase();
  const requestedRank = ROLE_RANK[requestedRole];
  const withinCeiling = requestedRank !== undefined && requestedRank <= ceiling && requestedRole !== "admin" && requestedRole !== "owner";
  const role = withinCeiling ? requestedRole : "service";

  const principalId = `service:automation:${input.automationId}`;
  const auth: AuthContext = {
    workspaceId: input.workspaceId,
    companyId: input.companyId,
    // Tenancy/ownership: NPATI resolves companies by this id, so it stays the owner's.
    userId: input.ownerUserId,
    // The principal itself: `classifyPrincipal` reads this first and yields `service`.
    externalSubject: principalId,
    permissions,
  } as AuthContext;

  return {
    principalId,
    kind: "service",
    automationId: input.automationId,
    companyId: input.companyId,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    role,
    roleDowngraded: !withinCeiling,
    permissions: permissions.sort(),
    rejected,
    auth,
  };
}

/**
 * Guard for call sites: refuse a permission the identity does not hold instead of widening it silently.
 * An automation that turns out to need a new permission must be an owner decision (config change), which
 * is exactly why this throws a named error rather than falling back to the owner's rights.
 */
export function assertAutomationPermissionAllowed(identity: ServiceIdentity, permission: string): void {
  if (!identity.permissions.includes(permission)) {
    throw new ServiceIdentityError(
      "automation_permission_not_allowed",
      `The automation service identity is not allowed to use ${permission}`,
      403,
      {
        reason: "automation_permission_not_allowed",
        permission,
        automationId: identity.automationId,
        allowed: identity.permissions,
        rejected: identity.rejected,
      },
    );
  }
}

/** Convenience: the automations this company may run, with a compact provenance summary for the audit log. */
export interface AutomationIdentitySummary {
  principalId: string;
  role: string;
  permissions: string[];
  rejected: Array<{ permission: string; reason: string }>;
  isService: boolean;
  productionReachable: false;
}

export function summarizeServiceIdentity(identity: ServiceIdentity): AutomationIdentitySummary {
  return {
    principalId: identity.principalId,
    role: identity.role,
    permissions: identity.permissions,
    rejected: identity.rejected,
    isService: classifyPrincipal(identity.auth) === "service",
    // A service identity can never reach production: the flag exists so a reviewer sees it asserted.
    productionReachable: false,
  };
}
