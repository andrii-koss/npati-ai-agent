import { randomUUID } from "node:crypto";
import type {
  AuthContext, AuditEntry, AuditEntryInput, AuditAnchor,
  AuditChainState, AuditChainVerification, Company,
} from "./types";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { now } from "./in-memory-clock";

export interface InMemoryAuditState {
  auditLog: Map<string, AuditEntry[]>;
  auditAnchors: Map<string, AuditAnchor[]>;
  assertCompany: (context: AuthContext, companyId: string) => Company;
}

export async function appendAuditEntry(host: InMemoryAuditState, context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> {
  host.assertCompany(context, companyId);
  const chain = host.auditLog.get(companyId) ?? [];
  const prevHash = chain.length ? chain[chain.length - 1]!.entryHash : null;
  const sequence = chain.length + 1;
  const createdAt = now();
  const metadata = input.metadata ?? {};
  const id = randomUUID();
  const entry: AuditEntry = {
    id, workspaceId: context.workspaceId, companyId, sequence, createdAt,
    actor: input.actor, actorRole: input.actorRole, action: input.action,
    resourceType: input.resourceType, resourceId: input.resourceId ?? null,
    projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash,
    requestId: input.requestId ?? null, correlationId: input.correlationId ?? null,
    snapshotId: input.snapshotId ?? null, metadata, prevHash,
    entryHash: auditEntryHash(prevHash, {
      id, companyId, sequence, createdAt, actor: input.actor, actorRole: input.actorRole,
      requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
      action: input.action, resourceType: input.resourceType, resourceId: input.resourceId ?? null,
      projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash, metadata,
    }),
  };
  chain.push(entry);
  host.auditLog.set(companyId, chain);
  return structuredClone(entry);
}

export async function listAuditEntries(
  host: InMemoryAuditState,
  context: AuthContext,
  companyId: string,
  filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {},
): Promise<AuditEntry[]> {
  host.assertCompany(context, companyId);
  const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));
  return structuredClone((host.auditLog.get(companyId) ?? [])
    .filter((entry) => (!filters.actor || entry.actor === filters.actor)
      && (!filters.requestId || entry.requestId === filters.requestId)
      && (!filters.correlationId || entry.correlationId === filters.correlationId)
      && (!filters.action || entry.action === filters.action)
      && (filters.fromSequence === undefined || entry.sequence >= filters.fromSequence))
    .slice(0, limit));
}

export async function verifyAuditChain(
  host: InMemoryAuditState,
  context: AuthContext,
  companyId: string,
  range: { fromSequence?: number; toSequence?: number } = {},
): Promise<AuditChainVerification> {
  host.assertCompany(context, companyId);
  const entries = (host.auditLog.get(companyId) ?? []).filter((entry) =>
    (range.fromSequence === undefined || entry.sequence >= range.fromSequence)
    && (range.toSequence === undefined || entry.sequence <= range.toSequence));
  const verification = verifyAuditEntries(entries);
  return { ...verification, companyId };
}

export async function auditChainState(host: InMemoryAuditState, context: AuthContext, companyId: string): Promise<AuditChainState> {
  host.assertCompany(context, companyId);
  const chain = host.auditLog.get(companyId) ?? [];
  return { companyId, entryCount: chain.length, headSequence: chain.length, headHash: chain.length ? chain[chain.length - 1]!.entryHash : null };
}

export async function recordAuditAnchor(
  host: InMemoryAuditState,
  context: AuthContext,
  companyId: string,
  anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null },
): Promise<AuditAnchor> {
  host.assertCompany(context, companyId);
  const record: AuditAnchor = {
    id: randomUUID(), workspaceId: context.workspaceId, companyId, day: anchor.day, sequence: anchor.sequence,
    entryCount: anchor.entryCount, headHash: anchor.headHash, anchorPath: anchor.anchorPath ?? null,
    signature: anchor.signature ?? null, createdAt: now(),
  };
  const existing = host.auditAnchors.get(companyId) ?? [];
  host.auditAnchors.set(companyId, [...existing.filter((item) => item.day !== anchor.day), record]);
  return structuredClone(record);
}

export async function listAuditAnchors(host: InMemoryAuditState, context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
  host.assertCompany(context, companyId);
  return structuredClone((host.auditAnchors.get(companyId) ?? [])
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, Math.max(1, Math.min(limit, 365))));
}

export async function latestAuditAnchor(host: InMemoryAuditState, context: AuthContext, companyId: string): Promise<AuditAnchor | null> {
  return (await listAuditAnchors(host, context, companyId, 1))[0] ?? null;
}

export async function auditCompanies(host: InMemoryAuditState, context: AuthContext): Promise<string[]> {
  return [...host.auditLog.entries()]
    .filter(([, entries]) => entries.length > 0 && entries[0]!.workspaceId === context.workspaceId)
    .map(([companyId]) => companyId)
    .sort();
}

export async function systemAuditChains(host: InMemoryAuditState, workspaceId: string) {
  return [...host.auditLog.entries()]
    .filter(([, entries]) => entries.length > 0 && entries[0]!.workspaceId === workspaceId)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([companyId, entries]) => ({
      companyId,
      state: { companyId, entryCount: entries.length, headSequence: entries.length, headHash: entries[entries.length - 1]!.entryHash },
      verification: { ...verifyAuditEntries(entries), companyId },
    }));
}

export async function systemRecordAuditAnchor(
  host: InMemoryAuditState,
  workspaceId: string,
  companyId: string,
  anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null },
): Promise<AuditAnchor> {
  const record: AuditAnchor = {
    id: randomUUID(), workspaceId, companyId, day: anchor.day,
    sequence: anchor.sequence, entryCount: anchor.entryCount, headHash: anchor.headHash,
    anchorPath: anchor.anchorPath ?? null, signature: anchor.signature ?? null, createdAt: now(),
  };
  const existing = host.auditAnchors.get(companyId) ?? [];
  host.auditAnchors.set(companyId, [...existing.filter((item) => item.day !== anchor.day), record]);
  return structuredClone(record);
}

