import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { AuthContext, Company } from "@npati/workspace";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { BrowserSecurityGuard } from "./browser-security-guard";

export const BROWSER_TOOL_IDS = new Set([
  "browser.browser_tab_control", "browser.browser_clicktype", "browser.browser_screenshots", "browser.browser_downloads",
]);

export interface BrowserActionTrace {
  action: string;
  status: "succeeded" | "failed" | "waiting_email" | "paused";
  url?: string;
  detail?: string;
  timestamp: string;
}

export interface BrowserToolResult {
  jobId: string;
  status: "completed" | "failed" | "waiting_email" | "paused";
  result?: unknown;
  artifacts?: Array<{ id: string; kind: string; path?: string }>;
  trace: BrowserActionTrace[];
  _npatiBrowserTrace: true;
}

const actionsForTool: Record<string, ReadonlySet<string>> = {
  "browser.browser_tab_control": new Set(["navigate", "extract", "pause", "resume"]),
  "browser.browser_clicktype": new Set(["fill_form", "register_account", "task"]),
  "browser.browser_screenshots": new Set(["screenshot"]),
  "browser.browser_downloads": new Set(["upload"]),
};

function requiredText(value: unknown, name: string, max = 20_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim().slice(0, max);
}

function containsInlineSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsInlineSecret);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    /password|passphrase|secret|access.?token|refresh.?token|api.?key/i.test(key)
      ? typeof item === "string" && item.length > 0
      : containsInlineSecret(item));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class BrowserUseClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly credentials?: BrowserCredentialsRepository,
    private readonly uploadRoot = process.env.NPATI_BROWSER_UPLOAD_ROOT || "/app/data/browser-uploads",
    private readonly files?: { open(context: AuthContext, fileId: string): Promise<{ file: { originalFilename: string; sizeBytes: number }; stream: NodeJS.ReadableStream } | null> },
  ) {
    if (internalToken.length < 32) throw new Error("NPATI_BROWSER_INTERNAL_TOKEN must contain at least 32 characters");
  }

  private scope(kind: string, value: string) {
    return createHmac("sha256", this.internalToken).update(`${kind}:${value}`).digest("hex");
  }

  async downloadArtifact(ctx: AuthContext, company: Company, artifactId: string, signal?: AbortSignal) {
    if (!/^[0-9a-f-]{36}$/i.test(artifactId)) throw Object.assign(new Error("Browser artifact was not found"), { status: 404 });
    if (company.workspaceId !== ctx.workspaceId || company.userId !== ctx.userId) throw new Error("Browser tenant access denied");
    const tenantScope = this.scope("tenant", `${ctx.workspaceId}:${company.id}:${ctx.userId}`);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/artifacts/${artifactId}`, {
      signal,
      headers: { authorization: `Bearer ${this.internalToken}`, "x-tenant-scope": tenantScope },
    });
    if (!response.ok) throw Object.assign(new Error("Browser artifact was not found"), { status: response.status });
    return { contentType: response.headers.get("content-type") || "image/png", data: Buffer.from(await response.arrayBuffer()) };
  }

  async execute(ctx: AuthContext, company: Company, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<BrowserToolResult> {
    const supportedActions = actionsForTool[tool];
    if (!supportedActions) throw new Error(`Unsupported Browser Tool capability: ${tool}`);
    const defaults: Record<string, string> = {
      "browser.browser_tab_control": "navigate", "browser.browser_clicktype": "fill_form",
      "browser.browser_screenshots": "screenshot", "browser.browser_downloads": "upload",
    };
    const action = typeof input.operation === "string" ? input.operation.trim().toLowerCase() : defaults[tool]!;
    if (!supportedActions.has(action)) throw new Error(`Action "${action}" is not permitted by capability "${tool}"`);
    if (company.workspaceId !== ctx.workspaceId || company.userId !== ctx.userId) throw new Error("Browser tenant access denied");

    const url = typeof input.url === "string" ? input.url.trim() : undefined;
    if (url) {
      const validated = BrowserSecurityGuard.validateUrl(url);
      if (!validated.allowed) throw Object.assign(new Error(validated.reason || "Browser URL is not allowed"), { code: "BROWSER_URL_BLOCKED" });
      input = { ...input, url: validated.normalizedUrl };
    }

    const secrets: Record<string, string> = {};
    const refs = Array.isArray(input.credentialRefs) ? input.credentialRefs : [];
    if (refs.length) {
      if (!this.credentials) throw new Error("Browser credential vault is unavailable");
      for (const raw of refs.slice(0, 10)) {
        const ref = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const id = requiredText(ref.id, "credentialRefs[].id", 100);
        const alias = requiredText(ref.alias ?? `credential_${Object.keys(secrets).length + 1}`, "credentialRefs[].alias", 64)
          .replace(/[^a-zA-Z0-9_.-]/g, "_");
        const fields = await this.credentials.resolve(ctx, company.id, id);
        for (const [field, value] of Object.entries(fields)) secrets[`${alias}.${field}`] = value;
      }
    }

    const sanitizedInput = { ...input };
    delete sanitizedInput.credentialRefs;
    const idempotencyInput = { ...sanitizedInput };
    if ((action === "task" || action === "register_account") && containsInlineSecret(sanitizedInput)) {
      throw new Error("Raw credentials are forbidden in autonomous browser input; store them in the Company browser vault and use credentialRefs aliases");
    }
    const temporaryUploads: string[] = [];
    if (action === "upload" || action === "task" || action === "register_account") {
      const files = Array.isArray(input.files) ? input.files.map(String).slice(0, 20) : [];
      if (files.length) {
        if (!this.files) throw new Error("Company file storage is unavailable for browser uploads");
        const linkedIds = new Set(company.knowledge.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const id = value.attachmentId ?? value.id;
          return typeof id === "string" ? [id] : [];
        }));
        sanitizedInput.files = [];
        for (const fileId of files) {
          if (!/^[0-9a-f-]{36}$/i.test(fileId) || !linkedIds.has(fileId)) throw new Error("Browser uploads must reference a file linked to this Company");
          const opened = await this.files.open(ctx, fileId);
          if (!opened) throw new Error(`Company upload file ${fileId} is unavailable`);
          if (opened.file.sizeBytes > 100 * 1024 * 1024) throw new Error("Browser upload file exceeds the 100 MB limit");
          const quarantine = BrowserSecurityGuard.validateDownload(opened.file.originalFilename);
          if (quarantine.quarantined) throw new Error(quarantine.reason || "Browser upload file type is blocked");
          const safeName = path.basename(opened.file.originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
          const destination = path.resolve(this.uploadRoot, this.scope("upload", `${ctx.workspaceId}:${company.id}`), `${randomUUID()}-${fileId}-${safeName}`);
          const root = path.resolve(this.uploadRoot) + path.sep;
          if (!destination.startsWith(root)) throw new Error("Browser upload path is outside the approved upload directory");
          await mkdir(path.dirname(destination), { recursive: true });
          await pipeline(opened.stream as any, (await import("node:fs")).createWriteStream(destination, { flags: "wx" })).catch(async (error: any) => {
            if (error?.code !== "EEXIST") throw error;
          });
          (sanitizedInput.files as string[]).push(destination);
          temporaryUploads.push(destination);
        }
      }
    }
    const tenantScope = this.scope("tenant", `${ctx.workspaceId}:${company.id}:${ctx.userId}`);
    const profileId = typeof input.profileId === "string" && input.profileId.trim() ? input.profileId.trim() : "default";
    const runId = typeof input.__npatiTaskRunId === "string" ? input.__npatiTaskRunId : undefined;
    const requestId = runId ? createHash("sha256").update(`${runId}:${tool}:${stableJson(idempotencyInput)}`).digest("hex") : undefined;
    const body = {
      request_id: requestId,
      tenant_scope: tenantScope,
      profile_scope: this.scope("profile", `${tenantScope}:${profileId}`),
      action,
      input: sanitizedInput,
      secrets,
    };
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/execute`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify(body),
      });
    } finally {
      await Promise.all(temporaryUploads.map((file) => unlink(file).catch(() => undefined)));
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw Object.assign(new Error(String((payload.error as any)?.message ?? payload.detail ?? `Browser Use Worker returned ${response.status}`)), { status: response.status, code: (payload.error as any)?.code ?? "BROWSER_WORKER_FAILED" });
    if (payload.status === "waiting_email" && this.credentials && typeof payload.jobId === "string" && typeof input.__npatiTaskRunId === "string") {
      await this.credentials.registerEmailWait(ctx, company.id, {
        jobId: payload.jobId,
        runId: input.__npatiTaskRunId,
        profileId,
        senderHint: typeof input.emailHint === "string" ? input.emailHint : undefined,
      });
    }
    return { ...(payload as Omit<BrowserToolResult, "_npatiBrowserTrace">), _npatiBrowserTrace: true };
  }
}
