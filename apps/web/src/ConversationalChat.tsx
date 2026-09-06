import { getStoredAuthToken, useAuth } from "./AuthContext";
import type { AgentReply } from "@npati/shared";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useContext, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BusinessChatPage, ChatContextSwitcherContext, useWorkspace } from "./BusinessWorkspace";
import { ChatMessageContent } from "./ChatMessageContent";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";

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

function BusinessConversation({ initialPrompt = "", initialConversationId }: { initialPrompt?: string; initialConversationId?: string }) {
  const { overview, refresh } = useWorkspace();
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
  const business = overview?.currentBusiness;
  const session = overview?.onboarding;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [researching, setResearching] = useState(false);
  const [error, setError] = useState("");
  const [providerConnected, setProviderConnected] = useState<boolean | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const activeTurnRef = useRef<HTMLElement>(null);
  const legacyCompletionRef = useRef("");
  const [activeTurn, setActiveTurn] = useState("");
  const [handoffConversationId, setHandoffConversationId] = useState("");

  async function loadHistory(businessId: string, conversationId: string) {
    const value = await request<{ messages: Message[] }>("/businesses/" + businessId + "/conversations/" + conversationId);
    setMessages(value.messages);
  }

  useEffect(() => {
    fetch("/api/ai/marketplace?tab=connected&limit=1").then((response) => response.json())
      .then((value) => setProviderConnected(value?.overview?.connectedProviders > 0)).catch(() => setProviderConnected(false));
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
    const frame = window.requestAnimationFrame(() => {
      if (activeTurn && activeTurnRef.current) activeTurnRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      else streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, activeTurn]);

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
      const result = await request<AgentReply>("/chat", payload);
      if (result.conversationId) {
        setHandoffConversationId(result.conversationId);
        navigate(`/c/${result.conversationId}`, { replace: true });
      }
      if (result.onboarding) await loadHistory(String(result.onboarding.business.id), result.onboarding.conversationId);
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
    if (!session || sending || !window.confirm("Start business setup over? The current draft and its chat history will be deleted. This cannot be undone.")) return;
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

  if (business || !session) return <BusinessChatPage initialPrompt={initialPrompt} initialConversationId={handoffConversationId || initialConversationId} />;

  if (!session) return (
    <>
      {providerConnected === false && (
        <div className="workspace-notice error">
          Connect an AI provider to start conversational onboarding.
          <Link to="/settings/ai">Open AI Marketplace →</Link>
        </div>
      )}
      {error && <div className="workspace-notice error">{error}</div>}
      <div className="onboarding-live-chat standard-live-chat onboarding-empty-chat">
        <div className="message-stream">
          <div className="chat-welcome">
            <span>N</span>
            <h2>What should we work on?</h2>
            <p>Tell me where you are today. I’ll build the initial business context from one useful answer and won’t invent missing facts.</p>
            <div>
              {([
                ["existing", "I already have a business"],
                ["starting", "I want to start a business"],
                ["seller", "I want to sell something"],
              ] as const).map(([scenario, title]) => (
                <button key={scenario} disabled={sending || providerConnected === false} onClick={() => void act({ onboardingAction: "start", scenario })}>{title}</button>
              ))}
            </div>
          </div>
          {messages.map((message, index) => <article ref={message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn) ? activeTurnRef : undefined} key={message.id} className={message.role} aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}><ChatMessageContent content={message.content} /></article>)}
          {sending && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{(researching ? researchThinkingSteps : onboardingThinkingSteps)[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          <div ref={streamEndRef} aria-hidden="true" />
          <div className="chat-scroll-spacer" aria-hidden="true" />
        </div>
        <form className="onboarding-live-composer" onSubmit={submit}>
          {contextSwitcher}
          <AutoResizeChatTextarea aria-label="Chat message" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} disabled={sending || providerConnected === false} placeholder="Describe what you want to work on…" autoFocus />
          <div><button disabled={sending || providerConnected === false || !input.trim()}>Send →</button></div>
        </form>
        <p className="onboarding-start-manual">Prefer a form? <Link to="/business">Set up manually</Link></p>
      </div>
    </>
  );

  const added = session.completedFields.length;
  const recoveryQuestion: Record<string, string> = {
    businessSnapshot: "Tell me about the business in one useful message. Include what you want to sell, where, and for whom; add any other details you already know.",
    businessGoal: "What is the first meaningful goal you want to achieve? Example: “I want to get my first 1,000 customers.”",
  };
  return (
    <>
      {error && (
        <div className="workspace-notice error">
          {error}
          {/provider/i.test(error) && <Link to="/settings/ai">Open AI Marketplace →</Link>}
        </div>
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
          {messages.length === 0 && (
            <article className="assistant" aria-label="NPATI Agent message">
              <p>{recoveryQuestion[session.currentField ?? ""] ?? "Let’s continue setting up your business. Tell me a little about it."}</p>
            </article>
          )}
          {messages.map((message, index) => (
            <article ref={message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn) ? activeTurnRef : undefined} key={message.id} className={message.role} aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}>
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
          <div className="chat-scroll-spacer" aria-hidden="true" />
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
              <div><button disabled={sending || !input.trim()}>Send →</button></div>
            </form>
            <div className="onboarding-live-actions">
              <button disabled={sending} onClick={() => void act({ onboardingAction: "skip" })}>Skip</button>
              <button disabled={sending} onClick={() => void act({ onboardingAction: "pause" })}>Continue later</button>
              <Link to="/business">Edit profile manually</Link>
              <button className="danger" disabled={sending} onClick={() => void startOver()}>Start over</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

type ChatProps = { initialPrompt?: string; initialConversationId?: string; neutralChat?: boolean };
export function ConversationalChat(props: ChatProps) {
  const { user } = useAuth();
  const chatKey = `${user?.id ?? "anonymous"}:${props.initialConversationId ?? "root"}`;
  return <ContextChat key={chatKey} {...props} userId={user?.id} />;
}
function ContextChat({ userId, neutralChat, ...props }: ChatProps & { userId?: string }) {
  const { overview, switchBusiness } = useWorkspace();
  const key = "npati_chat_context:" + (userId ?? "anonymous");
  const [selection, setSelection] = useState(() => { if (neutralChat) return "none"; try { const stored = sessionStorage.getItem(key); return !stored || stored === "none" ? "business" : stored; } catch { return "business"; } });
  const [companies, setCompanies] = useState<Array<{id:string;name:string}>>([]);
  const [error,setError] = useState("");
  const [switching,setSwitching] = useState(false);
  useEffect(() => { let active=true; if(userId) void request<{companies:Array<{id:string;name:string}>}>("/companies?limit=100").then(v=>{if(active)setCompanies(v.companies);}).catch(e=>{if(active)setError(e.message);}); return()=>{active=false;}; },[userId]);
  async function choose(value:string) {
    setSwitching(true);setError("");
    try {
      if(value.startsWith("business:")) await switchBusiness(value.slice(9));
      const next=value.startsWith("business:")?"business":value;
      setSelection(next);try{sessionStorage.setItem(key,next);}catch{}
    }catch(e){setError(e instanceof Error?e.message:"Could not switch context");}finally{setSwitching(false);}
  }
  const value=selection==="business"&&overview?.currentBusiness ? "business:"+overview.currentBusiness.id : selection;
  const switcher = neutralChat ? null : (
    <div className="composer-context-switcher" title="Active context">
      <select
        aria-label="Active context"
        value={value}
        disabled={switching}
        onChange={(e) => void choose(e.target.value)}
        className="composer-context-select"
      >
        {!overview?.currentBusiness && <option value="business">Business setup</option>}
        {overview?.businesses.map((b) => (
          <option key={b.id} value={"business:" + b.id}>
            {b.name}
          </option>
        ))}
        {companies.map((c) => (
          <option key={c.id} value={"company:" + c.id}>
            Company: {c.name}
          </option>
        ))}
      </select>
    </div>
  );

  if (neutralChat) {
    return (
      <ChatContextSwitcherContext.Provider value={null}>
        <BusinessChatPage {...props} neutralChat />
      </ChatContextSwitcherContext.Provider>
    );
  }

  return (
    <ChatContextSwitcherContext.Provider value={switcher}>
      {error && <div role="alert" className="workspace-notice error">{error}</div>}
      {selection === "business" ? (
        <BusinessConversation {...props} />
      ) : (
        <ScopedConversation key={`${key}:${props.initialConversationId ?? "root"}:${selection}`} companyId={selection.startsWith("company:") ? selection.slice(8) : undefined} />
      )}
    </ChatContextSwitcherContext.Provider>
  );
}
function ScopedConversation({companyId}:{companyId?:string}) {
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const [messages,setMessages]=useState<Message[]>([]),[input,setInput]=useState(""),[sending,setSending]=useState(false),[error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();if(!input.trim()||sending)return;
    const prompt=input.trim();setInput("");setSending(true);setError("");
    setMessages(v=>[...v,{id:crypto.randomUUID(),role:"user",content:prompt}]);
    try {const reply=await request<AgentReply>("/chat",{message:prompt,contextType:companyId?"company":"none",...(companyId?{companyId}:{})});
      setMessages(v=>[...v,{id:crypto.randomUUID(),role:"assistant",content:reply.message}]);
    }catch(e){setError(e instanceof Error?e.message:"Chat failed");}finally{setSending(false);}
  }
  return <div className="onboarding-live-chat standard-live-chat">
    {error&&<div role="alert" className="workspace-notice error">{error}</div>}
    <div className="message-stream">{messages.map(m=><article key={m.id} className={m.role} aria-label={m.role==="user"?"Your message":"NPATI Agent message"}><ChatMessageContent content={m.content}/></article>)}{sending&&<p role="status">Working…</p>}</div>
    <form className="onboarding-live-composer" onSubmit={e=>void submit(e)}>
      {contextSwitcher}
      <AutoResizeChatTextarea aria-label="Message" placeholder="Ask NPATI Agent…" value={input} onChange={e=>setInput(e.target.value)}/>
      <div><button disabled={sending||!input.trim()}>Send →</button></div>
    </form>
  </div>;
}
