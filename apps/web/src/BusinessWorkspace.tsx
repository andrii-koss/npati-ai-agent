import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { AgentReply, ProjectCardData } from "@npati/shared";
import { defaultHybridRouter } from "@npati/shared/hybrid-router";
import { FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, SyntheticEvent, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { ChatMessageContent, projectChatText, stripInternalChatActions } from "./ChatMessageContent";
import { UserPromptMessage } from "./UserPromptMessage";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { ChatAttachments, PendingMessageAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { SPEECH_VOICES } from "./speech-voices";
import { persistedModeLabel } from "./code-workspace/actions";
import { ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
import { cancelChatStream, streamChat } from "./chat-stream";
import { InboxSubmission } from "./code-inbox-client";
import { useCodeInbox } from "./use-code-inbox";
import { projectConversationUrl } from "./chat-development-view";
import { useChatResearchProgress } from "./use-chat-research-progress";
import { chatTimeline, mergeConversationMessages, nearChatBottom } from "./chat-timeline";
import { ChatDevelopmentProgress } from "./ChatDevelopmentProgress";
import { useChatDevelopment } from "./use-chat-development";
import { BusinessChatComposer } from "./business-workspace-composer";
import { confirmModal, alertModal } from "./ConfirmDialog";
import { detectChatMutationOperation, mutationProgressTargets } from "./chat-mutation-progress";
import { Business, Goal, MemoryItem, Company, api, blankBusiness, Notice, useWorkspace, Skill, getCachedSkills, updateCachedSkills, PageIntro, EmptyBusiness } from "./business-workspace-shared";
import { BusinessForm, ProjectChatCard, AssistantMessageToolbar, FloatingNotice, Message } from "./business-workspace-cards";
export * from "./business-workspace-page-views";
export * from "./business-workspace-cards";
export * from "./business-workspace-shared";
type Conversation = { id: string; title: string; updatedAt: string };
function messageHasImage(message: Message) {
  return message.attachments?.some((attachment) => attachment.kind === "image")
    || message.content.includes("[[npati-attachment:image:");
}

export const ChatContextSwitcherContext = createContext<ReactNode>(null);

export function BusinessSwitcher() {
  const { overview, loading, switchBusiness } = useWorkspace();
  if (loading) return null;
  if (!overview?.businesses.length) return <Link className="business-switcher setup" to="/business">Set up business</Link>;
  return (
    <label className="business-switcher">
      <span>Current business</span>
      <select value={overview.currentBusiness?.id ?? ""} onChange={(event) => void switchBusiness(event.target.value)}>
        {overview.businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
      </select>
    </label>
  );
}


const businessThinkingSteps = [
  "Thinking…",
  "Reviewing your business context…",
  "Checking goals and memory…",
  "Preparing a response…",
];

function expandDeleteConfirmationReply(message: string, history: Message[]): string {
  if (!/^(?:так|так,|підтверджую|да|да,|подтверждаю|yes|yes,|confirm)$/iu.test(message.trim())) return message;
  const previous = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
  const command = /(?:Для підтвердження напишіть|Для подтверждения напишите|To confirm, write):\s*\*\*([^*]+)\*\*/iu.exec(previous)?.[1]?.trim();
  return command || message;
}

function isWebsiteAnalysisRequest(message: string) {
  return /https?:\/\/|www\.|\b(?:website|webpage|site|scan|crawl)\b|сайт|вебсторінк|проскануй/iu.test(message);
}


export function BusinessChatPage({ initialPrompt = "", initialConversationId, neutralChat = false, companyId }: { initialPrompt?: string; initialConversationId?: string; neutralChat?: boolean; companyId?: string }) {
  const { t, language } = useTranslation();
  const { overview } = useWorkspace(); const business = neutralChat || companyId ? null : overview?.currentBusiness;
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
  const [chatSearch] = useSearchParams();
  const [selectedProject, setSelectedProject] = useState<{ companyId: string; projectId: string; conversationId: string | null } | null>(() => {
    const projectId = chatSearch.get("project"); const selectedCompany = chatSearch.get("company");
    return projectId && selectedCompany ? { projectId, companyId: selectedCompany, conversationId: initialConversationId ?? null } : null;
  });
  const [entryProjectCard, setEntryProjectCard] = useState<ProjectCardData | null>(null);
  useEffect(() => {
    if (!selectedProject || selectedProject.conversationId !== null) return;
    const controller = new AbortController();
    void api<{ id: string; name: string; status: string; framework?: string; previewUrl?: string; type: string }>(
      `/companies/${encodeURIComponent(selectedProject.companyId)}/projects/${encodeURIComponent(selectedProject.projectId)}`, { signal: controller.signal }
    ).then(project => {
      if (!controller.signal.aborted) setEntryProjectCard({ id: project.id, projectId: project.id, companyId: selectedProject.companyId, name: project.name, status: project.status, framework: project.framework, previewUrl: project.previewUrl, kind: project.type === "code_project" ? "code_project" : "website_project" });
    }).catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Project unavailable"); });
    return () => controller.abort();
  }, [selectedProject]);
  const [conversations, setConversations] = useState<Conversation[]>([]); const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]); const [input, setInput] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [chatMode, setChatMode] = useState<"none" | "private" | "tts">("none");
  const noMemory = chatMode === "private";
  const ttsEnabled = chatMode === "tts";

  useEffect(() => {
    try {
      localStorage.removeItem("npati_chat_tts_enabled");
    } catch {}
  }, []);

  const [sending, setSending] = useState(false); const [thinkingStep, setThinkingStep] = useState(0);
  const codeInbox = useCodeInbox(selected, sending);
  useEffect(() => {
    if (codeInbox.session && codeInbox.snapshot?.phase === "settled") {
      window.dispatchEvent(new CustomEvent("npati-code-project-updated", { detail: { projectId: codeInbox.session.projectId } }));
    }
  }, [codeInbox.session?.projectId, codeInbox.snapshot?.phase, codeInbox.snapshot?.runId]);
  const [inboxSubmitting, setInboxSubmitting] = useState(false);
  useEffect(() => { setNotice(""); }, [selected, codeInbox.session?.sessionId]);
  const inboxSubmission = useRef(new InboxSubmission());
  const inboxMutationBusy = useRef(false);
  const draftVersion = useRef(0);
  const selectedChatRef = useRef(selected); selectedChatRef.current = selected;
  const chatSubmissionBusy = useRef(false);
  const [streamingResponse,setStreamingResponse]=useState(false);
  const [notice, setNotice] = useState(""); const [replyMeta, setReplyMeta] = useState<AgentReply | null>(null);
  const development = useChatDevelopment({ companyId: companyId ?? readActiveCompanyId(), conversationId: selected, businessId: business?.id, onConversation: id => { void loadConversations(id); }, onError: setNotice, onAccepted: message => setInput(current => current.trim() === message ? "" : current), busy: sending, onSession: codeInbox.accept, boundSessionId: codeInbox.session?.sessionId });
  const [loadingHistory, setLoadingHistory] = useState(() => Boolean(initialConversationId));
  const [ttsVoice, setTtsVoice] = useState(() => {
    try {
      return localStorage.getItem("npati_chat_tts_voice") || "alloy";
    } catch {
      return "alloy";
    }
  });
  const [isGeneratingSpeech, setIsGeneratingSpeech] = useState(false);

  const handleModeChange = (mode: "none" | "private" | "tts") => {
    setChatMode(mode);
  };

  const handleTtsVoiceChange = (voice: string) => {
    setTtsVoice(voice);
    try {
      localStorage.setItem("npati_chat_tts_voice", voice);
    } catch {}
  };

  async function generateSpeechForInput(): Promise<void> {
    const text = input.trim();
    if (!text || isGeneratingSpeech) return;
    setIsGeneratingSpeech(true);
    try {
      const token = getStoredAuthToken();
      const response = await fetch("/api/audio/speech", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ input: text, format: "mp3", voice: ttsVoice }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? `TTS failed (${response.status})`);
      }
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const base64Data = btoa(binary);
      const audioAttachment: ChatAttachmentInput = {
        name: `speech-${ttsVoice}.mp3`,
        mimeType: "audio/mpeg",
        kind: "audio",
        dataBase64: base64Data,
      };
      setAttachments((prev) => [...prev.filter((a) => a.name !== audioAttachment.name), audioAttachment]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Text-to-speech failed.");
    } finally {
      setIsGeneratingSpeech(false);
    }
  }
  const streamEndRef = useRef<HTMLDivElement>(null);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const activeTurnRef = useRef<HTMLElement>(null);
  const latestMessageRef = useRef<HTMLElement>(null);
  const [activeTurn, setActiveTurn] = useState("");

  const followBottomRef = useRef(true);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (!followBottomRef.current) return;
    if (messageStreamRef.current) {
      messageStreamRef.current.scrollTo({
        top: messageStreamRef.current.scrollHeight,
        behavior,
      });
    }

  }, []);

  const scrollToLatestMessageStart = scrollToBottom;
  const flushDeltasRef = useRef<(() => void) | null>(null);
  const {
    progressEvents,
    visibleProgressCount,
    presentingProgressEvent,
    progressComplete,
    progressFailed,
    setProgressFailed,
    markComplete,
    enqueueProgress,
    resetProgress,
    progressCompleteRef,
    progressEventsRef,
  } = useChatResearchProgress(flushDeltasRef);
  const streamControllerRef=useRef<{controller:AbortController;streamId:string}|null>(null);
  const suggestions = useMemo(
    () => business
      ? ["What should I focus on this week?", "Review my current goals", "Help me improve my offer"]
      : ["Help me brainstorm business ideas", "How do I research market demand?", "Explain how NPATI Agent works"],
    [business?.id]
  );
  const prevBusinessIdRef = useRef(business?.id);
  const selectedRef = useRef(selected);
  const historyLoadVersionRef = useRef(0);
  selectedRef.current = selected;

  async function loadConversations(preferred?: string, preserveActiveTurn = false) {
    const loadVersion = ++historyLoadVersionRef.current;
    const base = business ? `/businesses/${business.id}/conversations` : "/conversations";
    let rows: Conversation[] = [];
    try {
      rows = await api<Conversation[]>(base);
    } catch {
      if (base !== "/conversations") {
        try { rows = await api<Conversation[]>("/conversations"); } catch {}
      }
    }
    if (loadVersion !== historyLoadVersionRef.current) return [] as Message[];
    setConversations(rows);
    const next = preferred ?? null; setSelected(next);
    if (next) {
      let loaded: Message[] = [];
      try {
        loaded = (await api<{ messages: Message[] }>(`${base}/${next}`)).messages;
      } catch {
        if (base !== "/conversations") {
          try {
            loaded = (await api<{ messages: Message[] }>(`/conversations/${next}`)).messages;
          } catch {}
        }
      }
      if (loadVersion !== historyLoadVersionRef.current) return [] as Message[];
      if (loaded.length > 0) {
        // The active turn already has stable React keys and the final streamed text.
        // Replacing it with persisted message IDs remounts both bubbles and flashes.
        if (preserveActiveTurn) return loaded;
        setMessages(loaded);
        if (!preserveActiveTurn && !activeTurn) {
          window.requestAnimationFrame(() => {
            scrollToLatestMessageStart("auto");
            setTimeout(() => scrollToLatestMessageStart("auto"), 50);
            setTimeout(() => scrollToLatestMessageStart("auto"), 150);
            setTimeout(() => scrollToLatestMessageStart("auto"), 300);
          });
        }
        return loaded;
      }
    }
    if (!preserveActiveTurn) {
      setMessages([]);
    }
    return [] as Message[];
  }
  useEffect(() => {
    const businessChanged = prevBusinessIdRef.current !== business?.id;
    prevBusinessIdRef.current = business?.id;

    if (businessChanged && (selectedRef.current || messages.length > 0)) {
      void loadConversations(selectedRef.current ?? undefined, true);
      return;
    }

    followBottomRef.current = true;
    setSelected(initialConversationId ?? null);
    setReplyMeta(null);
    setNotice("");
    setActiveTurn("");
    resetProgress();
    if (initialConversationId) {
      setLoadingHistory(true);
      void loadConversations(initialConversationId).finally(() => setLoadingHistory(false));
    } else {
      setMessages([]);
      setLoadingHistory(false);
      void loadConversations();
    }
  }, [business?.id, initialConversationId]);
  useEffect(() => {
    if (!sending) { setThinkingStep(0); return; }
    const timer = window.setInterval(() => setThinkingStep((step) => Math.min(step + 1, businessThinkingSteps.length - 1)), 1200);
    return () => window.clearInterval(timer);
  }, [sending]);
  useEffect(() => {
    const handleImageLoaded = () => {
      if (!activeTurn) {
        scrollToBottom("auto");
      }
    };
    window.addEventListener("npati:chat-image-loaded", handleImageLoaded);
    return () => window.removeEventListener("npati:chat-image-loaded", handleImageLoaded);
  }, [activeTurn, scrollToBottom]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => scrollToBottom("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [messages, sending, development.project?.progress, scrollToBottom]);
  useEffect(() => () => {
    streamControllerRef.current?.controller.abort();
  }, []);
  async function submitInbox(mode: "queue" | "steer") {
    const session = codeInbox.session;
    const text = input.trim();
    if (!session || !text || inboxMutationBusy.current) return;
    if (attachments.length || noMemory || ttsEnabled) { setNotice(t("codeInbox.textOnly")); return; }
    const version = draftVersion.current, generation = codeInbox.generation.current;
    inboxMutationBusy.current = true; setInboxSubmitting(true);
    try {
      await inboxSubmission.current.send(session, text, mode, { version, generation,
        currentVersion: () => draftVersion.current, currentGeneration: () => codeInbox.generation.current,
        apply: (next) => { codeInbox.applySnapshot(next, session.sessionId); if (next.receipt && !next.receipt.completion) setMessages(current => mergeConversationMessages(current,[{id:"inbox:"+next.receipt!.id,role:"user",content:next.receipt!.text,createdAt:next.receipt!.createdAt ?? new Date().toISOString()}])); },
        clear: () => { draftVersion.current++; setInput(""); },
      });
      if (generation !== codeInbox.generation.current) return;
      // The server may turn a late steer into next-turn. The pending panel uses the receipt target.
      setNotice("");
    } catch (reason) {
      if (generation === codeInbox.generation.current) setNotice(reason instanceof Error ? reason.message : t("common.error"));
      // Leave the draft and retry identity intact, including an ambiguous transport failure.
    } finally {
      inboxMutationBusy.current = false; setInboxSubmitting(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!noMemory && !attachments.length && !sending && !chatSubmissionBusy.current && await development.submit(input.trim())) return;
    const boundProjectId = development.project?.projectId ?? codeInbox.session?.projectId ?? (selectedProject?.conversationId === selected ? selectedProject.projectId : undefined);
    const nextIntent = defaultHybridRouter.classifyProject({ message: input.trim(), activeProjectId: boundProjectId, activeCompanyId: companyId ?? readActiveCompanyId() });
    const createsProject = nextIntent.intent === "CREATE_WEBSITE" || nextIntent.intent === "CREATE_PROJECT";
    if (codeInbox.active && !createsProject) { await submitInbox("queue"); return; }
    const message = input.trim(); if ((!message && attachments.length === 0) || sending || chatSubmissionBusy.current) return;
    chatSubmissionBusy.current = true;
    const submittedDraftVersion = draftVersion.current;
    const restoreDraft = (savedAttachments: ChatAttachmentInput[]) => {
      if (draftVersion.current === submittedDraftVersion && selectedChatRef.current === conversationAtSubmit) { setInput(message); setAttachments(savedAttachments); }
    };
    const requestMessage = expandDeleteConfirmationReply(message, messages);
    const conversationAtSubmit = selected;
    // An earlier history request must not replace the optimistic turn after it starts.
    historyLoadVersionRef.current += 1;
    const privateRequest = noMemory;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    let sentAttachments = [...attachments];

    if (ttsEnabled && message && !sentAttachments.some((item) => item.kind === "audio")) {
      try {
        const token = getStoredAuthToken();
        const ttsResponse = await fetch("/api/audio/speech", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ input: message, format: "mp3", voice: ttsVoice }),
        });
        if (ttsResponse.ok) {
          const blob = await ttsResponse.blob();
          const buffer = await blob.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]!);
          }
          const base64Data = btoa(binary);
          const ttsAttachment: ChatAttachmentInput = {
            name: `speech-${ttsVoice}.mp3`,
            mimeType: "audio/mpeg",
            kind: "audio",
            dataBase64: base64Data,
          };
          sentAttachments.push(ttsAttachment);
        } else {
          const payload = await ttsResponse.json().catch(() => null) as { error?: { message?: string } | string } | null;
          const errMsg = typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? `TTS failed (${ttsResponse.status})`;
          setNotice(`Text-to-speech notice: ${errMsg}`);
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Text-to-speech failed.");
      }
    }

    const optimisticContent = message;
    const projectProgressIntent = defaultHybridRouter.classifyProject({ message: requestMessage, activeProjectId: boundProjectId, activeCompanyId: companyId ?? readActiveCompanyId() });
    const mutationContext = companyId ? "company" : business ? "business" : "none";
    const pendingMutation = detectChatMutationOperation(requestMessage, mutationContext);
    const mutationTargets = pendingMutation
      ? mutationProgressTargets(requestMessage, mutationContext)
      : [];
    const mutationStartedAt = Date.now();
    setActiveTurn(optimisticContent);
    const optimisticMessage: Message = { id: optimisticId, role: "user", content: optimisticContent, createdAt: new Date().toISOString(), attachments: sentAttachments };
    setMessages((current) => [...current, optimisticMessage]);
    resetProgress();
    if (projectProgressIntent.intent !== "CHAT" && !development.project) enqueueProgress({ type: "project_progress", stage: "project", status: "active", title: /[\u0400-\u04ff]/u.test(requestMessage) ? "Підготовка запиту" : "Preparing request", timestamp: new Date().toISOString() });
    for (const mutationTarget of mutationTargets) enqueueProgress({ type: "action_started", ...mutationTarget, timestamp: new Date().toISOString() });
    setSending(true); setStreamingResponse(false); setNotice("");
    if (draftVersion.current === submittedDraftVersion) { setInput(""); setAttachments([]); }
    setReplyMeta(null);
    followBottomRef.current = true;
    window.requestAnimationFrame(() => scrollToBottom("auto"));
    const assistantId = crypto.randomUUID();
    let receivedDelta = false;
    let rawAssistantContent = "";
    const controller = new AbortController(), streamId = crypto.randomUUID();
    streamControllerRef.current = { controller, streamId };

    const deltaBuffer: string[] = [];

    const appendDelta = (chunk: string) => {
      rawAssistantContent += chunk;
      const visibleContent = stripInternalChatActions(rawAssistantContent, true);
      if (!visibleContent.trim()) return;
      if (!receivedDelta) {
        receivedDelta = true;
        scrollToBottom("auto");
      }
      setStreamingResponse(true);
      setMessages((current) => {
        const found = current.some((item) => item.id === assistantId);
        return found
          ? current.map((item) => (item.id === assistantId ? { ...item, content: visibleContent } : item))
          : [...current, { id: assistantId, role: "assistant", content: visibleContent, createdAt: new Date().toISOString() }];
      });
      // Do NOT scroll to bottom! Keep user reading from the top!
    };

    const flushDeltas = () => {
      flushDeltasRef.current = null;
      if (deltaBuffer.length > 0) {
        const buffered = deltaBuffer.join("");
        deltaBuffer.length = 0;
        appendDelta(buffered);
      }
    };
    flushDeltasRef.current = flushDeltas;

    const activeCompanyForRequest = (!createsProject ? development.project?.companyId : null) ?? (!createsProject && selectedProject?.conversationId === selected ? selectedProject.companyId : null) ?? companyId ?? readActiveCompanyId();
    let activeProjectId: string | undefined;
    const projectIntent = defaultHybridRouter.classifyProject({ message: requestMessage, activeProjectId: boundProjectId, activeCompanyId: activeCompanyForRequest });
    const isNewProjectRequest = projectIntent.intent === "CREATE_WEBSITE" || projectIntent.intent === "CREATE_PROJECT";
    if (!isNewProjectRequest) {
      const latestCard = [...messages].reverse().find(item => item.projectCard)?.projectCard;
      if (development.project?.companyId === activeCompanyForRequest) activeProjectId = development.project.projectId;
      else if (selectedProject?.conversationId === selected && selectedProject.companyId === activeCompanyForRequest) activeProjectId = selectedProject.projectId;
      else if (latestCard?.companyId === activeCompanyForRequest) activeProjectId = latestCard.projectId ?? latestCard.id;
      try {
        const stored = sessionStorage.getItem("npati_active_project");
        if (stored) {
          const active = JSON.parse(stored) as { companyId?: string; projectId?: string; conversationId?: string };
          if (!activeProjectId && selected && active.conversationId === selected && active.companyId === activeCompanyForRequest) activeProjectId = active.projectId;
        }
      } catch {}
    }
    try {
      const result = await streamChat<AgentReply>({
        message: requestMessage,
        conversationId: selected ?? undefined,
        attachments: sentAttachments,
        contextType: activeProjectId ? "project" : companyId ? "company" : (business ? "business" : "none"),
        ...(activeCompanyForRequest && (companyId || activeProjectId) ? { companyId: activeCompanyForRequest } : {}),
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
        noMemory: privateRequest,
        streamId,
      }, enqueueProgress, {
        signal: controller.signal,
        onCodeSession: (session) => { if (streamControllerRef.current?.controller === controller && selectedChatRef.current === conversationAtSubmit) codeInbox.accept(session, conversationAtSubmit); },
        onCodeInbox: (sessionId) => { if (streamControllerRef.current?.controller === controller) codeInbox.refresh(sessionId); },
        onDelta: (delta) => {
          if (!progressCompleteRef.current && progressEventsRef.current.length > 0) {
            deltaBuffer.push(delta);
            return;
          }
          if (deltaBuffer.length > 0) {
            flushDeltas();
          }
          appendDelta(delta);
        },
      });
      if (pendingMutation) {
        const remaining = 2_000 - (Date.now() - mutationStartedAt);
        if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
      }
      const finalMutationTarget = mutationTargets.at(-1);
      if (finalMutationTarget) enqueueProgress({ type: "action_completed", ...finalMutationTarget, timestamp: new Date().toISOString() });
      flushDeltas();
      setReplyMeta(result);
      const cleanedMessage = stripInternalChatActions(result.message ?? "").trim();
      if ((result as any)?.businessAction) {
        window.dispatchEvent(new CustomEvent("npati:business-changed", { detail: (result as any).businessAction }));
      }
      if (result.companyAction) {
        if (result.companyAction.action === "create" && !companyId && !readActiveCompanyId()) writeActiveCompanyId(result.companyAction.companyId);
        if (result.companyAction.action === "delete" && readActiveCompanyId() === result.companyAction.companyId) writeActiveCompanyId("");
        window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: result.companyAction }));
      } else {
        window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "refresh" } }));
      }
      if ((result as any)?.goalAction) {
        window.dispatchEvent(new CustomEvent("npati:goals-changed", { detail: (result as any).goalAction }));
      }
      if (result.activeContext?.projectId) {
        window.dispatchEvent(new CustomEvent("npati-code-project-updated", { detail: { projectId: result.activeContext.projectId } }));
        try {
          sessionStorage.setItem("npati_active_project", JSON.stringify({ companyId: result.activeContext.companyId, projectId: result.activeContext.projectId, conversationId: result.conversationId ?? selected }));
          if (!readActiveCompanyId() && result.activeContext.companyId) writeActiveCompanyId(result.activeContext.companyId);
        } catch {}
      }
      setMessages((currentMessages) => {
        const current = currentMessages.map(item => item.id === optimisticId && result.userMessage ? { ...item, ...result.userMessage } : item);
        const found = current.some((item) => item.id === assistantId);
        if (!cleanedMessage) return current.filter((item) => item.id !== assistantId);
        return found
          ? current.map((item) => item.id === assistantId ? { ...item, ...result.assistantMessage, content: cleanedMessage, projectCard: result.projectCard } : item)
          : [...current, { id: assistantId, role: "assistant", content: cleanedMessage, projectCard: result.projectCard, createdAt: new Date().toISOString(), ...result.assistantMessage }];
      });
      if (!privateRequest && result.conversationId) {
        if (selectedChatRef.current === conversationAtSubmit) codeInbox.bindConversation(result.conversationId);
        setSelected(result.conversationId);
        window.history.replaceState(
          { ...window.history.state, usr: business ? { businessId: business.id } : { neutralChat: true } },
          "",
          projectConversationUrl(result.conversationId, result.activeContext?.projectId ? result.activeContext : activeProjectId && activeCompanyForRequest ? { companyId: activeCompanyForRequest, projectId: activeProjectId } : undefined, chatSearch)
        );
        if (companyId && result.activeContext?.contextType === "none") {
          navigate(`/c/${result.conversationId}`, { replace: true, state: { neutralChat: true } });
        } else if (window.location.pathname.startsWith("/b/")) {
          navigate(`/c/${result.conversationId}`, { replace: true });
        }
        const firstAttachmentName = sentAttachments[0]?.name;
        const titleSource = message || firstAttachmentName || "New conversation";
        const title = Array.from(titleSource.replace(/[\n\r\t]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, 72).join("") || "New conversation";
        window.dispatchEvent(new CustomEvent("npati:conversations-changed", {
          detail: conversationAtSubmit ? undefined : {
            conversation: {
              id: result.conversationId,
              title,
              updatedAt: new Date().toISOString(),
              businessId: business?.id ?? null,
              businessName: business?.name ?? "",
            },
          },
        }));
      }
      markComplete();
    } catch (reason) {
      flushDeltas();
      const typed = reason as Error & { code?: string };
      if (typed.message?.includes("Project not found") || (typed as any).code === "WORKSPACE_NOT_FOUND" || (typed as any).status === 404) {
        try { sessionStorage.removeItem("npati_active_project"); } catch {}
      }
      if (typed.name === "AbortError") {
        window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "refresh" } }));
      markComplete();
        setNotice("");
        return;
      }
      setProgressFailed(true);
      setNotice(typed.message);
      window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "refresh" } }));
      if (privateRequest) {
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
        restoreDraft(sentAttachments);
      } else try {
        const loaded = await loadConversations(selected ?? undefined);
        const latestUser = [...loaded].reverse().find((item) => item.role === "user");
        const persisted = Boolean(latestUser)
          && (!message || latestUser!.content.includes(message))
          && sentAttachments.every((item) => latestUser!.content.includes(encodeURIComponent(item.name)));
        if (!persisted) {
          restoreDraft(sentAttachments);
        }
        window.dispatchEvent(new Event("npati:conversations-changed"));
      } catch {
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
        restoreDraft(sentAttachments);
      }
    } finally {
      flushDeltas();
      if (streamControllerRef.current?.controller === controller) streamControllerRef.current = null;
      setSending(false);
      chatSubmissionBusy.current = false;
      setStreamingResponse(false);
    }
  }
  async function remember() {
    if (!business || !replyMeta?.memoryCandidate) return;
    await api(`/businesses/${business.id}/memory`, { method: "POST", body: JSON.stringify({ ...replyMeta.memoryCandidate, source: "chat_confirmed" }) });
    setReplyMeta({ ...replyMeta, memoryCandidate: undefined }); setNotice("Saved to Business Memory.");
  }
  function sendOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }
  const displayMessages = mergeConversationMessages(messages,development.project?.conversationMessages);
  const timeline = chatTimeline(displayMessages, development.project?.progress, selected, development.project);
  return (
    <>
      {notice && (
        <FloatingNotice
          message={notice}
          tone={notice.startsWith("Saved") ? "success" : "error"}
          onClose={() => setNotice("")}
          action={/provider/i.test(notice) ? <Link to="/settings/ai">Open AI Marketplace →</Link> : undefined}
        />
      )}
      <div className="onboarding-live-chat standard-live-chat">
        <div className="message-stream" ref={messageStreamRef} onScroll={() => { if (messageStreamRef.current) followBottomRef.current = nearChatBottom(messageStreamRef.current); }}>
          {entryProjectCard && !selected && <ProjectChatCard card={entryProjectCard} onActivate={(card) => setSelectedProject({ companyId: card.companyId, projectId: card.projectId ?? card.id, conversationId: selected })} />}
          {messages.length === 0 && !selected && !initialConversationId && !loadingHistory && (
            <div className="chat-welcome">
              <h2>{t("chat.emptyTitle")}</h2>
              <p>{business ? t("chat.businessEmptySubtitle", { name: business.name }) : t("chat.emptySubtitle")}</p>
            </div>
          )}
          {timeline.map(entry => {
            if (entry.kind === "activity") return <ChatDevelopmentProgress key={"activity:" + entry.item.id} process={development.project} items={entry.run?.items ?? [entry.item]} run={entry.run} />;
            const { message, index } = entry;
            if (development.hideMessage(displayMessages, index)) return null;
            const isLatestAssistant = message.role === "assistant" && index === displayMessages.length - 1;
            const hasResearch = !development.project && progressEvents.some((event) => !event.type.startsWith("final_generation"));
            return (
              <Fragment key={message.id}>
                {isLatestAssistant && hasResearch && (
                  <ResearchProgressPanel
                    events={progressEvents}
                    visibleCount={visibleProgressCount}
                    presentingEvent={presentingProgressEvent}
                    completed={!sending && progressComplete}
                    failed={!sending && progressFailed}
                  />
                )}
                <article
                  ref={(el) => {
                    if (index === displayMessages.length - 1) {
                      latestMessageRef.current = el;
                    }
                    if (message.role === "user" && message.content === activeTurn && !displayMessages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn)) {
                      activeTurnRef.current = el;
                    }
                  }}
                  className={`${message.role}${message.role === "user" && messageHasImage(message) ? " image-message" : ""}`}
                  aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}
                >
                  <PendingMessageAttachments value={message.attachments ?? []} />
                  {message.role === "user" ? <UserPromptMessage content={message.content} onEdit={(prompt) => { setInput(prompt); window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".onboarding-live-composer textarea")?.focus()); }} /> : <ChatMessageContent content={projectChatText(message.content, message.projectCard,development.project?.responseLanguage ?? language)} />}
                  {development.card(displayMessages, index) && <ProjectChatCard card={development.card(messages, index)!} onActivate={(card) => { setSelectedProject({ companyId: card.companyId, projectId: card.projectId ?? card.id, conversationId: selected }); }} />}
                  {message.role === "assistant" && !sending && (
                    <AssistantMessageToolbar
                      content={message.content}
                      onRegenerate={() => {
                        for (let k = index - 1; k >= 0; k--) {
                          if (displayMessages[k]?.role === "user") {
                            setInput(displayMessages[k]!.content);
                            break;
                          }
                        }
                      }}
                    />
                  )}
                </article>
              </Fragment>
            );
          })}
          {!development.project && !messages.some((m, idx) => m.role === "assistant" && idx === messages.length - 1) && progressEvents.some((event) => !event.type.startsWith("final_generation")) && (
            <ResearchProgressPanel
              events={progressEvents}
              visibleCount={visibleProgressCount}
              presentingEvent={presentingProgressEvent}
              completed={!sending && progressComplete}
              failed={!sending && progressFailed}
            />
          )}
          {!development.project && sending && !streamingResponse && !progressEvents.some((event) => !event.type.startsWith("final_generation")) && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{isWebsiteAnalysisRequest(activeTurn) ? "Analyzing website and sources…" : businessThinkingSteps[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          {development.preview}
          {messages.length > 0 && <div className="chat-scroll-spacer" aria-hidden="true" />}
          <div ref={streamEndRef} aria-hidden="true" />
        </div>
        {replyMeta?.memoryCandidate && <div className="memory-candidate"><div><strong>Remember this?</strong><p>{replyMeta.memoryCandidate.title}: {replyMeta.memoryCandidate.content}</p></div><button onClick={() => void remember()}>Remember</button><button onClick={() => setReplyMeta({ ...replyMeta, memoryCandidate: undefined })}>Not now</button></div>}
        {development.panel}
        <BusinessChatComposer
          input={input}
          setInput={setInput}
          attachments={attachments}
          setAttachments={setAttachments}
          draftVersion={draftVersion}
          sending={sending}
          codeInbox={codeInbox}
          inboxSubmitting={inboxSubmitting}
          contextSwitcher={contextSwitcher}
          noMemory={noMemory}
          ttsEnabled={ttsEnabled}
          chatMode={chatMode}
          handleModeChange={handleModeChange}
          ttsVoice={ttsVoice}
          handleTtsVoiceChange={handleTtsVoiceChange}
          generateSpeechForInput={generateSpeechForInput}
          isGeneratingSpeech={isGeneratingSpeech}
          sendOnEnter={sendOnEnter}
          submit={submit}
          business={business}
          t={t}
          setNotice={setNotice}
          streamControllerRef={streamControllerRef}
        />
      </div>
    </>
  );
}
