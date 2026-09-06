export type ToolPolicyEffect = "allow" | "deny" | "require_approval";

export interface ToolPolicyRule {
  id: string;
  effect: ToolPolicyEffect;
  toolPattern: string; // e.g. "web.*", "mcp.*", "files.delete", "*"
  roles?: string[];    // optional role restrictions
  reason?: string;
  priority?: number;  // higher priority evaluated first
}

export interface ToolPolicyEvaluation {
  decision: ToolPolicyEffect;
  allowed: boolean;
  requiresApproval: boolean;
  matchedRule?: ToolPolicyRule;
  reason: string;
}

export class ToolPolicyEngine {
  private readonly rules: ToolPolicyRule[] = [];

  constructor(initialRules: ToolPolicyRule[] = []) {
    this.rules = [...initialRules];
  }

  addRule(rule: ToolPolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  getRules(): ToolPolicyRule[] {
    return [...this.rules];
  }

  private matchesPattern(pattern: string, tool: string): boolean {
    if (pattern === "*" || pattern === "all") return true;
    if (pattern === tool) return true;

    // Convert pattern like "web.*" to regex
    const regexPattern = "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
    return new RegExp(regexPattern, "i").test(tool);
  }

  /**
   * Evaluates whether a tool execution is permitted given the tool name, agent role, and context
   */
  evaluate(toolName: string, options: { role?: string; isHumanConfirmed?: boolean } = {}): ToolPolicyEvaluation {
    const normalizedTool = toolName.trim().toLowerCase();
    const role = options.role?.trim().toLowerCase();

    for (const rule of this.rules) {
      if (this.matchesPattern(rule.toolPattern, normalizedTool)) {
        // Check role filter if specified
        if (rule.roles && rule.roles.length > 0) {
          if (!role || !rule.roles.some((r) => r.toLowerCase() === role)) {
            continue; // Rule doesn't match this role, check next
          }
        }

        if (rule.effect === "deny") {
          return {
            decision: "deny",
            allowed: false,
            requiresApproval: false,
            matchedRule: rule,
            reason: rule.reason ?? `Tool '${toolName}' is blocked by security policy rule '${rule.id}'.`,
          };
        }

        if (rule.effect === "require_approval") {
          if (options.isHumanConfirmed) {
            return {
              decision: "allow",
              allowed: true,
              requiresApproval: false,
              matchedRule: rule,
              reason: `Tool '${toolName}' executed with verified human approval.`,
            };
          }
          return {
            decision: "require_approval",
            allowed: false,
            requiresApproval: true,
            matchedRule: rule,
            reason: rule.reason ?? `Tool '${toolName}' requires explicit human approval before execution.`,
          };
        }

        if (rule.effect === "allow") {
          return {
            decision: "allow",
            allowed: true,
            requiresApproval: false,
            matchedRule: rule,
            reason: rule.reason ?? `Tool '${toolName}' is allowed by policy rule '${rule.id}'.`,
          };
        }
      }
    }

    // Default safety behavior: allow unless dangerous destructive action
    const isDestructive = /delete|drop|destroy|purge|truncate|rmdir|exec|shell|bash/i.test(normalizedTool);
    if (isDestructive) {
      return {
        decision: "require_approval",
        allowed: false,
        requiresApproval: true,
        reason: `Destructive tool '${toolName}' requires human approval by default safety policy.`,
      };
    }

    return {
      decision: "allow",
      allowed: true,
      requiresApproval: false,
      reason: `Tool '${toolName}' allowed under default policy.`,
    };
  }
}
