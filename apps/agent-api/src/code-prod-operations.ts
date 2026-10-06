import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { CodeRbac, CodeRbacError, classifyPrincipal, createRoleRegistry, type CodeRoleRegistry } from "./code-rbac";
import {
  CODE_PROD_OPERATE_PERMISSION,
  CodeStepUp,
  CodeStepUpError,
  holdsProductionPermission,
  productionPayloadHash,
  resolveStepUpConfig,
  type CodePrivilegedAuditPort,
  type StepUpChallenge,
  type StepUpConfig,
} from "./code-step-up";

/**
 * C5a — production operations.
 *
 * Owner decisions implemented here:
 *  - `code.prod.operate` is a **separate permission that no default role holds**; a wildcard (`*`,
 *    `admin:all`, `owner`) never implies it (enforced by the RBAC registry and mirrored by
 *    `holdsProductionPermission`).
 *  - Production operations are performed by **platform executors** (the existing `DeployProvider` /
 *    promote flow), never by credentials inside an agent shell. This module therefore exposes an
 *    executor **interface** plus a `Null` implementation that always refuses, because the real deploy
 *    provider is not part of this step.
 *  - Step-up by default, two-person by configuration (see `code-step-up.ts`).
 *
 * Order of checks matters and is deliberate: the operation must be known, must not carry credentials and
 * must not be routed through the sandbox, the principal must be a human, RBAC must grant the privileged
 * permission explicitly, and only then is a step-up confirmation required and consumed.
 */

/** Operations a platform executor may run. Unknown names are refused rather than forwarded. */
export const PRODUCTION_OPERATIONS = [
  "deploy.release",
  "deploy.promote",
  "migration.apply",
  "credential.rotate",
] as const;

export type ProductionOperation = (typeof PRODUCTION_OPERATIONS)[number];

/**
 * Payload keys that would smuggle a credential into a production operation. Production credentials live
 * with the executor, never in a request payload, a sandbox environment or a shell command.
 */
const CREDENTIAL_KEY = /pass(word|wd)?|token|secret|api[_-]?key|private[_-]?key|credential|authorization|cookie|bearer|ssh[_-]?key/i;
/** Payload keys that would route a production operation through the sandbox or a shell. */
const SANDBOX_KEY = /^(command|cmd|shell|script|sandbox|sandboxId|container|dockerfile|image|env|environment|tool|toolName|argv)$/i;

export class CodeProductionError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeProductionError";
    this.retryable = retryable;
  }
}

export interface ProductionExecutorRequest {
  companyId: string;
  operation: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  requestedBy: string;
  confirmedBy: string;
  challengeId: string;
}

export interface ProductionExecutorResult {
  operation: string;
  reference?: string;
  details?: Record<string, unknown>;
}

export interface ProductionExecutor {
  readonly kind: string;
  execute(request: ProductionExecutorRequest): Promise<ProductionExecutorResult>;
}

/**
 * Default executor: refuses. The real provider (Dokploy/DeployProvider, promote flow) is wired in a later
 * step, so today every production operation stops here instead of being half-implemented.
 */
export class NullProductionExecutor implements ProductionExecutor {
  readonly kind = "null";

  async execute(request: ProductionExecutorRequest): Promise<ProductionExecutorResult> {
    throw new CodeProductionError(
      "production_executor_unavailable",
      `No platform executor is configured for ${request.operation}`,
      503,
      { reason: "production_executor_unavailable", operation: request.operation, executor: this.kind },
      false,
    );
  }
}

export interface ProductionGrant {
  operation: string;
  payloadHash: string;
  principal: "user";
  role: string | null;
  requestedBy: string;
  confirmedBy: string;
  challengeId: string;
  twoPerson: boolean;
}

export interface CodeProductionDeps {
  rbac?: CodeRbac;
  stepUp?: CodeStepUp;
  /** Platform executor. Defaults to `NullProductionExecutor` (always refuses). */
  executor?: ProductionExecutor;
  audit?: CodePrivilegedAuditPort;
  registry?: CodeRoleRegistry;
  /** Operations this installation allows. Defaults to `PRODUCTION_OPERATIONS`. */
  allowedOperations?: readonly string[];
  logger?: { warn(payload: unknown, message?: string): void };
}

export interface ProductionOperationInput {
  operation: string;
  payload?: Record<string, unknown>;
  /** The step-up challenge presented by the caller. */
  challengeId?: string;
}

