import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  CODE_CAPABILITIES,
  CODE_READ_CAPABILITIES,
  CODE_SHELL_CAPABILITIES,
  CODE_TOOL_FLAG_KEYS,
  CODE_WRITE_CAPABILITIES,
  defaultCapabilityRegistry,
  flagKeyForCodeTool,
} from "@npati/shared";
import {
  CODE_TOOL_MANIFEST_VERSION,
  CODE_TOOL_SCHEMAS,
  KNOWN_TOOL_MANIFESTS,
  PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V2_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V3_TOOL_SCHEMA_CHECKSUM,
  resolveManifestForSession,
  toolSchemaChecksum,
} from "../apps/agent-api/src/code-tool-registry";

/**
 * Tools that must never run without an explicit approval through the existing approval system:
 * deletion (C3) plus launching commands or background processes in the sandbox (C4).
 */
const APPROVAL_REQUIRED_TOOLS = new Set(["code.fs.delete", "code.deps.add"]);

/**
 * C11: the git writes that destroy work or publish something. They are approval-gated like the two above, and
 * they are a **separate** list only because their risk is not uniformly `high` (`code.git.pr.comment` is
 * `medium`): the approval is what gates them, and pinning the risk to `high` for all four would have been a
 * false statement about a comment.
 */
const GIT_APPROVAL_REQUIRED_TOOLS = ["code.git.restore", "code.git.push", "code.git.pr.create", "code.git.pr.comment"] as const;

/**
 * C3: mutating Coding Agent tools.
 *
 * These capabilities are the first ones that can change a workspace, so the contract they must keep is
 * stricter than C2's: `code.write` (not `code.read`) gates them, they need `workspace:write`, deletion is
 * `high` risk and approval-gated, and the published manifest must keep every older version resolvable so
 * a session created before C3 is still replayable.
 */
const WRITE_IDS = ["code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.diff", "code.fs.undo_last_turn"];
const WRITE_INVENTORY_IDS = [355, 356, 357, 358, 359, 360, 361];
const EXPECTED_RISK: Record<string, "low" | "medium" | "high"> = {
  "code.fs.edit": "medium",
  "code.fs.apply_patch": "medium",
  "code.fs.write": "medium",
  "code.fs.move": "medium",
  "code.fs.delete": "high",
  "code.fs.diff": "low",
  "code.fs.undo_last_turn": "medium",
};

