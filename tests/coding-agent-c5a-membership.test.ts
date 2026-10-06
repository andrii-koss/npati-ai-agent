import { describe, expect, it, vi } from "vitest";
import {
  CodeMembershipError,
  CodeMembershipService,
  COMPANY_ROLES,
  DEFAULT_COMPANY_ROLE_MATRIX,
  DEFAULT_INVITE_TTL_MS,
  createCompanyRoleRegistry,
  hashInviteToken,
  permissionsForCompanyRole,
  type CodeMembershipAuditPort,
  type CodeMembershipStore,
  type CompanyInvite,
  type CompanyMember,
  type CompanyMemberStatus,
  type CompanyRole,
} from "../apps/agent-api/src/code-membership";
import { CODE_PRIVILEGED_PERMISSIONS, createRoleRegistry, type CodeRoleRegistry } from "../apps/agent-api/src/code-rbac";

/**
 * C5a security-gate (SG-2): company membership is the authorization anchor for the Coding Agent.
 *
 * The properties pinned here are the ones an escalation would attack:
 *  - no membership row means **no role** — there is no "owner by default" fallback;
 *  - a role grants exactly the permissions of `DEFAULT_COMPANY_ROLE_MATRIX` (reviewer is read-only);
 *  - invites are hashed, TTL-bound and single-use, and only owner/admin may issue them;
 *  - the only owner of a company can be neither demoted nor removed;
 *  - a company admin has no authority in another company;
 *  - a role change is optimistic-concurrency checked, so a stale revision cannot overwrite a newer one;
 *  - every mutation is written to the audit journal **before** it is applied, and an unavailable journal
 *    refuses the change.
 *
 * The store is the injected `CodeMembershipStore` port. The postgres/in-memory implementations land with
 * `packages/workspace/src/migration-072.ts` (see the report): these tests therefore pin the *service* and
 * *port* contract — the conflict code a real store must raise is asserted through a store that follows
 * the documented contract.
 */

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

interface SeedMember {
  companyId: string;
  userId: string;
  role: CompanyRole;
  status?: CompanyMemberStatus;
  revision?: number;
}

interface StoreState {
  members: Map<string, CompanyMember>;
  invites: Map<string, CompanyInvite>;
  calls: Record<string, number>;
  events: string[];
  lastUpdate: { companyId: string; userId: string; role: CompanyRole; expectedRevision: number } | null;
}

const memberKey = (companyId: string, userId: string): string => `${companyId}:${userId}`;

