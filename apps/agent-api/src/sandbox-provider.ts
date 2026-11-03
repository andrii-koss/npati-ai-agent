import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHmac, randomUUID } from "node:crypto";

/** Frozen decision: docs/website-builder/SHARED_PROJECT_RUNTIME.md. Transport locality
 * and execution architecture are separate; shared must never fall back to Docker. */
export type ProjectRuntimeMode = "shared" | "isolated";
export function projectRuntimeMode(env: Record<string, string | undefined> = process.env): ProjectRuntimeMode {
  const configured = env.NPATI_PROJECT_RUNTIME_MODE;
  if (configured && configured !== "shared" && configured !== "isolated") throw new Error("Invalid NPATI_PROJECT_RUNTIME_MODE");
  // Account registration type does not override the explicitly selected execution architecture.
  if (configured === "shared" || configured === "isolated") return configured;
  if (env.NPATI_DEPLOYMENT_TYPE === "npati_hosted") return "isolated";
  return env.NPATI_DEPLOYMENT_TYPE === "self_hosted" || env.NPATI_SANDBOX_RUNNER_MODE === "local" ? "shared" : "isolated";
}
export function assertProjectRuntimeProvider(kind: ProjectRuntimeMode, env: Record<string, string | undefined> = process.env): void {
  if (projectRuntimeMode(env) !== kind) throw new SandboxProviderError("runtime_architecture_violation", `Configured ${projectRuntimeMode(env)} runtime cannot use ${kind} provider`, 503, "provider_selection");
}

export type SandboxState = "created" | "running" | "stopped" | "failed" | "destroyed";
export interface SandboxScope { workspaceId: string; userId: string; companyId: string; projectId: string; }
export interface SandboxStatus { id: string; state: SandboxState; createdAt: string; lastActivityAt: string; }
export interface SandboxFile { path: string; content: string; revision?: string; encoding?: "base64"; }
export interface SandboxBrowserQaResult {
  interactionTrace?: import("../browser-qa-actions.mjs").BrowserQaInteraction[];
  statusCode: number; loadTimeMs: number; domContentLoadedMs: number; resourceCount: number; totalSizeBytes: number;
  consoleDiagnostics?: import("../browser-qa-diagnostics.mjs").BrowserDiagnostic[];
  consoleErrorCount: number; brokenLinks: Array<{ href: string; status?: number; error?: string }>;
  accessibility: Array<{ rule: string; impact: string; selector?: string }>;
  screenshot?: { mimeType: "image/png"; base64Data: string; sizeBytes: number; redacted: true; captureMode?: "layout" | "visual" };
}
export interface SandboxBrowserQaOptions {
  actions?: import("../browser-qa-actions.mjs").BrowserQaAction[];
  port: number; path: string; viewport: { width: number; height: number }; timeoutMs: number;
  maxScreenshotBytes: number; maxBrokenLinks: number; screenshot: boolean; screenshotMode?: "layout" | "visual";
}
export interface SandboxCommandResult {
  status: "running" | "stopped" | "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  step: string;
  tool: string;
  retryable: boolean;
  processId?: string;
}
export interface SandboxCommandOptions { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string>; cwd?: string; processId?: string; }
/**
 * C15: a bind mount of one **mounted local project folder** into a container.
 *
 * It is the only shape of host mount this product has, and every field is constrained: `target` may only be
 * `/workspace` (the container's workspace is the workspace — a caller-chosen target would be an arbitrary host
 * mount), and `source` is not trusted by the component that creates the container. The sandbox runner re-reads
 * the allowlist from the database itself and re-validates the path (realpath + `lstat` on every component)
 * immediately before `docker create`, so a path that became a symlink after the confirmation, or a path a
 * client simply invented, never reaches a container.
 */
export interface SandboxMount { source: string; target: string; readOnly: boolean; }
export interface SandboxCreateOptions { runtime?: string; mount?: SandboxMount; }
/** The only container path a mounted folder may be exposed at. */
export const SANDBOX_MOUNT_TARGET = "/workspace";

/**
 * Validates the shape of a mount request at the client boundary. It is a *shape* check on purpose: whether the
 * path is allowed is decided by the runner against the allowlist it reads itself, because a check that only
 * happens in the caller is not a check on the caller.
 */
