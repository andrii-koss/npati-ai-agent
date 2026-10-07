import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  authorizationPayloadHash,
  authorizeCodeAction,
  CODE_NEVER_GRANTED,
  CODE_PRIVILEGED_PERMISSIONS,
  CodeRbac,
  CodeRbacError,
  classifyPrincipal,
  createRoleRegistry,
  DEFAULT_CODE_ROLE_MATRIX,
  hasAdminPermission,
  isAdminPrincipal,
  type CodeAuthorizationAuditPort,
  type CodeRoleMatrix,
} from "../apps/agent-api/src/code-rbac";
import { DEFAULT_COMPANY_ROLE_MATRIX } from "../apps/agent-api/src/code-membership";

/**
 * C5a security-gate (SG-1/SG-2): the server-side authorization point for `code.*` actions.
 *
 * What this suite pins, and why each one is a security property rather than a behaviour snapshot:
 *  - deny by default: no matrix entry (or no role) means no permission, never "owner by default";
 *  - the role -> permission matrix is **injected data**: changing the map changes the verdict with no code
 *    change, which is the mechanism the pending owner decisions plug into;
 *  - `code.prod.operate` is named by no default role and a wildcard can never imply it;
 *  - `CODE_NEVER_GRANTED` actions cannot be authorized by any role, permission or claim;
 *  - an agent is never an approver and a service identity never performs production work;
 *  - every refusal is structured (`code`, 403, `details.reason`, `retryable: false`);
 *  - the audit entry is written **before** the action, and an unavailable journal refuses the action
 *    instead of allowing it silently.
 */

function principal(input: {
  userId?: string;
  externalSubject?: string;
  role?: string;
  permissions?: string[];
  companyId?: string;
}): AuthContext {
  return {
    workspaceId: "ws-rbac",
    userId: input.userId ?? "user-rbac",
    externalSubject: input.externalSubject,
    companyId: input.companyId ?? "company-rbac",
    permissions: input.permissions ?? [],
    role: input.role,
  } as unknown as AuthContext;
}

interface AuditEntry {
  action: string;
  actor: string;
  companyId: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

/** Audit spy that also keeps a global ordering log, so "before the action" is provable, not assumed. */
function auditSpy(events: string[] = []): { port: CodeAuthorizationAuditPort; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    port: {
      record: async (entry) => {
        entries.push(entry as unknown as AuditEntry);
        events.push(`audit:${entry.action}`);
      },
    },
  };
}

const base = { permission: "workspace:write", action: "code.fs.edit" };

async function refusal(action: () => Promise<unknown>): Promise<CodeRbacError | null> {
  return action().then(
    () => null,
    (error: unknown) => error as CodeRbacError,
  );
}

describe("security-gate: C5a RBAC — deny by default", () => {
  it("refuses every action when the injected matrix is empty, for a principal without its own permission", async () => {
    const rbac = new CodeRbac({ registry: createRoleRegistry({ roles: {} }), audit: auditSpy().port });
    for (const role of ["owner", "admin", "developer", undefined]) {
      const failure = await refusal(() => rbac.authorize(principal({ role }), "company-rbac", base));
      if (!failure) throw new Error(`empty matrix allowed a ${role ?? "role-less"} principal`);
      expect(failure.code).toBe("permission_denied");
      expect(failure.httpStatus).toBe(403);
      expect(failure.details.reason).toBe("permission_denied");
    }
  });

  it("refuses a role the matrix does not define instead of falling back to owner", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    for (const role of ["superuser", "ghost", "root", "code-admin"]) {
      const failure = await refusal(() => rbac.authorize(principal({ role }), "company-rbac", base));
      if (!failure) throw new Error(`unknown role ${role} was granted ${base.permission}`);
      expect(failure.code).toBe("permission_denied");
    }
    // Role names are data, so only case and surrounding whitespace are normalised — nothing is inferred.
    expect(createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX).roleOf(principal({ role: "  OWNER  " }))).toBe("owner");
    // The same permission is granted to `owner` — so the refusals above are about the unknown role,
    // not about the action being unauthorizable in general.
    const granted = await new CodeRbac({ audit: auditSpy().port }).authorize(principal({ role: "owner" }), "company-rbac", base);
    expect(granted).toMatchObject({ allowed: true, role: "owner" });
  });

  it("does not treat an absent role as a member or owner", () => {
    const registry = createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX);
    expect(registry.roleOf(principal({}))).toBe(null);
    expect(registry.permissionsForRole(null)).toEqual([]);
    expect(registry.permissionsForRole("not-a-role")).toEqual([]);
  });
});

