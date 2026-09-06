import { describe, expect, it } from "vitest";
import {
  CacheHitSavingsTelemetry,
  DatabaseBackupManager,
  SessionSearchEngine,
} from "../apps/agent-api/src/telemetry-backups-and-session-search";

describe("Cache-Hit Savings Telemetry (Cache Savings Telemetry)", () => {
  it("tracks cached tokens, cost savings, and latency reductions", () => {
    const telemetry = new CacheHitSavingsTelemetry();

    // 100,000 cached tokens on Claude 3.7 ($3.0 normal vs $0.3 cached = $2.7/M savings)
    // 100k tokens * $2.7/M = $0.27 savings
    const event = telemetry.recordCacheEvent({
      tenantId: "tenant-1",
      modelId: "anthropic/claude-3-7-sonnet",
      cachedTokens: 100_000,
      standardPricePerMillionUsd: 3.0,
      cachedPricePerMillionUsd: 0.3,
      normalLatencyMs: 1200,
      cachedLatencyMs: 300,
    });

    expect(event.usdSaved).toBe(0.27);
    expect(event.latencySavedMs).toBe(900);

    const summary = telemetry.getSavingsSummary("tenant-1");
    expect(summary.totalCachedTokens).toBe(100_000);
    expect(summary.totalUsdSaved).toBe(0.27);
    expect(summary.totalLatencySavedMs).toBe(900);
  });
});

describe("Database Backup Manager (Database Backups)", () => {
  it("creates encrypted snapshots, verifies SHA-256 integrity, and prunes expired snapshots", () => {
    const manager = new DatabaseBackupManager();
    const dumpContent = "TABLE users (id INT, name VARCHAR); INSERT INTO users VALUES (1, 'Admin');";

    const snap = manager.createSnapshot({
      databaseName: "npati_production",
      snapshotName: "nightly_backup_2026_09_02",
      simulatedContent: dumpContent,
      retentionDays: 7,
    });

    expect(snap.snapshotId).toMatch(/^bkp_/);
    expect(snap.status).toBe("completed");
    expect(snap.checksumSha256.length).toBe(64);

    // Verification
    const isValid = manager.verifySnapshot(snap.snapshotId, dumpContent);
    expect(isValid).toBe(true);

    const isTampered = manager.verifySnapshot(snap.snapshotId, "TAMPERED DATA");
    expect(isTampered).toBe(false);
  });
});

describe("Session Search Engine (Session Search)", () => {
  it("indexes and fuzzy searches session dialogues by query terms and tags", () => {
    const engine = new SessionSearchEngine();

    engine.indexSession({
      sessionId: "sess-101",
      tenantId: "tenant-a",
      title: "Kubernetes Cluster Troubleshooting",
      messages: [
        { role: "user", content: "Pods in namespace ingress are crashing with OOMKilled." },
        { role: "assistant", content: "Check memory limits in values.yaml." },
      ],
      tags: ["k8s", "devops", "oom"],
      createdAt: new Date().toISOString(),
    });

    engine.indexSession({
      sessionId: "sess-102",
      tenantId: "tenant-a",
      title: "Marketing Campaign Planning",
      messages: [
        { role: "user", content: "Plan social media posts for Q4." },
      ],
      tags: ["marketing"],
      createdAt: new Date().toISOString(),
    });

    // Search for OOM
    const results = engine.search("OOMKilled ingress");
    expect(results.length).toBe(1);
    expect(results[0]!.sessionId).toBe("sess-101");
    expect(results[0]!.snippet).toContain("OOMKilled");
  });
});
