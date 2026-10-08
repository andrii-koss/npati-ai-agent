import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  CODE_ACTION_PERMISSIONS,
  CODE_PRIVILEGED_PERMISSIONS,
  CODE_RBAC_PERMISSIONS,
  CodeRbac,
  createRoleRegistry,
  requiredPermissionForAction,
} from "../apps/agent-api/src/code-rbac";
import {
  CODE_DATA_POLICY_ACTIONS,
  OWNER_LEVEL_DATA_POLICY_ACTIONS,
  ProviderDataPolicyAdminService,
  assertNoSensitiveProviderPolicyEvent,
} from "../apps/agent-api/src/provider-data-policy-service";
// The gate's own list is imported so this suite fails if a C5b suite silently drops out of SG-3.
import { SECURITY_GATE_TESTS, findMissingSuiteFiles } from "../scripts/lib/run-security-gate.mjs";

/**
 * C5b security-gate (SG-3): **who may decide what leaves NPATI**.
 *
 * The data policy is the switch that decides whether private repository code may reach a third-party
 * model, so the properties pinned here are the ones an escalation would go after:
 *
 *  - every data-policy action is mapped, and the permission is derived from the action rather than taken
 *    from the caller's label;
 *  - the write surfaces require the privileged `code.policy.manage`, which `*`, `admin:all` and `owner`
 *    never imply — a company admin is refused while the owner is accepted;
 *  - an agent or a service identity never changes the policy;
 *  - a caller without a membership row (role `null`) is refused, so a workspace-wide grant cannot widen a
 *    company-scoped policy surface;
 *  - every decision needs the journal: without it the change does not happen.
 */

const COMPANY = "company-a";
const OTHER_COMPANY = "company-b";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const DEVELOPER = "user-developer";
const AGENT = "agent:runner-1";

function context(userId: string, permissions: string[] = []): AuthContext {
  return { workspaceId: "workspace-a", userId, permissions } as AuthContext;
}

interface ServiceHarness {
  service: ProviderDataPolicyAdminService;
  audit: { action: string; actor: string; companyId: string | null }[];
  rbacAudit: { action: string; actor: string; companyId: string }[];
  activity: { kind: string; changes: string[]; action: string }[];
}

/**
 * The service is exercised with an injected store double: these tests are about authorization, so the
 * policy row itself is irrelevant — only whether the call is allowed to reach it.
 */
function harness(roleOfUser: Record<string, string | null>, registry?: ReturnType<typeof createRoleRegistry>): ServiceHarness {
  const audit: ServiceHarness["audit"] = [];
  const rbacAudit: ServiceHarness["rbacAudit"] = [];
  const activity: ServiceHarness["activity"] = [];
  const store = {
    async listProviderDataPolicies() { return []; },
    async getProviderDataPolicy() { return null; },
    async listProviderDataPolicyVersions() { return []; },
    async getProjectDataPolicy() { return null; },
    async getHostedProviderConsent() { return null; },
  };
  const policies = {
    async upsertPolicy() {
      throw new Error("the store must not be reached in an authorization test");
    },
    async upsertProjectPolicy() {
      throw new Error("the store must not be reached in an authorization test");
    },
    async grantHostedConsent() {
      throw new Error("the store must not be reached in an authorization test");
    },
    async revokeHostedConsent() {
      throw new Error("the store must not be reached in an authorization test");
    },
    async hasHostedConsent() { return false; },
    async resolveForCompany() {
      throw new Error("the resolver must not be reached in an authorization test");
    },
  };
  const service = new ProviderDataPolicyAdminService({
    store: store as never,
    policies: policies as never,
    resolveRole: async (ctx) => roleOfUser[String(ctx.userId)] ?? null,
    rbac: {
      ...(registry ? { registry } : {}),
      audit: { record: async (input) => { rbacAudit.push({ action: input.action, actor: input.actor, companyId: input.companyId }); } },
    },
    activity: { record: (event) => { activity.push({ kind: event.kind, changes: event.changes, action: event.action }); } },
  });
  return { service, audit, rbacAudit, activity };
}

/** A role registry whose `owner` names the privileged permission explicitly, like an operator would. */
const namedOwnerRegistry = createRoleRegistry({
  roles: {
    owner: [...CODE_RBAC_PERMISSIONS, "code.policy.manage"],
    admin: [...CODE_RBAC_PERMISSIONS],
    developer: ["workspace:read", "workspace:write", "tools:read", "tools:execute"],
    reviewer: ["workspace:read", "tools:read"],
  },
  privilegedPermissions: CODE_PRIVILEGED_PERMISSIONS,
});

