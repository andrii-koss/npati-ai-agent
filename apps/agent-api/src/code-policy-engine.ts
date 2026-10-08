import type { AuthContext } from "@npati/workspace";
import { CODE_READ_CAPABILITIES, CODE_SHELL_CAPABILITIES, CODE_WRITE_CAPABILITIES, CODE_DEPS_CAPABILITIES } from "@npati/shared";
import { assertCapabilityGranted, CodeCapabilityError } from "./code-capability-groups";
import { approvalActionFor, redactDenyComment } from "./code-approval-scope";
import { hasAdminPermission, type CodeCanonicalSessionMode } from "./code-rbac";
import {
  MCP_APPROVAL_TTL_MS,
  mcpApprovalPayloadFor,
  type McpApprovalRuntimeSubject,
} from "./mcp-approval";
import { detectGitWriteAttempts } from "./code-shell-classifier";
import { MCP_FLAG as MCP_RUNTIME_FLAG, isRuntimeMcpTool } from "./mcp-runtime-identity";
import {
  GIT_PUSH_REQUIRES_RESOLVED_BRANCH,
  GIT_WRITE_INTENT_INVALID,
  GIT_WRITE_INTENT_REQUIRED,
  bindsRepositoryInitialization,
  gitWriteIntentFromShellAttempt,
  isGitWriteTool,
  normalizeGitBranch,
  normalizeGitWriteIntent,
  type GitWriteIntent,
} from "./code-git-write-policy";
import {
  evaluateMigrationSafety,
  inferMigrationTargetFromCommand,
  resolveMigrationTarget,
  type MigrationDiffFile,
  type MigrationSafetyVerdict,
  type MigrationTargetInput,
} from "./code-migration-safety";

/**
 * C4: centralized server-side policy engine.
 *
 * This is the single decision point for every privileged Coding Agent action. It is deliberately
 * self-contained (structural dependency ports, no service imports) so that it can be injected into
 * any execution path and so that a path without an engine can only fail closed.
 *
 * Phase order is fixed and short-circuits on the first refusal. The numbered order below is the order in
 * which `evaluateInternal` can reach each phase, and its phase names are exactly the members of
 * `PolicyPhase`; `tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts` reads the type and the
 * method body from this file and fails when this description and the code disagree:
 *   1 feature_flag -> 2 rbac -> 3 capability -> 4 capability_groups -> 5 trust -> 6 hard_deny ->
 *   7 session_mode -> 8 project_rules -> 9 network_enforcement -> 10 approval -> 11 risk_classification
 *
 * The `approval` label is reached before `risk_classification` because the dependency and the migration
 * approval decisions run before the mode x risk matrix; the matrix is the only place that refuses under
 * `risk_classification`, and its own approval or allow verdict is the last thing this method returns.
 */

export type PolicyDecision = "allow" | "deny" | "require_approval";
/**
 * The reason an approval-classed request carries when it is deferred to a stronger boundary
 * (`approvalDeferredByBoundary`). It is exported because C13's PreToolUse probe reuses the same deferral to
 * ask the engine a question *without side effects* — the approval phase would otherwise create a second
 * approval request for the same call — and then reads this marker to recognise "an approval would be
 * required", which must withhold a project hook rather than let it run on an approval-required path.
 */
export const APPROVAL_DEFERRED_REASON = "approval:deferred_to_boundary";

export type PolicyPhase =
  | "feature_flag" | "rbac" | "capability" | "capability_groups" | "hard_deny" | "network_enforcement" | "session_mode"
  | "trust" | "project_rules" | "risk_classification" | "approval";
export type PolicyRisk = "safe" | "controlled" | "approval" | "hard_deny";
/**
 * The session mode a request carries. C5a (D6): both vocabularies are accepted — the C1 spellings
 * (`plan`/`edit`/`auto`/`full_auto`) that sessions are stored with, and the canonical matrix names
 * (`plan`/`ask`/`auto_edit`/`full_auto_sandbox`); `matrixModeFor` maps either onto one matrix mode.
 */
export type CodeSessionModeName = "plan" | "edit" | "auto" | "full_auto" | CodeCanonicalSessionMode;

/** C5: policy surfaces that only a user may change. An agent principal can never touch them. */
export type PolicyChangeKind = "session_mode" | "project_rules" | "trust" | "allowlist" | "tool_policy";

