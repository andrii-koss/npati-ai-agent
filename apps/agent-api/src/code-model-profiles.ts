/**
 * C6 model profiles: how a model is driven is **configuration, not code**.
 *
 * The agent loop must not branch on a model name or on a provider brand: it asks for a profile and the
 * profile answers the questions the loop needs (how tool calls arrive, how many may run at once, how much
 * context fits, which edit tool the model handles best). An operator can replace the registry without
 * touching the loop, which is what makes the harness model-agnostic.
 *
 * Everything unknown fails closed. A model we have no profile for gets the conservative profile: tool
 * calling is auto-detected (native only when the provider actually returned native calls), **one** tool
 * call at a time, the smallest context window we know about, no temperature opinion and no preferred edit
 * tool. Guessing here would silently give a weak model parallel writes and a long context it cannot hold.
 */

export type CodeToolCallingMode = "native" | "text" | "auto";

export const CODE_TOOL_CALLING_MODES: readonly CodeToolCallingMode[] = ["native", "text", "auto"];

export interface CodeModelProfileMatch {
  /** Provider ids as they appear in the engine/model id (e.g. `anthropic`, `openai`, `ollama`). */
  providers?: readonly string[];
  /** Exact model ids (case-insensitive). */
  models?: readonly string[];
  /** Model id patterns with `*` (any run) and `?` (single character), anchored and case-insensitive. */
  patterns?: readonly string[];
}

export interface CodeModelProfile {
  id: string;
  match: CodeModelProfileMatch;
  toolCallingMode: CodeToolCallingMode;
  /** Only set when we know the model handles that tool well; otherwise the loop decides. */
  preferredEditTool?: string;
  maxParallelToolCalls: number;
  contextWindow: number;
  temperature?: number;
  extraSystemPromptLines?: readonly string[];
  knownLimitations?: readonly string[];
}

export type CodeModelProfileMatchKind = "override" | "model" | "pattern" | "provider" | "default";

export interface ResolveModelProfileInput {
  provider?: string | null;
  model?: string | null;
  /** Profiles supplied by the caller (operator settings); a matching override always wins. */
  overrides?: readonly CodeModelProfile[];
  /** Replaces the built-in registry entirely (tests and operator configuration). */
  profiles?: readonly CodeModelProfile[];
  /** When set, only registry profiles with these ids are considered (e.g. `code.model_profile.<id>` flags). */
  enabledProfileIds?: readonly string[];
}

export interface ResolvedCodeModelProfile {
  profile: CodeModelProfile;
  matchedBy: CodeModelProfileMatchKind;
  warnings: string[];
  /** Normalised identifiers the decision was made for, so Activity can record them verbatim. */
  subject: { provider: string | null; model: string | null };
}

export class CodeModelProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "CodeModelProfileError";
  }
}

/** A profile is allowed to run at least one tool call at a time, never zero and never a stampede. */
export const MIN_PARALLEL_TOOL_CALLS = 1;
export const MAX_PARALLEL_TOOL_CALLS = 8;
/** Below this a "context window" is a misconfiguration, not a small model. */
export const MIN_CONTEXT_WINDOW = 1_024;
/** Used only when the registry itself is empty/invalid, so the conservative profile still has a number. */
export const FALLBACK_CONTEXT_WINDOW = 8_192;

/**
 * Conservative profile for a model we do not know (or whose profile is invalid).
 *
 * - `toolCallingMode: "auto"` — the safest *detection*: native is used only when the provider actually
 *   returned native tool calls, otherwise the text protocol is parsed. We never assume native support.
 * - `maxParallelToolCalls: 1` — an unknown model gets no parallel writes.
 * - `contextWindow` — the smallest window among known profiles (see `conservativeContextWindow`), because
 *   promising more context than the weakest known model can hold is how context silently gets truncated.
 * - no `temperature` — the provider default is the honest choice when we have no opinion.
 * - no `preferredEditTool` — the loop must not prefer a tool for a model we know nothing about.
 */
export const CONSERVATIVE_CODE_MODEL_PROFILE_ID = "conservative-default";

function freezeProfile(profile: CodeModelProfile): CodeModelProfile {
  return Object.freeze({
    ...profile,
    match: Object.freeze({ ...profile.match }),
    extraSystemPromptLines: profile.extraSystemPromptLines ? Object.freeze([...profile.extraSystemPromptLines]) : undefined,
    knownLimitations: profile.knownLimitations ? Object.freeze([...profile.knownLimitations]) : undefined,
  }) as CodeModelProfile;
}

