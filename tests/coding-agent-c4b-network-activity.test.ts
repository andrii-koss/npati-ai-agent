import { describe, expect, it, vi } from "vitest";
import {
  NetworkActivityRecorder, assertNoSensitiveNetworkPayload, emptySummary, redactNetworkDecision, stripQuery,
  type NetworkDecisionEvent,
} from "../apps/agent-api/src/network-activity";

const NOW = "2026-10-05T12:00:00.000Z";

function baseEvent(overrides: Partial<Omit<NetworkDecisionEvent, "kind" | "at">> = {}) {
  return {
    companyId: "company-1",
    projectId: "project-1",
    sessionId: "session-1",
    phase: "install" as const,
    host: "registry.npmjs.org",
    port: 443,
    protocol: "https" as const,
    action: "allow" as const,
    ...overrides,
  };
}

describe("security-gate: C4b network activity events", () => {
  it("records an allow decision with routing facts and never with request content", async () => {
    const sink = { record: vi.fn() };
    const recorder = new NetworkActivityRecorder({ sink, now: () => new Date(NOW) });
    const event = await recorder.record({ ...baseEvent(), resolvedIp: "104.16.0.1", bytesIn: 2048, bytesOut: 512, durationMs: 137 });

    expect(event).toMatchObject({
      kind: "network_decision", host: "registry.npmjs.org", port: 443, protocol: "https",
      phase: "install", action: "allow", resolvedIp: "104.16.0.1", bytesIn: 2048, bytesOut: 512, durationMs: 137, at: NOW,
    });
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(Object.keys(event).sort()).toEqual([
      "action", "at", "bytesIn", "bytesOut", "companyId", "durationMs", "host", "kind", "phase", "port", "projectId", "protocol", "resolvedIp", "sessionId",
    ]);
  });

  it("records a deny decision with the structured code that is returned to the caller", async () => {
    const recorder = new NetworkActivityRecorder({ now: () => new Date(NOW) });
    const event = await recorder.recordDenied({ ...baseEvent({ host: "169.254.169.254", phase: "run" }) }, "egress_host_not_allowed");
    expect(event).toMatchObject({ action: "deny", code: "egress_host_not_allowed", host: "169.254.169.254", phase: "run" });
    const summary = recorder.summary("company-1");
    expect(summary.denied).toBe(1);
    expect(summary.allowed).toBe(0);
    expect(summary.topDeniedHosts).toEqual([{ host: "169.254.169.254", count: 1 }]);
  });

  it("never carries headers, bodies, query strings or full URLs", async () => {
    const recorder = new NetworkActivityRecorder({ now: () => new Date(NOW) });
    const event = await recorder.record(baseEvent());
    expect(() => assertNoSensitiveNetworkPayload(event)).not.toThrow();
    expect(JSON.stringify(event)).not.toMatch(/https?:\/\//);

    const withHeaders = { ...event, headers: { authorization: "Bearer abc" } } as unknown as NetworkDecisionEvent;
    expect(() => assertNoSensitiveNetworkPayload(withHeaders)).toThrow(/network_decision_must_not_carry/);
    const withBody = { ...event, body: "x" } as unknown as NetworkDecisionEvent;
    expect(() => assertNoSensitiveNetworkPayload(withBody)).toThrow(/network_decision_must_not_carry/);
    const withQuery = { ...event, code: "deny?token=abc" } as unknown as NetworkDecisionEvent;
    expect(() => assertNoSensitiveNetworkPayload(withQuery)).toThrow(/network_decision_must_not_carry_query/);
  });

  it("masks anything secret-shaped before the event leaves the recorder", async () => {
    const recorder = new NetworkActivityRecorder({ now: () => new Date(NOW) });
    const event = await recorder.record(baseEvent({ code: "deny ghp_0123456789abcdefghijklmnopqrstuvwxyz", tool: "code.shell.exec" }));
    expect(event.code).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    expect(event.code).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redactNetworkDecision({ ...baseEvent(), host: "REGISTRY.NPMJS.ORG." }).host).toBe("registry.npmjs.org");
    expect(stripQuery("/tarball?token=abc#frag")).toBe("/tarball");
  });

  it("summarises decisions per company and per phase", async () => {
    const recorder = new NetworkActivityRecorder({ now: () => new Date(NOW) });
    await recorder.record(baseEvent({ bytesIn: 100, bytesOut: 10 }));
    await recorder.record(baseEvent({ phase: "run", host: "github.com", bytesIn: 50 }));
    await recorder.recordDenied(baseEvent({ phase: "run", host: "evil.example" }), "egress_host_not_allowed");
    const summary = recorder.summary("company-1");
    expect(summary).toMatchObject({ allowed: 2, denied: 1, bytesIn: 150, bytesOut: 10 });
    expect(summary.byPhase.install).toEqual({ allowed: 1, denied: 0 });
    expect(summary.byPhase.run).toEqual({ allowed: 1, denied: 1 });
    expect(summary.byPhase.tool).toEqual({ allowed: 0, denied: 0 });
    expect(recorder.summary("other-company")).toEqual(emptySummary());
    expect(recorder.recentEvents("company-1", 10)).toHaveLength(3);
  });

  it("bounds retained events and company counters", async () => {
    const recorder = new NetworkActivityRecorder({ now: () => new Date(NOW), maxCompanies: 2 });
    for (let index = 0; index < 1005; index += 1) await recorder.record(baseEvent({ host: `host-${index}.example` }));
    expect(recorder.recentEvents(undefined, 5000).length).toBeLessThanOrEqual(1000);
    await recorder.record(baseEvent({ companyId: "company-2" }));
    await recorder.record(baseEvent({ companyId: "company-3" }));
    expect(recorder.summary("company-1").allowed).toBe(0);
  });
});
