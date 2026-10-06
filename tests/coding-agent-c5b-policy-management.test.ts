import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  ProviderDataPolicyService,
  resolveEffectivePolicy,
  type ProviderDataPolicyAuditPort,
} from "../apps/agent-api/src/provider-data-policy";
import { ProviderDataPolicyAdminService } from "../apps/agent-api/src/provider-data-policy-service";
import { registerCodeDataPolicyRoutes } from "../apps/agent-api/src/code-data-policy-routes";

/**
 * C5b security-gate (SG-3): the management layer, end to end.
 *
 * What is pinned here is the part a unit test of `provider-data-policy.ts` cannot show:
 *  - a policy change bumps the version, appends a snapshot and is journalled **before** it is applied;
 *  - without the journal nothing is applied at all (fail closed);
 *  - one company's policy, classification and consent are invisible and unwritable from another;
 *  - lowering a project's classification takes the owner-level action while raising it does not;
 *  - an escaping path rule is refused and leaves the stored policy untouched;
 *  - the eligibility answer comes from the policy module itself, so a restricted project is reported
 *    ineligible for a hosted public-only provider and eligible for a local one;
 *  - the routes answer `apiVersion` on success and on failure, and a caller without a role is refused.
 */

const COMPANY = "company-a";
const OTHER_COMPANY = "company-b";
const PROJECT = "project-1";
const PROVIDER = "openai";
const OWNER = "user-owner";

function context(userId: string, permissions: string[] = []): AuthContext {
  return { workspaceId: "workspace-a", userId, permissions } as AuthContext;
}

interface Harness {
  store: InMemoryWorkspaceStore;
  service: ProviderDataPolicyAdminService;
  policyAudit: { action: string }[];
  rbacAudit: { action: string }[];
  activity: { action: string; changes: string[]; policyVersion: number | null; decision: string }[];
}

function makeHarness(
  roles: Record<string, string | null> = { [OWNER]: "owner" },
  withJournal = true,
  projectRecordClassification: "public" | "internal" | "confidential" | "restricted" | null = null,
): Harness {
  const store = new InMemoryWorkspaceStore();
  const policyAudit: { action: string }[] = [];
  const rbacAudit: { action: string }[] = [];
  const activity: Harness["activity"] = [];
  const auditPort: ProviderDataPolicyAuditPort | undefined = withJournal
    ? { record: async (input) => { policyAudit.push({ action: input.action }); } }
    : undefined;
  const policies = new ProviderDataPolicyService({
    store,
    ...(auditPort ? { audit: auditPort } : {}),
  });
  const service = new ProviderDataPolicyAdminService({
    store,
    policies,
    resolveRole: async (ctx, companyId) => (companyId === COMPANY ? roles[String(ctx.userId)] ?? null : null),
    // C1's own project classification, injected like `app.ts` injects the project store.
    ...(projectRecordClassification
      ? { projectClassification: { readProjectClassification: async () => projectRecordClassification } }
      : {}),
    rbac: withJournal
      ? { audit: { record: async (input) => { rbacAudit.push({ action: input.action }); } } }
      : {},
    activity: {
      record: (event) => {
        activity.push({ action: event.action, changes: event.changes, policyVersion: event.policyVersion, decision: event.decision });
      },
    },
  });
  return { store, service, policyAudit, rbacAudit, activity };
}

const hostedPolicy = {
  kind: "hosted_third_party" as const,
  maxDataClassification: "internal" as const,
  allowPrivateRepoCode: false,
  allowPromptCaching: false,
  externalRetention: "N_days:30",
  trainingPolicy: "no_training" as const,
  allowedContentTypes: ["metadata", "prompt", "code"] as const,
  lastReviewedAt: new Date("2026-01-01T00:00:00.000Z"),
  reviewedBy: "owner@example.com",
};

