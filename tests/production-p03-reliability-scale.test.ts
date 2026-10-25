import { describe, expect, it } from "vitest";
import { AdaptiveAdmissionQueue, SelfHealingAutoCombo } from "../apps/agent-api/src/resilience-admission-queue";
import { GroupSessionManager } from "../apps/agent-api/src/group-sessions";
import { SessionToolRegistry } from "../apps/agent-api/src/session-tools";
import { ToolPolicyEngine } from "../apps/agent-api/src/tool-policy-engine";
import { AgentEvaluationFramework } from "../apps/agent-api/src/evaluation-and-webhook-retries";
import { SemanticCache } from "../apps/agent-api/src/semantic-cache";
import { AtomicRpmLeaseManager } from "../apps/agent-api/src/atomic-rpm-rolling-leases";
import { QuotaShareRouter } from "../apps/agent-api/src/routing-transparency-and-dedup";
import {
  CompressionPresetManager,
  AdaptiveContextBudgetManager,
  PerRequestCompressionOverrideManager,
} from "../apps/agent-api/src/context-compression-presets-and-budget";
import {
  OutputStyleModifier,
  CompressionEvalHarness,
  CacheManagementService,
} from "../apps/agent-api/src/output-styles-eval-and-cache";
import { DatabaseBackupManager, SessionSearchEngine } from "../apps/agent-api/src/telemetry-backups-and-session-search";
import { SessionPruningManager, type PrunableSession } from "../apps/agent-api/src/sessions-custom-models-and-chunking";

