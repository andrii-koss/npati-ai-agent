import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthContext } from "@npati/workspace";
import {
  authorizationPayloadHash,
  authorizeCodeAction,
  classifyPrincipal,
  CODE_ACTION_PERMISSIONS,
  CODE_PRIVILEGED_PERMISSIONS,
  CODE_RBAC_PERMISSIONS,
  CodeRbac,
  CodeRbacError,
  createRoleRegistry,
  DEFAULT_CODE_ROLE_MATRIX,
  hasAdminPermission,
  isAdminPrincipal,
  requiredPermissionForAction,
  type CodeAuthorizationAuditPort,
  type CodeRoleMatrix,
} from "../apps/agent-api/src/code-rbac";

function principal(input: {
  userId?: string;
  externalSubject?: string;
  role?: string;
  permissions?: string[];
  workspaceId?: string;
  companyId?: string;
}): AuthContext {
  return {
    workspaceId: input.workspaceId ?? "ws-rbac",
    userId: input.userId ?? "user-rbac",
    externalSubject: input.externalSubject,
    companyId: input.companyId ?? "company-rbac",
    permissions: input.permissions ?? ["workspace:read"],
    role: input.role,
  } as unknown as AuthContext;
}

function auditSpy(): { port: CodeAuthorizationAuditPort; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    port: {
      record: async (entry) => {
        calls.push(entry as unknown as Record<string, unknown>);
      },
    },
  };
}

const base = { permission: "workspace:write", action: "code.fs.edit" };

describe("security-gate: C5a RBAC foundation — deny by default", () => {
  it("denies every action when the role matrix is empty", async () => {
    const empty = createRoleRegistry({ roles: {} });
    const rbac = new CodeRbac({ registry: empty, audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ role: "owner", permissions: [] }), "company-rbac", base),
    ).rejects.toMatchObject({ code: "permission_denied", httpStatus: 403, retryable: false });
  });

  it("denies an unknown role even when the caller names permissions it does not have in the matrix", async () => {
    const rbac = new CodeRbac({ registry: createRoleRegistry({ roles: { reader: ["workspace:read"] } }), audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ role: "ghost", permissions: [] }), "company-rbac", base),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("returns a structured refusal: code, 403, details.reason and retryable false", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    // `reviewer` is a real read-only company role, so the refusal comes from the permission and not
    // from an unknown role name.
    const outcome = await rbac
      .authorize(principal({ role: "reviewer" }), "company-rbac", base)
      .then(() => null, (error: unknown) => error as CodeRbacError);
    expect(outcome).toBeInstanceOf(CodeRbacError);
    // Narrowed once, so every assertion below reads a `CodeRbacError` rather than a union.
    const failure = outcome as CodeRbacError;
    expect(failure.code).toBe("permission_denied");
    expect(failure.httpStatus).toBe(403);
    expect(failure.retryable).toBe(false);
    expect(failure.details.reason).toBe("permission_denied");
    expect(String(failure.message)).toContain("[permission_denied]");
  });

  it("allows a role whose matrix grants the permission", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    // The token names only `workspace:read`, so the allowance has to come from the role matrix.
    const result = await rbac.authorize(principal({ role: "developer" }), "company-rbac", base);
    expect(result).toMatchObject({ allowed: true, permission: "workspace:write", principal: "user", role: "developer" });
  });

  it("takes the human roles from the company matrix: developer writes, reviewer only reads", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    // The four company roles are the frozen matrix `code-membership.ts` owns, imported not copied.
    expect(DEFAULT_CODE_ROLE_MATRIX.roles.developer ?? []).toContain("workspace:write");
    expect(DEFAULT_CODE_ROLE_MATRIX.roles.reviewer ?? []).toEqual(["workspace:read", "tools:read"]);
    await expect(rbac.authorize(principal({ role: "developer" }), "company-rbac", base))
      .resolves.toMatchObject({ allowed: true, role: "developer" });
    // A reviewer may read and see the tool catalog, but never write or execute a tool.
    await expect(rbac.authorize(principal({ role: "reviewer" }), "company-rbac", { permission: "workspace:read", action: "code.fs.read" }))
      .resolves.toMatchObject({ allowed: true, role: "reviewer" });
    await expect(rbac.authorize(principal({ role: "reviewer" }), "company-rbac", base))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(rbac.authorize(principal({ role: "reviewer" }), "company-rbac", { permission: "tools:execute", action: "code.verify.run" }))
      .rejects.toMatchObject({ code: "permission_denied" });
    // The owner is the only role with the administration vocabulary, and it is not privileged-by-default.
    expect(DEFAULT_CODE_ROLE_MATRIX.roles.owner ?? []).toContain("admin:all");
    for (const removed of ["member", "viewer"]) {
      expect(DEFAULT_CODE_ROLE_MATRIX.roles[removed], `${removed} was replaced by the plan role set`).toBeUndefined();
    }
  });
});