describe("security-gate: C5a RBAC — the matrix is injected configuration, not code", () => {
  it("changes the decision by changing only the map", async () => {
    const audit = auditSpy();
    const before = new CodeRbac({ registry: createRoleRegistry({ roles: { auditor: ["workspace:read"] } }), audit: audit.port });
    const denied = await refusal(() => before.authorize(principal({ role: "auditor" }), "company-rbac", base));
    expect(denied?.code).toBe("permission_denied");

    const after = new CodeRbac({
      registry: createRoleRegistry({ roles: { auditor: ["workspace:read", "workspace:write"] } }),
      audit: audit.port,
    });
    await expect(after.authorize(principal({ role: "auditor" }), "company-rbac", base)).resolves.toMatchObject({ allowed: true });
  });

  it("grants a privileged permission only when a role names it explicitly", async () => {
    const audit = auditSpy();
    const named = new CodeRbac({
      registry: createRoleRegistry({ roles: { platform: ["workspace:read", "code.prod.operate"] } }),
      audit: audit.port,
    });
    await expect(
      named.authorize(principal({ role: "platform" }), "company-rbac", {
        permission: "code.prod.operate",
        action: "code.deploy.production",
        production: true,
      }),
    ).resolves.toMatchObject({ allowed: true, privileged: true, role: "platform" });

    // The identical principal against the shipped default matrix is refused: the grant is data.
    const shipped = new CodeRbac({ registry: createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX), audit: audit.port });
    const refused = await refusal(() =>
      shipped.authorize(principal({ role: "owner", permissions: ["admin:all", "*"] }), "company-rbac", {
        permission: "code.prod.operate",
        action: "code.deploy.production",
        production: true,
      }),
    );
    expect(refused?.httpStatus).toBe(403);
  });

  it("carries exactly the privileged vocabulary the plan defines", () => {
    // C11 removed `code.git.protected_write` from this list: it named no reader anywhere (no route, no
    // service, no action mapping), and the surface it appeared to authorise is a hard deny for every
    // principal — a permission that can neither protect nor lift anything is deleted rather than kept as
    // decoration. The assertion is otherwise unchanged, so a future addition still has to be explicit.
    expect([...CODE_PRIVILEGED_PERMISSIONS].sort()).toEqual(
      ["code.policy.manage", "code.prod.operate", "code.rbac.manage", "code.trust.manage"].sort(),
    );
    expect(CODE_PRIVILEGED_PERMISSIONS).not.toContain("code.git.protected_write");
  });

  it("gives no default role a privileged permission it does not name, and names them only on owner", () => {
    const registries: Array<[string, ReturnType<typeof createRoleRegistry>, Record<string, readonly string[]>]> = [
      ["DEFAULT_CODE_ROLE_MATRIX", createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX), DEFAULT_CODE_ROLE_MATRIX.roles],
      [
        "DEFAULT_COMPANY_ROLE_MATRIX",
        createRoleRegistry({ roles: { ...DEFAULT_COMPANY_ROLE_MATRIX } }),
        DEFAULT_COMPANY_ROLE_MATRIX as unknown as Record<string, readonly string[]>,
      ],
    ];
    for (const [name, registry, roles] of registries) {
      expect(Object.keys(roles).length, `${name} must define roles`).toBeGreaterThan(0);
      const explicitlyNaming = new Map<string, string[]>();
      for (const [role, declared] of Object.entries(roles)) {
        for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
          // The failure mode is **implicit** privilege: a privileged permission a role never named, picked
          // up because a wildcard was expanded into the privileged space. It must hold exactly when the
          // role declares it — for every role, `owner` included.
          expect(
            registry.permissionsForRole(role).includes(privileged),
            `${name}: role ${role} must not gain ${privileged} implicitly`,
          ).toBe(declared.includes(privileged));
          if (declared.includes(privileged)) {
            explicitlyNaming.set(role, [...(explicitlyNaming.get(role) ?? []), privileged]);
          }
        }
      }
      // Exactly one role names a privileged permission and it is the owner (the plan puts the provider
      // data policy at owner level). A second role starting to name one — `code.prod.operate`,
      // `code.rbac.manage`, `code.trust.manage` — fails right here instead of slipping through as "still
      // no privileged permission at all". (`code.git.protected_write` left this vocabulary in C11.)
      expect([...explicitlyNaming.keys()], `${name}: only owner may name a privileged permission`).toEqual(["owner"]);
      expect(explicitlyNaming.get("owner"), `${name}: owner names exactly the data policy permission`)
        .toEqual(["code.policy.manage"]);
    }
    expect(CODE_PRIVILEGED_PERMISSIONS).toContain("code.prod.operate");
  });
});

