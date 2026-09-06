import type { ToolPolicyEngine } from "./tool-policy-engine";

export interface SubagentDelegationScope {
  parentAgentId: string;
  parentAllowedTools: string[];
  childAgentId: string;
  childBaseTools: string[];
  delegationAllowedTools?: string[]; // Caller-specified explicit tool subset
}

export interface SubagentToolPolicyResult {
  permittedTools: string[];
  deniedTools: Array<{
    tool: string;
    reason: string;
  }>;
  escalationAttempts: string[];
}

export class SubagentToolPolicyGuard {
  constructor(private readonly policyEngine?: ToolPolicyEngine) {}

  /**
   * Resolves permitted tools for a child sub-agent under a parent agent delegation
   * Invariant: Child sub-agents can NEVER escalate permissions beyond their parent agent.
   */
  evaluateSubagentTools(scope: SubagentDelegationScope): SubagentToolPolicyResult {
    const parentSet = new Set(scope.parentAllowedTools.map((t) => t.trim().toLowerCase()));
    const childSet = new Set(scope.childBaseTools.map((t) => t.trim().toLowerCase()));
    
    // If caller specified an explicit delegation tool subset, use that; otherwise use childBaseTools
    const candidateTools = scope.delegationAllowedTools && scope.delegationAllowedTools.length > 0
      ? scope.delegationAllowedTools.map((t) => t.trim().toLowerCase())
      : Array.from(childSet);

    const permittedTools: string[] = [];
    const deniedTools: Array<{ tool: string; reason: string }> = [];
    const escalationAttempts: string[] = [];

    for (const tool of candidateTools) {
      // 1. Check Privilege Escalation Invariant:
      // If parent agent is not permitted to use this tool, child agent CANNOT use it!
      const parentHasWildcard = parentSet.has("*") || parentSet.has("all");
      if (!parentHasWildcard && !parentSet.has(tool)) {
        escalationAttempts.push(tool);
        deniedTools.push({
          tool,
          reason: `PRIVILEGE_ESCALATION_BLOCKED: Sub-agent '${scope.childAgentId}' requested '${tool}', which is not allowed for parent agent '${scope.parentAgentId}'.`,
        });
        continue;
      }

      // 2. Check Global Tool Policy Engine (if attached)
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
      deniedTools,
      escalationAttempts,
    };
  }
}