export interface PolicyRequest {
  ctx: AuthContext;
  companyId: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  /**
   * C6b: the ExecutionSnapshot this decision belongs to. Optional on purpose: a caller with no snapshot
   * (an action outside a run, or a pre-C6b caller) leaves it unset rather than passing a fabricated id, and
   * the persisted Activity event records "no snapshot" honestly.
   */
  snapshotId?: string;
  tool: string;
  toolVersion?: number;
  command?: string;
  paths?: string[];
  sessionMode?: CodeSessionModeName;
  approved?: boolean;
  approvalId?: string;
  toolCallId?: string;
  /** C5: the scoped rule that selected this decision, when one applied (recorded in the decision event). */
  ruleRef?: { scope: string; id: string } | null;
  /**
   * C5: the scope this call asks for. `once` (default) keeps the one-shot approval bound to one payload
   * hash and creates no rule; `session`/`project` may be matched against an existing scoped rule.
   */
  approvalScope?: "once" | "session" | "project";
  /** C5: how long the caller is willing to wait for a human decision (clamped by the service). */
  approvalTimeoutMs?: number;
  /** True only when egress enforcement is actually guaranteed (C4b); otherwise network commands are denied. */
  networkEnforcementGuaranteed?: boolean;
  /**
   * C4a: what a dependency tool is about to do. A source other than `registry`, a registry
   * reconfiguration or an install that would run lifecycle scripts can never be an implicit allow —
   * the engine turns them into an approval regardless of the session mode.
   */
  deps?: {
    source?: "registry" | "git" | "tarball" | "http" | "local_path";
    installScripts?: boolean;
    registryChange?: boolean;
  };
  /**
   * C5: the agent's capability groups, the user's permissions and the project's rules. When present,
   * the engine intersects them in the `capability_groups` phase — before risk classification and
   * approval — and refuses with `capability_not_granted`. Absent means "no group source configured",
   * which leaves existing behaviour untouched.
   */
  capabilityGroups?: {
    agentCapabilityGroups: string[];
    userPermissions: string[];
    projectRules?: { allow?: string[]; deny?: string[] } | null;
  } | null;
  /**
   * C5: set when the call itself would change policy (mode, rules, trust, allowlist, tool policy).
   * An agent principal is always refused here; a user still goes through RBAC in the routes.
   */
  policyChange?: PolicyChangeKind;
  /**
   * C5: set when this tool call would apply repository instructions as instructions. It requires an
   * explicit owner/admin trust record; repository content itself can never grant it.
   */
  requiresProjectTrust?: boolean;
  projectTrusted?: boolean;
  /**
   * C5: repository instruction candidates reviewed for this call. A policy-mutation attempt inside
   * repository content is refused in the `trust` phase and never applied, trusted project or not.
   */
  repositoryInstructions?: { policyMutationAttempts?: number; notes?: string[] } | null;
  /**
   * C11 (owner decision 3): the **typed** git write this request performs, when it is a git write.
   *
   * A git tool has no `command`, so the branch, the remote and `force` cannot be read from a command line
   * and have to travel as fields. Phase 4b evaluates exactly this shape (and the command line as well,
   * when both are present), and `payloadHashFor` folds it into the approval hash, so an approval is bound
   * to the branch it was granted for rather than to "some push".
   */
  git?: GitWriteIntent | null;
  /**
   * C6a: database-migration context. The engine derives the migration *action* from `command` itself
   * (`code-migration-safety.ts`); this field carries what the command text cannot know — the resolved
   * target, the migration files in the diff, whether the call is routed through the Data Studio migration
   * engine, whether a rollback plan exists, and whether the database is the ephemeral sandbox one.
   */
  migration?: {
    target?: MigrationTargetInput | null;
    files?: MigrationDiffFile[];
    dataStudioEngine?: boolean;
    rollbackPlan?: boolean;
    sandboxEphemeral?: boolean;
  };
  /**
   * C11 (owner decision 10): the request comes from a session whose **intent is read-only** (`REVIEW_CODE`,
   * `EXPLAIN_CODE`). This is the server-side enforcement of that intent: the field is set from the session's
   * resolved intent, never from a model argument and never from a caller-supplied `readOnly` flag, and when
   * it is `true` every tool outside `READ_TOOLS` / `PLAN_SAFE_TOOLS` / the read-only git tools is refused
   * with `review_code_read_only`. A review therefore cannot write to the repository, run a command or push a
   * branch — not because the prompt asked it not to, but because the engine will not authorise it.
   */
  readOnlyIntent?: boolean;
  /**
   * C11 (owner decision 5): the caller states that this request's approval is enforced at a **boundary with
   * a stronger binding** than this phase can compute — the git boundary consumes the record against the
   * payload hash of the exact write, rebuilt from the resolved branch. When it is `true` the approval phase
   * records the deferral instead of creating or consuming a record.
   *
   * Only two things set it: the internal git pre-flight, and nothing else. It is a server-side field on a
   * request the caller builds, never a model argument, and it cannot turn a hard deny into an allow — the
   * hard-deny phases (4, 4b, 4c) have already returned by the time it is read.
   */
  approvalDeferredByBoundary?: boolean;
  /**
   * C13 (owner blocker 1): the **runtime MCP identity** of this call, when the tool is a discovered MCP tool.
   *
   * It is set by the MCP run path (`mcp-run-path.ts`) from the tool's published record and the model's own
   * arguments — never by the model and never by the MCP server — and it has two effects, both of which exist so
   * that an approval for one call cannot be redeemed as another:
   *
   *  - the approval **payload** of this request is the canonical MCP material (`mcp-approval.ts`), which is the
   *    material the run path recomputes when it redeems the record, so the two sides hash the same bytes;
   *  - the payload hash of this request covers the tool's schema hash and the hash of the exact arguments, so
   *    "approve the call" cannot mean "approve this tool in general".
   */
  runtimeMcp?: McpApprovalRuntimeSubject | null;
}

export interface PolicyResult {
  decision: PolicyDecision;
  phase: PolicyPhase;
  reasons: string[];
  code?: string;
  status?: number;
  risk?: PolicyRisk;
  approvalId?: string;
  retryable?: boolean;
}

export interface PolicyEngineDeps {
  flags?: { assertEnabled(ctx: AuthContext, key: string, opts: { companyId: string }): Promise<boolean> };
  /**
   * Registry lookup: returns the published capability or undefined.
   *
   * C13 (owner decision 5): the lookup is `static → runtime → unknown`. The engine hands the port the tenant of
   * the request as an optional **scope**, so a runtime provider capability (an MCP tool) can be resolved from
   * the overlay of *that* tenant. The scope is additive: an implementation that ignores it (every pre-C13 port)
   * is still assignable and behaves exactly as before, and the engine itself never reads the overlay — the
   * order lives in one place (`lookupCapability`), which is what makes it testable.
   */
  capabilities?: {
    get(
      id: string,
      scope?: { workspaceId?: string; companyId?: string; projectId?: string },
    ): { id: string; status?: string; version?: number; requiresConfirmation?: boolean } | undefined;
  };
  classifier?: (command: string, opts?: unknown) => { risk: PolicyRisk; reasons?: string[] };
  approvals?: {
    requestApproval(ctx: AuthContext, companyId: string, input: Record<string, unknown>): Promise<{ id: string }>;
    consumeApproved(ctx: AuthContext, companyId: string, id: string, params: Record<string, unknown>): Promise<unknown>;
  };
  /**
   * C5: scoped approval rules (`session` | `project`). Consulted **only** in the approval phase, which
   * runs after `hard_deny`, the session-mode check, project rules and the network enforcement gate —
   * that ordering is what makes a rule unable to bypass any of them. `once` approvals create no rule.
   */
  approvalRules?: {
    findRule(ctx: AuthContext, query: {
      companyId: string; projectId?: string | null; sessionId?: string | null; action: string;
    }): Promise<{ id: string; scope: string; expiresAt?: string | null } | null>;
  };
  /**
   * C5: reads a decided approval so a rejection can carry the reviewer's comment back to the model.
   * Read-only and purely informational: it never changes a verdict.
   */
  getApproval?: (ctx: AuthContext, companyId: string, id: string) => Promise<{
    status?: string; notes?: string | null; comment?: string | null;
  } | null>;
  projectRules?: (ctx: AuthContext, companyId: string, projectId?: string) => Promise<{
    allowedTools?: string[]; deniedTools?: string[]; requireApprovalFor?: string[];
  } | null>;
  /**
   * Whether the sandbox actually enforces the egress allowlist (C4b). Default: not guaranteed.
   */
  networkEnforcement?: () => boolean;
  /**
   * C5a (D9): the company-level protected-branch policy (`code-protected-branches.ts`, wired in
   * `app.ts`). Consulted in the **hard-deny** phase for a git write — before the session mode, the
   * project rules, the network gate and the approval phase — so a push into a protected branch is
   * refused for every principal: the owner, `admin:all`, a session rule and an `approved: true` claim
   * included. The port reads the *company* list (with the built-in `main`/`master`/`release` default
   * when the store cannot be read), which is what makes that list the enforcement source of truth.
   * Absent means the port is not wired; the classifier's own force-push rule stays the only guard.
   */
  protectedBranches?: {
    evaluateGitWrite(
      ctx: AuthContext,
      companyId: string,
      input: GitWriteIntent,
    ): Promise<{
      allowed: boolean;
      code: string | null;
      reason: string;
      branch: string;
      operation: string;
      protected: boolean;
      policyRevision: number;
    }>;
  };
  /**
   * C11 (owner decision 3): the branch an unrefspec'd `git push` would write to.
   *
   * `git push` with no refspec pushes the **checked-out** branch, which is a property of the checkout and
   * not of the command line — the parser deliberately reports `branch: ""` for it. This port is how a
   * caller that can genuinely establish that branch (a sandbox probe, the host git service) supplies it.
   * When the port is absent, or answers with nothing, the write is **refused**
   * (`git_push_requires_resolved_branch`) instead of being treated as "no branch to protect". Wiring it is
   * an explicit, reviewable decision; the fail-closed default is the refusal.
   */
  gitBranchResolver?: (request: PolicyRequest) => Promise<string | null> | string | null;
  sessionMode?: (ctx: AuthContext, companyId: string, sessionId: string) => Promise<CodeSessionModeName | null>;
  /**
   * C5: records every decision (allow, deny and require_approval) as a structured Activity event.
   * This is observability, not a gate — the engine calls it after the verdict and never lets a
   * recorder failure change the decision (it logs the failure instead).
   */
  decisionRecorder?: (request: PolicyRequest, result: PolicyResult) => Promise<void> | void;
  logger?: { warn(obj: unknown, message?: string): void };
}

