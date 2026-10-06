import { describe, expect, it, vi } from "vitest";
import {
  NO_REDACTION_CHANNELS,
  OUTBOUND_CHANNELS,
  OutboundExfiltrationError,
  assertNoContentInOutboundDecision,
  assertOutboundAllowed,
  containsOutboundPlaceholder,
  createOutboundGuard,
  getOutboundGuard,
  guardOutbound,
  inspectOutboundPayload,
  looksLikePrivateCode,
  setOutboundGuard,
  type OutboundChannel,
} from "../apps/agent-api/src/outbound-exfiltration-guard";
import type { ResolvedProviderDataPolicy } from "../apps/agent-api/src/provider-data-policy";
import { MessagingGateway, type MessagingAdapter } from "../apps/agent-api/src/messaging-gateway";
import { deliverWebhook } from "../apps/agent-api/src/webhook-destination-policy";
import { Crawl4AIProvider } from "../packages/web-research/src/providers";
import { SafeUrlValidator } from "../packages/web-research/src/safe-url-validator";
import { applyEdit, writeFileSafe } from "../apps/agent-api/src/code-tools-write";

/**
 * C5b security-gate: nothing sensitive leaves NPATI through a non-model channel.
 *
 * These tests are written against the *call sites*, not only against the pure decision function: a guard
 * that decides correctly but is not wired is exactly the failure this suite exists to catch, so each
 * channel below asserts that the transport was never invoked with the sensitive value.
 */

const GITHUB_TOKEN = "ghp_" + "a".repeat(36);
const AWS_KEY = "AKIA" + "B".repeat(16);
const PRIVATE_CODE = [
  "import { connect } from \"./db\";",
  "export async function loadUser(id: string) {",
  "  const row = await connect().query(\"select * from users where id = $1\", [id]);",
  "  return row.rows[0];",
  "}",
].join("\n");

const resolverPort = {
  resolve: async () => ["93.184.216.34"],
};

const crawlLimits = {
  maxSearchResults: 5, maxCompetitors: 3, maxPagesPerSite: 5, maxCrawlDepth: 1,
  timeoutMs: 1_000, maxConcurrentJobs: 1, cacheTtlSeconds: 60,
  maxContentCharacters: 10_000, perDomainDelayMs: 0,
};

const crawlGuardPort = {
  assertOutboundAllowed: (input: { channel: "web_search" | "web_fetch" | "web_crawl"; parts: Array<{ kind: "text" | "url" | "code" | "query" | "metadata"; value: string; label?: string }> }) => {
    assertOutboundAllowed({ channel: input.channel, parts: input.parts });
  },
};

function policy(overrides: Partial<ResolvedProviderDataPolicy["policy"]> = {}): ResolvedProviderDataPolicy {
  return {
    policy: {
      kind: "hosted_third_party",
      maxDataClassification: "confidential",
      allowPrivateRepoCode: true,
      allowPromptCaching: false,
      trainingPolicy: "no_training",
      externalRetention: "none",
      requiredRedactions: ["secrets", "tokens", "keys", "pii"],
      allowedContentTypes: ["metadata", "prompt", "code", "diff", "files", "logs", "terminal", "web"],
      region: null,
      jurisdiction: null,
      termsUrl: null,
      ...overrides,
    },
    source: "provider",
    matchedPolicyId: "policy-1",
    policyVersion: 3,
    stale: false,
    staleReason: null,
  };
}

/** Registers a guard for one test and always clears it again, so the module-level seam cannot leak. */
function withGuard<T>(run: () => T): T {
  setOutboundGuard(createOutboundGuard({ resolvePolicy: () => policy() }));
  try {
    return run();
  } finally {
    setOutboundGuard(null);
  }
}

/**
 * Asserts a refusal by its **code** rather than by class identity: the code is the contract callers branch
 * on, and it survives the module-instance boundary that a shimmed test runner can introduce.
 */
async function refusalCode(run: () => unknown): Promise<string> {
  try {
    await run();
    return "NO_REFUSAL";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : (error as Error).name;
  }
}

async function withGuardAsync(run: () => Promise<void>): Promise<void> {
  setOutboundGuard(createOutboundGuard({ resolvePolicy: () => policy() }));
  try {
    await run();
  } finally {
    setOutboundGuard(null);
  }
}

