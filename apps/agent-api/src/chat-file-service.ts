import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError } from "@npati/workspace";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { FileCategory, FileMetadataRepository, StoredFile } from "./file-metadata";
import { NPATI_BUCKETS, objectKey, objectKeySegment as segment, type ObjectStorage } from "./object-storage";
import type { StorageProtection } from "./storage-protection";
import { cleanupStoredFileObject } from "./file-cleanup";
import { SecurityPolicyEngine } from "./security-guardrails";

export interface PersistableAttachment {
  clientId?: string;
  kind: FileCategory;
  name: string;
  mimeType: string;
  data: Buffer;
  transcript?: string;
}


function uuid(value?: string) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : randomUUID();
}

export class ChatFileService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly repository: FileMetadataRepository,
    private readonly workspace: WorkspaceStore,
    private readonly legacyDirectory?: string,
    private readonly protection?: StorageProtection,
  ) {}

  async persist(context: AuthContext, businessId: string | undefined, chatId: string, attachments: PersistableAttachment[]) {
    await this.protection?.consume(context,"upload",attachments.length);
    const saved: Array<{ id: string; kind: FileCategory; name: string; transcript?: string }> = [];
    for (const item of attachments) {
      if (item.kind === "image") {
        SecurityPolicyEngine.protectVisualInput(item.data, item.transcript);
      }
      const id = uuid(item.clientId);
      const checksum = createHash("sha256").update(item.data).digest("hex");
      const key = objectKey(["workspace",segment(context.workspaceId),"user",segment(context.userId),"chats",segment(chatId),item.kind,id]);
      const idempotencyKey = "chat:" + chatId + ":" + (item.clientId ?? checksum + ":" + item.name);
      const reservation = await this.repository.reserve(context, {
        id, workspaceId: context.workspaceId, userId: context.userId, businessId: businessId || undefined, chatId,
        bucket: NPATI_BUCKETS.chat, objectKey: key, originalFilename: item.name, mimeType: item.mimeType,
        sizeBytes: item.data.length, checksum, category: item.kind, idempotencyKey,
      });
      const file = reservation.file;
      if (file.status !== "ready") {
        try {
          await this.storage.put(file.bucket,file.objectKey,item.data,{
            "Content-Type": item.mimeType,
            "x-amz-meta-checksum-sha256": checksum,
            "x-amz-meta-file-id": file.id,
          });
          await this.repository.markReady(context,file.id);
          await this.repository.audit(context,file.id,"upload","succeeded",{ chatId, sizeBytes: item.data.length });
        } catch (error) {
          await this.repository.markFailed(context,file.id).catch(()=>undefined);
          await this.repository.audit(context,file.id,"upload","failed",{ message: error instanceof Error ? error.message : "upload failed" }).catch(()=>undefined);
          throw error;
        }
      }
      saved.push({ id: file.id, kind: item.kind, name: item.name, transcript: item.transcript });
    }
    return saved;
  }

  async linkMessage(context: AuthContext, ids: string[], messageId: string) {
    await this.repository.attachMessage(context,ids,messageId);
  }

  async latestChatSpreadsheet(context: AuthContext, chatId: string) {
    const files = await this.repository.listChat(context, chatId);
    return files
      .filter((file) => file.status === "ready" && /\.(xlsx|xlsm|xlsb|xls|csv)$/i.test(file.originalFilename))
      .at(-1) ?? null;
  }

  async authorize(context: AuthContext, fileId: string) {
    const file = await this.repository.get(fileId);
    if (!file || file.deletedAt || file.status !== "ready") return null;
    if (file.workspaceId !== context.workspaceId || file.userId !== context.userId) {
      await this.repository.audit({ ...context, workspaceId: file.workspaceId, userId: file.userId },file.id,"download","denied").catch(()=>undefined);
      throw new WorkspaceAccessError("Attachment access denied");
    }
    if (file.businessId) await this.workspace.getBusiness(context,file.businessId);
    if (file.chatId && file.businessId) await this.workspace.getConversation(context,file.businessId,file.chatId);
    if (file.chatId && !file.businessId) await this.workspace.getNeutralConversation(context,file.chatId);
    return file;
  }

  async open(context: AuthContext, fileId: string) {
    await this.protection?.consume(context,"download");
    const file = await this.authorize(context,fileId);
    if (!file) return null;
    const stream = await this.storage.get(file.bucket,file.objectKey);
    await this.repository.audit(context,file.id,"download","succeeded");
    return { file, stream };
  }

  async delete(context: AuthContext, fileId: string) {
    await this.protection?.consume(context,"delete");
    const current = await this.authorize(context,fileId);
    if (!current) {
      const existing = await this.repository.get(fileId);
      if (existing?.workspaceId === context.workspaceId && existing.userId === context.userId && existing.deletedAt) {
        await this.removeObject(existing,context,"delete");
        return false;
      }
      return false;
    }
    const file = await this.repository.markDeleted(context,fileId);
    await this.removeObject(file,context,"delete");
    return true;
  }

  async deleteChat(context: AuthContext, chatId: string) {
    const files = await this.repository.listChat(context, chatId);
    for (const file of files) {
      await this.repository.markDeleted(context, file.id);
      await this.removeObject(file, context, "delete").catch(() => undefined);
    }
    try {
      const chatPrefix = objectKey(["workspace", segment(context.workspaceId), "user", segment(context.userId), "chats", segment(chatId)]) + "/";
      for await (const object of this.storage.list(NPATI_BUCKETS.chat, chatPrefix)) {
        if (object.key) {
          await this.storage.remove(NPATI_BUCKETS.chat, object.key).catch(() => undefined);
        }
      }
    } catch {
      // Ignore prefix listing or cleanup errors if storage is empty or unreachable
    }
  }

  async deleteBusiness(context: AuthContext, businessId: string) {
    const files = await this.repository.listBusiness(context,businessId);
    for (const file of files) {
      await this.repository.markDeleted(context,file.id);
      await this.removeObject(file,context,"delete");
    }
  }

  async cleanupPending(limit = 100) {
    for (const file of await this.repository.listPendingCleanup(limit)) {
      const context: AuthContext = { workspaceId: file.workspaceId, userId: file.userId, permissions: [] };
      await this.removeObject(file,context,"cleanup").catch(()=>undefined);
    }
  }

  private async removeObject(file: StoredFile, context: AuthContext, action: "delete" | "cleanup") {
    await cleanupStoredFileObject(this.storage,this.repository,file,{context,action,throwOnFailure:true});
  }

  async migrateLegacy() {
    if (!this.legacyDirectory) return { migrated: 0, failed: 0 };
    let names: string[];
    try { names = await readdir(this.legacyDirectory); } catch { return { migrated: 0, failed: 0 }; }
    let migrated=0,failed=0;
    for (const name of names.filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name))) {
      const id=name.slice(0,-5);
      try {
        const metadata=JSON.parse(await readFile(path.join(this.legacyDirectory,name),"utf8")) as Record<string,unknown>;
        const data=await readFile(path.join(this.legacyDirectory,id+".bin"));
        const workspaceId=String(metadata.workspaceId??""),userId=String(metadata.userId??""),businessId=String(metadata.businessId??"");
        if(!workspaceId||!userId||!businessId)throw new Error("Legacy attachment ownership is incomplete");
        const context: AuthContext={ workspaceId,userId,permissions:["workspace:read"] };
        const reference=await this.repository.findLegacyReference(workspaceId,userId,businessId,id);
        const kind=(["image","audio","document","file"].includes(String(metadata.kind))?String(metadata.kind):"file") as FileCategory;
        const checksum=createHash("sha256").update(data).digest("hex");
        const chatScope=reference.chatId??"legacy";
        const key=objectKey(["workspace",segment(workspaceId),"user",segment(userId),"chats",segment(chatScope),kind,id]);
        const reservation=await this.repository.reserve(context,{
          id,workspaceId,userId,businessId,chatId:reference.chatId,messageId:reference.messageId,
          bucket:NPATI_BUCKETS.chat,objectKey:key,originalFilename:String(metadata.name??"attachment"),
          mimeType:String(metadata.mimeType??"application/octet-stream"),sizeBytes:data.length,checksum,category:kind,
          idempotencyKey:"legacy:"+id,
        });
        if(reservation.file.status!=="ready"){
          await this.storage.put(NPATI_BUCKETS.chat,key,data,{"Content-Type":String(metadata.mimeType??"application/octet-stream"),"x-amz-meta-checksum-sha256":checksum,"x-amz-meta-file-id":id});
          await this.repository.markReady(context,id);
        }
        await this.repository.audit(context,id,"migrate","succeeded",{ chatId:reference.chatId??null });
        await rm(path.join(this.legacyDirectory,id+".bin"),{force:true});
        await rm(path.join(this.legacyDirectory,name),{force:true});
        migrated++;
      } catch { failed++; }
    }
    return { migrated,failed };
  }

  async close(){ await this.repository.close(); }
}
