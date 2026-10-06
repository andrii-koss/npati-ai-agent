import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import type { ProviderDataPolicyRecord } from "../apps/agent-api/src/provider-data-policy";
import {
  createEnginePolicyResolver,
  OutboundPolicySnapshot,
  resolveOutboundPolicyFromSnapshot,
  toEffectiveDataPolicy,
} from "../apps/agent-api/src/provider-data-policy-resolver";
import {
  classificationRank,
  CONTENT_TYPE_ALIASES,
  createProviderDataGuard,
  requiredRedactionKindsFromPolicy,
  toCanonicalContentType,
  type ProviderDataDecision,
} from "../apps/agent-api/src/provider-data-guard";

const CANARY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PRIVATE_CODE = [
  "import { secret } from './internal';",
  "class BillingEngine {",
  "  calculate(account) {",
  "    const rate = account.rate * 1.2;",
  "    return rate;",
  "  }",
  "}",
  "export default BillingEngine;",
].join("\n");

/** Fixture builder kept deliberately loose: the storage layer owns the record type, this only feeds it. */
function record(overrides: Record<string, unknown> = {}): ProviderDataPolicyRecord {
  return {
    id: "policy-1",
    companyId: "company-1",
    providerId: "self-hosted",
    modelPattern: null,
    kind: "self_hosted",
    allowPrivateRepoCode: true,
    maxDataClassification: "restricted",
    allowPromptCaching: true,
    trainingPolicy: "no_training",
    externalRetention: "none",
    requiredRedactions: ["secrets", "tokens", "keys", "email"],
    allowedContentTypes: ["prompt", "code", "diff", "logs", "terminal", "files", "web"],
    policyVersion: 4,
    lastReviewedAt: new Date("2026-09-01T00:00:00.000Z"),
    region: null,
    jurisdiction: null,
    termsUrl: null,
    ...overrides,
  } as unknown as ProviderDataPolicyRecord;
}

function portWith(records: ProviderDataPolicyRecord[]) {
  const calls: Array<string | null> = [];
  return {
    calls,
    port: {
      async listProviderDataPolicies(companyId: string | null) {
        calls.push(companyId);
        return records.filter((entry) => (entry as { companyId: string | null }).companyId === companyId);
      },
    },
  };
}

function mockEngine(): { engine: AIEngine; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const engine = {
    async chat(request: ChatRequest): Promise<ChatResult> {
      calls.push(request);
      return { message: { role: "assistant", content: "ok" }, model: request.model ?? "auto", usage: {} } as ChatResult;
    },
    async *stream(request: ChatRequest) {
      calls.push(request);
      yield "ok";
    },
    async listModels() {
      return [];
    },
    async getModel() {
      return undefined;
    },
    async executeTool() {
      return undefined;
    },
    async searchMemory() {
      return [];
    },
    async saveMemory() {},
    async getCapabilities() {
      return [];
    },
    async healthCheck() {
      return { status: "ok" } as never;
    },
  } as unknown as AIEngine;
  return { engine, calls };
}

const context = { companyId: "company-1", projectId: "project-1", dataClassification: "confidential" as const };
const projectContext = { companyId: "company-1" };

describe("security-gate: C5b configured policy changes the verdict (positive proof)", () => {
  it("lets private code through to a self-hosted provider the policy allows", async () => {
    const { port } = portWith([record()]);
    const { engine, calls } = mockEngine();
    const decisions: ProviderDataDecision[] = [];
    const guard = createProviderDataGuard(engine, {
      resolvePolicy: createEnginePolicyResolver(port),
      record: { record: (decision) => void decisions.push(decision) },
    }) as AIEngine & { providerDataGuard: unknown };

    await guard.chat({ messages: [{ role: "user", content: PRIVATE_CODE }], model: "self-hosted/chat" }, context);

    expect(calls).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "allow", policyVersion: 4 });
    const delivered = JSON.stringify(calls[0]);
    expect(delivered).toContain("BillingEngine");
    expect(delivered).not.toContain(CANARY);
  });

  it("refuses the same request for a hosted provider limited to public data", async () => {
    const { port } = portWith([
      record({ providerId: "hosted-public", kind: "hosted_third_party", maxDataClassification: "public", allowPrivateRepoCode: false, allowedContentTypes: ["prompt"], policyVersion: 2 }),
    ]);
    const { engine, calls } = mockEngine();
    const guard = createProviderDataGuard(engine, { resolvePolicy: createEnginePolicyResolver(port) }) as AIEngine;

    await expect(
      guard.chat({ messages: [{ role: "user", content: PRIVATE_CODE }], model: "hosted-public/chat" }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_data_classification_exceeded" }));
    expect(calls).toHaveLength(0);
  });

  it("redacts a policy-required secret end to end, including the plural policy vocabulary", async () => {
    const { port } = portWith([record({ requiredRedactions: ["secrets"] })]);
    const { engine, calls } = mockEngine();
    const guard = createProviderDataGuard(engine, { resolvePolicy: createEnginePolicyResolver(port) }) as AIEngine;

    await guard.chat({ messages: [{ role: "user", content: `token ${CANARY}` }], model: "self-hosted/chat" }, context);

    const delivered = JSON.stringify(calls[0]);
    expect(delivered).not.toContain(CANARY);
    expect(delivered).toContain("REDACTED:token_1");
    expect(requiredRedactionKindsFromPolicy(["secrets", "tokens", "keys"])).toEqual(["secret", "token", "key"]);
  });

  it("falls back to the fail-closed floor when the store holds no policy", async () => {
    const { port } = portWith([]);
    const engine = await createEnginePolicyResolver(port)({ model: "unknown/chat", policyContext: projectContext });
    expect(engine.maxDataClassification).toBe("public");
    expect(engine.allowPrivateRepoCode).toBe(false);
    expect(engine.allowPromptCaching).toBe(false);
    expect(engine.policyVersion).toBe(0);

    const snapshot = new OutboundPolicySnapshot(port);
    snapshot.setActiveContext({ companyId: "company-1" });
    await snapshot.refresh();
    const resolved = snapshot.resolve("unknown-channel");
    expect(resolved?.source).toBe("fail_closed");
    expect(resolved?.policy.maxDataClassification).toBe("public");
  });

  it("prefers a company policy over a platform default", async () => {
    const { port, calls } = portWith([
      record({ companyId: null, providerId: "shared", kind: "hosted_third_party", maxDataClassification: "public", allowPrivateRepoCode: false }),
      record({ companyId: "company-1", providerId: "shared", kind: "self_hosted", maxDataClassification: "restricted" }),
    ]);
    const resolve = createEnginePolicyResolver(port);
    expect((await resolve({ model: "shared/chat", policyContext: { companyId: "company-1" } })).maxDataClassification).toBe("restricted");
    expect((await resolve({ model: "shared/chat", policyContext: { companyId: "company-2" } })).maxDataClassification).toBe("public");
    expect(calls).toContain(null);
  });
});

