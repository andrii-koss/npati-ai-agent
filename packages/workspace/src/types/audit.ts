/** C1c: tamper-evident audit log types. */
export type AuditDecision = "allowed" | "denied" | "approved" | "rejected";
export interface AuditEntryInput {
  actor: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  decision: AuditDecision;
  /** SHA-256 of the canonical action payload; computed by the caller or by `AuditLogService`. */
  payloadHash: string;
  requestId?: string | null;
  correlationId?: string | null;
  snapshotId?: string | null;
  /** Already-redacted metadata: must never contain secrets or prompt content. */
  metadata?: Record<string, unknown>;
}
export interface AuditEntry extends AuditEntryInput {
  id: string;
  workspaceId: string;
  companyId: string;
  sequence: number;
  createdAt: string;
  prevHash: string | null;
  entryHash: string;
  metadata: Record<string, unknown>;
}
export interface AuditAnchor {
  id: string;
  workspaceId: string;
  companyId: string;
  day: string;
  sequence: number;
  entryCount: number;
  headHash: string;
  anchorPath?: string | null;
  signature?: string | null;
  createdAt: string;
}
export interface AuditChainState { companyId: string; entryCount: number; headSequence: number; headHash: string | null; }
export interface AuditChainVerification {
  companyId: string;
  ok: boolean;
  entryCount: number;
  /** Sequence number of the first entry that breaks the chain, when `ok` is false. */
  brokenAtSequence?: number;
  reason?: string;
  /** Hash of the last verified entry; compared against the latest anchor. */
  headHash: string | null;
}

/** C1a: feature flags with staged rollout. */
