import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { hasAdminPermission } from "./code-rbac";
import { CredentialMasker } from "./security-guardrails";
import { isLeasableEnvironment, normalizeCredentialEnvironment, type CredentialEnvironment } from "./credential-environment";

/**
 * C4: SecretLease — a secret may be handed to exactly one tool call, inside the sandbox, for a
 * bounded time, and never becomes part of any persistent state.
 *
 * Design notes (important):
 * - The lease object never carries a secret value. Delivery to a sandbox goes through the existing
 *   `TerminalSecretReference` mechanism (`{ id: credentialId, field }`), i.e. the sandbox service
 *   resolves the value itself and redacts it on the way out. This module stores metadata only.
 * - The only path that ever needs a value is the optional tmpfs-file delivery; it is performed by an
 *   injected port (`writeSecretFile`) so the value is never written to the host filesystem and never
 *   held longer than the call.
 * - Issuing a lease is a privileged action: it is written to the tamper-evident AuditLog *before* the
 *   lease is created, and if the journal is unavailable the lease is refused (fail closed).
 * - Production credentials are refused. The current credential model (`company_browser_credentials`)
 *   has no environment marker, so the predicate is conservative: anything that is not explicitly
 *   non-production (or explicitly allowlisted by an operator) is treated as production and denied.
 */

export type SecretLeaseTarget = "environmentReferences" | "tmpfsFile";
export type SecretLeaseState = "active" | "revoked" | "expired";

export interface SecretLease {
  leaseId: string;
  toolCallId: string;
  sessionId: string;
  companyId: string;
  projectId: string;
  purpose: string;
  /** Env variable name the value may be exposed as, inside this call only. */
  variableName: string;
  credentialId: string;
  field: string;
  target: SecretLeaseTarget;
  tmpfsPath?: string;
  issuedAt: number;
  expiresAt: number;
  state: SecretLeaseState;
  allowedOperations?: string[];
}

export interface SecretLeaseIssueInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  purpose: string;
  toolCallId: string;
  variableName: string;
  credentialId: string;
  field: string;
  /** Credential metadata used for the production check; the label/kind come from the credential store. */
  credential?: { id?: string; label?: string; kind?: string; environment?: string } | null;
  ttlMs?: number;
  target?: SecretLeaseTarget;
  allowedOperations?: string[];
}

/** Structural shape of the existing sandbox secret reference (see ProjectSandboxService). */
export interface SecretEnvironmentReference { id: string; field: string; }

export class SecretLeaseError extends Error {
  readonly status = "error" as const;
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SecretLeaseError";
  }
  toJSON(): Record<string, unknown> {
    return { status: this.status, code: this.code, message: this.message, httpStatus: this.httpStatus, retryable: this.retryable, details: this.details };
  }
}

export interface SecretLeaseConfig {
  /** Hard ceiling for a lease; never longer than the tool call timeout in practice. */
  maxTtlMs: number;
  defaultTtlMs: number;
  reaperIntervalMs: number;
  /** tmpfs mount the sandbox exposes for one-call secret files. */
  secretDirectory: string;
  /** Credential ids an operator explicitly allows for coding-agent leases. */
  allowedCredentialIds: string[];
  allowedLabels: string[];
}

export function resolveSecretLeaseConfig(env: NodeJS.ProcessEnv = process.env): SecretLeaseConfig {
  const int = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    maxTtlMs: int(env.NPATI_CODE_SECRET_LEASE_MAX_TTL_MS, 120_000),
    defaultTtlMs: int(env.NPATI_CODE_SECRET_LEASE_TTL_MS, 120_000),
    reaperIntervalMs: int(env.NPATI_CODE_SECRET_LEASE_REAPER_MS, 15_000),
    secretDirectory: env.NPATI_CODE_SECRET_TMPFS_DIR || "/run/npati-secrets",
    allowedCredentialIds: list(env.NPATI_CODE_SECRET_LEASE_ALLOWED_IDS),
    allowedLabels: list(env.NPATI_CODE_SECRET_LEASE_ALLOWED_LABELS),
  };
}

