import { providerContinuationFor } from "@npati/omniroute-adapter";
import { chatLanguageInstruction, type CompanyChatLanguage } from "./company-chat-i18n";
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
      description: "Create, update, or delete AI Companies and their agents stored inside NPATI. When the primary request creates a company with named AI agents, use this tool for the entire company and every agent in one operation. Preserve each supplied agent name, role, responsibility, hierarchy, shared behavior rule, and main-agent selection. Write new readable values (role, description) in the language of the user's message, not the company's. A long structured prompt with agent sections is one company-creation request; do not replace it with a memory or Business Profile action. Business Profiles with stage, audience, registration, goals, and memory use npati_business_profile. Do not use for explanations, capability questions, or public research.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["create", "update", "delete"], description: "The requested NPATI company operation." },
          companyId: { type: "string", description: "Existing owned company UUID. Omit when creating." },
          companyName: { type: "string", description: "Exact existing company name used only to locate the company for update or delete when companyId is unavailable. It is not a field edit." },
          fields: { type: "object", description: "Company fields to create or change: name, industry, description, website, productsServices, languages, brandTone, companyInstructions, status. Preserve every supplied applicable value. Append remembered facts to companyInstructions in the user's own words and language, never to description; do not translate them. For creation, name is required. For delete, omit fields and agents; provide only action=delete and companyId or companyName." },
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

/** Models whose provider refused a forced (named) tool_choice in this process. */
const modelsRejectingForcedToolChoice = new Set<string>();

export interface ChatToolExecutionResult {
  output: unknown;
  metadata?: Record<string, unknown>;
  /** The executor needs the user's answer (a destructive-action confirmation); no further step may run this turn. */
  stop?: boolean;
}

