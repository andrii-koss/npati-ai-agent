import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTALL_ALLOWLIST, DEFAULT_RUN_ALLOWLIST, EgressAllowlistManager,
  assertEgressAllowed, allowsNetworkForPhase, evaluateEgressRequest, isAddressLiteral,
  matchEgressHost, normalizeRequestHost, resolveAllowlistForPhase, resolveEgressAllowlist,
  toProxyAllowedHosts, validateAllowlistEntry,
} from "../apps/agent-api/src/egress-allowlist";

const admin = { userId: "user-admin", permissions: ["workspace:read", "admin:all"] };
const member = { userId: "user-member", permissions: ["workspace:read", "workspace:write"] };

const config = () => resolveEgressAllowlist({ env: {} as NodeJS.ProcessEnv });

describe("security-gate: C4b egress allowlist validation", () => {
  it("rejects schemes, paths, ports, credentials, bare wildcards and empty entries", () => {
    for (const entry of ["https://registry.npmjs.org", "registry.npmjs.org/path", "registry.npmjs.org?x=1", "user@registry.npmjs.org", "registry.npmjs.org:443", "*", " ", ""]) {
      expect(() => validateAllowlistEntry(entry), entry).toThrow(/invalid_allowlist_entry|bare wildcard|empty/);
    }
  });

  it("rejects non-ASCII homoglyphs and localhost/metadata names", () => {
    expect(() => validateAllowlistEntry("registry.npmjs.оrg")).toThrow(/homoglyphs/);
    expect(() => validateAllowlistEntry("localhost")).toThrow(/not allowed/);
    expect(() => validateAllowlistEntry("metadata.google.internal")).toThrow(/not allowed/);
    expect(() => validateAllowlistEntry("169.254.169.254")).toThrow(/IP literals/);
  });

  it("rejects address literals in every documented encoding", () => {
    for (const literal of ["127.0.0.1", "2130706433", "0x7f000001", "0177.0.0.1", "::1", "[::ffff:127.0.0.1]", "0:0:0:0:0:ffff:127.0.0.1"]) {
      expect(isAddressLiteral(literal), literal).toBe(true);
      expect(() => validateAllowlistEntry(literal), literal).toThrow();
      const denied = evaluateEgressRequest({ host: literal, phase: "install", config: config() });
      expect(denied.allowed, literal).toBe(false);
      expect(denied.code, literal).toBe("egress_address_literal_denied");
    }
    expect(isAddressLiteral("registry.npmjs.org")).toBe(false);
    expect(normalizeRequestHost("Registry.NPMJS.org.")).toBe("registry.npmjs.org");
  });

  it("accepts exactly one label for a wildcard and never a suffix trick", () => {
    const patterns = ["*.example.com", "registry.npmjs.org"];
    expect(matchEgressHost("a.example.com", patterns)).toBe("*.example.com");
    expect(matchEgressHost("example.com", patterns)).toBeNull();
    expect(matchEgressHost("a.b.example.com", patterns)).toBeNull();
    expect(matchEgressHost("registry.npmjs.org", patterns)).toBe("registry.npmjs.org");
    expect(matchEgressHost("registry.npmjs.org.evil.com", patterns)).toBeNull();
    expect(matchEgressHost("evil.npmjs.org.attacker.com", ["registry.npmjs.org"])).toBeNull();
    expect(matchEgressHost("evil.npmjs.org.attacker.com", ["*.npmjs.org"])).toBeNull();
    expect(validateAllowlistEntry("*.example.com")).toBe("*.example.com");
    expect(() => validateAllowlistEntry("*.*.example.com")).toThrow();
  });

  it("keeps install and run phases apart and gives the build phase no network at all", () => {
    const list = config();
    // Owner decision: the install phase ships exactly the approved official registries, and the run
    // phase defaults to deny all (git hosts must be added explicitly by the operator).
    expect([...DEFAULT_INSTALL_ALLOWLIST].sort()).toEqual([
      "files.pythonhosted.org",
      "index.crates.io",
      "plugins.gradle.org",
      "proxy.golang.org",
      "pypi.org",
      "registry.npmjs.org",
      "repo.maven.apache.org",
      "repo.packagist.org",
      "static.crates.io",
      "sum.golang.org",
    ]);
    expect(DEFAULT_INSTALL_ALLOWLIST).not.toContain("registry.yarnpkg.com");
    expect(DEFAULT_RUN_ALLOWLIST).toEqual([]);
    expect(list.run).toEqual([]);
    expect(list.install).toEqual(expect.arrayContaining([...DEFAULT_INSTALL_ALLOWLIST]));
    expect(resolveAllowlistForPhase("install", list)).toEqual(expect.arrayContaining(["registry.npmjs.org", "pypi.org", "index.crates.io", "repo.packagist.org"]));
    expect(resolveAllowlistForPhase("run", list)).toEqual([]);
    expect(list.install.concat(list.run).some((entry) => entry.includes("*"))).toBe(false);
    expect(resolveAllowlistForPhase("build", list)).toEqual([]);
    expect(allowsNetworkForPhase("build")).toBe(false);

    const build = evaluateEgressRequest({ host: "registry.npmjs.org", phase: "build", config: list });
    expect(build).toMatchObject({ allowed: false, code: "egress_phase_has_no_network" });

    const gitDuringInstall = evaluateEgressRequest({ host: "github.com", phase: "install", config: list });
    expect(gitDuringInstall).toMatchObject({ allowed: false, code: "egress_host_not_allowed" });
    const gitDuringRun = evaluateEgressRequest({ host: "github.com", phase: "run", config: list });
    expect(gitDuringRun).toMatchObject({ allowed: false, code: "egress_allowlist_empty" });
    const withOperatorGitHost = { install: [...DEFAULT_INSTALL_ALLOWLIST], run: ["github.com"] };
    expect(evaluateEgressRequest({ host: "github.com", phase: "run", config: withOperatorGitHost })).toMatchObject({ allowed: true });
    const registryDuringInstall = evaluateEgressRequest({ host: "registry.npmjs.org", phase: "install", config: list });
    expect(registryDuringInstall).toMatchObject({ allowed: true, matchedPattern: "registry.npmjs.org" });
    const registryDuringRun = evaluateEgressRequest({ host: "registry.npmjs.org", phase: "run", config: list });
    expect(registryDuringRun.allowed).toBe(false);
    expect(() => assertEgressAllowed({ host: "evil.example", phase: "install", config: list })).toThrow(/egress_host_not_allowed/);
  });

  it("denies everything when the allowlist for a phase is empty", () => {
    const empty = { install: [], run: [] };
    const decision = evaluateEgressRequest({ host: "registry.npmjs.org", phase: "install", config: empty });
    expect(decision).toMatchObject({ allowed: false, code: "egress_allowlist_empty" });
  });

  it("adds operator configuration additively and rejects invalid entries from the environment", () => {
    const resolved = resolveEgressAllowlist({ env: { NPATI_SANDBOX_EGRESS_ALLOWLIST_INSTALL: "internal.mirror.example" } as NodeJS.ProcessEnv });
    expect(resolved.install).toContain("internal.mirror.example");
    expect(resolved.install).toEqual(expect.arrayContaining([...DEFAULT_INSTALL_ALLOWLIST]));
    expect(() => resolveEgressAllowlist({ env: { NPATI_SANDBOX_EGRESS_ALLOWLIST_RUN: "*" } as NodeJS.ProcessEnv })).toThrow(/invalid_allowlist_entry|bare wildcard/);
    expect(() => resolveEgressAllowlist({ env: { NPATI_SANDBOX_EGRESS_ALLOWLIST_RUN: "http://x.example" } as NodeJS.ProcessEnv })).toThrow(/invalid_allowlist_entry/);
  });

  it("exposes exactly the value the egress proxy consumes", () => {
    const hosts = toProxyAllowedHosts(config()).split(",");
    expect(hosts).toContain("registry.npmjs.org");
    // The run phase defaults to deny all, so no git host is exported without an explicit operator rule.
    expect(hosts).not.toContain("github.com");
    expect(hosts).not.toContain("registry.yarnpkg.com");
    expect(hosts).not.toContain("*.example.com");
    expect(hosts.every((host) => !host.includes("*"))).toBe(true);

    const withOperatorGitHost = toProxyAllowedHosts({ install: [...DEFAULT_INSTALL_ALLOWLIST], run: ["github.com"] });
    expect(withOperatorGitHost.split(",")).toContain("github.com");
  });
});

