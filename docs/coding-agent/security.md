# Coding Agent — security model (C14)

Scope: the threat surfaces the Coding Agent has to answer for, the defence that answers each one, and how
each defence is proven non-vacuous. The G1 red-team report itself is
`docs/coding-agent/security-gate-report.md`; this document is the model behind it and **links** to that
report rather than repeating its evidence tables.

Threat model: `docs/coding-agent/00-audit.md:293-353` (T1–T14) — the audit put **network egress, secret
handling and workspace escape ahead of kernel escapes**, which is why the sandbox decision for C1b stayed on
`runc` with hardening and an optional stronger provider behind an interface, not a gVisor/Kata requirement
(`docs/coding-agent/sandbox-images.md:160-179`).

---

## 1. Threat surfaces and the defence for each

| Surface | Threat | Defence | Code |
| --- | --- | --- | --- |
| Command execution | Generated code escaping the container or exhausting the host | Container containment: non-root user, read-only rootfs, tmpfs workspace, all capabilities dropped, no-new-privileges, CPU/memory/pids limits, no docker socket, per-run internal network | `docker-sandbox-provider.ts:75-95`, `:127` |
| Resource exhaustion | Fork bomb, disk fill, memory/CPU amplification, output flood, 9 000-char commands | Hard-deny classifier rule `fork_bomb`, `--pids-limit` floor, disk/memory/cpu validation that refuses decorative limits, output truncation and an untrusted-data output budget | `code-shell-classifier.ts:120`, `docker-sandbox-provider.ts:127`, `security-gate-report.md:99-133` |
| Network egress | Reaching a registry that was not approved, an NPATI-internal service, or cloud metadata | Phase-scoped hostname allowlist (`install`, `run`; the `build` phase has **no network at all**), an egress proxy reading the same module, and a policy gate that refuses network commands until enforcement is proven | `egress-allowlist.ts:4-16`, `sandbox-egress-proxy.mjs`, `code-policy-engine.ts:787-800` |
| SSRF | IP encodings, DNS rebinding, redirects to loopback/metadata, credentials in URLs | One shared policy and one shared client: scheme/port/host shape/credential checks, private/loopback/reserved address refusal **before** a socket exists, and re-validation on **every** redirect and every delivery | `ssrf-policy.ts:15-18`, `ssrf-safe-http.ts:141-143`, `webhook-destination-policy.ts:24-29` |
| Path traversal | `..`, absolute paths, UNC, drive letters, NUL, Windows reserved names, encoded and Unicode look-alikes, zip-slip, symlink entries | A total path guard (`normalizeWorkspacePath`, `safeProjectPath`) plus archive extraction that refuses rather than sanitises; unicode normalisation is a **measured limitation** (RT-12) | `security-gate-report.md:135-155` |
| Prompt injection | A file, README, `NPATI.md`/`AGENTS.md`, tool output, web page, MCP response or command output attempting to change mode, permissions or approvals | Content is data, always: the `untrusted_data` envelope with a closed key vocabulary, a trust phase that refuses policy mutation from repository content, and reader functions that only ever see server-built fields | `code-prompt-injection-guard.ts:139`, `code-policy-engine.ts:595-610`, `security-gate-report.md:116-121`, `:157-167` |
| Secret leakage | A canary reaching a prompt, tool result, Activity, log, diff, export or error message | One-call `SecretLease` with audit-before-issue, a secret scanner that **refuses** rather than redacts at the boundaries, and Activity payload rules that reject content keys and secrets | `code-secret-lease.ts`, `code-secret-scanner.ts`, `code-run-activity-sink.ts:37-86` |
| Privilege escalation | Role escalation, self-approval, replaying an approval, an agent token acting as approver | RBAC with an explicit never-granted list, privileged permissions never implied by wildcards, and an agent principal that is refused as approver in phase 2 | `code-rbac.ts:57-69`, `:146`, `code-policy-engine.ts:556-560` |
| Unprovable privileged action | A policy change nobody can prove happened | Fail-closed tamper-evident AuditLog written **before** the change applies | `audit-log.ts:11-15`, `:72-75` |
| Supply chain | Typosquats, lifecycle scripts, registry reconfiguration, unverified base images | Dependency policy turning non-registry sources and install scripts into approvals, a typosquat dataset, digest-pinned signed images with a 14-day scan freshness policy | `code-deps-policy.ts`, `code-typosquat-dataset.ts`, `sandbox-images.md:118-158` |
| Approval bypass by rephrasing | Obfuscated commands, chains, script-then-run, TOCTOU between approval and execution | A deterministic payload hash over the exact judged material, consumed by the store's own atomic statement, with the typed git target and the MCP runtime identity folded in | `code-policy-engine.ts:1090-1146`, `project-git-service.ts:1121-1122` |

