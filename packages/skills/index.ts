export { businessStartupSkill } from "./business-startup";
export { businessGrowthSkill } from "./business-growth";
export { sellProductSkill } from "./sell-product";
export { webResearchSkill } from "./web-research";
export { competitorAnalysisSkill } from "./competitor-analysis";
export { SkillRegistry } from "./types";
export type { AgentSkill, SkillContext, SkillResult } from "./types";

import { businessStartupSkill } from "./business-startup";
import { businessGrowthSkill } from "./business-growth";
import { sellProductSkill } from "./sell-product";
import { webResearchSkill } from "./web-research";
import { competitorAnalysisSkill } from "./competitor-analysis";
import { SkillRegistry } from "./types";

export const defaultSkillRegistry = new SkillRegistry([competitorAnalysisSkill, webResearchSkill, businessStartupSkill, businessGrowthSkill, sellProductSkill]);

export const plannedSkillIds = [
  "business-audit",
  "listing-creator",
  "listing-optimizer",
  "seo",
  "content",
  "social-media",
  "market-research",
  "marketplace-advisor",
] as const;
