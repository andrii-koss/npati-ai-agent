import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { CODE_PRIVILEGED_PERMISSIONS, classifyPrincipal, createRoleRegistry, type CodeRoleRegistry } from "./code-rbac";

/**
 * C5a — step-up confirmation for production operations.
 *
 * Owner decisions implemented here:
 *  - **Step-up is the default**, two-person is **configuration** (`NPATI_CODE_PROD_TWO_PERSON=true`), never a
 *    hard requirement of the code path.
 *  - Both steps are written to the audit journal with the **same payload hash**, so a confirmation can
 *    never be replayed against a different payload.
 *  - A production operation is only performed by a platform executor (see `code-prod-operations.ts`); this
 *    module answers "has a human just confirmed *this exact* operation?".
 *  - A single-owner installation still works with step-up. When two-person is enabled and no second holder
 *    of `code.prod.operate` exists, the refusal says so explicitly instead of silently degrading.
 *
 * Storage is in-process (`TODO(C6a)` moves grants and cooldowns into the durable store together with the
 * rest of the coding-agent runtime state). Nothing here is persisted, so a restart forgets pending
 * challenges — and therefore refuses rather than silently allows, which is the safe direction.
 */

export const CODE_PROD_OPERATE_PERMISSION = "code.prod.operate";

export const DEFAULT_STEP_UP_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_STEP_UP_COOLDOWN_MS = 60 * 1000;
export const MAX_STEP_UP_TTL_MS = 30 * 60 * 1000;
export const MAX_STEP_UP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface StepUpConfig {
  /** When true, the confirmer must be a **different** user who also holds `code.prod.operate`. */
  twoPerson: boolean;
  /** Minimum wait between two confirmed production operations by the same actor for the same operation. */
  cooldownMs: number;
  /** How long a confirmed step-up stays valid. */
  ttlMs: number;
}

/** Configuration is data: an operator enables two-person by setting one variable, with no code edit. */
export function resolveStepUpConfig(env: Record<string, string | undefined> = process.env): StepUpConfig {
  return {
    twoPerson: String(env.NPATI_CODE_PROD_TWO_PERSON ?? "").toLowerCase() === "true",
    cooldownMs: clampInt(env.NPATI_CODE_PROD_STEP_UP_COOLDOWN_MS, DEFAULT_STEP_UP_COOLDOWN_MS, 0, MAX_STEP_UP_COOLDOWN_MS),
    ttlMs: clampInt(env.NPATI_CODE_PROD_STEP_UP_TTL_MS, DEFAULT_STEP_UP_TTL_MS, 1_000, MAX_STEP_UP_TTL_MS),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

export class CodeStepUpError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeStepUpError";
    this.retryable = retryable;
  }
}

export type StepUpStatus = "pending" | "confirmed" | "consumed" | "expired";

export interface StepUpChallenge {
  id: string;
  companyId: string;
  operation: string;
  payloadHash: string;
  twoPerson: boolean;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  consumedAt: string | null;
  status: StepUpStatus;
}

