#!/usr/bin/env node
/**
 * C4a: the mandatory `security-gate` job (SG-1).
 *
 * The rule of the project is that security-gate tests are never skipped and never weakened, so this
 * script runs a **fixed** list of suites and fails when any of them fails *or* reports a skipped test.
 * A suite that silently disappears is a failure too: the list is the contract, not a discovery scan.
 *
 * It also runs the two artifact guards that belong to the same gate:
 *   - `scripts/verify-code-tool-schemas.mjs --check` — a published tool schema may not change silently;
 *   - `scripts/sandbox-image-verify.mjs` — every sandbox image must stay digest-pinned and fresh.
 *
 * Usage: node scripts/run-security-gate.mjs [--list]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The suites that make up the gate. Adding a security-gate suite means adding it here. */
export const SECURITY_GATE_TESTS = [
  "tests/coding-agent-c1c-audit-log.test.ts",
  "tests/coding-agent-c1b-images.test.ts",
  "tests/coding-agent-c1b-image-api.test.ts",
  "tests/coding-agent-c2-read-tools.test.ts",
  "tests/coding-agent-c2-tool-runtime.test.ts",
  "tests/coding-agent-c2-schema-parity.test.ts",
  "tests/coding-agent-c3-write-engine.test.ts",
  "tests/coding-agent-c3-runtime.test.ts",
  "tests/coding-agent-c3-schema-executor-parity.test.ts",
  "tests/coding-agent-c4-classifier.test.ts",
  "tests/coding-agent-c4-shell.test.ts",
  "tests/coding-agent-c4-secret-lease.test.ts",
  "tests/coding-agent-c4-credentials-environment.test.ts",
  "tests/coding-agent-c4-policy-engine.test.ts",
  "tests/coding-agent-c4a-install-policy.test.ts",
  "tests/coding-agent-c4a-classifier.test.ts",
  "tests/coding-agent-c4a-deps-guard.test.ts",
  "tests/coding-agent-c4a-audit-and-secrets.test.ts",
  "tests/coding-agent-c4a-typosquat-dataset.test.ts",
  "tests/coding-agent-c4a-registry-allowlist.test.ts",
  "tests/coding-agent-c4a-capabilities.test.ts",
  "tests/coding-agent-c4a-security-gate.test.ts",
  // C4b: sandbox network policy — activity events, allowlist administration, SSRF client and the
  // consolidated network acceptance list.
  "tests/coding-agent-c4b-network-activity.test.ts",
  "tests/coding-agent-c4b-allowlist.test.ts",
  "tests/coding-agent-c4b-ssrf-client.test.ts",
  "tests/coding-agent-c4b-egress.test.ts",
  "tests/coding-agent-c4b-acceptance.test.ts",
  // C4b: runner readiness endpoint (probe contract, TTL cache, fail-closed) and the separate
  // destination policy applied to webhooks.
  "tests/coding-agent-c4b-readiness.test.ts",
  "tests/coding-agent-c4b-webhook-policy.test.ts",
  // C4b: the provider/runner wiring must expose the same enforcement defaults as the policy module.
  "tests/coding-agent-c4b-allowlist-wiring.test.ts",
  // C5 (SG-2): effective permissions and trust, every approval-bypass attempt, and the structured
  // decision events that make a verdict provable afterwards.
  "tests/coding-agent-c5-approval-scope.test.ts",
  "tests/coding-agent-c5-trust-and-injection.test.ts",
  "tests/coding-agent-c5-capability-groups.test.ts",
  "tests/coding-agent-c5-decision-activity.test.ts",
  "tests/coding-agent-c5-approval-bypass.test.ts",
  // C5a (SG-2): people-side authorization — the RBAC gate, company membership and invites, and the
  // escalation attempts (developer -> full_auto, reviewer -> run, protected-branch pushes).
  "tests/coding-agent-c5a-rbac-foundation.test.ts",
  "tests/coding-agent-c5a-rbac.test.ts",
  "tests/coding-agent-c5a-membership.test.ts",
  "tests/coding-agent-c5a-role-escalation.test.ts",
  // C5a: the decisions that change what a person may do — protected branches (D9), the role -> session
  // mode matrix (D6), membership (D4), project trust (D7), the privileged-permission boundary (D3) and
  // the action -> permission mapping (D11).
  "tests/coding-agent-c5a-protected-branches.test.ts",
  // C5a: production operations (code.prod.operate, step-up/two-person) and the narrow service identity
  // unattended automations run as.
  "tests/coding-agent-c5a-prod-operations.test.ts",
  "tests/coding-agent-c5a-automations-identity.test.ts",
  // C5b (SG-3): provider data policy — private code and secrets must not leave NPATI towards a provider
  // that has no permission for them, and routing must skip (or stop on) providers the policy forbids.
  "tests/coding-agent-c5b-provider-guard.test.ts",
  "tests/coding-agent-c5b-routing-eligibility.test.ts",
  "tests/coding-agent-c5b-policy-resolver.test.ts",
  "tests/coding-agent-c5b-policy-store.test.ts",
  // C6: the chat entry point must choose between chat and the coding agent deterministically (and a
  // disabled agent must not change chat), and the eval harness must prove the real tool path works while a
  // wrong transcript fails.
  "tests/coding-agent-c6-intent-routing.test.ts",
  "tests/coding-agent-c6-eval.test.ts",
  // C6: model profiles (configuration, not code) and the provider tool-call normalisation layer.
  "tests/coding-agent-c6-model-profiles.test.ts",
  "tests/coding-agent-c6-tool-call-adapter.test.ts",
  // C5b: policy administration — who may change what may leave NPATI (owner-level authority, versions,
  // audit before apply, tenant isolation, eligibility reporting).
  "tests/coding-agent-c5b-policy-management.test.ts",
  "tests/coding-agent-c5b-policy-rbac.test.ts",
  // C5b: the non-model outbound channels (web search/fetch/crawl, MCP, email, messaging, webhooks) — a
  // secret is refused for delivery channels and redacted (never sent raw) for retrieval channels, and the
  // transport is asserted never to have been called with the sensitive value.
  "tests/coding-agent-c5b-outbound-guard.test.ts",
  // C6: the agent loop itself. The first suite pins the model/tool contract (policyContext on every call,
  // read-only waves, sequential mutations, truncated arguments never executed, reminders, cancellation,
  // metadata-only Activity); the second pins every stop condition with its reason and summary.
  "tests/coding-agent-c6-runner.test.ts",
  "tests/coding-agent-c6-runner-stop-conditions.test.ts",
  // C6a: the reaper. Pins that a dry run mutates nothing, that a second pass over already cleaned targets
  // is a no-op rather than an error, that orphan work is only cleaned when its owner is provably gone
  // (live/active/unlabelled targets are left alone, advisory migration locks are never released blind),
  // that one failing step cannot take the other steps down, and that metrics carry counts — never content.
  "tests/coding-agent-c6a-reaper.test.ts",
  // C6a: the run state log and the reconciler. Pins the durable per-turn/per-tool-call state, the lease
  // and heartbeat semantics, that a run without a live lease becomes `interrupted`, that recovery starts
  // at a turn boundary, that a read-only tool call may be repeated while a write/shell call is never
  // repeated (its result becomes `unknown_outcome` with a workspace diff against the last checkpoint),
  // and that a dry run and a repeated pass change nothing.
  "tests/coding-agent-c6a-run-state.test.ts",
  "tests/coding-agent-c6a-reconciler.test.ts",
  // C6a security: database migrations. Pins that a production, external or unidentified target is a hard
  // deny that no mode, role, standing rule or `approved: true` claim can lift; that a development
  // DataBackend is only reachable through the Data Studio migration engine; that destructive work
  // (DROP/TRUNCATE/DELETE without WHERE/column removal/type change) requires a snapshot as well as an
  // approval; that a migration hidden inside a project script is detected; that the agent never sees a
  // production connection string; and that a revoked/denied verdict never reaches the engine at all.
  "tests/coding-agent-c6a-migration-safety.test.ts",
  // C6b: execution snapshots are append-only (a reused id is refused, and there is no update/delete path at
  // all); a run's snapshot is found by `run_id`; config versions are deduplicated by content hash and a change
  // mints a new immutable version; a secret-shaped value in the sources refuses persistence (`snapshot_secret_detected`)
  // rather than being silently stripped; and a run without a snapshot answers `legacy_no_snapshot` instead of failing.
  "tests/coding-agent-c6b-snapshot-store.test.ts",
  // C6b: every Activity family (tool call, policy decision, network decision, run, reconciliation) carries
  // its `snapshot_id` and is persisted with a classification/retention from creation; a command line, diff,
  // prompt or terminal output in the payload is refused instead of being stored; a secret hidden in an
  // innocuous key is refused by value; and a store failure is reported without changing the decision.
  "tests/coding-agent-c6b-activity-snapshot.test.ts",
  // C6b: the versioned replay bundle. Recording covers every field a deterministic replay needs (format
  // version, environment, prompt/profile versions, provider answers, ordered tool calls with their schema
  // version and the canonical settled result); the recorded input hash is stable for the same exchange; a raw
  // artifact is excluded from the replay input so untruncated output cannot influence a replay; a secret in a
  // provider answer or a tool result refuses the bundle instead of being stripped; and a failed write is
  // reported without changing the run.
  "tests/coding-agent-c6b-replay-bundle.test.ts",
  // C6b: deterministic replay. The recorded mode verifies the recorded run against its own two records (the
  // model output and the execution) and makes no provider call and no tool execution at all — the engine has
  // no live port, so that is structural, not promised. Every divergence (a different order, tool, schema
  // version, argument hash, an extra or missing call, a contradicted terminal status) is reported with a
  // structured, metadata-only reason; an unsupported format version, a tampered input hash and a truncated
  // recording are refused instead of partially replayed.
  "tests/coding-agent-c6b-replay-deterministic.test.ts",
  // C6b: live replay. It starts a **new** run, really calls the model and the tools, keeps the source
  // run/snapshot references, and is labelled best-effort with the owner's notice verbatim — a result that
  // claims "deterministic" is refused by a guard, and the shared gate refuses the replay without permission.
  "tests/coding-agent-c6b-replay-live.test.ts",
  // C6b: the read-only "why did the agent act this way" surface. A run recorded before C6b answers
  // `legacy_no_snapshot` (and a run without a recording `no_bundle`) with HTTP 200 and no error shape, so
  // history stays readable; the snapshot answer carries the identity Run Trace needs; the diff is the
  // store's content-safe structural diff and never echoes payload values; replay metadata is counts and
  // hashes only, with the best-effort notice verbatim for a live bundle; a stored Activity event that
  // carries content is refused loudly instead of being filtered; reads are authorized by the shared gate on
  // named actions, refused before the store is touched, and tenant-scoped.
  "tests/coding-agent-c6b-snapshot-api.test.ts",
  // C7: the code project lifecycle. Archive and delete go through the existing service (whose hook destroys
  // the sandbox), a partial cleanup is never reported as success, a repeated delete is `already_deleted` with
  // byte-identical answers for a missing and a foreign project (so the route is not an existence oracle),
  // every mutation is journalled before it applies (a failing journal means no effect), and each new action is
  // mapped so an unmapped action is refused instead of inheriting the caller's label.
  "tests/coding-agent-c7-project-lifecycle.test.ts",
  // C7: session control. Stop reports the three facts separately (recorded, aborted, sandbox released) and is
  // idempotent; usage says `unavailable` with a reason instead of inventing zeros; changes are rebuilt from
  // named fields so the reader's diff body cannot reach the client; revert validates paths with the canonical
  // validator before any git call, refuses per-file revert rather than silently hard-resetting everything, and
  // never touches the workspace when the journal fails; the active context is validated, not duplicated.
  "tests/coding-agent-c7-session-control.test.ts",
  // C7: the agent stream the Workspace renders. The transcript is read from the C6b replay bundle because the
  // runner never writes `code_run_turns.messages`; a run without a bundle is answered as `streamUnavailable`
  // rather than an empty stream, so "said nothing" and "never stored it" stay distinguishable. An unknown run
  // and a foreign run answer with byte-identical 404s (no existence oracle), authorization happens before any
  // store read, a credential in a stored tool result is refused instead of served, and a huge result is bounded
  // with an explicit truncation marker.
  "tests/coding-agent-c7-run-stream.test.ts",
  // C7: the web-source XSS invariant, runnable without jsdom or @testing-library (which are not installed),
  // so an HTML-injection path in `apps/web/src` cannot enter unnoticed: `dangerouslySetInnerHTML` and the
  // DOM-writing primitives are allowed only at explicitly listed sites with a written reason and an
  // occurrence cap, and a `javascript:` or template-built `href`/`src` is refused outright. It also executes
  // the pure escaping helpers behind chat card markdown, which is where a quote-escape gap let a link URL
  // close its own `href` attribute and install an event handler.
  "tests/coding-agent-c7-web-xss-source-scan.test.ts",
  // C7: the chat-side integration of the code workspace. Pins that the PERSISTED active project/session is
  // what chat follows (and that an explicit request project still wins), that the stored pointer is scoped to
  // its user and company, that a payload from a future schema version is treated as absent rather than guessed
  // at (acting on an unknown shape would start work in a workspace nobody selected), and that the versioned
  // code card travels with the message it belongs to and never into another user's conversation.
  "tests/coding-agent-c7-chat-integration.test.ts",
  // C7: real removal of a project's on-disk workspace. Pins that a delete which leaves bytes behind answers
  // `partial` instead of "deleted", that removal is idempotent, that a symlinked workspace is refused with the
  // link target left intact, and that a sibling project of the same company is untouched.
  "tests/coding-agent-c7-workspace-cleanup.test.ts",
  // C7: path-scoped revert. Pins that restoring named paths never issues `reset --hard` or `clean`, that hostile
  // paths (traversal, absolute, `~`, secret, malformed) are refused before any git process starts, that a symlink
  // in the path aborts the call, and that a mandatory pre-restore safety checkpoint keeps the revert reversible.
  "tests/coding-agent-c7-revert-paths.test.ts",
  // C7: usage accounting and the RBAC of destructive project actions. Pins that an unknown measurement is never
  // reported as `0` (three distinguishable answers: not recorded / unmeasurable with a reason / real totals),
  // that price is never inferred from tokens, and that archive/delete are allowed for owner/admin and denied for
  // developer/reviewer on the existing `business:manage` vocabulary.
  "tests/coding-agent-c7-usage-and-rbac.test.ts",
  // C7: the shared project-files adapter. Pins that exactly one module builds a `files/*` URL — a source scan
  // over `apps/web/src` fails on a hand-built one unless it is listed with a written reason, and a *stale*
  // exemption fails too, so the list cannot rot into a blanket permission. Also pins that ids and paths are
  // always encoded (a hostile id may not become a path segment or a query parameter) and that traversal,
  // absolute, drive-letter, home-relative and backslash paths are refused by the typed guard.
  "tests/coding-agent-c7-project-files-adapter.test.ts",
  // C8: the repo map. Pins that only structure (paths and signatures) ever reaches the prompt — never a
  // file body — that noise directories and lock files are excluded with the sandbox's own exclusion list,
  // that the token limit is honoured with an *explicit* truncation marker, that secret files are not even
  // named and a secret-shaped value makes the whole build refuse rather than be stripped, that the cache
  // is keyed by content as well as commit (a run edits files long before committing, so a commit-only key
  // would serve a stale map of the file it just wrote), that one company's map is never served to another,
  // and that a warm cache returns byte-identical output — the map becomes replay input (C6b), so the cache
  // must stay an optimisation and never a second source of truth.
  "tests/coding-agent-c8-repo-map.test.ts",
  // C8: context budget, conversation compaction and the two non-repository context sources. Pins that
  // NPATI_CODE_CONTEXT_COMPRESSION_RATIO is actually read (it was dead configuration until C8) and that the
  // threshold is taken from the profile's context_window rather than a model-name heuristic, that a stub keeps
  // the call it elided (id, tool, schema version, argument hash, outcome) so the transcript still explains what
  // the agent did, that the last turns survive byte-for-byte, that the structured summary keeps goal,
  // decisions, changed files, commands with results, open problems and next steps, that compaction is a
  // deterministic function of its input (it becomes replay input, so a second replay must see the same bytes),
  // that a summary carrying a secret is refused rather than scrubbed, and that company memory and repository
  // project context stay separate labelled blocks so repository data never carries tenant authority.
  "tests/coding-agent-c8-context-compaction.test.ts",
  // C8 acceptance: a scripted 100+ turn session with decisive facts (goal, decisions, plan, open problems,
  // changed files, commands with results) must compact automatically around the configured share of the whole
  // model request and still keep every one of those facts; old tool outputs are pruned while the calls and their
  // order survive; and the recorded CompressionArtifact is byte-identical on a second identical run, which is
  // what lets deterministic replay feed the recorded artifact instead of recomputing a non-deterministic summary.
  "tests/coding-agent-c8-long-session.test.ts",
  // C8: the compaction artifact is recorded model-visible state. Pins that the persisted replay-bundle format
  // was raised to version 2 when the artifact field was added (rule 13), that the artifact is byte-stable so a
  // replay can feed it back verbatim instead of regenerating a summary that would differ, that it carries the
  // exact summary text, source range and hashes, retained turns, pruned-result references and the placeholders
  // the model actually saw — but no pruned payload — and that it neither carries a secret or a secret-lease
  // value nor adopts an untrusted repository instruction as a decision, plan entry or policy-looking statement.
  "tests/coding-agent-c8-replay-compression.test.ts",
  // C8: the compaction artifact as **replay input**, walked end to end through the real `replayRecorded`. Pins
  // that a compacted session replays to the same terminal status with the recorded artifact reused (identified
  // by its own content hash), that offering a summarizer is *refused* rather than silently ignored and is then
  // never called, that a bundle without the artifact field reads as "no compaction" instead of "summarise on the
  // fly", that a summary swapped into the header afterwards fails the integrity check, that an unusable artifact
  // refuses the replay instead of degrading it — and, one layer down, that the model-visible truncated result is
  // deterministic while an optional raw reference beside it can never substitute it or change the input hash.
  "tests/coding-agent-c8-replay-compaction-e2e.test.ts",
  // C8: the compaction summary is provider-bound content and the system prompt keeps a stable prefix. Pins that
  // the summary passes the **existing** C5b guard (policy resolution, classification ceiling, private-code rule,
  // redaction) and is refused rather than scrubbed when it would have to be redacted, that metadata-only
  // decisions are recorded without the text, that a SecretLease value — opaque, so no pattern can match it — is
  // refused by comparison with the values the run issued, that an untrusted repository instruction cannot become
  // policy through compaction, that the persisted summary carries classification/retention from creation and is
  // tenant-scoped, and that the cacheable prefix holds policy, tool schemas, limits and the data invariant while
  // environment facts, repository instructions and retrieved memory are strictly after the boundary.
  "tests/coding-agent-c8-summary-guard-prefix.test.ts",
  // C8: project instructions (`NPATI.md` / `AGENTS.md` / the shared `PROJECT.md`). Pins the deterministic
  // hierarchy (root always, a subdirectory file only along the path of the work — never recursively), the single
  // shared name list so no third convention appears, the explicit truncation marker, a content hash that moves
  // when the effective instructions move and stays put otherwise, and that a file containing a credential is
  // *excluded and reported* rather than silently redacted (redaction would hide the leak from the user).
  "tests/coding-agent-c8-instructions.test.ts",
  // C8: trust is a label on data, never a grant of authority. Pins behaviourally that hostile instructions
  // ("ignore previous instructions", "run commands without approval", "enable full_auto", "grant yourself a
  // tool") change neither the session-mode line nor the tool list in the system prompt, that the report carries
  // no key any policy decision reads and `canChangePolicy` is literally false in both trust states, that the
  // invariant is the *last* thing before the instructions block, and that the trust route finally exists —
  // without it `CodeProjectTrustService.trust()` was called from nowhere, so "after the user trusts the
  // project" was unreachable in production while looking implemented, and a mutation without `expectedRevision`
  // is refused before the service is touched.
  "tests/coding-agent-c8-instructions-trust.test.ts",
  // C8: `code.symbols.outline` is actually connected. Pins a silent-no-op defect class: the `runCtags` port was
  // declared, threaded and implemented while nothing supplied it, so a published, Capability-Inspector-visible
  // tool always answered `symbols_unavailable`. Behaviour is checked (runner invoked and parsed; absent or
  // throwing runner yields the structured state, never an exception) plus a source guard that `app.ts` still
  // passes the runner into the canonical executors **through the sandbox transport** rather than the host.
  "tests/coding-agent-c8-symbols-wiring.test.ts",
  // C7: Website Builder regression behind that shared surface. The real `LocalProjectWorkspace` and the real
  // file routes are driven so a shared surface cannot break its original consumer: write/tree/read round-trip
  // with the revision, `website` and `code_project` served by the one implementation, `workspace:read` still
  // required (a permission set with nothing relevant is the negative control — `business:manage` is granted
  // read by design and would be a false negative), another tenant's project yields no content, and the
  // service's own protections still hold for the new consumer: `invalid_path` for traversal and `secret_path`
  // for `.env`/`.ssh`/`credentials`/`*.pem`.
  "tests/website-builder-regression.test.ts",
  // C9: the verification/repair loop. Pins that the repair budget is the configured limit and that exhausting
  // it **stops** with a code instead of looping or reporting success, that a failing check reaches the model as
  // an actionable instruction naming the check and stating the two prohibitions (do not weaken a test, do not
  // claim a pass), that an approval-gated or unconfigured check stops the loop rather than being worked around,
  // that asking for a decision twice cannot double-spend the budget, and that a check which never ran is a
  // failure rather than a pass. `NPATI_CODE_REPAIR_LOOP` existed since C1 and nothing read it; the
  // environment-driven test is what makes it a live handle instead of a dead configuration key.
  "tests/coding-agent-c9-verification-loop.test.ts",
  // C9: the test-integrity guard — "make it green" by weakening the suite. Pins detection of a deleted test
  // file, removed cases, `.skip`, `.only` (worse than a skip: it silently disables the rest), a specific
  // assertion replaced by an existence check, removed assertions and a removed table-driven block, from full
  // contents **and** from a unified diff; that adding tests is never flagged; that an uninspectable change is
  // reported as nothing rather than guessed at; and that the verdict carries no diff text.
  "tests/coding-agent-c9-test-integrity.test.ts",
  // C9: the scope guard. Pins that it warns rather than blocks, that the threshold is configuration, that a
  // gross overrun is escalated instead of tolerated, that files outside the stated focus are named together
  // with the focus used, that docs/config changes are never "unrelated", that it admits it cannot judge
  // relatedness when there is no stated focus (rather than inventing a finding nobody can act on), and that the
  // reported path list is bounded.
  "tests/coding-agent-c9-scope-guard.test.ts",
  // C9: the loop end to end. Pins that a run which changed files is verified through the **canonical** tool
  // runtime, that a failure is fed back and the run then stops at the configured limit, that an approval-gated
  // or unconfigured verification stops instead of being bypassed, that a green check over a changed test set is
  // reported as `passed_with_unjustified_test_changes` (never as a clean pass) with the finding in Activity,
  // that the caller can opt out, and that the argument-correction loop and the repair loop stay separate: a
  // model sending unusable arguments exhausts *its* budget and does not consume a verification attempt.
  "tests/coding-agent-c9-runner-verification.test.ts",
  // C9: the planning tools. Pins that a plan is data — `validatePlanBody` keeps only files/steps/risks/
  // testStrategy, so a plan cannot smuggle an `executionMode` or an invented permission field into storage —
  // that two `in_progress` tasks, a duplicate task id and an oversized list are **refused rather than
  // normalised**, and that both tools are idempotent, which is what C6a recovery depends on: a repeated
  // read-only call must not append a second plan revision or duplicate the todo list.
  "tests/coding-agent-c9-plan-tool.test.ts",
  // C9: plan mode and the plan decision. Pins that the approved execution mode comes from the decision
  // request (the user) and never from the stored plan row, that approving without a mode is refused instead
  // of defaulting, that a stale or already-decided revision changes nothing, and that the three pre-existing
  // layers which block writes in plan mode still hold while the two new tools are reachable there — the mode
  // that exists to produce a plan.
  "tests/coding-agent-c9-plan-mode.test.ts",
  // C9: goals and acceptance criteria. Pins that a goal cannot be created without criteria, that `completed`
  // is refused while any criterion is unverified and allowed once all are, that illegal transitions use the
  // transition table, that `blocked` requires the question and clears it on resume, that progress is derived
  // rather than supplied, that a foreign goal is indistinguishable from a missing one, and that every
  // mutation on the surface is journalled before it is applied.
  "tests/coding-agent-c9-goal.test.ts",
  // C9: `code.ask_user` — the pause is a state, not a process. Pins that the question row survives a restart
  // (answered through a second service instance over the same store), that the reconciler never recovers a
  // `waiting_for_user` run and never replays the call that asked, that an agent or service token can never
  // answer (checked before the store is touched), that a repeated answer resumes the run exactly once, that
  // only a choice the question offered is accepted, that expiry releases the run with an explicit
  // `ask_user_timeout` and leaves no answer behind, and that a journal outage refuses the answer instead of
  // applying it unrecorded.
  "tests/coding-agent-c9-ask-user.test.ts",
  // C9: `code.ask_user` stops the loop. Pins that a run that asks reaches `waiting_for_user` and writes **no**
  // terminal state (so C6a cannot call the pause a crash), that no further model call and no further tool call
  // of the same turn happens, that the rest of the turn's calls are reported as not executed instead of running,
  // that a "successful" ask without a question id fails the run closed rather than continuing, that the tool is
  // reachable in plan mode through the narrow plan-safe list, and that the executor dispatches to the service
  // (metadata only, no answer) and fails closed when unwired.
  "tests/coding-agent-c9-ask-user-runner.test.ts",
  // C9: the question expires and releases its run. Pins that expiry moves the question to `expired` and the run
  // to `interrupted`/`ask_user_timeout` while writing **no** answer, that a question inside its TTL is left
  // alone, that the reaper step has a real dry-run preview and reports an unavailable port as a skip rather
  // than as clean, and that a restart keeps the question pending and a repeated answer resumes the run once.
  "tests/coding-agent-c9-ask-user-reaper.test.ts",
  // C9 (owner requirement 4): the self-review pass. Pins that it is **one** pass per run (a second call cannot
  // happen), that it reaches the provider through the existing ProviderDataGuard and a refused prompt text is
  // *not* sanitised and sent (and is never reported as clean), that it sees all six inputs including the
  // approved plan, that a deliberate secret and an unnecessary out-of-scope change in the diff are both found,
  // that at most **one** fix iteration follows and a *blocking* finding survives it as `unresolved` rather than
  // being rounded up to a clean run, that a review which changed the code triggers a second verification while a
  // review that changed nothing does not, that a failed or unusable review is `unavailable` (never `clean`), and
  // that a review asking to change a mode/policy/permission stays a `security` finding while the session mode,
  // the policy and the permissions are observably untouched.
  "tests/coding-agent-c9-self-review.test.ts",
  // C10: the two columns that had a reader and an updater but **no writer**. Pins that a turn's checkpoint is the
  // checkpoint that turn's writes were based on (a distinct one per step — the pre-C10 runner used a single
  // `turnId` for a whole run, so only the first turn could own one), that a step which wrote nothing carries the
  // checkpoint in force, that the session→run link is written once per run (`lastRun`/`usage` were permanently
  // `null` without it), that the run summary still aggregates across steps, and that the reconciler's notice is
  // persisted — and refused rather than scrubbed when it would carry a credential.
  "tests/coding-agent-c10-run-checkpoint-link.test.ts",
  // C10: the durable state the session operations are built on. Pins the single revision-checked conversation
  // cursor (a rewind cannot delete rows: the replay bundle and the context summaries are append-only, so a
  // truncation is a pointer move every reader applies); the claim-before-perform protocol of the rewind and fork
  // ledgers, including the asymmetry that a claim which provably changed nothing may be reopened while one that
  // created a checkpoint or a session may not; tenant scoping of every row; and migration 082 being additive,
  // classification/retention-carrying, free of any foreign key to a structure that does not exist yet, and
  // append-only for the notice.
  "tests/coding-agent-c10-session-durability.test.ts",
  // C10: resume. Pins that a resume continues the **same** `runId` (a second bundle for one run cannot exist, so a
  // second run would destroy the recording) and re-takes its lease; that a paused or finished run is refused with
  // its own reason; that lost processes are named from the durable `unknown_outcome` evidence while a replayable
  // read is reported separately; that the checkpoint of the last finished turn is reported and the workspace is
  // only rolled back on request; that a resume never writes the conversation cursor (which would truncate the
  // conversation it is continuing); and that the continuation prompt is rebuilt from the replay bundle, the
  // compaction summaries, the plan, the todos and the notice — bounded, and refused when the combination carries
  // a credential.
  "tests/coding-agent-c10-resume.test.ts",
  // C10: rewind in all three variants and fork. Pins that `code`/`conversation`/`both` each do exactly their own
  // half, that `both` reports `rewound_partial` instead of "rewound" when the cursor could not move, that a turn
  // without a checkpoint is refused with the nearest earlier one named, that a repeated operation creates no
  // second checkpoint, session or audit entry, that a journal outage refuses the rewind and can be retried, that a
  // fork fills `parent_session_id`, copies the plan as a draft and the todo list but not the goal (with the reason
  // reported), and that the replay bundle's format version and replay-input hash are untouched by this step.
  "tests/coding-agent-c10-rewind-fork.test.ts",
  // C10 (ТЗ item 5): a long code run outlives the tab. Pins that a background run owns its **own** abort signal (a
  // client disconnect only detaches the viewer), that every event carries a monotonic `seq` so a reconnecting
  // client is handed the tail it missed rather than a gap, that the event buffer and the tracked-run map are
  // bounded while the terminal event is always retained, that an unknown run answers with an empty identity (no
  // existence oracle), and — the finding that opened this step — that `notifications.backgroundResults` is finally
  // **read**, with the asymmetry that an approval request is never silenced by a results switch.
  "tests/coding-agent-c10-background-runs.test.ts",
  // C10 (ТЗ item 6): the code-run queue. Pins the configured caps and their hard clamp (nonsense falls back rather
  // than becoming `NaN`, and an enormous value is clamped, so configuration cannot remove the limit), the two
  // independent counters (per user, per Company), the bounded and cancellable wait (`queue_timeout`,
  // `queue_cancelled`, the depth cap), an idempotent release, and the state a UI renders.
  "tests/coding-agent-c10-run-queue.test.ts",
  // C10 (ТЗ item 6): the round-robin property on its own, measured over a **sequence of grants** because a
  // first-come-first-served queue passes every counter assertion and still starves the quiet tenant: one slot per
  // Company per turn, so a backlog cannot be served twice while another Company waits.
  "tests/coding-agent-c10-queue-round-robin.test.ts",
  // C10 (ТЗ item 7): the sandbox lifecycle. Pins that auto-stop keeps the sandbox tracked (which is what lets
  // retention reason about it at all), that the retention pass destroys only a sandbox that is idle past its
  // configured window, that it never destroys live work, that the retention window can never be configured shorter
  // than the inactivity window (retention destroys, so a typo must not delete a just-stopped sandbox), that a
  // release built on a **stale** project object is a no-op while a fresh read destroys for real, and that deleting
  // a project destroys its sandbox through the existing `beforeRemove` hook.
  "tests/coding-agent-c10-sandbox-retention.test.ts",
  // C10 (ТЗ item 8): the Markdown session export. Pins that it reuses the stream route's bounds (50 default, 200
  // cap, 4000-character settled results) instead of becoming a wider read path, that a credential refuses the whole
  // document with **kinds only** (no value, no redacted preview, no file), that the renderer escapes fences and
  // table separators so a tool name or model answer cannot restructure the document it is quoted in, that the
  // refusal happens before the store is read, and that `code.export` is an allowlisted flag key.
  "tests/coding-agent-c10-session-export.test.ts",
  // C10: the defect class per-module suites cannot see. `codeSnapshotContexts` was declared and read but never
  // written, so in the **built** application the snapshot, Activity and GET-replay routes answered 401 to every
  // request while `coding-agent-c6b-snapshot-api.test.ts` stayed green (it builds those routes with its own deps).
  // This suite drives the real `buildApp` and additionally fails if any `*Contexts` WeakMap in `app.ts` is ever
  // declared without a `.set` — so the next surface that forgets its `preHandler` is caught before it ships.
  "tests/coding-agent-c10-route-auth-wiring.test.ts",
  // C10 (owner review, request durability): the run's **original request**. Pins that it is written by the same
  // statement that creates the run — before the first model step, so a crash immediately after start cannot lose
  // it — that `startRun`'s idempotency by run id is what stops a resume from overwriting it with the
  // reconstructed continuation prompt, that the recorded bytes are hash-addressed and bounded with a visible
  // marker, and that tenant scoping, classification/retention at creation and the credential refusal hold. The
  // behavioural half drives the real runner, then a brand-new run-state log and resume service, and asserts that
  // resume recovers **exactly** the prompt the run was started with; a request that is not there is reported as
  // `request_not_recorded` / `request_refused_credential` / `request_record_unavailable` — never as a paraphrase
  // and never as silence. Migration 083 is pinned as additive with its CHECK vocabulary.
  "tests/coding-agent-c10-run-request.test.ts",
  // C10 (owner review, Question 2): what a resume does about a **changed environment**. Pins that a resume
  // records a NEW `ExecutionSnapshot` version with `trigger: "resume"` from the facts a resume can genuinely
  // re-read (the run-scoped ones no longer exist), that the comparison is the store's own content-safe
  // `diffExecutionSnapshots` restricted to the value families, that a moved policy/flag is reported in the API
  // response **and** in the continuation prompt instead of being continued silently, that a revoked sandbox
  // image stops the resume before the lease is taken (leaving the run resumable) while an unreadable source, a
  // legacy run with no snapshot, a capture refused for carrying a credential and a deployment with no port are
  // each reported with their own reason — never as "unchanged".
  "tests/coding-agent-c10-resume-environment.test.ts",
  // C11 (owner decisions 3–6): the git workflow's security core. Pins that the protected-branch decision is
  // made on a **typed** git intent (`gitOperation`/`sourceBranch`/`targetBranch`/`remoteBranch`/`remote`/
  // `force`) and never on a command string, so `git push` without a refspec is refused
  // (`git_push_requires_resolved_branch`) instead of reaching a decision with an empty branch, and a git
  // **tool** — which has no command line — must carry the intent or is refused outright; that the hard deny
  // runs before the approval phase, so a protected branch is `hard_deny` for the owner, for `admin:all`, for a
  // standing rule and for an `approved: true` claim; that the **same** check is repeated at the git-policy
  // boundary of `ProjectGitService` immediately before the write, catching a direct service call that never
  // reaches the engine; that `approved: true` alone is not proof (a real approval record is consumed with the
  // payload hash of the exact write, and the branch/remote/force/credential are part of that hash); and that a
  // git credential is issued as a one-operation host-process lease whose `.git/config` is untouched, whose
  // value never enters the next invocation and which `environmentReferences` refuses — so an agent shell can
  // never receive a plaintext git token.
  "tests/coding-agent-c11-git-workflow-security.test.ts",
  // C11 (owner decisions 2, 7, 8, 9, 10, 11 and 12): the git workflow's **tool surface**. Pins that the eleven
  // `code.git.*` capabilities are registered, grouped, risk-classified and gated by their own `code.git` flag;
  // that the executors are **adapters** — a source scan fails if a git command ever appears in them, and each
  // one is driven against a recording stand-in for `ProjectGitService` to prove it delegates; that the session
  // branch is deterministic and created-or-switched (never assumed); that a commit or a push refuses on a branch
  // mismatch, a protected branch or a moved canonical revision, before the service is asked to write; that
  // `workspace_revision_mismatch` is the fail-closed answer when the canonical workspace moves or cannot be
  // read; that a merge conflict is resolved **at most twice** and then escalates with the attempts that were
  // really run and asks for `code.ask_user`; that a read-only intent (`REVIEW_CODE`) cannot write, run a command
  // or push on the server, while an ordinary session is unchanged; that the pull-request body is generated from
  // the run's own `CodingAgentRunSummary` and says when verification is missing; and that a pull-request comment
  // carries its **own** approval payload, so an approval for a push or for opening a pull request can never be
  // redeemed as a comment.
  "tests/coding-agent-c11-git-workflow.test.ts",
  // C11 (owner decision 13, the last known issue): no git mutation before authorization + approval. Pins that
  // `ProjectGitService.inspectRepository()` is read-only — it may `lstat` and run the two `rev-parse` probes
  // the suite names, and a recorded process list plus a recursive path+sha256 snapshot prove it creates no
  // `.git` and changes no file — while `ensureRepositoryInitialized()` (the `git init`, identity, ignore file
  // and initial commit) is reached only after RBAC, the protected-branch policy and the approval record, and
  // only immediately before the credential lease and the push. Five different refusals on an uninitialized
  // workspace are driven and each must leave no `.git`, not one changed byte and no mutating git subcommand;
  // the fact "this write creates the repository" is part of the approval payload and of the payload hash, so
  // an approval for a push into an existing repository cannot be redeemed for the initialization (or the other
  // way round) while every already-initialized write keeps its exact pre-decision-13 payload hash; and the
  // canonical revision is checked *after* the initialization, so an initialization that moved the workspace
  // refuses the push as `workspace_revision_mismatch` with no push and no credential lease.
  "tests/coding-agent-c11-git-init-approval.test.ts",
  // C11 (owner decision 5, corrected): a `code.git.*` approval must be **redeemable**, not only required. Pins
  // that the code-tool path and the git boundary hash the *same* material for the same write — the record the
  // request side creates is the record `ProjectGitService.requireGitWriteApproval` consumes, so an approved
  // `code.git.push`, `code.git.pr.create` or `code.git.pr.comment` really reaches the write and one record is
  // one write (a second push with a spent record is `APPROVAL_ALREADY_USED`, and a second push in the same turn
  // asks the human again); that a record issued for another branch, or a record for a push presented as a
  // pull-request comment (and the reverse), is refused with no side effect and no credit spent; and that the
  // initialization fact the read-only inspector resolves is part of the approved payload on this path too, with
  // the record consumed *before* the repository is created.
  "tests/coding-agent-c11-git-boundary-approval.test.ts",
  // C12: sub-agents and parallel work. Pins that depth 1 is **structural** (a run with a parent is never
  // offered the delegation tool, and the tool runtime refuses the name before the sub-flag, the approval and the
  // executor), that parallelism 4 is a hard ceiling configuration may only lower, and that a child's capability
  // set is an **intersection** — the parent's effective set, the child type's profile and the delegation record
  // — where a wildcard resolves only against the published universe and grants nothing without one. Also pins
  // the canonical limits of the two generic A2A registries, and that a tool added to the general set is not
  // automatically available to a child.
  "tests/coding-agent-c12-subagent-scope.test.ts",
  // C12: **one** file-lock manager and **one** budget. Pins that a path locked by the project task graph is
  // locked for the Company file tools as well (with the two-manager composition asserted as the negative
  // control, plus a source guard on the wiring, because "shared" is a property of the composition), and that a
  // parent run and its child draw on a single `sessionBudget` through the existing `A2AQuotaManager` — the
  // child's first pre-flight is refused rather than being handed an allowance of its own, and
  // `budget_exhausted` really stops a run.
  "tests/coding-agent-c12-locks-and-budget.test.ts",
  // C12 (owner requirement): the `code.agent.spawn` tool. Pins its published schema and manifest version (v9,
  // with v8 frozen), its own `code.subagents` sub-flag and its Capability Inspector visibility; the five
  // sub-agent types and what a type really decides (model profile through the existing registry, a turn limit
  // that configuration and the model may only lower, a published-tool capability profile); the refusals (an
  // unknown type, an unpublished tool, naming the delegation tool itself, an unusable scope path, an empty
  // intersection, `summaryOnly: false`); the deterministic run id and the runtime's idempotency; the fan-out
  // ceiling; and the two properties the owner named: an `explore` child returns a **handoff digest** (findings,
  // paths, symbols, counts) whose bytes never contain the child's prose or a file body, and a child that fails
  // or throws still leaves the parent with a **successful** tool call carrying the child's code.
  "tests/coding-agent-c12-subagent-workflow.test.ts",
  // C12 (owner criterion): the delegation tree is **visible**. Pins migration 084 as additive (three nullable
  // parent columns and one partial index, registered by the store and carried in its own select list), the store
  // round-trip and the `parentRunId` filter that makes one level of the tree a query, a pre-C12 event staying
  // parentless, tenant scoping, the parent linkage being *identity* rather than payload (so the metadata-only
  // checker never sees it), and — end to end — that the event the spawn executor writes is the row the tree
  // query finds, with its parent run, its tool call and its snapshot.
  "tests/coding-agent-c12-subagent-activity-tree.test.ts",
  // C12: parallel implement work and the mandatory verification after the merge. Pins that two tasks on
  // disjoint paths run in one graph turn under one lease manager each in its **own** worktree/branch (the slug
  // is derived per task — deriving it from the role alone made two parallel tasks share one worktree, which is
  // the defect this suite found), that overlapping scopes serialise instead of racing, that a real merge
  // conflict becomes the existing structured escalation (`GitConflictEscalationError`, its `conflictingFiles`
  // and its `code.ask_user` suggestion) with cleanup still in the `finally`, that a failing sub-agent fails its
  // task without hanging the parent's run, and that the final verification is the existing C9 loop over the
  // project's configured checks — `failed` fails the run, `unavailable` is reported and never presented as a
  // pass, and a runner that throws still settles the run.
  "tests/coding-agent-c12-parallel-verification.test.ts",
  // C13 (pre-MCP): the capability gates themselves. Pins that `verify-capability-matrix.mjs` and
  // `upgrade-gate.mjs` audit the *resolved* catalog through `packages/shared/src/capability-catalog-audit.ts`
  // (catalog ↔ matrix ↔ registry ↔ published manifest) instead of the base source literal, that the four
  // checks stay separate, that the runtime overlay is the empty rule-24 stub and never counts as static —
  // with a negative control that pushes a capability into a store, asserts the same parity check fails, and
  // restores the store in `finally`.
  "tests/coding-agent-c13-capability-catalog-audit.test.ts",
  // C13 (owner decisions 1, 2 and 9): project lifecycle hooks. Pins the gate order — the server-side
  // `code.hooks` flag, then the project trust record, then the read of `.npati/hooks.json` — so an
  // **untrusted** repository never has its hook config read, parsed or executed (proved with a spy that is
  // not called, a config probe whose property access is counted, and an executor spy that stays empty); the
  // closed result vocabulary (`{block, reason}` | `{context, trust}` | `{warnings}` only, with `allow`,
  // `permission`, `approval`, `mode`, `role`, `flag`, a risk override and a capability grant refused by
  // name, and a block that can only refuse); the position of `PreToolUse` in the tool pipeline — after the
  // approval was consumed and after every structural refusal, proved with the **real** policy engine for a
  // protected-branch hard deny and for an approval-classed command; that `PolicyRequest` has no hook field
  // at all; and that hook context reaches the model as `untrusted_data` inside the tool envelope.
  "tests/coding-agent-c13-hooks.test.ts",
  // C13: the hook Activity events and, just as importantly, what is **not** Activity. Pins that an
  // invocation is persisted through the real sink with metadata only (no config body, no command line, no
  // hook output), that a credential in a hook's output is refused rather than stored, that the skip reasons
  // (`hook_project_untrusted`, `hook_flag_disabled`) are recorded as codes, and that the hook subsystem
  // holds no audit port — `code_activity_events` is not the tamper-evident AuditLog, while the trust and
  // config changes that *are* journalled keep being audited before they are applied.
  "tests/coding-agent-c13-hooks-activity.test.ts",
  // C13: webhook hooks never become an egress channel of their own. Pins that a loopback, metadata,
  // internal-name, literal-IP, single-label or plain-HTTP destination is refused before the transport is
  // called, that a hostname merely *resolving* into a private or reserved range is refused on every
  // delivery, that redirects are disabled so a webhook cannot be bounced to a second host, that the
  // outbound exfiltration guard still refuses a credential in the body, and that the hooks module has one
  // injected port and no HTTP client of its own.
  "tests/coding-agent-c13-hooks-egress.test.ts",
];