function createMembershipStore(seed: SeedMember[] = [], events: string[] = []): { store: CodeMembershipStore; state: StoreState } {
  const state: StoreState = { members: new Map(), invites: new Map(), calls: {}, events, lastUpdate: null };
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  for (const entry of seed) {
    state.members.set(memberKey(entry.companyId, entry.userId), {
      id: `cm_${entry.userId}`,
      companyId: entry.companyId,
      userId: entry.userId,
      role: entry.role,
      status: entry.status ?? "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: entry.revision ?? 1,
    });
  }
  const counted = (name: string): void => {
    state.calls[name] = (state.calls[name] ?? 0) + 1;
  };

  const store: CodeMembershipStore = {
    async getCompanyMembership(companyId, userId) {
      counted("getCompanyMembership");
      return state.members.get(memberKey(companyId, userId)) ?? null;
    },
    async listCompanyMembers(companyId) {
      counted("listCompanyMembers");
      return [...state.members.values()].filter((member) => member.companyId === companyId);
    },
    async countCompanyOwners(companyId) {
      counted("countCompanyOwners");
      return [...state.members.values()].filter(
        (member) => member.companyId === companyId && member.role === "owner" && member.status === "active",
      ).length;
    },
    async createCompanyInvite(input) {
      counted("createCompanyInvite");
      state.events.push("store:createCompanyInvite");
      const invite: CompanyInvite = { ...input, createdAt: input.createdAt ?? timestamp };
      state.invites.set(invite.tokenHash, invite);
      return invite;
    },
    async findCompanyInviteByTokenHash(tokenHash) {
      counted("findCompanyInviteByTokenHash");
      return state.invites.get(tokenHash) ?? null;
    },
    async acceptCompanyInvite(input) {
      counted("acceptCompanyInvite");
      state.events.push("store:acceptCompanyInvite");
      const stored = state.invites.get(input.invite.tokenHash);
      if (stored) stored.acceptedAt = input.acceptedAt;
      const member: CompanyMember = {
        id: `cm_${input.userId}`,
        companyId: input.invite.companyId,
        userId: input.userId,
        role: input.invite.role,
        status: "active",
        invitedBy: input.invite.createdBy,
        invitedAt: input.invite.createdAt,
        acceptedAt: input.acceptedAt,
        createdAt: input.acceptedAt,
        updatedAt: input.acceptedAt,
        revision: 1,
      };
      state.members.set(memberKey(member.companyId, member.userId), member);
      return member;
    },
    async updateCompanyMemberRole(input) {
      counted("updateCompanyMemberRole");
      state.lastUpdate = {
        companyId: input.companyId,
        userId: input.userId,
        role: input.role,
        expectedRevision: input.expectedRevision,
      };
      const existing = state.members.get(memberKey(input.companyId, input.userId));
      if (!existing) {
        throw new CodeMembershipError("membership_not_found", "User is not a member of this company", { httpStatus: 404 });
      }
      if (existing.revision !== input.expectedRevision) {
        // The documented port contract: a stale revision is a conflict, and nothing is written.
        throw new CodeMembershipError("membership_revision_conflict", "Membership changed by another request", {
          httpStatus: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: existing.revision },
        });
      }
      const next: CompanyMember = { ...existing, role: input.role, revision: existing.revision + 1, updatedAt: input.updatedAt };
      state.members.set(memberKey(input.companyId, input.userId), next);
      state.events.push("store:updateCompanyMemberRole");
      return next;
    },
    async removeCompanyMember(input) {
      counted("removeCompanyMember");
      state.events.push("store:removeCompanyMember");
      state.members.delete(memberKey(input.companyId, input.userId));
    },
  };
  return { store, state };
}

interface MembershipAuditSpy {
  port: CodeMembershipAuditPort;
  entries: Array<Parameters<CodeMembershipAuditPort["record"]>[0]>;
}

function membershipAudit(events: string[] = [], options: { fail?: boolean } = {}): MembershipAuditSpy {
  const entries: MembershipAuditSpy["entries"] = [];
  return {
    entries,
    port: {
      record: async (entry) => {
        if (options.fail) throw new Error("audit journal down");
        entries.push(entry);
        events.push(`audit:${entry.action}`);
      },
    },
  };
}

function actor(userId: string, externalSubject?: string) {
  return { userId, externalSubject, companyId: COMPANY_A };
}

const INVITE_TOKEN = "invite-token-0123456789";

