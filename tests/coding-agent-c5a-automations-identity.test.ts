import { describe, expect, it } from "vitest";
import { CodeRbac, classifyPrincipal } from "../apps/agent-api/src/code-rbac";
import {
  AUTOMATION_ALLOWED_PERMISSION_DEFAULTS,
  AUTOMATION_PERMISSION_INVENTORY,
  SERVICE_IDENTITY_ROLE_CEILING,
  assertAutomationPermissionAllowed,
  resolveAutomationAllowedPermissions,
  serviceIdentityForAutomation,
  summarizeServiceIdentity,
} from "../apps/agent-api/src/code-service-identity";
import { CodeProductionOperations, NullProductionExecutor } from "../apps/agent-api/src/code-prod-operations";
import { CodeStepUp } from "../apps/agent-api/src/code-step-up";

/**
 * C5a security-gate: unattended automations run as a service identity limited to the reviewed inventory.
 *
 * The owner's decision was "inventory first, then narrow" — so these tests also assert that every
 * permission the automation call sites actually use is still granted (nothing was narrowed away by
 * accident), while production, privileged permissions and wildcards remain unreachable.
 */

const ownerUserId = "u-owner";
const base = { companyId: "company-1", workspaceId: "ws-1", ownerUserId, automationId: "automation-1" };

