/**
 * C5: capability groups.
 *
 * This is *not* a second permission system. It maps the existing feature/capability groups
 * (`code.read`, `code.write`, `code.shell`, `code.git`) onto the `code.*` capability ids that
 * already exist in the canonical registry, and computes effective permissions as the intersection of
 * the agent's capability groups, the user's permissions and the project's rules. The result is
 * consulted in the PolicyEngine's `capability` phase, which runs **before** risk classification and
 * approval: a tool the agent has no group for is refused with `capability_not_granted` and no
 * approval is ever requested for it.
 */

export const CODE_GROUPS = ["code.read", "code.write", "code.shell", "code.git"] as const;
export type CodeGroup = (typeof CODE_GROUPS)[number];

/**
 * Canonical `code.*` capabilities per group. Capability ids equal the tool names, which is how the
 * canonical registry already models them (C2/C3/C4/C4a); keep this map the single place where a new
 * tool is assigned to a group.
 */
export const CODE_CAPABILITY_GROUPS: Record<CodeGroup, string[]> = {
  "code.read": [
    "code.fs.list",
    "code.fs.read",
    "code.fs.grep",
    "code.fs.tree",
    "code.symbols.outline",
    "code.project.info",
    "code.fs.diff",
    "code.deps.inspect",
  ],
  "code.write": [
    "code.fs.edit",
    "code.fs.apply_patch",
    "code.fs.write",
    "code.fs.move",
    "code.fs.delete",
    "code.fs.undo_last_turn",
  ],
  "code.shell": [
    "code.shell.exec",
    "code.shell.process.start",
    "code.shell.process.list",
    "code.shell.process.logs",
    "code.shell.process.stop",
    "code.verify.run",
    "code.deps.add",
    "code.deps.audit",
  ],
  // Reserved: Git tooling arrives in a later step; the group exists so RBAC and flags can already be
  // expressed against it. TODO(C8): add code.git.* capabilities here when they ship.
  "code.git": [],
};

const TOOL_TO_GROUP: Record<string, CodeGroup> = Object.entries(CODE_CAPABILITY_GROUPS)
  .flatMap(([group, tools]) => tools.map((tool) => [tool, group as CodeGroup] as const))
  .reduce<Record<string, CodeGroup>>((accumulator, [tool, group]) => {
    accumulator[tool] = group;
    return accumulator;
  }, {});

export function groupForCapability(capabilityId: string): CodeGroup | null {
  return TOOL_TO_GROUP[capabilityId] ?? null;
}

export function isCodeCapability(capabilityId: string): boolean {
  return capabilityId.startsWith("code.");
}

export interface ProjectCapabilityRules {
  /** Capability ids the project allows; empty/absent means "inherit" (no narrowing). */
  allow?: string[];
  /** Capability ids the project forbids; always wins. */
  deny?: string[];
}

export interface EffectivePermissionsInput {
  /** Capability groups granted to the Company agent. */
  agentCapabilityGroups: string[];
  /** Capability ids (or `code.*` groups) the acting user is allowed to use. Empty means no user grant. */
  userPermissions: string[];
  projectRules?: ProjectCapabilityRules | null;
}

export interface EffectivePermissions {
  capabilities: string[];
  denied: Array<{ capabilityId: string; reason: string }>;
}

export class CodeCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeCapabilityError";
  }
}

function asSet(values: string[] | undefined | null): Set<string> {
  return new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0));
}

/**
 * Effective permissions = agent capability groups ∩ user permissions ∩ project rules.
 * An unknown `code.*` capability that belongs to no group is denied (fail closed), never allowed by
 * omission.
 */
export function effectivePermissions(input: EffectivePermissionsInput): EffectivePermissions {
  const agent = asSet(input.agentCapabilityGroups);
  const user = asSet(input.userPermissions);
  const allow = new Set(input.projectRules?.allow ?? []);
  const deny = asSet(input.projectRules?.deny);
  const capabilities: string[] = [];
  const denied: Array<{ capabilityId: string; reason: string }> = [];

  const allCapabilities = Array.from(new Set(Object.values(CODE_CAPABILITY_GROUPS).flat()));
  for (const capabilityId of allCapabilities) {
    const group = groupForCapability(capabilityId);
    if (!group) {
      denied.push({ capabilityId, reason: "capability_has_no_group" });
      continue;
    }
    if (deny.has(capabilityId) || deny.has(group)) {
      denied.push({ capabilityId, reason: "project_rule_denied" });
      continue;
    }
    if (allow.size > 0 && !allow.has(capabilityId) && !allow.has(group)) {
      denied.push({ capabilityId, reason: "project_rule_not_allowed" });
      continue;
    }
    if (!agent.has(group) && !agent.has(capabilityId)) {
      denied.push({ capabilityId, reason: "agent_group_missing" });
      continue;
    }
    // Fail closed: an empty user permission list grants nothing. `code.*` is the only wildcard and is
    // reserved for admins, so a missing grant is never "inherit everything".
    if (!user.has(capabilityId) && !user.has(group) && !user.has("code.*")) {
      denied.push({ capabilityId, reason: "user_permission_missing" });
      continue;
    }
    capabilities.push(capabilityId);
  }
  return { capabilities, denied };
}

export function isCapabilityGranted(input: EffectivePermissionsInput, capabilityId: string): boolean {
  return effectivePermissions(input).capabilities.includes(capabilityId);
}

/**
 * Throws `capability_not_granted` when the agent may not use this capability at all. Called from the
 * PolicyEngine's capability phase, i.e. before approvals, so an approval is never requested for
 * something the agent was never allowed to do.
 */
export function assertCapabilityGranted(input: EffectivePermissionsInput, capabilityId: string): void {
  if (!isCodeCapability(capabilityId)) return;
  const effective = effectivePermissions(input);
  if (effective.capabilities.includes(capabilityId)) return;
  const detail = effective.denied.find((entry) => entry.capabilityId === capabilityId);
  throw new CodeCapabilityError("capability_not_granted", "The agent does not hold the capability group for this tool", 403, {
    reason: detail?.reason ?? "agent_group_missing",
    capabilityId,
    group: groupForCapability(capabilityId),
  });
}

/** Convenience for the Inspector/UI: the groups an agent holds, expressed as capability ids. */
export function capabilitiesForGroups(groups: string[]): string[] {
  return effectivePermissions({ agentCapabilityGroups: groups, userPermissions: ["code.*"] }).capabilities;
}
