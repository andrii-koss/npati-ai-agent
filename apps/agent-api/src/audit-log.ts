import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalPayloadHash, verifyAuditEntries,
  type AuditAnchor, type AuditChainVerification, type AuditDecision, type AuditEntry, type AuthContext, type WorkspaceStore,
} from "@npati/workspace";
import { CredentialMasker } from "./security-guardrails";
import type { AuditConfig } from "./audit-config";

/** Raised when a privileged action cannot be audited: callers must fail closed. */
export class AuditUnavailableError extends Error {
  readonly code = "audit_unavailable";
  constructor(message = "Privileged action refused: the audit log is unavailable") { super(message); }
}

export interface AuditRecordInput {
  companyId: string;
  actor: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  projectId?: string;
  decision: AuditDecision;
  /** The exact payload of the action; only its canonical hash is stored. */
  payload?: unknown;
  metadata?: Record<string, unknown>;
  requestId?: string;
  correlationId?: string;
  snapshotId?: string;
}

const FORBIDDEN_METADATA_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|prompt|instruction|body|content|diff|patch|find|replacement/i;

/**
 * Redacts audit metadata: secrets by key and by pattern (reusing the project's CredentialMasker) and
 * prompt/content-like fields entirely, so the journal never becomes a content store.
 */
export function redactAuditMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return CredentialMasker.mask(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAuditMetadata(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = FORBIDDEN_METADATA_KEY.test(key) ? "[REDACTED]" : redactAuditMetadata(item, depth + 1);
    }
    return result;
  }
  return "[UNSUPPORTED]";
}

export interface AuditVerificationReport {
  companyId: string;
  ok: boolean;
  entryCount: number;
  brokenAtSequence?: number;
  reason?: string;
  headHash: string | null;
  /** Set when the latest anchor disagrees with the verified chain. */
  anchorMismatch?: boolean;
  anchorHeadHash?: string | null;
  alert?: string;
}

/**
 * C1c: the AuditLog interface every later step uses.
 *
 * `record` is intentionally the only write path and it throws on failure (fail closed). Activity
 * stays where it is: this journal is for privileged decisions that must be provable, so it stores
 * ids, decisions, hashes and redacted metadata only.
 */