describe("security-gate: C5a RBAC — a wildcard never reaches code.prod.operate", () => {
  const ownerWithEverything = principal({ role: "owner", permissions: ["*", "admin:all", "owner"] });

  it("refuses code.prod.operate for a principal holding every wildcard", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    const production = await refusal(() =>
      rbac.authorize(ownerWithEverything, "company-rbac", {
        permission: "code.prod.operate",
        action: "code.deploy.production",
        production: true,
      }),
    );
    if (!production) throw new Error("a wildcard granted code.prod.operate on a production action");
    expect(production.code).toBe("production_permission_required");
    expect(production.httpStatus).toBe(403);
    expect(production.retryable).toBe(false);
    expect(production.details.permission).toBe("code.prod.operate");

    // The `production` hint is not what protects the permission: without it the wildcard is still refused.
    const withoutHint = await refusal(() =>
      rbac.authorize(ownerWithEverything, "company-rbac", { permission: "code.prod.operate", action: "code.deploy.production" }),
    );
    if (!withoutHint) throw new Error("a wildcard granted code.prod.operate without the production hint");
    expect(withoutHint.code).toBe("permission_denied");
  });

  it("does not let `owner` (the matrix role) imply the privileged permission either", async () => {
    const registry = createRoleRegistry({ roles: { owner: ["admin:all", "owner", "*", "workspace:write"] } });
    expect(registry.permissionsForRole("owner")).not.toContain("code.prod.operate");
    const rbac = new CodeRbac({ registry, audit: auditSpy().port });
    const failure = await refusal(() =>
      rbac.authorize(principal({ role: "owner" }), "company-rbac", { permission: "code.prod.operate", action: "code.deploy.production" }),
    );
    expect(failure?.code).toBe("permission_denied");
  });

  it("still lets a wildcard widen the ordinary vocabulary (the refusal above is targeted)", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ role: "viewer", permissions: ["*"] }), "company-rbac", {
        permission: "audit:read",
        action: "code.audit.read",
      }),
    ).resolves.toMatchObject({ allowed: true, privileged: false });
  });
});

describe("security-gate: C5a RBAC — CODE_NEVER_GRANTED is not reachable by any permission", () => {
  const matrix: CodeRoleMatrix = {
    roles: {
      owner: ["admin:all", "*", ...CODE_NEVER_GRANTED],
      admin: ["admin:all", ...CODE_NEVER_GRANTED],
      member: [...CODE_NEVER_GRANTED],
    },
    neverGranted: CODE_NEVER_GRANTED,
  };

  it("refuses every never-granted action for every role, however the caller is permissioned", async () => {
    const registry = createRoleRegistry(matrix);
    for (const action of CODE_NEVER_GRANTED) {
      expect(registry.isNeverGranted(action)).toBe(true);
      for (const role of Object.keys(matrix.roles)) {
        const rbac = new CodeRbac({ registry, audit: auditSpy().port });
        const failure = await refusal(() =>
          rbac.authorize(principal({ role, permissions: ["*", "admin:all", action] }), "company-rbac", {
            permission: action,
            action,
          }),
        );
        if (!failure) throw new Error(`action ${action} was authorized for role ${role}`);
        expect(failure.code).toBe("action_never_authorizable");
        expect(failure.httpStatus).toBe(403);
        expect(failure.retryable).toBe(false);
        expect(failure.details.neverGranted).toBe(true);
      }
    }
  });

  it("does not turn a never-granted action into a privileged permission", () => {
    for (const action of CODE_NEVER_GRANTED) {
      expect(CODE_PRIVILEGED_PERMISSIONS).not.toContain(action);
      expect(createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX).isNeverGranted(action)).toBe(true);
    }
    expect(createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX).isNeverGranted("code.fs.edit")).toBe(false);
  });
});

