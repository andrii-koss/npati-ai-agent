# NPATI Coding Agent — C0 Audit

> **Status:** complete (C0). This document is the only code-free deliverable of C0.
> **Read-only guarantee:** C0 changes no application code, no DB schema, no configuration. The only
> files touched are `docs/coding-agent/00-audit.md` and `docs/coding-agent/current-state.md`.
> **Plan of record:** `docs/coding-agent/PLAN.md` (version 4, steps C0–C15 +
> C1a/C1b/C1c/C4a/C4b/C5a/C5b/C6a/C6b/G1/R1).
> **Companion audits:** `docs/website-builder/00-audit.md`, `docs/data-studio/00-audit.md`,
> `docs/data-studio/SELF_HOSTING.md`.

## Contents

The section numbers are authoritative and match the required C0 format
(`PLAN.md:209-218`). Sections were written as evidence arrived, so the physical order in the file
differs from the numbering; use this index.

| Section | Topic coverage |
|---|---|
| 0 | scope, method, evidence rules, acceptance mapping |
| 1 | documentation inventory and the plan's locked decisions |
| 2 (2.1–2.7) | platform facts confirmed first-hand: CI and gates, capability-registry baseline, existing `project.*` tool surface, coding-adjacent modules, migration system and permissions, Website Builder reuse verdict, evidence limits |
| 3 | model capability matrix and model metadata (topics 2, 22) |
| 4 | what must be created from scratch (topics 13, 15, 16, 19, 24) |
| 5 | `CodingAgentRunner` architecture: what the runtime does today, where the loop lives, state, agent integration (topics 1, 6, 7, 9) |
| 6 | `ToolCallAdapter` and per-profile edit format (topics 2, 14) |
| 7 | sandbox and runtime conclusion incl. the image verdict (topics 10, 15, 16, 19, 20) |
| 8 | threat model T1–T14 with limits and latent surfaces |
| 9 | RBAC, approvals, audit, secrets (topics 5, 18, 24) |
| 10 | observability, limits, budgets (topic 23) |
| 11 | UI building blocks for a code workspace (topic 11) |
| 12 | license review of reference harnesses (topic 12) |
| 13 | refined step order C1–C15 + SG-1/SG-2/SG-3/G1 with real dependencies |
| 14 | risks and answers to the eleven open questions (`PLAN.md:1032-1045`) |
| 15 | C0 acceptance self-check |

## 0. Scope, method and evidence rules

Scope: the 24 audit topics listed in `docs/coding-agent/PLAN.md:184-207`, the required document
format (`PLAN.md:209-218`) and the acceptance criteria (`PLAN.md:220-223`).

Method:

1. Direct inspection of the repository (read/grep/glob) — every statement below carries a
   `path:line` reference to the file it was read from.
2. Six parallel read-only research streams (agent runtime, AI providers, workspace/sandbox,
   capabilities/approvals/RBAC/audit, platform/ops/UI, reference-harness licenses). Their findings
   are folded into the sections below with the same citation rule.
3. Non-verifiable claims (for example third-party license terms or live Docker behaviour) are
   marked explicitly as `unknown` / `not verified` instead of being asserted.

Evidence rules used in this document:

- `path:line` always means the exact file and line the statement was read from.
- `not found (grep …)` means the fact was actively searched for and does not exist today.
- Anything inferred (a design proposal) is marked **Proposal**.

Acceptance mapping (self-check) is in section 15.

## 1. Documentation inventory (sources of truth)

| Document | Lines | What it fixes | Reuse in C1+ |
|---|---|---|---|
| `docs/coding-agent/PLAN.md` | 1059 | step-by-step prompts C0–C15 incl. sub-steps, shared rule block, default limits, phases, open questions, regression checklist | the normative plan; C0 refines the step order against the real codebase (section 13) |
| `docs/coding-agent/00-audit.md` | this file | audit deliverable of C0 | input for C1 design decisions |
| `docs/coding-agent/current-state.md` | 27 | handoff between sessions | updated at the end of C0 |
| `docs/website-builder/00-audit.md` | 17279 bytes | what the Website Builder already owns (projects, files, terminal, preview) | the reuse baseline for C1–C4 |
| `docs/data-studio/00-audit.md`, `docs/data-studio/current-state.md`, `docs/data-studio/SELF_HOSTING.md` | 20003 bytes + state + ops guide | Data Studio runtime: provisioning, migrations, snapshots, promote, quotas, external DBs | the DB-migration/runtime precedent for C6a and the sandbox-host precedent for C1b |

Facts locked by the plan that C0 must not re-open (`PLAN.md:74-101`): reuse of Website Builder
primitives, own agent loop (no external CLI dependency), code execution only in the sandbox,
`edit`/`apply_patch` as the primary editing tools, model behaviour driven by profiles, everything
through the capability registry, evaluations from the start, untrusted repository/web content,
staged rollout behind flags, versioned `code.*` tools and API, supply-chain-safe installs,
recoverable runs, security gate as a hard requirement, RBAC intersection, provider data policy,
execution snapshot, digest-pinned images + egress proxy, rollout readiness after G1+R1, protected
branches as hard deny, SecretLease for secrets, tamper-evident audit with fail-closed behaviour,
and the readiness ladder *C7 = feature complete, G1 = security ready, R1 = production/rollout
ready* (`PLAN.md:100`).

## 2. Platform facts confirmed first-hand (C0 evidence)

### 2.1 CI and release gates (topic 17)

| Fact | Evidence |
|---|---|
| There is exactly one CI workflow and it is **manual-only**: `on: workflow_dispatch` | `.github/workflows/ci.yml:3-4` |
| `platform` job: `npm ci` → `npm run typecheck` → `npm run audit:capabilities` → `npm test` → `npm run build` on ubuntu/windows/macos | `.github/workflows/ci.yml:14-33` |
| `docker` job builds the four runtime images, including the project sandbox and the egress image | `.github/workflows/ci.yml:35-45` |
| `release-gate` job runs `gate:upgrade` and depends on `platform` + `docker` | `.github/workflows/ci.yml:47-61` |
| No test in `tests/*.test.ts` is tagged `security-gate` today | `not found (grep "security-gate" tests/*.test.ts)` |
| Test/QA scripts available: `test` = `vitest run`, `typecheck`, `build`, `audit:capabilities` (`scripts/verify-capability-matrix.mjs`), `gate:upgrade`, `revalidate:306`, `docker:config` | `package.json` scripts block |
| Test suite size: **215 test files** in `tests/`; `vitest.config.ts:13-20` includes `tests/**/*.test.ts` and `packages/**/*.test.ts`, 10 s timeout, 4 workers, **no `setupFiles`** | `vitest.config.ts:13-20` |
| Security-adjacent tests already exist but are not tagged or gated: sandbox egress (`tests/project-sandbox-egress.test.ts:14-24`), production security (`tests/production-p01-security.test.ts`, `tests/production-security-guardrails.test.ts`), vault scopes (`tests/security-auth-vault-scopes.test.ts`), durable approvals (`tests/production-durable-approvals.test.ts`, `tests/human-approvals.test.ts:5-49`), API-key route authz (`tests/api-key-route-authorization.test.ts`), PII/subagents (`tests/pii-and-subagents.test.ts`), prompt injection (`tests/inference-and-memory-injection.test.ts`) | those files |
| No `security-gate` job exists and **no branch protection is configured in the repository** | `.github/workflows/ci.yml:13-61`, `not found (grep "security-gate")` |
| Hermetic model mocks: DI through `buildApp({ aiEngine })` with a hand-written `AIEngine` literal (`tests/production-admission-self-healing.test.ts:12`, `tests/tool-selection-matrix.test.ts:53`, `tests/active-context.test.ts:16-40`) and `vi.stubGlobal("fetch", …)` for the adapter itself (`tests/omniroute-adapter.test.ts:4-18`, including SSE delta tests `:228-288`) | those files |

**Consequence for G1/security gate:** a `security-gate` job already has a place to live
(`.github/workflows/ci.yml`), but the workflow cannot gate anything until it also runs on
`push`/`pull_request`; today a red test suite does not block a merge. **Proposal:** add a dedicated
`security-gate` job (own npm script, own vitest project/tag) and give the workflow `push`/PR
triggers with `paths` filters, so SG-1/SG-2/SG-3/G1 are automatic rather than manual.

### 2.2 Capability registry baseline (topic 4, first-hand part)

| Fact | Evidence |
|---|---|
| Canonical catalog is validated against the inventory: **348 covered inventory ids** | `tests/capability-registry.test.ts:41`, `:110` |
| **84 agent-callable capabilities** (tools + agent-callable entries) | `tests/capability-registry.test.ts:66`, `:87`, `:111`, `:125` |
| The same numbers are asserted in 10 test files (counter contract that a new `code.*` group must update) | `tests/capability-registry.test.ts`, `developer-capability-inspector.test.ts`, `full-capability-regression.test.ts`, `control-plane-ui-and-revisions.test.ts`, `invariants-and-anti-patterns.test.ts`, `phase13-upgrade-gate-expanded.test.ts`, `phase14-final-production-acceptance.test.ts`, `production-acceptance.test.ts`, `upgrade-compatibility-and-release-gate.test.ts`, `manual-product-e2e-web.test.ts` |
| The matrix audit script only parses the inline matrix literal, so pushed `project.*` entries (and future `code.*`) are not validated by it | `scripts/verify-capability-matrix.mjs:26` |

**Consequence for C2–C4:** every new `code.*` capability changes the two counter contracts above and
must be reflected in the Capability Inspector tests; the existing `project.data.*` /
`project.files.*` groups added in D3–D7 are the working precedent for the mechanics (capability
definition file + matrix push + runtime switch + counters).

### 2.3 The project-domain tool surface that already exists (topic 4, first-hand)

The registry already contains a large, tested tool surface for exactly the operations a coding
agent needs. Each group is one file in `packages/shared/src/`, defines a
`CapabilityDefinition[]` plus a `*_MATRIX` built by mapping, and assigns a contiguous
`inventoryIds` block:

| Group | Tools | Inventory | Source | Risk / approval today |
|---|---|---|---|---|
| `project.files.*` (`list`, `read`, `search`, `create`, `write`, `edit`, `move`, `delete`) | 8 | 307–314 | `packages/shared/src/project-file-capabilities.ts:4-26` | `delete` = high + `requiresConfirmation`; `create/write/edit/move` = medium; `list/read/search` = low. Input schema already carries `expectedRevision` (`project-file-capabilities.ts:20`) → optimistic concurrency exists at the tool level |
| `project.terminal.*` (`exec`, `process`) | 2 | 315–316 | `packages/shared/src/project-terminal-capabilities.ts:4-28` | high + `requiresConfirmation`; `requiredPermissions: ["tools:execute"]`; schema carries `command`, `processId`, `sandboxId` and `environmentReferences` (secret references, not raw secrets) |
| `project.git.*` (`status`, `diff`, `log`, `branch`, `stage`, `commit`, `restore`, `checkpoint`, `restore_checkpoint`, `push`, `pr`) | 11 | 319–330 | `packages/shared/src/project-git-capabilities.ts` | `push` and `pr` are high + `requiresConfirmation` ("requires explicit user approval", `project-git-capabilities.ts:236-290`); `commit`/`restore` = medium; `checkpoint` = low |
| `project.preview.*` (`start`, `status`, `stop`) | 3 | – | `packages/shared/src/project-preview-capabilities.ts` | preview lifecycle of the project sandbox |
| `project.qa.*` (`inspect`, `report`) | 2 | – | `packages/shared/src/project-qa-capabilities.ts` | browser QA findings |
| `project.deploy.*` (`publish`, `status`) | 2 | – | `packages/shared/src/project-deploy-capabilities.ts` | `publish` gated by a human `approved` flag in the deploy service |
| `project.data.*` | 13 | 336–348 | `packages/shared/src/project-data-capabilities.ts` | schema/template/rows/promote, risk-tagged per operation (added in D3–D7) |
| `project.auth.*`, `project.api.inspect` | 3 | – | `packages/shared/src/project-data-capabilities.ts` | auth settings and gateway inspection |

**Proof that these tools are wired end-to-end today:** `apps/agent-api/src/company-tool-runtime.ts:173`
routes `project.git.*` into `projectGitTool`, which switches over the eleven git operations
(`company-tool-runtime.ts:389-429`), and `company-runtime.ts:416` documents the same surface to the
model, including the rule that `push`/`pr` need human approval and a vault credential whose token
never appears in tool input. The approval plumbing for these tools is centralised in
`company-runtime.ts:915`.

### 2.4 Coding-adjacent modules that already exist (topics 3, 9, 11)

