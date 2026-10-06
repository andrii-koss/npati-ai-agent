import type { AuthContext } from "@npati/workspace";
import { CODE_READ_CAPABILITIES, CODE_SHELL_CAPABILITIES, CODE_WRITE_CAPABILITIES, CODE_DEPS_CAPABILITIES } from "@npati/shared";
import { assertCapabilityGranted, CodeCapabilityError } from "./code-capability-groups";
import { approvalActionFor, redactDenyComment } from "./code-approval-scope";
import { hasAdminPermission, type CodeCanonicalSessionMode } from "./code-rbac";
import { detectGitWriteAttempts } from "./code-shell-classifier";
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
 * Phase order is fixed and short-circuits on the first refusal:
 *   1 feature_flag -> 2 rbac -> 3 capability -> 4 hard_deny -> 5 session_mode ->
 *   6 project_rules -> 7 risk_classification -> 8 approval
 */

export type PolicyDecision = "allow" | "deny" | "require_approval";
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
  /** Registry lookup: returns the published capability or undefined. */
  capabilities?: { get(id: string): { id: string; status?: string; version?: number } | undefined };
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
      input: { operation: "push" | "force_push"; branch: string },
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

const SHELL_TOOLS = new Set(["code.shell.exec", "code.shell.process.start", "code.shell.process.stop"]);
const WRITE_TOOLS = new Set([
  "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move",
  "code.fs.delete", "code.fs.undo_last_turn", "code.verify.run",
]);

/** Exported for tests and for the wiring layer, so the mapping has exactly one definition. */
export function subFlagForTool(tool: string): string {
  // Every shell capability (including the read-only process list/logs) is gated by the dedicated
  // `code.shell` sub-flag, so an operator can forbid command execution while still allowing edits.
  if (tool.startsWith("code.shell.")) return SHELL_FLAG;
  if (SHELL_TOOLS.has(tool)) return SHELL_FLAG;
  if (READ_TOOLS.has(tool)) return READ_FLAG;
  // Plan/question tools never touch the workspace, so they follow the read flag rather than the write flag:
  // gating a *question* behind "writes allowed" would push the agent to guess instead of asking.
  if (PLAN_SAFE_TOOLS.has(tool)) return READ_FLAG;
  return WRITE_FLAG;
}
export function permissionForTool(tool: string): "workspace:read" | "workspace:write" {
  // Plan/question tools act on session metadata only, so the minimum workspace permission is a read — the
  // same level their capability records declare. Requiring `workspace:write` here would be stricter than
  // the tool's blast radius and would contradict the catalogue.
  return READ_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool) ? "workspace:read" : "workspace:write";
}
export function isReadOnlyTool(tool: string): boolean { return READ_TOOLS.has(tool); }
export function isShellTool(tool: string): boolean { return SHELL_TOOLS.has(tool); }
export function isPlanSafeTool(tool: string): boolean { return PLAN_SAFE_TOOLS.has(tool); }

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
    const registry = this.deps.capabilities;
    if (!registry) return deny("policy_engine_unavailable", "Capability registry is not configured", 503, "capability");
    const capability = registry.get(tool);
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

    // Phase 4 — hard deny: unreachable by any mode, role or approval.
    for (const path of request.paths ?? []) {
      if (isUnsafePath(path)) return deny("path_outside_workspace", `Unsafe path: ${path}`, 403, "hard_deny");
      if (path.replace(/\\/g, "/").split("/").includes(".git")) {
        return deny("git_dir_protected", "Writes inside .git are never allowed", 403, "hard_deny");
      }
    }
    // Phase 4b — protected branches (C5a D9). This is the call site where the enforcement layer reads
    // the **company** protected-branch policy: the port below is `CodeProtectedBranchService
    // .evaluateGitWrite` (wired in `app.ts`), which loads `company_protected_branches` and answers
    // `protected_branch_write_denied` / `force_push_denied` for a git write. It runs before the mode,
    // the rules and the approval phase, and it deliberately consults no permission, role or approval —
    // so a protected-branch write cannot be lifted by an owner, by `admin:all`, by a session rule or by
    // `approved: true`. An unprotected branch falls through untouched and keeps its `approval` class.
    if (request.command !== undefined && this.deps.protectedBranches) {
      const attempts = detectGitWriteAttempts(request.command);
      for (const attempt of attempts) {
        let decision: Awaited<ReturnType<NonNullable<PolicyEngineDeps["protectedBranches"]>["evaluateGitWrite"]>>;
        try {
          decision = await this.deps.protectedBranches.evaluateGitWrite(ctx, request.companyId, attempt);
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

  private async requireApproval(
    request: PolicyRequest, reasons: string[], risk: PolicyRisk | undefined, phase: PolicyPhase,
    details?: Record<string, unknown>,
  ): Promise<PolicyResult> {
    const approvals = this.deps.approvals;
    if (!approvals) return deny("approval_unavailable", "Approval system is not configured", 503, phase);
    if (request.approved === true || request.approvalId) {
      const expected = payloadHashFor(request);
      try {
        await approvals.consumeApproved(request.ctx, request.companyId, String(request.approvalId ?? request.toolCallId ?? ""), {
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
 */
export function payloadHashFor(request: PolicyRequest): string {
  const material = JSON.stringify({
    tool: request.tool,
    command: request.command ?? null,
    paths: [...(request.paths ?? [])].sort(),
    projectId: request.projectId ?? null,
    sessionId: request.sessionId ?? null,
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
