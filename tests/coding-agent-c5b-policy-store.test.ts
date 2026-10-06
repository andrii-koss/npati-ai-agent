import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  FAIL_CLOSED_HOSTED_POLICY,
  MANDATORY_REDACTIONS,
  POLICY_REVIEW_MAX_AGE_DAYS,
  PROVIDER_REDACTION_KINDS,
  ProviderDataPolicyError,
  ProviderDataPolicyService,
  classifyContent,
  isPolicyStale,
  modelPatternMatches,
  parseExternalRetention,
  pathMatchesRule,
  policyAllowsClassification,
  policyAllowsContentType,
  policyStalenessReason,
  resolveEffectivePolicy,
  validatePathRule,
  validateProviderDataPolicyInput,
  type ProviderDataPolicyRecord,
  type ProviderDataPolicyAuditPort,
  type UpsertProviderDataPolicyInput,
} from "../apps/agent-api/src/provider-data-policy";

const COMPANY = "cmp_a";
const OTHER_COMPANY = "cmp_b";
const PROVIDER = "provider_hosted";
const ACTOR = "user_owner";

/** Recording journal: the tests assert both the calls and, on failure, that nothing was written. */
function makeAudit(options: { fail?: boolean } = {}) {
  const entries: Array<Record<string, unknown>> = [];
  const port: ProviderDataPolicyAuditPort = {
    async record(input) {
      if (options.fail) throw new Error("journal offline");
      entries.push(input as unknown as Record<string, unknown>);
    },
  };
  return { port, entries };
}

function policyInput(overrides: Partial<UpsertProviderDataPolicyInput> = {}): UpsertProviderDataPolicyInput {
  return {
    companyId: COMPANY,
    providerId: PROVIDER,
    modelPattern: null,
    actor: ACTOR,
    kind: "hosted_third_party",
    allowPrivateRepoCode: false,
    maxDataClassification: "public",
    allowPromptCaching: false,
    externalRetention: "unknown",
    trainingPolicy: "unknown",
    requiredRedactions: [...PROVIDER_REDACTION_KINDS],
    allowedContentTypes: ["metadata"],
    lastReviewedAt: new Date(),
    reviewedBy: ACTOR,
    expectedPolicyVersion: null,
    ...overrides,
  };
}

describe("security-gate: C5b provider data policy — unknown providers fail closed", () => {
  it("gives an unknown hosted provider public-only data, no private code, no caching and no sensitive content", () => {
    const resolved = resolveEffectivePolicy({ providerId: "brand_new_provider" });
    expect(resolved.source).toBe("fail_closed");
    expect(resolved.matchedPolicyId).toBeNull();
    expect(resolved.policy.kind).toBe("hosted_third_party");
    expect(resolved.policy.maxDataClassification).toBe("public");
    expect(resolved.policy.allowPrivateRepoCode).toBe(false);
    expect(resolved.policy.allowPromptCaching).toBe(false);
    expect(resolved.policy.trainingPolicy).toBe("unknown");
    expect(resolved.policy.externalRetention).toBe("unknown");
    // Every redaction kind is required — an unknown provider gets the strictest treatment, not the loosest.
    for (const kind of PROVIDER_REDACTION_KINDS) {
      expect(resolved.policy.requiredRedactions).toContain(kind);
    }
    // The sensitive content types are absent: an unconfigured provider may receive metadata only.
    for (const contentType of ["code", "diff", "files", "logs", "terminal", "web"] as const) {
      expect(resolved.policy.allowedContentTypes).not.toContain(contentType);
      expect(policyAllowsContentType(resolved.policy, contentType)).toBe(false);
    }
    expect(policyAllowsContentType(resolved.policy, "metadata")).toBe(true);
    // An unconfigured provider has never been reviewed, so it is stale by definition.
    expect(resolved.stale).toBe(true);
    expect(resolved.staleReason).toBe("no_policy_for_provider");
  });

  it("treats a provider of unknown kind as hosted, never as self-hosted", () => {
    // Passing no kind at all must not fall back to the permissive self-hosted floor.
    const resolved = resolveEffectivePolicy({ providerId: "mystery", providerKind: null });
    expect(resolved.policy.kind).toBe("hosted_third_party");
    expect(resolved.policy.maxDataClassification).toBe(FAIL_CLOSED_HOSTED_POLICY.maxDataClassification);
    expect(resolved.policy.allowPrivateRepoCode).toBe(false);
    // A recognised self-hosted provider gets a higher ceiling, but never without mandatory redaction.
    const selfHosted = resolveEffectivePolicy({ providerId: "mystery", providerKind: "self_hosted" });
    expect(selfHosted.policy.maxDataClassification).toBe("restricted");
    for (const kind of MANDATORY_REDACTIONS) {
      expect(selfHosted.policy.requiredRedactions).toContain(kind);
    }
  });

  it("never lets an absent policy field mean 'allowed'", () => {
    // `undefined` in the input objects cannot produce an allow: the resolver works on stored rows only, and
    // an unconfigured provider is the fail-closed default (asserted above). Here we pin the comparison
    // helpers, which are what the guard layer calls.
    expect(policyAllowsClassification({ maxDataClassification: "public" }, "internal")).toBe(false);
    expect(policyAllowsClassification({ maxDataClassification: "public" }, "restricted")).toBe(false);
    expect(policyAllowsContentType({ allowedContentTypes: [] }, "metadata")).toBe(false);
    expect(policyAllowsContentType({ allowedContentTypes: ["metadata"] }, "code")).toBe(false);
  });
});