| Module | Size / evidence | What it already provides | Reuse for Coding Agent |
|---|---|---|---|
| `apps/agent-api/src/project-git-service.ts` | 35504 bytes | full git workflow service (status/diff/log/branch/stage/commit/restore/checkpoint/push/PR) | C11 must extend this, not write a second git layer |
| `apps/agent-api/src/project-workspace.ts` | 28510 bytes | the project file workspace (read/write/list/search/move/delete) | the only legitimate file backend for C2/C3 |
| `apps/agent-api/src/project-file-lock.ts` | 11220 bytes | pessimistic file locking / revision conflicts | C3 concurrency and C6a recovery |
| `apps/agent-api/src/project-sandbox-service.ts` | 27560 bytes | sandbox lifecycle, exec, sync, idle stop | C4 command execution and C6a reaper |
| `apps/agent-api/src/project-preview-service.ts` | 23549 bytes | preview servers incl. Expo/Next flows | C7 preview of builds/tests |
| `apps/agent-api/src/project-multi-agent.ts` | 22585 bytes | multi-agent project orchestration | C12 subagents |
| `apps/agent-api/src/project-task-graph.ts` | 9724 bytes | task graph for project work | C9 plan/todo |
| `apps/agent-api/src/project-browser-qa-service.ts` + `project-qa-routes.ts` | 9226 + 5473 bytes | browser QA runs and reports | C9/C14 verification signals |
| `apps/agent-api/src/coding-cli-and-file-tools.ts` | 4260 bytes, imported **only** by `tests/file-tools-and-coding-cli.test.ts` | a **stub**: in-memory `virtualFiles` map (`:39-91`), mocked CLI output with hardcoded `durationMs: 120` (`:105-126`), canned recipe results (`:133-154`) | must not be mistaken for a real filesystem/CLI; C1 decides whether to retire it or keep it as a pure interface stub |
| `scripts/execute-agent-mediated-gate.mjs` | 28795 bytes | Playwright + Redis + Postgres end-to-end gate script | template for the G1/C14 gate automation |
| `apps/agent-api/src/project-deploy-service.ts`, `project-deploy-routes.ts` | 10342 + 5618 bytes | deploy approval gate (`approved` boolean + credential from company vault) | precedent for C5a approval UX on production operations |

### 2.5 Migration system and permission vocabulary (topics 14, 18 — first-hand)

| Fact | Evidence |
|---|---|
| Core DB migrations are TypeScript modules `packages/workspace/src/migration-0NN.ts` exporting `runMigrationNNN(client: PoolClient)`; the newer ones run as ordered dynamic imports | `packages/workspace/src/postgres-store.ts:741-790`, `packages/workspace/src/migration-064.ts:1-14` |
| Applied versions are recorded in `schema_migrations(version text PRIMARY KEY, applied_at timestamptz)` and each version runs at most once (idempotent guard) | `packages/workspace/src/postgres-store.ts:98-106` |
| Migrations are **forward-only**: no `down`/`revert` function exists in the runner or in the modules | `not found (grep "down|revert" packages/workspace/src/postgres-store.ts)`; each module exports a single `runMigrationNNN` |
| Permission vocabulary in use today: `admin:all`, `business:manage`, `tools:execute`, `tools:linter`, `tools:read`, `workspace:read`, `workspace:write` | `packages/shared/src/*.ts`, `apps/agent-api/src/*.ts` (permission literals) |

**Consequences:**

1. *Expand/contract* has no runtime support to lean on: because migrations are forward-only and each
   version runs once, the discipline must be enforced by convention plus the Data Studio precedent
   (migration lock, expected-schema fingerprint, drift detection, mandatory snapshot before a
   destructive step — `apps/agent-api/src/data-studio/migration-engine.ts`,
   `apps/agent-api/src/data-studio/backup-service.ts`). C6a should reuse that engine rather than
   invent a second migration path.
2. RBAC today has no `code*` permission, and `tools:execute` is the only execution permission
   (`project-terminal-capabilities.ts:18`). C5a therefore introduces new permissions (for example a
   separate production-operation permission) rather than overloading `tools:execute`, and the
   existing `admin:all` / owner role stays the only approver-capable role until C5a says otherwise.

### 2.6 Website Builder reuse status, primitive by primitive (topic 3)

Verdict: **every primitive the plan wants to reuse already exists**; the coding agent is an
extension of them, not a parallel stack. Only `apply_patch` (C3) and streamed tool arguments (C6)
are genuinely new mechanisms.

| Primitive | Implemented today | Evidence | Reuse / extend for coding | Missing |
|---|---|---|---|---|
| **Project** | yes: `website`, `web_app`, `landing_page`, `mobile_app` types, revisions, archive/delete, data-backend attachment | `packages/workspace/src/types.ts` (`ProjectType`, `appScheme`), `apps/agent-api/src/project-service.ts`, `project-routes.ts` | add a code-with-settings shape in C1 without a new entity; reuse archive/delete semantics | code-specific project settings + `data_classification`/`retention_class` |
| **Workspace (files)** | yes: read/write/list/search/move/delete with size and count limits, disk-backed under `NPATI_PROJECT_WORKSPACE_ROOT` | `apps/agent-api/src/project-workspace.ts:196-200`, capabilities `project.files.*` (`packages/shared/src/project-file-capabilities.ts:4-21`) | the only legitimate file backend for `code.*`; add range reads, repo map and ignore rules on top | ripgrep-class search, binary handling, secret scrubbing on read |
| **File revision / locking** | yes: `expectedRevision` on file tools, a lease manager with conflict detection | `project-file-capabilities.ts:20`, `apps/agent-api/src/project-file-lock.ts:19-123` (`ProjectFileLease`, `pathsConflict`, `acquire`) | C3 edit/patch must take a lease and re-check the revision; C12 parallel subagents reuse conflict detection | patch-level (hunk) conflict handling |
| **Sandbox** | yes: provider abstraction with local/remote/docker implementations, per-run container with `--read-only`, `--cap-drop ALL`, `--tmpfs /workspace`, CPU/memory/pids/disk limits, egress proxy sidecar, idle sweep | `apps/agent-api/src/project-sandbox-service.ts`, `docker-sandbox-provider.ts:105-116,155`, `app.ts:941` | C4 execution; C1b pins the image by digest; C6a reaps | digest admission, SBOM/scan, stronger isolate (optional) |
| **Terminal / command execution** | yes: `project.terminal.exec/process`, a normaliser and risk classifier (`safe` / `controlled` / `approval`) with timeout classes (`default` / `install_build`), framework-CLI and scaffold rules, ANSI/output redaction | `apps/agent-api/src/terminal-command-policy.ts:1-11,31-49,70-80`, `project-terminal-capabilities.ts:4-24` | C4 extends the classifier for build/test/lint toolchains instead of inventing a policy engine; C4a adds the install policy | secret lease per command, per-command network policy |
| **Git** | yes: status/diff/log/branch/stage/commit/restore/checkpoint/restore_checkpoint/push/pr with approval for push/pr and a vault credential whose token never enters tool input | `apps/agent-api/src/project-git-service.ts` (35 KB), `packages/shared/src/project-git-capabilities.ts:132-290`, `company-runtime.ts:416` | C11 extends this service; protected-branch hard deny is an additional policy layer (C5a) | protected-branch enforcement, force-push deny, PR review flow |
| **Checkpoints** | yes: `ProjectCheckpoint` with `trigger: manual \| pre_run \| post_run \| pre_restore`, list/get/delete + restore through git | `packages/workspace/src/types.ts:51-72`, `:343-345`, `project.git.checkpoint`/`restore_checkpoint` | C3/C6a use `pre_run` before every code run and `pre_restore` before rollback | automatic pre-run checkpoint wiring in the coding loop |
| **Preview** | yes: preview service with port allocation, tokens and Expo/Next flows; UI renders preview in a sandboxed iframe | `apps/agent-api/src/project-preview-service.ts` (23 KB), `project-preview-capabilities.ts`, `apps/web/src/BusinessWorkspace.tsx:1232` | C7 shows build/test output and preview side by side | preview of a failed build / test report view |
| **Command risk UI** | yes: terminal events carry `riskLevel` and status; Activity/Run Trace render tool audit rows | `apps/web/src/ProjectPage.tsx:9`, `company_agent_tool_audit` (`migration-007.ts:56-74`) | C7 reuses the same event surface for `code.*` tools | diff/approval payload rendering for code changes |

### 2.7 Evidence limits and what is *not* verified in this audit

- Everything above was read directly from the working tree at the C0 baseline commit
  (`git log -1` at audit time). Line numbers refer to that revision.
- **Not verified in C0:** live Docker behaviour (sandbox images, egress proxy), third-party license
  terms (verified from published sources only, see section 12), and any runtime behaviour that needs
  a running `postgres-projects` / sandbox runner. These are marked `not verified` where they appear.
- **Corrected claim:** one research stream reported that `.env.example` does not exist. It does exist
  at the repository root and is the documented place for deployment variables (for example the Data
  Studio block at `.env.example:83-110`, read and updated in this session). The claim was a scoping
  error in that stream; the audit records the verified state.

## 12. License review of reference harnesses (topic 12)

Method: primary `LICENSE`/`NOTICE`/`README` files from the repositories plus vendor ToS texts,
checked by the license research stream on **2026-10-05**; this is an engineering reference, not a
legal opinion, and the owner decides on any code reuse. Nothing is copied from any project in C0.

| Project | License | Copy code into a closed product | Key caveats | What to learn (ideas only) |
|---|---|---|---|---|
| Claude Code (`anthropics/claude-code`) | proprietary (`LICENSE.md`: "© Anthropic PBC. All rights reserved… Commercial ToS") | **No** | ToS D.4(b) forbids reverse engineering / duplicating the service, D.4(a) building a competing product; decompilation forbidden; bundled plugins under the same terms | loop architecture, tool-calling semantics, approval/permission modes, system-prompt composition, subagents, hooks |
| OpenAI Codex CLI (`openai/codex`) | Apache-2.0 | Yes, with attribution + NOTICE | `NOTICE` mentions Ratatui (MIT); patent clause §3; model service under separate OpenAI terms | `apply_patch`/V4A diff format, sandbox/approval policy (read-only vs workspace-write), JSONL event protocol |
| Aider (`Aider-AI/aider`) | Apache-2.0 | Yes, with attribution | template copyright text; trademarks not granted | repo-map + tree-sitter context, search/replace edit blocks, auto-commit, architect/editor split |
| OpenHands (`OpenHands/OpenHands`) | MIT | Yes (keep copyright + text) | `software-agent-sdk` also MIT; `enterprise/LICENSE` not present in the public tree (404) — do not lift code from private/EE branches | agent server as a REST API + canvas frontend, event model (action/observation), Docker as the sandbox runtime |
| Cline (`cline/cline`) | Apache-2.0 | Yes, with attribution | historical Apache-2.0 ↔ ToS conflict (issue #3510, 2024-12) looks resolved; JetBrains plugin is closed source | Plan/Act modes, human-in-the-loop approvals + auto-approve, checkpoints/rollback, `.clinerules` |
| OpenCode (`anomalyco/opencode`, formerly `sst/opencode`) | MIT | Yes (keep copyright + text) | repository moved; licensor in the copyright line is not a legal entity; README asks for a non-affiliation disclaimer | TUI ↔ HTTP server that survives terminal closure, build/plan agents with different rights, bash permission model |
| SWE-agent (`SWE-agent/SWE-agent`) | MIT | Yes — cleanest option | not a product harness; value is in research protocols | Agent-Computer Interface as its own layer: output limits, terse errors, SWE-bench loop, YAML behaviour profiles |
| Continue (`continuedev/continue`) | Apache-2.0 | Yes, with attribution | repository read-only, final release 2.0.0; unverified third-party mention of an acquisition | IDE-agent architecture, rules/config-YAML, indexing/embeddings for repo search |
| Goose (`block/goose`) | Apache-2.0 | Yes, with attribution | root `NOTICE` is 404; unverified mentions of a repository move | local Rust agent, MCP as the primary extension mechanism, recipes, Ollama/local models |
| Gemini CLI (`google-gemini/gemini-cli`) | Apache-2.0 | Yes, with attribution | code is Apache-2.0, but using the Gemini service is under separate Google terms and quotas | trusted folders as a trust policy, session checkpointing, headless `--output-format stream-json` |
| Devin (Cognition) / Cursor (Anysphere) / Windsurf (Exafunction) | proprietary | **No** | ToS forbid reverse engineering, derivative works, competing products; Cursor §1.5(v) forbids training a competing model on Suggestions; Cognition may train on customer data (paid tiers can opt out) | product concepts only: delegated async engineer, inline diff UX, ZDR as a product option |
| VS Code Copilot Chat (`microsoft/vscode-copilot-chat`) | MIT | Yes (keep copyright + text) | `package.json` says "SEE LICENSE IN LICENSE.txt" while `LICENSE.txt` is plain MIT; the Copilot service itself has separate terms | the fullest public tool-schema set: `readFile` with mandatory line ranges, `applyPatch` (V4A), `findTextInFiles`, `getErrors` as post-edit validation, search/execution subagents |
| Roo Code / Agent Zero | Apache-2.0 / MIT | Yes | Agent Zero repository moved (`frdel` → `agent0ai`) | mode-based prompts with separate rights, orchestrated subtasks, subordinate-agent hierarchy, persistent memory |
| Zed (`zed-industries/zed`) | GPL-3.0-or-later (some components Apache-2.0) | **No for GPL parts** | copyleft poisons a closed product; a `LICENSE-AGPL` file exists with unclear scope — do not use until clarified | editor+agent UX, Rust core performance |
| Tabby (`TabbyML/tabby`) | Apache-2.0 outside `ee/`; Tabby Enterprise License inside `ee/` | Only outside `ee/` | `ee/LICENSE` forbids copying, merging, publishing, distributing, sublicensing, selling the software | local code inference, retriever/indexing, completion schema |
| Security scanners: OSV-Scanner (`google/osv-scanner`), Syft + Grype (`anchore/*`), Trivy (`aquasecurity/trivy`) | Apache-2.0 | Yes, with attribution | vulnerability databases and vendor enterprise products have their own terms | SBOM generation and image scanning for C1b sandbox images |

**Three real traps for NPATI:** GPL/AGPL (Zed) in a closed product; `ee/` directories (Tabby); ToS
clauses that forbid using the tool's output to train competing models (Cursor 1.5(v), Cognition
2.3(iii)) — directly relevant if NPATI ever trains its own models. **Process conclusion:** record
`URL + tag/commit + date` in the audit trail and re-check `LICENSE` on every dependency bump, because
in a single review window OpenCode and Agent Zero moved repositories, Continue froze, and Cursor and
Cognition rewrote their ToS.

