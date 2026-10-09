# Coding Agent — adding a model profile and adding a tool (C14)

Two procedures, both written as ordered checklists. Every step names the file it touches, the command that
proves it, and the failure you get if you skip it. Nothing here is a suggestion: the registry, the manifest and
the CI guard are all designed to **fail loudly** when one of these steps is missed.

---

# Part A — adding a model

## A.0 What "adding a model" actually means

The harness never branches on a model name. "Supporting a model" therefore means one of:

1. it already matches an existing profile (nothing to do — check the conformance table first), or
2. it needs a **registry profile** (a code change to `DEFAULT_CODE_MODEL_PROFILES`), or
3. it needs an **operator override** (`overrides`, or an operator-supplied `profiles` registry — no code
   change, and the loop is untouched).

Adding a profile does **not** enable it. See A.4.

## A.1 Check whether an existing profile already covers it

Run the resolver against the model before writing anything:

```
node --experimental-transform-types --no-warnings ./artifacts/c5b-policy-probe/run.mjs \
     tests/coding-agent-c14-eval-metrics-and-profiles.test.ts tests/coding-agent-c14-model-profile-flags.test.ts
```

Look at `matchedBy` and `fallbackReason`. `matchedBy: "provider"` on a hosted model means
`hosted-native-tools` already claims it — and its `knownLimitations` already says the assumption is
unverified (`code-model-profiles.ts:120`). If a **pattern** profile matched a model it should not have
(`*small*`, `*mini*`, `*flash*`, `*haiku*`), that is the case for a new, more specific entry, not for widening
the pattern.

## A.2 Write the profile

Add a frozen profile to `DEFAULT_CODE_MODEL_PROFILES` (`apps/agent-api/src/code-model-profiles.ts:112-141`),
or return it from operator configuration as part of `profiles` / `overrides`.

| Field | Rule | Where enforced |
| --- | --- | --- |
| `id` | non-empty; **must be expressible as a flag** — `[a-z0-9._-]{1,64}` so `code.model_profile.<id>` matches `CODE_MODEL_PROFILE_PATTERN` | `validateCodeModelProfile` (`:252-254`); `feature-flags.ts:65`; a test asserts every key `codeModelProfileFlagKey` builds is accepted |
| `match.providers` | exact provider ids, lower-cased on comparison | `matchesExact` (`:357-360`) |
| `match.models` | **exact** model ids, case-insensitive; highest specificity (3) | `:369` |
| `match.patterns` | anchored case-insensitive globs, `*` = any run, `?` = one char; more specific than `providers` (2), less than `models` | `:336-351`, `:370` |
| `match` overall | at least one provider, model or pattern — **except** the conservative profile, which is allowed an empty match only via `allowEmptyMatch` | `:318-323`, `:414` |
| a bare `*` pattern | rejected: `invalid_profile_pattern` | `:309-313` |
| `toolCallingMode` | one of `native`, `text`, `auto` | `:255-260` |
| `maxParallelToolCalls` | integer **1..8** | `:261-272` |
| `contextWindow` | integer **≥ 1 024** | `:273-278` |
| `temperature` | optional, 0..2 | `:279-283` |
| `preferredEditTool` | optional non-empty tool name; set it **only** when you know the model handles that tool well (`:32-33`) | `:284-289` |
| `extraSystemPromptLines`, `knownLimitations` | arrays of non-empty strings; `knownLimitations` is where an assumption belongs ("native tool calling is assumed… verify per model") | `:324-329` |

Fail-closed defaults to preserve unless you have evidence: `toolCallingMode: "auto"` (native is used only when
the provider actually returned native calls, `:455-467`), `maxParallelToolCalls: 1`, and the smallest context
window you can defend.

## A.3 Choose the specificity you actually have

| You know | Use | Specificity |
| --- | --- | --- |
| The exact model id | `match.models: ["claude-3-5-sonnet-latest"]` | 3 |
| A family/naming convention | `match.patterns: ["*sonnet*"]` | 2 |
| Only the provider's behaviour | `match.providers: ["anthropic"]` | 1 |

A **tie** at the same specificity is not an error but it is reported:
`ambiguous_profile_match:<ids>:using:<winner>` (`code-model-profiles.ts:444-448`). Two profiles claiming the
same model at the same specificity should be fixed, not tolerated.

## A.4 Enable the flags — otherwise the profile is dead weight

Enabling is a **filter**, never an assignment: `enabledProfileIds` decides which registry profiles may be
*considered*, and the model must still match one (`code-model-profiles.ts:401-404`).