describe("security-gate: C5b provider data policy — resolution priority", () => {
  const base = (overrides: Partial<ProviderDataPolicyRecord>): ProviderDataPolicyRecord => ({
    id: "pdp_x",
    companyId: COMPANY,
    providerId: PROVIDER,
    modelPattern: null,
    policyVersion: 1,
    kind: "hosted_third_party",
    allowPrivateRepoCode: false,
    maxDataClassification: "internal",
    allowPromptCaching: false,
    externalRetention: "none",
    trainingPolicy: "no_training",
    region: null,
    jurisdiction: null,
    requiredRedactions: [...MANDATORY_REDACTIONS],
    allowedContentTypes: ["metadata", "prompt"],
    termsUrl: null,
    lastReviewedAt: new Date(),
    reviewedBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it("prefers a model-specific policy over a provider-wide one", () => {
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      model: "gpt-x",
      companyPolicies: [
        base({ id: "provider_wide", modelPattern: null, maxDataClassification: "internal" }),
        base({ id: "model_specific", modelPattern: "gpt-*", maxDataClassification: "restricted" }),
      ],
    });
    expect(resolved.source).toBe("model");
    expect(resolved.matchedPolicyId).toBe("model_specific");
    expect(resolved.policy.maxDataClassification).toBe("restricted");
  });

  it("prefers a company policy over a platform default", () => {
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      companyPolicies: [base({ id: "company_row", maxDataClassification: "confidential" })],
      platformDefaults: [base({ id: "platform_row", companyId: null, maxDataClassification: "public" })],
    });
    expect(resolved.source).toBe("provider");
    expect(resolved.matchedPolicyId).toBe("company_row");
  });

  it("falls back to the platform default when the company has no policy of its own", () => {
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      companyPolicies: [],
      platformDefaults: [base({ id: "platform_row", companyId: null, maxDataClassification: "internal" })],
    });
    expect(resolved.source).toBe("platform");
    expect(resolved.matchedPolicyId).toBe("platform_row");
    expect(resolved.policy.maxDataClassification).toBe("internal");
  });

  it("falls back to the hard fail-closed default when nothing matches", () => {
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      companyPolicies: [base({ id: "other_provider", providerId: "someone_else" })],
      platformDefaults: [],
    });
    expect(resolved.source).toBe("fail_closed");
    expect(resolved.policy.maxDataClassification).toBe("public");
    expect(resolved.policy.allowPrivateRepoCode).toBe(false);
  });

  it("keeps the mandatory redactions even when a stored policy omits them", () => {
    const resolved = resolveEffectivePolicy({
      providerId: PROVIDER,
      companyPolicies: [base({ id: "stripped", requiredRedactions: [] })],
    });
    for (const kind of MANDATORY_REDACTIONS) {
      expect(resolved.policy.requiredRedactions).toContain(kind);
    }
  });

  it("matches model patterns literally and never lets a pattern escape", () => {
    expect(modelPatternMatches(null, "anything")).toBe(true);
    expect(modelPatternMatches("gpt-*", "gpt-4")).toBe(true);
    expect(modelPatternMatches("gpt-*", "claude-3")).toBe(false);
    expect(modelPatternMatches("gpt-4", "gpt-4")).toBe(true);
    // A pattern is anchored: it cannot match a longer, unrelated model id.
    expect(modelPatternMatches("gpt", "gpt-4")).toBe(false);
    expect(modelPatternMatches("gpt-*", null)).toBe(false);
  });
});