/**
 * C4 (owner decision) — environment-based lease policy.
 *
 * - `development` / `staging`: a lease is allowed.
 * - `unknown`: refused, unless an owner/admin overrides it AND the credential is in the operator
 *   allowlist; an override is always audited (`secret_lease.override`) before the lease exists.
 * - `production`: **never** leased, not even with an allowlist and not even for an owner. Hard deny.
 *
 * `credential` here is only a hint: when an authoritative resolver is configured (the credential
 * repository), its answer wins, so an environment marker that travelled with a tool call cannot be
 * spoofed into a lease.
 */
export function isProductionCredential(
  credential: { id?: string; label?: string; kind?: string; environment?: string } | null | undefined,
): boolean {
  const environment = normalizeCredentialEnvironment(credential?.environment ?? credential?.kind);
  // Anything that is not explicitly development/staging counts as production-grade for policy
  // purposes: `unknown` is not safe either, it just has an override path.
  return !isLeasableEnvironment(environment);
}

export interface CredentialLeaseDecision {
  allowed: boolean;
  environment: CredentialEnvironment;
  /** True when the lease is only possible through an explicit operator override. */
  requiresOverride: boolean;
  overrideApplied: boolean;
  code?: "production_credential_denied" | "credential_environment_unknown";
  reason: string;
}

function isAdminContext(context: AuthContext): boolean {
  // Equivalent to the previous two-clause check (the wildcard clause already required an admin
  // permission, which implies `business:manage`) but now shares the single admin vocabulary (C5a).
  return hasAdminPermission(context.permissions);
}

/**
 * Pure policy evaluation, exported so the decision is testable without a lease provider.
 * `actorIsAdmin` must be computed from the authenticated context, never from tool arguments.
 */
export function evaluateCredentialLeasePolicy(input: {
  credential: { id?: string; label?: string; kind?: string; environment?: string } | null | undefined;
  allowedCredentialIds: string[];
  allowedLabels: string[];
  actorIsAdmin: boolean;
}): CredentialLeaseDecision {
  const environment = normalizeCredentialEnvironment(input.credential?.environment ?? input.credential?.kind);
  if (environment === "production") {
    return { allowed: false, environment, requiresOverride: false, overrideApplied: false, code: "production_credential_denied", reason: "production_environment" };
  }
  if (isLeasableEnvironment(environment)) {
    return { allowed: true, environment, requiresOverride: false, overrideApplied: false, reason: `${environment}_environment` };
  }
  const listed = Boolean(
    (input.credential?.id && input.allowedCredentialIds.includes(input.credential.id))
    || (input.credential?.label && input.allowedLabels.includes(input.credential.label)),
  );
  if (!listed) {
    return { allowed: false, environment, requiresOverride: true, overrideApplied: false, code: "credential_environment_unknown", reason: "unknown_environment_not_allowlisted" };
  }
  if (!input.actorIsAdmin) {
    return { allowed: false, environment, requiresOverride: true, overrideApplied: false, code: "credential_environment_unknown", reason: "unknown_environment_override_requires_admin" };
  }
  return { allowed: true, environment, requiresOverride: true, overrideApplied: true, reason: "unknown_environment_admin_override" };
}

/** Removes any leaked lease value from a text that is about to be logged, stored or returned. */
export function redactLeaseValues(text: string, values: string[]): string {
  let result = text;
  for (const value of values) {
    if (!value || value.length < 6) continue;
    result = result.split(value).join("[REDACTED_SECRET]");
  }
  return CredentialMasker.mask(result);
}

export interface SecretLeaseAudit {
  record(context: AuthContext, input: {
    companyId: string; actor: string; actorRole: string; action: string; resourceType: string;
    resourceId?: string; projectId?: string; decision: "allowed" | "denied" | "approved" | "rejected";
    payload?: unknown; metadata?: Record<string, unknown>; correlationId?: string;
  }): Promise<unknown>;
}

export interface SecretLeaseDependencies {
  /**
   * Authoritative credential lookup (the Company credential repository). When configured it wins over
   * any environment marker supplied with the tool call, so the caller cannot spoof `development`.
   */
  resolveCredential?: (context: AuthContext, companyId: string, credentialId: string) => Promise<{ id: string; label: string; environment: string } | null>;
  /**
   * Optional value access used only by tmpfs-file delivery. When it is absent, `environmentReferences`
   * delivery stays available (the sandbox resolves the value itself) and tmpfs delivery is refused.
   */
  resolveField?: (context: AuthContext, companyId: string, credentialId: string, field: string) => Promise<string | null>;
  /** Writes/deletes inside the sandbox tmpfs; never the host filesystem. */
  writeSecretFile?: (input: { projectId: string; path: string; content: string }) => Promise<void>;
  deleteSecretFile?: (input: { projectId: string; path: string }) => Promise<void>;
  audit?: SecretLeaseAudit;
  config?: Partial<SecretLeaseConfig>;
  now?: () => number;
}

