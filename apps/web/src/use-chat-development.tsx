import React, { useEffect, useRef, useState } from "react";
import { chatOpenData, currentChatConversationId, isChatPage } from "./chat-open";
import { developmentIsActive, requestsDevelopmentRestore, planChatDevelopment, createDevelopmentAssistantIntro, type DevelopmentProcess, type DevelopmentTarget } from "@npati/shared";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "./business-workspace-shared";
import type { CodeChatSession } from "./code-inbox-client";
import { watchDevelopmentTrace } from "./chat-development-stream";
import { ChatDevelopmentProgress, ChatDevelopmentPreview } from "./ChatDevelopmentProgress";
import { developmentCard, hideDevelopmentMessage } from "./chat-development-view";
import { publishChatProcesses, stopConversationActivity } from "./chat-activity";
import { useTranslation } from "./i18n";
export function useChatDevelopment(options: {
  companyId?: string | null; conversationId: string | null; businessId?: string; onConversation(id: string, preserveActiveTurn?: boolean): void; onError(message: string): void; onAccepted(message: string, intro?: string): void; onSession(session: CodeChatSession, conversationId: string): void; boundSessionId?: string; busy?: boolean;
  /** The project of the chat's newest project card: where this chat last worked, whatever order its processes were created in. */
  latestProjectId?: string;
}) {
  const navigate = useNavigate(); const [search] = useSearchParams();
  const { language } = useTranslation();
  const queryProjectId = search.get("project") ?? undefined; const root = search.get("developmentRoot");
  const [processes, setProcesses] = useState<DevelopmentProcess[]>([]);
  // The chat continues where it last worked (its newest card), not with the empty project it was opened with ("Open in
  // chat" leaves an idle entry) nor with the most recently created process: a TODO chat that made a game and then
  // edited the TODO again is still on the TODO.
  const latestWorked = options.latestProjectId && options.conversationId
    ? processes.find(p => p.projectId === options.latestProjectId && p.conversationId === options.conversationId) : undefined;
  const currentProcess = latestWorked
    // Without a process for the chat's newest project, another project of this chat is not substituted for it.
    ?? (options.latestProjectId ? undefined : processes.find(p => p.conversationId === options.conversationId && (!queryProjectId || p.projectId === queryProjectId)))
    ?? (options.latestProjectId ? undefined : processes.find(p => p.parentConversationId === options.conversationId && (!queryProjectId || p.projectId === queryProjectId)))
    ?? (queryProjectId ? processes.find(p => p.projectId === queryProjectId) : undefined);
  const projectId = latestWorked?.projectId ?? queryProjectId ?? currentProcess?.projectId;
  // Opening a project from Settings first moves to its own chat; a message sent meanwhile would be cut off by that move.
  const [openingProjectChat, setOpeningProjectChat] = useState(false);
  const previousStatuses = useRef(new Map<string, string>());
  const retry = useRef<{ payload: string; requestId: string } | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const planning = useRef(false);
  const callbacks = useRef(options); callbacks.current = options;
  const sending = useRef(false); const alive = useRef(true);
  const snapshotGeneration = useRef(0);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const firstRead = useRef(true);
  useEffect(() => { if (!firstRead.current) publishChatProcesses(processes); }, [processes]);
  const readFor = useRef<string | null | undefined>(undefined);
  async function refresh(): Promise<void> {
    // A read already running for the same chat is shared; a read for another chat waits for it and then runs.
    if (refreshing.current) {
      if (readFor.current === (callbacks.current.conversationId ?? currentChatConversationId())) return refreshing.current;
      await refreshing.current.catch(() => {});
      return refresh();
    }
    const generation = snapshotGeneration.current;
    const task = async () => {
    // The chat page's single open request already carries this chat's processes; later reads ask only for this
    // chat's and running processes. A project link still needs the full list to find that project's chat.
    const conversationId = callbacks.current.conversationId ?? currentChatConversationId();
    readFor.current = conversationId;
    const shared = firstRead.current && conversationId && isChatPage() && !queryProjectId ? chatOpenData(conversationId) : null;
    const opened = shared ? await shared.catch(() => null) : null;
    firstRead.current = false;
    const data = opened ? { processes: opened.processes }
      : await api<{ processes: DevelopmentProcess[] }>(queryProjectId ? `/chat/development/processes?projectId=${encodeURIComponent(queryProjectId)}` : `/chat/development/processes?conversationId=${encodeURIComponent(conversationId ?? "")}`);
    if (alive.current && generation === snapshotGeneration.current) setProcesses(data.processes);
    };
    refreshing.current = task();
    try { await refreshing.current; } finally { refreshing.current = undefined; }
  }
  const anyActive = processes.some(developmentIsActive);
  // A project chat keeps live updates (a new run starts after the previous one finished); a chat without processes has none.
  const live = anyActive || processes.some(p => p.conversationId === options.conversationId || p.parentConversationId === options.conversationId);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // The chat id arriving after the first read of the same page chat needs no second read.
  useEffect(() => { if (readFor.current === undefined || readFor.current !== options.conversationId) void refresh().catch(() => {}); }, [options.conversationId]);
  useEffect(() => {
    // A chat without development processes needs no polling and no live stream; a started process turns them on.
    if (!live) return;
    const poll = () => { if (!document.hidden) void refresh().catch(() => {}); };
    let controller: AbortController | undefined;
    const visibility = () => {
      controller?.abort(); controller = undefined;
      if (document.hidden) return;
      poll();
      // Hidden tabs must release HTTP/1 connections, leaving navigation and
      // Activity requests available while a visible chat receives live updates.
      {
        const stream = new AbortController(); controller = stream;
        void watchDevelopmentTrace(stream.signal, snapshot => {
          if (stream.signal.aborted) return;
          if (snapshot) { snapshotGeneration.current++; setProcesses(snapshot); }
          else poll();
        }, queryProjectId ? undefined : callbacks.current.conversationId ?? currentChatConversationId() ?? "", queryProjectId ?? undefined);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(poll, anyActive ? 5000 : 10000);
    return () => { controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [live, anyActive]);
  useEffect(() => {
    // Websites links recover a dedicated development chat, even after its previous chat was deleted.
    const companyId = search.get("company");
    if (!projectId || !companyId || options.conversationId || root) return;
    let cancelled = false;
    setOpeningProjectChat(true);
    void api<{ url: string }>("/chat/development/project", { method: "POST", body: JSON.stringify({ companyId, projectId }) })
      .then(data => { if (!cancelled) navigate(data.url, { replace: true }); })
      .catch(error => { if (!cancelled) callbacks.current.onError(error instanceof Error ? error.message : "Could not restore project chat"); })
      .finally(() => { if (!cancelled) setOpeningProjectChat(false); });
    return () => { cancelled = true; setOpeningProjectChat(false); };
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
  async function submit(message: string): Promise<boolean> {
    const restore = requestsDevelopmentRestore(message);
    let targets: DevelopmentTarget[] = [];
    if (!restore) {
      targets = planChatDevelopment(message, projectId);
      if (!targets.length) {
        const current = processes.find(p => p.projectId === projectId && p.conversationId === options.conversationId);
        if (current && developmentIsActive(current) && !current.progress?.some(event => event.stage === "agent")) {
          callbacks.current.onError(language === "uk" ? "Триває встановлення заготовки. Дочекайтеся початку роботи агента перед надсиланням змін." : "Template installation is still running. Wait for the coding agent to start before sending changes.");
          return true;
        }
        return false;
      }
    }
    if (sending.current) return true;
    sending.current = true; setSubmitting(true);
    callbacks.current.onAccepted(message);
    try {
      if (restore) {
        const data = await api<{ processes: DevelopmentProcess[]; conversationId?: string }>("/chat/development/restore", { method: "POST" });
        if (!data.processes.length) { callbacks.current.onError(language === "uk" ? "Проєктів для розробки ще немає. Створіть перший проєкт у чаті." : "No development projects yet. Create your first project in chat."); return true; }
        setProcesses(data.processes);
        if (data.conversationId) { callbacks.current.onConversation(data.conversationId, true); navigate("/c/" + data.conversationId); }
        return true;
      }
      let companyId = callbacks.current.companyId;
      if (!companyId) {
        const data = await api<{ companies: { id: string }[] }>("/companies");
        if (data.companies.length !== 1) throw new Error(language === "uk" ? "Оберіть компанію перед створенням проєкту." : "Choose a company before creating a project.");
        companyId = data.companies[0]!.id;
      }
      const originalConversationId = callbacks.current.conversationId;
      const creationConversationId = originalConversationId ?? currentProcess?.parentConversationId;
      const payload = JSON.stringify([companyId, message, creationConversationId]);
      if (retry.current?.payload !== payload) retry.current = { payload, requestId: crypto.randomUUID() };
      const data = await api<{ conversationId: string; processes: DevelopmentProcess[] }>("/chat/development/processes", { method: "POST", body: JSON.stringify({ companyId, message,
        conversationId: creationConversationId ?? undefined, businessId: callbacks.current.businessId, requestId: retry.current.requestId }) });
      retry.current = undefined; if (!alive.current) return true;
      setProcesses(data.processes);
      callbacks.current.onConversation(data.conversationId, true);
      if (originalConversationId !== data.conversationId) {
        window.history.replaceState({ ...window.history.state, usr: { neutralChat: true } }, "", "/c/" + data.conversationId);
      }
      window.dispatchEvent(new Event("npati:conversations-changed"));
      return true;
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : "Could not start development"); return true; }
    finally { sending.current = false; if (alive.current) setSubmitting(false); }
  }
  const activeProcess = processes.find(p => developmentIsActive(p) &&
    (p.conversationId === options.conversationId || p.parentConversationId === options.conversationId));
  const isActive = Boolean(activeProcess);
  return {
    submit,
    submitting,
    stop: async () => {
      if (!options.conversationId || !activeProcess) return;
      await stopConversationActivity(options.conversationId);
      await refresh();
    },
    isActive,
    openingProjectChat,
    project: currentProcess,
    card: (messages: Parameters<typeof developmentCard>[0], index: number) => developmentCard(messages, index, processes, options.conversationId),
    hideMessage: (messages: Parameters<typeof hideDevelopmentMessage>[0], index: number) => hideDevelopmentMessage(messages, index, processes),
    preview: <ChatDevelopmentPreview process={currentProcess} busy={options.busy || submitting} />,
    timeline: <ChatDevelopmentProgress process={currentProcess} isUk={language === "uk"} />,
  };
}
