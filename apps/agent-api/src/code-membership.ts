import { createHash, randomUUID } from "node:crypto";
import { classifyPrincipal } from "./code-principal";

/**
 * Company membership as authorisation (C5a).
 *
 * Roles are a **map onto the permission vocabulary that already exists** in
 * `apps/agent-api/src/code-rbac.ts` (`workspace:read`, `workspace:write`, `business:manage`,
 * `tools:read`, `tools:execute`, `audit:read`, `admin:all`). Only permissions the existing vocabulary
 * cannot express are introduced, and `code.prod.operate` is deliberately granted to **no** role by default:
 * it is a privileged permission that an operator must name explicitly per role.
 *
 * There is no new permission system here: this module decides *which role a user has in a company*, and the
 * role-to-permission map is exported as data so `createRoleRegistry()` in `code-rbac.ts` consumes it
 * unchanged (`createCompanyRoleRegistry()` below is that one call).
 */

export type CompanyRole = "owner" | "admin" | "developer" | "reviewer";
export type CompanyMemberStatus = "active" | "invited" | "suspended";

export const COMPANY_ROLES: readonly CompanyRole[] = ["owner", "admin", "developer", "reviewer"];

/** Structural view of the request principal; avoids importing a concrete AuthContext type here. */
export interface MembershipActor {
  userId?: string | null;
  externalSubject?: string | null;
  companyId?: string | null;
}

export interface CompanyMember {
  id: string;
  companyId: string;
  userId: string;
  role: CompanyRole;
  status: CompanyMemberStatus;
  invitedBy?: string | null;
  invitedAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
}

export interface CompanyInvite {
  id: string;
  companyId: string;
  email: string;
  role: CompanyRole;
  tokenHash: string;
  expiresAt: Date;
  createdBy: string;
  acceptedAt?: Date | null;
  createdAt: Date;
}

/** Store port. Implemented by the postgres and in-memory stores; injected so this module stays testable. */
export interface CodeMembershipStore {
  getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null>;
  listCompanyMembers(companyId: string): Promise<CompanyMember[]>;
  countCompanyOwners(companyId: string): Promise<number>;
  createCompanyInvite(input: Omit<CompanyInvite, "createdAt"> & { createdAt?: Date }): Promise<CompanyInvite>;
  findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null>;
  acceptCompanyInvite(input: {
    invite: CompanyInvite;
    userId: string;
    acceptedAt: Date;
  }): Promise<CompanyMember>;
  updateCompanyMemberRole(input: {
    companyId: string;
    userId: string;
    role: CompanyRole;
    expectedRevision: number;
    updatedAt: Date;
  }): Promise<CompanyMember>;
  removeCompanyMember(input: { companyId: string; userId: string }): Promise<void>;
}

/**
 * Audit port (C1c AuditLog). Written **before** the change is applied; without it nothing changes.
 *
 * C5a (D7): a **refusal** is journalled too, with the `<action>.denied` spelling, so an escalation
 * attempt (an admin trying to mint an owner, a non-member trying to manage the company) leaves a trace.
 */
export type CodeMembershipAuditAction =
  | "code.membership.invite"
  | "code.membership.accept"
  | "code.membership.role_change"
  | "code.membership.remove"
  | "code.membership.invite.denied"
  | "code.membership.accept.denied"
  | "code.membership.role_change.denied"
  | "code.membership.remove.denied"
  | "code.membership.list.denied";