describe("security-gate: C5b one resolver — engine and outbound cannot diverge", () => {
  it("derives the same limits and version for both consumers from one policy", async () => {
    const { port } = portWith([record()]);
    const engine = await createEnginePolicyResolver(port)({ model: "self-hosted/chat", policyContext: projectContext });

    const snapshot = new OutboundPolicySnapshot(port);
    snapshot.setActiveContext({ companyId: "company-1", projectId: "project-1", dataClassification: "confidential" });
    await snapshot.refresh();
    const outbound = resolveOutboundPolicyFromSnapshot(snapshot, "self-hosted");

    expect(outbound.kind).toBe("policy");
    if (outbound.kind !== "policy") return;
    expect(outbound.resolved.policy.maxDataClassification).toBe(engine.maxDataClassification);
    expect(outbound.resolved.policy.policyVersion).toBe(engine.policyVersion);
    expect(outbound.resolved.policy.allowedContentTypes).toEqual(engine.allowedContentTypes);
    expect(outbound.resolved.policy.requiredRedactions).toEqual(engine.requiredRedactions);
    expect(outbound.resolved.source).toBe("provider");
  });

  it("maps between the policy vocabulary and the guard vocabulary in exactly one place", async () => {
    expect(toCanonicalContentType("file_list")).toBe("files");
    expect(toCanonicalContentType("web_content")).toBe("web");
    expect(toCanonicalContentType("text")).toBe("prompt");
    expect(toCanonicalContentType("diff")).toBe("diff");
    expect(toCanonicalContentType("nonsense")).toBeUndefined();
    expect(Object.keys(CONTENT_TYPE_ALIASES).length).toBeGreaterThan(0);

    const { port } = portWith([record({ allowedContentTypes: ["prompt"] })]);
    const engine = await createEnginePolicyResolver(port)({ model: "self-hosted/chat", policyContext: projectContext });
    // The policy names `prompt`; the guard must not be able to treat the same content as an unnamed type.
    expect(engine.allowedContentTypes).toEqual(["prompt"]);

    const resolved = toEffectiveDataPolicy(
      {
        policy: {
          kind: "self_hosted",
          maxDataClassification: "restricted",
          allowPrivateRepoCode: true,
          allowPromptCaching: true,
          trainingPolicy: "no_training",
          externalRetention: "none",
          requiredRedactions: ["secrets"],
          allowedContentTypes: ["prompt", "code"],
          region: null,
          jurisdiction: null,
          termsUrl: null,
        },
        source: "provider",
        matchedPolicyId: "policy-1",
        policyVersion: 4,
        stale: false,
        staleReason: null,
      },
      "self-hosted",
    );
    expect(resolved.requiredRedactions).toEqual(["secret"]);
    expect(classificationRank(resolved.maxDataClassification)).toBeGreaterThan(classificationRank("internal"));
  });

  it("refuses explicitly when no outbound context is active or the store is unreadable", async () => {
    const { port } = portWith([record()]);
    const noContext = new OutboundPolicySnapshot(port);
    await noContext.refresh();
    expect(resolveOutboundPolicyFromSnapshot(noContext, "self-hosted")).toEqual({
      kind: "context_required",
      code: "provider_policy_context_required",
      reason: "outbound_policy_context_required",
    });

    const broken = new OutboundPolicySnapshot({
      async listProviderDataPolicies() {
        throw new Error("store offline");
      },
    });
    broken.setActiveContext({ companyId: "company-1" });
    await broken.refresh();
    const failed = resolveOutboundPolicyFromSnapshot(broken, "self-hosted");
    expect(failed).toMatchObject({ kind: "context_required", code: "provider_policy_unavailable" });
    expect((failed as { reason: string }).reason).toContain("snapshot_refresh_failed");
    expect(broken.isLoaded()).toBe(false);
  });
});
