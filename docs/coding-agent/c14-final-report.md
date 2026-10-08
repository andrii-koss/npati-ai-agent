# C14 final comparative report — evals, metrics, hardening

Scope: the C14 acceptance requirement (`docs/coding-agent/PLAN.md:989-1004`) answered with measurements. Every
number in this document has a source: a file and line, a test, or a reproduction command. Where something was
not measured, this document says `not measured` instead of estimating it.

Companion documents: `docs/coding-agent/c14-eval-corpus-and-profiles.md` (corpus and profile conformance),
`docs/coding-agent/c14-provider-cassette-and-arguments-hash.md` (cassette and `argumentsHash`),
`docs/coding-agent/security-gate-report.md` (G1/C14 red-team report),
`docs/coding-agent/security.md`, `docs/coding-agent/model-profiles.md`,
`docs/coding-agent/permission-modes.md`, `docs/coding-agent/architecture.md`.

---

## 1. What C14 asked for, and where the answer is

| `PLAN.md` item | Requirement | Where it is answered | Status |
| --- | --- | --- | --- |
| `:995` (1) | 30+ hermetic tasks in 3+ languages, 7 kinds; score tests, diff size, turns, tokens, cost, time | §3, §4 | **Measured** (33 tasks, 4 languages, 7 kinds) |
| `:996` (2) | Run the set on **each model profile** and produce a comparative report; smoke subset in CI; record/replay provider answers for deterministic tests | §2, §5, §6 | **Conformance measured; quality `not_run`** |
| `:997` (3) | Metrics in Activity: success rate, average turns, failed-edit share, approvals share, tool error rate, cost per run | §7 | **Implemented and pinned; live values `not measured`** |
| `:998` (4) | Extend the G1 red-team suite: injection via file/README/NPATI.md/web/MCP/command output, secret leaks, sandbox escape, traversal, fork bomb and resource exhaustion, infinite loops, approval bypass, mode substitution from file content, supply chain and DB migrations | §8 | **Measured** (catalogue of 23 rows, 7 new suites, 5 mutation controls) |
| `:999` (5) | Tune R1 limits and SLO; per-model budgets, cost/behaviour anomaly detection, threshold calibration from evals | — | **Out of this document's scope** (a parallel stream owns SLO calibration; not measured here) |
| `:1000` (6) | Documentation: architecture, permission modes, security, model profiles, how to add a model and a tool | `architecture.md`, `permission-modes.md`, `security.md`, `model-profiles.md`, `adding-a-model-and-a-tool.md` | **Delivered** |
| `:1001` (7) | Thresholds: edit-tool success ≥ 95 %, 0 successful red-team attacks, 0 sandbox escapes | §6, §8 | **§6 met; §8 met under the stated limits** |
| `:1003` | Acceptance: a report with per-model metrics, all red-team tests passing, documentation ready, CI blocks regressions | this document + `security-gate-report.md` | Per-model **quality** metrics are the one unmet part (§5); see the **G1 supersession note** below for the "CI blocks regressions" half |

> **G1 supersession note (2026-10-08) — read this before quoting the CI claims below.**
> This document was written when `.github/workflows/ci.yml` ran on `push`, `pull_request` and a weekly
> `schedule`, and every statement in it about CI was accurate for that configuration. The owner has since
> **disabled every automatic trigger** — the repository is private and has no paid Actions minutes, and on the
> last automatic run *all* jobs failed in about 2 seconds **without starting**, so the checks were never evidence
> (they were only a permanent red signal). All three workflows are now `workflow_dispatch`-only; no workflow file,
> job or step was removed, and the removed trigger contract is kept in each file as a machine-readable
> `RE-ENABLE RECIPE`. Consequently, wherever this document says "CI blocks regressions" or "the quarantine gate
> runs the whole suite as CI's only test step", read it as **"the configuration would do that if it were
> triggered; it is not triggered, and nothing blocks a merge or a release today"**. That consequence is recorded
> as an **accepted risk with an owner and an expiry** in `security-gate-report.md` §6 item 11, its effect on the
> G1 "mandatory CI job" requirement is stated in `current-state.md` (section "Current step"), and the exact
> change, the new pins and the non-vacuity proof are in `security-gate-report.md` §7.6. Nothing else in this
> document is superseded: every number below is a measurement of the code and the suites, not of a GitHub run.

---

## 2. The three headline numbers

