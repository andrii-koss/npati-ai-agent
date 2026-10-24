import { describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG, CAPABILITY_MATRIX } from "@npati/shared";
import {
  CODE_CAPABILITIES,
  CODE_SHELL_CAPABILITIES,
  CODE_SHELL_MATRIX,
  CODE_TOOL_FLAG_KEYS_RESOLVED,
  flagKeyForCodeTool,
} from "@npati/shared";
import { CODE_TOOL_MANIFEST_VERSION, CODE_TOOL_SCHEMAS, PUBLISHED_TOOL_SCHEMA_CHECKSUM, toolSchemaChecksum } from "../apps/agent-api/src/code-tool-registry";

/**
 * C4: the sandbox execution capabilities and the contracts they must keep.
 *
 * The assertions are deliberately written as invariants derived from the canonical registry instead of
 * frozen totals, because a frozen number has to be re-edited by hand in a dozen files every time a tool
 * is added (that is exactly how C3 left three stale counters behind). The one place that still pins the
 * totals is the explicit "catalog totals" test below, so an accidental addition still fails loudly.
 */
const SHELL_TOOLS = [
  "code.shell.exec",
  "code.shell.process.start",
  "code.shell.process.list",
  "code.shell.process.logs",
  "code.shell.process.stop",
  "code.verify.run",
] as const;

describe("security-gate: C4 sandbox execution capabilities", () => {
  it("registers the six sandbox execution tools with the planned risk and approval contract", () => {
    expect(CODE_SHELL_CAPABILITIES.map((capability) => capability.id).sort()).toEqual([...SHELL_TOOLS].sort());
    const byId = new Map(CODE_SHELL_CAPABILITIES.map((capability) => [capability.id, capability]));
    // Launching a command in the sandbox is high risk and needs an approval; the read-only process
    // tools never do; stopping a process and replaying the project's verify commands are medium.
    // Owner decision: shell tools stay `high` risk but no longer claim approval is required — the
    // server-side PolicyEngine decides that from the command's risk class at execution time.
    for (const id of ["code.shell.exec", "code.shell.process.start"]) {
      expect(byId.get(id)).toMatchObject({ risk: "high", requiresConfirmation: false, agentCallable: true, userVisible: true });
    }
    for (const id of ["code.shell.process.list", "code.shell.process.logs"]) {
      expect(byId.get(id)).toMatchObject({ risk: "low", requiresConfirmation: false });
      expect(byId.get(id)!.requiredPermissions).toEqual(["workspace:read"]);
    }
    expect(byId.get("code.shell.process.stop")).toMatchObject({ risk: "medium", requiresConfirmation: false });
    expect(byId.get("code.verify.run")).toMatchObject({ risk: "medium", requiresConfirmation: false });
    for (const capability of CODE_SHELL_CAPABILITIES) {
      expect(capability).toMatchObject({ type: "tool", domain: "code", version: 1 });
      expect(capability.description.length).toBeGreaterThan(20);
      expect(capability.useWhen.length).toBeGreaterThan(0);
      expect(capability.doNotUseWhen.length).toBeGreaterThan(0);
      expect(capability.inputSchema).toMatchObject({ additionalProperties: false });
    }
  });

  it("publishes the shell tools in the canonical tool registry with matching versions", () => {
    const published = new Set(CODE_TOOL_SCHEMAS.map((tool) => `${tool.name}@${tool.version}`));
    for (const id of SHELL_TOOLS) expect(published.has(`${id}@1`)).toBe(true);
    expect(CODE_TOOL_SCHEMAS.length).toBeGreaterThanOrEqual(SHELL_TOOLS.length + 13);
    // The published set and its frozen checksum must agree, and every shell tool must carry both schemas.
    expect(toolSchemaChecksum()).toBe(PUBLISHED_TOOL_SCHEMA_CHECKSUM);
    for (const tool of CODE_TOOL_SCHEMAS.filter((entry) => SHELL_TOOLS.includes(entry.name as typeof SHELL_TOOLS[number]))) {
      expect(tool.status).toBe("active");
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
      expect(Object.keys(tool.outputSchema).length).toBeGreaterThan(0);
    }
  });

  it("keeps the C4 sandbox tools out of the file-write flag and behind the code.shell sub-flag", () => {
    // An operator must be able to allow file edits while forbidding command execution, so the shell
    // tools are gated by `code.shell` and `code.verify.run` stays with the change tools it verifies.
    for (const id of SHELL_TOOLS.filter((tool) => tool !== "code.verify.run")) {
      expect(CODE_TOOL_FLAG_KEYS_RESOLVED[id]).toBe("code.shell");
      expect(flagKeyForCodeTool(id, "code")).toBe("code.shell");
    }
    expect(CODE_TOOL_FLAG_KEYS_RESOLVED["code.verify.run"]).toBe("code.write");
    // The read-only process tools keep the read flag even though they live in the shell group.
    expect(flagKeyForCodeTool("code.shell.process.list", "code")).toBe("code.shell");
    expect(flagKeyForCodeTool("code.fs.diff", "code")).toBe("code.read");
  });

  it("appears in the canonical catalog and matrix with unique inventory ids", () => {
    const catalogCode = CAPABILITY_CATALOG.filter((capability) => capability.domain === "code");
    const matrixCode = CAPABILITY_MATRIX.filter((entry) => entry.domain === "code");
    expect(matrixCode).toHaveLength(catalogCode.length);
    for (const id of SHELL_TOOLS) {
      expect(catalogCode.some((capability) => capability.id === id)).toBe(true);
      expect(matrixCode.some((entry) => entry.capabilityId === id)).toBe(true);
    }
    const inventoryIds = CAPABILITY_CATALOG.flatMap((capability) => capability.inventoryIds);
    expect(new Set(inventoryIds).size).toBe(inventoryIds.length);
    expect(Math.max(...inventoryIds)).toBe(Math.max(...CODE_CAPABILITIES.flatMap((capability) => capability.inventoryIds)));
  });

  it("pins the catalog totals in exactly one place so an accidental addition fails loudly", () => {
    const callable = CAPABILITY_CATALOG.filter((capability) => capability.agentCallable);
    // C2 (6 reads) + C3 (7 file tools) + C4 (6 sandbox tools) + C4a (3 dependency tools) = 22 code tools, plus
    // C9's three (the planning pair and the user question), C11's eleven git tools and C12's delegation tool = 37,
    // all agent-callable.
    expect(CODE_CAPABILITIES).toHaveLength(60); // v15 adds ten tools on inventory ids 399-408
    expect(callable.filter((capability) => capability.domain === "code")).toHaveLength(60);
    expect(CAPABILITY_CATALOG.length).toBe(408);
    expect(callable.length).toBe(144);
    expect(CAPABILITY_CATALOG.length - callable.length).toBe(264);
    expect(CODE_TOOL_MANIFEST_VERSION).toBe(16); // v16 publishes code.data.schema.apply@2; the capability count is unchanged.
  });

  it("never exposes a sandbox tool without a manifest version and a versioned schema", () => {
    for (const tool of CODE_TOOL_SCHEMAS) {
      expect(Number.isInteger(tool.version)).toBe(true);
      expect(tool.version).toBeGreaterThanOrEqual(1);
    }
    const shellVersions = CODE_TOOL_SCHEMAS.filter((tool) => SHELL_TOOLS.includes(tool.name as typeof SHELL_TOOLS[number])).map((tool) => tool.version);
    expect(shellVersions.every((version) => version === 1)).toBe(true);
  });
});
