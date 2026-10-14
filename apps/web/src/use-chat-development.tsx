import React, { useEffect, useRef, useState } from "react";
import { developmentIsActive, planChatDevelopment, requestsDevelopmentRestore, type DevelopmentProcess } from "@npati/shared";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "./business-workspace-shared";
import type { CodeChatSession } from "./code-inbox-client";
import { watchDevelopmentTrace } from "./chat-development-stream";
import { ChatDevelopmentProgress, ChatDevelopmentPreview } from "./ChatDevelopmentProgress";
import { developmentCard, hideDevelopmentMessage } from "./chat-development-view";
import { ChatDevelopmentPanel } from "./ChatDevelopmentPanel";
import { useTranslation } from "./i18n";
export function useChatDevelopment(options: {
  companyId?: string | null; conversationId: string | null; businessId?: string; onConversation(id: string): void; onError(message: string): void; onAccepted(message: string): void; onSession(session: CodeChatSession, conversationId: string): void; boundSessionId?: string; busy?: boolean;
}) {
  const navigate = useNavigate(); const [search] = useSearchParams();
  const { language } = useTranslation();
  const queryProjectId = search.get("project") ?? undefined; const root = search.get("developmentRoot");
  const [processes, setProcesses] = useState<DevelopmentProcess[]>([]);
  const currentProcess = processes.find(p => p.conversationId === options.conversationId && (!queryProjectId || p.projectId === queryProjectId));
  const projectId = queryProjectId ?? currentProcess?.projectId;
  const [busyId, setBusyId] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const previousStatuses = useRef(new Map<string, string>());
  const retry = useRef<{ payload: string; requestId: string } | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const callbacks = useRef(options); callbacks.current = options;
  const sending = useRef(false); const alive = useRef(true);
  const snapshotGeneration = useRef(0);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  async function refresh() {
    if (refreshing.current) return refreshing.current;
    const generation = snapshotGeneration.current;
    const task = async () => {
    const data = await api<{ processes: DevelopmentProcess[] }>("/chat/development/processes");
    if (alive.current && generation === snapshotGeneration.current) setProcesses(data.processes);
    };
    refreshing.current = task();
    try { await refreshing.current; } finally { refreshing.current = undefined; }
  }
  const anyActive = processes.some(developmentIsActive);
  useEffect(() => {
    alive.current = true;
    const poll = () => { void refresh().catch(() => {}); };
    poll();
    const controller = new AbortController();
    void watchDevelopmentTrace(controller.signal, snapshot => {
      if (snapshot && !controller.signal.aborted) { snapshotGeneration.current++; setProcesses(snapshot); }
      else poll();
    });
    const intervalMs = anyActive ? 5000 : 10000;
    const timer = window.setInterval(poll, intervalMs);
    return () => { alive.current = false; controller.abort(); window.clearInterval(timer); };
  }, [anyActive]);
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
    if (options.busy) return;
    const signature = process.status + ":" + process.updatedAt;
    const previous = previousStatuses.current.get(process.id);
    previousStatuses.current.set(process.id, signature);
    if (previous && previous !== signature && !developmentIsActive(process) && options.conversationId) callbacks.current.onConversation(options.conversationId);
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
    try { targets = planChatDevelopment(message, projectId); } catch (error) { callbacks.current.onError((error as Error).message); return true; }
    if (!restore && !targets.length) {
      const current = processes.find(p => p.projectId === projectId && p.conversationId === options.conversationId);
      if (current && developmentIsActive(current) && !current.progress?.some(event => event.stage === "agent")) {
        callbacks.current.onError(language === "uk" ? "Триває встановлення заготовки. Дочекайтеся початку роботи агента перед надсиланням змін." : "Template installation is still running. Wait for the coding agent to start before sending changes.");
        return true;
      }
      return false;
    }
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
      const creationConversationId = currentProcess?.parentConversationId ?? originalConversationId;
      const payload = JSON.stringify([companyId, message, creationConversationId]);
      if (retry.current?.payload !== payload) retry.current = { payload, requestId: crypto.randomUUID() };
      const data = await api<{ conversationId: string; processes: DevelopmentProcess[] }>("/chat/development/processes", { method: "POST", body: JSON.stringify({ companyId, message,
        conversationId: creationConversationId ?? undefined, businessId: callbacks.current.businessId, requestId: retry.current.requestId }) });
      retry.current = undefined; if (!alive.current) return true; callbacks.current.onAccepted(message);
      callbacks.current.onConversation(data.conversationId);
      if (originalConversationId !== data.conversationId) navigate("/c/" + data.conversationId, { replace: !originalConversationId });
      await refresh();
      window.dispatchEvent(new Event("npati:conversations-changed"));
      return true;
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : "Could not start development"); return true; }
    finally { sending.current = false; if (alive.current) setSubmitting(false); }
  }
  const currentRoot = root ?? currentProcess?.parentConversationId ?? options.conversationId;
  const visible = processes.filter(p => p.parentConversationId === currentRoot || p.projectId === projectId || !p.hidden && (showAll || !currentRoot));
  return { submit, submitting, project: currentProcess, card: (messages: Parameters<typeof developmentCard>[0], index: number) => developmentCard(messages, index, processes, options.conversationId), hideMessage: (messages: Parameters<typeof hideDevelopmentMessage>[0], index: number) => hideDevelopmentMessage(messages, index, processes), preview: <ChatDevelopmentPreview process={currentProcess} />, timeline: <ChatDevelopmentProgress process={currentProcess} isUk={language === "uk"} />, panel: <ChatDevelopmentPanel processes={visible} projectId={projectId} isUk={language === "uk"} busyId={busyId}
    onOpen={id => { void action(id, "open"); }} onStop={id => { void action(id, "stop"); }} onHide={id => { void action(id, "hide"); }}
    onBack={() => { const parent = root ?? processes.find(p => p.projectId === projectId)?.parentConversationId; if (parent) navigate("/c/" + parent); }} /> };
}
