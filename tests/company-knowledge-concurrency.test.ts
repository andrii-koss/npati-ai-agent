import { describe, expect, it, vi } from "vitest";
import { CompanyKnowledgeProcessor, type KnowledgeDocument } from "../apps/agent-api/src/company-knowledge";
import { InMemoryObjectStorage, NPATI_BUCKETS } from "../apps/agent-api/src/object-storage";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";

const ctx = {
  workspaceId: "10000000-0000-0000-0000-000000000001",
  userId: "20000000-0000-0000-0000-000000000001",
  permissions: ["workspace:read"],
};

describe("Multi-worker Knowledge Concurrency and Background Processing (NPATI-004I)", () => {
  it("prevents double-processing when two workers race to claim the same document", async () => {
    const companyId = "30000000-0000-0000-0000-000000000001";
    const fileId = "40000000-0000-0000-0000-000000000001";
    const docId = "50000000-0000-0000-0000-000000000001";

    const storage = new InMemoryObjectStorage();
    const files = new InMemoryFileMetadataRepository();
    const data = Buffer.from("Important business rules for worker concurrency verification.");
    const key = `workspace/${ctx.workspaceId}/companies/${companyId}/knowledge/${fileId}`;
    await storage.put(NPATI_BUCKETS.knowledge, key, data);

    await files.reserve(ctx, {
      id: fileId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      companyId,
      bucket: NPATI_BUCKETS.knowledge,
      objectKey: key,
      originalFilename: "rules.txt",
      mimeType: "text/plain",
      sizeBytes: data.length,
      checksum: "concurrency-check-1",
      category: "document",
    });
    await files.markReady(ctx, fileId);

    let claimedWorker: string | null = null;
    const complete = vi.fn();

    // Simulated atomic database repository with row locking & single lease ownership
    const repo = {
      claim: vi.fn(async (id: string, worker: string) => {
        if (claimedWorker !== null) {
          // Already locked by another worker -> return undefined
          return undefined;
        }
        claimedWorker = worker;
        return {
          id: docId,
          workspaceId: ctx.workspaceId,
          companyId,
          userId: ctx.userId,
          fileId,
          status: "processing",
          workerId: worker,
          chunkCount: 0,
          attemptCount: 1,
          createdAt: "",
          updatedAt: "",
        } as KnowledgeDocument;
      }),
      complete,
      fail: vi.fn(),
      candidates: vi.fn(),
    };

    const ai = {
      embed: vi.fn(async ({ input }: { input: string[] }) => ({
        model: "openai/text-embedding-3-small",
        vectors: input.map(() => [0.1, 0.2, 0.3]),
      })),
    };

    const workerA = new CompanyKnowledgeProcessor(repo as any, files, storage, ai as any);
    const workerB = new CompanyKnowledgeProcessor(repo as any, files, storage, ai as any);

    // Run both workers concurrently for the same document ID
    const [resultA, resultB] = await Promise.allSettled([
      workerA.process(docId, "knowledge-worker-A"),
      workerB.process(docId, "knowledge-worker-B"),
    ]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    // Exactly one worker claimed and completed the document
    expect(repo.claim).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(ai.embed).toHaveBeenCalledTimes(1);
    expect(claimedWorker).toBe("knowledge-worker-A");
  });

  it("allows Worker B to safely reclaim and complete a document if Worker A's lease expires after crash", async () => {
    const companyId = "30000000-0000-0000-0000-000000000001";
    const fileId = "40000000-0000-0000-0000-000000000002";
    const docId = "50000000-0000-0000-0000-000000000002";

    const storage = new InMemoryObjectStorage();
    const files = new InMemoryFileMetadataRepository();
    const data = Buffer.from("Failover recovery test content.");
    const key = `workspace/${ctx.workspaceId}/companies/${companyId}/knowledge/${fileId}`;
    await storage.put(NPATI_BUCKETS.knowledge, key, data);

    await files.reserve(ctx, {
      id: fileId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      companyId,
      bucket: NPATI_BUCKETS.knowledge,
      objectKey: key,
      originalFilename: "failover.txt",
      mimeType: "text/plain",
      sizeBytes: data.length,
      checksum: "concurrency-check-2",
      category: "document",
    });
    await files.markReady(ctx, fileId);

    let docState: KnowledgeDocument = {
      id: docId,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      fileId,
      status: "processing",
      workerId: "knowledge-worker-A",
      leaseExpiresAt: new Date(Date.now() - 5000).toISOString(), // Expired lease (crashed worker A)
      chunkCount: 0,
      attemptCount: 1,
      createdAt: "",
      updatedAt: "",
    } as any;

    const complete = vi.fn(async () => {
      docState.status = "ready";
    });

    const repo = {
      claim: vi.fn(async (id: string, worker: string) => {
        // Simulates SQL: WHERE (lease_expires_at IS NULL OR lease_expires_at < now())
        const isExpired = !docState.leaseExpiresAt || new Date(docState.leaseExpiresAt) < new Date();
        if (docState.status === "ready" || (!isExpired && docState.workerId !== worker)) {
          return undefined;
        }
        docState.workerId = worker;
        docState.status = "processing";
        docState.attemptCount += 1;
        return docState;
      }),
      complete,
      fail: vi.fn(),
      candidates: vi.fn(),
    };

    const ai = {
      embed: vi.fn(async ({ input }: { input: string[] }) => ({
        model: "openai/text-embedding-3-small",
        vectors: input.map(() => [0.1, 0.2, 0.3]),
      })),
    };

    const workerB = new CompanyKnowledgeProcessor(repo as any, files, storage, ai as any);

    // Worker B claims the expired task and successfully completes it
    await workerB.process(docId, "knowledge-worker-B");

    expect(complete).toHaveBeenCalledOnce();
    expect(docState.workerId).toBe("knowledge-worker-B");
    expect(docState.attemptCount).toBe(2);
    expect(docState.status).toBe("ready");
  });
});
