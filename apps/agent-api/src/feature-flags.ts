import { hasAdminPermission } from "./code-rbac";
import type {
  AuthContext, CodeSession, FeatureFlag, FeatureFlagHistoryEntry, FeatureFlagInput, FeatureFlagScope, FeatureFlagStage, WorkspaceStore,
} from "@npati/workspace";
import { FEATURE_FLAG_SCOPES } from "@npati/workspace";
import type { AuditLogService } from "./audit-log";

/**
 * C1a: server-side feature flags for the Coding Agent.
 *
 * The Coding Agent is dark by default: every new path (API, tools, sandbox, model calls) must ask this
 * service, and a missing store/flag means "disabled", never "enabled". Resolution is
 * user -> company -> global (the most specific row wins) with a mandatory master gate, so enabling a
 * company never leaks to another one.
 */

export const CODE_AGENT_MASTER_FLAG = "coding_agent.enabled";

/** Sub-flags of the master switch. All are off by default. */
export const CODE_AGENT_SUB_FLAGS = [
  "code.read",
  "code.write",
  "code.shell",
  "code.git",
  "code.subagents",
  "code.background_runs",
  "code.mounted_folder",
  "code.hooks",
  "code.mcp",
  "code.full_auto_sandbox",
  /** C8: the repo map enters the model-visible context, so it stays off until enabled explicitly. */
  "code.repo_map",
  /**
   * C10: durable session operations. Each is its own flag because each has a different blast radius: a resume
   * re-takes the lease of an interrupted run and rebuilds its context, a rewind moves a session's conversation
   * cursor (and, for `code`/`both`, the workspace itself), and a fork mints a new session that inherits another
   * session's plan and task list. Adding them here is what makes them settable at all: `CODE_FLAG_KEY_PATTERN`
   * is an allowlist, and a key it does not match can never be enabled.
   */
  "code.session_resume",
  "code.rewind",
  "code.session_fork",
  /**
   * C10 (ТЗ item 8): exporting a session to Markdown. Its own flag because the exported document is removable
   * from the product's control — a workspace with data-residency rules may want the Workspace readable while
   * downloads are off. `code.background_runs` above is unchanged and now actually consumed by the background-run
   * surface instead of only by `code-process-manager.ts`.
   */
  "code.export",
  /**
   * C13: slash commands and lazily loaded Skills. Each is its own flag because each has a different blast
   * radius: a slash command expands a *stored template* into the model's input (and a project's templates are
   * repository content), while a Skill puts an *installed* body into the system prompt. A workspace may
   * reasonably want one and not the other, and the two flags let it say so. No duplicate keys: neither name
   * existed before C13, and both are added to `CODE_FLAG_KEY_PATTERN` in the same edit — a key the pattern does
   * not match can never be enabled, which is exactly the failure mode this list exists to prevent.
   */
  "code.commands",
  "code.skills",
  "code.async_inbox",
  "code.async_processes",
] as const;

export type CodeAgentSubFlag = typeof CODE_AGENT_SUB_FLAGS[number];

/** `code.model_profile.<id>` is the only pattern-based flag (model behaviour stays profile-driven). */
export const CODE_MODEL_PROFILE_PATTERN = /^code\.model_profile\.[a-z0-9._-]{1,64}$/;
/**
 * C1b: `code.sandbox_image.<digest-prefix>` gates the staged rollout of a new sandbox image digest;
 * the key carries the bare hex prefix (8..64 chars) because a flag key cannot contain a colon.
 */
export const CODE_SANDBOX_IMAGE_PATTERN = /^code\.sandbox_image\.[a-f0-9]{8,64}$/;
export const CODE_FLAG_KEY_PATTERN = /^(coding_agent\.enabled|code\.(read|write|shell|git|subagents|background_runs|mounted_folder|hooks|mcp|full_auto_sandbox|repo_map|session_resume|rewind|session_fork|export|commands|skills|async_inbox|async_processes))$|^code\.model_profile\.[a-z0-9._-]{1,64}$|^code\.sandbox_image\.[a-f0-9]{8,64}$/;

export function isValidCodeFlagKey(flagKey: string): boolean {
  return typeof flagKey === "string" && CODE_FLAG_KEY_PATTERN.test(flagKey);
}

export class FeatureFlagError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

