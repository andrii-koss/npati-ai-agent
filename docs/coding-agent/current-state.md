# NPATI Coding Agent — Current State

Update this file after every completed step.

## Current step
- Last completed: **C4 — shell, processes, SecretLease and verification** (after C0 audit, C1 foundation, C1c audit log, C1a flags/versioning, C1b image supply chain, C2 read tools, C3 edit tools)
- Next: **C4b — network policy (egress allowlist + proxy)** then **C4a — dependency policy**, per the hard order in `docs/coding-agent/00-audit.md` section 13. (Both were listed as part of the C4 family; the shell/lease half is done here.)

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
