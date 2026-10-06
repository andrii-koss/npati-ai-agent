import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import {
  assertNoPlaceholderInWrite,
  conservativeHostedPolicy,
  createProviderDataGuard,
  isRedactionPlaceholder,
  ProviderDataError,
  type EffectiveDataPolicy,
  type ProviderDataDecision,
  type ProviderDataGuardOptions,
} from "../apps/agent-api/src/provider-data-guard";

const CANARY_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
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

function policy(overrides: Partial<EffectiveDataPolicy> = {}): EffectiveDataPolicy {
  return {
    providerId: "hosted-provider",
    kind: "hosted_third_party",
    allowPrivateRepoCode: true,
    maxDataClassification: "restricted",
    allowPromptCaching: true,
    trainingPolicy: "no_training",
    externalRetention: "none",
    requiredRedactions: ["secret", "token", "key", "email"],
    allowedContentTypes: ["text", "code", "diff", "logs", "terminal", "file_list", "web_content"],
    policyVersion: 7,
    stale: false,
    ...overrides,
  };
}

function fakeEngine(): { engine: AIEngine; calls: ChatRequest[]; streamed: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const streamed: ChatRequest[] = [];
  const engine = {
    async chat(request: ChatRequest): Promise<ChatResult> {
      calls.push(request);
      return { message: { role: "assistant", content: "ok" }, model: request.model ?? "auto", usage: {} } as ChatResult;
    },
    async *stream(request: ChatRequest) {
      streamed.push(request);
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
    async transcribeAudio(input: unknown) {
      calls.push({ messages: [], model: (input as { model?: string })?.model });
      return { text: "transcribed" } as never;
    },
  } as unknown as AIEngine;
  return { engine, calls, streamed };
}

function guardFor(engine: AIEngine, overrides: Partial<ProviderDataGuardOptions> = {}, resolved = policy()) {
  const decisions: ProviderDataDecision[] = [];
  const guard = createProviderDataGuard(engine, {
    resolvePolicy: () => resolved,
    record: { record: (decision) => void decisions.push(decision) },
    ...overrides,
  });
  return { guard: guard as AIEngine & { providerDataGuard: ReturnType<typeof createProviderDataGuard>["providerDataGuard"] }, decisions };
}

const context = { companyId: "company-1", projectId: "project-1", sessionId: "session-1", dataClassification: "confidential" as const };

describe("security-gate: C5b provider data guard — classification and context", () => {
  it("refuses a classification above the provider maximum and never calls the provider", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {}, policy({ maxDataClassification: "internal" }));
    // The documented contract is `request.policyContext`; without it the guard refuses earlier with
    // `provider_policy_context_required` (covered by its own case), so the classification check needs it.
    await expect(
      guard.chat({ messages: [{ role: "user", content: "hello" }], model: "hosted/model-a", policyContext: context } as never),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_data_classification_exceeded", httpStatus: 403 }));
    expect(calls).toHaveLength(0);
  });

  it("requires a policy context for content-bearing requests", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine);
    await expect(guard.chat({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrowError(
      expect.objectContaining({ code: "provider_policy_context_required" }),
    );
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the policy cannot be resolved", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {
      resolvePolicy: () => {
        throw new Error("store offline");
      },
    });
    await expect(guard.chat({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrowError(
      expect.objectContaining({ code: "provider_policy_unavailable", httpStatus: 503, retryable: true }),
    );
    expect(calls).toHaveLength(0);
  });

  it("applies the conservative hosted default to an unknown provider: public only, no private code", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {}, conservativeHostedPolicy({ model: "brand-new/model" }));
    await expect(
      guard.chat({ messages: [{ role: "user", content: PRIVATE_CODE }], model: "brand-new/model" }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_data_classification_exceeded" }));
    expect(calls).toHaveLength(0);
    expect(conservativeHostedPolicy().maxDataClassification).toBe("public");
    expect(conservativeHostedPolicy().allowPrivateRepoCode).toBe(false);
    expect(conservativeHostedPolicy().allowPromptCaching).toBe(false);
  });

  it("denies private repository code when the policy forbids it even at an allowed classification", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {}, policy({ allowPrivateRepoCode: false, maxDataClassification: "restricted" }));
    await expect(
      guard.chat({ messages: [{ role: "user", content: PRIVATE_CODE }], model: "hosted/model-a" }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_private_code_not_allowed" }));
    expect(calls).toHaveLength(0);
  });

  it("blocks a content type the policy does not allow", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {}, policy({ allowedContentTypes: ["text"] }));
    await expect(
      guard.chat({ messages: [{ role: "user", content: "review this", diff: "--- a\n+++ b\n" } as never], model: "hosted/model-a" }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_content_type_not_allowed" }));
    expect(calls).toHaveLength(0);
  });
});

describe("security-gate: C5b provider data guard — redaction", () => {
  it("never lets a canary secret reach the provider and keeps the value out of the decision", async () => {
    const { engine, calls } = fakeEngine();
    const { guard, decisions } = guardFor(engine);
    const result = (await guard.chat(
      { messages: [{ role: "user", content: `token is ${CANARY_TOKEN}` }], model: "hosted/model-a" },
      context,
    )) as ChatResult;
    expect(result).toBeTruthy();
    expect(calls).toHaveLength(1);
    const delivered = JSON.stringify(calls[0]);
    expect(delivered).not.toContain(CANARY_TOKEN);
    expect(delivered).toContain("REDACTED:token_1");
    expect(calls[0]!.messages[0]!.content).toContain("REDACTED:token_1");
    const serializedDecisions = JSON.stringify(decisions);
    expect(serializedDecisions).not.toContain(CANARY_TOKEN);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "provider_data_decision", decision: "allow", policyVersion: 7, phase: "chat" });
    expect(decisions[0]!.redactionCounts.token).toBeGreaterThanOrEqual(1);
    expect(Object.keys(decisions[0]!)).not.toContain("content");
    expect(isRedactionPlaceholder("REDACTED:secret_1")).toBe(true);
    expect(isRedactionPlaceholder("ordinary text")).toBe(false);
  });

  it("redacts on the stream path too", async () => {
    const { engine, streamed } = fakeEngine();
    const { guard } = guardFor(engine);
    const chunks: string[] = [];
    for await (const chunk of guard.stream(
      { messages: [{ role: "user", content: `mail me at dev@internal.corp and token ${CANARY_TOKEN}` }], model: "hosted/model-a" },
      context,
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["ok"]);
    expect(streamed).toHaveLength(1);
    const delivered = JSON.stringify(streamed[0]);
    expect(delivered).not.toContain(CANARY_TOKEN);
    expect(delivered).not.toContain("dev@internal.corp");
    expect(delivered).toContain("REDACTED:token_1");
  });

  it("refuses to write a redaction placeholder to disk", () => {
    expect(() => assertNoPlaceholderInWrite("const a = 1;")).not.toThrow();
    expect(() => assertNoPlaceholderInWrite("const token = 'REDACTED:token_1';", { path: "src/x.ts" })).toThrowError(
      expect.objectContaining({ code: "redaction_placeholder_write_denied", httpStatus: 403 }),
    );
  });

  it("suppresses prompt caching when the policy forbids it and leaves no cache directive in the request", async () => {
    const { engine, calls } = fakeEngine();
    const { guard, decisions } = guardFor(engine, {}, policy({ allowPromptCaching: false }));
    await guard.chat({ messages: [{ role: "user", content: "hello" }], model: "hosted/model-a" }, context);
    const deliveredKeys = Object.keys(calls[0] as Record<string, unknown>).map((key) => key.toLowerCase());
    expect(deliveredKeys.filter((key) => key.includes("cache"))).toEqual([]);
    expect(decisions[0]!.cachingSuppressed).toBe(true);
  });

  it("covers non-chat engine methods such as transcription", async () => {
    const { engine, calls } = fakeEngine();
    const { guard } = guardFor(engine, {}, policy({ maxDataClassification: "public" }));
    await expect(
      (guard as unknown as { transcribeAudio: (input: unknown) => Promise<unknown> }).transcribeAudio({
        audio: "base64",
        policyContext: context,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "provider_data_classification_exceeded" }));
    expect(calls).toHaveLength(0);
  });
});

describe("security-gate: C5b provider data guard — eligibility", () => {
  it("reports a stale policy as ineligible and never as eligible by default", async () => {
    const { engine } = fakeEngine();
    const stale = guardFor(engine, {}, policy({ stale: true }));
    await expect(stale.guard.providerDataGuard.isModelEligible("hosted/model-a", context)).resolves.toEqual({
      eligible: false,
      reason: "policy_stale",
    });
    const fresh = guardFor(engine, {}, policy({ maxDataClassification: "internal" }));
    await expect(fresh.guard.providerDataGuard.isModelEligible("hosted/model-a", context)).resolves.toEqual({
      eligible: false,
      reason: "classification_exceeds:internal",
    });
  });

  it("keeps the engine interface intact and exposes the guard alongside it", async () => {
    const { engine } = fakeEngine();
    const { guard } = guardFor(engine);
    expect(typeof guard.chat).toBe("function");
    expect(typeof guard.listModels).toBe("function");
    expect(typeof (guard as { providerDataGuard?: unknown }).providerDataGuard).toBe("object");
    await expect(guard.healthCheck()).resolves.toBeTruthy();
  });

  it("surfaces a structured error type callers can branch on", () => {
    const error = new ProviderDataError("provider_content_type_not_allowed", "no diff", 403, { contentType: "diff" });
    expect(error.code).toBe("provider_content_type_not_allowed");
    expect(error.httpStatus).toBe(403);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("[provider_content_type_not_allowed]");
  });
});
