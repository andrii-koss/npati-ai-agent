import { randomUUID } from "node:crypto";

export interface ActionMemoryRule {
  id: string;
  companyId: string;
  actionName: string; // e.g. "stripe_charge", "deploy_cluster", "database_migration"
  title: string;
  instruction: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: string;
}

export class ActionSensitiveMemoryEngine {
  private readonly rules = new Map<string, ActionMemoryRule[]>();

  private getKey(companyId: string): string {
    return companyId;
  }

  /**
   * 1. Register an action-sensitive memory rule
   */
  registerRule(params: {
    companyId: string;
    actionName: string;
    title: string;
    instruction: string;
    riskLevel?: "low" | "medium" | "high";
  }): ActionMemoryRule {
    const rule: ActionMemoryRule = {
      id: `actmem_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      companyId: params.companyId,
      actionName: params.actionName.toLowerCase(),
      title: params.title,
      instruction: params.instruction,
      riskLevel: params.riskLevel ?? "medium",
      createdAt: new Date().toISOString(),
    };

    const list = this.rules.get(this.getKey(params.companyId)) || [];
    list.push(rule);
    this.rules.set(this.getKey(params.companyId), list);

    return rule;
  }

  /**
   * 2. Retrieve memories specifically triggered by planned tools / actions
   */
  getActionMemories(companyId: string, plannedActions: string[]): ActionMemoryRule[] {
    const list = this.rules.get(this.getKey(companyId)) || [];
    const normalizedActions = plannedActions.map((a) => a.toLowerCase());

    return list.filter((rule) =>
      normalizedActions.some((action) => action.includes(rule.actionName) || rule.actionName.includes(action))
    );
  }

  /**
   * 3. Inject action-sensitive constraints into system prompt
   */
  injectActionMemories(
    companyId: string,
    basePrompt: string,
    plannedActions: string[]
  ): { prompt: string; injectedRulesCount: number } {
    const matchingRules = this.getActionMemories(companyId, plannedActions);
    if (matchingRules.length === 0) {
      return { prompt: basePrompt, injectedRulesCount: 0 };
    }

    const ruleLines = matchingRules.map(
      (r) => `- [ACTION: ${r.actionName.toUpperCase()}] ${r.title}: ${r.instruction}`
    );

    const injected = [
      "<action_sensitive_memory>",
      "Crucial operational guidelines for detected planned actions:",
      ...ruleLines,
      "</action_sensitive_memory>",
      "",
      basePrompt,
    ].join("\n");

    return {
      prompt: injected,
      injectedRulesCount: matchingRules.length,
    };
  }
}