| # | Number | Value | What proves it | Honest qualifier |
| --- | --- | --- | --- | --- |
| 1 | Corpus breadth | **33 tasks / 7 task kinds / 4 programming languages** (plus JSON configuration) | `tests/fixtures/coding-agent-eval/tasks.json`; `tests/coding-agent-c6-eval.test.ts:419` (exact count and exact ids), `:621-633` (every kind, every declared language) | 4 languages of *source code*; `json` is configuration, and Python/Go tasks have no executable command at all (§4.3) |
| 2 | Edit success | **33/33 tasks green** and **42/42 edit-class tool calls succeeded** ⇒ **100 %** (threshold: ≥ 95 %) | `tests/coding-agent-c6-eval.test.ts:460-466` (the test throws for any task that is not `ok`), `:490` (`evalReportIsGreen`), `:508-522` (pinned aggregate) | This is the **recorded, scripted corpus**, not a live model: it measures that the harness applies and verifies the intended change, not that a model writes good code. The production metric `failed_edit_rate` is implemented (§7) but has no live value yet |
| 3 | Red team | **0 successful attacks / 0 escapes** out of **23 catalogued attack classes** (22 `covered`, 1 `measured-limitation`) | `docs/coding-agent/attack-catalogue.json`; `docs/coding-agent/security-gate-report.md:171-204` (5 mutation controls); `:250` (7 new suites / 34 tests / `failed=0`); `node scripts/run-security-gate.mjs --list` ⇒ 144 suites | Attacks are **rules under test with scripted inputs**, not a live model attacking the build; and no container was ever run, so "0 escapes" means "no test produced one", not "an escape was attempted and stopped" (§8.3) |

---

## 3. Per-profile comparative table

Produced by `buildCodeEvalProfileReport()` (`apps/agent-api/src/code-eval-profile-report.ts:198-295`), which
calls the **real** `resolveModelProfile` and the real `modelProfileFallbackTrace` for every
scenario × subject pair. Scenarios: `registry_unfiltered` (`enabledProfileIds: null`), `no_profile_enabled`
(`[]`), `flags_enabled_subset` (`["hosted-native-tools","local-text-tools"]`). Subjects: `openai/gpt-4o`,
`anthropic/claude-3-5-haiku`, `ollama/llama3.1:8b`, `-/acme/mystery-1`.

