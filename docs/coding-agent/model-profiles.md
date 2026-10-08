# Coding Agent — model profiles (C14)

Scope: what a model profile is, how one is resolved, what the `code.model_profile.<id>` flags do and — most
importantly for this step — **what happens when none of them is on**.

Code: `apps/agent-api/src/code-model-profiles.ts`. Comparative report:
`docs/coding-agent/c14-eval-corpus-and-profiles.md`, `docs/coding-agent/c14-final-report.md`.
Owner decision 2 (C14): the fallback is fail-closed **and visible** (`docs/coding-agent/current-state.md:55-66`).

---

## 1. Why profiles exist

The module's header states the rule: how a model is driven is **configuration, not code**
(`code-model-profiles.ts:1-13`). The agent loop must not branch on a model name or a provider brand; it asks
for a profile, and the profile answers the four questions the loop needs — how tool calls arrive, how many may
run at once, how much context fits, and which edit tool the model handles best. An operator can replace the
registry without touching the loop, which is what makes the harness model-agnostic.

Everything unknown fails closed: `toolCallingMode: "auto"`, **one** tool call at a time, the smallest context
window the registry knows, no temperature opinion and no preferred edit tool. Guessing here would silently
give a weak model parallel writes and a long context it cannot hold (`code-model-profiles.ts:9-12`, `:81-91`).

---

## 2. The shipped registry

`DEFAULT_CODE_MODEL_PROFILES` (`code-model-profiles.ts:112-141`) is data, exported so a test can resolve the
same logic against another registry.

| Profile id | Matches | `toolCallingMode` | `maxParallelToolCalls` | `contextWindow` | `preferredEditTool` |
| --- | --- | --- | --- | --- | --- |
| `hosted-native-tools` | providers `anthropic`, `openai`, `google`, `azure`, `bedrock`, `vertex` | `native` | 4 | 200 000 | `code.fs.apply_patch` |
| `hosted-native-tools-small-context` | patterns `*mini*`, `*flash*`, `*haiku*`, `*small*` | `native` | 2 | 64 000 | — |
| `local-text-tools` | providers `ollama`, `lmstudio`, `llamacpp`, `llama.cpp`, `vllm`, `localai`, `local`, `self-hosted`; patterns `*local*`, `*selfhosted*` | `text` | 1 | 32 000 | — |
| `conservative-default` | nothing (by construction) | `auto` | 1 | the registry's **minimum** window (32 000 for the shipped registry) | — |

Each profile also carries honest `knownLimitations` strings, e.g. "native tool calling is assumed for these
providers; verify per model" and "local models: tool calls are parsed from text and are never trusted as
instructions" (`code-model-profiles.ts:120`, `:128`, `:139`).

Validation bounds (`validateCodeModelProfile`, `:245-330`): `maxParallelToolCalls` is an integer in
**1..8** (`MIN_PARALLEL_TOOL_CALLS`/`MAX_PARALLEL_TOOL_CALLS`, `:74-75`), `contextWindow` is an integer
**≥ 1 024** (`MIN_CONTEXT_WINDOW`, `:77`), `temperature` if present is 0..2, `preferredEditTool` if present
is a non-empty string, and `match` must name at least one provider, model or pattern. `FALLBACK_CONTEXT_WINDOW
= 8 192` is used only when the registry itself is empty or invalid (`:79`).

---

## 3. Resolution

`resolveModelProfile` (`code-model-profiles.ts:386-453`) resolves in this order:

```
explicit override  →  exact model id (3)  →  pattern (2)  →  provider (1)  →  conservative default
```

Specificity is defined by `profileMatchSpecificity` (`:368-373`) and the winner is the highest specificity;
the C6 trace records which kind won as `matchedBy ∈ {override, model, pattern, provider, default}`
(`:41`).

Four deliberate details:

1. **Patterns are anchored and case-insensitive globs**, `*` = any run, `?` = one character
   (`matchesModelPattern`, `:336-351`). Anchoring matters: an unanchored match would let `evil-claude-proxy`
   look like `claude`.
2. **An empty or whitespace model id never matches anything** (`:341-344`) — a model that could not be
   identified must fall through to the conservative profile rather than inherit whatever matched.