/** Builds a service around a seeded store with a controllable clock. */
function build(options: { seed?: SeedMember[]; audit?: "ok" | "missing" | "failing"; now?: Date; inviteTtlMs?: number } = {}) {
  const events: string[] = [];
  const { store, state } = createMembershipStore(options.seed ?? [], events);
  const audit = options.audit === "missing" ? null : membershipAudit(events, { fail: options.audit === "failing" });
  let clock = options.now ?? new Date("2026-03-01T10:00:00.000Z");
  const logger = { warn: vi.fn() };
  const service = new CodeMembershipService({
    store,
    ...(audit ? { audit: audit.port } : {}),
    now: () => clock,
    inviteTtlMs: options.inviteTtlMs ?? 3_600_000,
    logger,
  });
  return {
    service,
    store,
    state,
    events,
    logger,
    entries: audit?.entries ?? [],
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

async function refusal(action: () => Promise<unknown>): Promise<CodeMembershipError | null> {
  return action().then(
    () => null,
    (error: unknown) => error as CodeMembershipError,
  );
}

describe("security-gate: C5a membership — no membership means no role, never owner by default", () => {
  it("resolves no role for a user without a membership row", async () => {
    const { service } = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    expect(await service.resolveRoleForUser(actor("u-stranger"), COMPANY_A)).toBe(null);
    expect(await service.resolveRoleForUser(actor("u-owner"), COMPANY_B)).toBe(null);
    expect(await service.resolveRoleForUser({ userId: null }, COMPANY_A)).toBe(null);
  });

  it("resolves no role for a member who is only invited or suspended", async () => {
    const { service } = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-invited", role: "admin", status: "invited" },
        { companyId: COMPANY_A, userId: "u-suspended", role: "owner", status: "suspended" },
      ],
    });
    expect(await service.resolveRoleForUser(actor("u-invited"), COMPANY_A)).toBe(null);
    expect(await service.resolveRoleForUser(actor("u-suspended"), COMPANY_A)).toBe(null);
  });

  it("refuses management to a user who is not a member of the company", async () => {
    const { service, state } = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    const calls: Array<() => Promise<unknown>> = [
      () => service.listMembers(actor("u-stranger"), COMPANY_A),
      () => service.invite(actor("u-stranger"), COMPANY_A, { email: "x@example.com", role: "developer", token: INVITE_TOKEN }),
      () => service.updateRole(actor("u-stranger"), COMPANY_A, { userId: "u-owner", role: "admin", expectedRevision: 1 }),
      () => service.removeMember(actor("u-stranger"), COMPANY_A, "u-owner"),
    ];
    for (const call of calls) {
      const failure = await refusal(call);
      if (!failure) throw new Error("a non-member managed the company");
      expect(failure.code).toBe("membership_manage_forbidden");
      expect(failure.httpStatus).toBe(403);
      expect(failure.retryable).toBe(false);
      expect(failure.details?.role).toBe(null);
    }
    // Nothing changed, and the single owner is still there.
    expect(state.members.size).toBe(1);
    expect(state.calls.updateCompanyMemberRole).toBeUndefined();
    expect(state.calls.createCompanyInvite).toBeUndefined();
  });

  it("requires a user session and refuses an agent principal outright", async () => {
    const { service, state } = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    expect((await refusal(() => service.listMembers({ userId: null }, COMPANY_A)))?.code).toBe("membership_user_required");
    const agent = await refusal(() => service.listMembers(actor("agent:runner-1"), COMPANY_A));
    expect(agent?.code).toBe("agent_cannot_change_policy");
    expect(agent?.httpStatus).toBe(403);
    expect(state.calls.listCompanyMembers).toBeUndefined();
  });

  it("grants nothing for a null, empty or unknown role", () => {
    expect(permissionsForCompanyRole(null)).toEqual([]);
    expect(permissionsForCompanyRole(undefined)).toEqual([]);
    expect(permissionsForCompanyRole("")).toEqual([]);
    expect(permissionsForCompanyRole("superuser")).toEqual([]);
  });
});

