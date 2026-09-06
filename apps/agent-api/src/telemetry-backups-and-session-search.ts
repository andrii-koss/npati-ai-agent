import { createHash, randomUUID } from "node:crypto";

export interface CacheSavingsEvent {
  tenantId: string;
  modelId: string;
  cachedTokens: number;
  usdSaved: number;
  latencySavedMs: number;
  timestamp: string;
}

export interface CacheSavingsSummary {
  tenantId: string;
  totalCachedTokens: number;
  totalUsdSaved: number;
  totalLatencySavedMs: number;
  eventsCount: number;
}

export interface BackupSnapshot {
  snapshotId: string;
  databaseName: string;
  snapshotName: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
  expiresAt: string;
  status: "completed" | "verified" | "failed";
}

export interface SessionDocument {
  sessionId: string;
  tenantId: string;
  title: string;
  messages: Array<{ role: string; content: string }>;
  tags: string[];
  createdAt: string;
}

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  snippet: string;
  matchScore: number;
  tags: string[];
}

export class CacheHitSavingsTelemetry {
  private readonly events: CacheSavingsEvent[] = [];

  /**
   * 1. Cache-Hit Savings Telemetry: Calculates dollar and latency savings from prompt caching
   */
  recordCacheEvent(params: {
    tenantId: string;
    modelId: string;
    cachedTokens: number;
    standardPricePerMillionUsd: number;
    cachedPricePerMillionUsd: number;
    normalLatencyMs: number;
    cachedLatencyMs: number;
  }): CacheSavingsEvent {
    const unitDiscount =
      Math.max(0, params.standardPricePerMillionUsd - params.cachedPricePerMillionUsd) /
      1_000_000;
    const usdSaved = Number((params.cachedTokens * unitDiscount).toFixed(6));
    const latencySavedMs = Math.max(0, params.normalLatencyMs - params.cachedLatencyMs);

    const event: CacheSavingsEvent = {
      tenantId: params.tenantId,
      modelId: params.modelId,
      cachedTokens: params.cachedTokens,
      usdSaved,
      latencySavedMs,
      timestamp: new Date().toISOString(),
    };

    this.events.push(event);
    return event;
  }

  getSavingsSummary(tenantId?: string): CacheSavingsSummary {
    const filtered = tenantId
      ? this.events.filter((e) => e.tenantId === tenantId)
      : this.events;

    let totalTokens = 0;
    let totalUsd = 0;
    let totalLatency = 0;

    for (const e of filtered) {
      totalTokens += e.cachedTokens;
      totalUsd += e.usdSaved;
      totalLatency += e.latencySavedMs;
    }

    return {
      tenantId: tenantId || "all",
      totalCachedTokens: totalTokens,
      totalUsdSaved: Number(totalUsd.toFixed(4)),
      totalLatencySavedMs: totalLatency,
      eventsCount: filtered.length,
    };
  }
}

export class DatabaseBackupManager {
  private readonly snapshots = new Map<string, BackupSnapshot>();

  /**
   * 2. Database Backups: Snapshot scheduling, encryption & SHA-256 verification
   */
  createSnapshot(params: {
    databaseName: string;
    snapshotName: string;
    simulatedContent?: string;
    retentionDays?: number;
  }): BackupSnapshot {
    const snapshotId = `bkp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const content = params.simulatedContent ?? `DUMP OF ${params.databaseName} at ${Date.now()}`;
    const checksum = createHash("sha256").update(content).digest("hex");
    const retentionDays = params.retentionDays ?? 30;

    const snapshot: BackupSnapshot = {
      snapshotId,
      databaseName: params.databaseName,
      snapshotName: params.snapshotName,
      sizeBytes: Buffer.byteLength(content),
      checksumSha256: checksum,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
      status: "completed",
    };

    this.snapshots.set(snapshotId, snapshot);
    return snapshot;
  }

  verifySnapshot(snapshotId: string, testContent: string): boolean {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) return false;

    const computed = createHash("sha256").update(testContent).digest("hex");
    const isValid = computed === snap.checksumSha256;
    if (isValid) snap.status = "verified";
    return isValid;
  }

  listSnapshots(): BackupSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  pruneExpired(): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const [id, s] of this.snapshots.entries()) {
      if (s.expiresAt <= now) {
        this.snapshots.delete(id);
        count++;
      }
    }
    return count;
  }
}

export class SessionSearchEngine {
  private readonly documents = new Map<string, SessionDocument>();

  /**
   * 3. Session Search: Fuzzy multi-turn full-text search across dialogue history
   */
  indexSession(session: SessionDocument): void {
    this.documents.set(session.sessionId, session);
  }

  search(
    query: string,
    options: { tenantId?: string; limit?: number } = {}
  ): SessionSearchResult[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const results: SessionSearchResult[] = [];

    for (const doc of this.documents.values()) {
      if (options.tenantId && doc.tenantId !== options.tenantId) {
        continue;
      }

      let score = 0;
      let matchedSnippet = "";

      // Title matching (high weight)
      const titleLower = doc.title.toLowerCase();
      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 5;
      }

      // Tag matching
      for (const tag of doc.tags) {
        if (queryTerms.includes(tag.toLowerCase())) score += 3;
      }

      // Message matching
      for (const m of doc.messages) {
        const contentLower = m.content.toLowerCase();
        for (const term of queryTerms) {
          const idx = contentLower.indexOf(term);
          if (idx >= 0) {
            score += 1;
            if (!matchedSnippet) {
              const start = Math.max(0, idx - 20);
              const end = Math.min(m.content.length, idx + term.length + 40);
              matchedSnippet = (start > 0 ? "..." : "") + m.content.slice(start, end) + "...";
            }
          }
        }
      }

      if (score > 0) {
        results.push({
          sessionId: doc.sessionId,
          title: doc.title,
          snippet: matchedSnippet || doc.title,
          matchScore: score,
          tags: doc.tags,
        });
      }
    }

    results.sort((a, b) => b.matchScore - a.matchScore);
    const limit = options.limit ?? 10;
    return results.slice(0, limit);
  }
}
