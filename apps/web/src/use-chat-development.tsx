import React, { useEffect, useRef, useState } from "react";
import { developmentIsActive, planChatDevelopment, requestsDevelopmentRestore, type DevelopmentProcess } from "@npati/shared";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "./business-workspace-shared";
import type { CodeChatSession } from "./code-inbox-client";
import { ChatDevelopmentPanel } from "./ChatDevelopmentPanel";
import { useTranslation } from "./i18n";
export function useChatDevelopment(options: {
  companyId?: string | null; conversationId: string | null; businessId?: string; onConversation(id: string): void; onError(message: string): void; onAccepted(message: string): void; onSession(session: CodeChatSession, conversationId: string): void; boundSessionId?: string; busy?: boolean;
}) {
  const navigate = useNavigate(); const [search] = useSearchParams();
  const { language } = useTranslation();
  const projectId = search.get("project") ?? undefined; const root = search.get("developmentRoot");
  const [processes, setProcesses] = useState<DevelopmentProcess[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const previousStatuses = useRef(new Map<string, string>());
  const retry = useRef<{ payload: string; requestId: string } | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const callbacks = useRef(options); callbacks.current = options;
  const sending = useRef(false); const alive = useRef(true);
  async function refresh() {
    const data = await api<{ processes: DevelopmentProcess[] }>("/chat/development/processes");
    if (alive.current) setProcesses(data.processes);
  }
  useEffect(() => {
    alive.current = true;
    const poll = () => { void refresh().catch(() => {}); };
    poll(); const timer = window.setInterval(poll, 2500);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    // Websites links recover a dedicated development chat, even after its previous chat was deleted.
    const companyId = search.get("company");
    if (!projectId || !companyId || options.conversationId || root) return;
    let cancelled = false;
    void api<{ url: string }>("/chat/development/project", { method: "POST", body: JSON.stringify({ companyId, projectId }) })
      .then(data => { if (!cancelled) navigate(data.url, { replace: true }); })
      .catch(error => { if (!cancelled) callbacks.current.onError(error instanceof Error ? error.message : "Could not restore project chat"); });
    return () => { cancelled = true; };
  }, [projectId, root, options.conversationId, search, navigate]);
  useEffect(() => {
    const process = processes.find(p => p.projectId === projectId && p.sessionId && p.conversationId === options.conversationId);
    if (process?.inboxEnabled && process.sessionId && process.sessionId !== options.boundSessionId && options.conversationId) callbacks.current.onSession({ companyId: process.companyId, projectId: process.projectId!, sessionId: process.sessionId, inboxEnabled: true }, options.conversationId);
  }, [processes, projectId, options.conversationId, options.boundSessionId]);
  useEffect(() => {
    const process = processes.find(p => p.projectId === projectId && p.conversationId === options.conversationId);
    if (!process) return;
    const previous = previousStatuses.current.get(process.id);
    previousStatuses.current.set(process.id, process.status);
    if (previous && previous !== process.status && !developmentIsActive(process) && !options.busy && options.conversationId) callbacks.current.onConversation(options.conversationId);
  }, [processes, projectId, options.conversationId, options.busy]);
  async function action(id: string, action: "open" | "stop" | "hide") {
    setBusyId(id);
    try {
      const result = await api<{ url?: string }>("/chat/development/processes/" + encodeURIComponent(id) + "/" + action, { method: "POST" });
      if (result.url) navigate(result.url);
      else { await refresh(); if (action === "hide" && root && processes.find(p => p.id === id)?.projectId === projectId) navigate("/c/" + root); }
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : "Process action failed"); }
    finally { if (alive.current) setBusyId(undefined); }
  }
  async function submit(message: string): Promise<boolean> {
    let targets;
    const restore = requestsDevelopmentRestore(message);
    try { targets = planChatDevelopment(message); } catch (error) { callbacks.current.onError((error as Error).message); return true; }
    if (!restore && !targets.length) return false;
    if (sending.current) return true;
    sending.current = true; setSubmitting(true);
    try {
      if (restore) {
        const data = await api<{ processes: DevelopmentProcess[]; conversationId?: string }>("/chat/development/restore", { method: "POST" });
        if (!data.processes.length) { callbacks.current.onError(language === "uk" ? "Проєктів для розробки ще немає. Створіть перший проєкт у чаті." : "No development projects yet. Create your first project in chat."); return true; }
        setProcesses(data.processes); setShowAll(true); callbacks.current.onAccepted(message);
        if (data.conversationId) { callbacks.current.onConversation(data.conversationId); navigate("/c/" + data.conversationId); }
        return true;
      }
      let companyId = callbacks.current.companyId;
      if (!companyId) {
        const data = await api<{ companies: { id: string }[] }>("/companies");
        if (data.companies.length !== 1) throw new Error(language === "uk" ? "Оберіть компанію перед створенням проєкту." : "Choose a company before creating a project.");
        companyId = data.companies[0]!.id;
      }
      const originalConversationId = callbacks.current.conversationId;
      const payload = JSON.stringify([companyId, message, originalConversationId]);
      if (retry.current?.payload !== payload) retry.current = { payload, requestId: crypto.randomUUID() };
      const data = await api<{ conversationId: string; processes: DevelopmentProcess[] }>("/chat/development/processes", { method: "POST", body: JSON.stringify({ companyId, message,
        conversationId: callbacks.current.conversationId ?? undefined, businessId: callbacks.current.businessId, requestId: retry.current.requestId }) });
      retry.current = undefined; if (!alive.current) return true; callbacks.current.onAccepted(message);
      callbacks.current.onConversation(data.conversationId);
      if (!originalConversationId) navigate("/c/" + data.conversationId, { replace: true });
      await refresh();
      window.dispatchEvent(new Event("npati:conversations-changed"));
      return true;
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : "Could not start development"); return true; }
    finally { sending.current = false; if (alive.current) setSubmitting(false); }
  }
  const currentRoot = root ?? options.conversationId;
  const visible = processes.filter(p => p.parentConversationId === currentRoot || p.projectId === projectId || !p.hidden && (showAll || !currentRoot));
  return { submit, submitting, panel: <ChatDevelopmentPanel processes={visible} projectId={projectId} isUk={language === "uk"} busyId={busyId}
    onOpen={id => { void action(id, "open"); }} onStop={id => { void action(id, "stop"); }} onHide={id => { void action(id, "hide"); }}
    onBack={() => { const parent = root ?? processes.find(p => p.projectId === projectId)?.parentConversationId; if (parent) navigate("/c/" + parent); }} /> };
}
