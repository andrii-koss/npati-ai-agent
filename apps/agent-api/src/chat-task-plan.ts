import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";

export interface StructuredChatPlan {
  primary_action: string;
  entity: string;
  provided_fields: Record<string, string>;
  secondary_actions: string[];
  dependencies: string[];
  completion_criteria: string[];
  requires_external_research?: boolean;
  company_fields?: Record<string, string>;
  company_agents?: Array<{ name: string; role: string; responsibilities: string[]; main?: boolean; parent_name?: string }>;
  company_agent_count?: number;
  company_agent_rules?: string[];
  company_coordination?: string;
}

export async function planStructuredChatRequest(ai: AIEngine, request: ChatRequest, userMessage: string): Promise<StructuredChatPlan | undefined> {
  // Structure/size determines whether a planning call is useful; the model determines intent semantically.
  if (userMessage.length < 900 || userMessage.split(/\r?\n/).length < 8) return undefined;
  const response = await ai.chat({
    ...request,
    messages: [
      { role: "system", content: "Analyze the complete user request as one task. Return ONLY a JSON object with primary_action (create_business_profile, create_company, research, answer, or a concise semantic action), entity, provided_fields (exact user values mapped to Business Profile fields when applicable), secondary_actions, dependencies, completion_criteria, and requires_external_research (boolean). Distinguish a Business Profile from an AI Company with agents. Map provided_fields to these canonical Business Profile keys: name, businessType, businessStage, industry, niche, country, market, teamType, presenceType, businessModel, website, legalName, contactEmail, contactPhone, postalAddress, description, productsServicesSummary, audienceSummary, registrationDetails; put Goal and Memory in secondary_actions, not provided_fields. For AI Company creation, also return company_fields (name, industry, description and other supplied company fields), company_agents (every named agent with exact name, role, all responsibilities, main flag, and parent_name when specified), company_agent_count (number explicitly requested), company_agent_rules (shared behavior instructions), and company_coordination (hierarchy and delegation instructions). These are separate from Business Profile fields. Include logoAttachmentName only when an actual attachment filename is supplied. Headings and bullet lists are part of the same request. Never invent missing legal, contact, or registration values. No tools, no writes, no prose." },
      ...request.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-6),
      { role: "user", content: userMessage },
    ],
    tools: undefined,
    toolChoice: "none",
  });
  try {
    const parsed = JSON.parse(response.content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()) as Partial<StructuredChatPlan>;
    if (!parsed || typeof parsed.primary_action !== "string" || typeof parsed.entity !== "string") return undefined;
    return {
      primary_action: parsed.primary_action.toLowerCase().trim(),
      entity: parsed.entity,
      provided_fields: parsed.provided_fields && typeof parsed.provided_fields === "object" && !Array.isArray(parsed.provided_fields) ? parsed.provided_fields : {},
      secondary_actions: Array.isArray(parsed.secondary_actions) ? parsed.secondary_actions : [],
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
      completion_criteria: Array.isArray(parsed.completion_criteria) ? parsed.completion_criteria : [],
      requires_external_research: typeof parsed.requires_external_research === "boolean" ? parsed.requires_external_research : undefined,
      company_fields: parsed.company_fields && typeof parsed.company_fields === "object" && !Array.isArray(parsed.company_fields) ? parsed.company_fields : undefined,
      company_agents: Array.isArray(parsed.company_agents) ? parsed.company_agents : undefined,
      company_agent_count: typeof parsed.company_agent_count === "number" && Number.isInteger(parsed.company_agent_count) && parsed.company_agent_count > 0 ? parsed.company_agent_count : undefined,
      company_agent_rules: Array.isArray(parsed.company_agent_rules) ? parsed.company_agent_rules : undefined,
      company_coordination: typeof parsed.company_coordination === "string" ? parsed.company_coordination : undefined,
    };
  } catch { return undefined; }
}

export function businessPlanComplete(plan: StructuredChatPlan | undefined, metadata: Record<string, unknown>[]): boolean {
  if (plan?.primary_action !== "create_business_profile") return true;
  const outcomes = metadata.filter((item) => item.kind === "business_profile").map((item) => item.outcome as {
    complete?: boolean; businessId?: string; savedFields?: Record<string, string>; goalIds?: string[]; memoryIds?: string[];
  }).filter((item) => item?.complete && item.businessId);
  return outcomes.some((primary) => {
    const related = outcomes.filter((item) => item.businessId === primary.businessId);
    const savedFields = Object.assign({}, ...related.map((item) => item.savedFields ?? {})) as Record<string, string>;
    // Source text may contain Markdown, URLs without a scheme, and natural-language enum labels.
    // The executor checks persisted values against canonical tool arguments; check coverage here.
    if (Object.keys(plan.provided_fields).some((key) => savedFields[key] === undefined)) return false;
    const actions = plan.secondary_actions.join(" ").toLowerCase();
    if (/goal/.test(actions) && !related.some((item) => item.goalIds?.length)) return false;
    if (/memor/.test(actions) && !related.some((item) => item.memoryIds?.length)) return false;
    return true;
  });
}
export function companyPlanComplete(plan: StructuredChatPlan | undefined, metadata: Record<string, unknown>[]): boolean {
  if (plan?.primary_action !== "create_company") return true;
  return metadata.some((item) => item.kind === "company" && item.primaryComplete === true);
}