describe("security-gate: C3 mutating code.* capability registration", () => {
  it("registers the seven mutating tools on inventory ids 355-361 with the documented risk", () => {
    expect(CODE_WRITE_CAPABILITIES.map((c) => c.id)).toEqual(WRITE_IDS);
    expect(CODE_WRITE_CAPABILITIES.map((c) => c.inventoryIds[0])).toEqual(WRITE_INVENTORY_IDS);
    for (const capability of CODE_WRITE_CAPABILITIES) {
      expect(capability, capability.id).toMatchObject({
        type: "tool",
        domain: "code",
        agentCallable: true,
        userVisible: true,
        risk: EXPECTED_RISK[capability.id],
        requiredConnections: [],
        version: 1,
      });
      expect(capability.useWhen.length).toBeGreaterThan(0);
      expect(capability.doNotUseWhen.length).toBeGreaterThan(0);
      expect(capability.inputSchema).toBeDefined();
      expect(capability.outputSchema).toBeDefined();
    }
  });

  it("gates deletion behind an explicit approval and never exaggerates the other tools' safety", () => {
    const deleteCapability = CODE_WRITE_CAPABILITIES.find((c) => c.id === "code.fs.delete")!;
    expect(deleteCapability.risk).toBe("high");
    expect(deleteCapability.requiresConfirmation).toBe(true);

    // The approval-gated set is exactly the destructive/command-launch tools (C3 + C4), and every
    // other code capability has to be honest about not needing approval.
    for (const capability of [...CODE_READ_CAPABILITIES, ...CODE_WRITE_CAPABILITIES, ...CODE_SHELL_CAPABILITIES]) {
      if (APPROVAL_REQUIRED_TOOLS.has(capability.id)) continue;
      expect(capability.requiresConfirmation, `${capability.id} must not claim approval is required`).toBe(false);
    }
    for (const id of APPROVAL_REQUIRED_TOOLS) {
      const capability = CAPABILITY_CATALOG.find((c) => c.id === id);
      expect(capability, `${id} must exist`).toBeTruthy();
      expect(capability!.risk, `${id} risk`).toBe("high");
      expect(capability!.requiresConfirmation, `${id} must require approval`).toBe(true);
    }
    const approvalGated = CAPABILITY_CATALOG.filter((c) => c.domain === "code" && c.requiresConfirmation);
    expect(approvalGated.map((c) => c.id).sort())
      .toEqual([...APPROVAL_REQUIRED_TOOLS, ...GIT_APPROVAL_REQUIRED_TOOLS].sort());
    // C11: and each of them is honest about being gated, without the risk label having to be inflated.
    for (const id of GIT_APPROVAL_REQUIRED_TOOLS) {
      const capability = CAPABILITY_CATALOG.find((c) => c.id === id);
      expect(capability, `${id} must exist`).toBeTruthy();
      expect(["high", "medium"], `${id} risk`).toContain(capability!.risk);
      expect(capability!.requiresConfirmation, `${id} must require approval`).toBe(true);
    }
  });

  it("requires workspace:write for mutations and workspace:read for the diff", () => {
    for (const capability of CODE_WRITE_CAPABILITIES) {
      expect(capability.requiredPermissions, `${capability.id} permissions`)
        .toEqual(capability.id === "code.fs.diff" ? ["workspace:read"] : ["workspace:write"]);
    }
    // The read group stays read-only: no mutating capability may hide in it.
    for (const capability of CODE_READ_CAPABILITIES) {
      expect(capability.requiredPermissions).toEqual(["workspace:read"]);
      expect(capability.id).not.toMatch(/edit|write|patch|delete|move|undo/);
    }
  });

  it("keeps the catalogue, the matrix and the registry resolvable and in sync", () => {
    const catalogCode = CAPABILITY_CATALOG.filter((c) => c.domain === "code");
    const matrixCode = CAPABILITY_MATRIX.filter((c) => c.domain === "code");
    // 37 code capabilities: C3's set plus C4's sandbox tools, C4a's dependency tools, C9's planning tools,
    // `code.ask_user`, C11's git workflow and C12's delegation tool. The pin had stopped at 19 (the count before
    // C4a) because this file is not part of the security gate; it is brought up to the real total rather than
    // widened into a range, which would stop catching an addition.
    expect(catalogCode).toHaveLength(37);
    expect(matrixCode).toHaveLength(37);
    expect(matrixCode.filter((entry) => WRITE_INVENTORY_IDS.includes(entry.id)).map((entry) => entry.id)).toEqual(WRITE_INVENTORY_IDS);

    for (const [index, id] of WRITE_IDS.entries()) {
      expect(defaultCapabilityRegistry.get(id)?.id).toBe(id);
      expect(defaultCapabilityRegistry.getByInventoryId(WRITE_INVENTORY_IDS[index]!)?.id).toBe(id);
    }
    expect(defaultCapabilityRegistry.validate().runtimeCallableViolations).toEqual([]);

    const allInventoryIds = CAPABILITY_CATALOG.flatMap((c) => c.inventoryIds);
    expect(new Set(allInventoryIds).size).toBe(allInventoryIds.length);
    expect(Math.max(...allInventoryIds)).toBe(385); // the last published inventory id, after C12's delegation tool

    const callable = CAPABILITY_CATALOG.filter((c) => c.agentCallable);
    expect(CAPABILITY_CATALOG).toHaveLength(385);
    expect(callable).toHaveLength(121);
    expect(CAPABILITY_CATALOG.length - callable.length).toBe(264);
  });
});