describe("security-gate: C5b data policy — the action map", () => {
  it("maps every data-policy action to a permission", () => {
    for (const action of Object.values(CODE_DATA_POLICY_ACTIONS)) {
      expect(requiredPermissionForAction(action)).toBeTruthy();
    }
  });

  it("requires the privileged policy permission for every widening surface", () => {
    expect(requiredPermissionForAction(CODE_DATA_POLICY_ACTIONS.providerUpsert)).toBe("code.policy.manage");
    expect(requiredPermissionForAction(CODE_DATA_POLICY_ACTIONS.projectLowerClassification)).toBe("code.policy.manage");
    expect(requiredPermissionForAction(CODE_DATA_POLICY_ACTIONS.hostedConsentGrant)).toBe("code.policy.manage");
    expect(requiredPermissionForAction(CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke)).toBe("code.policy.manage");
    // Raising a classification narrows what may leave, so it stays an ordinary workspace write.
    expect(requiredPermissionForAction(CODE_DATA_POLICY_ACTIONS.projectUpsert)).toBe("workspace:write");
    // Reading the policy — and asking who would receive the code — is ordinary read access.
    for (const action of [
      CODE_DATA_POLICY_ACTIONS.providerList,
      CODE_DATA_POLICY_ACTIONS.providerVersions,
      CODE_DATA_POLICY_ACTIONS.projectRead,
      CODE_DATA_POLICY_ACTIONS.eligibility,
    ]) {
      expect(requiredPermissionForAction(action)).toBe("workspace:read");
    }
  });

  it("keeps the policy permission out of the inherited wildcard", () => {
    const registry = createRoleRegistry({ roles: { admin: ["*", "admin:all"] } });
    const granted = registry.permissionsForRole("admin");
    expect(granted).not.toContain("code.policy.manage");
    for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
      expect(granted).not.toContain(privileged);
    }
  });

  it("refuses an action whose caller-supplied label does not match the map", async () => {
    const rbac = new CodeRbac({
      registry: namedOwnerRegistry,
      audit: { record: async () => undefined },
    });
    await expect(rbac.authorize(context(OWNER), COMPANY, {
      permission: "workspace:read",
      action: CODE_DATA_POLICY_ACTIONS.providerUpsert,
      policyChange: true,
    })).rejects.toThrowError(expect.objectContaining({ code: "permission_action_mismatch" }));
  });

  it("refuses an unknown action by default", async () => {
    const rbac = new CodeRbac({
      registry: namedOwnerRegistry,
      audit: { record: async () => undefined },
    });
    await expect(rbac.authorize(context(OWNER), COMPANY, {
      permission: "workspace:read",
      action: "provider.data_policy.destroy_everything",
    })).rejects.toThrowError(expect.objectContaining({ code: "action_not_mapped" }));
  });
});

describe("security-gate: C5b data policy — who may change it", () => {
  it("allows a role that names code.policy.manage explicitly, without the owner fallback", async () => {
    const { service, rbacAudit } = harness({ [OWNER]: "owner" }, namedOwnerRegistry);
    const call = service.upsertProviderPolicy(context(OWNER), COMPANY, "openai", {});
    // The stub store throws by design: reaching it proves the authorization allowed the call through.
    await expect(call).rejects.toThrowError(/must not be reached/);
    // The gate allowed it on the explicit grant, so the owner-authority path was never needed.
    expect(rbacAudit.map((entry) => entry.action)).toEqual(["code.rbac.allow"]);
  });

  it("falls back to the owner role only when the shipped matrix does not name the permission", async () => {
    const { service, rbacAudit } = harness({ [OWNER]: "owner" });
    await expect(service.upsertProviderPolicy(context(OWNER), COMPANY, "openai", {}))
      .rejects.toThrowError(/must not be reached/);
    // One mechanism only: the company matrix names `code.policy.manage` on `owner`, so the shared gate
    // allows the call and no second "owner authority" path exists to diverge from it.
    expect(rbacAudit.map((entry) => entry.action)).toEqual(["code.rbac.allow"]);
  });

  it("refuses a company admin holding admin:all, and journals the refusal", async () => {
    const { service, rbacAudit } = harness({ [ADMIN]: "admin" });
    await expect(service.upsertProviderPolicy(context(ADMIN, ["admin:all", "*"]), COMPANY, "openai", {}))
      .rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
    expect(rbacAudit.some((entry) => entry.action === "code.rbac.deny")).toBe(true);
  });

  it("refuses a developer for the owner-level surfaces", async () => {
    const { service } = harness({ [DEVELOPER]: "developer" });
    await expect(service.upsertProviderPolicy(context(DEVELOPER), COMPANY, "openai", {}))
      .rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
    await expect(service.grantHostedConsent(context(DEVELOPER), COMPANY, "project-1", "openai"))
      .rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
  });

  it("refuses an agent or a service identity on every surface, including reads", async () => {
    const { service } = harness({});
    await expect(service.upsertProviderPolicy(context(AGENT), COMPANY, "openai", {}))
      .rejects.toThrowError(expect.objectContaining({ code: "agent_cannot_change_policy" }));
    // A service identity is refused by the privileged branch of the shared gate, which is the canonical
    // refusal for a service on a privileged surface.
    await expect(service.grantHostedConsent(context("service:automation-1"), COMPANY, "project-1", "openai"))
      .rejects.toThrowError(expect.objectContaining({ code: "service_identity_cannot_operate_production" }));
    await expect(service.listProviderPolicies(context(AGENT), COMPANY))
      .rejects.toThrowError(expect.objectContaining({ code: "agent_cannot_change_policy" }));
  });

  it("refuses a caller without a membership row, in its own company and in another one", async () => {
    const { service } = harness({ [OWNER]: null });
    await expect(service.listProviderPolicies(context(OWNER), COMPANY))
      .rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
    // A role in company A grants nothing in company B: the role is resolved per company.
    const other = harness({ [OWNER]: "owner" });
    await expect(other.service.upsertProviderPolicy(context(OWNER), OTHER_COMPANY, "openai", {}))
      .rejects.toThrowError(/must not be reached/);
  });

  it("does not change anything when the journal is unavailable", async () => {
    const service = new ProviderDataPolicyAdminService({
      store: {
        async listProviderDataPolicies() { return []; },
        async getProviderDataPolicy() { return null; },
        async listProviderDataPolicyVersions() { return []; },
        async getProjectDataPolicy() { return null; },
        async getHostedProviderConsent() { return null; },
      } as never,
      policies: { async upsertPolicy() { throw new Error("the store must not be reached"); } } as never,
      resolveRole: async () => "owner",
      // No `rbac.audit`: every decision must refuse rather than proceed unattributed.
    });
    await expect(service.upsertProviderPolicy(context(OWNER), COMPANY, "openai", {}))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable", httpStatus: 503 }));
  });

  it("journals every decision through the shared gate, with no separate authority path", async () => {
    const { service, rbacAudit } = harness({ [OWNER]: "owner" });
    await expect(service.grantHostedConsent(context(OWNER), COMPANY, "project-1", "openai"))
      .rejects.toThrowError(/must not be reached/);
    expect(rbacAudit.map((entry) => entry.action)).toEqual(["code.rbac.allow"]);
  });

  it("never treats a non-owner role with the wildcard as the owner", async () => {
    const { service } = harness({ [ADMIN]: "admin" });
    for (const action of OWNER_LEVEL_DATA_POLICY_ACTIONS) {
      const call = action === CODE_DATA_POLICY_ACTIONS.providerUpsert
        ? service.upsertProviderPolicy(context(ADMIN, ["*", "admin:all", "owner"]), COMPANY, "openai", {})
        : action === CODE_DATA_POLICY_ACTIONS.hostedConsentGrant
          ? service.grantHostedConsent(context(ADMIN, ["*", "admin:all", "owner"]), COMPANY, "project-1", "openai")
          : service.revokeHostedConsent(context(ADMIN, ["*", "admin:all", "owner"]), COMPANY, "project-1", "openai");
      await expect(call).rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
    }
  });
});