describe("security-gate: C5b provider data policy — staleness", () => {
  const reviewedAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  it("reports a policy that was never reviewed as stale", () => {
    expect(isPolicyStale({ lastReviewedAt: null })).toBe(true);
    expect(policyStalenessReason({ lastReviewedAt: null })).toBe("never_reviewed");
  });

  it("accepts a recent review and rejects one older than the maximum age", () => {
    expect(isPolicyStale({ lastReviewedAt: reviewedAgo(1) })).toBe(false);
    expect(isPolicyStale({ lastReviewedAt: reviewedAgo(POLICY_REVIEW_MAX_AGE_DAYS - 1) })).toBe(false);
    expect(isPolicyStale({ lastReviewedAt: reviewedAgo(POLICY_REVIEW_MAX_AGE_DAYS + 1) })).toBe(true);
    expect(policyStalenessReason({ lastReviewedAt: reviewedAgo(181) }))
      .toBe(`review_older_than_${POLICY_REVIEW_MAX_AGE_DAYS}_days`);
  });
});

describe("security-gate: C5b provider data policy — content classification", () => {
  it("classifies repository content as confidential even in a public project", () => {
    const result = classifyContent({
      contentTypes: ["code", "diff"],
      projectClassification: "public",
    });
    expect(result.classification).toBe("confidential");
  });

  it("defaults a project to confidential, never public", () => {
    expect(classifyContent({ contentTypes: ["prompt"] }).classification).toBe("confidential");
  });

  it("lets a path rule raise the classification and records which rule did", () => {
    const result = classifyContent({
      contentTypes: ["files"],
      paths: ["src/secrets/token.txt"],
      pathRules: [
        { pattern: "**/secrets/**", classification: "restricted" },
        { pattern: "vendor/**", classification: "public" },
      ],
      projectClassification: "internal",
    });
    expect(result.classification).toBe("restricted");
    expect(result.matchedRule).toEqual({ pattern: "**/secrets/**", classification: "restricted" });
  });

  it("never lets a lower-classification rule weaken the floor set by another rule", () => {
    const result = classifyContent({
      contentTypes: ["files"],
      paths: ["vendor/lib/a.js", "src/secrets/b.txt"],
      pathRules: [
        { pattern: "vendor/**", classification: "public" },
        { pattern: "**/secrets/**", classification: "restricted" },
      ],
      projectClassification: "confidential",
    });
    expect(result.classification).toBe("restricted");
  });

  it("matches paths with `**` spanning separators and `*` staying inside one segment", () => {
    expect(pathMatchesRule("**/secrets/**", "a/b/secrets/c.txt")).toBe(true);
    expect(pathMatchesRule("vendor/**", "vendor/lib/a.js")).toBe(true);
    expect(pathMatchesRule("src/*.ts", "src/index.ts")).toBe(true);
    expect(pathMatchesRule("src/*.ts", "src/deep/index.ts")).toBe(false);
    // Anchored: a pattern cannot match a path that merely contains it.
    expect(pathMatchesRule("src/*.ts", "other/src/index.ts")).toBe(false);
  });
});

