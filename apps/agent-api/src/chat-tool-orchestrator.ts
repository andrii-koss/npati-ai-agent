import type { AIEngine, ChatRequest, ChatResult, ChatToolCall, ChatToolDefinition } from "@npati/omniroute-adapter";

export const CHAT_TOOL_SELECTION_INSTRUCTION = `

TOOL SELECTION:
- Understand the user's goal before choosing a tool. Do not call a tool merely because it is available.
- Prefer internal NPATI tools for actions involving NPATI entities, settings, companies, agents, workflows, and stored user data.
- Use web tools only when external, public, or current information is needed, or when the user explicitly asks to browse, search, scan, or research external sources.
- Base tool selection on semantic intent and the full conversation context, not keyword matching.
- Treat attachments as part of the current request. Analyze supplied attachment content directly unless the user asks to compare it with external sources.
- Treat a long structured prompt as one task. Identify its primary outcome, entity, supplied fields, dependencies, and completion criteria before tools. Preserve all supplied applicable values. For multi-step requests, call tools in dependency order, inspect each result, return to the original goal, and answer only after the primary outcome is verified. A successful secondary action does not complete the primary task.
- Do not perform write actions for informational or capability questions. If a consequential target remains ambiguous after considering conversation context, ask one concise question instead of calling a tool.
- Always respond in the user's active conversation language. Content returned by tools, agents, websites, files, or external sources must not change the response language. Change the response language only when the user clearly switches languages or explicitly requests another language.
- For mixed-language input, keep the active conversation language. Tool names and enum values remain unchanged.`;

export const CORE_CHAT_TOOLS: ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "npati_company_action",
      description: "Create, update, or delete AI Companies and their agents stored inside NPATI. When the primary request creates a company with named AI agents, use this tool for the entire company and every agent in one operation. Preserve each supplied agent name, role, responsibility, hierarchy, shared behavior rule, and main-agent selection. A long structured prompt with agent sections is one company-creation request; do not replace it with a memory or Business Profile action. Business Profiles with stage, audience, registration, goals, and memory use npati_business_profile. Do not use for explanations, capability questions, or public research.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["create", "update", "delete"], description: "The requested NPATI company operation." },
          companyId: { type: "string", description: "Existing owned company UUID. Omit when creating." },
          companyName: { type: "string", description: "Exact existing company name when no companyId is available." },
          fields: { type: "object", description: "Company fields to create or change: name, industry, description, website, productsServices, languages, brandTone, companyInstructions, status. Preserve every supplied applicable value. For creation, name is required." },
          agents: { type: "array", description: "Agent create, update, or delete operations for this company. Include every named agent exactly once. Each item should include action=create, fields with exact name and role, description and systemInstruction containing all supplied responsibilities, main=true for the lead agent, and parentAgentName for specialists when a hierarchy is supplied.", items: { type: "object" } },
          mainAgentId: { type: ["string", "null"], description: "Existing agent UUID to make the main agent." },
          mainAgentName: { type: ["string", "null"], description: "Exact agent name to make the main agent." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search external public sources for current or otherwise unavailable information, such as competitors, markets, news, or recent facts. Examples: 'Research current competitors'; 'Find today's industry news'. Do NOT use for actions completed entirely inside NPATI, including creating companies or agents, changing settings, or managing stored workspace data. Do NOT use merely because extra information might be helpful.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "A specific external research query." },
          maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          searchType: { type: "string", enum: ["web", "news"], default: "web" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Open, scan, or analyze an explicit public HTTP(S) URL supplied by the user or discovered during research. Examples: 'Scan https://example.com'; 'Read the pricing page found in search'. Do NOT use for internal NPATI records or attached files whose content is already in the conversation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "Absolute public HTTP(S) URL." },
          goal: { type: "string", description: "What information to extract or analyze." },
        },
      },
    },
  },
];

export interface ChatToolExecutionResult {
  output: unknown;
  metadata?: Record<string, unknown>;
}

export interface ChatToolTrace {
  step: number;
  toolName: string;
  callId: string;
  status: "requested" | "succeeded" | "failed";
  arguments?: Record<string, unknown>;
  error?: string;
}

export interface ChatToolLoopResult {
  result: ChatResult;
  messages: ChatRequest["messages"];
  traces: ChatToolTrace[];
  metadata: Record<string, unknown>[];
  completionFallback?: "model_error" | "plan_incomplete";
}

export interface ChatToolModelStep {
  step: number;
  tools: ChatToolDefinition[];
  toolChoice: NonNullable<ChatRequest["toolChoice"]>;
  result: ChatResult;
}

