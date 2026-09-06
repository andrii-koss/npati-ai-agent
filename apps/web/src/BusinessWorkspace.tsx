import { getStoredAuthToken } from "./AuthContext";
import type { AgentReply } from "@npati/shared";
import { FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChatMessageContent } from "./ChatMessageContent";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { ChatAttachments, PendingMessageAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
import { streamChat } from "./chat-stream";

type Business = {
  id: string; name: string; businessType?: string; industry?: string; niche?: string; country?: string;
  market?: string; website?: string; businessStage: string; teamType?: string; businessModel?: string;
  presenceType?: string; description?: string; audienceSummary?: string; productsServicesSummary?: string;
  activationStatus?: "draft" | "active";
};
type OnboardingSession = {
  id: string; businessId: string; conversationId: string; scenario: "existing" | "starting" | "seller";
  status: "active" | "paused" | "awaiting_confirmation" | "completed"; currentStep: number; totalFields: number;
  completedFields: string[]; skippedFields: string[]; currentField?: string; business: Business;
  updatedAt: string;
};
type WorkspaceOverview = {
  user: { id: string; displayName: string };
  workspace: { id: string; name: string; role: string };
  businesses: Business[];
  currentBusiness: Business | null;
  onboarding: OnboardingSession | null;
};
type Goal = { id: string; title: string; description?: string; status: string; priority: number; targetDate?: string };
type MemoryItem = { id: string; type: string; title: string; content: string; source: string; updatedAt: string };
type Skill = { id: string; name: string; description: string; capabilities: string[] };
type Conversation = { id: string; title: string; updatedAt: string };
type Message = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; attachments?: ChatAttachmentInput[] };

function messageHasImage(message: Message) {
  return message.attachments?.some((attachment) => attachment.kind === "image")
    || message.content.includes("[[npati-attachment:image:");
}


