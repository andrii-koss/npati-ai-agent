import type { ChatToolDefinition } from "@npati/omniroute-adapter";

/** Native entry point for the existing BusinessActionHandler goal implementation. */
export const GOAL_ACTION_TOOL: ChatToolDefinition = {
  type: "function", function: {
    name: "npati_goal_action",
    description: "Create, update, complete, assign or delete a Business Goal. Use owned business and goal IDs from context. Assignment records responsibility; it does not execute the agent. Only report success from the returned persisted goal.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "businessId"],
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"] },
        businessId: { type: "string" }, goalId: { type: "string" },
        goal: { type: "object", additionalProperties: false, properties: {
          title: { type: "string" }, description: { type: "string" }, priority: { type: "integer", enum: [1, 2, 3] },
          status: { type: "string", enum: ["active", "completed", "paused", "cancelled"] },
          targetValue: { type: "number" }, currentValue: { type: "number" }, targetUnit: { type: "string" }, targetDate: { type: "string" },
          assignedAgent: { type: ["string", "null"], description: "Exact owned Company Agent name or ID; null removes assignment." },
          assignedCompany: { type: "string", description: "Exact company name or ID to disambiguate the assigned agent." },
        } },
      },
    },
  },
};
