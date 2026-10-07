# NPATI Coding Agent — Current State

Update this file after every completed step.

## Current step
- **C12 COMPLETE — subagents and parallel work.** Final escalated evidence: `npm run typecheck` exit 0, both
  workspace builds exit 0, **`npm run security-gate` exit 0 — `passed=1707 failed=0`, 116 suites,
  `present=116 missing=0`**, **`npm run test:web` exit 0 — 8 files / 71 tests / 0 failed**, and the tool-schema
  artifact regenerated to **manifest v9 with 37 tools**, checksum `b498efdc…` — computed independently by the
  executor with the guard's own hasher and confirmed by the generator (the two agreed exactly, as they did in C7
  and C11).
  - **Two real capability-escalation holes in the pre-existing subagent path were closed**, and both were of the
    "the mechanism exists and its result is discarded" kind: the child node was given
    `allowedTools: params.requestedTools ?? ["*"]`, i.e. it **threw away** the intersection
    `SubagentToolPolicyGuard` had just computed and kept exactly what was **requested**; and
    `parentSet.has("*") || parentSet.has("all")` was treated as "everything allowed" (fail-open). Now the child
    gets `parentEffective ∩ childTypeProfile ∩ delegationRecord`, a wildcard expands **only** into the published
    canonical registry (with no registry it grants **nothing**: `PARENT_WILDCARD_SCOPE_UNRESOLVED`), and the
    allowlist comes **only** from the server-side spawn record — never from a model argument, the same discipline
    as `readOnlyIntent`. A test pins that a **new** tool added to the general set does **not** become available to
    a child.
  - **Depth 1 is structural, not a check.** One `capabilityScope` is derived from the server fact
    `input.subagentScope.parentRunId`; `toolDescriptors` **physically removes** `code.agent.spawn` for a child;
    and `code-tool-runtime` refuses `subagent_depth_exceeded` / `subagent_tool_scope_denied` in position (3c) —
    before sub-flag, arguments, approval and executor, so approval cannot lift it. Configuration can only
    **lower** (`subagentDepth: 0` removes the tool even for a root run). A child run without a recorded scope is
    refused fail-closed rather than inheriting the parent's set.
  - **Parallelism 4 is a hard ceiling** (the `code-run-queue` idiom): the config can lower it, never raise it, and
    the previously dead `subagentDepth`/`subagentParallelism` are now genuinely read — the three divergent
    limits (`NestedSubagentManager.maxDepth` 4, `maxChildrenPerAgent` 5, `A2AQuotaManager.maxRecursionDepth` 5)
    were brought to the same canonical numbers.
  - **One `ProjectFileLeaseManager`.** `project-orchestrator` passed `undefined`, so the graph and the Company
    tools held **separate** lock managers and could not see each other's leases. Proven from both sides: with one
    manager the graph's lease on a file makes a Company write return `file_locked` and the content is untouched,
    and a **negative control** with two managers shows the write succeeding and the file overwritten.
  - **Shared token budget for parent and children** implemented over the **existing** `A2AQuotaManager`
    (`CodeRunSharedQuota`, one `sessionBudget` keyed by session, `currentDepth` from `subagentRunDepth`).
    Verified on the real runner: the parent stops with `budget_exhausted`, and a child run is refused on its
    **first** pre-flight, so it cannot spend budget the session does not have.
  - **`code.agent.spawn`** (inventory id **385**, risk medium, flag `code.subagents`) with five typed subagents —
    `explore`, `plan`, `implement`, `review`, `test` — each mapped to a model **profile id** (never a literal
    model name), a turn limit and a capability profile; `explore` uses the small-context profile and, per the
    owner's requirement 6, returns **only a handoff digest**: `detail` must be single-line and short or it is
    **dropped** (counted in `dropped`, not truncated), paths go through the canonical validator, and the digest
    passes the metadata-only and secret scanners — a secret **refuses** the handoff instead of being redacted.
    Proven byte-for-byte: the child's prose and a file body never appear in `JSON.stringify(result)`.
  - **Nested Activity with a real tree**: migration **084** adds `parent_run_id` / `parent_tool_call_id` /
    `parent_event_id` (nullable, additive, no FK) plus a **partial index** on `parent_run_id`; the parent fields
    live in the event **identity**, not in the metadata-only payload. The "parent in payload" shortcut was
    deliberately rejected (unindexable, and a reference is not a payload key). An end-to-end test finds the event
    the spawn executor actually writes via a tree query, and `listCodeActivityEvents({parentRunId})` returns
    exactly one level.
  - **Parallel implement tasks reuse the existing machinery, with no second orchestrator/planner/isolation**:
    `parseProjectTaskPlan` + `selectProjectTaskAgent` for decomposition and executor choice (by
    role/description/instructions/tools/model — never `agent.name`), `executeProjectTaskGraph` for the DAG with
    leases and cancellation, `ProjectGitService` worktrees for isolation (`cleanupAllWorktrees` in `finally`),
    the existing structured conflict escalation (`suggestedTool: "code.ask_user"`) and `verifyAfterMerge` over
    the **same** `CodeVerifyRunnerPort` as `code.verify.run` for mandatory post-merge verification.
    **A real defect was found and fixed**: `agentSlug = task.role || task.id` gave two parallel tasks of the same
    role **one** worktree and one branch, so two merges were really one — now `role-taskId`.
  - **A failing subagent cannot hang the run**: a throwing/failing child yields a **successful** tool call with
    `status:"failed"` and the child's code, and the graph settles (verified with a `Promise.race` timeout);
    `onStatus` was isolated in try/catch after a store failure was found to reject the task promise and take down
    the whole graph.
