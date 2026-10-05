import { createHash } from "node:crypto";
import type { AuditChainVerification, AuditEntry } from "./types";

/**
 * C1c: canonical hashing and chain verification for the audit log.
 *
 * Kept in one place so PostgreSQL and the in-memory store produce byte-identical hashes and so the
 * verifier can be unit-tested as a pure function (a crafted, tampered entry list must be detected).
 */

/** Stable JSON with recursively sorted object keys, so a hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hash of the exact action payload (used for `payload_hash`, never the payload itself). */
export function canonicalPayloadHash(payload: unknown): string {
  return sha256(canonicalJson(payload ?? null));
}

/** The fields that participate in the chain hash (metadata is hashed, never trusted later). */
export interface AuditHashMaterial {
  id: string;
  companyId: string;
  sequence: number;
  createdAt: string;
  actor: string;
  actorRole: string;
  requestId: string | null;
  correlationId: string | null;
  snapshotId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  decision: string;
  payloadHash: string;
  metadata: Record<string, unknown>;
}

export function auditEntryHash(prevHash: string | null, material: AuditHashMaterial): string {
  return sha256(`${prevHash ?? ""}|${canonicalJson(material)}`);
}

/**
 * Verifies a chain: sequence continuity, `prev_hash` linking and every `entry_hash`.
 * Returns the first break so an operator can investigate a specific entry.
 */
export function verifyAuditEntries(entries: AuditEntry[]): AuditChainVerification {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  if (!ordered.length) return { companyId: "", ok: true, entryCount: 0, headHash: null };
  const companyId = ordered[0]!.companyId;
  let prevHash: string | null = null;
  let expectedSequence = ordered[0]!.sequence;
  for (const entry of ordered) {
    if (entry.companyId !== companyId) return { companyId, ok: false, entryCount: ordered.length, brokenAtSequence: entry.sequence, reason: "entry belongs to another company", headHash: prevHash };
    if (expectedSequence === ordered[0]!.sequence && entry.sequence === 1 && entry.prevHash !== null) {
      return { companyId, ok: false, entryCount: ordered.length, brokenAtSequence: 1, reason: "first entry must not have a prev_hash", headHash: prevHash };
    }
    if (entry.sequence !== expectedSequence) {
      return { companyId, ok: false, entryCount: ordered.length, brokenAtSequence: entry.sequence, reason: `expected sequence ${expectedSequence}, found ${entry.sequence}`, headHash: prevHash };
    }
    if ((entry.prevHash ?? null) !== prevHash) {
      return { companyId, ok: false, entryCount: ordered.length, brokenAtSequence: entry.sequence, reason: "prev_hash does not match the previous entry hash", headHash: prevHash };
    }
    const expected = auditEntryHash(prevHash, {
      id: entry.id, companyId: entry.companyId, sequence: entry.sequence, createdAt: entry.createdAt,
      actor: entry.actor, actorRole: entry.actorRole,
      requestId: entry.requestId ?? null, correlationId: entry.correlationId ?? null, snapshotId: entry.snapshotId ?? null,
      action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null, decision: entry.decision, payloadHash: entry.payloadHash,
      metadata: entry.metadata ?? {},
    });
    if (expected !== entry.entryHash) {
      return { companyId, ok: false, entryCount: ordered.length, brokenAtSequence: entry.sequence, reason: "entry_hash does not match the entry content", headHash: prevHash };
    }
    prevHash = entry.entryHash;
    expectedSequence = entry.sequence + 1;
  }
  return { companyId, ok: true, entryCount: ordered.length, headHash: prevHash };
}