/** The audit port shared by the C5a privileged modules; `app.ts` adapts it onto `AuditLogService`. */
export interface CodePrivilegedAuditPort {
  record(input: {
    /** Authenticated workspace of the decision, never a model-supplied scope. */
    workspaceId?: string;
    action: string;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    decision?: "allow" | "deny";
    payloadHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface CodeStepUpDeps {
  audit?: CodePrivilegedAuditPort;
  registry?: CodeRoleRegistry;
  now?: () => number;
  config?: Partial<StepUpConfig>;
  logger?: { warn(payload: unknown, message?: string): void };
}

/**
 * Does this principal hold `code.prod.operate` **by name**? A wildcard (`*`, `owner`, `admin:all`) never
 * grants it: the RBAC registry treats it as privileged, and this check deliberately mirrors that rule so
 * step-up cannot be satisfied by an administrator who was never given production operations.
 */
export function holdsProductionPermission(ctx: AuthContext, registry: CodeRoleRegistry = createRoleRegistry()): boolean {
  const named = new Set<string>([...(ctx.permissions ?? []), ...registry.permissionsForRole(registry.roleOf(ctx))]);
  return named.has(CODE_PROD_OPERATE_PERMISSION);
}

/** Stable payload hash for a production operation; the same value is used by both step-up steps. */
export function productionPayloadHash(operation: string, payload: Record<string, unknown> = {}): string {
  const text = `${operation}\u0000${canonical(payload)}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export interface RequestStepUpInput {
  operation: string;
  payloadHash: string;
  payload?: Record<string, unknown>;
}

export interface ConfirmStepUpInput {
  challengeId: string;
  payloadHash: string;
}

export interface RequireStepUpInput {
  operation: string;
  payloadHash: string;
  /** The challenge the caller is presenting. Absent means "no confirmation on record" → refused. */
  challengeId?: string;
}

/**
 * Step-up / two-person gate for production operations.
 *
 * Flow: `requestConfirmation` (audited) → `confirmConfirmation` by a **human** (audited, same payload
 * hash) → `requireStepUp` validates the grant → `consumeGrant` marks it used, which starts the cooldown
 * and makes replay with the same hash impossible.
 */
export class CodeStepUp {
  private readonly challenges = new Map<string, StepUpChallenge>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly config: StepUpConfig;
  private readonly registry: CodeRoleRegistry;
  private readonly now: () => number;

  constructor(private readonly deps: CodeStepUpDeps = {}) {
    this.config = { ...resolveStepUpConfig({}), ...(deps.config ?? {}) };
    this.registry = deps.registry ?? createRoleRegistry();
    this.now = deps.now ?? (() => Date.now());
  }

  get effectiveConfig(): StepUpConfig {
    return { ...this.config };
  }

  /** Step 1: a human asks to perform a production operation. Agents and service identities cannot. */
  async requestConfirmation(ctx: AuthContext, companyId: string, input: RequestStepUpInput): Promise<StepUpChallenge> {
    const kind = classifyPrincipal(ctx);
    if (kind !== "user") {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", {
        reason: kind === "agent" ? "agent_cannot_operate_production" : "service_identity_cannot_operate_production",
      });
      throw new CodeStepUpError(
        kind === "agent" ? "agent_cannot_operate_production" : "service_identity_cannot_operate_production",
        "Only a human user can request a production operation",
        403,
        { reason: kind === "agent" ? "agent_cannot_operate_production" : "service_identity_cannot_operate_production", principal: kind },
      );
    }
    if (!holdsProductionPermission(ctx, this.registry)) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: "production_permission_required" });
      throw new CodeStepUpError(
        "production_permission_required",
        `Requesting a production operation requires ${CODE_PROD_OPERATE_PERMISSION}`,
        403,
        { reason: "production_permission_required", permission: CODE_PROD_OPERATE_PERMISSION },
      );
    }

    const at = this.now();
    const challenge: StepUpChallenge = {
      id: randomUUID(),
      companyId,
      operation: input.operation,
      payloadHash: input.payloadHash,
      twoPerson: this.config.twoPerson,
      requestedBy: String(ctx.userId),
      requestedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.config.ttlMs).toISOString(),
      confirmedBy: null,
      confirmedAt: null,
      consumedAt: null,
      status: "pending",
    };
    this.challenges.set(challenge.id, challenge);
    await this.audit("code.prod.step_up.requested", ctx, companyId, input, "allow", {
      challengeId: challenge.id,
      twoPerson: this.config.twoPerson,
    });
    return { ...challenge };
  }

  /**
   * Step 2: the confirmation. With step-up only, the requester confirms their own request. With
   * two-person enabled the confirmer must be a different human who also holds `code.prod.operate`, and the
   * payload hash must match the request exactly.
   */
  async confirmConfirmation(ctx: AuthContext, companyId: string, input: ConfirmStepUpInput): Promise<StepUpChallenge> {
    const kind = classifyPrincipal(ctx);
    if (kind !== "user") {
      throw new CodeStepUpError(
        kind === "agent" ? "agent_cannot_confirm_production" : "service_cannot_confirm_production",
        "Only a human user can confirm a production operation",
        403,
        { reason: kind === "agent" ? "agent_cannot_confirm_production" : "service_cannot_confirm_production", principal: kind },
      );
    }
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.companyId !== companyId) {
      throw new CodeStepUpError("step_up_challenge_not_found", "Unknown step-up challenge", 404, { reason: "step_up_challenge_not_found" });
    }
    if (this.isExpired(challenge)) {
      throw new CodeStepUpError("step_up_expired", "The step-up challenge has expired", 409, { reason: "step_up_expired" });
    }
    if (challenge.status !== "pending") {
      throw new CodeStepUpError("step_up_already_resolved", "The step-up challenge was already resolved", 409, {
        reason: "step_up_already_resolved",
        status: challenge.status,
      });
    }
    if (!holdsProductionPermission(ctx, this.registry)) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, { operation: challenge.operation, payloadHash: challenge.payloadHash }, "deny", {
        reason: "production_permission_required",
        challengeId: challenge.id,
      });
      throw new CodeStepUpError(
        "production_permission_required",
        `Confirming a production operation requires ${CODE_PROD_OPERATE_PERMISSION}`,
        403,
        { reason: "production_permission_required", permission: CODE_PROD_OPERATE_PERMISSION },
      );
    }
    // Two-person: a different human, and the exact same payload.
    if (this.config.twoPerson) {
      if (String(ctx.userId) === challenge.requestedBy) {
        await this.audit("code.prod.step_up.denied", ctx, companyId, { operation: challenge.operation, payloadHash: challenge.payloadHash }, "deny", {
          reason: "two_person_same_user_denied",
          challengeId: challenge.id,
        });
        throw new CodeStepUpError(
          "two_person_same_user_denied",
          "Two-person confirmation requires a different user than the requester",
          403,
          { reason: "two_person_same_user_denied", requestedBy: challenge.requestedBy },
        );
      }
    }
    if (challenge.payloadHash !== input.payloadHash) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, { operation: challenge.operation, payloadHash: challenge.payloadHash }, "deny", {
        reason: "two_person_payload_mismatch",
        challengeId: challenge.id,
        presentedPayloadHash: input.payloadHash,
      });
      throw new CodeStepUpError(
        "two_person_payload_mismatch",
        "The confirmation payload does not match the requested production operation",
        409,
        { reason: "two_person_payload_mismatch" },
      );
    }

    challenge.confirmedBy = String(ctx.userId);
    challenge.confirmedAt = new Date(this.now()).toISOString();
    challenge.status = "confirmed";
    this.challenges.set(challenge.id, challenge);
    // Both steps carry the same payload hash, so the journal proves what was confirmed.
    await this.audit("code.prod.step_up.confirmed", ctx, companyId, { operation: challenge.operation, payloadHash: challenge.payloadHash }, "allow", {
      challengeId: challenge.id,
      requestedBy: challenge.requestedBy,
      twoPerson: this.config.twoPerson,
    });
    return { ...challenge };
  }

  /**
   * Validate that a fresh, matching, unused confirmation exists for **this** operation and payload.
   * Every refusal names its reason so the caller can explain it to the user instead of guessing.
   */
  async requireStepUp(ctx: AuthContext, companyId: string, input: RequireStepUpInput): Promise<StepUpChallenge> {
    if (!input.challengeId) {
      const code = this.config.twoPerson ? "two_person_confirmer_required" : "step_up_required";
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: code });
      throw new CodeStepUpError(
        code,
        this.config.twoPerson
          ? "This production operation needs a second confirmer holding code.prod.operate"
          : "This production operation requires a fresh step-up confirmation",
        403,
        { reason: code, twoPerson: this.config.twoPerson, permission: CODE_PROD_OPERATE_PERMISSION },
      );
    }
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.companyId !== companyId) {
      throw new CodeStepUpError("step_up_challenge_not_found", "Unknown step-up challenge", 404, { reason: "step_up_challenge_not_found" });
    }
    if (challenge.operation !== input.operation || challenge.payloadHash !== input.payloadHash) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: "step_up_payload_mismatch", challengeId: challenge.id });
      throw new CodeStepUpError("step_up_payload_mismatch", "The confirmation was granted for a different production payload", 409, {
        reason: "step_up_payload_mismatch",
      });
    }
    if (this.isExpired(challenge)) {
      throw new CodeStepUpError("step_up_expired", "The step-up confirmation has expired", 409, { reason: "step_up_expired" });
    }
    if (challenge.status === "consumed" || challenge.consumedAt) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: "two_person_replay_denied", challengeId: challenge.id });
      throw new CodeStepUpError(
        this.config.twoPerson ? "two_person_replay_denied" : "step_up_replay_denied",
        "This confirmation was already used",
        409,
        { reason: this.config.twoPerson ? "two_person_replay_denied" : "step_up_replay_denied" },
      );
    }
    if (challenge.status !== "confirmed" || !challenge.confirmedBy) {
      const code = this.config.twoPerson ? "two_person_confirmer_required" : "step_up_required";
      throw new CodeStepUpError(code, "The production operation has not been confirmed yet", 403, {
        reason: code,
        status: challenge.status,
      });
    }
    if (this.config.twoPerson && challenge.confirmedBy === challenge.requestedBy) {
      throw new CodeStepUpError("two_person_same_user_denied", "Two-person confirmation requires a different user", 403, {
        reason: "two_person_same_user_denied",
      });
    }
    const cooldownKey = this.cooldownKey(companyId, challenge.requestedBy, challenge.operation);
    const until = this.cooldownUntil.get(cooldownKey) ?? 0;
    if (until > this.now()) {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: "step_up_cooldown_active" });
      throw new CodeStepUpError(
        "step_up_cooldown_active",
        "A production operation was just confirmed; wait for the cooldown before confirming another",
        429,
        { reason: "step_up_cooldown_active", retryAfterMs: until - this.now() },
        true,
      );
    }
    return { ...challenge };
  }

  /** Marks the grant used. Replay with the same hash is refused, and the cooldown starts here. */
  async consumeGrant(ctx: AuthContext, companyId: string, input: ConfirmStepUpInput): Promise<StepUpChallenge> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.companyId !== companyId) {
      throw new CodeStepUpError("step_up_challenge_not_found", "Unknown step-up challenge", 404, { reason: "step_up_challenge_not_found" });
    }
    if (challenge.consumedAt || challenge.status === "consumed") {
      await this.audit("code.prod.step_up.denied", ctx, companyId, input, "deny", { reason: "two_person_replay_denied", challengeId: challenge.id });
      throw new CodeStepUpError(
        this.config.twoPerson ? "two_person_replay_denied" : "step_up_replay_denied",
        "This confirmation was already consumed",
        409,
        { reason: this.config.twoPerson ? "two_person_replay_denied" : "step_up_replay_denied" },
      );
    }
    if (challenge.payloadHash !== input.payloadHash) {
      throw new CodeStepUpError("step_up_payload_mismatch", "Payload hash does not match the confirmation", 409, {
        reason: "step_up_payload_mismatch",
      });
    }
    if (challenge.status !== "confirmed") {
      throw new CodeStepUpError("step_up_required", "The production operation was never confirmed", 403, { reason: "step_up_required" });
    }
    challenge.consumedAt = new Date(this.now()).toISOString();
    challenge.status = "consumed";
    this.challenges.set(challenge.id, challenge);
    this.cooldownUntil.set(this.cooldownKey(companyId, challenge.requestedBy, challenge.operation), this.now() + this.config.cooldownMs);
    await this.audit("code.prod.step_up.consumed", ctx, companyId, { operation: challenge.operation, payloadHash: challenge.payloadHash }, "allow", {
      challengeId: challenge.id,
      cooldownMs: this.config.cooldownMs,
    });
    return { ...challenge };
  }

  /** Test/administration helper: drop expired challenges so the map cannot grow without bound. */
  pruneExpired(): number {
    let removed = 0;
    for (const [id, challenge] of this.challenges) {
      if (this.isExpired(challenge)) {
        this.challenges.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private isExpired(challenge: StepUpChallenge): boolean {
    return new Date(challenge.expiresAt).getTime() <= this.now();
  }

  private cooldownKey(companyId: string, userId: string, operation: string): string {
    return `${companyId}\u0000${userId}\u0000${operation}`;
  }

  /**
   * Audit before the decision is applied: if the journal is unavailable a privileged production step is
   * refused rather than silently continued (rule 23, fail closed).
   */
  private async audit(
    action: string,
    ctx: AuthContext,
    companyId: string,
    input: { operation?: string; payloadHash?: string },
    decision: "allow" | "deny",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.deps.audit) {
      throw new CodeStepUpError("audit_unavailable", "This production step requires the audit journal", 503, {
        reason: "audit_unavailable",
        requiredPermission: CODE_PROD_OPERATE_PERMISSION,
        privilegedPermissions: CODE_PRIVILEGED_PERMISSIONS,
      });
    }
    try {
      await this.deps.audit.record({
        action,
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "code_production_step_up",
        resourceId: String(metadata.challengeId ?? input.operation ?? companyId),
        decision,
        ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
        metadata: { operation: input.operation ?? null, ...metadata },
      });
    } catch (error) {
      if (error instanceof CodeStepUpError) throw error;
      this.deps.logger?.warn({ err: error }, "code_step_up_audit_failed");
      throw new CodeStepUpError("audit_unavailable", "This production step requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
  }
}