1. The key is `code.model_profile.<id>`; it must match `CODE_MODEL_PROFILE_PATTERN`
   (`feature-flags.ts:65`) and `CODE_FLAG_KEY_PATTERN` (`:71`).
2. Self-hosted installations enable coding flags and model profiles by default after installation.
   Hosted deployments retain dark-launch defaults. There, **until somebody enables `code.model_profile.<id>`, every model gets
   `conservative-default`** — `toolCallingMode: "auto"`, one tool call at a time, the registry's minimum
   context window, with `fallbackReason: "profile_flag_disabled"` recorded in Activity
   (`code-model-profiles.ts:181-189`, `:499-505`).
3. With no flag reader wired at all, **no** profile is enabled — that is not "all profiles"
   (`:196`). A flag read that throws counts as disabled (`:205-207`).

## A.5 Verify

| Check | Command / test | What it proves |
| --- | --- | --- |
| Conformance rows | `tests/coding-agent-c14-eval-metrics-and-profiles.test.ts` | The matrix is re-derived with the **real** `resolveModelProfile` and the real `modelProfileFallbackTrace`; the per-profile table is compared literally and the `quality` field has no numeric member (`code-eval-profile-report.ts:104-124`) |
| Fail-closed fallback | `tests/coding-agent-c14-model-profile-flags.test.ts`, `tests/coding-agent-c14-model-profile-fallback.test.ts` | Empty enabled list ⇒ conservative + `profile_flag_disabled`; enabled-but-unmatched ⇒ conservative + `no_matching_profile`; a matched model ⇒ `null` |
| C6 trace contract | `tests/coding-agent-c6-model-profiles.test.ts` | The four C6 trace keys are unchanged (the C14 additions are a second function, not new keys) |
| Visibility | `tests/coding-agent-c14-model-profile-fallback.test.ts` | The reason reaches the Activity payload, the snapshot's optional source and the Inspector's `modelProfiles` section |
| Whole gate | `npm run security-gate` | All of the above inside the fixed suite list |

Anything the conformance matrix measures is **conformance**. It is not a statement about the model's quality:
`quality` stays `not_run` until a live run exists (`code-eval-profile-report.ts:264-277`; see
`docs/coding-agent/model-profiles.md` §7).

---

# Part B — adding a `code.*` tool

The manifest is a **published contract**, not a working set: a published `name@version` is immutable, and
changing a schema without a version bump fails the build (`code-tool-registry.ts:11-17`,
`scripts/verify-code-tool-schemas.mjs:5-8`). Follow the order below; the ordering is what keeps the guard
meaningful.

## B.1 Author the schema — one source of truth

Edit `apps/agent-api/src/code-tool-schemas.json` (the authored array; `code-tool-registry.ts:2` imports this
exact file, and the plain-Node guards read the same file so there is no copy to drift,
`code-tool-registry.ts:46-51`).

The schema shape is `{ name, version, status, description, inputSchema, outputSchema }`
(`code-tool-registry.ts:20-28`). A **new** tool starts at `version: 1`, `status: "active"`. A **changed** tool
must publish `version + 1` — additive optional fields may stay on the same version, anything else may not.

Note that the schema carries no `risk` and no approval flag: those live in the capability declaration (B.2).
A file-mutating tool's schema must also declare `projectId` nowhere — the project travels in the invocation
envelope, never as a model argument (`packages/shared/src/code-capabilities.ts:28-33`).

## B.2 Declare the capability

Add a `CapabilityDefinition` to the right group in `packages/shared/src/code-capabilities.ts`
(`CODE_READ_CAPABILITIES` `:1177`, `CODE_WRITE_CAPABILITIES` `:1358`, plus the shell/deps/plan/git/subagent
groups). `packages/shared` cannot import from `apps/agent-api`, so this file **mirrors** the authoritative
schema; `tests/coding-agent-c2-schema-parity.test.ts` fails the build if the mirror drifts (same required
fields, same property names and types, same envelope, same versions) — the contract is stated at
`code-capabilities.ts:12-20`.

Fields that matter for policy:

| Field | What it decides |
| --- | --- |
| `id` | The tool id. Must be unique across the whole catalogue (`uniqueInventoryIds` is audited) |
| `risk` | `low` / `medium` / `high`. Shipped precedent: reads `low`, edits `medium`, `code.fs.delete` and `code.shell.exec` `high` |
| `requiresConfirmation` | `true` ⇒ the engine always requires a human approval, **regardless of the mode × risk matrix**. Today exactly six `code.*` capabilities set it: `code.fs.delete`, `code.deps.add`, `code.git.restore`, `code.git.push`, `code.git.pr.create`, `code.git.pr.comment` |
| `requiredPermissions` | `["workspace:read"]` or `["workspace:write"]`; `permissionForTool` maps the tool to one of the two (`code-policy-engine.ts:428-441`) |
| `agentCallable` | Whether it appears in the agent-callable count (121 of 385 today) |

Also add the matrix entry: the group's `CODE_*_MATRIX` is derived from the capability list
(`code-capabilities.ts:1333`, `:2271`), and `scripts/verify-capability-matrix.mjs` audits
catalogue = matrix = registry = one number.

## B.3 Map the sub-flag and the permission

`subFlagForTool` and `permissionForTool` (`code-policy-engine.ts:411-441`) are exhaustive-by-construction: a
tool that matches nothing falls into `code.write` / `workspace:write`. Decide deliberately:

| If the tool… | Then |
| --- | --- |
| is a read/search tool | Add it to `READ_TOOLS` (`:372-376`) so it follows `code.read` — **and** decide separately whether it belongs in `PLAN_SAFE_TOOLS` (it does not, unless it only touches session metadata) |
| runs a command in the sandbox | It automatically follows `code.shell` if its id starts with `code.shell.`; otherwise add it to `SHELL_TOOLS` (`:404`) |
| writes to a remote git repository | It follows `code.git` if its id starts with `code.git.`, or is in the git-write set (`:421`) |
| is a new family with its own blast radius | Add a sub-flag to `CODE_AGENT_SUB_FLAGS` **and** to `CODE_FLAG_KEY_PATTERN` in the same edit — a key the pattern does not match can never be enabled (`feature-flags.ts:37-38`, `:71`) |
| is a runtime MCP tool | It is already gated by `code.mcp` first (`:414`) and mapped to the **stricter** `workspace:write`, because a third-party server's naming claim is not a permission (`:434-441`) |

## B.4 Implement the executor

Add the tool body to `apps/agent-api/src/code-tool-executors.ts` in the matching canonical group
(`canonicalExecutors`, `canonicalWriteExecutors` `:347`, `canonicalShellExecutors` `:603`,
`canonicalDepsExecutors` `:760`, `canonicalPlanExecutors` `:861`, `canonicalGitExecutors`), and make sure
`allCanonicalExecutors` (`:919-925`) merges it. There are deliberately no second implementations of a tool
body (`code-tool-runtime.ts:38-39`).

**A tool with no configured executor fails closed** with `tool_not_configured`
(`code-tool-runtime.ts:388-391`) — it does not silently do nothing.

## B.5 Bump the manifest and regenerate the artifact — with the generator

1. Bump `CODE_TOOL_MANIFEST_VERSION` (`apps/agent-api/src/code-tool-registry.ts:198`) when the published set or
   its content changes (`:15-17`).
2. Regenerate the published artifact **and** the frozen snapshot with the generator:

   ```
   node scripts/code-tool-schemas-generate.mjs --manifest-version <N>
   ```

   It writes `apps/agent-api/src/code-tool-schemas.published.json` (the artifact the CI guard verifies) and
   `tests/fixtures/code-tool-schema-snapshot.json` (the frozen contract), and prints the value for
   `PUBLISHED_TOOL_SCHEMA_CHECKSUM` (`scripts/code-tool-schemas-generate.mjs:11-20`).
3. Paste the printed checksum into `PUBLISHED_TOOL_SCHEMA_CHECKSUM` (`code-tool-registry.ts:215`). It is a
   literal on purpose: a schema edit without a version bump then shows up in review. The registry's
   `assertManifestConsistent` refuses a mismatch with
   `"Published tool schemas changed without bumping CODE_TOOL_MANIFEST_VERSION/PUBLISHED_TOOL_SCHEMA_CHECKSUM"`
   (`:311-344`).

Never hand-edit the published artifact: it is self-verifying (every per-tool checksum is recomputed from its
canonical schema and the aggregate checksum from all `key:canonical` pairs, so a hand-edited file fails,
`scripts/verify-code-tool-schemas.mjs:125-141`).

## B.6 Verify the manifest

```
npm run audit:code-tools        # = node scripts/verify-code-tool-schemas.mjs --check
```

`--check` writes nothing and exits non-zero when the artifacts are stale. It enforces
(`scripts/verify-code-tool-schemas.mjs:5-8`, `:81-106`):

