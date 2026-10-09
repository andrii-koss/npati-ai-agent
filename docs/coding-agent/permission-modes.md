# Coding Agent — permission modes and approvals (C14)

Scope: the four session modes, the mode × risk matrix, the actions that are **never** automated at any mode,
the three approval scopes, protected branches, and the mechanisms that make a mode unreachable from file
content or tool output.

Code: `apps/agent-api/src/code-policy-engine.ts`, `code-rbac.ts`, `code-approval-scope.ts`,
`code-protected-branches.ts`, `code-git-write-policy.ts`, `code-plan-mode.ts`.
Plan references: `docs/coding-agent/PLAN.md:536` (C5), `:573` (C5a).

---

## 1. The mode vocabulary

Two spellings exist and both are accepted; `matrixModeFor` maps either onto one matrix row
(`code-policy-engine.ts:359-370`).

| Stored / C1 spelling | Canonical name | Matrix mode |
| --- | --- | --- |
| `plan` | `plan` | `plan` |
| `edit` | `ask` | `ask` |
| `auto` | `auto_edit` | `auto_edit` |
| `full_auto` | `full_auto_sandbox` | `full_auto_sandbox` |

`CODE_CANONICAL_SESSION_MODES = ["plan", "ask", "auto_edit", "full_auto_sandbox"]`
(`code-rbac.ts:77`). **An unknown or absent mode maps to `plan`** — the most restrictive row
(`code-policy-engine.ts:368`).

---

## 2. Mode × risk matrix

`MODE_RISK_MATRIX` (`code-policy-engine.ts:352-357`), verbatim:

| Mode | `safe` | `controlled` | `approval` | `hard_deny` |
| --- | --- | --- | --- | --- |
| `plan` | allow | deny | deny | deny |
| `ask` | allow | require_approval | require_approval | deny |
| `auto_edit` | allow | allow | require_approval | deny |
| `full_auto_sandbox` | allow | allow | require_approval | deny |

Two things about this table are load-bearing:

* **The `hard_deny` row is a documented backstop, not the enforcement point.** Phase 4 returns before the
  matrix is ever consulted, so `hard_deny` never reaches this table
  (`code-policy-engine.ts:348-349`, `:834-835`). A mode therefore cannot lift a hard deny even by editing
  this constant — the refusal happens earlier in the same function.
* **`full_auto_sandbox` is not "allow everything".** It adds exactly one reason to the log
  (`full_auto_sandbox:no_extra_confirmation`, `:855`) and still requires approval for `approval`-class work,
  for destructive migrations, for dependency changes that are not plain registry installs, and for anything
  whose capability declares `requiresConfirmation`.

Risk classes come from the command classifier, never from the model
(`code-policy-engine.ts:730-739`; a `hard_deny` classification refuses immediately with
`command_hard_denied`). Tools without a command line are not risk-classified; their verdict comes from the
capability declaration and the mode's read-only rule (§4).

### 2.1 Ordering of the non-matrix gates

These run **outside** the matrix and therefore cannot be bought by raising the mode
(`code-policy-engine.ts:783-816`):

| Gate | Behaviour | Code |
| --- | --- | --- |
| Network enforcement | A network command is refused `503 network_enforcement_unavailable` (retryable) in **every** mode — including `full_auto_sandbox` and including a granted approval — until the sandbox guarantees egress allowlist enforcement | `:787-800` |
| Dependency source | `deps.source !== "registry"`, `deps.registryChange`, or `deps.installScripts` always produce `require_approval`, even in `full_auto_sandbox` | `:805-816` |
| Migration | A `require_approval` migration verdict is applied **before** the matrix, so `full_auto_sandbox` cannot auto-allow it | `:818-832` |
| Plan mode file rule | In `plan`, any tool that is not a shell tool, not in `READ_TOOLS` and not in `PLAN_SAFE_TOOLS` is refused | `:755-761` |

---

## 3. What is never automated (hard deny)

Hard deny means: unreachable by any mode, any role, `admin:all`, `*`, an owner's explicit approval, a
standing approval rule, or a `approved: true` claim.

