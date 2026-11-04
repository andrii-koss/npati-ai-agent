import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_ALLOWLIST, DEFAULT_RUN_ALLOWLIST, resolveAllowlistForPhase, resolveEgressAllowlist,
  toProxyAllowedHosts, evaluateEgressRequest,
} from "../apps/agent-api/src/egress-allowlist";

process.env.NPATI_EGRESS_TEST = "true";
const { hostnameAllowed } = await import("../apps/agent-api/src/sandbox-egress-proxy.mjs");
const { DockerSandboxProvider } = await import("../apps/agent-api/src/docker-sandbox-provider");

const APPROVED_REGISTRIES = [
  "files.pythonhosted.org", "index.crates.io", "plugins.gradle.org", "proxy.golang.org", "pub.dev", "pypi.org",
  "registry.npmjs.org", "repo.maven.apache.org", "repo.packagist.org", "static.crates.io", "sum.golang.org",
];
const FORBIDDEN_DEFAULTS = ["github.com", "codeload.github.com", "api.github.com", "objects.githubusercontent.com", "gitlab.com", "bitbucket.org", "registry.yarnpkg.com", "packagist.org"];

describe("security-gate: C4b allowlist wiring — one source of truth", () => {
  it("defaults to exactly the approved registries for install and to deny-all for run", () => {
    const config = resolveEgressAllowlist({ env: {} as NodeJS.ProcessEnv });
    // Order carries no meaning for an allowlist, so compare as a set while still requiring exactly the
    // approved entries: nothing extra, nothing missing and no duplicates.
    expect(config.install).toHaveLength(APPROVED_REGISTRIES.length);
    expect([...config.install].sort()).toEqual([...APPROVED_REGISTRIES].sort());
    expect([...DEFAULT_INSTALL_ALLOWLIST].sort()).toEqual([...APPROVED_REGISTRIES].sort());
    expect(new Set(config.install).size).toBe(config.install.length);
    expect(config.run).toEqual([]);
    expect(DEFAULT_RUN_ALLOWLIST).toEqual([]);
    expect(resolveAllowlistForPhase("run", config)).toEqual([]);
    expect(evaluateEgressRequest({ host: "github.com", phase: "run", config })).toMatchObject({ allowed: false, code: "egress_allowlist_empty" });
  });

  it("exposes exactly those registries to the proxy and never a git host or vendor mirror", () => {
    const proxyHosts = toProxyAllowedHosts(resolveEgressAllowlist({ env: {} as NodeJS.ProcessEnv }));
    const entries = proxyHosts.split(",");
    expect(entries).toHaveLength(APPROVED_REGISTRIES.length);
    expect([...entries].sort()).toEqual([...APPROVED_REGISTRIES].sort());
    // Compared per entry: a substring check would flag `repo.packagist.org` for `packagist.org`.
    for (const host of FORBIDDEN_DEFAULTS) expect(entries).not.toContain(host);
  });

  it("keeps the proxy's built-in fallback list free of git hosts", () => {
    // No entries argument: the module's own default allowlist applies.
    expect(hostnameAllowed("registry.npmjs.org")).toBe(true);
    expect(hostnameAllowed("pypi.org")).toBe(true);
    for (const host of FORBIDDEN_DEFAULTS) expect(hostnameAllowed(host), host).toBe(false);
  });

  it("accepts an empty allowlist as deny-all instead of rejecting the configuration", () => {
    expect(() => new DockerSandboxProvider({ allowedHosts: "" })).not.toThrow();
    expect(() => new DockerSandboxProvider({})).not.toThrow();
    expect(() => new DockerSandboxProvider({ allowedHosts: "*.example.com,registry.npmjs.org" })).not.toThrow();
    expect(() => new DockerSandboxProvider({ allowedHosts: "https://evil.example.com" })).toThrow("Invalid sandbox allowlist");
  });

  it("still honours an operator override, additively and validated", () => {
    const config = resolveEgressAllowlist({ env: { NPATI_SANDBOX_EGRESS_ALLOWLIST_INSTALL: "registry.internal.example.com", NPATI_SANDBOX_EGRESS_ALLOWLIST_RUN: "*.git.example.com" } as NodeJS.ProcessEnv });
    expect(config.install).toContain("registry.internal.example.com");
    expect(config.install).toContain("registry.npmjs.org");
    expect(config.run).toEqual(["*.git.example.com"]);
    expect(evaluateEgressRequest({ host: "a.git.example.com", phase: "run", config })).toMatchObject({ allowed: true });
    expect(evaluateEgressRequest({ host: "git.example.com.attacker.net", phase: "run", config })).toMatchObject({ allowed: false });
    const proxyHosts = toProxyAllowedHosts(config);
    expect(proxyHosts).toContain("registry.internal.example.com");
    expect(proxyHosts).toContain("git.example.com");
  });

  it("never lets an operator open localhost, metadata or internal service names", () => {
    for (const host of ["localhost", "metadata.google.internal", "postgres", "agent-api"]) {
      expect(() => resolveEgressAllowlist({ env: { NPATI_SANDBOX_EGRESS_ALLOWLIST_RUN: host } as NodeJS.ProcessEnv })).toThrow(/invalid_allowlist_entry/);
    }
    const config = resolveEgressAllowlist({ env: {} as NodeJS.ProcessEnv });
    for (const host of ["localhost", "169.254.169.254", "10.0.0.1", "0x7f000001"]) {
      expect(evaluateEgressRequest({ host, phase: "install", config }).allowed, host).toBe(false);
    }
  });
});