describe("security-gate: C5b outbound exfiltration decisions", () => {
  it("refuses a secret on a delivery channel and never suggests a redaction", () => {
    const result = inspectOutboundPayload({
      channel: "email",
      parts: [{ kind: "text", value: `here is the token ${GITHUB_TOKEN}` }],
      policy: policy(),
    });
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("outbound_secret_denied");
    expect(result.redactedParts).toBeNull();
    expect(result.reasons.join(" ")).toContain("secrets_never_leave");
  });

  it("treats private repository code as an approval-class event, not an allow", () => {
    const result = inspectOutboundPayload({
      channel: "web_search",
      parts: [{ kind: "query", value: `how do I fix this: ${PRIVATE_CODE}` }],
      policy: policy(),
    });
    expect(result.decision).toBe("require_approval");
    expect(result.code).toBe("outbound_private_code_requires_approval");
    expect(result.classification).toBe("confidential");
  });

  it("redacts a secret for a retrieval channel when the policy requires it, and the raw value is gone", () => {
    const result = inspectOutboundPayload({
      channel: "web_search",
      parts: [{ kind: "query", value: `rotate ${AWS_KEY} please` }],
      policy: policy(),
    });
    expect(result.decision).toBe("allow");
    expect(result.redactedParts).not.toBeNull();
    const redacted = result.redactedParts!.map((part) => part.value).join("\n");
    expect(redacted).not.toContain(AWS_KEY);
    expect(redacted).toContain("REDACTED:");
    expect(containsOutboundPlaceholder(redacted)).toBe(true);
  });

  it("refuses a sensitive payload when no policy is registered for the channel", () => {
    const result = inspectOutboundPayload({
      channel: "mcp",
      parts: [{ kind: "text", value: `{"token":"${GITHUB_TOKEN}"}` }],
      policy: null,
    });
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("outbound_guard_unavailable");
  });

  it("lets an ordinary public payload through, so unrelated NPATI features keep working", () => {
    const result = inspectOutboundPayload({
      channel: "email",
      parts: [
        { kind: "metadata", value: "customer@example.com" },
        { kind: "text", value: "Your invoice for March is attached to your account page." },
      ],
      policy: policy(),
    });
    expect(result.decision).toBe("allow");
    expect(result.code).toBeNull();
  });

  it("refuses every channel for a restricted project", () => {
    for (const channel of OUTBOUND_CHANNELS) {
      const result = inspectOutboundPayload({
        channel,
        parts: [{ kind: "text", value: "internal release notes" }],
        policy: policy(),
        projectClassification: "restricted",
      });
      expect(result.decision, channel).toBe("deny");
      expect(result.code, channel).toBe("outbound_classification_denied");
    }
  });

  it("never lets the decision event carry the payload, a secret or a url", async () => {
    const result = inspectOutboundPayload({
      channel: "webhook",
      parts: [{ kind: "text", value: `secret ${GITHUB_TOKEN}` }],
      policy: policy(),
    });
    expect(() => assertNoContentInOutboundDecision(result.event as unknown as Record<string, unknown>)).not.toThrow();
    expect(await refusalCode(() => assertNoContentInOutboundDecision({ payload: "x" })))
      .toBe("outbound_decision_contains_content");
    expect(await refusalCode(() => assertNoContentInOutboundDecision({ note: GITHUB_TOKEN })))
      .toBe("outbound_decision_contains_content");
    expect(await refusalCode(() => assertNoContentInOutDecisionUrl()))
      .toBe("outbound_decision_contains_content");
  });

  it("recognises repository content by shape, not by a caller-provided label", () => {
    expect(looksLikePrivateCode(PRIVATE_CODE)).toBe(true);
    expect(looksLikePrivateCode("Please send the invoice to the customer.")).toBe(false);
    expect(looksLikePrivateCode("diff --git a/app.ts b/app.ts")).toBe(true);
  });
});

function assertNoContentInOutDecisionUrl(): void {
  assertNoContentInOutboundDecision({ endpoint: "https://attacker.example/collect" });
}

