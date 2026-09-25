import { createHash, randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type { EmailAttachment } from "./email-inbox-types";
import type { FileCategory, FileMetadataRepository, StoredFile } from "./file-metadata";
import { NPATI_BUCKETS, objectKey, objectKeySegment, type ObjectStorage } from "./object-storage";

function attachmentCategory(contentType: string): FileCategory {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (/pdf|text|document|sheet|presentation|officedocument/i.test(contentType)) return "document";
  return "file";
}

function isPersonalEmailScope(companyId: string): boolean {
  return companyId.startsWith("personal:");
}

export class EmailAttachmentStorage {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly files: FileMetadataRepository,
  ) {}

  async persist(context: AuthContext, companyId: string, threadId: string, attachments: EmailAttachment[]): Promise<EmailAttachment[]> {
    const stored: EmailAttachment[] = [];
    for (const attachment of attachments) {
      if (!attachment.contentBase64) {
        stored.push(attachment);
        continue;
      }
      const data = Buffer.from(attachment.contentBase64, "base64");
      if (data.length > 10 * 1024 * 1024) throw Object.assign(new Error(`Email attachment exceeds 10 MB: ${attachment.filename}`), { status: 413 });
      const checksum = createHash("sha256").update(data).digest("hex");
      const id = randomUUID();
      const key = objectKey([
        "workspace", objectKeySegment(context.workspaceId), "company", objectKeySegment(companyId),
        "email", objectKeySegment(threadId), id,
      ]);
      const reservation = await this.files.reserve(context, {
        id,
        workspaceId: context.workspaceId,
        userId: context.userId,
        companyId: isPersonalEmailScope(companyId) ? undefined : companyId,
        bucket: NPATI_BUCKETS.chat,
        objectKey: key,
        originalFilename: attachment.filename,
        mimeType: attachment.contentType || "application/octet-stream",
        sizeBytes: data.length,
        checksum,
        category: attachmentCategory(attachment.contentType || ""),
        idempotencyKey: `email:${threadId}:${checksum}:${attachment.filename}`,
      });
      const file = reservation.file;
      if (file.status !== "ready") {
        try {
          await this.storage.put(file.bucket, file.objectKey, data, {
            "Content-Type": file.mimeType,
            "x-amz-meta-checksum-sha256": checksum,
            "x-amz-meta-file-id": file.id,
          });
          await this.files.markReady(context, file.id);
          await this.files.audit(context, file.id, "upload", "succeeded", { companyId, threadId, source: "email" });
        } catch (error) {
          await this.files.markFailed(context, file.id).catch(() => undefined);
          await this.files.audit(context, file.id, "upload", "failed", {
            companyId, threadId, source: "email", message: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
          throw error;
        }
      }
      stored.push({
        filename: attachment.filename,
        contentType: file.mimeType,
        sizeBytes: data.length,
        url: `/api/companies/${encodeURIComponent(companyId)}/email-inbox/attachments/${file.id}`,
      });
    }
    return stored;
  }

  async open(context: AuthContext, companyId: string, fileId: string): Promise<{ file: StoredFile; stream: NodeJS.ReadableStream } | null> {
    const file = await this.files.get(fileId);
    const correctScope = isPersonalEmailScope(companyId)
      ? file?.userId === context.userId && !file.companyId
      : file?.companyId === companyId;
    if (!file || file.deletedAt || file.status !== "ready" || file.workspaceId !== context.workspaceId || !correctScope || file.bucket !== NPATI_BUCKETS.chat) {
      return null;
    }
    const stream = await this.storage.get(file.bucket, file.objectKey);
    await this.files.audit(context, file.id, "download", "succeeded", { companyId, source: "email" }).catch(() => undefined);
    return { file, stream };
  }

  async materialize(context: AuthContext, companyId: string, attachments: EmailAttachment[]): Promise<EmailAttachment[]> {
    return Promise.all(attachments.map(async (attachment) => {
      if (attachment.contentBase64 || !attachment.url) return attachment;
      const match = attachment.url.match(/\/email-inbox\/attachments\/([0-9a-f-]{36})$/i);
      if (!match) return attachment;
      const opened = await this.open(context, companyId, match[1]!);
      if (!opened) throw new Error(`Stored email attachment is unavailable: ${attachment.filename}`);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream as AsyncIterable<Buffer | Uint8Array | string>) chunks.push(Buffer.from(chunk));
      return { ...attachment, contentBase64: Buffer.concat(chunks).toString("base64") };
    }));
  }

  async remove(context: AuthContext, companyId: string, attachment: EmailAttachment): Promise<boolean> {
    const match = attachment.url?.match(/\/email-inbox\/attachments\/([0-9a-f-]{36})$/i);
    if (!match) return false;
    const file = await this.files.get(match[1]!);
    const correctScope = isPersonalEmailScope(companyId)
      ? file?.userId === context.userId && !file.companyId
      : file?.companyId === companyId;
    if (!file || file.workspaceId !== context.workspaceId || !correctScope || file.bucket !== NPATI_BUCKETS.chat) return false;
    if (!file.deletedAt) await this.files.markDeleted(context, file.id);
    await this.storage.remove(file.bucket, file.objectKey).catch(() => undefined);
    await this.files.markStorageDeleted(file.id);
    await this.files.audit(context, file.id, "delete", "succeeded", { companyId, source: "email" }).catch(() => undefined);
    return true;
  }
}
