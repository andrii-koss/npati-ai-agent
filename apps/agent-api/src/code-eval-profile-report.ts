/**
 * C14: the comparative eval report **per model profile** — and, in the same document, the statement of what it
 * does not measure.
 *
 * Why the split is the whole point: `runEvalSuite` never reads a model profile. The corpus is a scripted
 * transcript run through the tool path, so a table saying "task X passed on profile Y" would be a **label**,
 * not a measurement — the number would be identical for every profile because no profile changed anything.
 * A report is only worth its bytes if a reader can tell which columns were measured, so this module produces
 * two clearly separated halves:
 *
 *  1. **Conformance — measured.** For every subject model (and every deployment state: the whole registry, no
 *     profile enabled, a flag-enabled subset) it resolves the profile through the real `resolveModelProfile`
 *     and records the real `modelProfileFallbackTrace`: which profile was chosen, how it matched
 *     (`model`/`pattern`/`provider`/`override`/`default`), what it decides (tool calling mode, parallel calls,
 *     context window) and **why** the conservative default was used when it was. This is a deterministic
 *     function of configuration, so it is a measurement, and the corpus suite re-runs it in CI.
 *
 *  2. **Quality — NOT measured.** A per-profile pass rate needs a run that actually calls a model, which the
 *     recorded corpus does not do and must not pretend to. Every profile therefore carries
 *     `quality: { status: "not_run", reason: "live_run_not_performed" }` — including a profile no subject
 *     matched, which is why the table can show "nothing here" without inventing a `0` or a `-`.
 *
 * The requirement for a real quality number is recorded as the code that enforces it: `runEvalSuite` throws
 * `eval_live_model_missing` when `NPATI_CODE_EVAL_LIVE=1` is set but no live model was injected, so the live
 * number cannot silently degrade into the recorded one. The report quotes that refusal rather than promising
 * a future measurement.
 *
 * The corpus section is deliberately about the **fixture**, not about a profile: it counts the tasks by kind
 * and language (which is what makes "30+ tasks, seven kinds, four programming languages" checkable data) and
 * names where the per-task records live rather than inventing a per-profile number.
 */

import {
  CONSERVATIVE_CODE_MODEL_PROFILE_ID,
  DEFAULT_CODE_MODEL_PROFILES,
  conservativeCodeModelProfile,
  modelProfileFallbackTrace,
  resolveModelProfile,
  type CodeModelProfile,
  type CodeModelProfileFallbackTrace,
} from "./code-model-profiles";
import {
  CODE_EVAL_SCHEMA_VERSION,
  EVAL_TASK_KINDS,
  EVAL_LANGUAGES,
  type EvalTask,
} from "./code-eval-harness";

/** One model the conformance matrix is resolved for: the provider id and the model id as the engine sees them. */
export interface CodeEvalProfileSubject {
  provider: string | null;
  model: string | null;
}

/**
 * The default subject list. It is chosen to make each resolution *rule* observable rather than to enumerate a
 * catalogue: an exact-model match, a pattern match on a hosted id, a provider match on a local runtime, and a
 * model nothing knows (which must land on the conservative default).
 */
export const CODE_EVAL_PROFILE_SUBJECTS: readonly CodeEvalProfileSubject[] = Object.freeze([
  { provider: "openai", model: "gpt-4o" },
  { provider: "anthropic", model: "claude-3-5-haiku" },
  { provider: "ollama", model: "llama3.1:8b" },
  { provider: null, model: "acme/mystery-1" },
]);

/**
 * A deployment state the matrix is measured in. The third one exists because the fail-closed behaviour is a
 * *decision*, not an absence: with the flag-enabled subset applied, a subject that would match a profile
 * outside the subset must fall back to the conservative default with the `no_matching_profile` reason.
 */
export interface CodeEvalProfileScenario {
  id: string;
  /** `null` means "no filter was applied" (the whole registry is searched), which is not the same as `[]`. */
  enabledProfileIds: readonly string[] | null;
  description: string;
}

export const CODE_EVAL_PROFILE_SCENARIOS: readonly CodeEvalProfileScenario[] = Object.freeze([
  {
    id: "registry_unfiltered",
    enabledProfileIds: null,
    description: "no profile flag filter was applied: the whole published registry is searched",
  },
  {
    id: "no_profile_enabled",
    enabledProfileIds: Object.freeze([]),
    description: "the deployment enabled no profile, so every subject fails closed to the conservative default",
  },
  {
    id: "flags_enabled_subset",
    enabledProfileIds: Object.freeze(["hosted-native-tools", "local-text-tools"]),
    description: "an operator subset is enabled: a profile outside it cannot match, and that is reported",
  },
]);