describe("security-gate: C5b the guard is wired into the outbound call sites", () => {
  it("refuses a secret through the throwing helper without reaching the transport", async () => {
    await withGuardAsync(async () => {
      const transport = vi.fn(async () => "sent");
      const code = await refusalCode(() => {
        assertOutboundAllowed({ channel: "email", parts: [{ kind: "text", value: GITHUB_TOKEN }] });
        void transport();
      });
      expect(code).toBe("outbound_secret_denied");
      expect(transport).not.toHaveBeenCalled();
    });
  });

  it("keeps a sensitive payload refused when no guard is registered", () => {
    setOutboundGuard(null);
    expect(getOutboundGuard()).toBeNull();
    const sensitive = guardOutbound({ channel: "webhook", parts: [{ kind: "text", value: `k=${AWS_KEY}` }] });
    expect(sensitive.decision).toBe("deny");
    const clean = guardOutbound({ channel: "webhook", parts: [{ kind: "text", value: "build finished" }] });
    expect(clean.decision).toBe("allow");
  });

  it("guards messaging at the gateway, so a new adapter cannot forget the check", async () => {
    await withGuardAsync(async () => {
      const sendText = vi.fn(async () => ["1"]);
      const adapter: MessagingAdapter = {
        channel: "telegram",
        validateCredential: async () => ({ externalName: "bot" }),
        configureWebhook: async () => undefined,
        parseInbound: async () => null,
        sendText,
      };
      const gateway = new MessagingGateway().register(adapter);
      expect(await refusalCode(() => gateway.adapter("telegram").sendText("token", "chat-1", `leaked ${GITHUB_TOKEN}`)))
        .toBe("outbound_secret_denied");
      expect(sendText).not.toHaveBeenCalled();

      await gateway.adapter("telegram").sendText("token", "chat-1", "NPATI connection is active.");
      expect(sendText).toHaveBeenCalledTimes(1);
    });
  });

  it("guards webhook delivery after the destination policy and never calls the transport for a secret", async () => {
    await withGuardAsync(async () => {
      const fetchImpl = vi.fn(async () => ({ status: 200, headers: {}, body: "", bytes: 0, redirects: 0 }));
      const options = {
        storedEndpoints: ["https://hooks.example.com/npati"],
        resolve: resolverPort.resolve as never,
        fetchImpl: fetchImpl as never,
      };
      // Positive control: a clean payload reaches the transport, so a refusal below is the guard's doing
      // and not a destination-policy failure.
      await deliverWebhook("https://hooks.example.com/npati", {
        ...options, body: JSON.stringify({ event: "build.finished" }),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await expect(deliverWebhook("https://hooks.example.com/npati", {
        ...options, body: JSON.stringify({ event: "build.finished", token: GITHUB_TOKEN }),
      })).rejects.toMatchObject({ code: "outbound_secret_denied" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(getOutboundGuard()).not.toBeNull();
    });
  });

  it("stops the crawl service from being reached with a secret in the request, so the direct fetch cannot bypass the guard", async () => {
    await withGuardAsync(async () => {
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const provider = new Crawl4AIProvider("http://crawler.local:11235", new SafeUrlValidator(), crawlLimits, undefined, crawlGuardPort);
        expect(await refusalCode(() => provider.fetch({ url: `https://example.com/page?token=${GITHUB_TOKEN}` })))
          .toBe("outbound_secret_denied");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("still performs an allowed crawl so the guard is a filter, not a blocker", async () => {
    await withGuardAsync(async () => {
      let seen = "";
      const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
        seen = `${url} ${String(init?.body ?? "")}`;
        return new Response(JSON.stringify({ results: [{ url: "https://example.com/page", markdown: "# Page" }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const provider = new Crawl4AIProvider("http://crawler.local:11235", new SafeUrlValidator(), crawlLimits, undefined, crawlGuardPort);
        const page = await provider.fetch({ url: "https://example.com/page" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(seen).toContain("https://example.com/page");
        expect(page.url).toBe("https://example.com/page");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("uses the same policy object for every channel so a narrower policy narrows them all", () => {
    const channels: OutboundChannel[] = ["web_search", "web_fetch", "mcp", "messaging"];
    for (const channel of channels) {
      const result = inspectOutboundPayload({
        channel,
        parts: [{ kind: "text", value: PRIVATE_CODE }],
        policy: policy({ maxDataClassification: "internal" }),
      });
      expect(result.decision, channel).toBe("deny");
      expect(result.code, channel).toBe("outbound_classification_denied");
    }
  });
});

describe("security-gate: C5b policy context is explicit and per channel", () => {
  it("refuses a sensitive payload with the resolver's own code when no context is available", () => {
    setOutboundGuard(createOutboundGuard({
      resolvePolicy: () => ({ code: "provider_policy_context_required", reason: "outbound_policy_context_required" }),
    }));
    try {
      const sensitive = guardOutbound({
        channel: "web_search",
        parts: [{ kind: "query", value: `fix this: ${PRIVATE_CODE}` }],
      });
      expect(sensitive.decision).toBe("deny");
      expect(sensitive.code).toBe("provider_policy_context_required");
      expect(sensitive.event.policyRefusalCode).toBe("provider_policy_context_required");

      // Positive path: a payload with nothing private still passes, so unrelated NPATI features keep working
      // while no run context is active (the runner sets one per run — TODO(C6)).
      const clean = guardOutbound({ channel: "web_search", parts: [{ kind: "query", value: "weather in kyiv" }] });
      expect(clean.decision).toBe("allow");
    } finally {
      setOutboundGuard(null);
    }
  });

  it("reports an unreadable policy store as an explicit refusal, never as a silent null", () => {
    setOutboundGuard(createOutboundGuard({
      resolvePolicy: () => ({ code: "provider_policy_unavailable", reason: "snapshot_refresh_failed:connection refused" }),
    }));
    try {
      const clean = guardOutbound({ channel: "email", parts: [{ kind: "text", value: "deploy finished" }] });
      expect(clean.decision).toBe("allow");
      const sensitive = guardOutbound({ channel: "email", parts: [{ kind: "text", value: PRIVATE_CODE }] });
      expect(sensitive.decision).toBe("deny");
      expect(sensitive.code).toBe("provider_policy_unavailable");
    } finally {
      setOutboundGuard(null);
    }
  });

  it("forwards the per-call context to the resolver and honours its classification", () => {
    const seen: Array<{ channel: string; companyId?: string; projectId?: string }> = [];
    setOutboundGuard(createOutboundGuard({
      resolvePolicy: (channel, context) => {
        seen.push({
          channel,
          ...(context?.companyId ? { companyId: context.companyId } : {}),
          ...(context?.projectId ? { projectId: context.projectId } : {}),
        });
        return policy();
      },
    }));
    try {
      const allowed = guardOutbound({
        channel: "mcp",
        parts: [{ kind: "text", value: "list open issues" }],
        context: { companyId: "company-7", projectId: "project-9" },
      });
      expect(allowed.decision).toBe("allow");
      expect(seen).toEqual([{ channel: "mcp", companyId: "company-7", projectId: "project-9" }]);

      const restricted = guardOutbound({
        channel: "mcp",
        parts: [{ kind: "text", value: "list open issues" }],
        context: { companyId: "company-7", dataClassification: "restricted" },
      });
      expect(restricted.decision).toBe("deny");
      expect(restricted.code).toBe("outbound_classification_denied");
    } finally {
      setOutboundGuard(null);
    }
  });

  it("gives every channel a positive path when the policy allows the payload", () => {
    setOutboundGuard(createOutboundGuard({ resolvePolicy: () => policy() }));
    try {
      const clean: Record<OutboundChannel, string> = {
        web_search: "weather in kyiv",
        web_fetch: "https://example.com/docs",
        web_crawl: "https://example.com/docs",
        mcp: "list repositories",
        email: "Your invoice is ready in the account page.",
        webhook: JSON.stringify({ event: "build.finished" }),
        messaging: "NPATI connection is active.",
      };
      for (const channel of OUTBOUND_CHANNELS) {
        const result = guardOutbound({ channel, parts: [{ kind: "text", value: clean[channel] }] });
        expect(result.decision, `${channel}:${result.code ?? ""}`).toBe("allow");
      }

      // A secret is refused outright on the delivery channels, and redacted (never sent raw) elsewhere, so
      // the positive path above is not a blanket allow.
      for (const channel of OUTBOUND_CHANNELS) {
        const result = guardOutbound({ channel, parts: [{ kind: "text", value: `token ${GITHUB_TOKEN}` }] });
        if (NO_REDACTION_CHANNELS.includes(channel)) {
          expect(result.decision, channel).toBe("deny");
          expect(result.code, channel).toBe("outbound_secret_denied");
        } else {
          expect(result.decision, channel).toBe("allow");
          const sent = result.redactedParts!.map((part) => part.value).join("\n");
          expect(sent, channel).not.toContain(GITHUB_TOKEN);
          expect(sent, channel).toContain("REDACTED:");
        }
      }
    } finally {
      setOutboundGuard(null);
    }
  });
});

describe("security-gate: C5b a redaction placeholder never reaches disk", () => {
  function writePort() {
    const writes: Array<{ path: string; content: string }> = [];
    return {
      writes,
      port: {
        stat: async () => ({ exists: false, type: "file" as const }),
        readFile: async () => ({ content: "const token = 'real';\n" }),
        writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { sha256: "x" }; },
        deletePath: async () => undefined,
        movePath: async () => undefined,
        createDirectory: async () => undefined,
      },
    };
  }

  it("refuses an edit whose new content is a placeholder, before any write", async () => {
    const { writes, port } = writePort();
    await expect(applyEdit({
      path: "src/app.ts",
      old_string: "const token = 'real';",
      new_string: "const token = 'REDACTED:github_token_1';",
    }, port as never, { readVerified: true } as never)).rejects.toMatchObject({ code: "redaction_placeholder_write_denied" });
    expect(writes).toEqual([]);
  });

  it("refuses a whole-file write whose content is a placeholder and leaves the file untouched", async () => {
    const { writes, port } = writePort();
    await expect(writeFileSafe({
      path: "src/config.ts",
      content: "export const apiKey = \"REDACTED:api_key_2\";\n",
      overwrite: true,
    }, port as never, { readVerified: true } as never)).rejects.toMatchObject({ code: "redaction_placeholder_write_denied" });
    expect(writes).toEqual([]);
  });

  it("still writes ordinary content, so the hook blocks placeholders only", async () => {
    const { writes, port } = writePort();
    await writeFileSafe({
      path: "src/config.ts",
      content: "export const apiKey = process.env.API_KEY;\n",
      overwrite: true,
    }, port as never, { readVerified: true } as never);
    expect(writes).toHaveLength(1);
  });
});