/**
 * Operator-editable defaults. Kept as a plain exported constant so the registry is data: replacing it
 * changes behaviour without touching the loop, and a test can resolve the same logic against another
 * registry to prove that.
 *
 * The patterns below are deliberately narrow. A bare `*` pattern is rejected by the validator: a catch-all
 * profile would hand every unknown model native tool calling and parallel writes, which is exactly what the
 * conservative default exists to prevent.
 */
export const DEFAULT_CODE_MODEL_PROFILES: readonly CodeModelProfile[] = Object.freeze([
  freezeProfile({
    id: "hosted-native-tools",
    match: { providers: ["anthropic", "openai", "google", "azure", "bedrock", "vertex"] },
    toolCallingMode: "native",
    preferredEditTool: "code.fs.apply_patch",
    maxParallelToolCalls: 4,
    contextWindow: 200_000,
    knownLimitations: ["native tool calling is assumed for these providers; verify per model"],
  }),
  freezeProfile({
    id: "hosted-native-tools-small-context",
    match: { patterns: ["*mini*", "*flash*", "*haiku*", "*small*"] },
    toolCallingMode: "native",
    maxParallelToolCalls: 2,
    contextWindow: 64_000,
    knownLimitations: ["smaller hosted models: fewer parallel calls and a shorter window"],
  }),
  freezeProfile({
    id: "local-text-tools",
    match: {
      providers: ["ollama", "lmstudio", "llamacpp", "llama.cpp", "vllm", "localai", "local", "self-hosted"],
      patterns: ["*local*", "*selfhosted*"],
    },
    toolCallingMode: "text",
    maxParallelToolCalls: 1,
    contextWindow: 32_000,
    knownLimitations: ["local models: tool calls are parsed from text and are never trusted as instructions"],
  }),
]);

function conservativeContextWindow(profiles: readonly CodeModelProfile[]): number {
  const windows = profiles
    .map((profile) => profile.contextWindow)
    .filter((value) => Number.isFinite(value) && value >= MIN_CONTEXT_WINDOW);
  if (!windows.length) return FALLBACK_CONTEXT_WINDOW;
  return Math.min(...windows);
}

/** The conservative profile for a registry — its context window is the smallest one the registry knows. */
export function conservativeCodeModelProfile(
  profiles: readonly CodeModelProfile[] = DEFAULT_CODE_MODEL_PROFILES,
): CodeModelProfile {
  return freezeProfile({
    id: CONSERVATIVE_CODE_MODEL_PROFILE_ID,
    match: {},
    toolCallingMode: "auto",
    maxParallelToolCalls: 1,
    contextWindow: conservativeContextWindow(profiles),
    knownLimitations: ["unknown_model", "tool calling is auto-detected and never assumed"],
  });
}

export const CONSERVATIVE_CODE_MODEL_PROFILE: CodeModelProfile = conservativeCodeModelProfile();

export interface ValidateCodeModelProfileOptions {
  /** Only the conservative profile may match nothing; every other profile must say what it matches. */
  allowEmptyMatch?: boolean;
}

/**
 * Rejects a profile instead of silently repairing it: a broken profile must fall back to the conservative
 * default, never run with half its values applied.
 */