describe("security-gate: C5a RBAC foundation — the matrix is injected configuration", () => {
  it("changes the decision by changing only the map, with no code change", async () => {
    const audit = auditSpy();
    const before = new CodeRbac({ registry: createRoleRegistry({ roles: { auditor: ["workspace:read"] } }), audit: audit.port });
    await expect(
      before.authorize(principal({ role: "auditor" }), "company-rbac", base),
    ).rejects.toMatchObject({ code: "permission_denied" });

    const after = new CodeRbac({ registry: createRoleRegistry({ roles: { auditor: ["workspace:read", "workspace:write"] } }), audit: audit.port });
    await expect(after.authorize(principal({ role: "auditor" }), "company-rbac", base)).resolves.toMatchObject({ allowed: true });
  });

  it("treats role names as data and matches them case-insensitively", async () => {
    const rbac = new CodeRbac({ registry: createRoleRegistry({ roles: { Reviewer: ["workspace:write"] } }), audit: auditSpy().port });
    await expect(rbac.authorize(principal({ role: "reviewer" }), "company-rbac", base)).resolves.toMatchObject({ allowed: true, role: "reviewer" });
  });

  it("keeps privileged permissions out of every default role", () => {
    const roles = Object.entries(DEFAULT_CODE_ROLE_MATRIX.roles);
    expect(roles.length).toBeGreaterThan(0);
    for (const [role, permissions] of roles) {
      expect(permissions, `${role} must not carry a privileged permission`).not.toContain("code.prod.operate");
      expect(permissions).not.toContain("code.git.protected_write");
      expect(permissions).not.toContain("code.policy.manage");
    }
  });

  it("does not let a wildcard permission imply a privileged one", async () => {
    const registry = createRoleRegistry({ roles: { owner: ["admin:all", "workspace:write"] } });
    const rbac = new CodeRbac({ registry, audit: auditSpy().port });
    // The ordinary vocabulary is widened by the wildcard ...
    await expect(rbac.authorize(principal({ role: "owner", permissions: ["*"] }), "company-rbac", base)).resolves.toMatchObject({ allowed: true });
    // ... but production operations are not, even for an owner with `admin:all` and `*`. The refusal
    // is reported with the production-specific code (still a 403 denial: the action never runs).
    await expect(
      rbac.authorize(principal({ role: "owner", permissions: ["admin:all", "*"] }), "company-rbac", {
        permission: "code.prod.operate",
        action: "code.deploy.production",
        production: true,
      }),
    ).rejects.toMatchObject({ code: "production_permission_required", httpStatus: 403 });
  });

  it("refuses an action the matrix lists as never granted, whatever the role says", async () => {
    const matrix: CodeRoleMatrix = { roles: { owner: ["admin:all", "code.hard_deny"] }, neverGranted: ["code.hard_deny"] };
    const rbac = new CodeRbac({ registry: createRoleRegistry(matrix), audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ role: "owner", permissions: ["admin:all"] }), "company-rbac", {
        permission: "admin:all",
        action: "code.hard_deny",
      }),
    ).rejects.toMatchObject({ code: "action_never_authorizable" });
  });
});