export class PolicyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly phase: PolicyPhase;
  constructor(code: string, message: string, status: number, phase: PolicyPhase, retryable = false) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.status = status;
    this.phase = phase;
    this.retryable = retryable;
  }
}

export const MASTER_FLAG = "coding_agent.enabled";
export const READ_FLAG = "code.read";
export const WRITE_FLAG = "code.write";
export const SHELL_FLAG = "code.shell";
/**
 * C11: git tooling has its own declared sub-flag (`feature-flags.ts`, off by default) and its own
 * capability group (`code-capability-groups.ts`). Before C11 the sub-flag existed while the mapping sent
 * every git tool to `code.write`, so enabling "writes" silently enabled git tooling too — the flag was
 * decorative. Git tools are named here so the mapping and the flag agree.
 */
export const GIT_FLAG = "code.git";
/**
 * C13 (owner decision 5): the sub-flag that gates **runtime MCP tools**. `code.mcp` has existed in
 * `CODE_AGENT_SUB_FLAGS` and in `CODE_FLAG_KEY_PATTERN` since the flag list was written, but nothing read it —
 * a flag that is settable and inert is worse than a missing one, because an operator who turns it off believes
 * something changed. It is its own flag rather than `code.write` because calling a third-party MCP server is a
 * different blast radius from editing a file: a workspace may want agent edits while forbidding outbound
 * server calls entirely.
 */
export const MCP_FLAG = MCP_RUNTIME_FLAG;

/**
 * Tools whose capability declaration demands a human approval. Derived from the shared capability
 * catalog so there is exactly one definition (a capability that declares `requiresConfirmation` must
 * be approved regardless of the command risk class).
 */
const APPROVAL_GATED_TOOLS = new Set(
  [...CODE_READ_CAPABILITIES, ...CODE_WRITE_CAPABILITIES, ...CODE_SHELL_CAPABILITIES, ...CODE_DEPS_CAPABILITIES]
    .filter((capability) => capability.requiresConfirmation === true)
    .map((capability) => capability.id),
);

/** The normalized modes of the owner's decision matrix. One definition, shared with `code-rbac.ts`. */
export type MatrixMode = CodeCanonicalSessionMode;

/**
 * Owner matrix: mode x risk. `hard_deny` is denied in every mode (phase 4 returns first, this row is
 * the documented backstop). The C1 session modes map onto these as:
 * plan -> plan, edit -> ask, auto -> auto_edit, full_auto -> full_auto_sandbox (mapping to confirm).
 */
export const MODE_RISK_MATRIX: Record<MatrixMode, Record<PolicyRisk, PolicyDecision>> = {
  plan: { safe: "allow", controlled: "deny", approval: "deny", hard_deny: "deny" },
  ask: { safe: "allow", controlled: "require_approval", approval: "require_approval", hard_deny: "deny" },
  auto_edit: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
  full_auto_sandbox: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
};

export function matrixModeFor(mode: string | null | undefined): MatrixMode {
  switch (mode) {
    case "plan": return "plan";
    case "edit": return "ask";
    case "ask": return "ask";
    case "auto": return "auto_edit";
    case "auto_edit": return "auto_edit";
    case "full_auto": return "full_auto_sandbox";
    case "full_auto_sandbox": return "full_auto_sandbox";
    default: return "plan";
  }
}

const READ_TOOLS = new Set([
  "code.fs.read", "code.fs.list", "code.fs.grep", "code.fs.tree",
  "code.symbols.outline", "code.project.info", "code.fs.diff",
  "code.shell.process.list", "code.shell.process.logs",
]);

/**
 * C9 narrow planning allowance — an explicit **name list**, deliberately not a membership in `READ_TOOLS`.
 *
 * These tools carry session metadata (a plan draft, the todo list) or a question to the user. None of them
 * can touch the workspace, the sandbox or the network, which is why `plan` mode has to allow them. But
 * read-only is a *broad* class that grows every time a read tool is published, and plan mode must not
 * inherit that growth: with `isReadOnlyTool` as the gate, any future read tool would silently become
 * available in the one mode whose entire purpose is to plan without touching code. The owner's decision is
 * therefore a narrow, reviewable list, read by the same three places that used to read the class — the
 * `plan` branch below, the runner's offered-tool filter, and the sub-flag/permission mapping.
 */
export const PLAN_SAFE_TOOLS = new Set(["code.plan.propose", "code.plan.update", "code.ask_user"]);

/**
 * C11 (owner decision 10): the tools a **read-only intent** may call beyond the reads and the plan-safe
 * metadata tools.
 *
 * `code.git.status/diff/log` write nothing — not the working tree, not the index, not the remote — so a
 * review may inspect history and the change set. `code.git.pr.comment` is here for the other half of the
 * owner's decision: a review's finding belongs on the pull request, and posting it is *not* a repository
 * write, so it is permitted — but only through **its own** approval record, bound to the pull-request number
 * and a hash of the comment text (`gitToolApprovalPayload`). An approval for a push or for opening a pull
 * request cannot be redeemed as a comment, because the payloads differ.
 */
export const REVIEW_SAFE_GIT_TOOLS = new Set(["code.git.status", "code.git.diff", "code.git.log", "code.git.pr.comment"]);

const SHELL_TOOLS = new Set(["code.shell.exec", "code.shell.process.start", "code.shell.process.stop"]);
const WRITE_TOOLS = new Set([
  "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move",
  "code.fs.delete", "code.fs.undo_last_turn", "code.verify.run",
]);

