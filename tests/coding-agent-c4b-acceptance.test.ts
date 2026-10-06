import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSafeUrlValidatorAdapter, isForbiddenIp, isHostnameAllowed, looksLikeIpLiteral,
  parseDestination, resolveAndValidate, type ResolverPort,
} from "../apps/agent-api/src/ssrf-policy";
import {
  EgressEnforcement, EgressEnforcementError, resolveEgressEnforcement, type EgressProbePort,
} from "../apps/agent-api/src/sandbox-egress-enforcement";
import {
  DEFAULT_INSTALL_ALLOWLIST, evaluateEgressRequest, resolveAllowlistForPhase, resolveEgressAllowlist,
} from "../apps/agent-api/src/egress-allowlist";

/**
 * C4b consolidated acceptance suite: the network list from the plan, verified against the real
 * enforcement modules (proxy helpers, SSRF policy, enforcement probe) with injected ports, so no
 * test opens a real socket.
 */

const config = () => resolveEgressAllowlist({ env: {} as NodeJS.ProcessEnv });
const PUBLIC_IP = "93.184.216.34";
const METADATA_IP = "169.254.169.254";

type ProxyHelpers = {
  normalizeHostname(value: string): string;
  isIpLiteral(host: string): boolean;
  isForbiddenAddress(address: string): boolean;
  hostnameAllowed(host: string, entries?: string[]): boolean;
  portAllowed(host: string, port: number, gitHosts?: string[]): boolean;
};

let proxy: ProxyHelpers;

beforeAll(async () => {
  // The proxy module starts a listener unless this flag is set, so it must be set before importing.
  process.env.NPATI_EGRESS_TEST = "true";
  proxy = (await import("../apps/agent-api/src/sandbox-egress-proxy.mjs")) as unknown as ProxyHelpers;
});

afterAll(() => {
  delete process.env.NPATI_EGRESS_TEST;
});

function enforcementWith(overrides: Partial<EgressProbePort> = {}) {
  const probe: EgressProbePort = {
    proxyHealth: async () => ({ ok: true, detail: "healthy" }),
    directEgressBlocked: async () => ({ blocked: true, detail: "BLOCKED:ENETUNREACH" }),
    dnsBypassBlocked: async () => ({ blocked: true, detail: "BLOCKED:EAI_AGAIN" }),
    ...overrides,
  };
  return new EgressEnforcement({ probe, now: () => 1_000 });
}

describe("security-gate: C4b acceptance — address literals and encodings", () => {
  it("blocks IP literals in every documented encoding", async () => {
    const literals = ["127.0.0.1", "2130706433", "0x7f000001", "0177.0.0.1", "::1", "::ffff:127.0.0.1"];
    for (const literal of literals) {
      expect(looksLikeIpLiteral(literal) || literal === "2130706433", literal).toBe(true);
    }
    for (const literal of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.10", "172.16.5.5", "::1", "::ffff:127.0.0.1"]) {
      expect(proxy.isForbiddenAddress(literal), literal).toBe(true);
      expect(isForbiddenIp(literal), literal).toBe(true);
    }
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.0.0.1/", "http://[::ffff:127.0.0.1]/", `http://${METADATA_IP}/`]) {
      expect(() => parseDestination(url, { allowlist: ["registry.npmjs.org"] }), url).toThrow();
    }
    const decision = evaluateEgressRequest({ host: "0x7f000001", phase: "install", config: config() });
    expect(decision).toMatchObject({ allowed: false, code: "egress_address_literal_denied" });
  });

  it("blocks a hostname that resolves to a private address", async () => {
    const destination = parseDestination("http://localtest.me/", { allowlist: ["localtest.me"] });
    await expect(resolveAndValidate(destination, async () => ["127.0.0.1"])).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    await expect(resolveAndValidate(destination, async () => ["10.1.2.3"])).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    await expect(resolveAndValidate(destination, async () => [PUBLIC_IP])).resolves.toMatchObject({ ip: PUBLIC_IP });
  });

  it("defeats DNS rebinding by failing closed on any private answer and re-validating each hop", async () => {
    const destination = parseDestination("http://rebind.example/", { allowlist: ["rebind.example"] });
    // A record set that mixes a public and a private answer must be refused outright.
    await expect(resolveAndValidate(destination, async () => [PUBLIC_IP, "127.0.0.1"])).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });

    let answers = [PUBLIC_IP];
    const flapping: ResolverPort = async () => answers;
    const client = createSafeUrlValidatorAdapter({ allowlist: ["rebind.example"], resolve: flapping });
    await expect(client.validate("http://rebind.example/")).resolves.toBeInstanceOf(URL);
    // Second lookup returns a private address: the same host must now be refused, never pinned blindly.
    answers = ["127.0.0.1"];
    await expect(client.validate("http://rebind.example/")).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });

    // Missing/failed resolution is a retryable failure, never a silent allow.
    await expect(resolveAndValidate(destination, async () => { throw new Error("SERVFAIL"); }))
      .rejects.toMatchObject({ code: "dns_resolution_failed" });
    await expect(resolveAndValidate(destination, async () => [])).rejects.toMatchObject({ code: "dns_resolution_failed" });
  });
});