describe("security-gate: C5a RBAC foundation — principal invariants", () => {
  it("classifies agent and service principals conservatively", () => {
    expect(classifyPrincipal(principal({ userId: "agent:runner-1" }))).toBe("agent");
    expect(classifyPrincipal(principal({ userId: "user-1", externalSubject: "agent:runner-1" }))).toBe("agent");
    expect(classifyPrincipal(principal({ userId: "user-1", externalSubject: "service:automation-1" }))).toBe("service");
    expect(classifyPrincipal(principal({ userId: "user-1" }))).toBe("user");
  });

  it("never lets an agent approve its own action, in any role", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ userId: "agent:runner-1", role: "owner", permissions: ["admin:all"] }), "company-rbac", {
        ...base,
        approvalClaim: true,
      }),
    ).rejects.toMatchObject({ code: "agent_cannot_approve" });
  });

  it("never lets an agent change mode, roles, flags or policy", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    await expect(
      rbac.authorize(principal({ userId: "agent:runner-1", role: "owner", permissions: ["admin:all"] }), "company-rbac", {
        ...base,
        policyChange: true,
      }),
    ).rejects.toMatchObject({ code: "agent_cannot_change_policy" });
  });

  it("never lets a service identity operate production or approve", async () => {
    const rbac = new CodeRbac({ audit: auditSpy().port });
    const service = principal({ externalSubject: "service:automation-1", role: "owner", permissions: ["admin:all"] });
    await expect(
      rbac.authorize(service, "company-rbac", { permission: "code.prod.operate", action: "code.deploy.production", production: true }),
    ).rejects.toMatchObject({ code: "service_identity_cannot_operate_production" });
    await expect(
      rbac.authorize(service, "company-rbac", { ...base, approvalClaim: true }),
    ).rejects.toMatchObject({ code: "service_cannot_approve" });
  });

  it("keeps an agent out of privileged route guards but lets an owner through", () => {
    expect(isAdminPrincipal(principal({ role: "owner", permissions: ["admin:all"] }))).toBe(true);
    expect(isAdminPrincipal(principal({ userId: "agent:x", role: "owner", permissions: ["admin:all"] }))).toBe(false);
    expect(isAdminPrincipal(principal({ externalSubject: "service:x", role: "owner", permissions: ["admin:all"] }))).toBe(false);
    expect(hasAdminPermission(["*"])).toBe(true);
    expect(hasAdminPermission(["workspace:write"])).toBe(false);
    expect(hasAdminPermission(undefined)).toBe(false);
  });
});