**Recommendation for C2–C4/C11 design:** take format and protocol ideas from Codex CLI
(`apply_patch`/V4A, approval-policy vocabulary), tool-schema and post-edit validation ideas from
VS Code Copilot Chat, approval/checkpoint UX ideas from Cline, event-model ideas from OpenHands, and
ACI output discipline from SWE-agent — all re-implemented independently against NPATI's own
capability registry, with an attribution/NOTICE process only if any Apache/MIT code is ever copied.

## 13. Refined step order, real dependencies and SG checkpoints (Proposal)

The plan's order (`PLAN.md:1024-1030`) is kept. This section refines **what each step actually
touches** in this repository, based on the modules confirmed in section 2, and states the
dependency that makes the order non-negotiable.

| Step | Goal (from the plan) | What it must extend (confirmed files) | Hard dependency | Exit criteria (measurable) |
|---|---|---|---|---|
| **C1** Code Project & Workspace foundation | a code project type, session/workspace model, `data_classification` + `retention_class` on new entities | `packages/workspace/src/types.ts` (`ProjectType`, `ProjectCheckpoint:51-72`), `packages/workspace/src/postgres-store.ts` (project columns, migration registry `:741-790`), `apps/agent-api/src/project-service.ts`, `apps/agent-api/src/project-workspace.ts` | none | new migration(s) applied forward-only; a code project can be created, listed and archived through the existing Project API; no `code.*` tool is callable yet |
| **C1c** Tamper-evident audit log | append-only AuditLog with hash chain, fail-closed | existing audit storage (see section 9) + `packages/workspace/src/postgres-store.ts` migration slot | C1 | privileged action without an audit row fails; chain verifier green; `UPDATE`/`DELETE` on the log denied at the DB level |
| **C1a** Feature flags, staged rollout, versioning | flags without deploy, rollback by flag, versioned `code.*` schemas, session manifest | build on `workspace_user_settings` (`packages/workspace/src/migration-004.ts:2-13`, revision + optimistic concurrency `postgres-store.ts:812-822`, retry loop `ai-preferences.ts:132-151`); add the version columns that do not exist today (capability `version` is declared but never read — `packages/shared/src/capabilities.ts:41`; tool-call audit has no version — `migration-007.ts:56-74`, `migration-029.ts:10-15`) | C1c (flag changes are privileged and audited) | disabled flag blocks session/run/tools/approvals while History/Activity/Changes/Export/Delete stay read-only; kill switch propagates in ≤30 s (`PLAN.md:116`); global/company scope + shared cache + change audit exist |
| **C1b** Sandbox image supply chain | digest-pinned images, SBOM, scan, signature, admission | `apps/agent-api/Dockerfile.project-sandbox`, `apps/agent-api/Dockerfile.sandbox-egress`, `.github/workflows/ci.yml:43-44` | C1a (admission is flag-gated) | sandbox refuses to start an image that is not admitted by digest; SBOM + scan report stored per image version |
| **C2** Read & search tools | read/grep/glob with limits | `project.files.list/read/search` already exist (`packages/shared/src/project-file-capabilities.ts:4`) on top of `apps/agent-api/src/project-workspace.ts` | C1a | reads are range-bounded, binary-aware, secret-scrubbed; a repo map exists; `code.*` read/search are new ids only where the semantics differ |
| **C3** Edit, patch, checkpoints | `edit` + `apply_patch`, checkpoints, diff | `project.files.edit/write` + `expectedRevision` (`project-file-capabilities.ts:20`), `apps/agent-api/src/project-file-lock.ts`, `project.git.checkpoint`/`restore_checkpoint` + `ProjectCheckpoint` (`packages/workspace/src/types.ts:51-72`) | C2 | edits are revision-checked, atomic, and revertible; `pre_run` checkpoint before every code run; no full-file rewrite for existing files |
| **C4** Shell, processes, verification | command execution with policy, processes, test/build runs | `project.terminal.exec/process` (`project-terminal-capabilities.ts:4`) + `apps/agent-api/src/project-sandbox-service.ts` + command policy | C1b, C3 | commands run only in the sandbox through the runner, output is bounded and redacted, install/build timeouts honoured (`PLAN.md:110`); `SecretLease` is the only way a secret reaches a command |
| **C4a** Supply-chain security | install policy, lockfiles, audits, secret scanning | sandbox images (package managers inside) + the C4 execution path | C4 | `install` runs without lifecycle scripts by default, restores from lockfile, network limited to allowlisted registries; dependency + secret scan results recorded |
| **C4b** Egress enforcement | proxy/firewall with post-DNS and redirect checks | current host allowlist + egress image (details in section 7) | C4 | egress is denied by default; allowlist applies after DNS resolution and on every redirect; DNS-rebinding and SSRF tests in the security suite |
| **SG-1** | security checkpoint | — | C4, C4a, C4b, C1b | sandbox escape, secret leak, path traversal, egress-bypass suites green and blocking |
| **C5** Permission modes & policy engine | plan / ask / auto-edit / full-auto, policy engine | approval plumbing in `apps/agent-api/src/company-runtime.ts:820-845,915` and `company-tool-runtime.ts:173,389` | SG-1 | mode is part of the run's execution snapshot; a mode can never be raised by tool output or model text |
| **C5a** RBAC & production approvals | roles, production permission, two-person approval, protected-branch hard deny | permission vocabulary (`admin:all`, `business:manage`, `tools:execute`, `workspace:read|write`) + approval repository + `project.git.push/pr` precedent (`project-git-capabilities.ts:236-290`) | SG-1 | effective rights = agent capability groups ∩ user role ∩ project policy; the agent can never approve its own action; force push and protected-branch writes are denied for everyone |
| **SG-2** | security checkpoint | — | C5, C5a | approval-bypass and RBAC-escalation suites green and blocking |
| **C5b** Provider data policy | classification, redaction, routing by policy | the single model-request chokepoint (section 5) | SG-2 | no request reaches a provider without passing the guard; fallback and subagents cannot bypass it |
| **C6** Agent loop (`CodingAgentRunner`) | model → tools → results → repeat, state persisted | the existing chat/tool loop and `CompanyToolRuntime`; **interface only** for `ExecutionSnapshotProvider` with `NullSnapshotProvider` (`PLAN.md:34`) | C5b | loop is resumable, bounded by `PLAN.md:106-118` limits, emits Activity events per step, cancels cleanly |
| **C6a** Recovery, cleanup, rollback | reconciler, reaper, rollback, safe DB migrations | existing run recovery (DB lease + heartbeat + `max_attempts(3)` + Redis `XAUTOCLAIM` + 30 s tick — `postgres-store.ts:1629-1665`, `company-run-queue.ts:113-130`), sandbox lifecycle (`project-sandbox-service.ts`, `docker-sandbox-provider.ts:155`), and the Data Studio migration engine (advisory lock + `expires_at` lock + checksum + reversible/destructive + snapshot-before-destructive — `data-studio/migration-engine.ts:73-155`) to be reused for **Core DB** migrations, which today have no lock, no checksum and no down path (`postgres-store.ts:99-791`) | C6 | crashed runs are reconciled; sandboxes are reaped; a failed change can be rolled back to a checkpoint; DB migrations follow expand/contract with a snapshot and a lock |
| **C6b** Execution snapshot | immutable per-run snapshot | real provider implementation behind the C6 interface | C6a | every run and every Activity event references a snapshot; replay is deterministic with recorded providers/tool results only |
| **SG-3** | security checkpoint | — | C5b, C6, C6a, C6b | prompt-injection-from-repo, infinite-loop and budget-exhaustion suites green and blocking |
| **C7** Code Workspace UI | chat stream, diff, terminal, approvals | `apps/web/src/App.tsx` routing + `Workspace` shell, existing project/terminal/preview UI components, `styles.css` | SG-3 | feature complete: a user can run a code task end to end from chat and the workspace UI |
| **G1** Security Gate Phase 1 | red-team suite as a hard gate | `.github/workflows/ci.yml` (needs push/PR triggers, section 2.1) | C7 | the gate job is required; flags cannot leave internal without it |
| **R1** Rollout readiness | limits, queues, quotas, observability, SLO, retention, export/delete | existing budgets/rate limits, volumes/backups, retention classes from C1 | G1 | limits + alerts + retention + export/delete verified; production-ready sign-off |
| **C8–C11** | context management, planning/verification, sessions/background, git/PR | `project-task-graph.ts`, `project-multi-agent.ts`, `project-git-service.ts`, `project-browser-qa-service.ts` | Phase 1 complete | as in the plan |
| **C12–C15** | subagents, extensions, evals, local mode | `project-multi-agent.ts`, skills/MCP surfaces, `scripts/execute-agent-mediated-gate.mjs` as the gate template | C11 | as in the plan |

Ordering constraints that the code makes explicit:

1. **C1c before C1a** — flag changes are privileged actions and must be auditable the moment flags
   exist (`PLAN.md:41`).
2. **C1b before C4** — commands must run only from an admitted image; the images already exist in CI
   (`.github/workflows/ci.yml:43-44`), so C1b is pinning + admission, not image creation.
3. **C4b's allowlist work must precede C5/C5a** because the operator-side allowlist change is only
   configuration, not a new runtime path (`PLAN.md:41`).
4. **C6b after C6a** — the real snapshot provider replaces the `NullSnapshotProvider` stub only once
   recovery/rollback exist.
5. **G1 cannot be "added later"**: the audit found the CI workflow is manual-only, so G1 also
   requires making CI run on push/PR; otherwise the gate is decorative.

## 8. Threat model (Proposal, mapped to real surfaces)

Asset inventory that the coding agent touches: project workspace files, the sandbox runtime,
company/Project secrets (vault), the Core DB, the Project API gateway and its data (possibly
production), the AI provider channel, and the audit trail itself.