---

## 2. Sandbox containment

Enforced by `docker-sandbox-provider.ts` (the argument lines, not a policy document):

```
--network <per-run internal network> --network-alias project-preview --user 10001:10001
--read-only --cap-drop ALL --security-opt no-new-privileges
--cpus <n> --memory <size> --pids-limit <n> --tmpfs /workspace:size=<diskBytes>
```

(`docker-sandbox-provider.ts:93-95`; the header calls this "read-only root filesystem, all capabilities
dropped, no-new-privileges, tmpfs workspace, an internal network".)

Limits are validated, not merely accepted — a decorative ceiling is refused with
`Invalid sandbox resource limits` (`docker-sandbox-provider.ts:127`):

* `cpu` must match `^(?:0\.[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$`;
* `memory` must match `^[1-9][0-9]*(?:[kmg])?$`;
* `diskBytes` must be a safe integer **≥ 16 000 000**;
* `pids` must be a safe integer **≥ 16**.

The egress proxy is a second, similarly hardened container: `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--memory 128m`, `--pids-limit 64`, `--read-only`,
`--tmpfs /tmp:rw,nosuid,nodev,size=16m` (`docker-sandbox-provider.ts:202`).

Image supply chain: digest pinning, cosign keyless provenance, per-digest SBOM, a scan with a 14-day
freshness policy, and a rule that a CRITICAL finding exits the scan step non-zero so the sign step never runs
and the entry stays `unverified` (`sandbox-images.md:125-135`). A **revoked** digest forces new sessions onto
the current one, and a running session keeps the digest it was created with — a long run cannot change its
runtime mid-flight (`sandbox-images.md:141-150`).

> **Honest limit.** There is no Docker in the test environment. The ceilings are verified on the
> `docker create` argument line and on the provider's own validation, **not** by triggering an OOM or filling
> a disk. The real container run is an unchecked item on the G1 manual checklist
> (`security-gate-report.md:131-133`, `:210-211`, `:262-273`).

---

## 3. Egress and SSRF

One module is the single source of truth for the sandbox egress allowlist, and the enforcement probe, the
sandbox provider and the proxy must all read it, so an operator cannot end up with two different policies
(`egress-allowlist.ts:4-16`). Phases are explicit: dependency fetching may reach registries, execution may
reach configured git hosts, and the build phase has **no network at all** (`:9-11`). The metadata service is
named as a blocked host (`egress-allowlist.ts:92`, `sandbox-egress-proxy.mjs:38`).

The SSRF policy and client are shared by every NPATI-side outbound request — web fetch/crawl, webhooks, MCP,
image/video URL inputs (`app.ts:950`, `:1649-1651`, `:2395`) — and refuse with a closed code vocabulary:
`ssrf_blocked_scheme`, `ssrf_blocked_port`, `ssrf_blocked_private_ip`, `ssrf_blocked_credentials`
(`ssrf-policy.ts:15-18`). An ambiguous numeric host literal is refused rather than resolved
(`ssrf-policy.ts:283`).

Policy-wise, a network command is a hard **availability** gate, not an approval: in every mode, including
`full_auto_sandbox` and including with a granted approval, it is refused `503
network_enforcement_unavailable` (retryable) until the sandbox actually guarantees egress allowlist
enforcement (`code-policy-engine.ts:783-800`). "We could not prove enforcement" therefore fails closed
instead of degrading to an approval.

---

## 4. Content is data

Three mechanisms, at three different layers:

1. **The envelope.** Every tool result is wrapped with `trust: "untrusted_data"` and a closed key set; the
   top level carries no `risk`, `mode`, `approval`, `role`, `flag`, `permission`, `allow`, `capability`,
   `grant` or `trusted` field. RT-04 pins this: hostile stdout containing "enable full_auto", "approve
   yourself", "change your role to owner" produces a byte-identical engine verdict before and after, while a
   negative control shows the same engine does answer differently for a genuinely hard-denied command
   (`security-gate-report.md:116-121`, `:226-229`).
2. **The trust phase.** Repository content that attempted a policy change is refused
   (`repository_instruction_policy_change`) regardless of whether the project is trusted, and applying
   repository instructions requires an explicit owner/admin trust record
   (`code-policy-engine.ts:600-610`). `repositoryContentCanChangePolicy()` is typed to return `false`
   (`code-prompt-injection-guard.ts:139`).
3. **The readers.** The values the engine treats as authoritative are built server-side:
   `readOnlyIntent` from the session's resolved intent, `git` as a typed intent, `runtimeMcp` from the
   published record plus the model's own arguments, the session mode from the session record
   (`code-policy-engine.ts:139-192`, `:742-744`). Hook results have no policy member
   (`current-state.md:122-123`), slash-command expansion carries `canChangePolicy: false` /
   `canGrantTools: false` (`code-commands.ts:558-560`), and permissive-looking names are never trusted: an
   MCP tool called `read_file` is mapped to `workspace:write`, because a third-party server's claim is not a
   permission (`code-policy-engine.ts:428-441`).

The repository-instruction classifier recognises conventional instruction paths (`npati.md`, `agents.md`,
`claude.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.npati/`) plus
`readme|instructions|guidelines` files (`code-prompt-injection-guard.ts:43`, `:76`), and classifies each
candidate through the prompt-injection guard before anything is applied (`:93-97`).

---

## 5. Secrets

`code-secret-lease.ts` issues one-call leases for a single credential field, target and session, with:

| Property | Value |
| --- | --- |
| Default TTL | `NPATI_CODE_SECRET_LEASE_TTL_MS`, default **120 000 ms** |
| Maximum TTL | `NPATI_CODE_SECRET_LEASE_MAX_TTL_MS`, default **120 000 ms** (the requested TTL is clamped) |
| States | `active` / `revoked` / `expired`; an expired or revoked lease never yields a reference |
| Audit | Every issue **and** revoke is recorded before it takes effect; an override additionally requires the journal (`audit_unavailable` if it throws) |
| Redaction | `redactLeaseValues` replaces every leased value with `[REDACTED_SECRET]` |

(`code-secret-lease.ts:37`, `:113-114`, `:190-194`, `:227-233`, `:293-335`, `:420-430`.)

The module's own header states the boundary: it stores **metadata only** and the value itself is resolved and
redacted by the caller (`code-secret-lease.ts:14`). A caller is expected to revoke in a `finally`, so a
second git call needs a new lease rather than inheriting one (`:373`).

Where a secret would have to be written anywhere the run can observe, the design is to **refuse, not
sanitise**: a hook result containing a secret refuses the hook; a skill body that would require redaction is
refused (`skill_provider_data_refused`); a subagent handoff digest containing a secret refuses the handoff
(`current-state.md:121-122`, `:152`, `:250`).

---

## 6. RBAC

| Concept | Members | Behaviour |
| --- | --- | --- |
| Never granted | `code.hard_deny`, `code.docker.socket`, `code.production_credentials` | Refused whatever the matrix says; hard deny is unreachable (`code-rbac.ts:64-69`) |
| Privileged | `code.prod.operate`, `code.policy.manage`, `code.trust.manage`, `code.rbac.manage` | A role must name them explicitly; the wildcards `*`, `owner`, `admin:all` do **not** imply them (`code-rbac.ts:24`, `:57-62`, `:146`) |
| Unmapped action | — | `action_not_mapped` is a refusal, not an identity mapping (`code-rbac.ts:55`) |
| Admin marker | `hasAdminPermission` — one definition of "is this an admin principal", replacing scattered inline arrays (`code-rbac.ts:148-154`) |
| Agent principals | `subject: agent:*` / `service:*` or `userId: agent:*` | Recognised conservatively (any doubt resolves to "agent") and refused as approver (`code-policy-engine.ts:464-472`, `:556-560`) |

Authorization decisions themselves require the audit journal: `code-rbac.ts:536` and `:563` raise
`audit_unavailable` (503) when it is missing.

---

## 7. AuditLog is fail-closed; Activity is not

`AuditLogService` is described as "the AuditLog interface every later step uses", whose `record` is the only
write path and **throws on failure (fail closed)**; it stores ids, decisions, hashes and redacted metadata
only, and "Activity stays where it is" (`audit-log.ts:69-75`).

| Property | Value / behaviour |
| --- | --- |
| Chain | Append-only, hash-chained; `verifyAuditEntries` re-derives the chain and compares the latest anchor |
| Intervals | Verify every 21 600 000 ms (6 h), anchor every 3 600 000 ms (1 h), retention 365 days, `blockOnBreak: true` (`audit-log.ts:81`) |
| Break handling | Once a company's chain is broken, privileged operations are **blocked** pending investigation (`audit-log.ts:91-93`) |
| Redaction | Secrets by key and by pattern (the project's `CredentialMasker`), and prompt/content-like keys replaced with `[REDACTED]`, so the journal never becomes a content store (`audit-log.ts:34`, `:40-54`) |
| Metadata only | `payload` is stored as a canonical hash, not as content (`audit-log.ts:95`) |

Every privileged surface follows the same order — **journal first, then apply**: project trust
(`code-project-trust.ts:60-75`), RBAC (`code-rbac.ts:536`, `:563`), session mode
(`code-session-mode-routes.ts:120-135`), protected branches (`code-protected-branches.ts:823-839`), egress
allowlist (`egress-allowlist.ts:328`), SecretLease (`code-secret-lease.ts:293-335`), MCP risk override
(`mcp-risk-override.ts:158`, `:194`), approvals and approval rules (`approvals-routes.ts:105`,
`code-approval-scope.ts:527-533`), project lifecycle and membership
(`code-project-lifecycle-routes.ts:252-265`, `code-membership.ts:523-532`).

By contrast, Activity recording is explicitly **not** a gate: the engine calls the recorder after the verdict
and never lets a recorder failure change the decision (`code-policy-engine.ts:527-537`). Activity payloads
reject content keys and secrets outright (`code-run-activity-sink.ts:37-86`), and `code-hooks.ts` has no
audit port at all, so a hook invocation cannot be mistaken for an administrative decision
(`current-state.md:130-132`).

---

## 8. Red-team catalogue and mutation sensitivity

The C14 red-team work is catalogued in `docs/coding-agent/attack-catalogue.json`, guarded in three places and
reported in `docs/coding-agent/security-gate-report.md`.

| Fact | Value | Source |
| --- | --- | --- |
| Catalogue rows | **24**: 15 attack classes (RT-01…RT-15) + 8 gate-integrity rows (RT-16…RT-23) + RT-24 (obfuscated command execution, added by G1/D10) | `attack-catalogue.json` → `classes` |
| Status breakdown | **23** `covered`, **1** `measured-limitation` (RT-12, Unicode normalisation in zip dedup) | same, grouped by `status` |
| Hard-deny rule coverage | 16 classifier `HARD_DENY_RULES` accounted for: RT-24 claims the four G1/D10 rules (`decode_pipe_shell`, `eval_dynamic`, `shell_alias_definition`, `path_manipulation`) and the rest are covered by **11** exempted rules, each with a probe command that really fires the rule | `attack-catalogue.json` → `hardDenyRuleExemptions`; `security-gate-report.md:23-26`, `:84-91`, § 7.4 |
| Row schema | `id`, `class`, `suite`, `title`, `negativeControl`, `negativeControlSuite`, `negativeControlTitle`, `hardDenyRuleIds`, `status` | `attack-catalogue.json` |
| Guard levels | (1) static validation **before** vitest, (2) dynamic validation against the vitest JSON report **after**, (3) the same functions exercised in the suite itself | `security-gate-report.md:46-63` |
| Fabrication proof | Five kinds of fabricated row all produce `ok=false` with their own codes; the real catalogue produces `ok=true, issues=0` | `security-gate-report.md:65-82` |
| New red-team suites | 7 suites, 34 tests, `failed=0` | `security-gate-report.md:250` |
| Mutation controls (in memory) | **5**, each neutralised **in memory** (no file on disk changes), each asserting the attack now succeeds and then that the refusal returns | `security-gate-report.md:171-210` |
| Branch mutations (decoy branch) | **3** rows in `mutation-controls.json`: 2 `decoy` rows (the `fork_bomb` rule removed; the workspace-relative traversal guard weakened) that must make the **real** `run-security-gate.mjs` exit non-zero with the named test among its failures, and 1 `cosmetic` row that must leave it green. Guarded **in the gate** (file, anchor uniqueness, gate suite, test title, both directions); the run itself is `npm run mutation:branch` — it needs git and two full gate runs, so it is not a PR blocker | `mutation-controls.json`, `security-gate-report.md` § 5.1, § 7.5 |
| Current gate size | `node scripts/run-security-gate.mjs --list` → **150** lines (149 before G1 registered the mutation-matrix guard suite) | reproduction command |

**How "0 successful attacks" is demonstrated.** The catalogue is a list of *attack classes under test*, each
tied to a named test title and a named negative control ≥ 40 characters long, so a row cannot be satisfied by
an empty or "n/a" justification; a renamed, moved or `.skip`-ped attack test is reported **by catalogue id**
(`security-gate-report.md:48-63`). On top of that, five guards are deliberately removed in memory and the
corresponding test must fail — if neutralisation changes nothing, the control is declared decorative and the
test fails (`:171-210`). A sixth claim — that the **gate itself** goes red when a guard is deleted from the
source — is a different one and is carried by the decoy branch (`npm run mutation:branch`), which copies the
tree under review into an isolated `git worktree`, weakens exactly one guard, runs the real gate and requires
the named test among its failures, with a cosmetic mutation as the negative control (§ 5.1).

**What "0 successful attacks" therefore is *not*.** No live model attacked this build. The rows are rules
under test with scripted attacks, and the mutation evidence is about the **suite's sensitivity**, not about a
model's behaviour. RT-12 is recorded as `measured-limitation`, not as covered: path deduplication in
`extractProjectZip` lower-cases but does not Unicode-normalise its key, so `café.txt` in NFC and NFD are two
entries there and one file on a normalisation-sensitive filesystem (APFS). The test asserts only what stays
true after a fix, and the catalogue says `measured-limitation` (`security-gate-report.md:144-150`).

> **Documentation divergence (closed by G1).** This paragraph used to report that `security-gate-report.md:37`
> and `:248-249` stated **138** suites while the current fixed list was **144**. Both numbers are now the same
> one: the report states **150** (`node scripts/run-security-gate.mjs --list` → 150 lines, `suites=150
> present=150 missing=0`) and the fixed list in `scripts/run-security-gate.mjs` holds 150 entries, because the
> C14 gate-size guard reads the number **out of the document** (`security-gate-report.md` § 7.4/§ 5.1). The history is
> kept as history: 131 → 138 (C14) → 144 (guard suite) → 145/146 → 148 (C15) → 149 (G1: `c1a-flags`) → **150**
> (G1: the mutation-matrix guard suite).

---

## 9. Quarantine: a failing suite that stays visible

`known-failures.json` declares the pre-existing failures with the exact test id (`file` + full vitest title),
a `reason`, an `owner`, `added_at` and an **`expires_at`**. Measured state: **15 entries across 10 files**
(`known-failures.json`, `version: 1`, `updated_at: 2026-10-07`).

`npm run test:known-failures` runs the **whole** suite — the same invocation `npm test` makes, with the JSON
reporter, no file filter, no `--exclude`, no `continue-on-error` — and is GREEN only while every actual
failure is documented and unexpired. Four conditions are RED (`scripts/check-known-failures.mjs:10-23`,
exit codes at `:36`):

1. an **undocumented failure** — the only case that can hide a regression;
2. a **stale entry** — a quarantined test that passed (the quarantine must shrink, or it would swallow the
   test's *next* failure);
3. an **expired entry** — expired whether or not the test is still failing, because a quarantine without an
   expiry is a permanent exemption;
4. an **untrustworthy manifest** — a malformed entry, a duplicate id, or a run that did not actually execute
   every suite file on disk.

Growing the quarantine is a signed human decision: `--adopt` refuses to run without a reason and an expiry
and is deliberately not usable from CI (`check-known-failures.mjs:33-34`).

---

## 10. Honest limits

1. **CI has never run on GitHub — and since G1 it is not triggered at all.** The workflow is configured and
   pinned by tests (`tests/coding-agent-c14-ci-and-lint-gates.test.ts` — the trigger pins were replaced in G1 by
   the stricter ones: the trigger set must be exactly `["workflow_dispatch"]`, and the removed trigger contract
   is kept as a machine-readable re-enable recipe) and states exactly which gates it runs (`npm ci`,
   security-gate, both typechecks, lint, both audits, the quarantine gate, build, `eval:smoke`, upgrade gate) —
   but its execution is verified statically plus locally with equivalent commands, never by a real GitHub Actions
   run. On top of that, the owner has **disabled every automatic trigger** (private repository, no paid Actions
   minutes, every job of the last automatic run failed in ~2 s without starting), so the mandatory security gate
   currently blocks **no** merge and **no** release and the quarantine does not fire on a push. That consequence
   is an accepted risk with an owner slot and an expiry, not a fix: `security-gate-report.md` §6 item 11 and
   §7.6, `current-state.md` (section "Current step").
2. **No Docker in the test environment.** Containment ceilings are proven on the argument line and by the
   provider's validation, not by a real OOM/disk-full event (`security-gate-report.md:210-211`).
3. **C4b Docker E2E has not been performed**, and the sandbox egress allowlist is therefore still an
   unproven-in-container guarantee — which is exactly why the policy gate refuses network commands until
   enforcement is guaranteed (`code-policy-engine.ts:787-800`).
4. **Migrations 070–085 have never been applied to a live PostgreSQL.** `085_mcp_tool_policies` is defined in
   `packages/workspace/src/migration-085.ts` and applied from `postgres-store.ts:1220-1227`, but the migration
   path has not been exercised against a real database in this environment.
5. **The composed shell string is not executed by a real shell.** Escaping is pinned by exact string equality
   (the canonical `'\''` idiom) and by the fact that the engine judges the **raw** command
   (`security-gate-report.md:212-214`).
6. **RT-12 is an accepted measured limitation**, not a covered class (`security-gate-report.md:144-150`).
7. **`normalizeWorkspacePath` has no mutation seam**, so the path guard is proven by refusal/acceptance pairs
   plus a containment invariant rather than by mutation; the mutation evidence for that layer comes from the
   control above it (`security-gate-report.md:200-204`).
8. **The 11 `hardDenyRuleExemptions` cite behavioural coverage** in `tests/coding-agent-c4-classifier.test.ts`
   (the assert is `hard_deny` for such commands), not rule-identity coverage; identity is proven by each
   exemption's `probe` (`security-gate-report.md:218-221`).
9. **Production ready = NO.** The three headline numbers and their limits are stated once in
   `docs/coding-agent/c14-final-report.md`.
