import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { CodeRbac } from "../apps/agent-api/src/code-rbac";
import { CodeStepUp, CodeStepUpError, productionPayloadHash, resolveStepUpConfig } from "../apps/agent-api/src/code-step-up";
import {
  CodeProductionOperations,
  CodeProductionError,
  NullProductionExecutor,
  PRODUCTION_OPERATIONS,
} from "../apps/agent-api/src/code-prod-operations";

/**
 * C5a security-gate: `code.prod.operate`, step-up and two-person confirmation.
 *
 * The invariants pinned here are the owner's decisions: the permission is never implied by a wildcard, an
 * agent or service identity can never perform a production operation, step-up is the default gate, and when
 * two-person is enabled the same user cannot satisfy both halves.
 */

const OPERATION = "deploy.release";

function user(overrides: Partial<AuthContext> & { userId: string; permissions: string[] }): AuthContext {
  return {
    workspaceId: "ws-1",
    companyId: "company-1",
    ...overrides,
  } as AuthContext;
}

interface AuditEntry {
  action: string;
  actor: string;
  decision?: string;
  payloadHash?: string;
  metadata?: Record<string, unknown>;
}

function auditSpy(): { entries: AuditEntry[]; port: { record: (input: AuditEntry & { companyId: string; resourceType: string; resourceId: string }) => Promise<void> } } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    port: {
      record: async (input) => {
        entries.push(input);
      },
    },
  };
}

function build(options: { twoPerson?: boolean; cooldownMs?: number; ttlMs?: number; now?: () => number } = {}) {
  const spy = auditSpy();
  const registry = undefined;
  const stepUp = new CodeStepUp({
    audit: spy.port,
    config: { twoPerson: options.twoPerson ?? false, cooldownMs: options.cooldownMs ?? 60_000, ttlMs: options.ttlMs ?? 300_000 },
    ...(options.now ? { now: options.now } : {}),
  });
  const operations = new CodeProductionOperations({
    rbac: new CodeRbac({ audit: spy.port }),
    stepUp,
    executor: new NullProductionExecutor(),
    audit: spy.port,
    registry,
  });
  return { spy, stepUp, operations };
}

