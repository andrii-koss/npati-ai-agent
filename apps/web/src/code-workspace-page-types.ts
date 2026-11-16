import { canonicalSessionMode } from "./code-workspace/actions";
import { getStoredAuthToken } from "./AuthContext";

export type FileEntry = {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  children?: FileEntry[];
};

export type RunEvent = {
  id?: string;
  kind?: string;
  snapshotId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
};

export type ActivityResponse = { events?: RunEvent[]; nextCursor?: string | null };

export type Change = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
};

export type ChangesResponse = {
  files?: Change[];
  changes?: Change[];
  diffStats?: { filesChanged?: number; additions?: number; deletions?: number };
};

export type UsageResponse = {
  /** The route answers in an envelope: `status`/`reason` describe the answer, `usage` carries the numbers. */
  status?: string;
  reason?: string;
  usage?: {
    tokens?: { input: number | null; output: number | null; total: number };
    totalTokens?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    /** `true` means the numbers come from the runner's summary, not from provider metering. */
    estimated?: boolean;
    costUsd?: number | null;
    costStatus?: string;
    source?: string;
  } | null;
};

export type PreviewStatus = { status?: string; url?: string; port?: number; message?: string };

export type PendingApproval = {
  id: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  diff?: string;
  reason?: string;
  requestedBy?: string;
  createdAt?: string;
};

export type ApprovalScope = "once" | "session" | "project";

export type BottomTab = "changes" | "terminal" | "logs" | "activity";
/** One stored project command (project_terminal_events): the command, its combined output, status and exit code. */
export type ProjectTerminalRow = { id: string; runId?: string | null; processId?: string | null; commandSummary: string; status: string; exitCode?: number | null; output: string; errorCode?: string | null; createdAt: string };
export type MobileView = "all" | "files" | "stream" | "file" | "bottom";

export const SESSION_MODES = ["plan", "ask", "auto_edit", "full_auto_sandbox"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export function authHeaders(): Headers {
  const headers = new Headers();
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

export async function apiSend<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

export async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string; code?: string } };
    const code = data?.error?.code ? ` [${data.error.code}]` : "";
    if (data?.error?.message) return `${data.error.message}${code}`;
  } catch {
    /* ignore */
  }
  return `HTTP ${response.status}`;
}

/** Only http/https links are ever rendered; `javascript:`/`data:` are silently dropped. */
export function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function flattenFiles(entries: FileEntry[] | undefined, prefix = ""): Array<{ path: string; label: string; depth: number }> {
  if (!entries) return [];
  const out: Array<{ path: string; label: string; depth: number }> = [];
  for (const entry of entries) {
    const raw = entry.path ?? entry.name ?? "";
    if (!raw) continue;
    const path = prefix ? `${prefix}/${raw}` : raw;
    const depth = path.split("/").length - 1;
    if (entry.children && entry.children.length > 0) {
      out.push(...flattenFiles(entry.children, path));
    } else if (entry.type !== "directory") {
      out.push({ path, label: raw, depth });
    }
  }
  return out;
}

export function eventTitle(event: RunEvent, isUk: boolean): string {
  const kind = event.kind ?? "event";
  const payload = event.payload ?? {};
  const tool = typeof payload.tool === "string" ? payload.tool : undefined;
  if (tool) return `${kind} · ${tool}`;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (action) return `${kind} · ${action}`;
  return kind || (isUk ? "подія" : "event");
}

/**
 * The failure of a stream event, for its collapsed row: a failed tool call looked exactly like a successful one
 * until the row was opened (V6 step 18). Returns the error code (or "failed") or undefined.
 */
export function eventFailure(event: RunEvent): string | undefined {
  const payload = event.payload ?? {};
  const code = typeof payload.errorCode === "string" && payload.errorCode ? payload.errorCode : undefined;
  if (payload.ok === false || code) return code ?? "failed";
  if (payload.decision === "deny" || payload.decision === "denied") return typeof payload.code === "string" ? payload.code : "denied";
  return undefined;
}

/** Metadata-only summary: string/number/boolean leaves only, no nested content, bounded. */
export function eventFacts(event: RunEvent): Array<[string, string]> {
  const payload = event.payload ?? {};
  const facts: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      facts.push([key, text.length > 200 ? `${text.slice(0, 200)}…` : text]);
    }
    if (facts.length >= 12) break;
  }
  return facts;
}

/** Translate the stored API mode to the existing browser control vocabulary. */
export function normalizeWorkspaceMode(value: string): SessionMode {
  const resolved = canonicalSessionMode(value);
  if (resolved) return resolved;
  throw new Error("Unsupported session mode");
}