describe("security-gate: C5a automation service identity is narrow, inventoried and never production", () => {
  it("is the reviewed inventory: every permission a call site needs is still granted", () => {
    const identity = serviceIdentityForAutomation(base);
    expect(AUTOMATION_PERMISSION_INVENTORY.length).toBeGreaterThan(3);
    for (const binding of AUTOMATION_PERMISSION_INVENTORY) {
      expect(binding.purpose.length).toBeGreaterThan(10);
      expect(binding.location).toMatch(/\.ts:\d+|\.ts \(/);
      expect(identity.permissions).toContain(binding.permission);
    }
    expect(identity.permissions).toEqual([...AUTOMATION_ALLOWED_PERMISSION_DEFAULTS].sort());
    // The permissions the previous fixed context granted, minus production-shaped ones.
    expect(identity.permissions).toContain("automation:execute_browser");
    expect(identity.permissions).toContain("workspace:read");
    expect(identity.permissions).toContain("workspace:write");
    expect(identity.permissions).not.toContain("code.prod.operate");
    expect(identity.permissions).not.toContain("*");
    expect(identity.permissions).not.toContain("admin:all");
  });

  it("is classified as a service principal, so the C5a service invariants apply to it", () => {
    const identity = serviceIdentityForAutomation(base);
    expect(identity.principalId).toBe("service:automation:automation-1");
    expect(classifyPrincipal(identity.auth)).toBe("service");
    expect(summarizeServiceIdentity(identity)).toMatchObject({ isService: true, productionReachable: false });
  });

  it("keeps the owner id for tenancy (NPATI resolves companies by user_id) without granting extra rights", () => {
    const identity = serviceIdentityForAutomation(base);
    // `WorkspaceStore.assertCompany` resolves a company as workspace_id + user_id, so this must stay the
    // owner's id; the principal travels in externalSubject.
    expect(identity.auth.userId).toBe(ownerUserId);
    expect(identity.auth.externalSubject).toBe(identity.principalId);
    expect(identity.ownerUserId).toBe(ownerUserId);
  });

  it("caps the role at the documented ceiling", () => {
    expect(SERVICE_IDENTITY_ROLE_CEILING).toBe("developer");
    const service = serviceIdentityForAutomation(base);
    expect(service.role).toBe("service");
    expect(service.roleDowngraded).toBe(false);
    for (const requestedRole of ["admin", "owner", "superuser"]) {
      const escalated = serviceIdentityForAutomation({ ...base, requestedRole });
      expect(escalated.role).toBe("service");
      expect(escalated.roleDowngraded).toBe(true);
    }
  });

  it("refuses a permission outside the allowlist instead of widening itself", () => {
    const identity = serviceIdentityForAutomation(base);
    expect(() => assertAutomationPermissionAllowed(identity, "automation:execute_browser")).not.toThrow();
    expect(() => assertAutomationPermissionAllowed(identity, "business:manage")).not.toThrow();
    expect(() => assertAutomationPermissionAllowed(identity, "code.prod.operate")).toThrowError(/automation_permission_not_allowed/);
    try {
      assertAutomationPermissionAllowed(identity, "email:send");
    } catch (error) {
      expect(error).toMatchObject({ code: "automation_permission_not_allowed", httpStatus: 403 });
    }
    // A requested permission that is not in the allowlist is reported, not granted.
    const narrowed = serviceIdentityForAutomation({ ...base, requestedPermissions: ["workspace:read", "email:send"] });
    expect(narrowed.permissions).toEqual(["workspace:read"]);
    expect(narrowed.rejected).toEqual([{ permission: "email:send", reason: "not_in_allowlist" }]);
  });

  it("lets configuration narrow the allowlist but never add production, privileged or wildcard rights", () => {
    const narrowed = resolveAutomationAllowedPermissions({ NPATI_CODE_AUTOMATION_ALLOWED_PERMISSIONS: "workspace:read,workspace:write" });
    expect(narrowed.allowed).toEqual(["workspace:read", "workspace:write"]);
    expect(narrowed.source).toBe("configuration+inventory");

    const hostile = resolveAutomationAllowedPermissions({
      NPATI_CODE_AUTOMATION_ALLOWED_PERMISSIONS: "workspace:read,code.prod.operate,code.policy.manage,*,owner,deploy.release",
    });
    expect(hostile.allowed).toEqual(["workspace:read"]);
    expect(hostile.rejected.map((item) => item.permission).sort()).toEqual(["*", "code.policy.manage", "code.prod.operate", "deploy.release", "owner"]);
    for (const reason of hostile.rejected.map((item) => item.reason)) {
      expect(["privileged_permission_not_allowed_for_service_identity", "production_not_allowed_for_service_identity", "wildcard_not_allowed_for_service_identity"]).toContain(reason);
    }

    const identity = serviceIdentityForAutomation({ ...base, allowedPermissions: hostile.allowed, requestedPermissions: ["workspace:read", "code.prod.operate"] });
    expect(identity.permissions).toEqual(["workspace:read"]);
    expect(identity.rejected).toContainEqual({ permission: "code.prod.operate", reason: "not_in_allowlist" });
  });

  it("cannot approve anything and cannot operate production", async () => {
    const identity = serviceIdentityForAutomation(base);
    const auditEntries: unknown[] = [];
    const auditPort = { record: async (input: unknown) => { auditEntries.push(input); } };

    const rbac = new CodeRbac({ audit: auditPort as never });
    await expect(
      rbac.authorize(identity.auth, "company-1", { permission: "workspace:write", action: "approve", approvalClaim: true }),
    ).rejects.toMatchObject({ code: "service_cannot_approve" });
    await expect(
      rbac.authorize(identity.auth, "company-1", { permission: "code.prod.operate", action: "code.prod.operate", production: true }),
    ).rejects.toMatchObject({ code: "service_identity_cannot_operate_production" });

    const operations = new CodeProductionOperations({
      rbac: new CodeRbac({ audit: auditPort as never }),
      stepUp: new CodeStepUp({ audit: auditPort as never, config: { twoPerson: false, cooldownMs: 0, ttlMs: 300_000 } }),
      executor: new NullProductionExecutor(),
      audit: auditPort as never,
    });
    await expect(
      operations.assertProductionOperationAllowed(identity.auth, "company-1", { operation: "deploy.release", payload: {} }),
    ).rejects.toMatchObject({ code: "service_identity_cannot_operate_production", httpStatus: 403 });
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("keeps ordinary work allowed, so narrowing did not break existing automations", async () => {
    const identity = serviceIdentityForAutomation(base);
    const rbac = new CodeRbac({ audit: { record: async () => undefined } });
    const allowed = await rbac.authorize(identity.auth, "company-1", { permission: "workspace:read", action: "company.run" });
    expect(allowed).toMatchObject({ allowed: true, principal: "service" });
    const browser = await rbac.authorize(identity.auth, "company-1", { permission: "automation:execute_browser", action: "browser.campaign" });
    expect(browser.allowed).toBe(true);
  });
});
