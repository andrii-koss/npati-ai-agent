import {
  CONSERVATIVE_CODE_MODEL_PROFILE,
  DEFAULT_CODE_MODEL_PROFILES,
  resolveModelProfile,
  type CodeModelProfile,
  type CodeModelProfileMatchKind,
  type CodeToolCallingMode,
} from "./code-model-profiles";
import { clampCodeSubagentParallelism } from "./code-subagent-limits";

/**
 * C12: the **type** of a coding sub-agent — one spelling of "explore", "plan", "implement", "review", "test"
 * — and the single place that maps a type onto the three things a delegated run needs.
 *
 * A type is a *profile*, not a second engine. Everything a type decides already exists elsewhere:
 *
 *  - the **model** is resolved through `code-model-profiles.ts` (the registry that already exists). The type
 *    names a profile **id** from that registry, never a model name literal, so an operator who renames a model
 *    changes the registry and not this file. A concrete model may still be named by the caller (the
 *    `code.agent.spawn` `model` argument, or `NPATI_CODE_SUBAGENT_MODEL_<TYPE>`); when one is, the type's
 *    profile and the model's own profile are both resolved and the **stricter** tool-calling mode wins, because
 *    a named model that only speaks the text protocol must not be driven as if it supported native calls.
 *  - the **turn limit** follows the `code-run-queue.ts` idiom: configuration may lower it, never raise it past
 *    the type's own ceiling, which is itself clamped to `CODE_SUBAGENT_MAX_TURNS`. The model's requested
 *    `turnLimit` may only lower it again — the direction the whole mechanism depends on.
 *  - the **capability profile** is a plain list of published tool names. It is not a grant: the delegation
 *    intersects it with the parent's effective set and the requested list (`SubagentToolPolicyGuard`), so a
 *    wide profile can never widen a delegation. Its name is reported to the parent so the digest says which
 *    profile the child ran under.
 *
 * `explore` is the type this module exists to make cheap and safe: it is read-only, it is given the smallest
 * turn budget, it resolves the small-context profile (a fast/cheap model where the deployment has one) and
 * `summaryOnly` is true — the parent receives a handoff digest and never the child's transcript, file bodies
 * or tool output. That is the whole reason to delegate a repository-wide search instead of doing it inline.
 */

/** The five kinds of coding sub-agent. Ordered cheapest/safest first; the order is part of the public list. */
export const CODE_SUBAGENT_TYPES = ["explore", "plan", "implement", "review", "test"] as const;
export type CodeSubagentType = (typeof CODE_SUBAGENT_TYPES)[number];

export function isCodeSubagentType(value: unknown): value is CodeSubagentType {
  return typeof value === "string" && (CODE_SUBAGENT_TYPES as readonly string[]).includes(value);
}

/**
 * Hard ceiling on the model turns one child may use. A child that needs more than this is a task that should
 * have been decomposed, not a run that should be allowed to grow.
 */
export const CODE_SUBAGENT_MAX_TURNS = 40;

/** Lowest limit that is still a run: one turn. A configured 0 must not disable the child silently. */
export const CODE_SUBAGENT_MIN_TURNS = 1;

/** Configuration and callers may lower a turn limit, never raise it past what the type already holds. */
export function clampCodeSubagentTurnLimit(value: unknown, ceiling: number = CODE_SUBAGENT_MAX_TURNS): number {
  const top = Math.max(CODE_SUBAGENT_MIN_TURNS, Math.min(Math.trunc(Number(ceiling) || CODE_SUBAGENT_MAX_TURNS), CODE_SUBAGENT_MAX_TURNS));
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return top;
  return Math.max(CODE_SUBAGENT_MIN_TURNS, Math.min(Math.trunc(parsed), top));
}