/** Thrown by `assertEnabled`; routes translate it into 403 `feature_disabled`. */
export class FeatureDisabledError extends FeatureFlagError {
  constructor(public readonly flagKey: string, message?: string) {
    super("feature_disabled", message ?? `Feature "${flagKey}" is disabled`, 403);
  }
}

export interface FlagEvaluationContext { companyId?: string; userId?: string; }

export interface FlagResolution {
  key: string;
  enabled: boolean;
  scope: FeatureFlagScope;
  scopeId: string;
  stage: FeatureFlagStage;
  /** Why the flag resolved this way: `no_row` means nothing was configured (dark launch). */
  source: "user" | "company" | "global" | "no_row" | "self_hosted_default";
}

export interface FeatureFlagServiceConfig {
  /** Explicit rows, including kill switches, always override self-hosted defaults. */
  enabledByDefault?: boolean;
  /** Cache TTL for flag resolution; clamped to 1..30 s so a kill switch is felt quickly. */
  cacheTtlMs?: number;
  /** G1/R1 have not passed yet: stages above `internal` need an explicit operator override. */
  allowPreGateRollout?: boolean;
  /** Automatically disable the master flag when the audit chain is reported broken. */
  autoDisableOnAuditBreak?: boolean;
}

const MAX_CACHE_TTL_MS = 30_000;

/**
 * The service is the only place that decides whether the Coding Agent may run. It is deliberately
 * small and synchronous in its decisions: `isEnabled` never performs the privileged action itself.
 */
