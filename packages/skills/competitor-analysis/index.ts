import type { AgentSkill } from "../types";

export const competitorAnalysisSkill: AgentSkill = {
  id: "competitor-analysis",
  name: "Competitor Analysis",
  description: "Finds relevant competitors and compares public evidence with the current Business context.",
  version: "0.1.0",
  capabilities: ["competitors.discover", "competitors.compare", "web.search", "web.fetch", "web.crawl"],
  inputSchema: { type: "object", properties: { competitorUrl: { type: "string" }, refresh: { type: "boolean" } } },
  canHandle: ({ userMessage }) => /competitor|competition|конкурент/iu.test(userMessage),
  async run() { return { message: "I can compare competitors using your current Business and cited public sources.", suggestedActions: [] }; },
};
