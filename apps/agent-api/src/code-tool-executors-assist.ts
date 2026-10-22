import type { AuthContext } from "@npati/workspace";
import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import { normalizeWorkspacePath } from "./code-tools-path";
import { isSensitivePath } from "./code-tools-sensitive";

/**
 * Manifest v15 assist tools: explicit completion, image and preview viewing, documentation lookup.
 *
 * None of them adds a new capability to the platform: `code.image.view` reads through the same workspace
 * provider as `code.fs.read`, `code.preview.screenshot` is the existing Browser QA capture, and the web tools are
 * the existing web-research provider (SSRF-validated URLs, exfiltration guard, Crawl4AI when configured). A tool
 * whose backing service is not wired is simply not registered, so the catalogue never offers it.
 */

/** An image produced by a tool. The runtime moves it out of the model-visible result (`imageAttachment`). */
export interface CodeToolImageAttachment {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataBase64: string;
  source: string;
  question?: string;
}

export const CODE_IMAGE_ATTACHMENT_KEY = "imageAttachment";
export const MAX_TOOL_IMAGE_BYTES = 2_000_000;

export interface CodeAssistToolOptions {
  /** Reads a workspace file with its exact bytes (`contentBase64` for binary files). */
  readWorkspaceFile?: (input: { ctx: AuthContext; companyId: string; projectId: string; path: string }) => Promise<{
    binary?: boolean; contentBase64?: string; size?: number; mimeGuess?: string;
  }>;
  /** Existing Browser QA capture of the running Live Preview. */
  previewScreenshot?: (input: {
    ctx: AuthContext; companyId: string; projectId: string; path: string; viewport: "desktop" | "tablet" | "mobile"; runId?: string;
  }) => Promise<{ mimeType: string; base64Data: string; sizeBytes: number; statusCode?: number; issues?: number }>;
  /** Existing web-research provider (search + SSRF-safe fetch). */
  webResearch?: {
    search(input: { query: string; maxResults?: number }): Promise<Array<{ title?: string; url: string; snippet?: string }>>;
    fetch(input: { url: string }): Promise<{ url?: string; finalUrl?: string; title?: string; content?: string; markdown?: string; text?: string; fetchedAt?: string; provider?: string }>;
  };
}

