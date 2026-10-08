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
 *
 * G1 (item 5): this file is the **library** half of the gate. It carries no shebang, because a
 * `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm`
 * untransformed — and that is exactly what happened in a git worktree, where Vite did not transform this file
 * and eight gate suites that import it reported "no tests at all" (109 tests that ran nowhere except in the
 * repository's own layout). The executable is now the thin wrapper `scripts/run-security-gate.mjs`, which
 * keeps the shebang, decides that it is the entry point, and calls `main()` from here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACK_CATALOGUE_PATH, findMissingCatalogueEntries, loadAttackCatalogue, validateAttackCatalogue } from "./attack-catalogue-check.mjs";
import { MUTATION_CONTROLS_PATH, loadMutationControls, validateMutationControls } from "./mutation-controls-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The scripts the gate invokes, relative to the repository root (this module is one directory deeper). */
const TYPOSQUAT_GENERATOR_PATH = "scripts/typosquat-dataset-generate.mjs";

/**
 * G1 (D20): where the gate leaves its verdict.
 *
 * The vitest report itself is written into `mkdtempSync(...)` and removed in the script's `finally`, which
 * left the CI job with no evidence at all — a green gate and a red gate both uploaded nothing. This artifact
 * is the durable half: the suite counts, the catalogue counts, the test totals and the verdict. CI makes it
 * mandatory (`if-no-files-found: error` in `.github/workflows/ci.yml`), so a run whose evidence is missing
 * fails there, while a *local* run that cannot create `artifacts/` reports the failure and keeps its exit code
 * about the gate's own verdict (the artifact is evidence, not a security check). Since G1 that workflow has no
 * automatic trigger, so "CI makes it mandatory" applies to the manual dispatch the owner runs.
 */
export const GATE_ARTIFACT_PATH = "artifacts/security-gate-report.json";

/**
 * G1 (item 2/D1): the verdict artifact of the **DB-backed** gate, which is a separate run with a separate
 * contract — see `SECURITY_GATE_DB_TESTS` and `runDatabaseSuiteGate` below.
 */
export const DB_GATE_ARTIFACT_PATH = "artifacts/security-gate-db-report.json";