3. **A bare `*` pattern is rejected** (`invalid_profile_pattern`, `:309-313`): a catch-all profile would hand
   every unknown model native tool calling and parallel writes, which is exactly what the conservative
   default exists to prevent.
4. **Invalid entries are skipped, never partially applied.** A profile that fails validation, an invalid
   override and an unknown enabled id all become warnings
   (`invalid_profile_skipped:*`, `invalid_override_skipped:*`, `enabled_profile_unknown:*`), because a
   half-applied profile is worse than the conservative one (`:381-419`). A tie between two equally specific
   profiles is reported as `ambiguous_profile_match:<ids>:using:<winner>` and the first is used (`:444-448`).

The resolved value is `{ profile, matchedBy, warnings, subject }`, where `subject` carries the normalised
provider/model the decision was made for, so Activity can record them verbatim (`:54-60`).

### 3.1 Effective tool-calling mode

`resolveEffectiveToolCallingMode` (`:460-467`): `native` stays native, `text` stays text, and **`auto`
resolves to `native` only when the provider actually returned native tool calls** for this exchange —
otherwise the text protocol is parsed. The asymmetry is intentional: assuming native support loses tool calls
silently, while parsing text can only fail loudly (`:455-459`).

---

## 4. Flags: `enabledProfileIds` is a filter, never an assignment

`code.model_profile.<id>` is the flag key for one registry profile
(`CODE_MODEL_PROFILE_FLAG_PREFIX` / `codeModelProfileFlagKey`, `:151-155`). The pattern is owned by
`feature-flags.ts` (`CODE_MODEL_PROFILE_PATTERN = /^code\.model_profile\.[a-z0-9._-]{1,64}$/`,
`feature-flags.ts:65`) and a test asserts every key this function builds is accepted there, so the two
definitions cannot drift (`code-model-profiles.ts:143-151`).

`resolveEnabledModelProfileIds` (`:191-210`) fails closed **in both directions**:

* **without a flag reader, no profile is enabled** (`if (!flags) return []`, `:196`). It never means "all
  profiles": a deployment that cannot say which profiles it allows must not get native tool calling and
  parallel writes for every model (`:181-186`);
* **a flag read that throws counts as disabled** (`catch {}`, `:205-207`), so a flag-store outage narrows
  behaviour instead of widening it;
* the conservative default is deliberately **not** flag-gated — it is the fallback for a registry with no
  match, so disabling it would leave an unknown model with no profile at all (`:187-189`).

Consequences, stated plainly:

| Deployment state | What every model gets |
| --- | --- |
| No `code.model_profile.<id>` flag enabled (the default), or no flag reader wired | `conservative-default` for **all** models — no native tool calling, one tool call at a time |
| A subset enabled | Only the enabled ids can win; a model that would have matched a disabled profile falls back to `conservative-default` with the reason `no_matching_profile` |
| The whole registry searchable (`enabledProfileIds` absent) | The profile its provider/model/pattern matches |

**Filter, not assignment:** enabling `code.model_profile.local-text-tools` does not give any model that
profile. It only permits that profile to be *considered*; the model still has to match it
(`:401-404`, `code-eval-profile-report.ts:67-95`).

---

## 5. The fallback reason vocabulary

`CodeModelProfileFallbackReason = "profile_flag_disabled" | "no_matching_profile"`
(`code-model-profiles.ts:484-490`), computed by `modelProfileFallbackReasonFor` (`:499-505`):

| Situation | `matchedBy` | `fallbackReason` |
| --- | --- | --- |
| The model matched a profile | `model` / `pattern` / `provider` / `override` | `null` — "no degradation" is the absence of a reason, not a reason (`:481-482`) |
| Profiles are enabled but none matches (or the registry is empty/invalid) | `default` | `no_matching_profile` |
| The deployment enabled **nothing** (`enabledProfileIds` present and empty) | `default` | `profile_flag_disabled` |

`undefined` and `[]` are therefore different inputs with different operator actions, and collapsing them
would erase the exact fail-closed distinction the report exists for (`:492-498`,
`code-eval-profile-report.ts:211-213`).

