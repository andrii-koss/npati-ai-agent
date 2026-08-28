import type { AgentSkill } from "../types";

export const sellProductSkill: AgentSkill = {
  id: "sell-product",
  name: "Sell Product",
  description: "Turn a product or service into a clear offer and sales plan.",
  version: "1.0.0",
  capabilities: ["offer", "positioning", "pricing", "sales-channel"],
  inputSchema: { type: "object", required: ["userMessage"], properties: { userMessage: { type: "string" } } },
  canHandle: ({ userMessage }) => /sell|product|service|offer|price|pricing|listing/i.test(userMessage),
  async run() {
    return { message: "I’ll use the Sell Product skill to shape a concrete offer.", suggestedActions: ["Define the customer problem", "Write the value proposition", "Choose a sales channel"] };
  },
};