describe("security-gate: C5b policy management — versions, audit and isolation", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("bumps the version, snapshots it and journals before applying", async () => {
    const first = await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    expect(first.policy.policyVersion).toBe(1);
    const second = await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "confidential",
    });
    expect(second.policy.policyVersion).toBe(2);
    expect(harness.policyAudit.map((entry) => entry.action)).toEqual([
      "provider.data_policy.upsert",
      "provider.data_policy.upsert",
    ]);
    const versions = await harness.store.listProviderDataPolicyVersions(COMPANY, PROVIDER);
    expect(versions.map((version) => version.policyVersion)).toEqual([1, 2]);
    expect(versions[1]?.actor).toBe(OWNER);
    // The snapshot records what was in force at that version, not the latest state.
    expect((versions[1]?.payload as { maxDataClassification?: string }).maxDataClassification).toBe("confidential");
  });

  it("refuses a stale expected version instead of merging two writers", async () => {
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    await expect(harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      expectedPolicyVersion: 99,
    })).rejects.toThrowError(expect.objectContaining({ code: "data_policy_revision_conflict" }));
  });

  it("applies nothing when the journal is unavailable", async () => {
    const noJournal = makeHarness({ [OWNER]: "owner" }, false);
    await expect(noJournal.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable" }));
    expect(await noJournal.store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
    expect(await noJournal.store.listProviderDataPolicyVersions(COMPANY, PROVIDER)).toHaveLength(0);
  });

  it("keeps one company's policy, classification and consent away from another", async () => {
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "restricted" });
    await harness.service.grantHostedConsent(context(OWNER), COMPANY, PROJECT, PROVIDER);

    expect(await harness.store.listProviderDataPolicies(OTHER_COMPANY)).toHaveLength(0);
    expect(await harness.store.getProjectDataPolicy(OTHER_COMPANY, PROJECT)).toBeNull();
    expect(await harness.store.getHostedProviderConsent({
      companyId: OTHER_COMPANY, projectId: PROJECT, providerId: PROVIDER,
    })).toBeNull();
  });

  it("refuses a write in another company even for an owner of this one", async () => {
    await expect(harness.service.upsertProviderPolicy(context(OWNER), OTHER_COMPANY, PROVIDER, hostedPolicy))
      .rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
    expect(await harness.store.listProviderDataPolicies(OTHER_COMPANY)).toHaveLength(0);
  });

  it("defaults an unconfigured project to confidential and records the change in Activity", async () => {
    const before = await harness.service.getProjectPolicy(context(OWNER), COMPANY, PROJECT);
    expect(before.dataClassification).toBe("confidential");
    expect(before.configured).toBe(false);

    const raised = await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, {
      dataClassification: "restricted",
      pathRules: [{ pattern: "**/secrets/**", classification: "restricted" }],
    });
    expect(raised.policy.dataClassification).toBe("restricted");
    expect(raised.policy.effectiveClassification).toBe("restricted");
    expect(harness.activity.at(-1)).toEqual({
      action: "project.data_policy.upsert",
      changes: ["dataClassification", "pathRules"],
      policyVersion: 1,
      decision: "allow",
    });
  });

  it("takes the owner-level action to lower a classification and refuses an escaping path rule", async () => {
    await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "restricted" });
    const lowered = await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, {
      dataClassification: "public",
    });
    expect(lowered.policy.dataClassification).toBe("public");
    expect(harness.activity.at(-1)?.action).toBe("project.data_policy.lower_classification");

    await expect(harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, {
      pathRules: [{ pattern: "../outside/**", classification: "restricted" }],
    })).rejects.toThrowError(expect.objectContaining({ code: "invalid_policy_path_rule" }));
    // The refused rule did not reach the store: the stored version is unchanged.
    const stored = await harness.store.getProjectDataPolicy(COMPANY, PROJECT);
    expect(stored?.policyVersion).toBe(2);
  });

  it("refuses a policy that drops the mandatory redactions", async () => {
    await expect(harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      requiredRedactions: ["pii"],
    })).rejects.toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
    expect(await harness.store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
  });

  it("warns about an unreviewed or stale policy instead of trusting it", async () => {
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      lastReviewedAt: new Date("2025-01-01T00:00:00.000Z"),
      reviewedBy: null,
    });
    const { policies } = await harness.service.listProviderPolicies(context(OWNER), COMPANY);
    expect(policies[0]?.stale).toBe(true);
    expect(policies[0]?.warnings).toContain("never_reviewed_by_a_person");
  });

  it("records a change as field names only, never as values", async () => {
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "confidential",
      termsUrl: "https://provider.example.com/terms",
    });
    const event = harness.activity.at(-1)!;
    expect(event.changes).toEqual(["maxDataClassification", "termsUrl"]);
    for (const change of event.changes) {
      expect(change).not.toMatch(/[:=]/);
      expect(change).not.toContain("https://");
    }
  });

  it("reports eligibility from the policy module: restricted project vs hosted public-only provider", async () => {
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "public",
      allowedContentTypes: ["metadata"],
    });
    await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "restricted" });
    const report = await harness.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(report.dataClassification).toBe("restricted");
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.eligible).toBe(false);
    expect(report.entries[0]?.reasons.some((reason) => reason.startsWith("classification_exceeds_policy"))).toBe(true);
    // Code is not an allowed content type either, which the report names explicitly.
    expect(report.entries[0]?.reasons).toContain("content_type_not_allowed:code");
    expect(report.preferred).toBeNull();
  });

  it("reports a hosted provider as eligible once it is configured and consent is granted", async () => {
    // Code content is confidential by nature, so a policy that may receive code must allow at least
    // `confidential`; the eligibility answer comes from the policy module's own classification floors.
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "confidential",
    });
    await harness.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "confidential" });
    const before = await harness.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(before.entries[0]?.reasons).toContain("hosted_consent_required");
    expect(before.entries[0]?.dataClassification).toBe("confidential");

    await harness.service.grantHostedConsent(context(OWNER), COMPANY, PROJECT, PROVIDER);
    const after = await harness.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(after.entries[0]?.eligible).toBe(true);
    expect(after.preferred).toEqual({ providerId: PROVIDER, model: null });

    await harness.service.revokeHostedConsent(context(OWNER), COMPANY, PROJECT, PROVIDER);
    const revoked = await harness.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(revoked.entries[0]?.eligible).toBe(false);
  });

  it("takes the strictest of the C5b row and the project record, so neither can lower the other", async () => {
    // The project record (C1) says `restricted`; the C5b row is deliberately set to `public`. The
    // effective value must stay `restricted`, and a hosted provider limited to `public` must not receive
    // the code — a second source of truth may only ever *raise* the protection.
    const strict = makeHarness({ [OWNER]: "owner" }, true, "restricted");
    await strict.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "public",
    });
    await strict.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "public" });

    const view = await strict.service.getProjectPolicy(context(OWNER), COMPANY, PROJECT);
    expect(view.dataClassification).toBe("public");
    expect(view.projectRecordClassification).toBe("restricted");
    expect(view.effectiveClassification).toBe("restricted");
    expect(view.effectiveFromProjectRecord).toBe(true);

    const report = await strict.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(report.dataClassification).toBe("restricted");
    expect(report.entries[0]?.eligible).toBe(false);
    expect(report.entries[0]?.reasons.some((reason) => reason.startsWith("classification_exceeds_policy"))).toBe(true);

    // The same project with a policy that permits `restricted` becomes eligible, which shows the rule
    // narrows rather than blocks outright.
    await strict.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "restricted",
    });
    await strict.service.grantHostedConsent(context(OWNER), COMPANY, PROJECT, PROVIDER);
    const allowed = await strict.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(allowed.entries[0]?.eligible).toBe(true);
  });

  it("treats an unreadable project record as confidential rather than as no constraint", async () => {
    const harness = makeHarness();
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, {
      ...hostedPolicy,
      maxDataClassification: "public",
      allowedContentTypes: ["metadata"],
    });
    const report = await harness.service.getEligibility(context(OWNER), COMPANY, PROJECT);
    expect(report.dataClassification).toBe("confidential");
    expect(report.entries[0]?.eligible).toBe(false);
  });

  it("judges a lowering request against the effective classification, not just the stored row", async () => {
    const strict = makeHarness({ [OWNER]: "owner" }, true, "restricted");
    await strict.service.upsertProjectPolicy(context(OWNER), COMPANY, PROJECT, { dataClassification: "public" });
    // `public` is below the project record's `restricted`, so this is a lowering request: it must take the
    // owner-level action — and the owner is the only role that holds `code.policy.manage`.
    expect(strict.activity.at(-1)?.action).toBe("project.data_policy.lower_classification");
    const stored = await strict.store.getProjectDataPolicy(COMPANY, PROJECT);
    expect(stored?.dataClassification).toBe("public");
    // The protection itself did not drop: the effective value is still the project record's.
    const view = await strict.service.getProjectPolicy(context(OWNER), COMPANY, PROJECT);
    expect(view.effectiveClassification).toBe("restricted");
  });

  it("keeps the eligibility answer aligned with the resolver it claims to use", async () => {
    const policy = await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    const stored = await harness.store.getProviderDataPolicy({ companyId: COMPANY, providerId: PROVIDER, modelPattern: null });
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      companyPolicies: stored ? [stored] : [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(resolved.policy.maxDataClassification).toBe(policy.policy.maxDataClassification);
    expect(resolved.source).toBe("provider");
  });
});

