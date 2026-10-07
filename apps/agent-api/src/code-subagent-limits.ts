/**
 * C12: the single place that defines a coding subagent's **structural** limits and the single place that
 * intersects a tool set.
 *
 * Two properties this module exists to make true, both of them structural rather than checked:
 *
 * 1. **Depth 1.** A main run may delegate; a delegated run may not. The fact that decides is "this run has a
 *    parent" — a value the **server** sets when it starts the child, never something the model asks for and
 *    never a number a configuration file can raise. `CODE_SUBAGENT_MAX_DEPTH` is the one spelling of that
 *    limit, and `resolveCodeRunCapabilityScope` turns the parent fact into `mayDelegate: false` plus a tool
 *    list that no longer contains the delegation tool at all.
 *
 * 2. **Parallelism 4 as a hard ceiling.** The idiom is `code-run-queue.ts`: configuration may lower a cap,
 *    never raise it past what one node can serve. `clampCodeSubagentParallelism` is the only way a configured
 *    value reaches the graph or the registry, so a typo cannot remove the limit.
 *
 * The module has no imports on purpose: it is a leaf, so the guard, the manager, the runner, the tool runtime
 * and the A2A registries can all share it without a cycle.
 */

/**
 * The tool a parent run uses to delegate work. Declared here so every structural filter — the offered tool
 * descriptors, the runtime's refusal, the depth accounting — has exactly one spelling of the name.
 */
export const CODE_AGENT_SPAWN_TOOL = "code.agent.spawn";

/**
 * Nesting levels allowed below a main run: **one**. A main run delegates; its children work instead of
 * delegating. Nothing here is a check that could be skipped — a child run never receives the delegation tool
 * (`resolveCodeRunCapabilityScope`), the tool runtime refuses the name outright for a run with a parent, and
 * the shared budget refuses an allowance past this depth.
 */
export const CODE_SUBAGENT_MAX_DEPTH = 1;

/** Hard ceiling for work admitted in parallel under one parent. Configuration may lower it, never raise it. */
export const CODE_SUBAGENT_MAX_PARALLELISM = 4;

/**
 * The same limit expressed the way a registry that counts the **root** as depth 1 does (root = 1, its own
 * children = 2). Kept derived from `CODE_SUBAGENT_MAX_DEPTH` so the two vocabularies cannot drift apart.
 */
export const CODE_SUBAGENT_MAX_NODE_DEPTH = CODE_SUBAGENT_MAX_DEPTH + 1;

/**
 * Ceilings for the **generic** A2A registries (`NestedSubagentManager`, `A2AQuotaManager`). They orchestrate
 * peer agents rather than a coding run's children, so their bound is larger — but it is declared once, here,
 * instead of arriving as three unrelated literals (4, 5 and 1), and an explicit caller can no longer pass an
 * unbounded number. The previous defaults (4 and 5) are inside these ceilings, so nothing that worked before
 * is refused now; only a nonsense value is.
 */
export const CODE_SUBAGENT_REGISTRY_MAX_DEPTH = 5;
export const CODE_SUBAGENT_REGISTRY_MAX_CHILDREN = 5;

/** The two spellings of "every tool". Neither is a universal key: see `resolveEffectiveToolSet`. */
export const CODE_SUBAGENT_WILDCARDS: ReadonlySet<string> = new Set(["*", "all"]);

function finiteInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** Configuration may lower the nesting depth (0 = "nobody delegates"), never raise it. */
export function clampCodeSubagentDepth(value: unknown): number {
  return Math.max(0, Math.min(finiteInt(value, CODE_SUBAGENT_MAX_DEPTH), CODE_SUBAGENT_MAX_DEPTH));
}

/** Configuration may lower the parallel fan-out, never raise it past the hard ceiling. */
export function clampCodeSubagentParallelism(value: unknown): number {
  return Math.max(1, Math.min(finiteInt(value, CODE_SUBAGENT_MAX_PARALLELISM), CODE_SUBAGENT_MAX_PARALLELISM));
}