describe("security-gate: C5b provider data policy — validation", () => {
  it("refuses an unknown classification, training policy, retention and content type", () => {
    expect(() => validateProviderDataPolicyInput(policyInput({ maxDataClassification: "top_secret" as never })))
      .toThrowError(expect.objectContaining({ code: "invalid_classification" }));
    expect(() => validateProviderDataPolicyInput(policyInput({ trainingPolicy: "maybe" as never })))
      .toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
    expect(() => validateProviderDataPolicyInput(policyInput({ externalRetention: "forever" as never })))
      .toThrowError(expect.objectContaining({ code: "invalid_retention" }));
    expect(() => validateProviderDataPolicyInput(policyInput({ allowedContentTypes: ["everything" as never] })))
      .toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
  });

  it("refuses a policy that drops mandatory redaction, for any provider kind", () => {
    for (const kind of ["hosted_third_party", "self_hosted", "local"] as const) {
      expect(() => validateProviderDataPolicyInput(policyInput({ kind, requiredRedactions: ["pii"] })))
        .toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
    }
  });

  it("refuses a path rule that could leave the project", () => {
    for (const pattern of ["../outside/**", "/etc/**", "~/secrets/**", "src\\..\\x", "a/../../b", ""]) {
      expect(() => validatePathRule({ pattern, classification: "restricted" }))
        .toThrowError(expect.objectContaining({ code: "invalid_policy_path_rule" }));
    }
    expect(validatePathRule({ pattern: "src/**", classification: "internal" }))
      .toEqual({ pattern: "src/**", classification: "internal" });
  });

  it("accepts only the documented retention formats", () => {
    expect(parseExternalRetention("none")).toBe("none");
    expect(parseExternalRetention("unknown")).toBe("unknown");
    expect(parseExternalRetention("N_days:30")).toBe("N_days:30");
    for (const bad of ["30", "n_days:30", "N_days:", "N_days:abc", "forever"]) {
      expect(() => parseExternalRetention(bad))
        .toThrowError(expect.objectContaining({ code: "invalid_retention" }));
    }
  });
});