| Profile | Source | `matchedBy` | Tool calling | Parallel | Context | Resolved for (measured) | Quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hosted-native-tools` | registry | `provider` | `native` | 4 | 200 000 | `registry_unfiltered:openai/gpt-4o`; `flags_enabled_subset:openai/gpt-4o`; `flags_enabled_subset:anthropic/claude-3-5-haiku` | `not_run` |
| `hosted-native-tools-small-context` | registry | `pattern` | `native` | 2 | 64 000 | `registry_unfiltered:anthropic/claude-3-5-haiku` | `not_run` |
| `local-text-tools` | registry | `provider` | `text` | 1 | 32 000 | `registry_unfiltered:ollama/llama3.1:8b`; `flags_enabled_subset:ollama/llama3.1:8b` | `not_run` |
| `conservative-default` | conservative | `default` | `auto` | 1 | 32 000 | `registry_unfiltered:-/acme/mystery-1`; `no_profile_enabled`: **all four** subjects; `flags_enabled_subset:-/acme/mystery-1` | `not_run` |

Three readings of this table that the C14 owner decisions were about:

1. **`no_profile_enabled` gives every model the conservative profile.** Without the
   `code.model_profile.<id>` flags, no model gets native tool calling and no model gets parallel writes. The
   reason recorded is `profile_flag_disabled` — a rollout that has not been switched on, not a misconfiguration.
2. **The third scenario shows a real demotion.** `anthropic/claude-3-5-haiku` matches the **pattern** profile
   when the whole registry is searched, but when only `hosted-native-tools` and `local-text-tools` are enabled
   it rides the **broader** provider profile. The report shows the winner rather than assuming one.
3. **A profile that matched nothing still gets a row** — with an empty `matchedFor` and `quality: not_run`,
   never an invented `0` or `-` (`code-eval-profile-report.ts:226-245`).

The row format is fixed (`profileId`, `source`, `matchedBy`, `matchedFor`, `toolCallingMode`,
`maxParallelToolCalls`, `contextWindow`, `quality`), so a numeric quality field cannot be added unnoticed
(`code-eval-profile-report.ts:112-124`).

### 3.1 Conformance matrix (measured)

| Scenario | Model | Profile | `matchedBy` | `fallbackReason` |
| --- | --- | --- | --- | --- |
| `registry_unfiltered` | `openai/gpt-4o` | `hosted-native-tools` | `provider` | — |
| `registry_unfiltered` | `anthropic/claude-3-5-haiku` | `hosted-native-tools-small-context` | `pattern` | — |
| `registry_unfiltered` | `ollama/llama3.1:8b` | `local-text-tools` | `provider` | — |
| `registry_unfiltered` | `-/acme/mystery-1` | `conservative-default` | `default` | `no_matching_profile` |
| `no_profile_enabled` | all four | `conservative-default` | `default` | `profile_flag_disabled` |
| `flags_enabled_subset` | `openai/gpt-4o` | `hosted-native-tools` | `provider` | — |
| `flags_enabled_subset` | `anthropic/claude-3-5-haiku` | `hosted-native-tools` | `provider` | — |
| `flags_enabled_subset` | `ollama/llama3.1:8b` | `local-text-tools` | `provider` | — |
| `flags_enabled_subset` | `-/acme/mystery-1` | `conservative-default` | `default` | `no_matching_profile` |

Nine measured rows, re-derived by the real resolver on every run
(`tests/coding-agent-c14-eval-metrics-and-profiles.test.ts`).

---

## 4. Corpus measurements

### 4.1 Aggregate of the real run

Pinned by assertion so the table cannot drift from the run
(`tests/coding-agent-c6-eval.test.ts:508-522`). Price model: `anthropic/claude-3-5-sonnet`
(3.0 USD per 1M prompt tokens, 15.0 USD per 1M completion tokens).

| Metric | Value |
| --- | --- |
| Tasks | 33 |
| `totals.steps` | 135 |
| `totals.turns` | 49 |
| `totals.checks` | 22 (14 from C9 + 8 new) |
| `totals.tokens` | 3 357 |
| `totals.diffStats` | 42 files / +80 lines / −43 lines |
| `totals.costUsd` | 0.019671 USD |
| `totals.costUnavailableTasks` | 0 (every task was priced; no `null` was silently counted as `0`) |
| `totals.durationMs` | collected per task, deliberately **not** pinned — wall-clock is not a property of the corpus |

`turns` (49) is deliberately smaller than the number of tool calls (80): consecutive tool calls in one turn are
**one** model turn, and `turns` is documented as a **lower bound** on model calls, never a claim larger than
the transcript proves (`docs/coding-agent/c14-eval-corpus-and-profiles.md:141-146`).

### 4.2 Corpus composition (measured from the fixture)

| Dimension | Breakdown |
| --- | --- |
| Task kinds (7/7) | `bug_fix` 12, `feature` 6, `tests` 4, `build_repair` 4, `refactor` 3, `multi_file` 2, `dependency_migration` 2 |
| Languages | `javascript` 17, `python` 5, `typescript` 4, `json` 4, `go` 3 |
| Steps | 135 total = **80** `tool` + **33** `message` + **22** `check` |
| Tool calls by tool | `code.fs.read` 38, `code.fs.edit` 22, `code.fs.write` 18, `code.fs.apply_patch` 1, `code.fs.move` 1 |
| Edit-class tool calls | **42** (edit 22 + write 18 + apply_patch 1 + move 1) |
| Commands | exactly three, all **simulators**: `npm test`, `npm run build`, `npm run deps:check` |
| Tool vocabulary | exactly `["code.fs.apply_patch","code.fs.edit","code.fs.move","code.fs.read","code.fs.write"]` — no shell, no deps, no git, no subagent, no MCP, no `ask_user` |

Hermeticity is derived from the data, not asserted: no `http://`/`https://` anywhere in the fixture, no
generated process, no Docker, no live model, and a session that names a fourth command fails instead of
passing (`tests/coding-agent-c6-eval.test.ts:636-661`;
`docs/coding-agent/c14-eval-corpus-and-profiles.md:117-126`).

### 4.3 The simulators are named simulators

| Command | What it is | What it does **not** do |
| --- | --- | --- |
| `npm test` | A **regex simulator** that evaluates only `expect(<fn>(a, b)).toBe(n)` against a JS/TS-shaped function body, honouring `.skip`/`.todo`/`.only` | Runs neither vitest nor node; understands **no** Python or Go |
| `npm run build` | A "can the build read its own configuration" stand that parses `package.json`/`tsconfig.json` with a real `JSON.parse` | Compiles nothing, resolves no module, calls no `tsc` |
| `npm run deps:check` | A regex scan of `import`/`require` plus a two-way manifest check | Resolves no package, knows no versions, touches no registry |

Consequence: **Python and Go tasks have no command at all.** Their verification is `file_contains` and
`diff_stats` over the change set — a statement about the fixture text, not about execution — and a test pins
that for every Python/Go task (`tests/coding-agent-c6-eval.test.ts:663-672`). An unknown command returns an
error, so a task cannot pass because of a runner nobody wired.