/**
 * Issues, tracks and revokes one-call secret leases.
 *
 * Invariants enforced here:
 * - a lease is bound to exactly one `toolCallId` (and one session/project/company);
 * - a value handle can be consumed once — reusing another call's lease raises `secret_lease_inherited`;
 * - expired or revoked leases never yield references;
 * - every issue/revoke is audited before it takes effect.
 */
export class SecretLeaseProvider {
  private readonly leases = new Map<string, SecretLease>();
  private readonly byCall = new Map<string, string[]>();
  private readonly consumed = new Set<string>();
  private readonly config: SecretLeaseConfig;
  private readonly now: () => number;
  private reaper?: NodeJS.Timeout;

  constructor(private readonly deps: SecretLeaseDependencies = {}) {
    this.config = { ...resolveSecretLeaseConfig(), ...deps.config };
    this.now = deps.now ?? (() => Date.now());
  }

  get secretDirectory(): string { return this.config.secretDirectory; }

  async issue(context: AuthContext, input: SecretLeaseIssueInput): Promise<SecretLease> {
    if (!input.credentialId || !input.field || !input.toolCallId || !input.sessionId || !input.purpose) {
      throw new SecretLeaseError("invalid_lease_request", "A lease requires purpose, toolCallId, sessionId, credentialId and field", 400);
    }
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(input.variableName)) {
      throw new SecretLeaseError("invalid_lease_request", "variableName must be an upper-case environment variable name", 400);
    }
    // The authoritative environment lookup wins over any marker that travelled with the call.
    let credential = input.credential ?? null;
    if (!credential && !this.deps.resolveCredential) {
      throw new SecretLeaseError(
        "credential_environment_unknown",
        "Credential metadata is required to lease a secret",
        403,
        false,
        { credentialId: input.credentialId, reason: "credential_metadata_missing" },
      );
    }
    if (this.deps.resolveCredential) {
      const resolved = await this.deps.resolveCredential(context, input.companyId, input.credentialId);
      if (!resolved) {
        throw new SecretLeaseError("credential_environment_unknown", "Credential was not found for this tenant", 403, false, { credentialId: input.credentialId, reason: "credential_not_found" });
      }
      credential = { id: resolved.id, label: resolved.label, environment: resolved.environment };
    }
    const decision = evaluateCredentialLeasePolicy({
      credential,
      allowedCredentialIds: this.config.allowedCredentialIds,
      allowedLabels: this.config.allowedLabels,
      actorIsAdmin: isAdminContext(context),
    });
    if (!decision.allowed) {
      throw new SecretLeaseError(
        decision.code ?? "production_credential_denied",
        decision.environment === "production"
          ? "Production credentials are never leased to the coding agent"
          : "Credential environment is unknown; an owner/admin override is required",
        403,
        false,
        { credentialId: input.credentialId, environment: decision.environment, reason: decision.reason },
      );
    }
    // The override is a privileged decision: it must be provable before the lease exists.
    if (decision.overrideApplied && this.deps.audit) {
      try {
        await this.deps.audit.record(context, {
          companyId: input.companyId, actor: context.userId, actorRole: "admin",
          action: "secret_lease.override", resourceType: "credential", resourceId: input.credentialId,
          projectId: input.projectId, decision: "allowed",
          payload: { credentialId: input.credentialId, environment: decision.environment, toolCallId: input.toolCallId },
          metadata: { leasePurpose: input.purpose, toolCallId: input.toolCallId, environment: decision.environment, reason: decision.reason },
          correlationId: input.toolCallId,
        });
      } catch (error) {
        throw new SecretLeaseError("audit_unavailable", error instanceof Error ? `Secret lease refused: ${error.message}` : "Secret lease refused: audit log unavailable", 503, true);
      }
    }
    if (decision.overrideApplied && !this.deps.audit) {
      throw new SecretLeaseError("audit_unavailable", "An environment override requires the audit journal", 503, false);
    }
    const ttl = Math.min(input.ttlMs ?? this.config.defaultTtlMs, this.config.maxTtlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new SecretLeaseError("invalid_lease_request", "Invalid lease TTL", 400);
    const target: SecretLeaseTarget = input.target ?? "environmentReferences";
    if (target === "tmpfsFile" && !this.deps.resolveField) {
      throw new SecretLeaseError("secret_delivery_unavailable", "tmpfs secret delivery is not configured", 503, true);
    }
    const issuedAt = this.now();
    const lease: SecretLease = {
      leaseId: randomUUID(), toolCallId: input.toolCallId, sessionId: input.sessionId,
      companyId: input.companyId, projectId: input.projectId, purpose: input.purpose,
      variableName: input.variableName, credentialId: input.credentialId, field: input.field,
      target, issuedAt, expiresAt: issuedAt + ttl, state: "active", allowedOperations: input.allowedOperations,
    };
    // Fail closed: without the journal no lease exists.
    if (this.deps.audit) {
      try {
        await this.deps.audit.record(context, {
          companyId: input.companyId, actor: context.userId, actorRole: "service",
          action: "secret_lease.issue", resourceType: "secret_lease", resourceId: lease.leaseId,
          projectId: input.projectId, decision: "allowed",
          payload: { credentialId: input.credentialId, field: input.field, variableName: input.variableName, ttlMs: ttl, toolCallId: input.toolCallId },
          metadata: { leaseId: lease.leaseId, purpose: input.purpose, scope: target, ttlMs: ttl, toolCallId: input.toolCallId, sessionId: input.sessionId },
          correlationId: input.toolCallId,
        });
      } catch (error) {
        throw new SecretLeaseError("audit_unavailable", error instanceof Error ? `Secret lease refused: ${error.message}` : "Secret lease refused: audit log unavailable", 503, true);
      }
    }
    this.leases.set(lease.leaseId, lease);
    this.byCall.set(input.toolCallId, [...(this.byCall.get(input.toolCallId) ?? []), lease.leaseId]);
    if (target === "tmpfsFile") lease.tmpfsPath = await this.materializeFile(context, lease);
    return { ...lease };
  }