/** Writes a verdict under a caller-named path. Returns `{ ok, path, error }` instead of throwing. */
export function writeGateArtifactAt(root, relativePath, summary) {
  const file = path.join(root, relativePath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return { ok: true, path: relativePath, error: null };
  } catch (error) {
    return { ok: false, path: relativePath, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes the hermetic gate's verdict. Returns `{ ok, path, error }` instead of throwing, so it cannot mask it. */
export function writeGateArtifact(root, summary) {
  return writeGateArtifactAt(root, GATE_ARTIFACT_PATH, summary);
}

/** The suites that make up the gate. Adding a security-gate suite means adding it here. */
export const SECURITY_GATE_TESTS = [
  "tests/coding-agent-c1c-audit-log.test.ts",
  "tests/coding-agent-c1b-images.test.ts",
  "tests/coding-agent-c1b-image-api.test.ts",
  // C1a (owner policy 5): the dark-launch gate itself — `gate_not_passed` while nothing is configured, the
  // master flag authoritative over every sub-flag, per-company/per-user isolation, flag administration and
  // the **kill switch**. The suite existed and was never registered here, so the policy the Coding Agent
  // starts from ran in no gate at all; it is hermetic (an in-memory store plus `Fastify.inject`, no port, no
  // Docker, no network) and carries no `.skip`/`.only`/`.todo`, which is what a gate suite must be.
  "tests/coding-agent-c1a-flags.test.ts",
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
  // C13: slash commands. Pins that a command is a **versioned prompt template and nothing else** — `/review`
  // expands into the stored text plus a labelled argument block, and the expansion value carries
  // `canChangePolicy: false` / `canGrantTools: false` with no field naming a mode, an approval, a role or a
  // flag; that a project command file under `.npati/commands/` is **not read** before the project trust record
  // says yes (the reader spy and its counter both stay at zero, and the gate order is flag -> trust -> read);
  // that a declaration naming a decision is refused by name in the same closed vocabulary the hooks use; that a
  // template attempting a policy mutation is refused instead of expanded; that the C13 precedence
  // `system -> user -> project -> session` picks the same winner and the same shadowed list for both candidate
  // orders; that the template, the expansion and every argument value are bounded and validated; and that the
  // expansion's content hash and provenance are recorded as replay input, so a replay expands the recorded
  // command version rather than today's — with the bundle format staying at version 3 because the two
  // provenance lists are optional header members and a bundle without them still derives the pre-C13 hash.
  "tests/coding-agent-c13-slash-commands.test.ts",
  // C13: lazily loaded Skills. Pins that the metadata listing never calls the body reader and withholds a
  // repository-sourced Skill without a trust record; that a loaded body becomes a typed `SKILL INSTRUCTIONS`
  // section of the system prompt rather than a tool result, and that the **real** `compactConversation` leaves
  // it byte-identical while old tool results become stubs; that `skill_id` + version + hash + provenance are
  // recorded while the body is not; that the replay reader refuses a moved version or an edited body instead of
  // answering with the current one; that a credential-shaped body is refused by the scanner before the provider
  // guard is reached and a redaction-requiring body is refused rather than sanitised; and that two sessions
  // share neither active Skills nor the lazy-load budget.
  "tests/coding-agent-c13-skills-lazy-load.test.ts",
  // C13: the runner wiring, end to end. Pins that the text the **engine** really receives as the user message
  // is the expanded command text and not the raw `/name` line; that the command provenance reaches the replay
  // recorder at start (so the bundle pins the expanded version rather than resolving the name later); that a
  // registry failure leaves the caller's own prompt in place and records no provenance instead of inventing
  // one; that the typed `SKILL INSTRUCTIONS` section is inside the system prompt above the data boundary with
  // its invariant lines still last; and that the Skill provenance published to the ExecutionSnapshot holder is
  // id/version/hash/source only.
  "tests/coding-agent-c13-runner-wiring.test.ts",
  // C13 (owner decisions 5 and 8): MCP as a **runtime** capability provider. Pins the runtime record the owner
  // named (connection id, tool name, schema hash, risk, approval requirement, `discoveredAt`, connection scope),
  // the `static → runtime → unknown ⇒ deny` lookup in one function with the static path measurably untouched, the
  // fail-closed default (`high` + approval required) that a new/unknown MCP tool gets and that an MCP server's own
  // metadata can never lower (a declaration is refused by name, and a schema parameter named `mode` is not a
  // declaration), the owner/admin-only risk flow that is journalled in the AuditLog **before** it applies and
  // refuses with `audit_unavailable` when the journal is unavailable, the Capability Inspector showing both
  // sources while the static count does not move (measured: static 385, runtime N, combined 385 + N), the runtime
  // manifest pinned in the ExecutionSnapshot, a schema change minting a new revision/hash, and a replay against a
  // different set refused with a structured error instead of a silent swap.
  "tests/coding-agent-c13-mcp-runtime-capabilities.test.ts",
  // C13 (owner decision 7): MCP network and data safety. Pins that an endpoint may come only from a configured
  // Integration — a model argument, a README line or a `NPATI.md` instruction is refused by name with the
  // transport never dialled (call count asserted); that the transport is the **existing** SSRF-safe client, so a
  // loopback, link-local (cloud metadata), RFC1918 or privately-resolving destination is refused before a socket
  // exists and every redirect is re-validated (a public host bounced towards metadata is refused at hop two, with
  // exactly one dial); that the egress allowlist is enforced (an empty allowlist denies every host); that a
  // response is untrusted data bounded with a visible marker, refused — never redacted — when it carries a
  // credential, classified by the injection guard, and wrapped in the canonical `code_tool_result` envelope with
  // a **closed** key vocabulary so an injected instruction has no policy field to reach; and that a discovery is
  // tenant scoped and a refused declaration contributes nothing to the manifest.
  "tests/coding-agent-c13-mcp-network-safety.test.ts",
  // C13 (owner requirement: fresh-process MCP acceptance): discovery must happen **on the run path**. Pins that a
  // brand-new runtime with a configured, active MCP Integration discovers its tools before the first model call
  // with **no** Capability Inspector request and no warm-up call (measured: the overlay is empty and the transport
  // was never entered before the run, and the numbers captured *inside* the first model call show the discovery
  // had already happened); that the fail-closed risk/approval assignment reaches the model-visible descriptors and
  // the pinned ExecutionSnapshot (hash/revision, metadata only); that the model's call really executes through the
  // existing transport and returns the canonical `untrusted_data` envelope (bounded with a marker, a credential
  // **refused** and never redacted, an injected instruction carried as classified data with no policy field to
  // reach); that the default `high` + approval-required tool is refused with `approval_required` and a real
  // approval request; that a re-listing keeps the manifest hash while a schema change mints a new revision; that a
  // replay against a changed schema is refused by the existing 409 contract; that tenants are isolated and the
  // static count does not move (385 / runtime N / combined); and the negative controls — no Integration, an
  // `is_active=false` row, an unwired source, a failing discovery and `code.mcp` off all leave the overlay empty
  // with an Activity code, remove the tool from the descriptors, make the call impossible (`unknown_tool`) and
  // still let the run complete.
  "tests/coding-agent-c13-mcp-run-path.test.ts",
  // C13: the wiring of that run path in the **composed** application — one discovery system with two entry points
  // (the runner's `runtimeCapabilities` and the Inspector route are the same object; the route no longer calls
  // `discoverMcpRuntimeCapabilities` directly), the source-level ordering inside the runner (discovery < tool list
  // < ExecutionSnapshot < the loop's first model call, each anchor non-vacuously present), the absence of any
  // Inspector dependency in the runner and the MCP run path, the newly wired replay-bundle manifest pin, and a
  // fresh `buildApp` whose Inspector still answers over the shared discovery.
  "tests/coding-agent-c13-mcp-run-path-wiring.test.ts",
  // C13 (owner requirement, corrected): the two **replay modes** are not interchangeable. Pins that a
  // deterministic replay of an MCP-using run verifies against the runtime manifest the run's **own bundle**
  // recorded — with the discovery port never consulted, zero dials and the recorded settled tool results — so
  // it works in a fresh process whose runtime overlay is empty (the defect: the recorded replay compared
  // against the in-process overlay, answered "I cannot say" and refused every such run with
  // `runtime_mcp_manifest_unavailable`); that an explicit live comparison of a moved manifest is still the
  // 409 `replay_runtime_mcp_manifest_changed` refusal; that **live** replay is where discovery happens and a
  // moved or unstateable manifest refuses **before** any run is started; and that the bundle format stays at
  // version 3, with a bundle carrying no runtime field hashing exactly as it did before the field existed.
  "tests/coding-agent-c13-mcp-replay-modes.test.ts",
  // C13 (owner blocker 1): a runtime MCP call is approved **once**, for that exact call, and the run continues.
  // Pins that `approval_required` pauses the run in the existing `waiting_for_user` state, that exactly one
  // durable approval record is created for it with the canonical material (provider, connection, tool, schema
  // hash, argument hash and the run/agent/call ids — never the arguments themselves), that the material the
  // requesting side stored and the material the consuming side presents hash to the **same** value (the C11
  // defect this closes: two builders, two hashes, an approval nobody could redeem), that the same run resumes
  // and really executes the call through the SSRF-safe transport with the canonical `untrusted_data` envelope,
  // that one record is one call (`APPROVAL_ALREADY_USED`) while a record for another tool, schema, argument set,
  // run or agent is `APPROVAL_INVALID` with no dial, that two runtime MCP calls in one turn are **two** human
  // requests and one pause, that the pause survives a process restart, and that a rejection, a timeout and a
  // cancellation are structured refusals that execute nothing — without ever requiring the separate owner/admin
  // risk downgrade, which keeps working beside it.
  "tests/coding-agent-c13-mcp-approval-flow.test.ts",
  // C14 (evals, metrics and hardening). The eval corpus already lives in the gate above
  // (`tests/coding-agent-c6-eval.test.ts`, 17 hermetic tasks); these two suites cover what C14 itself changed.
  //
  // C14: the CI workflow is an artifact with a contract. Pins the *gate structure* of `.github/workflows/ci.yml`
  // (every gate step present, the mandatory `security-gate` job unconditional and never soft-failing, the eval
  // smoke a job of its own that blocks the release, the evidence artifacts) — and, since G1, that **no** workflow
  // in the repository carries an automatic trigger: automated CI is off on purpose (private repository, no paid
  // Actions minutes, every job of the last automatic run failed in ~2 s without starting) and the removed trigger
  // contract is kept verbatim as a machine-readable RE-ENABLE RECIPE, with the recipe itself used as the mutation
  // input of the non-vacuity proof. The consequence — the gate no longer blocks a merge or a release, so it runs
  // only on the owner's local escalated run — is an accepted risk recorded in
  // `docs/coding-agent/security-gate-report.md` §6. It also pins the lint guard itself in both directions: it
  // fires on a real violation (a new file with an unrecorded cast, an unlisted `console.log`, an
  // unrecorded `.only`/`.skip`) and produces no false positive on the repository it guards, with its own detector
  // self-test asserted rather than trusted.
  "tests/coding-agent-c14-ci-and-lint-gates.test.ts",
  // C14: `code.model_profile.<id>` really decides which profiles a run may match. Pins the silent no-op this
  // step closed: the runner's `modelProfiles` port was declared and read but never supplied by the
  // composition, so `enabledProfileIds` never reached `resolveModelProfile` and the ExecutionSnapshot's
  // "which profile ran" could not reflect the deployment. Behaviour is asserted on three layers — a real
  // `FeatureFlagService` over the in-memory store (a disabled flag excludes its profile, and the same model
  // then resolves to the conservative default; a throwing flag store enables nothing; the flag key of every
  // registry profile passes the feature-flag allowlist), the runner recording the profile a per-run resolver
  // enabled (with the run's own ctx/company/session, and the conservative default when the port is absent or
  // the resolver throws), and a source guard that `app.ts` still passes the **existing** registry plus the
  // flag-driven resolver — no second registry, and the provider of the model id is part of the match now.
  "tests/coding-agent-c14-model-profile-flags.test.ts",
  // C14 (owner decision 1): the known-failures quarantine. The 15 pre-existing failures stay *run* — the suite
  // pins the four RED conditions of `scripts/check-known-failures.mjs` on synthetic data, each with its own
  // negative control (the same fixture with the single difference reverted is GREEN), and then pins the real
  // `known-failures.json` against the literal list of the 15 baseline failures **in both directions**, so a
  // deleted entry (a failure that would then read as a regression) and an added one (something hidden) both fail.
  // The verdict cannot be satisfied by a partial run either: a report that did not execute every suite file on
  // disk is refused, which is the check `--exclude` would otherwise have made unnecessary.
  "tests/coding-agent-c14-known-failures.test.ts",
  // C14 (owner decision 2): the conservative model profile stays fail-closed, and its degradation is made
  // **visible** instead of silent. Pins the two-valued reason (`profile_flag_disabled` when no profile is
  // enabled, `no_matching_profile` when profiles are enabled but none matches, and no reason at all when one
  // does) on the pure resolver, on a real runner run (the environment trace *and* every Activity event written
  // after the profile, through the real metadata-only and secret guards), and on the ExecutionSnapshot payload
  // (additive: the key is absent when the deployment does not wire the source). Source guards then pin that
  // `app.ts` wires exactly that snapshot source and exposes the Inspector section, and that the warning the
  // Inspector shows exists in all seven i18n dictionaries rather than in one.
  "tests/coding-agent-c14-model-profile-fallback.test.ts",
  // C14 (red-team hardening, PLAN.md G1 items 2 and 3). The catalogue below is an artifact with a contract:
  // every row names a suite, an exact test title and a written non-vacuity argument, and the gate refuses a
  // row whose suite file, suite registration, title or negative control does not resolve — so a fabricated
  // entry cannot pass. The classes C14 adds are the ones nothing covered: a fork bomb (the rule existed and
  // no test touched it), hostile text arriving through **command output**, disk/memory ceilings, zip-slip with
  // Unicode/NUL/long-path spellings, and two channels the existing suites do not reach (an MCP tool
  // *description*, and the shell session environment). The last two suites are the point of the step: the
  // catalogue guard itself, and a mutation-sensitivity suite that neutralises five named guards in memory and
  // asserts the matching attack then really succeeds.
  "tests/coding-agent-c14-redteam-fork-bomb.test.ts",
  "tests/coding-agent-c14-redteam-command-output-injection.test.ts",
  "tests/coding-agent-c14-redteam-resource-exhaustion.test.ts",
  "tests/coding-agent-c14-redteam-path-and-zip-slip.test.ts",
  "tests/coding-agent-c14-redteam-new-channels.test.ts",
  // C14: the catalogue guard. Pins that the catalogue cannot contain a fabricated row (a missing suite file, a
  // suite outside this list, a title nobody wrote, a missing negative control, a stale rule exemption), that
  // every hard-deny rule of the classifier is either exercised by a row or exempted with a probe command that
  // really fires, and that the report check catches a catalogued title which did not run.
  "tests/coding-agent-c14-attack-catalogue.test.ts",
  // C14 (owner decision 1, second half): the eval **scores** and the **comparative report per profile**.
  // The corpus itself is the suite above (`tests/coding-agent-c6-eval.test.ts`, now 33 hermetic tasks across
  // seven task kinds and four programming languages plus JSON configuration); this suite pins the arithmetic
  // under those numbers and the honesty of the profile table. It asserts `diffStats`/`turns`/`costUsd` in both
  // directions — a real change set versus a false declaration, a computed price versus an unknown model, where
  // the answer is `null` **with a reason** and never `0` (a generic price row would be a fabricated number) —
  // and that turns are derived by a stated rule from the executed prefix only. It then re-derives the profile
  // conformance matrix from the real `resolveModelProfile`/`modelProfileFallbackTrace` for every subject and
  // deployment state, pins one row per profile (a profile that matched nothing is shown as such), and fails if
  // any numeric quality field appears: a per-profile pass rate needs a live model, so every row is `not_run`
  // and the report says so in its own text. A source guard finally proves the recorded harness reads no model
  // profile at all, which is why "task X passed on profile Y" would be a label rather than a measurement.
  "tests/coding-agent-c14-eval-metrics-and-profiles.test.ts",
  // C14 (owner decision 3): the **aggregated** metrics — success rate, average turns, failed edit rate,
  // approvals share, tool error rate and cost per run — computed from the run states and Activity rows that
  // already exist. Each metric is pinned in both directions (a real number, and `null` **with a reason** once its
  // source is removed, never `0`), together with the tenant boundary the store read enforces, the arithmetic
  // against the real in-memory store, and the fact that the route serves exactly the report the aggregator
  // produced under the existing `workspace:read` permission. The presentation half is pinned by `npm run test:web`.
  "tests/coding-agent-c14-metrics-aggregation.test.ts",
  // C14 (PLAN.md G1 item 3): mutation sensitivity of this gate. Five guards are neutralised **in memory** — the
  // `fork_bomb` hard-deny rule, the PolicyEngine's classifier wiring, the ZIP decompression budget, the
  // untrusted-data output budget and the sensitive-file read policy — and each attack is asserted to succeed
  // once its guard is neutralised and to be refused again afterwards with the real guard restored. A
  // neutralisation that changes nothing fails as "the control is decorative", which is what stops this gate
  // from being a green suite that would stay green if a protection were deleted.
  "tests/coding-agent-c14-gate-mutation-sensitivity.test.ts",
  // C14 (owner decision 2, the provider cassette). Two suites, and the split is the point: one is the
  // **file-backed** `ReplayBundlePersistPort` — a cassette a fresh process can read without a database, proved
  // equivalent to the database-shaped store over the same recording (same steps, same `replayInputHash`, same
  // tenant scoping), corrupt/wrong-container/hostile-id/refused-write cases included; the other is the
  // **provider seam** — one adaptation of `CodeRunEnginePort.chat` that serves the recorded answers in order and
  // the recorded settled tool results instead of executing anything, with the zeros **measured** (a stubbed
  // global `fetch`, a tool runtime that would count, and a negative control that really dials and really
  // executes), a byte-identical `replayInputHash` on the walk, and loud refusals for a request that does not
  // match the recording, for missing argument bytes, and for a tampered cassette (the integrity hash plus two
  // independent second walls). It proves reproducibility of the provider/tool sequence, never model quality.
  "tests/coding-agent-c14-replay-cassette-store.test.ts",
  "tests/coding-agent-c14-replay-cassette-engine.test.ts",
  // C14 (post-step cleanup): the two descriptions that had drifted on their own. The phase order named by the
  // engine's header comment and by the wiring comment in `app.ts` (both listed eight of the eleven
  // `PolicyPhase` members and omitted three that really run), and the suite count in
  // `docs/coding-agent/security-gate-report.md` (138 against a fixed list of 144). The guard reads the union
  // type, the `evaluateInternal` body, both comments and the document itself, holds no copy of either fact, and
  // proves both halves non-vacuous on in-memory copies rather than on the files.
  "tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts",
  // C15 (owner decisions 2 and 3): the CLI/terminal entry point into the Coding Agent, and the two surfaces it
  // needs. Pins that the run-start route (`POST /companies/:companyId/code/runs`) is authorized by the existing
  // `code.run.start` action and the existing `workspace:write` permission, that the master flag and a tenant-scoped
  // project are checked **before** the `202` (a flag-off or foreign project is an HTTP refusal, not a success
  // followed by silence), that the response carries the C1a version envelope plus a server-minted unguessable run
  // id and the URL of the **existing** background stream, and that the queue slot is released exactly once. The
  // isolation half is the owner's acceptance test — a key scoped `workspace:read` cannot start a run, a key without
  // `business:manage` cannot decide an approval, and an agent/service principal can never be an approver — driven
  // through the real `CodeRbac` with the shipped matrix. The approval half pins audit-**before**-apply on the
  // existing decide route (the journal entry is written first, so an audit outage refuses the decision), and the
  // stream half pins that the existing background-stream SSE surface serves the run the CLI started and answers a
  // foreign tenant the same empty 404 as an unknown run. The CLI half is the secret boundary: the token comes from
  // the environment or a file and never from `argv` (refused in every spelling), and no error path prints it.
  "tests/coding-agent-c15-cli-run-start.test.ts",
  // C15 (mounted local folder): the allowlist policy, the single workspace resolver, the provider that serves a
  // mounted folder as the project's canonical workspace, the revision that provider derives from the mounted tree
  // (so `workspace_revision_mismatch` needs no mounted branch), and the sandbox side of the same feature — the
  // bind argument, its Docker-level `readonly` flag, the runner's own re-validation of the path immediately
  // before `docker create`, and the copy-back that is disabled for a mounted project.
  "tests/coding-agent-c15-mounted-workspace.test.ts",
  "tests/coding-agent-c15-mount-sandbox.test.ts",
  // G1 (item 3, the decoy branch): the matrix of deliberate mutations and the guard that keeps it honest. The
  // suite proves three things about `docs/coding-agent/mutation-controls.json` and about the runner that consumes
  // it (`scripts/security-gate-mutation-branch.mjs`): every row resolves against the real file and the real
  // anchor, a fabricated row is refused with its own issue code, and a gate run that never measured anything is
  // classified `environment` rather than "the mutation was caught". The runner itself is **not** in this list and
  // not in this job: it mutates a worktree and runs the whole gate twice, so it stays a separate, opt-in command
  // (`npm run mutation:branch`) inside the same `mutation:branch` contract.
  "tests/coding-agent-c14-mutation-branch-controls.test.ts",
  // G1 (item 5): the gate's own prerequisites on a clean checkout. Pins that a tree with no `data/typosquat`
  // (the state of a fresh clone, because `data/` is `.gitignore`d and no lifecycle script ever generated it) is
  // made gate-ready by the gate's **always-run preparation step**, which generates the curated dataset before
  // the `--check` guard reads it — while a dataset that exists but disagrees with the generator stays RED
  // (generation does not repair staleness, it only removes "missing"). The temp-tree half proves the
  // preparation step is a real function of the tree it is given, not of this checkout.
  "tests/coding-agent-g1-clean-clone-prerequisites.test.ts",
  // G1 (production CrashLoop): the sandbox runner exited before it served anything because
  // `NPATI_ENCRYPTION_KEY_REQUIRED` was raised by `new CryptoVault()` — a **module-level** construction in
  // `packages/workspace/src/crypto-vault.ts`, reached from `sandbox-runner-server.ts` through the
  // `@npati/workspace` barrel. The runner never encrypts anything: it merely imports the module. The suite pins
  // the corrected contract from both sides — the module, the barrel and the runner's own import edges all
  // evaluate under `NODE_ENV=production` with no key, while `encrypt`/`decrypt` still refuse with the same three
  // codes (`NPATI_ENCRYPTION_KEY_REQUIRED`, `_UNSAFE_DEFAULT`, `_TOO_SHORT`) — and proves the two halves are
  // non-vacuous by mutating **copies** in memory: returning the refusal to the constructor makes module
  // evaluation throw, and removing the derivation guard makes a production vault encrypt with the development
  // key. The files on disk are never mutated, and every `process.env` change is restored in `finally`.
  "tests/coding-agent-g1-crypto-vault-production-key-timing.test.ts",
];

/**
 * G1 (item 2, D1): the suites that need a **real PostgreSQL** — the half of the audit guarantee that no
 * in-memory double can provide (the append-only trigger, the chain guard on INSERT, the `REVOKE`, and the
 * application role those are measured against).
 *
 * Why this is a **separate list with a separate script** rather than an entry in `SECURITY_GATE_TESTS`:
 *
 *  - `SECURITY_GATE_TESTS` is hermetic by contract, and the gate **fails a run that reports a skipped test**
 *    (`evaluateVitestReport`). Adding a database suite literally to it would therefore make `npm run
 *    security-gate` red on every machine without PostgreSQL — the gate would stop being a gate anyone can run
 *    locally and in CI without a database, which is a strictly worse trade than a second, mandatory list.
 *  - So the DB half is its own contract: `npm run security-gate:db` (this list) **requires** `DATABASE_URL` and
 *    fails immediately with a named reason when it is missing — never a skip, never a green run over zero
 *    executed tests. It is enforced by its own mandatory CI job (`security-gate-db` in
 *    `.github/workflows/ci.yml`), which the release gate `needs`, so D1 blocks exactly as a gate suite in
 *    `SECURITY_GATE_TESTS` would, without weakening the hermetic one.
 *  - The DB run is marked with `NPATI_SECURITY_GATE_DB=1`, which the suites require as well: a plain
 *    `npm test` therefore never runs them against whatever `DATABASE_URL` a developer has exported (that would
 *    move the known-failures baseline of 10 files / 15 tests).
 */
export const SECURITY_GATE_DB_TESTS = [
  "tests/coding-agent-c1c-audit-postgres.test.ts",
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

/**
 * The failing tests of a vitest JSON report, as `{ file, title, messages }`.
 *
 * There is exactly **one** traversal of `assertionResults` in this repository: `formatFailedTests` below and
 * the C14 known-failures quarantine (`scripts/check-known-failures.mjs`) both read this. Two independent
 * parsers would be two definitions of "which tests failed", and a quarantine compared against a differently
 * parsed list is worse than no quarantine — a test could be red in one reading and green in the other.
 *
 * `file` is repository-relative and the title is the full `ancestorTitles > title` chain, which is the same
 * string a `known-failures.json` entry names.
 */
export function failedTests(report) {
  const failures = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status !== "failed") continue;
      const title = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(" > ");
      failures.push({
        file: path.relative(ROOT, String(file.name ?? "")).replace(/\\/g, "/"),
        title,
        messages: (assertion.failureMessages ?? []).map((message) => String(message)),
      });
    }
  }
  return failures;
}

/** Prints every failed test with its message, so a red CI run is actionable without a second run. */
export function formatFailedTests(report) {
  const lines = [];
  for (const failure of failedTests(report)) {
    lines.push(`[security-gate] FAILED TEST: ${failure.file} > ${failure.title}`);
    for (const message of failure.messages) {
      for (const messageLine of message.split("\n").slice(0, 12)) {
        lines.push(`[security-gate]     ${messageLine.trim()}`);
      }
    }
  }
  return lines;
}

/**
 * G1 (item 2, D1): runs one **database-backed** suite gate.
 *
 * The contract is deliberately not the hermetic one, and the differences are the whole point:
 *
 *  - `DATABASE_URL` is **required**. A missing value is reported as a failure with that exact reason, written
 *    into the verdict artifact and returned as exit 1 — never a skip and never a green run over zero tests.
 *    (This is why the DB suites live in their own list: a skipped suite in `SECURITY_GATE_TESTS` would fail the
 *    hermetic gate on a machine without PostgreSQL, and adding a database as a prerequisite of the hermetic
 *    gate would make it unrunnable where it is most useful.)
 *  - The suites are told `NPATI_SECURITY_GATE_DB=1`, so a plain `npm test` never reaches them.
 *  - Everything else is the same reader the hermetic gate uses (`evaluateVitestReport`, `findMissingSuites`,
 *    `findEmptySuites`, `failedTests`): a skipped test, a `todo`, a suite that did not run, a suite that
 *    reported no tests and a non-zero vitest exit are each a failure here too.
 */
export function runDatabaseSuiteGate(options) {
  const { gate, suiteListName, suites, artifactPath, root = ROOT } = options;
  const summary = {
    gate,
    script: "scripts/run-security-gate.mjs",
    suiteList: suiteListName,
    suites: { configured: suites.length, present: suites.length, missing: [] },
    database: { requiredEnv: "DATABASE_URL", present: Boolean(process.env.DATABASE_URL) },
    tests: { passed: null, failed: null, skipped: null, todo: null },
    failedTests: [],
    missingSuites: [],
    emptySuites: [],
    reason: null,
    ok: false,
  };
  let ok = true;
  process.stdout.write(`\n[${gate}] database-backed suites (${suiteListName}): ${suites.length} configured\n`);

  const missingFiles = findMissingSuiteFiles(root, suites);
  summary.suites.missing = missingFiles;
  summary.suites.present = suites.length - missingFiles.length;
  if (missingFiles.length) {
    process.stdout.write(`[${gate}] FAILED: ${missingFiles.length} configured suite file(s) do not exist:\n`);
    for (const suite of missingFiles) process.stdout.write(`[${gate}]   missing file: ${suite}\n`);
    ok = false;
  }

  if (!process.env.DATABASE_URL) {
    // Fail closed **before** vitest: this gate exists to prove database-level guarantees, so a run without a
    // database must be red and must say why. `describe.skip` in the suite is not a path this gate accepts.
    summary.reason = "database_url_missing";
    process.stdout.write(
      `[${gate}] FAILED: DATABASE_URL is required. This gate proves database-level guarantees and is never\n` +
        `[${gate}] skipped or silently reduced to zero executed tests; set DATABASE_URL (PostgreSQL with the\n` +
        `[${gate}] pgvector extension, the same image as docker-compose.yml) and run it again.\n`,
    );
    ok = false;
  } else if (ok) {
    const reportDir = mkdtempSync(path.join(tmpdir(), "npati-security-gate-db-"));
    const reportPath = path.join(reportDir, "vitest-report.json");
    // Resolved against the caller's `root` (this gate runs a suite list rather than the hermetic one), which is
    // why the entry point is its own name here and not the hermetic run's `vitestBin`.
    const vitestEntryPoint = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
    try {
      process.stdout.write(`[${gate}] vitest run (${suites.length} suite(s)) with NPATI_SECURITY_GATE_DB=1\n`);
      const vitest = spawnSync(
        process.execPath,
        [vitestEntryPoint, "run", ...suites, "--reporter=json", `--outputFile=${reportPath}`],
        { cwd: root, shell: false, encoding: "utf8", env: { ...process.env, NPATI_SECURITY_GATE_DB: "1" } },
      );
      if (vitest.error) {
        process.stdout.write(`[${gate}] FAILED to start vitest: ${vitest.error.message}\n`);
        ok = false;
      } else {
        const vitestOutput = `${vitest.stdout ?? ""}${vitest.stderr ?? ""}`.trim();
        if (vitestOutput) process.stdout.write(`${vitestOutput}\n`);
        let report = null;
        try {
          report = JSON.parse(readFileSync(reportPath, "utf8"));
        } catch (error) {
          process.stdout.write(`[${gate}] FAILED to read the vitest report: ${error instanceof Error ? error.message : String(error)}\n`);
          ok = false;
        }
        if (report) {
          const verdict = evaluateVitestReport(report);
          for (const line of formatFailedTests(report)) process.stdout.write(`${line}\n`);
          for (const failure of verdict.failures) process.stdout.write(`[${gate}] ${failure}\n`);
          process.stdout.write(`[${gate}] tests: passed=${verdict.numPassed} failed=${verdict.numFailed} skipped=${verdict.numPending} todo=${verdict.numTodo}\n`);
          summary.tests = {
            passed: verdict.numPassed,
            failed: verdict.numFailed,
            skipped: verdict.numPending,
            todo: verdict.numTodo,
          };
          summary.failedTests = failedTests(report).map((failure) => `${failure.file} > ${failure.title}`);
          const missing = findMissingSuites(report, suites);
          summary.missingSuites = missing;
          if (missing.length) {
            process.stdout.write(`[${gate}] FAILED: ${missing.length} configured suite(s) did not run:\n`);
            for (const suite of missing) process.stdout.write(`[${gate}]   missing: ${suite}\n`);
          }
          const empty = findEmptySuites(report);
          summary.emptySuites = empty;
          if (empty.length) {
            process.stdout.write(`[${gate}] FAILED: ${empty.length} suite(s) reported no tests at all:\n`);
            for (const suite of empty) process.stdout.write(`[${gate}]   empty: ${suite}\n`);
          }
          if (!verdict.ok || missing.length || empty.length) ok = false;
          if (vitest.status !== 0) {
            process.stdout.write(`[${gate}] FAILED: vitest exited with ${vitest.status}\n`);
            const rawTail = tail(vitestOutput);
            if (rawTail) process.stdout.write(`[${gate}] vitest output (tail):\n${rawTail}\n`);
            ok = false;
          }
        }
      }
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }

  summary.ok = ok;
  summary.generatedAt = new Date().toISOString();
  const artifact = writeGateArtifactAt(root, artifactPath, summary);
  if (artifact.ok) process.stdout.write(`[${gate}] verdict artifact: ${artifact.path}\n`);
  else process.stdout.write(`[${gate}] notice: the verdict artifact could not be written (${artifact.error}); the verdict is unaffected\n`);
  process.stdout.write(ok ? `\n[${gate}] PASSED\n` : `\n[${gate}] FAILED\n`);
  return ok ? 0 : 1;
}

/**
 * G1 (item 5, finding B): the gate's **preparation** phase for the curated typosquat dataset.
 *
 * The defect this closes is a hermeticity defect, not a test defect: `data/` is `.gitignore`d, `npm ci` does
 * not create it, and the only writer of `data/typosquat/*.json` — `scripts/typosquat-dataset-generate.mjs`
 * without `--check` — was invoked from nowhere, so on a clean clone the mandatory `security-gate` job could not
 * go green: five gate suites load that dataset and the gate's own `typosquat dataset guard` step reports it as
 * stale.
 *
 * The choice between "generate inside the guard step" and "an explicit preparation phase" is the second one,
 * and deliberately so:
 *
 *  - the dataset is a **prerequisite of five suites too**, not only of the guard step, and those suites run in
 *    the same vitest process the guard step runs *after*. A generation hidden inside the guard would therefore
 *    still leave the first run of the gate red;
 *  - "generate, then check" in one step would make the gate's own evidence harder to read: the same command
 *    would both repair and judge.
 *
 * So the phase runs **before** vitest, is idempotent, and is honest about what it repairs:
 *
 *  - it generates **only when a dataset file is missing** (the clean-clone state). A dataset that exists always
 *    goes to the `--check` guard untouched, so a **stale** dataset stays RED — generation removes "missing", it
 *    never repairs "stale";
 *  - the generator itself refuses `--check` mismatches, so a partial dataset is not silently completed by a
 *    later run: the run that finds a stale file fails right here.
 *
 * Returns `{ ok, generated, reason, missing }` instead of throwing, so the caller can decide the exit code.
 */
export function prepareTyposquatDataset(options = {}) {
  const root = options.root ?? ROOT;
  const generator = path.resolve(root, TYPOSQUAT_GENERATOR_PATH);
  const dataDirectory = path.join(root, "data", "typosquat");
  const ecosystems = ["npm", "pypi", "cargo", "go", "composer", "maven"];
  const missing = ecosystems.filter((ecosystem) => !existsSync(path.join(dataDirectory, `${ecosystem}.json`)));
  if (!existsSync(generator)) {
    return { ok: false, generated: false, reason: `missing generator ${TYPOSQUAT_GENERATOR_PATH}`, missing };
  }
  if (missing.length === 0) {
    return { ok: true, generated: false, reason: null, missing };
  }
  process.stdout.write(`\n[security-gate] prepare: typosquat dataset is absent (${missing.join(", ")}); generating it from ${TYPOSQUAT_GENERATOR_PATH}\n`);
  // `--root` is not decoration: the generator resolves its target from the tree it is **told** to write into, so
  // a preparation phase that is handed a temp tree (the clean-clone suite) cannot touch this checkout.
  const result = spawnSync(process.execPath, [generator, "--root", root], { cwd: root, shell: false, encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  if (result.error) return { ok: false, generated: true, reason: `could not start ${TYPOSQUAT_GENERATOR_PATH}: ${result.error.message}`, missing };
  if (result.status !== 0) return { ok: false, generated: true, reason: `${TYPOSQUAT_GENERATOR_PATH} exited with ${result.status}`, missing };
  const stillMissing = ecosystems.filter((ecosystem) => !existsSync(path.join(dataDirectory, `${ecosystem}.json`)));
  if (stillMissing.length) return { ok: false, generated: true, reason: `the generator produced no dataset for ${stillMissing.join(", ")}`, missing: stillMissing };
  process.stdout.write("[security-gate] prepare: OK — the typosquat dataset now exists and the guard step will check it\n");
  return { ok: true, generated: true, reason: null, missing };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--db")) {
    if (argv.includes("--list")) {
      process.stdout.write(`${SECURITY_GATE_DB_TESTS.join("\n")}\n`);
      return 0;
    }
    return runDatabaseSuiteGate({
      gate: "security-gate:db",
      suiteListName: "SECURITY_GATE_DB_TESTS",
      suites: SECURITY_GATE_DB_TESTS,
      artifactPath: DB_GATE_ARTIFACT_PATH,
    });
  }
  if (argv.includes("--list")) {
    process.stdout.write(`${SECURITY_GATE_TESTS.join("\n")}\n`);
    return 0;
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), "npati-security-gate-"));
  const reportPath = path.join(reportDir, "vitest-report.json");
  const vitestBin = path.resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
  let ok = true;
  /**
   * G1 (D20): the durable verdict. Every field is filled from the run itself at the point it is known, so the
   * artifact cannot claim a count the gate did not measure.
   */
  const summary = {
    gate: "security-gate",
    script: "scripts/run-security-gate.mjs",
    suiteList: "SECURITY_GATE_TESTS",
    suites: { configured: SECURITY_GATE_TESTS.length, present: SECURITY_GATE_TESTS.length, missing: [] },
    catalogue: null,
    mutationControls: null,
    tests: { passed: null, failed: null, skipped: null, todo: null },
    failedTests: [],
    missingSuites: [],
    emptySuites: [],
    steps: {},
    ok: false,
  };

  /**
   * G1 (item 5, finding B): the **preparation** phase, before every other measurement because five gate suites
   * read the dataset as well. A clean clone gets the dataset generated here (that is what makes `npm run
   * security-gate` green on a fresh checkout); a present-but-stale dataset is left untouched and fails in the
   * `typosquat dataset guard` step below, exactly as before.
   */
  const preparation = prepareTyposquatDataset({ root: ROOT });
  summary.steps.typosquatDatasetPrepare = preparation.ok;
  if (!preparation.ok) {
    process.stdout.write(`[security-gate] FAILED: typosquat dataset preparation: ${preparation.reason}\n`);
    ok = false;
  }

  // Every configured suite must exist before vitest starts. The list is a contract, so a deleted,
  // renamed or mistyped path fails here with its own message instead of as a bare vitest exit code.
  const missingFiles = findMissingSuiteFiles(ROOT, SECURITY_GATE_TESTS);
  summary.suites.missing = missingFiles;
  summary.suites.present = SECURITY_GATE_TESTS.length - missingFiles.length;
  process.stdout.write(
    `\n[security-gate] suite files: present=${summary.suites.present} missing=${missingFiles.length}\n`,
  );
  if (missingFiles.length) {
    process.stdout.write(`[security-gate] FAILED: ${missingFiles.length} configured suite file(s) do not exist:\n`);
    for (const suite of missingFiles) process.stdout.write(`[security-gate]   missing file: ${suite}\n`);
    ok = false;
  }

  /**
   * The attack catalogue (C14). Checked **before** vitest for the same reason the suite list is: a row whose
   * suite file is gone, whose suite is no longer part of this gate, whose test title nobody wrote or whose
   * negative-control argument is missing must be reported as a catalogue defect instead of as a passing run.
   * The report-side half of the check runs below, against the vitest JSON report.
   */
  const catalogueState = loadAttackCatalogue(ROOT);
  let attackCatalogue = null;
  if (catalogueState.error) {
    process.stdout.write(`[security-gate] FAILED: attack catalogue ${catalogueState.error}\n`);
    summary.catalogue = { rows: null, issues: null, error: catalogueState.error };
    ok = false;
  } else {
    attackCatalogue = catalogueState.catalogue;
    const catalogueVerdict = validateAttackCatalogue({ root: ROOT, catalogue: attackCatalogue, suites: SECURITY_GATE_TESTS });
    const catalogueRows = Array.isArray(attackCatalogue?.classes) ? attackCatalogue.classes.length : 0;
    summary.catalogue = { rows: catalogueRows, issues: catalogueVerdict.issues.length, exemptions: Array.isArray(attackCatalogue?.hardDenyRuleExemptions) ? attackCatalogue.hardDenyRuleExemptions.length : 0 };
    process.stdout.write(
      `\n[security-gate] attack catalogue (${ATTACK_CATALOGUE_PATH}): rows=${catalogueRows} issues=${catalogueVerdict.issues.length}\n`,
    );
    for (const issue of catalogueVerdict.issues) {
      process.stdout.write(`[security-gate]   catalogue ${issue.code} [${issue.id}]: ${issue.detail}\n`);
    }
    if (!catalogueVerdict.ok) ok = false;
  }

  /**
   * G1 (item 3): the mutation matrix. Checked here, before vitest, for the same reason the catalogue is: the
   * decoy-branch runner (`scripts/security-gate-mutation-branch.mjs`) mutates files and runs this whole gate, so
   * the matrix it reads is a contract — every row must resolve to a real file, a real anchor that occurs exactly
   * once, a failing suite this list really runs and a test title that really exists. A row that has rotted away
   * (a renamed test, a moved line) is a defect of the gate's own evidence and is reported here rather than being
   * discovered by a run that then blames the mutation.
   *
   * The runner itself is deliberately **not** part of this gate: it needs git, a worktree and two full gate runs,
   * so it is a separate command (`npm run mutation:branch`) whose verdict is a separate artifact.
   */
  const mutationState = loadMutationControls(ROOT);
  if (mutationState.error) {
    process.stdout.write(`[security-gate] FAILED: mutation matrix ${mutationState.error}\n`);
    summary.mutationControls = { rows: null, issues: null, error: mutationState.error };
    ok = false;
  } else {
    const mutationVerdict = validateMutationControls({ root: ROOT, controls: mutationState.controls, suites: SECURITY_GATE_TESTS });
    summary.mutationControls = {
      rows: mutationState.controls.length,
      decoy: mutationVerdict.counts.decoy,
      cosmetic: mutationVerdict.counts.cosmetic,
      issues: mutationVerdict.issues.length,
    };
    process.stdout.write(
      `\n[security-gate] mutation matrix (${MUTATION_CONTROLS_PATH}): rows=${mutationState.controls.length} ` +
        `decoy=${mutationVerdict.counts.decoy} cosmetic=${mutationVerdict.counts.cosmetic} issues=${mutationVerdict.issues.length}\n`,
    );
    for (const issue of mutationVerdict.issues) {
      process.stdout.write(`[security-gate]   mutation ${issue.code} [${issue.id}]: ${issue.detail}\n`);
    }
    if (!mutationVerdict.ok) ok = false;
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
        summary.tests = {
          passed: verdict.numPassed,
          failed: verdict.numFailed,
          skipped: verdict.numPending,
          todo: verdict.numTodo,
        };
        summary.failedTests = failedTests(report).map((failure) => `${failure.file} > ${failure.title}`);
        const missing = findMissingSuites(report, SECURITY_GATE_TESTS);
        summary.missingSuites = missing;
        if (missing.length) {
          process.stdout.write(`[security-gate] FAILED: ${missing.length} configured suite(s) did not run (expected ${SECURITY_GATE_TESTS.length}, saw ${SECURITY_GATE_TESTS.length - missing.length}):\n`);
          for (const suite of missing) process.stdout.write(`[security-gate]   missing: ${suite}\n`);
        }
        if (!verdict.ok || missing.length) ok = false;
        /**
         * The attack catalogue against the report: every catalogued attack test must have really run, matched
         * by suite **and** exact title. A catalogue row whose test was renamed, moved or skipped is reported
         * with its catalogue id, so the catalogue cannot describe tests that no longer exist.
         */
        if (attackCatalogue) {
          const catalogueMissing = findMissingCatalogueEntries(report, attackCatalogue);
          process.stdout.write(
            `[security-gate] attack catalogue report check: rows=${Array.isArray(attackCatalogue.classes) ? attackCatalogue.classes.length : 0} missing=${catalogueMissing.length}\n`,
          );
          if (catalogueMissing.length) {
            process.stdout.write(`[security-gate] FAILED: ${catalogueMissing.length} catalogued attack test(s) did not run:\n`);
            for (const entry of catalogueMissing) {
              process.stdout.write(`[security-gate]   catalogue ${entry.id}: ${entry.suite} > ${entry.title}\n`);
            }
            ok = false;
          }
        }
        const empty = findEmptySuites(report);
        summary.emptySuites = empty;
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
  summary.steps.toolSchemas = runStep("tool schema guard", "scripts/verify-code-tool-schemas.mjs", ["--check"]);
  ok = summary.steps.toolSchemas && ok;
  summary.steps.sandboxImages = runStep("sandbox image guard", "scripts/sandbox-image-verify.mjs");
  ok = summary.steps.sandboxImages && ok;
  // A stale curated typosquat dataset must fail CI here: otherwise every `code.deps.add` would silently
  // become an approval forever instead of the check being refreshed. The preparation phase above has already
  // generated a *missing* dataset; this step is the check, and it is the only thing that may repair nothing.
  summary.steps.typosquatDataset = runStep("typosquat dataset guard", TYPOSQUAT_GENERATOR_PATH, ["--check"]);
  ok = summary.steps.typosquatDataset && ok;

  /**
   * G1 (D20): the durable verdict, written **after** every measurement and **before** the exit code, so the
   * artifact describes the run that really happened — including a run that failed. A write failure is
   * reported and does not change the verdict: the artifact is evidence, and the gate's own contract is the
   * suite list. CI turns a missing artifact into a failure at the upload step instead.
   */
  summary.ok = ok;
  summary.generatedAt = new Date().toISOString();
  const artifact = writeGateArtifact(ROOT, summary);
  if (artifact.ok) process.stdout.write(`[security-gate] verdict artifact: ${artifact.path}\n`);
  else process.stdout.write(`[security-gate] notice: the verdict artifact could not be written (${artifact.error}); the verdict is unaffected\n`);

  process.stdout.write(ok ? "\n[security-gate] PASSED\n" : "\n[security-gate] FAILED\n");
  return ok ? 0 : 1;
}

/**
 * The module is imported by the gate suites, so it must stay free of import-time side effects: nothing but
 * definitions runs at module scope, and `main()` is invoked only by the executable wrapper
 * (`scripts/run-security-gate.mjs`), which owns the shebang and calls `isEntryPoint` with its **own**
 * `import.meta.url`. The comparison is case- and separator-insensitive because Windows paths differ in both,
 * and a mistaken match would recursively run the whole gate from a test.
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