`diffStats` is the difference of the **sets of non-empty lines**, not an LCS diff; a line moved inside a file
counts as neither added nor removed. It is deliberately weaker than `git diff --numstat` and is documented as
such. `costUsd` is arithmetic on tokens and the project's price table, not provider metering; an unknown price
yields `null` with `costUnavailable: "no_price_for_model"` rather than the generic `default` price row
(`docs/coding-agent/c14-eval-corpus-and-profiles.md:147-161`).

---

## 5. Per-profile quality: `not_run` (the one unmet part of C14 item 2)

The report says this in its own bytes (`code-eval-profile-report.ts:264-277`):

```
measured: false
status: "not_run"
reason: "live_run_not_performed"
requires: ["NPATI_CODE_EVAL_LIVE=1", "a liveModel port injected into the harness deps"]
refusal: { code: "eval_live_model_missing",
           detail: "runEvalSuite refuses a live run without a live model instead of reusing the recorded answers" }
```

Why no number may be produced from the recorded run: **the recorded suite never reads a model profile.** A
source-level guard asserts `code-eval-harness.ts` contains no import of `code-model-profiles` and no
`resolveModelProfile` / `modelProfileTrace` / `enabledProfileIds`
(`docs/coding-agent/c14-eval-corpus-and-profiles.md:224-226`). A per-profile pass rate computed from it would
be identical for every profile, i.e. a **label**, not a measurement. The refusal is already enforced in code:
`resolveEvalMode` enables live mode only under `NPATI_CODE_EVAL_LIVE=1`, and `runEvalSuite` throws
`eval_live_model_missing` rather than reusing recorded answers
(`tests/coding-agent-c6-eval.test.ts:575-580`).

**Therefore: no model profile may be described as better or worse at anything on the basis of C14.** The
conformance table (§3) is a deterministic function of configuration; the quality column is empty by design.

---

## 6. Edit success (threshold ≥ 95 %)

| Measurement | Value | Source |
| --- | --- | --- |
| Tasks verified green | **33 / 33 = 100 %** | `tests/coding-agent-c6-eval.test.ts:460-466` throws for any task whose `ok` is false; `:490` asserts the report is green; `:508-522` pins the aggregate |
| Edit-class tool calls executed | **42** (`code.fs.edit` 22, `code.fs.write` 18, `code.fs.apply_patch` 1, `code.fs.move` 1) | counted from `tests/fixtures/coding-agent-eval/tasks.json` (80 `tool` steps total). The value equals `totals.diffStats.files` (42) by coincidence: that one counts **files changed**, this one counts **tool calls made** |
| Edit-class tool calls that failed | **0** | no fixture step declares `expectError`, so every tool step is a success-expecting call; the harness records a failure for any tool error and every task is `ok` (`code-eval-harness.ts:491-496`) |
| Threshold | ≥ 95 % (`PLAN.md:1001`) | **Met** (100 %) |

Nothing was "adjusted" to reach the threshold: no task was removed, no `verify` was weakened, and the corpus
test pins both the exact id list and the aggregate.

**What this number is not.** It says that the harness, given a correct transcript, applies the intended change
and the verification agrees. It does **not** say a model writes a working edit 100 % of the time, because no
model ran. The production counterpart — `failed_edit_rate`, the share of failed edit calls in Activity — is
implemented and tested (§7) but has **no live value**: `not measured`.

The corpus does contain a negative control for the failing direction, so the counter is not vacuous: a
transcript that "does not actually fix anything" reports `ok: false`, `verify_content_mismatch`, an empty
change set and zero turns (`tests/coding-agent-c6-eval.test.ts:525-537`), and a scripted tool error reports
`tool_failed:<tool>` (`:539-545`).

---

## 7. Metrics in Activity

Six metric kinds, exactly (`apps/agent-api/src/code-metrics.ts:45-51`), matching `PLAN.md:997`
one-for-one:

| Metric kind | Meaning | Unit |
| --- | --- | --- |
| `success_rate` | Share of finished runs that succeeded | ratio |
| `avg_turns` | Mean model turns per run | turns |
| `failed_edit_rate` | Share of failed edit calls | ratio |
| `approvals_share` | Share of runs that involved an approval | ratio |
| `tool_error_rate` | Share of failed tool calls | ratio |
| `cost_per_run` | Mean recorded cost per run | USD |

Three honesty rules are built into the module rather than left to a caller:

* A read that throws is **not** the same as a read that returned nothing: the failure is carried as its own
  flag into every metric the read feeds (`code-metrics.ts:196-197`).
* A run whose payload does not state an outcome is counted separately and left out of **both** numerator and
  denominator, rather than being counted as a success (`:250-251`).