type WorkspaceValue = {
  overview: WorkspaceOverview | null;
  loading: boolean;
  error: string;
  refresh(): Promise<void>;
  switchBusiness(id: string): Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`/api${url}`, {
    ...init,
    headers,
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("npati:unauthorized"));
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    Object.assign(error, { code: payload?.error?.code, status: response.status });
    throw error;
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setLoading(true);
    try { setOverview(await api<WorkspaceOverview>("/workspace/context")); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Workspace is unavailable"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function switchBusiness(id: string) {
    await api("/workspace/current-business", { method: "PUT", body: JSON.stringify({ businessId: id }) });
    await refresh();
  }
  return <WorkspaceContext.Provider value={{ overview, loading, error, refresh, switchBusiness }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is missing");
  return value;
}

export function BusinessSwitcher() {
  const { overview, loading, switchBusiness } = useWorkspace();
  if (loading) return <span className="business-switcher muted">Loading workspace…</span>;
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

const blankBusiness = {
  name: "", businessType: "", industry: "", niche: "", country: "", market: "", website: "",
  businessStage: "starting", teamType: "solo", businessModel: "", presenceType: "online",
  description: "", audienceSummary: "", productsServicesSummary: "",
};

function PageIntro({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>{action}</div>;
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "error" | "success" }) {
  return <div className={`workspace-notice ${tone}`}>{children}</div>;
}

function BusinessForm({ initial, mode, onCancel, onSaved }: { initial?: Business; mode: string; onCancel?: () => void; onSaved(): Promise<void> }) {
  const [form, setForm] = useState({ ...blankBusiness, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function field(name: keyof typeof blankBusiness) {
    return { value: form[name] ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [name]: event.target.value }) };
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const fallbackName = mode === "starting" ? "New Business Idea" : mode === "seller" ? "My Selling Business" : "";
    try {
      await api(initial ? `/businesses/${initial.id}` : "/businesses", {
        method: initial ? "PATCH" : "POST",
        body: JSON.stringify({
          ...form,
          name: form.name.trim() || fallbackName,
          businessType: form.businessType || mode,
          businessStage: !initial && mode === "starting" ? "idea" : !initial && mode === "seller" ? "starting" : form.businessStage,
        }),
      });
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save business"); }
    finally { setSaving(false); }
  }
  return (
    <form className="workspace-form" onSubmit={submit}>
      <div className="form-section-title"><span>Business profile</span><p>Give NPATI enough context to make relevant recommendations. You can refine this later.</p></div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="field-grid">
        <label className="field"><span>Business name</span><input {...field("name")} required={mode === "existing"} placeholder={mode === "starting" ? "Optional for now" : "Business name"} /></label>
        <label className="field"><span>Stage</span><select {...field("businessStage")}><option value="idea">Idea</option><option value="starting">Starting</option><option value="operating">Operating</option><option value="growing">Growing</option><option value="scaling">Scaling</option></select></label>
        <label className="field"><span>Industry</span><input {...field("industry")} placeholder="E-commerce, consulting, food…" /></label>
        <label className="field"><span>Niche</span><input {...field("niche")} placeholder="Your specific focus" /></label>
        <label className="field"><span>Country</span><input {...field("country")} placeholder="Primary country" /></label>
        <label className="field"><span>Market</span><input {...field("market")} placeholder="Local, national, global…" /></label>
        <label className="field"><span>Team</span><select {...field("teamType")}><option value="solo">Solo</option><option value="team">Team</option></select></label>
        <label className="field"><span>Presence</span><select {...field("presenceType")}><option value="online">Online</option><option value="local">Local</option><option value="both">Online & local</option></select></label>
        <label className="field"><span>Business model</span><input {...field("businessModel")} placeholder="Services, products, subscription…" /></label>
        <label className="field"><span>Website</span><input {...field("website")} type="url" placeholder="https://" /></label>
      </div>
      <label className="field"><span>What does the business do?</span><textarea {...field("description")} placeholder="Products, services, value proposition…" /></label>
      <label className="field"><span>Products or services</span><textarea {...field("productsServicesSummary")} placeholder="What you sell or plan to offer…" /></label>
      <label className="field"><span>Target audience</span><textarea {...field("audienceSummary")} placeholder="Who you serve and what problem they have…" /></label>
      <div className="form-actions"><button className="button-primary" disabled={saving}>{saving ? "Saving…" : initial ? "Save changes" : "Create business"}</button>{onCancel && <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>}</div>
    </form>
  );
}

export function BusinessPage() {
  const { overview, loading, error, refresh } = useWorkspace();
  const [onboarding, setOnboarding] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const current = overview?.currentBusiness;
  async function removeCurrent() {
    if (!current || !window.confirm(`Delete ${current.name} and its goals, memory, and conversations? This cannot be undone.`)) return;
    await api(`/businesses/${current.id}`, { method: "DELETE" });
    await refresh();
  }
  if (loading) return <div className="workspace-loading">Loading business workspace…</div>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!current && overview?.onboarding && !onboarding) return (
    <>
      <PageIntro eyebrow="Business setup in progress" title={overview.onboarding.business.name} copy="Chat onboarding and manual editing use the same structured Business Profile." action={<Link className="button-primary" to="/chat">Resume in Chat</Link>} />
      <Notice><strong>{overview.onboarding.completedFields.length} of {overview.onboarding.totalFields} details added</strong><span>Your progress is saved. You can edit collected details here or continue the recommended conversational setup.</span></Notice>
      <BusinessForm initial={overview.onboarding.business} mode={overview.onboarding.scenario} onSaved={refresh} />
    </>
  );
  if (!current && !onboarding) return (
    <>
      <PageIntro eyebrow="Business workspace" title="Set up your business" copy="NPATI uses this profile as grounded context for goals, memory, and every business conversation." />
      <Link className="chat-onboarding-recommendation" to="/chat"><span>Recommended</span><strong>Set up your business in Chat</strong><small>NPATI asks one natural question at a time and saves your progress.</small><b>Start conversational setup →</b></Link>
      <div className="manual-setup-heading"><strong>Set up manually</strong><span>Or create the structured profile directly.</span></div>
      <div className="onboarding-grid">
        {([
          ["existing", "I already have a business", "Add an operating business and its current market context."],
          ["starting", "I want to start a business", "Turn an early idea into a structured workspace."],
          ["seller", "I want to sell something", "Start from a product, service, or offer you want to sell."],
        ] as const).map(([id, title, copy]) => <button key={id} onClick={() => setOnboarding(id)}><span>→</span><strong>{title}</strong><small>{copy}</small></button>)}
      </div>
    </>
  );
  if (!current && onboarding) return <><PageIntro eyebrow="Business onboarding" title="Tell NPATI what you’re building" copy="Skip anything you do not know yet." /><BusinessForm mode={onboarding} onCancel={() => setOnboarding(null)} onSaved={async () => { setOnboarding(null); await refresh(); }} /></>;
  if (editing && current) return <><PageIntro eyebrow="Business profile" title={current.name} copy="Keep the facts NPATI relies on accurate." /><BusinessForm initial={current} mode={current.businessType ?? "existing"} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} /></>;
  return (
    <>
      <PageIntro eyebrow="Current business" title={current!.name} copy={current!.description || "Your business workspace is ready."} action={<div className="head-actions"><button className="button-secondary" onClick={() => setEditing(true)}>Edit profile</button><button className="button-primary" onClick={() => setOnboarding("existing")}>Add business</button><button className="button-danger" onClick={() => void removeCurrent()}>Delete</button></div>} />
      {onboarding && <BusinessForm mode={onboarding} onCancel={() => setOnboarding(null)} onSaved={async () => { setOnboarding(null); await refresh(); }} />}
      {!onboarding && <div className="profile-grid">
        <section><span>Stage</span><strong>{current!.businessStage}</strong><p>{current!.industry || "Industry not added"}{current!.niche ? ` · ${current!.niche}` : ""}</p></section>
        <section><span>Audience</span><strong>{current!.audienceSummary || "Not defined yet"}</strong><p>Used to ground positioning and content advice.</p></section>
        <section><span>Market & presence</span><strong>{current!.market || current!.country || "Not defined yet"}</strong><p>{current!.presenceType || "Presence not added"}{current!.website ? ` · ${current!.website}` : ""}</p></section>
        <section><span>Operating model</span><strong>{current!.businessModel || "Not defined yet"}</strong><p>{current!.teamType === "team" ? "Team business" : "Solo business"}</p></section>
        <section><span>Products & services</span><strong>Business profile ready</strong><p>A dedicated product catalog is coming in a future milestone.</p></section>
        <section><span>Current goals</span><strong>Turn context into outcomes</strong><p><Link to="/goals">View and manage this business’s goals →</Link></p></section>
      </div>}
    </>
  );
}

function EmptyBusiness({ feature }: { feature: string }) {
  return <Notice><strong>Set up a business first.</strong><span>{feature} are isolated per business, so NPATI needs an active business workspace.</span><Link to="/business">Set up business →</Link></Notice>;
}

export function GoalsPage() {
  const { overview } = useWorkspace(); const business = overview?.currentBusiness;
  const [goals, setGoals] = useState<Goal[]>([]); const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState({ title: "", description: "", targetDate: "", priority: "2" }); const [error, setError] = useState("");
  async function load() { if (business) setGoals(await api<Goal[]>(`/businesses/${business.id}/goals`)); }
  useEffect(() => { void load().catch((reason) => setError(String(reason))); }, [business?.id]);
  if (!business) return <><PageIntro eyebrow="Execution" title="Goals" copy="Define measurable outcomes for the current business." /><EmptyBusiness feature="Goals" /></>;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    await api(editing ? `/businesses/${business.id}/goals/${editing.id}` : `/businesses/${business.id}/goals`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...form, priority: Number(form.priority), targetDate: form.targetDate || undefined }) });
    setForm({ title: "", description: "", targetDate: "", priority: "2" }); setEditing(null); await load();
  }
  function startEdit(goal: Goal) { setEditing(goal); setForm({ title: goal.title, description: goal.description ?? "", targetDate: goal.targetDate?.slice(0, 10) ?? "", priority: String(goal.priority) }); }
  return (
    <>
      <PageIntro eyebrow={business.name} title="Goals" copy="Give NPATI concrete outcomes to prioritize in chat and recommendations." />
      {error && <Notice tone="error">{error}</Notice>}
      <form className="compact-form" onSubmit={(event) => void save(event)}>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Goal title" required />
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What does success look like?" />
        <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="1">High priority</option><option value="2">Normal priority</option><option value="3">Low priority</option></select>
        <button className="button-primary">{editing ? "Save goal" : "Add goal"}</button>{editing && <button type="button" className="button-secondary" onClick={() => { setEditing(null); setForm({ title: "", description: "", targetDate: "", priority: "2" }); }}>Cancel</button>}
      </form>
      <div className="record-list">{goals.length === 0 ? <div className="empty-record">No goals yet. Add the first outcome you want NPATI to help with.</div> : goals.map((goal) => (
        <article className="record-card" key={goal.id}><div><span className={`record-status ${goal.status}`}>{goal.status}</span><h3>{goal.title}</h3><p>{goal.description || "No description"}{goal.targetDate ? ` · Due ${new Date(goal.targetDate).toLocaleDateString()}` : ""}</p></div><div className="record-actions">{goal.status !== "completed" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) }).then(load)}>Complete</button>}{goal.status === "active" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) }).then(load)}>Pause</button>}{goal.status === "paused" && <button onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }).then(load)}>Resume</button>}<button onClick={() => startEdit(goal)}>Edit</button><button className="danger" onClick={() => void api(`/businesses/${business.id}/goals/${goal.id}`, { method: "DELETE" }).then(load)}>Delete</button></div></article>
      ))}</div>
    </>
  );
}

