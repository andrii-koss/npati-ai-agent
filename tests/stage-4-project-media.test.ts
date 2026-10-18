import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import {
  ProjectMediaService,
  ProjectMediaError,
  ALLOWED_MEDIA_MIME_TYPES,
} from "../apps/agent-api/src/project-media-service";
import { PROJECT_MEDIA_TOOLS } from "../apps/agent-api/src/project-agent-capabilities";
import type { ObjectStorage, StoredObjectInfo } from "../apps/agent-api/src/object-storage";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import type { AuthContext } from "@npati/workspace";

function createMockObjectStorage() {
  const store = new Map<string, { buffer: Buffer; info: StoredObjectInfo; metadata?: Record<string, string> }>();

  const storage: ObjectStorage = {
    async initialize() {},
    async health() { return "ok"; },

    async put(bucket: string, key: string, data: Buffer, metadata?: Record<string, string>) {
      const storedInfo: StoredObjectInfo = {
        key,
        size: data.length,
        lastModified: new Date(),
        etag: "mock-etag-" + key,
      };
      store.set(`${bucket}:${key}`, { buffer: data, info: storedInfo, metadata });
    },

    async get(bucket: string, key: string) {
      const item = store.get(`${bucket}:${key}`);
      if (!item) {
        throw new Error("NoSuchKey");
      }
      return Readable.from(item.buffer);
    },

    async exists(bucket: string, key: string) {
      return store.has(`${bucket}:${key}`);
    },

    async remove(bucket: string, key: string) {
      store.delete(`${bucket}:${key}`);
    },

    async *list(bucket: string, prefix?: string) {
      const p = prefix || "";
      for (const [compositeKey, val] of store.entries()) {
        if (compositeKey.startsWith(`${bucket}:`)) {
          const key = compositeKey.slice(bucket.length + 1);
          if (key.startsWith(p)) {
            yield val.info;
          }
        }
      }
    },
  };

  return { storage, store };
}

function createMockProjectWorkspace() {
  const files = new Map<string, { content: string; revision: string }>();

  const workspace: ProjectWorkspace = {
    async createFile(_ctx: any, companyId: string, projectId: string, filePath: string, content: string) {
      files.set(`${companyId}/${projectId}/${filePath}`, { content, revision: "rev-1" });
      return { path: filePath, size: Buffer.byteLength(content), revision: "rev-1" } as any;
    },
    async writeFile(_ctx: any, companyId: string, projectId: string, filePath: string, content: string) {
      files.set(`${companyId}/${projectId}/${filePath}`, { content, revision: "rev-2" });
      return { path: filePath, size: Buffer.byteLength(content), revision: "rev-2" } as any;
    },
    async deleteFile(_ctx: any, companyId: string, projectId: string, filePath: string) {
      files.delete(`${companyId}/${projectId}/${filePath}`);
    },
    async readFile(_ctx: any, companyId: string, projectId: string, filePath: string) {
      const f = files.get(`${companyId}/${projectId}/${filePath}`);
      if (!f) throw new Error("File not found");
      return { content: f.content, revision: f.revision } as any;
    },
  } as unknown as ProjectWorkspace;

  return { workspace, files };
}