- Earlier: **C11 COMPLETE — Git workflow and Pull Request.** Final escalated evidence: `npm run typecheck` exit 0, both
  workspace builds exit 0, **`npm run security-gate` exit 0 — `passed=1627 failed=0`, 111 suites,
  `present=111 missing=0`**, **`npm run test:web` exit 0 — 8 files / 71 tests / 0 failed**, and the tool-schema
  artifact regenerated to **manifest v8 with 36 tools**, checksum `921d6029…` (derived independently by the
  executor with the guard's own hasher and confirmed by the generator — the two agreed exactly).
  - **Git transport per the owner's decision**: `ProjectGitService` stays on the host and there is **no second
    sandbox git**. The Coding Agent calls only structured `code.git.*` tools; the model **never** passes a git
    command string, and no arbitrary argument can walk from the structured API into a shell. The invariant to
    keep documented: *AI-generated code and arbitrary commands execute only in the sandbox; platform-controlled
    structured services such as GitProvider/DeployProvider may execute on the NPATI host against the canonical
    managed workspace.*
  - **Protected branches are hard deny in two places.** A new typed policy request
    (`gitOperation`/`sourceBranch`/`targetBranch`/`remoteBranch`/`force`) replaces branch inference from a command
    string; the central PolicyEngine phase decides (`code-policy-engine.ts` ~`:520-540`) **and** `ProjectGitService`
    calls the same policy again immediately before the git side effect, because a direct service call never passes
    through the runner. A missing policy port fails closed (`GIT_POLICY_UNAVAILABLE`). `git push` **without a
    refspec** no longer reaches a decision with an empty branch: it is either resolved (host: `rev-parse
    --abbrev-ref HEAD`) or **hard denied** (`git_push_requires_resolved_branch`) — previously `branch: ""` bypassed
    the check entirely. Hard deny precedes approval and is not lifted by `approved: true`, a standing rule, or the
    owner.
  - **`code.git.protected_write` was removed, not wired.** It had no reader, and the surface it named is hard deny
    that no permission may lift — so wiring it would have meant either a permission protecting nothing or one that
    removes hard deny, both forbidden. Removing it made authorisation **stricter**: the permission now maps to
    `null` → `action_not_mapped` → deny, where before it was an identity mapping, i.e. an allow.
  - **Approvals are bound to the target.** `__npatiApprovalGranted` is no longer proof: the git boundary consumes
    the real approval record atomically, and `payloadHashFor` now includes branch, remote, force and credentialId,
    so an approval for one push cannot be spent on another. A git write with no named target cannot be approved
    at all (`GIT_WRITE_INTENT_REQUIRED` before the approval is created). No direct HTTP route for push/PR was added.
  - **Credentials are separated structurally.** A third, non-interchangeable SecretLease target `hostProcess` carries
    the git token into one process-scoped environment (config via `GIT_CONFIG_*` at a scope above `.git/config`,
    which is never written), revoked in `finally`. `environmentReferences()` refuses a `hostProcess` lease, so a
    plaintext token **cannot** reach `code.shell.exec` by construction rather than by filtering. Sandbox commands
    now receive git hardening built from the existing installer primitives. Tests pin: sha256 of `.git/config`
    unchanged across a credentialed push, no `extraheader`/`credential`/token in it, clean logs/stdout/stderr, and
    no credential on the next call without a new lease.
  - **Eleven `code.git.*` tools** (ids 374–384) as a **thin adapter** over the existing `ProjectGitService` — the
    adapter contains no git command at all (a source scan in the suite forbids `child_process`/`execFile`/`spawn`),
    and each executor was exercised against a recording fake. `code.git.pr.comment` was added because requirement
    10 needs a **separate** approval for PR comments; its payload is bound to the pull number and a hash of the
    body, so a push/PR approval cannot be spent as a comment. A **real integration bug was found and fixed**: the
    service hard-coded `project.git.pr` in the approval payload, so every agent PR approval would have been
    rejected — `toolName` is now passed (default preserves the old bytes).
  - **Auto branch** `npati/<session-short-id>` is created before the first model step; if that fails the run
    **stops** rather than working on whatever branch happens to be checked out. Before commit/push the session
    branch, the canonical revision and the protected-branch policy are all verified.
  - **Canonical workspace**: the runtime snapshots the canonical `ProjectWorkspace` content digest once per
    authorised call and the git executors re-check it before the side effect — a changed digest yields
    `workspace_revision_mismatch` (409) and **no side effect**; an unreadable revision also fails closed rather
    than inventing a value. The sandbox remains an execution environment that receives a specific revision.
  - **Conflicts auto-resolve for real**: at most two attempts (`-X ours|theirs` after listing unmerged paths and
    aborting), then a structured escalation carrying `attempts`, conflicting files and `suggestedTool:
    "code.ask_user"`. The textual promise "maximum automatic attempts (2)" is gone; the counter is real, and
    without a resolver the message says one attempt, not two.
  - **`REVIEW_CODE` read-only is enforced by the server**, not by the unused `intent`/`readOnly` field: a new
    runtime step (before sub-flag, arguments, approval and executor) plus a PolicyEngine hard-deny phase refuse any
    tool outside `READ_TOOLS ∪ PLAN_SAFE_TOOLS ∪ REVIEW_SAFE_GIT_TOOLS`, and PR comments still require their own
    approval. Review never writes to the repository.
  - **PR description reuses `CodingAgentRunSummary`** (what changed / verification / risks / unresolved), with an
    explicit "no verification was recorded" line instead of an implied pass; no second summary format exists.
  - Three stale comments that had become false were corrected (manifest version, the C8 git-group TODO, the C5a
    migration TODO). No unrelated refactor.
- Earlier: **C10 COMPLETE — sessions, checkpoints, resume, rewind, fork, background runs.** Final escalated evidence:
  `npm run typecheck` exit 0, both builds exit 0, **`npm run security-gate` exit 0 — `passed=1503 failed=0`,
  105 suites, `present=105 missing=0`**, and **`npm run test:web` exit 0 — 8 files / 71 tests / 0 failed**.
  - **Owner review (post-C10) — request durability + environment re-check.** Two suites were added
    (`tests/coding-agent-c10-run-request.test.ts`, `tests/coding-agent-c10-resume-environment.test.ts`), so the
    gate list is now **107 suites** with `missing_count = 0` and `node --check scripts/run-security-gate.mjs`
    exit 0. `npm run typecheck` is exit 0 after the change; the escalated gate/build/web re-run is the owner's.
  - **Three dead links were written, not invented**: `code_run_turns.checkpoint_id` now has a writer (the turn
    tracker is keyed **per step**, `${turnId}#turn-<i>`, with carry-forward for steps that wrote nothing — before
    this, every step of a run shared one `turnId`, so "the checkpoint of turn N" could only ever mean "the state
    before turn 1" and `CodeRunBoundary.checkpointId` was always `null`); `code_sessions.run_id` has a writer, so
    `lastRun`/`usage` stop being `null`; and `code_context_summaries` (C8 compaction) got its **first production
    reader** — it had been written and never read.
  - **Resume is the *same* run id** (`startRun` + a new `resumeRun` that acquires the lease *then* flips status,
    so a live foreign lease is never mislabelled), lost processes are derived from durable `unknown_outcome`
    evidence rather than the in-memory registry, and the continuation prompt is rebuilt from the run's own
    recorded request + the replay bundle + context summaries + plan/todos/goal + recovery notice — **never** from
    `code_run_turns.messages`, which the runner does not write (and which stays the metadata-only turn snapshot it
    was declared to be). The prompt is bounded, and is refused rather than stripped when it contains a secret.
  - **Owner review, request durability (C10 fix).** The original request used to exist **only in the live request
    body**: the bundle records the model's side and is written on the terminal path, so a mid-flight crash left no
    copy of what the user asked for. Migration **083** gives `code_run_states` the request (`request_status` /
    `request_text` / `request_sha256` / `request_truncated` / `request_recorded_at`) plus its
    `data_classification`/`retention_class`, written by the **same insert that creates the run** — so a crash
    immediately after start cannot lose it — and `ON CONFLICT (run_id) DO NOTHING` is what stops a resume
    re-entering the loop with the continuation prompt from overwriting it. `request_status` is a first-class value:
    `not_recorded` (no prompt / pre-083 run) and `refused_credential` (the value was **never** stored, so resume
    reports the refusal instead of pretending there was none). Resume returns the request verbatim plus
    `requestUnavailable`, and the prompt quotes it as *the user's own text*.
  - **Owner review, environment re-check (C10 fix).** A resume now records a **new** `ExecutionSnapshot` version
    with `trigger: "resume"` (the value had a vocabulary entry and no producer), built from the facts a resume can
    genuinely re-read (resolved flags, policy composition, provider/data policy, the C1b image verdict) because the
    run-scoped facts die with the process. The comparison is the store's own content-safe `diffExecutionSnapshots`
    restricted to the value families; an image is a **verdict, not a diff** (a replaced and a revoked digest are
    identical field by field). A **revoked image refuses the resume before the lease is taken** (409
    `run_environment_revoked`, run left resumable), and every other move — or a family that could not be compared —
    is stated in the response **and** in the continuation prompt, never continued silently.
  - **Rewind** (`code` / `conversation` / `both`) — and "conversation only" is a **cursor move**
    (`code_session_heads`), because the replay bundle and summaries are append-only **at the trigger level**;
    deletion is impossible, so rewind must point, not mutate. `both` reports `rewound_partial` honestly, and
    **claim-before-perform** (ledger unique on `(company_id, operation_id)`, audit before effects) means a repeat
    leaves exactly one pre-rewind checkpoint — not two.
  - **Fork** fills `parent_session_id`, copies the plan as a **draft** (an `approved` plan with an
    `execution_mode` was a decision about *that* session) and the todos/cursor, and deliberately **does not** copy
    the goal, with the reason returned in the response: two rows for one goal would make "is it done?" depend on
    which row you read.
  - **Background runs**: the tab-close handler now aborts only the transport, while the code run owns its own
    registry `AbortController` — previously closing a tab **killed** the run. Reconnect is served by an SSE
    endpoint (missed events by `fromSeq`, then live) and a polling endpoint, with monotonic `seq`, bounded
    buffers, and the terminal event always retained. **Queue and limits** are a new `CodeRunQueue` (not
    `CompanyRunQueue`, whose unit of work is a durable Company-run row while a code run carries a live
    `AuthContext` that another replica cannot rebuild): per-user and per-Company counters, round-robin between
    companies, bounded cancellable queue, `state()` for the UI, admitted **before** `reply.hijack()` so refusal
    is an honest 429.
  - **`notifications.backgroundResults` is finally read.** The key existed in the schema, the migration defaults
    and the UI in eight locales with **no server reader**; it now drives completed/failed notifications. Approval
    notifications are deliberately **not** muted by result switches — a run waiting on a human must not stall
    silently because someone turned off result delivery.
  - **Sandbox**: the `finally` release was confirmed **by fact** to be a no-op (the project object was read before
    the run created the sandbox, and `destroy` returns early on an empty `sandboxId`) and now re-reads the
    project; a retention sweep was added that never touches a running sandbox and has a floor of
    `retention ≥ inactivity`; and restart visibility uses new **system-scoped** reads, because the tenant-scoped
    `getProject` could not serve a system context.
  - **Export**: Markdown via the **same** limits (50/200, 4000-char results with a marker) and the **same**
    scanners as the transcript route; a secret yields `422 export_secret_detected` with `kinds` only and no
    document at all — a redacted export would look like a clean transcript while the secret stayed in the
    workspace.
  - **A real defect in the assembled app was found and fixed, with a test that provably catches it:**
    `codeSnapshotContexts` was read but never written, so snapshot/compare/by-id/activity and GET replay returned
    **401** in the assembled application, while `c6b-snapshot-api` stayed green because it builds routes with its
    own deps. The new `c10-route-auth-wiring` suite checks behaviour on the **real** `buildApp` *and* source-guards
    every `*Contexts` WeakMap; removing the `.set(...)` temporarily made it fail 4/4, which is how we know the
    test is not vacuous. This is the fourth instance of the project's recurring class ("module exists, no call").
- Earlier: **C9 COMPLETE — planning, todo, verification, self-review and goal-driven execution.** All eight owner
  completion conditions hold: `ask_user` pause/resume green with a pause that is a **persisted state** (survives
  restart, the C6a reconciler refuses it on two layers, only a human principal may answer, a repeated answer does
  not resume twice, TTL expiry yields `expired` + `ask_user_timeout` with **no** recorded answer — structurally,
  because the migration CHECKs make "answered without an answer" and "not answered with an answer" impossible);
  **self-review runs exactly once** structurally (a single `executed` flag that is never reset, so a second call
  returns the same frozen verdict and makes no model call), fix iterations capped at **one** by
  `resolveSelfReviewFixIterations` (which *reduces* any larger value) with a one-way fix and the verify repair
  budget closed afterwards, **re-verify driven by a change signature** (path + status + `sha256(diff)`), and a
  finding that asks to change mode/policy/permissions rewritten into a **blocking security finding** because the
  review output is data and no port could apply it; the **eval corpus expanded** in the existing harness
  (schema 1 → 2, 8 → 17 tasks) with exact count assertions; and the **Goal/Progress/verification UI** working in
  the existing plan block.
- Done and proven: plan mode
  (which was **already** enforced on three layers — mode matrix, `session_mode_denied` for non-read-only tools,
  and the runner not offering mutating tools in plan — so the new planning tools were deliberately added to the
  read-only classification instead of becoming an exception), the `code.plan.propose`/`code.plan.update` tools
  with capability ids 371/372 and executors, `code_session_plans` with `execution_mode` as a **separate column**
  (a plan is model output, so it can never choose its own execution mode), `code_session_todos` with a **partial
  unique index** enforcing "at most one `in_progress`", `code_goals` + `code_goal_criteria` where acceptance
  criteria are **separate rows** and DB triggers refuse `completed` while any criterion is unverified (plus the
  reverse trigger stopping a criterion of a completed goal from being re-verified), the verification loop with the
  **revived** dead knob `repairLoopAttempts`, the **test-integrity guard** (the real gap: deleting or weakening
  tests was not detected at all) and the scope guard as a warning.
- **Verified (final, escalated):** `npm run typecheck` exit 0; both workspace builds exit 0;
  **`npm run security-gate` exit 0 — `passed=1382 failed=0`, 95 suites, `present=95 missing=0`**; and
  **`npm run test:web` exit 0 — 8 files / 71 tests / 0 failed** (the frontend render tests had never executed
  before this step, and their first real run exposed 7 failures — all **test** defects, no XSS hole).
- **Registry split-brain closed and the guard hardened.** The generated artifacts said manifest **v6 / 24 tools**
  while `code-tool-registry.ts` still held `v5` with the old checksum — the artifact guard compared artifacts with
  each other and could not see it, so a session resolving v5 would silently not see the new tools. v5 is now
  **frozen with an explicit list of 22 names** (not "all minus new", which would let a future tool leak into an
  already published manifest), and `c2-schema-parity` gained three provably non-tautological checks: no
  duplicates and a complete `EXPECTED_RISK`, registry constants equal to the published manifest and to the
  registry's own checksum helper, and exactly one manifest for the published version with v5 intact.
- **One pre-existing defect fixed (owner-approved):** `project-deploy-service.ts` value-imported the type
  `AuthContext`, which broke loading of any suite that pulls `buildApp` under type-stripping — the reason
  `manual-product-e2e-web.test.ts` could never be a gate member. Zero other occurrences in `apps/agent-api/src`.
- **Eval-set extension (owner requirement 5) — DONE.** The eight C6 tasks were extended to **seventeen** without
  a second harness: `check` steps and the `test_integrity`/`self_review`/`repair_loop`/`command_fails`
  verifications were added **additively** (fixture + report **schema 2**, schema-1 tasks still valid), and the
  `c6-eval` count assertions were tightened from `8` to an exact `17` plus an exact id list. `ask_user`
  pause/resume and "a goal cannot complete with an unverified criterion" are **not** in the corpus (they need a
  store, a runner and DB triggers, not a repository transcript) and stay pinned by
  `coding-agent-c9-ask-user*.test.ts` and `coding-agent-c9-goal.test.ts`.
- **STILL OPEN IN C9 (do not read this step as complete):** requirement 4 **self-review** (one pass over the own
  diff, at most one fix iteration, explicitly **not** a second agent — that is C12); requirement 5 **`ask_user`**
  (structured question that pauses the run; the pause must be a **state** with a TTL that survives a restart and
  passes the C6a reconciler, otherwise the question dies with the process and the goal stays `blocked` forever);
  and the **UI** display of Goal / Progress / current / completed / blocked /
  Verification status inside the existing Code Workspace components (the plan block already renders — C9 wired a
  producer to it — so the same pattern applies).
- **Browser E2E = required in G1, not completed yet. Production ready = NO.** Migrations **070–080** have never
  run against a live PostgreSQL, the C4b live Docker E2E has not been executed, and G1/R1 have not been passed.
- **C10 (resume) and C12 (subagents) are NOT implemented** — `subagentDepth`/`subagentParallelism` remain dead
  configuration; C9 declared interfaces only, as the step requires.
  `CompressionArtifact` is model-visible state recorded into `ReplayBundle.replayInput` (format v3) and reused
  by replay, never recomputed; `contextCompressionRatio` (default 0.75) is revived and pressure is measured from
  the **full** model request; pinning replaced the absolute "never compress code" ban; truncation is
  deterministic with a separate raw ref; memory/context/instructions stay separate typed sections with their own
  trust; the cache prefix is stable and the data part follows a boundary marker; the summary passes
  `ProviderDataGuard`, classification and a shorter retention; and the 120-turn long-session acceptance test
  proves goal/decisions/open problems survive compaction while tool calls and their order do not.
- **The step's most valuable finding: the gate caught a real fail-closed regression.** A `let lastBudget` /
  `let compactionCount` declared below the early `return finish(...)` statements put every refusal path
  (flag → RBAC → admission gate → image admission) into the temporal dead zone, so with the feature flag off the
  runner **threw instead of refusing**. Fixed by hoisting the declarations; no test was weakened.
- **Browser E2E = required in G1, not completed yet.** Unchanged from C7.
- **Production ready = NO.** Migrations **070–079** have never run against a live PostgreSQL, the C4b live Docker
  egress E2E has not been executed, and G1/R1 have not been passed.
- **Open item for the owner (deliberate, not hidden):** the `secretLeaseValues` port is **not wired**. The lease
  module is metadata-only by design (a value exists only inside a single `consume`/`resolveField`), so no source
  of active lease values exists, and inventing one would break the boundary C4 was written for. The guarantee
  therefore rests on the value never entering the transcript at creation time (the shell path already redacts via
  `redactLeaseValues`), plus the pattern scanner and the guard on the summary. If a value source is wanted, it
  must be an explicit injectable accessor on `SecretLeaseProvider`.
- Next: **C9**, per `00-audit.md` section 13 (order is binding).

## Implemented (C6b, partial — green but incomplete)
- **Immutable snapshot storage** (migration `076_execution_snapshots`): `execution_snapshots` and
  `code_snapshot_config_versions`, both **append-only by repeating the `audit_log` pattern from 066** —
  `BEFORE UPDATE OR DELETE` trigger raising `insufficient_privilege`, `REVOKE UPDATE, DELETE, TRUNCATE`, and an
  `INSERT` trigger validating the per-session chain (`prev_snapshot_id`/`prev_payload_hash` must equal the
  head), so history can neither be edited nor spliced. `createExecutionSnapshot` **refuses** a repeated id
  (it is not an upsert — a snapshot is evidence, and overwriting would destroy exactly what it exists for).
- **Canonical hashing and content-safe diff** (`execution-snapshot-hash.ts`): canonical JSON with sorted keys
  (structurally identical configurations hash identically, any real change hashes differently),
  `snapshotPayloadHash` as `sha256:…`, and `diffSnapshotPayloads` which **cannot leak content** — long strings
  render as `string(N)`, objects as their key list, and a nested change is addressed by path
  (`featureFlags.code.write`) rather than "the whole object changed".
- **Real provider replacing `NullSnapshotProvider`**, with two deliberate properties: an unreadable source is
  recorded as an explicit `{unavailable: reason}` **and listed**, so "we could not read it" can never be read
  as "nothing was configured"; and `assertNoSecretsInSnapshot` scans the **serialised payload** rather than
  trusting the field list, refusing creation with `snapshot_secret_detected` instead of silently stripping.
- **Run/snapshot ordering fixed**: the snapshot is created **after** `runState.startRun` and carries the real
  `runId` (`stateRunId ?? input.runId`), plus `workspaceId` from the session — previously the snapshot was
  created before the run id existed, so `run_id` would have been `null` and `getSnapshotForRun` would never
  have found it. Failure to create a snapshot does **not** stop the run (an empty id is an honest answer).
- **`sandbox_image_digest` is real**: the `imageAdmission` port was extended additively to
  `{ reference, dev, digest?, sbomRef? }`, the admitted result is published into a holder, and the snapshot
  source reads it — so the field contains **the digest the policy actually admitted**, not an empty string.
- **Policy composition as its own source** (`policyComposition`): `modeRiskMatrixHash` and
  `sessionModeMatrixHash` are `sha256` of the stably sorted JSON of `MODE_RISK_MATRIX` and
  `DEFAULT_CODE_SESSION_MODE_MATRIX` (they are **code**, so a hash is the only honest "version number"), plus
  `projectPolicyVersion`, `approvalRulesRevision` and `companyMembershipRevision`; every reader is fail-soft
  (a failing reader yields `null` for **that component only**, never an invented number). There is deliberately
  **no single `policy_version` number**, so a diff names the concrete changed component.
- **`snapshot_id` in every Activity event** (migration `077_code_activity_events` with `kind` restricted to five
  families, `snapshot_id`/`run_id`, `data_classification` and `retention_class` NOT NULL with a CHECK
  vocabulary, four indexes): added to tool activity, policy decisions, network decisions and run/reconcile
  events, plus `PolicyRequest.snapshotId`, and `app.ts` now writes them through **one shared sink** instead of
  five scattered `app.log.info` calls. `invoke` in the tool runtime carries `snapshotId` into both Activity and
  the audit — and **never fabricates** it: without a value the store gets `NULL` (tested).
  Three properties worth keeping: content keys are **rejected**, not silently stripped (silent removal would
  hide the leak from the caller); secrets are caught **by value**, not only by key (`{"note": "ghp_…"}` is
  refused — that is exactly how a secret reaches a log); and a failing write **does not change the decision**
  (`{persisted:false, errorCode}` plus a log), throwing only on the two programmer errors that must be loud.
- `runnerVersion` came for free from an existing source (`build-info.ts`: `version`, `commit`, `builtAt`,
  `fingerprint`) — only the wiring is missing (see the blocker).

## OPEN BLOCKER (C6b acceptance criterion — partially closed)
**Closed:** `featureFlags` (resolved values from `featureFlagService.describe`), `providerDataPolicy`
(`resolveForCompany(...).policyVersion` **plus** the effective classification from `getProjectPolicy`),
`baseCommit` (branch/dirty from `status`, **HEAD hash from `log(..., 1)`** — never invented from `status`),
`toolchain` (the project's `ProjectCodeSettings.toolchain`) and `runnerVersion`
(`buildRunnerVersion(buildInfo)` = `version+commit+fingerprint`, with a test importing `buildInfo` directly).
Each reader is fail-soft in its own `try/catch`: a failing reader nulls **only its own field** (tested), and
each of the five is asserted non-empty for an ordinary run.

**Still open (both explicitly required by the C6b spec):**
1. `systemPrompt` — **CLOSED**: the holder publishes `{ version, contentHash }` from
   `ensureSystemPromptVersion(...)`, so the snapshot now says **with which prompt** the run executed (the
   registry de-duplicates by content hash, so an identical prompt reuses the same version — tested).
2. `modelProfileVersion` — **CLOSED**: same mechanism via `ensureModelProfilesVersion(...)` /
   `resolveModelProfile(...)`, so the snapshot says **with which profile** the run executed.

Every snapshot source named by the spec is now populated: `toolManifestVersion`, `policyVersion` components
(via `policyComposition`), `modelProfileVersion`, `modelSelection`, `systemPrompt`, `runnerVersion`,
`sandboxImage` (digest + SBOM), `featureFlags`, `providerDataPolicy`, `baseCommit`, `toolchain`,
`projectInstructions` (trust + `null` hash), initiator/role and time.

**Deliberate `null`s (accepted, not debt):** `projectInstructions.contentHash` belongs to **C8** (the source
already accepts `string | null`), and `modelSelection.temperature` does not exist because the runner does not
pass generation parameters to `engine.chat` — recording a value that does not exist would be worse than `null`.

## Replay, API and Run Trace (C6b, closed)
- **`ReplayBundle`** (migration `078_replay_bundles` + `code_replay_bundle_steps`, both **append-only at the
  database level** with the 076/066 trigger pattern — a bundle is evidence of what the model actually saw, and
  a row that can be rewritten after the run proves nothing): header with `execution_snapshot_id`,
  `bundle_version` (**format** version, per rule 13), `runner_version`, `system_prompt_version` +
  `content_hash`, `model_profile_version`, provider/model, `replay_mode`, `source_run_id`/`source_snapshot_id`,
  `terminal_status`/`terminal_reason`, `payload_hash` + `replay_input_hash`, classification and retention NOT
  NULL; steps ordered by `seq` with `kind` `model_step|tool_call`. Header and steps are written **in one
  transaction**, so there can be no header promising steps that do not exist; uniqueness gives idempotency per
  `(run_id, turn, tool_call_id)`.
- **`replayInput` excludes `rawArtifact`** — the owner's rule ("raw must not change replay input") is a
  property of the data, not a convention, and the engine consumes `replayInput`, never `steps`.
  **Defect found by running:** canonicalising the settled tool result by sorting keys **changed the text the
  model sees** (`{ok,tool,result,truncated}` → `{ok,result,tool,truncated}`); sorting is now used **for hashes
  only**, the model-visible text stays byte-for-byte identical, and a test pins it.
- **Deterministic replay**: `RecordedReplayDeps` has **no engine and no tool runtime at all**, so "no provider
  call, no tool execution" is **structural**; `providerCalls`/`toolExecutions` are returned as hard zeros so
  the property can be asserted rather than believed. What it verifies is the recorded model output against the
  recorded execution (two independent records): order, `tool_call_id`, tool name, **schema version against the
  live registry**, argument hash, settled-result presence, and `outcome:"failed"` ↔ `errorCode` consistency —
  returning metadata-only divergences (`{reason, turn, toolCallId, expected, actual}`) as **409
  `replay_diverged`**. The author **discarded** his first approach (re-running the real loop through replay
  ports) on discovering the bundle records only argument **hashes**, so reconstructing the assistant message is
  impossible and a replay comparing a recording with itself proves nothing.
- **Live replay**: creates a genuinely **new** run, keeps `source_run_id`/`source_snapshot_id`, stores
  `replay_mode = live_best_effort`, carries the owner's notice **verbatim**, and `assertNotDeterministic`
  inspects the **serialised** result, throwing `replay_wording_violation` if the word "deterministic" appears
  anywhere — the promise cannot leak into a response by accident.
- **Read-only API** (`code-snapshot-routes.ts`, five routes, `apiVersion: v1`, tenant-scoped, deny by default
  through the shared C5a gate with **named** actions `code.snapshot.read`/`code.activity.read` plus the
  existing `code.replay.read`): snapshot for a run (with identity: version, `payloadHash`, chain, `trigger`,
  `createdBy`), one snapshot by id, `compare?a=&b=` via the existing `diffExecutionSnapshots`, run activity
  events with keyset pagination, and replay status/metadata. **`legacy_no_snapshot` and `no_bundle` return
  200 without an error envelope**, decided by the same reader the runner uses, so writer and reader cannot
  diverge — old history stays readable instead of becoming a 500.
- **Minimal Run Trace view**: `CodeSnapshotPanel.tsx` inserted into the **existing** `ActivityPage.tsx` (not a
  new screen), using existing style classes and no new dependencies: model/provider, profile, system prompt,
  runner version, tool manifest, image digest + SBOM, provider data policy, **resolved** flags, base commit with
  dirty state, project trust, toolchain and policy components, plus "Compare snapshot" and replay status.
- **Two real defects found by the API stream's own tests**: a pagination cursor was issued on a page not proven
  full (`events.length === (limit ?? events.length)` was true when `limit` was absent, so the client saw "there
  is more" when there was not — now an explicit default of 50 and a cursor only on a full page); and a
  malformed cursor returned **403 instead of 400**, because an explicit error `status` overrode the code
  contract, making a client error look like a permissions problem.
- **Three deliberate decisions**: an event whose stored payload contains a content key is refused **loudly**
  (`activity_payload_invalid`, 500) and never copied into the response (silent stripping would hide the leak
  from whoever wrote it); the diff is checked both for forbidden keys and for every element being a **path**
  (`^[A-Za-z][A-Za-z0-9_.]*$`) rather than a value, with a canary proving no secret appears; and
  `{unavailable: reason}` renders as "could not read", never as "empty".
- **By-id replay read is not an existence oracle**: `getReplayBundleById` returns `no_bundle` for **both** an
  unknown and a foreign id, so the endpoint cannot be used to probe whether another tenant's data exists. The
  store method was added **additively** to the existing port (no second store in the routes), and by-id and
  by-run share one `assembleBundleRead`, so the two read paths cannot diverge (proven by a test asserting
  identical `steps` and `replayInputHash`).

## Verification (C6b, as far as it goes)
- `npm run typecheck` → **exit 0**; `npm run security-gate` → **exit 0: `passed=946 failed=0 skipped=0`** with
  **61** suites (`suite files: present=61 missing=0`) and all four steps green; both workspace builds exit 0.
- Three of the five traps found by recon were closed in code (port extension for the digest, snapshot-after-
  `startRun` ordering, run→snapshot linkage via `run_id` rather than the overwritten `details` column), and one
  was resolved by **not inventing** a composite `policy_version`.

## Real E2E status (C6b)
- Verified in-process with injected stores, clocks, services and holders: immutability and chain validation at
  the store contract level, hash sensitivity, content-safe diff, version de-duplication, `legacy_no_snapshot`,
  secret refusal by canary, ordering, digest publication, activity persistence and metadata-only enforcement.
- **Not verified here:** migrations **070–077** against a live PostgreSQL (the DB triggers were verified by
  reading, not by running), the real `code_activity_events` SQL and keyset cursor, deterministic replay and
  live replay (not implemented yet in this step's scope), the C4b Docker E2E and the GitHub CI job.

## Known risks / open questions (C6b)
1. **`code_activity_events` has no DB-level append-only trigger** (deliberate: it is derived telemetry with no
   hash chain; immutability rests on the absence of mutating methods — only create + read). If evidence-grade
   immutability is required for Activity, this needs an additive trigger change.
2. `NPATI.md` content hash is intentionally `null` until **C8** (the source accepts
   `{ contentHash: string | null, trustStatus }`), and `modelSelection`/`temperature` is `null` because the
   runner does not pass generation parameters to `engine.chat` — recording a value that does not exist would be
   worse than recording nothing.
3. Deterministic replay is **not implemented**: the recorded data (C6a `code_run_turns`) is enough for a
   structural re-run, but provider responses are only kept as assistant messages (no provider/model/usage per
   turn), the runner's `idempotencyKey` is not persisted, the system prompt lives only as the first message, and
   tool results are truncated — so replay needs those recordings added first.
4. The "why did the agent act this way" API/UI (snapshot view plus diff between two runs) is not implemented.
5. Snapshot retention follows the Activity policy (R1) — but there is still **no retention sweeper** anywhere,
   so without one this data grows forever.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C6b), `docs/coding-agent/00-audit.md` sections 12 and 13, and this
  file.
- **First: close the five null snapshot sources** listed in the blocker, with tests proving each field is
  non-empty for an ordinary run and that a failing reader nulls only its own component. Then implement
  deterministic replay (recorded provider responses per turn + tool results + the system prompt as a versioned
  hash, then replay against a mock provider) and clearly label live replay as best-effort reproducibility; then
  the "why did the agent act this way" API/UI with snapshot diff.
- Keep every earlier guarantee intact: commands only through the sandbox port, the PolicyEngine decides (hard
  deny > session mode > project rules > protected branches > migration safety > network gate > approval), agents
  never approve and never change policy, recovery never repeats write/shell/unknown tool calls, nothing reaches
  a provider outside `ProviderDataGuard`, and every new suite goes into `scripts/run-security-gate.mjs`.
- **Before any production promotion:** run migrations 070–077 against a live PostgreSQL and execute the C4b live
  Docker E2E checklist.
- Do not start C7 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C6a, latest step)
- **Run state as an event log** (migration `075_code_run_state`): `code_run_states` with `status`
  (`running|interrupted|completed|failed|cancelled`), `turn_index`, `last_event_seq`, `lease_owner`,
  `lease_expires_at`, `heartbeat_at`, `revision`, plus `code_run_turns` holding the messages, tool calls
  (with `tool_call_id`), results, `checkpoint_id` and `outcome` (`ok|failed|unknown_outcome`). State is
  written **after every turn and every tool call**, not at the end; `last_event_seq` is monotonic and every
  append is idempotent. Heartbeat and lease use the limits from `resolveCodeAgentLimits()`
  (`runHeartbeatMs` 15 s, `runLeaseMs` 60 s) — those constants were **dead configuration** before this step.
- **Reconciler** (`code-run-reconciler.ts`), run at server start and periodically with `unref()`: a `running`
  run without a live lease becomes **`interrupted`**, and recovery proceeds **only from a turn boundary**. The
  asymmetry that matters: a **read-only** tool call that was in flight is **repeated**; a **write, shell or
  unknown** call is **never repeated** — its result is marked **`unknown_outcome`**, the workspace is
  **diffed against the last checkpoint**, and that diff plus the list of unknown-outcome calls is handed to
  the model *and* the user before continuing. Idempotency is keyed by `tool_call_id`. The reconciler follows
  the existing `storage-reconciler` pattern (single reconciliation lease, grace period) and supports
  `dryRun`; a second run is a no-op.
- **Reaper** (`code-reaper.ts`) is an **orchestrator over the existing `reap*` implementations**
  (`code-secret-lease.reap`, `code-process-manager.reapIdle`, `code-shell-runtime.reap`) rather than a fourth
  reimplementation. Eleven steps, each with metrics: secret leases, process records, orphan processes, shell
  sessions, stuck tool calls, overdue runs, stale approvals, orphan sandboxes, temp dirs, stale locks and disk
  pressure. Invariants proven by tests: **`dryRun` calls no mutating API** (steps without a preview are
  reported as `dry_run_preview_unavailable` rather than "clean"), **re-running is safe** (already-cleaned
  targets are a no-op), one failing step cannot take down the server, **migration advisory locks are never
  released**, a lock with a live owner is skipped and logged, long-running tasks are not killed, runs stop
  only after `maxRunMinutes` **plus grace**, and a temp directory whose ownership cannot be proven is not
  deleted. **Real defect found:** `SecretLeaseProvider.startReaper()` was **called nowhere**, so in the live
  server expired SecretLeases were never revoked — the reaper now calls the existing `reap()` each pass.
- **Admission gate**: the reaper's `isRefusingNewRuns()` (disk pressure) is now consumed by the runner through
  an **optional** port at run start, after RBAC and before image admission and any model call; a refusing gate
  returns the existing `failed`/`refused` stop with an additive `code` (`disk_pressure`), and a gate that
  **throws** also refuses (`admission_gate_unavailable`) — "the gate did not answer" must never mean "let it
  run". Without the port behaviour is unchanged.
- **Safe DB migrations** (`code-migration-safety.ts`, phase **4c** immediately after protected branches):
  migration runners (prisma/drizzle/alembic/django/rails/artisan/knex/typeorm/sequelize/flyway/liquibase/goose/
  sqlx/dbmate) and direct SQL clients against a non-local database are **approval class**; targets are
  classified by **host/URL, not by variable name**. **Production, external and unknown targets are hard deny**
  (`migration_target_production_denied`, `…_external_denied`, `…_unknown_denied`) and this hard deny is not
  lifted by `full_auto_sandbox`, `approved: true` or a standing rule. Only an **ephemeral sandbox database**
  or a **dev DataBackend through the existing Data Studio engine** may execute (otherwise
  `migration_execution_path_required`), and on a `deny` verdict the engine is **not called at all**. Destructive
  changes — in the command (`prisma migrate reset`, `db push --force-reset`, `flyway clean`, `goose reset`,
  `typeorm schema:drop`, `alembic downgrade base`) or in the migration **diff** (`DROP TABLE/COLUMN`,
  `TRUNCATE`, `DELETE` without `WHERE`, type changes, renames, dropped indexes/constraints) — require
  **approval plus snapshot**; hidden migrations in `package.json` scripts (`prestart`, `dev`, `postinstall`,
  `prepare`, `start`, `test`), `Makefile` targets and entrypoints are detected and require approval; a
  migration without a rollback plan is approval with an explicit warning; a failed migration is **not
  retried** (exactly one `apply`). **Real bypass found and closed:** declaring an ephemeral sandbox target
  would have masked a production host **inside the command text** (`psql -h db.prod.internal`), so the order is
  now **inferred → declared → sandbox default** and a test proves that `approved: true` does not help.
- **Production credentials**: `assertNoProductionCredentialsVisible` is now actually **called** in the shell
  path after environment assembly and **before** the lease and the sandbox (`production_credentials_visible_
  denied`, 403, with `details.leakedKeys`); it fires only when a value points at a **configured** production
  host/URL or a variable name is explicitly listed in `productionSecretKeys`, so dev and local values pass.
  Approval does not bypass it (independent checks, tested).
- **Checkpoints and rollback** stay with the existing `code-workspace-checkpoint.ts`, which deliberately does
  not re-implement anything: checkpoints go through `ProjectGitService.createCheckpoint`/`restoreCheckpoint`
  (commit of the dirty worktree, tag `refs/npati/checkpoints/<id>`, mandatory pre-restore safety checkpoint)
  and approvals through the existing repository.
- **Store additions** (additive, both implementations): run-state methods plus keyset-paginated scans
  `listStuckToolCalls` and `listOverdueRuns` for the reaper. `longRunning` is **not guessed from the tool
  name**: it derives from the same limits table the tool runtime enforces (`code.deps.*` → 600 s, otherwise
  120 s) and `declaredTimeoutMs` is returned so the log explains the decision; `lastProgressAt` is measured
  from the run's heartbeat; overdue grace is 5 minutes. Both scans are read-only (a test compares the full
  turn JSON and `lastEventSeq`/`revision` before and after), company-scoped (with a documented system scope
  for the reaper), content-free (exact key list asserted) and paginated (cursor, `limit` clamped to 1…500,
  at most 20 pages per call).
- **Approvals expiry**: `expireStaleApprovals({ now })` performs the bulk `pending` → `expired` transition
  with **audit before each transition** (`company.approval.expired`, `actor: "system"`), fail-closed when the
  journal is unavailable, idempotent and race-safe (conditional `UPDATE … AND status='pending' AND
  expires_at < $2`), with no route (system reap). The existing lazy expiry in `decide`/`consumeApproved` is
  untouched. **A contract mismatch was caught before it shipped:** the reaper port expects
  `{ now: number }` (epoch ms) returning a **number**, while the first implementation returned
  `{ expired, ids }` — which would have silently put a number where a `timestamptz` belonged and an object
  into a numeric metric, invisible to `tsc` because the adapter casts through `unknown`; the method now
  matches the port and the ids live in `expireStaleApprovalsDetailed`.

## Verification (C6a)
- `npm run typecheck` → **exit 0** (all workspaces); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=905 failed=0 skipped=0 todo=0`** with **59** security-gate
  suites (`suite files: present=59 missing=0`, unique 59) and all four steps green.
- Real defects found by running, not reading: `SecretLeaseProvider.startReaper()` called nowhere (expired
  leases never revoked in the live server); `lastEventSeq` never advanced on turn/tool-call writes, so the
  "monotonic event cursor" was fiction; the log and the store used **different clocks** for `startedAt`, so
  "no progress for 300 s" compared two clocks — exactly how the reaper would have killed a healthy run; the
  final turn had no boundary at all; `finishedAt: null` became `now` through `??`, making a write-ahead record
  look finished; declaring an ephemeral sandbox target masked a production host in the command text; and the
  approvals method shape did not match the reaper port (caught before shipping).

## Real E2E status (C6a)
- Verified in-process with injected stores, clocks, sandbox and engine ports: run-state writes and lease
  lifecycle, reconciler decisions and `dryRun` idempotency, all eleven reaper steps, the admission gate, the
  migration safety verdicts (including the positive paths) and the approvals expiry contract.
- **Not verified here:** migrations **070–075** against a live PostgreSQL, real Postgres SQL for the keyset
  scans and the bulk expiry, a real sandbox container dying (no Docker), real disk-full and network
  interruption chaos, the C4b Docker egress E2E, and the GitHub CI job (never executed).

## Known risks / open questions (C6a)
1. **Workspace inside the sandbox is tmpfs** (`--read-only`, `--tmpfs /workspace`, no host mount), so the
   container's working copy does **not** survive its death; durable state is host-side plus git checkpoints.
   Recovery is therefore **git-based**, and anything that lived only in tmpfs (build artifacts, uncommitted
   files) is lost after a crash. This is a documented limit, not a promise of volume snapshots.
2. **No budget/quota is set for a code run** (the `quota` port is still unwired) — the only cost protection is
   the runner's own limits. **Owner decision.**
3. **`runId` is now real** (`code_run_states`), but `turnId` remains a placeholder in the entry point, and
   Activity is still a log (`code_run_activity`) until C6b links events to a snapshot.
4. Six reaper steps depend on other modules and were `skipped: port_unavailable` at first; `stale_approvals`
   and the tool-call/run scans are now wired, while the sandbox list-by-label scan, the all-processes scan and
   the temp-dir/file-lock inventory still need provider support. Where ownership cannot be proven the reaper
   logs instead of deleting.
5. **Core migrations have no lock, checksum or down migration** (`postgres-store.ts`), unlike the Data Studio
   engine; the audit already says to reuse that engine for the Core DB. Until then "a failed migration rolls
   back" holds for Data Studio–managed targets, not for NPATI's own migration runner.
6. Rollback/atomic-task behaviour is still only partially exercised: "changes stay as Changes with a Revert run
   proposal" and the optional `atomic task` auto-revert after the repair limit are not covered by a chaos test
   here.
7. Migration execution, transactional rollback and snapshots were verified by reading the existing engine plus
   contract tests — **not** by running against Postgres.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C6b), `docs/coding-agent/00-audit.md` sections 12 and 13, and this
  file.
- Execute **only C6b**: `ExecutionSnapshot` — the real provider replacing `NullSnapshotProvider`, the snapshot
  content and versioning, `snapshotId` on every Activity event and audit entry, and the linkage from run and
  turn state to the snapshot.
- Keep every earlier guarantee intact: commands only through the sandbox port, the PolicyEngine decides (hard
  deny > session mode > project rules > protected branches > migration safety > network gate > approval; the
  permission is derived from the action), one-shot SecretLease with revocation, no lifecycle scripts without
  approval, agents never approve and never change policy, nothing reaches a provider outside
  `ProviderDataGuard`, recovery never repeats write/shell/unknown tool calls, and every new suite goes into
  `scripts/run-security-gate.mjs`.
- Carry these open items forward: the code-run budget policy (owner decision), the remaining reaper ports
  (sandbox list-by-label, all-processes, temp/lock inventory), Core-migration lock/checksum/down, and the
  sandbox tmpfs limitation.
- **Before any production promotion:** run migrations 070–075 against a live PostgreSQL and execute the C4b
  live Docker E2E checklist; then consider `NPATI_SANDBOX_EGRESS_ENFORCED=true` and
  `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT=true`.
- Do not start C7 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C6, latest step)
- **`CodingAgentRunner`** (`coding-agent-runner.ts`) — a loop **separate** from `runChatToolLoop` (which serves
  ordinary chat, Company and email and was **not** modified). Unlike that loop it checks cancellation
  **between steps** (`signal.aborted` plus an injected `cancelRequested()`). Every model call carries
  **`policyContext` inside the request** (`CodingAgentChatRequest extends ChatRequest`, no `as` and no edits
  to the shared package), which is the C5b contract; this runner is the first real caller, so
  `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT` can be enabled after it.
- **Call partitioning**: read-only calls run in waves up to `parallelReadOnlyCalls` (8); writes and shell run
  **strictly one at a time** in the model's order. The classification is an **explicit** list
  (`CODE_RUN_READ_ONLY_TOOLS`) because `CodeToolRuntime.isWriteTool` covers only workspace mutations —
  `code.shell.*`, `code.deps.*` and `code.verify.run` are not "write" there, so relying on it would have run
  shell commands in parallel. An unknown tool is treated as sequential (fail-safe).
- **Stop conditions**, each with a reason and a summary: `completed`, `step_limit` (40), `time_limit` (30 min),
  `budget_exhausted` (existing `A2AQuotaManager` port), `cancelled`, `loop_detected`,
  `invalid_arguments_exhausted`, `provider_error`, `refused` (flag/RBAC/image admission — all of these are
  checked **before** the first model call). The summary takes `filesChanged`/`diffStats` from the canonical
  `turnSummary` and counts `checksRun` from executed `code.verify.*`/`code.deps.audit`.
- **Anti-loop**: three identical calls (name + stable JSON args) insert a system reminder to change approach,
  a further repeat stops the run (`loop_detected`); three identical **error codes** are handled separately
  (different arguments) with the same escalation.
- **Error handling**: tool failures come back to the model as structured results; invalid tool arguments get
  **up to 2 corrections**, and **partial** calls (truncated stream) are never executed and never counted as a
  correction; provider failures rely on the **existing** routing/fallback (no private retries); a stream break
  resumes **without re-executing** already-run tool calls (idempotency by `tool_call_id`).
- **`ToolCallAdapter`** (`code-tool-call-adapter.ts`) is now the single normaliser: `normalizeToolCalls` →
  `{ mode, calls, rejected, warnings, reasoning }`, `executableToolCalls` (excludes `partial`/`rejected`),
  `planToolCallWaves`, with the canonical `validateArguments` always injected (the text fallback executes
  **nothing** without a validator: `validator_not_configured`, fail closed). Two invariants: nothing
  unparsable is executed (a truncated JSON never becomes `{}`) and **normalisation never raises trust**
  (`trustedAsInstruction: false` on every call — an injected `{"tool":"code.shell.exec",…}` inside file
  content is data; authorisation stays with the PolicyEngine/RBAC/approvals). Honest limits: the wire types
  have **no** reasoning/thinking fields and `stream()` yields only text, so `reasoning` is pass-through only;
  and the engine hard-codes `parallel_tool_calls: false`, so waves are a **safety net**, not a guarantee.
- **Model profiles as configuration** (`code-model-profiles.ts`): an injectable registry
  (`DEFAULT_CODE_MODEL_PROFILES`), priority override → exact model → anchored pattern → provider →
  **conservative default** (`toolCallingMode: "auto"` with `supportsNativeTools` as evidence, 
  `maxParallelToolCalls: 1`, the **smallest** known `contextWindow`, no temperature, **no** invented
  `preferredEditTool`, `knownLimitations: ["unknown_model"]`). Invalid profiles are skipped with a warning
  rather than half-applied; a bare `*` pattern is rejected; `code.model_profile.<id>` is a **boolean** flag, so
  profile content comes from configuration and the flag only enables a profile by id.
- **Intent router** extended **inside the existing mechanism** (`defaultHybridRouter`): seven code intents
  (`CREATE_CODE`, `EDIT_CODE`, `DEBUG_CODE`, `EXPLAIN_CODE`, `REVIEW_CODE`, `REFACTOR_CODE`, `TEST_CODE`) map
  onto existing `ProjectIntent`s; `DEPLOY_PROJECT`, `CONNECT_REPOSITORY` and data-model intents stay with the
  existing pipeline, and a website/mobile project **never** enters the coding agent.
- **The chat entry point now reaches the runner** (this was the acceptance criterion): inside the existing
  `POST /chat/stream` handler, after SSE setup and before the existing pipeline, a pure exported
  `resolveChatCodeIntent(...)` decides `chat` | `clarify` | `run`. A code intent with an active code project
  and session calls `codingAgentRunner.run({ ctx, session, prompt, signal })` and streams the result through
  the **same** `send(...)`/heartbeat/cancel mechanism; without a project it returns the question "Which
  project should I work in?"; master-flag off (or any flag read error, treated as off), non-code intents,
  website/mobile projects and a missing company context fall through to the existing pipeline unchanged. An
  error inside the branch is logged (`code_intent_chat_branch_failed`) and never breaks the stream.
- **`ExecutionSnapshotProvider`** (`execution-snapshot.ts`) declared with a **`NullSnapshotProvider`**
  returning an empty `snapshot_id`; `snapshotId` stays optional in events so C6b can substitute the real
  implementation without changing formats.
- **Limits and budget are reused, not re-implemented**: `resolveCodeAgentLimits()` and the existing
  `A2AQuotaManager` port (the injection point is ready), `toolRuntime.invoke` (idempotency by `toolCallId`,
  approval gate, checkpoints, read tracker, Activity, audit — all inside the runtime), the PolicyEngine,
  SecretLease, and image admission (`SandboxImagePolicy.admit`). **No migration was needed**: run lifecycle
  uses the existing event types and tool details go through the Activity port as in C4/C5.
- **RBAC**: `code.run.start` maps to `workspace:write`; the missing `code.session.create` entry was added — it
  is audited but was absent from `CODE_ACTION_PERMISSIONS`, so creating a session (without which no run is
  possible) would have failed with `action_not_mapped`.
- **Eval harness** (`code-eval-harness.ts` + `tests/fixtures/coding-agent-eval/tasks.json`): seventeen
  deterministic tasks on tiny fixtures with scripted model transcripts, executed through the **real
  `CodeToolRuntime`** (canonical executors, in-memory read/write port, checkpoint port) and post-verified.
  The eight original C6 tasks (arithmetic bug, add a function, refactor, write a test, broken `package.json`,
  failing test, TypeScript typing, enable strict) are unchanged and remain valid verbatim: the C9 additions are
  **additive**, which is why the fixture and the report were raised to **schema 2** (a newer fixture is refused,
  an older one still loads). The nine C9 tasks pin, in data rather than in code: a *failing* check that is then
  repaired until it passes (a `check` step records the exit status of a project check **inside** the transcript,
  so "it was red, then green" is a fact and not the transcript's claim); a run that spends its three repair
  attempts and **stops** (`repair_loop`, replayed through the real loop state machine, with the check still red);
  the test-integrity guard's verdict on a skipped case, a deleted case, a whole test file moved out of the suite
  and a `.only` focus (all flagged, each with its own finding kind) plus the negative control that *adding* a
  case is not flagged; and two self-review tasks whose findings (a committed credential, an out-of-scope change)
  are produced by the real review pass from a **recorded** provider answer, so CI needs no live model.
  Metrics: steps, tool calls, checks, tokens, duration, totals.
  **A negative control exists** — a wrong transcript fails (`verify_content_mismatch`), tool errors surface as
  `tool_failed:…`, `maxSteps` gives `max_steps_exceeded`, a `check` step whose expected status did not happen
  fails (`check_failed`/`check_unexpectedly_passed`), a verification that insists a weakened change is clean
  fails (`verify_test_integrity_flagged`), a recorded review finding about a file the run never changed is
  refused (`verify_self_review_file_not_changed`), and the live mode requires both `NPATI_CODE_EVAL_LIVE=1`
  and an injected live model (`eval_live_model_missing`), so recorded answers are never silently reused.

## Verification (C6)
- `npm run typecheck` → **exit 0** (all workspaces); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=821 failed=0 skipped=0 todo=0`** with **55** security-gate suites
  (`suite files: present=55 missing=0`) and all four steps green.
- Chat/Company regression (run separately because the gate does not contain those files):
  `chat-language-routing` and `human-approvals` pass; `company-runtime` keeps its **4 pre-existing failures**
  (documented since before C1 and reproduced on a clean tree — unrelated to C6).
- Real defects found by running, not reading: `matchesModelPattern("", "*")` returned `true`, so an empty or
  unknown model id would have inherited any broad pattern instead of the conservative default; text tool calls
  **lost their order** (fenced blocks were collected before markers); the guard's context contract and the
  `toCanonicalContentType` totality (C5b); and the runner's own partitioning would have parallelised shell
  commands if it had trusted `isWriteTool`.

## Real E2E status (C6)
- Verified in-process against injected models, tool runtime, sandbox, budget and snapshot: every stop
  condition, anti-loop, stream-break recovery, invalid arguments, partitioning, cancellation, RBAC/flag/image
  admission, the intent router, the chat branch decision, and the eval harness end to end.
- **Not verified here:** a real model call, a real sandbox container lifecycle (no Docker), migrations 070–074
  against a live PostgreSQL, the C4b Docker egress E2E, the UI in a browser, and the GitHub CI job (never
  executed). The acceptance scenario ("fix the failing test in this project" through the chat) is verified at
  the decision and orchestration level, not against a live provider.

## Known risks / open questions (C6)
1. **No budget/quota is set for a code run** (`quota` port unwired — no `A2AQuotaManager` instance at that
   point); the only cost protection is the runner's own limits. **Owner decision.**
2. **`runId`/`turnId` are placeholders** (`turnId: sessionId`): the run entity arrives with C6a, so run
   lifecycle events and Activity are not yet bound to a real run; Activity is currently the log
   `code_run_activity`.
3. **Sandbox release works only where `projectSandbox` is constructed**: in the chat path the project is
   loaded, so `destroy` runs in a `finally` (success, failure and cancellation); where the service is absent
   nothing was created by that path, and this is logged (`code_run_sandbox_release_unavailable`).
4. The promise of "read-only in parallel" is bounded by the engine setting `parallel_tool_calls: false`;
   parallelism is a safety net, not a guarantee.
5. `reasoning`/thinking content is not available from the provider wire types — the adapter passes it through
   only if the caller already has it.
6. The eval harness is deterministic and CI-friendly, but it exercises a mocked model; a live-model run is
   opt-in and has never been executed here.
7. C5b enforcement is still off by default; enabling `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT` now requires that
   every remaining non-coding caller also passes `policyContext`, otherwise legitimate chat/Company/email
   traffic is refused.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C6a), `docs/coding-agent/00-audit.md` sections 12 and 13, and this
  file.
- Execute **only C6a**: persistence of sessions/turns/tool calls, the run and turn entities that C6 leaves as
  placeholders, the durable event log, the reconciler/reaper for stuck runs, recovery after a process restart,
  and the `runId`/`turnId` binding so Activity events reference a real run.
- Keep every earlier guarantee intact: commands only through the sandbox port, the PolicyEngine decides (hard
  deny > session mode > project rules > network gate > approval; the permission is derived from the action),
  one-shot SecretLease with revocation, no lifecycle scripts without approval, agents never approve and never
  change policy, nothing reaches a provider outside `ProviderDataGuard`, and every new suite goes into
  `scripts/run-security-gate.mjs`.
- Carry these open items forward: the code-run budget policy (owner decision), sandbox release where
  `projectSandbox` is absent, and the `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT` flip once all callers pass
  `policyContext`.
- **Before any production promotion:** run migrations 070–074 against a live PostgreSQL and execute the C4b
  live Docker E2E checklist.
- Do not start C6b in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C5b, latest step)
- **`ProviderDataPolicy` per provider (and optionally per model)**, additive migration
  `074_provider_data_policies` with four tables: `provider_data_policies` (`company_id` nullable = platform
  default, `model_pattern` nullable = whole provider, `policy_version`, `kind`
  `hosted_third_party|self_hosted|local`, `allow_private_repo_code`, `max_data_classification`,
  `allow_prompt_caching`, `external_retention`, `training_policy`, `region`, `jurisdiction`,
  `required_redactions`, `allowed_content_types`, `terms_url`, `last_reviewed_at`, `reviewed_by`),
  `code_project_data_policies` (classification default `confidential` + `path_rules`),
  `provider_data_policy_versions` (append-only snapshots for C6b) and `provider_hosted_consent`
  (explicit consent per company+project+provider).