describe("security-gate: C5b policy management — routes", () => {
  interface Route {
    method: string;
    url: string;
    handler: (request: unknown, reply: unknown) => Promise<unknown>;
  }

  function fakeInstance(routes: Route[]): FastifyInstance {
    return {
      get: (url: string, handler: Route["handler"]) => routes.push({ method: "get", url, handler }),
      put: (url: string, handler: Route["handler"]) => routes.push({ method: "put", url, handler }),
      post: (url: string, handler: Route["handler"]) => routes.push({ method: "post", url, handler }),
      delete: (url: string, handler: Route["handler"]) => routes.push({ method: "delete", url, handler }),
    } as unknown as FastifyInstance;
  }

  function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
    const state = { status: 200, body: undefined as unknown };
    const reply = {
      code(status: number) {
        state.status = status;
        return reply;
      },
      send(payload: unknown) {
        state.body = payload;
        return payload;
      },
    };
    return { reply, state };
  }

  async function callRoute(
    service: ProviderDataPolicyAdminService,
    contextOrNull: AuthContext | null,
    input: { method: string; url: string; params: Record<string, string>; body?: unknown; query?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    // A fresh instance per call: a shared route list would keep calling the first service it captured.
    const routes: Route[] = [];
    await registerCodeDataPolicyRoutes(fakeInstance(routes), {
      service,
      getAuthContext: () => contextOrNull,
    });
    const route = routes.find((entry) => entry.method === input.method && entry.url === input.url);
    if (!route) throw new Error(`route not registered: ${input.method} ${input.url}`);
    const { reply, state } = fakeReply();
    await route.handler({ params: input.params, body: input.body, query: input.query ?? {} }, reply);
    return { status: state.status, body: state.body };
  }

  it("answers apiVersion and the policy list for an owner", async () => {
    const harness = makeHarness();
    const result = await callRoute(harness.service, context(OWNER), {
      method: "get",
      url: "/companies/:companyId/code/data-policy/providers",
      params: { companyId: COMPANY },
    });
    expect(result.status).toBe(200);
    expect((result.body as { apiVersion?: string }).apiVersion).toBeTruthy();
    expect((result.body as { policies: unknown[] }).policies).toEqual([]);
  });

  it("refuses an unauthenticated caller with 401 and apiVersion", async () => {
    const harness = makeHarness();
    const result = await callRoute(harness.service, null, {
      method: "get",
      url: "/companies/:companyId/code/data-policy/providers",
      params: { companyId: COMPANY },
    });
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe("unauthorized");
    expect((result.body as { apiVersion?: string }).apiVersion).toBeTruthy();
  });

  it("persists a provider policy through PUT and reports the authority used", async () => {
    const harness = makeHarness();
    const result = await callRoute(harness.service, context(OWNER), {
      method: "put",
      url: "/companies/:companyId/code/data-policy/providers/:providerId",
      params: { companyId: COMPANY, providerId: PROVIDER },
      body: {
        kind: "hosted_third_party",
        maxDataClassification: "internal",
        allowPrivateRepoCode: false,
        allowPromptCaching: false,
        externalRetention: "N_days:30",
        trainingPolicy: "no_training",
        allowedContentTypes: ["metadata", "prompt", "code"],
      },
    });
    expect(result.status).toBe(200);
    const body = result.body as { policy: { policyVersion: number; maxDataClassification: string } };
    expect(body.policy.policyVersion).toBe(1);
    expect(body.policy.maxDataClassification).toBe("internal");
  });

  it("refuses an invalid retention with 400 and leaves the store empty", async () => {
    const harness = makeHarness();
    const result = await callRoute(harness.service, context(OWNER), {
      method: "put",
      url: "/companies/:companyId/code/data-policy/providers/:providerId",
      params: { companyId: COMPANY, providerId: PROVIDER },
      body: { externalRetention: "forever" },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("invalid_retention");
    expect(await harness.store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
  });

  it("refuses an escaping path rule with 400 and leaves the stored policy untouched", async () => {
    const harness = makeHarness();
    const result = await callRoute(harness.service, context(OWNER), {
      method: "put",
      url: "/companies/:companyId/code/data-policy/projects/:projectId",
      params: { companyId: COMPANY, projectId: PROJECT },
      body: { pathRules: [{ pattern: "/etc/passwd", classification: "restricted" }] },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("invalid_policy_path_rule");
    expect(await harness.store.getProjectDataPolicy(COMPANY, PROJECT)).toBeNull();
  });

  it("answers the eligibility report with apiVersion", async () => {
    const harness = makeHarness();
    await harness.service.upsertProviderPolicy(context(OWNER), COMPANY, PROVIDER, hostedPolicy);
    const result = await callRoute(harness.service, context(OWNER), {
      method: "get",
      url: "/companies/:companyId/code/data-policy/projects/:projectId/eligibility",
      params: { companyId: COMPANY, projectId: PROJECT },
      query: { contentTypes: "code" },
    });
    expect(result.status).toBe(200);
    const body = result.body as { entries: { eligible: boolean; reasons: string[] }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.eligible).toBe(false);
  });

  it("refuses a caller without a company role on the read routes as well", async () => {
    const harness = makeHarness({ [OWNER]: null });
    const result = await callRoute(harness.service, context(OWNER), {
      method: "get",
      url: "/companies/:companyId/code/data-policy/providers",
      params: { companyId: COMPANY },
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe("permission_denied");
  });
});