/**
 * Suites listed above but absent from disk. The list is the contract, so a missing file is reported
 * before vitest is even started: previously that surfaced as a confusing vitest exit code.
 */
export function findMissingSuiteFiles(root, suites) {
  return suites.filter((suite) => !existsSync(path.join(root, suite)));
}

/**
 * Decides whether a vitest JSON report passes the gate. Exported so the rule "a skipped security-gate
 * test fails the job" is unit-testable without spawning vitest.
 */
export function evaluateVitestReport(report) {
  const failures = [];
  const numFailed = Number(report?.numFailedTests ?? report?.numFailedTestSuites ?? 0);
  const numPending = Number(report?.numPendingTests ?? 0);
  const numTodo = Number(report?.numTodoTests ?? 0);
  const numPassed = Number(report?.numPassedTests ?? 0);
  if (!Number.isFinite(numPassed) || numPassed === 0) failures.push("the security-gate run reported no passing tests");
  if (numFailed > 0) failures.push(`${numFailed} security-gate test(s) failed`);
  if (numPending > 0) failures.push(`${numPending} security-gate test(s) were skipped, which rule 12 forbids`);
  if (numTodo > 0) failures.push(`${numTodo} security-gate test(s) are marked todo, which rule 12 forbids`);
  return { ok: failures.length === 0, failures, numPassed, numFailed, numPending, numTodo };
}