/** Exported for tests and for the wiring layer, so the mapping has exactly one definition. */
export function subFlagForTool(tool: string): string {
  // C13: a runtime MCP tool is gated by `code.mcp`. Checked first because the id space (`mcp:<connection>/<tool>`)
  // is disjoint from every static one, so there is no ordering question to get wrong.
  if (isRuntimeMcpTool(tool)) return MCP_FLAG;
  // Every shell capability (including the read-only process list/logs) is gated by the dedicated
  // `code.shell` sub-flag, so an operator can forbid command execution while still allowing edits.
  if (tool.startsWith("code.shell.")) return SHELL_FLAG;
  if (SHELL_TOOLS.has(tool)) return SHELL_FLAG;
  // C11: a git write is gated by the git sub-flag, not by `code.write`. Both are off by default, but
  // they are different blast radii: enabling file edits must not enable pushing to a remote.
  if (tool.startsWith("code.git.") || isGitWriteTool(tool)) return GIT_FLAG;
  if (READ_TOOLS.has(tool)) return READ_FLAG;
  // Plan/question tools never touch the workspace, so they follow the read flag rather than the write flag:
  // gating a *question* behind "writes allowed" would push the agent to guess instead of asking.
  if (PLAN_SAFE_TOOLS.has(tool)) return READ_FLAG;
  return WRITE_FLAG;
}
export function permissionForTool(tool: string): "workspace:read" | "workspace:write" {
  // Plan/question tools act on session metadata only, so the minimum workspace permission is a read — the
  // same level their capability records declare. Requiring `workspace:write` here would be stricter than
  // the tool's blast radius and would contradict the catalogue. The read-only git tools only read the
  // repository's state, so they are reads too.
  //
  // C13: a runtime MCP tool is neither, and it is deliberately mapped to the **stricter** of the two. It is not
  // derived from the tool name (an MCP tool called `read_file` is a claim by a third-party server, and a claim
  // is not a permission), so it can only be reached by a principal that already holds `workspace:write` or
  // `admin:all`.
  return READ_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool) || REVIEW_SAFE_GIT_TOOLS.has(tool)
    ? "workspace:read"
    : "workspace:write";
}
/**
 * `isReadOnlyTool` keeps its original meaning — the C2/C3 `READ_TOOLS` class — because `plan` mode reads it:
 * a git read tool must not become available in `plan` merely by being read-only. The read-only *git* class
 * is `REVIEW_SAFE_GIT_TOOLS`, and only the review gate below consults it.
 */
export function isReadOnlyTool(tool: string): boolean { return READ_TOOLS.has(tool); }
export function isShellTool(tool: string): boolean { return SHELL_TOOLS.has(tool); }
export function isPlanSafeTool(tool: string): boolean { return PLAN_SAFE_TOOLS.has(tool); }
/**
 * C11 (owner decision 10): the complete set of tools a **read-only intent** may call. It is the union of the
 * three narrow lists the engine already keeps — the read tools, the plan-safe metadata tools and the
 * read-only git tools — so "read-only" has exactly one definition and a new tool cannot join it by accident.
 */
export function isReviewSafeTool(tool: string): boolean {
  return READ_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool) || REVIEW_SAFE_GIT_TOOLS.has(tool);
}

export function isAdmin(ctx: AuthContext): boolean {
  // C5a: one definition of the admin vocabulary, shared with `code-rbac.ts`.
  return hasAdminPermission(ctx.permissions);
}

/**
 * An agent (or an agent token) must never be an approver. Principals that identify themselves as
 * agents are recognised conservatively: any doubt resolves to "agent".
 */
export function isAgentPrincipal(ctx: AuthContext): boolean {
  const subject = String(ctx.externalSubject ?? "");
  const userId = String(ctx.userId ?? "");
  return subject.startsWith("agent:") || subject.startsWith("service:") || userId.startsWith("agent:");
}

/** Network-capable executables: denied until C4b guarantees egress enforcement. */
const NETWORK_EXECUTABLES = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "nc", "netcat", "telnet", "ftp", "ping", "dig", "nslookup",
]);
const NETWORK_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "ci", "publish", "audit", "update", "exec"]),
  pnpm: new Set(["install", "i", "add", "publish", "update", "dlx"]),
  yarn: new Set(["install", "add", "publish", "up", "upgrade"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  poetry: new Set(["install", "add", "update"]),
  uv: new Set(["pip", "sync", "add"]),
  go: new Set(["get", "install", "mod"]),
  cargo: new Set(["install", "add", "update", "publish"]),
  git: new Set(["clone", "fetch", "pull", "push", "remote", "submodule", "ls-remote"]),
  docker: new Set(["pull", "push", "login"]),
  apt: new Set(["install", "update"]),
  aptget: new Set(["install", "update"]),
  gem: new Set(["install"]),
  composer: new Set(["require", "install", "update"]),
};

export function isNetworkCommand(command: string): boolean {
  const text = command.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/https?:\/\//i.test(text)) return true;
  // Split on shell separators, then look at the first word (and subcommand) of each segment.
  for (const segment of text.split(/\|\||&&|;|\|/)) {
    const words = segment.trim().split(" ").filter(Boolean);
    // Skip leading VAR=value assignments and wrappers such as `npx`/`sudo`.
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || words[index] === "sudo" || words[index] === "npx" || words[index] === "env")) index += 1;
    const executable = (words[index] ?? "").split("/").pop() ?? "";
    const subcommand = words[index + 1] ?? "";
    if (NETWORK_EXECUTABLES.has(executable)) return true;
    if (NETWORK_SUBCOMMANDS[executable]?.has(subcommand)) return true;
  }
  return false;
}

/** Conservative built-in path safety used when no canonical guard is injected. */
export function isUnsafePath(path: string): boolean {
  if (!path || path.includes("\0")) return true;
  const normalised = path.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:\//.test(normalised) || normalised.startsWith("~")) return true;
  return normalised.split("/").includes("..");
}

export class PolicyEngine {
  constructor(private readonly deps: PolicyEngineDeps) {}

  async evaluate(request: PolicyRequest): Promise<PolicyResult> {
    const result = await this.evaluateInternal(request);
    // C5: record the verdict (who, what, mode, rule, outcome). Deliberately after the decision is
    // computed and deliberately non-blocking for security: a failing recorder must not change, delay
    // or weaken the verdict, so the failure is logged and the result is returned unchanged.
    if (this.deps.decisionRecorder) {
      try {
        await this.deps.decisionRecorder(request, result);
      } catch (error) {
        this.deps.logger?.warn({ err: error }, "policy_decision_record_failed");
      }
    }
    return result;
  }

