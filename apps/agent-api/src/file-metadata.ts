import type { AuthContext } from "@npati/workspace";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type FileCategory = "image" | "audio" | "document" | "file";
export type FileStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed" | "deleted";

export interface StoredFile {
  id: string;
  workspaceId: string;
  userId: string;
  businessId?: string;
  companyId?: string;
  chatId?: string;
  messageId?: string;
  bucket: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  category: FileCategory;
  status: FileStatus;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  storageDeletedAt?: string;
  storageMissingAt?: string;
}

export interface ReserveFileInput extends Omit<StoredFile, "status" | "createdAt" | "updatedAt" | "deletedAt" | "storageDeletedAt"> {}

export interface FileMetadataRepository {
  reserve(context: AuthContext, input: ReserveFileInput): Promise<{ file: StoredFile; created: boolean }>;
  get(fileId: string): Promise<StoredFile | null>;
  markReady(context: AuthContext, fileId: string): Promise<StoredFile>;
  markFailed(context: AuthContext, fileId: string): Promise<void>;
  attachMessage(context: AuthContext, fileIds: string[], messageId: string): Promise<void>;
  listChat(context: AuthContext, chatId: string): Promise<StoredFile[]>;
  listBusiness(context: AuthContext, businessId: string): Promise<StoredFile[]>;
  listCompany(context: AuthContext, companyId: string): Promise<StoredFile[]>;
  purgeCompany(context: AuthContext, companyId: string): Promise<number>;
  markDeleted(context: AuthContext, fileId: string): Promise<StoredFile>;
  markStorageDeleted(fileId: string): Promise<void>;
  listPendingCleanup(limit: number): Promise<StoredFile[]>;
  findExistingObjectKeys(bucket: string, keys: string[]): Promise<Set<string>>;
  listReconciliationPage(afterId: string | undefined, limit: number): Promise<StoredFile[]>;
  markMissingObject(fileId: string): Promise<void>;
  auditReconciliation(file: StoredFile | undefined, bucket: string, objectKey: string, action: "minio_orphan_removed" | "database_object_missing" | "scan", outcome: "succeeded" | "failed" | "skipped", detail?: Record<string, unknown>): Promise<void>;
  findLegacyReference(workspaceId: string, userId: string, businessId: string, attachmentId: string): Promise<{ chatId?: string; messageId?: string }>;
  audit(context: AuthContext, fileId: string, action: "upload" | "download" | "delete" | "migrate" | "cleanup", outcome: "requested" | "succeeded" | "failed" | "denied", detail?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function mapFile(row: Record<string, unknown>): StoredFile {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), userId: String(row.user_id),
    businessId: row.business_id ? String(row.business_id) : undefined,
    companyId: row.company_id ? String(row.company_id) : undefined,
    chatId: row.chat_id ? String(row.chat_id) : undefined,
    messageId: row.message_id ? String(row.message_id) : undefined,
    bucket: String(row.bucket), objectKey: String(row.object_key),
    originalFilename: String(row.original_filename), mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes), checksum: String(row.checksum), category: row.category as FileCategory,
    status: row.status as FileStatus, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
    storageDeletedAt: row.storage_deleted_at ? String(row.storage_deleted_at) : undefined,
    storageMissingAt: row.storage_missing_at ? String(row.storage_missing_at) : undefined,
  };
}

const columns = "id,workspace_id,user_id,business_id,company_id,chat_id,message_id,bucket,object_key,original_filename,mime_type,size_bytes,checksum,category,status,idempotency_key,created_at,updated_at,deleted_at,storage_deleted_at,storage_missing_at";

function assertOwner(context: AuthContext, file: StoredFile) {
  if (file.workspaceId !== context.workspaceId || file.userId !== context.userId) throw new Error("File tenant access denied");
}