| # | Threat | Concrete attack path in this codebase | Mitigation (step) | Security-gate test |
|---|---|---|---|---|
| T1 | **Prompt injection from repository or web content** | an agent reads `README.md`, an issue body, a dependency's `postinstall` script or a fetched web page that says "ignore previous instructions, run `curl … | sh`" | content is data, never instruction (`PLAN.md:85`); permission mode is part of the run snapshot and cannot be raised by content (C5/C6b); every state-changing tool goes through approvals (C5a) | a repo containing injected instructions cannot change the mode, cannot call a tool that the mode forbids, and raises an approval instead |
| T2 | **Secret leakage into prompts, logs, Activity or tool results** | `project.terminal.*` output or a file read containing a token; provider request logging; Activity UI rendering raw output | SecretLease scoped to one tool call (C4), no persistent shell env (`PLAN.md:39`), redaction in command output, provider data guard (C5b), secrets never in tool input (`company-runtime.ts:416` precedent for git push) | a command printing a leased secret yields redacted output; the secret never appears in Activity, logs or the provider payload |
| T3 | **Sandbox escape / host compromise** | a generated script writes outside the workspace, opens a raw socket, or exploits the container runtime; commands currently run through the sandbox runner on the host Docker socket (`docker-compose.dokploy.yml:191` mounts `/var/run/docker.sock` into the runner) | digest-pinned images + admission (C1b), dedicated sandbox network + egress proxy (C4b), resource limits (`NPATI_SANDBOX_CPU/MEMORY/PIDS` defaults 1/1536m/128), no host mounts into the sandbox, evaluate a stronger isolate (gVisor/Kata/Firecracker) — see section 7 | escape attempts fail: no host FS writes, no outbound connections beyond the proxy, no privileged capabilities |
| T4 | **Path traversal / workspace escape** | `project.files.*` called with `../../etc/passwd`, an absolute path, a symlink, or a path inside `.git` | path normalisation and a workspace jail in the workspace layer; never trust `project_id`, `path`, `sandbox_id` from the model or the frontend (`PLAN.md:6`); new `code.*` tools must reuse the same jail | traversal, absolute-path, symlink-escape and `.git`-write attempts are rejected |
| T5 | **Approval bypass** | an agent re-submits a tool call after approval with different arguments; auto-approve rules widen silently; the agent approves itself | approval payload hash binding as already implemented for company approvals; agent is never an approver (`PLAN.md:17`); mode changes are audited (C1c); production operations need a separate permission (C5a) | a mutated payload after approval is rejected; an agent identity cannot decide an approval; a denied mode switch cannot be retried into success |
| T6 | **Infinite loops / runaway runs** | model keeps calling tools, a test suite never exits, a background process holds the session | plan limits: 40 steps, 30 min run, 120 s command timeout (600 s install), no progress for 300 s → abort, reaper every 60 s (`PLAN.md:106-120`); recovery/reconcile in C6a | a looping agent is stopped at the step/time/no-progress bound and the run is marked accordingly |
| T7 | **Budget exhaustion / model abuse** | an agent runs dozens of parallel subagents or long-context calls; fallback silently switches to an expensive model | per-run step/time limits, ≤8 parallel read-only calls and ≤4 subagents depth 1 (`PLAN.md:111,115`), budgets enforced at the existing routing/budget layer (section 5), fallback must respect the same policy (C5b) | exceeding the budget stops the run; fallback cannot escalate cost or bypass the provider policy |
| T8 | **Supply-chain compromise** | a new dependency's install script exfiltrates secrets; a typosquatted package; a mutable base image | install without lifecycle scripts, lockfile-only, allowlisted registries, minimum package age 7 days (C4a), digest-pinned images with SBOM/scan/signature (C1b) | installs with network disabled during build; unpinned base image is refused; scan blocks a known-malicious package |
| T9 | **Tenant isolation break** | a crafted `project_id`/`company_id` from the model or a URL reads another company's files, DB or session | the existing chain user → company → project → workspace → session → sandbox is enforced server-side on every call; new code sessions must carry company/project scope and reuse the existing authorisation helpers (`PLAN.md:6`) | cross-company reads/writes fail for files, sessions, runs and approvals |
| T10 | **Audit tampering / silent privileged action** | an actor deletes audit rows or performs a privileged action while the audit write fails | append-only AuditLog with hash chain and `fail closed` (`PLAN.md:99`), DB-level denial of `UPDATE`/`DELETE`, anchor outside the Core DB (C1c) | the chain verifier detects tampering; a privileged action with a broken audit writer is refused |
| T11 | **Production data exposure through the model channel** | a coding task pastes production rows or `.env` values into a prompt sent to a third-party provider | provider data policy + classification/redaction before the request leaves NPATI (C5b); production credentials are never issued to the agent (`PLAN.md:98`) | a classified payload never reaches a provider that the policy forbids; production secrets are absent from every recorded prompt |
| T12 | **Untrusted tool output executed as code** | the agent copies a snippet from a fetched page or a package README and runs it | C4b egress restrictions, automatic scanning of executed commands against the policy, approvals for high-risk actions (C5a) | executing an injected snippet triggers policy/approval rather than run |

Threats T1, T2, T4, T5, T6 and T9 must have their first regression tests in the step that introduces
the corresponding surface (C1c/C2/C3/C4/C5/C6), not at G1 — the plan already requires this
(`PLAN.md:12-19`, rule 12 of the shared block).

Two additional threats found by the runtime/capability audits and not covered by the plan text:

| # | Threat | Concrete path in this codebase | Mitigation (step) | Security-gate test |
|---|---|---|---|---|
| T13 | **Run outcome is misrecorded** (cancel or failure presented as success, or as a fake provider error) | a cancelled company run writes a synthetic assistant message ("model temporarily unavailable") into conversation history, so a cancelled coding run could be mistaken for a completed one; the non-stream `/chat` path cannot be cancelled at all because it never passes an `AbortSignal` | C6 records `cancelled` plus a checkpoint and never an error string; both defects are fixed as part of the runner contract (`app.ts:3475-3488`, `app.ts:500-507`, `app.ts:3126-3131`) | a cancelled run leaves a `cancelled` record with a resumable checkpoint, no assistant success text, and no partial success marker |
| T14 | **Over-broad standing grants** | automation runs execute with a fixed synthetic permission set (`workspace:read/write`, `business:manage`, `tools:execute`, `automation:execute_browser`) instead of the current user's role, so a scheduled task could run shell/git operations the user may no longer be allowed to run | C5a recomputes effective rights per run from current role + project policy; automation grants must not include `code.*` execution rights by default (`app.ts:1074-1079`) | an automation attempting a `code.*` action without an explicit grant is denied and audited |

**Confirmation-visibility and self-approval risk (T5 detail).** The audit of the approval path found
three properties that make an approval weaker than it looks for file-changing tools: the payload for
non-terminal tools is the raw tool input with **no size limit**, the approver's UI masks `content`,
`find` and `replacement` to `[REDACTED]` (`company-runtime.ts:77-83`,
`apps/web/src/CompanyPage.tsx:1033-1041`), and only the requester can approve because every read and
decision filters `user_id = ctx.userId` (`approvals-repository.ts:57,73,131,146`) with no two-person
or step-up mechanism anywhere in the repository. C5 must therefore render an explicit, bounded diff
in the approval payload (not the raw input), and C5a must define who may approve when the requester
is the only user.

**Confirmed limits the security suite must assert (from the runtime audit):** chat tool loop 8 steps
(cap 16) and 40 000-char tool output; company plan ≤10 executed tools and >20 requests →
`TOOL_LOOP_DETECTED`; multi-agent pipeline 40 model calls (cap 100); terminal 120 s / install-build
600 s with 64 KiB output (cap 128 KiB); sandbox sync 20 MB / 500 files; Code-Mode WASM ≤64 KiB and
≤5 s; admission 20 concurrent / 10 per tenant / 200 queued; queue concurrency 2 with per-tenant 10
(`chat-tool-orchestrator.ts:113-132`, `company-runtime.ts:515-517,722`, `project-multi-agent.ts:25-28`,
`project-sandbox-service.ts:19,48-50`, `wasm-exec-sandbox.ts:11-13`, `app.ts:1203`,
`company-run-queue.ts:70-73`).

**Latent surfaces recorded by the audit:** an MCP server implementation exists but is mounted on no
route (only its own test imports it), while the MCP client is one generic `mcp` tool guarded by a
hardcoded allowlist (`company-tool-runtime.ts:40-53`); MCP server definitions are stored in
`company_mcp_servers` but their tools are not registered in the capability registry. Whatever C13
does with MCP must first decide whether that surface is exposed or removed, because an unregistered
tool path is exactly what rule 4 ("no hidden tools") forbids. Two more latent gaps worth recording:
`GET /capabilities` has no authentication at all (`app.ts:2762`), and Skills
(`/settings/skills`) is a read-only prompt extension whose `requiredTools`/`forbiddenTools` metadata
is never enforced, so it cannot serve as an extension mechanism for the coding agent.

## 15. C0 acceptance self-check

| Acceptance criterion (`PLAN.md:220-223`) | Where satisfied |
|---|---|
| Only `docs/coding-agent/00-audit.md` changed (git status) | section 14 (final report); the temporary `research/` artifact produced by one research stream was folded into section 12 and removed |
| Every statement carries a file reference | sections 2.x, 13 and 14 use `path:line`; section 12 uses `URL + date` for external claims and is explicitly marked as an engineering reference |
| Explicit recommendations for the agent-loop location, Website Builder reuse, and the edit format per model profile | agent loop → section 5; Website Builder reuse → sections 2.3, 2.4 and 13; edit format per model profile → section 6 |

## 3. Model capability matrix (topic 2, 22)

**Structural fact:** NPATI has no provider adapters of its own. One HTTP client
(`packages/omniroute-adapter/src/omniroute-engine.ts:150` `OmniRouteEngine implements AIEngine`)
talks to the OmniRoute gateway, which owns 352 provider entries
(`packages/omniroute-adapter/src/generated/provider-catalog.json`, `sourceVersion v3.8.50`) and
performs Anthropic/Gemini/OpenAI translation internally
(`vendor/omniroute/open-sse/translator/`). NPATI has **no table of its own for providers or keys** —
keys live in the gateway DB (`packages/omniroute-adapter/src/marketplace-client.ts:393-402` →
`vendor/omniroute/src/lib/db/core.ts:239`, AES-256-GCM in
`vendor/omniroute/src/lib/db/encryption.ts:30`).

| Capability | State in NPATI | Evidence |
|---|---|---|
| Native tool calling (request) | sent as `tools` + `tool_choice` (default `auto`) on the chat-completions and Responses paths | `omniroute-engine.ts:214`, `:220` |
| Native tool calling (declared support) | **unconditional `true` for every model** — `supportsNativeTools() { return true; }` ignores its `model` argument, so `app.ts:1839` always takes the native branch and the prompt-compatible fallback (`app.ts:1948`, `:2378`) is reachable only via an exception | `omniroute-engine.ts:182`, `apps/agent-api/src/app.ts:1839` |
| Parallel tool calls | **hard-disabled**: `parallel_tool_calls: false` written literally in both request bodies; the loop also executes returned calls sequentially | `omniroute-engine.ts:214`, `:220`, `apps/agent-api/src/chat-tool-orchestrator.ts:196-216` |
| Streamed tool arguments | **not supported**: the stream body sends no `tools` at all and the delta parser reads only text (`choices[0].delta.content` / `output_text.delta`) — `delta.tool_calls` is never read | `omniroute-engine.ts:287-289`, `:325-328` |
| JSON mode / structured output | **absent for chat**: no `response_format`/`json_schema` anywhere; structure is prompt + regex | `not found (grep "response_format\|json_schema\|json_object")` except audio/TTS (`omniroute-engine.ts:373`, `:404`); prompt-regex at `packages/agent/src/index.ts:282-287`, `apps/agent-api/src/chat-task-plan.ts:18-21` |
| `strict` tool schemas | declared in the type but never set | `packages/omniroute-adapter/src/types.ts:13` |
| Context window | three inconsistent hardcoded sources + one accurate source that is not read: `routing-strategies.ts:59-114`, `context-compression-presets-and-budget.ts:83-102` (substring heuristics), `cost-telemetry.ts:15-23`, and `listModels()` which **ignores** `context_length` | `omniroute-engine.ts:576-589`; accurate field exists in `normalization.ts:300` |
| Max output tokens | only from the manifest summary; never sent to the model (no `max_tokens` in any request body) | `types.ts:337`, `normalization.ts:301`, `not found (grep "max_tokens")` in request bodies |
| Prompt caching | **not used**: no `cache_control`, a `supportsPromptCaching` flag exists only inside a local scorer, while `cached_tokens`/`cacheHit` are already read back | `routing-strategies.ts:32,59-114,202-226`; read-back `omniroute-engine.ts:95,101,267` |
| Reasoning content | **not supported end to end**: zero `reasoning_content` references in `apps/`+`packages/`, and `ChatMessage` has no field for it | `types.ts:23-29`, parser `omniroute-engine.ts:249-257`; capability flag only in `normalization.ts:160` |
| Fallback / routing | three layers: inside the adapter (candidate list + retryable-status loop), a self-healing proxy, a circuit breaker; `auto*` is expanded by the adapter into every chat-capable model | `omniroute-engine.ts:184-198,204,239-241`; `apps/agent-api/src/production-resilient-ai-engine.ts:77-192`; `apps/agent-api/src/resilience-circuit-breaker.ts` |
| Budget enforcement | **stored but never enforced**: `monthlyBudgetUsd` (default 20), `warningPercent`, `stopPaidWhenLimitReached` are saved and shown in the UI; the gateway-side push (`configureRuntimePolicy`) and the local `checkBudgetQuota` have no production caller | `apps/agent-api/src/ai-preferences.ts:33-44`, `packages/omniroute-adapter/src/marketplace-client.ts:264-299` (uncalled), `apps/agent-api/src/cost-telemetry.ts:56-63` (test-only) |

**Consequences for the Coding Agent:**

1. A multi-step tool loop works today (it exists, see section 5) but **only non-streamed**, because
   streaming cannot carry tools. Streaming agent UX (C7) therefore requires adapter work first
   (`omniroute-engine.ts:287-289`, `:325-328`) — this is a C6 dependency, not a C7 detail.
2. `supportsNativeTools()` must become capability-driven (per-model), otherwise a model without
   reliable tool calling will never degrade to the prompt-compatible path that already exists.
   **This is exactly the gap the planned `ToolCallAdapter` (section 6) has to close.**
3. Parallel tool calls are a code-level constant; enabling them for profiles that support them is a
   separate, testable change (`omniroute-engine.ts:214`, `:220`).
4. Model metadata must be consolidated before profiles can be declared: extend `ModelInfo`
   (`types.ts:185-195`) with `contextLength`, `maxOutputTokens`, `toolCalling`, `structuredOutput`,
   `promptCaching`, `reasoning`; read them in `listModels()`
   (`omniroute-engine.ts:576-589`); extend `AIModelSummary` (`types.ts:325-338`) and
   `normalizeModels()` (`normalization.ts:276-305`); fix the name mismatch
   (`normalization.ts:162` expects `toolCalling` while the gateway serves `capabilities.tool_calling`).
   A generated matrix file next to `generated/provider-catalog.json` is the natural home.
5. Budget enforcement is a prerequisite for R1 and for the C5b guard: today a runaway coding run
   would be visible in telemetry but not stopped.