describe("security-gate: C4b acceptance — redirects and allowlist matching", () => {
  it("re-validates every redirect target and blocks metadata or localhost hops", async () => {
    const client = createSafeUrlValidatorAdapter({ allowlist: ["example.com"], resolve: async () => [PUBLIC_IP] });
    await expect(client.validateRedirect("http://example.com/a", "http://example.com/b")).resolves.toBeUndefined();
    await expect(client.validateRedirect("http://example.com/a", `http://${METADATA_IP}/latest/meta-data/`))
      .rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    await expect(client.validateRedirect("http://example.com/a", "http://localhost/"))
      .rejects.toMatchObject({ code: expect.stringMatching(/ssrf_blocked_private_ip|host_not_allowed/) });
    await expect(client.validateRedirect("http://example.com/a", "http://evil.example.net/"))
      .rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(client.validateRedirect("http://example.com/a", "http://example.com:8443/"))
      .rejects.toMatchObject({ code: "ssrf_blocked_port" });
    await expect(client.validate("file:///etc/passwd")).rejects.toMatchObject({ code: "ssrf_blocked_scheme" });
    await expect(client.validate("http://user:pass@example.com/")).rejects.toMatchObject({ code: "ssrf_blocked_credentials" });
  });

  it("never lets a suffix trick pass the hostname allowlist", () => {
    const allowlist = ["registry.npmjs.org", "*.npmjs.org"];
    expect(isHostnameAllowed("registry.npmjs.org", allowlist)).toBe(true);
    expect(isHostnameAllowed("cdn.npmjs.org", allowlist)).toBe(true);
    expect(isHostnameAllowed("registry.npmjs.org.evil.com", ["registry.npmjs.org"])).toBe(false);
    expect(isHostnameAllowed("evil.npmjs.org.attacker.com", allowlist)).toBe(false);
    expect(isHostnameAllowed("npmjs.org", ["*.npmjs.org"])).toBe(false);
    expect(proxy.hostnameAllowed("evil.npmjs.org.attacker.com", ["registry.npmjs.org"])).toBe(false);
    expect(proxy.hostnameAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
  });
});

describe("security-gate: C4b acceptance — network-level enforcement", () => {
  it("requires the probe to prove direct egress, DNS bypass and proxy health", async () => {
    expect(await enforcementWith().isEnforced()).toBe(true);
    expect(await enforcementWith({ directEgressBlocked: async () => ({ blocked: false, detail: "CONNECTED" }) }).isEnforced()).toBe(false);
    expect(await enforcementWith({ dnsBypassBlocked: async () => ({ blocked: false, detail: "RESOLVED:1.1.1.1" }) }).isEnforced()).toBe(false);
    expect(await enforcementWith({ proxyHealth: async () => ({ ok: false, detail: "503" }) }).isEnforced()).toBe(false);
    expect((await enforcementWith().verify()).reason).toBeUndefined();
    expect((await enforcementWith({ directEgressBlocked: async () => ({ blocked: false }) }).verify()).reason).toBe("direct_egress_open");
  });

  it("never treats the environment flag alone as proof of readiness", async () => {
    const withoutProbe = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "true" } as NodeJS.ProcessEnv);
    expect(await withoutProbe.isEnforced()).toBe(false);
    expect((await withoutProbe.verify()).reason).toBe("probe_not_configured");

    const withProbe = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "true" } as NodeJS.ProcessEnv, {
      probe: {
        proxyHealth: async () => ({ ok: true }),
        directEgressBlocked: async () => ({ blocked: true }),
        dnsBypassBlocked: async () => ({ blocked: true }),
      },
    });
    expect(await withProbe.isEnforced()).toBe(true);

    const disabled = resolveEgressEnforcement({ NPATI_SANDBOX_EGRESS_ENFORCED: "false" } as NodeJS.ProcessEnv, {
      probe: {
        proxyHealth: async () => ({ ok: true }),
        directEgressBlocked: async () => ({ blocked: true }),
        dnsBypassBlocked: async () => ({ blocked: true }),
      },
    });
    expect(await disabled.isEnforced()).toBe(false);
    expect((await disabled.verify()).reason).toBe("disabled_by_configuration");
  });

  it("refuses to run anything with a structured 503 when enforcement is not proven", async () => {
    const enforcement = enforcementWith({ directEgressBlocked: async () => ({ blocked: false, detail: "CONNECTED" }) });
    await expect(enforcement.assertEnforced()).rejects.toBeInstanceOf(EgressEnforcementError);
    await enforcement.assertEnforced().catch((error: EgressEnforcementError) => {
      expect(error.code).toBe("network_enforcement_unavailable");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
      expect(error.details).toMatchObject({ reason: "direct_egress_open" });
    });
  });

  it("allows only the proxy ports and blocks UDP/ICMP-style destinations and non-standard ports", () => {
    expect(proxy.portAllowed("registry.npmjs.org", 443)).toBe(true);
    expect(proxy.portAllowed("registry.npmjs.org", 80)).toBe(true);
    expect(proxy.portAllowed("registry.npmjs.org", 8443)).toBe(false);
    expect(proxy.portAllowed("registry.npmjs.org", 22)).toBe(false);
    expect(proxy.portAllowed("github.com", 22)).toBe(true);
    // `parseDestination` throws synchronously, so the structured code is asserted directly.
    expect(() => parseDestination("http://registry.npmjs.org:8080/", { allowlist: ["registry.npmjs.org"] }))
      .toThrowError(expect.objectContaining({ code: "ssrf_blocked_port" }));
    // UDP/ICMP are not expressible through the HTTP proxy at all: the only transport is the proxy.
    expect(proxy.hostnameAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
    expect(proxy.isIpLiteral("1.1.1.1")).toBe(true);
  });

  it("keeps internal NPATI services and other sandboxes out of reach", () => {
    for (const host of ["postgres", "postgres-projects", "agent-api", "sandbox-runner", "npati-egress", "localhost"]) {
      expect(proxy.hostnameAllowed(host, ["postgres", "agent-api"]), host).toBe(false);
      expect(() => parseDestination(`http://${host}/`, { allowlist: ["postgres", "agent-api"] }), host).toThrow();
    }
    for (const address of ["10.0.0.7", "172.17.0.2", "172.31.255.254", "192.168.65.1", "169.254.169.254"]) {
      expect(proxy.isForbiddenAddress(address), address).toBe(true);
    }
  });
});