export function sandboxMountRequest(value: unknown): SandboxMount | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new SandboxProviderError("invalid_mount", "A sandbox mount must be an object", 400);
  const candidate = value as { source?: unknown; target?: unknown; readOnly?: unknown };
  if (typeof candidate.source !== "string" || !candidate.source) throw new SandboxProviderError("invalid_mount", "A sandbox mount needs a source", 400);
  if (candidate.source.length > 1024 || candidate.source.includes("\0")) throw new SandboxProviderError("invalid_mount", "Invalid sandbox mount source", 400);
  if (candidate.target !== SANDBOX_MOUNT_TARGET) throw new SandboxProviderError("mount_target_denied", `A mounted folder may only be exposed at ${SANDBOX_MOUNT_TARGET}`, 400);
  if (typeof candidate.readOnly !== "boolean") throw new SandboxProviderError("invalid_mount", "A sandbox mount must state readOnly", 400);
  return { source: candidate.source, target: SANDBOX_MOUNT_TARGET, readOnly: candidate.readOnly };
}
/**
 * Variables a background sandbox process (for example the Live Preview dev server) may receive.
 * Secret references stay unavailable to background processes; only the public Project API
 * client configuration is allowed, because generated sites need it at runtime.
 */
export const SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST = ["PROJECT_API_URL", "PROJECT_PUBLISHABLE_KEY"] as const;
/** Validates background process environment: allowlisted public variables only, never secrets. */
export function sandboxProcessEnvironment(environment: Record<string, string> | undefined): Array<[string, string]> {
  const entries = Object.entries(environment ?? {});
  for (const [key, value] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== "string" || value.length > 4096) throw new SandboxProviderError("invalid_environment", "Invalid environment variable", 400);
    if (!(SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST as readonly string[]).includes(key)) throw new SandboxProviderError("process_secrets_unsupported", "Background processes may only receive Project API client variables", 400);
  }
  return entries;
}
export interface SandboxProvider {
  readonly executionMode?: ProjectRuntimeMode;
  processCapabilities?(scope: SandboxScope): Promise<{ durableIdentity: boolean; terminalStatus: boolean }>;
  proxyPreview?(scope: SandboxScope, sandboxId: string, options: PreviewProxyRequest): Promise<PreviewProxyResponse>;
  inspectBrowser?(scope: SandboxScope, sandboxId: string, options: SandboxBrowserQaOptions): Promise<SandboxBrowserQaResult>;
  createSandbox(scope: SandboxScope, options?: SandboxCreateOptions): Promise<SandboxStatus>;
  startSandbox(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  stopSandbox(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  destroySandbox(scope: SandboxScope, sandboxId: string): Promise<void>;
  executeCommand(scope: SandboxScope, sandboxId: string, command: string, options: SandboxCommandOptions): Promise<SandboxCommandResult>;
  uploadFiles(scope: SandboxScope, sandboxId: string, files: SandboxFile[]): Promise<void>;
  downloadFiles(scope: SandboxScope, sandboxId: string): Promise<SandboxFile[]>;
  exposePort(scope: SandboxScope, sandboxId: string, port: number): Promise<{ port: number; internalHost: string }>;
  getLogs(scope: SandboxScope, sandboxId: string, processId?: string): Promise<string>;
  getStatus(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  startProcess(scope: SandboxScope, sandboxId: string, command: string, options: SandboxCommandOptions): Promise<SandboxCommandResult>;
  stopProcess(scope: SandboxScope, sandboxId: string, processId: string): Promise<SandboxCommandResult>;
  getProcessStatus(scope: SandboxScope, sandboxId: string, processId: string): Promise<SandboxCommandResult>;
  getProcessOutput?(scope: SandboxScope, sandboxId: string, processId: string): Promise<{ output: string; earliestOffset: number; nextOffset: number }>;
}
export interface PreviewProxyRequest { port: number; path: string; method: string; headers: Record<string, string>; body?: string; }
export interface PreviewProxyResponse { status: number; headers: Record<string, string>; body: string; }
/**
 * Global fetch gives up after 300 s without response headers, so a long command looked like a dead runner.
 * Every runner call already carries its own AbortSignal deadline.
 */
const runnerFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const url = new URL(String(input));
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const call = send(url, { method: init?.method, headers: init?.headers as Record<string, string>, ...(init?.signal ? { signal: init.signal } : {}) }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", reject);
    response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })));
  });
  call.on("error", reject);
  call.end(init?.body as string | undefined);
});