/** One measured resolution: a scenario and a subject, and what the real resolver answered. */
export interface CodeEvalProfileConformanceRow extends CodeModelProfileFallbackTrace {
  scenario: string;
  provider: string | null;
  model: string | null;
}

/**
 * Why a profile has no quality number. One value, deliberately: a second one would have to mean either "the
 * run happened and failed" (a different report) or "the profile is not used" (which is `matchedFor: []`).
 */
export const CODE_EVAL_PROFILE_QUALITY_REASONS = ["live_run_not_performed"] as const;
export type CodeEvalProfileQualityReason = (typeof CODE_EVAL_PROFILE_QUALITY_REASONS)[number];

/** One row of the comparative table: the measured conformance facts plus the unmeasured quality field. */
export interface CodeEvalProfileTableRow {
  profileId: string;
  source: "registry" | "conservative_default";
  /** The match kinds that selected this profile, measured (sorted, de-duplicated). */
  matchedBy: readonly string[];
  /** `<scenario>:<provider>/<model>` for every subject this profile is the resolved answer for. */
  matchedFor: readonly string[];
  toolCallingMode: string;
  maxParallelToolCalls: number;
  contextWindow: number;
  /** Never a number in a recorded run: a per-profile quality number would need a live model. */
  quality: { status: "not_run"; reason: CodeEvalProfileQualityReason };
}

export interface CodeEvalProfileQualityStatement {
  measured: false;
  status: "not_run";
  reason: CodeEvalProfileQualityReason;
  /** The two things a real per-profile quality measurement would require. */
  requires: readonly string[];
  /** The refusal this build already performs, quoted so the requirement is enforced rather than promised. */
  refusal: { code: string; detail: string };
  note: string;
}

export interface CodeEvalProfileCorpusSummary {
  tasks: number;
  /** Task counts per `EvalTaskKind` (all seven keys present, zeros included, so a missing kind is visible). */
  taskTypes: Record<string, number>;
  /** Task counts per `EvalLanguage` (all keys present, zeros included). */
  languages: Record<string, number>;
  /** Tasks that declare neither metadata field. Must be 0 for the shipped corpus, and is asserted as such. */
  undeclaredTaskType: number;
  undeclaredLanguage: number;
  /**
   * Where the per-task scores actually are. Deliberately not a file path that no step writes: the scores are the
   * in-process `EvalReport`, the corpus suite asserts them, and CI persists the **vitest** JSON of that same
   * suite — which carries the verdict and the individual test names, not the scores. Claiming the CI artifact
   * holds them would be the same class of error as inventing a number.
   */
  records: {
    status: "profile_independent";
    producedBy: string;
    assertedBy: string;
    ciArtifact: string;
    reason: string;
  };
}

export interface CodeEvalProfileReport {
  schemaVersion: number;
  mode: "recorded";
  scenarios: readonly CodeEvalProfileScenario[];
  conformance: readonly CodeEvalProfileConformanceRow[];
  profiles: readonly CodeEvalProfileTableRow[];
  quality: CodeEvalProfileQualityStatement;
  corpus: CodeEvalProfileCorpusSummary;
}

export interface BuildCodeEvalProfileReportInput {
  /** The corpus, used only for its shape (counts by kind and language) — never to attribute a result. */
  tasks?: readonly EvalTask[];
  profiles?: readonly CodeModelProfile[];
  subjects?: readonly CodeEvalProfileSubject[];
  scenarios?: readonly CodeEvalProfileScenario[];
  /** Overrides CI's evidence path for the same suite, when a caller runs it under another name. */
  ciArtifact?: string;
}

const DEFAULT_CI_ARTIFACT = "artifacts/coding-agent-eval-smoke-report.json";

function subjectLabel(subject: CodeEvalProfileSubject): string {
  return `${subject.provider ?? "-"}/${subject.model ?? "-"}`;
}

/** Zeroed counters for a closed vocabulary, so a kind or language with no task is visible as `0`, not absent. */
function emptyCounts(vocabulary: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of vocabulary) counts[key] = 0;
  return counts;
}

/**
 * Builds the report. Pure: every number comes from the passed data plus the real profile resolver, so the same
 * inputs give byte-identical output and the suite can re-derive it in CI.
 */