const IMAGE_SIGNATURES: Array<{ mimeType: CodeToolImageAttachment["mimeType"]; test: (bytes: Buffer) => boolean }> = [
  { mimeType: "image/png", test: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mimeType: "image/jpeg", test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mimeType: "image/gif", test: (bytes) => bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a" },
  { mimeType: "image/webp", test: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Identifies a supported raster image by its magic bytes; the file name is never trusted. */
export function detectToolImageType(bytes: Buffer): CodeToolImageAttachment["mimeType"] | null {
  return IMAGE_SIGNATURES.find((signature) => signature.test(bytes))?.mimeType ?? null;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function canonicalAssistExecutors(options: CodeAssistToolOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const executors: Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> = {
    /**
     * Completion is decided by the loop, not here: the runner sees a successful `code.finish` and settles the
     * run exactly as it does for a final answer (verification, self-review and Preview still run).
     */
    "code.finish": async (input) => {
      const summary = stringArg(input.args, "summary");
      if (!summary) throw new CodeToolError("invalid_arguments", "code.finish requires a summary", 400, "validate_arguments", true, input.tool.name);
      const status = stringArg(input.args, "status") ?? "completed";
      return { finished: true, status, summaryChars: summary.length };
    },
  };

  if (options.readWorkspaceFile) {
    const readWorkspaceFile = options.readWorkspaceFile;
    executors["code.image.view"] = async (input) => {
      const path = normalizeWorkspacePath(input.args.path, { tool: input.tool.name, allowEmpty: false });
      if (isSensitivePath(path)) throw new CodeToolError("sensitive_file_denied", `"${path}" is a protected path`, 403, "execute", false, input.tool.name);
      const file = await readWorkspaceFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path });
      const bytes = file.contentBase64 ? Buffer.from(file.contentBase64, "base64") : Buffer.alloc(0);
      const mimeType = detectToolImageType(bytes);
      if (!file.binary || !mimeType) throw new CodeToolError("image_unsupported_type", `"${path}" is not a PNG, JPEG, WebP or GIF image; use code.fs.read for text`, 415, "execute", false, input.tool.name);
      if (bytes.length > MAX_TOOL_IMAGE_BYTES) throw new CodeToolError("file_too_large", `"${path}" exceeds ${MAX_TOOL_IMAGE_BYTES} bytes`, 413, "execute", false, input.tool.name);
      const question = stringArg(input.args, "question");
      return {
        path, mimeType, bytes: bytes.length,
        [CODE_IMAGE_ATTACHMENT_KEY]: { mimeType, dataBase64: bytes.toString("base64"), source: path, ...(question ? { question } : {}) } satisfies CodeToolImageAttachment,
      };
    };
  }

  if (options.previewScreenshot) {
    const previewScreenshot = options.previewScreenshot;
    executors["code.preview.screenshot"] = async (input) => {
      const path = stringArg(input.args, "path") ?? "/";
      if (!/^\/(?!\/)[A-Za-z0-9/_~.%-]{0,511}$/.test(path) || path.includes("..")) {
        throw new CodeToolError("invalid_arguments", "path must be a local preview path such as /about", 400, "validate_arguments", true, input.tool.name);
      }
      const viewport = (["desktop", "tablet", "mobile"] as const).find((value) => value === input.args.viewport) ?? "desktop";
      const shot = await previewScreenshot({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path, viewport, ...(input.runId ? { runId: input.runId } : {}) });
      const bytes = Buffer.from(shot.base64Data, "base64");
      const mimeType = detectToolImageType(bytes);
      if (!mimeType) throw new CodeToolError("visual_screenshot_unavailable", "The preview runner returned no usable image", 503, "execute", true, input.tool.name);
      const question = stringArg(input.args, "question");
      return {
        path, viewport, mimeType, bytes: bytes.length,
        ...(shot.statusCode !== undefined ? { statusCode: shot.statusCode } : {}),
        ...(shot.issues !== undefined ? { issues: shot.issues } : {}),
        [CODE_IMAGE_ATTACHMENT_KEY]: { mimeType, dataBase64: shot.base64Data, source: `preview:${path}@${viewport}`, ...(question ? { question } : {}) } satisfies CodeToolImageAttachment,
      };
    };
  }

  if (options.webResearch) {
    const web = options.webResearch;
    executors["code.web.search"] = async (input) => {
      const query = stringArg(input.args, "query");
      if (!query || query.length > 300) throw new CodeToolError("invalid_arguments", "query must be 2-300 characters", 400, "validate_arguments", true, input.tool.name);
      const maxResults = typeof input.args.maxResults === "number" ? Math.min(8, Math.max(1, Math.floor(input.args.maxResults))) : 5;
      const results = await web.search({ query, maxResults });
      return {
        query,
        results: results.slice(0, maxResults).map((result) => ({ title: result.title ?? "", url: result.url, snippet: (result.snippet ?? "").slice(0, 500) })),
      };
    };
    executors["code.web.fetch"] = async (input) => {
      const url = stringArg(input.args, "url");
      if (!url || !/^https?:\/\//i.test(url)) throw new CodeToolError("invalid_arguments", "url must be an http(s) URL", 400, "validate_arguments", true, input.tool.name);
      const maxChars = typeof input.args.maxChars === "number" ? Math.min(40_000, Math.max(1_000, Math.floor(input.args.maxChars))) : 20_000;
      const page = await web.fetch({ url });
      const text = page.markdown ?? page.content ?? page.text ?? "";
      return {
        url, finalUrl: page.finalUrl ?? page.url ?? url, title: page.title ?? "",
        content: text.slice(0, maxChars), contentChars: text.length, truncated: text.length > maxChars,
        ...(page.fetchedAt ? { fetchedAt: page.fetchedAt } : {}), ...(page.provider ? { provider: page.provider } : {}),
      };
    };
  }

  return executors;
}
