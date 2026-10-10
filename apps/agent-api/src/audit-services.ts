/* Audit and privileged-decision journal wiring, extracted from app.ts
 * (step 2b of docs/refactoring/PLAN.md).
 *
 * The code is moved verbatim. The only edits are the five closure locals that became
 * parameters: config.databaseUrl -> databaseUrl, config.dataDirectory -> dataDirectory,
 * workspaceStore -> store, AUDIT_SYSTEM_WORKSPACE -> systemWorkspaceId, app.log -> log.
 */
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { AuditLogService } from "./audit-log";
import { AuditRepository } from "./audit-repository";
import { resolveAuditConfig, type AuditConfig } from "./audit-config";
import type { ApprovalDecisionAuditPort } from "./approvals-repository";

/** The pino-compatible slice of Fastify's logger that this domain uses. */
export interface AuditLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AuditServicesInput {
  databaseUrl?: string;
  dataDirectory?: string;
  store: WorkspaceStore;
  systemWorkspaceId: string;
  log: AuditLogger;
}

export interface AuditServices {
  auditRepo?: AuditRepository;
  auditConfig: AuditConfig;
  auditLogService?: AuditLogService;
  approvalDecisionAudit?: ApprovalDecisionAuditPort;
  verifyTimer?: NodeJS.Timeout;
  anchorTimer?: NodeJS.Timeout;
}

export function createAuditServices(input: AuditServicesInput): AuditServices {
  const { databaseUrl, dataDirectory, store, systemWorkspaceId, log } = input;
  const auditRepo = databaseUrl ? new AuditRepository(databaseUrl) : undefined;
  // C1c: tamper-evident journal for privileged decisions (append-only, hash-chained, anchored daily).
  const auditConfig = resolveAuditConfig(process.env, dataDirectory);
  const auditLogService = databaseUrl ? new AuditLogService(store, auditConfig) : undefined;
  /**
   * C5a: approval decisions are journalled **before** they are applied, closing the C5 audit finding that
   * decisions never reached `company_audit_logs`. When the journal is absent the port is absent too and the
   * repository keeps its previous behaviour (the port is what makes the journal mandatory in production).
   */
  const approvalDecisionAudit: ApprovalDecisionAuditPort | undefined = auditLogService
    ? {
        record: async (input) => {
          await auditLogService.record(
            { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
            {
              companyId: input.companyId,
              actor: input.actor,
              actorRole: "owner",
              action: input.action,
              resourceType: input.resourceType,
              resourceId: input.resourceId,
              decision: input.decision === "allow" ? "approved" : "rejected",
              ...(input.payloadHash ? { payload: { payload_hash: input.payloadHash } } : {}),
              metadata: input.metadata ?? {},
            },
          );
        },
      }
    : undefined;

  // C1c: background chain verification and the daily anchor. Both are read-only unless a break is
  // detected; a failed verification logs a critical alert and (by configuration) blocks new
  // privileged audit writes for that company until an operator investigates.
  const verifyTimer = auditLogService ? setInterval(() => {
    void auditLogService.verifyAll(systemWorkspaceId)
      .then((failures) => { for (const failure of failures) log.error({ failure }, "audit_chain_verification_failed"); })
      .catch((error) => log.warn({ err: error }, "audit_chain_verification_error"));
  }, auditConfig.verifyIntervalMs) : undefined;
  verifyTimer?.unref();
  const anchorTimer = auditLogService ? setInterval(() => {
    void auditLogService.writeDailyAnchors(systemWorkspaceId)
      .catch((error) => log.warn({ err: error }, "audit_anchor_write_failed"));
  }, auditConfig.anchorIntervalMs) : undefined;
  anchorTimer?.unref();

  return { auditRepo, auditConfig, auditLogService, approvalDecisionAudit, verifyTimer, anchorTimer };
}