describe("security-gate: C5a membership — the role decides the permissions", () => {
  it("gives a reviewer read-only permissions and nothing else", () => {
    expect([...permissionsForCompanyRole("reviewer")].sort()).toEqual(["tools:read", "workspace:read"]);
    expect(permissionsForCompanyRole("reviewer")).not.toContain("workspace:write");
    expect(permissionsForCompanyRole("reviewer")).not.toContain("tools:execute");
    expect(permissionsForCompanyRole("reviewer")).not.toContain("business:manage");
    expect(permissionsForCompanyRole("reviewer")).not.toContain("admin:all");
  });

  it("separates developer, admin and owner exactly as the plan describes", () => {
    const developer = permissionsForCompanyRole("developer");
    expect(developer).toContain("workspace:read");
    expect(developer).toContain("workspace:write");
    expect(developer).toContain("tools:read");
    expect(developer).toContain("tools:execute");
    expect(developer).not.toContain("business:manage");
    expect(developer).not.toContain("audit:read");
    expect(developer).not.toContain("admin:all");

    const admin = permissionsForCompanyRole("admin");
    expect(admin).toContain("business:manage");
    expect(admin).toContain("audit:read");
    expect(admin).not.toContain("admin:all");

    expect(permissionsForCompanyRole("owner")).toContain("admin:all");
    expect([...COMPANY_ROLES].sort()).toEqual(["admin", "developer", "owner", "reviewer"]);
  });

  it("names no privileged permission implicitly, and names one explicitly only on owner", () => {
    // The security property is **implicit** privilege: a role must never end up holding a privileged
    // permission it did not name itself. `owner` names `code.policy.manage` on purpose (the plan puts the
    // provider data policy at owner level), so the roles that name a privileged permission are exactly
    // `["owner"]` — a second role would fail this test instead of passing silently — and production,
    // protected-branch, RBAC and trust permissions stay unnamed by every role.
    const explicitlyNaming = new Map<string, string[]>();
    for (const role of COMPANY_ROLES) {
      const declared = permissionsForCompanyRole(role);
      for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
        if (declared.includes(privileged)) {
          explicitlyNaming.set(role, [...(explicitlyNaming.get(role) ?? []), privileged]);
        }
      }
    }
    expect([...explicitlyNaming.keys()]).toEqual(["owner"]);
    expect(explicitlyNaming.get("owner")).toEqual(["code.policy.manage"]);

    // The registry may only ever hand out a privileged permission the role declared: no wildcard
    // (`admin:all` on owner) turns into one.
    const registry = createRoleRegistry({ roles: { ...DEFAULT_COMPANY_ROLE_MATRIX } });
    for (const role of COMPANY_ROLES) {
      const declared = permissionsForCompanyRole(role);
      const effective = registry.permissionsForRole(role);
      for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
        expect(effective.includes(privileged), `${role} must not gain ${privileged} implicitly`)
          .toBe(declared.includes(privileged));
      }
    }
  });

  it("plugs the company matrix into the one RBAC registry without a second permission system", () => {
    const registry = createRoleRegistry({ roles: { ...DEFAULT_COMPANY_ROLE_MATRIX } });
    for (const role of COMPANY_ROLES) {
      expect(registry.roleOf({ workspaceId: "w", userId: "u", companyId: COMPANY_A, permissions: [], role } as never), role).toBe(role);
      expect([...registry.permissionsForRole(role)].sort(), role).toEqual([...permissionsForCompanyRole(role)].sort());
    }
    // The composition helper exists precisely so call sites do not hand-roll the mapping.
    const composed = createCompanyRoleRegistry((matrix) => createRoleRegistry(matrix)) as CodeRoleRegistry;
    expect(composed.roleOf({ workspaceId: "w", userId: "u", companyId: COMPANY_A, permissions: [], role: "developer" } as never)).toBe("developer");
    expect([...composed.permissionsForRole("developer")].sort()).toEqual([...permissionsForCompanyRole("developer")].sort());
  });
});

