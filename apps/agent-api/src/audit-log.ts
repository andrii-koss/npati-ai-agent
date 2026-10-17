import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalPayloadHash, verifyAuditEntries,
  type AuditAnchor, type AuditChainVerification, type AuditDecision, type AuditEntry, type AuthContext, type WorkspaceStore,
} from "@npati/workspace";
import { classifyPrincipal } from "./code-principal";
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
  /** Trusted internal approval adapters may provide an already canonical action hash. Never a public request field. */
  payloadHash?: string;
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

  /** Adapters resolve the stored role instead of labelling every principal as an owner. */
  async resolveActorRole(companyId: string, actor: string): Promise<string> {
    const kind = actor === "system" ? "service" : classifyPrincipal({ userId: actor });
    if (kind !== "user") return kind;
    return (await this.store.getCompanyMembership(companyId, actor))?.role ?? "unknown";
  }

  async record(context: AuthContext, input: AuditRecordInput): Promise<AuditEntry> {
    if (this.config.blockOnBreak && this.brokenCompanies.has(input.companyId)) {
      throw new AuditUnavailableError("Audit chain is broken for this company; privileged operations are blocked pending investigation");
    }
    const metadata = (redactAuditMetadata(input.metadata ?? {}) as Record<string, unknown>) ?? {};
    if (input.payloadHash !== undefined && (!/^[a-f0-9]{64}$/.test(input.payloadHash)
      || (input.payload !== undefined && canonicalPayloadHash(input.payload) !== input.payloadHash)))
      throw new AuditUnavailableError("Invalid or inconsistent action payload hash");
    const payloadHash = input.payloadHash ?? canonicalPayloadHash(input.payload ?? { action: input.action, resourceId: input.resourceId ?? null });
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

  /** Check an anchor against its own prefix, never against a later live head. */
  private async anchorFailure(anchor: AuditAnchor | null | undefined, prefix?: AuditChainVerification): Promise<string | undefined> {
    if (!anchor) return undefined;
    if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || !prefix?.ok
      || prefix.entryCount !== anchor.entryCount || prefix.entryCount !== anchor.sequence || prefix.headHash !== anchor.headHash)
      return "anchor does not match its chain prefix";
    if (anchor.anchorPath) {
      const external = await this.readAnchorFile(anchor.anchorPath, anchor);
      if (!external.ok) return external.reason ?? "external anchor verification failed";
    } else if (this.config.anchorDirectory) return "external anchor is missing";
    return undefined;
  }

  /** Verifies a range including its predecessor prefix; only a full clean verification clears a block. */
  async verify(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditVerificationReport> {
    for (const value of [range.fromSequence, range.toSequence]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid audit sequence range");
    }
    if (range.fromSequence !== undefined && range.toSequence !== undefined && range.fromSequence > range.toSequence)
      throw new Error("Invalid audit sequence range");
    const verification = await this.store.verifyAuditChain(context, companyId, range);
    const anchor = await this.store.latestAuditAnchor(context, companyId);
    const prefix = anchor ? await this.store.verifyAuditChain(context, companyId, { toSequence: anchor.sequence }) : undefined;
    const anchorReason = await this.anchorFailure(anchor, prefix);
    const report: AuditVerificationReport = {
      companyId, ok: verification.ok && !anchorReason, entryCount: verification.entryCount,
      brokenAtSequence: verification.brokenAtSequence, reason: verification.reason ?? anchorReason, headHash: verification.headHash,
      anchorMismatch: Boolean(anchorReason), anchorHeadHash: anchor?.headHash ?? null,
    };
    if (!report.ok) {
      report.alert = "CRITICAL: audit chain verification failed for company " + companyId + (report.reason ? " (" + report.reason + ")" : "");
      this.brokenCompanies.add(companyId);
    } else if (range.fromSequence === undefined && range.toSequence === undefined) this.brokenCompanies.delete(companyId);
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
    for (const { companyId, state, anchor, verification, anchorVerification } of chains) {
      if (!state.headHash) continue;
      const anchorReason = await this.anchorFailure(anchor, anchorVerification);
      if (!verification.ok || anchorReason) {
        this.brokenCompanies.add(companyId);
        throw new AuditUnavailableError("Cannot anchor a broken audit chain");
      }
      if (anchor?.day === day) { written.push(anchor); continue; }
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
      const { companyId, verification, state, anchor, anchorVerification } = chain;
      const anchorReason = await this.anchorFailure(anchor, anchorVerification);
      if (verification.ok && !anchorReason) { this.brokenCompanies.delete(companyId); continue; }
      const report: AuditVerificationReport = {
        companyId, ok: false, entryCount: state.entryCount, brokenAtSequence: verification.brokenAtSequence,
        reason: verification.reason ?? anchorReason, headHash: state.headHash,
        anchorMismatch: Boolean(anchorReason), anchorHeadHash: anchor?.headHash ?? null,
        alert: "CRITICAL: audit chain verification failed for company " + companyId,
      };
      this.brokenCompanies.add(companyId);
      failures.push(report);
    }
    return failures;
  }

  private async writeAnchorFile(companyId: string, day: string, payload: unknown, signature: string | null): Promise<string | null> {
    if (!this.config.anchorDirectory) return null;
    if (!this.config.signingKey || !signature) throw new AuditUnavailableError("External audit anchors require a signing key");
    const file = path.join(this.config.anchorDirectory, `${companyId}-${day}.json`);
    try {
      await mkdir(this.config.anchorDirectory, { recursive: true });
      await writeFile(file, JSON.stringify({ ...(payload as Record<string, unknown>), signature, algorithm: "hmac-sha256", createdAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      // A crash between file creation and the DB insert may leave the exact signed file behind.
      // Reuse only that same payload; a different or invalid anchor is never replaced.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const existing = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          const fields = payload as Record<string, unknown>;
          const identical = Object.keys(fields).every(key => existing[key] === fields[key]);
          if (identical && existing.signature === signature && (await this.readAnchorFile(file)).ok) return file;
        } catch { /* Keep the original persistence failure authoritative. */ }
      }
      throw new AuditUnavailableError("External audit anchor could not be persisted; existing anchors are never overwritten");
    }
  }

  /** Reads an anchor file back and checks its signature (used by the verification endpoint). */
  async readAnchorFile(file: string, anchor?: AuditAnchor): Promise<{ ok: boolean; headHash?: string; reason?: string }> {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { companyId?: string; day?: string; sequence?: number; entryCount?: number; headHash?: string; signature?: string | null };
      if (anchor && (parsed.companyId !== anchor.companyId || parsed.day !== anchor.day || parsed.sequence !== anchor.sequence
        || parsed.entryCount !== anchor.entryCount || parsed.headHash !== anchor.headHash || parsed.signature !== anchor.signature))
        return { ok: false, reason: "external anchor differs from the recorded anchor" };
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
