import type { AuthContext } from "@npati/workspace";
import { DEFAULT_COMPANY_ROLE_MATRIX } from "./code-membership";
import { classifyPrincipal, type CodePrincipalKind } from "./code-principal";

/**
 * C5a (D10): the principal classifier is defined once, in `code-principal.ts`, and re-exported here
 * because this module is where callers look for the authorization vocabulary. `code-membership.ts`
 * imports the same function from the leaf module instead of re-implementing it (the two modules import
 * one another for the role matrix, so a shared definition could not live in either of them).
 */
export { classifyPrincipal };
export type { CodePrincipalKind };

/**
 * C5a — the single server-side authorization point for `code.*` actions.
 *
 * Design constraints from the owner:
 *  - No second permission system: the vocabulary is the one `auth.ts` already issues
 *    (`workspace:read`, `workspace:write`, `business:manage`, `admin:all`, `tools:execute`, ...).
 *  - The role -> permission matrix is an **injected registry**, never hardcoded logic, so the pending
 *    owner decisions (company membership vs single-operator, role names, two-person vs step-up,
 *    service identity for Automations) plug in as configuration instead of a rewrite.
 *  - Deny by default: an empty matrix denies everything, and an unknown role grants nothing.
 *  - Privileged permissions never flow from a wildcard: `*` / `admin:all` grant the ordinary
 *    vocabulary but not `code.prod.operate`, `code.git.protected_write` or `code.policy.manage`.
 */

/** Permissions that exist in the NPATI vocabulary today, plus the `code.` ones this step introduces. */
export const CODE_RBAC_PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "business:manage",
  "tools:read",
  "tools:execute",
  "agent:exec",
  "audit:read",
  "admin:all",
] as const;

/**
 * Privileged permissions: only ever granted by naming them **explicitly** on a role. A wildcard
 * (`*`, `admin:all`, `owner`) deliberately does not imply them — an operator who wants production
 * operations must say so per role.
 */
export const CODE_PRIVILEGED_PERMISSIONS = [
  "code.prod.operate",
  "code.git.protected_write",
  "code.policy.manage",
  "code.trust.manage",
  "code.rbac.manage",
] as const;

/** Actions that can never be authorized at all, whatever the matrix says (hard deny is unreachable). */
export const CODE_NEVER_GRANTED = [
  "code.hard_deny",
  "code.docker.socket",
  "code.production_credentials",
] as const;

/**
 * C5a (D6): the canonical session modes of the owner decision matrix. They are the names the plan and
 * `code-policy-engine.ts` use (`MatrixMode` is this union), and they are what the session-mode surface
 * authorizes: the C1 spellings (`edit`, `auto`, `full_auto`) remain accepted aliases and are normalized
 * onto these.
 */
export const CODE_CANONICAL_SESSION_MODES = ["plan", "ask", "auto_edit", "full_auto_sandbox"] as const;

export type CodeCanonicalSessionMode = (typeof CODE_CANONICAL_SESSION_MODES)[number];

/**
 * C5a (D6): role -> session modes the role may set. Data, exactly like `roles` above: nothing in
 * `createRoleRegistry` knows what "developer" means, and a company-specific matrix can replace this map
 * without a code edit. `plan`/`ask`/`auto_edit` are the working modes the plan grants a developer;
 * `full_auto_sandbox` is the unattended mode and stays with the owner/admin alone (PLAN.md:582).
 */
export const DEFAULT_CODE_SESSION_MODE_MATRIX: Readonly<Record<string, readonly CodeCanonicalSessionMode[]>> =
  Object.freeze({
    owner: ["plan", "ask", "auto_edit", "full_auto_sandbox"],
    admin: ["plan", "ask", "auto_edit", "full_auto_sandbox"],
    developer: ["plan", "ask", "auto_edit"],
    // A reviewer may read and comment but never drive an agent session: no mode at all.
    reviewer: [],
    service: [],
  });

