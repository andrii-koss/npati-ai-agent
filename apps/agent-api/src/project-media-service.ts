import { createHash } from "node:crypto";
import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { NPATI_BUCKETS, objectKey, objectKeySegment, type ObjectStorage, type StoredObjectInfo } from "./object-storage";
import type { ProjectWorkspace } from "./project-workspace";
import { sanitizeSvg } from "./svg-sanitizer";

export class ProjectMediaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ProjectMediaError";
  }
}

export const ALLOWED_MEDIA_MIME_TYPES = new Map<string, string[]>([
  // Images
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
  ["image/gif", [".gif"]],
  ["image/webp", [".webp"]],
  ["image/svg+xml", [".svg"]],
  ["image/avif", [".avif"]],
  ["image/x-icon", [".ico"]],
  ["image/bmp", [".bmp"]],
  // Video
  ["video/mp4", [".mp4", ".m4v"]],
  ["video/webm", [".webm"]],
  ["video/ogg", [".ogv"]],
  ["video/quicktime", [".mov"]],
  // Audio
  ["audio/mpeg", [".mp3"]],
  ["audio/ogg", [".ogg"]],
  ["audio/wav", [".wav"]],
  ["audio/webm", [".weba"]],
  ["audio/aac", [".aac"]],
  // Fonts & Documents
  ["application/pdf", [".pdf"]],
  ["font/woff", [".woff"]],
  ["font/woff2", [".woff2"]],
  ["font/ttf", [".ttf"]],
  ["font/otf", [".otf"]],
]);

const EXTENSION_TO_MIME = new Map<string, string>();
for (const [mime, exts] of ALLOWED_MEDIA_MIME_TYPES.entries()) {
  for (const ext of exts) {
    EXTENSION_TO_MIME.set(ext.toLowerCase(), mime);
  }
}

export interface StoredMediaItem {
  name: string;
  path: string;
  url: string;
  size: number;
  mimeType: string;
  lastModified: Date;
  etag?: string;
}

export interface ProjectMediaOptions {
  maxImageSizeBytes?: number;
  maxMediaSizeBytes?: number;
  projectQuotaBytes?: number;
}

export class ProjectMediaService {
  private readonly maxImageSizeBytes: number;
  private readonly maxMediaSizeBytes: number;
  private readonly projectQuotaBytes: number;

  constructor(
    private readonly storage: ObjectStorage,
    private readonly workspace?: ProjectWorkspace,
    options: ProjectMediaOptions = {},
  ) {
    this.maxImageSizeBytes = options.maxImageSizeBytes ?? 15 * 1024 * 1024; // 15 MB
    this.maxMediaSizeBytes = options.maxMediaSizeBytes ?? 50 * 1024 * 1024; // 50 MB
    this.projectQuotaBytes = options.projectQuotaBytes ?? 250 * 1024 * 1024; // 250 MB
  }

  resolveMimeType(filename: string, providedMime?: string): string {
    const ext = path.extname(filename).toLowerCase();
    const inferred = EXTENSION_TO_MIME.get(ext);
    const cleanProvided = providedMime ? providedMime.toLowerCase().split(";")[0]?.trim() : undefined;

    if (cleanProvided && ALLOWED_MEDIA_MIME_TYPES.has(cleanProvided)) {
      return cleanProvided;
    }
    if (inferred) {
      return inferred;
    }
    throw new ProjectMediaError(
      "unsupported_media_type",
      `Unsupported media file type: ${ext || filename}. Supported types: images, videos, audio, fonts, and PDF.`,
      415,
    );
  }

  mediaKey(companyId: string, projectId: string, relativePath: string): string {
    const cleanRelative = relativePath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .map(part => {
        if (part === "." || part === "..") throw new ProjectMediaError("invalid_path", "Path traversal is forbidden", 400);
        return part.replace(/[^A-Za-z0-9._-]/g, "_");
      });

    if (!cleanRelative.length) throw new ProjectMediaError("invalid_path", "Media path cannot be empty", 400);

    return objectKey([
      objectKeySegment(companyId),
      objectKeySegment(projectId),
      ...cleanRelative,
    ]);
  }