describe("security-gate: C3 tool manifest and flag gating", () => {
  it("keeps manifest v3 frozen and resolvable while the current manifest publishes every tool", () => {
    // C4 bumped the manifest to v4; v3 must keep resolving with exactly its 13 tools and frozen checksum.
    expect(CODE_TOOL_MANIFEST_VERSION).toBeGreaterThanOrEqual(4);
    expect(CODE_TOOL_SCHEMAS.length).toBe(37); // 19 at C3, 22 after C4a, 24 after C9's planning tools, 25 after code.ask_user, 36 after C11's git tools, 37 after C12's delegation tool
    expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM).toBe(toolSchemaChecksum(CODE_TOOL_SCHEMAS));

    const v1 = resolveManifestForSession(1);
    expect(v1.version).toBe(1);
    expect(v1.tools).toHaveLength(0);

    // A session created during C2 keeps resolving, and its six schemas are unchanged: if somebody edits
    // one of them without publishing a new version, this frozen checksum stops matching.
    const v2 = resolveManifestForSession(2);
    expect(v2.version).toBe(2);
    expect(v2.tools.map((tool) => tool.key)).toEqual([
      "code.fs.grep@1",
      "code.fs.list@1",
      "code.project.info@1",
      "code.fs.read@1",
      "code.symbols.outline@1",
      "code.fs.tree@1",
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(v2.checksum).toBe(PUBLISHED_V2_TOOL_SCHEMA_CHECKSUM);

    const v3 = resolveManifestForSession(3);
    expect(v3.version).toBe(3);
    expect(v3.tools).toHaveLength(13);
    expect(v3.checksum).toBe(PUBLISHED_V3_TOOL_SCHEMA_CHECKSUM);
    // Every manifest published so far stays resolvable (v1 empty, v2 reads, v3 file tools, v4 sandbox
    // execution, v5 dependency tools), and the list always ends with the current version.
    const manifestVersions = KNOWN_TOOL_MANIFESTS.map((manifest) => manifest.version);
    expect(manifestVersions).toEqual([...manifestVersions].sort((a, b) => a - b));
    expect(new Set(manifestVersions).size).toBe(manifestVersions.length);
    expect(manifestVersions).toContain(1);
    expect(manifestVersions).toContain(2);
    expect(manifestVersions).toContain(3);
    expect(manifestVersions[manifestVersions.length - 1]).toBe(CODE_TOOL_MANIFEST_VERSION);

    // Every published version is unique and immutable-looking: one entry per `name@version`.
    const keys = CODE_TOOL_SCHEMAS.map((tool) => `${tool.name}@${tool.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => !key.endsWith("@1"))).toEqual([]);
  });

  it("maps every code capability to the flag that actually governs it", () => {
    expect(Object.keys(CODE_TOOL_FLAG_KEYS).sort()).toEqual(CODE_CAPABILITIES.map((c) => c.id).sort());
    for (const id of ["code.fs.list", "code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info", "code.fs.diff"]) {
      expect(flagKeyForCodeTool(id, "code"), `${id} must be gated by code.read`).toBe("code.read");
    }
    for (const id of ["code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.undo_last_turn"]) {
      expect(flagKeyForCodeTool(id, "code"), `${id} must be gated by code.write`).toBe("code.write");
    }
    // A capability outside the code domain has no code flag, and an unmapped code capability still
    // resolves to the read flag rather than to nothing (fail closed, never ungated).
    expect(flagKeyForCodeTool("files.read", "files")).toBeNull();
    expect(flagKeyForCodeTool("code.something.new", "code")).toBe("code.read");
  });

  it("keeps mutation out of the read group so a write flag cannot leak into code.read tools", () => {
    const readIds = CODE_READ_CAPABILITIES.map((c) => c.id);
    for (const id of readIds) {
      expect(CODE_TOOL_FLAG_KEYS[id]).toBe("code.read");
    }
    for (const id of WRITE_IDS) {
      if (id === "code.fs.diff") continue;
      expect(CODE_TOOL_FLAG_KEYS[id]).toBe("code.write");
      expect(readIds, `${id} must not be registered as a read tool`).not.toContain(id);
    }
  });
});