describe("security-gate: C5a membership — invites are hashed, TTL-bound and single use", () => {
  it("stores only a hash of the invite token and expires the invite exactly at the TTL", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }], inviteTtlMs: 3_600_000 });
    const invite = await harness.service.invite(actor("u-owner"), COMPANY_A, {
      email: "dev@example.com",
      role: "developer",
      token: INVITE_TOKEN,
    });
    expect(invite.tokenHash).toBe(hashInviteToken(INVITE_TOKEN));
    expect(invite.tokenHash).not.toBe(INVITE_TOKEN);
    expect(invite.expiresAt.getTime()).toBe(harness.now().getTime() + 3_600_000);
    expect(invite.role).toBe("developer");
    expect(JSON.stringify(invite)).not.toContain(INVITE_TOKEN);
    // Audit first, store second.
    expect(harness.events).toEqual(["audit:code.membership.invite", "store:createCompanyInvite"]);
    expect(DEFAULT_INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("accepts a valid invite and creates the membership with the invited role", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "dev@example.com", role: "developer", token: INVITE_TOKEN });
    harness.events.length = 0;
    const member = await harness.service.acceptInvite({ userId: "u-dev", email: "dev@example.com" }, { token: INVITE_TOKEN });
    expect(member).toMatchObject({ companyId: COMPANY_A, userId: "u-dev", role: "developer", status: "active" });
    expect(harness.events).toEqual(["audit:code.membership.accept", "store:acceptCompanyInvite"]);
    expect(await harness.service.resolveRoleForUser(actor("u-dev"), COMPANY_A)).toBe("developer");
  });

  it("refuses an expired invite without creating a member", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }], inviteTtlMs: 1_000 });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "dev@example.com", role: "developer", token: INVITE_TOKEN });
    harness.advance(1_001);
    const failure = await refusal(() => harness.service.acceptInvite({ userId: "u-dev", email: "dev@example.com" }, { token: INVITE_TOKEN }));
    expect(failure?.code).toBe("invite_expired");
    expect(failure?.httpStatus).toBe(410);
    expect(harness.state.calls.acceptCompanyInvite).toBeUndefined();
    expect(await harness.service.resolveRoleForUser(actor("u-dev"), COMPANY_A)).toBe(null);
  });

  it("refuses a second acceptance of the same invite", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "dev@example.com", role: "developer", token: INVITE_TOKEN });
    await harness.service.acceptInvite({ userId: "u-dev", email: "dev@example.com" }, { token: INVITE_TOKEN });
    const failure = await refusal(() =>
      harness.service.acceptInvite({ userId: "u-other", email: "dev@example.com" }, { token: INVITE_TOKEN }),
    );
    expect(failure?.code).toBe("invite_already_accepted");
    expect(failure?.httpStatus).toBe(409);
    expect(await harness.service.resolveRoleForUser(actor("u-other"), COMPANY_A)).toBe(null);
  });

  it("refuses an unknown token and a token presented by the wrong email", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "dev@example.com", role: "developer", token: INVITE_TOKEN });

    const unknown = await refusal(() => harness.service.acceptInvite({ userId: "u-dev", email: "dev@example.com" }, { token: "not-the-token" }));
    expect(unknown?.code).toBe("invite_invalid");
    expect(unknown?.httpStatus).toBe(403);

    const wrongEmail = await refusal(() =>
      harness.service.acceptInvite({ userId: "u-mallory", email: "mallory@example.com" }, { token: INVITE_TOKEN }),
    );
    expect(wrongEmail?.code).toBe("invite_email_mismatch");
    expect(wrongEmail?.httpStatus).toBe(403);
    // The refused attempt did not consume the invite.
    expect(harness.state.members.has(memberKey(COMPANY_A, "u-mallory"))).toBe(false);
    expect(harness.state.invites.get(hashInviteToken(INVITE_TOKEN))?.acceptedAt).toBe(null);
  });

  it("refuses to mint an invite with a weak token or an unknown role, with no journal entry", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    const weak = await refusal(() => harness.service.invite(actor("u-owner"), COMPANY_A, { email: "d@example.com", role: "developer", token: "short" }));
    expect(weak?.code).toBe("invite_token_too_weak");
    expect(weak?.httpStatus).toBe(400);

    const badRole = await refusal(() =>
      harness.service.invite(actor("u-owner"), COMPANY_A, { email: "d@example.com", role: "superuser" as CompanyRole, token: INVITE_TOKEN }),
    );
    expect(badRole?.code).toBe("invalid_company_role");
    expect(badRole?.httpStatus).toBe(400);

    expect(harness.events).toEqual([]);
    expect(harness.state.calls.createCompanyInvite).toBeUndefined();
  });

  it("requires a user session to accept an invite", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "dev@example.com", role: "developer", token: INVITE_TOKEN });
    expect((await refusal(() => harness.service.acceptInvite({ userId: null }, { token: INVITE_TOKEN })))?.code).toBe("membership_user_required");
  });

  it("lets only owner and admin issue an invite", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
        { companyId: COMPANY_A, userId: "u-dev", role: "developer" },
        { companyId: COMPANY_A, userId: "u-rev", role: "reviewer" },
      ],
    });
    for (const userId of ["u-dev", "u-rev"]) {
      const failure = await refusal(() =>
        harness.service.invite(actor(userId), COMPANY_A, { email: "x@example.com", role: "developer", token: INVITE_TOKEN }),
      );
      expect(failure?.code, userId).toBe("membership_manage_forbidden");
    }
    expect(harness.state.calls.createCompanyInvite).toBeUndefined();
  });
});