export interface ChatToolTrace {
  step: number;
  toolName: string;
  callId: string;
  status: "requested" | "succeeded" | "failed" | "deduplicated";
  arguments?: Record<string, unknown>;
  error?: string;
  /** For `deduplicated`: the call in the same assistant turn whose result this call reuses. */
  duplicateOf?: string;
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

/** Name plus arguments with sorted keys, so key order cannot hide an identical call. */
function callSignature(call: ChatToolCall): string {
  let args: unknown;
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { return `${call.function.name}\u0000${call.function.arguments}`; }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    : value;
  return `${call.function.name}\u0000${JSON.stringify(canonical(args))}`;
}

function toolOutput(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length <= 40_000 ? serialized : serialized.slice(0, 40_000) + "\n[tool output truncated]";
}

export async function runChatToolLoop(input: {
  ai: AIEngine;
  request: ChatRequest;
  responseLanguage?: CompanyChatLanguage;
  tools?: () => ChatToolDefinition[] | Promise<ChatToolDefinition[]>;
  execute(call: ChatToolCall, args: Record<string, unknown>): Promise<ChatToolExecutionResult>;
  maxSteps?: number;
  onTrace?: (trace: ChatToolTrace) => void;
  onModelStep?: (event: ChatToolModelStep) => void;
  primaryOutcomeComplete?: (metadata: Record<string, unknown>[]) => boolean;
  recoveryCall?: ChatToolCall;
  /** Capabilities the semantic route attributed to this request; a model that stops before trying one is reminded once. */
  requiredTools?: string[];
  /** Capabilities the caller settles after the loop with its deterministic record planner when the model did not call them. */
  deferredTools?: string[];
}): Promise<ChatToolLoopResult> {
  const messages = [...input.request.messages];
  // Some providers silently discard named tool_choice (MiMo supports auto only). The requested
  // capability still needs an actual executor receipt; assistant prose cannot stand in for it.
  const namedPrimary = typeof input.request.toolChoice === "object" && input.request.toolChoice.function.name.startsWith("npati_") ? input.request.toolChoice.function.name : undefined;
  // A caller-supplied completion check already verifies the primary outcome with its own reminders and recovery.
  const requiredTools = [...new Set([...(input.requiredTools ?? []), ...(namedPrimary && !input.primaryOutcomeComplete ? [namedPrimary] : [])])];
  if (namedPrimary) messages.push({ role: "system", content: `This turn requires calling ${namedPrimary} with arguments grounded in the user's request. A tool selection setting may be ignored by the provider. Do not claim the action succeeded without its executor result. If essential arguments are missing, explain what is missing instead of inventing values.` });
  // Keep the provider mode stable across tool continuations, including forced -> auto steps.
  const reasoningMode = typeof input.request.toolChoice === "object" ? "disabled" : input.request.reasoningMode;
  // Steps are streamed (counters only, no text reaches the caller) so a silent provider is cut off by the stream idle
  // timeout instead of holding the whole request budget; non-streamed calls only end at the request timeout.
  const onGenerationProgress = input.request.onGenerationProgress ?? (() => undefined);
  const traces: ChatToolTrace[] = [];
  const metadata: Record<string, unknown>[] = [];
  // A create that already succeeded in an earlier step of this turn is not run again when the model repeats it word for
  // word: one Spanish goal request made two identical goals (V6 step 20, V6-D20-06). Other repeats still run.
  const createdInTurn = new Map<string, { callId: string; content: string }>();
  const isCreate = (call: ChatToolCall) => { try { return (JSON.parse(call.function.arguments || "{}") as { action?: unknown }).action === "create"; } catch { return false; } };
  const maxSteps = Math.max(1, input.maxSteps ?? Number.POSITIVE_INFINITY);
  let result: ChatResult = { content: "" };
  let completionReminders = 0;
  let requiredReminded = false;
  const hasPersistedPrimary = () => metadata.some((item) =>
    item.kind === "business_profile" && (item.outcome as { businessId?: string } | undefined)?.businessId
    || item.kind === "company" && (item.companyAction as { companyId?: string } | undefined)?.companyId);
  let recoveryAttempted = false;
  const recoverPrimary = async (): Promise<ChatToolLoopResult | undefined> => {
    const call = input.recoveryCall;
    if (!call || recoveryAttempted) return undefined;
    recoveryAttempted = true;
    const requested: ChatToolTrace = { step: traces.length, toolName: call.function.name, callId: call.id, status: "requested" };
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
    let toolChoice = tools.length
      ? step === 0 ? input.request.toolChoice ?? "auto" : "auto"
      : "none";
    const modelKey = String(input.request.model ?? "default");
    // A forced web_search/web_fetch is a guarantee that the answer rests on retrieved content: its refusal goes to the
    // caller's fallback, which runs the research itself. Only NPATI record actions are relaxed to "auto".
    const relaxable = typeof toolChoice === "object" && !["web_search", "web_fetch"].includes(toolChoice.function.name);
    if (relaxable && modelsRejectingForcedToolChoice.has(modelKey)) toolChoice = "auto";
    const stepMessages = [...messages];
    if (step > 0 && input.responseLanguage) {
      // Keep the assistant/tool exchange contiguous and preserve its final tool message for provider compatibility.
      let position = stepMessages.length;
      while (position > 0 && stepMessages[position - 1]?.role === "tool") position -= 1;
      if (position > 0 && stepMessages[position - 1]?.role === "assistant") position -= 1;
      stepMessages.splice(position, 0, { role: "system", content: chatLanguageInstruction("", [], input.responseLanguage) });
    }
    try {
      try {
        result = await input.ai.chat({ ...input.request, messages: stepMessages, tools, toolChoice, onGenerationProgress,
          // DeepSeek thinking rejects a named tool. The adapter applies this only to that supported model.
          reasoningMode });
      } catch (error) {
        // Thinking models (DeepSeek) refuse a forced tool_choice. The same step is asked once with "auto", and the
        // model is remembered so later requests do not spend a failed call on it.
        if (!relaxable || typeof toolChoice !== "object" || !/does not support this tool_choice/i.test(String((error as Error)?.message ?? error))) throw error;
        modelsRejectingForcedToolChoice.add(modelKey);
        toolChoice = "auto";
        result = await input.ai.chat({ ...input.request, messages: stepMessages, tools, toolChoice, onGenerationProgress, reasoningMode });
      }
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
      // A failed attempt is not retried here: only a capability the model never tried in this turn is missing.
      const untried = requiredTools.filter((name) => tools.some((tool) => tool.function.name === name)
        && !traces.some((trace) => trace.toolName === name));
      if (untried.length && !requiredReminded) {
        requiredReminded = true;
        messages.push({ role: "system", content: `The original user request also requires ${untried.join(", ")}, which is available and was not called in this turn. Call it now for that part of the request, or report the concrete error it returns. Do not claim it is unavailable.` });
        continue;
      }
      // The caller's semantic-plan recovery and completion check still apply; only without them is prose rejected here.
      if (untried.some((name) => !input.deferredTools?.includes(name)) && !input.primaryOutcomeComplete) {
        const recovered = await recoverPrimary();
        if (recovered) return recovered;
        throw Object.assign(new Error(`Required tools were not called: ${untried.join(", ")}; no completion is verified`), { code: "TOOL_PRIMARY_INCOMPLETE" });
      }
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

    messages.push({ ...providerContinuationFor(result), role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    // A provider can repeat one call within a turn (same name and arguments, new id). Executing it twice would
    // duplicate a side effect such as a created company or a sent email, so the repeat reuses the first result.
    const executedInTurn = new Map<string, { callId: string; content: string }>();
    for (const call of result.toolCalls) {
      const signature = callSignature(call);
      const first = executedInTurn.get(signature) ?? (isCreate(call) ? createdInTurn.get(signature) : undefined);
      if (first) {
        const deduplicated: ChatToolTrace = { step, toolName: call.function.name, callId: call.id, status: "deduplicated", duplicateOf: first.callId };
        traces.push(deduplicated);
        input.onTrace?.(deduplicated);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: first.content });
        continue;
      }
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
        const content = toolOutput(executed.output);
        executedInTurn.set(signature, { callId: call.id, content });
        if (isCreate(call)) createdInTurn.set(signature, { callId: call.id, content });
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content });
        if (executed.stop) return { result: { content: "" }, messages, traces, metadata };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: ChatToolTrace = { ...requested, status: "failed", error: message };
        traces.push(failed);
        input.onTrace?.(failed);
        // A failed fetch/search leaves no evidence; without saying so, models fill the gap from memory.
        const instruction = /^web_(fetch|search)$/.test(call.function.name)
          ? "No page content was retrieved. Tell the user it could not be opened and why. Do not describe or analyse the page from memory or general knowledge."
          : undefined;
        const content = JSON.stringify({ error: message, ...(instruction ? { instruction } : {}) });
        // A failed call may still have partly acted; repeating it in the same turn is not a retry the model chose.
        executedInTurn.set(signature, { callId: call.id, content });
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content });
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