## 5. Proposed `CodingAgentRunner` architecture (topics 1, 6, 7, 9)

### 5.1 What the runtime actually does today (confirmed, and different from the plan's assumption)

| Path | Mechanism | Limits | Evidence |
|---|---|---|---|
| **Chat with native tools** | the *only* genuine `model → tool → result → model` loop: `runChatToolLoop` | `maxSteps` default **8**, hard cap **16**; tool output truncated at **40 000** chars; completion reminders ≤2; errors expose `TOOL_LOOP_LIMIT` / `TOOL_PRIMARY_INCOMPLETE` | `apps/agent-api/src/chat-tool-orchestrator.ts:118-225` (`:132` steps, `:113-116` truncation, `:181-193` reminders, `:224` limit) |
| Chat tool surface | **only 4 tools** visible to the model: `npati_company_action`, `web_search`, `web_fetch` + `BUSINESS_PROFILE_TOOL` | hardcoded list, filtered by permission | `chat-tool-orchestrator.ts:16-71`, `app.ts:1475`, used at `app.ts:1916`, `:2337` |
| **Company run** | **plan-then-execute, not a loop**: one planning call must return `{mode, agentIds, toolRequests[]}`; all requested tools are then executed; one final answer call consumes the concatenated evidence | ≤10 tools per run (`plans.slice(startIndex, 10)`), >20 tool requests → `TOOL_LOOP_DETECTED`; `MAX_CANDIDATES 60`, `MAX_SELECTED 12` | `apps/agent-api/src/company-runtime.ts:392-430`, `:537`, `:722`, `:515-517`, `:559-565`, `:944` |
| Company delegation (worker) | Redis Stream queue + Postgres claim/lease + heartbeat + `XAUTOCLAIM` + recovery + retry backoff + **approval resume from `nextToolIndex`** | concurrency 2 (≤32), lease 180 s, per-tenant 10, recovery tick 30 s | `apps/agent-api/src/company-run-queue.ts:5-7,71-73,125-130,151-186,195-219`, `company-runtime.ts:272,460,537` |
| Multi-agent project pipeline | **closest existing coding-agent prototype**: task DAG (parallelism 3) with design/frontend/SEO/QA/security roles, git worktrees (`createAgentWorktree`/`mergeAgentWorktree`) with conflict escalation, a 2-iteration build→preview→browser-QA→repair loop, and a model-call budget | `NPATI_PROJECT_MAX_MODEL_CALLS` default **40**, cap **100**; worktree mode `NPATI_PROJECT_WORKTREE_MODE=true` | `apps/agent-api/src/project-multi-agent.ts:25-28,55,159-214,360` |
| Code Mode (`exec` tool) | QuickJS/WASM sandbox, **not** for repository work: no FS, no network, ≤64 KiB code, ≤5 s | — | `apps/agent-api/src/wasm-exec-sandbox.ts:11-13,21-22,80,87` |
| Tool dispatch | centralised `CompanyToolRuntime`: files, terminal, git, preview, deploy, QA, data, `exec`, knowledge, MCP | per-tool permission checks + capability resolver | `apps/agent-api/src/company-tool-runtime.ts:103-233,250-334`, `company-runtime.ts:754-766` |
| Revision-safe writes | already implemented: `expectedRevision` + base-content sha256 + `mergeProjectText` + 3 retries on `revision_conflict` + escalation on overlapping changes | 3 attempts | `company-tool-runtime.ts:282-320`, `apps/agent-api/src/project-file-lock.ts` |

**The gap that C6 must close:** the product has *no* general iterative coding loop. The chat loop is
capped at 8/16 steps and sees 4 tools; the company runtime deliberately executes a single plan. So
`CodingAgentRunner` is not "another loop in the same shape" — it is the first iterative tool loop with
full tool access, and it must be introduced without breaking the plan-then-execute guarantees of
company runs (approvals, evidence, cost accounting).

### 5.2 Where the runner lives (Proposal)

1. **New module** `apps/agent-api/src/coding-agent-runner.ts`, sibling to `chat-tool-orchestrator.ts`
   and `company-runtime.ts`, reusing their building blocks rather than replacing them:
   - tool dispatch: `CompanyToolRuntime.execute(...)` (already handles every `project.*` tool);
   - run lifecycle: `company_agent_runs` / `_steps` / `_tool_audit` / `run_events`, Redis lease +
     heartbeat + recovery, cancel/resume routes (`company-runtime-routes.ts:47-120`);
   - approvals: the existing durable approval path (`company-runtime.ts:782-894`);
   - capability checks: `effective-capabilities.ts` deny-wins resolver as used at
     `company-runtime.ts:754-766`;
   - model access: the single guarded engine (section 3, section 9);
   - persistence of steps: a **new versioned session/step store** (see 5.3) because the existing
     tables cannot hold tool calls.
2. **Entry points (Proposal):** a new intent (`CODE_TASK`) routed like the existing project intents
   (`packages/shared/src/project-intent.ts:1-18,66-93,118-344`; execution branches
   `apps/agent-api/src/app.ts:3390-3441` stream, `:3023-3090` non-stream), plus a direct
   `code.*` capability call from a Company agent. Company runs keep working exactly as today; the
   runner is entered deliberately (flag-gated, C1a).
3. **State = versioned event log, resumable.** Steps append
   `{step_index, tool_call_id, tool_name, tool_schema_version, arguments_hash, result_summary,
   result_ref, status, checkpoint_ref, snapshot_id}`. This is new schema (C1) — the audit proves the
   current `messages` table cannot be extended in place without a migration, since it has never been
   altered and holds only flat text (`packages/workspace/migrations/001_business_workspace.sql:46-49`,
   `packages/workspace/src/types.ts:273-274`).
4. **Long-run hosting:** reuse the worker queue rather than a new scheduler
   (`company-run-queue.ts`), because it already provides lease, heartbeat, `XAUTOCLAIM`, recovery,
   per-tenant concurrency, retry backoff and idempotency keys.
5. **Parallel read-only tools** are a runner-level feature (plan default ≤8, `PLAN.md:111`); today
   the chat loop executes tools strictly sequentially (`chat-tool-orchestrator.ts:196-216`) and the
   engine forbids parallel calls (`parallel_tool_calls: false`, section 3), so parallelism is
   implemented by the runner, not by the model.
6. **Cancellation must be corrected first.** Two defects found in the audit affect code runs directly:
   the non-stream `/chat` path never passes an `AbortSignal` (`app.ts:3126-3131`), and a cancelled
   company run writes a synthetic assistant reply ("model temporarily unavailable") into history
   (`app.ts:3475-3488` + `app.ts:500-507`). A cancelled coding run must be recorded as *cancelled with
   a checkpoint*, never as an error message or a partial success.
7. **Automations carry broader rights than the invoking user.** Automation runs are executed with a
   synthetic `AuthContext` whose permissions are fixed at `workspace:read/write`,
   `business:manage`, `tools:execute`, `automation:execute_browser` (`app.ts:1075-1079`). For a coding
   agent that can run shell commands and push git, C5/C5a must compute rights from the *current* user
   role plus the project policy, not from a fixed automation grant.

### 5.3 Integration with Company agents (Proposal)

- The runner is invoked **by** a Company agent (Main Agent or a specialist) and executes in that
  agent's capability context; effective rights stay `agent groups ∩ user role ∩ project policy`.
- Delegation: reuse the existing hierarchy and edges; a coding subagent is a normal agent with the
  `code.*` group (C12 extends `project-multi-agent.ts` rather than writing a second orchestrator).
- Two-agent safety property for approvals: the **planner/executor is never the approver**, and the
  approver identity must be a real user (C5a).
- Every step writes an Activity event referencing the execution snapshot (C6b), so a code run is
  auditable and replayable from recorded tool results (deterministic only with recorded providers,
  `PLAN.md:34`).

## 6. `ToolCallAdapter` proposal (topics 2, 14)

Problem it solves: tool calling today is declared globally
(`supportsNativeTools() → true`, `omniroute-engine.ts:182`), so a model with weak or absent native
tool calling still receives `tools` and can silently produce prose instead of calls. The adapter must
make the *mechanism* a per-model profile decision, with no model names in the loop code
(`PLAN.md:82`, rule 7).

Design (config-driven, one file of profiles):