/** The published read/search tools every type starts from. */
const READ_TOOLS = [
  "code.fs.list", "code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info",
] as const;
/** The read-only half of the git surface: inspecting history and the change set, never writing to it. */
const GIT_READ_TOOLS = ["code.git.status", "code.git.diff", "code.git.log"] as const;
/** Session metadata: a plan draft, the todo list, and the one question a run may ask a human. */
const METADATA_TOOLS = ["code.plan.propose", "code.plan.update", "code.ask_user"] as const;
const WRITE_TOOLS = [
  "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete",
  "code.fs.undo_last_turn", "code.fs.diff",
] as const;
const SHELL_TOOLS = [
  "code.shell.exec", "code.shell.process.start", "code.shell.process.list", "code.shell.process.logs",
  "code.shell.process.stop",
] as const;
const DEPS_TOOLS = ["code.deps.inspect", "code.deps.audit", "code.deps.add"] as const;
/** The local git writes. The three remote operations are deliberately absent from every type profile. */
const GIT_LOCAL_TOOLS = [
  "code.git.branch.create", "code.git.branch.switch", "code.git.stage", "code.git.commit", "code.git.restore",
] as const;

export interface CodeSubagentTypeProfile {
  type: CodeSubagentType;
  /** Stable name of the capability profile, reported to the parent in the handoff digest. */
  capabilityProfile: string;
  /** A profile **id** from the model-profile registry; never a model name. */
  modelProfileId: string;
  maxTurns: number;
  maxParallelism: number;
  /** True when the type must not change the workspace: the runner also carries `readOnlyIntent` for it. */
  readOnly: boolean;
  /** True when the parent receives the handoff digest only. Always true today; the field is the contract. */
  summaryOnly: boolean;
  /** The tools this kind of sub-agent exists to use. Intersected, never granted by itself. */
  baseTools: readonly string[];
  /** Why the type exists, in one line, for the Capability Inspector and the digest. */
  purpose: string;
}

/**
 * The type table. `modelProfileId` values are ids the registry already ships (`DEFAULT_CODE_MODEL_PROFILES`);
 * an operator that replaces the registry and drops an id gets the conservative profile reported as a fallback
 * rather than a silent model change.
 */
export const CODE_SUBAGENT_TYPE_PROFILES: Readonly<Record<CodeSubagentType, CodeSubagentTypeProfile>> = Object.freeze({
  explore: Object.freeze({
    type: "explore",
    capabilityProfile: "explore-read-only",
    // The small-context hosted profile: a repository search does not need the biggest window, and delegating
    // it is only worth doing if the child is cheaper than doing the search inline.
    modelProfileId: "hosted-native-tools-small-context",
    maxTurns: 8,
    maxParallelism: 4,
    readOnly: true,
    summaryOnly: true,
    baseTools: Object.freeze([...READ_TOOLS, ...GIT_READ_TOOLS]),
    purpose: "Search the repository and survey its architecture, returning a metadata-only digest.",
  }),
  plan: Object.freeze({
    type: "plan",
    capabilityProfile: "plan-metadata",
    modelProfileId: "hosted-native-tools",
    maxTurns: 10,
    maxParallelism: 2,
    readOnly: true,
    summaryOnly: true,
    baseTools: Object.freeze([...READ_TOOLS, ...GIT_READ_TOOLS, ...METADATA_TOOLS]),
    purpose: "Produce a plan and a task list from the repository's own facts; changes no file.",
  }),
  implement: Object.freeze({
    type: "implement",
    capabilityProfile: "implement-scoped",
    modelProfileId: "hosted-native-tools",
    maxTurns: 24,
    maxParallelism: 4,
    readOnly: false,
    summaryOnly: false,
    baseTools: Object.freeze([
      ...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS, ...DEPS_TOOLS, ...GIT_LOCAL_TOOLS,
      "code.verify.run", "code.plan.update",
    ]),
    purpose: "Change files inside one declared scope, running the project's own checks as it goes.",
  }),
  review: Object.freeze({
    type: "review",
    capabilityProfile: "review-read-only",
    modelProfileId: "hosted-native-tools",
    maxTurns: 12,
    maxParallelism: 2,
    readOnly: true,
    summaryOnly: true,
    baseTools: Object.freeze([...READ_TOOLS, ...GIT_READ_TOOLS, ...METADATA_TOOLS]),
    purpose: "Read the change set and report findings; writes nothing, so a review can never be the change.",
  }),
  test: Object.freeze({
    type: "test",
    capabilityProfile: "test-runner",
    modelProfileId: "hosted-native-tools-small-context",
    maxTurns: 16,
    maxParallelism: 2,
    readOnly: false,
    summaryOnly: false,
    baseTools: Object.freeze([...READ_TOOLS, ...SHELL_TOOLS, ...DEPS_TOOLS, "code.verify.run", "code.plan.update"]),
    purpose: "Run and extend the project's tests, reporting what passed and what did not.",
  }),
});

