import { useEffect, useSyncExternalStore } from "react";
import { developmentIsActive, type DevelopmentProcess } from "@npati/shared";
import { authFetch } from "./shell/auth-helpers";

type Process = Pick<DevelopmentProcess, "id" | "conversationId" | "parentConversationId" | "status">;
type Turn = { conversationId: string; stop: () => Promise<void> };
type Snapshot = { processes: Process[]; turns: Turn[]; pending: string[]; errors: Record<string, string> };
let snapshot: Snapshot = { processes: [], turns: [], pending: [], errors: {} };
let updatedAt = 0;
let revision = 0;
const listeners = new Set<() => void>();
const emit = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
const belongsTo = (process: Process, id: string) => process.conversationId === id || process.parentConversationId === id;

/** Shared with the chat's existing snapshots; never read project histories for sidebar badges. */
export function publishChatProcesses(processes: DevelopmentProcess[]) {
  updatedAt = Date.now(); revision++;
  const active = processes.filter(developmentIsActive).map(({ id, conversationId, parentConversationId, status }) => ({ id, conversationId, parentConversationId, status }));
  if (JSON.stringify(active) !== JSON.stringify(snapshot.processes)) emit({ ...snapshot, processes: active });
}

export function registerChatTurn(conversationId: string, stop: () => Promise<void>) {
  const turn = { conversationId, stop };
  emit({ ...snapshot, turns: [...snapshot.turns, turn] });
  return () => { emit({ ...snapshot, turns: snapshot.turns.filter(item => item !== turn) }); };
}

export function conversationActivity(state: Snapshot, conversationId: string) {
  const processes = state.processes.filter(process => belongsTo(process, conversationId));
  const turns = state.turns.filter(turn => turn.conversationId === conversationId);
  const keys = [...processes.filter(process => process.status !== "stopping").map(process => process.id), ...turns.map(turn => "turn:" + turn.conversationId)];
  return {
    active: processes.length + turns.length > 0,
    stopping: keys.every(key => state.pending.includes(key)),
    error: state.errors[conversationId],
  };
}

export async function stopConversationActivity(conversationId: string) {
  // Capture only this chat's currently visible work, never a fallback from another chat.
  const jobs = snapshot.processes.filter(process => belongsTo(process, conversationId) && process.status !== "stopping" && !snapshot.pending.includes(process.id));
  const turns = snapshot.turns.filter(turn => turn.conversationId === conversationId && !snapshot.pending.includes("turn:" + conversationId));
  const keys = [...jobs.map(job => job.id), ...turns.map(() => "turn:" + conversationId)];
  if (!keys.length) return;
  revision++;
  emit({ ...snapshot, pending: [...snapshot.pending, ...keys], errors: { ...snapshot.errors, [conversationId]: "" } });
  const results = await Promise.allSettled([
    ...jobs.map(async job => {
      const response = await authFetch("/api/chat/development/processes/" + encodeURIComponent(job.id) + "/stop", { method: "POST" });
      if (!response.ok) throw new Error("Stop failed (" + response.status + ")");
      emit({ ...snapshot, processes: snapshot.processes.map(process => process.id === job.id ? { ...process, status: "stopping" } : process) });
    }),
    ...turns.map(turn => turn.stop()),
  ]);
  const failed = results.some(result => result.status === "rejected");
  revision++;
  emit({ ...snapshot, pending: snapshot.pending.filter(key => !keys.includes(key)), errors: { ...snapshot.errors, [conversationId]: failed ? "stop_failed" : "" } });
  updatedAt = 0;
  window.dispatchEvent(new Event("npati:chat-activity-refresh"));
}

export function useChatActivity() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    let controller: AbortController | undefined;
    let closed = false;
    const refresh = async () => {
      if (document.hidden || controller || Date.now() - updatedAt < 10_000) return;
      const request = new AbortController(); controller = request;
      const readRevision = revision;
      try {
        // An explicitly empty conversation filter selects active metadata only. Omitting it would
        // expand all projects' histories and reintroduce slow chat loading.
        const response = await authFetch("/api/chat/development/processes?conversationId=", { signal: request.signal });
        if (response.status === 401 || response.status === 403) {
          if (!closed) publishChatProcesses([]);
          return;
        }
        if (!response.ok) return;
        const data = await response.json() as { processes: DevelopmentProcess[] };
        if (!closed && revision === readRevision) publishChatProcesses(data.processes);
      } catch { /* Keep known work visible during a temporary network failure. */ }
      finally { if (controller === request) controller = undefined; }
    };
    const visibility = () => { if (document.hidden) controller?.abort(); else void refresh(); };
    const first = window.setTimeout(() => { void refresh(); }, 1000);
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    const requested = () => { void refresh(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("npati:chat-activity-refresh", requested);
    return () => {
      closed = true; controller?.abort(); window.clearTimeout(first); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("npati:chat-activity-refresh", requested);
    };
  }, []);
  return state;
}