export function validateCodeModelProfile(
  profile: CodeModelProfile,
  options: ValidateCodeModelProfileOptions = {},
): void {
  if (!profile || typeof profile !== "object") {
    throw new CodeModelProfileError("invalid_profile", "Model profile must be an object");
  }
  if (typeof profile.id !== "string" || !profile.id.trim()) {
    throw new CodeModelProfileError("invalid_profile_id", "Model profile needs a non-empty id");
  }
  if (!CODE_TOOL_CALLING_MODES.includes(profile.toolCallingMode)) {
    throw new CodeModelProfileError(
      "invalid_tool_calling_mode",
      `Model profile ${profile.id}: unknown toolCallingMode ${String(profile.toolCallingMode)}`,
    );
  }
  if (!Number.isInteger(profile.maxParallelToolCalls) || profile.maxParallelToolCalls < MIN_PARALLEL_TOOL_CALLS) {
    throw new CodeModelProfileError(
      "invalid_parallel_tool_calls",
      `Model profile ${profile.id}: maxParallelToolCalls must be an integer >= ${MIN_PARALLEL_TOOL_CALLS}`,
    );
  }
  if (profile.maxParallelToolCalls > MAX_PARALLEL_TOOL_CALLS) {
    throw new CodeModelProfileError(
      "invalid_parallel_tool_calls",
      `Model profile ${profile.id}: maxParallelToolCalls must be <= ${MAX_PARALLEL_TOOL_CALLS}`,
    );
  }
  if (!Number.isInteger(profile.contextWindow) || profile.contextWindow < MIN_CONTEXT_WINDOW) {
    throw new CodeModelProfileError(
      "invalid_context_window",
      `Model profile ${profile.id}: contextWindow must be an integer >= ${MIN_CONTEXT_WINDOW}`,
    );
  }
  if (profile.temperature !== undefined) {
    if (typeof profile.temperature !== "number" || Number.isNaN(profile.temperature) || profile.temperature < 0 || profile.temperature > 2) {
      throw new CodeModelProfileError("invalid_temperature", `Model profile ${profile.id}: temperature must be between 0 and 2`);
    }
  }
  if (profile.preferredEditTool !== undefined && (typeof profile.preferredEditTool !== "string" || !profile.preferredEditTool.trim())) {
    throw new CodeModelProfileError(
      "invalid_preferred_edit_tool",
      `Model profile ${profile.id}: preferredEditTool must be a non-empty tool name`,
    );
  }
  const match = profile.match;
  if (!match || typeof match !== "object") {
    throw new CodeModelProfileError("invalid_profile_match", `Model profile ${profile.id}: match must be an object`);
  }
  const lists: Array<[string, readonly string[] | undefined]> = [
    ["providers", match.providers],
    ["models", match.models],
    ["patterns", match.patterns],
  ];
  let entries = 0;
  for (const [key, list] of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new CodeModelProfileError("invalid_profile_match", `Model profile ${profile.id}: match.${key} must be an array`);
    }
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new CodeModelProfileError("invalid_profile_match", `Model profile ${profile.id}: match.${key} contains an empty entry`);
      }
      if (key === "patterns" && entry.trim() === "*") {
        throw new CodeModelProfileError(
          "invalid_profile_pattern",
          `Model profile ${profile.id}: a bare "*" pattern is not allowed; match the provider or a narrow pattern instead`,
        );
      }
      entries += 1;
    }
  }
  if (!entries && !options.allowEmptyMatch) {
    throw new CodeModelProfileError(
      "invalid_profile_match",
      `Model profile ${profile.id}: match must name at least one provider, model or pattern`,
    );
  }
  for (const [key, list] of [["extraSystemPromptLines", profile.extraSystemPromptLines], ["knownLimitations", profile.knownLimitations]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((line) => typeof line !== "string" || !line.trim())) {
      throw new CodeModelProfileError("invalid_profile_lines", `Model profile ${profile.id}: ${key} must be non-empty strings`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anchored, case-insensitive glob: `*` matches any run (including empty), `?` matches one character.
 * Anchoring matters — an unanchored match would let `evil-claude-proxy` look like `claude`.
 */
export function matchesModelPattern(model: string, pattern: string): boolean {
  // An empty model id must never match: `*` matches the empty string, and a model we could not identify
  // has to fall through to the conservative default rather than inherit whatever matched.
  if (typeof model !== "string" || !model.trim()) return false;
  if (typeof pattern !== "string" || !pattern.trim()) return false;
  const source = pattern
    .trim()
    .split("*")
    .map((part) => part.split("?").map(escapeRegExp).join("."))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(model.trim());
}

function normalise(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesExact(value: string, candidates: readonly string[] | undefined): boolean {
  if (!candidates?.length || !value) return false;
  return candidates.some((candidate) => candidate.trim().toLowerCase() === value);
}

function matchesPatterns(value: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length || !value) return false;
  return patterns.some((pattern) => matchesModelPattern(value, pattern));
}

/** 3 = exact model, 2 = pattern, 1 = provider. Higher wins; a model match always beats a general provider. */
export function profileMatchSpecificity(profile: CodeModelProfile, provider: string, model: string): number {
  if (matchesExact(model, profile.match.models)) return 3;
  if (matchesPatterns(model, profile.match.patterns)) return 2;
  if (matchesExact(provider, profile.match.providers)) return 1;
  return 0;
}

function matchKindFor(specificity: number): CodeModelProfileMatchKind {
  if (specificity === 3) return "model";
  if (specificity === 2) return "pattern";
  return "provider";
}

/**
 * Resolution order: explicit override -> exact model -> pattern -> provider -> conservative default.
 * Invalid entries (registry, override or enabled-id list) are reported as warnings and **skipped**; they
 * never partially apply, because a half-applied profile is worse than the conservative one.
 */
export function resolveModelProfile(input: ResolveModelProfileInput = {}): ResolvedCodeModelProfile {
  const provider = normalise(input.provider);
  const model = normalise(input.model);
  const warnings: string[] = [];

  const registry: CodeModelProfile[] = [];
  for (const profile of input.profiles ?? DEFAULT_CODE_MODEL_PROFILES) {
    try {
      validateCodeModelProfile(profile);
      registry.push(profile);
    } catch (error) {
      warnings.push(`invalid_profile_skipped:${profile?.id ?? "unknown"}:${(error as CodeModelProfileError).code}`);
    }
  }

  const enabled = input.enabledProfileIds;
  const active = enabled
    ? registry.filter((profile) => enabled.includes(profile.id))
    : registry;
  if (enabled) {
    for (const id of enabled) {
      if (!registry.some((profile) => profile.id === id)) warnings.push(`enabled_profile_unknown:${id}`);
    }
  }

  const overrides: CodeModelProfile[] = [];
  for (const profile of input.overrides ?? []) {
    try {
      validateCodeModelProfile(profile, { allowEmptyMatch: true });
      overrides.push(profile);
    } catch (error) {
      warnings.push(`invalid_override_skipped:${profile?.id ?? "unknown"}:${(error as CodeModelProfileError).code}`);
    }
  }

  const subject = { provider: provider || null, model: model || null };

  for (const profile of overrides) {
    const specificity = profileMatchSpecificity(profile, provider, model);
    const matchesNothing = !profile.match.providers?.length && !profile.match.models?.length && !profile.match.patterns?.length;
    if (specificity > 0 || matchesNothing) {
      return { profile, matchedBy: "override", warnings, subject };
    }
  }

  let best: { profile: CodeModelProfile; specificity: number } | null = null;
  let bestTies: string[] = [];
  for (const profile of active) {
    const specificity = profileMatchSpecificity(profile, provider, model);
    if (specificity === 0) continue;
    if (!best || specificity > best.specificity) {
      best = { profile, specificity };
      bestTies = [profile.id];
      continue;
    }
    if (specificity === best.specificity) bestTies.push(profile.id);
  }

  if (best) {
    if (bestTies.length > 1) {
      warnings.push(`ambiguous_profile_match:${bestTies.join(",")}:using:${best.profile.id}`);
    }
    return { profile: best.profile, matchedBy: matchKindFor(best.specificity), warnings, subject };
  }

  warnings.push(`unknown_model_conservative_default:${subject.model ?? "unknown"}`);
  return { profile: conservativeCodeModelProfile(input.profiles ?? DEFAULT_CODE_MODEL_PROFILES), matchedBy: "default", warnings, subject };
}

/**
 * Effective tool calling mode. `auto` resolves to `native` **only** when the provider actually returned
 * native tool calls for this exchange; otherwise the text protocol is used. That asymmetry is intentional:
 * assuming native support loses tool calls silently, while parsing text can only fail loudly.
 */
export function resolveEffectiveToolCallingMode(
  profile: Pick<CodeModelProfile, "toolCallingMode">,
  context: { sawNativeToolCalls?: boolean } = {},
): "native" | "text" {
  if (profile.toolCallingMode === "native") return "native";
  if (profile.toolCallingMode === "text") return "text";
  return context.sawNativeToolCalls === true ? "native" : "text";
}

/** Stable key for Activity/telemetry: which profile drove a turn, and why. */
export function modelProfileTrace(result: ResolvedCodeModelProfile): {
  profileId: string;
  matchedBy: CodeModelProfileMatchKind;
  toolCallingMode: CodeToolCallingMode;
  maxParallelToolCalls: number;
} {
  return {
    profileId: result.profile.id,
    matchedBy: result.matchedBy,
    toolCallingMode: result.profile.toolCallingMode,
    maxParallelToolCalls: result.profile.maxParallelToolCalls,
  };
}