/**
 * Normalizes a suite path for comparison: the vitest JSON report carries absolute, Windows-style paths
 * (`D:\\repo\\tests\\x.test.ts`) while the configured list is repository-relative (`tests/x.test.ts`),
 * so both sides are reduced to the suffix starting at `tests/`.
 */
export function suiteKey(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const index = normalized.indexOf("tests/");
  return index >= 0 ? normalized.slice(index) : normalized;
}

/**
 * Every configured suite must actually appear in the report: a mistyped path makes vitest exit non-zero
 * while the remaining suites still pass, which used to end as a bare `FAILED` with no explanation.
 */
export function findMissingSuites(report, expected) {
  const seen = new Set((report?.testResults ?? []).map((entry) => suiteKey(entry?.name ?? entry?.file ?? "")));
  return expected.filter((suite) => !seen.has(suiteKey(suite)));
}

/**
 * Detects suites that appear in the report but ran no assertion at all — the signature of a file that
 * failed to load (an import error surfaces as a suite with zero tests and a non-zero vitest exit).
 */
export function findEmptySuites(report) {
  return (report?.testResults ?? [])
    .filter((entry) => Array.isArray(entry?.assertionResults) && entry.assertionResults.length === 0)
    .map((entry) => suiteKey(entry?.name ?? entry?.file ?? ""));
}