describe("security-gate: C5a RBAC — agents and service identities have invariants no matrix can lift", () => {
  const agent = principal({ userId: "agent:runner-1", role: "owner", permissions: ["*", "admin:all"] });
  const service = principal({
    userId: "u-owner",
    externalSubject: "service:automation:automation-1",
    role: "owner",
    permissions: ["*", "admin:all"],
  });

  it("classifies a principal conservatively from either marker", () => {
    expect(classifyPrincipal(principal({ userId: "agent:runner-1" }))).toBe("agent");
    expect(classifyPrincipal(principal({ userId: "user-1", externalSubject: "agent:runner-1" }))).toBe("agent");
    expect(classifyPrincipal(principal({ userId: "user-1", externalSubject: "service:automation:1" }))).toBe("service");
    expect(classifyPrincipal(principal({ userId: "user-1" }))).toBe("user");
  });

  it("never lets an agent approve, in any role or with any permission", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    for (const role of ["owner", "admin", "member", "service", "viewer"]) {
      const failure = await refusal(() =>
        rbac.authorize(principal({ userId: "agent:runner-1", role, permissions: ["*", "admin:all"] }), "company-rbac", {
          ...base,
          approvalClaim: true,
        }),
      );
      if (!failure) throw new Error(`agent with role ${role} was allowed to approve`);
      expect(failure.code).toBe("agent_cannot_approve");
      expect(failure.httpStatus).toBe(403);
      expect(failure.retryable).toBe(false);
    }
  });

  it("keeps an agent out of the privileged route guard while the wildcard is still visible on it", () => {
    expect(isAdminPrincipal(agent)).toBe(false);
    expect(hasAdminPermission(agent.permissions)).toBe(true);
    expect(isAdminPrincipal(principal({ role: "owner", permissions: ["admin:all"] }))).toBe(true);
  });

  it("never lets a service identity perform a production operation, even when a role names the permission", async () => {
    // A registry that explicitly grants production to `owner`: the refusal must come from the principal,
    // not from a missing permission.
    const registry = createRoleRegistry({ roles: { owner: ["admin:all", "code.prod.operate"] } });
    const rbac = new CodeRbac({ registry, audit: auditSpy().port });
    const failure = await refusal(() =>
      rbac.authorize(service, "company-rbac", { permission: "code.prod.operate", action: "code.deploy.production", production: true }),
    );
    if (!failure) throw new Error("a service identity performed a production operation");
    expect(failure.code).toBe("service_identity_cannot_operate_production");
    expect(failure.httpStatus).toBe(403);
    expect(failure.retryable).toBe(false);

    const approval = await refusal(() => rbac.authorize(service, "company-rbac", { ...base, approvalClaim: true }));
    expect(approval?.code).toBe("service_cannot_approve");
  });

  it("still allows a service identity its ordinary, non-privileged work", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    await expect(rbac.authorize(service, "company-rbac", base)).resolves.toMatchObject({ allowed: true, principal: "service" });
  });
});

describe("security-gate: C5a RBAC — every refusal is structured", () => {
  const cases: Array<{ name: string; code: string; run: () => Promise<unknown> }> = [
    {
      name: "missing permission",
      code: "permission_denied",
      run: () => new CodeRbac({ audit: auditSpy().port }).authorize(principal({ role: "viewer" }), "company-rbac", base),
    },
    {
      name: "agent approval claim",
      code: "agent_cannot_approve",
      run: () =>
        new CodeRbac({ audit: auditSpy().port }).authorize(
          principal({ userId: "agent:r", role: "owner", permissions: ["admin:all"] }),
          "company-rbac",
          { ...base, approvalClaim: true },
        ),
    },
    {
      name: "service production",
      code: "service_identity_cannot_operate_production",
      run: () =>
        new CodeRbac({ audit: auditSpy().port }).authorize(
          principal({ externalSubject: "service:a", role: "owner", permissions: ["admin:all"] }),
          "company-rbac",
          { permission: "code.prod.operate", action: "code.deploy.production", production: true },
        ),
    },
    {
      name: "never-granted action",
      code: "action_never_authorizable",
      run: () =>
        new CodeRbac({ audit: auditSpy().port }).authorize(principal({ role: "owner", permissions: ["admin:all"] }), "company-rbac", {
          permission: "admin:all",
          action: "code.hard_deny",
        }),
    },
  ];

  it("reports code, 403, details.reason and retryable false for every refusal shape", async () => {
    for (const entry of cases) {
      const failure = await refusal(entry.run);
      if (!failure) throw new Error(`${entry.name} was not refused`);
      expect(failure, entry.name).toBeInstanceOf(CodeRbacError);
      expect(failure.code, entry.name).toBe(entry.code);
      expect(failure.httpStatus, entry.name).toBe(403);
      expect(failure.retryable, entry.name).toBe(false);
      expect(failure.details.reason, entry.name).toBe(entry.code);
      expect(failure.details.action, entry.name).toBeDefined();
      expect(String(failure.message), entry.name).toContain(`[${entry.code}]`);
    }
  });

  it("never marks a refusal retryable", async () => {
    const failure = await refusal(() =>
      new CodeRbac({ audit: auditSpy().port }).authorize(principal({ role: "viewer" }), "company-rbac", base),
    );
    expect(failure?.retryable).toBe(false);
  });
});