* The cost mean is taken over the runs that actually recorded a cost; dividing a known total by a run count
  that includes unpriced runs would "invent a cheaper number, which is the defect this module exists to
  avoid" (`:330-331`). A cancelled or still-running run is excluded from rates and visible in
  `runs.byStatus` instead (`:287-288`).

**Live values: `not measured`.** These are aggregates computed from Activity at request time
(`collectCodeMetrics`, `code-metrics.ts:188`); no production Activity population was available in this step,
so this report states the metric definitions and their tests, not a number.

---

## 8. Red team: 0 successful attacks, 0 sandbox escapes

### 8.1 The catalogue

`docs/coding-agent/attack-catalogue.json` (version 1) holds **23 rows**, one per attack class, plus the
hard-deny rule coverage:

| Fact | Value |
| --- | --- |
| Rows | **23** |
| Status | **22** `covered`, **1** `measured-limitation` (RT-12) |
| Row fields | `id`, `class`, `suite`, `title`, `negativeControl`, `negativeControlSuite`, `negativeControlTitle`, `hardDenyRuleIds`, `status` |
| Hard-deny rule coverage | **12** classifier `HARD_DENY_RULES` accounted for: claimed by a row, or one of **11** exemptions each carrying a `probe` that really fires the rule |
| Guard levels | static validation **before** vitest; dynamic validation against the vitest JSON report **after**; the same functions exercised inside the suite |

Class groups present, by row: `resource_exhaustion` — fork bomb (RT-01, RT-02), process limit (RT-03), disk
(RT-05), memory/CPU (RT-06), output budget (RT-07), command length/time (RT-08); `prompt_injection` — command
output (RT-04), MCP tool description (RT-14); `path_traversal` — zip-slip (RT-09), archive metadata (RT-10),
encoded/Unicode (RT-11), Unicode normalisation (RT-12, the one `measured-limitation`), workspace-relative
guard (RT-13); `approval_bypass` — shell environment (RT-15); `gate_integrity` — mutation sensitivity
(RT-16…RT-20), catalogue contract (RT-21), catalogue report contract (RT-22), hard-deny rule coverage
(RT-23).

### 8.2 Why the catalogue cannot be prose

* A row whose suite file, suite registration, exact test title or negative control does not resolve makes the
  gate **red**; a negative control must be ≥ 40 characters so "n/a" is not an argument
  (`security-gate-report.md:48-63`).
* Five fabricated rows plus a duplicate id and an invented status all produce `ok=false` with their own
  codes, while the real catalogue produces `ok=true, issues=0` — so the guard is not "always fails" either
  (`security-gate-report.md:65-82`).
* Every one of the 11 hard-deny exemptions is proven by running its `probe` through
  `classifyShellCommand` and asserting `risk === "hard_deny"` **and** that `matched` contains that exact
  rule id (`security-gate-report.md:84-91`).

### 8.3 Mutation sensitivity — the part that makes "green" mean something

Five guards are neutralised **in memory** (no file on disk changes), each with the same three-step pattern:
refusal with the guard's own code → attack **succeeds** without it → refusal returns
(`security-gate-report.md:171-204`):

| Control | Guard | After neutralisation |
| --- | --- | --- |
| 1/5 | `fork_bomb` rule in `HARD_DENY_RULES` | `refused: hard_deny:fork_bomb` → `succeeded: risk=approval` → `hard_deny` |
| 2/5 | the classifier wiring in `PolicyEngine` | `deny:command_hard_denied` → `allow`; with no port at all, `deny:policy_engine_unavailable` (fail closed). Defence in depth measured: for a **network** command, neutralising the classifier still leaves `deny:network_enforcement_unavailable` |
| 3/5 | ZIP decompression budget | `refused: zip_bomb` → `succeeded: expanded=8388608` → `zip_bomb` |
| 4/5 | output budget in the untrusted envelope | `refused: truncated:<n>` → whole hostile payload delivered → truncated again |
| 5/5 | sensitive-file read policy | `refused: sensitive_file_denied` at `reads=0` → `succeeded: read=1,chars=21` → `deny` |

A sixth test asserts the declared control list is at least 3, has no duplicates, and every declaration names a
test that **exists in that file** — so "five controls" cannot decay into prose
(`security-gate-report.md:189-192`).

A real defect was found and fixed by this work: the `fork_bomb` pattern used `.` which does not cross a
newline, so a multi-line fork bomb fell into `approval` (a human could have approved it) instead of
`hard_deny`; it is now `[\s\S]*` with a regression test (`security-gate-report.md:107-110`).

### 8.4 What "0 sandbox escapes" proves — and what it does not