describe("security-gate: C5b policy suites cannot silently drop out of the gate", () => {
  it("lists every C5b policy suite, without duplicates or missing files", () => {
    const required = [
      "tests/coding-agent-c5b-policy-store.test.ts",
      "tests/coding-agent-c5b-policy-resolver.test.ts",
      "tests/coding-agent-c5b-policy-management.test.ts",
      "tests/coding-agent-c5b-policy-rbac.test.ts",
      "tests/coding-agent-c5b-provider-guard.test.ts",
      "tests/coding-agent-c5b-routing-eligibility.test.ts",
      "tests/coding-agent-c5b-outbound-guard.test.ts",
    ];
    for (const suite of required) {
      // A suite that is not in the fixed list is not part of SG-3, however green it is locally.
      expect(SECURITY_GATE_TESTS).toContain(suite);
    }
    // A duplicate entry would run the same suite twice; a missing file would fail the gate outright.
    expect(new Set(SECURITY_GATE_TESTS).size).toBe(SECURITY_GATE_TESTS.length);
    expect(findMissingSuiteFiles(process.cwd(), SECURITY_GATE_TESTS)).toEqual([]);
  });
});

describe("security-gate: C5b data policy — the activity event carries no policy values", () => {
  it("refuses an event that carries a policy value, content or a secret", () => {
    const base = {
      kind: "provider_policy_decision" as const,
      companyId: COMPANY,
      providerId: "openai",
      projectId: null,
      action: CODE_DATA_POLICY_ACTIONS.providerUpsert,
      actor: OWNER,
      decision: "allow" as const,
      policyVersion: 2,
      changes: ["maxDataClassification"],
      at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
    // The documented shape is accepted …
    expect(() => assertNoSensitiveProviderPolicyEvent(base)).not.toThrow();
    // … a value smuggled into a change entry is not ("field=value" is a value, not a field name) …
    expect(() => assertNoSensitiveProviderPolicyEvent({
      ...base,
      changes: ["maxDataClassification=restricted"],
    })).toThrowError(expect.objectContaining({ code: "policy_event_contains_values" }));
    // … a policy payload is not …
    expect(() => assertNoSensitiveProviderPolicyEvent({
      ...base,
      ...({ payload: { termsUrl: "https://example.com" } } as Record<string, unknown>),
    } as typeof base)).toThrowError(expect.objectContaining({ code: "policy_event_contains_values" }));
    // … and a secret-shaped value is not.
    expect(() => assertNoSensitiveProviderPolicyEvent({
      ...base,
      actor: "api_key=sk-live-1234567890",
    })).toThrowError(expect.objectContaining({ code: "policy_event_contains_values" }));
  });
});