describe("security-gate: C5a RBAC — the journal is written before the action runs", () => {
  const owner = principal({ role: "owner", permissions: ["admin:all"] });

  it("writes the allow entry before the action is performed", async () => {
    const events: string[] = [];
    const audit = auditSpy(events);
    const result = await authorizeCodeAction(owner, "company-rbac", { ...base, projectId: "project-1" }, { audit: audit.port });
    expect(result.allowed).toBe(true);
    events.push("action:code.fs.edit");
    expect(events).toEqual(["audit:code.rbac.allow", "action:code.fs.edit"]);
  });

  it("writes the deny entry before the caller is refused, and no action follows", async () => {
    const events: string[] = [];
    const audit = auditSpy(events);
    const failure = await refusal(() => authorizeCodeAction(principal({ role: "viewer" }), "company-rbac", base, { audit: audit.port }));
    if (!failure) throw new Error("a viewer was allowed to write");
    expect(failure.code).toBe("permission_denied");
    expect(events).toEqual(["audit:code.rbac.deny"]);
    expect(audit.entries[0]!.metadata?.code).toBe("permission_denied");
  });

  it("binds the decision to permission, action and resource with a payload hash", async () => {
    const audit = auditSpy();
    await authorizeCodeAction(owner, "company-rbac", { ...base, projectId: "project-1" }, { audit: audit.port });
    const entry = audit.entries[0]!;
    expect(entry.resourceType).toBe("code_authorization");
    expect(entry.resourceId).toBe("project-1");
    expect(entry.metadata?.payload_hash).toBe(
      authorizationPayloadHash({ permission: "workspace:write", action: "code.fs.edit", resource: "project-1" }),
    );
    // Different payloads must not share a hash, otherwise a decision could be replayed against another one.
    expect(authorizationPayloadHash({ permission: "workspace:write", action: "code.fs.edit", resource: "project-2" })).not.toBe(
      entry.metadata?.payload_hash,
    );
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("refuses with audit_unavailable and performs no action when there is no journal at all", async () => {
    const events: string[] = [];
    const failure = await refusal(async () => {
      const result = await new CodeRbac({}).authorize(owner, "company-rbac", base);
      events.push("action:code.fs.edit");
      return result;
    });
    if (!failure) throw new Error("an action was authorized without an audit journal");
    expect(failure.code).toBe("audit_unavailable");
    expect(failure.httpStatus).toBe(503);
    expect(failure.details.reason).toBe("audit_unavailable");
    expect(failure.retryable).toBe(false);
    expect(events).toEqual([]);
  });

  it("fails closed, and logs, when the journal throws", async () => {
    const logger = { warn: vi.fn() };
    const rbac = new CodeRbac({
      audit: {
        record: async () => {
          throw new Error("audit journal down");
        },
      },
      logger,
    });
    const failure = await refusal(() => rbac.authorize(owner, "company-rbac", base));
    expect(failure?.code).toBe("audit_unavailable");
    expect(failure?.httpStatus).toBe(503);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("refuses a denial too when the journal is unavailable (a missing journal is not an allow)", async () => {
    const failure = await refusal(() => new CodeRbac({}).authorize(principal({ role: "viewer" }), "company-rbac", base));
    expect(failure?.code).toBe("audit_unavailable");
  });
});