function tail(value, lines = 40) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parts = text.split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}

function runStep(title, scriptRelativePath, args = []) {
  const scriptPath = path.resolve(ROOT, scriptRelativePath);
  process.stdout.write(`\n[security-gate] ${title}: node ${scriptRelativePath} ${args.join(" ")}\n`);
  // Never through a shell: the Node executable path may contain spaces ("C:\Program Files\nodejs"),
  // and a shell would split it, which made the guards look red while they pass when run by hand.
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, shell: false, encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  if (result.error) {
    process.stdout.write(`[security-gate] FAILED to start ${scriptRelativePath}: ${result.error.message}\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stdout.write(`[security-gate] FAILED: ${title} exited with ${result.status}\n`);
    return false;
  }
  process.stdout.write(`[security-gate] OK: ${title}\n`);
  return true;
}

/** Prints every failed test with its message, so a red CI run is actionable without a second run. */
export function formatFailedTests(report) {
  const lines = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status !== "failed") continue;
      const name = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(" > ");
      lines.push(`[security-gate] FAILED TEST: ${path.relative(ROOT, String(file.name ?? ""))} > ${name}`);
      for (const message of assertion.failureMessages ?? []) {
        for (const messageLine of String(message).split("\n").slice(0, 12)) {
          lines.push(`[security-gate]     ${messageLine.trim()}`);
        }
      }
    }
  }
  return lines;
}

function main() {
  if (process.argv.includes("--list")) {
    process.stdout.write(`${SECURITY_GATE_TESTS.join("\n")}\n`);
    return 0;
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), "npati-security-gate-"));
  const reportPath = path.join(reportDir, "vitest-report.json");
  const vitestBin = path.resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
  let ok = true;
  // Every configured suite must exist before vitest starts. The list is a contract, so a deleted,
  // renamed or mistyped path fails here with its own message instead of as a bare vitest exit code.
  const missingFiles = findMissingSuiteFiles(ROOT, SECURITY_GATE_TESTS);
  process.stdout.write(
    `\n[security-gate] suite files: present=${SECURITY_GATE_TESTS.length - missingFiles.length} missing=${missingFiles.length}\n`,
  );
  if (missingFiles.length) {
    process.stdout.write(`[security-gate] FAILED: ${missingFiles.length} configured suite file(s) do not exist:\n`);
    for (const suite of missingFiles) process.stdout.write(`[security-gate]   missing file: ${suite}\n`);
    ok = false;
  }
  try {
    process.stdout.write(`\n[security-gate] vitest run (${SECURITY_GATE_TESTS.length} suites)\n`);
    // The local vitest entry point is invoked through the Node binary, so no shell and no `npx`
    // resolution is involved (both were fragile on Windows).
    const vitest = spawnSync(
      process.execPath,
      [vitestBin, "run", ...SECURITY_GATE_TESTS, "--reporter=json", `--outputFile=${reportPath}`],
      { cwd: ROOT, shell: false, encoding: "utf8", env: process.env },
    );
    if (vitest.error) {
      process.stdout.write(`[security-gate] FAILED to start vitest: ${vitest.error.message}\n`);
      ok = false;
    } else {
      const vitestOutput = `${vitest.stdout ?? ""}${vitest.stderr ?? ""}`.trim();
      if (vitestOutput) process.stdout.write(`${vitestOutput}\n`);
      let report = null;
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        process.stdout.write(`[security-gate] FAILED to read the vitest report: ${error instanceof Error ? error.message : String(error)}\n`);
        ok = false;
      }
      if (report) {
        const verdict = evaluateVitestReport(report);
        for (const line of formatFailedTests(report)) process.stdout.write(`${line}\n`);
        for (const failure of verdict.failures) process.stdout.write(`[security-gate] ${failure}\n`);
        process.stdout.write(`[security-gate] tests: passed=${verdict.numPassed} failed=${verdict.numFailed} skipped=${verdict.numPending} todo=${verdict.numTodo}\n`);
        const missing = findMissingSuites(report, SECURITY_GATE_TESTS);
        if (missing.length) {
          process.stdout.write(`[security-gate] FAILED: ${missing.length} configured suite(s) did not run (expected ${SECURITY_GATE_TESTS.length}, saw ${SECURITY_GATE_TESTS.length - missing.length}):\n`);
          for (const suite of missing) process.stdout.write(`[security-gate]   missing: ${suite}\n`);
        }
        if (!verdict.ok || missing.length) ok = false;
        const empty = findEmptySuites(report);
        if (empty.length) {
          process.stdout.write(`[security-gate] FAILED: ${empty.length} suite(s) reported no tests at all (a file that failed to load looks like this):\n`);
          for (const suite of empty) process.stdout.write(`[security-gate]   empty: ${suite}\n`);
          ok = false;
        }
        if (vitest.status !== 0) {
          process.stdout.write(`[security-gate] FAILED: vitest exited with ${vitest.status}${verdict.ok && !missing.length && !empty.length ? " although the report shows no failures (a suite may have failed to load)" : ""}\n`);
          // The raw tail is printed unconditionally so the real cause is visible instead of hypothetical:
          // vitest reports worker load errors on stdout/stderr without counting them as failed tests.
          const rawTail = tail(vitestOutput);
          if (rawTail) {
            process.stdout.write(`[security-gate] vitest output (tail):\n${rawTail}\n`);
          } else {
            process.stdout.write("[security-gate] vitest produced no output at all\n");
          }
          if (vitest.signal) process.stdout.write(`[security-gate] vitest was terminated by signal ${vitest.signal}\n`);
          ok = false;
        }
      }
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }

  // The artifact guards the gate owns, invoked exactly as documented in the runbook.
  ok = runStep("tool schema guard", "scripts/verify-code-tool-schemas.mjs", ["--check"]) && ok;
  ok = runStep("sandbox image guard", "scripts/sandbox-image-verify.mjs") && ok;
  // A stale curated typosquat dataset must fail CI here: otherwise every `code.deps.add` would silently
  // become an approval forever instead of the check being refreshed.
  ok = runStep("typosquat dataset guard", "scripts/typosquat-dataset-generate.mjs", ["--check"]) && ok;

  process.stdout.write(ok ? "\n[security-gate] PASSED\n" : "\n[security-gate] FAILED\n");
  return ok ? 0 : 1;
}

/**
 * The module is imported by `tests/coding-agent-c4a-security-gate.test.ts`, so it must stay free of
 * import-time side effects: nothing but definitions runs at module scope, and `main()` is invoked only
 * when this file is the actual entry point. The comparison is case- and separator-insensitive because
 * Windows paths differ in both, and a mistaken match would recursively run the whole gate from a test.
 */
export function isEntryPoint(argv = process.argv, moduleUrl = import.meta.url) {
  const invoked = argv?.[1];
  if (!invoked) return false;
  try {
    const invokedPath = path.resolve(invoked).replace(/\\/g, "/").toLowerCase();
    const modulePath = path.resolve(fileURLToPath(moduleUrl)).replace(/\\/g, "/").toLowerCase();
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exit(main());
