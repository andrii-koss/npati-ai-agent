import type { AgentSkill } from "../types";

export const webResearchSkill: AgentSkill = {
  id: "web-research",
  name: "Web Research",
  description: "Searches and reads public web sources through the protected NPATI Web Research boundary.",
  version: "0.1.0",
  capabilities: ["web.search", "web.fetch", "web.crawl"],
  inputSchema: { type: "object", properties: { query: { type: "string" }, url: { type: "string" } } },
  canHandle: ({ userMessage }) => /https?:\/\/|web research|search the web|досліди|пошук в інтернеті/iu.test(userMessage),
  async run() { return { message: "I can research public web sources and cite what I find.", suggestedActions: [] }; },
};