describe("P0.3 Production Suite: Runtime Reliability, Streaming, Observability & Scale", () => {
  // 1. #22 Adaptive Admission Queue
  describe("#22 Adaptive Admission Queue (system.adaptive_admission_queue)", () => {
    it("processes tasks with priority tier ordering and sheds free load under capacity", async () => {
      const queue = new AdaptiveAdmissionQueue({ maxConcurrent: 2, maxQueueLength: 4 });
      const order: string[] = [];

      const makeTask = (id: string, ms: number) => async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(id);
        return id;
      };

      const pFree = queue.enqueue(makeTask("free-task", 30), "free");
      const pPro = queue.enqueue(makeTask("pro-task", 20), "pro");
      const pEnt = queue.enqueue(makeTask("ent-task", 10), "enterprise");

      const results = await Promise.all([pFree, pPro, pEnt]);
      expect(results).toEqual(["free-task", "pro-task", "ent-task"]);
      expect(order.length).toBe(3);

      // Verify queue shedding: fill active capacity (1) and queue capacity (1), then 3rd free task sheds
      const smallQueue = new AdaptiveAdmissionQueue({ maxConcurrent: 1, maxQueueLength: 1 });
      void smallQueue.enqueue(() => new Promise((r) => setTimeout(r, 200)), "pro"); // activeCount = 1
      void smallQueue.enqueue(() => new Promise((r) => setTimeout(r, 200)), "pro"); // queue.length = 1
      // 3rd task with free tier must be rejected
      await expect(smallQueue.enqueue(() => Promise.resolve("done"), "free")).rejects.toThrow(
        "ADMISSION_QUEUE_SHED"
      );
    });
  });

  // 2. #23 Self-Healing Auto-Combo
  describe("#23 Self-Healing Auto-Combo (system.self-healing_auto-combo)", () => {
    it("transparently falls back to secondary model when primary fails with 503", async () => {
      const candidates = [
        {
          modelId: "openai/gpt-4o",
          provider: "openai",
          execute: async () => {
            throw new Error("503 Service Unavailable");
          },
        },
        {
          modelId: "anthropic/claude-3-7-sonnet",
          provider: "anthropic",
          execute: async () => "Self-healed answer from Claude 3.7",
        },
      ];

      const result = await SelfHealingAutoCombo.executeWithHealing(candidates);
      expect(result.wasHealed).toBe(true);
      expect(result.finalModelId).toBe("anthropic/claude-3-7-sonnet");
      expect(result.result).toBe("Self-healed answer from Claude 3.7");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].success).toBe(false);
      expect(result.attempts[1].success).toBe(true);
    });
  });

  // 3. #44 Isolated Group Sessions
  describe("#44 Isolated Group Sessions (system.isolated_group_sessions)", () => {
    it("manages isolated group sessions scoped by tenant and company", async () => {
      const manager = new GroupSessionManager();
      const companyId = "company-group-1";
      const tenantId = "tenant-group-1";

      const session = await manager.createSession({
        companyId,
        tenantId,
        title: "Executive Strategy Boardroom",
        participants: [
          { id: "agent-ceo", name: "CEO Agent", type: "agent", role: "executive" },
          { id: "agent-cto", name: "CTO Agent", type: "agent", role: "tech" },
        ],
        initialTools: ["web.search"],
      });

      expect(session.id).toBeDefined();
      expect(session.isIsolated).toBe(true);
      expect(session.participants).toHaveLength(2);

      // Retrieval within same tenant succeeds
      const found = await manager.getSession(session.id, companyId, tenantId);
      expect(found).not.toBeNull();
      expect(found?.title).toBe("Executive Strategy Boardroom");

      // Cross-tenant access denied
      const crossTenant = await manager.getSession(session.id, companyId, "tenant-other");
      expect(crossTenant).toBeNull();
    });
  });

  // 4. #46 Session Tools
  describe("#46 Session Tools (system.session_tools)", () => {
    it("attaches, resolves, and detaches session tools with policy enforcement", () => {
      const policyEngine = new ToolPolicyEngine([
        { id: "deny-dangerous", effect: "deny", toolPattern: "dangerous.*" },
      ]);
      const registry = new SessionToolRegistry(policyEngine);
      const sessionId = "sess-tool-101";

      registry.attachTool(sessionId, "calculator.eval", { description: "Math tool" });
      registry.attachTool(sessionId, "dangerous.wipe", { description: "Blocked tool" });

      const active = registry.getActiveTools(sessionId);
      expect(active).toHaveLength(2);

      const resolved = registry.resolveEffectiveTools(sessionId, ["web.search"]);
      expect(resolved.effectiveTools).toContain("web.search");
      expect(resolved.effectiveTools).toContain("calculator.eval");
      expect(resolved.effectiveTools).not.toContain("dangerous.wipe");
      expect(resolved.blockedTools).toHaveLength(1);

      registry.detachTool(sessionId, "calculator.eval");
      expect(registry.getActiveTools(sessionId)).toHaveLength(1);
    });
  });

  // 5. #124 Evaluation Framework
  describe("#124 Evaluation Framework (system.evaluation_framework)", () => {
    it("evaluates JSON schema compliance, required terms, and negative boundaries", () => {
      const validJsonResponse = JSON.stringify({ status: "success", plan: "multi-cloud migration" });
      const criteria = {
        checkJsonFormat: true,
        requiredSubstrings: ["multi-cloud", "migration"],
        disallowedSubstrings: ["confidential", "secret_key"],
      };

      const evalPassed = AgentEvaluationFramework.evaluate("Plan cloud setup", validJsonResponse, criteria);
      expect(evalPassed.passed).toBe(true);
      expect(evalPassed.overallScore).toBeGreaterThanOrEqual(0.9);

      const invalidResponse = "This is not JSON but has secret_key and confidential";
      const evalFailed = AgentEvaluationFramework.evaluate("Plan cloud setup", invalidResponse, criteria);
      expect(evalFailed.passed).toBe(false);
      expect(evalFailed.notes.length).toBeGreaterThanOrEqual(2);
    });
  });

  // 6. #176 Semantic Cache
  describe("#176 Semantic Cache (system.semantic_cache)", () => {
    it("normalizes queries, caches responses, and expires after TTL", async () => {
      const cache = new SemanticCache<string>(50, 100);

      cache.set("What is the refund policy?", "30 days full refund", "tenant-c1");

      // Casing and punctuation normalization
      const hit = cache.get("what is the refund policy", "tenant-c1");
      expect(hit).toBe("30 days full refund");

      // Different scope should miss
      const crossMiss = cache.get("what is the refund policy", "tenant-c2");
      expect(crossMiss).toBeNull();

      // TTL expiration
      await new Promise((r) => setTimeout(r, 60));
      const expired = cache.get("what is the refund policy", "tenant-c1");
      expect(expired).toBeNull();
    });
  });

  // 7. #189 Atomic RPM Rolling Leases
  describe("#189 Atomic RPM Rolling Leases (system.atomic_rpm_rolling_leases)", () => {
    it("retains lease lifecycle without imposing an RPM allowance", () => {
      const manager = new AtomicRpmLeaseManager(1000);

      const l1 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 3 });
      expect(l1.granted).toBe(true);
      expect(l1.remainingTokens).toBe(2);

      const l2 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 2 });
      expect(l2.granted).toBe(true);
      expect(l2.remainingTokens).toBe(0);

      // Over capacity
      const l3 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 1 });
      expect(l3.granted).toBe(true);
      expect(l3.reason).toContain("Granted rolling lease");

      // Release l1
      manager.releaseLease(l1.leaseId!);
      const l4 = manager.acquireLease({ provider: "anthropic", maxRpm: 5, tokens: 2 });
      expect(l4.granted).toBe(true);
    });
  });

  // 8. #190 Quota-Share Routing
  describe("#190 Quota-Share Routing (security.quota-share_routing)", () => {
    it("admits all tenant tiers without local usage quota shares", () => {
      const router = new QuotaShareRouter();
      router.setTenantShare("tenant-enterprise", "enterprise", 60);
      router.setTenantShare("tenant-free", "starter", 10);

      // Normal load (50% of system max)
      const normalFree = router.isAdmitted("tenant-free", 50, 100);
      expect(normalFree.admitted).toBe(true);

      // Saturated load (85% of system max)
      const satFree = router.isAdmitted("tenant-free", 85, 100);
      expect(satFree.admitted).toBe(true);
      expect(satFree.reason).toContain("quotas are disabled");

      const satEnterprise = router.isAdmitted("tenant-enterprise", 85, 100);
      expect(satEnterprise.admitted).toBe(true);
      expect(satEnterprise.reason).toContain("quotas are disabled");
    });
  });

  // 9. #197, #198, #199 Compression Presets, Budget & Override
  describe("#197, #198, #199 Context Compression & Adaptive Budget (system.compression_presets, system.adaptive_context_budget, system.per-request_compression_override)", () => {
    it("applies compression presets while preserving code blocks and critical facts (#197)", () => {
      const prompt = `
      Please note that in order to deploy, follow instructions:

      \`\`\`bash
      npm run build && npm start
      \`\`\`

      It is important to remember that this process is very critical and basically necessary.
      `;

      const balanced = CompressionPresetManager.applyPreset(prompt, "balanced");
      expect(balanced.preset).toBe("balanced");
      expect(balanced.compressedText).toContain("npm run build && npm start");
      expect(balanced.compressedText).not.toContain("Please note that");

      const extreme = CompressionPresetManager.applyPreset(prompt, "extreme");
      expect(extreme.preset).toBe("extreme");
      expect(extreme.tokensSaved).toBeGreaterThanOrEqual(balanced.tokensSaved);

      const codeSafe = CompressionPresetManager.applyPreset(prompt, "code-safe");
      expect(codeSafe.preset).toBe("code-safe");
      expect(codeSafe.compressedText).toContain("```bash");
      expect(codeSafe.compressedText).toContain("npm run build && npm start");
    });

    it("evaluates adaptive context budget based on usage ratios (#198)", () => {
      const low = AdaptiveContextBudgetManager.evaluateBudget(40_000, 100_000);
      expect(low.actionRequired).toBe(false);
      expect(low.suggestedPreset).toBe("none");

      const medium = AdaptiveContextBudgetManager.evaluateBudget(70_000, 100_000);
      expect(medium.actionRequired).toBe(true);
      expect(medium.suggestedPreset).toBe("balanced");

      const critical = AdaptiveContextBudgetManager.evaluateBudget(90_000, 100_000);
      expect(critical.actionRequired).toBe(true);
      expect(critical.suggestedPreset).toBe("extreme");
    });

    it("resolves per-request compression header overrides (#199)", () => {
      const bypassRes = PerRequestCompressionOverrideManager.resolveOverride({
        "x-npati-compression": "bypass",
      });
      expect(bypassRes.bypass).toBe(true);
      expect(bypassRes.enabled).toBe(false);

      const presetRes = PerRequestCompressionOverrideManager.resolveOverride({
        "x-npati-compression": "extreme",
      });
      expect(presetRes.bypass).toBe(false);
      expect(presetRes.preset).toBe("extreme");

      const bodyRes = PerRequestCompressionOverrideManager.resolveOverride(
        {},
        { preset: "rag-optimized", maxBudgetTokens: 4000 }
      );
      expect(bodyRes.preset).toBe("rag-optimized");
      expect(bodyRes.maxBudgetTokens).toBe(4000);
    });
  });

  // 10. #200 Output Styles & #201 Compression Eval Harness
  describe("#200 Output Styles & #201 Compression Eval Harness (system.output_styles, system.compression_eval_harness)", () => {
    it("injects concise, bulleted, and minimal-json style prompts (#200)", () => {
      const messages = [{ role: "user", content: "Summarize Q3 earnings" }];
      const concise = OutputStyleModifier.applyOutputStyle(messages, "concise");
      expect(concise[0].content).toContain("Extremely concise");

      const jsonStyle = OutputStyleModifier.applyOutputStyle(messages, "minimal-json");
      expect(jsonStyle[0].content).toContain("Valid compact JSON only");
    });

    it("evaluates compression reduction percent and entity retention (#201)", () => {
      const original = "PostgreSQL and Redis cluster deployment in production with 3 replicas and automated failover.";
      const compressed = "PostgreSQL Redis cluster deployment production 3 replicas automated failover.";

      const report = CompressionEvalHarness.evaluate(original, compressed);
      expect(report.reductionPercent).toBeGreaterThan(10);
      expect(report.entityRetentionRate).toBeGreaterThanOrEqual(0.7);
      expect(report.passedValidation).toBe(true);
    });
  });

  // 11. #202 Cache Stats / Flush
  describe("#202 Cache Stats / Flush (system.cache_stats_flush)", () => {
    it("monitors hits, misses, memory bytes, and supports tenant-scoped flushing", () => {
      const cacheService = new CacheManagementService();

      cacheService.set("tenantA:session:1", { user: "alice" });
      cacheService.set("tenantA:session:2", { user: "bob" });
      cacheService.set("tenantB:session:1", { user: "carol" });

      expect(cacheService.get("tenantA:session:1")).toEqual({ user: "alice" });
      expect(cacheService.get("tenantA:nonexistent")).toBeUndefined();

      const stats = cacheService.getStats("tenantA");
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.totalKeys).toBe(2);
      expect(stats.hitRatio).toBe(0.5);

      // Scoped flush for tenantA
      const flushRes = cacheService.flush({ tenantId: "tenantA" });
      expect(flushRes.flushedCount).toBe(2);
      expect(cacheService.getStats("tenantA").totalKeys).toBe(0);

      // tenantB still exists
      expect(cacheService.get("tenantB:session:1")).toEqual({ user: "carol" });
    });
  });

  // 12. #205 Database Backups
  describe("#205 Database Backups (browser.database_backups)", () => {
    it("creates snapshots with SHA-256 checksums and validates restore drills", () => {
      const backupManager = new DatabaseBackupManager();
      const content = "PG_DUMP_VERIFIED_DATA_BLOCK";

      const snapshot = backupManager.createSnapshot({
        databaseName: "npati_agent_db",
        snapshotName: "nightly_backup_01",
        simulatedContent: content,
        retentionDays: 14,
      });

      expect(snapshot.snapshotId).toBeDefined();
      expect(snapshot.status).toBe("completed");
      expect(snapshot.checksumSha256).toBeDefined();

      // Verification drill
      const isValid = backupManager.verifySnapshot(snapshot.snapshotId, content);
      expect(isValid).toBe(true);

      const isInvalid = backupManager.verifySnapshot(snapshot.snapshotId, "TAMPERED_DATA");
      expect(isInvalid).toBe(false);
    });
  });

  // 13. #207 Session Search & #208 Session Pruning
  describe("#207 Session Search & #208 Session Pruning (research.session_search, system.session_pruning)", () => {
    it("indexes and searches multi-turn sessions with relevance ranking (#207)", () => {
      const searchEngine = new SessionSearchEngine();

      searchEngine.indexSession({
        sessionId: "sess-tech-1",
        tenantId: "tenant-search",
        title: "Kubernetes Cluster Architecture Setup",
        tags: ["devops", "cloud", "infra"],
        messages: [
          { role: "user", content: "Pods in namespace ingress are crashing with OOMKilled." },
          { role: "assistant", content: "Check memory limits in values.yaml." },
        ],
        createdAt: new Date().toISOString(),
      });

      searchEngine.indexSession({
        sessionId: "sess-sales-2",
        tenantId: "tenant-search",
        title: "Enterprise Sales Pitch Q4",
        tags: ["sales", "leads"],
        messages: [{ role: "user", content: "Prepare slides for the enterprise client." }],
        createdAt: new Date().toISOString(),
      });

      const techResults = searchEngine.search("OOMKilled ingress");
      expect(techResults.length).toBeGreaterThanOrEqual(1);
      expect(techResults[0].sessionId).toBe("sess-tech-1");
      expect(techResults[0].snippet).toContain("OOMKilled");
    });

    it("prunes inactive sessions and archives them by retention TTL (#208)", () => {
      const now = Date.now();
      const oldTime = now - 45 * 86_400_000; // 45 days ago

      const sessions: PrunableSession[] = [
        {
          sessionId: "stale-1",
          tenantId: "tenant-prune",
          lastActiveAt: oldTime,
          messages: [{ role: "user", content: "old query" }],
        },
        {
          sessionId: "active-2",
          tenantId: "tenant-prune",
          lastActiveAt: now,
          messages: [{ role: "user", content: "current query" }],
        },
      ];

      // Prune with archive
      const prunedWithArchive = SessionPruningManager.prune(sessions, {
        maxInactiveDays: 30,
        archiveBeforeDelete: true,
      });

      expect(prunedWithArchive.result.archivedSessionsCount).toBe(1);
      expect(prunedWithArchive.activeSessions.find((s) => s.sessionId === "stale-1")?.isArchived).toBe(true);

      // Prune with delete
      const prunedWithDelete = SessionPruningManager.prune(sessions, {
        maxInactiveDays: 30,
        archiveBeforeDelete: false,
      });

      expect(prunedWithDelete.result.prunedSessionsCount).toBe(1);
      expect(prunedWithDelete.activeSessions).toHaveLength(1);
      expect(prunedWithDelete.activeSessions[0].sessionId).toBe("active-2");
    });
  });
});