export class CodeProductionOperations {
  private readonly rbac: CodeRbac;
  private readonly stepUp: CodeStepUp;
  private readonly executor: ProductionExecutor;
  private readonly registry: CodeRoleRegistry;
  private readonly allowed: Set<string>;

  constructor(private readonly deps: CodeProductionDeps = {}) {
    this.registry = deps.registry ?? createRoleRegistry();
    this.rbac = deps.rbac ?? new CodeRbac({ registry: this.registry, ...(deps.audit ? { audit: deps.audit } : {}) });
    this.stepUp = deps.stepUp ?? new CodeStepUp({ registry: this.registry, ...(deps.audit ? { audit: deps.audit } : {}) });
    this.executor = deps.executor ?? new NullProductionExecutor();
    this.allowed = new Set(deps.allowedOperations ?? PRODUCTION_OPERATIONS);
  }

  get stepUpConfig(): StepUpConfig {
    return this.stepUp.effectiveConfig;
  }

  get executorKind(): string {
    return this.executor.kind;
  }

  /** Step 1 of the flow: open a confirmation for a production operation. */
  async requestProductionConfirmation(
    ctx: AuthContext,
    companyId: string,
    input: ProductionOperationInput,
  ): Promise<StepUpChallenge> {
    const payload = input.payload ?? {};
    this.assertOperationKnown(input.operation);
    this.assertPayloadSafe(input.operation, payload);
    const payloadHash = productionPayloadHash(input.operation, payload);
    return this.stepUp.requestConfirmation(ctx, companyId, { operation: input.operation, payloadHash, payload });
  }

  /** Step 2 of the flow: confirm (a different human when two-person is enabled). */
  async confirmProductionOperation(
    ctx: AuthContext,
    companyId: string,
    input: { challengeId: string; operation: string; payload?: Record<string, unknown> },
  ): Promise<StepUpChallenge> {
    const payload = input.payload ?? {};
    this.assertOperationKnown(input.operation);
    return this.stepUp.confirmConfirmation(ctx, companyId, {
      challengeId: input.challengeId,
      payloadHash: productionPayloadHash(input.operation, payload),
    });
  }

  /**
   * The guard itself: everything a production operation must satisfy before it reaches an executor.
   * Returns the grant, consumed — a second call with the same confirmation is refused as a replay.
   */
  async assertProductionOperationAllowed(
    ctx: AuthContext,
    companyId: string,
    input: ProductionOperationInput,
  ): Promise<ProductionGrant> {
    const payload = input.payload ?? {};
    this.assertOperationKnown(input.operation);
    this.assertPayloadSafe(input.operation, payload);

    // Hard invariant: human only. Production is never executed by an agent or a service identity.
    const principal = classifyPrincipal(ctx);
    if (principal !== "user") {
      const code = principal === "agent" ? "agent_cannot_operate_production" : "service_identity_cannot_operate_production";
      await this.recordDeny(ctx, companyId, input, code, principal);
      throw new CodeProductionError(code, "Production operations are performed by platform executors on behalf of a human operator", 403, {
        reason: code,
        principal,
      });
    }

    // RBAC: privileged permission, must be named explicitly by the role — a wildcard never grants it.
    try {
      await this.rbac.authorize(ctx, companyId, {
        permission: CODE_PROD_OPERATE_PERMISSION,
        action: "code.prod.operate",
        production: true,
      });
    } catch (error) {
      const known = error as CodeRbacError;
      const code = known?.code ?? "permission_denied";
      throw new CodeProductionError(code, known?.message ?? "Production operations are not granted to this principal", known?.httpStatus ?? 403, {
        reason: code,
        permission: CODE_PROD_OPERATE_PERMISSION,
        wildcardDoesNotGrant: true,
      });
    }
    if (!holdsProductionPermission(ctx, this.registry)) {
      // Defence in depth: the registry already refuses this, and the explicit check keeps the invariant
      // intact even if a custom matrix is injected.
      throw new CodeProductionError(
        "production_permission_required",
        `Production operations require ${CODE_PROD_OPERATE_PERMISSION} to be named on the role`,
        403,
        { reason: "production_permission_required", permission: CODE_PROD_OPERATE_PERMISSION },
      );
    }

    const payloadHash = productionPayloadHash(input.operation, payload);
    const challenge = await this.stepUp.requireStepUp(ctx, companyId, {
      operation: input.operation,
      payloadHash,
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    });
    if (!challenge.confirmedBy) {
      throw new CodeProductionError("step_up_required", "The production operation has no confirmer on record", 403, {
        reason: "step_up_required",
      });
    }
    // Consume before executing: a production operation is not idempotent, so a second attempt must
    // require a fresh confirmation rather than reusing this one.
    await this.stepUp.consumeGrant(ctx, companyId, { challengeId: challenge.id, payloadHash });

    await this.audit(ctx, companyId, "code.prod.operation.authorized", input, "allow", {
      payloadHash,
      challengeId: challenge.id,
      requestedBy: challenge.requestedBy,
      confirmedBy: challenge.confirmedBy,
      twoPerson: challenge.twoPerson,
      executor: this.executor.kind,
    });

    return {
      operation: input.operation,
      payloadHash,
      principal: "user",
      role: this.registry.roleOf(ctx),
      requestedBy: challenge.requestedBy,
      confirmedBy: challenge.confirmedBy,
      challengeId: challenge.id,
      twoPerson: challenge.twoPerson,
    };
  }

