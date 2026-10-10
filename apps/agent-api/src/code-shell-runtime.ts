import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { classifyShellCommand } from "./code-shell-classifier";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import type { FeatureFlagService } from "./feature-flags";
import type { PolicyEngine } from "./code-policy-engine";
import type { AuditLogService } from "./audit-log";
import { SecretLeaseProvider, redactLeaseValues, type SecretEnvironmentReference } from "./code-secret-lease";
import { CredentialMasker } from "./security-guardrails";
import type { CodeAsyncProcessService, AsyncProcessReceipt } from "./code-async-process";
import type { CodeProcessManager } from "./code-process-manager";
import { MIGRATION_CODES, assertNoProductionCredentialsVisible } from "./code-migration-safety";

/**
 * C4: shell runtime for the coding agent.
 *
 * Hard rules encoded here:
 * - commands run **only** inside the sandbox: the single execution path is the injected
 *   `CodeShellSandboxPort`; without it every call is refused with `sandbox_unavailable` (503). There is
 *   no `child_process` fallback anywhere in this module.
 * - a command is classified before anything is executed: `hard_deny` never reaches the port,
 *   `approval` requires an explicit approval, `controlled` needs the `code.shell` sub-flag.
 * - secrets never enter the persistent shell session: only non-secret variables are remembered, and
 *   lease values are delivered through the sandbox's own `environmentReferences` mechanism for exactly
 *   one call, then revoked.
 */

export type ShellRisk = "safe" | "controlled" | "approval" | "hard_deny";

export interface ShellClassification {
  risk: ShellRisk;
  reasons: string[];
  matched?: string[];
  /** Install/build work gets the longer timeout class from the shared terminal policy. */
  timeoutClass?: "default" | "install" | "install_build";
}

/** Structural contract of the classifier owned by another C4 workstream. */
export interface ShellClassifier {
  classify(command: string, options?: { allowlistHosts?: string[] }): ShellClassification;
}

/**
 * Default classifier: the shared C4 classifier module. It is injected as an object so tests can
 * substitute their own, and it is never re-implemented here.
 */
export const defaultShellClassifier: ShellClassifier = {
  classify: (command, options) => {
    const result = classifyShellCommand(command, options?.allowlistHosts ? { allowlist: options.allowlistHosts } : {});
    return { risk: result.risk, reasons: result.reasons, matched: result.matched, timeoutClass: result.timeoutClass };
  },
};

export interface CodeShellSandboxPort {
  execute(input: {
    context: AuthContext;
    companyId: string;
    projectId: string;
    agentId: string;
    command: string;
    cwd?: string;
    environmentReferences?: Record<string, SecretEnvironmentReference>;
    approved?: boolean;
    timeoutMs?: number;
    runId?: string;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; status?: string; sandboxId?: string; riskLevel?: string }>;
}

export interface CodeShellExecInput {
  leaseOwner?: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  agentId?: string;
  command: string;
  cwd?: string;
  /** Non-secret variables for this call; they become part of the session state. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Lease ids issued for this exact tool call. */
  secretLeaseIds?: string[];
  toolCallId: string;
  approved?: boolean;
  runId?: string;
}

export interface CodeShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  risk: ShellRisk;
  classification: ShellClassification;
  approvalRequired?: boolean;
  leaseIds?: string[];
  cwd: string;
  sessionId: string;
  sandboxId?: string;
}

export class ShellRuntimeError extends Error {
  readonly status = "error" as const;
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShellRuntimeError";
  }
  toJSON(): Record<string, unknown> {
    return { status: this.status, code: this.code, message: this.message, httpStatus: this.httpStatus, retryable: this.retryable, details: this.details };
  }
}

export interface CodeShellSession {
  sessionId: string;
  companyId: string;
  projectId: string;
  cwd: string;
  /** Non-secret variables only; secrets are never stored here. */
  env: Record<string, string>;
  updatedAt: number;
  turnCount: number;
}