* **Proven:** no catalogued escape/extraction class succeeds; every class has a named refusing guard, a
  negative control, and (for five of them) a mutation proof that the guard is what refuses.
* **Not proven:** that a container actually holds. **No Docker is available in this environment**, so the
  containment claims are verified on the `docker create` argument line and on `DockerSandboxProvider`'s own
  limit validation — not by triggering an OOM, filling a disk, or attempting a real escape. A real container
  run under load is an unchecked item on the G1 manual checklist
  (`security-gate-report.md:131-133`, `:210-211`, `:262-273`).
* **Not proven:** that a *live model* would fail to attack the build. Every attack is scripted.

### 8.5 Gate state

| Measurement | Value | How |
| --- | --- | --- |
| Fixed suite list | **144** suites | `node scripts/run-security-gate.mjs --list` → 144 lines (reproduced while writing this document) |
| Escalated sign-off run | `security-gate` exit 0, **passed=2001 failed=0** | The C14 escalated run reported to the owner for this step. **Not re-run here** (it writes `artifacts/` and runs 144 suites); the suite count above is the part reproduced in this session |
| `security-gate-report.md` figure | 138 suites | `security-gate-report.md:37`, `:248-249` — accurate when written; six suites were registered afterwards. Documentation variance, not a code defect |

---

## 9. Metrics, evals and CI as regression protection

| Layer | What blocks a regression | Source |
| --- | --- | --- |
| Tool-schema contract | A schema change without a version bump, a removed published version, or a checksum mismatch fails the build | `npm run audit:code-tools`; `scripts/verify-code-tool-schemas.mjs:81-106` |
| Capability inventory | catalogue = matrix = registry, one number, plus manifest/schema parity | `npm run audit:capabilities` (4/4) |
| Corpus | Exact id list and the exact aggregate are pinned; the failing direction has negative controls | `tests/coding-agent-c6-eval.test.ts` |
| Metrics | Scoring arithmetic, `null` instead of `0`, `diff_stats` positivity and four negative controls | `tests/coding-agent-c14-eval-metrics-and-profiles.test.ts`, `tests/coding-agent-c14-metrics-aggregation.test.ts` |
| Profile resolution | Conformance matrix re-derived by the real resolver; `not_run` has no numeric field | `tests/coding-agent-c14-model-profile-flags.test.ts`, `tests/coding-agent-c14-model-profile-fallback.test.ts` |
| Red team | Catalogue guard in three places + 5 mutation controls + 7 new suites | `tests/coding-agent-c14-redteam-*`, `-gate-mutation-sensitivity`, `-attack-catalogue` |
| Full suite | `npm test` has a known-red baseline of **10 files / 15 tests**; the quarantine gate is GREEN only while every actual failure is documented and unexpired, and it runs the whole suite as CI's **only** test step | `package.json` (`test` = `vitest run`, `test:known-failures`), `scripts/check-known-failures.mjs:10-23`; `known-failures.json` = 15 entries / 10 files |
| CI workflow | Pins `npm ci`, security-gate, both typechecks, lint, both audits, the quarantine gate, build, `eval:smoke`, upgrade gate; no `continue-on-error` anywhere. **Superseded by G1 (see the note in §1):** the workflow is now `workflow_dispatch`-only, so it verifies all of that when a human runs it, and blocks nothing automatically | `tests/coding-agent-c14-ci-and-lint-gates.test.ts` (`:142-181` at C14; the trigger pins were replaced by the stronger G1 ones — exact trigger set, complete re-enable recipe, repo-wide no-automatic-trigger regression tests) |

---

## 10. Honest limits

These are the limits of the whole C14 step. None of them is a defect hidden behind a green number; each is
stated where it was measured.

1. **CI has never run on GitHub — and since G1 it is not even triggered.** The workflow is configured and its
   content is pinned by tests, and the same commands were run locally, but no GitHub Actions run has ever
   executed successfully here. "CI blocks regressions" was therefore always a *configured* claim, verified
   statically plus locally, not an observed one; and the owner has now **disabled every automatic trigger**
   (private repository, no paid Actions minutes, every job of the last automatic run failed in ~2 s without
   starting), so the claim is not merely unobserved — it is **not in force**. The workflow runs only when a human
   dispatches it, which means nothing blocks a merge or a release, and the mandatory security gate no longer
   runs on a push. That is an accepted risk with a named owner slot and an expiry, not a fix:
   `security-gate-report.md` §6 item 11 and §7.6, plus `current-state.md` (section "Current step").
2. **C4b Docker E2E has not been performed.** The egress allowlist and the container ceilings are not proven in
   a real container; this is why the policy gate refuses network commands until enforcement is guaranteed.