  private async evaluateInternal(request: PolicyRequest): Promise<PolicyResult> {
    const reasons: string[] = [];
    const { ctx, tool } = request;

    // Phase 1 — feature flags (master + sub-flag). No flag source means deny, never allow.
    const flags = this.deps.flags;
    if (!flags) return deny("policy_engine_unavailable", "Feature flags are not configured", 503, "feature_flag");
    try {
      await flags.assertEnabled(ctx, MASTER_FLAG, { companyId: request.companyId });
      await flags.assertEnabled(ctx, subFlagForTool(tool), { companyId: request.companyId });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "feature_disabled";
      return deny(code, error instanceof Error ? error.message : "Feature disabled", 403, "feature_flag");
    }
    reasons.push(`flag:${subFlagForTool(tool)}=on`);

    // Phase 2 — RBAC, including the "an agent can never be an approver" rule.
    const needsApprovalClaim = request.approved === true || Boolean(request.approvalId);
    if (needsApprovalClaim && isAgentPrincipal(ctx)) {
      return deny("agent_cannot_approve", "An agent or service principal cannot approve its own action", 403, "rbac");
    }
    const permission = permissionForTool(tool);
    if (!ctx.permissions.includes(permission) && !hasAdminPermission(ctx.permissions)) {
      return deny("permission_denied", `Missing permission: ${permission}`, 403, "rbac");
    }
    reasons.push(`permission:${permission}`);

    // Phase 3 — capability must exist in the registry and be usable.
    //
    // C13: the port is asked with the request's tenant, so the same call resolves a static capability first and,
    // when the id is not one, a runtime provider capability (an MCP tool) of that tenant. An id that is neither
    // is still `unknown_tool` — the "unknown ⇒ deny" half of the owner's lookup rule, unchanged.
    const registry = this.deps.capabilities;
    if (!registry) return deny("policy_engine_unavailable", "Capability registry is not configured", 503, "capability");
    const capability = registry.get(tool, { workspaceId: ctx.workspaceId, companyId: request.companyId, projectId: request.projectId });
    if (!capability) return deny("unknown_tool", `Unknown tool: ${tool}`, 404, "capability");
    if (capability.status === "deprecated") return deny("tool_deprecated", `Tool is deprecated: ${tool}`, 409, "capability");
    if (request.toolVersion !== undefined && capability.version !== undefined && capability.version !== request.toolVersion) {
      return deny("unknown_tool_version", `Unknown tool version: ${tool}@${request.toolVersion}`, 404, "capability");
    }
    reasons.push(`capability:${tool}@${request.toolVersion ?? capability.version ?? 1}`);

    // Phase 3b — capability groups (C5): the agent's groups ∩ the user's permissions ∩ project rules.
    // Runs before risk classification and approval on purpose: a tool the agent has no group for is
    // refused outright, so no approval is ever requested for something it was never allowed to do.
    if (request.capabilityGroups) {
      try {
        assertCapabilityGranted(request.capabilityGroups, tool);
        reasons.push("capability_group:granted");
      } catch (error) {
        const known = error as CodeCapabilityError;
        return deny(known.code ?? "capability_not_granted", known.message, known.httpStatus ?? 403, "capability_groups");
      }
    }

    // Phase 3c — policy changes and project trust (C5). Repository content is DATA: a file can neither
    // widen policy nor mark a project trusted, and reading one never changes state.
    if (request.policyChange && isAgentPrincipal(ctx)) {
      return deny("agent_cannot_change_policy", "An agent cannot change session mode or policy", 403, "trust");
    }
    if (request.repositoryInstructions && (request.repositoryInstructions.policyMutationAttempts ?? 0) > 0) {
      return deny(
        "repository_instruction_policy_change",
        "Repository content attempted to change policy; it is treated as data and is not applied",
        403,
        "trust",
      );
    }
    if (request.requiresProjectTrust && request.projectTrusted !== true) {
      return deny("project_not_trusted", "This action applies repository instructions and the project is not trusted", 403, "trust");
    }

    /**
     * C11 (owner decision 10) — the **read-only intent**, enforced here rather than requested in a prompt.
     *
     * `READ_ONLY_CODE_INTENTS` lists `EXPLAIN_CODE` and `REVIEW_CODE`, and until now the flag it produced was
     * carried around and read by nobody: a review session could ask for `code.git.push` and the request
     * would be judged like any other. This phase closes that: when the session's resolved intent is
     * read-only, any tool outside `READ_TOOLS` / `PLAN_SAFE_TOOLS` / the read-only git tools is refused
     * outright, before the session mode, the project rules and the approval phase — so an approval cannot
     * buy a write in a review either.
     *
     * The gate runs with the other hard-deny checks because it is one: "this session may not write" is not a
     * preference that a mode or a rule can widen.
     */
    if (request.readOnlyIntent === true && !isReviewSafeTool(tool)) {
      return {
        ...deny(
          "review_code_read_only",
          `This session's intent is read-only, so ${tool} cannot run: a review inspects the repository and writes nothing`,
          403,
          "hard_deny",
        ),
        risk: "hard_deny",
      };
    }

    // Phase 4 — hard deny: unreachable by any mode, role or approval.
    for (const path of request.paths ?? []) {
      if (isUnsafePath(path)) return deny("path_outside_workspace", `Unsafe path: ${path}`, 403, "hard_deny");
      if (path.replace(/\\/g, "/").split("/").includes(".git")) {
        return deny("git_dir_protected", "Writes inside .git are never allowed", 403, "hard_deny");
      }
    }
    // Phase 4b — protected branches (C5a D9, C11). This is the call site where the enforcement layer reads
    // the **company** protected-branch policy: the port below is `CodeProtectedBranchService
    // .evaluateGitWrite` (wired in `app.ts`), which loads `company_protected_branches` and answers
    // `protected_branch_write_denied` / `force_push_denied` for a git write. It runs before the mode,
    // the rules and the approval phase, and it deliberately consults no permission, role or approval —
    // so a protected-branch write cannot be lifted by an owner, by `admin:all`, by a session rule or by
    // `approved: true`. An unprotected branch falls through untouched and keeps its `approval` class.
    //
    // C11: the subject is a **typed** intent, never a command string. A git tool has no `command`, so the
    // phase reads `request.git` (and detects a git-write tool that carries none, refusing it), and an
    // unrefspec'd shell push is resolved or refused — the `branch: ""` hole is closed in
    // `gitWriteIntentsFor`. When both a command and a declared intent are present, **both** are evaluated.
    if (this.deps.protectedBranches) {
      const resolved = await this.gitWriteIntentsFor(request);
      if ("refusal" in resolved) return resolved.refusal;
      for (const intent of resolved.intents) {
        let decision: Awaited<ReturnType<NonNullable<PolicyEngineDeps["protectedBranches"]>["evaluateGitWrite"]>>;
        try {
          decision = await this.deps.protectedBranches.evaluateGitWrite(ctx, request.companyId, intent);
        } catch (error) {
          // Fail closed: a policy port that throws is not evidence that the branch is unprotected.
          this.deps.logger?.warn({ err: error, companyId: request.companyId }, "policy_protected_branch_check_failed");
          return deny(
            "protected_branch_policy_unavailable",
            "The protected-branch policy could not be evaluated; the git write is refused",
            503,
            "hard_deny",
            true,
          );
        }
        if (!decision.allowed) {
          reasons.push(`protected_branch:${decision.branch}=denied:${decision.code}`);
          return {
            ...deny(decision.code ?? "protected_branch_write_denied", decision.reason, 403, "hard_deny"),
            risk: "hard_deny",
          };
        }
        reasons.push(`protected_branch:${decision.branch}=not_protected`);
      }
    }
    // Phase 4c — migration safety (C6a). Running a database migration is a privileged operation, so this
    // phase runs with the other hard-deny checks: before the session mode, the project rules, the network
    // gate and the approval phase. Three things are refused outright and cannot be lifted by any mode,
    // role, standing rule or `approved: true` claim:
    //   - a production target (host/environment), including a connection string that resolves to prod;
    //   - an external target that is not a known development DataBackend;
    //   - an unknown target — fail closed, because "we could not tell" is not evidence of safety.
    // A development DataBackend is only reachable through the Data Studio migration engine (advisory lock,
    // checksum, snapshot-before-destructive, history); a hand-written SQL path is refused. Destructive
    // work (DROP/TRUNCATE/DELETE without WHERE/column removal/type change) requires a snapshot *and* an
    // approval, and a migration is never an implicit allow in any mode.
    let migrationVerdict: MigrationSafetyVerdict | undefined;
    if (request.command !== undefined || request.migration) {
      // The host/URL named **inside the command** wins over the target the caller declares: a command like
      // `psql -h db.prod.internal` must be judged by that host even when the call runs in the sandbox.
      const declared = request.migration?.target ?? {};
      const inferred = request.command ? inferMigrationTargetFromCommand(request.command) : null;
      const targetInput: MigrationTargetInput = inferred
        ? { ...declared, ...inferred }
        : {
          ...declared,
          ...(request.migration?.sandboxEphemeral === true ? { sandboxEphemeral: true } : {}),
          ...(request.migration?.dataStudioEngine === true ? { dataStudioBackend: true } : {}),
        };
      const hasTargetSignal = inferred !== null
        || declared.databaseUrl !== undefined || declared.host !== undefined || declared.environment !== undefined
        || declared.sandboxEphemeral === true || declared.dataStudioBackend === true;
      migrationVerdict = evaluateMigrationSafety({
        command: request.command,
        target: hasTargetSignal ? resolveMigrationTarget(targetInput) : null,
        ...(request.migration?.files ? { files: request.migration.files } : {}),
        ...(request.migration?.dataStudioEngine === true ? { dataStudioEngine: true } : {}),
        ...(request.migration?.rollbackPlan === true ? { rollbackPlan: true } : {}),
        ...(request.migration?.sandboxEphemeral === true ? { sandboxEphemeral: true } : {}),
      });
      if (migrationVerdict) {
        reasons.push(`migration:${migrationVerdict.target}:${migrationVerdict.decision}:${migrationVerdict.code}`);
        if (migrationVerdict.decision === "deny") {
          return {
            ...deny(migrationVerdict.code, migrationVerdict.reason, 403, "hard_deny"),
            risk: "hard_deny",
          };
        }
      }
    }
    let risk: PolicyRisk | undefined;
    if (request.command !== undefined) {
      const classifier = this.deps.classifier;
      if (!classifier) return deny("policy_engine_unavailable", "Command classifier is not configured", 503, "hard_deny");
      const classification = classifier(request.command, {});
      risk = classification.risk;
      reasons.push(`risk:${risk}`);
      if (risk === "hard_deny") {
        return { ...deny("command_hard_denied", "Command is never allowed", 403, "hard_deny"), risk };
      }
    }

    // Phase 5 — session mode.
    const mode = request.sessionMode ?? (request.sessionId && this.deps.sessionMode
      ? await this.deps.sessionMode(ctx, request.companyId, request.sessionId).catch(() => null)
      : null);
    if (isShellTool(tool) && mode === null) {
      return deny("session_mode_denied", "Shell tools require an explicit session mode (default is plan)", 403, "session_mode");
    }
    // Phase 5 — session mode. The C1 session modes are mapped onto the owner's decision matrix
    // (the mapping is explicit and subject to confirmation): plan -> plan, edit -> ask,
    // auto -> auto_edit, full_auto -> full_auto_sandbox.
    const matrixMode = matrixModeFor(mode);
    // File mutations are not risk-classified, so the read-only rule of `plan` applies to them here;
    // shell commands in `plan` are decided by the mode x risk matrix further down (safe is allowed,
    // controlled and approval are denied there).
    if (mode === "plan" && !isShellTool(tool) && !isReadOnlyTool(tool) && !isPlanSafeTool(tool)) {
      // Allowed in `plan`: read/search tools plus the narrow `PLAN_SAFE_TOOLS` name list — nothing else. A new
      // read tool does not widen this (that is the point of keeping the list separate from `READ_TOOLS`), and
      // no workspace, sandbox or git mutation is ever allowed here: those are neither read-only nor plan-safe,
      // so they fall through to this denial.
      return deny("session_mode_denied", "Session mode plan allows read-only and planning tools only", 403, "session_mode");
    }
    if (mode !== null && mode !== undefined) reasons.push(`mode:${mode}`, `matrix_mode:${matrixMode}`);

    // Phase 6 — project rules (no port yet: no extra restrictions, stated in the reasons).
    if (this.deps.projectRules) {
      const rules = await this.deps.projectRules(ctx, request.companyId, request.projectId).catch(() => null);
      if (rules) {
        if (rules.deniedTools?.includes(tool)) {
          return deny("project_rule_denied", "Denied by project rules", 403, "project_rules");
        }
        if (rules.allowedTools?.length && !rules.allowedTools.includes(tool)) {
          return deny("project_rule_denied", "Tool is not in the project allowlist", 403, "project_rules");
        }
        if (rules.requireApprovalFor?.includes(tool)) {
          return this.requireApproval(request, reasons, risk, "project_rules");
        }
      }
      reasons.push("project_rules:applied");
    } else {
      reasons.push("project_rules:none");
    }

    // Phase 7 — network enforcement gate. This is deliberately *not* an approval: it is a hard
    // availability gate that precedes the mode/risk/approval matrix, so a network command fails
    // closed (503, retryable) in every mode — including full_auto_sandbox — and even when an approval
    // was granted, until C4b guarantees enforced egress.
    if (request.command !== undefined && isNetworkCommand(request.command)) {
      const enforced = request.networkEnforcementGuaranteed === true
        || this.deps.networkEnforcement?.() === true;
      if (!enforced) {
        return deny(
          "network_enforcement_unavailable",
          "Network commands are disabled: the sandbox does not yet guarantee egress allowlist enforcement (C4b)",
          503,
          "network_enforcement",
          true,
        );
      }
      reasons.push("network:enforced");
    }

    // C4a: a dependency change whose source is not a registry entry, that would reconfigure the
    // registry, or that would run lifecycle scripts is never an implicit allow — it needs a human
    // approval even in `full_auto_sandbox`, because it runs third-party code with the project's rights.
    if (request.deps) {
      const depsApprovalReasons: string[] = [];
      if (request.deps.source !== undefined && request.deps.source !== "registry") {
        depsApprovalReasons.push(`deps:source=${request.deps.source}`);
      }
      if (request.deps.registryChange === true) depsApprovalReasons.push("deps:registry_change");
      if (request.deps.installScripts === true) depsApprovalReasons.push("deps:lifecycle_scripts");
      if (depsApprovalReasons.length) {
        reasons.push(...depsApprovalReasons);
        return this.requireApproval(request, reasons, risk, "approval");
      }
    }

    // C6a: a migration verdict of `require_approval` is applied here — after the mode, the project rules
    // and the network gate, but **before** the mode x risk matrix, so `full_auto_sandbox` cannot turn a
    // migration into an automatic allow. The destructive/snapshot detail travels into the approval payload
    // so the reviewer sees what the migration would do.
    if (migrationVerdict) {
      reasons.push(`migration:${migrationVerdict.code}`);
      return this.requireApproval(request, reasons, risk ?? "approval", "approval", {
        target: migrationVerdict.target,
        destructive: migrationVerdict.destructive,
        requiresSnapshot: migrationVerdict.requiresSnapshot,
        executionPath: migrationVerdict.executionPath,
        codes: migrationVerdict.codes,
        ...(migrationVerdict.planCommand ? { plan: migrationVerdict.planCommand } : {}),
      });
    }

    // Phase 8 — approval and the mode x risk matrix. `hard_deny` already returned in phase 4, and the
    // matrix below is the only place that decides safe/controlled/approval for a classified command.
    const capabilityRequiresConfirmation =
      (capability as { requiresConfirmation?: boolean }).requiresConfirmation === true
      || APPROVAL_GATED_TOOLS.has(tool);
    if (risk !== undefined && mode !== null && mode !== undefined) {
      const verdict = MODE_RISK_MATRIX[matrixMode][risk];
      reasons.push(`matrix:${matrixMode}/${risk}=${verdict}`);
      if (verdict === "deny") {
        return deny("session_mode_denied", `Session mode ${matrixMode} denies ${risk} commands`, 403, "risk_classification", false);
      }
      if (verdict === "require_approval") {
        return this.requireApproval(request, reasons, risk, "approval");
      }
    }
    // The matrix already decided the verdict for a classified command; what remains is the capability
    // declaration (for example code.fs.delete), which always needs a human approval.
    if (capabilityRequiresConfirmation) {
      const phase: PolicyPhase = risk === undefined ? "capability" : "approval";
      return this.requireApproval(request, reasons, risk, phase);
    }
    if (matrixMode === "full_auto_sandbox") reasons.push("full_auto_sandbox:no_extra_confirmation");

    return { decision: "allow", phase: "approval", reasons, risk, status: 200 };
  }