describe("security-gate: C5a production operations require code.prod.operate and a step-up", () => {
  it("refuses a user whose role does not name code.prod.operate, and a wildcard never grants it", async () => {
    const { operations } = build();
    // `code.prod.operate` is privileged, so RBAC answers with the production requirement rather than a
    // generic denial — the same code the API surfaces for "your role does not name this permission".
    const adminOnly = user({ userId: "u-admin", permissions: ["admin:all", "*", "owner"] });
    await expect(operations.assertProductionOperationAllowed(adminOnly, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "production_permission_required",
      httpStatus: 403,
    });
    const plain = user({ userId: "u-member", permissions: ["workspace:write"] });
    await expect(operations.assertProductionOperationAllowed(plain, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "production_permission_required",
      httpStatus: 403,
    });
  });

  it("refuses agents and service identities outright, even if someone names the permission on them", async () => {
    const { operations, spy } = build();
    const agent = user({ userId: "agent:runner", permissions: ["code.prod.operate"] });
    await expect(operations.assertProductionOperationAllowed(agent, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "agent_cannot_operate_production",
      httpStatus: 403,
    });
    const service = user({ userId: "service:automation:a1", permissions: ["code.prod.operate"] });
    await expect(operations.assertProductionOperationAllowed(service, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "service_identity_cannot_operate_production",
      httpStatus: 403,
    });
    expect(spy.entries.some((entry) => entry.action === "code.prod.operation.denied")).toBe(true);
  });

  it("requires a human operator, a confirmation, and then refuses at the platform executor", async () => {
    const { operations, spy, stepUp } = build();
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate", "workspace:write"] });

    // 1. No confirmation on record: refused before anything runs.
    await expect(operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "step_up_required",
      httpStatus: 403,
    });

    // 2. Step-up: request, confirm (same user is fine when two-person is off), then execute.
    const challenge = await operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: { version: "1.2.3" } });
    await operations.confirmProductionOperation(operator, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: { version: "1.2.3" } });
    await expect(
      operations.executeProductionOperation(operator, "company-1", {
        operation: OPERATION,
        payload: { version: "1.2.3" },
        challengeId: challenge.id,
      }),
    ).rejects.toMatchObject({ code: "production_executor_unavailable", httpStatus: 503 });

    // Both step-up steps carry the same payload hash.
    const hash = productionPayloadHash(OPERATION, { version: "1.2.3" });
    const requested = spy.entries.find((entry) => entry.action === "code.prod.step_up.requested");
    const confirmed = spy.entries.find((entry) => entry.action === "code.prod.step_up.confirmed");
    expect(requested?.payloadHash).toBe(hash);
    expect(confirmed?.payloadHash).toBe(hash);
    expect(spy.entries.some((entry) => entry.action === "code.prod.step_up.consumed")).toBe(true);
    expect(stepUp.effectiveConfig.twoPerson).toBe(false);
  });

  it("consumes the confirmation: the same hash cannot be replayed, and the cooldown holds", async () => {
    let now = 1_000_000;
    const { operations } = build({ cooldownMs: 60_000, now: () => now });
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    const challenge = await operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: {} });
    await operations.confirmProductionOperation(operator, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: {} });
    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, challengeId: challenge.id }),
    ).resolves.toMatchObject({ operation: OPERATION });

    // Replay of the consumed confirmation.
    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, challengeId: challenge.id }),
    ).rejects.toMatchObject({ code: "step_up_replay_denied" });

    // A fresh confirmation inside the cooldown window is refused as well.
    const second = await operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: {} });
    await operations.confirmProductionOperation(operator, "company-1", { challengeId: second.id, operation: OPERATION, payload: {} });
    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, challengeId: second.id }),
    ).rejects.toMatchObject({ code: "step_up_cooldown_active", httpStatus: 429 });

    now += 61_000;
    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, challengeId: second.id }),
    ).resolves.toMatchObject({ operation: OPERATION });
  });

  it("enforces two-person confirmation when configured: different user, same payload, no replay", async () => {
    const { operations, stepUp } = build({ twoPerson: true });
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    const second = user({ userId: "u-second", permissions: ["code.prod.operate"] });

    expect(stepUp.effectiveConfig.twoPerson).toBe(true);
    const challenge = await operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: { version: "2.0.0" } });

    // The requester cannot confirm their own production operation.
    await expect(
      operations.confirmProductionOperation(operator, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: { version: "2.0.0" } }),
    ).rejects.toMatchObject({ code: "two_person_same_user_denied" });

    // A different payload is refused.
    await expect(
      operations.confirmProductionOperation(second, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: { version: "9.9.9" } }),
    ).rejects.toMatchObject({ code: "two_person_payload_mismatch" });

    await expect(
      operations.confirmProductionOperation(second, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: { version: "2.0.0" } }),
    ).resolves.toMatchObject({ status: "confirmed", confirmedBy: "u-second" });

    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, payload: { version: "2.0.0" }, challengeId: challenge.id }),
    ).resolves.toMatchObject({ confirmedBy: "u-second", twoPerson: true });

    // Replay after use is refused.
    await expect(
      operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION, payload: { version: "2.0.0" }, challengeId: challenge.id }),
    ).rejects.toMatchObject({ code: "two_person_replay_denied" });
  });

  it("explains the missing second confirmer instead of silently degrading on a single-owner install", async () => {
    const { operations } = build({ twoPerson: true });
    const soleOwner = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    await expect(operations.assertProductionOperationAllowed(soleOwner, "company-1", { operation: OPERATION })).rejects.toMatchObject({
      code: "two_person_confirmer_required",
      httpStatus: 403,
    });
  });

  it("refuses an expired confirmation", async () => {
    let now = 5_000_000;
    const { operations } = build({ ttlMs: 1_000, now: () => now });
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    const challenge = await operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: {} });
    now += 2_000;
    await expect(
      operations.confirmProductionOperation(operator, "company-1", { challengeId: challenge.id, operation: OPERATION, payload: {} }),
    ).rejects.toMatchObject({ code: "step_up_expired" });
  });

  it("never accepts a credential or a sandbox command in a production payload", async () => {
    const { operations } = build();
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    await expect(
      operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: { deployToken: "x" } }),
    ).rejects.toMatchObject({ code: "production_credentials_not_allowed", httpStatus: 403 });
    await expect(
      operations.requestProductionConfirmation(operator, "company-1", { operation: OPERATION, payload: { command: "npm run deploy" } }),
    ).rejects.toMatchObject({ code: "production_operation_cannot_use_sandbox", httpStatus: 403 });
    await expect(
      operations.requestProductionConfirmation(operator, "company-1", { operation: "rm -rf /", payload: {} }),
    ).rejects.toMatchObject({ code: "production_operation_unknown", httpStatus: 400 });
    expect(PRODUCTION_OPERATIONS).toContain(OPERATION);
  });

  it("refuses every step when the audit journal is unavailable (fail closed)", async () => {
    const stepUp = new CodeStepUp({ config: { twoPerson: false, cooldownMs: 0, ttlMs: 300_000 } });
    const operator = user({ userId: "u-owner", permissions: ["code.prod.operate"] });
    await expect(stepUp.requestConfirmation(operator, "company-1", { operation: OPERATION, payloadHash: "h" })).rejects.toBeInstanceOf(CodeStepUpError);
    await expect(stepUp.requestConfirmation(operator, "company-1", { operation: OPERATION, payloadHash: "h" })).rejects.toMatchObject({
      code: "audit_unavailable",
      httpStatus: 503,
    });

    const operations = new CodeProductionOperations({
      rbac: new CodeRbac({}),
      stepUp: new CodeStepUp({ config: { twoPerson: false, cooldownMs: 0, ttlMs: 300_000 } }),
      executor: new NullProductionExecutor(),
    });
    await expect(operations.assertProductionOperationAllowed(operator, "company-1", { operation: OPERATION })).rejects.toBeInstanceOf(CodeProductionError);
  });

  it("resolves its configuration from the environment, with two-person off unless configured", () => {
    expect(resolveStepUpConfig({}).twoPerson).toBe(false);
    expect(resolveStepUpConfig({ NPATI_CODE_PROD_TWO_PERSON: "true" }).twoPerson).toBe(true);
    expect(resolveStepUpConfig({ NPATI_CODE_PROD_TWO_PERSON: "TRUE" }).twoPerson).toBe(true);
    expect(resolveStepUpConfig({ NPATI_CODE_PROD_STEP_UP_COOLDOWN_MS: "1" }).cooldownMs).toBe(1);
    expect(resolveStepUpConfig({ NPATI_CODE_PROD_STEP_UP_COOLDOWN_MS: "-5" }).cooldownMs).toBe(0);
    expect(resolveStepUpConfig({ NPATI_CODE_PROD_STEP_UP_COOLDOWN_MS: "999999999999" }).cooldownMs).toBe(24 * 60 * 60 * 1000);
  });
});
