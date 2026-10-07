import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { AuthContext } from "@npati/workspace";
import { CodeHooksService, type CodeHooksDeps } from "../apps/agent-api/src/code-hooks";
import { AgentLifecycleHookManager } from "../apps/agent-api/src/automation-lifecycle-and-reminders";
import {
  WEBHOOK_DELIVERY_MAX_REDIRECTS, WebhookDestinationError, deliverWebhook, validateWebhookDestination,
} from "../apps/agent-api/src/webhook-destination-policy";
import { assertOutboundAllowed } from "../apps/agent-api/src/outbound-exfiltration-guard";

/**
 * C13 — webhook hooks must not become an egress channel of their own.
 *
 * The owner's rule is that a webhook hook goes through the **existing** SSRF-safe/network policy and never
 * around C4b. This suite drives the real destination policy and the real delivery path:
 *
 *  - a private, loopback, metadata or plain-HTTP destination is refused **before** the transport is called,
 *    including a hostname that merely *resolves* into a private range on the delivery that matters;
 *  - redirects are disabled, so a webhook cannot be bounced to a second, unvetted host;
 *  - the payload still passes the outbound exfiltration guard, so a credential in the body is refused;
 *  - the hooks module itself performs no I/O: it has one injected port, and an unwired port is a refusal.
 */

const owner: AuthContext = { workspaceId: "ws-c13", userId: "user-c13", permissions: ["owner"] } as unknown as AuthContext;
const PUBLIC_IP = "93.184.216.34";
const GHP = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

/** The transport seam: the real SSRF client is used, only the socket is replaced. */
function transportPort(status: number, body = "{}", headers: Record<string, string> = {}) {
  return vi.fn(async () => ({
    status,
    headers,
    body: (async function* () { yield Buffer.from(body, "utf8"); })(),
  }));
}

async function destinationError(run: () => Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await run();
    return { code: "none", reason: "none" };
  } catch (error) {
    const shaped = error as WebhookDestinationError & { code?: string; reason?: string };
    return { code: shaped.code ?? "unknown", reason: shaped.reason ?? String(shaped.message) };
  }
}

