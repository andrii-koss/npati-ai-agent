import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  CODE_CAPABILITIES,
  CODE_DEPS_CAPABILITIES,
  CODE_TOOL_SCHEMA_MIRROR,
  flagKeyForCapabilityId,
} from "@npati/shared";
import { CODE_TOOL_SCHEMAS, CODE_TOOL_MANIFEST_VERSION } from "../apps/agent-api/src/code-tool-registry";

/**
 * C4a: the dependency capabilities. The catalog is the single contract the Capability Inspector, the
 * PolicyEngine and the model all read, so this suite pins the owner-approved shape: inspection is a
 * harmless read, the audit executes commands, and adding a dependency installs third-party code and
 * therefore always needs an approval.
 */
const DEPS_TOOLS = ["code.deps.inspect", "code.deps.audit", "code.deps.add"] as const;

const EXPECTED = {
  "code.deps.inspect": { risk: "low", approval: false, flag: "code.read", permission: "workspace:read", inventoryId: 368 },
  "code.deps.audit": { risk: "medium", approval: false, flag: "code.shell", permission: "workspace:write", inventoryId: 369 },
  "code.deps.add": { risk: "high", approval: true, flag: "code.shell", permission: "workspace:write", inventoryId: 370 },
} as const;

describe("security-gate: C4a dependency capabilities", () => {
  it("registers the three dependency tools with the approved risk, approval and permission contract", () => {
    expect(CODE_DEPS_CAPABILITIES).toHaveLength(3);
    for (const name of DEPS_TOOLS) {
      const capability = CODE_DEPS_CAPABILITIES.find((entry) => entry.id === name);
      expect(capability, `${name} must be registered`).toBeDefined();
      if (!capability) continue;
      const expected = EXPECTED[name];
      expect(capability.risk, `${name} risk`).toBe(expected.risk);
      expect(capability.requiresConfirmation, `${name} approval`).toBe(expected.approval);
      expect(capability.requiredPermissions, `${name} permission`).toEqual([expected.permission]);
      expect(capability.inventoryIds).toEqual([expected.inventoryId]);
      expect(capability.agentCallable).toBe(true);
      expect(capability.userVisible).toBe(true);
      expect(capability.domain).toBe("code");
      expect(capability.type).toBe("tool");
      expect(capability.version).toBe(1);
      expect(capability.doNotUseWhen.length).toBeGreaterThan(0);
    }
  });

  it("keeps every dependency tool in the catalog, the matrix and the published schema registry", () => {
    for (const name of DEPS_TOOLS) {
      expect(CAPABILITY_CATALOG.some((entry) => entry.id === name), `${name} in catalog`).toBe(true);
      expect(CAPABILITY_MATRIX.some((entry) => entry.capabilityId === name), `${name} in matrix`).toBe(true);
      expect(CODE_TOOL_SCHEMAS.some((schema) => schema.name === name), `${name} in registry`).toBe(true);
      expect(CODE_TOOL_SCHEMA_MIRROR[name], `${name} mirrored schema`).toBeDefined();
    }
  });

  it("mirrors the canonical schemas so a schema change cannot drift from the capability contract", () => {
    for (const name of DEPS_TOOLS) {
      const canonical = CODE_TOOL_SCHEMAS.find((schema) => schema.name === name);
      const mirrored = CODE_TOOL_SCHEMA_MIRROR[name];
      expect(canonical, `${name} canonical schema`).toBeDefined();
      expect(mirrored?.inputSchema).toEqual(canonical?.inputSchema);
      expect(mirrored?.outputSchema).toEqual(canonical?.outputSchema);
      // Every dependency result is untrusted data, never instructions.
      expect(JSON.stringify(mirrored?.outputSchema)).toContain("untrusted_data");
    }
  });

  it("gates the dependency tools with the documented feature flags", () => {
    for (const name of DEPS_TOOLS) {
      expect(flagKeyForCapabilityId(name, "code"), `${name} flag`).toBe(EXPECTED[name].flag);
    }
  });

  it("keeps inventory ids unique across the whole code domain", () => {
    const codeIds = CODE_CAPABILITIES.flatMap((capability) => capability.inventoryIds);
    expect(new Set(codeIds).size).toBe(codeIds.length);
    expect(codeIds.sort((a, b) => a - b)).toEqual(Array.from({ length: codeIds.length }, (_, index) => 349 + index));
  });

  it("never lets a dependency tool claim a lower risk than the plan assigns", () => {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    for (const name of DEPS_TOOLS) {
      const capability = CODE_CAPABILITIES.find((entry) => entry.id === name);
      expect(rank[capability?.risk ?? "low"]).toBeGreaterThanOrEqual(rank[EXPECTED[name].risk]);
    }
    // The install must be the strongest gate of the three, and it must not be silently downgraded.
    const install = CODE_CAPABILITIES.find((entry) => entry.id === "code.deps.add");
    expect(install?.risk).toBe("high");
    expect(install?.requiresConfirmation).toBe(true);
    expect(DEPS_TOOLS.length).toBe(3);
    expect(CODE_TOOL_MANIFEST_VERSION).toBeGreaterThanOrEqual(5);
  });
});
