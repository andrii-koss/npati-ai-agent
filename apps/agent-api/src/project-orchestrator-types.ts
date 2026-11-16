export class ProjectOrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ProjectOrchestrationError";
  }
}

export function isModelError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/InferenceRouteFailure|SelfHealingExhaustedError|OmniRouteError|model_routing_failed|model_unavailable|No chat-compatible inference model|AI inference failed|(?:NPATI AI|OmniRoute) chat failed|Provider returned empty content/i.test(msg)) {
    return true;
  }
  if (/\b(?:401|403|404)\b/i.test(msg) && /\b(?:model|route|provider|unsupported|denied|auth|unauthorized|not found)\b/i.test(msg)) {
    return true;
  }
  if (/\b(?:does not support|unsupported model|no valid candidate)\b/i.test(msg)) {
    return true;
  }
  return false;
}

export function extractCleanProjectName(prompt: string, explicitName?: string): string {
  if (explicitName && explicitName.trim()) {
    const trimmed = explicitName.trim().replace(/^["'«]+|["'»]+$/g, "");
    if (trimmed.length > 0) return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  let cleaned = (prompt || "").trim();

  const commandPatterns = [
    /^(?:створи(?: мені)?|зроби(?: мені)?|розроби(?: мені)?|побудуй|запусти|згенеруй|відкрий)\s+(?:(?:новий|сучасний|адаптивний|тестовий|демо)\s+)*(?:веб-?сайт|сайт|проєкт|проект|лендінг|додаток)(?:\s+(?:для|під|про|компанії))?/iu,
    /^(?:створи(?:ти)?|зроби(?:ти)?)\s+(?:новий\s+)?(?:веб-?сайт|сайт|проєкт|проект)/iu,
    /^(?:please\s+)?(?:create|build|make|generate|launch|develop)(?:\s+me)?(?:\s+a)?\s+(?:(?:new|modern|responsive|test|demo)\s+)*(?:website|site|project|landing(?:\s+page)?|web\s*app)(?:\s+(?:for|about))?/iu,
  ];

  for (const pattern of commandPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  // A name the person put in quotes right after the command is the name, exactly. Without the model (a provider
  // outage) the fallback kept the closing quote and the description: "V6TEST18 Retry Site» — проста сторінка…",
  // and the repeated request then created a second project (V6 step 18).
  const quoted = cleaned.match(/^[«“"„]([^»”"“\n]{2,80})[»”"“]/u);
  if (quoted?.[1]?.trim()) {
    const name = quoted[1].trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  // Framework and execution instructions belong in the description, not the display name.
  cleaned = cleaned.replace(/\s+(?:на|on|using|with)\s+(?:next\.?js|react|vite|expo|html(?:\/css)?)(?:\b|(?=\s|[,.;]))[\s\S]*$/iu, "").trim();
  cleaned = cleaned.replace(/[,;]\s*(?:запусти|збери|покажи|run|build|start|launch)(?:\s|$)[\s\S]*$/iu, "").trim();

  cleaned = cleaned.replace(/^[,:;—–\-.\s]+/, "").trim();

  const firstSentence = cleaned.split(/(?:\.\s+|\n+)/)[0]?.trim() || "";
  if (firstSentence && firstSentence.length >= 2 && firstSentence.length <= 60) {
    cleaned = firstSentence;
  }

  cleaned = cleaned.replace(/[,:;—–\-.\s]+$/, "").trim();
  cleaned = cleaned.replace(/^["'«]+|["'»]+$/g, "").trim();

  if (!cleaned || cleaned.length < 2) {
    return "Website Project";
  }

  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}
