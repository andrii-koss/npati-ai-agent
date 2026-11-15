import { getStoredAuthToken } from "./AuthContext";
import { textIn } from "./i18n";
import { useTranslation } from "./i18n";
import { developmentIsActive, type AgentReply, type ProjectCardData } from "@npati/shared";
import { defaultHybridRouter } from "@npati/shared/hybrid-router";
import { FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, SyntheticEvent, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { ChatMessageContent, projectChatText, stripInternalChatActions } from "./ChatMessageContent";
import { UserPromptMessage } from "./UserPromptMessage";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { ChatAttachments, PendingMessageAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { SPEECH_VOICES } from "./speech-voices";
import { persistedModeLabel } from "./code-workspace/actions";
import { ChatThinking, useChatThinking, ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
import { cancelChatStream, streamChat } from "./chat-stream";
import { InboxSubmission } from "./code-inbox-client";
import { useCodeInbox } from "./use-code-inbox";
import { projectConversationUrl, developmentPreviewAnchor } from "./chat-development-view";
import { useChatResearchProgress } from "./use-chat-research-progress";
import { useChatOpeningPosition } from "./use-chat-opening-position";
import { chatTimeline, mergeConversationMessages, nearChatBottom, normalizeActivity } from "./chat-timeline";
import { processDuration } from "./AgentExecutionTrace";
import { ChatDevelopmentProgress } from "./ChatDevelopmentProgress";
import { useChatDevelopment } from "./use-chat-development";
import { BusinessChatComposer, ChatWorkModeSwitch } from "./business-workspace-composer";
import { chatOpenData } from "./chat-open";
import { registerChatTurn } from "./chat-activity";
import { ChatMessageRow, useChatRowActions } from "./chat-message-row";
import { confirmModal, alertModal } from "./ConfirmDialog";
import { detectChatMutationOperation, mutationProgressTargets } from "./chat-mutation-progress";
import { Business, Goal, MemoryItem, Company, api, blankBusiness, Notice, useWorkspace, Skill, getCachedSkills, updateCachedSkills, PageIntro, EmptyBusiness } from "./business-workspace-shared";
import { BusinessForm, ProjectChatCard, ChatProjectPreviewCard, AssistantMessageToolbar, FloatingNotice, Message } from "./business-workspace-cards";
import { ChatPreviewOpenContext } from "./ChatProjectPreviewCard";
import { ChatFileViewerProvider } from "./ChatFileViewer";
import { ChatPreviewPanelProvider } from "./ChatPreviewPanel";
import { ChatRunApprovals } from "./ChatRunApprovals";
import { messageLanguage } from "./approval-i18n";
export * from "./business-workspace-page-views";
export * from "./business-workspace-cards";
export * from "./business-workspace-shared";

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



// Earlier messages load before the top is reached, so the view never stops at the very top while they arrive.
const EARLIER_MESSAGES_THRESHOLD_PX = 600;

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
  const [chatSearch] = useSearchParams();
  const isNeutral = neutralChat || Boolean(chatSearch.get("project")) || Boolean(chatSearch.get("company"));
  const { overview } = useWorkspace();
  const business = (isNeutral || companyId) ? null : overview?.currentBusiness;
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
  const [selectedProject, setSelectedProject] = useState<{ companyId: string; projectId: string; conversationId: string | null } | null>(() => {
    const projectId = chatSearch.get("project"); const selectedCompany = chatSearch.get("company");
    return projectId && selectedCompany ? { projectId, companyId: selectedCompany, conversationId: initialConversationId ?? null } : null;
  });
  const [entryProjectCard, setEntryProjectCard] = useState<ProjectCardData | null>(null);
  useEffect(() => {
    const projectId = selectedProject?.projectId ?? chatSearch.get("project");
    const companyId = selectedProject?.companyId ?? chatSearch.get("company");
    if (!projectId || !companyId) return;
    const controller = new AbortController();
    void api<{ id: string; name: string; status: string; framework?: string; previewUrl?: string; type: string }>(
      `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal }
    ).then(project => {
      if (!controller.signal.aborted) setEntryProjectCard({ id: project.id, projectId: project.id, companyId, name: project.name, status: project.status, framework: project.framework, previewUrl: project.previewUrl, kind: project.type === "code_project" ? "code_project" : "website_project" });
    }).catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Project unavailable"); });
    return () => controller.abort();
  }, [chatSearch, selectedProject?.projectId, selectedProject?.companyId]);
  const [selected, setSelected] = useState<string | null>(null); const [earlierMessages, setEarlierMessages] = useState(0);
  const loadingEarlierRef = useRef(false);
  // Earlier messages load on the user's own scroll, not on the scroll that opens the chat at its end.
  const userScrolledRef = useRef(false);
  const earlierAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  // The oldest loaded message id: the history cursor for the next earlier page.
  const earlierCursorRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]); const [input, setInput] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [chatMode, setChatMode] = useState<"none" | "private" | "tts">("none");
  const noMemory = chatMode === "private";
  const ttsEnabled = chatMode === "tts";
  // Work mode is a per-tab convenience; Chat is the default when storage is unavailable.
  // The switch is hidden, so a tab must not start in a mode it can no longer leave.
  const [workMode, setWorkMode] = useState<"chat" | "code">("chat");
  const changeWorkMode = (mode: "chat" | "code") => { setWorkMode(mode); try { sessionStorage.setItem("npati_work_mode", mode); } catch {} };

  useEffect(() => {
    try {
      localStorage.removeItem("npati_chat_tts_enabled");
    } catch {}
  }, []);

  const [sending, setSending] = useState(false);
  const codeInbox = useCodeInbox(selected, sending);
  useEffect(() => {
    if (codeInbox.session && codeInbox.snapshot?.phase === "settled") {
      window.dispatchEvent(new CustomEvent("npati-code-project-updated", { detail: { projectId: codeInbox.session.projectId } }));
    }
  }, [codeInbox.session?.projectId, codeInbox.snapshot?.phase, codeInbox.snapshot?.runId]);
  const [inboxSubmitting, setInboxSubmitting] = useState(false);
  // Moving into the conversation a failed message created must keep the failure notice the person still needs to read.
  const keepNoticeOnSelectRef = useRef(false);
  // A failure from the message that created this conversation, carried here by the navigation; it stays while the person
  // is in that conversation, however often the selection settles after the route mounts.
  const routeLocation = useLocation();
  const carriedNotice = routeLocation.state as { chatNotice?: unknown; chatNoticeFor?: unknown } | null;
  useEffect(() => {
    if (keepNoticeOnSelectRef.current) { keepNoticeOnSelectRef.current = false; return; }
    if (typeof carriedNotice?.chatNotice === "string" && (!selected || carriedNotice.chatNoticeFor === selected)) return;
    setNotice("");
  }, [selected, codeInbox.session?.sessionId]);
  useEffect(() => {
    if (typeof carriedNotice?.chatNotice === "string" && carriedNotice.chatNotice) setNotice(carriedNotice.chatNotice);
  }, [routeLocation.key]);
  const inboxSubmission = useRef(new InboxSubmission());
  const inboxMutationBusy = useRef(false);
  const draftVersion = useRef(0);
  const selectedChatRef = useRef(selected); selectedChatRef.current = selected;
  const chatSubmissionBusy = useRef(false);
  const [streamingResponse, setStreamingResponse] = useState(false);
  const [notice, setNotice] = useState(""); const [replyMeta, setReplyMeta] = useState<AgentReply | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(() => Boolean(initialConversationId));
  // Where this chat last worked: the project of its newest card (a request, a reply or the project it was opened with).
  const latestCard = useMemo(() => [...messages].reverse().find(item => item.projectCard)?.projectCard, [messages]);
  const development = useChatDevelopment({
    latestProjectId: latestCard ? latestCard.projectId ?? latestCard.id : undefined,
    companyId: companyId ?? readActiveCompanyId(),
    conversationId: selected,
    businessId: business?.id,
    onConversation: (id, preserve) => { void loadConversations(id, preserve ?? true); },
    onError: setNotice,
    onAccepted: (message) => {
      cancelOpeningPosition();
      resetProgress();
      thinking.start(message);
      setInput("");
      const userMsg: Message = { id: `opt-u-${crypto.randomUUID()}`, role: "user", content: message, createdAt: new Date().toISOString() };
      setMessages(curr => mergeConversationMessages(curr, [userMsg]));
      setActiveTurn(message);
      followBottomRef.current = true;
      window.requestAnimationFrame(() => scrollToBottom("auto"));
    },
    // The message goes through the ordinary chat next; its own send shows it again, so the development bubble goes.
    onDeclined: (message) => {
      setMessages(curr => {
        const index = curr.map(item => item.id.startsWith("opt-u-") && item.role === "user" && item.content === message).lastIndexOf(true);
        return index < 0 ? curr : curr.filter((_, position) => position !== index);
      });
    },
    busy: sending || inboxSubmitting || codeInbox.active,
    onSession: codeInbox.accept,
    boundSessionId: codeInbox.session?.sessionId
  });
  // A project created in this chat becomes its selection: Preview and follow-ups no longer use the empty entry project.
  // A chat opened for one project ("Edit in chat" on its card) keeps that project: the chat's newest card, already there
  // when the page opened, is not a new project and must not replace it (V6 step 04: a game's edits went to the site).
  const entryProject = useRef<{ projectId: string | null; preexisting?: string }>({ projectId: chatSearch.get("project") });
  useEffect(() => {
    const p = development.project;
    if (!(p?.projectId && p.companyId && selected && p.conversationId === selected)) return;
    const entry = entryProject.current;
    if (entry.projectId && entry.projectId !== p.projectId && entry.preexisting === undefined) { entry.preexisting = p.projectId; return; }
    if (entry.projectId && p.projectId === entry.preexisting && !developmentIsActive(p)) return;
    setSelectedProject(current => current && current.projectId === p.projectId && current.conversationId === selected ? current : { companyId: p.companyId, projectId: p.projectId!, conversationId: selected });
  }, [development.project?.projectId, development.project?.status, selected]);
  // Open Previews of this chat survive a card moving to the newest reply; another chat starts with none.
  const openPreviews = useMemo(() => new Set<string>(), [selected]);
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
  const [openingPosition, setOpeningPosition] = useState<string | null>(null);
  const cancelOpeningPosition = useChatOpeningPosition(messageStreamRef, openingPosition, sending);

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
  } = useChatResearchProgress(flushDeltasRef);
  const streamControllerRef=useRef<{controller:AbortController;streamId:string;stopRequested?:boolean}|null>(null);
  const thinking = useChatThinking({
    busy: sending || development.submitting || development.isActive || codeInbox.active,
    streaming: streamingResponse, text: textIn(messageLanguage([...messages].reverse().find((message) => message.role === "user")?.content, development.project?.responseLanguage ?? language), "chat.thinking"), items: development.project?.progress, events: progressEvents,
    runIds: [...Object.keys(development.project?.runStatuses ?? {}), development.project?.runId, development.project?.initialRunId].filter((id): id is string => Boolean(id)),
  });
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
  useEffect(() => {
    if (!sending || !selected) return;
    return registerChatTurn(selected, async () => {
      const active = streamControllerRef.current;
      if (!active || selectedRef.current !== selected) return;
      active.stopRequested = true;
      if (!await cancelChatStream(active.streamId)) throw new Error("Stream cancellation was not confirmed");
      active.controller.abort(new DOMException("Stopped", "AbortError"));
    });
  }, [sending, selected]);
  const { rowActions, rowStateRef } = useChatRowActions({ setInput, setSelectedProject, selectedRef, latestMessageRef, activeTurnRef });

  /** Prepends the previous page of the open chat and keeps the visible message in place. */
  async function loadEarlierMessages() {
    const id = selectedRef.current, stream = messageStreamRef.current;
    if (!id || business || earlierMessages <= 0 || loadingEarlierRef.current || !stream) return;
    loadingEarlierRef.current = true;
    try {
      const page = await api<{ messages: Message[]; earlier: number; cursor: string | null }>(`/conversations/${id}/messages?before=${encodeURIComponent(earlierCursorRef.current ?? String(earlierMessages))}`);
      if (selectedRef.current !== id) return;
      // The first visible message keeps its place on screen. Only the shift left after the browser's own scroll
      // anchoring is corrected (none at the very top, where browsers do not anchor), so the view never moves twice.
      const top = stream.getBoundingClientRect().top;
      const first = [...stream.querySelectorAll<HTMLElement>("[data-message-id]")].find((element) => element.getBoundingClientRect().bottom > top);
      earlierAnchorRef.current = first ? { id: first.dataset.messageId!, offset: first.getBoundingClientRect().top - top } : null;
      followBottomRef.current = false;
      setMessages((current) => [...page.messages.filter((message) => !current.some((item) => item.id === message.id)), ...current]);
      setEarlierMessages(page.earlier);
      earlierCursorRef.current = page.cursor ?? earlierCursorRef.current;
    } catch {
      // The loaded page stays as it is; scrolling up again retries.
    } finally {
      loadingEarlierRef.current = false;
    }
  }

  async function loadConversations(preferred?: string, preserveActiveTurn = false) {
    const loadVersion = ++historyLoadVersionRef.current;
    const base = business ? `/businesses/${business.id}/conversations` : "/conversations";
    if (loadVersion !== historyLoadVersionRef.current) return [] as Message[];
    const next = preferred ?? null; setSelected(next);
    if (next) {
      let loaded: Message[] = [];
      try {
        if (business) loaded = (await api<{ messages: Message[] }>(`${base}/${next}`)).messages;
        else {
          // A chat opens with its latest messages from the page's single open request; a refresh after a turn
          // reads only the latest page. Earlier messages load when the user scrolls up.
          const opened = preserveActiveTurn ? null : chatOpenData(next);
          const page = opened ? (await opened).conversation : await api<{ messages: Message[]; earlier: number; cursor?: string | null }>(`/conversations/${next}/messages`);
          loaded = (page?.messages ?? []) as Message[];
          setEarlierMessages(page?.earlier ?? 0);
          // The chat selects the company it worked in, as the user expects on opening it (owner decision, V6 step 14).
          const chatCompany = (page as { company?: { id: string } | null } | null | undefined)?.company;
          if (chatCompany?.id && chatCompany.id !== readActiveCompanyId()) {
            writeActiveCompanyId(chatCompany.id);
            window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "select", companyId: chatCompany.id } }));
          }
          // A refresh after a turn keeps the earlier pages already shown and their cursor.
          if (!preserveActiveTurn || earlierCursorRef.current === null) earlierCursorRef.current = page?.cursor ?? (loaded[0]?.id ?? null);
        }
      } catch {
        try {
          // Without the combined open request the chat still shows its latest page.
          const page = await api<{ messages: Message[]; earlier?: number }>(`/conversations/${next}${business ? "" : "/messages"}`);
          loaded = page.messages;
          setEarlierMessages(page.earlier ?? 0);
        } catch {}
      }
      if (loadVersion !== historyLoadVersionRef.current) return [] as Message[];
      if (loaded.length > 0) {
        // The active turn already has stable React keys and the final streamed text.
        // Replacing it with persisted message IDs remounts both bubbles and flashes.
        if (preserveActiveTurn) {
          setMessages(current => mergeConversationMessages(current, loaded));
          return loaded;
        }
        setMessages(loaded);
        followBottomRef.current = false;
        setOpeningPosition(`${next}:${loadVersion}`);
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

    if (initialConversationId && selectedRef.current === initialConversationId) {
      return;
    }

    followBottomRef.current = false;
    userScrolledRef.current = false;
    earlierAnchorRef.current = null;
    setOpeningPosition(null);
    setSelected(initialConversationId ?? null);
    setReplyMeta(null);
    // Opening the conversation a failed message created keeps that failure on screen.
    if (!(typeof carriedNotice?.chatNotice === "string" && carriedNotice.chatNoticeFor === initialConversationId)) setNotice("");
    if (!initialConversationId || !selectedRef.current) {
      setActiveTurn("");
      resetProgress();
    }
    if (initialConversationId) {
      setMessages([]);
      setActiveTurn("");
      setLoadingHistory(true);
      void loadConversations(initialConversationId).finally(() => setLoadingHistory(false));
    } else {
      setMessages([]);
      setLoadingHistory(false);
      void loadConversations();
    }
  }, [business?.id, initialConversationId]);
  useEffect(() => {
    const handleImageLoaded = () => {
      if (!activeTurn) {
        scrollToBottom("auto");
      }
    };
    window.addEventListener("npati:chat-image-loaded", handleImageLoaded);
    return () => window.removeEventListener("npati:chat-image-loaded", handleImageLoaded);
  }, [activeTurn, scrollToBottom]);
  useLayoutEffect(() => {
    const anchor = earlierAnchorRef.current, stream = messageStreamRef.current;
    if (!anchor || !stream) return;
    earlierAnchorRef.current = null;
    const element = stream.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
    const shift = element ? element.getBoundingClientRect().top - stream.getBoundingClientRect().top - anchor.offset : 0;
    // Instant: the chat area scrolls smoothly by default, and an animated correction would leave the view at the top.
    if (Math.abs(shift) > 1) stream.scrollTo({ top: stream.scrollTop + shift, behavior: "instant" as ScrollBehavior });
  }, [messages]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => scrollToBottom("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [messages, sending, scrollToBottom]);
  useEffect(() => () => {
    streamControllerRef.current?.controller.abort();
  }, []);
  async function submitInbox(mode: "queue" | "steer") {
    const session = codeInbox.session;
    const text = input.trim();
    if (!session || !text || inboxMutationBusy.current) return;
    if (attachments.length || noMemory || ttsEnabled) { setNotice(t("codeInbox.textOnly")); return; }
    cancelOpeningPosition();
    followBottomRef.current = true;
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
  /**
   * While a run waits for an answer, the next message is that answer. The waiting run does not continue by itself, so
   * the answer is recorded on the question and then sent as the next turn, whose history already holds the question.
   */
  async function answerWaitingQuestion(): Promise<"answered" | "stopped" | false> {
    const session = codeInbox.session, runId = codeInbox.snapshot?.runId ?? development.project?.runId, text = input.trim(), company = session?.companyId;
    if (!session || !runId || !text || !company) return false;
    const path = `/companies/${encodeURIComponent(company)}/code`;
    const pending = await api<{ waiting: boolean; question: { id: string; revision: number } | null; runStatus?: string | null }>(`${path}/runs/${encodeURIComponent(runId)}/question`).catch(() => null);
    // A run that stopped (an answered question, a server restart) still marks its session busy, but nothing reads that queue.
    if (!pending?.waiting || !pending.question) return ["interrupted", "failed", "cancelled", "completed"].includes(pending?.runStatus ?? "") ? "stopped" : false;
    await api(`${path}/sessions/${encodeURIComponent(session.sessionId)}/questions/${encodeURIComponent(pending.question.id)}/answer`, { method: "POST", body: JSON.stringify({ revision: pending.question.revision, freeAnswer: text }) });
    return "answered";
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (development.openingProjectChat) return; // the draft stays; the chat it belongs to is still opening
    if (!noMemory && !attachments.length && !sending && !chatSubmissionBusy.current && await development.submit(input.trim())) return;
    const boundProjectId = development.activeProject?.projectId ?? (selectedProject?.conversationId === selected ? selectedProject.projectId : undefined) ?? development.project?.projectId ?? codeInbox.session?.projectId;
    const nextIntent = defaultHybridRouter.classifyProject({ message: input.trim(), activeProjectId: boundProjectId, activeCompanyId: companyId ?? readActiveCompanyId() });
    const createsProject = nextIntent.intent === "CREATE_WEBSITE" || nextIntent.intent === "CREATE_PROJECT";
    // The inbox queues work for its own session; a request for another project of this chat goes through routing.
    // An answer, or a message after a stopped run, starts the next turn instead of waiting in that run's queue.
    const heldRunDone = codeInbox.active && await answerWaitingQuestion();
    if (codeInbox.active && !heldRunDone && !createsProject && (!boundProjectId || codeInbox.session?.projectId === boundProjectId) && (codeInbox.snapshot ? true : await codeInbox.confirmActive())) { await submitInbox("queue"); return; }
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
    cancelOpeningPosition();
    thinking.start(message);
    const mutationContext = companyId ? "company" : business ? "business" : "none";
    const pendingMutation = detectChatMutationOperation(requestMessage, mutationContext);
    const mutationTargets = pendingMutation
      ? mutationProgressTargets(requestMessage, mutationContext)
      : [];
    setActiveTurn(optimisticContent);
    const optimisticMessage: Message = { id: optimisticId, role: "user", content: optimisticContent, createdAt: new Date().toISOString(), attachments: sentAttachments };
    setMessages((current) => [...current, optimisticMessage]);
    resetProgress();
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

    // Streamed text is applied at most once per frame: many small deltas would otherwise re-render the list each.
    let deltaFrame = 0;
    const appendDelta = (chunk: string) => {
      rawAssistantContent += chunk;
      if (!deltaFrame) deltaFrame = window.requestAnimationFrame(commitDelta);
    };
    const settleDelta = () => {
      if (!deltaFrame) return;
      window.cancelAnimationFrame(deltaFrame);
      commitDelta();
    };
    const commitDelta = () => {
      deltaFrame = 0;
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

    const activeCompanyForRequest = (!createsProject ? (development.activeProject ?? development.project)?.companyId : null) ?? (!createsProject && selectedProject?.conversationId === selected ? selectedProject.companyId : null) ?? companyId ?? readActiveCompanyId();
    let activeProjectId: string | undefined;
    const projectIntent = defaultHybridRouter.classifyProject({ message: requestMessage, activeProjectId: boundProjectId, activeCompanyId: activeCompanyForRequest });
    const isNewProjectRequest = projectIntent.intent === "CREATE_WEBSITE" || projectIntent.intent === "CREATE_PROJECT";
    if (!isNewProjectRequest) {
      // The chat's selection follows its newest development project and the server's routed replies.
      if (development.activeProject?.companyId === activeCompanyForRequest) activeProjectId = development.activeProject.projectId;
      else if (selectedProject?.conversationId === selected && selectedProject.companyId === activeCompanyForRequest) activeProjectId = selectedProject.projectId;
      else if (development.project?.companyId === activeCompanyForRequest) activeProjectId = development.project.projectId;
      else if (latestCard?.companyId === activeCompanyForRequest) activeProjectId = latestCard.projectId ?? latestCard.id;
      try {
        const stored = sessionStorage.getItem("npati_active_project");
        if (stored) {
          const active = JSON.parse(stored) as { companyId?: string; projectId?: string; conversationId?: string };
          if (!activeProjectId && selected && active.conversationId === selected && active.companyId === activeCompanyForRequest) activeProjectId = active.projectId;
        }
      } catch {}
    }
    let startedConversationId: string | undefined;
    try {
      const result = await streamChat<AgentReply>({
        message: requestMessage,
        conversationId: selected ?? undefined,
        attachments: sentAttachments,
        contextType: activeProjectId ? "project" : companyId ? "company" : (business ? "business" : "none"),
        ...(activeCompanyForRequest && (companyId || activeProjectId) ? { companyId: activeCompanyForRequest } : {}),
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
        ...(workMode === "code" ? { mode: "code" as const } : {}),
        noMemory: privateRequest,
        streamId,
      }, enqueueProgress, {
        signal: controller.signal,
        onCodeSession: (session) => { if (streamControllerRef.current?.controller === controller && selectedChatRef.current === conversationAtSubmit) codeInbox.accept(session, conversationAtSubmit); },
        onCodeInbox: (sessionId) => { if (streamControllerRef.current?.controller === controller) codeInbox.refresh(sessionId); },
        onConversation: (id) => { startedConversationId = id; },
        onDelta: appendDelta,
      });
      const finalMutationTarget = mutationTargets.at(-1);
      if (finalMutationTarget) enqueueProgress({ type: "action_completed", ...finalMutationTarget, timestamp: new Date().toISOString() });
      settleDelta();
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
        // The server may route a follow-up to another project of this chat ("У грі …"); later turns continue there.
        if (result.activeContext.companyId && selectedProject?.conversationId === conversationAtSubmit && selectedChatRef.current === conversationAtSubmit) setSelectedProject({ companyId: result.activeContext.companyId, projectId: result.activeContext.projectId, conversationId: selectedProject.conversationId });
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
      settleDelta();
      const typed = reason as Error & { code?: string };
      if (typed.message?.includes("Project not found") || (typed as any).code === "WORKSPACE_NOT_FOUND" || (typed as any).status === 404) {
        try { sessionStorage.removeItem("npati_active_project"); } catch {}
      }
      // Stopped (or cut off) in a new chat: the server already saved this message in a conversation, so the chat moves there
      // and the next message continues it instead of starting another one. Stop ends the server stream first, so this is
      // not always an AbortError.
      const stoppedByPerson = typed.name === "AbortError" || (streamControllerRef.current?.controller === controller && streamControllerRef.current.stopRequested === true);
      if (startedConversationId && !privateRequest && !selected && selectedChatRef.current === conversationAtSubmit) {
        keepNoticeOnSelectRef.current = true;
        setSelected(startedConversationId);
        // /c/:id is another route, so the chat mounts again: a failure travels with the navigation and is shown there.
        navigate(`/c/${startedConversationId}`, { replace: true, state: { ...(business ? {} : { neutralChat: true }), ...(stoppedByPerson ? {} : { chatNotice: typed.message, chatNoticeFor: startedConversationId }) } });
      }
      // A stop ends the server stream first, so the read may end with "no result" before the abort lands; it is still a stop.
      if (typed.name === "AbortError" || (streamControllerRef.current?.controller === controller && streamControllerRef.current.stopRequested)) {
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
      settleDelta();
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
  rowStateRef.current = { displayMessages, activeTurn };
  const timeline = chatTimeline(displayMessages, development.project?.progress, selected, development.project, earlierMessages > 0, development.conversationProcesses);
  // While the agent works in this chat, an open Preview stays but none is offered for the state it is changing.
  const agentWorking = sending || codeInbox.active || Boolean(development.project && developmentIsActive(development.project));
  // Resolve the card once, then anchor it to the closing reply below.
  const timelineCard = timeline.flatMap(entry => {
    if (entry.kind !== "message") return [];
    const card = development.card(displayMessages, entry.index);
    return card ? [card] : [];
  }).at(-1);
  const fallbackCard = entryProjectCard || (development.project?.projectId && development.project.companyId ? {
    id: development.project.projectId,
    projectId: development.project.projectId,
    companyId: development.project.companyId,
    name: development.project.name,
    status: development.project.status,
    framework: development.project.framework,
    previewUrl: development.project.previewUrl,
    kind: "code_project" as const
  } : null);
  // The whole run's time belongs under the reply that closes it, not under an unrelated later answer.
  const runActivity = development.project && !agentWorking ? normalizeActivity(development.project.progress) : [];
  const runEndedAt = Math.max(0, ...runActivity.map(item => (Date.parse(item.at) || 0) + (item.durationMs ?? 0)));
  const latestReplyAt = Date.parse(displayMessages.at(-1)?.createdAt ?? "") || 0;
  const runTotal = runEndedAt && Math.abs(latestReplyAt - runEndedAt) < 120_000 ? processDuration(runActivity) : undefined;
  const bottomCard = timelineCard ?? fallbackCard;
  const previewAnchor = developmentPreviewAnchor(timeline, development.project);
  const projectPreview = bottomCard && !agentWorking ? (
      <ChatProjectPreviewCard card={bottomCard} showPreviewTrigger onActivate={(card) => setSelectedProject({ companyId: card.companyId, projectId: card.projectId ?? card.id, conversationId: selected })} />
  ) : null;
  return (
    <ChatPreviewOpenContext.Provider value={openPreviews}>
    <ChatPreviewPanelProvider busy={agentWorking} conversationId={selected}>
    <ChatFileViewerProvider busy={agentWorking}>
      {notice && (
        <FloatingNotice
          message={notice}
          tone={notice.startsWith("Saved") ? "success" : "error"}
          onClose={() => setNotice("")}
          action={/provider/i.test(notice) ? <Link to="/settings/ai">Open AI Marketplace →</Link> : undefined}
        />
      )}
      <div className="onboarding-live-chat standard-live-chat">
        <div className="message-stream" ref={messageStreamRef} onScroll={() => { if (!messageStreamRef.current) return; if (!openingPosition || userScrolledRef.current || sending) followBottomRef.current = nearChatBottom(messageStreamRef.current); if (userScrolledRef.current && messageStreamRef.current.scrollTop < EARLIER_MESSAGES_THRESHOLD_PX) void loadEarlierMessages(); }}
          onPointerDown={() => { cancelOpeningPosition(); userScrolledRef.current = true; }}
          onWheel={() => { cancelOpeningPosition(); userScrolledRef.current = true; }} onTouchMove={() => { cancelOpeningPosition(); userScrolledRef.current = true; }} onKeyDown={() => { cancelOpeningPosition(); userScrolledRef.current = true; }}>
          {messages.length === 0 && !selected && !initialConversationId && !loadingHistory && (
            <div className="chat-welcome">
              <h2>{t("chat.emptyTitle")}</h2>
              <p>{business ? t("chat.businessEmptySubtitle", { name: business.name }) : t("chat.emptySubtitle")}</p>
            </div>
          )}
          {timeline.map((entry, timelineIndex) => {
            if (entry.kind === "activity") return <ChatDevelopmentProgress key={"activity:" + entry.item.id} process={entry.process ?? development.project} items={entry.run?.items ?? [entry.item]} run={entry.run} animatePending={!thinking.visible} preview={timelineIndex === previewAnchor ? projectPreview : undefined} />;
            const { message, index } = entry;
            if (development.hideMessage(displayMessages, index)) return timelineIndex === previewAnchor && projectPreview ? <article className="assistant" key={message.id}>{projectPreview}</article> : null;
            const resolvedCard = development.card(displayMessages, index);
            const messageCard = timelineIndex === previewAnchor && !agentWorking ? bottomCard : resolvedCard && (resolvedCard.projectId ?? resolvedCard.id) !== (bottomCard?.projectId ?? bottomCard?.id) ? resolvedCard : null;
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
                <ChatMessageRow message={message} card={messageCard} showToolbar={message.role === "assistant" && !sending} previewBusy={agentWorking}
                  responseLanguage={messageLanguage(displayMessages.slice(0, index + 1).reverse().find((item) => item.role === "user")?.content, development.project?.responseLanguage ?? language)} totalTime={isLatestAssistant ? runTotal : undefined} actions={rowActions} />
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
          {/* A run started from the chat waits for its confirmation too, not only a development process run. */}
          {agentWorking && (development.project?.companyId ?? companyId) && <ChatRunApprovals language={messageLanguage([...messages].reverse().find(message => message.role === "user")?.content, development.project?.responseLanguage ?? language)} companyId={(development.project?.companyId ?? companyId)!} runId={development.project && developmentIsActive(development.project) ? development.project.runId ?? null : null} projectIds={[development.project?.projectId, development.activeProject?.projectId, selectedProject?.projectId, codeInbox.session?.projectId].filter((id): id is string => Boolean(id))} />}
          {thinking.visible && <ChatThinking key="turn-thinking" text={thinking.text} />}
          {previewAnchor < 0 && projectPreview && <article className="assistant">{projectPreview}</article>}
          {!bottomCard && development.preview}
          {messages.length > 0 && <div className="chat-scroll-spacer" aria-hidden="true" />}
          <div ref={streamEndRef} aria-hidden="true" />
        </div>
        {replyMeta?.memoryCandidate && <div className="memory-candidate"><div><strong>Remember this?</strong><p>{replyMeta.memoryCandidate.title}: {replyMeta.memoryCandidate.content}</p></div><button onClick={() => void remember()}>Remember</button><button onClick={() => setReplyMeta({ ...replyMeta, memoryCandidate: undefined })}>Not now</button></div>}
        <BusinessChatComposer
          input={input}
          setInput={setInput}
          attachments={attachments}
          setAttachments={setAttachments}
          draftVersion={draftVersion}
          sending={sending}
          developmentActive={development.isActive}
          onStopDevelopment={development.stop}
          codeInbox={codeInbox}
          inboxSubmitting={inboxSubmitting || development.openingProjectChat}
          inputDisabled={development.openingProjectChat}
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
          workMode={workMode}
          onWorkModeChange={changeWorkMode}
          projectSelected={Boolean(development.project?.projectId ?? codeInbox.session?.projectId ?? (selectedProject?.conversationId === selected ? selectedProject?.projectId : undefined))}
        />
      </div>
    </ChatFileViewerProvider>
    </ChatPreviewPanelProvider>
    </ChatPreviewOpenContext.Provider>
  );
}