export interface CodeMembershipAuditPort {
  record(entry: {
    action: CodeMembershipAuditAction;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    /** Present on a refusal; the journal adapter records `deny` as a denied decision. */
    decision?: "allow" | "deny";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface CodeMembershipDeps {
  store: CodeMembershipStore;
  audit?: CodeMembershipAuditPort;
  now?: () => Date;
  logger?: { warn(payload: unknown, message?: string): void };
  /** Default invite lifetime. */
  inviteTtlMs?: number;
}

export class CodeMembershipError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CodeMembershipError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Owner-confirmed defaults. `owner`/`admin` mirror the existing workspace vocabulary; `developer` is the
 * coding role (write + tools, no administration) and `reviewer` may read and comment but never execute.
 * `code.prod.operate` and the other privileged permissions are intentionally absent everywhere.
 */
export const DEFAULT_COMPANY_ROLE_MATRIX: Readonly<Record<CompanyRole, readonly string[]>> = Object.freeze({
  owner: [
    "workspace:read",
    "workspace:write",
    "business:manage",
    "tools:read",
    "tools:execute",
    "audit:read",
    "admin:all",
  ],
  admin: ["workspace:read", "workspace:write", "business:manage", "tools:read", "tools:execute", "audit:read"],
  developer: ["workspace:read", "workspace:write", "tools:read", "tools:execute"],
  reviewer: ["workspace:read", "tools:read"],
});

/** Permissions actually granted by a role. Unknown roles grant nothing (deny by default). */
export function permissionsForCompanyRole(
  role: CompanyRole | string | null | undefined,
  matrix: Readonly<Record<string, readonly string[]>> = DEFAULT_COMPANY_ROLE_MATRIX,
): readonly string[] {
  if (!role) return [];
  return matrix[role] ?? [];
}

/** `code-rbac.ts` consumes this: one call, no second permission system. */
export function createCompanyRoleRegistry(
  createRoleRegistry: (matrix: { roles: Record<string, readonly string[]> }) => unknown,
  matrix: Readonly<Record<string, readonly string[]>> = DEFAULT_COMPANY_ROLE_MATRIX,
): unknown {
  return createRoleRegistry({ roles: { ...matrix } });
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * C5a (D4): who may hand out which company role.
 *  - `owner` is owner-only. An admin promoting itself or anybody else to `owner` is exactly the
 *    admin -> owner escalation the plan forbids, and demoting/removing an owner is the same authority.
 *  - An admin may manage only the working roles `developer` / `reviewer`; `admin` itself stays with the
 *    owner, so an admin can never mint a peer (or a superior) with wider rights than its own.
 * Nothing here is a second role system: the caller's role comes from `resolveRoleForUser` and the
 * assignable set is derived from it, not from the request.
 */
export const OWNER_ONLY_ASSIGNABLE_ROLES: readonly CompanyRole[] = ["owner", "admin"];
export const ADMIN_ASSIGNABLE_ROLES: readonly CompanyRole[] = ["developer", "reviewer"];

/**
 * A principal is an agent (or a service identity) when it is not a user session.
 *
 * C5a (D10): the rule is the shared `classifyPrincipal` — the exact `agent:` / `service:` prefixes. The
 * previous substring test (`subject.includes("agent-")`) classified a human such as `u-agent-manager`
 * as an agent and refused a legitimate manager, and it never matched a `service:` user id at all.
 */
function isAgentActor(actor: MembershipActor): boolean {
  return classifyPrincipal(actor) !== "user";
}

export class CodeMembershipService {
  private readonly store: CodeMembershipStore;
  private readonly audit?: CodeMembershipAuditPort;
  private readonly now: () => Date;
  private readonly logger?: { warn(payload: unknown, message?: string): void };
  private readonly inviteTtlMs: number;

  constructor(deps: CodeMembershipDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
    this.inviteTtlMs = deps.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
  }

  /**
   * Membership is the authorisation anchor: no row means **no role**, which means denied. There is no
   * "owner by default" fallback anywhere in this method.
   */
  async resolveRoleForUser(ctx: MembershipActor, companyId: string): Promise<CompanyRole | null> {
    const userId = ctx.userId ?? null;
    if (!userId) return null;
    const member = await this.store.getCompanyMembership(companyId, userId);
    if (!member) return null;
    if (member.status !== "active") return null;
    return member.role;
  }

  async listMembers(ctx: MembershipActor, companyId: string): Promise<CompanyMember[]> {
    await this.assertManager(ctx, companyId, "code.membership.list");
    return this.store.listCompanyMembers(companyId);
  }

  async invite(
    ctx: MembershipActor,
    companyId: string,
    input: { email: string; role: CompanyRole; token: string },
  ): Promise<CompanyInvite> {
    const manager = await this.assertManager(ctx, companyId, "code.membership.invite");
    if (!COMPANY_ROLES.includes(input.role)) {
      throw new CodeMembershipError("invalid_company_role", `Unknown company role: ${input.role}`, {
        httpStatus: 400,
      });
    }
    await this.assertRoleAssignmentAllowed(ctx, companyId, "code.membership.invite.denied", manager.role, input.role, "invite");
    if (!input.token || input.token.length < 16) {
      throw new CodeMembershipError("invite_token_too_weak", "Invite tokens must be at least 16 characters", {
        httpStatus: 400,
      });
    }

    const now = this.now();
    const invite: CompanyInvite = {
      id: `cinv_${randomUUID()}`,
      companyId,
      email: input.email,
      role: input.role,
      tokenHash: hashInviteToken(input.token),
      expiresAt: new Date(now.getTime() + this.inviteTtlMs),
      createdBy: manager.actor,
      acceptedAt: null,
      createdAt: now,
    };

    // Audit first, fail closed: without the journal entry the invite is not created.
    await this.auditOrFail({
      action: "code.membership.invite",
      actor: manager.actor,
      companyId,
      resourceType: "company_invite",
      resourceId: invite.id,
      metadata: { role: invite.role, email: invite.email, expiresAt: invite.expiresAt.toISOString() },
    });

    return this.store.createCompanyInvite(invite);
  }

  async acceptInvite(
    ctx: MembershipActor & { email?: string | null },
    input: { token: string },
  ): Promise<CompanyMember> {
    const userId = ctx.userId ?? null;
    if (!userId) {
      await this.recordDenial(ctx, String(ctx.companyId ?? ""), "code.membership.accept.denied", "membership_user_required");
      throw new CodeMembershipError("membership_user_required", "A user session is required to accept an invite");
    }
    const tokenHash = hashInviteToken(input.token ?? "");
    const invite = await this.store.findCompanyInviteByTokenHash(tokenHash);
    if (!invite) {
      await this.recordDenial(ctx, String(ctx.companyId ?? ""), "code.membership.accept.denied", "invite_invalid");
      throw new CodeMembershipError("invite_invalid", "Invite token is not valid");
    }
    if (invite.acceptedAt) {
      await this.recordDenial(ctx, invite.companyId, "code.membership.accept.denied", "invite_already_accepted", {
        inviteId: invite.id,
      });
      throw new CodeMembershipError("invite_already_accepted", "Invite token was already used", { httpStatus: 409 });
    }
    const now = this.now();
    if (invite.expiresAt.getTime() <= now.getTime()) {
      await this.recordDenial(ctx, invite.companyId, "code.membership.accept.denied", "invite_expired", {
        inviteId: invite.id,
      });
      throw new CodeMembershipError("invite_expired", "Invite token has expired", { httpStatus: 410 });
    }
    // The invite names an email; when the principal carries one it must match, otherwise a leaked token
    // would be usable from any account.
    if (ctx.email && invite.email && ctx.email.toLowerCase() !== invite.email.toLowerCase()) {
      await this.recordDenial(ctx, invite.companyId, "code.membership.accept.denied", "invite_email_mismatch", {
        inviteId: invite.id,
      });
      throw new CodeMembershipError("invite_email_mismatch", "Invite was issued for a different email address");
    }

    await this.auditOrFail({
      action: "code.membership.accept",
      actor: userId,
      companyId: invite.companyId,
      resourceType: "company_invite",
      resourceId: invite.id,
      metadata: { role: invite.role },
    });

    return this.store.acceptCompanyInvite({ invite, userId, acceptedAt: now });
  }

  async updateRole(
    ctx: MembershipActor,
    companyId: string,
    input: { userId: string; role: CompanyRole; expectedRevision: number },
  ): Promise<CompanyMember> {
    const manager = await this.assertManager(ctx, companyId, "code.membership.role_change");
    if (!COMPANY_ROLES.includes(input.role)) {
      throw new CodeMembershipError("invalid_company_role", `Unknown company role: ${input.role}`, {
        httpStatus: 400,
      });
    }
    const target = await this.store.getCompanyMembership(companyId, input.userId);
    if (!target) {
      throw new CodeMembershipError("membership_not_found", "User is not a member of this company", {
        httpStatus: 404,
      });
    }
    // C5a (D4): the acting role decides which roles may be handed out, and an owner is out of an
    // admin's reach even when the change would lower it.
    await this.assertRoleAssignmentAllowed(ctx, companyId, "code.membership.role_change.denied", manager.role, input.role, "role_change", {
      targetUserId: input.userId,
      currentRole: target.role,
    });
    if (target.role === "owner" && input.role !== "owner") {
      await this.assertNotLastOwner(ctx, companyId, "code.membership.role_change.denied", "demote");
    }

    await this.auditOrFail({
      action: "code.membership.role_change",
      actor: manager.actor,
      companyId,
      resourceType: "company_member",
      resourceId: input.userId,
      metadata: { from: target.role, to: input.role, expectedRevision: input.expectedRevision },
    });

    return this.store.updateCompanyMemberRole({
      companyId,
      userId: input.userId,
      role: input.role,
      expectedRevision: input.expectedRevision,
      updatedAt: this.now(),
    });
  }

  async removeMember(ctx: MembershipActor, companyId: string, targetUserId: string): Promise<void> {
    const manager = await this.assertManager(ctx, companyId, "code.membership.remove");
    const target = await this.store.getCompanyMembership(companyId, targetUserId);
    if (!target) {
      throw new CodeMembershipError("membership_not_found", "User is not a member of this company", {
        httpStatus: 404,
      });
    }
    if (target.role === "owner" && manager.role !== "owner") {
      // C5a (D4): removing an owner is owner-only, exactly like demoting one.
      await this.recordDenial(ctx, companyId, "code.membership.remove.denied", "owner_role_requires_owner", {
        targetUserId,
        currentRole: target.role,
        actorRole: manager.role,
      });
      throw new CodeMembershipError("owner_role_requires_owner", "Only the company owner can remove an owner", {
        httpStatus: 403,
        details: { actorRole: manager.role, targetRole: target.role },
      });
    }
    if (target.role === "owner") {
      await this.assertNotLastOwner(ctx, companyId, "code.membership.remove.denied", "remove");
    }

    await this.auditOrFail({
      action: "code.membership.remove",
      actor: manager.actor,
      companyId,
      resourceType: "company_member",
      resourceId: targetUserId,
      metadata: { role: target.role },
    });

    await this.store.removeCompanyMember({ companyId, userId: targetUserId });
  }

  /** A single owner can never be demoted or removed; the company would lose its administrator. */
  private async assertNotLastOwner(
    ctx: MembershipActor,
    companyId: string,
    deniedAction: CodeMembershipAuditAction,
    operation: "demote" | "remove",
  ): Promise<void> {
    const owners = await this.store.countCompanyOwners(companyId);
    if (owners <= 1) {
      await this.recordDenial(ctx, companyId, deniedAction, "last_owner_protected", { operation, owners });
      throw new CodeMembershipError(
        "last_owner_protected",
        `Cannot ${operation} the only owner of the company`,
        { httpStatus: 409, details: { operation, owners } },
      );
    }
  }

  /**
   * C5a (D4): refuses a role assignment the acting role may not make. See
   * `OWNER_ONLY_ASSIGNABLE_ROLES` / `ADMIN_ASSIGNABLE_ROLES` for the rule itself; this method is the
   * single place that applies it to `invite` and `updateRole`, so both surfaces cannot drift apart.
   */
  private async assertRoleAssignmentAllowed(
    ctx: MembershipActor,
    companyId: string,
    deniedAction: CodeMembershipAuditAction,
    actorRole: CompanyRole,
    assignedRole: CompanyRole,
    operation: "invite" | "role_change",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const assignable = actorRole === "owner" ? [...OWNER_ONLY_ASSIGNABLE_ROLES, ...ADMIN_ASSIGNABLE_ROLES] : ADMIN_ASSIGNABLE_ROLES;
    if (assignable.includes(assignedRole)) return;
    const code = assignedRole === "owner" ? "owner_role_requires_owner" : "admin_role_requires_owner";
    await this.recordDenial(ctx, companyId, deniedAction, code, { actorRole, assignedRole, operation, ...metadata });
    throw new CodeMembershipError(
      code,
      assignedRole === "owner"
        ? "Only the company owner can grant or change the owner role"
        : "Only the company owner can grant or change the admin role",
      { httpStatus: 403, details: { actorRole, assignedRole, operation, ...metadata } },
    );
  }

  /** Only owner/admin manage membership, and an agent principal may never do it at all. */
  private async assertManager(
    ctx: MembershipActor,
    companyId: string,
    action: "code.membership.list" | "code.membership.invite" | "code.membership.role_change" | "code.membership.remove",
  ): Promise<{ actor: string; role: CompanyRole }> {
    const deniedAction = `${action}.denied` as CodeMembershipAuditAction;
    const actor = ctx.userId ?? null;
    if (!actor) {
      await this.recordDenial(ctx, companyId, deniedAction, "membership_user_required", { action });
      throw new CodeMembershipError("membership_user_required", "A user session is required");
    }
    if (isAgentActor(ctx)) {
      await this.recordDenial(ctx, companyId, deniedAction, "agent_cannot_change_policy", { action });
      throw new CodeMembershipError(
        "agent_cannot_change_policy",
        "Agent principals cannot change company membership",
        { details: { action } },
      );
    }
    const role = await this.resolveRoleForUser(ctx, companyId);
    if (role !== "owner" && role !== "admin") {
      await this.recordDenial(ctx, companyId, deniedAction, "membership_manage_forbidden", { action, role });
      throw new CodeMembershipError("membership_manage_forbidden", "Owner or admin role required", {
        details: { action, role },
      });
    }
    return { actor, role };
  }

  /**
   * C5a (D7): a refusal is written to the journal too. Best effort by construction — a refusal is
   * already fail-closed, so an unavailable or failing journal must not change it; the failure is
   * logged separately instead (`code_membership_denial_audit_*`).
   */
  private async recordDenial(
    ctx: MembershipActor,
    companyId: string,
    action: CodeMembershipAuditAction,
    code: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const audit = this.audit;
    if (!audit) {
      this.logger?.warn({ action, code, companyId }, "code_membership_denial_audit_unavailable");
      return;
    }
    try {
      await audit.record({
        action,
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "company_member",
        resourceId: String(metadata.targetUserId ?? ctx.userId ?? companyId),
        decision: "deny",
        metadata: { reason: code, principal: classifyPrincipal(ctx), ...metadata },
      });
    } catch (error) {
      this.logger?.warn({ err: error, action, code }, "code_membership_denial_audit_failed");
    }
  }

  private async auditOrFail(entry: Parameters<CodeMembershipAuditPort["record"]>[0]): Promise<void> {
    if (!this.audit) {
      throw new CodeMembershipError("audit_unavailable", "Membership changes require the audit journal", {
        httpStatus: 503,
        retryable: true,
      });
    }
    try {
      await this.audit.record(entry);
    } catch (error) {
      this.logger?.warn({ err: error, action: entry.action }, "code_membership_audit_failed");
      throw new CodeMembershipError("audit_unavailable", "Membership changes require the audit journal", {
        httpStatus: 503,
        retryable: true,
      });
    }
  }
}