export interface CodeRoleMatrix {
  /** role name -> permissions. Names are data: nothing here knows what "owner" means. */
  roles: Record<string, readonly string[]>;
  /** Permissions a role must name explicitly; wildcards never imply them. */
  privilegedPermissions?: readonly string[];
  /** Actions that are never authorized (hard deny). */
  neverGranted?: readonly string[];
  /** C5a (D6): role name -> session modes the role may set. Also data, also replaceable. */
  sessionModes?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Default matrix — the **owner-confirmed plan role set**: `owner`, `admin`, `developer`, `reviewer`
 * (the four company roles of C5a) plus `service` for unattended runs. The human half is the very same
 * frozen map `code-membership.ts` exports (`DEFAULT_COMPANY_ROLE_MATRIX`), imported instead of copied,
 * so company membership and code authorization cannot drift apart (the earlier `member`/`viewer`
 * spelling was a pre-plan placeholder and is gone).
 *
 * This is **data**, never logic: nothing in `createRoleRegistry` knows what "owner" means, and a
 * company-specific matrix can be injected instead. Changing the map changes authorization with no
 * code edit.
 */
export const DEFAULT_CODE_ROLE_MATRIX: CodeRoleMatrix = {
  roles: {
    ...DEFAULT_COMPANY_ROLE_MATRIX,
    // Service identities (Automations, integrations) get ordinary work permissions only. They are
    // never approvers and never get production operations — see `classifyPrincipal`.
    service: ["workspace:read", "workspace:write", "tools:read", "tools:execute"],
  },
  privilegedPermissions: CODE_PRIVILEGED_PERMISSIONS,
  neverGranted: CODE_NEVER_GRANTED,
  sessionModes: DEFAULT_CODE_SESSION_MODE_MATRIX,
};

export class CodeRbacError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeRbacError";
  }
}

/** Wildcard permissions that widen the ordinary vocabulary. They never imply a privileged one. */
const WILDCARD_PERMISSIONS = new Set(["*", "owner", "admin:all"]);

/**
 * Single definition of "is this an admin principal". Replaces the inline
 * `["*", "owner", "admin:all"]` arrays that were scattered across the code tooling.
 */
export function hasAdminPermission(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).some((permission) => WILDCARD_PERMISSIONS.has(permission));
}

/**
 * Classify the principal. Conservative by construction: any `agent:`/`service:` marker wins, so an
 * agent token cannot present itself as a user.
 *
 * C5a (D10): the implementation lives in `code-principal.ts` (imported and re-exported at the top of
 * this file) so `code-membership.ts` can share it without a circular import.
 */

export interface CodeRoleRegistry {
  readonly matrix: CodeRoleMatrix;
  /** Role of the principal; unknown/absent roles resolve to `null` (deny by default). */
  roleOf(ctx: AuthContext): string | null;
  /** Effective permissions = role permissions ∩ nothing else (intersection with user/agent groups is C5b). */
  permissionsForRole(role: string | null): string[];
  /** C5a (D6): canonical session modes this role may set; an empty list denies every mode change. */
  sessionModesFor(role: string | null): string[];
  isPrivileged(permission: string): boolean;
  isNeverGranted(action: string): boolean;
}

export function createRoleRegistry(matrix: CodeRoleMatrix = DEFAULT_CODE_ROLE_MATRIX): CodeRoleRegistry {
  const privileged = new Set(matrix.privilegedPermissions ?? CODE_PRIVILEGED_PERMISSIONS);
  const neverGranted = new Set(matrix.neverGranted ?? CODE_NEVER_GRANTED);
  const roles = new Map<string, string[]>();
  for (const [role, permissions] of Object.entries(matrix.roles ?? {})) {
    roles.set(role.toLowerCase(), [...permissions]);
  }
  const sessionModes = new Map<string, string[]>();
  for (const [role, modes] of Object.entries(matrix.sessionModes ?? DEFAULT_CODE_SESSION_MODE_MATRIX)) {
    sessionModes.set(role.toLowerCase(), modes.map((mode) => String(mode)));
  }

  const roleOf = (ctx: AuthContext): string | null => {
    const raw = (ctx as unknown as { role?: unknown }).role;
    const role = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
    return role && roles.has(role) ? role : null;
  };

  /**
   * C5a (D3): the effective permissions of a role.
   *
   * A privileged permission is part of the result only when **this role names it explicitly**. The
   * wildcard token `*` is expanded here (that is what a wildcard means: the ordinary vocabulary of
   * `CODE_RBAC_PERMISSIONS`), and the naive expansion — "everything this registry knows", including the
   * privileged vocabulary — is exactly what the filter at the end removes. Without that filter, `*`
   * would hand out `code.prod.operate`, and `code-step-up.ts` (which consumes this output to decide who
   * holds production permission) would accept a wildcard as a production grant.
   *
   * The admin markers `owner` / `admin:all` are deliberately *not* expanded: `hasAdminPermission()`
   * interprets them where a wildcard is meant (a route guard or a non-privileged permission check), and
   * expanding them would change the declared permission set of the shipped company roles.
   */
  const permissionsForRole = (role: string | null): string[] => {
    if (!role) return [];
    const named = roles.get(role) ?? [];
    const namedExplicitly = new Set(named.filter((permission) => privileged.has(permission)));
    const effective = new Set<string>(named);
    if (named.includes("*")) {
      for (const permission of [...CODE_RBAC_PERMISSIONS, ...privileged]) effective.add(permission);
    }
    return [...effective].filter((permission) => !privileged.has(permission) || namedExplicitly.has(permission));
  };

  const sessionModesFor = (role: string | null): string[] => {
    if (!role) return [];
    return [...(sessionModes.get(role.toLowerCase()) ?? [])];
  };

  return {
    matrix,
    roleOf,
    permissionsForRole,
    sessionModesFor,
    isPrivileged: (permission: string) => privileged.has(permission),
    isNeverGranted: (action: string) => neverGranted.has(action),
  };
}