export class FeatureFlagService {
  private readonly enabledByDefault: boolean;
  private readonly cache = new Map<string, { resolution: FlagResolution; expiresAt: number }>();
  private readonly cacheTtlMs: number;
  private readonly allowPreGateRollout: boolean;
  private readonly autoDisableOnAuditBreak: boolean;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly audit?: AuditLogService,
    config: FeatureFlagServiceConfig = {},
    /** Best-effort sandbox cleanup used by the kill switch (full cleanup and lease revocation: C4/C6). */
    private readonly stopSandboxes?: (ctx: AuthContext, companyId: string) => Promise<number>,
  ) {
    this.enabledByDefault = config.enabledByDefault ?? false;
    const requested = config.cacheTtlMs ?? Number.parseInt(process.env.NPATI_CODE_FLAG_CACHE_TTL_MS ?? "", 10);
    const ttl = Number.isFinite(requested) && requested > 0 ? requested : 15_000;
    this.cacheTtlMs = Math.min(Math.max(ttl, 1_000), MAX_CACHE_TTL_MS);
    this.allowPreGateRollout = config.allowPreGateRollout ?? process.env.NPATI_ALLOW_PRE_GATE_ROLLOUT === "true";
    this.autoDisableOnAuditBreak = config.autoDisableOnAuditBreak ?? process.env.NPATI_CODE_AUTO_DISABLE_ON_AUDIT_BREAK !== "false";
  }

  /** Clears the resolution cache. Called after every flag change so a kill switch is immediate. */
  invalidate(workspaceId?: string): void {
    if (!workspaceId) { this.cache.clear(); return; }
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${workspaceId}|`)) this.cache.delete(key);
  }

  private cacheKey(ctx: AuthContext, flagKey: string, options: FlagEvaluationContext): string {
    return `${ctx.workspaceId}|${options.companyId ?? ""}|${options.userId ?? ctx.userId}|${flagKey}`;
  }

  private rows(ctx: AuthContext, flagKey: string): Promise<FeatureFlag[]> {
    return this.store.listFeatureFlags(ctx).then((flags) => flags.filter((flag) => flag.flagKey === flagKey));
  }

  /** Stage semantics: `off` denies, `internal` needs an administrative actor, `allowlist` needs an id. */
  private stageAllows(ctx: AuthContext, flag: FeatureFlag, options: FlagEvaluationContext): boolean {
    if (!flag.enabled) return false;
    const subject = options.userId ?? ctx.userId;
    switch (flag.stage) {
      case "off": return false;
      case "internal": return hasAdminPermission(ctx.permissions);
      case "allowlist": return flag.allowlist.includes(subject) || (options.companyId ? flag.allowlist.includes(options.companyId) : false);
      case "percent": {
        if (flag.rolloutPercent <= 0) return false;
        const bucket = stableBucket(`${flag.flagKey}:${options.companyId ?? subject}`);
        return bucket < flag.rolloutPercent;
      }
      case "ga": return true;
      default: return false;
    }
  }

  /** Rows that apply to this evaluation context, most specific first: user -> company -> global. */
  private applicableRows(rows: FeatureFlag[], ctx: AuthContext, options: FlagEvaluationContext): Array<{ flag: FeatureFlag; source: FlagResolution["source"] }> {
    const userId = options.userId ?? ctx.userId;
    const candidates: Array<{ flag: FeatureFlag; source: FlagResolution["source"] }> = [];
    const userFlag = rows.find((flag) => flag.scope === "user" && flag.scopeId === userId);
    if (userFlag) candidates.push({ flag: userFlag, source: "user" });
    const companyFlag = options.companyId ? rows.find((flag) => flag.scope === "company" && flag.scopeId === options.companyId) : undefined;
    if (companyFlag) candidates.push({ flag: companyFlag, source: "company" });
    const globalFlag = rows.find((flag) => flag.scope === "global" && flag.scopeId === "");
    if (globalFlag) candidates.push({ flag: globalFlag, source: "global" });
    return candidates;
  }

  private resolveFrom(rows: FeatureFlag[], ctx: AuthContext, options: FlagEvaluationContext): FlagResolution | null {
    const winner = this.applicableRows(rows, ctx, options)[0];
    if (!winner) return null;
    return {
      key: winner.flag.flagKey,
      enabled: this.stageAllows(ctx, winner.flag, options),
      scope: winner.flag.scope,
      scopeId: winner.flag.scopeId,
      stage: winner.flag.stage,
      source: winner.source,
    };
  }

  /**
   * Resolves one flag. A sub-flag is enabled only when it *and* the master flag resolve to enabled at
   * the same or a broader scope, which is why the master is always evaluated with the same options.
   * The resolved descriptor is cached, so `describe` and `assertEnabled` agree on scope and stage.
   */
  async resolve(ctx: AuthContext, flagKey: string, options: FlagEvaluationContext = {}): Promise<FlagResolution> {
    const key = this.cacheKey(ctx, flagKey, options);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.resolution;

    const rows = await this.rows(ctx, flagKey);
    const own = this.resolveFrom(rows, ctx, options);
    let resolution: FlagResolution;
    if (flagKey === CODE_AGENT_MASTER_FLAG) {
      // The master flag is a kill switch, so it is authoritative across scopes: it must be enabled at
      // every applicable scope. An explicit `off` at a broader scope (for example the global stop
      // written by `evaluateAutoDisable` during an incident) therefore vetoes a narrower `on`, while a
      // sub-flag keeps ordinary most-specific-wins resolution.
      const applicable = this.applicableRows(rows, ctx, options);
      const winner = applicable[0];
      resolution = winner
        ? {
          key: flagKey,
          enabled: applicable.every(({ flag }) => this.stageAllows(ctx, flag, options)),
          scope: winner.flag.scope, scopeId: winner.flag.scopeId, stage: winner.flag.stage, source: winner.source,
        }
        : this.defaultResolution(flagKey);
    } else {
      const master = await this.resolve(ctx, CODE_AGENT_MASTER_FLAG, options);
      resolution = own
        ? { ...own, enabled: own.enabled && master.enabled }
        : { ...this.defaultResolution(flagKey), enabled: this.defaultResolution(flagKey).enabled && master.enabled };
    }
    this.cache.set(key, { resolution, expiresAt: Date.now() + this.cacheTtlMs });
    return resolution;
  }

  async isEnabled(ctx: AuthContext, flagKey: string, options: FlagEvaluationContext = {}): Promise<boolean> {
    if (!isValidCodeFlagKey(flagKey)) return false;
    return (await this.resolve(ctx, flagKey, options)).enabled;
  }

  private defaultResolution(flagKey: string): FlagResolution {
    const enabled = this.enabledByDefault && !["code.async_inbox", "code.async_processes"].includes(flagKey);
    return { key: flagKey, enabled, scope: "global", scopeId: "", stage: enabled ? "ga" : "off", source: enabled ? "self_hosted_default" : "no_row" };
  }

  /** Deny-by-default gate used by every code entry point (routes and services alike). */
  async assertEnabled(ctx: AuthContext, flagKey: string, options: FlagEvaluationContext = {}): Promise<true> {
    if (!isValidCodeFlagKey(flagKey)) throw new FeatureDisabledError(flagKey, `Unknown coding flag "${flagKey}"`);
    if (!(await this.isEnabled(ctx, flagKey, options))) throw new FeatureDisabledError(flagKey);
    return true;
  }

  /** Dark-launch summary for the UI/API: the master flag plus every configured code flag. */
  async describe(ctx: AuthContext, options: FlagEvaluationContext = {}): Promise<{ master: FlagResolution; flags: FlagResolution[]; darkLaunch: boolean }> {
    const configured = (await this.store.listFeatureFlags(ctx)).filter((flag) => flag.flagKey.startsWith("code") || flag.flagKey === CODE_AGENT_MASTER_FLAG);
    const keys = new Set<string>([CODE_AGENT_MASTER_FLAG, ...CODE_AGENT_SUB_FLAGS,
      "code.model_profile.hosted-native-tools", "code.model_profile.hosted-native-tools-small-context", "code.model_profile.local-text-tools",
      ...configured.map((flag) => flag.flagKey)]);
    const flags: FlagResolution[] = [];
    for (const key of keys) {
      if (key === CODE_AGENT_MASTER_FLAG) continue;
      flags.push(await this.resolve(ctx, key, options));
    }
    const master = await this.resolve(ctx, CODE_AGENT_MASTER_FLAG, options);
    return { master, flags: flags.sort((a, b) => a.key.localeCompare(b.key)), darkLaunch: !master.enabled };
  }

  async list(ctx: AuthContext): Promise<FeatureFlag[]> {
    return this.store.listFeatureFlags(ctx);
  }

  async history(ctx: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> {
    return this.store.listFeatureFlagHistory(ctx, flagKey, limit);
  }

  private assertAdmin(ctx: AuthContext, action: string): void {
    if (!hasAdminPermission(ctx.permissions)) {
      throw new FeatureFlagError("flag_admin_required", `${action} requires the owner/admin role`, 403);
    }
  }

  /**
   * Changes a flag.
   *
   * Fail closed: the audit entry is written *before* the flag row is touched, so a deployment where
   * the journal is unavailable cannot change permissions or enable a feature unaudited. The entry
   * therefore records the intended change; if the subsequent write fails the audit shows an attempt
   * that did not take effect (which is the safe direction for this control).
   */
  async setFlag(ctx: AuthContext, input: FeatureFlagInput, options: { auditCompanyId?: string } = {}): Promise<FeatureFlag> {
    this.assertAdmin(ctx, "Changing a feature flag");
    if (!isValidCodeFlagKey(input.flagKey)) throw new FeatureFlagError("invalid_flag_key", `Invalid coding flag key "${input.flagKey}"`, 400);
    if (!FEATURE_FLAG_SCOPES.includes(input.scope)) throw new FeatureFlagError("invalid_flag_key", `Invalid flag scope "${input.scope}"`, 400);
    const stage = input.stage;
    if (stage && stage !== "off" && stage !== "internal" && !this.allowPreGateRollout) {
      throw new FeatureFlagError("gate_not_passed", "Stages above internal require the security gate (G1) and rollout readiness (R1); set NPATI_ALLOW_PRE_GATE_ROLLOUT=true for an explicit pre-gate rollout", 409);
    }
    if (input.scope !== "global" && !input.scopeId) throw new FeatureFlagError("invalid_flag_key", "scopeId is required for company and user scoped flags", 400);

    const before = (await this.store.listFeatureFlags(ctx)).find((flag) =>
      flag.flagKey === input.flagKey && flag.scope === input.scope
      && flag.scopeId === (input.scope === "global" ? "" : (input.scopeId ?? ""))) ?? null;

    if (this.audit) {
      // Every audit entry belongs to a company, and a flag change is always performed from a company
      // context in the API. Without one the change is refused rather than applied unaudited.
      const auditCompanyId = options.auditCompanyId ?? (input.scope === "company" ? input.scopeId : undefined);
      if (!auditCompanyId) throw new FeatureFlagError("flag_admin_required", "An audit company context is required to change a flag", 403);
      await this.audit.record(ctx, {
        companyId: auditCompanyId,
        actor: ctx.userId,
        actorRole: this.auditRole(ctx),
        action: "flag.change",
        resourceType: "feature_flag",
        resourceId: input.flagKey,
        decision: "allowed",
        payload: { flagKey: input.flagKey, scope: input.scope, scopeId: input.scope === "global" ? "" : (input.scopeId ?? null), stage: stage ?? before?.stage ?? "off", enabled: input.enabled ?? before?.enabled ?? false, rolloutPercent: input.rolloutPercent ?? before?.rolloutPercent ?? 0, allowlistSize: (input.allowlist ?? before?.allowlist ?? []).length, expectedRevision: input.expectedRevision ?? null },
        metadata: { previous: before ? { stage: before.stage, enabled: before.enabled, revision: before.revision } : null },
      });
    }

    const saved = await this.store.setFeatureFlag(ctx, input);
    this.invalidate(ctx.workspaceId);
    return saved;
  }

  /**
   * Kill switch: turns the master flag off at the given scope immediately (cache invalidated in the
   * same call), suspends the company's active code sessions and asks the injected sandbox stopper to
   * clean up the projects best-effort. Secret-lease revocation and full sandbox teardown are C4/C6.
   */
  async killSwitch(ctx: AuthContext, options: { companyId?: string; reason?: string } = {}): Promise<{ flag: FeatureFlag; suspendedSessions: number; stoppedSandboxes: number }> {
    this.assertAdmin(ctx, "Using the kill switch");
    const scope: FeatureFlagScope = options.companyId ? "company" : "global";
    const scopeId = options.companyId ?? "";
    const sessions = options.companyId
      ? (await this.store.listCodeSessions(ctx, options.companyId, undefined, { includeArchived: true }))
      : [];
    const targets = sessions.filter((session: CodeSession) => ["active", "paused", "awaiting_approval"].includes(session.status));

    if (this.audit) {
      await this.audit.record(ctx, {
        companyId: options.companyId ?? ctx.workspaceId,
        actor: ctx.userId,
        actorRole: this.auditRole(ctx),
        action: "flag.kill_switch",
        resourceType: "feature_flag",
        resourceId: CODE_AGENT_MASTER_FLAG,
        decision: "allowed",
        payload: { flagKey: CODE_AGENT_MASTER_FLAG, scope, scopeId: scopeId || null, reason: options.reason ?? null, plannedSessions: targets.length },
        metadata: { plannedSessions: targets.length },
      });
    }

    const flag = await this.store.setFeatureFlag(ctx, { scope, scopeId: scopeId || undefined, flagKey: CODE_AGENT_MASTER_FLAG, stage: "off", enabled: false });
    this.invalidate(ctx.workspaceId);

    let suspendedSessions = 0;
    for (const session of targets) {
      try {
        if (options.companyId) {
          await this.store.updateCodeSession(ctx, options.companyId, session.id, { status: "suspended_by_flag", summary: `Suspended by kill switch${options.reason ? `: ${options.reason}` : ""}` });
          suspendedSessions += 1;
        }
      } catch { /* a session that cannot be suspended must not block the kill switch */ }
    }

    let stoppedSandboxes = 0;
    if (options.companyId && this.stopSandboxes) {
      try { stoppedSandboxes = await this.stopSandboxes(ctx, options.companyId); } catch { stoppedSandboxes = 0; }
    }
    return { flag, suspendedSessions, stoppedSandboxes };
  }

  /**
   * Optional automatic kill switch for security events (default on for a broken audit chain): the
   * master flag is disabled globally so the feature stops while the incident is investigated.
   */
  async evaluateAutoDisable(ctx: AuthContext, event: { type: string; reason?: string; companyId?: string }): Promise<{ disabled: boolean; flag?: FeatureFlag }> {
    if (!this.autoDisableOnAuditBreak) return { disabled: false };
    if (event.type !== "audit_chain_broken") return { disabled: false };
    if (this.audit) {
      await this.audit.record(ctx, {
        companyId: event.companyId ?? ctx.workspaceId,
        actor: "system:auto-disable",
        actorRole: "system",
        action: "flag.auto_disable",
        resourceType: "feature_flag",
        resourceId: CODE_AGENT_MASTER_FLAG,
        decision: "denied",
        payload: { event: event.type, reason: event.reason ?? null },
        metadata: { reason: event.reason ?? null },
      });
    }
    const flag = await this.store.setFeatureFlag(ctx, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "off", enabled: false });
    this.invalidate(ctx.workspaceId);
    return { disabled: true, flag };
  }

  private auditRole(ctx: AuthContext): string {
    return hasAdminPermission(ctx.permissions) ? "admin" : "user";
  }
}

/** Deterministic 0..99 bucket, stable across processes and restarts (percentage rollout). */
export function stableBucket(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 100;
}