/** Raised for a type outside `CODE_SUBAGENT_TYPES`; the executor maps it onto a structured tool error. */
export class CodeSubagentTypeError extends Error {
  readonly code: string;
  readonly httpStatus = 400;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodeSubagentTypeError";
    this.code = code;
  }
}

/** The environment key that names one type's model, e.g. `NPATI_CODE_SUBAGENT_MODEL_EXPLORE`. */
export function codeSubagentModelEnvKey(type: CodeSubagentType): string {
  return `NPATI_CODE_SUBAGENT_MODEL_${type.toUpperCase()}`;
}

/** The environment key that lowers one type's turn limit, e.g. `NPATI_CODE_SUBAGENT_TURN_LIMIT_EXPLORE`. */
export function codeSubagentTurnLimitEnvKey(type: CodeSubagentType): string {
  return `NPATI_CODE_SUBAGENT_TURN_LIMIT_${type.toUpperCase()}`;
}

/** The environment key that replaces one type's model-profile id, e.g. `NPATI_CODE_SUBAGENT_PROFILE_EXPLORE`. */
export function codeSubagentProfileEnvKey(type: CodeSubagentType): string {
  return `NPATI_CODE_SUBAGENT_PROFILE_${type.toUpperCase()}`;
}

/** A model string as it may arrive from a model argument or the environment: bounded and single-line. */
function normalizeModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : null;
}

function profileById(profiles: readonly CodeModelProfile[], id: string): CodeModelProfile | null {
  return profiles.find((profile) => profile.id === id) ?? null;
}

/**
 * The stricter of two tool-calling modes. `text` is stricter than `native` because assuming native support
 * loses tool calls silently while parsing text can only fail loudly — the same asymmetry
 * `resolveEffectiveToolCallingMode` documents.
 */
function strictestToolCallingMode(left: CodeToolCallingMode, right: CodeToolCallingMode): CodeToolCallingMode {
  if (left === "text" || right === "text") return "text";
  if (left === "native" || right === "native") return "native";
  return "auto";
}

