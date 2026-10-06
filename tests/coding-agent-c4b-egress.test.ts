import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NPATI_EGRESS_TEST = "true";
const {
  publicAddress, isForbiddenAddress, isIpLiteral, normalizeHostname, hostnameAllowed, portAllowed,
  destination, redirectDepthExceeded, resetDnsCache,
} = await import("../apps/agent-api/src/sandbox-egress-proxy.mjs");
const { EgressEnforcement, EgressEnforcementError, resolveEgressEnforcement } = await import("../apps/agent-api/src/sandbox-egress-enforcement");

// The pinning cache is module state shared by every test in this file; each case starts clean so a
// cached address from a previous case cannot mask a denial.
beforeEach(() => resetDnsCache());

const ALLOWLIST = ["registry.npmjs.org", "pypi.org", "github.com", "*.example.com"];
const GIT_HOSTS = ["github.com", "gitlab.com"];

describe("security-gate: C4b egress — IP literal and address classification", () => {
  it("classifies every forbidden IPv4 range and mapped IPv6 as not public", () => {
    for (const address of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.1.2.3",
      "100.64.0.1", "100.127.255.254", "169.254.1.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255",
      "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255",
      "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd00::1",
    ]) expect(isForbiddenAddress(address), address).toBe(true);
    for (const address of ["8.8.8.8", "1.1.1.1", "140.82.121.3", "172.32.0.1", "100.128.0.1"]) expect(isForbiddenAddress(address), address).toBe(false);
  });

  it("keeps the compatibility predicate IPv4-only so IPv6 never authorizes a connection", () => {
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("::1")).toBe(false);
    expect(publicAddress("2001:4860:4860::8888")).toBe(false);
    expect(publicAddress("127.0.0.1")).toBe(false);
  });

  it("detects IP literals in every encoding and refuses them (never allowlisted)", async () => {
    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "127.0.0.1.", "[::ffff:127.0.0.1]", "::1", "169.254.169.254", "0x0a000001"]) {
      expect(isIpLiteral(host), host).toBe(true);
      await expect(destination(host, 443, { allowlist: [...ALLOWLIST, host] })).rejects.toThrow(/ip_literal_not_allowed/);
    }
    expect(isIpLiteral("registry.npmjs.org")).toBe(false);
    expect(isIpLiteral("2130706433a")).toBe(false);
  });

  it("normalizes hostnames and refuses ambiguous or control-character input", () => {
    expect(normalizeHostname(" Registry.NPMJS.org. ")).toBe("registry.npmjs.org");
    expect(normalizeHostname("a\u0000b")).toBeUndefined();
    expect(normalizeHostname("has space.com")).toBeUndefined();
    expect(normalizeHostname("")).toBeUndefined();
    expect(normalizeHostname("x".repeat(300))).toBeUndefined();
  });
});

describe("security-gate: C4b egress — allowlist and ports", () => {
  it("matches exact names and single-level wildcards only, never a suffix lookalike", () => {
    expect(hostnameAllowed("registry.npmjs.org", ALLOWLIST)).toBe(true);
    expect(hostnameAllowed("a.example.com", ALLOWLIST)).toBe(true);
    expect(hostnameAllowed("example.com", ALLOWLIST)).toBe(false);
    expect(hostnameAllowed("a.b.example.com", ALLOWLIST)).toBe(false);
    expect(hostnameAllowed("evil.npmjs.org.attacker.com", ALLOWLIST)).toBe(false);
    expect(hostnameAllowed("npmjs.org.attacker.net", ALLOWLIST)).toBe(false);
    expect(hostnameAllowed("registry.npmjs.org.attacker.net", ALLOWLIST)).toBe(false);
    expect(hostnameAllowed("attacker.com", ALLOWLIST)).toBe(false);
  });

  it("never allows internal service names or metadata hostnames, even if listed", async () => {
    for (const host of ["localhost", "metadata.google.internal", "metadata.goog", "postgres", "postgres-projects", "agent-api", "egress", "sandbox-runner"]) {
      expect(hostnameAllowed(host, [...ALLOWLIST, host]), host).toBe(false);
      await expect(destination(host, 443, { allowlist: [...ALLOWLIST, host] })).rejects.toThrow();
    }
  });

  it("allows 80 and 443 everywhere, and 22 only for allowlisted git hosts", async () => {
    expect(portAllowed("registry.npmjs.org", 443, GIT_HOSTS)).toBe(true);
    expect(portAllowed("registry.npmjs.org", 80, GIT_HOSTS)).toBe(true);
    expect(portAllowed("github.com", 22, GIT_HOSTS)).toBe(true);
    expect(portAllowed("registry.npmjs.org", 22, GIT_HOSTS)).toBe(false);
    expect(portAllowed("registry.npmjs.org", 8080, GIT_HOSTS)).toBe(false);
    expect(portAllowed("registry.npmjs.org", 3306, GIT_HOSTS)).toBe(false);
    await expect(destination("registry.npmjs.org", 8080, { allowlist: ALLOWLIST })).rejects.toThrow(/port_not_allowed/);
  });
});