describe("security-gate: C4b egress allowlist administration", () => {
  it("requires owner/admin rights for every change", async () => {
    const manager = new EgressAllowlistManager({ companyId: "company-1", audit: { record: vi.fn() } });
    await expect(manager.addHost(member, "internal.mirror.example", "install")).rejects.toThrow(/egress_allowlist_admin_required/);
    await expect(manager.removeHost(member, "registry.npmjs.org", "install")).rejects.toThrow(/egress_allowlist_admin_required/);
    expect(manager.getAllowlist().install).toContain("registry.npmjs.org");
  });

  it("refuses to change anything when the audit journal is unavailable (fail closed)", async () => {
    const manager = new EgressAllowlistManager({ companyId: "company-1" });
    await expect(manager.addHost(admin, "internal.mirror.example", "install")).rejects.toThrow(/audit_unavailable/);
    expect(manager.getAllowlist().install).not.toContain("internal.mirror.example");
  });

  it("does not apply a change when the audit write fails", async () => {
    const audit = { record: vi.fn(async () => { throw new Error("journal down"); }) };
    const manager = new EgressAllowlistManager({ companyId: "company-1", audit });
    await expect(manager.addHost(admin, "internal.mirror.example", "install")).rejects.toThrow(/journal down/);
    expect(manager.getAllowlist().install).not.toContain("internal.mirror.example");
  });

  it("applies an audited change and journals host, phase and actor without secrets", async () => {
    const audit = { record: vi.fn(async () => ({})) };
    const manager = new EgressAllowlistManager({ companyId: "company-1", audit });
    const after = await manager.addHost(admin, "Internal.Mirror.Example", "install");
    expect(after.install).toContain("internal.mirror.example");
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, input] = audit.record.mock.calls[0] as unknown as [unknown, { action: string; resourceId: string; actor: string; metadata: Record<string, unknown> }];
    expect(input.action).toBe("egress_allowlist.add");
    expect(input.resourceId).toBe("install:internal.mirror.example");
    expect(input.actor).toBe("user-admin");
    expect(JSON.stringify(input.metadata)).not.toMatch(/token|secret|password/i);

    const removed = await manager.removeHost(admin, "internal.mirror.example", "install");
    expect(removed.install).not.toContain("internal.mirror.example");
    await expect(manager.removeHost(admin, "nope.example", "install")).rejects.toThrow(/allowlist_entry_absent/);
  });

  it("keeps the manager view consistent with the phase resolver and the proxy value", () => {
    const manager = new EgressAllowlistManager({ companyId: "company-1" });
    expect(manager.resolveForPhase("build")).toEqual([]);
    expect(manager.evaluate({ host: "registry.npmjs.org", phase: "install" }).allowed).toBe(true);
    expect(manager.evaluate({ host: "registry.npmjs.org", phase: "run" }).allowed).toBe(false);
    expect(manager.proxyAllowedHosts()).toContain("registry.npmjs.org");
    expect(manager.getAllowlist().install).toEqual([...manager.getAllowlist().install].sort());
  });
});