export interface CodeShellRuntimeOptions {
  processes?: CodeProcessManager;
  sandbox?: CodeShellSandboxPort;
  classifier?: ShellClassifier;
  flags?: FeatureFlagService;
  /**
   * C4 owner decision: the centralized PolicyEngine is the single decision point. Every execution path
   * must call it before touching the sandbox, and a missing engine means deny, never "run anyway".
   */
  policy?: PolicyEngine;
  audit?: Pick<AuditLogService, "record">;
  leases?: SecretLeaseProvider;
  limits?: Partial<CodeAgentLimits>;
  /** Session TTL; an idle session is dropped and its environment forgotten. */
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  /**
   * C6a: which hosts count as production and which as development DataBackends. The shell always declares
   * the **ephemeral sandbox** as its execution target, but a command that names a host itself
   * (`psql -h db.prod.internal`) is judged by that host, so this list is what makes such a command a hard
   * deny. Values fall back to `NPATI_CODE_PRODUCTION_URLS` / `NPATI_CODE_PRODUCTION_HOSTS` /
   * `NPATI_CODE_DEV_DB_HOSTS` / `NPATI_CODE_PRODUCTION_SECRET_KEYS` and default to empty (nothing to
   * compare against) rather than to a permissive list.
   */
  migrationTargets?: MigrationTargetConfig;
}

const INTERACTIVE_PATTERNS = [/(?:\(y\/n\)|\[y\/n\]|\[Y\/n\]|yes\/no)/i, /\bpassword\s*:/i, /\bpassphrase\s*:/i, /press any key/i, /are you sure/i, /enter .*:\s*$/i];

/**
 * C6a: production/development database identities used by the migration-safety phase. Every field is
 * optional and empty by default: an empty list means "nothing is known to be production", so the check
 * never blocks work by accident — but it also never invents a permissive target.
 */