| # | Hard deny | Code / code |
| --- | --- | --- |
| 1 | A path outside the workspace, or a NUL byte, or `..` traversal, or a Windows drive/absolute path or `~` | `path_outside_workspace` (`code-policy-engine.ts:638-643`, `isUnsafePath` `:515-520`) |
| 2 | Any write inside `.git` | `git_dir_protected` (`:640-642`) |
| 3 | A write into a **protected branch** (default `main`, `master`, `release`) | `protected_branch_write_denied` (`code-protected-branches.ts:54`, `:66`; evaluated in phase 4b, `code-policy-engine.ts:644-683`) |
| 4 | A **force push** | `force_push_denied` (`code-protected-branches.ts:66`) |
| 5 | A git write whose typed intent is missing or internally inconsistent | `git_write_intent_invalid` / `git_write_intent_required` (`code-policy-engine.ts:884-941`) |
| 6 | An unrefspec'd `git push` whose branch cannot be resolved | `git_push_requires_resolved_branch` (`:914-920`) |
| 7 | A **production** database migration, an external target that is not a known development DataBackend, or an **unknown** target | `code-migration-safety.ts` verdict `deny` (`code-policy-engine.ts:684-728`) |
| 8 | A command the classifier classes `hard_deny` (e.g. fork bomb, root wipe, download-and-execute, device writes, sandbox network reconfiguration) | `command_hard_denied` (`:736-738`); rule table `HARD_DENY_RULES`, `code-shell-classifier.ts:120` |
| 9 | Any tool outside the review-safe set when the session's intent is read-only | `review_code_read_only` (`:625-635`) |
| 10 | Repository content that attempted to change policy | `repository_instruction_policy_change` (`:600-607`) |
| 11 | Applying repository instructions without owner/admin trust | `project_not_trusted` (`:608-610`) |
| 12 | An unavailable protected-branch policy — fail closed | `protected_branch_policy_unavailable` (`:663-672`) |

A standing approval rule cannot be created for a hard-deny surface in the first place
(`hard_deny_not_approvable`, `code-approval-scope.ts:54-55`), and the engine refuses to consult a rule before
those phases have run (`:1025-1032`).

The action vocabulary that can never be authorised at all is listed separately and independently of the
matrix: `code.hard_deny`, `code.docker.socket`, `code.production_credentials`
(`CODE_NEVER_GRANTED`, `code-rbac.ts:64-69`). Privileged permissions (`code.prod.operate`,
`code.policy.manage`, `code.trust.manage`, `code.rbac.manage`, `code-rbac.ts:57-62`) are never implied by a
wildcard: `*`, `owner` and `admin:all` expand ordinary permissions only (`code-rbac.ts:24`, `:146`).

### 3.1 Where an owner *can* decide

Owner/admin is a real authority for a specific, narrow set, each journal-first and each failing closed when
the journal is unavailable (`audit_unavailable`, 503):

* lowering the assigned risk of one runtime MCP tool (`mcp-risk-override.ts:139-140`, `:158`);
* project trust grant/revoke (`code-project-trust.ts:60-75`, `:105-109`);
* the protected-branch policy itself (owner only; an agent is refused with
  `agent_cannot_change_protected_branches`, a non-owner human with `protected_branches_owner_required`,
  `code-protected-branches.ts:17-18`);
* the egress allowlist (`egress-allowlist.ts:328`);
* session mode changes (`code-session-mode-routes.ts:120-135`).

None of these can turn a hard deny into an allow: they are all decided in a later phase than the hard-deny
phases, or they change a *policy input* that is re-evaluated by the same engine on the next call.

---

## 4. Read-only and plan-mode allowances are explicit name lists

| Set | Members | Why a name list, not a class |
| --- | --- | --- |
| `READ_TOOLS` | `code.fs.read`, `code.fs.list`, `code.fs.grep`, `code.fs.tree`, `code.symbols.outline`, `code.project.info`, `code.fs.diff`, `code.shell.process.list`, `code.shell.process.logs` | `isReadOnlyTool` is the `plan`-mode gate; if it were class-based, any future read tool would silently become available in the one mode whose purpose is to plan without touching code (`code-policy-engine.ts:378-389`) |
| `PLAN_SAFE_TOOLS` | `code.plan.propose`, `code.plan.update`, `code.ask_user` | Session metadata and a question; they touch neither workspace nor sandbox nor network |
| `REVIEW_SAFE_GIT_TOOLS` | `code.git.status`, `code.git.diff`, `code.git.log`, `code.git.pr.comment` | Read-only git plus commenting on a PR — the comment has **its own** approval record bound to the PR number and a hash of the comment text, so a push approval cannot be redeemed as a comment (`code-policy-engine.ts:391-402`) |