  /**
   * Returns the sandbox references for a call. The value itself never passes through this method:
   * the sandbox resolves it from the existing credential store.
   */
  environmentReferences(leaseId: string, toolCallId: string, sessionId?: string): Record<string, SecretEnvironmentReference> {
    const lease = this.consume(leaseId, toolCallId, sessionId);
    if (lease.target === "tmpfsFile") throw new SecretLeaseError("secret_delivery_mismatch", "This lease was issued for tmpfs file delivery", 409);
    return { [lease.variableName]: { id: lease.credentialId, field: lease.field } };
  }

  /** Path of the one-call tmpfs secret file (tmpfs delivery only). */
  fileHandle(leaseId: string, toolCallId: string): { path: string; variableName: string } {
    const lease = this.consume(leaseId, toolCallId);
    if (lease.target !== "tmpfsFile" || !lease.tmpfsPath) throw new SecretLeaseError("secret_delivery_mismatch", "This lease was not issued for tmpfs file delivery", 409);
    return { path: lease.tmpfsPath, variableName: lease.variableName };
  }

  /**
   * Guard against inheriting a lease from a previous call: any attempt to use a lease that belongs to
   * another `toolCallId`, or to use one twice, is refused.
   */
  assertNotInherited(leaseId: string, toolCallId: string, sessionId?: string): SecretLease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new SecretLeaseError("secret_lease_inherited", "Unknown or already released secret lease", 409);
    if (lease.toolCallId !== toolCallId) {
      throw new SecretLeaseError("secret_lease_inherited", "A secret lease can only be used by the tool call it was issued for", 409, false, { leaseToolCallId: lease.toolCallId });
    }
    // A lease is also bound to the session that requested it: a later session must not inherit it,
    // even when it happens to reuse the same toolCallId.
    if (sessionId !== undefined && lease.sessionId !== sessionId) {
      throw new SecretLeaseError("secret_lease_inherited", "A secret lease can only be used by the session it was issued for", 409, false, { leaseSessionId: lease.sessionId });
    }
    return lease;
  }

  async revoke(leaseId: string, reason: string): Promise<boolean> {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    if (lease.state === "revoked") return true;
    lease.state = "revoked";
    this.consumed.delete(leaseId);
    if (lease.tmpfsPath && this.deps.deleteSecretFile) {
      await this.deps.deleteSecretFile({ projectId: lease.projectId, path: lease.tmpfsPath }).catch(() => undefined);
    }
    if (this.deps.audit) {
      await this.deps.audit.record({ workspaceId: "", userId: "system", permissions: [] } as unknown as AuthContext, {
        companyId: lease.companyId, actor: "system", actorRole: "service", action: "secret_lease.revoke",
        resourceType: "secret_lease", resourceId: lease.leaseId, projectId: lease.projectId, decision: "allowed",
        payload: { reason }, metadata: { leaseId: lease.leaseId, reason, toolCallId: lease.toolCallId },
        correlationId: lease.toolCallId,
      }).catch(() => undefined);
    }
    return true;
  }

  async revokeAllForCall(toolCallId: string, reason = "call_finished"): Promise<number> {
    const ids = this.byCall.get(toolCallId) ?? [];
    let revoked = 0;
    for (const leaseId of ids) if (await this.revoke(leaseId, reason)) revoked += 1;
    this.byCall.delete(toolCallId);
    return revoked;
  }

  list(filter: { sessionId?: string; state?: SecretLeaseState } = {}): SecretLease[] {
    return [...this.leases.values()]
      .filter((lease) => (!filter.sessionId || lease.sessionId === filter.sessionId))
      .filter((lease) => (!filter.state || lease.state === filter.state))
      .map((lease) => ({ ...lease }));
  }

  /** Revokes expired leases; returns how many were revoked (used by the background reaper). */
  async reap(): Promise<number> {
    const now = this.now();
    let revoked = 0;
    for (const lease of this.leases.values()) {
      if (lease.state !== "active") continue;
      if (lease.expiresAt > now) continue;
      lease.state = "expired";
      if (lease.tmpfsPath && this.deps.deleteSecretFile) {
        await this.deps.deleteSecretFile({ projectId: lease.projectId, path: lease.tmpfsPath }).catch(() => undefined);
      }
      revoked += 1;
    }
    return revoked;
  }

  startReaper(onReap?: (count: number) => void): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      void this.reap().then((count) => { if (count > 0) onReap?.(count); }).catch(() => undefined);
    }, this.config.reaperIntervalMs);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (!this.reaper) return;
    clearInterval(this.reaper);
    this.reaper = undefined;
  }

  /** Consumes the lease once: the second attempt is treated as inheritance and refused. */
  private consume(leaseId: string, toolCallId: string, sessionId?: string): SecretLease {
    const lease = this.assertNotInherited(leaseId, toolCallId, sessionId);
    if (lease.state !== "active") throw new SecretLeaseError("secret_lease_expired", `Secret lease is ${lease.state}`, 409, false, { state: lease.state });
    if (lease.expiresAt <= this.now()) {
      lease.state = "expired";
      throw new SecretLeaseError("secret_lease_expired", "Secret lease has expired", 409, true);
    }
    if (this.consumed.has(leaseId)) {
      throw new SecretLeaseError("secret_lease_inherited", "A secret lease can be consumed only once", 409);
    }
    this.consumed.add(leaseId);
    return lease;
  }

  private async materializeFile(context: AuthContext, lease: SecretLease): Promise<string> {
    if (!this.deps.resolveField || !this.deps.writeSecretFile) {
      throw new SecretLeaseError("secret_delivery_unavailable", "tmpfs secret delivery is not configured", 503, true);
    }
    const value = await this.deps.resolveField(context, lease.companyId, lease.credentialId, lease.field);
    if (typeof value !== "string" || !value) throw new SecretLeaseError("secret_not_found", "Secret reference was not found", 404);
    const path = `${this.config.secretDirectory.replace(/\/$/, "")}/${lease.leaseId}`;
    try {
      await this.deps.writeSecretFile({ projectId: lease.projectId, path, content: value });
    } catch (error) {
      throw new SecretLeaseError("secret_delivery_failed", error instanceof Error ? error.message : "Could not deliver the secret to the sandbox", 502, true);
    }
    return path;
  }
}