/** The generic registry's own bound: at least one level, never past its declared ceiling. */
export function clampCodeSubagentRegistryDepth(value: unknown): number {
  return Math.max(1, Math.min(finiteInt(value, CODE_SUBAGENT_MAX_NODE_DEPTH), CODE_SUBAGENT_REGISTRY_MAX_DEPTH));
}

/** The generic registry's fan-out bound. */
export function clampCodeSubagentRegistryChildren(value: unknown): number {
  return Math.max(1, Math.min(finiteInt(value, CODE_SUBAGENT_MAX_PARALLELISM), CODE_SUBAGENT_REGISTRY_MAX_CHILDREN));
}

export interface ResolvedCodeSubagentLimits {
  /** Nesting levels allowed below a main run (0 or 1). */
  maxDepth: number;
  /** Hard-clamped parallel fan-out (1..4). */
  maxParallelism: number;
  /** True when `maxDepth` still allows a delegation at all. */
  delegationAllowed: boolean;
}

/**
 * Resolves the coding agent's subagent limits from whichever configuration object the caller has. Both
 * numbers are clamped **here**, so no caller can observe an unclamped value.
 */
export function resolveCodeSubagentLimits(
  limits: { subagentDepth?: unknown; subagentParallelism?: unknown } = {},
): ResolvedCodeSubagentLimits {
  const maxDepth = clampCodeSubagentDepth(limits.subagentDepth);
  return {
    maxDepth,
    maxParallelism: clampCodeSubagentParallelism(limits.subagentParallelism),
    delegationAllowed: maxDepth >= 1,
  };
}

export interface EffectiveToolSet {
  /** The resolved tools, spelled the way the canonical universe spells them. Never contains a wildcard. */
  tools: string[];
  /** True when the input contained `*`/`all`. */
  wildcardRequested: boolean;
  /**
   * True when a wildcard was present but no canonical universe was supplied — so the wildcard granted
   * **nothing**. This is the fail-closed direction of "`*` is not a universal key".
   */
  wildcardUnresolved: boolean;
  /** Entries that are not part of the supplied canonical universe, so they cannot be granted. */
  unknown: string[];
}

function canonicalIndex(canonicalTools?: readonly string[] | null): Map<string, string> | null {
  if (!canonicalTools || canonicalTools.length === 0) return null;
  const index = new Map<string, string>();
  for (const tool of canonicalTools) {
    if (typeof tool !== "string") continue;
    const trimmed = tool.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!index.has(key)) index.set(key, trimmed);
  }
  return index.size ? index : null;
}

/**
 * Resolves a list of tool grants against the deployment's canonical universe (the published registry).
 *
 * Three rules, and they are the whole of C12's capability narrowing:
 *  - a wildcard expands to the canonical universe and to **nothing else**; with no universe to expand into it
 *    grants nothing and says so (`wildcardUnresolved`), instead of silently meaning "everything";
 *  - an entry outside the canonical universe cannot be granted (a tool that is not published is not a tool);
 *  - the result is a plain set (no wildcard survives), so every consumer compares names and cannot reintroduce
 *    "everything" by accident.
 *
 * When no canonical universe is supplied, explicit names are kept as given: the caller is a registry that owns
 * its own vocabulary (the generic A2A routes), and inventing a universe there would be worse than saying
 * "these names, unchanged".
 */