export interface ResolveCodeSubagentTypeInput {
  /** The requested type. An unknown value is refused rather than defaulted. */
  type: string;
  /** A concrete model named by the caller. Bounded and single-line, or ignored. */
  model?: unknown;
  /** Requested turn limit from the tool arguments: it may only lower the resolved limit. */
  turnLimit?: unknown;
  /** The model-profile registry; defaults to the shipped one. */
  profiles?: readonly CodeModelProfile[];
  /** Operator overrides, forwarded to `resolveModelProfile` unchanged. */
  overrides?: readonly CodeModelProfile[];
  /** Enabled profile ids, forwarded to `resolveModelProfile` unchanged. */
  enabledProfileIds?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedCodeSubagentType {
  type: CodeSubagentType;
  capabilityProfile: string;
  /** The profile id the type asked for (the registry id, after the environment override). */
  modelProfileId: string;
  /** The registry profile that id resolved to. An unknown id falls back to the conservative profile. */
  modelProfile: CodeModelProfile;
  /** True when the requested profile id was not in the registry, so the conservative profile was used. */
  profileFallback: boolean;
  /** The concrete model handed to `CodingAgentRunInput.model`; `null` means "the deployment's default". */
  model: string | null;
  /**
   * What a named concrete model resolves to through the existing registry. `null` when no model was named,
   * because there is nothing to resolve and inventing a profile would be a claim nobody made.
   */
  modelResolution: { profileId: string; matchedBy: CodeModelProfileMatchKind; toolCallingMode: CodeToolCallingMode } | null;
  /** The stricter of the type profile and the named model's profile. */
  toolCallingMode: CodeToolCallingMode;
  maxTurns: number;
  maxParallelism: number;
  readOnly: boolean;
  summaryOnly: boolean;
  /** The type's tool profile, filtered to the published universe by the caller (see `spawnExecutor`). */
  baseTools: readonly string[];
  /** Non-fatal notes: an ignored model string, an unknown profile id, an ambiguous model match. */
  warnings: string[];
}

/**
 * Resolves one sub-agent type into everything the delegation needs. Pure: no store, no clock, no network, so
 * a test can drive every branch (including the fallbacks) without any port.
 */
export function resolveCodeSubagentType(input: ResolveCodeSubagentTypeInput): ResolvedCodeSubagentType {
  const env = input.env ?? process.env;
  if (!isCodeSubagentType(input.type)) {
    throw new CodeSubagentTypeError(
      "subagent_type_unknown",
      `Unknown sub-agent type "${String(input.type)}": expected one of ${CODE_SUBAGENT_TYPES.join(", ")}`,
    );
  }
  const type = input.type;
  const table = CODE_SUBAGENT_TYPE_PROFILES[type];
  const profiles = input.profiles ?? DEFAULT_CODE_MODEL_PROFILES;
  const warnings: string[] = [];

  const requestedProfileId = normalizeProfileId(env[codeSubagentProfileEnvKey(type)]);
  const modelProfileId = requestedProfileId ?? table.modelProfileId;
  let modelProfile = profileById(profiles, modelProfileId);
  let profileFallback = false;
  if (!modelProfile) {
    profileFallback = true;
    warnings.push(`subagent_profile_unknown:${modelProfileId}`);
    modelProfile = conservativeCodeModelProfileFor(profiles);
  }

  const fromArguments = normalizeModelName(input.model);
  const fromEnvironment = normalizeModelName(env[codeSubagentModelEnvKey(type)]);
  if (input.model !== undefined && input.model !== null && !fromArguments) {
    warnings.push("subagent_model_argument_ignored:not_a_bounded_single_line_name");
  }
  // The argument wins over the environment: it is this call's decision, while the environment is the
  // deployment's default for the type.
  const model = fromArguments ?? fromEnvironment;

  let modelResolution: ResolvedCodeSubagentType["modelResolution"] = null;
  let toolCallingMode: CodeToolCallingMode = modelProfile.toolCallingMode;
  if (model) {
    const resolved = resolveModelProfile({
      model,
      profiles,
      ...(input.overrides ? { overrides: input.overrides } : {}),
      ...(input.enabledProfileIds ? { enabledProfileIds: input.enabledProfileIds } : {}),
    });
    warnings.push(...resolved.warnings);
    modelResolution = {
      profileId: resolved.profile.id,
      matchedBy: resolved.matchedBy,
      toolCallingMode: resolved.profile.toolCallingMode,
    };
    toolCallingMode = strictestToolCallingMode(modelProfile.toolCallingMode, resolved.profile.toolCallingMode);
    if (resolved.matchedBy === "default") warnings.push(`subagent_model_unknown:${model}`);
  }

  // Two clamps in the same direction: the environment may lower the type's ceiling, and the call's own
  // request may lower that again. Nothing here can raise a limit, so a typo or a hopeful model cannot buy
  // turns the type was never given.
  const configuredTurns = clampCodeSubagentTurnLimit(env[codeSubagentTurnLimitEnvKey(type)], table.maxTurns);
  const maxTurns = clampCodeSubagentTurnLimit(input.turnLimit, configuredTurns);

  return {
    type,
    capabilityProfile: table.capabilityProfile,
    modelProfileId,
    modelProfile,
    profileFallback,
    model,
    modelResolution,
    toolCallingMode,
    maxTurns,
    maxParallelism: clampCodeSubagentParallelism(env.NPATI_CODE_SUBAGENT_PARALLELISM ?? table.maxParallelism),
    readOnly: table.readOnly,
    summaryOnly: table.summaryOnly,
    baseTools: table.baseTools,
    warnings,
  };
}

/** The conservative profile for a registry: its window is the smallest one that registry knows. */
function conservativeCodeModelProfileFor(profiles: readonly CodeModelProfile[]): CodeModelProfile {
  if (profiles === DEFAULT_CODE_MODEL_PROFILES) return CONSERVATIVE_CODE_MODEL_PROFILE;
  const windows = profiles.map((profile) => profile.contextWindow).filter((value) => Number.isFinite(value) && value > 0);
  return {
    ...CONSERVATIVE_CODE_MODEL_PROFILE,
    contextWindow: windows.length ? Math.min(...windows) : CONSERVATIVE_CODE_MODEL_PROFILE.contextWindow,
  };
}
