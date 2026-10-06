import { describe, expect, it } from "vitest";
import {
  CODE_CAPABILITY_GROUPS,
  assertCapabilityGranted,
  capabilitiesForGroups,
  effectivePermissions,
  groupForCapability,
  isCodeCapability,
} from "../apps/agent-api/src/code-capability-groups";

/**
 * C5 security-gate: capability groups feed the PolicyEngine's `capability_groups` phase, which runs
 * before risk classification and approval. These tests pin the intersection semantics: an agent
 * without a group is refused outright (so no approval is ever requested for it), a user without
 * permission is refused, and a project denial always wins.
 */

const tools = Object.values(CODE_CAPABILITY_GROUPS).flat();

describe("security-gate: C5 capability groups are the intersection of agent, user and project", () => {
  it("maps every code.* tool to exactly one group", () => {
    expect(tools.length).toBeGreaterThan(15);
    for (const tool of tools) {
      expect(groupForCapability(tool)).not.toBeNull();
      expect(isCodeCapability(tool)).toBe(true);
    }
    expect(groupForCapability("code.fs.read")).toBe("code.read");
    expect(groupForCapability("code.fs.write")).toBe("code.write");
    expect(groupForCapability("code.shell.exec")).toBe("code.shell");
    expect(groupForCapability("code.git.commit")).toBeNull();
  });

  it("refuses a tool whose group the agent does not hold, and never asks for approval", () => {
    const input = {
      agentCapabilityGroups: ["code.read"],
      userPermissions: ["code.*"],
    };
    const effective = effectivePermissions(input);
    expect(effective.capabilities).toContain("code.fs.read");
    expect(effective.capabilities).not.toContain("code.fs.write");
    expect(effective.denied.find((entry) => entry.capabilityId === "code.fs.write")?.reason).toBe("agent_group_missing");
    expect(() => assertCapabilityGranted(input, "code.fs.write")).toThrowError(/capability_not_granted/);
    try {
      assertCapabilityGranted(input, "code.shell.exec");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "capability_not_granted", httpStatus: 403, details: { group: "code.shell" } });
    }
  });

  it("fails closed when the user grants nothing, and never widens on its own", () => {
    // Empty user permissions grant nothing (no implicit inheritance).
    const empty = effectivePermissions({ agentCapabilityGroups: ["code.write"], userPermissions: [] });
    expect(empty.capabilities).toEqual([]);
    expect(empty.denied.find((entry) => entry.capabilityId === "code.fs.write")?.reason).toBe("user_permission_missing");
    expect(() => assertCapabilityGranted({ agentCapabilityGroups: ["code.write"], userPermissions: [] }, "code.fs.edit"))
      .toThrowError(/capability_not_granted/);

    // Intersection, not union: an agent holding code.write gains nothing from a code.read permission.
    const disjoint = effectivePermissions({ agentCapabilityGroups: ["code.write"], userPermissions: ["code.fs.read"] });
    expect(disjoint.capabilities).toEqual([]);

    // Both sides must grant for a tool to be usable.
    const both = effectivePermissions({ agentCapabilityGroups: ["code.write"], userPermissions: ["code.write"] });
    expect(both.capabilities).toContain("code.fs.write");

    // `code.*` is the only wildcard, and it still cannot create a group the agent lacks.
    const wildcard = effectivePermissions({ agentCapabilityGroups: [], userPermissions: ["code.*"] });
    expect(wildcard.capabilities).toEqual([]);
  });

  it("lets a project rule narrow but never widen, and a denial always wins", () => {
    const base = { agentCapabilityGroups: ["code.read", "code.write"], userPermissions: ["code.*"] };
    const narrowed = effectivePermissions({ ...base, projectRules: { allow: ["code.fs.read"] } });
    expect(narrowed.capabilities).toEqual(["code.fs.read"]);
    expect(narrowed.denied.find((entry) => entry.capabilityId === "code.fs.write")?.reason).toBe("project_rule_not_allowed");

    const denied = effectivePermissions({ ...base, projectRules: { deny: ["code.fs.read"] } });
    expect(denied.capabilities).not.toContain("code.fs.read");
    expect(denied.denied.find((entry) => entry.capabilityId === "code.fs.read")?.reason).toBe("project_rule_denied");

    // A project rule can never grant what the agent's groups do not include.
    const widened = effectivePermissions({
      agentCapabilityGroups: [],
      userPermissions: ["code.*"],
      projectRules: { allow: ["code.shell.exec"] },
    });
    expect(widened.capabilities).toEqual([]);
  });

  it("derives the Inspector view from groups only", () => {
    expect(capabilitiesForGroups(["code.read"])).toEqual(expect.arrayContaining(["code.fs.read", "code.fs.grep"]));
    expect(capabilitiesForGroups([])).toEqual([]);
    expect(capabilitiesForGroups(["code.git"])).toEqual([]);
  });
});