export interface MigrationTargetConfig {
  productionUrls?: string[];
  productionHosts?: string[];
  devHosts?: string[];
  productionSecretKeys?: string[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Reads the migration-target configuration from the environment (all optional). */
export function resolveMigrationTargetConfig(env: NodeJS.ProcessEnv = process.env): MigrationTargetConfig {
  return {
    productionUrls: splitList(env.NPATI_CODE_PRODUCTION_URLS),
    productionHosts: splitList(env.NPATI_CODE_PRODUCTION_HOSTS),
    devHosts: splitList(env.NPATI_CODE_DEV_DB_HOSTS),
    productionSecretKeys: splitList(env.NPATI_CODE_PRODUCTION_SECRET_KEYS),
  };
}

/**
 * Reveals whether output looks like a program waiting for terminal input. A timeout alone is not
 * enough: the command may simply be slow, and that case must surface as `command_timeout`.
 */
export function looksInteractive(output: string, exitCode: number, _status?: string): boolean {
  if (exitCode === 0) return false;
  const tail = output.slice(-400);
  return INTERACTIVE_PATTERNS.some((pattern) => pattern.test(tail));
}

/** Trims long output to head + tail with an explicit marker and a narrowing hint. */
export function truncateShellOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.max(1, Math.floor(limit * 0.6));
  const tail = Math.max(1, limit - head);
  return {
    text: `${text.slice(0, head)}\n[truncated ${text.length - limit} chars — narrow the command output (grep/tail) or raise the limit]\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/** Shell-quotes a value so it can be inlined into a command without becoming syntax. */
function quote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export class CodeShellRuntime {
  private readonly sessions = new Map<string, CodeShellSession>();
  private readonly limits: CodeAgentLimits;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(private readonly options: CodeShellRuntimeOptions = {}) {
    this.limits = { ...resolveCodeAgentLimits(), ...options.limits };
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 200;
    this.now = options.now ?? (() => Date.now());
  }

  session(sessionId: string): CodeShellSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.now() - session.updatedAt > this.sessionTtlMs) { this.sessions.delete(sessionId); return null; }
    return { ...session, env: { ...session.env } };
  }

  resetSession(sessionId: string): void { this.sessions.delete(sessionId); }

  resetAll(): void { this.sessions.clear(); }

  /** Proactive cleanup used by the reaper: drops idle sessions and forgets their environment. */
  reap(): number {
    const now = this.now();
    let dropped = 0;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.updatedAt > this.sessionTtlMs) { this.sessions.delete(sessionId); dropped += 1; }
    }
    return dropped;
  }

  async exec(context: AuthContext, input: CodeShellExecInput): Promise<CodeShellExecResult> {
    return this.execute(context, input) as Promise<CodeShellExecResult>;
  }

  async execAsync(context: AuthContext, input: CodeShellExecInput & { background?: boolean; waitTimeoutMs?: number }): Promise<AsyncProcessReceipt> {
    return this.execute(context, input, { background: input.background, waitTimeoutMs: input.waitTimeoutMs }) as Promise<AsyncProcessReceipt>;
  }

  private async execute(context: AuthContext, input: CodeShellExecInput, tracked?: { background?: boolean; waitTimeoutMs?: number }): Promise<CodeShellExecResult | AsyncProcessReceipt> {
    if (!input.command || !input.command.trim()) throw new ShellRuntimeError("invalid_command", "A command is required", 400);
    if (input.command.length > 8_000) throw new ShellRuntimeError("invalid_command", "Command is too long", 400);
    if (!input.sessionId || !input.toolCallId) throw new ShellRuntimeError("invalid_command", "sessionId and toolCallId are required", 400);
    if (!this.options.sandbox) throw new ShellRuntimeError("sandbox_unavailable", "Sandbox execution is unavailable; code never runs on the application host", 503, true);
    // C4 owner decision: the server-side PolicyEngine is the single decision point for execution, so
    // this runtime no longer decides on its own. The engine cannot be bypassed: without it the call is
    // refused (`policy_engine_unavailable`) instead of running without a policy.
    const policy = this.options.policy;
    if (!policy) {
      throw new ShellRuntimeError("policy_engine_unavailable", "Coding Agent policy engine is not configured", 503, true);
    }
    const classifier = this.options.classifier ?? defaultShellClassifier;
    const classification = classifier.classify(input.command);
    const extended = input as {
      projectId?: string; sessionMode?: "plan" | "edit" | "auto" | "full_auto";
      approvalId?: string; networkEnforcementGuaranteed?: boolean;
      // C5: optional policy inputs the caller (agent loop / routes) may supply. They are forwarded
      // verbatim; the engine stays the only place that decides what they mean, and absent fields
      // simply leave the corresponding phase without data (never an implicit allow).
      runId?: string; agentId?: string; policyChange?: "session_mode" | "project_rules" | "trust" | "allowlist" | "tool_policy";
      requiresProjectTrust?: boolean; projectTrusted?: boolean;
      repositoryInstructions?: { policyMutationAttempts?: number; notes?: string[] } | null;
      /**
       * C6a: extra migration context from the caller (migration files in the diff, a rollback plan, or a
       * dev DataBackend routed through the Data Studio engine). The shell itself always declares the
       * **ephemeral sandbox** target, and a host named inside the command still overrides it.
       */
      migration?: {
        files?: Array<{ path: string; content: string }>;
        dataStudioEngine?: boolean;
        rollbackPlan?: boolean;
      };
    };
    const migrationTargets = this.options.migrationTargets ?? resolveMigrationTargetConfig();
    const decision = await policy.evaluate({
      ctx: context,
      companyId: input.companyId,
      projectId: extended.projectId,
      sessionId: input.sessionId,
      runId: extended.runId,
      agentId: extended.agentId,
      tool: "code.shell.exec",
      command: input.command,
      sessionMode: extended.sessionMode,
      approved: input.approved,
      approvalId: extended.approvalId,
      toolCallId: input.toolCallId,
      networkEnforcementGuaranteed: extended.networkEnforcementGuaranteed,
      policyChange: extended.policyChange,
      requiresProjectTrust: extended.requiresProjectTrust,
      projectTrusted: extended.projectTrusted,
      repositoryInstructions: extended.repositoryInstructions,
      // C6a: a shell command runs against the ephemeral sandbox database, and the caller may add the
      // diff/rollback context. A migration that names a production host is still refused, because the
      // engine lets the host inside the command win over this declaration.
      migration: {
        sandboxEphemeral: true,
        target: {
          productionUrls: migrationTargets.productionUrls,
          productionHosts: migrationTargets.productionHosts,
          devHosts: migrationTargets.devHosts,
        },
        ...(extended.migration ?? {}),
      },
    });
    if (decision.decision !== "allow") {
      const risk = decision.risk ?? classification.risk;
      await this.audit(context, input, decision.decision === "require_approval" ? "shell.command.approval_required" : "shell.command.denied", "denied", {
        risk, reasons: decision.reasons, phase: decision.phase, code: decision.code,
      });
      throw new ShellRuntimeError(
        decision.code ?? "policy_denied",
        decision.reasons[0] ?? "Denied by the Coding Agent policy engine",
        decision.status ?? 403,
        decision.retryable ?? false,
        { phase: decision.phase, reasons: decision.reasons, approvalId: decision.approvalId, risk },
      );
    }

    const session = this.sessionFor(context, input);
    const cwd = input.cwd?.trim() || session.cwd;
    const environment = { ...session.env, ...(input.env ?? {}) };
    for (const [name, value] of Object.entries(environment)) {
      if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)/i.test(name) || value.length > 2_000) {
        throw new ShellRuntimeError("invalid_environment", `Refusing to keep a secret-looking variable in the shell session: ${name}`, 400);
      }
    }
    // C6a: production credentials must never be visible to the agent. The check is deliberately narrow —
    // it fires only for a variable whose *value* points at a configured production host, or for an
    // explicitly named production secret key — so a development connection string keeps working. It runs
    // before any lease is delivered and before the sandbox is touched.
    const credentialCheck = assertNoProductionCredentialsVisible({
      agentEnv: environment,
      productionUrls: migrationTargets.productionUrls ?? [],
      productionSecretKeys: migrationTargets.productionSecretKeys ?? [],
    });
    if (!credentialCheck.safe) {
      throw new ShellRuntimeError(
        credentialCheck.code ?? MIGRATION_CODES.credentialsVisible,
        `Refusing to run: the shell environment exposes production credentials (${credentialCheck.leakedKeys.join(", ")})`,
        403,
        false,
        { leakedKeys: credentialCheck.leakedKeys },
      );
    }

    // Secret delivery for exactly this call.
    const leases = this.options.leases;
    const leaseIds = (input.secretLeaseIds ?? []).filter(Boolean);
    if (tracked && leaseIds.length) throw new ShellRuntimeError("process_secret_promotion_denied", "Foreground secret leases cannot be promoted", 403);
    const references: Record<string, SecretEnvironmentReference> = {};
    const leaseValues: string[] = [];
    if (leaseIds.length) {
      if (!leases) throw new ShellRuntimeError("secret_lease_unavailable", "Secret leases are not configured", 503, true);
      for (const leaseId of leaseIds) {
        const reference = leases.environmentReferences(leaseId, input.toolCallId);
        Object.assign(references, reference);
      }
    }

    const command = this.composeCommand(input.command, cwd, environment);
    const installLike = classification.timeoutClass === "install" || classification.timeoutClass === "install_build";
    const ceiling = installLike ? this.limits.installBuildTimeoutMs : this.limits.commandTimeoutMs;
    const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? ceiling, this.limits.installBuildTimeoutMs));

    if (tracked) {
      const processes: CodeAsyncProcessService | undefined = this.options.processes?.tracked;
      if (!processes) throw new ShellRuntimeError("process_promotion_unavailable", "Tracked execution is unavailable", 503);
      const waitTimeoutMs = tracked.background ? 0 : (tracked.waitTimeoutMs ?? 1000);
      if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 300000) throw new ShellRuntimeError("invalid_wait_timeout", "Invalid foreground wait", 400);
      let op = await processes.start(context, { companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        runId: input.runId ?? "", leaseOwner: input.leaseOwner ?? "", toolCallId: input.toolCallId, agentId: input.agentId,
        command, cwd, timeoutMs, approved: input.approved });
      const result = await processes.wait(context, { companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        processId: op.processId, waitTimeoutMs, leaseOwner: input.leaseOwner });
      if (result.kind === "running-process-receipt") op = await processes.promote(context, input, op);
      session.env = environment; session.cwd = cwd; session.updatedAt = this.now(); session.turnCount += 1;
      await this.audit(context, input, "shell.command.executed", "allowed", { operationId: op.operationId, processId: op.processId, state: result.state });
      return result;
    }

    let raw: Awaited<ReturnType<CodeShellSandboxPort["execute"]>>;
    try {
      raw = await this.options.sandbox.execute({
        context, companyId: input.companyId, projectId: input.projectId,
        agentId: input.agentId ?? "code-shell-runtime", command, cwd,
        environmentReferences: Object.keys(references).length ? references : undefined,
        approved: input.approved === true, timeoutMs, runId: input.runId,
      });
    } finally {
      // The lease never outlives the call, whatever happened.
      if (leaseIds.length && leases) for (const leaseId of leaseIds) await leases.revoke(leaseId, "call_finished").catch(() => undefined);
    }

    const combined = `${raw.stdout}${raw.stderr ? `\n${raw.stderr}` : ""}`;
    const redacted = redactLeaseValues(CredentialMasker.mask(combined), leaseValues);
    const { text, truncated } = truncateShellOutput(redacted, this.limits.toolOutputChars);
    const interactive = looksInteractive(redacted, raw.exitCode, raw.status);
    session.env = environment;
    session.cwd = cwd;
    session.updatedAt = this.now();
    session.turnCount += 1;

    await this.audit(context, input, "shell.command.executed", "allowed", {
      risk: classification.risk, exitCode: raw.exitCode, leaseIds, cwd, durationMs: raw.durationMs, truncated,
    });

    if (interactive) {
      throw new ShellRuntimeError("interactive_command_not_supported", "Command appears to wait for terminal input, which the sandbox does not provide", 409, false, { exitCode: raw.exitCode, risk: classification.risk });
    }
    if (raw.status === "timed_out") {
      throw new ShellRuntimeError("command_timeout", "Sandbox command timed out", 504, true, { timeoutMs, risk: classification.risk, leaseIds });
    }

    return {
      exitCode: raw.exitCode,
      stdout: text,
      stderr: truncateShellOutput(redactLeaseValues(CredentialMasker.mask(raw.stderr), leaseValues), this.limits.toolOutputChars).text,
      durationMs: raw.durationMs,
      truncated,
      risk: classification.risk,
      classification,
      leaseIds: leaseIds.length ? leaseIds : undefined,
      cwd,
      sessionId: input.sessionId,
      sandboxId: raw.sandboxId,
    };
  }

  private sessionFor(context: AuthContext, input: CodeShellExecInput): CodeShellSession {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (existing.companyId !== input.companyId || existing.projectId !== input.projectId) {
        throw new ShellRuntimeError("session_mismatch", "Shell session belongs to another project", 403);
      }
      if (this.now() - existing.updatedAt > this.sessionTtlMs) this.sessions.delete(input.sessionId);
      else return existing;
    }
    if (this.sessions.size >= this.maxSessions) throw new ShellRuntimeError("shell_session_limit", "Too many shell sessions", 429, true);
    const created: CodeShellSession = {
      sessionId: input.sessionId, companyId: input.companyId, projectId: input.projectId,
      cwd: input.cwd?.trim() || "/workspace", env: {}, updatedAt: this.now(), turnCount: 0,
    };
    this.sessions.set(input.sessionId, created);
    void context;
    return created;
  }

  /**
   * Builds the command line that reproduces the session state. Only non-secret variables are inlined
   * (they were validated above); secret values are never part of the command string.
   */
  private composeCommand(command: string, cwd: string, environment: Record<string, string>): string {
    const parts: string[] = [];
    if (cwd && cwd !== "/workspace") parts.push(`cd ${quote(cwd)}`);
    for (const [name, value] of Object.entries(environment)) parts.push(`export ${name}=${quote(value)}`);
    parts.push(command);
    return parts.length > 1 ? parts.join(" && ") : command;
  }

  private async audit(context: AuthContext, input: CodeShellExecInput, action: string, decision: "allowed" | "denied", metadata: Record<string, unknown>): Promise<void> {
    const audit = this.options.audit;
    if (!audit) return;
    await audit.record(context, {
      companyId: input.companyId, actor: context.userId, actorRole: "agent", action,
      resourceType: "code_shell", resourceId: input.toolCallId, projectId: input.projectId,
      decision, payload: { action, toolCallId: input.toolCallId, sessionId: input.sessionId },
      metadata: { ...metadata, sessionId: input.sessionId, toolCallId: input.toolCallId, commandDigest: digest(input.command) },
      correlationId: input.toolCallId,
    }).catch(() => undefined);
  }
}

function digest(value: string): string {
  // Never store the command itself in the journal: a digest is enough to correlate.
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return `fnv:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