export interface CodeAuthorizationAuditPort {
  record(input: {
    action: string;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface AuthorizeCodeActionInput {
  permission: string;
  action: string;
  projectId?: string;
  sessionId?: string;
  mode?: string;
  /** True when the action changes policy, trust, roles, flags or the allowlist. */
  policyChange?: boolean;
  /** True when the action touches production credentials or deploys. */
  production?: boolean;
  /** True when the caller claims to approve. */
  approvalClaim?: boolean;
}

export interface CodeAuthorizationResult {
  allowed: true;
  permission: string;
  action: string;
  principal: CodePrincipalKind;
  role: string | null;
  privileged: boolean;
}

export interface CodeRbacDeps {
  registry?: CodeRoleRegistry;
  audit?: CodeAuthorizationAuditPort;
  logger?: { warn(payload: unknown, message?: string): void };
}

/**
 * C5a (D11) — the permission each action requires, derived from the action itself.
 *
 * The gate used to authorize `input.permission`: a label the *caller* supplies. A mismatched pair
 * (`permission: "workspace:read"`, `action: "code.flags.change"`) was therefore allowed, and only the
 * separate `isAdminPrincipal` guard the routes call next kept that from mattering — protection by
 * convention, not by construction. The required permission is now derived here, a caller-supplied label
 * may only **confirm** it, and an action that is not in this map is refused (`action_not_mapped`): deny
 * by default, so a new route with a copy-pasted label cannot silently pass.
 *
 * The map is the vocabulary of `code-*` surfaces plus the two non-`code.` actions the shared gate
 * already authorizes for service identities (`company.run`, `browser.campaign`). An action name that is
 * itself a privileged permission (for example `code.prod.operate`, used as the production operation)
 * resolves to itself — see `requiredPermissionForAction`.
 */
export const CODE_ACTION_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  // Read-only surfaces.
  "code.fs.read": "workspace:read",
  "code.fs.list": "workspace:read",
  "code.fs.grep": "workspace:read",
  "code.fs.tree": "workspace:read",
  "code.fs.diff": "workspace:read",
  "code.symbols.outline": "workspace:read",
  "code.project.info": "workspace:read",
  "code.shell.process.list": "workspace:read",
  "code.shell.process.logs": "workspace:read",
  "code.audit.read": "audit:read",
  "code.membership.accept": "workspace:read",
  "code.protected_branches.read": "workspace:read",
  "company.run": "workspace:read",
  // Mutating workspace surfaces.
  "code.fs.edit": "workspace:write",
  "code.fs.write": "workspace:write",
  "code.fs.move": "workspace:write",
  "code.fs.apply_patch": "workspace:write",
  "code.fs.undo_last_turn": "workspace:write",
  "code.fs.delete": "workspace:write",
  "code.shell.exec": "workspace:write",
  "code.shell.process.start": "workspace:write",
  "code.shell.process.stop": "workspace:write",
  "code.deps.add": "workspace:write",
  "code.deps.install": "workspace:write",
  "code.deps.update": "workspace:write",
  "code.deps.remove": "workspace:write",
  // Executing a verification command is a tool execution, not an edit (the permission the route guard
  // and the security-gate suite use for `code.verify.run`).
  "code.verify.run": "tools:execute",
  "browser.campaign": "automation:execute_browser",
  // Administrative surfaces (the company role check is a second, separate gate).
  "code.membership.list": "business:manage",
  "code.membership.invite": "business:manage",
  "code.membership.role_change": "business:manage",
  "code.membership.remove": "business:manage",
  "code.protected_branches.update": "business:manage",
  "code.flags.change": "business:manage",
  "code.project.trust": "business:manage",
  "code.project.untrust": "business:manage",
  "code.approval_rule.create": "business:manage",
  "code.approval_rule.delete": "business:manage",
  // Production: the privileged permission and the operation name are one and the same surface.
  "code.prod.operate": "code.prod.operate",
  "code.deploy.production": "code.prod.operate",
  // C5b: provider data policy. Reading the policy is ordinary read access; **changing** it decides what
  // may leave NPATI, so the write surfaces are mapped to the privileged `code.policy.manage` — the plan
  // puts ProviderDataPolicy changes at owner level — and the inherited wildcard (`*`, `admin:all`,
  // `owner`) deliberately does not grant it (see `permissionsForRole`). Raising a project's data
  // classification narrows what may be sent and is an ordinary workspace write; **lowering** it widens
  // the surface, so it is the owner-level action and has its own name.
  "provider.data_policy.read": "workspace:read",
  "provider.data_policy.versions": "workspace:read",
  "provider.data_policy.eligibility": "workspace:read",
  "project.data_policy.read": "workspace:read",
  "provider.data_policy.upsert": "code.policy.manage",
  "project.data_policy.upsert": "workspace:write",
  "project.data_policy.lower_classification": "code.policy.manage",
  "provider.hosted_consent.grant": "code.policy.manage",
  "provider.hosted_consent.revoke": "code.policy.manage",
});

/**
 * The permission an action requires, or `null` when the action is not part of the known vocabulary.
 * A `null` result is a refusal (`action_not_mapped`), never a fallback to the caller's label.
 */
export function requiredPermissionForAction(action: unknown): string | null {
  const value = String(action ?? "").trim();
  if (!value) return null;
  if (Object.prototype.hasOwnProperty.call(CODE_ACTION_PERMISSIONS, value)) {
    return CODE_ACTION_PERMISSIONS[value] ?? null;
  }
  // A privileged permission may also be the name of the action it authorizes (`code.prod.operate`,
  // `code.policy.manage`, ...): resolving it to itself keeps that identity explicit instead of implicit.
  if ((CODE_PRIVILEGED_PERMISSIONS as readonly string[]).includes(value)) return value;
  return null;
}

/** Stable hash of the authorization subject, used as `payload_hash` in the audit journal. */
export function authorizationPayloadHash(input: { permission: string; action: string; resource: string }): string {
  const text = `${input.permission}\u0000${input.action}\u0000${input.resource}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Authorize one `code.*` action. Deny by default; privileged permissions require an explicit grant;
 * agents and service identities have hard invariants that no matrix can lift.
 */
export class CodeRbac {
  private readonly registry: CodeRoleRegistry;

  constructor(private readonly deps: CodeRbacDeps = {}) {
    this.registry = deps.registry ?? createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX);
  }

  get roleRegistry(): CodeRoleRegistry {
    return this.registry;
  }

  async authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<CodeAuthorizationResult> {
    const principal = classifyPrincipal(ctx);
    const role = this.registry.roleOf(ctx);
    const granted = new Set([...(ctx.permissions ?? []), ...this.registry.permissionsForRole(role)]);
    const privileged = this.registry.isPrivileged(input.permission);
    const resource = input.sessionId ?? input.projectId ?? ctx.companyId ?? companyId;

    const deny = async (code: string, message: string, details: Record<string, unknown> = {}): Promise<never> => {
      await this.record("code.rbac.deny", ctx, companyId, { ...input, resource, principal, role, code });
      throw new CodeRbacError(code, message, 403, { reason: code, permission: input.permission, action: input.action, principal, ...details });
    };

    // Hard deny: never authorizable, whatever the matrix or the caller claims.
    if (this.registry.isNeverGranted(input.action)) {
      return deny("action_never_authorizable", `Action ${input.action} can never be authorized`, { neverGranted: true });
    }
    // Agent invariants.
    if (principal === "agent") {
      if (input.approvalClaim) return deny("agent_cannot_approve", "An agent cannot approve its own action");
      if (input.policyChange) return deny("agent_cannot_change_policy", "An agent cannot change mode, roles, flags or policy");
    }
    // Service identities: never production, never above their granted role.
    if (principal === "service") {
      if (input.approvalClaim) return deny("service_cannot_approve", "A service identity cannot approve an action");
      if (input.production || this.registry.isPrivileged(input.permission)) {
        return deny("service_identity_cannot_operate_production", "A service identity cannot perform production operations");
      }
    }
    // C5a (D11): the permission the action requires is derived from the action, never taken from the
    // caller's label. This runs before the production gate and the permission check, so a mismatched pair
    // is always reported as the caller error it is (`permission_action_mismatch`) or, for an action the
    // gate does not know, as `action_not_mapped` — deny by default.
    const expectedPermission = requiredPermissionForAction(input.action);
    if (!expectedPermission) {
      return deny("action_not_mapped", `No permission is mapped to action ${input.action}; refusing by default`, {
        actionMapped: false,
        knownActions: Object.keys(CODE_ACTION_PERMISSIONS).length,
      });
    }
    if (input.permission !== expectedPermission) {
      return deny(
        "permission_action_mismatch",
        `Permission ${input.permission} does not authorise action ${input.action}; it requires ${expectedPermission}`,
        { expected: expectedPermission, provided: input.permission },
      );
    }
    if (input.production && !granted.has(input.permission)) {
      return deny("production_permission_required", "Production operations require an explicitly granted privileged permission");
    }
    // Deny by default: the permission must be present, and privileged permissions must be named.
    const hasPermission = granted.has(input.permission) || (!privileged && hasAdminPermission([...granted]));
    if (!hasPermission) {
      return deny("permission_denied", `Missing permission: ${input.permission}`, { privileged });
    }
    await this.record("code.rbac.allow", ctx, companyId, { ...input, resource, principal, role, privileged });
    return { allowed: true, permission: input.permission, action: input.action, principal, role, privileged };
  }

  /**
   * Audit before the action runs. Authorization is fail closed in every case: this module is the
   * server-side gate for coded actions, so a missing or failing journal refuses the decision rather
   * than allowing it silently (rules 23 and 17).
   */
  private async record(
    action: "code.rbac.allow" | "code.rbac.deny",
    ctx: AuthContext,
    companyId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) {
      throw new CodeRbacError("audit_unavailable", "Authorization decisions require the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
    try {
      await this.deps.audit.record({
        action,
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "code_authorization",
        resourceId: String(metadata.resource ?? companyId),
        metadata: {
          permission: metadata.permission ?? null,
          action: metadata.action ?? null,
          principal: metadata.principal ?? null,
          role: metadata.role ?? null,
          code: metadata.code ?? null,
          payload_hash: authorizationPayloadHash({
            permission: String(metadata.permission ?? ""),
            action: String(metadata.action ?? ""),
            resource: String(metadata.resource ?? ""),
          }),
        },
      });
    } catch (error) {
      if (error instanceof CodeRbacError) throw error;
      this.deps.logger?.warn({ err: error }, "code_rbac_audit_failed");
      throw new CodeRbacError("audit_unavailable", "This authorization decision requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
  }
}

/** Convenience helper for route guards: authorize or throw `CodeRbacError`. */
export async function authorizeCodeAction(
  ctx: AuthContext,
  companyId: string,
  input: AuthorizeCodeActionInput,
  deps: CodeRbacDeps = {},
): Promise<CodeAuthorizationResult> {
  return new CodeRbac(deps).authorize(ctx, companyId, input);
}

/** Admin check that also refuses agent/service principals for privileged route guards. */
export function isAdminPrincipal(ctx: AuthContext): boolean {
  return classifyPrincipal(ctx) === "user" && hasAdminPermission(ctx.permissions);
}