  prefix(companyId: string, projectId: string, subDir = ""): string {
    const base = `${objectKeySegment(companyId)}/${objectKeySegment(projectId)}`;
    if (!subDir) return `${base}/`;
    const cleanSub = subDir
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .map(part => part.replace(/[^A-Za-z0-9._-]/g, "_"))
      .join("/");
    return `${base}/${cleanSub}/`;
  }

  async getQuotaUsage(companyId: string, projectId: string): Promise<{ totalBytes: number; count: number }> {
    const pfx = this.prefix(companyId, projectId);
    let totalBytes = 0;
    let count = 0;
    for await (const obj of this.storage.list(NPATI_BUCKETS.projectMedia, pfx)) {
      totalBytes += obj.size;
      count++;
    }
    return { totalBytes, count };
  }

  async uploadMedia(
    ctx: AuthContext | undefined,
    companyId: string,
    projectId: string,
    input: {
      name: string;
      data: Buffer;
      mimeType?: string;
      targetDir?: string;
      workspaceSync?: boolean;
    },
  ): Promise<StoredMediaItem> {
    if (!input.name || typeof input.name !== "string") {
      throw new ProjectMediaError("invalid_name", "Media name is required", 400);
    }
    if (!input.data || !Buffer.isBuffer(input.data) || !input.data.length) {
      throw new ProjectMediaError("invalid_data", "Media data cannot be empty", 400);
    }

    const cleanFilename = input.name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 255);
    const mimeType = this.resolveMimeType(cleanFilename, input.mimeType);

    let uploadData = input.data;
    if (mimeType === "image/svg+xml" || cleanFilename.toLowerCase().endsWith(".svg")) {
      const sanitizedResult = sanitizeSvg(input.data);
      uploadData = sanitizedResult.sanitized;
    }

    const isImage = mimeType.startsWith("image/");
    const maxBytes = isImage ? this.maxImageSizeBytes : this.maxMediaSizeBytes;
    if (uploadData.length > maxBytes) {
      throw new ProjectMediaError(
        "file_too_large",
        `File size (${uploadData.length} bytes) exceeds limit of ${maxBytes} bytes`,
        413,
      );
    }

    // Quota check
    const { totalBytes } = await this.getQuotaUsage(companyId, projectId);
    if (totalBytes + uploadData.length > this.projectQuotaBytes) {
      throw new ProjectMediaError(
        "media_quota_exceeded",
        `Project media quota exceeded (${totalBytes + uploadData.length} > ${this.projectQuotaBytes} bytes)`,
        413,
      );
    }

    const targetDir = input.targetDir ? input.targetDir.replace(/^\/+/, "").replace(/\/+$/, "") : "assets";
    const relativeMediaPath = `${targetDir}/${cleanFilename}`.replace(/^\/+/, "");
    const key = this.mediaKey(companyId, projectId, relativeMediaPath);

    const checksum = createHash("sha256").update(uploadData).digest("hex");
    await this.storage.put(NPATI_BUCKETS.projectMedia, key, uploadData, {
      "content-type": mimeType,
      "x-amz-meta-original-name": cleanFilename,
      "x-amz-meta-sha256": checksum,
      "x-amz-meta-uploaded-at": new Date().toISOString(),
    });

    // Mirror to workspace filesystem if workspaceSync is requested and workspace is available
    if (input.workspaceSync !== false && this.workspace && ctx) {
      const workspacePath = `public/${relativeMediaPath}`;
        try {
          const existing = await this.workspace.readFile(ctx, companyId, projectId, workspacePath);
          await this.workspace.writeFile(ctx, companyId, projectId, workspacePath, uploadData, existing.revision);
        } catch {
          await this.workspace.createFile(ctx, companyId, projectId, workspacePath, uploadData).catch(() => undefined);
        }
    }