export function MemoryPage() {
  const { overview } = useWorkspace(); const business = overview?.currentBusiness;
  const [items, setItems] = useState<MemoryItem[]>([]); const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [form, setForm] = useState({ type: "business_fact", title: "", content: "" }); const [error, setError] = useState("");
  async function load() { if (business) setItems(await api<MemoryItem[]>(`/businesses/${business.id}/memory`)); }
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [business?.id]);
  if (!business) return <><PageIntro eyebrow="Business context" title="Memory" copy="Control the durable facts NPATI may use." /><EmptyBusiness feature="Memory items" /></>;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    await api(editing ? `/businesses/${business.id}/memory/${editing.id}` : `/businesses/${business.id}/memory`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...form, source: "user" }) });
    setForm({ type: "business_fact", title: "", content: "" }); setEditing(null); await load();
  }
  return (
    <>
      <PageIntro eyebrow={business.name} title="Memory" copy="Only confirmed business facts live here. Credentials and API keys are rejected." />
      {error && <Notice tone="error">{error}</Notice>}
      <form className="compact-form memory-form" onSubmit={(event) => void save(event)}>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{["business_fact","audience","brand","preference","decision","product","channel","experiment","result","other"].map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}</select>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Memory title" required />
        <input value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Fact NPATI should remember" required />
        <button className="button-primary">{editing ? "Save memory" : "Add memory"}</button>{editing && <button type="button" className="button-secondary" onClick={() => { setEditing(null); setForm({ type: "business_fact", title: "", content: "" }); }}>Cancel</button>}
      </form>
      <div className="record-list">{items.length === 0 ? <div className="empty-record">No confirmed memory yet. Add an audience, preference, decision, or business fact.</div> : items.map((item) => <article className="record-card" key={item.id}><div><span className="record-status">{item.type.replace("_", " ")}</span><h3>{item.title}</h3><p>{item.content}</p></div><div className="record-actions"><button onClick={() => { setEditing(item); setForm({ type: item.type, title: item.title, content: item.content }); }}>Edit</button><button className="danger" onClick={() => void api(`/businesses/${business.id}/memory/${item.id}`, { method: "DELETE" }).then(load)}>Forget</button></div></article>)}</div>
    </>
  );
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => { void api<Skill[]>("/skills").then(setSkills); }, []);
  return <><PageIntro eyebrow="Capabilities" title="Skills" copy="Reusable business capabilities selected automatically from your request and current stage." /><div className="skill-grid">{skills.map((skill) => <article key={skill.id}><span>Skill</span><h2>{skill.name}</h2><p>{skill.description}</p><div>{skill.capabilities.map((capability) => <i key={capability}>{capability}</i>)}</div></article>)}</div></>;
}