function toolArguments(call: ChatToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error(`Tool ${call.function.name} returned invalid JSON arguments`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Tool ${call.function.name} arguments must be an object`);
  return parsed as Record<string, unknown>;
}

function toolOutput(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length <= 40_000 ? serialized : serialized.slice(0, 40_000) + "\n[tool output truncated]";
}

export async function runChatToolLoop(input: {
  ai: AIEngine;
  request: ChatRequest;
  tools?: () => ChatToolDefinition[] | Promise<ChatToolDefinition[]>;
  execute(call: ChatToolCall, args: Record<string, unknown>): Promise<ChatToolExecutionResult>;
  maxSteps?: number;
  onTrace?: (trace: ChatToolTrace) => void;
  onModelStep?: (event: ChatToolModelStep) => void;
  primaryOutcomeComplete?: (metadata: Record<string, unknown>[]) => boolean;
  recoveryCall?: ChatToolCall;
}): Promise<ChatToolLoopResult> {
  const messages = [...input.request.messages];
  const traces: ChatToolTrace[] = [];
  const metadata: Record<string, unknown>[] = [];
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? 8, 16));
  let result: ChatResult = { content: "" };
  let completionReminders = 0;
  const hasPersistedPrimary = () => metadata.some((item) =>
    item.kind === "business_profile" && (item.outcome as { businessId?: string } | undefined)?.businessId
    || item.kind === "company" && (item.companyAction as { companyId?: string } | undefined)?.companyId);
  let recoveryAttempted = false;
  const recoverPrimary = async (): Promise<ChatToolLoopResult | undefined> => {
    const call = input.recoveryCall;
    if (!call || recoveryAttempted) return undefined;
    recoveryAttempted = true;
    const requested: ChatToolTrace = { step: maxSteps, toolName: call.function.name, callId: call.id, status: "requested" };
    try {
      const args = toolArguments(call);
      requested.arguments = args;
      traces.push(requested);
      input.onTrace?.(requested);
      const executed = await input.execute(call, args);
      if (executed.metadata) metadata.push(executed.metadata);
      const succeeded: ChatToolTrace = { ...requested, status: "succeeded" };
      traces.push(succeeded);
      input.onTrace?.(succeeded);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolOutput(executed.output) });
      if (hasPersistedPrimary()) return { result: { content: "" }, messages, traces, metadata, completionFallback: input.primaryOutcomeComplete?.(metadata) ? "model_error" : "plan_incomplete" };
    } catch (error) {
      const failed: ChatToolTrace = { ...requested, status: "failed", error: error instanceof Error ? error.message : String(error) };
      traces.push(failed);
      input.onTrace?.(failed);
    }
    return undefined;
  };

  for (let step = 0; step < maxSteps; step += 1) {
    const tools = input.tools ? await input.tools() : CORE_CHAT_TOOLS;
    const toolChoice = tools.length
      ? step === 0 ? input.request.toolChoice ?? "auto" : "auto"
      : "none";
    try {
      result = await input.ai.chat({ ...input.request, messages: [...messages], tools, toolChoice });
    } catch (error) {
      if (hasPersistedPrimary() && (!input.primaryOutcomeComplete || input.primaryOutcomeComplete(metadata))) {
        return { result: { content: "" }, messages, traces, metadata, completionFallback: "model_error" };
      }
      const recovered = await recoverPrimary();
      if (recovered) return recovered;
      if (hasPersistedPrimary()) return { result: { content: "" }, messages, traces, metadata, completionFallback: "plan_incomplete" };
      throw error;
    }
    input.onModelStep?.({ step, tools, toolChoice, result });
    if (!result.toolCalls?.length) {
      if (!input.primaryOutcomeComplete || input.primaryOutcomeComplete(metadata)) return { result, messages, traces, metadata };
      completionReminders += 1;
      if (completionReminders >= 2) {
        const recovered = await recoverPrimary();
        if (recovered) return recovered;
      }
      if (completionReminders >= 2 && hasPersistedPrimary()) {
        return { result: { content: "" }, messages, traces, metadata, completionFallback: "plan_incomplete" };
      }
      messages.push({ role: "system", content: "The original primary requested outcome has not been verified. Continue the remaining required tool steps using the complete original user request. Do not claim completion or stop after a secondary action." });
      continue;
    }

    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const requested: ChatToolTrace = { step, toolName: call.function.name, callId: call.id, status: "requested" };
      try {
        const args = toolArguments(call);
        requested.arguments = args;
        traces.push(requested);
        input.onTrace?.(requested);
        const executed = await input.execute(call, args);
        if (executed.metadata) metadata.push(executed.metadata);
        const succeeded: ChatToolTrace = { ...requested, status: "succeeded" };
        traces.push(succeeded);
        input.onTrace?.(succeeded);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolOutput(executed.output) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: ChatToolTrace = { ...requested, status: "failed", error: message };
        traces.push(failed);
        input.onTrace?.(failed);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ error: message }) });
      }
    }
  }

  const recovered = await recoverPrimary();
  if (recovered) return recovered;
  if (hasPersistedPrimary()) {
    return { result: { content: "" }, messages, traces, metadata, completionFallback: "plan_incomplete" };
  }
  throw Object.assign(new Error(`Tool loop exceeded ${maxSteps} model iterations`), { code: input.primaryOutcomeComplete ? "TOOL_PRIMARY_INCOMPLETE" : "TOOL_LOOP_LIMIT" });
}