- **Conservative, fail-closed defaults**: an unknown or new **hosted** provider gets `public` only,
  `allow_private_repo_code: false`, `allow_prompt_caching: false`, `training_policy: "unknown"`,
  `external_retention: "unknown"`, **all six** redaction kinds and `allowed_content_types: ["metadata"]`
  (no code, diff, files, logs, terminal or web) with `stale: true` / `no_policy_for_provider`. An unknown
  `providerKind` is **not** treated as self-hosted. `local`/`self_hosted` reach `restricted` but secret,
  token and key redaction is **always** mandatory — the validator and the store refuse to remove it for any
  kind, and the resolver re-adds it even if the database row lacks it. Priority is model → provider →
  platform default → hard fail-closed; two model patterns can never weaken each other (the stricter one
  wins). `classifyContent` gives `code`/`diff`/`files`/`logs`/`terminal` a floor of `confidential` **even in
  a public project**, and path rules can only **raise** the classification. `path_rules` with `..`,
  absolute paths, `~`, backslashes or empty values are rejected by both the service and the store, and a
  refusal leaves the stored policy untouched. Staleness is reported after 180 days (or when
  `last_reviewed_at` is missing).
- **`ProviderDataGuard` as an `AIEngine` decorator** (`provider-data-guard.ts`): a Proxy, so it covers all
  twenty-plus engine methods and a new adapter method cannot create a hole; it intercepts `chat`/`stream`
  and, when present, `transcribeAudio`/`embed`/`moderate`/`rerank`. **Content is walked generically over all
  string leaves** (not over known `ChatRequest` fields), so a new field in the adapter cannot bypass it.
  Refusals: `provider_policy_context_required`, `provider_policy_unavailable` (503), 
  `provider_data_classification_exceeded` (403), `provider_content_type_not_allowed` (403),
  `provider_private_code_not_allowed` (403), `redaction_placeholder_write_denied` (403),
  `no_eligible_provider`. Redaction uses **stable placeholders** (`REDACTED:token_1`, `REDACTED:email_1`)
  and the decision carries **counts only**; `assertNoContentInDecision` throws on content keys and URLs.
  The guard is wrapped around `baseAiEngine` **before** the resilient engine in `app.ts`, and the same
  wrapper is applied to the **second** engine instance in `worker.ts` (previously an unprotected path).
- **Vocabulary unification**: the guard now **imports** the authoritative `ProviderDataClassification` /
  `ProviderContentType` (aliased) and derives its ordering from `PROVIDER_DATA_CLASSIFICATIONS`. Legacy
  spellings map in exactly one place (`CONTENT_TYPE_ALIASES` + `toCanonicalContentType`: `file_list` →
  `files`, `web_content` → `web`, `text` → `prompt`), and canonical values now map **identically** — this
  was a real defect: `diff`, `code`, `logs`, `terminal`, `metadata` and `embeddings` used to return
  `undefined`, so a policy naming `diff` looked like "no such type".
- **Routing is filtered by the same resolver**: `production-resilient-ai-engine.ts` gained an additive
  `isModelEligible`; both `rawModels` arrays (chat and stream) are filtered **after** fallback models are
  resolved from their five different sources, so a forbidden provider is never even attempted. If nothing
  is eligible the run stops with `no_eligible_provider` (non-retryable) listing the rejected models and
  reasons instead of "try anyway". Without `isModelEligible` behaviour is unchanged.
- **One policy prefix**: `provider-data-policy-resolver.ts` is a **thin adapter** that delegates to the
  authoritative `resolveEffectivePolicy` (no own priority/defaults/staleness logic). `OutboundPolicySnapshot`
  caches the **raw store rows**, so every verdict is computed by the same function; unknown or unloaded
  state yields an **explicit** refusal (`outbound_policy_context_required`, `snapshot_refresh_failed:…`) and
  never a silent `null`. Eligibility calls the same resolver the engine guard uses, so "UI says eligible"
  and "routing filters" cannot diverge. `config.providerDataPolicyResolver`/`Eligibility` **no longer exist
  anywhere**; the snapshot refreshes on start, on a 60 s timer and on **every policy mutation** (a Proxy in
  `app.ts` invalidates it).
- **Outbound exfiltration guard** (`outbound-exfiltration-guard.ts`) wired into **all six channels**:
  web search, web fetch, web crawl (**including `Crawl4AIProvider`, which until now used a direct `fetch`
  bypassing everything**), MCP, email and webhooks (after the C4b/C5 destination policy), plus messaging
  through a Proxy over every adapter. Delivery channels (email, webhook, messaging) **deny** on a secret
  rather than redact (a placeholder would still travel as content); retrieval channels may redact by policy;
  a secret in the **URL** always denies. A `restricted` project sends nothing through any channel. Decisions
  carry metadata only, and each channel has a **positive path** test so the mechanism cannot "protect" by
  breaking legitimate traffic.
- **Placeholders can never be written to disk**: `assertNoPlaceholderInWrite` is called **before** the write
  in `applyEdit`, in `writeFileSafe` (before `stat`/`read`, so a refusal has no side effects) and in
  `applyPatch` as a **separate pass over the whole plan before the first write**, so a refusal cannot leave a
  partially applied patch.
- **Management, RBAC, versions, audit, transparency**: eight `apiVersion: "v1"` routes
  (`GET|PUT …/code/data-policy/providers`, `…/versions`, `GET|PUT …/projects/:projectId`,
  `POST|DELETE …/hosted-consent`, `…/eligibility`). Changing provider policy, lowering a project's
  classification and hosted consent require the **privileged** `code.policy.manage`, which now lives
  **explicitly** on `owner` in `DEFAULT_COMPANY_ROLE_MATRIX` (a wildcard never reveals it) — the earlier
  separate "owner authority" fallback was **removed** so there is one mechanism, not two. Every change
  bumps `policy_version`, writes an append-only snapshot, is audited **before** it is applied (fail closed)
  and emits a `provider_policy_decision` Activity event containing **field names only**. Tenant isolation is
  enforced per `companyId`. **Effective project classification is the strictest of the two sources** (the
  C5b row and the C1 project record): neither may lower the other, an unreadable project record counts as
  `confidential`, and lowering is evaluated against the effective value. UI: `CodeDataPolicyPanel.tsx`
  (providers, stale >180 days warning, hosted-consent state, project classification and path rules,
  eligibility table) inserted into `CodeSettingsPage.tsx`.

