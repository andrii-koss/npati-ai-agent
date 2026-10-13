import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import {
  globalCacheService,
  globalSemanticCache,
  globalBackupManager,
  authorize,
  sendError,
} from "./reliability-operations-singletons";

export function registerReliabilityCacheAndBackupRoutes(app: FastifyInstance, auth: AuthProvider): void {
  // 1. #176 & #202: Semantic & KV Cache Stats, Query, Store, Invalidate & Flush
  app.get("/cache/stats", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const kv = globalCacheService.getStats(scope.workspaceId);
      const semantic = globalSemanticCache.stats();
      const totalHits = kv.hits + semantic.hits;
      const totalMisses = kv.misses + semantic.misses;
      const totalRequests = totalHits + totalMisses;
      const combinedHitRatio = totalRequests > 0 ? Number((totalHits / totalRequests).toFixed(2)) : 0;

      return {
        stats: kv,
        semantic,
        combined: {
          totalHits,
          totalMisses,
          combinedHitRatio,
          totalKeys: kv.totalKeys + semantic.entriesCount,
          memoryBytesEstimate: kv.memoryBytesEstimate,
        },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { prefix?: string; flushAll?: boolean; target?: "all" | "kv" | "semantic" } }>("/cache/flush", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const { prefix, flushAll, target = "all" } = request.body || {};
      const isGlobal = Boolean(flushAll && scope.permissions.includes("admin:all"));

      let kvResult = { flushedCount: 0, remainingKeys: 0 };
      let semanticFlushed = 0;

      if (target === "all" || target === "kv") {
        kvResult = globalCacheService.flush(
          isGlobal ? undefined : { tenantId: scope.workspaceId, prefix }
        );
      }

      if (target === "all" || target === "semantic") {
        semanticFlushed = globalSemanticCache.invalidate(isGlobal ? "" : scope.workspaceId);
      }

      return {
        ...kvResult,
        semanticFlushed,
        totalFlushed: kvResult.flushedCount + semanticFlushed,
        target,
        scope: isGlobal ? "global" : scope.workspaceId,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { key: string; value: unknown } }>("/cache/kv/set", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:write");
      const { key, value } = request.body || {};
      if (!key) return reply.code(400).send({ error: { code: "KEY_REQUIRED", message: "key is required" } });
      const tenantKey = `${scope.workspaceId}:${key}`;
      globalCacheService.set(tenantKey, value);
      return { ok: true, key: tenantKey };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { key: string } }>("/cache/kv/get/:key", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      const { key } = request.params;
      const tenantKey = `${scope.workspaceId}:${key}`;
      const value = globalCacheService.get(tenantKey);
      return { hit: value !== undefined, value };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      query: string;
      scopeKey?: string;
    };
  }>("/cache/semantic/query", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { query, scopeKey } = request.body || {};
      if (!query) {
        return reply.code(400).send({ error: { code: "QUERY_REQUIRED", message: "query is required" } });
      }
      const targetScope = scope.permissions.includes("admin:all") && scopeKey ? scopeKey : scope.workspaceId;
      const data = globalSemanticCache.get(query, targetScope);
      return {
        hit: data !== null,
        data,
        scope: targetScope,
        stats: globalSemanticCache.stats(),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      query: string;
      data: string;
      ttlMs?: number;
      scopeKey?: string;
    };
  }>("/cache/semantic/store", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "chat:use");
      const { query, data, ttlMs, scopeKey } = request.body || {};
      if (!query || data === undefined) {
        return reply.code(400).send({ error: { code: "INPUT_REQUIRED", message: "query and data are required" } });
      }
      const targetScope = scope.permissions.includes("admin:all") && scopeKey ? scopeKey : scope.workspaceId;
      globalSemanticCache.set(query, data, targetScope, ttlMs);
      return {
        stored: true,
        query,
        scope: targetScope,
        ttlMs: ttlMs || 3600_000,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      scopeKey?: string;
      flushAll?: boolean;
    };
  }>("/cache/semantic/invalidate", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "business:manage");
      const flushAll = Boolean(request.body?.flushAll && scope.permissions.includes("admin:all"));
      const targetScope = flushAll ? "" : (scope.permissions.includes("admin:all") && request.body?.scopeKey ? request.body.scopeKey : scope.workspaceId);
      const flushedCount = globalSemanticCache.invalidate(targetScope);
      return {
        flushedCount,
        scope: flushAll ? "global" : targetScope,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 2. #205: Database Backups
  app.post<{ Body: { databaseName?: string; snapshotName?: string; retentionDays?: number; content?: string } }>(
    "/admin/backups",
    async (request, reply) => {
      try {
        await authorize(auth, request, "business:manage");
        const { databaseName, snapshotName, retentionDays, content } = request.body || {};
        const snapshot = globalBackupManager.createSnapshot({
          databaseName: databaseName || "npati_production",
          snapshotName: snapshotName || `manual-backup-${Date.now()}`,
          simulatedContent: content,
          retentionDays,
        });
        return reply.code(201).send({ snapshot });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get<{ Querystring: { database?: string } }>("/admin/backups", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const { database } = request.query || {};
      const snapshots = globalBackupManager.listSnapshots(database);
      return { snapshots, count: snapshots.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { snapshotId: string } }>("/admin/backups/:snapshotId", async (request, reply) => {
    try {
      await authorize(auth, request, "workspace:read");
      const snapshot = globalBackupManager.getSnapshot(request.params.snapshotId);
      if (!snapshot) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
      }
      return { snapshot };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { snapshotId: string } }>("/admin/backups/:snapshotId", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const deleted = globalBackupManager.deleteSnapshot(request.params.snapshotId);
      if (!deleted) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
      }
      return { snapshotId: request.params.snapshotId, deleted: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/admin/backups/prune", async (request, reply) => {
    try {
      await authorize(auth, request, "business:manage");
      const prunedCount = globalBackupManager.pruneExpired();
      return { prunedCount, remainingCount: globalBackupManager.listSnapshots().length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { snapshotId: string }; Body: { content: string } }>(
    "/admin/backups/:snapshotId/verify",
    async (request, reply) => {
      try {
        await authorize(auth, request, "business:manage");
        const verification = globalBackupManager.verifySnapshotDetails(
          request.params.snapshotId,
          request.body?.content || ""
        );
        if (!verification.snapshot) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Snapshot '${request.params.snapshotId}' not found` } });
        }
        return {
          snapshotId: request.params.snapshotId,
          verified: verification.verified,
          expectedChecksum: verification.expectedChecksum,
          actualChecksum: verification.actualChecksum,
          status: verification.snapshot.status,
        };
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

}
