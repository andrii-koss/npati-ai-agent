import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  CODE_READ_CAPABILITIES,
  CODE_READ_FLAG,
  CapabilityInspectorService,
  defaultCapabilityRegistry,
  flagKeyForCapability,
  flagKeyForCodeTool,
} from "@npati/shared";

const CODE_IDS = ["code.fs.list", "code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info"];
const CODE_INVENTORY_IDS = [349, 350, 351, 352, 353, 354];
/** C3 added the mutating tools and C4 the sandbox execution tools: 19 capabilities on inventory ids 349-367. */
const ALL_CODE_IDS = [...CODE_IDS, "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.diff", "code.fs.undo_last_turn", "code.shell.exec", "code.shell.process.start", "code.shell.process.list", "code.shell.process.logs", "code.shell.process.stop", "code.verify.run"];
const ALL_CODE_INVENTORY_IDS = [...CODE_INVENTORY_IDS, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367];

describe("C2: read-only code.* capability registration", () => {
  it("registers exactly six code capabilities on inventory ids 349-354, all low risk and read-only", () => {
    expect(CODE_READ_CAPABILITIES.map((c) => c.id)).toEqual(CODE_IDS);
    expect(CODE_READ_CAPABILITIES.map((c) => c.inventoryIds[0])).toEqual(CODE_INVENTORY_IDS);
    for (const capability of CODE_READ_CAPABILITIES) {
      expect(capability).toMatchObject({
        type: "tool",
        domain: "code",
        agentCallable: true,
        userVisible: true,
        risk: "low",
        requiresConfirmation: false,
        requiredConnections: [],
        version: 1,
      });
      expect(capability.requiredPermissions).toEqual(["workspace:read"]);
      expect(capability.useWhen.length).toBeGreaterThan(0);
      expect(capability.doNotUseWhen.length).toBeGreaterThan(0);
      expect(capability.inputSchema).toBeDefined();
      expect(capability.outputSchema).toBeDefined();
      // Read-only contract: nothing in the C2 group may advertise a write or shell capability.
      expect(capability.id).not.toMatch(/write|edit|delete|move|shell|exec/);
    }
  });

  it("keeps the catalogue and the audit matrix in sync and the inventory ids unique", () => {
    const catalogCode = CAPABILITY_CATALOG.filter((c) => c.domain === "code");
    const matrixCode = CAPABILITY_MATRIX.filter((c) => c.domain === "code");
    expect(catalogCode).toHaveLength(19);
    expect(matrixCode).toHaveLength(19);
    expect(matrixCode.map((entry) => entry.id)).toEqual(ALL_CODE_INVENTORY_IDS);
    expect(catalogCode.map((c) => c.id)).toEqual(ALL_CODE_IDS);

    const allInventoryIds = CAPABILITY_CATALOG.flatMap((c) => c.inventoryIds);
    expect(new Set(allInventoryIds).size).toBe(allInventoryIds.length);
    expect(Math.max(...allInventoryIds)).toBe(367);
    // The code group did not disturb the previous totals' internal split.
    const callable = CAPABILITY_CATALOG.filter((c) => c.agentCallable);
    expect(CAPABILITY_CATALOG).toHaveLength(367);
    expect(callable).toHaveLength(103);
    expect(CAPABILITY_CATALOG.length - callable.length).toBe(264);
  });

  it("is resolvable through the registry by id and by inventory id", () => {
    for (const [index, id] of CODE_IDS.entries()) {
      const byId = defaultCapabilityRegistry.get(id);
      expect(byId?.id).toBe(id);
      const byInventory = defaultCapabilityRegistry.getByInventoryId(CODE_INVENTORY_IDS[index]!);
      expect(byInventory?.id).toBe(id);
    }
    expect(defaultCapabilityRegistry.validate().runtimeCallableViolations).toEqual([]);
  });
});

describe("security-gate: C2 code capabilities are gated by a feature flag", () => {
  it("maps only the code domain to the code.read flag and nothing else", () => {
    expect(flagKeyForCapability("code")).toBe(CODE_READ_FLAG);
    expect(CODE_READ_FLAG).toBe("code.read");
    for (const domain of ["files", "browser", "storage", "ai", "orchestration", "system", "business", "security", "research", "communications"]) {
      expect(flagKeyForCapability(domain)).toBeNull();
    }
  });

  it("reports the flag as unknown (never on) when the server has no flag source", () => {
    const report = new CapabilityInspectorService().inspect("all");
    const codeItems = report.items.filter((item) => item.domain === "code");
    expect(codeItems).toHaveLength(19);
    for (const item of codeItems) {
      // The governing flag comes from the canonical mapping: reads (and code.fs.diff) use code.read,
      // file mutations use code.write, sandbox execution uses code.shell.
      expect(item.flagKey, `${item.capabilityId} flag`).toBe(flagKeyForCodeTool(item.capabilityId, "code"));
      expect(item.flagState).toBe("unknown");
    }
    // Dark launch: with every code flag off, the capabilities stay visible in the inspector but are gated.
    const dark = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: false, "code.write": false, "code.shell": false }, flagSourceAvailable: true });
    expect(dark.items.filter((item) => item.domain === "code").every((item) => item.flagState === "off")).toBe(true);
    const on = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: true, "code.write": true, "code.shell": true }, flagSourceAvailable: true });
    expect(on.items.filter((item) => item.domain === "code").every((item) => item.flagState === "on")).toBe(true);
    // Reads enabled, writes and shell still off: exactly the read-gated capabilities report "on".
    const readOnly = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: true, "code.write": false, "code.shell": false }, flagSourceAvailable: true });
    const codeOnly = readOnly.items.filter((item) => item.domain === "code");
    const expectedOn = codeOnly.filter((item) => flagKeyForCodeTool(item.capabilityId, "code") === CODE_READ_FLAG).map((item) => item.capabilityId).sort();
    expect(codeOnly.filter((item) => item.flagState === "on").map((item) => item.capabilityId).sort()).toEqual(expectedOn);
    expect(codeOnly.filter((item) => item.flagState === "off").map((item) => item.capabilityId).sort())
      .toEqual(codeOnly.filter((item) => flagKeyForCodeTool(item.capabilityId, "code") !== CODE_READ_FLAG).map((item) => item.capabilityId).sort());
  });

  it("exposes no code capability outside the tool contract and keeps the read group low risk", () => {
    // C2's read-only group stays low risk without approval.
    for (const capability of CODE_READ_CAPABILITIES) {
      expect(capability.risk).toBe("low");
      expect(capability.requiresConfirmation).toBe(false);
    }
    const nonTool = CAPABILITY_CATALOG.filter((c) => c.domain === "code" && c.type !== "tool");
    expect(nonTool).toEqual([]);
  });
});