describe("security-gate: C5b provider data policy — store, versioning and tenant isolation", () => {
  let store: InMemoryWorkspaceStore;

  beforeEach(() => {
    store = new InMemoryWorkspaceStore();
  });

  it("bumps the policy version and appends a snapshot for every accepted write", async () => {
    const { port, entries } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });

    const first = await service.upsertPolicy(policyInput({ expectedPolicyVersion: null }));
    expect(first.policyVersion).toBe(1);
    const second = await service.upsertPolicy(policyInput({ maxDataClassification: "internal", expectedPolicyVersion: 1 }));
    expect(second.policyVersion).toBe(2);

    const versions = await store.listProviderDataPolicyVersions(COMPANY, PROVIDER);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.policyVersion)).toEqual([1, 2]);
    for (const version of versions) {
      expect(version.actor).toBe(ACTOR);
      expect((version.payload as ProviderDataPolicyRecord).providerId).toBe(PROVIDER);
    }
    // The snapshot records what was actually in force at that version, not the latest state.
    expect((versions[1]!.payload as ProviderDataPolicyRecord).maxDataClassification).toBe("internal");
    expect(entries.map((entry) => entry.action)).toEqual(["provider.data_policy.upsert", "provider.data_policy.upsert"]);
  });

  it("refuses a stale expected version instead of merging two writers", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.upsertPolicy(policyInput({ expectedPolicyVersion: null }));
    await expect(service.upsertPolicy(policyInput({ expectedPolicyVersion: 1 }))).resolves.toBeTruthy();
    await expect(service.upsertPolicy(policyInput({ expectedPolicyVersion: 1 })))
      .rejects.toThrowError(expect.objectContaining({ code: "data_policy_revision_conflict", httpStatus: 409 }));
  });

  it("keeps one company's policies invisible and unwritable from another", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.upsertPolicy(policyInput({ companyId: COMPANY, expectedPolicyVersion: null }));

    expect(await store.getProviderDataPolicy({ companyId: OTHER_COMPANY, providerId: PROVIDER, modelPattern: null })).toBeNull();
    expect(await store.listProviderDataPolicies(OTHER_COMPANY)).toHaveLength(0);
    expect(await store.listProviderDataPolicyVersions(OTHER_COMPANY)).toHaveLength(0);
    // The other company may write its own row, and it does not touch the first one.
    await service.upsertPolicy(policyInput({ companyId: OTHER_COMPANY, maxDataClassification: "restricted", expectedPolicyVersion: null }));
    const first = await store.getProviderDataPolicy({ companyId: COMPANY, providerId: PROVIDER, modelPattern: null });
    expect(first?.maxDataClassification).toBe("public");
  });

  it("defaults an unconfigured project to confidential and isolates project policies by company", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    expect(await store.getProjectDataPolicy(COMPANY, "proj_1")).toBeNull();

    const created = await service.upsertProjectPolicy({ companyId: COMPANY, projectId: "proj_1", actor: ACTOR });
    expect(created.dataClassification).toBe("confidential");
    expect(created.policyVersion).toBe(1);

    await service.upsertProjectPolicy({
      companyId: COMPANY, projectId: "proj_1", actor: ACTOR,
      dataClassification: "restricted", pathRules: [{ pattern: "**/secrets/**", classification: "restricted" }],
      expectedPolicyVersion: 1,
    });
    expect((await store.getProjectDataPolicy(COMPANY, "proj_1"))?.policyVersion).toBe(2);
    expect(await store.getProjectDataPolicy(OTHER_COMPANY, "proj_1")).toBeNull();
  });

  it("refuses an escaping path rule at the store as well, leaving the stored policy untouched", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.upsertProjectPolicy({ companyId: COMPANY, projectId: "proj_1", actor: ACTOR });
    await expect(service.upsertProjectPolicy({
      companyId: COMPANY, projectId: "proj_1", actor: ACTOR,
      pathRules: [{ pattern: "../outside/**", classification: "restricted" }],
    })).rejects.toThrowError(expect.objectContaining({ code: "invalid_policy_path_rule" }));
    const stored = await store.getProjectDataPolicy(COMPANY, "proj_1");
    expect(stored?.policyVersion).toBe(1);
    expect(stored?.pathRules).toEqual([]);
  });

  it("refuses an invalid policy at the store even when the service is bypassed", async () => {
    await expect(store.upsertProviderDataPolicy({
      ...policyInput({ expectedPolicyVersion: null }),
      requiredRedactions: ["pii"],
    })).rejects.toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
    expect(await store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
  });
});