  /**
   * C11 (owner decision 3): every git write this request performs, as a typed intent.
   *
   * Three sources, and a refusal is always preferred over a guess:
   *  - `request.git` — the typed intent a git tool supplies. It must be complete and internally
   *    consistent, otherwise `git_write_intent_invalid` (a `force: true` "push", or no branch at all, is
   *    not something to resolve in either direction);
   *  - `request.command` — the shell path. A refspec names its branch; a push with **no** refspec gets its
   *    branch from `gitBranchResolver` and is refused with `git_push_requires_resolved_branch` when the
   *    resolver is absent, throws or answers with nothing. `branch: ""` therefore never reaches a decision;
   *  - a git-write **tool** that supplies neither is refused with `git_write_intent_required`, because a
   *    tool call has no command line and must not slip past the protected-branch phase.
   *
   * A command and a declared intent are both evaluated when both are present: a caller cannot declare a
   * harmless target while the command line writes to another one.
   */
  private async gitWriteIntentsFor(
    request: PolicyRequest,
  ): Promise<{ intents: GitWriteIntent[] } | { refusal: PolicyResult }> {
    const intents: GitWriteIntent[] = [];
    if (request.git) {
      const declared = normalizeGitWriteIntent(request.git);
      if (!declared) {
        return {
          refusal: {
            ...deny(
              GIT_WRITE_INTENT_INVALID,
              "The git write request is incomplete or inconsistent (operation, target branch and force must agree)",
              403,
              "hard_deny",
            ),
            risk: "hard_deny",
          },
        };
      }
      intents.push(declared);
    }
    if (request.command !== undefined) {
      for (const attempt of detectGitWriteAttempts(request.command)) {
        let resolved: string | null = null;
        if (!normalizeGitBranch(attempt.branch)) {
          try {
            resolved = normalizeGitBranch((await this.deps.gitBranchResolver?.(request)) ?? "");
          } catch (error) {
            // A resolver that fails is not evidence that the branch is unprotected.
            this.deps.logger?.warn({ err: error, companyId: request.companyId }, "policy_git_branch_resolution_failed");
            resolved = "";
          }
        }
        const intent = gitWriteIntentFromShellAttempt(attempt, resolved);
        if (!intent) {
          return {
            refusal: {
              ...deny(
                GIT_PUSH_REQUIRES_RESOLVED_BRANCH,
                "A git push without a refspec writes to the branch of the checkout; that branch could not be " +
                  "resolved, so the write is refused rather than assumed to be unprotected",
                403,
                "hard_deny",
              ),
              risk: "hard_deny",
            },
          };
        }
        intents.push(intent);
      }
    }
    if (!intents.length && isGitWriteTool(request.tool)) {
      return {
        refusal: {
          ...deny(
            GIT_WRITE_INTENT_REQUIRED,
            `Tool ${request.tool} performs a remote git write, so it must carry the typed git intent ` +
              "(operation, target branch, remote, force); without it the write cannot be checked against the " +
              "protected-branch policy",
            403,
            "hard_deny",
          ),
          risk: "hard_deny",
        },
      };
    }
    return { intents };
  }