describe("security-gate: C5a RBAC foundation — auditing happens before the action", () => {
  it("records an allow decision with a payload hash and no secrets", async () => {
    const audit = auditSpy();
    const rbac = new CodeRbac({ audit: audit.port });
    await rbac.authorize(principal({ role: "developer" }), "company-rbac", { ...base, projectId: "project-1" });
    expect(audit.calls).toHaveLength(1);
    const entry = audit.calls[0]!;
    expect(entry.action).toBe("code.rbac.allow");
    expect(entry.companyId).toBe("company-rbac");
    expect(entry.resourceType).toBe("code_authorization");
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.payload_hash).toBe(
      authorizationPayloadHash({ permission: "workspace:write", action: "code.fs.edit", resource: "project-1" }),
    );
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("records every denial before the caller learns about it", async () => {
    const audit = auditSpy();
    const rbac = new CodeRbac({ audit: audit.port });
    await expect(rbac.authorize(principal({ role: "reviewer" }), "company-rbac", base)).rejects.toBeInstanceOf(CodeRbacError);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.action).toBe("code.rbac.deny");
    expect((audit.calls[0]!.metadata as Record<string, unknown>).code).toBe("permission_denied");
  });

  it("fails closed when the journal is unavailable: the action is not authorized", async () => {
    const rbac = new CodeRbac({ audit: { record: async () => { throw new Error("journal down"); } } });
    // `developer` is allowed the action by the matrix, so the refusal can only come from the journal.
    await expect(rbac.authorize(principal({ role: "developer" }), "company-rbac", base)).rejects.toMatchObject({
      code: "audit_unavailable",
      httpStatus: 503,
    });
  });

  it("fails closed with no journal at all (an authorization gate never allows silently)", async () => {
    const rbac = new CodeRbac({});
    await expect(rbac.authorize(principal({ role: "developer" }), "company-rbac", base)).rejects.toMatchObject({ code: "audit_unavailable" });
  });

  it("logs, but does not silently allow, when the journal throws", async () => {
    const logger = { warn: vi.fn() };
    const rbac = new CodeRbac({ audit: { record: async () => { throw new Error("boom"); } }, logger });
    await expect(rbac.authorize(principal({ role: "developer" }), "company-rbac", base)).rejects.toMatchObject({ code: "audit_unavailable" });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("security-gate: C5a RBAC foundation — route guards use the shared vocabulary", () => {
  const owner = principal({ role: "owner", permissions: ["admin:all"] });
  const developer = principal({ role: "developer", permissions: ["workspace:read", "workspace:write", "business:manage"] });

  it("denies a plain company member where an owner is required (code routes, approval rules, sandbox images)", async () => {
    const audit = auditSpy();
    const plainMember = principal({ role: "developer", permissions: ["workspace:read"] });
    // The mapped permission for a policy change is `business:manage`, which a developer does not carry:
    // the gate checks the pair first, then the grant, and refuses.
    await expect(
      authorizeCodeAction(
        plainMember,
        "company-rbac",
        { permission: "business:manage", action: "code.flags.change" },
        { audit: audit.port },
      ),
    ).rejects.toMatchObject({ code: "permission_denied", httpStatus: 403, details: { privileged: false } });
    // A label that does not authorise the action is a caller error and is reported with the permission the
    // action actually needs. This combination used to resolve as `allow`, because the gate authorized the
    // label the caller supplied instead of the permission the action requires (C5a D11).
    await expect(
      authorizeCodeAction(
        plainMember,
        "company-rbac",
        { permission: "workspace:read", action: "code.flags.change" },
        { audit: audit.port },
      ),
    ).rejects.toMatchObject({
      code: "permission_action_mismatch",
      httpStatus: 403,
      details: { expected: "business:manage", provided: "workspace:read" },
    });
    // An action outside the known vocabulary is refused by default, even for a token carrying a wildcard.
    await expect(
      authorizeCodeAction(
        owner,
        "company-rbac",
        { permission: "admin:all", action: "code.future.tool" },
        { audit: audit.port },
      ),
    ).rejects.toMatchObject({ code: "action_not_mapped", httpStatus: 403, details: { actionMapped: false } });
    // flag change and kill switch use the stricter "user admin" guard
    expect(isAdminPrincipal(developer)).toBe(false);
    expect(hasAdminPermission(developer.permissions)).toBe(false);
    expect(isAdminPrincipal(owner)).toBe(true);
  });

  it("allows the owner through the same helper the routes call", async () => {
    const audit = auditSpy();
    await expect(
      authorizeCodeAction(owner, "company-rbac", { permission: "business:manage", action: "code.flags.change" }, { audit: audit.port }),
    ).resolves.toMatchObject({ allowed: true, principal: "user", privileged: false });
  });

  it("refuses an agent even when its token carries admin permissions", () => {
    const agent = principal({ userId: "agent:runner-1", role: "owner", permissions: ["admin:all"] });
    expect(isAdminPrincipal(agent)).toBe(false);
    expect(hasAdminPermission(agent.permissions)).toBe(true);
  });
});

describe("security-gate: C5a RBAC foundation — the required permission comes from the action", () => {
  it("maps every action to its category permission and refuses any other label", async () => {
    const audit = auditSpy();
    // `developer` carries workspace:read/write and tools:read/execute only, and holds no wildcard in its
    // token, so a pass here proves the mapping itself instead of an administrative shortcut.
    const developer = principal({ role: "developer", permissions: [] });
    const workspacePairs: Array<[string, string]> = [
      ["code.verify.run", "tools:execute"],
      ["code.shell.exec", "workspace:write"],
      ["code.fs.edit", "workspace:write"],
      ["code.fs.read", "workspace:read"],
      ["code.protected_branches.read", "workspace:read"],
    ];
    for (const [action, permission] of workspacePairs) {
      await expect(authorizeCodeAction(developer, "company-rbac", { permission, action }, { audit: audit.port }))
        .resolves.toMatchObject({ allowed: true, permission, action, role: "developer", privileged: false });
    }
    // Administrative surfaces are `business:manage`, carried by the `admin` company role, and that label is
    // the only one accepted for them: the same actions under another label are a caller error.
    const admin = principal({ role: "admin", permissions: [] });
    for (const action of [
      "code.flags.change", "code.membership.list", "code.membership.invite", "code.membership.role_change",
      "code.membership.remove", "code.protected_branches.update", "code.project.trust", "code.approval_rule.create",
    ]) {
      await expect(authorizeCodeAction(admin, "company-rbac", { permission: "business:manage", action }, { audit: audit.port }))
        .resolves.toMatchObject({ allowed: true, permission: "business:manage", action });
      await expect(authorizeCodeAction(admin, "company-rbac", { permission: "workspace:write", action }, { audit: audit.port }))
        .rejects.toMatchObject({
          code: "permission_action_mismatch",
          details: { expected: "business:manage", provided: "workspace:write" },
        });
    }
    // Production is the identity mapping (`code.prod.operate` names both the action and the permission it
    // needs) and it is granted only when a role names that privileged permission explicitly.
    const operator = new CodeRbac({ registry: createRoleRegistry({ roles: { operator: ["code.prod.operate"] } }), audit: audit.port });
    const operatorCtx = principal({ role: "operator", permissions: [] });
    for (const action of ["code.prod.operate", "code.deploy.production"]) {
      await expect(operator.authorize(operatorCtx, "company-rbac", { permission: "code.prod.operate", action, production: true }))
        .resolves.toMatchObject({ allowed: true, permission: "code.prod.operate", action, privileged: true });
      await expect(operator.authorize(operatorCtx, "company-rbac", { permission: "business:manage", action, production: true }))
        .rejects.toMatchObject({
          code: "permission_action_mismatch",
          details: { expected: "code.prod.operate", provided: "business:manage" },
        });
    }
    // The right label is still not enough for production: the privileged permission must be granted too.
    await expect(
      authorizeCodeAction(admin, "company-rbac", { permission: "code.prod.operate", action: "code.deploy.production", production: true }, { audit: audit.port }),
    ).rejects.toMatchObject({ code: "production_permission_required", httpStatus: 403 });
  });

  it("pins the action -> permission map itself, with no fallback to the caller's label", () => {
    expect(requiredPermissionForAction("code.fs.read")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.fs.edit")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.shell.exec")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.verify.run")).toBe("tools:execute");
    expect(requiredPermissionForAction("code.flags.change")).toBe("business:manage");
    expect(requiredPermissionForAction("code.protected_branches.update")).toBe("business:manage");
    expect(requiredPermissionForAction("code.membership.invite")).toBe("business:manage");
    expect(requiredPermissionForAction("code.deploy.production")).toBe("code.prod.operate");
    expect(requiredPermissionForAction("code.prod.operate")).toBe("code.prod.operate");
    // A privileged permission may also be the action it authorizes: that identity is explicit, not implicit.
    expect(requiredPermissionForAction("code.policy.manage")).toBe("code.policy.manage");
    expect(requiredPermissionForAction("code.git.protected_write")).toBe("code.git.protected_write");
    // Anything unmapped resolves to nothing (deny by default), never to the caller's label — including a
    // hard-denied action, which the `neverGranted` check refuses before this map is even consulted.
    expect(requiredPermissionForAction("code.future.tool")).toBeNull();
    expect(requiredPermissionForAction("code.hard_deny")).toBeNull();
    expect(requiredPermissionForAction("")).toBeNull();
    expect(requiredPermissionForAction(undefined)).toBeNull();
    expect(requiredPermissionForAction("   ")).toBeNull();
    // The map never invents a permission outside the shared vocabulary, so a typo cannot widen the gate.
    const vocabulary = new Set<string>([...CODE_RBAC_PERMISSIONS, ...CODE_PRIVILEGED_PERMISSIONS, "automation:execute_browser"]);
    for (const [action, permission] of Object.entries(CODE_ACTION_PERMISSIONS)) {
      expect(vocabulary.has(permission), `${action} maps to an unknown permission ${permission}`).toBe(true);
    }
  });
});

describe("security-gate: C5a RBAC foundation — the suite is part of SG-1", () => {
  it("is registered in the gate list, and every configured suite file exists", async () => {
    const { SECURITY_GATE_TESTS, findMissingSuiteFiles } = await import("../scripts/run-security-gate.mjs");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    // SG-1 runs a fixed list, so a suite that is green but unlisted protects nothing: this one and its
    // C5a siblings must all be on it.
    for (const suite of [
      "tests/coding-agent-c5a-rbac-foundation.test.ts",
      "tests/coding-agent-c5a-rbac.test.ts",
      "tests/coding-agent-c5a-membership.test.ts",
      "tests/coding-agent-c5a-role-escalation.test.ts",
      "tests/coding-agent-c5a-prod-operations.test.ts",
      "tests/coding-agent-c5a-automations-identity.test.ts",
      "tests/coding-agent-c5a-protected-branches.test.ts",
    ]) {
      expect(SECURITY_GATE_TESTS).toContain(suite);
    }
    expect(new Set(SECURITY_GATE_TESTS).size).toBe(SECURITY_GATE_TESTS.length);
    // A configured-but-absent suite fails the gate before vitest starts, so the list is a contract and
    // also the reason the start-up line reads `present=N missing=0`.
    expect(findMissingSuiteFiles(root, SECURITY_GATE_TESTS)).toEqual([]);
  });
});
