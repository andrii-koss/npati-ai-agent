import type { ToolPolicyEngine } from "./tool-policy-engine";
import { CODE_SUBAGENT_WILDCARDS, resolveEffectiveToolSet } from "./code-subagent-limits";

export interface SubagentDelegationScope {
  parentAgentId: string;
  /**
   * What the parent may use. It is **not** trusted as a grant on its own: a `*`/`all` entry is resolved
   * against `canonicalTools` (see below) and never means "everything".
   */
  parentAllowedTools: string[];
  childAgentId: string;
  /**
   * The child **type**'s own profile: the tools this kind of subagent exists to use. It is intersected with
   * the parent's effective set — a wide profile cannot widen a delegation.
   */
  childBaseTools: string[];
  /**
   * The delegation record the server wrote when it authorised the spawn. Also intersected, never a grant:
   * this is why a model argument asking for more can only ever produce less.
   */
  delegationAllowedTools?: string[];
  /**
   * The deployment's canonical tool universe (the published registry).
   *
   * C12: this is the only thing `*`/`all` can expand to. Without it a wildcard resolves to **nothing** and the
   * result says so, because the previous behaviour — `parentSet.has("*")` short-circuiting the escalation
   * invariant — was a fail-open that turned any parent with a wildcard into an unlimited parent.
   */
  canonicalTools?: readonly string[];
}

export interface SubagentToolPolicyResult {
  /** Exactly the intersection `parentEffective ∩ childType ∩ delegationRecord`. Never the requested set. */
  permittedTools: string[];
  /**
   * C12: the parent's effective set, computed **once** here. Callers reuse this object instead of re-deriving
   * the parent's capabilities, which is what kept a second (and third) tool list in circulation.
   */
  effectiveParentTools: string[];
  /** True when a wildcard was present with no canonical universe to expand into, so nothing was granted. */
  wildcardUnresolved: boolean;
  deniedTools: Array<{
    tool: string;
    reason: string;
  }>;
  /** Tools the child asked for that the parent provably does not hold. These are escalation attempts. */
  escalationAttempts: string[];
}

function normalize(entries: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    if (typeof entry !== "string") continue;
    const key = entry.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export class SubagentToolPolicyGuard {
  constructor(private readonly policyEngine?: ToolPolicyEngine) {}

  /**
   * Resolves the tools a child sub-agent may use under a parent delegation.
   *
   * Invariant (C12, tightened): the child's set is an **intersection** —
   * `parentEffective ∩ childTypeProfile ∩ delegationRecord` — and never the requested set. Two failure modes
   * that used to be silent are now explicit:
   *  - `*`/`all` in the parent is expanded only against `canonicalTools`; with no universe it grants nothing
   *    (`wildcardUnresolved`), so a wildcard can no longer short-circuit the escalation invariant;
   *  - a requested tool outside the parent's effective set is an escalation attempt, and a tool inside it but
   *    outside the child's type profile is denied with its own reason instead of being granted.
   */
  evaluateSubagentTools(scope: SubagentDelegationScope): SubagentToolPolicyResult {
    const parent = resolveEffectiveToolSet(scope.parentAllowedTools, scope.canonicalTools);
    const parentSet = new Set(parent.tools.map((tool) => tool.toLowerCase()));
    const typeProfile = normalize(scope.childBaseTools);
    const delegationRecord = scope.delegationAllowedTools && scope.delegationAllowedTools.length > 0
      ? normalize(scope.delegationAllowedTools)
      : null;

    /**
     * The candidate list is the request (or, with no request, the child type's profile). `*` inside it is
     * resolved against the parent's effective set — the widest thing a delegation can legitimately ask for —
     * so even a wildcard *request* cannot exceed the parent.
     */
    const requested = delegationRecord ?? (typeProfile.length ? typeProfile : null);
    const candidates: string[] = [];
    const seen = new Set<string>();
    if (requested === null) {
      for (const tool of parentSet) {
        if (seen.has(tool)) continue;
        seen.add(tool);
        candidates.push(tool);
      }
    } else {
      for (const entry of requested) {
        if (CODE_SUBAGENT_WILDCARDS.has(entry)) {
          for (const tool of parentSet) {
            if (seen.has(tool)) continue;
            seen.add(tool);
            candidates.push(tool);
          }
          continue;
        }
        if (seen.has(entry)) continue;
        seen.add(entry);
        candidates.push(entry);
      }
    }

    const permittedTools: string[] = [];
    const deniedTools: Array<{ tool: string; reason: string }> = [];
    const escalationAttempts: string[] = [];

    for (const tool of candidates) {
      // 1. Privilege escalation invariant: a tool the parent does not effectively hold can never be delegated.
      if (!parentSet.has(tool)) {
        escalationAttempts.push(tool);
        deniedTools.push({
          tool,
          /**
           * Two distinct reasons, because an operator needs to tell "the parent does not have this tool" from
           * "the parent's grant could not be resolved at all". Both refuse; only the second one is a delegation
           * record to fix, and neither is silence.
           */
          reason: parent.wildcardUnresolved
            ? `PARENT_WILDCARD_SCOPE_UNRESOLVED: parent agent '${scope.parentAgentId}' holds a wildcard that no canonical tool universe was supplied for, so '${tool}' cannot be granted to sub-agent '${scope.childAgentId}'.`
            : `PRIVILEGE_ESCALATION_BLOCKED: Sub-agent '${scope.childAgentId}' requested '${tool}', which is not allowed for parent agent '${scope.parentAgentId}'.`,
        });
        continue;
      }

      // 2. The child type's own profile narrows the parent's set; it can never extend it.
      if (typeProfile.length > 0 && !typeProfile.includes(tool)) {
        deniedTools.push({
          tool,
          reason: `CHILD_TYPE_PROFILE_EXCLUDES: '${tool}' is permitted for parent agent '${scope.parentAgentId}' but not part of sub-agent '${scope.childAgentId}' type profile.`,
        });
        continue;
      }

      // 3. Global Tool Policy Engine (if attached).
      if (this.policyEngine) {
        const evaluation = this.policyEngine.evaluate(tool, { role: "subagent" });
        if (!evaluation.allowed) {
          deniedTools.push({
            tool,
            reason: evaluation.reason,
          });
          continue;
        }
      }

      permittedTools.push(tool);
    }

    return {
      permittedTools,
      effectiveParentTools: parent.tools,
      wildcardUnresolved: parent.wildcardUnresolved,
      deniedTools,
      escalationAttempts,
    };
  }
}
