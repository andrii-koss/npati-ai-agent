import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { PolicyEngine, type PolicyEngineDeps } from "../apps/agent-api/src/code-policy-engine";
import { EgressEnforcement } from "../apps/agent-api/src/sandbox-egress-enforcement";
import { authenticateRunnerRequest, createRunnerReadiness, signRunnerRequest, type RunnerReadinessReport } from "../apps/agent-api/src/runner-readiness";
import { RunnerReadinessClient, resolveRunnerReadinessTtl } from "../apps/agent-api/src/sandbox-runner-readiness-client";

const SECRET = "r".repeat(48);
const owner: AuthContext = { workspaceId: "ws-c4b-r", userId: "user-owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };

function authHeaders(body: string, overrides: Record<string, string | undefined> = {}, now = Date.now()) {
  const headers = signRunnerRequest({ secret: SECRET, body, timestamp: now });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

function auth(body: string, headers: Record<string, string | string[] | undefined>, seen = new Map<string, number>(), now = Date.now()) {
  return authenticateRunnerRequest({ headers, body, secret: SECRET, seen, now });
}

/** Readiness report as the runner endpoint returns it. */
function report(overrides: Partial<RunnerReadinessReport> = {}): RunnerReadinessReport {
  const base: RunnerReadinessReport = {
    docker_ready: true, egress_proxy_ready: true, network_policy_ready: true, dns_policy_ready: true,
    required_images_ready: true, overall_ready: true, reasons: [], details: {}, checkedAt: Date.now(),
  };
  return { ...base, ...overrides };
}

function client(transport: typeof fetch, options: Record<string, unknown> = {}) {
  return new RunnerReadinessClient({ baseUrl: "http://runner:7865", secret: SECRET, transport, now: () => 1_000_000, ...options });
}

describe("security-gate: C4b runner readiness endpoint authentication", () => {
  it("refuses a request without credentials and returns no readiness data", () => {
    const body = "{}";
    expect(auth(body, {})).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
    expect(auth(body, authHeaders(body, { "x-npati-signature": undefined }))).toMatchObject({ ok: false, status: 401 });
    expect(auth(body, authHeaders(body, { "x-npati-nonce": undefined }))).toMatchObject({ ok: false, status: 401 });
    expect(auth(body, authHeaders(body, { "x-npati-timestamp": undefined }))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a wrong signature, a stale timestamp, a replayed nonce and a short secret", () => {
    const body = "{}";
    expect(auth(body, authHeaders(body, { "x-npati-signature": "a".repeat(64) }))).toMatchObject({ ok: false, status: 401 });
    const stale = Date.now() - 60_000;
    expect(auth(body, authHeaders(body, {}, stale))).toMatchObject({ ok: false, status: 401 });
    const headers = authHeaders(body);
    const seen = new Map<string, number>();
    expect(auth(body, headers, seen).ok).toBe(true);
    expect(auth(body, headers, seen)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateRunnerRequest({ headers: authHeaders(body), body, secret: "short", seen: new Map() }))
      .toMatchObject({ ok: false, status: 503, code: "runner_auth_not_configured" });
  });

  it("accepts a correctly signed request and records the nonce", () => {
    const body = "{}";
    const seen = new Map<string, number>();
    expect(auth(body, authHeaders(body), seen).ok).toBe(true);
    expect(seen.size).toBe(1);
  });
});

describe("security-gate: C4b runner readiness facts", () => {
  const enforcement = (result: { proxy: boolean; direct: boolean; dns: boolean }) => new EgressEnforcement({
    probe: {
      proxyHealth: async () => ({ ok: result.proxy, detail: result.proxy ? "healthy" : "no answer" }),
      directEgressBlocked: async () => ({ blocked: result.direct, detail: result.direct ? "blocked" : "open" }),
      dnsBypassBlocked: async () => ({ blocked: result.dns, detail: result.dns ? "blocked" : "open" }),
    },
    now: () => 1_000_000,
  });

  it("reports all six facts separately and is ready only when every one is proven", async () => {
    const docker = async (args: string[]) => ({ ok: true, output: args[1] === "inspect" ? "sha256:abc" : "24.0.0" });
    const readiness = createRunnerReadiness({ docker, enforcement: enforcement({ proxy: true, direct: true, dns: true }), images: { sandbox: "npati/project-sandbox:local", egressProxy: "npati/sandbox-egress:local" }, now: () => 1_000_000 });
    const result = await readiness.collect(true);
    expect(result).toMatchObject({
      docker_ready: true, egress_proxy_ready: true, network_policy_ready: true, dns_policy_ready: true,
      required_images_ready: true, overall_ready: true, reasons: [],
    });
  });

  it("fails closed per fact: docker, images, proxy, direct egress and DNS each flip only their own field", async () => {
    const dockerOk = async () => ({ ok: true, output: "24.0.0" });
    const cases: Array<{ name: string; docker?: typeof dockerOk; images?: { sandbox?: string; egressProxy?: string }; probe: { proxy: boolean; direct: boolean; dns: boolean }; field: keyof RunnerReadinessReport; reason: string }> = [
      { name: "docker down", docker: async () => ({ ok: false, output: "daemon down" }), probe: { proxy: true, direct: true, dns: true }, field: "docker_ready", reason: "docker_unavailable" },
      { name: "image missing", probe: { proxy: true, direct: true, dns: true }, field: "required_images_ready", reason: "required_image_missing:npati/sandbox-egress:local" },
      { name: "proxy unhealthy", probe: { proxy: false, direct: true, dns: true }, field: "egress_proxy_ready", reason: "egress_proxy_unhealthy" },
      { name: "direct egress open", probe: { proxy: true, direct: false, dns: true }, field: "network_policy_ready", reason: "direct_egress_open" },
      { name: "dns bypass open", probe: { proxy: true, direct: true, dns: false }, field: "dns_policy_ready", reason: "dns_bypass_open" },
    ];
    for (const entry of cases) {
      const docker = entry.docker ?? (async (args: string[]) => ({ ok: entry.name !== "image missing" || args[1] !== "inspect" || !String(args[2]).includes("egress"), output: "ok" }));
      const readiness = createRunnerReadiness({ docker, enforcement: enforcement(entry.probe), images: { sandbox: "npati/project-sandbox:local", egressProxy: "npati/sandbox-egress:local" }, now: () => 1_000_000 });
      const result = await readiness.collect(true);
      expect(result.overall_ready, entry.name).toBe(false);
      expect(result[entry.field], entry.name).toBe(false);
      expect(result.reasons, entry.name).toContain(entry.reason);
    }
  });

  it("treats a missing probe or a disabled feature as not enforced", async () => {
    const noProbe = new EgressEnforcement({ now: () => 1_000_000 });
    const disabled = new EgressEnforcement({ enabled: false, probe: { proxyHealth: async () => ({ ok: true }), directEgressBlocked: async () => ({ blocked: true }), dnsBypassBlocked: async () => ({ blocked: true }) }, now: () => 1_000_000 });
    const docker = async () => ({ ok: true, output: "ok" });
    const images = { sandbox: "a", egressProxy: "b" };
    expect((await createRunnerReadiness({ docker, enforcement: noProbe, images }).collect(true)).overall_ready).toBe(false);
    const disabledReport = await createRunnerReadiness({ docker, enforcement: disabled, images }).collect(true);
    expect(disabledReport.overall_ready).toBe(false);
    expect(disabledReport.reasons.some((value) => value.includes("disabled_by_configuration"))).toBe(true);
  });
});

describe("security-gate: C4b runner readiness client", () => {
  it("is ready only for an overall_ready report and fails closed on any other answer", async () => {
    const ready = client(async () => new Response(JSON.stringify(report()), { status: 200 }));
    expect(await ready.isReady()).toBe(true);
    expect(ready.isReadySync()).toBe(true);

    const notReady = client(async () => new Response(JSON.stringify(report({ overall_ready: false, network_policy_ready: false, reasons: ["direct_egress_open"] })), { status: 200 }));
    expect(await notReady.isReady()).toBe(false);
    await expect(notReady.assertReady()).rejects.toMatchObject({ code: "network_enforcement_unavailable", status: 503, retryable: true });

    for (const transport of [
      async () => { throw new Error("connect ECONNREFUSED"); },
      async () => new Response("nope", { status: 500 }),
      async () => new Response(JSON.stringify({ docker_ready: true }), { status: 200 }),
    ]) {
      const failing = client(transport as unknown as typeof fetch);
      expect(await failing.isReady()).toBe(false);
      await expect(failing.assertReady()).rejects.toMatchObject({ code: "network_enforcement_unavailable", status: 503 });
    }
  });

  it("never treats the enforcement flag as proof: it can only disable", async () => {
    let calls = 0;
    const transport = (async () => { calls += 1; throw new Error("runner down"); }) as unknown as typeof fetch;
    const withFlagOn = client(transport, { enabled: true });
    expect(await withFlagOn.isReady()).toBe(false);
    await expect(withFlagOn.assertReady()).rejects.toMatchObject({ code: "network_enforcement_unavailable" });

    const disabled = client(transport, { enabled: false });
    const state = await disabled.check(true);
    expect(state).toMatchObject({ available: false, ready: false, reason: "disabled_by_configuration" });
    expect(calls).toBe(1);
  });

  it("caches the verdict for a short TTL and clamps the TTL to at most 30 seconds", async () => {
    let calls = 0;
    let clock = 5_000_000;
    const transport = (async () => { calls += 1; return new Response(JSON.stringify(report()), { status: 200 }); }) as unknown as typeof fetch;
    const cached = new RunnerReadinessClient({ baseUrl: "http://runner:7865", secret: SECRET, transport, now: () => clock, ttlMs: 15_000 });
    await cached.check();
    await cached.check();
    expect(calls).toBe(1);
    clock += 15_001;
    await cached.check();
    expect(calls).toBe(2);
    expect(cached.ttlMs).toBe(15_000);
    expect(new RunnerReadinessClient({ secret: SECRET, ttlMs: 999_999 }).ttlMs).toBe(30_000);
    expect(new RunnerReadinessClient({ secret: SECRET }).ttlMs).toBe(15_000);
    expect(resolveRunnerReadinessTtl({ NPATI_SANDBOX_RUNNER_READINESS_TTL_MS: "60000" } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(resolveRunnerReadinessTtl({} as NodeJS.ProcessEnv)).toBe(15_000);
  });

  it("refuses to answer without a runner URL or with a short secret", async () => {
    const noRunner = new RunnerReadinessClient({ secret: SECRET });
    expect(await noRunner.isReady()).toBe(false);
    await expect(noRunner.assertReady()).rejects.toMatchObject({ code: "network_enforcement_unavailable" });
    const shortSecret = new RunnerReadinessClient({ baseUrl: "http://runner:7865", secret: "short" });
    expect(await shortSecret.isReady()).toBe(false);
  });
});

describe("security-gate: C4b readiness drives the PolicyEngine network phase", () => {
  function engine(networkEnforcement: () => boolean) {
    const deps: PolicyEngineDeps = {
      flags: { async assertEnabled() { return true; } },
      capabilities: { get: (id: string) => ({ id, status: "active" as const, version: 1 }) },
      classifier: () => ({ risk: "controlled" as const }),
      networkEnforcement,
    };
    return new PolicyEngine(deps);
  }

  it("denies network commands while the runner is not ready, even when the flag is on", async () => {
    const notReady = client(async () => new Response(JSON.stringify(report({ overall_ready: false }) ), { status: 200 }), { enabled: true });
    await notReady.check(true);
    const result = await engine(() => notReady.isReadySync()).evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad", sessionMode: "auto" });
    expect(result).toMatchObject({ decision: "deny", code: "network_enforcement_unavailable", phase: "network_enforcement" });
  });

  it("lets a network command through the network gate once the runner proves readiness", async () => {
    const ready = client(async () => new Response(JSON.stringify(report()), { status: 200 }), { enabled: true });
    await ready.check(true);
    const result = await engine(() => ready.isReadySync()).evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad", sessionMode: "auto" });
    expect(result.decision).not.toBe("deny");
    expect(result.phase).not.toBe("network_enforcement");
  });
  it("asks again after a timeout before the verdict is lost", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(report({ overall_ready: true })), { status: 200 }));
    const readiness = new RunnerReadinessClient({ baseUrl: "http://sandbox-runner:7865", secret: "x".repeat(32), attempts: 3, transport });
    expect((await readiness.check(true)).ready).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