const businessThinkingSteps = [
  "Thinking…",
  "Reviewing your business context…",
  "Checking goals and memory…",
  "Preparing a response…",
];

const PAGE_PROGRESS_PRESENTATION_MS = 1200;

export function BusinessChatPage({ initialPrompt = "", initialConversationId }: { initialPrompt?: string; initialConversationId?: string }) {
  const { overview } = useWorkspace(); const business = overview?.currentBusiness;
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]); const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]); const [input, setInput] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [sending, setSending] = useState(false); const [thinkingStep, setThinkingStep] = useState(0);
  const [notice, setNotice] = useState(""); const [replyMeta, setReplyMeta] = useState<AgentReply | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const activeTurnRef = useRef<HTMLElement>(null);
  const [activeTurn, setActiveTurn] = useState("");
  const [progressEvents, setProgressEvents] = useState<ChatProgressEvent[]>([]);
  const [visibleProgressCount, setVisibleProgressCount] = useState(0);
  const [presentingProgressEvent, setPresentingProgressEvent] = useState<ChatProgressEvent | null>(null);
  const [progressComplete, setProgressComplete] = useState(false);
  const [progressFailed, setProgressFailed] = useState(false);
  const progressEventsRef = useRef<ChatProgressEvent[]>([]);
  const progressQueueRef = useRef<ChatProgressEvent[]>([]);
  const pendingSearchResultsRef = useRef<ChatProgressEvent | null>(null);
  const pageStartPendingRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);
  const nextProgressRevealRef = useRef(0);
  const suggestions = useMemo(() => ["What should I focus on this week?", "Review my current goals", "Help me improve my offer"], [business?.id]);
  async function loadConversations(preferred?: string) {
    if (!business) return [] as Message[];
    const rows = await api<Conversation[]>(`/businesses/${business.id}/conversations`); setConversations(rows);
    const next = preferred ?? selected ?? rows[0]?.id ?? null; setSelected(next);
    if (next) {
      const loaded = (await api<{ messages: Message[] }>(`/businesses/${business.id}/conversations/${next}`)).messages;
      setMessages(loaded);
      return loaded;
    }
    setMessages([]);
    return [] as Message[];
  }
  useEffect(() => {
    setSelected(null); setMessages([]); setReplyMeta(null); setNotice(""); setActiveTurn(""); resetProgress();
    if (initialConversationId) {
      void loadConversations(initialConversationId);
    } else {
      void loadConversations();
    }
  }, [business?.id, initialConversationId]);
  useEffect(() => {
    if (!sending) { setThinkingStep(0); return; }
    const timer = window.setInterval(() => setThinkingStep((step) => Math.min(step + 1, businessThinkingSteps.length - 1)), 1200);
    return () => window.clearInterval(timer);
  }, [sending]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (activeTurn && activeTurnRef.current) activeTurnRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      else streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, activeTurn]);
  useEffect(() => () => {
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
  }, []);
  function drainProgressQueue() {
    const delay = Math.max(0, nextProgressRevealRef.current - Date.now());
    progressTimerRef.current = window.setTimeout(() => {
      const next = progressQueueRef.current[0];
      if (!next) {
        progressTimerRef.current = null;
        return;
      }
      const isPageResult = next.type === "page_fetch_completed" || next.type === "page_fetch_failed";
      if (isPageResult) {
        setPresentingProgressEvent(next);
        progressTimerRef.current = window.setTimeout(() => {
          progressQueueRef.current.shift();
          setVisibleProgressCount((count) => count + 1);
          setPresentingProgressEvent(null);
          nextProgressRevealRef.current = Date.now() + 250;
          progressTimerRef.current = null;
          if (progressQueueRef.current.length > 0) drainProgressQueue();
        }, PAGE_PROGRESS_PRESENTATION_MS);
        return;
      }
      progressQueueRef.current.shift();
      setVisibleProgressCount((count) => count + 1);
      // Search results and the first fetched page form one continuous visual
      // transition: globe -> active page, without an empty pause between them.
      nextProgressRevealRef.current = Date.now() + (next.type === "search_results_received" ? 0 : 800);
      progressTimerRef.current = null;
      if (progressQueueRef.current.length > 0) drainProgressQueue();
    }, delay);
  }
  function queueProgressEvent(event: ChatProgressEvent) {
    const nextEvents = [...progressEventsRef.current, event];
    progressEventsRef.current = nextEvents;
    setProgressEvents(nextEvents);
    progressQueueRef.current.push(event);
    if (progressTimerRef.current === null) drainProgressQueue();
  }
  function enqueueProgress(event: ChatProgressEvent) {
    // Discovered URLs are backend evidence, but they do not create a visible row.
    // Keeping them out of the visual queue prevents invisible events from delaying pages.
    if (event.type === "source_discovered") return;
    // Search-based crawlMany returns its pages as one completed batch. Keep the
    // globe active while that real work is running instead of pinning the first
    // candidate URL on screen for the duration of the whole batch.
    if (event.type === "search_results_received") {
      pendingSearchResultsRef.current = event;
      return;
    }
    if (event.type === "page_fetch_started" && pendingSearchResultsRef.current) return;
    if (
      pendingSearchResultsRef.current
      && (event.type === "page_fetch_completed" || event.type === "page_fetch_failed" || event.type === "research_completed")
    ) {
      queueProgressEvent(pendingSearchResultsRef.current);
      pendingSearchResultsRef.current = null;
    }
    // Direct URL and sequential fallback fetches still expose their real start.
    if (event.type === "page_fetch_started") {
      if (pageStartPendingRef.current) return;
      pageStartPendingRef.current = true;
    }
    if (event.type === "page_fetch_completed" || event.type === "page_fetch_failed" || event.type === "research_completed") {
      pageStartPendingRef.current = false;
    }
    // Terminal generation events must stay in the same presentation queue.
    // Flushing here would make every completed crawl page appear at once.
    queueProgressEvent(event);
  }
  function resetProgress() {
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = null;
    progressQueueRef.current = [];
    progressEventsRef.current = [];
    pendingSearchResultsRef.current = null;
    pageStartPendingRef.current = false;
    setPresentingProgressEvent(null);
    nextProgressRevealRef.current = 0;
    setProgressEvents([]);
    setVisibleProgressCount(0);
    setProgressComplete(false);
    setProgressFailed(false);
  }
  if (!business) return <><PageIntro eyebrow="Conversation" title="Chat" copy="Your AI Business Agent uses the active business as context." /><EmptyBusiness feature="Conversations" /></>;
  async function submit(event: FormEvent) {
    event.preventDefault(); const message = input.trim(); if ((!message && attachments.length === 0) || sending) return;
    const optimisticId = `pending-${Date.now()}`;
    const sentAttachments = attachments;
    const optimisticContent = message;
    setActiveTurn(optimisticContent);
    setMessages((current) => [...current, { id: optimisticId, role: "user", content: optimisticContent, createdAt: new Date().toISOString(), attachments: sentAttachments }]);
    resetProgress();
    setSending(true); setNotice(""); setInput(""); setAttachments([]); setReplyMeta(null);
    try {
      const result = await streamChat<AgentReply>({ message, conversationId: selected ?? undefined, attachments: sentAttachments }, enqueueProgress);
      setReplyMeta(result); await loadConversations(result.conversationId);
      setProgressComplete(true);
      navigate(`/c/${result.conversationId}`, { replace: !selected });
      window.dispatchEvent(new Event("npati:conversations-changed"));
    } catch (reason) {
      const typed = reason as Error & { code?: string };
      setProgressFailed(true);
      setNotice(typed.message);
      try {
        const loaded = await loadConversations(selected ?? undefined);
        const latestUser = [...loaded].reverse().find((item) => item.role === "user");
        const persisted = Boolean(latestUser)
          && (!message || latestUser!.content.includes(message))
          && sentAttachments.every((item) => latestUser!.content.includes(encodeURIComponent(item.name)));
        if (!persisted) {
          setInput(message);
          setAttachments(sentAttachments);
        }
        window.dispatchEvent(new Event("npati:conversations-changed"));
      } catch {
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
        setInput(message); setAttachments(sentAttachments);
      }
    } finally { setSending(false); }
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
  return (
    <>
      {notice && <Notice tone={notice.startsWith("Saved") ? "success" : "error"}>{notice}{/provider/i.test(notice) && <Link to="/settings/ai">Open AI Marketplace →</Link>}</Notice>}
      <div className="onboarding-live-chat standard-live-chat">
        <div className="message-stream">
          {messages.length === 0 && <div className="chat-welcome"><span>N</span><h2>What should we work on?</h2><p>I’ll use the context for {business.name} and won’t invent missing facts.</p><div>{suggestions.map((suggestion) => <button key={suggestion} onClick={() => setInput(suggestion)}>{suggestion}</button>)}</div></div>}
          {messages.map((message, index) => <Fragment key={message.id}>
            {progressComplete && progressEvents.some((event) => !event.type.startsWith("final_generation")) && message.role === "assistant" && index === messages.length - 1 && <ResearchProgressPanel events={progressEvents} visibleCount={visibleProgressCount} presentingEvent={presentingProgressEvent} completed failed={progressFailed} />}
            <article ref={message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn) ? activeTurnRef : undefined} className={`${message.role}${message.role === "user" && messageHasImage(message) ? " image-message" : ""}`} aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}><PendingMessageAttachments value={message.attachments ?? []} /><ChatMessageContent content={message.content} /></article>
          </Fragment>)}
          {!progressComplete && progressEvents.some((event) => !event.type.startsWith("final_generation")) && <ResearchProgressPanel events={progressEvents} visibleCount={visibleProgressCount} presentingEvent={presentingProgressEvent} completed={false} failed={progressFailed} />}
          {sending && !progressEvents.some((event) => !event.type.startsWith("final_generation")) && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{businessThinkingSteps[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          <div ref={streamEndRef} aria-hidden="true" />
          <div className="chat-scroll-spacer" aria-hidden="true" />
        </div>
        {replyMeta?.memoryCandidate && <div className="memory-candidate"><div><strong>Remember this?</strong><p>{replyMeta.memoryCandidate.title}: {replyMeta.memoryCandidate.content}</p></div><button onClick={() => void remember()}>Remember</button><button onClick={() => setReplyMeta({ ...replyMeta, memoryCandidate: undefined })}>Not now</button></div>}
        <form className="onboarding-live-composer" onSubmit={(event) => void submit(event)}>
          <ChatAttachments value={attachments} onChange={setAttachments} onError={setNotice} disabled={sending} />
          <AutoResizeChatTextarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} placeholder="Ask about your business, goals, audience, or next move…" />
          <div><button disabled={sending || (!input.trim() && attachments.length === 0)}>Send →</button></div>
        </form>
      </div>
    </>
  );
}