3. **There is no Docker in the test environment**, so sandbox ceilings are verified on the argument line and by
   provider validation, never by an OOM, disk-full or escape event.
4. **Migrations 070–085 have never been applied to a live PostgreSQL.** `085_mcp_tool_policies` exists
   (`packages/workspace/src/migration-085.ts`, applied at `postgres-store.ts:1220-1227`) but the migration path
   has not been exercised against a real database here.
5. **Browser E2E is deferred to G1 and has not been executed.**
6. **The cassette proves reproducibility, not quality.** A recorded run replays deterministically and a
   substitution control still diverges; nothing about the cassette says whether the recorded model output was
   *good*. `REPLAY_BUNDLE_FORMAT_VERSION` stays **3** (the persisted shape did not move), and bundles written
   before the `argumentsHash` fix are not retro-fitted — they stay readable evidence and stay unreplayable
   (`docs/coding-agent/c14-provider-cassette-and-arguments-hash.md:108`).
7. **Quality evals are `not_run`** (§5). This is the only part of C14's item 2 that cannot be closed without a
   live provider run; `requires: ["NPATI_CODE_EVAL_LIVE=1", "a liveModel port injected into the harness deps"]`.
8. **`npm test` is not green and is not claimed to be.** Its baseline is `10 files / 15 tests` failing, all
   quarantined in `known-failures.json` with an `expires_at`. C14 neither fixed nor hid them; the quarantine
   gate reports an undocumented failure, a stale entry, an expired entry or an untrustworthy manifest as RED.
9. **Production ready = NO.** `C7` is feature complete and `G1` is the security-ready gate; `R1`
   (production/rollout ready) is a separate stream, and rollout beyond `internal` requires both `G1` and `R1`
   (`PLAN.md:777`, `:811`, `:1026`). Nothing in this document is a production-readiness claim.
10. **C14 item 5 (SLO and limit tuning, budget/anomaly calibration from evals) is not covered here** — a
    parallel stream owns it, and this document does not touch `code-agent-config.ts` or
    `code-anomaly-detection.ts`.
11. **Two documentation divergences were found and are reported, not fixed**: (a) the `PolicyEngine` module
    header comment (`apps/agent-api/src/code-policy-engine.ts:40-43`) and the wiring-site comment
    (`apps/agent-api/src/app.ts:1464-1469`) both list an eight-phase order that omits `capability_groups`,
    `trust` and `network_enforcement`, all of which are evaluated by `evaluateInternal`; (b)
    `security-gate-report.md:37` and `:248-249` state 138 gate suites while the current fixed list is 144
    (§8.5). See `docs/coding-agent/architecture.md` §4.

---

## 11. How to reproduce

```
# corpus, metrics and profile conformance (the same file CI's evals job runs)
npm run eval:smoke

# per-profile conformance, metrics arithmetic, model-profile flags and fallback visibility
node --experimental-transform-types --no-warnings ./artifacts/c5b-policy-probe/run.mjs \
     tests/coding-agent-c6-eval.test.ts tests/coding-agent-c14-eval-metrics-and-profiles.test.ts \
     tests/coding-agent-c14-model-profile-flags.test.ts tests/coding-agent-c14-model-profile-fallback.test.ts

# capability catalogue, manifest parity and the runtime overlay counts (4/4)
npm run audit:capabilities

# published tool schemas vs the frozen snapshot (writes nothing)
npm run audit:code-tools

# the fixed security-gate suite list (144 lines) and the gate itself
node scripts/run-security-gate.mjs --list
npm run security-gate

# red-team catalogue validation, statically and against a vitest JSON report
node scripts/attack-catalogue-check.mjs

# the quarantine verdict (runs the whole suite; CI's only test step)
npm run test:known-failures
```

---

## 12. Number → source