describe("security-gate: C5a membership — the last owner is protected", () => {
  it("cannot demote the only owner, and the role does not change", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    const failure = await refusal(() =>
      harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-owner", role: "admin", expectedRevision: 1 }),
    );
    if (!failure) throw new Error("the only owner was demoted");
    expect(failure.code).toBe("last_owner_protected");
    expect(failure.httpStatus).toBe(409);
    expect(failure.details?.operation).toBe("demote");
    expect(harness.state.calls.updateCompanyMemberRole).toBeUndefined();
    expect(harness.state.members.get(memberKey(COMPANY_A, "u-owner"))?.role).toBe("owner");
  });

  it("cannot remove the only owner, and the membership survives", async () => {
    const harness = build({ seed: [{ companyId: COMPANY_A, userId: "u-owner", role: "owner" }] });
    const failure = await refusal(() => harness.service.removeMember(actor("u-owner"), COMPANY_A, "u-owner"));
    expect(failure?.code).toBe("last_owner_protected");
    expect(failure?.details?.operation).toBe("remove");
    expect(harness.state.calls.removeCompanyMember).toBeUndefined();
    expect(harness.state.members.has(memberKey(COMPANY_A, "u-owner"))).toBe(true);
  });

  it("allows a demotion once a second owner exists", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
        { companyId: COMPANY_A, userId: "u-owner-2", role: "owner" },
      ],
    });
    const updated = await harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-owner-2", role: "admin", expectedRevision: 1 });
    expect(updated.role).toBe("admin");
    expect(updated.revision).toBe(2);
    expect(harness.events).toEqual(["audit:code.membership.role_change", "store:updateCompanyMemberRole"]);
  });

  it("still allows promoting another member to owner while a single owner exists", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
        { companyId: COMPANY_A, userId: "u-dev", role: "developer" },
      ],
    });
    const updated = await harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "owner", expectedRevision: 1 });
    expect(updated.role).toBe("owner");
  });

  it("protects the last owner of each company independently", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-a", role: "owner" },
        { companyId: COMPANY_B, userId: "u-b1", role: "owner" },
        { companyId: COMPANY_B, userId: "u-b2", role: "owner" },
      ],
    });
    // Company B has two owners, so its own demotion is allowed even though A has one.
    const updated = await harness.service.updateRole(actor("u-b1"), COMPANY_B, { userId: "u-b2", role: "admin", expectedRevision: 1 });
    expect(updated.role).toBe("admin");
  });
});

describe("security-gate: C5a membership — companies are isolated", () => {
  const seed: SeedMember[] = [
    { companyId: COMPANY_A, userId: "u-admin-a", role: "admin" },
    { companyId: COMPANY_A, userId: "u-dev-a", role: "developer" },
    { companyId: COMPANY_B, userId: "u-owner-b", role: "owner" },
    { companyId: COMPANY_B, userId: "u-dev-b", role: "developer" },
  ];

  it("refuses an admin of one company any action inside another", async () => {
    const harness = build({ seed });
    const calls: Array<() => Promise<unknown>> = [
      () => harness.service.listMembers(actor("u-admin-a"), COMPANY_B),
      () => harness.service.invite(actor("u-admin-a"), COMPANY_B, { email: "x@example.com", role: "developer", token: INVITE_TOKEN }),
      () => harness.service.updateRole(actor("u-admin-a"), COMPANY_B, { userId: "u-dev-b", role: "reviewer", expectedRevision: 1 }),
      () => harness.service.removeMember(actor("u-admin-a"), COMPANY_B, "u-dev-b"),
    ];
    for (const call of calls) {
      const failure = await refusal(call);
      if (!failure) throw new Error("a company admin acted in another company");
      expect(failure.code).toBe("membership_manage_forbidden");
      expect(failure.httpStatus).toBe(403);
    }
    expect(harness.state.members.get(memberKey(COMPANY_B, "u-dev-b"))?.role).toBe("developer");
  });

  it("resolves the role per company, not per user", async () => {
    const harness = build({ seed });
    expect(await harness.service.resolveRoleForUser(actor("u-dev-a"), COMPANY_A)).toBe("developer");
    expect(await harness.service.resolveRoleForUser(actor("u-dev-a"), COMPANY_B)).toBe(null);
    expect(await harness.service.resolveRoleForUser(actor("u-owner-b"), COMPANY_A)).toBe(null);
  });

  it("lists only the members of the requested company", async () => {
    const harness = build({ seed });
    const members = await harness.service.listMembers(actor("u-admin-a"), COMPANY_A);
    expect(members.map((member) => member.userId).sort()).toEqual(["u-admin-a", "u-dev-a"]);
  });
});

