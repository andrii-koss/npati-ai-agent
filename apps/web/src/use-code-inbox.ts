import { useCallback, useEffect, useRef, useState } from "react";
import { inboxActive, requestCodeInbox, type CodeChatSession, type InboxSnapshot } from "./code-inbox-client";

/** Observation only: the existing backend executor owns every run, even after the tab closes. */
export function useCodeInbox(conversationId: string | null, streaming: boolean) {
  const [binding, setBinding] = useState<{ session: CodeChatSession; conversationId: string | null } | null>(null);
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState("");
  const [receiptTarget, setReceiptTarget] = useState<"next-step" | "next-turn" | null>(null);
  const generation = useRef(0);
  const activeBinding = binding?.conversationId === conversationId ? binding : null;
  const current = useRef(activeBinding); current.current = activeBinding;
  const observationActive = useRef(true);
  observationActive.current = streaming || !snapshot || !!error || inboxActive(snapshot);
  const refreshRef = useRef<{ sessionId: string; refresh: () => Promise<void> } | null>(null);
  const refresh = useCallback((sessionId: string) => {
    if (current.current?.session.sessionId === sessionId && refreshRef.current?.sessionId === sessionId) void refreshRef.current.refresh();
  }, []);
  const accept = useCallback((session: CodeChatSession, chatId: string | null) => {
    generation.current++;
    current.current = { session, conversationId: chatId };
    setSnapshot(null); setReceiptTarget(null); setError(""); setBinding(current.current);
    try { if (chatId) sessionStorage.setItem(`npati_code_inbox:${chatId}`, JSON.stringify(session)); } catch { /* Storage is an optional reconnect hint. */ }
  }, []);
  const bindConversation = useCallback((chatId: string) => {
    const session = current.current?.session;
    if (session) {
      current.current = { session, conversationId: chatId }; setBinding(current.current);
      try { sessionStorage.setItem(`npati_code_inbox:${chatId}`, JSON.stringify(session)); } catch { /* GET remains authoritative. */ }
    }
  }, []);
  useEffect(() => {
    // Binding a newly created chat to the same live Coding Session is continuity, not a new UI owner.
    if (current.current?.conversationId === conversationId) return;
    generation.current++;
    if (conversationId && current.current?.conversationId !== conversationId) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(`npati_code_inbox:${conversationId}`) ?? "null") as CodeChatSession | null;
        if (saved?.inboxEnabled === true && typeof saved.sessionId === "string" && typeof saved.companyId === "string" && typeof saved.projectId === "string") {
          setBinding({ session: saved, conversationId }); setSnapshot(null); setReceiptTarget(null); setError("");
        }
      } catch { /* A stale local hint cannot authorize anything; the GET below still checks RBAC. */ }
    }
  }, [conversationId]);
  const applySnapshot = useCallback((next: InboxSnapshot, sessionId: string) => {
    if (current.current?.session.sessionId !== sessionId) return;
    setSnapshot((previous) => !previous || next.revision >= previous.revision ? next : previous);
    if (next.receipt?.target) setReceiptTarget(next.receipt.target);
    setError("");
  }, []);
  useEffect(() => {
    if (!activeBinding) return;
    const session = activeBinding.session;
    const controller = new AbortController();
    const epoch = generation.current;
    let busy = false;
    const refresh = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const next = await requestCodeInbox(session, "GET", undefined, undefined, controller.signal);
        if (!controller.signal.aborted && epoch === generation.current) applySnapshot(next, session.sessionId);
      }
      catch (reason) {
        if (controller.signal.aborted || epoch !== generation.current) return;
        if ((reason as { code?: string }).code === "feature_disabled") {
          // Rollback removes only the optional browser hint; durable pending messages stay on the server.
          generation.current++; current.current = null; setBinding(null); setSnapshot(null); setReceiptTarget(null);
          try { if (conversationId) sessionStorage.removeItem(`npati_code_inbox:${conversationId}`); } catch { /* Optional hint. */ }
        } else setError(reason instanceof Error ? reason.message : "Inbox unavailable");
      }
      finally { busy = false; }
    };
    void refresh();
    refreshRef.current = { sessionId: session.sessionId, refresh };
    // Bounded UI snapshot refresh covers queued runs after the original chat SSE closes and other hosts.
    // It does not consume input, start a run or poll from the model. A unified event tail belongs to Step 8.
    const timer = window.setInterval(() => { if (observationActive.current && document.visibilityState !== "hidden") void refresh(); }, 3000);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    return () => { controller.abort(); refreshRef.current = null; window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
  }, [activeBinding, conversationId, applySnapshot]);
  return { session: activeBinding?.session ?? null, snapshot: activeBinding ? snapshot : null, error: activeBinding ? error : "",
    receiptTarget: activeBinding ? receiptTarget : null,
    // An unavailable authoritative snapshot must not fall through to a second routing request.
    active: !!activeBinding && (streaming || !snapshot || !!error || inboxActive(snapshot)),
    accept, bindConversation, applySnapshot, refresh, generation };
}
