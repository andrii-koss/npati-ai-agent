import { getStoredAuthToken } from "./AuthContext";

export type CodeChatSession = { companyId: string; projectId: string; sessionId: string; inboxEnabled: true };
export type InboxMessage = { id: string; requestId: string; text: string; target: "next-turn" | "next-step";
  status: "pending" | "claimed" | "admitted" | "discarded"; revision: number; runId: string | null; completion?: { eventId: string; resultRef: string; status: string; processId: string } };
export type InboxSnapshot = { revision: number; phase: "idle" | "reserved" | "running" | "sealed" | "settled";
  runId: string | null; lastError: string | null; messages: InboxMessage[]; receipt?: InboxMessage | null };
export function inboxActive(snapshot: InboxSnapshot | null) {
  return !!snapshot && (snapshot.messages.length > 0 || ["reserved", "running", "sealed"].includes(snapshot.phase));
}
export async function requestCodeInbox(session: CodeChatSession, method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown, messageId?: string, signal?: AbortSignal): Promise<InboxSnapshot> {
  const token = getStoredAuthToken();
  const response = await fetch(`/api/companies/${encodeURIComponent(session.companyId)}/code/sessions/${encodeURIComponent(session.sessionId)}/messages${messageId ? `/${encodeURIComponent(messageId)}` : ""}`, {
    method, signal, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) window.dispatchEvent(new Event("npati:unauthorized"));
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error?.message ?? `HTTP ${response.status}`), { status: response.status, code: payload.error?.code });
  return payload as InboxSnapshot;
}

/** A transport retry uses the same accepted request identity; it never starts another chat stream. */
export class InboxSubmission {
  private previous?: { payload: string; requestId: string };
  private busy = false;
  begin(session: CodeChatSession, text: string, mode: "queue" | "steer") {
    if (this.busy) return null;
    const payload = JSON.stringify([session.companyId, session.sessionId, text, mode]);
    if (this.previous?.payload !== payload) this.previous = { payload, requestId: crypto.randomUUID() };
    this.busy = true;
    return { requestId: this.previous.requestId, text, mode };
  }
  finish(accepted: boolean) { this.busy = false; if (accepted) this.previous = undefined; }
  async send(session: CodeChatSession, text: string, mode: "queue" | "steer", draft: {
    version: number; generation: number; currentVersion(): number; currentGeneration(): number;
    apply(snapshot: InboxSnapshot): void; clear(): void;
  }) {
    const request = this.begin(session, text, mode);
    if (!request) return false;
    let accepted = false;
    try {
      const next = await requestCodeInbox(session, "POST", request);
      accepted = true;
      if (draft.currentGeneration() === draft.generation) {
        draft.apply(next);
        if (draft.currentVersion() === draft.version) draft.clear();
      }
      return true;
    } finally { this.finish(accepted); }
  }
}