describe("[C13] [security-gate] webhook hooks — SSRF is refused before a socket is opened", () => {
  it("refuses loopback, metadata and internal service names without resolving anything", async () => {
    const resolve = vi.fn(async () => [PUBLIC_IP]);
    for (const [url, reason] of [
      ["https://localhost/hook", "forbidden_host"],
      ["https://metadata.google.internal/computeMetadata/v1/", "forbidden_host"],
      ["https://agent-api/hook", "forbidden_host"],
      // The cloud metadata address is refused by name *and* would be refused as a literal: both layers hold.
      ["https://169.254.169.254/latest/meta-data/", "forbidden_host"],
      ["https://127.0.0.1/hook", "address_literal_not_allowed"],
      ["https://10.0.0.5/hook", "address_literal_not_allowed"],
      ["https://singlelabel/hook", "single_label_host"],
      ["ftp://hooks.example.com/hook", "scheme_not_allowed"],
    ] as const) {
      const result = await destinationError(() => validateWebhookDestination(url, { resolve, allowInsecureHttp: false }));
      expect(`${url} -> ${result.code}/${result.reason}`).toBe(`${url} -> webhook_destination_blocked/${reason}`);
    }
    // Not one of those destinations was ever resolved, so no DNS traffic left the process either.
    expect(resolve).toHaveBeenCalledTimes(0);
  });

  it("refuses a hostname that resolves into a private, loopback or metadata range on every delivery", async () => {
    for (const address of ["10.1.2.3", "192.168.1.10", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) {
      const result = await destinationError(() =>
        validateWebhookDestination("https://hooks.example.com/npati", { resolve: async () => [address], allowInsecureHttp: false }),
      );
      expect(`${address} -> ${result.reason}`).toBe(`${address} -> private_or_reserved_address`);
    }
    // A mixed answer is a refusal too: one private address is enough to reject the host.
    const mixed = await destinationError(() =>
      validateWebhookDestination("https://hooks.example.com/npati", { resolve: async () => [PUBLIC_IP, "10.0.0.9"], allowInsecureHttp: false }),
    );
    expect(mixed.reason).toBe("private_or_reserved_address");
  });

  it("refuses plain HTTP for a hook destination", async () => {
    const result = await destinationError(() =>
      validateWebhookDestination("http://hooks.example.com/npati", { resolve: async () => [PUBLIC_IP], allowInsecureHttp: false }),
    );
    expect(result.reason).toBe("http_not_allowed");
  });

  it("delivers only after the destination passed, and never on a refused one", async () => {
    const refused = transportPort(200);
    const blocked = await destinationError(() => deliverWebhook("https://169.254.169.254/latest/meta-data/", {
      storedEndpoints: ["https://169.254.169.254/latest/meta-data/"], allowInsecureHttp: false,
      resolve: async () => [PUBLIC_IP], transport: refused, body: "{}",
    }));
    expect(blocked.code).toBe("webhook_destination_blocked");
    expect(refused).toHaveBeenCalledTimes(0);

    const allowed = transportPort(200, JSON.stringify({ warnings: ["ok"] }));
    const delivered = await deliverWebhook("https://hooks.example.com/npati", {
      storedEndpoints: ["https://hooks.example.com/npati"], requireStoredEndpoint: true, allowInsecureHttp: false,
      resolve: async () => [PUBLIC_IP], transport: allowed, body: JSON.stringify({ event: "PreToolUse" }),
    });
    expect(delivered.status).toBe(200);
    expect(delivered.decision.allowed).toBe(true);
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it("never follows a redirect: a webhook cannot be bounced to a second host", async () => {
    expect(WEBHOOK_DELIVERY_MAX_REDIRECTS).toBe(0);
    const transport = transportPort(302, "", { location: "https://evil.example/collect" });
    const result = await destinationError(() => deliverWebhook("https://hooks.example.com/npati", {
      storedEndpoints: ["https://hooks.example.com/npati"], allowInsecureHttp: false,
      resolve: async () => [PUBLIC_IP], transport, body: "{}",
    }));
    expect(result.reason).toBe("redirect_refused");
    // Exactly one request: the redirect target was never contacted.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("still passes the outbound exfiltration guard, so a credential in the body is refused", () => {
    // The guard is the same call `deliverWebhook` makes before the socket, tested directly because it is the
    // refusal that must survive: a webhook delivers to a third party, so a secret is a deny, not a redaction.
    let code = "none";
    try {
      assertOutboundAllowed({ channel: "webhook", parts: [{ kind: "url", value: "https://hooks.example.com/npati" }, { kind: "text", value: `{"note":"${GHP}"}` }] });
    } catch (error) {
      code = (error as { code?: string }).code ?? "unknown";
    }
    expect(code).not.toBe("none");
    // The metadata-only body a hook really sends is not refused: the guard is not a blanket block.
    const allowed = assertOutboundAllowed({
      channel: "webhook",
      parts: [{ kind: "url", value: "https://hooks.example.com/npati" }, { kind: "text", value: '{"event":"PreToolUse","tool":"code.fs.read"}' }],
    });
    expect(allowed.decision).toBe("allow");
  });
});

describe("[C13] [security-gate] webhook hooks — the transport is the only way out", () => {
  function webhookHarness(options: { config?: unknown; body?: string; status?: number; withPort?: boolean } = {}) {
    const deliver = vi.fn(async () => ({ status: options.status ?? 200, body: options.body ?? JSON.stringify({ warnings: ["from the endpoint"] }) }));
    const service = new CodeHooksService({
      bus: new AgentLifecycleHookManager(),
      flags: { isEnabled: async () => true },
      trust: { isTrusted: async () => true },
      readConfig: async () => options.config ?? null,
      ...(options.withPort === false ? {} : { webhook: { deliver: deliver as unknown as NonNullable<CodeHooksDeps["webhook"]>["deliver"] } }),
    });
    return { service, deliver };
  }

  it("sends a metadata-only body and reads the result from the endpoint's answer", async () => {
    const h = webhookHarness({
      config: { hooks: [{ id: "notify", event: "PostToolUse", type: "webhook", url: "https://hooks.example.com/npati", timeoutMs: 5_000 }] },
    });
    const outcome = await h.service.postToolUse({
      ctx: owner, companyId: "company-c13", projectId: "project-c13", sessionId: "session-c13",
      tool: "code.fs.write", toolCallId: "call-1", paths: ["src/orders.ts"],
    });
    expect(outcome.executed).toBe(true);
    expect(outcome.warnings).toEqual(["from the endpoint"]);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const request = h.deliver.mock.calls[0]?.[0] as { url: string; body: string; timeoutMs: number; companyId: string; projectId: string };
    expect(request.url).toBe("https://hooks.example.com/npati");
    expect(request.timeoutMs).toBe(5_000);
    // The tenant travels with the delivery, so the existing guard resolves *its* policy.
    expect(request.companyId).toBe("company-c13");
    expect(request.projectId).toBe("project-c13");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({ event: "PostToolUse", hookId: "notify", tool: "code.fs.write" });
    expect(body.paths).toEqual(["src/orders.ts"]);
    // Metadata only: no tool arguments, no file content, no config.
    for (const forbidden of ["args", "content", "command", "prompt", "diff"]) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });

  it("refuses a webhook hook with no transport wired, and treats a non-2xx endpoint as a failure", async () => {
    const unwired = webhookHarness({
      withPort: false,
      config: { hooks: [{ id: "n", event: "PreToolUse", type: "webhook", url: "https://hooks.example.com/x" }] },
    });
    const refused = await unwired.service.preToolUse({ ctx: owner, companyId: "c", projectId: "p", tool: "code.fs.read", toolCallId: "t" });
    expect(refused.executed).toBe(false);
    expect(refused.blocked).toBe(false);
    expect(refused.refusals).toContain("hook_transport_unavailable");

    const failing = webhookHarness({
      status: 500,
      config: { hooks: [{ id: "n", event: "PreToolUse", type: "webhook", url: "https://hooks.example.com/x" }] },
    });
    const failed = await failing.service.preToolUse({ ctx: owner, companyId: "c", projectId: "p", tool: "code.fs.read", toolCallId: "t" });
    // A failing endpoint is a reported failure, never a block: a broken notifier cannot refuse work.
    expect(failed.blocked).toBe(false);
    expect(failed.executed).toBe(false);
    expect(failed.refusals).toContain("hook_executor_failed");
  });

  it("cannot reach egress by itself (source guard): one port, no client of its own", () => {
    const source = readFileSync(new URL("../apps/agent-api/src/code-hooks.ts", import.meta.url), "utf8");
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    for (const forbidden of ["node:http", "node:https", "node:net", "node:dns", "axios", "undici", "XMLHttpRequest"]) {
      expect(source.includes(forbidden)).toBe(false);
    }
    // The URL is used exactly once, as an argument to the injected port.
    const deliverCall = source.indexOf("await webhook.deliver({");
    expect(deliverCall).toBeGreaterThan(0);
    expect(source.indexOf("url: entry.url!")).toBeGreaterThan(deliverCall);
    // And the existing delivery path keeps its own guard: the hook cannot skip C4b by construction.
    const policy = readFileSync(new URL("../apps/agent-api/src/webhook-destination-policy.ts", import.meta.url), "utf8");
    expect(policy.includes("assertWebhookDeliveryAllowed(input, options)")).toBe(true);
    expect(policy.includes("assertOutboundAllowed({")).toBe(true);
    expect(policy.includes("maxRedirects: WEBHOOK_DELIVERY_MAX_REDIRECTS")).toBe(true);
  });
});