describe("security-gate: C5b provider data policy — audit before apply, fail closed", () => {
  let store: InMemoryWorkspaceStore;

  beforeEach(() => {
    store = new InMemoryWorkspaceStore();
  });

  it("refuses the change and writes nothing when no journal is configured", async () => {
    const service = new ProviderDataPolicyService({ store });
    await expect(service.upsertPolicy(policyInput({ expectedPolicyVersion: null })))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable", httpStatus: 503, retryable: true }));
    expect(await store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
    expect(await store.listProviderDataPolicyVersions(COMPANY)).toHaveLength(0);
  });

  it("refuses the change and writes nothing when the journal throws", async () => {
    const { port } = makeAudit({ fail: true });
    const service = new ProviderDataPolicyService({ store, audit: port });
    await expect(service.upsertPolicy(policyInput({ expectedPolicyVersion: null })))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable" }));
    expect(await store.listProviderDataPolicies(COMPANY)).toHaveLength(0);
  });

  it("journals before the store is touched", async () => {
    const order: string[] = [];
    const audit: ProviderDataPolicyAuditPort = {
      async record() { order.push("audit"); },
    };
    const proxied = new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (String(property).startsWith("upsert")) order.push("store");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as InMemoryWorkspaceStore;
    const service = new ProviderDataPolicyService({ store: proxied, audit });
    await service.upsertPolicy(policyInput({ expectedPolicyVersion: null }));
    expect(order).toEqual(["audit", "store"]);
  });

  it("never journals an invalid policy as applied", async () => {
    const { port, entries } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await expect(service.upsertPolicy(policyInput({ requiredRedactions: ["pii"], expectedPolicyVersion: null })))
      .rejects.toThrowError(expect.objectContaining({ code: "invalid_policy_field" }));
    expect(entries).toHaveLength(0);
  });
});

describe("security-gate: C5b provider data policy — hosted provider consent", () => {
  let store: InMemoryWorkspaceStore;

  beforeEach(() => {
    store = new InMemoryWorkspaceStore();
  });

  it("has no consent by default and requires an explicit, journalled grant", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .resolves.toBe(false);
    await expect(service.grantHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR }))
      .resolves.toMatchObject({ grantedBy: ACTOR, revokedAt: null });
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .resolves.toBe(true);
  });

  it("treats a revoked consent as no consent, and a fresh grant clears the revocation", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.grantHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR });
    const revoked = await service.revokeHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .resolves.toBe(false);
    // The row is still returned so a caller can tell "never granted" from "withdrawn".
    expect(await store.getHostedProviderConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .not.toBeNull();
    await service.grantHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR });
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .resolves.toBe(true);
  });

  it("refuses to grant or revoke consent without a journal", async () => {
    const service = new ProviderDataPolicyService({ store });
    await expect(service.grantHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR }))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable" }));
    expect(await store.getHostedProviderConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .toBeNull();
  });

  it("keeps consent scoped to its own company and project", async () => {
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.grantHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: PROVIDER, actor: ACTOR });
    await expect(service.hasHostedConsent({ companyId: OTHER_COMPANY, projectId: "proj_1", providerId: PROVIDER }))
      .resolves.toBe(false);
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_2", providerId: PROVIDER }))
      .resolves.toBe(false);
    await expect(service.hasHostedConsent({ companyId: COMPANY, projectId: "proj_1", providerId: "other" }))
      .resolves.toBe(false);
  });
});

describe("security-gate: C5b provider data policy — the service resolves against stored rows", () => {
  it("resolves a company policy only for that company", async () => {
    const store = new InMemoryWorkspaceStore();
    const { port } = makeAudit();
    const service = new ProviderDataPolicyService({ store, audit: port });
    await service.upsertPolicy(policyInput({
      companyId: COMPANY, maxDataClassification: "confidential",
      allowedContentTypes: ["metadata", "prompt", "code"], expectedPolicyVersion: null,
    }));

    const mine = await service.resolveForCompany({ companyId: COMPANY, providerId: PROVIDER });
    expect(mine.source).toBe("provider");
    expect(mine.policy.maxDataClassification).toBe("confidential");
    expect(policyAllowsContentType(mine.policy, "code")).toBe(true);
    expect(mine.stale).toBe(false);

    // The other company is back to the fail-closed default: it never inherits a foreign policy.
    const theirs = await service.resolveForCompany({ companyId: OTHER_COMPANY, providerId: PROVIDER });
    expect(theirs.source).toBe("fail_closed");
    expect(theirs.policy.maxDataClassification).toBe("public");
    expect(policyAllowsContentType(theirs.policy, "code")).toBe(false);
  });

  it("requires a journal to change a project policy too", async () => {
    const store = new InMemoryWorkspaceStore();
    const service = new ProviderDataPolicyService({ store });
    await expect(service.upsertProjectPolicy({ companyId: COMPANY, projectId: "proj_1", actor: ACTOR }))
      .rejects.toThrowError(expect.objectContaining({ code: "audit_unavailable" }));
    expect(await store.getProjectDataPolicy(COMPANY, "proj_1")).toBeNull();
  });
});

describe("security-gate: C5b provider data policy — refusals are structured", () => {
  it("carries a code, an http status and retryability", () => {
    const error = new ProviderDataPolicyError("invalid_retention", "nope", { httpStatus: 400, details: { field: "x" } });
    expect(error.code).toBe("invalid_retention");
    expect(error.httpStatus).toBe(400);
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ field: "x" });
    // The default is denial, never permission.
    expect(new ProviderDataPolicyError("x", "y").httpStatus).toBe(403);
  });
});
