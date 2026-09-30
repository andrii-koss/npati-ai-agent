import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";

export interface StructuredChatPlan {
  primary_action: string;
  entity: string;
  provided_fields: Record<string, string>;
  secondary_actions: string[];
  dependencies: string[];
  completion_criteria: string[];
  requires_external_research?: boolean;
}

export async function planStructuredChatRequest(ai: AIEngine, request: ChatRequest, userMessage: string): Promise<StructuredChatPlan | undefined> {
  // Structure/size determines whether a planning call is useful; the model determines intent semantically.
  if (userMessage.length < 900 || userMessage.split(/\r?\n/).length < 8) return undefined;
  const response = await ai.chat({
    ...request,
    messages: [
      { role: "system", content: "Analyze the complete user request as one task. Return ONLY a JSON object with primary_action (create_business_profile, create_company, research, answer, or a concise semantic action), entity, provided_fields (exact user values mapped to Business Profile fields when applicable), secondary_actions, dependencies, completion_criteria, and requires_external_research (boolean). Distinguish a Business Profile from an AI Company with agents. Map provided_fields to these canonical Business Profile keys: name, businessType, businessStage, industry, niche, country, market, teamType, presenceType, businessModel, website, legalName, contactEmail, contactPhone, postalAddress, description, productsServicesSummary, audienceSummary, registrationDetails; put Goal and Memory in secondary_actions, not provided_fields. Include logoAttachmentName only when an actual attachment filename is supplied. Headings and bullet lists are part of the same request. Never invent missing legal, contact, or registration values. No tools, no writes, no prose." },
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
    if (Object.entries(plan.provided_fields).some(([key, value]) => {
      const saved = savedFields[key];
      if (saved === undefined || typeof value !== "string") return true;
      const normalize = (text: string) => ["businessStage", "teamType", "presenceType"].includes(key) ? text.trim().toLowerCase() : text.trim();
      return normalize(saved) !== normalize(value);
    })) return false;
    const actions = plan.secondary_actions.join(" ").toLowerCase();
    if (/goal/.test(actions) && !related.some((item) => item.goalIds?.length)) return false;
    if (/memor/.test(actions) && !related.some((item) => item.memoryIds?.length)) return false;
    return true;
  });
}