export function buildCodeEvalProfileReport(input: BuildCodeEvalProfileReportInput = {}): CodeEvalProfileReport {
  const profiles = input.profiles ?? DEFAULT_CODE_MODEL_PROFILES;
  const subjects = input.subjects ?? CODE_EVAL_PROFILE_SUBJECTS;
  const scenarios = input.scenarios ?? CODE_EVAL_PROFILE_SCENARIOS;
  const tasks = input.tasks ?? [];

  const conformance: CodeEvalProfileConformanceRow[] = [];
  for (const scenario of scenarios) {
    for (const subject of subjects) {
      const resolved = resolveModelProfile({
        provider: subject.provider,
        model: subject.model,
        profiles,
        // `null` means no filter at all; the resolver treats `undefined` as "no filter" and `[]` as "nothing
        // enabled", and collapsing the two would erase the exact fail-closed distinction this report exists for.
        ...(scenario.enabledProfileIds === null ? {} : { enabledProfileIds: scenario.enabledProfileIds }),
      });
      conformance.push({
        scenario: scenario.id,
        provider: subject.provider,
        model: subject.model,
        ...modelProfileFallbackTrace(resolved, { enabledProfileIds: scenario.enabledProfileIds }),
      });
    }
  }

  // One row per registry profile plus the conservative default the resolver can return. The conservative
  // profile is computed from the same registry, so its context window is the registry's own minimum.
  const tableProfiles: Array<{ profile: CodeModelProfile; source: "registry" | "conservative_default" }> = profiles.map(
    (profile) => ({ profile, source: "registry" as const }),
  );
  if (!profiles.some((profile) => profile.id === CONSERVATIVE_CODE_MODEL_PROFILE_ID)) {
    tableProfiles.push({ profile: conservativeCodeModelProfile(profiles), source: "conservative_default" });
  }

  const profilesTable: CodeEvalProfileTableRow[] = tableProfiles.map(({ profile, source }) => {
    const rows = conformance.filter((row) => row.profileId === profile.id);
    return {
      profileId: profile.id,
      source,
      matchedBy: [...new Set(rows.map((row) => row.matchedBy))].sort(),
      matchedFor: rows.map((row) => `${row.scenario}:${subjectLabel(row)}`).sort(),
      toolCallingMode: profile.toolCallingMode,
      maxParallelToolCalls: profile.maxParallelToolCalls,
      contextWindow: profile.contextWindow,
      quality: { status: "not_run" as const, reason: CODE_EVAL_PROFILE_QUALITY_REASONS[0] },
    };
  });

  const taskTypes = emptyCounts(EVAL_TASK_KINDS);
  const languages = emptyCounts(EVAL_LANGUAGES);
  let undeclaredTaskType = 0;
  let undeclaredLanguage = 0;
  for (const task of tasks) {
    if (task.taskType) taskTypes[task.taskType] = (taskTypes[task.taskType] ?? 0) + 1;
    else undeclaredTaskType += 1;
    if (task.language) languages[task.language] = (languages[task.language] ?? 0) + 1;
    else undeclaredLanguage += 1;
  }

  return {
    schemaVersion: CODE_EVAL_SCHEMA_VERSION,
    mode: "recorded",
    scenarios,
    conformance,
    profiles: profilesTable,
    quality: {
      measured: false,
      status: "not_run",
      reason: CODE_EVAL_PROFILE_QUALITY_REASONS[0],
      requires: Object.freeze(["NPATI_CODE_EVAL_LIVE=1", "a liveModel port injected into the harness deps"]),
      refusal: {
        code: "eval_live_model_missing",
        detail: "runEvalSuite refuses a live run without a live model instead of reusing the recorded answers",
      },
      note:
        "The recorded suite never reads a model profile, so no task result may be attributed to one. A pass "
        + "rate per profile requires the live run above; until it is performed every row is `not_run`, and no "
        + "number is estimated in its place.",
    },
    corpus: {
      tasks: tasks.length,
      taskTypes,
      languages,
      undeclaredTaskType,
      undeclaredLanguage,
      records: {
        status: "profile_independent",
        producedBy: "runEvalSuite() -> EvalReport (per task: success, diffStats, turns, tokens, costUsd, durationMs)",
        assertedBy: "tests/coding-agent-c6-eval.test.ts",
        ciArtifact: input.ciArtifact ?? DEFAULT_CI_ARTIFACT,
        reason:
          "the per-task scores are recorded per task by the corpus suite; they are identical for every profile "
          + "because no profile is read, so attributing one to a profile would be a label rather than a measurement",
      },
    },
  };
}
