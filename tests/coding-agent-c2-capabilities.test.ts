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
/**
 * C3 added the mutating tools, C4 the sandbox execution tools, C4a the dependency tools, C9 the planning
 * tools **and** `code.ask_user`, and C11 (owner decision 2) the eleven git workflow tools: 36 capabilities on
 * inventory ids 349-384. The inventory list here had stopped at 367 (it was never extended for the dependency
 * group), so it is brought up to date together with the newer additions rather than left as a stale guard.
 */
const GIT_CODE_IDS = ["code.git.status", "code.git.diff", "code.git.log", "code.git.branch.create", "code.git.branch.switch", "code.git.stage", "code.git.commit", "code.git.restore", "code.git.push", "code.git.pr.create", "code.git.pr.comment"];
/** C12: the delegation tool (inventory id 385), appended after the git group so no earlier id moved. */
const SUBAGENT_CODE_IDS = ["code.agent.spawn"];
const ALL_CODE_IDS = [...CODE_IDS, "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.diff", "code.fs.undo_last_turn", "code.shell.exec", "code.shell.process.start", "code.shell.process.list", "code.shell.process.logs", "code.shell.process.stop", "code.verify.run", "code.deps.inspect", "code.deps.audit", "code.deps.add", "code.plan.propose", "code.plan.update", "code.ask_user", ...GIT_CODE_IDS, ...SUBAGENT_CODE_IDS];
const ALL_CODE_INVENTORY_IDS = [...CODE_INVENTORY_IDS, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385];

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
    // C9 published three more code tools (`code.plan.propose`, `code.plan.update`, `code.ask_user`), C11 the
    // eleven git tools and C12 the delegation tool, so the code group is 37 now.
    expect(catalogCode).toHaveLength(37);
    expect(matrixCode).toHaveLength(37);
    expect(matrixCode.map((entry) => entry.id)).toEqual(ALL_CODE_INVENTORY_IDS);
    expect(catalogCode.map((c) => c.id)).toEqual(ALL_CODE_IDS);

    const allInventoryIds = CAPABILITY_CATALOG.flatMap((c) => c.inventoryIds);
    expect(new Set(allInventoryIds).size).toBe(allInventoryIds.length);
    expect(Math.max(...allInventoryIds)).toBe(385); // C12 added id 385
    // The code group did not disturb the previous totals' internal split.
    const callable = CAPABILITY_CATALOG.filter((c) => c.agentCallable);
    // The catalog is 385 entries with 121 callable: the real totals, updated for C9's three tools, C11's
    // eleven git tools and C12's delegation tool. This file is not part of the security gate and its pins had
    // drifted before (it expected 367/103 while the catalog already stood at 370/106), so the numbers here are
    // the current truth rather than a delta on a stale baseline.
    expect(CAPABILITY_CATALOG).toHaveLength(385);
    expect(callable).toHaveLength(121);
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
    // C12: 37 code capabilities — the delegation tool is the newest, and it hangs off `code.subagents`.
    expect(codeItems).toHaveLength(37);
    for (const item of codeItems) {
      // The governing flag comes from the canonical mapping: reads (and code.fs.diff) use code.read,
      // file mutations use code.write, sandbox execution uses code.shell.
      expect(item.flagKey, `${item.capabilityId} flag`).toBe(flagKeyForCodeTool(item.capabilityId, "code"));
      expect(item.flagState).toBe("unknown");
    }
    // Dark launch: with every code flag off — C11's `code.git` and C12's `code.subagents` are further code
    // sub-flags — the capabilities stay visible in the inspector but are gated.
    const dark = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: false, "code.write": false, "code.shell": false, "code.git": false, "code.subagents": false }, flagSourceAvailable: true });
    expect(dark.items.filter((item) => item.domain === "code").every((item) => item.flagState === "off")).toBe(true);
    const on = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: true, "code.write": true, "code.shell": true, "code.git": true, "code.subagents": true }, flagSourceAvailable: true });
    expect(on.items.filter((item) => item.domain === "code").every((item) => item.flagState === "on")).toBe(true);
    // Reads enabled, writes, shell, git and delegation still off: exactly the read-gated capabilities report "on".
    const readOnly = new CapabilityInspectorService().inspect("all", undefined, { flagStates: { [CODE_READ_FLAG]: true, "code.write": false, "code.shell": false, "code.git": false, "code.subagents": false }, flagSourceAvailable: true });
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