| Profile | When | Mechanism | Edit format |
|---|---|---|---|
| `native` | gateway metadata says `tool_calling: true` (after section 3's metadata consolidation) | send `tools` + `tool_choice`; parse `tool_calls`; sequential execution | `edit`/`apply_patch` tool calls (preferred, `PLAN.md:81`) |
| `native-no-parallel` | model supports tools but not parallel calls | same as `native`, one call per step (today's behaviour; the safe default) | `edit`/`apply_patch` |
| `prompt-json` | model lacks reliable native tools (`tool_calling` unknown/false, local models) | the existing prompt-compatible path (`app.ts:1948`, `:2378`): tool catalogue in the system prompt, strict-JSON reply parsed by the existing regex extractor (`packages/agent/src/index.ts:282-287`), validation before execution, one retry on parse failure | for editing prefer a whole-file `create`/`write`, or fenced search/replace blocks when the model is known to be reliable; never rely on line numbers alone |
| `prompt-text` | smallest local models | XML-ish command blocks with mandatory echo-back of the touched region; every edit is verified by re-reading the region and comparing hashes | whole-file rewrite only for new files; otherwise explicit search/replace with a mandatory unique match (reuse `SecureFileToolsEngine.replaceChunk` semantics as a *pattern*, not the stub itself) |

Rules the adapter must enforce (all testable in the security-gate suite):

1. A profile is selected from gateway/capability metadata **plus** project configuration — never from
   a hardcoded model name; a missing capability is a `deny`-by-default decision, not `assume native`.
2. Tool arguments are schema-validated before execution; a validation failure is a structured,
   retryable error whose retry budget is bounded (`PLAN.md:112`: 2 repair attempts).
3. Reasoning content, when the model produces it, is stored as part of the step event only if the
   provider policy allows it; it is never treated as an instruction (threat T1).
4. Streaming tool arguments are only attempted when the model profile declares support **and** the
   adapter implements it (currently `no`, section 3).
5. The adapter emits one Activity event per tool call with a versioned payload (`tool_schema_version`),
   which is what keeps old sessions replayable (C1a/C6b).
6. Prompt-injection hardening is centralised here: tool output is fenced and labelled as data, never
   concatenated into the instruction section of the prompt.

## 9. RBAC, approvals, audit and secrets (topics 5, 18, 24)

### 9.1 Capability mechanics and what `code.*` must plug into (topic 4/7)

| Fact | Evidence |
|---|---|
| A capability is one record with `id, inventoryIds[], type, domain, name, description, useWhen[], doNotUseWhen[], agentCallable, userVisible, risk, requiresConfirmation, requiredConnections[], requiredPermissions[], inputSchema?, outputSchema?, version` | `packages/shared/src/capabilities.ts:23-42` |
| `agentCallable` is valid only for `type: "tool"`; the coverage validator only walks inventory ids 1..306, so pushed groups (`project.*` today, `code.*` tomorrow) escape it | `capabilities.ts:124-127`, `:157-166` |
| The catalog is a 306-entry generated literal plus two `push(...)` sites (catalog and matrix) | `packages/shared/src/capability-catalog.ts:4,7244-7263`, `capability-matrix.ts:15,4824-4843` |
| Next free inventory id is **349**; the current counters are 348 total / 84 agent-callable | `packages/shared/src/project-data-capabilities.ts:391`, `tests/capability-registry.test.ts:41,66,110-111` |
| `requiresConfirmation` is **not enforced** anywhere: the server decides approval from a regex over the tool name (`classifyRisk`) plus a project-file override, and the Inspector counts "requires approval" purely from `risk` | `packages/shared/src/risk-approval.ts:43-76`, `apps/agent-api/src/company-runtime.ts:818`, `packages/shared/src/capability-inspector.ts:162` |
| The registry is metadata, not a dispatcher: nothing maps `CapabilityDefinition` → model tool definition, and `HybridRouter` candidates never reach the model (its only caller is the diagnostic route) | `capabilities.ts:63-78`, `apps/agent-api/src/app.ts:1475,2796`, `packages/shared/src/hybrid-router.ts:209` |
| Effective rights come from one deny-wins resolver (platform → plan tier → tenant permissions → context boundary → company override → agent allowlist → skill → connections), applied per tool | `packages/shared/src/effective-capabilities.ts:113-312`, `company-runtime.ts:754-766` |
| Agent tool grants live in `company_agents.tools_json`; group-style grants work through `isDataCapabilityPermitted` (wildcards, group names), other groups match ids literally | `packages/workspace/src/migration-006.ts:49`, `packages/shared/src/project-data-capabilities.ts:33-45`, `company-tool-runtime.ts:456-461` |
| **The agent tool picker in the UI will not show `code.*`**: it fetches `/capabilities?callable=true` but maps the result onto a hardcoded `defaultToolOptions` list | `apps/web/src/CompanyPage.tsx:48-62,286-299` |
| Counter tests that a new group must update (all found): capability-registry, control-plane-ui-and-revisions, developer-capability-inspector, full-capability-regression, invariants-and-anti-patterns, manual-product-e2e-web, phase13/phase14, production-acceptance, upgrade-compatibility-and-release-gate | those files (line references in section 2.2) |

### 9.2 Approvals (topic 5)

| Fact | Evidence |
|---|---|
| Durable store `company_approvals` with `status pending/approved/rejected/expired`, `input_payload jsonb`, `responded_by`, plus migration 028 adding `payload_hash`, `expires_at`, `consumed_at` and a partial index | `packages/workspace/src/migration-016.ts:2-21`, `migration-028.ts:5-12` |
| TTL default 15 min (clamped 1 s … 24 h); expiry is evaluated lazily in `decide` and in `consumeApproved`, with no background expiry job | `apps/agent-api/src/approvals-repository.ts:84,117-120,145` |
| Payload binding is cryptographically sound: canonical-JSON SHA-256 hash, computed at request time and re-verified at consume time together with `run_id`, `agent_id`, `tool_name`, `status='approved'`, `consumed_at IS NULL` and `expires_at > now()`, in a single atomic UPDATE | `packages/shared/src/risk-approval.ts:78-97`, `approvals-repository.ts:141-153` |
| **What the payload actually contains differs per tool:** for terminal commands only `{projectId, commandHash, cwd, action, environmentReferenceHash}` (no raw command); for every other tool the raw `plan.input` (so a file edit's `find`/`replacement` and a file write's `content` are stored verbatim) and there is **no size limit on `input_payload`** | `company-runtime.ts:819-827`, `migration-016.ts:12` |
| **The approver cannot see what they approve:** the web UI renders `inputSummary`, which is produced by `summary()` where `content`, `find`, `replacement` and anything matching token/secret/password/key are replaced with `[REDACTED]`; the full payload is only reachable through the GET route | `company-runtime.ts:77-83`, `apps/web/src/CompanyPage.tsx:1033-1041` |
| **Self-approval is the default and there is no two-person/quorum/step-up mechanism:** every read/decision filters `user_id = ctx.userId`, so only the requester can approve, and a second workspace user cannot even see the request | `approvals-repository.ts:57,60,73,131,143,146`; `not found (grep "two_person\|quorum\|step_up\|secondApprover")` |
| Approval is reachable outside the web UI (Telegram/Discord/WhatsApp/Slack/Email slash commands `/approvals`, `/approve`, `/deny`), but that path checks only the stored `connection.permissions` and has no explicit `business:manage` check | `apps/agent-api/src/app.ts:2650-2655`, `messaging-integrations-routes.ts:26,194,215`, `slack-messaging.ts:36,40`, `messaging-commands.ts:14-16` |
| A fallback path exists when the durable repository is unavailable: HMAC tokens in memory with a **hardcoded default secret** and an in-process `consumedTokens` set (does not survive restart, does not work across workers) | `packages/shared/src/risk-approval.ts:32-37,115-131,150-230` |
| Decisions are **not** written to `company_audit_logs`; the tool-audit row links to the approval only through free text (`Approval request ID: …` in `errorMessage`) | `not found (grep "company_approvals" in audit paths)`, `company-runtime.ts:831` |
| Approval gates already exist at three levels: runtime approval (above), a boolean gate in the sandbox service (`approved !== true` → 403), and a deploy-service `approved` flag | `apps/agent-api/src/project-sandbox-service.ts:167-169`, `project-deploy-service.ts` |

### 9.3 RBAC and actors (topic 18)

| Fact | Evidence |
|---|---|
| Permissions are string literals with no union type or central constant: `workspace:read`, `workspace:write`, `business:manage`, `chat:use`, `admin:all`, `audit:read`, `tools:execute`, `tools:read`, `tools:linter`, `research:execute`, `browser:execute`, `files:execute`, `mcp:read/execute`, `agent:exec`, `memory:read/write`, `email:*`, `automation:execute_browser`, `owner`, `*` | `apps/agent-api/src/auth.ts:126-144,172-191,217-249`, capability files |
| Checks are per route via local helpers; there is no global RBAC middleware and `GET /capabilities` has **no authentication at all** | `apps/agent-api/src/approvals-routes.ts:6-10`, `audit-routes.ts:6-10`, `app.ts:2762` |
| Workspace membership exists (`workspace_members.role`, `owner_user_id`) but `role` is never used for authorization; every business query is additionally filtered by `owner_user_id = ctx.userId` | `packages/workspace/migrations/001_business_workspace.sql:5-13`, `postgres-store.ts:829-849,861-873` |
| **Multi-user Company is not supported in practice**: no members/invites API exists; the only role model (`owner|admin|member|viewer`) is in-memory for multi-user chat sessions | `not found (grep "invite\|member" routes)`, `apps/agent-api/src/multi-user-session.ts:1,97-115` |
| Approver identity = the requester (self-only), plus route permission `business:manage` | `approvals-repository.ts:131`, `approvals-routes.ts:81` |
| Automation runs execute from the owner's `userId` but with a **fixed, broader permission set** that ignores the user's current rights | `apps/agent-api/src/app.ts:1074-1079` |

**Consequence for C5a:** the plan's RBAC model (owner/admin/developer/reviewer, separate production
permission, two-person approval) is new work, and the very first prerequisite is that **Company
membership must become real authorization** — otherwise "two-person" and "reviewer" are impossible
to express. Until then, the only honest options are a step-up confirmation for the single owner or an
explicitly documented single-operator mode.

### 9.4 Audit (topic 24) and secrets (topics 22, 24)

| Fact | Evidence |
|---|---|
| Existing audit surfaces are ordinary tables: `company_audit_logs` (no `request_id`, no `prev_hash`/`entry_hash`, no `payload_hash`, no `snapshot_id`), `file_audit`, `storage_reconciliation_audit`, plus the tool-audit and run-event tables | `packages/workspace/src/migration-018.ts:5-20`, `migration-011.ts:22-33`, `migration-013.ts:4-15`, `migration-007.ts:56-74`, `migration-030.ts:2-21` |
| **No append-only enforcement of any kind**: no `REVOKE`, no `CREATE TRIGGER`, no rule blocking `UPDATE`/`DELETE` on audit tables (the only `REVOKE`s in the repo belong to the Data Studio provisioner for project databases) | `not found (grep "REVOKE\|CREATE TRIGGER\|append-only")`; `apps/agent-api/src/data-studio/provisioner.ts:140,148` |
| Immutability is only asserted in application code (a chat action refuses to cancel a finished run); nothing at the DB level | `apps/agent-api/src/workspace-chat-actions.ts:446,684` |
| Natural chain-insertion points: `AuditRepository.log` (single writer for `company_audit_logs`) and `WorkspaceStore.appendCompanyAgentToolAudit` | `apps/agent-api/src/audit-repository.ts:62-97`, `packages/workspace/src/postgres-store.ts:1602-1615` |
| Hashing primitives already exist (`createHash("sha256")` for payload hashes and checksums) and `run-trace.ts` even ships an unused `isEligibleForRetention` helper | `company-runtime.ts:819`, `apps/agent-api/src/company-knowledge-routes.ts:40`, `packages/shared/src/run-trace.ts:311-320` (test-only today) |
| `audit:read` permission exists but the audit route requires only `workspace:read` | `auth.ts:219,248`, `audit-routes.ts:37` |
| Secrets: `CryptoVault` AES-256-GCM with scrypt-derived key, `v1$salt$iv$tag$ciphertext` format, prod fail-closed when `NPATI_ENCRYPTION_KEY` is missing, `rotate()` available but never called | `packages/workspace/src/crypto-vault.ts:1-113` |
| Outside production the vault uses a **constant development key**, and compose ships a default local encryption key | `crypto-vault.ts:7,28`, `docker-compose.yml:40` |
| The sandbox receives secrets as **references**, never values, capped at 20, with a deny list for DB credentials and a download-side leak guard | `apps/agent-api/src/project-sandbox-service.ts:76-90,154` |
| Short-lived scoped credentials already exist in one place: `rat_` remote access tokens with TTL 60 s…24 h (default 1 h), HMAC signature, IP allowlist and fail-closed secret handling | `apps/agent-api/src/security-guardrails-and-tokens.ts:215-309`, `auth.ts:165-205` |
| Redaction layers: `SecurityPolicyEngine` (PII + credentials, per-company policy toggles), `summary()` for tool audit, and terminal policy logging | `apps/agent-api/src/security-guardrails.ts:57-109,144-263`, `company-runtime.ts:77-83`, `terminal-policy-log.ts:10-29` |
| **No secret rotation, no secret-access audit, no secret scanning** were found | `not found (grep "rotate\|secret.scan")` outside `CryptoVault.rotate` |

**Consequence for C1c/C4:** `SecretLease` can be modelled directly on the existing `rat_` token
mechanism (signed, scoped, TTL, revocable), and the audit chain can start at the two existing writer
points — but both need real DB-level guarantees (no `UPDATE`/`DELETE`, plus an anchor outside the
Core DB), which does not exist today.

## 10. Observability, limits and budgets (topic 23)

| What exists | Evidence | Gap for the Coding Agent |
|---|---|---|
| Cost telemetry with per-model pricing and run telemetry headers | `apps/agent-api/src/cost-telemetry.ts:15-40`, `:65-93` | pricing is substring-matched and duplicated (see section 3) |
| Upstream cost/cache/failover signals from the gateway | `omniroute-engine.ts:260-269` (`x-omniroute-cost-usd`, `cache-hit`, `failover-count`) | not persisted per code run; no per-run budget cap |
| Rate-limit snapshot with 80 %/95 % thresholds (in-memory) | `apps/agent-api/src/live-quota-telemetry.ts:26-111` | `setLimits` has no production caller; RPM/TPM are not enforced per company |
| Admission queue with tiers and queue timeout | `apps/agent-api/src/resilience-admission-queue.ts` (tiers `critical-orchestration/enterprise/pro/free`, 30 s queue timeout) | a long coding run must claim a tier and release it on cancel |
| Circuit breaker + resilience status endpoint | `apps/agent-api/src/resilience-circuit-breaker.ts`, `omniroute-engine.ts:779-815`, `apps/agent-api/src/ai-routes.ts:167-173` | code runs must surface the same status in the workspace UI |
| Health/ready endpoints, structured logs | `apps/agent-api/src/server.ts`, pino logging across the API | no tracing of a code run across API → sandbox → model |
| Host resources for sandboxes | compose limits: sandbox `NPATI_SANDBOX_CPU=1`, `MEMORY=1536m`, `PIDS=128`, `DISK_BYTES=1610612736`; runner container `cpus 1.0`, `mem_limit 512m`, `pids_limit 128` | R1 must publish these as documented per-tenant limits |
| Budget settings stored and displayed | `apps/agent-api/src/ai-preferences.ts:33-44`, `apps/web/src/AIProviderMarketplace.tsx:265-321` | **enforcement missing** (section 3) — R1 must close this before any rollout |

R1 therefore has three concrete, verifiable deliverables beyond the plan text: (a) enforce the stored
monthly budget (or explicitly document it as advisory and add a per-run cap instead), (b) turn the
in-memory rate-limit snapshot into an enforced per-company quota, and (c) publish the real sandbox
resource limits per tenant.

Additional platform findings from the same research stream (topics 13, 14, 16, 21, 23):

| Area | Fact | Evidence |
|---|---|---|
| Observability | pino logs with redaction (authorization, api keys, passwords, tokens, IMAP/SMTP secrets); `/health/live` and an aggregate `/health`; **no Prometheus metrics, no tracing, no alerting, no `/ready`** | `apps/agent-api/src/app.ts:707`, `:2710-2745`; `not found (grep "prometheus\|opentelemetry\|sentry")` |
| Rate limiting | only targeted: route-guard tiers on company runtime routes (free 20 / pro 120 / enterprise 1200 rpm), Data Studio gateway per key/IP (120/600 rpm), auth limiters, email send quota, storage upload/download/delete limits — the rest of the API has none | `apps/agent-api/src/route-guard-tiers.ts:17-34,62-107`, `apps/agent-api/src/data-studio/gateway-service.ts:237-246`, `apps/agent-api/src/storage-protection.ts:16-18` |
| Retention | **no TTL anywhere**: MinIO objects (4 buckets), workspace files, `company_agent_run_events`, `company_agent_tool_audit`, `company_audit_logs` all grow forever; the only retention today is Data Studio snapshots (30 days) | `apps/agent-api/src/object-storage.ts:7`, `packages/workspace/src/migration-030.ts:2-18`, `migration-007.ts:56-74`, `migration-018.ts:5-17` |
| Backups | docker volumes are backed up wholesale (`npati-agent-data, omniroute-data, redis-data, postgres-data, postgres-projects-data, postgres-projects-snapshots, crawler-state, minio-data, qdrant-data, browser-use-state`); **secrets are included** — encrypted ciphertexts live in `postgres-data`/`minio-data` and the key in the environment, and there is no exclusion mechanism | `docker-compose.yml:371-390`, `packages/workspace/src/crypto-vault.ts:1-53` |
| Recovery (already good) | run recovery is solid: DB lease + heartbeat + `attempt_count/max_attempts(3)` + Redis `XAUTOCLAIM` + 30 s recovery tick + idempotency keys, so a run survives an API/worker restart | `packages/workspace/src/postgres-store.ts:1629-1665`, `apps/agent-api/src/company-run-queue.ts:113-130,186-219` |
| Workspace durability | sandbox filesystem is ephemeral (`--tmpfs`, `--read-only`, `--cap-drop ALL`); the source of truth is the host volume `npati-agent-data:/app/data/project-workspaces`, so workspaces survive container loss and re-sync; a disk write-lock with 5 s mtime heartbeat handles stale writers | `apps/agent-api/src/docker-sandbox-provider.ts:105-116,155`, `apps/agent-api/src/project-workspace.ts:196-200,266-310`, `docker-compose.yml:128-130` |
| Core DB migrations are weaker than Data Studio's | no migration lock, no checksum, no down-migrations (except 054–058, which the runner never calls), no contract steps; Data Studio, by contrast, has an advisory lock + `expires_at` lock + checksum + reversible/destructive flags + snapshot-before-destructive + a partial unique index on applied versions | `packages/workspace/src/postgres-store.ts:99-791`, `apps/agent-api/src/data-studio/repository.ts:266-276`, `apps/agent-api/src/data-studio/migration-engine.ts:73-155`, `packages/workspace/src/migration-060.ts:32-49` |
| Versioning | `CapabilityDefinition.version` is mandatory but **never read**; the main API has no `/v1` prefix and no version in response schemas (`/v1` exists only for the sandbox runner, the Data Studio gateway and webhooks); tool-call audit rows have **no version column** | `packages/shared/src/capabilities.ts:41`, `apps/agent-api/src/app.ts:2545-2693`, `packages/workspace/src/migration-007.ts:56-74`, `migration-029.ts:10-15`, `apps/agent-api/src/sandbox-runner-server.ts:43`, `apps/agent-api/src/data-studio/gateway-routes.ts:27` |

**Consequence for C1a:** the flag layer has a ready-made foundation — `workspace_user_settings`
(`migration-004.ts:2-13`) with `revision` + optimistic concurrency (`postgres-store.ts:812-822`) and
an in-process retry loop (`ai-preferences.ts:132-151`) — but it needs a global/company scope, a cache
with ≤30 s propagation and an audited change path, none of which exist.

## 11. UI building blocks for a code workspace (topic 11)

| Fact | Evidence | Implication |
|---|---|---|
| There is **no code editor**: files render as `<pre><code>` and editing is a plain `<textarea>` | `apps/web/src/ProjectPage.tsx:778`, `:822` | C7 either adds a real editor dependency or keeps the textarea and invests in diff/approval UX instead |
| No diff viewer: diffs are shown as raw text (`selectedDiffPath`, `FileChange.diff`); a diff modal exists only for Data Studio SQL | `apps/web/src/ProjectPage.tsx:140,599`, `apps/web/src/DataStudioPage.tsx:1708-1766,1941-1961` | a side-by-side/unified diff component is new UI work in C7 |
| Terminal is an event list (`TerminalEvent { commandSummary, riskLevel, status, output }`), not an interactive terminal | `apps/web/src/ProjectPage.tsx:9` | C7 can ship with the event-list model; xterm-class interactivity is optional |
| No editor/terminal libraries in dependencies (no monaco, codemirror, xterm, shiki, prism, highlight.js) | `apps/web/package.json:12-19` | any editor choice is a new dependency decision, not an existing one |
| Design system: `packages/branding/src/theme.css:1-12` defines the palette (`--npati-red:#e11d2e`, radii, shadow, `color-scheme: light` — no dark theme); everything else is one 417 KB `apps/web/src/styles.css` with prefixed classes (`company-*`, `project-*`, `data-studio-*`); no Tailwind | `packages/branding/src/theme.css`, `apps/web/src/styles.css` | new code UI must follow the prefix + variable convention |
| Routing pattern: flat `<Routes>` where each page is `<Workspace><XPage/></Workspace>`, and a new settings page = one `<Route>` + one card in the `SettingsPage` `cards` array | `apps/web/src/App.tsx:1479-1522`, `:1255-1262`, shell `:1070-1131` | the Code Workspace page plugs in the same way |
| Existing project UI to extend: bottom tabs `changes / terminal / checkpoints / deployments / qa / logs / activity`, file tree in `WebsiteEditor.tsx`/`WebsiteBuilderDashboard.tsx`, preview via `<iframe sandbox>` | `apps/web/src/ProjectPage.tsx:10`, `apps/web/src/WebsiteEditor.tsx`, `apps/web/src/BusinessWorkspace.tsx:1232` | C7 extends `ProjectPage` tabs rather than creating a parallel editor shell |
| Mobile: 39 `@media` blocks in `styles.css` plus a mobile header with a burger and `mobile-nav-open` | `apps/web/src/styles.css:144,2972,3790-3823,6552`, `apps/web/src/App.tsx:1073,1098-1123` | the code workspace must respect the same breakpoints |

## 4. What must be created from scratch (topics 13, 15, 16, 19, 24)

Everything below was actively searched for and does not exist today; each item is a deliverable of a
named step, not a new subsystem bolted onto NPATI.

| Missing piece | Why it is missing (evidence) | Step |
|---|---|---|
| **Feature-flag service with runtime scope and audit** | no flag table or runtime-config API was found in the Core DB or in `apps/agent-api/src` (the platform stream confirms in section 9); today behaviour is switched by env + restart | C1a |
| **Append-only AuditLog with hash chain and fail-closed writes** | existing audit surfaces are ordinary tables; no `UPDATE`/`DELETE` denial, no chain, no anchor (section 9) | C1c |
| **Image admission by digest + SBOM/scan/signature records** | images are built but not pinned by digest for the sandbox runtime, and no SBOM/scan/signature verification exists; CI builds them without any admission step (`.github/workflows/ci.yml:43-44`) | C1b |
| **Per-model capability metadata (one source of truth)** | today four inconsistent hardcoded tables and an ignored `context_length` (section 3) | C1a/C6 |
| **`code.*` capability group + CodingAgentRunner + session/run state** | the registry has `project.*` tools but no `code.*` group; the existing loop is a chat loop capped at 16 steps (`chat-tool-orchestrator.ts:118-225`) | C1, C2–C6 |
| **Streamed tool arguments** | the stream request carries no `tools` and `delta.tool_calls` is never parsed (`omniroute-engine.ts:287-289`, `:325-328`) | C6 |
| **`SecretLease` (scoped, TTL, revoked per tool call)** | secrets reach the sandbox through an allowlisted environment; there is no lease abstraction (`apps/agent-api/src/sandbox-provider.ts` allowlist) | C4 |
| **Egress proxy enforcement with post-DNS and redirect checks** | current control is a host allowlist string (`NPATI_SANDBOX_ALLOWED_HOSTS`) plus an egress image; no proxy enforcement or DNS-rebinding protection in NPATI code | C4b |
| **Provider data guard** | PII/secret guardrails exist per company, but no classification/redaction layer bound to *provider* policy, and the worker engine bypasses the resilient wrapper (`worker.ts:31`) | C5b |
| **Budget/quota enforcement** | settings are stored and displayed, `configureRuntimePolicy` has no caller, `checkBudgetQuota` is test-only (section 3, section 10) | R1 (enforcement), C1a (flags) |
| **`ExecutionSnapshotProvider`** | does not exist; C6 introduces the interface with a `NullSnapshotProvider`, C6b the real implementation (`PLAN.md:34`) | C6/C6b |
| **Data classification / retention classes** | no `data_classification`/`retention_class` on any entity today (section 9) | C1 |
| **`security-gate` test suite + blocking CI job** | zero `security-gate` tagged tests exist and CI does not run on push/PR (section 2.1) | C2 onwards, SG-1/2/3, G1 |
| **Install policy for dependencies inside the sandbox** | no lifecycle-script suppression, lockfile enforcement, minimum package age or registry allowlist is implemented (topic 15, refined in section 7) | C4a |
| **`code` capability domain** | `CapabilityDomain = ai\|research\|files\|browser\|communications\|storage\|security\|orchestration\|system\|business` has no `code` member, and grep for `code.*` capability ids finds matches only in `docs/coding-agent/PLAN.md` | C1/C2 |
| **Capability → model-tool bridge** | nothing converts a `CapabilityDefinition` into a provider tool definition; the model sees a hardcoded list of four chat tools (`app.ts:1475`) and the `HybridRouter` candidates never reach the model (`hybrid-router.ts:209` is called only from the diagnostic route `app.ts:2796`) | C2 |
| **Iterative tool loop with full tool access** | the only real loop is `runChatToolLoop` (4 tools, 8/16 steps); the company runtime is plan-then-execute (≤10 tools, one final answer) | C6 |
| **Versioned session/step persistence for tool calls** | `messages` holds only `id, conversation_id, role, content, created_at` and has never been altered in 64 migrations; `company_agent_tool_audit` stores only an aggregated `input_summary`; chat tool traces go to pino logs only | C1 (schema), C1a (version), C6 (writer) |
| **Interactive channel for terminal/approval** | SSE is one-way (`progress/delta/result/error`); no WebSocket or bidirectional channel exists for an interactive coding session | C7 (or explicitly deferred) |
| **Fix of two cancellation defects** | non-stream `/chat` passes no `AbortSignal` (`app.ts:3126-3131`); a cancelled company run writes a misleading assistant message into history (`app.ts:3475-3488`, `app.ts:500-507`) | C6 |

## 14. Risks and open questions (answers to `PLAN.md:1032-1045`)

Status legend: **answered** (evidence in this audit), **preliminary** (recommendation, needs the
remaining stream or an owner decision), **owner decision** (only the owner can answer).

| # | Question | Status | Finding / recommendation |
|---|---|---|---|
| 1 | Website Builder state (sandbox, terminal, git) | **answered** | All four primitives already exist and are wired to capabilities: project workspace (`project-workspace.ts`), terminal (`project.terminal.exec/process`), git incl. push/PR with approval (`project-git-service.ts`, `project.git.*`), checkpoints (`ProjectCheckpoint` with `manual/pre_run/post_run/pre_restore`), preview, QA. Git is therefore **not** greenfield: C11 extends an existing service. The only genuinely missing edit primitive is `apply_patch` (C3) |
| 2 | Model-specific tool calling and reasoning behaviour | **answered for NPATI, open for the gateway** | NPATI declares native tools for every model, never streams tool arguments, never uses JSON mode, never sends `cache_control`, and has no field for reasoning content (section 3). Which models actually behave well is a gateway/metadata question: the gateway already stores `tool_call/reasoning/structured_output/limit_context` per model (`vendor/omniroute/src/lib/modelsDevSync.ts:501-504`) — NPATI must consume it before profiles can be trusted |
| 3 | Is a mounted local folder (C15) needed earlier? | **preliminary: keep it in C15** | It changes the trust boundary fundamentally (the agent would read the user's real filesystem). Recommendation: ship C1–C14 against workspace-only projects; add mounted folders later behind a separate flag and a separate threat review |
| 4 | Approvals from Telegram/WhatsApp | **pending (capabilities stream)** | Depends on whether the integrations layer can carry an approval decision with verified actor identity; the audit records the requirement: the approver must be a human identity, never the agent, and the decision must be auditable |
| 5 | Licenses of reference harnesses | **answered** | Full table in section 12: MIT/Apache-2.0 projects are safe for ideas and (with attribution) code; Claude Code, Cursor, Devin, Windsurf are proprietary; Zed is GPL/AGPL; Tabby's `ee/` is off-limits. No code is copied in C0 |
| 6 | Does NPATI have a feature-flag system? | **answered: no** | No flag/kill-switch/runtime-config system exists (zero grep hits for flag/killSwitch/remoteConfig in `apps/`); behaviour changes need an env edit plus a container restart across ~117 env names. The only runtime-config store is `workspace_user_settings` (`migration-004.ts:2-13`) with `revision` + optimistic concurrency (`postgres-store.ts:812-822`) and an in-process retry loop (`ai-preferences.ts:132-151`) — a good foundation, but it has no global/company scope, no shared cache and no change audit. **Recommendation:** build the minimal flag service on that pattern (C1a), with audit hooks from C1c, rather than adopting a third-party flag product |
| 7 | Single owner or several users? | **pending (capabilities stream)** | Determines whether two-person approval is real or a step-up flow for one owner. The audit requires: approver identity must be a real user; the agent can never be the approver |
| 8 | Which providers and what data level | **owner decision** | The audit can only supply the mechanism (single chokepoint + worker path, section 3/5) and the rule that policy must also constrain fallback and subagents. The classification per provider is a business decision |
| 9 | Sandbox isolation level (containers vs gVisor/Kata/Firecracker) | **preliminary** | Today's sandbox is a hardened ephemeral container: `--read-only`, `--cap-drop ALL`, `--tmpfs /workspace`, CPU 1 / memory 1536m / pids 128 / disk 1.5 GiB (`docker-sandbox-provider.ts:105-116`), and the durable state lives on the host volume `npati-agent-data:/app/data/project-workspaces` (`project-workspace.ts:196-200`). Recommendation: keep hardened containers for Phase 1 on a dedicated host, keep the provider interface isolate-agnostic, and treat a stronger isolate as a documented upgrade path. **The highest-value target found in the audit is the runner container's host Docker socket mount** (`docker-compose.sandbox-runner.yml:22-25`, `docker-compose.dokploy.yml:191`) — it must be an explicit, documented trust assumption |
| 10 | Backups today, and excluding secrets | **answered, needs an owner decision** | All ten docker volumes are backed up wholesale (`docker-compose.yml:371-390`), including `postgres-data` and `minio-data`, which hold encrypted secrets (API keys `migration-019`, browser credentials `migration-043`, Data Studio secrets `migration-060.ts:15-20`) with the key held only in the environment (`crypto-vault.ts:1-53`). There is no selective backup or exclude mechanism. Options: exclude those tables/objects from backups and restore them from the vault, or accept ciphertext-in-backup and treat `NPATI_ENCRYPTION_KEY` as the single secret to protect. **R1 must document which one is true** |
| 11 | Where to anchor the audit hash chain | **preliminary** | Recommendation: chain rows in Core (append-only, `UPDATE`/`DELETE` denied by grants/trigger) plus a periodic anchor written outside the DB — a signed file on a separate volume, or an object in MinIO with object-lock/immutability if the deployment enables it. Verification must be a runnable command, not a manual procedure |

Cross-cutting risks recorded by the audit (beyond the threat model in section 8):

1. **Two model-call paths** (chat wrapper vs `worker.ts:31` raw engine) mean any guard placed in the
   wrong place silently misses automations and delegation runs.
2. **Metadata drift** between four hardcoded model tables makes any profile decision unreliable until
   consolidated; a wrong context-window guess is a silent quality/cost bug.
3. **CI does not gate anything today**; the security gate (G1) is decoration until push/PR triggers
   exist and the job is required.
4. **`supportsNativeTools()` returning true unconditionally** hides exactly the failure mode the
   `ToolCallAdapter` exists to fix — it must be corrected before C6 relies on it.
5. **Budget non-enforcement** plus a 40-step/30-minute run budget means a runaway coding agent is the
   most likely real-world cost incident.
6. **The Docker socket mount** in the runner container is the single largest privilege assumption in
   the design; it belongs in the documented threat model, not only in the code.
7. **No retention anywhere** (MinIO objects, workspace files, `company_agent_run_events`,
   `company_agent_tool_audit`, `company_audit_logs`) means a coding agent that reads repositories and
   runs commands will grow storage monotonically; R1 must assign `retention_class` per entity from C1
   and enforce pruning.
8. **Versioning is declared but unused**: capability `version` is never read, the main API has no
   version prefix, and tool-call audit rows carry no version. C1a must add the columns *and* the
   readers, otherwise old sessions cannot be replayed safely (C6b depends on it).
9. **No metrics, tracing or alerting** and only partial rate limiting; a code run cannot be observed
   end to end today (API → sandbox → model), which makes SLO work in R1 a prerequisite rather than a
   nice-to-have.
10. **Core DB migrations are weaker than Data Studio's** (no lock/checksum/down); the safe runner
    exists in Data Studio and should be generalized in C6a instead of duplicated.

## 7. Sandbox and runtime conclusion (topics 10, 15, 16, 19, 20)

### 7.1 What the sandbox already guarantees (better than the plan assumed)

| Property | Implementation | Evidence |
|---|---|---|
| Per-run network isolation | `docker network create --internal` with `gateway_mode_ipv4=isolated`; only the sandbox and its egress sidecar join it | `apps/agent-api/src/docker-sandbox-provider.ts:103-113` |
| Egress enforcement that already satisfies most of C4b | dedicated `sandbox-egress-proxy.mjs`: host allowlist, ports 80/443 only, DNS resolution followed by rejection of RFC1918/loopback/link-local/CGNAT/multicast, CONNECT with **SNI verification**, ClientHello timeout 5 s / 16 KB cap | `apps/agent-api/src/sandbox-egress-proxy.mjs:6-25,64-65,84-101` |
| Container hardening | `--user 10001:10001`, `--read-only` rootfs, `--cap-drop ALL`, no-new-privileges, cpus 1 / memory 1536m / pids 128, `tmpfs /workspace`, separate 64m `/tmp`, egress sidecar capped at 128m/64 pids | `docker-sandbox-provider.ts:105-133` |
| No database reachability | the sandbox network is separate from both the Core network and `npati-projects-db`; environment filtering additionally blocks database-shaped variables | `docker-compose.yml:146,345,366-367`, `apps/agent-api/src/project-sandbox-service.ts:28-31,76-89` |
| Secret handling today | Company vault references only (`<uuid>:<field>`, ≤20), with a hard deny list (`DATABASE_URL`, `PROJECT_SECRET_KEY`, `PGPASSWORD`, `npati_sk_*`, `postgres://`), and sandbox variables are removed afterwards | `project-sandbox-service.ts:28-31,76-89,177` |
| Output redaction | `redactTerminalText` applied to stdout/stderr, journal, process logs and files pulled from the sandbox | `apps/agent-api/src/terminal-command-policy.ts:80-87`, `project-sandbox-service.ts:154,190,200,289,309-311` |
| Command risk policy | in-code classifier with `safe` / `controlled` / `approval`, timeout classes (`default` / `install_build`), allow-listed flags (including `--ignore-scripts`, `--offline`, `--frozen-lockfile`), shell metacharacters forced to approval | `terminal-command-policy.ts:17,52-78` |
| Limits | command 120 s, install/build 600 s, output 64 KiB (clamp 128 KiB), idle 15 min, sync 500 files / 20 MB; Docker hard-caps at 600 s and 128 KiB and stops the sandbox on timeout | `project-sandbox-service.ts:19,48-50,179`, `docker-sandbox-provider.ts:176-179` |
| No raw host exposure | `exposePort` returns the container-internal IP; nothing is published to the host; preview goes through an HMAC-token proxy with 15-minute tokens, scope checks and `redirect: manual` | `docker-sandbox-provider.ts:255,266-276`, `apps/agent-api/src/project-preview-service.ts:212-258` |

**Conclusion for C4b:** the plan's "egress proxy with post-DNS and redirect checks" is **largely
implemented**. C4b shrinks to: (a) making the allowlist project-policy-driven instead of a static env
value, (b) DNS-rebinding/redirect regression tests in the `security-gate` suite, and (c) the
fetch/build network separation that belongs to C4a. The remaining C1b work is about **image supply
chain**, not about building a proxy from scratch.

### 7.2 What the sandbox lacks today

| Gap | Evidence | Consequence |
|---|---|---|
| Images are **not** digest-pinned, unsigned, unscanned; `NPATI_SANDBOX_IMAGE` is a free-form tag and `createSandbox` has no image allowlist | `apps/agent-api/Dockerfile.project-sandbox:1-11` (`node:24-alpine` tag), `docker-sandbox-provider.ts:13-17`; no `cosign`/`sbom`/`trivy`/`osv-scanner`/`syft` anywhere in `apps/` | C1b must add digest pinning, SBOM, scan, signature and admission control |
| The sandbox image has Node (npm/pnpm 10/yarn 1.22.22), python3+pip, php+composer, git, coreutils, findutils, util-linux — and **no Go, Rust, Java, ripgrep, build-base/make/g++, curl, jq, unzip, bash or patch** | `Dockerfile.project-sandbox:1-11` | a coding agent cannot build Go/Rust/Java projects and cannot grep efficiently; C1b must extend the image (see 7.4) |
| `npm_config_audit=false` and global installs use `--no-audit --no-fund`; no `pip-audit`, `composer audit`, OSV or Trivy; no private registry or registry proxy; no two-phase (fetch/build) network | `docker-sandbox-provider.ts:121`, `Dockerfile.project-sandbox:3`, `not found (grep "pip-audit\|composer audit\|osv-scanner\|trivy\|sbom")` | C4a has real work: install policy, lockfile-only, minimum package age, allowlisted registries, audits |
| Secrets are injected as environment for the sandbox lifetime, not leased per tool call; there is no rotation and no revocation | `project-sandbox-service.ts:76-89,177` | C4 must introduce `SecretLease` (scoped, TTL, revoked after the call) |
| The browser-QA image is neither built by CI nor by the runner entrypoint; preflight only checks project + egress images | `.github/workflows/ci.yml:43-44`, `apps/agent-api/sandbox-runner-entrypoint.sh:8-11`, `sandbox-runner-server.ts:31-32` | QA/verification path is fragile; C1b must cover it |
| No file-content search: `project.files.search` matches **path substrings only** (`searchFiles` caps at 200 chars / 100 results) and the sandbox has no ripgrep | `apps/agent-api/src/project-workspace.ts:349-350`, `company-tool-runtime.ts:270` | C2's read/search tools are genuinely new |
| No `apply_patch`; `edit` is first-occurrence find/replace; the HTTP write path ignores `expectedRevision` (CAS is weakened for UI edits) | `project-workspace.ts:398`, `apps/agent-api/src/project-file-routes.ts:45-46` | C3 must add patch semantics and restore CAS on the HTTP path |
| No build/test tool: `buildProject` exists but is only called by the orchestrator/multi-agent services; no result parsing, no PTY, no streamed output | `project-preview-service.ts:191-211`, `project-orchestrator.ts:712`, `project-multi-agent.ts:163,292` | C4 must expose run/test tools with structured results |
| Sandbox `/workspace` is tmpfs; sync back happens only after `exec`; background processes (`action:"start"`) are **never** synced back; preview sessions and `lastUse` are in-memory; there is no orphan-container reaper | `docker-sandbox-provider.ts:115`, `project-sandbox-service.ts:186-191`, `:92-107` | C6a must add a reaper, and code runs must not rely on background processes producing files |
| **The queue worker cannot run coding tools**: it constructs the runtime without `project.git/preview/deploy/qa/data`, without the file-lease manager, and without the Project API environment | `apps/agent-api/src/worker.ts:55,63-71` | **Critical:** long/background runs (C6/C10) execute in the worker, so worker parity is a prerequisite, not a detail |
| Checkpoint restore is a hard `git reset --hard` + `git clean -fd` (untracked work is lost) and does not cover the tmpfs sandbox | `apps/agent-api/src/project-git-service.ts:553-561` | C3/C6a must snapshot the workspace before destructive restores |
| Git merge lock is in-process memory only; there are no session branches or review queue | `project-git-service.ts:626` | C11/C12 need a durable lock and a review flow |
| Project type has no `code`/`repository` variant; local folders are C15-only | `packages/workspace/src/types.ts:35-36`, `migration-054.ts:12`, `migration-063.ts:14` | C1 adds the type |
| Compose reality check: the local `docker-compose.yml` passes `NPATI_SANDBOX_RUNNER_URL/SECRET` but has no `sandbox-runner` service and no `local-sandbox` profile in the repository; only `data-studio` exists there | `docker-compose.yml:66-67,325`, `not found (grep "profiles: \[local-sandbox\]")` in the committed compose files | documentation must be reconciled with the deployed reality (`docker-compose.dokploy.yml` is the single-host file that does define the runner) |

### 7.3 Runtime/durability summary

- Durable state lives in Core: `<NPATI_PROJECT_WORKSPACE_ROOT>/<companyId>/<projectId>` on the
  `npati-agent-data` volume (`project-workspace.ts:243,344`, `docker-compose.yml:129-130`), with
  atomic writes (`.npati-<uuid>.tmp` + rename, mode 0600), content-addressed `sha256` revisions, CAS
  on `expectedRevision`, a disk write-lock with a 5 s heartbeat plus a cross-agent lease manager, and
  a baseline + unified diff for change review (`project-workspace.ts:80-171,248-314,321,360-369,429`).
- The sandbox is disposable by design; that is acceptable **only** because every exec is bracketed by
  an upload/download sync. Code runs must therefore treat the Core workspace as the single source of
  truth and never rely on sandbox-local state.

### 7.4 Sandbox image conclusion

The plan asks whether the images must be extended. Answer: **yes, and the extension is bounded.**

1. **Required for a usable coding agent (C1b/C4):** `ripgrep`, `patch`/`diffutils`, `bash`, `jq`,
   `unzip`, `curl`, `make` + `g++`/`build-base` (native modules), `git` (already present),
   `openssh-client` (private repositories), and `sqlite3` if local data work is expected. Without
   `ripgrep` a code agent is effectively blind, and without a compiler many npm/pip installs fail.
2. **Required per language promise (choose explicitly, do not silently promise them):** Go toolchain,
   Rust (`rustup`/`cargo`), Java (JDK + Maven/Gradle). These are heavy; if they are promised, they
   need their own image variants or a pre-warmed cache, otherwise each run re-downloads them.
3. **Required for supply chain (C1b/C4a):** digest-pinned base images, a signed/admitted image set,
   `osv-scanner` (or an equivalent) available either inside the image or as a mandatory CI step,
   pre-warmed read-only package caches, `--ignore-scripts` by default, and a separate fetch phase
   before the network is cut for build.
4. **Explicitly not required:** a browser stack beyond the existing browser-QA image, Docker-in-sandbox,
   or language runtimes nobody asked for. Anything added must be justified by a plan step and covered
   by an image test so the sandbox stays reproducible.
