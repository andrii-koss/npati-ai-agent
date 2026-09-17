export interface BusinessBrainContext {
  business: Record<string, unknown> | null;
  goals: Array<Record<string, unknown>>;
  memory: Array<Record<string, unknown>>;
  skills: Array<{ id: string; name: string; description: string; capabilities: string[] }>;
  selectedSkill?: { id: string; name: string; description: string };
  connections: Array<{ provider: string; connected: boolean; capabilities: string[]; status: string }>;
  ai: { mode: "automatic" | "manual"; model: string };
}

export function buildBusinessAgentInstruction(context: BusinessBrainContext) {
  return `You are NPATI Agent, an AI Business Agent. You are not a generic chatbot.

Your job is to understand the current business, help the user make decisions, explain recommendations, and produce practical next actions. Never promise guaranteed profit. Never invent business facts, connected services, completed actions, or metrics. Ask a focused question when an important fact is missing.

Current normalized context (only data authorized for this request):
${JSON.stringify(context, null, 2)}

Rules:
- Always answer in the same language as the user's latest message. If the user changes language, change with them.
- Ground the answer in the current business, active goals, and relevant memory above.
- Keep recommendations realistic for the business stage, audience, market, and available channels.
- Third-party external services (e.g. ad networks, external CRM) write actions require connected integrations.
- Internal Workspace Business Profiles and Workspace Goals ARE fully supported native capabilities: you CAN and MUST create, add, and edit them directly whenever the user asks, using the business-action and goal-action directives provided below. NEVER state that you cannot edit or save business settings, profiles, or goals in this chat.
- Structure substantial answers with a short recommendation, reasoning, and 3-5 concrete next actions.
- If there is no current business, help the user define one instead of fabricating context.`;
}

export function detectMemoryCandidate(message: string) {
  const patterns: Array<{ expression: RegExp; type: string; title: string }> = [
    { expression: /(?:my|our) (?:main |target )?(?:customers|audience) (?:are|is) (.+)/i, type: "audience", title: "Target audience" },
    { expression: /(?:i|we) prefer (.+)/i, type: "preference", title: "Business preference" },
    { expression: /(?:we decided|my decision is|our decision is) (.+)/i, type: "decision", title: "Decision" },
    { expression: /(?:our|my) brand (?:voice|tone) is (.+)/i, type: "brand", title: "Brand voice" },
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern.expression);
    if (match?.[1]) return { type: pattern.type, title: pattern.title, content: match[1].trim().replace(/[.!?]+$/, "") };
  }
  return undefined;
}