  /**
   * Guard + platform executor. The default executor always refuses (`production_executor_unavailable`),
   * which is the intended state until the real deploy/promote provider is wired.
   */
  async executeProductionOperation(
    ctx: AuthContext,
    companyId: string,
    input: ProductionOperationInput,
  ): Promise<ProductionExecutorResult> {
    const grant = await this.assertProductionOperationAllowed(ctx, companyId, input);
    try {
      const result = await this.executor.execute({
        companyId,
        operation: grant.operation,
        payload: input.payload ?? {},
        payloadHash: grant.payloadHash,
        requestedBy: grant.requestedBy,
        confirmedBy: grant.confirmedBy,
        challengeId: grant.challengeId,
      });
      await this.audit(ctx, companyId, "code.prod.operation.executed", input, "allow", {
        payloadHash: grant.payloadHash,
        executor: this.executor.kind,
        reference: result.reference ?? null,
      });
      return result;
    } catch (error) {
      const known = error as CodeProductionError;
      await this.audit(ctx, companyId, "code.prod.operation.denied", input, "deny", {
        payloadHash: grant.payloadHash,
        executor: this.executor.kind,
        code: known?.code ?? "production_execution_failed",
      }).catch((auditError) => this.deps.logger?.warn({ err: auditError }, "code_prod_audit_failed"));
      throw error;
    }
  }

  private assertOperationKnown(operation: string): void {
    if (!this.allowed.has(operation)) {
      throw new CodeProductionError("production_operation_unknown", `Unknown production operation: ${operation}`, 400, {
        reason: "production_operation_unknown",
        allowed: [...this.allowed],
      });
    }
  }

  /**
   * A production payload may describe **what** to do, never carry a credential and never be a sandbox
   * command. This is the explicit check that production credentials cannot travel into a sandbox or shell.
   */
  private assertPayloadSafe(operation: string, payload: Record<string, unknown>): void {
    for (const key of Object.keys(payload)) {
      if (CREDENTIAL_KEY.test(key)) {
        throw new CodeProductionError(
          "production_credentials_not_allowed",
          "Production credentials must stay with the platform executor and never appear in a request payload",
          403,
          { reason: "production_credentials_not_allowed", operation, key },
        );
      }
      if (SANDBOX_KEY.test(key)) {
        throw new CodeProductionError(
          "production_operation_cannot_use_sandbox",
          "A production operation cannot be routed through the sandbox or a shell command",
          403,
          { reason: "production_operation_cannot_use_sandbox", operation, key },
        );
      }
      const value = payload[key];
      if (typeof value === "string" && SANDBOX_KEY.test(value.trim())) {
        throw new CodeProductionError(
          "production_operation_cannot_use_sandbox",
          "A production operation cannot be routed through the sandbox or a shell command",
          403,
          { reason: "production_operation_cannot_use_sandbox", operation, key },
        );
      }
    }
  }

  private async recordDeny(
    ctx: AuthContext,
    companyId: string,
    input: ProductionOperationInput,
    code: string,
    principal: string,
  ): Promise<void> {
    await this.audit(ctx, companyId, "code.prod.operation.denied", input, "deny", { code, principal }).catch((error) =>
      this.deps.logger?.warn({ err: error }, "code_prod_audit_failed"),
    );
  }

