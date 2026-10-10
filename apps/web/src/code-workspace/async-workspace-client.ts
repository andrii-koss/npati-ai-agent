import { getStoredAuthToken } from "../AuthContext";
export type AsyncScope = { companyId: string; projectId: string; sessionId: string };
export type AsyncOperation = { operationId: string; processId: string; runId: string; generation: number;
  kind: "process" | "subagent"; state: string; exitCode: number | null; cancelRequested: boolean;
  collected: boolean; delivered: boolean; childRunId?: string; childSessionId?: string; agentType?: string; stopRequested?: boolean };
export type AsyncWorkspaceSnapshot = AsyncScope & { schemaVersion: 1; capabilities: { inbox: boolean; controls: boolean; resume: boolean; processes: boolean }; operations: AsyncOperation[] };
export const sessionPath = (scope: AsyncScope) => `/api/companies/${encodeURIComponent(scope.companyId)}/code/sessions/${encodeURIComponent(scope.sessionId)}`;
export async function asyncRequest<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const token = getStoredAuthToken();
  const response = await fetch(path, { signal, method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) window.dispatchEvent(new Event("npati:unauthorized"));
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error?.code ?? `HTTP ${response.status}`), { code: value.error?.code, status: response.status });
  return value;
}
export async function readAsyncWorkspace(scope: AsyncScope, signal: AbortSignal) {
  const path = `/api/companies/${encodeURIComponent(scope.companyId)}/projects/${encodeURIComponent(scope.projectId)}/code/sessions/${encodeURIComponent(scope.sessionId)}/async-workspace`;
  const value = await asyncRequest<AsyncWorkspaceSnapshot>(path, signal);
  if (value.schemaVersion !== 1 || value.companyId !== scope.companyId || value.projectId !== scope.projectId || value.sessionId !== scope.sessionId) throw new Error("async_workspace_scope_mismatch");
  return value;
}

/** One observer at a time; disposal fences late replies even if the transport ignores abort. */
export function createAsyncObserver<T>(read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void) {
  const controller = new AbortController(); let busy = false;
  return { async refresh() {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try { const value = await read(controller.signal); if (!controller.signal.aborted) apply(value); }
    catch (error) { if (!controller.signal.aborted) fail(error); }
    finally { busy = false; }
  }, close() { controller.abort(); } };
}

/** Failed control requests retain their identity; a retry cannot mint another continuation. */
export class AsyncControlSubmission {
  private pending?: { key: string; requestId: string }; private busy = false;
  begin(key: string) {
    if (this.busy) return null;
    if (this.pending?.key !== key) this.pending = { key, requestId: crypto.randomUUID() };
    this.busy = true; return this.pending.requestId;
  }
  finish(accepted: boolean) { this.busy = false; if (accepted) this.pending = undefined; }
}