## Verification (C5b)
- `npm run typecheck` → **exit 0** (all workspaces including `apps/web`); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=739 failed=0 skipped=0 todo=0`** with **49** security-gate
  suites (`suite files: present=49 missing=0`) and all four steps green.
- Real defects found and fixed while closing the step (none by weakening a check):
  1. **the policy did not affect what reached providers** — `providerDataPolicyResolver`/`Eligibility` were
     read from a `config` that has no such fields, so the guard applied the conservative hosted default to
     **every** request: the configured policy had no effect at all (the same "module exists, enforcement
     does not read it" failure as protected branches in C5a);
  2. **redaction was a silent no-op** — the policy names redaction kinds in the **plural**
     (`secrets`, `tokens`, `keys`, `internal_hostnames`) while the scanner emits the **singular**, and a
     type cast (`as`) hid the mismatch, so a policy requiring redaction could never match any kind; now a
     single bridge (`REDACTION_KIND_FROM_POLICY`) and the test asserts the **effect** (the canary does not
     arrive) rather than the field's presence;
  3. **the guard's context contract was broken**: `AIEngine.chat(request)` takes only the request, so a
     caller could not pass `policyContext` positionally, and every such call was refused with
     `provider_policy_context_required` — the mechanism appeared to **block legitimate work**; both forms
     are now accepted, with `request.policyContext` as the C6 contract;
  4. **`toCanonicalContentType` was not total** — canonical values returned `undefined`;
  5. `conservativeHostedPolicy` declared `["text"]`, a content type the policy vocabulary does not know;
  6. the messaging wrapper threw **synchronously** while adapters return promises and several call sites use
     `.catch(...)`, so the refusal would have bypassed their error handling;
  7. the "is this code" heuristic treated **any JSON ending in `}`** as code, which would have sent every
     legitimate webhook or automation payload to approval;
  8. three C5a assertions still described the previous design ("no role has a privileged permission"); they
     now assert the truth and **more**: no role receives a privileged permission **implicitly**, and exactly
     `owner` names exactly `code.policy.manage`.

## Real E2E status (C5b)
- Verified in-process with injected stores, policies, resolvers and mock engines: the positive path (an
  allowed self-hosted provider receives private code), every refusal, redaction end to end, the routing
  filter, the placeholder write hook, the policy routes and the RBAC matrix.
- **Not verified here:** migrations **070–074** against a live PostgreSQL, the C4b live Docker egress E2E,
  a real provider call with a real policy row, the UI in a browser, and the GitHub CI job (never executed).
- **Enforcement is off by default** (`NPATI_CODE_PROVIDER_DATA_ENFORCEMENT`): existing Chat/Company/Email
  traffic does not pass `policyContext` yet, so enabling it now would block legitimate non-coding traffic.
  The first real caller is `CodingAgentRunner` in **C6**, which must set the snapshot's active context.

## Known risks / open questions (C5b)
1. **`require_approval` in the outbound guard does not create a real approval** — it refuses with
   `approval_required` (403) and sends nothing (fail closed); wiring it to the existing approval system is
   `TODO(C6)`.
2. **Messaging has no per-call project context** (the gateway is global), so it relies on the snapshot's
   active context, which **C6 must set**; the other channels pass company/project explicitly.
3. **Two sources of project classification remain** (`projects.data_classification` from C1 and the C5b
   table); they are reconciled fail-closed (strictest wins) but the duplication itself is debt worth
   collapsing when R1 lands.
4. `data_classification`/`retention_class` still exist only on projects and code sessions — tool results,
   logs, checkpoints and artifacts are not labelled yet (R1 scope; C5b labels only what goes to a provider).
5. Approval payloads carry **file content** and are stored (hashed); they are never provider input, but
   their classification/retention belongs to R1 and should be reviewed there.
6. The `artifacts/**` probe harnesses are git-ignored verification aids; deleting them removes the only
   executable proof for agents whose sessions cannot run vitest.
7. `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT` must not be enabled before C6 passes `policyContext` from the
   runner, otherwise legitimate Chat/Company/Email traffic is refused.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C6), `docs/coding-agent/00-audit.md` sections 11 and 13, and this
  file.
- Execute **only C6**: the own agent loop (`CodingAgentRunner`) with its own tool cycle, action schema,
  limits, context assembly, `policyContext` on every model call, the active-context snapshot for outbound
  channels, streamed Activity events and turn-level idempotency.
- Keep all earlier guarantees intact: commands only through the sandbox port, the PolicyEngine decides
  (hard deny > session mode > project rules > network gate > approval; the required permission is derived
  from the action), one-shot SecretLease with revocation, no lifecycle scripts without approval, sensitive
  changes always require approval, agents never approve and never change policy, nothing reaches a provider
  outside `ProviderDataGuard`, and every new suite goes into `scripts/run-security-gate.mjs`.
- **Before any production promotion:** run migrations 070–074 against a live PostgreSQL and execute the C4b
  live Docker E2E checklist; then, and only then, consider `NPATI_SANDBOX_EGRESS_ENFORCED=true` and
  `NPATI_CODE_PROVIDER_DATA_ENFORCEMENT=true`.
- Still open from C5a: whether the four file actions in the standing-rule allow list should become
  approval-gated, and whether to replace the remaining ad-hoc admin checks in non-code modules.
- Do not start C7 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C5a, latest step)
- **One server-side authorization point** (`code-rbac.ts`), deny by default. The role matrix is
  **injected data** (`createRoleRegistry(matrix)`; `DEFAULT_CODE_ROLE_MATRIX` is a separate exported
  constant whose human roles are spread from `DEFAULT_COMPANY_ROLE_MATRIX`), so the owner's role model is
  configuration, not code. `authorizeCodeAction` returns a decision or throws `CodeRbacError`
  (`code`, `httpStatus: 403`, `details.reason`, `retryable: false`).
- **Privileged permissions cannot leak through a wildcard**: `code.prod.operate`,
  `code.policy.manage`, `code.trust.manage`, `code.rbac.manage` are granted
  only when a role names them explicitly; `*`/`admin:all`/`owner` expand only the ordinary vocabulary, and
  `code.prod.operate` is in **no** default role (tested across every role). `permissionsForRole` now really
  strips the privileged half of a `*` expansion (it was a tautology before — and `code-step-up.ts` trusted
  its output). `code.git.protected_write` left this vocabulary in C11: nothing ever asked for it and the
  write it appeared to authorise is a hard deny for every principal, so a permission that could neither
  protect nor lift anything was removed rather than kept as decoration.
- **Principal invariants**: an agent is never an approver and never changes policy (even with
  `owner` + `admin:all`); a service identity never approves and never performs production operations;
  `CODE_NEVER_GRANTED` actions are refused for every role and wildcard; `classifyPrincipal` now lives in a
  leaf module (`code-principal.ts`) with exact `agent:`/`service:` prefixes, so `u-agent-manager` is a human
  (the old substring match treated it as an agent).
- **The required permission is derived from the action** (`CODE_ACTION_PERMISSIONS` +
  `requiredPermissionForAction`), evaluated after the principal invariants and before production/grant:
  an unknown action is `action_not_mapped` (deny by default) and a mismatched label is
  `permission_action_mismatch` (with `details.expected`/`details.provided`) instead of silently authorizing
  by the caller's label. All existing call sites already passed a consistent pair; no route needed fixing.
- **Company membership is real authorization** (migration `072_code_company_membership_and_invites`):
  `company_members` (`owner|admin|developer|reviewer`, status, revision) and `company_invites`
  (sha256 token, TTL, single use). `CodeMembershipService` + `code-membership-routes.ts` (7 `apiVersion`
  routes) with audit **before** applying and fail closed; no membership → role `null` → deny (never "owner
  by default"); `last_owner_protected`; a stale revision is `membership_revision_conflict` 409 with
  `details.actualRevision`. Backfill is deliberately conservative: only a **single** workspace owner per
  company becomes `owner`, otherwise nothing is inserted (`TODO`).
  **An admin can no longer grant the `owner` role** (`owner_role_requires_owner`,
  `admin_role_requires_owner`) — that was a real admin→owner escalation.
- **Protected branches** (`code-protected-branches.ts`, migration `073_company_protected_branches`): the
  policy is company-scoped and is now **read by enforcement** (`code-policy-engine.ts:431`, phase 4b,
  port wired at `app.ts:1348`, sharing `detectGitWriteAttempts()` with the classifier). Phase 4b runs
  **before** session mode, project rules, the network gate and approval, and reads neither permissions nor
  role nor `approved`/`approvalId` nor standing rules — so an **agent push into a protected branch is a hard
  deny for everyone including owner** (`protected_branch_write_denied`), force push is `force_push_denied`,
  and a push to an unprotected branch stays `approval` and is never automatic. Proof that the company list
  is what is read: with the policy saved as `["production","release"]`, `git push origin production` is
  denied while `git push origin main` is `require_approval`. Only `owner` may change the policy, only
  outside an agent session (`agent_cannot_change_protected_branches`), any body field outside
  `branches`/`expectedRevision`/`challengeId` is `protected_branch_policy_input_rejected`, the module reads
  no files, and the audit records `repositoryContentConsulted: false`. Store unavailable → conservative
  default (`main`/`master`/`release`) for decisions and 503 for changes.
- **Session modes** accept the canonical `plan`/`ask`/`auto_edit`/`full_auto_sandbox` (legacy C1 spellings
  normalized, `full_auto` → `full_auto_sandbox`), and authorization comes from
  `DEFAULT_CODE_SESSION_MODE_MATRIX`: owner/admin get all four, **developer gets `plan`/`ask`/`auto_edit`**
  (the plan's intent, previously unreachable), others `session_mode_not_permitted`. Persistence keeps the C1
  spelling (the `code_sessions.mode` CHECK was not altered).
- **Denials are audited** in the people-side modules (`code.membership.*.denied`,
  `code.session.mode_change.denied`, `code.project.trust.denied`, each with `decision: "deny"`); the audit is
  best effort for denials so a failing journal cannot change the refusal, while fail-closed remains for the
  mutations themselves.
- **`code.prod.operate`** (`code-prod-operations.ts`, `code-step-up.ts`): not in any default role and not
  reachable by wildcard; agents and service identities are always refused; execution goes only through a
  `ProductionExecutor` whose default is a `Null` executor (`production_executor_unavailable`, 503); payloads
  carrying secrets (`production_credentials_not_allowed`) or sandbox/shell keys
  (`production_operation_cannot_use_sandbox`) are rejected. **Step-up is the default** (request → confirm →
  require → consume, both steps audited with the same `payload_hash`, cooldown, grant consumed before
  execution), **two-person is configuration** (different confirmer, same payload hash, TTL, no replay) and on
  a single-owner instance it fails explicitly with `two_person_confirmer_required`.
- **Automations run as a service identity**: the inventory in `docs/coding-agent/c5a-automations-inventory.md`
  produced an explicit permission allowlist (5 permissions); configuration can only narrow it; production,
  privileged and wildcard entries are rejected; a permission outside the allowlist is
  `automation_permission_not_allowed`. A verified finding shaped the design: `assertCompany` resolves the
  company by `workspace_id + user_id`, so replacing `userId` would have broken every automation — the owner
  therefore stays in `userId` for tenancy while `externalSubject = service:automation:<id>` carries the
  principal, which grants **no** permission beyond the allowlist.
- **Approval decisions are now written to AuditLog** before being applied (the C5 audit finding), and
  `approvals-repository.ts` gained an additive `audience: "self" | "role"` path (default `self`, so existing
  self-only behaviour is unchanged) with self-approval forbidden for the two-person path; the audience
  metadata is excluded from `payload_hash`, so existing approval suites are unaffected.
- **Scoped approval rules are restricted to allow-listed actions at both scopes** (per the owner's decision,
  extended to `session` because the risk does not depend on the scope): allowed are `code.fs.edit/write/move`,
  `code.verify.run` and shell commands free of network, credential, dependency and git-write markers; denied
  are `code.fs.delete`, `code.deps.add/install/update`, `code.git.push`, `code.secret_lease`,
  `code.network.allowlist.add`, `code.migrations.run`, `code.deploy.release`, `code.project.trust`,
  `code.session.mode` and every matching pattern. A refused scope **creates no row** (checked before audit and
  before insert); `once` still works for every privileged action; hard deny is unreachable through any scope.
- **SG-2** (`tests/coding-agent-c5-approval-bypass.test.ts`) plus the new C5a suites pin reason code and phase:
  hard deny under all modes with a rule and `approved: true`, the approval class never automatic, `plan`
  read-only even with a rule, the network gate not bypassable by approval, an agent never an approver,
  `payload_hash` substitution → `approval_invalid`, foreign rules inert, **role downgrade mid-run stops the
  actions** (the role is re-read on every tool call — no per-run cache), reviewer read-only, developer
  escalations via API / file content / project rules, and the `code.prod.operate`/wildcard/membership
  invariants above.

## Verification (C5a)
- `npm run typecheck` → **exit 0** (all workspaces); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=614 failed=0 skipped=0 todo=0`** with **42** security-gate
  suites (`suite files: present=42 missing=0`) and all four steps green; the gate now also verifies that
  every configured suite file exists.
- Real defects found and fixed while closing the step (none by weakening a check):
  1. missing audit journal **did not block** authorization for ordinary actions — a call could be
     authorized with no audit at all (now `audit_unavailable` 503 for every decision);
  2. **admin could grant the `owner` role** (admin→owner escalation);
  3. the **privileged filter in `permissionsForRole` was a tautology**, so the documented "wildcards never
     reach the privileged space" did not hold there while `code-step-up.ts` trusted that output;
  4. **authorization used the caller-supplied permission label** and never derived it from the action, so an
     inconsistent pair was allowed (now `permission_action_mismatch`, unknown action `action_not_mapped`) —
     and a test had been **pinning that very hole** as `allowed: true`;
  5. **a plain `git push` into a protected branch was `approval`**, not hard deny: the policy module existed
     but enforcement never read it (now phase 4b reads the company policy);
  6. `isAgentActor` matched the **substring** `agent-`, so a user like `u-agent-manager` was treated as an
     agent; `isProjectTrusted`/membership role lookups had the same class of assumption;
  7. a real SQL bug in migration 072 (backfill read a non-existent `company_id` column from
     `workspace_members`, which would have failed `initialize()` on any database);
  8. `isForbiddenIp`-style ambiguity in the SSRF layer (C4b) and, in C5/C5a, several test-side
     over-specifications that would have made CI pass or fail for the wrong reason (a `toEqual` on a full
     audit record; a loop iteration that could never pass; a case pinning the label-vs-action hole).

## Real E2E status (C5a)
- Verified in-process against the real stores (in-memory), services, engine and route handlers (the routes
  via an injected store and a fake Fastify instance).
- **Not verified here:** migrations **070–073** against a live PostgreSQL (no database in this environment —
  compile-time and in-memory semantics only), the C4b live Docker egress E2E, any real Fastify HTTP server,
  and the GitHub CI job (still never executed).

## Known risks / open questions (C5a)
1. **Standing rules for the four allow-listed file actions are inert at the policy level** (confirmed twice,
   by code and probe): `findRule` is called only from `requireApproval`, and the only approval-gated
   capabilities are `code.fs.delete` and `code.deps.add`, both on the deny list. The only observable effect
   of `approve for project/session` today is **shell commands**. Either those file actions become
   approval-gated later or the allow list should be treated as declarative — a decision for the owner.
2. **`agent-api` is fail-closed for network-dependent work** until the runner reports `overall_ready: true`
   (C4b readiness is remote); the first network command of a session is refused until the first successful
   probe.
3. **Messenger approvals remain notification-only** (`TODO(C5a)`): no proof of identity for the decision, no
   AuditLog entry per decision, no replay protection, stale permission snapshots — see
   `docs/coding-agent/c5-messenger-approvals.md`.
4. **Non-code modules still use ad-hoc admin checks** (`["*","owner","admin:all"]`): a2a, automations,
   browser-automation, integrations, messaging-integrations, multimodal, data-studio, project-*, memory,
   api-keys, ai-routes, content-library, scoped-memory, company-* — out of C5a scope, explicitly listed.
5. **`code-approval-scope.ts:470`** still contains one ad-hoc admin check the RBAC sweep did not reach.
6. `ProjectCapabilityRules` remains a boundary adapter (`{ allow?, deny? }`); C5a did not find a conflicting
   project/company rules interface, so no separate persistent policy system was created.
7. `notifyAutomation` still uses `ownerUserId` for its messaging lookup (notification targeting, not
   authority); moving it needs a company+agent repository method.
8. `code-membership-routes.ts`'s documented code list and `ROUTE_ERROR_STATUS` do not yet mention
   `owner_role_requires_owner`/`admin_role_requires_owner`/`session_mode_not_permitted` (the HTTP status is
   still correct because the errors carry `httpStatus`).

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C5b), `docs/coding-agent/00-audit.md` sections 10 and 13, and this
  file.
- Execute **only C5b**: ProviderDataPolicy — nothing reaches a provider outside `ProviderDataGuard`, fallback
  and subagents do not bypass the policy, and each stored entity carries `data_classification` and
  `retention_class` from creation (R1 defines the classes; C5b wires the guard).
- Keep the C4/C4a/C4b/C5/C5a guarantees intact: commands only through the sandbox port, the PolicyEngine
  decides (hard deny > session mode > project rules > network gate > approval; the required permission is
  derived from the action), one-shot SecretLease with revocation, no lifecycle scripts without approval,
  sensitive changes always require approval, agents never approve and never change policy, and every new
  suite goes into `scripts/run-security-gate.mjs`.
- **Before any production promotion:** run migrations 070–073 against a live PostgreSQL and execute the C4b
  live Docker E2E checklist; without them the release is not production-ready.
- The owner's open decisions from C5a: whether the four file actions in the standing-rule allow list should
  become approval-gated, and whether to replace the remaining ad-hoc admin checks in non-code modules.
- Do not start C6 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C5, latest step)
- **Session modes and the decision pipeline** build on the C4 PolicyEngine instead of replacing it: two new
  phases were added — `capability_groups` (**3b**, before risk and approval, so an agent without the
  capability group never reaches an approval prompt) and `trust` (**3c**). Hard deny, the mode × risk
  matrix, the separate `network_enforcement` gate and the order of the existing phases are unchanged.
- **Approval scopes**: additive migration `070_code_approval_rules` (`scope CHECK (session|project)`,
  `decision CHECK (allow)`, CHECK anchors tying a rule to its session/project, unique index for upsert plus
  lookup indexes). `once` (default) creates no rule and keeps the approval bound to one `payload_hash`;
  `session`/`project` create a rule with priority `session → project`, expired rules never match, and a
  session rule now requires **both** session and project to match (found by a probe: the same session id
  could otherwise leak into another project). Rules are consulted **only** inside the approval phase, i.e.
  **after** hard deny, session mode, project rules and the network gate; a rule for a hard-deny action
  cannot be created (`hard_deny_not_approvable`) and an existing row is ignored. `deny` with a comment
  returns the comment to the **model** (`approval_denied`, `details.comment`, `CredentialMasker` redaction,
  500-char cap, `trust: "untrusted_data"`). Approval timeout (`NPATI_CODE_APPROVAL_TIMEOUT_MS`, default
  15 min, clamp 60 min) **stops** the action with `approval_timeout` (504, `retryable: false`). Routes
  `GET/POST/DELETE /companies/:companyId/code/approval-rules` (`apiVersion`, owner/admin, audit **before**
  applying, fail closed).
- **Project trust and prompt injection**: trust lives in its own additive table `project_code_trust`
  (`071_code_project_trust`, plus an additive `code_sessions.revision`) so no existing `projects` query or
  type changed; `trust`/`revoke` are owner/admin only, audited **before** applying and fail closed without
  the journal. Repository instructions (`NPATI.md`, `AGENTS.md`, `CLAUDE.md`, any file) are **data** and
  change no state; they are usable as *work content* only after explicit trust, and even then cannot change
  mode, rules, allowlist, tools or approvals. `code-prompt-injection-guard.ts` has 15 rules and pure
  functions: `appliedPolicyChanges` is always `[]` and `repositoryContentCanChangePolicy()` is always
  `false` (three `tool_change` patterns were added when a probe proved "grant yourself the code.shell tool"
  was **not** detected).
- **Only the user changes the mode**: `PUT …/code/sessions/:sessionId/mode` (owner/admin, audit, revision
  check, `mode_revision_conflict` 409); the model gets `agent_cannot_change_policy` and can only
  `POST …/mode/suggest`, which records a proposal without changing anything. Because the route contract
  needs a synchronous auth context while authentication is asynchronous, `app.ts` installs a
  path-scoped `preHandler` writing into a `WeakMap` (no second authentication on other routes).
- **Capability groups via the existing mechanism**: `code.read`/`code.write`/`code.shell` (and a reserved
  `code.git`) map onto the 22 `code.*` capabilities; `effectivePermissions` is the **intersection** of the
  agent's groups, the user's permissions and the project rules, and `assertCapabilityGranted`
  (`capability_not_granted`, 403) runs in phase 3b. A probe found a real hole: empty user permissions were
  treated as "no narrowing", so an agent with `code.write` gained rights the user never granted — now fail
  closed (only `code.*` is a wildcard, and it does not create a group the agent lacks).
- **Decision activity**: `policy-decision-activity.ts` records `{ kind: "policy_decision", … }` with **who**
  (actor/actorKind/agentId/approvedBy), **what** (tool/action), **which mode**, **which rule**
  (`ruleRef`), **which result** (decision/code/phase) — no commands, file content, headers or URLs, with a
  throwing `assertNoSensitivePolicyDecision` and per-phase/per-code/per-rule counters. The engine records
  through an additive wrapper (`evaluate()` → `evaluateInternal()` with the phase order untouched, then the
  recorder in `try/catch`): a failing recorder **never** changes the decision. The real run-Activity stream
  and `ExecutionSnapshot` remain `TODO(C6)`.
- **SG-2** (`tests/coding-agent-c5-approval-bypass.test.ts`) asserts reason code **and** phase so a
  regression cannot pass as "still denied, but for another reason": hard deny under all four modes with an
  allow rule and `approved: true`, path traversal and `.git`, the approval class never auto-running,
  `plan` staying read-only even with a rule, the network gate not bypassable by approval (503), an agent
  principal never being an approver, `payload_hash` substitution → `approval_invalid`, foreign rules not
  applying, and untrusted content creating no rules.
- **Messenger approvals** (owner-optional item): audited in `docs/coding-agent/c5-messenger-approvals.md`
  and **deliberately not implemented**. Adapters, pairing and `/approve` commands exist and email enforces
  authenticated senders, but there is no proof of identity **for the decision itself**, no AuditLog entry
  with `request_id`/`payload_hash`, no replay protection, and permission snapshots go stale — so messengers
  stay notification-only behind `TODO(C5a)`.

## Verification (C5)
- `npm run typecheck` → **0 errors** (all workspaces); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=450 failed=0 skipped=0 todo=0`** with **35** security-gate
  suites and all four steps green (vitest, tool schemas, sandbox images, typosquat datasets); every path in
  the gate list exists (`missing_count = 0`).
- Existing NPATI approval suites (`human-approvals`, `production-durable-approvals`,
  `production-security-guardrails`) do not construct `PolicyEngine` at all, and the C4 suites that do are
  compatible by construction (the new dependency is optional) — confirmed by reading, not by a run.
- Real defects found and fixed (none by weakening a check): empty user permissions granting rights the user
  never gave; a session-scoped rule matching on session alone; the `tool_change` detection gap for "grant
  yourself the <id> tool" / "you may now use …"; and two probe-only expectation bugs (a closed network gate
  in approval-class cases, and the actual `CredentialMasker` label) that would have made CI pass or fail for
  the wrong reason.

## Real E2E status (C5)
- Verified in-process against the real store implementations, services, engine and routes' contracts.
- **Not verified here:** migration `070`/`071` against a live PostgreSQL (no database in this environment —
  compile- and in-memory-semantics only), real Fastify request context for the session-mode routes, and any
  real messenger round trip (deliberately out of scope).

## Known risks / open questions (C5)
1. **`requiresProjectTrust`/`repositoryInstructions` plumbing is ready but no caller fills them yet** — the
   signal comes from the C6 agent read loop, so trust currently gates nothing in practice; this is a
   deliberate `TODO(C6)`, not an imitation of enforcement.
2. `ProjectCapabilityRules` is the adapter type `{ allow?, deny? }`; if another project-rules interface
   exists, it must be reduced to this shape (isolation is guaranteed by passing rules per request together
   with `companyId`/`projectId`, not by storing them in the module).
3. The `code.git` capability group is reserved and empty until a later step.
4. Messenger approvals stay disabled until RBAC with a live role, an AuditLog entry per decision and a
   challenge bound to the decision exist (`TODO(C5a)`).
5. Which actions may be granted by default through `approve for project` is an **open owner decision**; today
   `project` scope grants exactly the action it was approved for and never a hard-deny action.
6. Migrations `070`/`071` have never run against a real database here, so their SQL is not yet proven.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (section C5a), `docs/coding-agent/00-audit.md` sections 9 and 13, and this
  file.
- Execute **only C5a**: RBAC enforced server-side for every action (effective rights = agent capability
  groups ∩ user role ∩ project rules), the agent and its token can never be an approver, and RBAC becomes
  the gate for allowlist/policy changes — which closes the two `TODO(C5a)` items from C4b (proxy-side audit
  into the real AuditLog and allowlist routes behind approval + RBAC).
- Keep C4/C4a/C4b/C5 guarantees intact: commands only through the sandbox port, the PolicyEngine decides
  (with the network gate driven by the runner readiness probe), one-shot SecretLease with revocation, no
  lifecycle scripts without approval, sensitive changes always require approval, hard deny is unbypassable,
  and every new suite is added to `scripts/run-security-gate.mjs`.
- Still pending from C4b: the live Docker E2E checklist before enabling egress enforcement in production.
- Do not start C5b in that session; the order in `00-audit.md` section 13 is binding.

## Owner decisions applied to C4b (second pass)
- **Webhook transport is its own destination policy**, never the web-fetch allowlist: the allowed
  destination is the webhook endpoint explicitly saved by a user/Company, matched by exact scheme +
  hostname + port, with no wildcard allow of any kind; the URL passes SSRF validation **on save** (and is
  refused, not stored, if it fails), DNS/IP validation is repeated **on every delivery**, private/internal/
  metadata/Docker/NPATI targets are always blocked, redirects are disabled by default (if ever supported,
  every hop must pass the full re-validation and policy check), and delivery uses the **same shared
  SSRF-safe client** — no second implementation.
- **No new default allowlist hosts.** Install keeps only the agreed official registry endpoints; the
  build/run phase defaults to **deny all** (the git hosts that used to sit there were removed). Additional
  hostnames are added after C5/C5a only as a project/company rule through RBAC → approval → AuditLog
  (a developer may propose, an owner/admin confirms); no broad wildcard hosts for convenience.
- **Readiness source of truth is the runner** (it owns Docker and the sandbox), so the docker daemon probe
  is **not** duplicated in `agent-api`. The runner exposes an **authenticated readiness endpoint** returning
  `docker_ready`, `egress_proxy_ready`, `network_policy_ready`, `dns_policy_ready`, `required_images_ready`
  and `overall_ready`; `agent-api` checks it before any network-dependent execution with a short cache
  (≤30 s) and fails closed with `network_enforcement_unavailable` when the runner is unavailable or
  `overall_ready !== true`. The env flag is never proof of readiness.
- **Live Docker E2E is the gate for production enablement** (owner checklist): direct internet bypass
  blocked; `HTTP_PROXY` unset does not bypass enforcement; external DNS blocked; direct IP blocked;
  private/internal/metadata targets blocked; cross-sandbox access blocked; redirect to a private IP blocked;
  a DNS-rebinding probe blocked; an allowed registry works during fetch/install; build/run network stays
  disabled where the policy requires it; the egress proxy stays healthy under basic concurrent load.

## Implemented (C4b, latest step)
- **Default-deny by topology, not by variables**: each run network is created `--internal` with
  `gateway_mode_ipv4=isolated`, so there is no route out; the only container attached to both the internal
  network and the outside bridge is the NPATI egress proxy (`egress`), and the sandbox joins only
  `npati-net-<id>`. Unsetting `HTTP_PROXY`/`HTTPS_PROXY` cannot restore egress. **Honest limitation:** no
  nftables/host firewall was added — the mechanism is Docker network topology; UDP/ICMP are unreachable
  because the only peer is the proxy, and IPv6 egress is denied (`family: 4` only).
- **The proxy is the single policy point** (`sandbox-egress-proxy.mjs`, extended, not duplicated):
  hostname allowlist (exact or `*.domain` = exactly one label; `evil.npmjs.org.attacker.com` and
  `npmjs.org.attacker.net` fail, wildcard apex fails), **IP literals never allowed**, every encoding
  normalised (decimal/hex/octal/mixed/trailing dot/`[::ffff:…]`/`::1`) with ambiguous leading-zero forms
  denied, the full forbidden-range list plus forbidden names (`localhost`, `metadata*`, `postgres`,
  `postgres-projects`, `agent-api`, `egress`, `sandbox-runner`) even if listed, resolution inside the proxy
  with **all** answers validated, **pinning** to the validated address with re-validation per connection
  and a short TTL cache, SNI-pinning against domain fronting, ports 80/443 (22 for allowlisted git hosts),
  redirect limit 5 with full re-validation per hop, structured `egress_denied` decisions plus an audit hook
  (AuditLog itself is `TODO(C5a)` — the proxy has no database access).
- **Readiness probe** (`sandbox-egress-enforcement.ts`): 60 s TTL cache, **three factual checks** (proxy
  health, direct egress from the run network fails, DNS outside the proxy fails), structured reasons
  (`proxy_unhealthy`, `direct_egress_open`, `dns_bypass_open`, `probe_unavailable`, `probe_not_configured`,
  `disabled_by_configuration`), `assertEnforced()` → `network_enforcement_unavailable` (503, retryable),
  called **before** creating any workload container. **`NPATI_SANDBOX_EGRESS_ENFORCED=true` is not proof**
  (owner decision): `agent-api` reads the last **verified** report synchronously and refreshes it in the
  background, so network commands are refused until the first successful probe; `=false` is a kill switch.
  The docker probe lives in the runner process (the only one with docker access) — a documented seam.
- **One shared SSRF-safe HTTP client** (`ssrf-policy.ts`, `ssrf-safe-http.ts`) for every path that can
  receive a URL from a model or user: own DNS resolution, **pinning** with the original SNI/`Host`,
  re-validation of every redirect in the same budget, stripping of `authorization`/`cookie`/
  `proxy-authorization`/`x-api-key` on a host change, size (413) and own deadline (504), 30 s resolution
  cache, `dns_rebinding_detected`. `web.fetch`/`web.crawl`/search pages go through the same policy via an
  injected validator (additive parameter in `packages/web-research`, default unchanged). The authority is
  validated **before** WHATWG normalisation, so `http://08.0.0.1/`, `http://010.0.0.1/` and
  `http://0177.0.0.1/` are refused like `http://127.0.0.1/` and never reach the transport.
- **Allowlist and activity**: `egress-allowlist.ts` is the single source (install and run sets differ; the
  build phase has no network at all), with official registry defaults, an additive strictly validated
  operator override, strict wildcard semantics, and `EgressAllowlistManager` requiring owner/admin with an
  audit entry written **before** the change is applied (fail closed; routes are `TODO(C5a)`).
  `network-activity.ts` records one `network_decision` per decision (host, port, phase, action, code,
  resolved IP, bytes, duration) with **no** headers/body/query/URL, redaction via `CredentialMasker` and a
  throwing `assertNoSensitiveNetworkPayload`, plus per-company/phase summaries (real run-Activity and
  `ExecutionSnapshot` stay `TODO(C6)`); `network-routes.ts` exposes read-only state and a forced re-probe.
- **SG-1** now runs **27** security-gate suites plus four steps (vitest, tool schemas, sandbox images,
  typosquat datasets) and fails on any failure, `skipped`/`todo`, an empty report, a configured suite that
  did not run, or a suite that reported no tests at all.

## Verification (C4b)
- `npm run typecheck` → **0 errors** (all workspaces); both builds → **exit 0**.
- **`npm run security-gate` → exit 0: `passed=386 failed=0 skipped=0 todo=0`** with **30** security-gate
  suites and all four steps (vitest, tool schemas, sandbox images, typosquat datasets) green; the seven C4b
  suites pass on their own (**63+ tests**), and every path in the gate list exists (`missing_count = 0`).
- Second pass (owner decisions, all verified by the same run): the webhook destination policy (separate from
  web-fetch, exact scheme+host+port built from the stored endpoint, SSRF validation on save and DNS/IP
  re-validation on every delivery, redirects disabled, same shared client); install keeps exactly the ten
  approved registry endpoints while **run defaults to deny-all**; the runner readiness endpoint with six
  separate facts is the single source of truth for `network_enforcement` (short cache, fail closed); and the
  allowlist **single source of truth is now wired into the provider, the runner, the classifier and the
  proxy fallback list** — `github.com` in the run phase is denied with `egress_allowlist_empty`. A real
  defect was fixed on the way: the provider's allowlist validator **threw on an empty list**, so deny-all was
  physically impossible.
- **Real defects found and fixed** (none by weakening a check): the resolver TTL was treated as
  milliseconds although it is seconds, so the pinning cache lived 1 s instead of 30 and the DNS-rebinding
  protection was effectively disabled; `isForbiddenIp("08.0.0.1")` returned false (`08` parsed as decimal
  8 → public `8.0.0.1`), now the whole ambiguous leading-zero class is denied and never canonicalised;
  WHATWG normalised literals before the policy ran (`http://010.0.0.1/` became public `8.0.0.1`), so the
  authority is now validated before `new URL(...)`; the readiness probe split its JS payload on spaces;
  `EgressEnforcementError` passed `retryable` in the `step` slot; the DNS cache could not be reset on an
  allowlist change; two `it()` callbacks had `await` without `async`, so an entire security-gate file
  loaded with zero tests (caught by the `findEmptySuites` diagnostic added after the same class hit C4a);
  octal was not recognised as an address literal and returned the wrong refusal code.
- Machine-checked invariant: the shared client is never more permissive than the proxy — **1960 addresses,
  `permissive = 0`** (one deliberate stricter case: AS112 `192.175.48.0/24`).

## Real E2E status (C4b)
- Verified in-process with injected resolvers, transports and probes: the policy surface, pinning,
  redirect re-validation, header stripping, limits, the readiness probe and its failure modes, allowlist
  administration with fail-closed audit, and network decision records.
- **Not verified here:** live probes against a real Docker daemon, an actual topological default-deny (no
  container was started), a real DNS-rebinding attempt, real redirect chains through the proxy, proxy
  behaviour under load; the GitHub CI job has still never run.

## Known risks / open questions (C4b)
1. **Webhook transport semantics need a decision**: a tenant webhook URL is legitimately an arbitrary
   public host, so it needs its own allowlist/rules rather than the web-fetch list (the retry engine
   receives its transport by injection today).
2. **`agent-api` is fail-closed until a probe is injected**: the docker probe lives in the runner process,
   so the API refuses network commands until it has a verified report; sharing the verdict across processes
   is a deliberate follow-up.
3. No nftables/host firewall: isolation rests on Docker network topology, so the provider must keep
   creating the isolated network (host networking would silently remove the guarantee).
4. The proxy records allowlist changes to an audit hook, not the C1c AuditLog (no database access in that
   process); C5a must close this.
5. Additional install/run allowlist hosts are configuration, not code; an empty allowlist denies everything
   (intended).
6. `NPATI_SANDBOX_EGRESS_ENFORCED=true` must never be treated as readiness — anything reading that flag
   directly would reintroduce the gap the owner decision closed.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C5), `docs/coding-agent/00-audit.md` sections 8 and
  13, and this file.
- Execute **only C5**: policy engine, RBAC and project rules — effective permissions as the intersection of
  the agent's capability groups, the user's role and the project rules, enforced server-side; the agent and
  its token can never be an approver; allowlist/policy changes then go through approval + RBAC, which closes
  both C4b `TODO(C5a)` items (proxy-side audit and allowlist routes).
- Keep C4/C4a/C4b guarantees intact: commands only through the sandbox port, PolicyEngine decides (with the
  `network_enforcement` phase driven by the readiness probe), one-shot SecretLease with revocation, no
  lifecycle scripts without approval, sensitive changes always require approval, and every new suite added
  to `scripts/run-security-gate.mjs`.
- Early follow-up worth doing (not a C5 feature): add `tests/**` to type checking (`tsconfig.tests.json` +
  `typecheck:tests` in CI) — two separate blockers in C4a/C4b were test-file defects invisible both to
  `npm run typecheck` and to the vitest JSON reporter.
- Do not start C6 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C4a, latest step)
- **Install policy per package manager** (`code-deps-policy.ts`, fully env-configured): npm
  `npm ci --ignore-scripts --no-fund`, pnpm `--frozen-lockfile --ignore-scripts`, yarn
  `--frozen-lockfile`/`--immutable`, pip `--only-binary=:all:` (sdist → separate plan **requiring
  approval**), uv `uv sync --frozen --no-install-project`, poetry `--no-root`, composer
  `--no-scripts --no-plugins`, cargo `cargo fetch --locked` → `cargo build --locked --offline`, go
  `go mod download` + `go build -mod=readonly` with an allowlisted `GOPROXY`. **A lockfile is required**
  for npm/pnpm/yarn/uv/poetry/composer/cargo/go; lifecycle scripts are **never** run by install — they run
  only as a separate command for allowlisted packages and only after approval.
- **Two phases**: `fetch` runs with the network, `build` runs **without** it; if the runner cannot
  guarantee network isolation the build is refused (`network_isolation_unavailable`) instead of running
  online, and a plan with blocking problems never reaches the runner. `scrubbedEnvironment` drops every
  secret-shaped variable (GitHub/npm/AWS/Vault tokens, `SSH_*`, `PIP_INDEX_URL`, `KUBECONFIG`,
  `COMPOSER_AUTH`, `GIT_CONFIG_*`, …) and adds hardening (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/true`,
  `HUSKY=0`, `npm_config_ignore_scripts=true`, `GIT_LFS_SKIP_SMUDGE=1`). Git is hardened both by arguments
  (`core.hooksPath` to an empty dir, `protocol.file.allow=never`, `submodule.recurse=false`, empty LFS
  filters and credential helper) and by environment (`GIT_CONFIG_GLOBAL/SYSTEM` pointed at empty files),
  so **repository git hooks, submodules and filters never execute**.
- **Classifier extensions** (`code-shell-classifier.ts`): `curl|wget … | sh` and `bash <(curl …)` →
  `hard_deny`; installs from URL/git/tarball, registry reconfiguration, writes into registry config files,
  explicit lifecycle-script runs and `husky install` → `approval`; plus a `deps` hint
  (`{ manager, action, fromUrl }`) so the PolicyEngine does not re-parse the command. A documented finding:
  the Website Builder base policy returned `npm ci`/`cargo fetch --locked`/`pip install -r …` as
  **approval** (it concatenates raw words with args, so strict conditions never matched); a strict
  allowlist of reproducible install forms now downgrades only those to `controlled`, while
  `--registry=`, `--foreground-scripts` and URL forms stay `approval`.
- **Dependency guard** (`code-deps-guard.ts`): `checkDependency` **never** touches the network (metadata
  comes through an injected port). Registry outside the allowlist → `deny` (no lookup at all); package not
  found → `deny` (invented names); published less than 7 days ago (`NPATI_CODE_DEPS_MIN_AGE_DAYS`) → `deny`;
  typosquat (Levenshtein ≤2 to a popular package, or transposed letters, scope-aware) → `require_approval`
  naming the similar package; `hasInstallScripts` → `require_approval`; metadata failure →
  `require_approval` (never auto-allow). Sources other than the registry (`git`, `tarball`, `http`,
  `local_path`) and registry/index reconfiguration require approval.
- **Audit and secret scanning**: `code-deps-audit.ts` has own parsers for npm v7 and legacy, pip-audit,
  composer, cargo and osv-scanner; unknown/unparseable output is `parsed:false` with a bounded raw excerpt
  and **blocks** the commit (`audit_output_unparsed`), and a missing audit runner is `audit_unavailable`
  (503) — never "assume clean". `shouldBlockCommit` blocks automation on critical/high. `code-secret-scanner.ts`
  covers nine secret kinds, always redacts the preview, scans **only added lines** of a diff with the new
  file path and line number, and `assertNoSecretsInDiff` throws `secret_in_diff` (403) without the value.
- **Diff guard** (`code-diff-guard.ts`): CI workflows, Dockerfiles, git hooks, package-manager configs,
  dependency `sources`/`repositories` (including TOML tables such as `[[tool.poetry.source]]` and
  `[tool.uv.index]`) and lifecycle scripts (plus scripts that download and execute code) are **sensitive**
  and require approval in `ask`, `auto_edit` and `full_auto_sandbox` — they never pass automatically.
- **Three new capabilities** (inventoryIds **368–370**; counters now **370 total / 106 agent-callable**):
  `code.deps.inspect` (low, `code.read`), `code.deps.audit` (medium, `code.shell`), `code.deps.add`
  (**high, `requiresConfirmation: true`**, `code.shell`). Tool schemas: **22 tools, manifest v5**
  (frozen v4 checksum, `KNOWN_TOOL_MANIFESTS = [1,2,3,4,5]` so old sessions still resolve). The
  PolicyEngine adds a `deps` request field: a non-registry source, a registry reconfiguration or install
  scripts forces `require_approval` in **every** mode, including `full_auto_sandbox`; the
  `network_enforcement` phase, the mode × risk matrix and hard-deny are unchanged. Install and audit run
  through the single `codeShellRuntimePort`, so the PolicyEngine (and its network gate) always decides.
- **SG-1 CI gate**: `scripts/run-security-gate.mjs` (pure Node) runs a fixed list of **20** security-gate
  suites and fails on any failure, any `skipped`/`todo` (rule 12) or an empty report, then runs both guard
  scripts; exposed as `npm run security-gate` and added as a mandatory `security-gate` job in
  `.github/workflows/ci.yml` (no `continue-on-error`).
- No migration in C4a (policy, guards and scanning are stateless; the in-memory limitation from C4 stands).

## Verification (C4a)
- `npm run typecheck` → **0 errors**; both builds → **exit 0**;
  `code-tool-schemas-generate.mjs --manifest-version 5` → exit 0, `--check` → exit 0
  (`22 tool(s), manifest v5`); `verify-code-tool-schemas.mjs --check` → exit 0
  (`checksum ea9cf82b…d9f19`); `sandbox-image-verify.mjs` → exit 0;
  `typosquat-dataset-generate.mjs --check` → exit 0.
- **`npm run security-gate` → exit 0: `passed=287 failed=0 skipped=0 todo=0`**, with all four steps
  green (22 security-gate suites, tool schema guard, sandbox image guard, typosquat dataset guard). This
  is the SG-1 acceptance criterion and it is now a mandatory CI job; the gate also fails on any `skipped`
  or `todo` test (rule 12), on an empty report, on a configured suite that did not run, and on a suite
  that reported no tests at all (a file that failed to load).

## Owner decisions accepted and implemented (C4a)
1. **Typosquat dataset**: versioned curated datasets live in the repository, one per supported ecosystem
   (`data/typosquat/{npm,pypi,cargo,go,composer,maven}.json`) with `schemaVersion`, `ecosystem`,
   `datasetVersion`, `generatedAt`, `source` metadata, `hash` (sha256 of the canonical sorted name list)
   and `packageNames` (npm 87, pypi 62, cargo 70, go 57, composer 58, maven 56 entries; maven keys are
   `groupId:artifactId`, go entries are module paths). Runtime performs **no external ranking call**. If a
   dataset is missing, invalid, of the wrong ecosystem, hash-mismatched or stale
   (`NPATI_CODE_TYPOSQUAT_MAX_AGE_DAYS`, default 365) the guard returns **`require_approval` with
   `typosquat_dataset_unavailable:<reason>`** and never `allow`; the list is not hardcoded in the
   PolicyEngine (`popularPackages` remains an explicit test/admin override only).
2. **Registry allowlist**: conservative official defaults without wildcards — npm `registry.npmjs.org`;
   pypi `pypi.org`, `files.pythonhosted.org`; cargo `index.crates.io`, `static.crates.io`; go
   `proxy.golang.org`, `sum.golang.org`; composer `repo.packagist.org`; maven `repo.maven.apache.org`,
   `plugins.gradle.org`. An empty allowlist denies everything, hosts are never added automatically, the
   `NPATI_CODE_REGISTRY_ALLOWLIST` override is additive and rejects `*`/suffix patterns, and a host only
   matches exactly or as a subdomain of a listed host. The code carries an explicit note that **C4b must
   re-validate the redirect target against this same policy after DNS resolution**.
3. **`code.deps.*` flags stay under `code.shell`** (add/audit/inspect); no move to `code.write` and no new
   flag in this step.
4. **Network isolation unchanged**: `supportsNetworkIsolation: false` with fail-closed remains, with no
   workaround. **C4b must implement real enforcement** (`sandbox → enforced network policy → NPATI egress
   proxy → DNS/IP validation → destination`); `NPATI_SANDBOX_EGRESS_ENFORCED=true` **does not by itself
   prove readiness** — the SandboxProvider/runner must verify that enforcement actually works and
   otherwise return `network_enforcement_unavailable` before any execution starts. C4a is therefore
   **implementation-complete, with network-dependent real E2E gated by C4b**.

## Follow-up recommended for the next step
- Add `tests/**` to type checking (a `tsconfig.tests.json` plus `npm run typecheck:tests` in CI): the
  blocker that kept C4a red was a missing `import path from "node:path"` in a test file, invisible to
  `npm run typecheck` (which only covers workspace `src`) and invisible to the vitest JSON reporter. The
  gate now catches that class through `findEmptySuites`, but a real type check of tests would catch it
  earlier and more clearly.
- Real defects found and fixed while closing the step (none by weakening a check): five secret-scanner
  patterns lacked a capture group, so `match[1]` was `undefined` and those findings were **silently
  dropped** (a secret could pass unnoticed); a valid audit report with no vulnerability sections was
  treated as `parsed:false`, so `shouldBlockCommit` blocked **every commit on a healthy tree**;
  `detectDepsHint` did not recognise `husky install`, so the PolicyEngine saw no deps phase for git-hook
  installation; and TOML dependency sources were not detected, so a private index added through
  `[[tool.poetry.source]]`/`[tool.uv.index]` could have passed **without approval**. The gate script itself
  invoked the guards through a shell on Windows and broke on the space in `C:\Program Files\nodejs\node.exe`.

## Real E2E status (C4a)
- Verified in-process with fake runners and metadata ports: install plans and flags per manager, the two
  phases, scrubbed environment, git hardening, guard verdicts, audit parsers, secret scanning and diff
  decisions, plus the SG-1 gate end to end and both builds.
- **Not verified here:** a real install in a real sandbox (no Docker in this environment), real
  `npm audit`/`pip-audit`/`composer audit`/`cargo audit`/`osv-scanner` runs, a private registry through a
  SecretLease, and GitHub actually parsing the new CI job (the YAML was written by hand and has not been
  parsed by GitHub yet). No migration in C4a.

## Known risks / open questions (C4a)
1. **Popular-package list for typosquat detection** is configuration input, not a built-in dataset — it
   must be supplied (`NPATI_CODE_DEPS_POPULAR_PACKAGES` or the injected list) for the check to be
   meaningful.
2. **Registry allowlist** is configuration; an empty allowlist denies everything, which is the intended
   fail-closed default but must be filled before any install works.
3. `code.deps.audit`/`code.deps.add` are gated by `code.shell` (per the approved table) although
   `code.deps.add` is semantically closer to `code.write`; changing it is one line in
   `CODE_TOOL_FLAG_OVERRIDES`.
4. Install runs with `supportsNetworkIsolation: false` today, so any plan with a build phase is refused
   (fail closed) until C4b provides enforced network isolation.
5. `code.deps.inspect` uses a minimal manifest parser (package.json/composer.json/requirements.txt/go.mod/
   pyproject/Cargo sections) written at the app layer because the deps modules had no manifest parser.
6. `audit_blocked`/`shouldBlockCommit` are wired for commit/PR flows that arrive with C6; today the
   verdict is returned to the caller.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C4b), `docs/coding-agent/00-audit.md` sections 7
  and 13, and this file.
- Execute **only C4b**: enforced egress — proxy/firewall that the sandbox cannot bypass, allowlist per
  company/capability, re-validation after DNS resolution and after every redirect, SSRF and DNS-rebinding
  protection, and the `security-gate` tests proving an arbitrary host is unreachable while allowlisted
  registries and git hosts work. Then flip `NPATI_SANDBOX_EGRESS_ENFORCED=true`, which turns the current
  blanket network refusal into matrix-driven decisions.
- Keep C4/C4a guarantees intact: commands only through the sandbox port, PolicyEngine decides (with the
  separate network gate), one-shot SecretLease with revocation, no lifecycle scripts without approval,
  sensitive changes always require approval, and add the new suites to `scripts/run-security-gate.mjs`.
- Do not start C5 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C4, latest step)
- **Six new `code.*` capabilities** (inventoryIds **362–367**): `code.shell.exec` and
  `code.shell.process.start` (**high, `requiresConfirmation: true`**), `code.shell.process.list`/`logs`
  (low, read-only), `code.shell.process.stop` (medium) and `code.verify.run` (medium). Counters are now
  **367 total / 103 agent-callable / 264 runtime-only**.
- **A dedicated `code.shell` sub-flag**: shell tools are gated by `code.shell`, `code.verify.run` by
  `code.write`, and the base map still derives from `requiredPermissions`, so the operator can allow
  file edits while forbidding command execution. The Inspector receives **three** flag states
  (`code.read`, `code.write`, `code.shell`).
- **Command risk classification** (`code-shell-classifier.ts`), reusing the Website Builder policy
  (`terminal-command-policy.ts`) as the base and adding a fourth level: a full command parser (quotes,
  `&&`/`||`/`;`/`|`, redirects, heredoc, `$( )`, backticks, variables) plus `safe` / `controlled` /
  `approval` / **`hard_deny`**. `hard_deny` is unreachable by any mode and covers `rm -rf /`, fork bombs,
  `mkfs`/`dd of=/dev/*`, the docker socket, network/sandbox reconfiguration, host secret reads, writes
  outside the workspace and `curl|sh`; unknown executables default to **approval**, never safe.
  Read-only utilities and read-only git subcommands are downgraded to `safe` through an explicit
  allowlist guarded by a long forbidden-option list (`-c`, `--git-dir`, `--work-tree`, `-C`, `--output`,
  `--no-index`, `--force`, `--amend`, `--exec`, `-i`/`--in-place`, `-exec`, `-delete`, `sort -o`,
  redirects …), so `git status`/`diff`/`log` are safe while `git push`, `git commit`, `git reset --hard`
  and `git diff > /etc/passwd` are not. Allowlisted registries are `controlled`; any other host is
  `approval`. All seven documented bypass forms (`a && rm -rf /`, `$( )`, backticks, variables, heredoc,
  `;`, `xargs`) classify as `hard_deny`.
- **Shell runtime** (`code-shell-runtime.ts`): persistent cwd and **non-secret** env per CodeSession,
  120 s / 600 s timeouts, head+tail output limits, closed stdin with `interactive_command_not_supported`
  (detected from a real prompt-shaped output, not from any timeout — a real timeout is
  `command_timeout` 504 retryable), process-tree termination, and the only execution path is the injected
  sandbox port (no `child_process` for project commands; without the port, `sandbox_unavailable` 503).
- **`SecretLeaseProvider`** (`code-secret-lease.ts`): a lease is issued for **one tool call** against the
  existing Company credential store, carries a scope, minimal permissions and a TTL bounded by the call
  timeout, and the value is **never** returned in the object — the sandbox resolves it through
  `environmentReferences` (or a tmpfs file written by an injected port). One-shot `consume`, so a second
  call with the same lease id yields `secret_lease_inherited`; revocation happens in `finally` (success,
  failure, cancellation, timeout) plus a reaper; the shell session state holds no secrets (secret-looking
  env names are rejected before start); production credentials are refused conservatively; and `issue`
  writes `secret_lease.issue` to the AuditLog **before** the lease exists (no journal → no lease).
- **`CodeProcessManager`**: background processes with a ring log buffer and offset reads, `stop`/`stopAll`
  and per-session isolation; a background process that needs a secret requires its own approved lease.
- **`code.verify.run`** with `code-verify-parser.ts`: runs the project's own verify commands (from the C1
  toolchain) and parses `tsc`, `eslint`, `pytest`, `jest`/`vitest`, `go test` and `cargo` output into
  structured `findings`/`summary`, degrading to a bounded raw excerpt for unknown formats.
- **Wiring**: the executors receive ports; the canonical `CodeShellRuntime`, `CodeProcessManager`,
  `SecretLeaseProvider` and `parseVerifyOutput` stand behind them (the duplicated registry and heuristics
  that briefly lived in `app.ts` were removed), the sandbox transport stays single
  (`ProjectSandboxService.execute/process` wrapped in two thin adapters), and without a port every shell
  tool fails closed with `tool_not_configured` (503).

## Files / migrations / capabilities changed (C4)
- agent-api: **new** `code-shell-classifier.ts`, `code-verify-parser.ts`, `code-secret-lease.ts`,
  `code-shell-runtime.ts`, `code-process-manager.ts`; changed `code-tool-executors.ts` (shell/verify
  ports), `code-tool-routes.ts` (14 C4 error codes), `app.ts` (canonical modules behind the ports,
  sandbox adapters, three flag states), `code-tool-schemas.json` (**19 tools**),
  `code-tool-registry.ts` (**manifest v4**, frozen v3 checksum, `KNOWN_TOOL_MANIFESTS = [1,2,3,4]`).
- `packages/shared`: `code-capabilities.ts` (+6), `capability-catalog.ts`, `capability-matrix.ts`,
  `capability-inspector.ts` (`flagKeyForCapabilityId` now uses the resolved flag map).
- Artifacts regenerated: `code-tool-schemas.published.json`, `tests/fixtures/code-tool-schema-snapshot.json`.
- Config: `.env.example` + seven C4 variables (lease TTL/max TTL/reaper/tmpfs/allowlists, process log
  lines).
- Tests: **new** `coding-agent-c4-classifier.test.ts`, `coding-agent-c4-shell.test.ts`,
  `coding-agent-c4-secret-lease.test.ts`, `coding-agent-c4-capabilities.test.ts`; parity tests extended to
  all 19 tools; counters migrated to invariants in twelve files.
- No migration in C4 (leases, sessions, processes and idempotency are in-process — persistence is C6a).

## Verification (C4)
- `npm run typecheck` → **0 errors**; `npm run build` for agent-api and web → **exit 0**;
  `node scripts/code-tool-schemas-generate.mjs --check` → **exit 0**; `node scripts/verify-code-tool-schemas.mjs --check`
  → **exit 0** (`19 tool(s), manifest v4, checksum 2575b953…425b`); `node scripts/sandbox-image-verify.mjs` → **exit 0**.
- Definitive run: **27 files, 365 tests, 0 failures** — every C4 suite and every security-gate suite,
  together with the C1/C1a/C1b/C1c/C2/C3 suites, the capability registry / full regression / Inspector
  suites, invariants, agent-api and architecture. `npm run typecheck` → 0 errors; both builds → exit 0;
  `code-tool-schemas-generate.mjs --check` → exit 0; `verify-code-tool-schemas.mjs --check` → exit 0
  (`19 tool(s), manifest v4, checksum 2575b953…425b`); `sandbox-image-verify.mjs` → exit 0. The one red
  test in a wider run is the **pre-existing, unrelated** `tests/manual-product-e2e-web.test.ts`
  (`expected ['completed','queued','running'] to include 'failed'`), which reproduces standalone and has
  been failing since before C1.

## Tool policy matrix and the network enforcement gate (C4, owner-approved)
- **Mode × risk matrix** (`MODE_RISK_MATRIX` in `code-policy-engine.ts`), exactly as approved:
  | mode | safe | controlled | approval | hard_deny |
  |---|---|---|---|---|
  | `plan` | allow | deny | deny | deny |
  | `ask` | allow | approval | approval | deny |
  | `auto_edit` | allow | allow | approval | deny |
  | `full_auto_sandbox` | allow | allow | approval | deny |
  The existing `CodeSessionMode` values map explicitly: `plan → plan`, `edit → ask`, `auto → auto_edit`,
  `full_auto → full_auto_sandbox` (the new names are also accepted directly). The mapping `edit → ask` is
  the owner's wording; switching it to `auto_edit` is a one-line change in `matrixModeFor`. `controlled`
  is decided **only** by this matrix — the temporary "controlled always needs approval" rule was removed.
  `hard_deny` is still denied in every mode, role and even with `approved: true`.
- **Network enforcement is a separate gate, not an approval side effect**: the
  `network_enforcement` phase runs after hard-deny and **before** mode/risk/approval; when a command
  needs the network and `NPATI_SANDBOX_EGRESS_ENFORCED !== "true"`, the engine returns
  `network_enforcement_unavailable` (503, retryable) **in every mode, including `full_auto_sandbox`, and
  even when an approval was granted** — the tests assert that the approval is *not* consumed. With
  enforcement guaranteed, the matrix applies normally (allowlisted host → `controlled`, otherwise
  `approval`).

## Owner decisions accepted and implemented in C4
1. **Credential environment** (migration `069_credential_environment`, additive): `company_browser_credentials.environment`
   with `development | staging | production | unknown`, default **`unknown`** for existing and unknown rows.
   `development`/`staging` are leasable; **`unknown` and `production` are refused**; the allowlist
   (`NPATI_CODE_SECRET_LEASE_ALLOWED_IDS`/`_LABELS`) is now **only** an admin override for `unknown`
   (owner/admin **and** a mandatory `secret_lease.override` audit entry written before the lease exists);
   `production` is never leasable — not with the allowlist and not for an owner. An authoritative
   `resolveCredential` lookup (wired in `app.ts`) outranks the marker that arrives in a tool call, so a
   caller cannot claim a safer environment.
2. **SecretLease delivery**: process-scoped `environmentReferences` is the accepted path for this step; the
   value is available only to that tool call/process, is never written into a persistent shell environment
   (secret-shaped env names are rejected before start), is unusable by the next tool call **or another
   session** (`secret_lease_inherited`), and is revoked on completion, cancellation, failure and TTL.
   `writeSecretFile`/tmpfs stays a provider capability and does not block the step.
3. **Shell approvals**: the static per-command approval requirement was removed from `code.shell.*`
   (`requiresConfirmation: false`, `risk: high`; `code.fs.delete` is the only remaining approval-gated
   capability). Every `code.shell.exec` now passes through the **centralized server-side PolicyEngine**
   with a fixed phase order — feature flag → RBAC → capability → hard deny → session mode → project rules
   → risk classification → approval. `safe` commands may run automatically according to the session mode,
   `approval`-class always needs approval, `hard_deny` is always denied, and **a direct API/tool call
   cannot bypass the engine**: without an injected engine the runtime refuses with
   `policy_engine_unavailable` (503) instead of running anything.
4. **Persistence**: sessions, leases, process state and idempotency remain **in-process** for C4 by
   decision; the event log, reconciler and recovery are C6a and are not implemented early. This limitation
   is recorded here and in code comments.
5. **Egress**: the classifier only classifies network commands. Until C4b provides the enforced egress
   proxy/firewall (DNS/IP validation, redirect re-check, SSRF and DNS-rebinding protection), network
   commands **fail closed**: `NPATI_SANDBOX_EGRESS_ENFORCED=false` makes even an allowlisted host fail with
   `network_enforcement_unavailable` (503). C4b must guarantee enforcement outside the agent and then flip
   that flag.
- Real defects found and fixed while closing the step (none by weakening a check): the base policy was
  applied as a **floor**, so read-only utilities and allowlisted registry downloads could never be
  downgraded to `safe`/`controlled` (fixed by a per-segment risk resolution with an explicit allowlist
  and forbidden options); any timeout was reported as an interactive command (a slow build looked like an
  input error); the Inspector read the base flag map instead of the resolved one, so `code.shell.*`
  showed `code.write`; and the C4 ports were initially wired to a second, duplicated shell/process
  implementation instead of the canonical modules.

## Real E2E status (C4)
- Verified in-process with fake sandbox ports: classification (including every documented bypass form),
  the gate order, timeouts and output limits, process management, lease lifecycle and non-inheritance,
  the verify parsers, and both builds.
- **Not verified here:** a real sandbox run (no Docker execution in this environment), real registry
  downloads through the egress proxy, a real approval round-trip with a human approver, the LLM-driven
  loop (C6) and the Activity run stream / `ExecutionSnapshot` (C6/C6b). No PostgreSQL migration in C4.

## Known risks / open questions (C4)
1. **Credential environment flag (decision needed):** the Company credential model has no environment
   marker, so `isProductionCredential` denies everything except ids/labels explicitly allowed through
   `NPATI_CODE_SECRET_LEASE_ALLOWED_IDS`/`_ALLOWED_LABELS` (or clearly dev/test/staging). Either add an
   additive `environment` column or keep managing the allowlist.
2. **Secret delivery is environment-reference based**; the tmpfs delivery path exists in the provider but
   no `writeSecretFile` port is wired yet, so tmpfs delivery is unavailable in this deployment.
3. `code.shell.exec` and `code.shell.process.start` require approval by capability contract, so even a
   `safe` command asks for approval while `requiresConfirmation` is honoured by the caller; the runtime
   additionally gates `approval`-class commands regardless of the capability flag.
4. Shell sessions, leases, processes and idempotency caches are in-process: a restart forgets them
   (safe, but noisy) — persistence is C6a.
5. Egress allowlist enforcement lives in the sandbox/egress proxy (C4b); the classifier only decides
   whether a network command is `controlled` (allowlisted host) or `approval` (anything else), so C4b
   must still guarantee enforcement outside the agent.
6. Activity run events and `ExecutionSnapshot` linkage remain `TODO(C6)`; C4 emits structured log events
   with tool, versions, duration, exit code and truncation but no output content and no secrets.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, sections C4b and C4a), `docs/coding-agent/00-audit.md`
  sections 7 and 13, and this file.
- Execute **only C4b** (network policy): egress proxy enforcement with the allowlist, re-validation after
  DNS resolution and redirects, per-company/capability network rules, and the `security-gate` tests that
  prove an arbitrary host is unreachable from the sandbox while allowlisted registries are. Then C4a
  (dependency policy: install without lifecycle scripts, lockfile reproducibility, allowlisted
  registries) in the following session.
- Keep the C4 guarantees intact: commands only through the sandbox port, `hard_deny`/`approval` gates
  before execution, one-shot SecretLease with revocation, and audit before privileged actions.
- Do not start C5 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C3, latest step)
- **Seven new `code.*` capabilities** (inventoryIds **355–361**), so the registry is now **361 total /
  97 agent-callable**: `code.fs.edit` (medium), `code.fs.apply_patch` (medium), `code.fs.write` (medium),
  `code.fs.move` (medium), `code.fs.delete` (**high, `requiresConfirmation: true`**), `code.fs.diff`
  (**low**, `workspace:read`) and `code.fs.undo_last_turn` (medium). Flag gating is derived from
  `requiredPermissions`, not from the group, so `code.fs.diff` is gated by `code.read` while the
  mutating tools require `code.write`. The Inspector now receives **both** flag states.
- **Canonical tool schemas** extended to **13 tools**, manifest **v3**
  (`checksum 677fb6f8…2125`); v1 (empty) and v2 (the six C2 tools, with a frozen checksum) remain
  resolvable, so sessions pinned to an older manifest keep working. Artifacts were regenerated with
  `scripts/code-tool-schemas-generate.mjs --manifest-version 3` and both guards are green.
- **Write engine** (`code-tools-write.ts`, `code-tools-patch.ts`, `code-tools-diff.ts`):
  `applyEdit` (exact replacement, uniqueness check, whitespace-tolerant nearest-match hint with line
  number, `replace_all`, preserved encoding/BOM/EOL/tabs/file mode), `applyPatch` in the project's own
  `*** Begin Patch` format with **atomicity** (every hunk validated and every new content computed before
  the first write; a mid-write failure rolls back from before-copies; `dryRun` writes nothing),
  `writeFileSafe` (`createDirectories`/`overwrite` honoured), `movePathSafe`, `deletePathSafe`, a
  dependency-free unified diff with stats, size limits (`NPATI_CODE_MAX_EDIT_BYTES` 512 KiB,
  `NPATI_CODE_MAX_PATCH_FILES` 50), a mass-operation threshold (`NPATI_CODE_MASS_OP_THRESHOLD` 10) that
  demands approval, `.git/**` protection, sensitive-file protection (allowed only with an explicit
  approval, and the result says so), and `preferredEditTool(profile)` so the edit strategy comes from
  the model profile, never from a model name.
- **Runtime** (`code-tool-runtime.ts`, `code-workspace-checkpoint.ts`, `code-edit-approval.ts`): the gate
  order is now tenant isolation → master flag → tool/version resolution → **sub-flag (`code.write` for
  writes, `code.read` otherwise)** → argument validation (`confirm: true` required for undo) →
  idempotency → **read-before-write → approval → checkpoint → audit (strict, fail-closed)** → execution
  by the canonical engine → turn log + refreshed read tracking + post-write warnings → data envelope +
  Activity/AuditLog. Reused rather than rebuilt: `ProjectGitService.createCheckpoint/restoreCheckpoint`
  for per-turn checkpoints (one per turn, created **before** the first write; no checkpoint port means
  the write is refused with `checkpoint_unavailable`), `CompanyApprovalsRepository.requestApproval/
  consumeApproved` for destructive and bulk operations (payload substitution between approval and
  execution is rejected via `payload_hash`), and `ProjectWorkspace` revision control
  (`expectedRevision` → `revision_conflict`, at most two retries per `(session, path)`).
- **New error codes**: `read_before_write_required` (409, `details.reason: not_read|changed`),
  `revision_conflict`/`revision_conflict_exhausted` (409), `checkpoint_unavailable` (503),
  `checkpoint_not_found` (409), `approval_required` (403 with `details.approvalId`),
  `approval_invalid` (409), `approval_unavailable` (503), `write_unavailable` (503),
  `edit_no_match`/`edit_not_unique`/`patch_conflict` (409), `write_failed`/`delete_failed`/`move_failed`
  (502), `edit_too_large`/`patch_too_large` (413), `git_dir_protected`/`sensitive_file_denied` (403).
- **API**: the invoke harness now accepts `turnId`/`approvalId`/`runId`/`agentId` and returns `details`;
  added `GET /companies/:companyId/projects/:projectId/code/diff?turnId=` and
  `POST …/code/undo-last-turn` (owner/admin), all with `apiVersion`.
- **Audit/Activity**: `code.fs.*` writes are audited **before** the change (strict, fail-closed) with
  `path`, `sha256`, `linesAdded/Removed`, `checkpointId`, `turnId` — no file content and no secrets.
  Post-write formatter/syntax hooks run only when `NPATI_CODE_FORMAT_COMMAND`/`NPATI_CODE_SYNTAX_COMMAND`
  are configured and can only add warnings.

## Files / migrations / capabilities changed (C3)
- agent-api: **new** `code-tools-write.ts`, `code-tools-patch.ts`, `code-tools-diff.ts`,
  `code-workspace-checkpoint.ts`, `code-edit-approval.ts`; changed `code-tool-runtime.ts`,
  `code-tool-executors.ts`, `code-tool-routes.ts`, `code-tools-path.ts` (14 new error codes, additive),
  `app.ts` (turn tracker, checkpoint/approval ports, write port, canonical executors, both flag states).
- `packages/shared/src/code-capabilities.ts` (+7 capabilities), `capability-catalog.ts`,
  `capability-matrix.ts`, `capability-inspector.ts` (`flagKeyForCapabilityId`).
- `apps/agent-api/src/code-tool-schemas.json`, `code-tool-registry.ts` (v3 + frozen v2 checksum),
  `code-tool-schemas.published.json`, `tests/fixtures/code-tool-schema-snapshot.json`.
- Tests: **new** `coding-agent-c3-write-engine.test.ts` (30), `coding-agent-c3-runtime.test.ts` (16),
  `coding-agent-c3-schema-executor-parity.test.ts` (6), `coding-agent-c3-capabilities.test.ts` (12);
  counters migrated to invariants in eleven files (the C2 tool-count tests now assert subset +
  artifact equality instead of a hardcoded six).
- No migration in C3 (checkpoints reuse git; the turn log, read tracking and idempotency cache stay
  in-process — persistence is C6a).

## Verification (C3)
- `npm run typecheck` → **0 errors**; `npm run build` for agent-api and web → **exit 0**;
  `node scripts/verify-code-tool-schemas.mjs --check` → **exit 0** (13 tools, manifest v3);
  `node scripts/sandbox-image-verify.mjs` → **exit 0**.
- Definitive run: **21 test files, 282 tests, 0 failures** — all C3 suites plus every C1/C1a/C1b/C1c and
  C2 security-gate suite, capability registry, full capability regression, Inspector, invariants,
  agent-api and architecture.
- Real defects found and fixed while closing the step (none by weakening a check): the executors had
  been written before the canonical engines and had drifted from the schemas — `replace_all` was
  ignored, `apply_patch` treated the canonical patch as a unified diff and **did not honour `dryRun`**
  (a dry run could have written), `write` dropped `createDirectories`/`overwrite`, `move`/`delete`
  dropped `overwrite`/`recursive`/`expectedRevision`; read-before-write wrongly refused a legitimate
  overwrite after a read (fixed with an additive `readVerified` flag that only the runtime sets);
  `stats.linesAdded/linesRemoved` were lost when the turn diff moved to the canonical shape (both forms
  are now returned).

## Real E2E status (C3)
- Verified in-process with fake and real workspace ports: the full gate order, read-before-write,
  revision conflicts and retries, per-turn checkpoint and undo, approval consumption with payload-hash
  checking, atomic patches with dry-run, diffs and stats, and the acceptance path
  (`read` → `edit` → `apply_patch` on several files → correct diff → undo restores the original state).
- **Not verified here:** a real git-backed checkpoint and undo against a live project workspace (no
  Docker/sandbox run in this environment), a live PostgreSQL (no migration in C3), the existing approval
  system end to end through HTTP with a real approver, the LLM-driven tool loop (C6), and the Activity
  run stream / `ExecutionSnapshot` (C6/C6b).

## Known risks / open questions (C3)
1. Without the approval port (for example a deployment without the database) every destructive change is
   refused with `approval_unavailable` (503). That is the intended deny, but it means delete does not
   work in such a deployment.
2. `code.fs.edit` refuses an ambiguous match (>1) unless `replace_all` is set — a deliberate choice to
   avoid editing the wrong occurrence; it can be relaxed if the product prefers a different tradeoff.
3. The canonical patch format requires every hunk to match exactly; on any mismatch **no** file changes.
   This is stricter than `patch(1)` and is deliberate.
4. `code.fs.read` still denies every `.env*`, including `.env.example` (carried over from C2).
5. Turn log, read tracking and idempotency are in-process: a restart forgets them, so after a restart
   read-before-write will demand a fresh read (safe, but noisy) — persistence is C6a.
6. The Inspector shows a real flag state for `code.*` only when the flag service is configured;
   otherwise it reports `unknown`, never `on`.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C4), `docs/coding-agent/00-audit.md`
  sections 6, 7 and 13, and this file.
- Execute **only C4**: sandbox command execution (`code.shell.run`) with allowlisted commands,
  environment sanitisation, output redaction, timeouts and output limits, plus the dependency/registry
  rules of C4a (install without lifecycle scripts, lockfile-reproducible, allowlisted registries only)
  and the SecretLease mechanism of C4 (secrets scoped to a single tool call, TTL, revoked after use, no
  inheritance into later processes or tool calls, never written into a persistent shell environment).
  Register the new capabilities, extend `code-tool-schemas.json`, bump
  `CODE_TOOL_MANIFEST_VERSION`, regenerate the published artifact and snapshot with
  `node scripts/code-tool-schemas-generate.mjs --manifest-version N`, keep the schema↔capability parity
  test and the schema↔executor parity test green, and update the counter tests as invariants.
- Privileged actions (secret issuance, allowlist changes) must be written through `AuditLogService`
  (C1c) and fail closed, exactly like the C3 approvals and checkpoints.
- Do not start C5 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C2, latest step)
- **Six `code.*` capabilities** in the canonical registry, all `risk: low`, `type: tool`,
  `domain: code` (a new domain member), `agentCallable`, `userVisible`, no confirmation,
  `requiredPermissions: ["workspace:read"]`, version 1, inventoryIds **349–354**:
  `code.fs.list`, `code.fs.read`, `code.fs.grep`, `code.fs.tree`, `code.symbols.outline`,
  `code.project.info`. Counters moved from 348/84 to **354 total / 90 agent-callable** (updated in ten
  test files; `scripts/verify-capability-matrix.mjs` still checks the literal 306 and needed no change
  because pushed groups were never visible to it).
- **Capability Inspector** shows a **Flag** column: `code.*` capabilities report `flagKey`/`flagState`
  from the server-side `FeatureFlagService` (dark launch → `off`), and `unknown` when the flag source is
  missing — never `on` by default.
- **Single source of truth for tool schemas**: `apps/agent-api/src/code-tool-schemas.json` (six entries
  with `name@version`, input/output JSON Schema, `additionalProperties: false`). The manifest was raised
  to **v2**; `code-tool-schemas.published.json` and the frozen snapshot were regenerated, and
  `assertManifestConsistent()` plus the CI guards (`verify-code-tool-schemas.mjs`,
  `code-tool-schemas-generate.mjs --check`, `npm run audit:code-tools`) are green. `packages/shared`
  mirrors the canonical schemas (it cannot import from `apps/`), and a new **parity test**
  (`tests/coding-agent-c2-schema-parity.test.ts`) fails the build if they diverge again — including a
  check that no tool argument can name `projectId`/`companyId`/`sessionId`/`workspaceId` (the project
  comes from the authenticated call envelope, not the model).
- **Tool implementations** (`code-tools-path.ts`, `code-tools-sensitive.ts`, `code-tools-fs.ts`,
  `code-tools-project.ts`): path safety (traversal, absolute paths, `C:\`, UNC, `~`, null bytes, glob
  metacharacters in plain paths, symlink escape with fail-closed handling of unknown targets), sensitive
  file policy (`NPATI_CODE_SENSITIVE_POLICY=deny|redact`, default deny — the decision is taken **before**
  reading, so `.env*`, keys, certificates, `.ssh/`, `.aws/`, `.gnupg/` and `.git/` never enter a result),
  `list`/`read`/`grep`/`tree`/`outline`/`project.info` with `.gitignore` support, bounded output
  (arrays trimmed first with a narrowing hint, then a head/tail preview with `[truncated N chars]`),
  binary/image detection returning metadata plus `sha256` instead of content, and every result wrapped as
  `{ kind: "code_tool_result", trust: "untrusted_data", … }` so file content is data, never instructions.
- **Runtime** (`code-tool-runtime.ts`, `code-tool-executors.ts`, `code-read-tracker.ts`,
  `code-tool-routes.ts`): a fixed ten-gate order — tenant isolation → feature flags (master +
  `code.read`, deny-by-default) → tool/version resolution → JSON Schema argument validation → path and
  sensitive-file policy → idempotency by `(sessionId, toolCallId)` → execution through the canonical
  executors → data envelope → Activity/AuditLog → read tracking (`code.fs.read` records `{path, sha256}`
  for C3 read-before-write). The only execution path is the C1 workspace and the sandbox port: `grep`
  runs through the sandbox (`rg --line-number`) and refuses with `sandbox_unavailable` (503, retryable)
  rather than falling back to the server. All logic comes from the canonical modules — a missing
  executor yields `tool_not_configured` (503), never a look-alike implementation.
- **Harness API**: `GET /companies/:companyId/code/tools` and
  `POST /companies/:companyId/projects/:projectId/code/tools/invoke` (with `code.tool.invoke` /
  `code.tool.denied` audit entries), used by the tests and by manual acceptance checks.
- **Activity**: `CompanyAgentRunEventType` is lifecycle-only, so tool events are emitted as a structured
  `CodeToolActivityEvent` (tool, versions, duration, bytes, truncated, ok, errorCode — no file content, no
  secrets) and logged; the run-level event stream and `ExecutionSnapshot` linkage stay `TODO(C6)`.

## Files / migrations / capabilities changed (C2)
- `packages/shared/src/code-capabilities.ts` (new), `capabilities.ts` (domain `code`),
  `capability-catalog.ts` / `capability-matrix.ts` (import + push), `index.ts`, `capability-inspector.ts`.
- agent-api: **new** `code-tools-path.ts`, `code-tools-sensitive.ts`, `code-tools-fs.ts`,
  `code-tools-project.ts`, `code-tool-executors.ts`, `code-tool-runtime.ts`, `code-tool-routes.ts`,
  `code-read-tracker.ts`, `code-tool-schemas.json`; changed `code-tool-registry.ts` (v2, six tools),
  `app.ts` (runtime + routes wiring), `code-tool-schemas.published.json`, snapshot fixture.
- `scripts/code-tool-schemas-generate.mjs` (new).
- web: `CapabilityInspectorPage.tsx` (Flag column).
- Tests: **new** `tests/coding-agent-c2-read-tools.test.ts` (26), `coding-agent-c2-tool-runtime.test.ts`
  (16), `coding-agent-c2-capabilities.test.ts` (6), `coding-agent-c2-schema-parity.test.ts` (5); counters
  updated in ten existing files.
- No migration in C2 (the read tracker and idempotency cache are in-process; persistence is C3/C6a).

## Verification (C2)
- `npm run typecheck` → **0 errors** (13 workspaces); `npm run build` for agent-api and web → **exit 0**.
- `node scripts/verify-code-tool-schemas.mjs --check` → **exit 0** (6 tools, manifest v2, checksum
  `c1d027c2…4066a`); `node scripts/code-tool-schemas-generate.mjs --check` → **exit 0**;
  `node scripts/sandbox-image-verify.mjs` → **exit 0**.
- Definitive run: **24 test files, 322 tests, 0 failures** — all C2 suites, the C1/C1a/C1b/C1c
  security-gate suites, capability registry/full regression/Inspector, invariants, agent-api,
  architecture, Website Builder, Data Studio, control plane, phase13/14 and the upgrade-compatibility
  gate.
- Real bugs found and fixed while closing the step (none by weakening a check): `enforceOutputBudget`
  measured the payload before adding its own `truncation` metadata, so a barely-fitting array was
  discarded in favour of a text preview; the tool routes returned 403 instead of 503 when the runtime
  was absent; canonical port errors were masked (`sandbox_unavailable` surfaced as 400 `search_failed`);
  the runtime duplicated path/sensitive/envelope logic instead of using the canonical modules; and the
  capability and registry schemas disagreed on argument names (would have caused `invalid_arguments` in
  production), now locked by the parity test.

## Real E2E status (C2)
- Verified in-process against fake ports and the real workspace port: the ten gates, argument
  validation, path/sensitive policy, idempotency, read tracking, the data envelope, error contracts and
  the acceptance path (`grep` finds a function, `read` returns its body).
- **Not verified here:** a real sandbox executing `rg` (no Docker run in this environment),
  a live PostgreSQL (no migration in C2), LLM-driven tool selection (the agent loop is C6), and the
  Activity run stream (C6). The tool-schema guards were verified as scripts, not in GitHub CI.

## Known risks / open questions (C2)
1. `code.fs.read` denies **every** `.env*`, including `.env.example`. If the product wants the example
   file readable, that is one pattern in `code-tools-sensitive.ts` — a decision for the owner.
2. Read tracking and idempotency are **in-process**: they reset on restart and are not shared between
   replicas. Persistence is C3/C6a; until then a restart forgets which files were read (read-before-write
   in C3 must tolerate that).
3. `grep` requires the sandbox port; without it the tool refuses (503). A deployment that wants search
   must provide the sandbox.
4. Tool events are logged, not yet part of the run Activity stream, and have no `ExecutionSnapshot`
   reference (C6/C6b).
5. The `Flag` column header in the Inspector is intentionally not translated yet (adding i18n keys would
   touch `i18n/types.ts` and seven locales); the domain `code` shares the generic domain badge styling.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C3), `docs/coding-agent/00-audit.md`
  sections 5, 6 and 13, and this file.
- Execute **only C3**: write/edit tools with **read-before-write** enforced through the C2 read tracker
  (refuse to edit a file that was not read, or whose `sha256` changed since it was read), checkpoints for
  every mutating action (rule 14), the same ten-gate runtime order, one fixed version per tool, flags
  (`code.write`), approvals where the existing approval system applies, and secret redaction in diffs.
  Publish the new schemas (bump `CODE_TOOL_MANIFEST_VERSION`, regenerate
  `code-tool-schemas.published.json` + the snapshot with `scripts/code-tool-schemas-generate.mjs
  --manifest-version N`), extend `code-capabilities.ts` **and** keep the parity test green, and update
  every counter test.
- Do not start C4 in that session; the order in `00-audit.md` section 13 is binding.

## Implemented (C1b, latest step)
- **Declarative image catalog** `docker/sandbox/images.json` (schema v1, six variants: base, node, python,
  php, go, rust, java) where every reference must be `repo@sha256:<64hex>`; the catalog is validated
  strictly (no tags or `:latest`, mandatory `sbomPath`/`scanAt`/known `status`/`variant`, no duplicate
  digests or ids). A missing catalog yields an empty catalog plus a log — never "trust everything".
  **All digests are deterministic placeholders** until the first real build; this is stated in the
  catalog warnings, in `docs/coding-agent/sandbox-images.md`, and enforced by `--require-verified`
  (which is red by design today).
- **Dockerfiles** `docker/sandbox/Dockerfile.{base,node,python,php,go,rust,java}`: digest-pinned base
  (`ARG UPSTREAM_BASE=...@sha256:<digest>`), pinned package/runtime versions (pnpm 10.15.0, yarn 1.22.22,
  pytest 8.3.3, ruff 0.6.9, mypy 1.11.2, poetry 1.8.4, uv 0.4.20, OpenJDK 21 + Maven/Gradle), Go with
  `GOTOOLCHAIN=local`, unprivileged `USER 10001:10001`, `WORKDIR /workspace`, no docker socket and no
  privileged mode — this closes the Go/Rust/Java toolchains C1 deliberately deferred.
- **SBOM and scanning**: `docker/sandbox/sbom/*.spdx.json` per image (placeholder inventory, clearly
  marked, replaced by real `syft` output in CI); `scripts/sandbox-image-scan.mjs` blocks publication on
  any critical finding and requires a waiver (owner + reason + expiry) for high findings.
- **Signing and trusted registry**: `CosignImageSignatureVerifier` (keyless, certificate identity +
  OIDC issuer) and `NullImageSignatureVerifier`, which **always refuses** — with no configured verifier
  every image is denied (fail closed).
- **Admission control in the sandbox provider**: `SandboxImagePolicy.admit()` runs **before**
  `docker create`, the admitted digest (not the configured tag) is what reaches the command line, and a
  refusal creates neither container nor network. Refusal codes: `image_not_pinned`, `image_not_allowed`,
  `image_revoked` (409 + `forcedUpgrade`/`replacement`), `image_digest_mismatch`, `image_scan_stale`
  (older than `NPATI_CODE_MAX_IMAGE_AGE_DAYS`, default 14), `image_scan_failed`, `image_waiver_expired`,
  `image_signature_invalid`, `image_admin_required`, `sandbox_image_policy_unavailable`.
- **Deny by default in three places**: no signature verifier → refusal; no audit journal →
  `allow`/`revoke`/`waiver` are not applied (the journal is written **before** the change); no injected
  policy in the provider → refuse instead of starting.
- **Dev mode** (`NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES=true`, default false) allows a locally built image
  only when the environment is `development`/`test` **and** no production flag is enabled for the
  company; such an image is recorded `unverified` and can never become `verified`.
- **Rollout and digest immutability**: `selectForRollout` keeps a session on its own digest; a new digest
  is adopted only when `code.sandbox_image.<digest-prefix8>` is enabled (the namespace was added to the
  flag-key validator, otherwise the operator could not have enabled it at all); after a revoke the policy
  returns `forcedUpgrade` with the last verified image of the same variant, so the runtime can notify and
  move the session.
- **Container hardening**: `buildSandboxCreateArgs()` (pure, testable) emits `--user 10001:10001`,
  `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, tmpfs `/workspace` owned by 10001,
  the internal network and an optional seccomp profile (`NPATI_SANDBOX_SECCOMP_PROFILE`), and never
  `--privileged`, a docker socket, host mounts, `--pid=host`, `--network=host` or `:latest`.
- **API and UI**: `GET/POST /companies/:companyId/code/sandbox-images`, `POST .../revoke`,
  `POST .../:imageId/scan`, `POST .../admission-check` (all responses carry `apiVersion`), and the
  «Sandbox images» panel on Settings → Code with status/scan badges, revoke confirmation, scan recording
  and a manual admission check.
- **CI**: `.github/workflows/sandbox-images.yml` (verify → build/SBOM/scan/sign, weekly `rescan` with an
  issue on critical) plus `npm run audit:sandbox-images` in the existing platform job; the local guard
  `scripts/sandbox-image-verify.mjs` runs on pure Node (no TS loader) and also checks the Dockerfiles
  (digest-pinned `FROM`, `USER 10001:10001`, no `--privileged`/`docker.sock`).

## Files / migrations / capabilities changed (C1b)
- Migration **`packages/workspace/src/migration-068.ts`** (`068_sandbox_image_supply_chain`): table
  `sandbox_images` with digest, status, signature/issuer, SBOM path, scan data, waiver fields,
  `previous_reference` and revoke audit fields.
- Workspace package: `types.ts` (`SandboxImage*` types, `SANDBOX_IMAGE_REFERENCE_PATTERN`, five store
  methods), `postgres-store.ts`, `in-memory-store.ts`.
- agent-api: **new** `sandbox-image-policy.ts`, `sandbox-image-catalog.ts`, `sandbox-image-signature.ts`,
  `sandbox-image-routes.ts`; changed `docker-sandbox-provider.ts` (admission + seccomp),
  `sandbox-runner-server.ts` (policy construction), `app.ts` (policy + route registration),
  `feature-flags.ts` (rollout flag namespace).
- New: `docker/sandbox/**` (7 Dockerfiles, catalog, 6 SBOMs, negative self-test fixture),
  `scripts/sandbox-image-{lib,build,sbom,scan,sign,verify}.mjs`, `.github/workflows/sandbox-images.yml`,
  `docs/coding-agent/sandbox-images.md`; changed `.github/workflows/ci.yml`, `package.json`
  (`audit:sandbox-images`), `apps/agent-api/Dockerfile.project-sandbox` (kept buildable, digest via
  `--build-arg`), `.env.example` (six new sandbox variables).
- web: **new** `CodeSandboxImagesPanel.tsx`; changed `CodeSettingsPage.tsx`, `styles.css`.
- Capabilities: none added (still **348 / 84**) — unchanged by design, tools arrive in C2.

## Verification (C1b)
- `npm run typecheck` → **0 errors**; `npm run build` for agent-api and web → **exit 0**;
  `node scripts/sandbox-image-verify.mjs` → **exit 0** (0 errors, 6 placeholder warnings);
  `node scripts/verify-code-tool-schemas.mjs --check` → **exit 0**.
- `tests/coding-agent-c1b-images.test.ts` **14/14** and `tests/coding-agent-c1b-image-api.test.ts` **7/7**,
  and the full security-gate regression slice — **18 files, 197 tests, all passing** (C1, C1a flags,
  C1a versioning, C1a artifact guard, C1c audit, projects, sandbox provider/egress/terminal, capability
  registry and full capability regression, invariants, Website Builder, Data Studio, agent-api, architecture).
- Fixed during the step (all seven failures were real, none was solved by weakening a check):
  five test fixtures used a bare hex digest where the canonical form is `sha256:<hex>`;
  `AuthenticationError` was mapped to 400 instead of 401 by the image routes; an unexpected internal
  failure mapped to 400 instead of 500; and `newDigestAdopted` built the rollout flag key from
  `digest.slice(0,8)` — i.e. `sha256:b` — while the flag namespace was not even accepted by the key
  validator, so the documented rollout mechanism could not be enabled at all.

## Real E2E status (C1b)
- Verified in-process: admission decisions and every refusal code, fail-closed audit for image
  administration, catalog validation, the hardened command line, rollout/revoke semantics, the API error
  contracts and both builds.
- **Not verified here (no Docker registry, no `syft`/`trivy`/`cosign`):** actual image builds, real
  SPDX inventories, vulnerability scans, cosign signatures, and a container actually starting from an
  admitted digest. The catalog digests are placeholders, so the deploy gate (`--require-verified`) is red
  by design until the first real build; the workflow YAML was written by hand and has not been parsed by
  GitHub yet. Migration 068 and the DB store methods have not run against a live PostgreSQL.

## Known risks / open questions (C1b)
1. **Dev workflow break (needs confirmation)**: the default `NPATI_SANDBOX_IMAGE` is a tag, so from C1b the
   sandbox refuses to start until either a digest from the catalog plus cosign identity/issuer is
   configured, or `NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES=true` is combined with `NODE_ENV=development`.
   This is intentional deny-by-default, but it changes the local flow.
2. **Runner without `DATABASE_URL` sees only the file catalog**, so a `revoke` performed through the API
   does not reach it (a warning is logged). Production runners must have database access; alternatively a
   periodic catalog pull from the API can be added.
3. The negative-check fixture (`docker/sandbox/.negative-check.json`) stays in the repo deliberately: the
   CI `verify` job asserts that the guard **fails** on it. It can be moved to `tests/fixtures/` if that is
   preferred.
4. `apps/agent-api/Dockerfile.project-sandbox` remains tag-buildable so the existing CI/Dokploy path keeps
   working; the digest-pinned production path is `docker/sandbox/*` with `--build-arg BASE_IMAGE=…@sha256:…`.
   Forcing a digest there would break the current CI job until a real digest exists.
5. `docker/sandbox/images.json` entries are `unverified` placeholders; the real rotas must be filled by the
   first successful workflow run, and only then may any of them be promoted to `verified`.
6. The gVisor/Kata/Firecracker decision is documented (evaluated, not implemented) in
   `docs/coding-agent/sandbox-images.md`; a stronger runtime would be an alternative `SandboxRuntimeProvider`.

## Implemented (C1a, latest step)
- **Feature-flag store** (migration **067**, additive): `feature_flags` with scope `global|company|user`,
  `stage` (`off|internal|allowlist|percent|ga`), `enabled`, `rollout_percent`, `allowlist`, `revision`,
  `updated_by`, unique on (workspace, scope, scope_id, flag_key); `feature_flag_history` records every
  change (previous/next value, actor) so "who turned it on" is answerable without the journal — the
  privileged action itself is additionally in the C1c AuditLog.
- **`FeatureFlagService`** (`apps/agent-api/src/feature-flags.ts`): master `coding_agent.enabled` plus
  sub-flags `code.read`, `code.write`, `code.shell`, `code.git`, `code.subagents`,
  `code.background_runs`, `code.mounted_folder`, `code.hooks`, `code.mcp`, `code.full_auto_sandbox`
  and the `code.model_profile.<id>` template; keys outside the `code.` namespace are rejected
  (`invalid_flag_key`). Resolution is user → company → global; stages are `off` = deny,
  `internal` = admin/owner only, `allowlist` = id list, `percent` = deterministic FNV bucket,
  `ga` = allow. The in-process cache is capped at 30 s (`NPATI_CODE_FLAG_CACHE_TTL_MS`, default 15 s)
  and `invalidate()` is called on every write, so a kill switch acts immediately.
- **Master flag is a veto switch**: an explicit `off` at a broader scope stops the feature even where a
  narrower scope enabled it (this is what makes an incident stop authoritative); sub-flags keep
  most-specific-wins. This semantics change is called out below for confirmation.
- **Dark launch by default**: nothing is enabled out of the box; mutations require master +
  `code.write`, and the check exists in **both** the route and `CodeService`, so a direct service call
  is refused too (403 `feature_disabled` with the offending `flagKey`). A missing flag service means
  **deny**, never allow. Reads stay available — this is the History (read-only) mode: project/session
  lists, details, limits, flags and `archive` keep working while the feature is off, so a user can
  still see and remove their data. Website Builder and Data Studio are untouched.
- **Kill switch** (`POST /companies/:companyId/code/flags/kill-switch`): audited (`flag.kill_switch`)
  before the state change, disables master at the requested scope, invalidates the cache, moves
  `active|paused|awaiting_approval` sessions of that company to the new `suspended_by_flag` status and
  best-effort stops the sandbox of those projects (full cleanup and SecretLease revocation are C4/C6).
- **Auto-disable on a security event** (`NPATI_CODE_AUTO_DISABLE_ON_AUDIT_BREAK`, default true):
  `evaluateAutoDisable({ type: "audit_chain_broken" })` disables master globally and audits
  `flag.auto_disable`; the owner sees the new state in the UI.
- **Administration**: only `*`/`owner`/`admin:all` may change flags (403 `flag_admin_required`, checked
  before any company lookup); `expectedRevision` gives 409 `flag_revision_conflict`; promoting a stage
  above `internal` returns 409 `gate_not_passed` unless `NPATI_ALLOW_PRE_GATE_ROLLOUT=true`, because G1
  and R1 have not been passed. Every change goes through `AuditLogService.record()` **before** it is
  applied, so an audit outage refuses the change (fail closed).
- **UI**: Settings → Code → «Feature flags (experimental)» — master switch, kill switch with
  confirmation, the ten sub-flags, scope selector (company/global with a warning), dark-launch alert
  and change history; the page switches to History read-only (mutating buttons disabled with an
  explanation) when master is off.
- **Versioning**: `code-tool-registry.ts` (schemas as `name@version`, canonical JSON checksum,
  `CODE_TOOL_MANIFEST_VERSION`, `assertManifestConsistent`, `resolveManifestForSession`),
  `persisted-schema-upcast.ts` (`PERSISTED_SCHEMA_VERSIONS` for session transcript, summary, checkpoint
  metadata, model profile and tool result; `upcastPersisted` reads old records without migrating
  history and refuses records newer than the code), `api-versioning.ts` (`API_VERSION = "v1"`, 90-day
  deprecation window, `x-npati-api-version` request header, `unsupported_api_version` for an unknown
  version) — code API responses now also carry the `x-npati-api-version` header.
- **CI guard**: `scripts/verify-code-tool-schemas.mjs` (`npm run audit:code-tools`) compares the
  published artifact `apps/agent-api/src/code-tool-schemas.published.json` with the frozen snapshot
  `tests/fixtures/code-tool-schema-snapshot.json` and fails the build for a changed schema without a
  version bump, a removed published version, a new version without a manifest bump, or a tampered
  checksum; `tests/coding-agent-c1a-tool-schema-artifact.test.ts` keeps registry ↔ artifact ↔ snapshot
  in sync (vite compiles TS, so the guard itself needs no TS loader).
- **Session manifest pinning**: a new `CodeSession` records `toolManifestVersion` (manifest v1 today),
  and `app.ts` publishes the manifest at startup after `assertManifestConsistent()`.

## Files / migrations / capabilities changed (C1a)
- Migration **`packages/workspace/src/migration-067.ts`** (`067_feature_flags_and_versioning`),
  registered in `postgres-store.ts`.
- Workspace package: `types.ts` (flag types, `CodeToolManifest`, `suspended_by_flag` status, five new
  store methods), `postgres-store.ts`, `in-memory-store.ts` (mirrored).
- agent-api: **new** `feature-flags.ts`, `code-tool-registry.ts`, `persisted-schema-upcast.ts`,
  `api-versioning.ts`, `code-tool-schemas.published.json`; **new** `scripts/verify-code-tool-schemas.mjs`,
  `tests/fixtures/code-tool-schema-snapshot.json`; changed `code-routes.ts` (mutation gates, three flag
  routes, API-version check + header), `code-service.ts` (deny-by-default `assertWriteEnabled`,
  manifest pinning), `app.ts` (flag service + manifest publication).
- web: **new** `CodeFlagsPanel.tsx`; changed `CodeSettingsPage.tsx`, `styles.css`.
- Config/docs: `.env.example` (`NPATI_CODE_FLAG_CACHE_TTL_MS`, `NPATI_ALLOW_PRE_GATE_ROLLOUT`,
  `NPATI_CODE_AUTO_DISABLE_ON_AUDIT_BREAK`), `package.json` (`audit:code-tools`), this file.
- Capabilities: none added (still **348 / 84**); rule 24 in action — the flag plumbing exists, the
  `code.*` capabilities and the Inspector's per-capability flag badge arrive with C2.

## Verification (C1a)
- `npm run typecheck` → **0 errors** (13 workspaces); `npm run build` for agent-api and web → **exit 0**.
- `npm run audit:code-tools` → **exit 0** (`0 tool(s), manifest v1, checksum e3b0c44…b855`); drift was
  demonstrated to fail in all four cases (changed schema without bump, removed version, new version,
  tampered checksum).
- New/updated suites: `tests/coding-agent-c1a-flags.test.ts` **12/12** (dark launch denies mutations
  through both the API and a direct service call; per-company and per-user isolation; master veto over
  sub-flags; key validation; non-admin refusal; fail-closed audit; revision conflict; gate above
  `internal`; kill switch suspends sessions, invalidates the cache immediately and is audited;
  auto-disable on a broken chain; 503 when flags are not configured),
  `tests/coding-agent-c1a-versioning.test.ts` **17/17**,
  `tests/coding-agent-c1a-tool-schema-artifact.test.ts` **6/6**, plus the C1 suite **16/16** (updated
  for deny-by-default and the pinned manifest) and the C1c suite **10/10** — the four security-gate
  suites together are **61/61**.
- Regression slice (23 files) in the same run: **216 passed, 3 skipped (DB-bound C1c), 1 failed** — the
  failure was a stale `toolManifestVersion: null` expectation caused by the new manifest pinning, and
  it is fixed. Pre-existing failures are unchanged and unrelated: `company-runtime.test.ts` (4),
  `manual-product-e2e-web.test.ts` (1), `production-durable-approvals.test.ts` (1, reproduced on a
  clean HEAD).

## Real E2E status (C1a)
- Verified in-process: flag resolution across scopes and stages, master veto, cache invalidation and
  the immediate kill-switch effect, session suspension, audit-before-apply, API error contracts, the
  versioning helpers, the artifact/snapshot guard, and both builds.
- **Not verified here:** the flag tables and the `suspended_by_flag` CHECK against a live PostgreSQL
  (migration 067 is additive and follows 065/066; the DB-backed job must apply it), the UI panel in a
  browser, and the C1c DB-bound triggers (unchanged, 3 tests skipped without `DATABASE_URL`).

## Known risks / open questions (C1a)
1. **Master flag is now a veto switch** (a broader `off` overrides a narrower `on`). It is required for
   an incident kill switch, but it is a semantics decision — confirm it, or switch to a separate
   "incident stop" row that outranks every scope.
2. `stage: "internal"` admits only admin/owner; ordinary users need `allowlist`/`percent`/`ga`. This is
   the conservative reading of the plan and is easy to relax in one condition.
3. A rejected flag change (revision conflict) already has a `flag.change` entry, because the audit is
   written first (fail closed). If "audit only applied changes" is preferred, the order must change
   together with a compensating entry.
4. `tsx` is still not declared in `devDependencies`; the new guard no longer needs it, but the older
   `gate:agent` script has the same latent dependency.
5. Auto-disable currently reacts to the audit-chain-broken event; error-rate and budget thresholds
   need the metrics that arrive with C6/R1.
6. Kill-switch cleanup is best-effort for sandboxes and does not revoke SecretLeases (C4) or suspend
   runs (C6 adds run-level `suspended_by_flag`; C1a suspends sessions).

## Implemented (C1c, latest step)
- **Append-only journal** `audit_log`, deliberately separate from Activity and from
  `company_audit_logs`: `audit_id`, `sequence` (per company), `created_at`, `actor`, `actor_role`,
  `request_id`, `correlation_id`, `snapshot_id` (null until C6b), `action`, `resource_type`,
  `resource_id`, `project_id`, `decision` (`allowed|denied|approved|rejected`), `payload_hash`,
  `prev_hash`, `entry_hash`, redacted `metadata`. Migration **066** also revokes UPDATE/DELETE from
  PUBLIC and installs two triggers: one that raises on any UPDATE/DELETE (covering the table owner,
  which a REVOKE alone would not) and one that enforces the hash chain on INSERT (first entry of a
  company must be sequence 1 with no `prev_hash`; every later entry must continue the previous
  `entry_hash` with the next sequence), so a rogue INSERT cannot fork or reorder a chain.
- **Hash chain** `entry_hash = sha256(prev_hash | canonical(entry))` with canonical JSON (recursively
  sorted keys) computed by one shared module (`packages/workspace/src/audit-chain.ts`), so PostgreSQL
  and the in-memory store produce identical hashes and the verifier is a pure, unit-testable function.
  Appends take a per-company advisory lock inside a transaction, so concurrent privileged actions
  cannot interleave.
- **`AuditLogService`** (`apps/agent-api/src/audit-log.ts`): the `record()` interface later steps use.
  It redacts metadata (secrets by key and by the project's `CredentialMasker` patterns; prompt/content
  keys dropped entirely), stores only the canonical hash of the action payload, and **throws
  `AuditUnavailableError` on any write failure (fail closed)**.
- **Verification**: `verifyChain(company, range)` API + a background verifier
  (`NPATI_AUDIT_VERIFY_INTERVAL_MS`, default 6 h) that runs without a user context through a
  workspace-scoped system path and logs a critical alert per broken chain. After a break, the service
  refuses new privileged writes for that company (`blockOnBreak`, default true, documented off-switch)
  until an operator clears it.
- **Daily anchors**: every day the head hash of each company is stored in `audit_anchors` **and**
  written as an HMAC-SHA256-signed JSON file outside the Core database
  (`NPATI_AUDIT_ANCHOR_DIR`, default `<data dir>/audit-anchors`); the signature is verified on read, so
  an attacker who rewrites the table (and matches the chain) still disagrees with the anchor.
- **Access and export**: journal, verification, anchors and export require the owner/admin role
  (`*`/`owner`/`admin:all`/`audit:read`) and are refused *before* any company lookup (403
  `audit_read_denied`); anonymous callers get 401 with the authentication error's own code; a
  deployment without the journal returns 503 `audit_unavailable`. The export endpoint is itself
  audited (`audit.export`), supports filters (actor, request_id, correlation_id, action, fromSequence)
  and returns JSONL. Retention is configured (`NPATI_AUDIT_RETENTION_DAYS`, only ids/hashes/metadata).
- **Privileged paths wired in C1c (fail closed)**: approval decisions
  (`approval.decide`, with the hash of the exact payload the approver saw, so approval/execution
  substitution is detectable), guardrail policy changes (`policy.guardrail.update`, before/after
  policies hashed, blocked-term values never stored), code project/session actions
  (`code.project.create`, `code.project.update`, `code.session.create`, `code.session.archive`,
  `code.session.status`) and audit export. Company deletion is the next hook (see risks).

## Files / migrations / capabilities changed (C1c)
- Migration **`packages/workspace/src/migration-066.ts`** (`066_tamper_evident_audit_log`), registered
  in `postgres-store.ts`; new module `packages/workspace/src/audit-chain.ts` (exported from the
  package index).
- Workspace package: `types.ts` (audit types + store interface incl. the system path),
  `postgres-store.ts` (advisory-locked append, list/verify/state/anchors, system path), `in-memory-store.ts`
  (same semantics; entries are stored and returned as clones with no update/delete path).
- agent-api: **new** `audit-log.ts`, `audit-config.ts`; changed `audit-routes.ts` (journal, verify,
  anchors, export + owner/admin gating), `approvals-routes.ts` (audited decisions),
  `guardrail-policy-routes.ts` (audited policy changes), `code-service.ts` (audited code actions),
  `app.ts` (service construction, route wiring, verify + anchor timers, `AUDIT_SYSTEM_WORKSPACE`).
- Config/docs: `.env.example` (`NPATI_AUDIT_*`, `NPATI_WORKSPACE_ID`), this file.
- Capabilities: none added (still **348 inventory / 84 agent-callable**).

## Verification (C1c)
- `npm run typecheck` → 0 errors (13 workspaces); both builds exit 0 (agent-api, web).
- `tests/coding-agent-c1c-audit-log.test.ts` → **10/10** (always runs): chain continuity and head
  hash, four tamper cases detected by the pure verifier (content rewrite, hash rewrite, sequence gap,
  duplicate sequence), payload binding (substitution changes the recorded hash), fail-closed on a
  failing store, break → privileged writes blocked → cleared after investigation, secret/prompt
  redaction (keys and `CredentialMasker` patterns), per-company and per-workspace isolation, signed
  daily anchors (signature verified, rewritten anchor detected), and API access control
  (403 for a plain member on all four endpoints, 401 anonymous, 200 + `audit.export` recorded for
  admin, 503 when the journal is not configured).
- `tests/coding-agent-c1c-audit-postgres.test.ts` → **3 tests, skipped without `DATABASE_URL`** (their
  names carry the skip reason). They are the DB-level guarantees: the append-only trigger rejects
  UPDATE/DELETE for the application role, a rogue INSERT that would fork the chain is rejected by the
  chain guard, and a superuser bypass (trigger disabled, row edited) is detected by `verifyChain`
  which then blocks new privileged writes.
- Regression slice with the C1 suite: 30 passed / 3 skipped (projects, code foundation).

## Real E2E status (C1c)
- Verified in-process: the whole chain model, redaction, fail-closed behaviour, blocking, anchors
  (including real file writes and signature checks), API authorization and audit-export recording.
- **Not verified here (needs PostgreSQL):** the triggers and REVOKE themselves, the advisory-lock
  concurrency path in a real database, and anchor rows written by the background timer. These are
  covered by the three DB-bound tests above, which must be executed by the DB-backed job
  (`npm run gate:upgrade`, the Docker CI job, and the SG-* checkpoints) — this is the one deliberate
  skip in the step and it is reported as such rather than weakened.

## Known risks / open questions (C1c)
1. **A superuser can still disable the triggers.** That is exactly why the hash chain and the external
   signed anchor exist: such an edit is detectable, and the service then blocks new privileged writes.
   The anchor is only as trustworthy as the key in `NPATI_AUDIT_ANCHOR_KEY`/`NPATI_ENCRYPTION_KEY` and
   the storage holding the anchor directory (recommendation: a volume that is not part of the database
   backup rotation, or object storage with object-lock — decided in R1).
2. **`blockOnBreak` defaults to true**, so a break halts privileged audit writes until an operator
   investigates and clears it. The off-switch (`NPATI_AUDIT_BLOCK_ON_BREAK=false`) is documented; the
   owner should confirm the default is acceptable for production.
3. **Retention is configured but not enforced** (`NPATI_AUDIT_RETENTION_DAYS`); pruning is R1 work and
   must never delete rows that an anchor/verification still needs.
4. **Company deletion is not yet audited.** The hook (`beforeDeleteCompany` in `app.ts`) is the next
   natural insertion point; it needs the company id before the row disappears, so it should be wired
   together with the C1a flag work or as a small follow-up in C5a (RBAC/export/delete events).
5. **Not every privileged event is wired yet**: feature flags and kill switch (C1a), protected-branch
   and network allowlist changes (C4b/C5a), image allow/revoke (C1b), `SecretLease` metadata (C4),
   RBAC/role changes and ProviderDataPolicy (C5a/C5b) will call `AuditLogService.record()` as those
   features appear.
6. The background verifier uses `NPATI_WORKSPACE_ID` (default `dev-workspace`, matching the local auth
   provider). A multi-workspace deployment must iterate workspaces; the store's system path is already
   workspace-scoped for that reason.

## Next-session handoff (superseded — see the C2 handoff above)
- The C2 step described here is complete; the binding handoff for the next session is the
  "Next-session handoff" section under the C2 block above (execute only **C3**).
- Historical note for C2: capabilities were registered with the domain `code`, the tool-schema manifest
  was raised to v2, and the counters are now **354 / 90**.
- **`code_project` project type** on the existing `Project` entity (no new entity): the enum and CHECK
  constraint were extended additively, so Website Builder projects keep working unchanged.
- **Classification and retention** exist on projects and sessions: `data_classification`
  (`public | internal | confidential | restricted`, default `confidential`) and `retention_class`
  (`ephemeral | short | standard | extended | until_deleted`, default `standard`), with helpers
  (`isClassificationAtLeast`, `strictestClassification`). Sessions inherit the project classification;
  raising is always allowed, lowering requires an administrative role (`admin:all`/`owner` today,
  C5a replaces this with real roles).
- **Toolchain detection** (`code-toolchain-detector.ts`): Node (npm/pnpm/yarn from lockfiles),
  Python (pip/poetry/uv, pytest/ruff/mypy), Go, Rust, Java (maven/gradle), PHP (composer), plus a
  Makefile fallback that never overrides an explicit package-manager script. The result is stored as
  project metadata (`projects.toolchain`) with `source: detected|manual`, `detectedAt` and `evidence`,
  and can be corrected by the owner through the API/UI.
- **CodeSession** (`code_sessions` table + store/service/API): tied to the existing company Run via
  `run_id` (reuse, not duplication), with mode, model profile, status, parent session, summary,
  classification, retention and a reserved `tool_manifest_version` column that C1a will fill.
- **Repository import reuses the Website Builder path**: `CodeService.createProject` calls the
  existing `ProjectImportService.importRepository` (sandbox clone + Company-vault credential for
  private repositories), then detects the toolchain from the resulting workspace. Import failures are
  structured (`repository_import_failed`, retryable) and never carry credentials.
- **Sandbox image (C1 part)**: `Dockerfile.project-sandbox` now ships the base coding toolchain
  (`ripgrep`, `build-base`/`make`/`g++`, `bash`, `patch`, `diffutils`, `jq`, `unzip`, `curl`,
  `openssh-client`, `git`) on top of Node/Python/PHP; the container stays unprivileged
  (`USER 10001:10001`) and the existing isolation (read-only rootfs, `--cap-drop ALL`, tmpfs
  workspace, internal network + egress proxy, no host mounts, no docker socket) is unchanged.
- **Configuration instead of literals** (`code-agent-config.ts`): the plan's limits table is a typed,
  env-overridable configuration (`NPATI_CODE_*`, documented in `.env.example`), and
  `CODE_AGENT_ENABLED_BY_DEFAULT = false` records that the feature is dark until C1a.
- **Minimal UI**: Settings → **Code** (`/settings/code`) with a settings card next to Website
  Builder, four statistics, project table (repository, toolchain chips, classification/retention
  badges), detail drawer with verify-command editing, session table with create/archive, and a limits
  block fed by `GET …/code/limits`.
- **API (company-scoped, ownership checked server-side)**: `GET/POST /companies/:companyId/code/projects`,
  `POST …/projects/:projectId/code/detect-toolchain`, `PATCH …/projects/:projectId/code`,
  `GET …/code/sessions`, `POST …/projects/:projectId/code/sessions`,
  `GET …/code/sessions/:sessionId`, `POST …/code/sessions/:sessionId/archive`, `GET …/code/limits`.

## Implemented (C1)
- **`code_project` project type** on the existing `Project` entity (no new entity), and classification
  plus retention fields on projects and sessions (defaults `confidential` / `standard`), with session
  inheritance and role-gated downgrades.
- **Toolchain detection** for Node/Python/Go/Rust/Java/PHP (+Makefile fallback), stored as project
  metadata with `source`, `detectedAt` and `evidence`, editable by the owner.
- **CodeSession** records tied to the existing company run, repository import through the Website
  Builder path, the sandbox image extended with the base coding toolchain, limits as configuration,
  and the minimal Settings → Code UI.

## Files / migrations / capabilities changed (C1)
- Migration: **`packages/workspace/src/migration-065.ts`** (`065_code_projects_and_sessions`),
  registered in `packages/workspace/src/postgres-store.ts`. Additive only: extend the project type
  CHECK, add `data_classification`, `retention_class`, `toolchain`, `default_branch`, create
  `code_sessions` + indexes. No destructive statement, so a rollback stays a flag change.
- Workspace package: `types.ts` (types, enums, helpers, store interface), `postgres-store.ts`
  (columns, create/update project, session CRUD), `in-memory-store.ts` (mirror for tests).
- agent-api: **new** `code-toolchain-detector.ts`, `code-agent-config.ts`, `code-service.ts`,
  `code-routes.ts`; changed `project-service.ts` (`updateCodeSettings`), `project-routes.ts`
  (type enum), `app.ts` (service + routes wiring, `codeAgentLimits` config), `server.ts`
  (limits from env), `Dockerfile.project-sandbox` (toolchain).
- web: **new** `CodeSettingsPage.tsx`; changed `App.tsx` (card + route) and `styles.css`.
- Config/docs: `.env.example` (`NPATI_CODE_*`), this file.
- **Capabilities: none added in C1** (no tools yet), so the registry counters stay at
  **348 inventory / 84 agent-callable** and the matrix audit script keeps passing.

## Verification (C1)
- `npm run typecheck` → 0 errors (13 workspaces).
- `npm run build --workspace @npati/agent-api` → exit 0; `npm run build --workspace @npati/web` → exit 0.
- New suite `tests/coding-agent-c1-foundation.test.ts` → **16/16**, covering: toolchain detection for
  Node/Python/Go/Rust (+Makefile precedence), the configuration defaults and env overrides,
  code-project create/detect/list/edit with revision checks, session create/list/get/archive,
  classification inheritance plus downgrade rejection (owner vs admin), archived-project and
  cross-project parent session refusals, HTTP status contracts (201/400/401/403/503),
  `security-gate` cases for cross-company/cross-user isolation, a private-repository import failure
  that must not echo the credential, and a `code_unavailable` check for the dark-launch state.
- Regression slice (24 files, **309 tests passed**): capability registry + inspector + counters,
  project foundation/intent/preview/workspace/files/terminal/sandbox-egress/sandbox-provider/deploy,
  Website Builder schema + chat e2e, Data Studio UI/mobile/D7, agent-api, architecture,
  effective-capability-resolver.

## Real E2E status (C1)
- Verified: everything above runs against `InMemoryWorkspaceStore` and Fastify injection, i.e. the
  full C1 logic (schema types, detection, service rules, routes, isolation).
- **Not verified here:** the new `code_sessions`/project columns against a live PostgreSQL (no Docker
  in this environment — the migration is additive and mirrors migration 060–064 patterns, but a real
  `npm run gate:upgrade`/Docker run is still required), the rebuilt sandbox image (needs a Docker
  build), and a real private-repository clone through the sandbox runner.
- Sandbox isolation properties (unprivileged user, no host visibility, egress allowlist) remain
  covered by the existing `tests/project-sandbox-provider.test.ts` and
  `tests/project-sandbox-egress.test.ts`; C1 changed image contents only.

## Known risks / open questions (C1)
1. **Go/Rust/Java runtimes are not in the sandbox image.** Detection already reports them, but
   running their verify commands needs the toolchains. Decision deferred to **C1b** (digest-pinned
   image variants), recorded in the audit section 7.4 — the owner must confirm this is acceptable.
2. **Lowering classification/retention uses `admin:all`/`owner`** as a stand-in; C5a must replace it
   with the real role model (and multi-user Company support, which does not exist yet).
3. **C1 has no feature flag yet** (C1a): the feature is dark by convention
   (`CODE_AGENT_ENABLED_BY_DEFAULT = false`) and routes currently rely on the existing owner/admin
   permission checks. C1a must gate every route and add the kill switch.
4. **No audit-log writes yet** (C1c): creating a code project/session is not yet recorded in a
   tamper-evident log; today it is only visible through the existing audit/activity surfaces.
5. **`verifyCommands: {}` intentionally clears all commands** (the UI sends it only when the four
   fields are emptied); C2/C4 should decide whether an empty command set blocks verification runs.
6. Naming: the project type is `code_project`; the audit/plan wording "code repository" refers to the
   same thing, so no rename is expected.
