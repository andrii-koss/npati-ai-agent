import { getStoredAuthToken, useAuth } from "./AuthContext";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import type { AgentReply } from "@npati/shared";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useContext, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BusinessChatPage, ChatContextSwitcherContext, FloatingNotice, useWorkspace } from "./BusinessWorkspace";
import { ChatMessageContent } from "./ChatMessageContent";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { cancelChatStream, streamChat } from "./chat-stream";
import { confirmModal } from "./ConfirmDialog";

type Message = { id: string; role: "user" | "assistant" | "system"; content: string };
type Scenario = "existing" | "starting" | "seller";

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch("/api" + url, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(getStoredAuthToken() ? { authorization: "Bearer " + getStoredAuthToken() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "Request failed with HTTP " + response.status);
  }
  return response.json() as Promise<T>;
}

const onboardingThinkingSteps = [
  "Thinking…",
  "Checking your answer…",
  "Preparing the next question…",
];
const researchThinkingSteps = [
  "Researching the web…",
  "Reading public sources…",
  "Analyzing findings…",
];

function isResearchRequest(message?: string) {
  return Boolean(message && (/https?:\/\//i.test(message) || /competitor|competition|web research|search the web|конкурент|досліди|аналізуй/iu.test(message)));
}

function BusinessConversation({ initialPrompt = "", initialConversationId, businessSetup = false, businessId }: { initialPrompt?: string; initialConversationId?: string; businessSetup?: boolean; businessRoute?: boolean; businessId?: string }) {
  const { overview, refresh } = useWorkspace();
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
  const business = overview?.currentBusiness;
  const session = businessId && businessId !== "new"
    ? overview?.onboardings.find((item) => item.businessId === businessId)
    : (businessId === "new" ? undefined : overview?.onboarding);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [researching, setResearching] = useState(false);
  const [error, setError] = useState("");
  const [providerConnected, setProviderConnected] = useState<boolean | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const activeTurnRef = useRef<HTMLElement>(null);
  const latestMessageRef = useRef<HTMLElement>(null);
  const legacyCompletionRef = useRef("");
  const [activeTurn, setActiveTurn] = useState("");
  const [handoffConversationId, setHandoffConversationId] = useState("");

  async function loadHistory(businessId: string, conversationId: string) {
    const value = await request<{ messages: Message[] }>("/businesses/" + businessId + "/conversations/" + conversationId);
    setMessages(value.messages);
  }

  useEffect(() => {
    request<{ overview?: { connectedProviders?: number } }>("/ai/marketplace?tab=connected&limit=1")
      .then((value) => setProviderConnected((value?.overview?.connectedProviders ?? 0) > 0))
      .catch(() => setProviderConnected(false));
  }, []);
  useEffect(() => {
    if (session) void loadHistory(session.businessId, session.conversationId).catch(() => setMessages([]));
  }, [session?.id, session?.updatedAt]);
  useEffect(() => {
    if (!sending) { setThinkingStep(0); return; }
    const steps = researching ? researchThinkingSteps : onboardingThinkingSteps;
    const timer = window.setInterval(() => setThinkingStep((step) => Math.min(step + 1, steps.length - 1)), 1200);
    return () => window.clearInterval(timer);
  }, [sending, researching]);
  useEffect(() => {
    if (sending) {
      const frame = window.requestAnimationFrame(() => {
        streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (messages.length > 0) {
      const frame = window.requestAnimationFrame(() => {
        if (latestMessageRef.current) {
          latestMessageRef.current.scrollIntoView({ behavior: "auto", block: "start" });
        } else {
          streamEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages, sending]);

  async function act(payload: { onboardingAction?: string; scenario?: Scenario; message?: string }) {
    if (sending) return;
    const optimisticId = payload.message ? `pending-${Date.now()}` : "";
    if (payload.message) {
      setActiveTurn(payload.message);
      setMessages((current) => [...current, { id: optimisticId, role: "user", content: payload.message! }]);
      setInput("");
    }
    setSending(true);
    setResearching(isResearchRequest(payload.message));
    setError("");
    try {
      const result = await request<AgentReply>("/chat", businessSetup ? { ...payload, businessSetup: true, businessId: session?.businessId ?? (businessId && businessId !== "new" ? businessId : undefined) } : payload);
      if (result.conversationId && !businessSetup) {
        setHandoffConversationId(result.conversationId);
        window.history.replaceState(null, "", `/c/${result.conversationId}`);
        window.dispatchEvent(new Event("npati:conversations-changed"));
      }
      if (result.onboarding) {
        window.history.replaceState(null, "", `/b/${result.onboarding.business.id}`);
        await loadHistory(String(result.onboarding.business.id), result.onboarding.conversationId);
        window.dispatchEvent(new Event("npati:conversations-changed"));
      }
      await refresh();
    } catch (reason) {
      if (optimisticId) setMessages((current) => current.filter((message) => message.id !== optimisticId));
      if (payload.message) setInput(payload.message);
      setError(reason instanceof Error ? reason.message : "Could not continue onboarding.");
    } finally {
      setSending(false);
      setResearching(false);
    }
  }

  useEffect(() => {
    if (session?.status !== "awaiting_confirmation" || sending || legacyCompletionRef.current === session.id) return;
    legacyCompletionRef.current = session.id;
    void act({ onboardingAction: "confirm" });
  }, [session?.id, session?.status, sending]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (input.trim()) void act({ message: input.trim() });
  }

  function sendOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function startOver() {
    if (!session || sending) return;
    const confirmed = await confirmModal({
      title: "Restart business setup?",
      message: "Start business setup over? The current draft and its chat history will be deleted. This cannot be undone.",
      confirmText: "Restart setup",
      cancelText: "Cancel",
      isDanger: true,
    });
    if (!confirmed) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/businesses/" + session.businessId, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "Could not restart business setup.");
      }
      setMessages([]);
      setInput("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restart business setup.");
    } finally {
      setSending(false);
    }
  }

  if (!businessSetup && (business || !session)) return <BusinessChatPage initialPrompt={initialPrompt} initialConversationId={handoffConversationId || initialConversationId} />;

  if (!session) return (
    <>
      {providerConnected === false && (
        <FloatingNotice
          message="Connect an AI provider to start conversational onboarding."
          tone="error"
          onClose={() => setProviderConnected(null)}
          action={<Link to="/settings/ai">Open AI Marketplace →</Link>}
        />
      )}
      {error && (
        <FloatingNotice
          message={error}
          tone="error"
          onClose={() => setError("")}
          action={/provider/i.test(error) ? <Link to="/settings/ai">Open AI Marketplace →</Link> : undefined}
        />
      )}
      <div className="onboarding-live-chat standard-live-chat onboarding-empty-chat">
        <div className="message-stream">
          <div className="chat-welcome">
            <h2>What should we work on?</h2>
            <p>Ask NPATI Agent anything, or brainstorm ideas.</p>
          </div>
          {messages.map((message, index) => (
            <article
              ref={(el) => {
                if (index === messages.length - 1) {
                  latestMessageRef.current = el;
                }
                if (message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn)) {
                  activeTurnRef.current = el;
                }
              }}
              key={message.id}
              className={message.role}
              aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}
            >
              <ChatMessageContent content={message.content} />
            </article>
          ))}
          {sending && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{(researching ? researchThinkingSteps : onboardingThinkingSteps)[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          <div ref={streamEndRef} aria-hidden="true" />
          {messages.length > 0 && <div className="chat-scroll-spacer" aria-hidden="true" />}
        </div>
        <form className="onboarding-live-composer" onSubmit={submit}>
          {contextSwitcher}
          <AutoResizeChatTextarea aria-label="Chat message" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} disabled={sending} placeholder="Type your answer…" autoFocus />
          <div>
            <button
              type="submit"
              className="chat-send-btn"
              disabled={sending || !input.trim()}
              aria-label="Send"
              title="Send"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="12" x2="20" y2="12" />
                <polyline points="14 6 20 12 14 18" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </>
  );

  const added = session.completedFields.length;
  const onboardingSuggestions = [
    "Help me brainstorm business ideas",
    "How do I research market demand?",
    "Explain how NPATI Agent works",
  ];
  return (
    <>
      {error && (
        <FloatingNotice
          message={error}
          tone="error"
          onClose={() => setError("")}
          action={/provider/i.test(error) ? <Link to="/settings/ai">Open AI Marketplace →</Link> : undefined}
        />
      )}
      <div className="onboarding-progress">
        <div>
          <strong>Setting up your business</strong>
          <span>{added} of {session.totalFields} quick steps completed</span>
        </div>
        <div><i style={{ width: Math.round((session.currentStep / session.totalFields) * 100) + "%" }} /></div>
      </div>
      <div className="onboarding-live-chat standard-live-chat">
        <div className="message-stream">
          {messages.length === 0 && !session?.conversationId && (
            <div className="chat-welcome">
              <h2>What should we work on?</h2>
              <p>Ask NPATI Agent anything, or brainstorm ideas.</p>
            </div>
          )}
          {messages.map((message, index) => (
            <article
              ref={(el) => {
                if (index === messages.length - 1) {
                  latestMessageRef.current = el;
                }
                if (message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn)) {
                  activeTurnRef.current = el;
                }
              }}
              key={message.id}
              className={message.role}
              aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}
            >
              <ChatMessageContent content={message.content} />
            </article>
          ))}
          {sending && (
            <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working">
              <p>{(researching ? researchThinkingSteps : onboardingThinkingSteps)[thinkingStep]}</p>
              <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            </article>
          )}
          <div ref={streamEndRef} aria-hidden="true" />
          {messages.length > 0 && <div className="chat-scroll-spacer" aria-hidden="true" />}
        </div>
        {session.status === "paused" && (
          <div className="onboarding-actions">
            <span>Your progress is saved.</span>
            <button className="button-primary" onClick={() => void act({ onboardingAction: "resume" })}>Continue onboarding</button>
            <button className="button-secondary" onClick={() => void startOver()}>Start over</button>
          </div>
        )}
        {session.status === "awaiting_confirmation" && <div className="onboarding-actions"><span>Finishing business setup…</span></div>}
        {session.status === "active" && (
          <>
            <form className="onboarding-live-composer" onSubmit={submit}>
              {contextSwitcher}
              <AutoResizeChatTextarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} placeholder="Type your answer…" autoFocus />
              <div>
                <button
                  type="submit"
                  className="chat-send-btn"
                  disabled={sending || !input.trim()}
                  aria-label="Send"
                  title="Send"
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <polyline points="14 6 20 12 14 18" />
                  </svg>
                </button>
              </div>
            </form>
            <div className="onboarding-live-actions">
              <button disabled={sending} onClick={() => void act({ onboardingAction: "skip" })}>Skip</button>
              <button disabled={sending} onClick={() => void act({ onboardingAction: "pause" })}>Continue later</button>
              <Link to="/settings/business">Edit profile manually</Link>
              <button className="danger" disabled={sending} onClick={() => void startOver()}>Start over</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

type ChatProps = { initialPrompt?: string; initialConversationId?: string; neutralChat?: boolean; businessSetup?: boolean; businessRoute?: boolean; businessId?: string };
export function ConversationalChat(props: ChatProps) {
  const { user } = useAuth();
  const chatKey = `${user?.id ?? "anonymous"}:${props.initialConversationId ?? "root"}:${props.businessSetup ? "business-setup" : props.businessRoute ? "business" : "chat"}`;
  return <ContextChat key={chatKey} {...props} userId={user?.id} />;
}
function ContextChat({ userId, neutralChat, businessSetup, businessRoute, ...props }: ChatProps & { userId?: string }) {
  const { overview } = useWorkspace();
  const key = "npati_chat_context:" + (userId ?? "anonymous");
  const readStoredSelection = () => {
    try {
      const activeCompanyId = readActiveCompanyId();
      if (activeCompanyId) return `company:${activeCompanyId}`;
      return sessionStorage.getItem(key) ?? localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const persistSelection = (value: string) => {
    try { sessionStorage.setItem(key, value); } catch {}
    try { localStorage.setItem(key, value); } catch {}
    writeActiveCompanyId(value.startsWith("company:") ? value.slice(8) : "");
  };
  const [selection, setSelection] = useState(() => {
    if (businessRoute) return "business";
    const stored = readStoredSelection();
    if (stored && stored.startsWith("company:")) return stored;
    return "none";
  });
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let active = true;
    const loadCompanies = async (preferredCompanyId?: string) => {
      const value = await request<{ companies: Array<{ id: string; name: string }> }>("/companies?limit=100");
      if (!active) return;
      setCompanies(value.companies);
      if (businessRoute || businessSetup) return;
      setSelection((current) => {
        const preferred = preferredCompanyId ? `company:${preferredCompanyId}` : "";
        if (preferred && value.companies.some((company) => `company:${company.id}` === preferred)) {
          persistSelection(preferred);
          return preferred;
        }
        if (current.startsWith("company:") && value.companies.some((company) => `company:${company.id}` === current)) {
          persistSelection(current);
          return current;
        }
        const stored = readStoredSelection();
        if (stored?.startsWith("company:") && value.companies.some((company) => `company:${company.id}` === stored)) {
          persistSelection(stored);
          return stored;
        }
        const fallback = "none";
        persistSelection(fallback);
        return fallback;
      });
    };
    const handleCompanyChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; companyId?: string }>).detail;
      void loadCompanies(detail?.action === "create" ? detail.companyId : undefined).catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not refresh companies");
      });
    };
    window.addEventListener("npati:company-changed", handleCompanyChanged);
    if (userId) {
      void loadCompanies()
        .catch((e) => {
          if (active) setError(e.message);
        });
    }
    return () => {
      active = false;
      window.removeEventListener("npati:company-changed", handleCompanyChanged);
    };
  }, [userId, key, businessRoute, businessSetup]);

  async function choose(value: string) {
    setSwitching(true);
    setError("");
    try {
      setSelection(value);
      persistSelection(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch context");
    } finally {
      setSwitching(false);
    }
  }

  const selectValue = selection.startsWith("company:")
    ? (companies.some((c) => "company:" + c.id === selection) ? selection : (companies[0] ? "company:" + companies[0].id : "none"))
    : "none";

  const activeCompanyName = companies.find((c) => "company:" + c.id === selectValue)?.name;

  const setupSwitcher = (
    <div className="composer-context-switcher" title="Active context">
      <div className="composer-context-trigger" aria-hidden="true">
        <span className="composer-context-text">Business setup</span>
        <svg className="composer-context-icon" viewBox="0 0 10 6" width="10" height="6" fill="none">
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <select aria-label="Active context" value="business-setup" disabled className="composer-context-select">
        <option value="business-setup">Business setup</option>
      </select>
    </div>
  );

  const switcher = (
    <div className="composer-context-switcher" title={activeCompanyName || "Active context"}>
      <div className="composer-context-trigger" aria-hidden="true">
        <span className="composer-context-text">
          {activeCompanyName || "No company"}
        </span>
        <svg className="composer-context-icon" viewBox="0 0 10 6" width="10" height="6" fill="none">
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <select
        aria-label="Active context"
        value={selectValue}
        disabled={switching}
        onChange={(e) => void choose(e.target.value)}
        className="composer-context-select"
      >
        <option value="none">No company</option>
        {companies.map((c) => (
            <option key={c.id} value={"company:" + c.id} title={c.name}>
              {c.name}
            </option>
          ))}
      </select>
    </div>
  );

  if (businessSetup) {
    return (
      <ChatContextSwitcherContext.Provider value={setupSwitcher}>
        <BusinessConversation {...props} businessSetup />
      </ChatContextSwitcherContext.Provider>
    );
  }

  if (businessRoute) {
    return (
      <ChatContextSwitcherContext.Provider value={null}>
        <BusinessConversation {...props} businessRoute />
      </ChatContextSwitcherContext.Provider>
    );
  }

  return (
    <ChatContextSwitcherContext.Provider value={switcher}>
      {error && (
        <FloatingNotice
          message={error}
          tone="error"
          onClose={() => setError("")}
          action={/provider/i.test(error) ? <Link to="/settings/ai">Open AI Marketplace →</Link> : undefined}
        />
      )}
      <BusinessChatPage
        key={`${key}:${props.initialConversationId ?? "root"}`}
        {...props}
        neutralChat={selectValue === "none"}
        companyId={selectValue.startsWith("company:") ? selectValue.slice(8) : undefined}
      />
    </ChatContextSwitcherContext.Provider>
  );
}