`isReviewSafeTool` is the union of exactly these three lists, so "read-only" has one definition
(`code-policy-engine.ts:455-457`), and the read-only gate itself is a **hard deny** ("this session may not
write" is not a preference a mode or rule can widen, `:612-635`).

---

## 5. Approval scopes

`APPROVAL_SCOPES = ["once", "session", "project"]` (`code-approval-scope.ts:30`).

| Scope | Bound to | Creates a rule? | Notes |
| --- | --- | --- | --- |
| `once` (default) | One **payload hash** | No — deliberately not representable as a row | The one-shot decision must never become a standing allowance (`code-approval-scope.ts:5-7`) |
| `session` | `(session, action)` | Yes | Consulted only in the approval phase, which runs after hard deny, the session-mode check, project rules and the network gate (`code-policy-engine.ts:1023-1032`) |
| `project` | `(project, action)` | Yes | Same restriction; scope does not change what is permitted |

Invariant: **a rule can only ever widen an approval, never a prohibition** (`code-approval-scope.ts:11-16`).

Two closed lists decide what a standing rule may cover:

* `SCOPED_RULE_ALLOWED_ACTIONS` — exactly `code.fs.edit`, `code.fs.write`, `code.fs.move`, `code.verify.run`.
  An explicit allowlist, so a new tool is never standing-approvable by accident (`:121-126`).
* `SCOPED_RULE_DENIED_ACTIONS` — `code.fs.delete`, `code.deps.add`, `code.deps.install`,
  `code.deps.update`, `code.git.push`, and the rest of the privileged set: credentials, the egress
  allowlist, migrations, deploys. These stay `once` (`:138-145`).

Timeouts and comments: `DEFAULT_APPROVAL_TIMEOUT_MS = 900 000` (15 min), `MAX_APPROVAL_TIMEOUT_MS = 3 600 000`
(1 h), `MAX_DENY_COMMENT_LENGTH = 500` (`code-approval-scope.ts:24-26`). A rejection travels back to the
model as `approval_denied` with the reviewer's comment, length-capped and secret-redacted, treated as data
and never as a policy input (`code-policy-engine.ts:1066-1083`, `code-approval-scope.ts:17-18`).

An agent or service principal can never approve its own action: `agent_cannot_approve` in the RBAC phase,
before anything else is considered (`code-policy-engine.ts:556-560`).

### 5.1 Which tools require a human even when a mode would allow them

The capability declaration decides, not the mode. From `packages/shared/src/code-capabilities.ts`, the
`code.*` capabilities with `requiresConfirmation: true` are:

| Tool | Declared risk | Capability `requiresConfirmation` |
| --- | --- | --- |
| `code.fs.delete` | high | true |
| `code.deps.add` | high | true |
| `code.git.restore` | high | true |
| `code.git.push` | high | true |
| `code.git.pr.create` | high | true |
| `code.git.pr.comment` | medium | true |

Every other `code.*` tool declares `requiresConfirmation: false`; its verdict comes from the mode × risk
matrix, the sub-flag and the phases above. `code.shell.exec`, `code.shell.process.start` and
`code.deps.add` are declared `risk: high` while the remaining read tools are `low` and the editing tools
`medium` (same file). The engine derives its approval-gated set from that declaration so there is exactly one
definition (`APPROVAL_GATED_TOOLS`, `code-policy-engine.ts:333-342`).

---

## 6. Sub-flags: a mode is not enough

A mode is consulted in phase 5; the sub-flag is consulted in phase 1 and a missing flag source is a
`503 policy_engine_unavailable` (`code-policy-engine.ts:544-554`). Mapping
(`subFlagForTool`, `code-policy-engine.ts:411-427`):

| Tool family | Sub-flag |
| --- | --- |
| Runtime MCP tool (`mcp:<connection>/<tool>`) | `code.mcp` |
| Any `code.shell.*` | `code.shell` |
| Any `code.git.*` or a git-write tool | `code.git` (its own flag, so enabling edits does not enable pushing) |
| `READ_TOOLS` and `PLAN_SAFE_TOOLS` | `code.read` |
| Everything else | `code.write` |

Self-hosted installations enable all supported sub-flags and the master `coding_agent.enabled` by default.
Hosted deployments retain the off-by-default rollout. Explicit disabled rows and the master kill switch take
precedence over installation defaults. A key that does not match `CODE_FLAG_KEY_PATTERN` can never be enabled
(`feature-flags.ts:71-74`).

---

## 7. Role → mode

`DEFAULT_CODE_SESSION_MODE_MATRIX` (`code-rbac.ts:87-95`), which is data and replaceable:

| Role | Modes the role may set |
| --- | --- |
| `owner` | `plan`, `ask`, `auto_edit`, `full_auto_sandbox` |
| `admin` | `plan`, `ask`, `auto_edit`, `full_auto_sandbox` |
| `developer` | `plan`, `ask`, `auto_edit` |
| `reviewer` | none — reads and comments, never drives a session |
| `service` | none — never an approver, never production operations (`code-rbac.ts:122-124`) |

A mode **denial** is independent of the matrix: the mode's authority to be set at all is checked on the
session-mode route, which also requires the audit journal (`code-session-mode-routes.ts:120-135`).

---

## 8. Protected branches

`DEFAULT_PROTECTED_BRANCHES = ["main", "master", "release"]` (`code-protected-branches.ts:54`), used only
when the company has no stored row (`company_protected_branches`, `:36-46`). `MAX_PROTECTED_BRANCHES = 100`
(`:59`), the update action is `code.protected_branches.update` (`:57`), and the accepted input keys are
exactly `["branches", "expectedRevision", "challengeId"]` (`:62`) — repository content cannot smuggle a
policy input into the request (`protected_branch_policy_input_rejected`, `:23`).

The hard deny is evaluated in the policy engine **and** again at the git boundary, before the approval record
is consumed — the order is deliberate, because a hard deny must not spend a human's one-shot approval
(`project-git-service.ts:1121-1122`).

---

## 9. How a mode cannot be changed from content

This is the part that makes the matrix meaningful. Four independent mechanisms:

1. **Repository content that attempts a policy change is refused, trusted or not.** The trust phase denies
   with `repository_instruction_policy_change` as soon as
   `request.repositoryInstructions.policyMutationAttempts > 0` (`code-policy-engine.ts:600-607`), and
   `repositoryContentCanChangePolicy()` is literally typed `false`
   (`code-prompt-injection-guard.ts:139`).
2. **An agent principal cannot change policy at all.** `policyChange` (one of `session_mode`, `project_rules`,
   `trust`, `allowlist`, `tool_policy`) from an agent principal is `agent_cannot_change_policy`
   (`code-policy-engine.ts:597-599`; `PolicyChangeKind` at `:67`).
3. **Tool output, hook context and command output are data with a closed key vocabulary.** The envelope
   marks them `trust: "untrusted_data"` and the top level carries no policy field
   (`docs/coding-agent/security.md` §4; `security-gate-report.md:120`, `:226-229`).
4. **The values the engine reads are server-side.** `readOnlyIntent` comes from the session's resolved
   intent, `git` is a typed intent, `runtimeMcp` is built by the run path, and the mode comes either from the
   request the server builds or from the session record through the `sessionMode` port
   (`code-policy-engine.ts:139-192`, `:742-744`). Slash-command expansion and hook results have no member
   that any of these readers looks at: `code.commands` expansion carries `canChangePolicy: false` /
   `canGrantTools: false` (`code-commands.ts:558-560`), and `code-hooks.ts` cannot see a policy field at all
   (`current-state.md:122-123`).

---

## 10. Honest limits

* The matrix is exercised by tests with an injected classifier and an injected session-mode port; the modes
  are not exercised end-to-end against a real container in this environment (no Docker — see
  `docs/coding-agent/c14-final-report.md`).
* `plan` mode's allowance is a name list, so a genuinely new read-only tool is **not** usable in `plan` until
  it is added to `PLAN_SAFE_TOOLS`. That is the intended trade-off, and it means "plan is too strict for tool
  X" is a real, expected review comment rather than a bug.
* Standing rules (`session`/`project`) are restricted to four actions and are never available for privileged
  work; an operator who wants repeated privileged work has to approve it each time.
* The mode-vs-risk matrix applies to command-carrying calls. A tool with no command line is decided by its
  capability declaration and the read-only/plan rules, so "which row would this tool be in" is not a question
  the matrix answers.