export class SandboxProviderError extends Error {
  diagnostics?: { dockerAction?: string; dockerStderr?: string; image?: string; container?: string; network?: string; sandboxId?: string };
  constructor(public readonly code: string, message: string, public readonly status = 503, public readonly step = "sandbox", public readonly tool = "project.terminal.exec", public readonly retryable = false, public readonly currentRevision?: string) { super(message); }
}
export class RemoteSandboxProvider implements SandboxProvider {
  get executionMode(): ProjectRuntimeMode { return this.runtimeMode ?? projectRuntimeMode(); }
  processCapabilities(scope: SandboxScope) { return this.request<{ durableIdentity: boolean; terminalStatus: boolean }>("processCapabilities", { scope }); }
  private readonly endpoint: URL;
  constructor(url: string, private readonly secret: string, private readonly transport: typeof fetch = runnerFetch, private readonly mode: "local" | "remote" = (process.env.NPATI_SANDBOX_RUNNER_MODE === "local" ? "local" : "remote"), private readonly runtimeMode?: ProjectRuntimeMode) {
    if (process.env.NPATI_SANDBOX_RUNNER_MODE && !["local", "remote"].includes(process.env.NPATI_SANDBOX_RUNNER_MODE)) throw new Error("Invalid sandbox runner mode");
    this.endpoint = new URL(url);
    const loopback = ["127.0.0.1", "localhost"].includes(this.endpoint.hostname);
    const localDocker = mode === "local" && this.endpoint.protocol === "http:" && this.endpoint.hostname === "sandbox-runner" && !this.endpoint.username && !this.endpoint.password && !this.endpoint.search && !this.endpoint.hash && (this.endpoint.port === "7865" || !this.endpoint.port);
    if (this.endpoint.protocol !== "https:" && !localDocker && !(process.env.NODE_ENV !== "production" && this.endpoint.protocol === "http:" && loopback)) throw new Error("Sandbox runner URL must use HTTPS");
    if (mode === "local" && !localDocker) throw new Error("Local sandbox runner must use http://sandbox-runner:7865");
    if (process.env.NODE_ENV === "production" && loopback) throw new Error("Production sandbox runner must be on a separate host");
    if (!secret || secret.length < 32) throw new Error("Sandbox runner secret must be at least 32 characters");
  }
  private async assertBackend(): Promise<void> {
    const expected = this.runtimeMode ?? (process.env.NPATI_PROJECT_RUNTIME_MODE || process.env.NPATI_DEPLOYMENT_TYPE || process.env.NPATI_SANDBOX_RUNNER_MODE === "local" ? projectRuntimeMode() : undefined);
    if (expected) {
      try {
        // Authenticated readiness proves which implementation is behind the runner URL.
        // Check every admission; an API reconnect must not silently reach a replaced isolated runner.
        const body = JSON.stringify({});
        const timestamp = String(Date.now()), nonce = randomUUID();
        const signature = createHmac("sha256", this.secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
        const response = await this.transport(new URL("/v1/readiness", this.endpoint), {
          method: "POST", headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature },
          body, signal: AbortSignal.timeout(5000),
        });
        const report = await response.json() as { overall_ready?: boolean; details?: { runtimeMode?: string } };
        if (!response.ok || report.overall_ready !== true || report.details?.runtimeMode !== expected) {
          throw new SandboxProviderError("runtime_architecture_violation", `Configured ${expected} runtime requires its matching ready provider; provider fallback is prohibited`, 503, "provider_selection");
        }
      } catch (error) {
        if (error instanceof SandboxProviderError) throw error;
        throw new SandboxProviderError("runner_unavailable", `Configured ${expected} runtime readiness could not be established; provider fallback is prohibited`, 503, "provider_selection", "project.terminal.exec", true);
      }
    }
  }
  private async request<T>(operation: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    await this.assertBackend();
    const body = JSON.stringify({ operation, payload });
    const runnerEndpoint = new URL("/v1/sandbox", this.endpoint).origin + "/v1/sandbox";
    const requestScope = payload.scope as SandboxScope | undefined;
    const identifiers = { operation, endpoint: runnerEndpoint, projectId: requestScope?.projectId ?? null, sandboxId: typeof payload.sandboxId === "string" ? payload.sandboxId : null };
    const timestamp = String(Date.now()), nonce = randomUUID();
    const signature = createHmac("sha256", this.secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
    let response: Response;
    try {
      response = await this.transport(new URL("/v1/sandbox", this.endpoint), {
        method: "POST", headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const causeCode = error && typeof error === "object" && "code" in error ? String(error.code) : "network_error";
      console.error("[sandbox-runner-client] " + JSON.stringify({ ...identifiers, httpStatus: null, errorCode: "runner_unavailable", causeCode }));
      throw new SandboxProviderError("runner_unavailable", `Sandbox runner is unavailable during ${operation}`, 503, operation, "project.terminal.exec", true);
    }
    const data = await response.json().catch(() => ({})) as { result?: T; error?: { code?: string; message?: string; status?: number; retryable?: boolean } };
    if (!response.ok) {
      console.error("[sandbox-runner-client] " + JSON.stringify({ ...identifiers, httpStatus: response.status, errorCode: data.error?.code ?? "runner_error" }));
      throw new SandboxProviderError(data.error?.code ?? "runner_error", data.error?.message ?? `Sandbox runner ${operation} failed (HTTP ${response.status})`, response.status, operation, "project.terminal.exec", data.error?.retryable ?? false);
    }
    return data.result as T;
  }
  /**
   * C15: the mount travels in the payload and is **re-validated by the runner** against the allowlist it reads
   * from the database itself. The client-side shape check here exists so a malformed request is refused before
   * a socket is opened, not so that the runner can trust the value.
   *
   * A mount is also refused outright unless this client is in `local` mode: the confirmed path names a directory
   * on the runner's host, and a remote runner is on another machine where that path means something else (or
   * nothing). The runner enforces the same rule, so the two layers cannot disagree about which mode may mount.
   */
  async createSandbox(scope: SandboxScope, options: SandboxCreateOptions = {}): Promise<SandboxStatus> {
    const mount = sandboxMountRequest(options.mount);
    if (mount && this.mode !== "local") {
      throw new SandboxProviderError("mounted_folder_requires_local_runner", "A mounted local folder is only available on a local sandbox runner", 403, "createSandbox");
    }
    return this.request<SandboxStatus>("createSandbox", { scope, options: { runtime: options.runtime, ...(mount ? { mount } : {}) } });
  }
  startSandbox(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("startSandbox", { scope, sandboxId }); }
  stopSandbox(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("stopSandbox", { scope, sandboxId }); }
  destroySandbox(scope: SandboxScope, sandboxId: string) { return this.request<void>("destroySandbox", { scope, sandboxId }); }
  executeCommand(scope: SandboxScope, sandboxId: string, command: string, options: SandboxCommandOptions) { return this.request<SandboxCommandResult>("executeCommand", { scope, sandboxId, command, options }, options.timeoutMs + 15_000); }
  uploadFiles(scope: SandboxScope, sandboxId: string, files: SandboxFile[]) { return this.request<void>("uploadFiles", { scope, sandboxId, files }, 605_000); }
  downloadFiles(scope: SandboxScope, sandboxId: string) { return this.request<SandboxFile[]>("downloadFiles", { scope, sandboxId }, 605_000); }
  exposePort(scope: SandboxScope, sandboxId: string, port: number) { return this.request<{ port: number; internalHost: string }>("exposePort", { scope, sandboxId, port }); }
  getLogs(scope: SandboxScope, sandboxId: string, processId?: string) { return this.request<string>("getLogs", { scope, sandboxId, processId }); }
  getStatus(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("getStatus", { scope, sandboxId }); }
  startProcess(scope: SandboxScope, sandboxId: string, command: string, options: SandboxCommandOptions) { return this.request<SandboxCommandResult>("startProcess", { scope, sandboxId, command, options }, options.timeoutMs + 15_000); }
  stopProcess(scope: SandboxScope, sandboxId: string, processId: string) { return this.request<SandboxCommandResult>("stopProcess", { scope, sandboxId, processId }); }
  getProcessStatus(scope: SandboxScope, sandboxId: string, processId: string) { return this.request<SandboxCommandResult>("getProcessStatus", { scope, sandboxId, processId }); }
  getProcessOutput(scope: SandboxScope, sandboxId: string, processId: string) { return this.request<{ output: string; earliestOffset: number; nextOffset: number }>("getProcessOutput", { scope, sandboxId, processId }); }
  inspectBrowser(scope: SandboxScope, sandboxId: string, options: SandboxBrowserQaOptions) { return this.request<SandboxBrowserQaResult>("inspectBrowser", { scope, sandboxId, options }, Math.min(60_000, options.timeoutMs) + 15_000); }
  proxyPreview(scope: SandboxScope, sandboxId: string, options: PreviewProxyRequest) { return this.request<PreviewProxyResponse>("proxyPreview", { scope, sandboxId, options }, 30_000); }
}