| Number | Source |
| --- | --- |
| 33 tasks | `tests/fixtures/coding-agent-eval/tasks.json`; `tests/coding-agent-c6-eval.test.ts:419` |
| 7 task kinds / 4 languages + json | `tasks.json` metadata; `tests/coding-agent-c6-eval.test.ts:621-633`; `code-eval-harness.ts:103`, `:123` |
| 135 steps = 80 tool + 33 message + 22 check | counted from `tasks.json`; pinned at `tests/coding-agent-c6-eval.test.ts:516-519` |
| turns 49, tokens 3 357, diffStats 42/+80/−43, costUsd 0.019671 | `tests/coding-agent-c6-eval.test.ts:508-522` |
| 42 edit-class calls (22/18/1/1) | counted from `tasks.json` tool steps |
| 33/33 tasks green, 0 tool failures | `tests/coding-agent-c6-eval.test.ts:460-466`, `:490`; `code-eval-harness.ts:491-496` |
| 4 profiles, 3 scenarios, 4 subjects, 9 conformance rows | `code-eval-profile-report.ts:60-95`, `:204-245` |
| quality `not_run` + `requires` list | `code-eval-profile-report.ts:264-277` |
| profile fields: parallel 4/2/1, context 200k/64k/32k | `code-model-profiles.ts:112-141` |
| `maxParallelToolCalls` 1..8, context ≥ 1 024, fallback window 8 192 | `code-model-profiles.ts:74-79` |
| fallback reasons `profile_flag_disabled` / `no_matching_profile` | `code-model-profiles.ts:484-505` |
| no flag reader ⇒ nothing enabled; a throwing read ⇒ disabled | `code-model-profiles.ts:191-210` |
| 6 metric kinds | `code-metrics.ts:45-51` |
| `null` + reason instead of `0`; excluded denominators | `code-metrics.ts:196-197`, `:250-251`, `:287-288`, `:330-331` |
| 23 catalogue rows / 22 `covered` / 1 `measured-limitation` / 11 exemptions | `docs/coding-agent/attack-catalogue.json` (counted); `security-gate-report.md:23-26` |
| 12 hard-deny rules | `attack-catalogue.json` → `hardDenyRuleIds` + `hardDenyRuleExemptions`; `security-gate-report.md:25-26` |
| 5 mutation controls | `security-gate-report.md:171-204` |
| 7 new red-team suites / 34 tests / failed=0 | `security-gate-report.md:250` |
| 144 gate suites | `node scripts/run-security-gate.mjs --list` (144 lines, run in this session) |
| `passed=2001 failed=0`, 144 suites | C14 escalated sign-off run reported for this step (not re-run here) |
| 385 / 121 / 264 catalogue, manifest v9 / 37 tools / 37 code tools, overlay 3, combined 388 | `node scripts/verify-capability-matrix.mjs` (4/4, output quoted in `architecture.md` §6) |
| checksum `b498efdc…` | `apps/agent-api/src/code-tool-registry.ts:215`; `code-tool-schemas.published.json:3`; `tests/fixtures/code-tool-schema-snapshot.json:3` |
| 15 quarantined entries / 10 files | `known-failures.json`; `security-gate-report.md:231-232` |
| 4 RED quarantine conditions | `scripts/check-known-failures.mjs:10-23` |
| `REPLAY_BUNDLE_FORMAT_VERSION = 3` | `apps/agent-api/src/code-replay-bundle.ts:25`; asserted in `tests/coding-agent-c14-replay-cassette-engine.test.ts:734` |
| migration 085 | `packages/workspace/src/migration-085.ts:26`; `packages/workspace/src/postgres-store.ts:1220-1227` |
| MCP approval TTL 86 400 000 ms | `apps/agent-api/src/mcp-approval.ts:43` |
| sandbox ceiling flags and validation floors | `apps/agent-api/src/docker-sandbox-provider.ts:93-95`, `:127` |
| SecretLease TTL 120 000 ms default and max | `apps/agent-api/src/code-secret-lease.ts:113-114` |
| subagent depth 1 / parallelism 4 | `apps/agent-api/src/code-subagent-limits.ts:33`, `:36` |
| hook events 4 | `apps/agent-api/src/code-hooks.ts:52` |
| command precedence `system → user → project → session` | `apps/agent-api/src/code-commands.ts:31-63`; `tests/coding-agent-c13-slash-commands.test.ts:257-286` |
| protected branches `main`, `master`, `release` | `apps/agent-api/src/code-protected-branches.ts:54` |
| thresholds ≥ 95 %, 0 attacks, 0 escapes | `docs/coding-agent/PLAN.md:1001` |
| production ready = NO; G1/R1 gate rollout | `docs/coding-agent/PLAN.md:777`, `:811`, `:1026` |

---

## 13. Sign-off

* **Delivered by this step's documentation work:** `architecture.md`, `permission-modes.md`, `security.md`,
  `model-profiles.md`, `adding-a-model-and-a-tool.md`, this report.
* **Measured and pinned:** 33-task corpus with a fixed aggregate; per-profile conformance via the real
  resolver; 23-row attack catalogue with 5 mutation controls; six Activity metrics; the tool-schema and
  capability audits.
* **Not measured, and said so:** per-profile model quality, live Activity metric values, container-level
  containment, live-PostgreSQL migrations, browser E2E, and any GitHub Actions execution.
* **Rollout decision remains the owner's.** `G1` is security ready; going beyond `internal` requires `G1`
  **and** `R1`, and this report makes no claim beyond `G1`.
