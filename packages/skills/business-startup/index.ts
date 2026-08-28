import { createStartupPlan } from "@npati/business-brain";
import type { AgentSkill } from "../types";

export const businessStartupSkill: AgentSkill = {
  id: "business-startup",
  name: "Business Startup",
  description: "Shape a business idea, audience, offer, and first validation plan.",
  version: "1.0.0",
  capabilities: ["business-idea", "niche", "audience", "validation"],
  inputSchema: { type: "object", required: ["userMessage"], properties: { userMessage: { type: "string" } } },
  canHandle: ({ userMessage }) => /start|launch|business|idea/i.test(userMessage),
  async run() {
    const steps = createStartupPlan().map((step) => step.title);
    return {
      message: "Let’s turn the idea into a focused first business test. What customer problem do you want to solve?",
      suggestedActions: steps,
    };
  },
};