* a changed canonical schema for an existing `name@version` ⇒ "schema changed without a version bump";
* a removed or added `name@version` ⇒ "bump `CODE_TOOL_MANIFEST_VERSION` and regenerate";
* a manifest-version or aggregate-checksum mismatch.

A removal is never the fix: mark the tool `deprecated` instead — a published version must stay resolvable, and
the engine already refuses a deprecated tool with `tool_deprecated` (`code-policy-engine.ts:576`).

## B.7 Activity, idempotency, read-before-write

| Property | Requirement | Source |
| --- | --- | --- |
| Activity event | Emit `code_tool_activity` / `run_activity` with a **metadata-only** payload. Content keys and secrets are **rejected**, not scrubbed | `code-run-activity-sink.ts:37-86`; `assertMetadataOnly` in `coding-agent-runner.ts:1379` |
| Snapshot | An event written during a run must name its `snapshotId`, or the "no snapshot" fact is recorded honestly | `code-policy-engine.ts:76-81` |
| Idempotency | The same `(session, toolCallId)` must never execute twice; the window defaults to the read-tracker TTL and is overridable via `idempotencyTtlMs` | `code-tool-runtime.ts:963-1000`, `:398-399`, `:710-724` |
| Read-before-write | A mutating tool must respect `read_before_write_required` | `code-tool-runtime.ts:73`, `:158` |
| Revision | A write is authorised against a canonical revision and must refuse once it moved (`revision_conflict`) | `code-workspace-revision.ts`, `code-tool-runtime.ts:458` |
| Checkpoint | Writes are checkpointed per turn so `code.fs.undo_last_turn` works | `code-workspace-checkpoint.ts` (`CodeTurnTracker`) |
| Diff policy | A sensitive-path change may require approval depending on the mode | `code-diff-guard.ts:117-170` |
| Test integrity | A change to a test file is analysed for weakened/deleted/focused tests | `code-test-integrity-guard.ts:164` |
| Untrusted envelope | Every result is wrapped `trust: "untrusted_data"` with a closed key vocabulary | `packages/shared/src/code-capabilities.ts:34-50` |

## B.8 Tests, and registration in the gate

1. Unit/integration tests for the executor in `tests/`, following the existing `coding-agent-c*-*.test.ts`
   naming.
2. Register every new suite in `SECURITY_GATE_TESTS`
   (`scripts/run-security-gate.mjs:25`). The list is a **fixed contract**: several suites assert the list is
   duplicate-free, that it contains named C14 suites, and that every listed file exists on disk
   (`tests/coding-agent-c14-ci-and-lint-gates.test.ts:207-210`,
   `tests/coding-agent-c5b-policy-rbac.test.ts:275-279`). A new suite that is not registered is not in the
   gate, and the gate reports a missing/unrun suite as a failure rather than passing quietly
   (`scripts/run-security-gate.mjs:912-914`, `:972-976`).
3. If the tool is a new **attack surface**, add a catalogue row (`docs/coding-agent/attack-catalogue.json`)
   with a real `suite`, an exact `title`, and a `negativeControl` ≥ 40 characters — a row that does not
   resolve makes the gate red (`docs/coding-agent/security-gate-report.md:46-63`).
4. Run: `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `npm run audit:capabilities`,
   `npm run audit:code-tools`, `npm run security-gate`.

## B.9 Pre-flight checklist

* [ ] Schema added/changed in `code-tool-schemas.json`; version bumped if anything but an optional field changed.
* [ ] Capability declared in `code-capabilities.ts` with `risk`, `requiresConfirmation` and `requiredPermissions`.
* [ ] Mirror parity holds (`tests/coding-agent-c2-schema-parity.test.ts`).
* [ ] Sub-flag and permission mapping decided (`subFlagForTool` / `permissionForTool`), new flag added to both
      `CODE_AGENT_SUB_FLAGS` and `CODE_FLAG_KEY_PATTERN` if it is a new family.
* [ ] Executor implemented and merged into `allCanonicalExecutors`.
* [ ] `CODE_TOOL_MANIFEST_VERSION` bumped; artifact and snapshot regenerated **by the generator**;
      `PUBLISHED_TOOL_SCHEMA_CHECKSUM` pasted from its output.
* [ ] `npm run audit:code-tools` exits 0.
* [ ] Activity event is metadata-only; idempotency and read-before-write respected.
* [ ] Tests written and registered in `SECURITY_GATE_TESTS`; catalogue row added if the tool is a new surface.
