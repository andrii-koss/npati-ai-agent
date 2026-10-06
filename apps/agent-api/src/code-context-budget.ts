import { createHash } from "node:crypto";

/**
 * C8 — context budget accounting for a code run.
 *
 * This module answers exactly one question: how full is the model window, and has the run crossed the
 * compression threshold. It is a **pure** function of the message contents, the profile's `context_window`
 * and the configured ratio — no clock, no randomness, no cache state. That matters beyond tidiness:
 * compaction changes what the model sees, so the decision to compact must be reproducible, otherwise a
 * recorded run (C6b) could not be replayed against the same input.
 *
 * Two rules it deliberately obeys:
 *
 *   - The window comes from the **model profile** (`profile.contextWindow`), never from
 *     `getModelContextLimit(modelId)`. That helper guesses a limit from the model *name* (1M/200k/128k/16k),
 *     and global rule 7 forbids behaviour keyed to model names; the profile registry already computes the
 *     conservative minimum across known profiles.
 *   - The token estimate uses the same convention as the rest of the repository
 *     (`Math.ceil(chars / 4)`, see `context-compression-presets-and-budget.ts`). A second, slightly
 *     different estimator would make the trigger point differ between the compressor and this gate.
 */

/** Same convention as `context-compression-presets-and-budget.ts`; kept here so callers do not re-derive it. */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/**
 * The threshold ratio is read from `NPATI_CODE_CONTEXT_COMPRESSION_RATIO` through
 * `resolveCodeAgentLimits().contextCompressionRatio`. That configuration key existed since C1 but was read by
 * nothing; C8 is the step that gives it meaning.
 */
export const DEFAULT_COMPRESSION_RATIO = 0.75;

export interface ContextBudgetMessage {
  role: string;
  content: string;
}

export interface ContextBudgetInput {
  messages: readonly ContextBudgetMessage[];
  /** Effective window of the resolved model profile, in tokens. */
  contextWindow: number;
  /** Fraction of the window at which compaction is triggered (0, 1]. */
  compressionRatio: number;
}

export interface ContextBudgetResolution {
  currentTokens: number;
  maxContextTokens: number;
  /** Absolute token count at which compaction triggers. */
  thresholdTokens: number;
  utilizationRatio: number;
  actionRequired: boolean;
  reason: string;
}

export function estimateContextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: readonly ContextBudgetMessage[]): number {
  return messages.reduce((total, message) => total + estimateContextTokens(message.content), 0);
}

/**
 * Clamps a configured ratio into the open interval (0, 1]. A ratio of 0 or a non-finite value would turn the
 * trigger into "always compact" (or "never"), which is not a configuration decision anyone can debug.
 */
export function normalizeCompressionRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_COMPRESSION_RATIO;
  return value > 1 ? 1 : value;
}

export function resolveContextBudget(input: ContextBudgetInput): ContextBudgetResolution {
  const maxContextTokens = Math.max(1, Math.floor(input.contextWindow));
  const ratio = normalizeCompressionRatio(input.compressionRatio);
  const currentTokens = estimateMessagesTokens(input.messages);
  const thresholdTokens = Math.max(1, Math.floor(maxContextTokens * ratio));
  const utilizationRatio = currentTokens / maxContextTokens;
  const actionRequired = currentTokens >= thresholdTokens;

  return {
    currentTokens,
    maxContextTokens,
    thresholdTokens,
    utilizationRatio: Number(utilizationRatio.toFixed(4)),
    actionRequired,
    reason: actionRequired
      ? `context at ${Math.round(utilizationRatio * 100)}% of ${maxContextTokens} tokens reached the ${Math.round(ratio * 100)}% compaction threshold`
      : `context at ${Math.round(utilizationRatio * 100)}% of ${maxContextTokens} tokens is below the ${Math.round(ratio * 100)}% compaction threshold`,
  };
}

/**
 * Pressure is measured against the **whole model request**, not the conversation alone: in a code run the
 * tool schemas, the project instructions and the memory/project-context blocks are a large and permanent share
 * of every request, so measuring only the messages would under-report the window by a wide margin and let a
 * session run into provider truncation before compaction ever triggered.
 */
export interface ModelRequestPressureInput {
  systemPrompt: string;
  /** Serialised tool schemas as they are sent (names, descriptions, JSON schemas). */
  toolSchemas?: string;
  projectInstructions?: string;
  contextBlocks?: string;
  messages: readonly ContextBudgetMessage[];
  contextWindow: number;
  compressionRatio: number;
}

export interface ModelRequestPressure extends ContextBudgetResolution {
  systemTokens: number;
  toolSchemaTokens: number;
  instructionTokens: number;
  contextBlockTokens: number;
  conversationTokens: number;
}

export function resolveModelRequestPressure(input: ModelRequestPressureInput): ModelRequestPressure {
  const systemTokens = estimateContextTokens(input.systemPrompt);
  const toolSchemaTokens = estimateContextTokens(input.toolSchemas ?? "");
  const instructionTokens = estimateContextTokens(input.projectInstructions ?? "");
  const contextBlockTokens = estimateContextTokens(input.contextBlocks ?? "");
  const conversationTokens = estimateMessagesTokens(input.messages);
  const currentTokens = systemTokens + toolSchemaTokens + instructionTokens + contextBlockTokens + conversationTokens;

  const maxContextTokens = Math.max(1, Math.floor(input.contextWindow));
  const ratio = normalizeCompressionRatio(input.compressionRatio);
  const thresholdTokens = Math.max(1, Math.floor(maxContextTokens * ratio));
  const utilizationRatio = currentTokens / maxContextTokens;
  const actionRequired = currentTokens >= thresholdTokens;

  return {
    currentTokens,
    maxContextTokens,
    thresholdTokens,
    utilizationRatio: Number(utilizationRatio.toFixed(4)),
    actionRequired,
    reason: actionRequired
      ? `model request at ${Math.round(utilizationRatio * 100)}% of ${maxContextTokens} tokens reached the ${Math.round(ratio * 100)}% compaction threshold`
      : `model request at ${Math.round(utilizationRatio * 100)}% of ${maxContextTokens} tokens is below the ${Math.round(ratio * 100)}% compaction threshold`,
    systemTokens,
    toolSchemaTokens,
    instructionTokens,
    contextBlockTokens,
    conversationTokens,
  };
}

/**
 * Stable fingerprint of the exact context a model call received. The runner records it so a replay can prove
 * it fed the same input; it is a hash of content only, so two runs that compact identically hash identically.
 */
export function contextInputHash(messages: readonly ContextBudgetMessage[]): `sha256:${string}` {
  const canonical = messages.map((message) => `${message.role}\u0000${message.content}`).join("\u0001");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