describe("security-gate: C5a membership — a stale revision cannot overwrite a newer role", () => {
  it("passes the caller's revision to the store and refuses the conflict without applying it", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
        { companyId: COMPANY_A, userId: "u-dev", role: "developer", revision: 1 },
      ],
    });
    const failure = await refusal(() =>
      harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "reviewer", expectedRevision: 99 }),
    );
    if (!failure) throw new Error("a stale revision was applied");
    expect(failure.httpStatus).toBe(409);
    expect(failure.details?.actualRevision).toBe(1);
    // The service does not invent a revision: the caller's token is what the store checks.
    expect(harness.state.lastUpdate?.expectedRevision).toBe(99);
    expect(harness.state.members.get(memberKey(COMPANY_A, "u-dev"))?.role).toBe("developer");
  });

  it("applies the change with the current revision", async () => {
    const harness = build({
      seed: [
        { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
        { companyId: COMPANY_A, userId: "u-dev", role: "developer" },
      ],
    });
    const updated = await harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "reviewer", expectedRevision: 1 });
    expect(updated.role).toBe("reviewer");
    expect(updated.revision).toBe(2);
  });
});

describe("security-gate: C5a membership — audit before the change, fail closed", () => {
  const seed: SeedMember[] = [
    { companyId: COMPANY_A, userId: "u-owner", role: "owner" },
    { companyId: COMPANY_A, userId: "u-dev", role: "developer" },
  ];

  it("writes the journal entry before every mutation", async () => {
    const harness = build({ seed });
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "d@example.com", role: "developer", token: INVITE_TOKEN });
    await harness.service.acceptInvite({ userId: "u-new", email: "d@example.com" }, { token: INVITE_TOKEN });
    await harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "reviewer", expectedRevision: 1 });
    await harness.service.removeMember(actor("u-owner"), COMPANY_A, "u-dev");
    expect(harness.events).toEqual([
      "audit:code.membership.invite",
      "store:createCompanyInvite",
      "audit:code.membership.accept",
      "store:acceptCompanyInvite",
      "audit:code.membership.role_change",
      "store:updateCompanyMemberRole",
      "audit:code.membership.remove",
      "store:removeCompanyMember",
    ]);
    expect(harness.entries.map((entry) => entry.actor)).toEqual(["u-owner", "u-new", "u-owner", "u-owner"]);
  });

  it("refuses every mutation when there is no journal, and changes nothing", async () => {
    const harness = build({ seed, audit: "missing" });
    const calls: Array<() => Promise<unknown>> = [
      () => harness.service.invite(actor("u-owner"), COMPANY_A, { email: "d@example.com", role: "developer", token: INVITE_TOKEN }),
      () => harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "reviewer", expectedRevision: 1 }),
      () => harness.service.removeMember(actor("u-owner"), COMPANY_A, "u-dev"),
    ];
    for (const call of calls) {
      const failure = await refusal(call);
      if (!failure) throw new Error("a membership change was applied without a journal");
      expect(failure.code).toBe("audit_unavailable");
      expect(failure.httpStatus).toBe(503);
      expect(failure.retryable).toBe(true);
    }
    await harness.service.invite(actor("u-owner"), COMPANY_A, { email: "d@example.com", role: "developer", token: INVITE_TOKEN }).catch(() => null);
    expect(harness.state.calls.createCompanyInvite).toBeUndefined();
    expect(harness.state.calls.updateCompanyMemberRole).toBeUndefined();
    expect(harness.state.calls.removeCompanyMember).toBeUndefined();
    expect(harness.state.members.get(memberKey(COMPANY_A, "u-dev"))?.role).toBe("developer");
  });

  it("fails closed, and logs, when the journal throws", async () => {
    const harness = build({ seed, audit: "failing" });
    const failure = await refusal(() =>
      harness.service.updateRole(actor("u-owner"), COMPANY_A, { userId: "u-dev", role: "reviewer", expectedRevision: 1 }),
    );
    expect(failure?.code).toBe("audit_unavailable");
    expect(harness.logger.warn).toHaveBeenCalled();
    expect(harness.state.calls.updateCompanyMemberRole).toBeUndefined();
  });

  it("refuses an agent principal even before touching the journal or the store", async () => {
    const harness = build({ seed, audit: "missing" });
    const failure = await refusal(() =>
      harness.service.updateRole(actor("agent:runner-1"), COMPANY_A, { userId: "u-dev", role: "owner", expectedRevision: 1 }),
    );
    expect(failure?.code).toBe("agent_cannot_change_policy");
    expect(harness.state.calls.updateCompanyMemberRole).toBeUndefined();
  });

  it("does not require the journal for a read", async () => {
    const harness = build({ seed, audit: "missing" });
    const members = await harness.service.listMembers(actor("u-owner"), COMPANY_A);
    expect(members.length).toBe(2);
  });
});
