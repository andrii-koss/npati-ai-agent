# Coding Agent — architecture and component boundaries (C14)

This document is the steady-state map of the Coding Agent: which component owns which decision, where the
trust boundaries run, and how to find the code that enforces each claim. It is **navigation, not history**:
the historical record lives in the documents below, and this file deliberately does not repeat them.

| Document | What it is for |
| --- | --- |
| `docs/coding-agent/00-audit.md` | C0 audit: documentation inventory, first-hand platform facts, threat model T1–T14, what must be created from scratch |
| `docs/coding-agent/PLAN.md` | The step plan C0–C15 with acceptance criteria, readiness levels (`C7` feature complete, `G1` security ready, `R1` production ready) and the C14 requirement text (`PLAN.md:989-1004`) |
| `docs/coding-agent/current-state.md` | Per-step journal: what each step implemented, its escalated evidence, its open risks |
| `docs/coding-agent/security-gate-report.md` | G1/C14 red-team report: attack catalogue, mutation sensitivity, honest limits, manual checklist |
| `docs/coding-agent/c14-eval-corpus-and-profiles.md` | C14 eval corpus and the per-profile comparative report (measured conformance, `not_run` quality) |
| `docs/coding-agent/c14-provider-cassette-and-arguments-hash.md` | C14 provider cassette and the `argumentsHash` blocker it exposed |
| `docs/coding-agent/c14-final-report.md` | The C14 comparative report: per-profile table, corpus measurements, the three headline numbers, honest limits |
| `docs/coding-agent/permission-modes.md` | Modes, mode × risk matrix, approval scopes, what is never automated |
| `docs/coding-agent/security.md` | Threat model and the defences that answer it |
| `docs/coding-agent/model-profiles.md` | Model profile registry, resolution order, flags, fallback visibility |
| `docs/coding-agent/adding-a-model-and-a-tool.md` | Step-by-step: add a model profile, add a `code.*` tool |
| `docs/ARCHITECTURE.md` | **Product-level** architecture of the platform as a whole. It is not the Coding Agent's document and this file does not replace it. |

Everything in this repository's code and comments is English; the C0/PLAN/current-state documents are
English, and so is this one.

---

## 1. Component map

| Component | Owns | Code |
| --- | --- | --- |
| **Run intake and queue** | Admission, concurrency caps, per-run budget, durable run state and resume refusal | `apps/agent-api/src/code-run-queue.ts`, `code-run-state.ts`, `code-run-quota.ts`, `code-run-reconciler.ts`, `code-run-cancellation.ts` |
| **Agent loop (runner)** | The turn loop: resolve profile → build descriptors → pin snapshot → call the model → consult policy → execute → record | `apps/agent-api/src/coding-agent-runner.ts` (`CodingAgentRunner.run`, `coding-agent-runner.ts:1621`, `:1814`) |
| **Policy** | The single decision point for every privileged action | `apps/agent-api/src/code-policy-engine.ts` (`PolicyEngine`) |
| **Capability registry** | Which tools exist, at which version, with which risk and approval declaration | `apps/agent-api/src/code-tool-registry.ts`, `packages/shared/src/code-capabilities.ts`, `code-capability-groups.ts` |
| **Tool execution** | Argument validation, idempotency, read-before-write, dispatch to an executor | `apps/agent-api/src/code-tool-runtime.ts`, `code-tool-executors.ts`, `code-tools-fs.ts`, `code-tools-patch.ts`, `code-tools-write.ts`, `code-tool-git-executors.ts` |
| **Sandbox** | Where generated code actually runs, and how it is contained | `apps/agent-api/src/docker-sandbox-provider.ts`, `code-shell-runtime.ts`, `code-shell-classifier.ts`, `sandbox-egress-enforcement.ts`, `egress-allowlist.ts`, `sandbox-egress-proxy.mjs` |
| **Workspace and git** | Revision checks, turn checkpoints, diff policy, test-integrity guard, git/PR writes | `code-workspace-revision.ts`, `code-workspace-checkpoint.ts`, `code-diff-guard.ts`, `code-test-integrity-guard.ts`, `code-git-workflow.ts`, `code-protected-branches.ts`, `project-git-service.ts` |
| **Verification and review** | The verify/repair loop, self-review, PR description | `code-verification-loop.ts`, `code-self-review.ts`, `code-pr-description.ts` |
| **Snapshot and replay** | The pinned per-run fact set and the deterministic re-execution of a recorded run | `execution-snapshot.ts`, `code-replay-bundle.ts`, `code-replay-engine.ts`, `code-replay-cassette.ts`, `code-replay-cassette-store.ts` |
| **Activity** | The run's observable event stream (metadata only) | `code-run-activity-sink.ts` |
| **AuditLog** | The tamper-evident journal of privileged decisions | `apps/agent-api/src/audit-log.ts` (`AuditLogService`) |
| **Metrics** | Six aggregates over Activity | `apps/agent-api/src/code-metrics.ts` (`collectCodeMetrics`, `code-metrics.ts:188`) |
| **Evals** | The hermetic corpus and the per-profile comparative report | `code-eval-harness.ts`, `code-eval-profile-report.ts` |
| **Model profiles** | How a model is driven: tool-calling mode, parallelism, context window | `code-model-profiles.ts` |
| **Extension surfaces** | Hooks, slash commands, skills, MCP | `code-hooks.ts`, `code-command-registry.ts` + `code-commands.ts`, `code-skills-instructions.ts`, `mcp-runtime-capabilities.ts` + `mcp-run-path.ts` + `mcp-approval.ts` |
| **Subagents** | Child runs, their tool scope, depth and parallelism ceilings | `code-subagent-limits.ts`, `code-subagent-types.ts`, `code-subagent-child-runner.ts`, `code-subagent-handoff.ts`, `code-agent-spawn-executor.ts` |