export class PostgresFileMetadataRepository implements FileMetadataRepository {
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 5 }); }

  async reserve(context: AuthContext, input: ReserveFileInput) {
    assertOwner(context, { ...input, status: "uploading", createdAt: "", updatedAt: "" });
    const result = await this.pool.query(`INSERT INTO files
      (id,workspace_id,user_id,business_id,company_id,chat_id,message_id,bucket,object_key,original_filename,mime_type,size_bytes,checksum,category,status,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'uploading',$15)
      ON CONFLICT DO NOTHING RETURNING ${columns}`,
      [input.id,input.workspaceId,input.userId,input.businessId ?? null,input.companyId ?? null,input.chatId ?? null,input.messageId ?? null,
       input.bucket,input.objectKey,input.originalFilename,input.mimeType,input.sizeBytes,input.checksum,input.category,input.idempotencyKey ?? null]);
    if (result.rows[0]) return { file: mapFile(result.rows[0]), created: true };
    const existing = await this.pool.query(`SELECT ${columns} FROM files WHERE id=$1 OR
      (workspace_id=$2 AND user_id=$3 AND idempotency_key=$4 AND $4 IS NOT NULL) LIMIT 1`,
      [input.id,input.workspaceId,input.userId,input.idempotencyKey ?? null]);
    if (!existing.rows[0]) throw new Error("File reservation conflict");
    const file = mapFile(existing.rows[0]);
    assertOwner(context, file);
    if (file.checksum !== input.checksum || file.sizeBytes !== input.sizeBytes || file.chatId !== input.chatId) {
      throw new Error("Attachment idempotency key was reused with different content");
    }
    return { file, created: false };
  }

  async get(fileId: string) {
    const result = await this.pool.query(`SELECT ${columns} FROM files WHERE id=$1`, [fileId]);
    return result.rows[0] ? mapFile(result.rows[0]) : null;
  }
  async markReady(context: AuthContext, fileId: string) {
    const result = await this.pool.query(`UPDATE files SET status='ready',updated_at=now(),deleted_at=NULL,storage_deleted_at=NULL,storage_missing_at=NULL
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING ${columns}`, [fileId,context.workspaceId,context.userId]);
    if (!result.rows[0]) throw new Error("File tenant access denied");
    return mapFile(result.rows[0]);
  }
  async markFailed(context: AuthContext, fileId: string) {
    await this.pool.query("UPDATE files SET status='failed',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3", [fileId,context.workspaceId,context.userId]);
  }
  async attachMessage(context: AuthContext, fileIds: string[], messageId: string) {
    if (!fileIds.length) return;
    const result = await this.pool.query("UPDATE files SET message_id=$1,updated_at=now() WHERE id=ANY($2::uuid[]) AND workspace_id=$3 AND user_id=$4 AND deleted_at IS NULL", [messageId,fileIds,context.workspaceId,context.userId]);
    if (result.rowCount !== fileIds.length) throw new Error("One or more attachments could not be linked to the message");
  }
  async listChat(context: AuthContext, chatId: string) {
    const chatPattern = `%/chats/${chatId}/%`;
    const result = await this.pool.query(`SELECT ${columns} FROM files WHERE workspace_id=$1 AND user_id=$2 AND (chat_id=$3 OR object_key LIKE $4) AND deleted_at IS NULL ORDER BY created_at,id`, [context.workspaceId,context.userId,chatId,chatPattern]);
    return result.rows.map(mapFile);
  }
  async listBusiness(context: AuthContext, businessId: string) {
    const result=await this.pool.query(`SELECT ${columns} FROM files WHERE workspace_id=$1 AND user_id=$2 AND business_id=$3 AND deleted_at IS NULL ORDER BY created_at,id`,[context.workspaceId,context.userId,businessId]);
    return result.rows.map(mapFile);
  }
  async listCompany(context: AuthContext, companyId: string) {
    const result=await this.pool.query("SELECT "+columns+" FROM files WHERE workspace_id=$1 AND user_id=$2 AND company_id=$3 ORDER BY created_at,id",[context.workspaceId,context.userId,companyId]);
    return result.rows.map(mapFile);
  }
  async purgeCompany(context: AuthContext, companyId: string) {
    const result=await this.pool.query("DELETE FROM files WHERE workspace_id=$1 AND user_id=$2 AND company_id=$3",[context.workspaceId,context.userId,companyId]);
    return result.rowCount??0;
  }
  async markDeleted(context: AuthContext, fileId: string) {
    const result = await this.pool.query(`UPDATE files SET status='deleted',deleted_at=COALESCE(deleted_at,now()),delete_attempts=delete_attempts+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING ${columns}`, [fileId,context.workspaceId,context.userId]);
    if (!result.rows[0]) throw new Error("File tenant access denied");
    return mapFile(result.rows[0]);
  }
  async markStorageDeleted(fileId: string) {
    await this.pool.query("UPDATE files SET storage_deleted_at=COALESCE(storage_deleted_at,now()),storage_missing_at=NULL,updated_at=now() WHERE id=$1", [fileId]);
  }
  async listPendingCleanup(limit: number) {
    const result = await this.pool.query(`SELECT ${columns} FROM files WHERE deleted_at IS NOT NULL AND storage_deleted_at IS NULL ORDER BY updated_at,id LIMIT $1`, [Math.max(1,Math.min(limit,100))]);
    return result.rows.map(mapFile);
  }
  async findExistingObjectKeys(bucket: string, keys: string[]) {
    if (!keys.length) return new Set<string>();
    const result=await this.pool.query("SELECT object_key FROM files WHERE bucket=$1 AND object_key=ANY($2::text[]) AND storage_deleted_at IS NULL",[bucket,keys]);
    return new Set(result.rows.map((row)=>String(row.object_key)));
  }
  async listReconciliationPage(afterId: string | undefined, limit: number) {
    const result=await this.pool.query(`SELECT ${columns} FROM files WHERE storage_deleted_at IS NULL AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`,[afterId??null,Math.max(1,Math.min(limit,1000))]);
    return result.rows.map(mapFile);
  }
  async markMissingObject(fileId: string) { await this.pool.query("UPDATE files SET status='failed',storage_missing_at=COALESCE(storage_missing_at,now()),updated_at=now() WHERE id=$1 AND deleted_at IS NULL",[fileId]); }
  async auditReconciliation(file: StoredFile | undefined,bucket: string,objectKey: string,action: "minio_orphan_removed"|"database_object_missing"|"scan",outcome: "succeeded"|"failed"|"skipped",detail: Record<string,unknown>={}) {
    await this.pool.query("INSERT INTO storage_reconciliation_audit(id,file_id,bucket,object_key,action,outcome,detail) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[randomUUID(),file?.id??null,bucket,objectKey,action,outcome,JSON.stringify(detail)]);
  }
  async findLegacyReference(workspaceId: string, userId: string, businessId: string, attachmentId: string) {
    const result = await this.pool.query(`SELECT c.id AS chat_id,m.id AS message_id FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE c.workspace_id=$1 AND c.user_id=$2 AND c.business_id=$3 AND m.content LIKE $4
      ORDER BY m.created_at LIMIT 1`, [workspaceId,userId,businessId,"%npati-attachment:%:"+attachmentId+":%"]);
    return result.rows[0] ? { chatId: String(result.rows[0].chat_id), messageId: String(result.rows[0].message_id) } : {};
  }
  async audit(context: AuthContext, fileId: string, action: "upload" | "download" | "delete" | "migrate" | "cleanup", outcome: "requested" | "succeeded" | "failed" | "denied", detail: Record<string, unknown> = {}) {
    await this.pool.query("INSERT INTO file_audit(id,workspace_id,user_id,file_id,action,outcome,detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [randomUUID(),context.workspaceId,context.userId,fileId,action,outcome,JSON.stringify(detail)]);
  }
  async close() { await this.pool.end(); }
}

export class InMemoryFileMetadataRepository implements FileMetadataRepository {
  private readonly files = new Map<string, StoredFile>();
  async reserve(context: AuthContext, input: ReserveFileInput) {
    const byKey = [...this.files.values()].find((file) => input.idempotencyKey && file.workspaceId === context.workspaceId && file.userId === context.userId && file.idempotencyKey === input.idempotencyKey);
    const existing = this.files.get(input.id) ?? byKey;
    if (existing) {
      assertOwner(context, existing);
      if (existing.checksum !== input.checksum || existing.sizeBytes !== input.sizeBytes || existing.chatId !== input.chatId) throw new Error("Attachment idempotency key was reused with different content");
      return { file: existing, created: false };
    }
    const now = new Date().toISOString();
    const file: StoredFile = { ...input, status: "uploading", createdAt: now, updatedAt: now };
    this.files.set(file.id,file);
    return { file, created: true };
  }
  async get(id: string) { return this.files.get(id) ?? null; }
  async markReady(context: AuthContext,id: string) { const f=await this.owned(context,id);f.status="ready";f.deletedAt=undefined;f.storageDeletedAt=undefined;f.updatedAt=new Date().toISOString();return f; }
  async markFailed(context: AuthContext,id: string) { const f=await this.owned(context,id);f.status="failed"; }
  async attachMessage(context: AuthContext,ids: string[],messageId: string) { for(const id of ids)(await this.owned(context,id)).messageId=messageId; }
  async listChat(context: AuthContext,chatId: string) { return [...this.files.values()].filter(f=>f.workspaceId===context.workspaceId&&f.userId===context.userId&&(f.chatId===chatId||f.objectKey.includes(`/chats/${chatId}/`))&&!f.deletedAt); }
  async listBusiness(context: AuthContext,businessId: string) { return [...this.files.values()].filter(f=>f.workspaceId===context.workspaceId&&f.userId===context.userId&&f.businessId===businessId&&!f.deletedAt); }
  async listCompany(context: AuthContext,companyId: string) { return [...this.files.values()].filter(f=>f.workspaceId===context.workspaceId&&f.userId===context.userId&&f.companyId===companyId); }
  async purgeCompany(context: AuthContext,companyId: string) { let count=0;for(const [id,file] of this.files)if(file.workspaceId===context.workspaceId&&file.userId===context.userId&&file.companyId===companyId){this.files.delete(id);count++;}return count; }
  async markDeleted(context: AuthContext,id: string) { const f=await this.owned(context,id);f.status="deleted";f.deletedAt??=new Date().toISOString();return f; }
  async markStorageDeleted(id: string) { const f=this.files.get(id);if(f)f.storageDeletedAt??=new Date().toISOString(); }
  async listPendingCleanup(limit: number) { return [...this.files.values()].filter(f=>f.deletedAt&&!f.storageDeletedAt).slice(0,limit); }
  async findExistingObjectKeys(bucket:string,keys:string[]){return new Set(keys.filter(key=>[...this.files.values()].some(file=>file.bucket===bucket&&file.objectKey===key&&!file.storageDeletedAt)));}
  async listReconciliationPage(afterId:string|undefined,limit:number){return [...this.files.values()].filter(file=>!file.storageDeletedAt&&(!afterId||file.id>afterId)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit);}
  async markMissingObject(id:string){const file=this.files.get(id);if(file&&!file.deletedAt){file.status="failed";file.storageMissingAt??=new Date().toISOString();}}
  async auditReconciliation(){}
  async findLegacyReference() { return {}; }
  async audit() {}
  async close() {}
  private async owned(context: AuthContext,id: string) { const f=this.files.get(id);if(!f)throw new Error("File not found");assertOwner(context,f);return f; }
}