  /**
   * Fail closed for privileged steps: without a journal the operation is refused (rule 23). Denials are
   * attempted first and degrade to a log line, because refusing to *log* a denial must not turn a denial
   * into an allow.
   */
  private async audit(
    ctx: AuthContext,
    companyId: string,
    action: string,
    input: ProductionOperationInput,
    decision: "allow" | "deny",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) {
      if (decision === "deny") {
        this.deps.logger?.warn({ action, companyId, ...metadata }, "code_prod_audit_unavailable");
        return;
      }
      throw new CodeProductionError("audit_unavailable", "This production operation requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
    try {
      await this.deps.audit.record({
        action,
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "code_production_operation",
        resourceId: input.operation,
        decision,
        ...(typeof metadata.payloadHash === "string" ? { payloadHash: metadata.payloadHash } : {}),
        metadata,
      });
    } catch (error) {
      if (decision === "deny") {
        this.deps.logger?.warn({ err: error, action }, "code_prod_audit_failed");
        return;
      }
      this.deps.logger?.warn({ err: error }, "code_prod_audit_failed");
      throw new CodeProductionError("audit_unavailable", "This production operation requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
  }
}

/** Default step-up configuration for this installation, resolved from the environment. */
export function resolveProductionStepUpConfig(env: Record<string, string | undefined> = process.env): StepUpConfig {
  return resolveStepUpConfig(env);
}

export interface ProductionRouteDeps {
  service: CodeProductionOperations;
  getAuthContext: (request: unknown) => AuthContext | null;
}

/**
 * Production routes. They exist so the guard is reachable and auditable rather than theoretical: every one
 * of them ends in a refusal for anybody (no role holds `code.prod.operate`, agents and service identities
 * are refused outright) and, once a human operator is granted the permission and confirms via step-up, in
 * `production_executor_unavailable` until the real platform executor is wired.
 */
export async function registerCodeProductionRoutes(instance: FastifyInstance, deps: ProductionRouteDeps) {
  const authOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new CodeProductionError("unauthorized", "Authentication required", 401, { reason: "unauthorized" });
    return context;
  };
  const fail = (reply: { status(code: number): { send(payload: unknown): unknown } }, error: unknown) => {
    const known = error as CodeProductionError | CodeStepUpError;
    const status = known?.httpStatus ?? 500;
    return reply.status(status).send({
      status: "error",
      code: known?.code ?? "production_operation_failed",
      message: known?.message ?? "Production operation failed",
      details: known?.details ?? {},
    });
  };

  instance.post("/companies/:companyId/code/production-operations/request", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string };
      const body = (request.body ?? {}) as { operation?: string; payload?: Record<string, unknown> };
      if (!body.operation) return reply.status(400).send({ status: "error", code: "invalid_arguments", message: "operation is required" });
      const challenge = await deps.service.requestProductionConfirmation(context, params.companyId, {
        operation: body.operation,
        payload: body.payload ?? {},
      });
      return reply.send({ status: "ok", challenge });
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.post("/companies/:companyId/code/production-operations/confirm", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string };
      const body = (request.body ?? {}) as { challengeId?: string; operation?: string; payload?: Record<string, unknown> };
      if (!body.challengeId || !body.operation) {
        return reply.status(400).send({ status: "error", code: "invalid_arguments", message: "challengeId and operation are required" });
      }
      const challenge = await deps.service.confirmProductionOperation(context, params.companyId, {
        challengeId: body.challengeId,
        operation: body.operation,
        payload: body.payload ?? {},
      });
      return reply.send({ status: "ok", challenge });
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.post("/companies/:companyId/code/production-operations", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string };
      const body = (request.body ?? {}) as { operation?: string; payload?: Record<string, unknown>; challengeId?: string };
      if (!body.operation) return reply.status(400).send({ status: "error", code: "invalid_arguments", message: "operation is required" });
      const result = await deps.service.executeProductionOperation(context, params.companyId, {
        operation: body.operation,
        payload: body.payload ?? {},
        ...(body.challengeId ? { challengeId: body.challengeId } : {}),
      });
      return reply.send({ status: "ok", apiVersion: "code.production.v1", result });
    } catch (error) {
      return fail(reply, error);
    }
  });
}

export { CodeStepUpError };