---

## 2. The run lifecycle, in order

The order below is the security property, not a preference: every step that can refuse a call runs **before**
any step that can approve one.

1. **Admission** — the run enters `CodeRunQueue` under per-user / per-company concurrency caps
   (`code-run-queue.ts:47-50`: 16 per user, 64 per company, depth 5 000, timeout 15 min) and the shared
   session budget (`code-run-quota.ts:41-42`: 10 000 000 tokens, 1 000 USD).
2. **Run state** — the durable record; `refuseResume` answers whether an interrupted run may be resumed
   rather than guessing (`code-run-state.ts:156`).
3. **Model profile resolution** — `resolveModelProfile` against the registry filtered by the
   `code.model_profile.<id>` flags; the fallback reason is captured for Activity
   (`coding-agent-runner.ts:3318-3355`).
4. **Start-up refusals** — flags, RBAC, tenant resolution. Discovery, not authorization, is the exception:
   MCP discovery runs once per run *after* the refusals and *before* the model-visible tool list
   (`current-state.md:169-183`).
5. **Tool descriptors** — the model-visible tool list is built from the resolved capabilities. A child run
   has `code.agent.spawn` **physically removed** from this list, not merely refused later
   (`current-state.md:227-232`).
6. **ExecutionSnapshot** — the pinned facts of the run (tool manifest version, limits, policy hashes, the
   runtime MCP manifest hash when present). Optional sources keep the payload's previous key set
   (`execution-snapshot.ts:132`, `:216`).
7. **Model call** — one turn. 8. **Policy** — `PolicyEngine.evaluate` decides the call.
9. **Approval** — if the verdict is `require_approval`, exactly one durable record is created; the run pauses
   through `waiting_for_user` and resumes the **same** run id after the decision.
10. **Hooks** — `PreToolUse` fires **after** an approval-allow and immediately before the executor
    (ordering pinned as `["approval","hook","executor"]`, `current-state.md:113-118`).
11. **Executor** — sandbox or workspace operation through the tool runtime, with idempotency on
    `(session, toolCallId)` (`code-tool-runtime.ts:963-1000`).
12. **Activity** — metadata-only events; `PostToolUse`; the turn checkpoint.
13. **Replay bundle** — the recorded run is serialised so it can be re-executed deterministically
    (`REPLAY_BUNDLE_FORMAT_VERSION = 3`, `code-replay-bundle.ts:25`).

---

## 3. Where the trust boundaries run

