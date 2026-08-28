import type { AgentSkill } from "../types";

export const businessGrowthSkill: AgentSkill = {
  id: "business-growth",
  name: "Business Growth",
  description: "Find practical acquisition, retention, positioning, and growth opportunities.",
  version: "1.0.0",
  capabilities: ["growth-plan", "customer-acquisition", "retention", "metrics"],
  inputSchema: { type: "object", required: ["userMessage"], properties: { userMessage: { type: "string" } } },
  canHandle: ({ userMessage }) => /grow|growth|more customers|increase sales|revenue|acquisition|retention/i.test(userMessage),
  async run() {
    return { message: "I’ll use the Business Growth skill and adapt the plan to this business.", suggestedActions: ["Review the current offer", "Choose one acquisition channel", "Define a measurable experiment"] };
  },
};