  private async requireApproval(
    request: PolicyRequest, reasons: string[], risk: PolicyRisk | undefined, phase: PolicyPhase,
    details?: Record<string, unknown>,
  ): Promise<PolicyResult> {
    const approvals = this.deps.approvals;
    /**
     * C11 (owner decision 5): the approval is deferred to a boundary that binds it more strongly than this
     * phase can. The git boundary rebuilds the payload from the branch it is about to write and consumes the
     * record with that hash, so creating a record here (or spending the caller's) would be strictly worse:
     * it would either add a second, weaker approval or leave the boundary with nothing to verify.
     *
     * The check sits **after** every hard-deny phase, so a deferred approval can never turn a refusal into an
     * allow; and it sits before the missing-port refusal, because a deployment whose approval gateway is not
     * wired here may still have a fully wired git boundary.
     */
    if (request.approvalDeferredByBoundary === true) {
      return {
        decision: "allow", phase, risk, status: 200,
        reasons: [...reasons, APPROVAL_DEFERRED_REASON],
      };
    }
    if (!approvals) return deny("approval_unavailable", "Approval system is not configured", 503, phase);
    /**
     * C13 (owner blocker 1): the approval **material** of a runtime MCP call.
     *
     * `mcpApprovalPayloadFor` is the one builder both sides use (see `mcp-approval.ts` for why that is the whole
     * point). Two consequences are deliberate:
     *
     *  - the material is handed to the durable approval store as its `inputPayload`, so the row's own
     *    `payload_hash` is the hash of *this* call — the same value the run path will present when it redeems
     *    the record. Without it the store would hash an empty payload and no runtime MCP approval could ever be
     *    consumed;
     *  - the repo-shaped fields (`toolName`, `actionSummary`, `runId`, `agentId`, `riskLevel`, `ttlMs`) travel
     *    with it, because `CompanyApprovalsRepository.requestApproval` is the real implementation behind this
     *    port and it needs exactly those to write the row. A deployment whose approval gateway is the store
     *    therefore creates a real, redeemable, one-shot approval for an MCP call.
     */
    // A `PolicyRequest` structurally satisfies `McpApprovalSubject`, which is what lets the run path and this
    // phase build the material from the same values with the same function.
    const mcpPayload = mcpApprovalPayloadFor(request);
    const runtimeApprovalFields = mcpPayload
      ? {
          toolName: request.tool,
          actionSummary: `Runtime MCP tool ${request.tool} requires an approval for this exact call`,
          inputPayload: mcpPayload,
          runId: request.runId ?? "",
          agentId: request.agentId ?? "",
          riskLevel: "high" as const,
          // A paused run can outlive a tab and a process restart, so the window is the store's own maximum.
          ttlMs: MCP_APPROVAL_TTL_MS,
        }
      : {};
    if (request.approved === true || request.approvalId) {
      const expected = payloadHashFor(request);
      try {
        await approvals.consumeApproved(request.ctx, request.companyId, String(request.approvalId ?? request.toolCallId ?? ""), {
          ...(mcpPayload
            ? {
                // The consuming side of the same material: `run_id`, `agent_id`, `tool_name` and the payload
                // hash are all matched by the store's own atomic statement.
                runId: request.runId ?? "",
                agentId: request.agentId ?? "",
                toolName: request.tool,
                inputPayload: mcpPayload,
              }
            : {}),
          payloadHash: expected, tool: request.tool, toolCallId: request.toolCallId,
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "approval_invalid";
        // A rejection is not a failure to consume: the reviewer's comment (redacted, capped, and
        // explicitly marked as data) is what the model needs in order to change its approach.
        const rejection = await this.describeRejection(request, code);
        if (rejection) return rejection;
        return deny(code, error instanceof Error ? error.message : "Approval could not be consumed", 409, phase);
      }
      return { decision: "allow", phase, reasons: [...reasons, "approval:consumed"], risk, status: 200 };
    }
    // C5: a standing rule for this action short-circuits the request. Never consulted for an approval
    // raised in the `project_rules` phase, because that phase precedes the network enforcement gate.
    if (this.deps.approvalRules && phase !== "project_rules") {
      const action = approvalActionFor(request);
      const rule = await this.deps.approvalRules
        .findRule(request.ctx, {
          companyId: request.companyId, projectId: request.projectId ?? null,
          sessionId: request.sessionId ?? null, action,
        })
        .catch(() => null);
      if (rule) {
        request.ruleRef = { scope: rule.scope, id: rule.id };
        return {
          decision: "allow", phase, risk, status: 200,
          reasons: [...reasons, `approval:rule:${rule.scope}`, `approval:rule_id:${rule.id}`, `approval:action:${action}`],
        };
      }
    }
    try {
      const created = await approvals.requestApproval(request.ctx, request.companyId, {
        tool: request.tool,
        payloadHash: payloadHashFor(request),
        toolCallId: request.toolCallId,
        // The scope a caller asks for is recorded on the request; `once` (the default) creates no rule.
        approvalScope: request.approvalScope ?? "once",
        approvalTimeoutMs: request.approvalTimeoutMs ?? null,
        digest: digestOf(request.command ?? request.paths?.join(",") ?? request.tool),
        // C6a: what a migration would do (target, destructive, snapshot, plan). Metadata only — no SQL,
        // no connection string and no credentials.
        ...(details ? { migration: details } : {}),
        // C13: the durable store's own fields plus the canonical MCP material, for a runtime MCP call.
        ...runtimeApprovalFields,
      });
      return {
        decision: "require_approval", phase, reasons: [...reasons, "approval:required"],
        code: "approval_required", status: 403, risk, approvalId: created.id,
      };
    } catch (error) {
      this.deps.logger?.warn({ err: error }, "policy_approval_request_failed");
      return deny("approval_unavailable", "Approval request could not be created", 503, phase);
    }
  }

  /**
   * C5: turns a rejected approval into a structured `approval_denied` result carrying the reviewer's
   * comment. Returns null when the approval was not actually rejected, so every other consumption
   * failure keeps its existing code and status.
   */
  private async describeRejection(request: PolicyRequest, code: string): Promise<PolicyResult | null> {
    if (!this.deps.getApproval) return null;
    const approvalId = String(request.approvalId ?? request.toolCallId ?? "");
    const approval = await this.deps.getApproval(request.ctx, request.companyId, approvalId).catch(() => null);
    const status = String(approval?.status ?? "").toLowerCase();
    if (status !== "rejected" && code !== "approval_rejected") return null;
    const comment = redactDenyComment(approval?.comment ?? approval?.notes);
    return {
      decision: "deny", phase: "approval", status: 403, retryable: false,
      code: "approval_denied",
      reasons: ["approval:rejected", ...(comment ? [`approval:comment:${comment}`] : [])],
    };
  }
}

function deny(code: string, message: string, status: number, phase: PolicyPhase, retryable = false): PolicyResult {
  return { decision: "deny", phase, reasons: [message], code, status, retryable };
}

/**
 * Deterministic payload hash: an approval must be consumed with exactly the payload that was
 * approved, so substituting the command or paths between approval and execution is detected.
 *
 * C11: when the request is a git write, the **typed target** is part of the material — `gitOperation`,
 * `sourceBranch`, `targetBranch`, `remoteBranch`, `remote`, `force` and the credential reference. Before
 * C11 a branch or a remote was not in the hash at all, so an approval granted for one push could be
 * consumed for a push to a different branch of the same repository. The key is added only when a git
 * intent is present, so every non-git request keeps its previous hash.
 *
 * C11 (owner decision 13): the same material carries the **repository initialization** fact, and only when
 * the write has to create the repository (`bindsRepositoryInitialization`, shared with
 * `gitApprovalPayload` so the two hashers cannot drift). An approval granted for "push into an existing
 * repository" therefore hashes differently from one granted for "create the repository and push", while
 * every write against an existing repository keeps the exact bytes — and the exact hash — it had before.
 *
 * C13 (owner blocker 1): a **runtime MCP call** adds the tool's runtime identity — `providerId`,
 * `connectionId`, `toolName`, the schema hash and the hash of the exact (normalised) arguments. An approval
 * for one MCP call therefore cannot be spent on another: a different tool, a server that changed its input
 * schema, or different arguments all move the hash. The key is added only when the request carries
 * `runtimeMcp`, so every other request keeps the exact bytes — and the exact hash — it had before.
 */
export function payloadHashFor(request: PolicyRequest): string {
  const material = JSON.stringify({
    tool: request.tool,
    command: request.command ?? null,
    paths: [...(request.paths ?? [])].sort(),
    projectId: request.projectId ?? null,
    sessionId: request.sessionId ?? null,
    ...(request.git
      ? {
          git: {
            gitOperation: request.git.gitOperation,
            sourceBranch: request.git.sourceBranch ?? null,
            targetBranch: request.git.targetBranch ?? null,
            remoteBranch: request.git.remoteBranch ?? null,
            remote: request.git.remote ?? null,
            force: request.git.force === true,
            credentialId: request.git.credentialId ?? null,
            ...(bindsRepositoryInitialization(request.git) ? { repositoryInitialized: false } : {}),
          },
        }
      : {}),
    ...(request.runtimeMcp
      ? {
          runtimeMcp: {
            providerId: request.runtimeMcp.providerId,
            connectionId: request.runtimeMcp.connectionId,
            toolName: request.runtimeMcp.toolName,
            schemaHash: request.runtimeMcp.schemaHash,
            argsHash: request.runtimeMcp.argsHash,
          },
        }
      : {}),
  });
  return fnv1a(material);
}

/** Non-cryptographic digest used only for logs (never for security decisions). */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function digestOf(value: string): string { return fnv1a(value); }

/**
 * C5: the canonical action a scoped rule is keyed by. The implementation lives in
 * `code-approval-scope.ts` so the grant path and this enforcement path cannot drift apart; it is
 * re-exported here because the policy surface is where callers look for it.
 */
export { approvalActionFor } from "./code-approval-scope";