| # | Boundary | What may not cross it | Enforcement |
| --- | --- | --- | --- |
| B1 | **Tenant** | A run, tool call, project, session or sandbox of one company/user/project/session reaching another's | Tenant is resolved before tool logic; `projectId` is never a model argument (it travels in the invocation envelope, `packages/shared/src/code-capabilities.ts:28-33`) |
| B2 | **Content vs instruction** | Repository files, tool output, hook context, web pages, MCP responses, command output changing policy, mode, permissions or approvals | The `untrusted_data` envelope (closed key vocabulary, `canChangePolicy/canGrantTools/canChangeMode/canChangeApproval` literally `false`), the trust phase (`code-policy-engine.ts:595-610`), `repositoryContentCanChangePolicy(): false` (`code-prompt-injection-guard.ts:139`) |
| B3 | **Model vs policy** | A model argument deciding a risk class, a mode, an approval or a git target | The classifier owns the risk class; `readOnlyIntent`, `git` intent and `runtimeMcp` identity are server-side fields the caller builds (`code-policy-engine.ts:139-192`) |
| B4 | **Sandbox** | Generated code reaching the host, the docker socket, another project's sandbox, or the network outside the allowlist | `docker-sandbox-provider.ts` (`--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, tmpfs workspace, per-run internal network; `:93-95`), `egress-allowlist.ts`, `sandbox-egress-proxy.mjs` |
| B5 | **Secrets** | A secret being inherited by a later tool call, a background process or a log/event | `code-secret-lease.ts` (one-call leases, TTL 120 000 ms default and max, `:113-114`; audit **before** the lease exists), `code-secret-scanner.ts` |
| B6 | **Egress** | An outbound request reaching a private, loopback, reserved or metadata address, or a host outside the phase allowlist | Shared SSRF policy and client (`ssrf-policy.ts`, `ssrf-safe-http.ts`), re-validated on every redirect and every delivery |
| B7 | **Observability vs accountability** | An observability event being treated as the security record, or a hook being confused with an administrative decision | Activity is metadata-only and non-authoritative; AuditLog is authoritative and fail-closed (see §5) |

The threat model that these boundaries answer is `docs/coding-agent/00-audit.md:293-353` (T1–T14), and the
per-class evidence is `docs/coding-agent/security-gate-report.md` plus `attack-catalogue.json`.

---

## 4. Policy is one decision point

`PolicyEngine` is described in its own header as "the single decision point for every privileged Coding Agent
action", deliberately self-contained via structural ports "so that a path without an engine can only fail
closed" (`code-policy-engine.ts:33-43`).

Outcome vocabulary: `PolicyDecision = "allow" | "deny" | "require_approval"` (`code-policy-engine.ts:45`) and
`PolicyRisk = "safe" | "controlled" | "approval" | "hard_deny"` (`:58`).

Phase vocabulary (`PolicyPhase`, `code-policy-engine.ts:55-57`):

```
feature_flag | rbac | capability | capability_groups | hard_deny | network_enforcement
| session_mode | trust | project_rules | risk_classification | approval
```

The order the code actually evaluates them in is:
`feature_flag` → `rbac` → `capability` → `capability_groups` → `trust` → read-only intent (`hard_deny`) →
`hard_deny` (paths, `.git`, protected branches, migration safety, classifier) → `session_mode` →
`project_rules` → `network_enforcement` → dependency override → migration approval →
`risk_classification` + `approval`. See `docs/coding-agent/permission-modes.md` for the matrix and for what
each phase can refuse.

> **Documented divergence (code comment vs code).** The module header comment
> (`code-policy-engine.ts:40-43`) lists an eight-phase order —
> `1 feature_flag -> 2 rbac -> 3 capability -> 4 hard_deny -> 5 session_mode -> 6 project_rules -> 7
> risk_classification -> 8 approval` — which omits `capability_groups`, `trust` and `network_enforcement`,
> all three of which are members of `PolicyPhase` and are evaluated in `evaluateInternal`. The same stale
> list appears a second time at the wiring site (`app.ts:1464-1469`). The code is the source of truth. These
> are documentation defects in source comments, reported here rather than silently "fixed" (C14
> documentation scope forbids code edits).

---

## 5. Activity and AuditLog are different things, on purpose

| | Activity | AuditLog |
| --- | --- | --- |
| Purpose | Observability: what a run did, so it can be streamed, inspected and aggregated | Accountability: which privileged decision was taken, by whom, provably |
| Storage | `run_activity` / `code_tool_activity` events with a metadata-only payload | Append-only, hash-chained journal with a daily anchor (`audit-log.ts:81`: verify every 21 600 000 ms, anchor every 3 600 000 ms, retention 365 days, `blockOnBreak: true`) |
| Content rules | Content fields and secrets are **rejected**, not redacted (`code-run-activity-sink.ts:37-86`) | Only ids, decisions, hashes and redacted metadata; prompt/content-like keys are replaced by `[REDACTED]` (`audit-log.ts:34`, `:40-54`) |
| Failure behaviour | A failed recorder **must not** change a decision: the engine logs and returns the verdict unchanged (`code-policy-engine.ts:527-537`) | A failed write **refuses** the action: `record` throws `AuditUnavailableError` and the caller must fail closed (`audit-log.ts:11-15`, `:72-75`) |
| Structural separation | `code-hooks.ts` has **no** audit port at all, so a hook invocation cannot be confused with an administrative decision (`current-state.md:130-132`) | Trust, RBAC, session mode, protected branches, egress allowlist, SecretLease and MCP risk overrides all write here **before** applying (`code-project-trust.ts:60-75`, `code-rbac.ts:536`, `code-session-mode-routes.ts:120`, `code-protected-branches.ts:823`, `egress-allowlist.ts:328`, `code-secret-lease.ts:293-335`, `mcp-risk-override.ts:158`) |

