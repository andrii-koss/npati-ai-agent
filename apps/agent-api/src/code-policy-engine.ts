import type { AuthContext } from "@npati/workspace";
import { CODE_READ_CAPABILITIES, CODE_SHELL_CAPABILITIES, CODE_WRITE_CAPABILITIES, CODE_DEPS_CAPABILITIES } from "@npati/shared";

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
  | "feature_flag" | "rbac" | "capability" | "hard_deny" | "network_enforcement" | "session_mode"
  | "project_rules" | "risk_classification" | "approval";
export type PolicyRisk = "safe" | "controlled" | "approval" | "hard_deny";
export type CodeSessionModeName = "plan" | "edit" | "auto" | "full_auto";

export interface PolicyRequest {
  ctx: AuthContext;
  companyId: string;
  projectId?: string;
  sessionId?: string;
  tool: string;
  toolVersion?: number;
  command?: string;
  paths?: string[];
  sessionMode?: CodeSessionModeName;
  approved?: boolean;
  approvalId?: string;
  toolCallId?: string;
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
  projectRules?: (ctx: AuthContext, companyId: string, projectId?: string) => Promise<{
    allowedTools?: string[]; deniedTools?: string[]; requireApprovalFor?: string[];
  } | null>;
  /** Whether the sandbox actually enforces the egress allowlist (C4b). Default: not guaranteed. */
  networkEnforcement?: () => boolean;
  sessionMode?: (ctx: AuthContext, companyId: string, sessionId: string) => Promise<CodeSessionModeName | null>;
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

/** The normalized modes of the owner's decision matrix. */
export type MatrixMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";

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
  return WRITE_FLAG;
}
export function permissionForTool(tool: string): "workspace:read" | "workspace:write" {
  return READ_TOOLS.has(tool) ? "workspace:read" : "workspace:write";
}
export function isReadOnlyTool(tool: string): boolean { return READ_TOOLS.has(tool); }
export function isShellTool(tool: string): boolean { return SHELL_TOOLS.has(tool); }

export function isAdmin(ctx: AuthContext): boolean {
  return ctx.permissions.some((permission) => ["*", "owner", "admin:all"].includes(permission));
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
    if (!ctx.permissions.includes(permission) && !isAdmin(ctx)) {
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

    // Phase 4 — hard deny: unreachable by any mode, role or approval.
    for (const path of request.paths ?? []) {
      if (isUnsafePath(path)) return deny("path_outside_workspace", `Unsafe path: ${path}`, 403, "hard_deny");
      if (path.replace(/\\/g, "/").split("/").includes(".git")) {
        return deny("git_dir_protected", "Writes inside .git are never allowed", 403, "hard_deny");
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
    if (mode === "plan" && !isShellTool(tool) && !isReadOnlyTool(tool)) {
      return deny("session_mode_denied", "Session mode plan allows read-only tools only", 403, "session_mode");
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
        return deny(code, error instanceof Error ? error.message : "Approval could not be consumed", 409, phase);
      }
      return { decision: "allow", phase, reasons: [...reasons, "approval:consumed"], risk, status: 200 };
    }
    try {
      const created = await approvals.requestApproval(request.ctx, request.companyId, {
        tool: request.tool,
        payloadHash: payloadHashFor(request),
        toolCallId: request.toolCallId,
        digest: digestOf(request.command ?? request.paths?.join(",") ?? request.tool),
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