    const publicUrl = `/api/projects/${encodeURIComponent(projectId)}/media/${relativeMediaPath}`;

    return {
      name: cleanFilename,
      path: relativeMediaPath,
      url: publicUrl,
      size: input.data.length,
      mimeType,
      lastModified: new Date(),
      etag: checksum,
    };
  }

  async getMedia(
    companyId: string,
    projectId: string,
    relativePath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
    const key = this.mediaKey(companyId, projectId, relativePath);
    const exists = await this.storage.exists(NPATI_BUCKETS.projectMedia, key);
    if (!exists) {
      throw new ProjectMediaError("media_not_found", `Media object ${relativePath} not found`, 404);
    }

    const stream = await this.storage.get(NPATI_BUCKETS.projectMedia, key);
    const mimeType = this.resolveMimeType(path.basename(relativePath));
    return { stream, mimeType };
  }

  async listMedia(
    companyId: string,
    projectId: string,
    subDir = "",
  ): Promise<{ items: StoredMediaItem[]; totalBytes: number; quotaBytes: number }> {
    const pfx = this.prefix(companyId, projectId, subDir);
    const items: StoredMediaItem[] = [];
    let totalBytes = 0;

    for await (const obj of this.storage.list(NPATI_BUCKETS.projectMedia, pfx)) {
      const relPath = obj.key.slice(pfx.length);
      if (!relPath) continue;
      const filename = path.basename(relPath);
      let mimeType = "application/octet-stream";
      try {
        mimeType = this.resolveMimeType(filename);
      } catch {
        // Fallback for unknown extension in list
      }
      totalBytes += obj.size;
      items.push({
        name: filename,
        path: relPath,
        url: `/api/projects/${encodeURIComponent(projectId)}/media/${relPath}`,
        size: obj.size,
        mimeType,
        lastModified: obj.lastModified,
        etag: obj.etag,
      });
    }

    return {
      items,
      totalBytes,
      quotaBytes: this.projectQuotaBytes,
    };
  }

  async deleteMedia(
    ctx: AuthContext | undefined,
    companyId: string,
    projectId: string,
    relativePath: string,
  ): Promise<{ deleted: boolean; path: string }> {
    const key = this.mediaKey(companyId, projectId, relativePath);
    await this.storage.remove(NPATI_BUCKETS.projectMedia, key).catch(() => undefined);

    if (this.workspace && ctx) {
      const workspacePath = `public/${relativePath.replace(/^\/+/, "")}`;
      await this.workspace.deleteFile(ctx, companyId, projectId, workspacePath).catch(() => undefined);
    }

    return { deleted: true, path: relativePath };
  }

  async purgeProjectMedia(
    ctx: AuthContext | undefined,
    companyId: string,
    projectId: string,
  ): Promise<{ deletedCount: number; deletedBytes: number }> {
    if (!companyId || !projectId) throw new ProjectMediaError("invalid_target", "companyId and projectId are required for purge", 400);
    const pfx = this.prefix(companyId, projectId);
    const cleanCompany = objectKeySegment(companyId);
    const cleanProject = objectKeySegment(projectId);
    const expectedPrefix = `${cleanCompany}/${cleanProject}/`;
    if (!pfx.startsWith(expectedPrefix)) {
      throw new ProjectMediaError("invalid_prefix", `Security check failed: prefix ${pfx} does not match expected ${expectedPrefix}`, 500);
    }

    let deletedCount = 0;
    let deletedBytes = 0;
    for await (const obj of this.storage.list(NPATI_BUCKETS.projectMedia, pfx)) {
      // Strict safety: verify each object key strictly starts with expected prefix to prevent cross-project deletion
      if (!obj.key.startsWith(expectedPrefix)) {
        continue;
      }
      await this.storage.remove(NPATI_BUCKETS.projectMedia, obj.key);
      deletedCount++;
      deletedBytes += obj.size;
    }
    return { deletedCount, deletedBytes };
  }
}