`modelProfileFallbackTrace` (`:542-552`) is deliberately a **second** function that spreads the C6 trace and
appends `fallbackReason` + `enabledProfileIds`, rather than adding keys to `modelProfileTrace`: the four keys
of the C6 trace are a pinned contract, and a consumer that switches on the trace's exact shape must not break
because a diagnostic field was added (`:522-540`).

---

## 6. Where all of this is visible

| Surface | What is recorded | Source |
| --- | --- | --- |
| **Activity** | `modelProfileFallbackReason` is written into the existing `run_activity` payload of every event recorded after the profile was resolved, published through the per-run holder | `coding-agent-runner.ts:2225-2234`, `app.ts:4813` |
| **ExecutionSnapshot** | An **optional** source `modelProfileFallbackReason`; a deployment that does not wire it keeps the payload's previous key set and the snapshot schema version does not move | `execution-snapshot.ts:132`, `:216`; `current-state.md:61-62` |
| **Inspector** | `GET /capabilities/inspect` answers an additive `modelProfiles` section: registry ids, enabled ids, whether that list is empty, and the fallback reason for an empty one | `app.ts:6397`, `:4943`, `:6444-6504` |
| **CapabilityInspectorPage** | A warning banner driven by that section, present in all seven i18n dictionaries | `current-state.md:64-66` |
| **Subagents** | Each of the five typed subagents names a **model profile id**, never a literal model name; `explore` and `test` use `hosted-native-tools-small-context` | `code-subagent-types.ts:103-161` |

The point of this visibility is the C14 owner decision: "the run used `conservative-default`" reads identically
whether the rollout is simply not switched on, the model has no profile, or the registry is broken — and those
need different actions (`code-model-profiles.ts:528-534`).

---

## 7. Conformance is measured; quality is `not_run`

`buildCodeEvalProfileReport()` (`code-eval-profile-report.ts:198-295`) resolves every
"deployment scenario × subject model" pair through the **real** `resolveModelProfile` and records the real
`modelProfileFallbackTrace`. Three scenarios (`registry_unfiltered`, `no_profile_enabled`,
`flags_enabled_subset`) times four subjects (`openai/gpt-4o`, `anthropic/claude-3-5-haiku`,
`ollama/llama3.1:8b`, `-/acme/mystery-1`) give nine measured rows plus one table row per profile.

`quality` is `{ status: "not_run", reason: "live_run_not_performed" }` for every profile — there is no numeric
quality field at all, by construction:

```
measured: false, status: "not_run", reason: "live_run_not_performed",
requires: ["NPATI_CODE_EVAL_LIVE=1", "a liveModel port injected into the harness deps"],
refusal: { code: "eval_live_model_missing", ... }
```

(`code-eval-profile-report.ts:264-277`.)

**Conformance must never be read as model quality.** The recorded corpus never reads a model profile (a source
guard asserts `code-eval-harness.ts` contains no import of `code-model-profiles` and no
`resolveModelProfile`/`modelProfileTrace`/`enabledProfileIds`), so a per-profile pass rate from that run would
be a label whose value is identical for every profile. The conformance table is a deterministic function of
configuration; the quality column needs a live run
(`code-eval-profile-report.ts:1-31`, `c14-eval-corpus-and-profiles.md:212-226`).

---

## 8. Honest limits

1. **Quality per profile is `not_run`** and can only be closed by a live run with `NPATI_CODE_EVAL_LIVE=1`
   plus an injected `liveModel`; until then no profile may be said to be "better" or "worse" at anything.
2. **The conformance matrix covers four subject models and three deployment states.** It is chosen to make
   each resolution *rule* observable (exact model, pattern, provider, unknown), not to enumerate a catalogue
   (`code-eval-profile-report.ts:55-59`).
3. **`knownLimitations` are operator notes, not measurements.** "Native tool calling is assumed for these
   providers; verify per model" is exactly that: an assumption flagged for verification, and no test proves
   per-model native support.
4. **Pattern matching is lexical.** `hosted-native-tools-small-context` matches any id containing `mini`,
   `flash`, `haiku` or `small`; a model whose name carries one of those substrings but not the behaviour would
   be mis-profiled, and only a live run or an operator override can show that.
5. **Subagent profile ids are not verified against live behaviour** either; the mapping is configuration and
   its resolution is pinned by tests, not its quality.
