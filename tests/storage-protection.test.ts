import type { AuthContext } from "@npati/workspace";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe,expect,it } from "vitest";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";
import { InMemoryObjectStorage,NPATI_BUCKETS,withOperationTimeout,withStreamTimeout } from "../apps/agent-api/src/object-storage";
import { StorageReconciler } from "../apps/agent-api/src/storage-reconciler";
import { InMemoryStorageProtection,StorageRateLimitError } from "../apps/agent-api/src/storage-protection";

const context:AuthContext={workspaceId:"storage-ws",userId:"storage-user",permissions:["workspace:read"]};
const limits={upload:{limit:2,windowMs:60_000},download:{limit:2,windowMs:60_000},delete:{limit:2,windowMs:60_000}} as const;

describe("storage production protections",()=>{
  it("enforces tenant-scoped distributed-style counters and a single reconciliation lease",async()=>{
    const protection=new InMemoryStorageProtection(limits);
    await protection.consume(context,"upload");await protection.consume(context,"upload");
    await expect(protection.consume(context,"upload")).rejects.toBeInstanceOf(StorageRateLimitError);
    await expect(protection.consume({...context,userId:"another-user"},"upload")).resolves.toBeUndefined();
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
    const first=protection.withLease("scan",60_000,()=>held);
    await new Promise(resolve=>setImmediate(resolve));
    expect((await protection.withLease("scan",60_000,async()=>undefined)).acquired).toBe(false);
    release();expect((await first).acquired).toBe(true);
  });

  it("terminates stalled MinIO operations and idle download streams",async()=>{
    await expect(withOperationTimeout(new Promise<never>(()=>undefined),20,"upload")).rejects.toThrow("timed out");
    const stalled=new PassThrough(),timed=withStreamTimeout(stalled,20,100);
    await expect((async()=>{for await(const _ of timed){void _;}})()).rejects.toThrow("idle timeout");
  });

  it("removes aged MinIO-only objects and marks PostgreSQL-only ready records missing",async()=>{
    const storage=new InMemoryObjectStorage(),repository=new InMemoryFileMetadataRepository(),protection=new InMemoryStorageProtection();
    await storage.initialize();
    const orphanKey="workspace/storage-ws/user/storage-user/chats/orphan/file/"+randomUUID();
    await storage.put(NPATI_BUCKETS.chat,orphanKey,Buffer.from("orphan"));
    const missingId=randomUUID(),missingKey="workspace/storage-ws/user/storage-user/chats/missing/file/"+missingId;
    await repository.reserve(context,{id:missingId,workspaceId:context.workspaceId,userId:context.userId,bucket:NPATI_BUCKETS.chat,objectKey:missingKey,originalFilename:"missing.txt",mimeType:"text/plain",sizeBytes:7,checksum:"missing",category:"file"});
    await repository.markReady(context,missingId);
    const healthyId=randomUUID(),healthyKey="workspace/storage-ws/user/storage-user/chats/healthy/file/"+healthyId;
    await repository.reserve(context,{id:healthyId,workspaceId:context.workspaceId,userId:context.userId,bucket:NPATI_BUCKETS.chat,objectKey:healthyKey,originalFilename:"healthy.txt",mimeType:"text/plain",sizeBytes:7,checksum:"healthy",category:"file"});
    await storage.put(NPATI_BUCKETS.chat,healthyKey,Buffer.from("healthy"));await repository.markReady(context,healthyId);
    const reconciler=new StorageReconciler(storage,repository,protection,{orphanGraceMs:0,pageSize:10});
    const result=await reconciler.run();
    expect(result.acquired).toBe(true);
    expect(result.result).toMatchObject({removedOrphans:1,missingObjects:1});
    expect(await storage.exists(NPATI_BUCKETS.chat,orphanKey)).toBe(false);
    expect((await repository.get(missingId))?.status).toBe("failed");
    expect((await repository.get(missingId))?.storageMissingAt).toBeTruthy();
    expect((await repository.get(healthyId))?.status).toBe("ready");
  });
});
