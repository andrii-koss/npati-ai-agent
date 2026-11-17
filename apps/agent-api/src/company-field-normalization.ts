export const companyFields = new Set(["name", "businessId", "website", "industry", "description", "productsServices", "languages", "brandTone", "companyInstructions", "status"]);
export const agentFields = new Set(["name", "role", "description", "systemInstruction", "promptGuidelines", "recommendedPrompts", "modelId", "fallbackModelId", "tools", "isActive", "sortOrder", "positionX", "positionY"]);
export const toolIds = new Set(["storage.agent_knowledge_retrieval", "storage.company_memory", "research.web_search", "browser.web_fetch", "web.crawl", "mcp", "files", "system.text-to-speech", "exec"]);
export const toolAliases = new Map([
    ["knowledge", "storage.agent_knowledge_retrieval"],
    ["company memory", "storage.company_memory"],
    ["web search", "research.web_search"],
    ["web fetch", "browser.web_fetch"],
    ["crawler", "web.crawl"],
    ["mcp", "mcp"],
    ["files", "files"],
    ["text to speech", "system.text-to-speech"],
    ["code mode exec", "exec"],
    // Runtime IDs used by the Company planner (web.search, web.fetch, audio.speech) name the same tools.
    ["audio speech", "system.text-to-speech"],
]);
export function normalizedLabel(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/[\s_\-/.]+/g, " ").replace(/[^\p{L}\p{N} .]+/gu, "").trim();
}
export function normalizeTool(value: string): string {
    if (toolIds.has(value))
        return value;
    const label = normalizedLabel(value)
        .replace(/\b(?:low|medium|high|critical)\b/giu, "")
        .replace(/\bapproval required\b/giu, "")
        .replace(/\s+/g, " ")
        .trim();
    return toolAliases.get(label) ?? value;
}
export const agentFieldAliases: Record<string, string> = {
    systeminstruction: "systemInstruction",
    systemprompt: "systemInstruction",
    promptguidelines: "promptGuidelines",
    recommendedprompts: "recommendedPrompts",
    toolsandcapabilities: "tools",
    toolscapabilities: "tools",
    capabilities: "tools",
    toolids: "tools",
    modelid: "modelId",
    fallbackmodelid: "fallbackModelId",
    isactive: "isActive",
    sortorder: "sortOrder",
    positionx: "positionX",
    positiony: "positionY",
};
export const companyFieldAliases: Record<string, string> = {
    companyname: "name",
    businessid: "businessId",
    products: "productsServices",
    services: "productsServices",
    productsandservices: "productsServices",
    productservices: "productsServices",
    brandtone: "brandTone",
    instructions: "companyInstructions",
    companyinstructions: "companyInstructions",
};
export function compactKey(value: string): string {
    return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}
export function normalizeCompanyFields(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const result: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        if (rawValue === null || rawValue === undefined)
            continue;
        const key = companyFieldAliases[compactKey(rawKey)] ?? rawKey;
        let item = rawValue;
        if (key === "languages" && typeof item === "string")
            item = item.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
        if (key === "status" && typeof item === "string")
            item = item.toLocaleLowerCase();
        result[key] = item;
    }
    return result;
}
export function normalizeAgentFields(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const source = value as Record<string, unknown>;
    const expanded: Record<string, unknown> = { ...source };
    if (source.instructions && typeof source.instructions === "object" && !Array.isArray(source.instructions)) {
        Object.assign(expanded, source.instructions);
        delete expanded.instructions;
    }
    else if (typeof source.instructions === "string" && source.systemInstruction === undefined) {
        expanded.systemInstruction = source.instructions;
        delete expanded.instructions;
    }
    const result: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(expanded)) {
        if (rawValue === null || rawValue === undefined)
            continue;
        const key = agentFieldAliases[compactKey(rawKey)] ?? rawKey;
        let item = rawValue;
        if (key === "recommendedPrompts" && typeof item === "string") {
            item = item.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
        }
        if (key === "tools" && typeof item === "string") {
            item = item.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
        }
        // Guidelines or an instruction given as a list of lines is the same text: rejecting it left a Dutch "add agent"
        // request without the agent ("Invalid promptGuidelines", V6 step 14).
        if (["promptGuidelines", "systemInstruction", "description", "role"].includes(key) && Array.isArray(item) && item.every((part) => typeof part === "string")) {
            item = item.map((part) => (part as string).trim()).filter(Boolean).join("\n");
        }
        // Unknown tools are kept so validation refuses them: dropping them silently saved [] and reported success.
        if (key === "tools" && Array.isArray(item))
            item = item
                .map((part) => typeof part === "string" ? normalizeTool(part) : part)
                .filter((part): part is string => typeof part === "string");
        result[key] = item;
    }
    return result;
}