The same "one journal" rule holds for the MCP risk path: there is no second journal and no second
authorization (`app.ts:6200`).

---

## 6. Capability registry and the tool manifest

Two different sets, deliberately not merged:

* **Capability catalogue** — the platform-wide inventory. Measured state:

  ```
  node scripts/verify-capability-matrix.mjs
  ✓ [1/4] static catalog exact integrity: OK (catalogTotal=385, matrixTotal=385, registryTotal=385,
    agentCallable=121, runtimeOnly=264, uniqueInventoryIds=385, uniqueTestSuites=162, registryValidationErrors=0)
  ✓ [2/4] static manifest/schema parity: OK (manifestVersion=9, manifestTools=37, catalogCodeTools=37)
  ✓ [3/4] runtime overlay integrity: OK (... staticTotalWithProbeOverlay=385, combinedTotalWithProbeOverlay=388)
  ✓ [4/4] combined Capability Inspector view: OK (...)
  ```

  So: 385 catalog entries, of which **37** are Coding Agent `code.*` tools (`code-capabilities.ts` declares
  exactly 37 ids, and the manifest declares the same 37).

* **Tool schema manifest** — `CODE_TOOL_MANIFEST_VERSION = 9`, checksum
  `b498efdc44e06ea1fd8b75860947a770e74f8b9a63dcd92026068a98de963d20`
  (`code-tool-registry.ts:198`, `:215`; the published artifact carries the same checksum,
  `code-tool-schemas.published.json:3`). A published `name@version` is immutable: a changed canonical schema
  without a version bump fails the build (`scripts/verify-code-tool-schemas.mjs:5-8`, `:93-94`), and the
  registry's own `assertManifestConsistent` refuses drift (`code-tool-registry.ts:311-344`).

* **Runtime MCP overlay** — dynamic tools discovered per run, kept in a separate
  `RuntimeProviderCapabilityOverlay` (`connectionId, toolName, schemaHash, risk, approvalRequired,
  discoveredAt, connectionScope, riskSource`). The lookup order is one function,
  `static → runtime → unknown ⇒ deny`. Static counts never include the overlay: static 385 stays 385 with a
  probe overlay, and the combined Inspector view is 388 (`current-state.md:184-186`).

---

## 7. Evals and metrics

* **Corpus** — 33 hermetic tasks, 7 task kinds, 4 programming languages plus JSON configuration, run through
  the real tool path with three named **simulators** (`npm test`, `npm run build`, `npm run deps:check`) that
  never execute the fixture's language. Aggregate is pinned by assertion; see
  `docs/coding-agent/c14-eval-corpus-and-profiles.md` and `docs/coding-agent/c14-final-report.md`.
* **Metrics** — exactly six, from Activity (`code-metrics.ts:45-51`): `success_rate`, `avg_turns`,
  `failed_edit_rate`, `approvals_share`, `tool_error_rate`, `cost_per_run`. A metric that cannot be measured
  is reported with a reason instead of a `0`: a denominator that excludes runs with no recorded price is the
  defect the module exists to avoid (`code-metrics.ts:330-331`), and a read failure is carried as its own
  flag rather than being confused with "the read returned nothing" (`:196-197`).

---

## 8. Extension surfaces and their one-mechanism rule

