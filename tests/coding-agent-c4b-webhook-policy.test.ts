import { describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_ALLOWED_PORTS,
  WEBHOOK_DELIVERY_MAX_REDIRECTS,
  WebhookDestinationError,
  assertWebhookDeliveryAllowed,
  deliverWebhook,
  findStoredEndpoint,
  sameWebhookEndpoint,
  validateWebhookDestination,
  webhookEndpointIdentity,
} from "../apps/agent-api/src/webhook-destination-policy";
import type { SsrfTransportRequest, SsrfTransportResponse } from "../apps/agent-api/src/ssrf-safe-http";

const PUBLIC_IP = "93.184.216.34";
const STORED = "https://hooks.example.com/events";

function resolverFor(map: Record<string, string[]>) {
  const resolve = vi.fn(async (host: string) => {
    const answers = map[host.toLowerCase()];
    if (!answers) throw new Error(`ENOTFOUND ${host}`);
    return answers;
  });
  return { resolve, calls: resolve.mock.calls };
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { /* no body */ } };
}

function transportReturning(status: number, headers: Record<string, string> = {}) {
  const calls: SsrfTransportRequest[] = [];
  const transport = async (request: SsrfTransportRequest): Promise<SsrfTransportResponse> => {
    calls.push(request);
    return { status, headers, body: emptyBody() };
  };
  return { transport, calls };
}