export class AuditLogService {
  private readonly brokenCompanies = new Set<string>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly config: AuditConfig = { verifyIntervalMs: 21_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true },
  ) {}

  get retentionDays(): number { return this.config.retentionDays; }
  isBlocked(companyId: string): boolean { return this.brokenCompanies.has(companyId); }
  blockedCompanies(): string[] { return [...this.brokenCompanies]; }
  /** Operator action after an investigation; also cleared implicitly by a successful verification. */
  clearBlock(companyId: string): void { this.brokenCompanies.delete(companyId); }

  async record(context: AuthContext, input: AuditRecordInput): Promise<AuditEntry> {
    if (this.config.blockOnBreak && this.brokenCompanies.has(input.companyId)) {
      throw new AuditUnavailableError("Audit chain is broken for this company; privileged operations are blocked pending investigation");
    }
    const metadata = (redactAuditMetadata(input.metadata ?? {}) as Record<string, unknown>) ?? {};
    const payloadHash = canonicalPayloadHash(input.payload ?? { action: input.action, resourceId: input.resourceId ?? null });
    try {
      return await this.store.appendAuditEntry(context, input.companyId, {
        actor: input.actor, actorRole: input.actorRole, action: input.action,
        resourceType: input.resourceType, resourceId: input.resourceId ?? null, projectId: input.projectId ?? null,
        decision: input.decision, payloadHash, metadata,
        requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
      });
    } catch (error) {
      throw new AuditUnavailableError(error instanceof Error ? `Audit write failed: ${error.message}` : "Audit write failed");
    }
  }

  async list(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> {
    return this.store.listAuditEntries(context, companyId, filters);
  }

  async export(context: AuthContext, companyId: string, limit = 1000): Promise<string> {
    const entries = await this.store.listAuditEntries(context, companyId, { limit });
    return entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  /** Verifies the chain and compares the head with the latest anchor. */
  async verify(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditVerificationReport> {
    const verification: AuditChainVerification = await this.store.verifyAuditChain(context, companyId, range);
    const anchor = await this.store.latestAuditAnchor(context, companyId);
    const anchorMismatch = Boolean(anchor && verification.ok && anchor.headHash !== verification.headHash && (range.toSequence === undefined));
    const report: AuditVerificationReport = {
      companyId, ok: verification.ok && !anchorMismatch, entryCount: verification.entryCount,
      brokenAtSequence: verification.brokenAtSequence, reason: verification.reason, headHash: verification.headHash,
      anchorMismatch, anchorHeadHash: anchor?.headHash ?? null,
    };
    if (!report.ok) {
      report.alert = `CRITICAL: audit chain verification failed for company ${companyId}`
        + (verification.reason ? ` (${verification.reason} at sequence ${verification.brokenAtSequence})` : "")
        + (anchorMismatch ? " (anchor mismatch)" : "");
      this.brokenCompanies.add(companyId);
    } else {
      this.brokenCompanies.delete(companyId);
    }
    return report;
  }

  async anchors(context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
    return this.store.listAuditAnchors(context, companyId, limit);
  }

  /**
   * Writes the daily anchor for every company that has entries: the head hash is stored in Core and
   * also written as an HMAC-signed file outside the database, so a full-table rewrite is detectable.
   * Idempotent per (company, day).
   */
  async writeDailyAnchors(workspaceId: string, now = new Date()): Promise<AuditAnchor[]> {
    const chains = await this.store.systemAuditChains(workspaceId);
    const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const written: AuditAnchor[] = [];
    for (const { companyId, state } of chains) {
      if (!state.headHash) continue;
      const payload = { companyId, day, sequence: state.headSequence, entryCount: state.entryCount, headHash: state.headHash };
      const signature = this.config.signingKey ? createHmac("sha256", this.config.signingKey).update(JSON.stringify(payload)).digest("hex") : null;
      const anchorPath = await this.writeAnchorFile(companyId, day, payload, signature);
      written.push(await this.store.systemRecordAuditAnchor(workspaceId, companyId, {
        day, sequence: state.headSequence, entryCount: state.entryCount, headHash: state.headHash, anchorPath, signature,
      }));
    }
    return written;
  }

  /** Verifies every company's chain in a workspace; returns only the failures (background task). */
  async verifyAll(workspaceId: string): Promise<AuditVerificationReport[]> {
    const chains = await this.store.systemAuditChains(workspaceId);
    const failures: AuditVerificationReport[] = [];
    for (const chain of chains) {
      const { companyId, verification, state } = chain;
      if (verification.ok) { this.brokenCompanies.delete(companyId); continue; }
      const report: AuditVerificationReport = {
        companyId, ok: false, entryCount: state.entryCount, brokenAtSequence: verification.brokenAtSequence,
        reason: verification.reason, headHash: state.headHash,
        alert: `CRITICAL: audit chain verification failed for company ${companyId}`
          + (verification.reason ? ` (${verification.reason} at sequence ${verification.brokenAtSequence})` : ""),
      };
      this.brokenCompanies.add(companyId);
      failures.push(report);
    }
    return failures;
  }

  private async writeAnchorFile(companyId: string, day: string, payload: unknown, signature: string | null): Promise<string | null> {
    if (!this.config.anchorDirectory) return null;
    try {
      await mkdir(this.config.anchorDirectory, { recursive: true });
      const file = path.join(this.config.anchorDirectory, `${companyId}-${day}.json`);
      await writeFile(file, JSON.stringify({ ...(payload as Record<string, unknown>), signature, algorithm: "hmac-sha256", createdAt: new Date().toISOString() }, null, 2), "utf8");
      return file;
    } catch {
      return null;
    }
  }

  /** Reads an anchor file back and checks its signature (used by the verification endpoint). */
  async readAnchorFile(file: string): Promise<{ ok: boolean; headHash?: string; reason?: string }> {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { companyId?: string; day?: string; sequence?: number; entryCount?: number; headHash?: string; signature?: string | null };
      if (!this.config.signingKey || !parsed.signature) return { ok: false, headHash: parsed.headHash, reason: "anchor is unsigned" };
      const expected = createHmac("sha256", this.config.signingKey)
        .update(JSON.stringify({ companyId: parsed.companyId, day: parsed.day, sequence: parsed.sequence, entryCount: parsed.entryCount, headHash: parsed.headHash }))
        .digest("hex");
      return expected === parsed.signature ? { ok: true, headHash: parsed.headHash } : { ok: false, headHash: parsed.headHash, reason: "anchor signature mismatch" };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "anchor unreadable" };
    }
  }
}

/** Pure helper used by tests and by callers that need the canonical hash of an action payload. */
export { canonicalPayloadHash, verifyAuditEntries };