| Surface | Gate order | Key property |
| --- | --- | --- |
| **Hooks** (`code-hooks.ts`) | `flag → isTrusted → readConfig → parse → execute` | Four events only (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`), `code-hooks.ts:52`); an untrusted repository's hook config is **not read at all** — proven by a read-config spy at 0 and an access counter at 0 (`current-state.md:124-126`); the result vocabulary is closed (`code-hooks.ts:77`, `:84`) and `PolicyRequest` carries no hook field |
| **Slash commands** (`code-command-registry.ts`, `code-commands.ts`) | `code.commands` flag → project trust → read/parse → offer | Precedence `system → user → project → session` is a **rank**, so a higher rank wins a collision and two runs over the same inputs give the same winner byte-for-byte (`code-commands.ts:31-63`; test `tests/coding-agent-c13-slash-commands.test.ts:257-282`); expansion carries `canChangePolicy: false` / `canGrantTools: false` literally (`code-commands.ts:558-560`), and arguments are appended as an `ARGUMENTS (untrusted_user_data)` block, never interpolated |
| **Skills** (`code-skills-instructions.ts`) | metadata first; body only on demand | `listMetadata()` never reads a body; the loaded body renders into a typed `SKILL INSTRUCTIONS` section that survives C8 compression, and `skillId/version/hash/source` go to the snapshot without the body (`current-state.md:145-152`) |
| **MCP** (`mcp-runtime-capabilities.ts`, `mcp-run-path.ts`, `mcp-approval.ts`) | `code.mcp` flag → discovery on the run path → risk assignment → overlay → descriptors → snapshot → model call | Risk is **assigned**, never read from server metadata: default `high` + `approvalRequired=true`; only the owner/admin flow may lower it, journal-first (`mcp-risk-override.ts:13-24`, `:139-140`); the approval payload is built by one builder on both sides with **no raw arguments** (`mcp-approval.ts:91-126`, TTL `86_400_000` at `:43`) |
| **Subagents** (`code-subagent-*.ts`) | depth/scope refusal sits **before** sub-flag, arguments, approval and executor (position 3c) | Depth 1 and parallelism 4 are hard ceilings a configuration may only lower (`code-subagent-limits.ts:33`, `:36`); the child's tool set is `parentEffective ∩ childTypeProfile ∩ delegationRecord`, resolved from the server-side spawn record only; the five typed subagents (`explore`, `plan`, `implement`, `review`, `test`) each name a **model profile id**, never a literal model (`code-subagent-types.ts:103-161`) |

---

## 9. Evidence map

| Claim | Pinned by |
| --- | --- |
| Catalogue is 385 (121 callable / 264 runtime-only), manifest is v9 with 37 tools | `npm run audit:capabilities`; `tests/coding-agent-c9-plan-tool.test.ts:130`, `tests/coding-agent-c12-subagent-workflow.test.ts:173`, `tests/coding-agent-c11-git-workflow.test.ts:777` |
| A schema change without a version bump fails | `scripts/verify-code-tool-schemas.mjs --check` (`npm run audit:code-tools`), `tests/coding-agent-c1a-tool-schema-artifact.test.ts`, `tests/coding-agent-c2-schema-parity.test.ts:310` |
| The policy engine's order and refusals | `tests/coding-agent-c5b-policy-rbac.test.ts`, `tests/coding-agent-c5a-rbac-foundation.test.ts`, `tests/coding-agent-c4a-security-gate.test.ts` |
| Hooks fire after approval-allow and never on a denied path | `tests/coding-agent-c13-*` (ordering test `["approval","hook","executor"]`, `current-state.md:113-118`) |
| Subagent depth 1 is structural | `tests/coding-agent-c12-subagent-workflow.test.ts` |
| Evals: 33 tasks, pinned aggregate | `tests/coding-agent-c6-eval.test.ts:419`, `:508-522` |
| Six metrics, `null` + reason rather than `0` | `tests/coding-agent-c14-*` metrics suites; `code-metrics.ts:196-197`, `:330-331` |
| Attack catalogue is not prose | `scripts/attack-catalogue-check.mjs`, `tests/coding-agent-c14-attack-catalogue.test.ts`, `docs/coding-agent/security-gate-report.md:46-93` |
| Quarantine is not a blanket exemption | `scripts/check-known-failures.mjs:10-20`, `known-failures.json` (15 entries / 10 files) |

---

## 10. Known limits

The honest limits of the whole step — CI never executed on GitHub, no Docker in the test environment, C4b
container E2E not performed, migrations 070–085 never applied to a live PostgreSQL, browser E2E deferred to
`G1`, cassette proving reproducibility rather than model quality, `REPLAY_BUNDLE_FORMAT_VERSION = 3`, quality
evals `not_run`, `npm test` at a quarantined 10 files / 15 tests baseline — are listed once, with their
evidence, in `docs/coding-agent/c14-final-report.md`.
