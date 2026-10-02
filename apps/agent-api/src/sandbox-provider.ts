import { createHmac, randomUUID } from "node:crypto";

export type SandboxState = "created" | "running" | "stopped" | "failed" | "destroyed";
export interface SandboxScope { workspaceId: string; userId: string; companyId: string; projectId: string; }
export interface SandboxStatus { id: string; state: SandboxState; createdAt: string; lastActivityAt: string; }
export interface SandboxFile { path: string; content: string; revision?: string; }
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
export interface SandboxProvider {
  createSandbox(scope: SandboxScope, options?: { runtime?: string }): Promise<SandboxStatus>;
  startSandbox(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  stopSandbox(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  destroySandbox(scope: SandboxScope, sandboxId: string): Promise<void>;
  executeCommand(scope: SandboxScope, sandboxId: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }): Promise<SandboxCommandResult>;
  uploadFiles(scope: SandboxScope, sandboxId: string, files: SandboxFile[]): Promise<void>;
  downloadFiles(scope: SandboxScope, sandboxId: string): Promise<SandboxFile[]>;
  exposePort(scope: SandboxScope, sandboxId: string, port: number): Promise<{ port: number; internalHost: string }>;
  getLogs(scope: SandboxScope, sandboxId: string, processId?: string): Promise<string>;
  getStatus(scope: SandboxScope, sandboxId: string): Promise<SandboxStatus>;
  startProcess(scope: SandboxScope, sandboxId: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }): Promise<SandboxCommandResult>;
  stopProcess(scope: SandboxScope, sandboxId: string, processId: string): Promise<SandboxCommandResult>;
  getProcessStatus(scope: SandboxScope, sandboxId: string, processId: string): Promise<SandboxCommandResult>;
}
export class SandboxProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503, public readonly step = "sandbox", public readonly tool = "project.terminal.exec", public readonly retryable = false, public readonly currentRevision?: string) { super(message); }
}
export class RemoteSandboxProvider implements SandboxProvider {
  private readonly endpoint: URL;
  constructor(url: string, private readonly secret: string, private readonly transport: typeof fetch = fetch) {
    this.endpoint = new URL(url);
    const loopback = ["127.0.0.1", "localhost"].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && this.endpoint.protocol === "http:" && loopback)) throw new Error("Sandbox runner URL must use HTTPS");
    if (process.env.NODE_ENV === "production" && loopback) throw new Error("Production sandbox runner must be on a separate host");
    if (!secret || secret.length < 32) throw new Error("Sandbox runner secret must be at least 32 characters");
  }
  private async request<T>(operation: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const body = JSON.stringify({ operation, payload });
    const timestamp = String(Date.now()), nonce = randomUUID();
    const signature = createHmac("sha256", this.secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
    let response: Response;
    try {
      response = await this.transport(new URL("/v1/sandbox", this.endpoint), {
        method: "POST", headers: { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SandboxProviderError("runner_unavailable", "Sandbox runner is unavailable", 503, operation, "project.terminal.exec", true);
    }
    const data = await response.json().catch(() => ({})) as { result?: T; error?: { code?: string; message?: string; status?: number; retryable?: boolean } };
    if (!response.ok) throw new SandboxProviderError(data.error?.code ?? "runner_error", data.error?.message ?? "Sandbox runner failed", response.status, operation, "project.terminal.exec", data.error?.retryable ?? false);
    return data.result as T;
  }
  createSandbox(scope: SandboxScope, options: { runtime?: string } = {}) { return this.request<SandboxStatus>("createSandbox", { scope, options }); }
  startSandbox(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("startSandbox", { scope, sandboxId }); }
  stopSandbox(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("stopSandbox", { scope, sandboxId }); }
  destroySandbox(scope: SandboxScope, sandboxId: string) { return this.request<void>("destroySandbox", { scope, sandboxId }); }
  executeCommand(scope: SandboxScope, sandboxId: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }) { return this.request<SandboxCommandResult>("executeCommand", { scope, sandboxId, command, options }, options.timeoutMs + 15_000); }
  uploadFiles(scope: SandboxScope, sandboxId: string, files: SandboxFile[]) { return this.request<void>("uploadFiles", { scope, sandboxId, files }, 120_000); }
  downloadFiles(scope: SandboxScope, sandboxId: string) { return this.request<SandboxFile[]>("downloadFiles", { scope, sandboxId }, 120_000); }
  exposePort(scope: SandboxScope, sandboxId: string, port: number) { return this.request<{ port: number; internalHost: string }>("exposePort", { scope, sandboxId, port }); }
  getLogs(scope: SandboxScope, sandboxId: string, processId?: string) { return this.request<string>("getLogs", { scope, sandboxId, processId }); }
  getStatus(scope: SandboxScope, sandboxId: string) { return this.request<SandboxStatus>("getStatus", { scope, sandboxId }); }
  startProcess(scope: SandboxScope, sandboxId: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }) { return this.request<SandboxCommandResult>("startProcess", { scope, sandboxId, command, options }, options.timeoutMs + 15_000); }
  stopProcess(scope: SandboxScope, sandboxId: string, processId: string) { return this.request<SandboxCommandResult>("stopProcess", { scope, sandboxId, processId }); }
  getProcessStatus(scope: SandboxScope, sandboxId: string, processId: string) { return this.request<SandboxCommandResult>("getProcessStatus", { scope, sandboxId, processId }); }
}