describe("Stage 4: MinIO Integration for Website Media Files", () => {
  const context: AuthContext = {
    workspaceId: "ws-test",
    companyId: "company-alpha",
    userId: "user-123",
  } as any;

  const companyId = "company-alpha";
  const projectId = "project-uuid-001";

  describe("1. MIME Validation & Security Sanitization", () => {
    const { storage } = createMockObjectStorage();
    const service = new ProjectMediaService(storage);

    it("accepts supported image, video, audio, font, and pdf MIME types", () => {
      expect(service.resolveMimeType("hero.jpg", "image/jpeg")).toBe("image/jpeg");
      expect(service.resolveMimeType("banner.png")).toBe("image/png");
      expect(service.resolveMimeType("anim.webp")).toBe("image/webp");
      expect(service.resolveMimeType("logo.svg", "image/svg+xml")).toBe("image/svg+xml");
      expect(service.resolveMimeType("promo.mp4")).toBe("video/mp4");
      expect(service.resolveMimeType("podcast.mp3")).toBe("audio/mpeg");
      expect(service.resolveMimeType("font.woff2")).toBe("font/woff2");
      expect(service.resolveMimeType("brochure.pdf")).toBe("application/pdf");
    });

    it("rejects malicious or executable file extensions", () => {
      const dangerous = ["malware.exe", "script.js", "shell.sh", "exploit.bat", "index.php", "config.env"];
      for (const file of dangerous) {
        expect(() => service.resolveMimeType(file)).toThrow(ProjectMediaError);
        try {
          service.resolveMimeType(file);
        } catch (err: any) {
          expect(err.code).toBe("unsupported_media_type");
          expect(err.status).toBe(415);
        }
      }
    });

    it("sanitizes relative paths preventing directory traversal", () => {
      expect(() => service.mediaKey(companyId, projectId, "../../etc/passwd.jpg")).toThrow(ProjectMediaError);
    });

    it("uses immutable primary identifier projectId regardless of display names", () => {
      const key1 = service.mediaKey(companyId, projectId, "assets/logo.png");
      const key2 = service.mediaKey(companyId, projectId, "assets/logo.png");
      expect(key1).toBe(key2);
      expect(key1).toBe(`company-alpha/${projectId}/assets/logo.png`);
    });
  });

  describe("2. File Size Limits & Quota Enforcement", () => {
    it("rejects images larger than maxImageSizeBytes (15MB)", async () => {
      const { storage } = createMockObjectStorage();
      const service = new ProjectMediaService(storage, undefined, {
        maxImageSizeBytes: 1024 * 1024, // 1MB limit for test
      });

      const oversizedBuffer = Buffer.alloc(1024 * 1024 + 10);
      await expect(
        service.uploadMedia(context, companyId, projectId, {
          name: "huge-image.jpg",
          data: oversizedBuffer,
          mimeType: "image/jpeg",
        }),
      ).rejects.toThrow("exceeds limit");
    });

    it("rejects media larger than maxMediaSizeBytes (50MB)", async () => {
      const { storage } = createMockObjectStorage();
      const service = new ProjectMediaService(storage, undefined, {
        maxMediaSizeBytes: 2 * 1024 * 1024, // 2MB limit for test
      });

      const oversizedVideo = Buffer.alloc(2 * 1024 * 1024 + 100);
      await expect(
        service.uploadMedia(context, companyId, projectId, {
          name: "big-video.mp4",
          data: oversizedVideo,
          mimeType: "video/mp4",
        }),
      ).rejects.toThrow("exceeds limit");
    });

    it("enforces project quota (default 250MB)", async () => {
      const { storage } = createMockObjectStorage();
      const service = new ProjectMediaService(storage, undefined, {
        projectQuotaBytes: 1000, // 1000 bytes quota
      });

      // Upload 600 bytes
      await service.uploadMedia(context, companyId, projectId, {
        name: "first.png",
        data: Buffer.alloc(600),
        mimeType: "image/png",
      });

      // Second upload of 500 bytes should exceed quota (600 + 500 = 1100 > 1000)
      await expect(
        service.uploadMedia(context, companyId, projectId, {
          name: "second.png",
          data: Buffer.alloc(500),
          mimeType: "image/png",
        }),
      ).rejects.toThrow("Project media quota exceeded");
    });
  });

  describe("3. Lifecycle: Upload -> MinIO -> Workspace Mirror -> Read -> Delete", () => {
    it("successfully uploads, mirrors to workspace public/assets/, lists, and reads", async () => {
      const { storage, store } = createMockObjectStorage();
      const { workspace, files } = createMockProjectWorkspace();
      const service = new ProjectMediaService(storage, workspace);

      const fakeImage = Buffer.from("FAKE-PNG-IMAGE-BINARY-DATA");

      // 1. Upload
      const uploaded = await service.uploadMedia(context, companyId, projectId, {
        name: "header-logo.png",
        data: fakeImage,
        mimeType: "image/png",
      });

      expect(uploaded.name).toBe("header-logo.png");
      expect(uploaded.mimeType).toBe("image/png");
      expect(uploaded.size).toBe(fakeImage.length);
      expect(uploaded.url).toBe(`/api/projects/${projectId}/media/assets/header-logo.png`);

      // 2. Check MinIO object
      const storedItem = store.get(`npati-project-media:company-alpha/${projectId}/assets/header-logo.png`);
      expect(storedItem).toBeDefined();
      expect(storedItem?.buffer.length).toBe(fakeImage.length);

      // 3. Check Workspace Mirror
      const mirroredPath = `${companyId}/${projectId}/public/assets/header-logo.png`;
      expect(files.has(mirroredPath)).toBe(true);

      // 4. List Media
      const list = await service.listMedia(companyId, projectId);
      expect(list.items.length).toBe(1);
      expect(list.items[0].name).toBe("header-logo.png");
      expect(list.totalBytes).toBe(fakeImage.length);

      // 5. Read Stream
      const streamResult = await service.getMedia(companyId, projectId, "assets/header-logo.png");
      expect(streamResult.mimeType).toBe("image/png");
      expect(streamResult.stream).toBeDefined();

      // 6. Delete Media
      await service.deleteMedia(context, companyId, projectId, "assets/header-logo.png");

      // Confirm deleted from MinIO
      expect(store.has(`npati-project-media:company-alpha/${projectId}/assets/header-logo.png`)).toBe(false);

      // Confirm deleted from workspace mirror
      expect(files.has(mirroredPath)).toBe(false);

      // Confirm empty list
      const emptyList = await service.listMedia(companyId, projectId);
      expect(emptyList.items.length).toBe(0);
    });
  });

  describe("4. Cross-Project Isolation (Project A vs Project B)", () => {
    it("ensures Project B cannot view or access Project A media", async () => {
      const { storage } = createMockObjectStorage();
      const service = new ProjectMediaService(storage);

      const projectA = "project-aaa-111";
      const projectB = "project-bbb-222";

      // Upload to Project A
      await service.uploadMedia(context, companyId, projectA, {
        name: "secret-diagram.png",
        data: Buffer.from("PROJECT-A-DATA"),
        mimeType: "image/png",
      });

      // Project A lists 1 item
      const listA = await service.listMedia(companyId, projectA);
      expect(listA.items.length).toBe(1);
      expect(listA.items[0].name).toBe("secret-diagram.png");

      // Project B lists 0 items
      const listB = await service.listMedia(companyId, projectB);
      expect(listB.items.length).toBe(0);

      // Project B querying Project A's media returns not found (404)
      await expect(
        service.getMedia(companyId, projectB, "assets/secret-diagram.png"),
      ).rejects.toThrow();

      // Deleting non-existent file in Project B does not affect Project A
      await service.deleteMedia(context, companyId, projectB, "assets/secret-diagram.png");

      const listAAfter = await service.listMedia(companyId, projectA);
      expect(listAAfter.items.length).toBe(1);
    });
  });

  describe("5. Coding Agent Capabilities & Tool Schema", () => {
    it("exposes the 4 permitted project.media tools", () => {
      expect(PROJECT_MEDIA_TOOLS).toContain("project.media.upload");
      expect(PROJECT_MEDIA_TOOLS).toContain("project.media.list");
      expect(PROJECT_MEDIA_TOOLS).toContain("project.media.get");
      expect(PROJECT_MEDIA_TOOLS).toContain("project.media.delete");
      expect(PROJECT_MEDIA_TOOLS.length).toBe(4);
    });
  });

  describe("6. Media Integrity & Exact Binary Mirroring", () => {
    it("mirrors raw binary buffer to workspace without UTF-8 expansion or corruption", async () => {
      const { storage } = createMockObjectStorage();
      const files = new Map<string, { buffer: Buffer; revision: string }>();
      const mockWs = {
        async readFile(_ctx: any, cId: string, pId: string, fPath: string) {
          const item = files.get(`${cId}/${pId}/${fPath}`);
          if (!item) throw new Error("not found");
          return { content: item.buffer.toString("binary"), revision: item.revision };
        },
        async createFile(_ctx: any, cId: string, pId: string, fPath: string, content: string | Buffer) {
          const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
          files.set(`${cId}/${pId}/${fPath}`, { buffer: buf, revision: "rev-1" });
          return { path: fPath, size: buf.length, revision: "rev-1" };
        },
        async writeFile(_ctx: any, cId: string, pId: string, fPath: string, content: string | Buffer) {
          const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
          files.set(`${cId}/${pId}/${fPath}`, { buffer: buf, revision: "rev-2" });
          return { path: fPath, size: buf.length, revision: "rev-2" };
        },
      } as unknown as ProjectWorkspace;

      const service = new ProjectMediaService(storage, mockWs);
      const binaryPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const shaOriginal = crypto.createHash("sha256").update(binaryPng).digest("hex");

      const res = await service.uploadMedia(context, companyId, projectId, {
        name: "hero-integrity.png",
        data: binaryPng,
        mimeType: "image/png",
        workspaceSync: true,
      });

      expect(res.size).toBe(binaryPng.length);
      expect(res.etag).toBe(shaOriginal);

      // Verify workspace copy has exact same byte length and SHA-256
      const wsCopy = files.get(`${companyId}/${projectId}/public/assets/hero-integrity.png`);
      expect(wsCopy).toBeDefined();
      expect(wsCopy!.buffer.length).toBe(binaryPng.length);
      const shaWorkspace = crypto.createHash("sha256").update(wsCopy!.buffer).digest("hex");
      expect(shaWorkspace).toBe(shaOriginal);
    });
  });
});