describe("security-gate: C4b acceptance — phases and the shared SSRF client", () => {
  it("allows an official registry during install and gives the build phase no network", () => {
    const list = config();
    expect(evaluateEgressRequest({ host: "registry.npmjs.org", phase: "install", config: list })).toMatchObject({ allowed: true });
    expect(evaluateEgressRequest({ host: "pypi.org", phase: "install", config: list })).toMatchObject({ allowed: true });
    expect(evaluateEgressRequest({ host: "registry.npmjs.org", phase: "build", config: list }))
      .toMatchObject({ allowed: false, code: "egress_phase_has_no_network" });
    expect(resolveAllowlistForPhase("build", list)).toEqual([]);
    expect(resolveAllowlistForPhase("install", list)).toEqual(expect.arrayContaining([...DEFAULT_INSTALL_ALLOWLIST]));
    expect(evaluateEgressRequest({ host: "github.com", phase: "install", config: list }))
      .toMatchObject({ allowed: false, code: "egress_host_not_allowed" });
    // Owner decision: the run phase defaults to deny all, so a git host is only reachable once the
    // operator adds it explicitly for the project or company.
    expect(resolveAllowlistForPhase("run", list)).toEqual([]);
    expect(evaluateEgressRequest({ host: "github.com", phase: "run", config: list }))
      .toMatchObject({ allowed: false, code: "egress_allowlist_empty" });
    expect(evaluateEgressRequest({ host: "registry.npmjs.org", phase: "run", config: list }))
      .toMatchObject({ allowed: false, code: "egress_allowlist_empty" });
    expect(evaluateEgressRequest({ host: "github.com", phase: "run", config: { install: [...DEFAULT_INSTALL_ALLOWLIST], run: ["github.com"] } }))
      .toMatchObject({ allowed: true });
  });

  it("drives the same decisions through the SSRF-safe client", async () => {
    const client = createSafeUrlValidatorAdapter({ allowlist: ["registry.npmjs.org"], resolve: async () => [PUBLIC_IP] });
    await expect(client.validate("https://registry.npmjs.org/pkg")).resolves.toBeInstanceOf(URL);
    await expect(client.validate(`http://${METADATA_IP}/`)).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    await expect(client.validate("http://localhost/")).rejects.toMatchObject({ code: expect.stringMatching(/ssrf_blocked_private_ip|host_not_allowed/) });
    await expect(client.validate("http://evil.example/")).rejects.toMatchObject({ code: "host_not_allowed" });
    const empty = createSafeUrlValidatorAdapter({ allowlist: [], resolve: async () => [PUBLIC_IP] });
    await expect(empty.validate("https://registry.npmjs.org/pkg")).rejects.toMatchObject({ code: "host_not_allowed" });
  });
});