describe("security-gate: C4b egress — resolution, pinning and rebinding", () => {
  it("denies a hostname that resolves to a private address (localtest.me style)", async () => {
    const resolver = async () => [{ address: "127.0.0.1", ttl: 60 }];
    await expect(destination("pypi.org", 443, { allowlist: ALLOWLIST, resolver })).rejects.toThrow(/address_not_allowed/);
  });

  it("denies the whole name when ANY answer is private, and pins the validated address", async () => {
    const resolver = vi.fn(async () => [{ address: "140.82.121.3", ttl: 60 }, { address: "169.254.169.254", ttl: 60 }]);
    await expect(destination("github.com", 443, { allowlist: ALLOWLIST, resolver })).rejects.toThrow(/address_not_allowed/);
    const mixed = vi.fn(async () => [{ address: "140.82.121.3", ttl: 60 }, { address: "1.1.1.1", ttl: 60 }]);
    const pinned = await destination("github.com", 443, { allowlist: ALLOWLIST, resolver: mixed });
    expect(pinned.address).toBe("140.82.121.3");
    expect(pinned.cached).toBe(false);
  });

  it("defeats DNS rebinding by pinning and by re-validating every connection", async () => {
    let call = 0;
    const rebinding = async () => {
      call += 1;
      return call === 1
        ? [{ address: "140.82.121.3", ttl: 60 }]
        : [{ address: "10.1.2.3", ttl: 60 }];
    };
    const first = await destination("github.com", 443, { allowlist: ALLOWLIST, resolver: rebinding, ignoreCache: true });
    expect(first.address).toBe("140.82.121.3");
    // The record flips to a private address: the next validation refuses instead of connecting there.
    await expect(destination("github.com", 443, { allowlist: ALLOWLIST, resolver: rebinding, ignoreCache: true })).rejects.toThrow(/address_not_allowed/);
  });

  it("serves a short DNS cache and re-resolves when forced", async () => {
    const resolver = vi.fn(async () => [{ address: "140.82.121.3", ttl: 60 }]);
    const now = 1_000_000;
    await destination("github.com", 443, { allowlist: ALLOWLIST, resolver, now: () => now });
    await destination("github.com", 443, { allowlist: ALLOWLIST, resolver, now: () => now + 1_000 });
    expect(resolver).toHaveBeenCalledTimes(1);
    await destination("github.com", 443, { allowlist: ALLOWLIST, resolver, now: () => now + 400_000 });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("denies unresolvable names and non-public answers", async () => {
    await expect(destination("github.com", 443, { allowlist: ALLOWLIST, resolver: async () => [] })).rejects.toThrow(/address_not_allowed/);
    await expect(destination("github.com", 443, { allowlist: ALLOWLIST, resolver: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow(/ENOTFOUND/);
  });
});

describe("security-gate: C4b egress — redirects", () => {
  it("caps the redirect chain at five hops and rejects nonsense depths", () => {
    expect(redirectDepthExceeded(0)).toBe(false);
    expect(redirectDepthExceeded(4)).toBe(false);
    expect(redirectDepthExceeded(5)).toBe(true);
    expect(redirectDepthExceeded(6)).toBe(true);
    expect(redirectDepthExceeded("abc")).toBe(true);
    expect(redirectDepthExceeded(-1)).toBe(true);
  });

  it("re-validates each hop: metadata, loopback and private targets stay blocked", async () => {
    for (const host of ["169.254.169.254", "localhost", "127.0.0.1"]) {
      await expect(destination(host, 80, { allowlist: [...ALLOWLIST, host] })).rejects.toThrow();
    }
    const toPrivate = async () => [{ address: "192.168.1.10", ttl: 30 }];
    await expect(destination("a.example.com", 80, { allowlist: ALLOWLIST, resolver: toPrivate })).rejects.toThrow(/address_not_allowed/);
    const toPublic = async () => [{ address: "93.184.216.34", ttl: 30 }];
    await expect(destination("a.example.com", 80, { allowlist: ALLOWLIST, resolver: toPublic })).resolves.toMatchObject({ address: "93.184.216.34" });
  });
});

describe("security-gate: C4b egress — readiness probe", () => {
  const healthyProbe = () => ({
    proxyHealth: vi.fn(async () => ({ ok: true, detail: "200" })),
    directEgressBlocked: vi.fn(async () => ({ blocked: true, detail: "ECONNREFUSED" })),
    dnsBypassBlocked: vi.fn(async () => ({ blocked: true, detail: "EAI_AGAIN" })),
  });

  it("reports enforced only when proxy, direct egress and DNS are all proven", async () => {
    const probe = healthyProbe();
    const enforcement = new EgressEnforcement({ probe });
    const report = await enforcement.verify();
    expect(report).toMatchObject({ enforced: true });
    expect(await enforcement.isEnforced()).toBe(true);
    await expect(enforcement.assertEnforced()).resolves.toMatchObject({ enforced: true });
  });

  it("fails closed with a structured reason for every unmet condition", async () => {
    const cases: Array<[string, () => Record<string, unknown>]> = [
      ["proxy_unhealthy", () => ({ ...healthyProbe(), proxyHealth: vi.fn(async () => ({ ok: false, detail: "502" })) })],
      ["direct_egress_open", () => ({ ...healthyProbe(), directEgressBlocked: vi.fn(async () => ({ blocked: false, detail: "CONNECTED" })) })],
      ["dns_bypass_open", () => ({ ...healthyProbe(), dnsBypassBlocked: vi.fn(async () => ({ blocked: false, detail: "RESOLVED" })) })],
    ];
    for (const [reason, factory] of cases) {
      const enforcement = new EgressEnforcement({ probe: factory() as never });
      const report = await enforcement.verify();
      expect(report.enforced).toBe(false);
      expect(report.reason).toBe(reason);
      await expect(enforcement.assertEnforced()).rejects.toBeInstanceOf(EgressEnforcementError);
      await enforcement.assertEnforced().catch((error: InstanceType<typeof EgressEnforcementError>) => {
        expect(error.code).toBe("network_enforcement_unavailable");
        expect(error.status).toBe(503);
        expect(error.retryable).toBe(true);
      });
    }
  });

  it("refuses to claim enforcement without a probe or with a broken probe", async () => {
    const withoutProbe = new EgressEnforcement({});
    expect(await withoutProbe.verify()).toMatchObject({ enforced: false, reason: "probe_not_configured" });
    const broken = new EgressEnforcement({ probe: { proxyHealth: vi.fn(async () => { throw new Error("docker_unavailable"); }), directEgressBlocked: vi.fn(), dnsBypassBlocked: vi.fn() } as never });
    expect(await broken.verify()).toMatchObject({ enforced: false, reason: "probe_unavailable" });
  });

  it("never treats NPATI_SANDBOX_EGRESS_ENFORCED=true as proof, and honours false as a kill switch", async () => {
    // The flag plus a passing probe is enforced…
    const withProbe = healthyProbe();
    const enabled = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "true" } as NodeJS.ProcessEnv, { probe: withProbe });
    expect(await enabled.isEnforced()).toBe(true);
    expect(withProbe.proxyHealth).toHaveBeenCalled();

    // …but the flag alone is NOT proof: without a probe the verdict is "no probe configured", never
    // "enforced", and container creation is refused with the structured 503.
    const noProbeButFlag = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "true" } as NodeJS.ProcessEnv, {});
    expect(await noProbeButFlag.verify()).toMatchObject({ enforced: false, reason: "probe_not_configured" });
    await expect(noProbeButFlag.assertEnforced()).rejects.toMatchObject({ code: "network_enforcement_unavailable", status: 503, retryable: true });

    // `false` is the operator kill switch: enforcement is never claimed and the probe is not consulted.
    const killSwitchProbe = healthyProbe();
    const disabled = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "false" } as NodeJS.ProcessEnv, { probe: killSwitchProbe });
    expect(await disabled.verify()).toMatchObject({ enforced: false, reason: "disabled_by_configuration" });
    expect(killSwitchProbe.proxyHealth).not.toHaveBeenCalled();
    expect(killSwitchProbe.directEgressBlocked).not.toHaveBeenCalled();
    expect(await disabled.isEnforced()).toBe(false);
    await expect(disabled.assertEnforced()).rejects.toBeInstanceOf(EgressEnforcementError);
  });

  it("caches the verdict for the TTL and re-probes after it expires or on demand", async () => {
    const probe = healthyProbe();
    let now = 0;
    const enforcement = new EgressEnforcement({ probe, ttlMs: 60_000, now: () => now });
    await enforcement.verify();
    await enforcement.verify();
    expect(probe.proxyHealth).toHaveBeenCalledTimes(1);
    now = 59_000;
    await enforcement.verify();
    expect(probe.proxyHealth).toHaveBeenCalledTimes(1);
    now = 61_000;
    await enforcement.verify();
    expect(probe.proxyHealth).toHaveBeenCalledTimes(2);
    enforcement.invalidate();
    await enforcement.verify();
    expect(probe.proxyHealth).toHaveBeenCalledTimes(3);
  });
});
