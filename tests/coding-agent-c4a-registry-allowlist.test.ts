import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY_ALLOWLIST, RegistryAllowlistError, assertRegistryHostAllowed, defaultRegistryAllowlist,
  isRegistryHostAllowed, registryAllowlistSnapshot, resolveRegistryAllowlist,
} from "../apps/agent-api/src/code-registry-allowlist";
import { TYPOSQUAT_ECOSYSTEMS } from "../apps/agent-api/src/code-typosquat-dataset";

describe("security-gate: C4a registry allowlist", () => {
  it("ships exactly the official hosts for every ecosystem, with no wildcards", () => {
    const allowlist = defaultRegistryAllowlist();
    expect(Object.keys(allowlist).sort()).toEqual([...TYPOSQUAT_ECOSYSTEMS].sort());
    expect(allowlist.npm).toEqual(["registry.npmjs.org"]);
    expect(allowlist.pypi).toEqual(["pypi.org", "files.pythonhosted.org"]);
    expect(allowlist.cargo).toEqual(["index.crates.io", "static.crates.io"]);
    expect(allowlist.go).toEqual(["proxy.golang.org", "sum.golang.org"]);
    expect(allowlist.composer).toEqual(["repo.packagist.org"]);
    expect(allowlist.maven).toEqual(["repo.maven.apache.org", "plugins.gradle.org"]);
    for (const hosts of Object.values(allowlist)) {
      for (const host of hosts) {
        expect(host).not.toContain("*");
        expect(host).not.toContain("/");
      }
    }
  });

  it("allows a listed host and its subdomains only", () => {
    const allowlist = defaultRegistryAllowlist();
    expect(isRegistryHostAllowed("npm", "registry.npmjs.org", allowlist)).toBe(true);
    expect(isRegistryHostAllowed("npm", "REGISTRY.NPMJS.ORG", allowlist)).toBe(true);
    expect(isRegistryHostAllowed("npm", "cdn.registry.npmjs.org", allowlist)).toBe(true);
    expect(isRegistryHostAllowed("npm", "evil.com", allowlist)).toBe(false);
    expect(isRegistryHostAllowed("npm", "registry.npmjs.org.evil.com", allowlist)).toBe(false);
    expect(isRegistryHostAllowed("pypi", "pypi.org.evil.com", allowlist)).toBe(false);
    expect(isRegistryHostAllowed("pypi", "files.pythonhosted.org", allowlist)).toBe(true);
    expect(isRegistryHostAllowed("npm", "", allowlist)).toBe(false);
  });

  it("fails closed when the allowlist for an ecosystem is empty", () => {
    const empty = { ...defaultRegistryAllowlist(), npm: [] };
    expect(isRegistryHostAllowed("npm", "registry.npmjs.org", empty)).toBe(false);
    expect(() => assertRegistryHostAllowed("npm", "registry.npmjs.org", empty)).toThrow(RegistryAllowlistError);
    try {
      assertRegistryHostAllowed("npm", "registry.npmjs.org", empty);
    } catch (error) {
      expect((error as RegistryAllowlistError).code).toBe("registry_allowlist_empty");
    }
  });

  it("throws registry_not_allowed for a host outside the list", () => {
    try {
      assertRegistryHostAllowed("npm", "evil.example", defaultRegistryAllowlist());
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryAllowlistError);
      expect((error as RegistryAllowlistError).code).toBe("registry_not_allowed");
      expect((error as RegistryAllowlistError).httpStatus).toBe(403);
    }
  });

  it("adds configured hosts on top of the defaults and rejects wildcards or malformed entries", () => {
    const widened = resolveRegistryAllowlist({ NPATI_CODE_REGISTRY_ALLOWLIST: JSON.stringify({ npm: ["registry.internal.example"] }) } as NodeJS.ProcessEnv);
    expect(widened.npm).toContain("registry.npmjs.org");
    expect(widened.npm).toContain("registry.internal.example");
    expect(isRegistryHostAllowed("npm", "registry.internal.example", widened)).toBe(true);

    for (const override of ['{"npm":["*"]}', '{"npm":["*.example.com"]}', '{"npm":["https://registry.npmjs.org"]}', '{"npm":["registry.npmjs.org/path"]}', '{"npm":[""]}', '{"npm":"registry.npmjs.org"}', '{"unknown-ecosystem":["x.example"]}', "not-json"]) {
      expect(() => resolveRegistryAllowlist({ NPATI_CODE_REGISTRY_ALLOWLIST: override } as NodeJS.ProcessEnv), override).toThrow(RegistryAllowlistError);
    }
  });

  it("returns a copy so callers cannot mutate the shipped defaults", () => {
    const snapshot = registryAllowlistSnapshot();
    snapshot.npm.push("evil.example");
    expect(DEFAULT_REGISTRY_ALLOWLIST.npm).toEqual(["registry.npmjs.org"]);
    expect(defaultRegistryAllowlist().npm).toEqual(["registry.npmjs.org"]);
  });
});