describe("security-gate: C4b webhook destination policy", () => {
  it("refuses a destination that is not a stored endpoint", async () => {
    const { resolve } = resolverFor({ "other.example.com": [PUBLIC_IP] });
    await expect(
      assertWebhookDeliveryAllowed("https://other.example.com/events", { resolve, storedEndpoints: [STORED] }),
    ).rejects.toMatchObject({ code: "webhook_destination_blocked", reason: "not_a_stored_endpoint" });
  });

  it("requires a stored endpoint for delivery even when none were provided at all", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    await expect(assertWebhookDeliveryAllowed(STORED, { resolve })).rejects.toMatchObject({ reason: "not_a_stored_endpoint" });
  });

  it("allows a stored public endpoint and returns the pinned address", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    const verdict = await assertWebhookDeliveryAllowed(STORED, { resolve, storedEndpoints: [STORED] });
    expect(verdict.identity).toEqual({ scheme: "https", host: "hooks.example.com", port: 443 });
    expect(verdict.ip).toBe(PUBLIC_IP);
    expect(verdict.storedEndpoint).toBe(STORED);
  });

  it("refuses loopback, metadata, internal names and encoded literals at save and at delivery", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    const blocked = [
      "http://127.0.0.1/hook",
      "http://169.254.169.254/hook",
      "http://localhost/hook",
      "http://postgres/hook",
      "http://agent-api/hook",
      "http://docker-internal/hook",
      "http://08.0.0.1/hook",
      "http://010.0.0.1/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://2130706433/hook",
      "http://0x7f000001/hook",
    ];
    for (const url of blocked) {
      const save = await validateWebhookDestination(url, { resolve, allowInsecureHttp: true }).catch((error: unknown) => error);
      expect(save, url).toBeInstanceOf(WebhookDestinationError);
      const delivery = await assertWebhookDeliveryAllowed(url, { resolve, storedEndpoints: [url], allowInsecureHttp: true }).catch((error: unknown) => error);
      expect(delivery, url).toBeInstanceOf(WebhookDestinationError);
      // No DNS lookup may happen for a literal or an internal name: the target never becomes a request.
      expect(resolve.mock.calls.some(([host]) => host === "hooks.example.com" && url.includes("hooks")), url).toBe(false);
    }
  });

  it("re-validates DNS on every delivery: a host that moved to a private address is blocked", async () => {
    const first = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    await expect(validateWebhookDestination(STORED, { resolve: first.resolve })).resolves.toMatchObject({ ip: PUBLIC_IP });

    const second = resolverFor({ "hooks.example.com": ["127.0.0.1"] });
    await expect(
      assertWebhookDeliveryAllowed(STORED, { resolve: second.resolve, storedEndpoints: [STORED] }),
    ).rejects.toMatchObject({ reason: "private_or_reserved_address" });
  });

  it("blocks delivery when any resolved address is private", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP, "10.0.0.5"] });
    await expect(
      assertWebhookDeliveryAllowed(STORED, { resolve, storedEndpoints: [STORED] }),
    ).rejects.toMatchObject({ reason: "private_or_reserved_address" });
  });

  it("matches scheme, hostname and port exactly, so a changed scheme or port is refused", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    for (const candidate of ["http://hooks.example.com/events", "https://hooks.example.com:8443/events", "https://hooks.example.com.evil.test/events"]) {
      await expect(
        assertWebhookDeliveryAllowed(candidate, { resolve, storedEndpoints: [STORED], allowInsecureHttp: true }),
      ).rejects.toBeInstanceOf(WebhookDestinationError);
    }
    // The stored identity is scheme + host + port only, so a different path is still the same endpoint.
    expect(findStoredEndpoint("https://hooks.example.com/other", [STORED])).toBe(STORED);
    expect(sameWebhookEndpoint(webhookEndpointIdentity(STORED), webhookEndpointIdentity("https://hooks.example.com/x"))).toBe(true);
  });

  it("refuses plain HTTP for an ad-hoc destination but honours an operator-stored http endpoint", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    await expect(validateWebhookDestination("http://hooks.example.com/events", { resolve }))
      .rejects.toMatchObject({ reason: "http_not_allowed" });
    await expect(validateWebhookDestination("http://hooks.example.com/events", { resolve, allowInsecureHttp: true }))
      .resolves.toMatchObject({ identity: { scheme: "http", port: 80 } });
  });

  it("never follows redirects: a redirect to a private target is refused", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    const { transport, calls } = transportReturning(302, { location: "http://169.254.169.254/latest/meta-data" });
    await expect(
      deliverWebhook(STORED, { resolve, storedEndpoints: [STORED], transport, body: "{}" }),
    ).rejects.toMatchObject({ reason: "redirect_refused" });
    expect(calls).toHaveLength(1);

    const allowedRedirect = transportReturning(301, { location: "https://other.example.com/events" });
    await expect(
      deliverWebhook(STORED, { resolve, storedEndpoints: [STORED], transport: allowedRedirect.transport }),
    ).rejects.toMatchObject({ reason: "redirect_refused" });
    expect(allowedRedirect.calls).toHaveLength(1);
  });

  it("sends delivery through the shared SSRF-safe client with the pinned address", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    const { transport, calls } = transportReturning(200);
    const result = await deliverWebhook(STORED, { resolve, storedEndpoints: [STORED], transport, body: "{}", headers: { "content-type": "application/json" } });
    expect(result.status).toBe(200);
    expect(WEBHOOK_DELIVERY_MAX_REDIRECTS).toBe(0);
    expect(calls).toHaveLength(1);
    // Pinned IP with the original hostname preserved for TLS/SNI, i.e. the shared client did the work.
    expect(calls[0]!.ip).toBe(PUBLIC_IP);
    expect(calls[0]!.servername).toBe("hooks.example.com");
    expect(calls[0]!.url.hostname).toBe("hooks.example.com");
  });

  it("validates before it opens a socket, so a blocked target never reaches the transport", async () => {
    const { resolve } = resolverFor({ "hooks.example.com": ["127.0.0.1"] });
    const { transport, calls } = transportReturning(200);
    await expect(
      deliverWebhook(STORED, { resolve, storedEndpoints: [STORED], transport }),
    ).rejects.toMatchObject({ reason: "private_or_reserved_address" });
    expect(calls).toHaveLength(0);
  });

  it("keeps a conservative port policy", () => {
    expect([...WEBHOOK_ALLOWED_PORTS].sort((a, b) => a - b)).toEqual([80, 443]);
    expect(() => webhookEndpointIdentity("https://hooks.example.com:8443/events")).toThrowError(
      expect.objectContaining({ reason: "port_not_allowed" }),
    );
  });

  it("refuses URLs with credentials and non-http schemes", () => {
    expect(() => webhookEndpointIdentity("https://user:pass@hooks.example.com/events"))
      .toThrowError(expect.objectContaining({ reason: "credentials_not_allowed" }));
    expect(() => webhookEndpointIdentity("ftp://hooks.example.com/events"))
      .toThrowError(expect.objectContaining({ reason: "scheme_not_allowed" }));
    expect(() => webhookEndpointIdentity("file:///etc/passwd"))
      .toThrowError(expect.objectContaining({ reason: "scheme_not_allowed" }));
  });

  it("is wired into the outbound dispatcher at save and delivery", async () => {
    const { OutboundWebhookDispatcher } = await import("../apps/agent-api/src/outbound-webhook-dispatcher");
    const { resolve } = resolverFor({ "hooks.example.com": [PUBLIC_IP] });
    const dispatcher = new OutboundWebhookDispatcher(undefined, { resolve });

    await expect(dispatcher.registerSubscription({ companyId: "c1", url: "http://127.0.0.1/hook", secret: "s" }))
      .rejects.toMatchObject({ code: "webhook_destination_blocked" });
    // A destination that already resolves privately can never be stored at all.
    const privateAtSave = new OutboundWebhookDispatcher(undefined, { resolve: async () => ["10.1.2.3"] });
    await expect(privateAtSave.registerSubscription({ companyId: "c1", url: STORED, secret: "s" }))
      .rejects.toMatchObject({ reason: "private_or_reserved_address" });

    await expect(dispatcher.registerSubscription({ companyId: "c1", url: STORED, secret: "s" })).resolves.toMatchObject({ url: STORED });

    // The host is public at save and moves to a private address afterwards: delivery must refuse it.
    let phase: "public" | "private" = "public";
    const flipping = new OutboundWebhookDispatcher(undefined, { resolve: async () => (phase === "public" ? [PUBLIC_IP] : ["10.1.2.3"]) });
    await flipping.registerSubscription({ companyId: "c2", url: STORED, secret: "s" });
    phase = "private";
    const sender = vi.fn(async () => 200);
    const results = await flipping.dispatchEvent("c2", "agent.task_completed", {}, sender);
    expect(sender).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ delivered: false, url: STORED });
    expect(results[0]!.error).toMatch(/private_or_reserved_address/);
  });
});