export function resolveEffectiveToolSet(
  entries: readonly string[] | undefined | null,
  canonicalTools?: readonly string[] | null,
): EffectiveToolSet {
  const canonical = canonicalIndex(canonicalTools);
  const tools: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  let wildcardRequested = false;
  let wildcardUnresolved = false;

  for (const raw of entries ?? []) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim();
    if (!entry) continue;
    if (CODE_SUBAGENT_WILDCARDS.has(entry.toLowerCase())) {
      wildcardRequested = true;
      if (!canonical) {
        wildcardUnresolved = true;
        continue;
      }
      for (const [key, spelled] of canonical) {
        if (seen.has(key)) continue;
        seen.add(key);
        tools.push(spelled);
      }
      continue;
    }
    const key = entry.toLowerCase();
    if (canonical) {
      const spelled = canonical.get(key);
      if (!spelled) {
        if (!unknown.includes(entry)) unknown.push(entry);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      tools.push(spelled);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push(entry);
  }

  return { tools, wildcardRequested, wildcardUnresolved, unknown };
}

/** Why a run's capability scope is what it is. Metadata only: it never decides anything by itself. */
export type CodeRunCapabilityScopeSource =
  /** A main run: no narrowing was recorded, and the run may delegate while the depth limit allows it. */
  | "root"
  /** A delegated run whose recorded intersection was resolved. */
  | "subagent_scope"
  /** A delegated run with **no** recorded scope: fail closed — no tools, no delegation. */
  | "subagent_scope_missing"
  /** A delegated run whose recorded scope was a wildcard with no canonical universe: fail closed. */
  | "subagent_wildcard_unresolved";

export interface CodeRunCapabilityScope {
  /** The run that delegated this one, or `null` for a main run. Always a server fact. */
  parentRunId: string | null;
  isSubagent: boolean;
  /**
   * The tools this run may call. `null` means "no narrowing was recorded" and is only ever produced for a
   * **main** run; a delegated run always gets an explicit list, `[]` included.
   */
  tools: string[] | null;
  /** True when this run may be offered the delegation tool. A delegated run never may. */
  mayDelegate: boolean;
  source: CodeRunCapabilityScopeSource;
  /** Granted names the deployment does not publish (dropped, and reported so the record can be fixed). */
  unknownTools: string[];
}

/**
 * Computes the **one** capability-scope object a run uses. The runner hands the same object to
 * `toolDescriptors` (what the model is offered) and to every `toolRuntime.invoke` (what the tool runtime
 * enforces), so the courtesy half and the enforcement half cannot disagree — the same shape as the C11
 * read-only intent and its `reviewScope`.
 *
 * The inputs are server facts: the parent run id and the intersection the delegation recorded. A model
 * argument can never reach here.
 */
export function resolveCodeRunCapabilityScope(input: {
  parentRunId?: string | null;
  allowedTools?: readonly string[] | null;
  canonicalTools?: readonly string[] | null;
  maxDepth?: unknown;
}): CodeRunCapabilityScope {
  const rawParent = typeof input.parentRunId === "string" ? input.parentRunId.trim() : "";
  const limits = resolveCodeSubagentLimits({ subagentDepth: input.maxDepth });

  if (!rawParent) {
    return {
      parentRunId: null,
      isSubagent: false,
      tools: null,
      mayDelegate: limits.delegationAllowed,
      source: "root",
      unknownTools: [],
    };
  }

  if (input.allowedTools === undefined || input.allowedTools === null) {
    return {
      parentRunId: rawParent,
      isSubagent: true,
      tools: [],
      mayDelegate: false,
      source: "subagent_scope_missing",
      unknownTools: [],
    };
  }

  const resolved = resolveEffectiveToolSet(input.allowedTools, input.canonicalTools);
  if (resolved.wildcardUnresolved) {
    return {
      parentRunId: rawParent,
      isSubagent: true,
      tools: [],
      mayDelegate: false,
      source: "subagent_wildcard_unresolved",
      unknownTools: resolved.unknown,
    };
  }

  return {
    parentRunId: rawParent,
    isSubagent: true,
    tools: resolved.tools,
    mayDelegate: false,
    source: "subagent_scope",
    unknownTools: resolved.unknown,
  };
}

/** The depth a run occupies in the delegation tree: 1 for a main run, 2 for its child. */
export function subagentDepthForRun(parentRunId?: string | null): number {
  return typeof parentRunId === "string" && parentRunId.trim() ? CODE_SUBAGENT_MAX_NODE_DEPTH : 1;
}

/**
 * The delegation question, asked in the two places that own a tool list (the generic A2A registry and the
 * coding runner) so both answer with the same rule instead of with their own literal.
 */
export function codeSubagentDelegationAllowed(input: {
  parentRunId?: string | null;
  maxDepth?: unknown;
}): boolean {
  if (typeof input.parentRunId === "string" && input.parentRunId.trim()) return false;
  return resolveCodeSubagentLimits({ subagentDepth: input.maxDepth }).delegationAllowed;
}
