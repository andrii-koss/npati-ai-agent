import { getStoredAuthToken } from "./AuthContext";
import type { AgentReply } from "@npati/shared";
import { FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChatMessageContent } from "./ChatMessageContent";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { ChatAttachments, PendingMessageAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
import { cancelChatStream, streamChat } from "./chat-stream";

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
  onboardings: OnboardingSession[];
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

export const ChatContextSwitcherContext = createContext<ReactNode>(null);

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
    <form className="workspace-form business-profile-form" onSubmit={submit}>
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
      <div className="business-narrative-fields">
        <label className="field"><span>What does the business do?</span><textarea {...field("description")} placeholder="Products, services, value proposition…" /></label>
        <label className="field"><span>Products or services</span><textarea {...field("productsServicesSummary")} placeholder="What you sell or plan to offer…" /></label>
        <label className="field"><span>Target audience</span><textarea {...field("audienceSummary")} placeholder="Who you serve and what problem they have…" /></label>
      </div>
      <div className="form-actions">{onCancel && <button type="button" className="button-secondary" onClick={onCancel} disabled={saving}>Cancel</button>}<button className="button-primary" disabled={saving}>{saving ? "Saving…" : initial ? "Save changes" : "Create business"}</button></div>
    </form>
  );
}

function BusinessSettingsHeader({ title = "Business Profiles", copy, action, backTo = "/settings", onBack }: { title?: string; copy: string; action?: ReactNode; backTo?: string; onBack?: () => void }) {
  return (
    <header className="inspector-header automations-header business-settings-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">Settings · Business</p>
          <h1>
            {onBack ? <button type="button" className="marketplace-back-button" aria-label="Back to business profiles" title="Back to business profiles" onClick={onBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button> : <Link to={backTo} className="marketplace-back-button" aria-label={backTo === "/settings" ? "Back to settings" : "Back to business profiles"} title={backTo === "/settings" ? "Back to settings" : "Back to business profiles"}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>}
            <span>{title}</span>
          </h1>
          <p className="hero-copy">{copy}</p>
        </div>
        {action && <div className="automations-header-actions">{action}</div>}
      </div>
    </header>
  );
}

export function BusinessPage() {
  const { overview, loading, error, refresh, switchBusiness } = useWorkspace();
  const { businessId: editBusinessId } = useParams();
  const navigate = useNavigate();
  const [creatingManually, setCreatingManually] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const current = overview?.currentBusiness;
  const editDraft = editBusinessId ? overview?.onboardings.find((session) => session.businessId === editBusinessId) ?? null : null;
  const editTarget = editBusinessId ? overview?.businesses.find((business) => business.id === editBusinessId) : undefined;

  useEffect(() => {
    if (!editTarget || current?.id === editTarget.id) return;
    void switchBusiness(editTarget.id);
  }, [editTarget?.id, current?.id]);

  async function createBusinessIdea() {
    const session = await api<OnboardingSession>("/business-onboarding", {
      method: "POST",
      body: JSON.stringify({ scenario: "starting" }),
    });
    await refresh();
    navigate(`/b/${session.businessId}`);
  }

  async function removeBusiness(id: string, name: string) {
    if (!window.confirm(`Delete ${name} and its goals, memory, and conversations? This cannot be undone.`)) return;
    await api(`/businesses/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function convertToCompany(business: Business) {
    if (!window.confirm(`Create a company from ${business.name} and transfer its profile, goals, and confirmed memory?`)) return;
    setConvertingId(business.id);
    try {
      await api(`/businesses/${business.id}/convert-to-company`, {
        method: "POST",
        headers: { "idempotency-key": `business-convert-${business.id}` },
        body: JSON.stringify({
          companyName: business.name,
          includeConfirmedMemory: true,
          includeGoals: true,
          includeResearchSummary: true,
          includeInstructions: true,
        }),
      });
      navigate("/company");
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : "Could not create company from this business");
    } finally {
      setConvertingId(null);
    }
  }

  if (loading && editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy="Manage the business context NPATI uses across chats and recommendations." backTo="/settings/business" /></main>;
  if (error) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy="Manage the business context NPATI uses across chats and recommendations." backTo={editBusinessId ? "/settings/business" : "/settings"} /><Notice tone="error">{error}</Notice></main>;

  if (creatingManually) {
    return (
      <main className="automations-container business-settings-page">
        <BusinessSettingsHeader title="New Business" copy="Create a complete business profile manually. You can update every field later." onBack={() => setCreatingManually(false)} />
        <BusinessForm
          mode="existing"
          onCancel={() => setCreatingManually(false)}
          onSaved={async () => { await refresh(); setCreatingManually(false); }}
        />
      </main>
    );
  }

  if (editDraft) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editDraft.business.name} copy="Edit the saved details for this business idea." backTo="/settings/business" /><BusinessForm initial={editDraft.business} mode={editDraft.scenario} onSaved={refresh} /></main>;
  }
  if (editTarget && current?.id !== editTarget.id) return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy="Opening this business profile and its active context." backTo="/settings/business" /><div className="workspace-loading">Opening business profile…</div></main>;
  if (editTarget) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy="Keep the business facts NPATI relies on accurate and complete." backTo="/settings/business" /><BusinessForm initial={editTarget} mode={editTarget.businessType ?? "existing"} onSaved={refresh} /></main>;
  }
  if (editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy="Manage the business context NPATI uses across chats and recommendations." backTo="/settings/business" /><Notice tone="error">This business does not exist or is not available to your user.</Notice></main>;

  const businesses = overview?.businesses ?? [];
  const drafts = overview?.onboardings ?? [];
  const ideaCount = businesses.length + drafts.length;
  return (
    <main className="automations-container business-settings-page">
      <BusinessSettingsHeader
        copy="Manage the business profiles, markets, audiences, and operating context NPATI uses across chats and recommendations."
        action={<><button className="button-secondary" onClick={() => void createBusinessIdea()}>Guided setup</button><button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>+ Add Business</button></>}
      />

      <section className="overview-grid inspector-stats-grid business-stats-grid">
        <div><strong>{ideaCount}</strong><span>business profiles</span><small>All active profiles and drafts</small></div>
        <div><strong>{businesses.length}</strong><span>active businesses</span><small>Ready to use with NPATI Agent</small></div>
        <div><strong>{drafts.length}</strong><span>setup drafts</span><small>Profiles awaiting completion</small></div>
        <div><strong>{current ? 1 : 0}</strong><span>current context</span><small>{current?.name || "No business selected"}</small></div>
      </section>

      <div className="inspector-table-status business-list-status">
        <div className="status-left"><span>Showing <strong>{ideaCount}</strong> business {ideaCount === 1 ? "profile" : "profiles"}</span></div>
      </div>

      {ideaCount === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">B</div>
          <h3>No Business Profiles Yet</h3>
          <p>Create the first business profile to give NPATI the context it needs for relevant recommendations.</p>
          <button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>+ Create First Business</button>
        </div>
      ) : (
        <div className="record-list business-profile-list">
          {drafts.map((draft) => (
            <article className="record-card business-profile-card" key={draft.businessId} onClick={() => navigate(`/b/${draft.businessId}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{draft.business.name.charAt(0).toUpperCase() || "B"}</span>
                <div><span className="record-status">Setup draft</span><h3>{draft.business.name}</h3><p>{draft.completedFields.length} of {draft.totalFields} setup steps completed</p></div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/b/${draft.businessId}`); }}>Continue setup</button>
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${draft.businessId}`); }}>Edit</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(draft.businessId, draft.business.name); }}>Delete</button>
              </div>
            </article>
          ))}
          {businesses.map((business) => (
            <article className="record-card business-profile-card" key={business.id} onClick={() => navigate(`/b/${business.id}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{business.name.charAt(0).toUpperCase() || "B"}</span>
                <div>
                  <span className={`record-status${business.id === current?.id ? " active" : ""}`}>{business.id === current?.id ? "Current" : business.businessStage}</span>
                  <h3>{business.name}</h3>
                  <p>{business.description || business.industry || "Business profile"}</p>
                  <div className="business-card-meta">
                    {business.industry && <span>{business.industry}</span>}
                    {business.market && <span>{business.market}</span>}
                    {business.country && <span>{business.country}</span>}
                  </div>
                </div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/b/${business.id}`); }}>Open chat</button>
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${business.id}`); }}>Edit</button>
                <button disabled={convertingId === business.id} onClick={(event) => { event.stopPropagation(); void convertToCompany(business); }}>{convertingId === business.id ? "Converting..." : "Create company"}</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(business.id, business.name); }}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<Skill[]>("/skills")
      .then((data) => { setSkills(data); setError(""); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load skills"))
      .finally(() => setLoading(false));
  }, []);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => skill.name.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.capabilities.some((capability) => capability.toLowerCase().includes(query)));
  }, [search, skills]);
  const capabilityCount = useMemo(() => new Set(skills.flatMap((skill) => skill.capabilities)).size, [skills]);

  return (
    <main className="automations-container skills-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">Settings · Skills</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label="Back to settings" title="Back to settings">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>Agent Skills</span>
            </h1>
            <p className="hero-copy">Browse the built-in business capabilities NPATI Agent selects automatically for your requests.</p>
          </div>
          <span className="skills-readonly-badge">Built-in catalog</span>
        </div>
      </header>

      <section className="overview-grid inspector-stats-grid skills-stats-grid">
        <div><strong>{skills.length}</strong><span>available skills</span><small>Registered agent workflows</small></div>
        <div><strong>{capabilityCount}</strong><span>capabilities</span><small>Actions available to the agent</small></div>
        <div><strong>Auto</strong><span>skill selection</span><small>Matched to request and context</small></div>
      </section>

      <div className="inspector-controls skills-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input type="text" role="searchbox" placeholder="Search skills and capabilities..." value={search}
            onChange={(event) => setSearch(event.target.value)} className="inspector-search-input" aria-label="Filter skills" />
          {search && <button type="button" className="search-clear-btn" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
        </div>
      </div>

      <div className="inspector-table-status">
        <div className="status-left"><span>Showing <strong>{filteredSkills.length}</strong> of <strong>{skills.length}</strong> skills</span></div>
      </div>

      {error ? <div className="workspace-notice error">{error}</div> : loading ? (
        <div className="workspace-notice">Loading agent skills...</div>
      ) : filteredSkills.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">⌕</div><h3>No matching skills</h3>
          <p>Try another name, description, or capability.</p>
          <button type="button" className="button-secondary" onClick={() => setSearch("")}>Clear Search</button>
        </div>
      ) : (
        <div className="skill-grid skills-catalog-grid">
          {filteredSkills.map((skill, index) => (
            <article key={skill.id} className="skills-catalog-card">
              <div className="skills-card-head">
                <span className="skills-card-icon" aria-hidden="true">{index + 1}</span>
                <span className="skills-card-status"><i /> Available</span>
              </div>
              <div className="skills-card-type">Built-in skill</div>
              <h2>{skill.name}</h2><p>{skill.description}</p>
              <div className="skills-capabilities">{skill.capabilities.map((capability) => <i key={capability}>{capability}</i>)}</div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

const businessThinkingSteps = [
  "Thinking…",
  "Reviewing your business context…",
  "Checking goals and memory…",
  "Preparing a response…",
];

const PAGE_PROGRESS_PRESENTATION_MS = 1200;

export function BusinessChatPage({ initialPrompt = "", initialConversationId, neutralChat = false }: { initialPrompt?: string; initialConversationId?: string; neutralChat?: boolean }) {
  const { overview } = useWorkspace(); const business = neutralChat ? null : overview?.currentBusiness;
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]); const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]); const [input, setInput] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [noMemory, setNoMemory] = useState(false);
  const [sending, setSending] = useState(false); const [thinkingStep, setThinkingStep] = useState(0);
  const [streamingResponse,setStreamingResponse]=useState(false);
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
  const streamControllerRef=useRef<{controller:AbortController;streamId:string}|null>(null);
  const suggestions = useMemo(
    () => business
      ? ["What should I focus on this week?", "Review my current goals", "Help me improve my offer"]
      : ["Help me brainstorm business ideas", "How do I research market demand?", "Explain how NPATI Agent works"],
    [business?.id]
  );
  async function loadConversations(preferred?: string) {
    const base = business ? `/businesses/${business.id}/conversations` : "/conversations";
    const rows = await api<Conversation[]>(base); setConversations(rows);
    const next = preferred ?? selected ?? rows[0]?.id ?? null; setSelected(next);
    if (next) {
      const loaded = (await api<{ messages: Message[] }>(`${base}/${next}`)).messages;
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
    streamControllerRef.current?.controller.abort();
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
  async function submit(event: FormEvent) {
    event.preventDefault(); const message = input.trim(); if ((!message && attachments.length === 0) || sending) return;
    const privateRequest = noMemory;
    const optimisticId = `pending-${Date.now()}`;
    const sentAttachments = attachments;
    const optimisticContent = message;
    setActiveTurn(optimisticContent);
    const optimisticMessage: Message = { id: optimisticId, role: "user", content: optimisticContent, createdAt: new Date().toISOString(), attachments: sentAttachments };
    setMessages((current) => [...current, optimisticMessage]);
    resetProgress();
    setSending(true); setStreamingResponse(false); setNotice(""); setInput(""); setAttachments([]); setReplyMeta(null);
    const assistantId=crypto.randomUUID();let receivedDelta=false;
    const controller=new AbortController(),streamId=crypto.randomUUID();streamControllerRef.current={controller,streamId};
    try {
      const result = await streamChat<AgentReply>({
        message,
        conversationId: selected ?? undefined,
        attachments: sentAttachments,
        contextType: business ? "business" : "none",
        noMemory: privateRequest,
        streamId,
      }, enqueueProgress,{signal:controller.signal,onDelta:(delta)=>{
        receivedDelta=true;setStreamingResponse(true);
        setMessages(current=>{const found=current.some(item=>item.id===assistantId);return found?current.map(item=>item.id===assistantId?{...item,content:item.content+delta}:item):[...current,{id:assistantId,role:"assistant",content:delta,createdAt:new Date().toISOString()}];});
      }});
      setReplyMeta(result);
      if (privateRequest) {
        if(!receivedDelta)setMessages((current) => [...current, { id: assistantId, role: "assistant", content: result.message, createdAt: new Date().toISOString() }]);
      } else if (result.conversationId) {
        await loadConversations(result.conversationId);
        navigate(`/c/${result.conversationId}`, { replace: !selected, state: business ? { businessId: business.id } : { neutralChat: true } });
        window.dispatchEvent(new Event("npati:conversations-changed"));
      }
      setProgressComplete(true);
    } catch (reason) {
      const typed = reason as Error & { code?: string };
      if(typed.name==="AbortError"){setProgressComplete(true);setNotice("");return;}
      setProgressFailed(true);
      setNotice(typed.message);
      if (privateRequest) {
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
        setInput(message); setAttachments(sentAttachments);
      } else try {
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
    } finally { if(streamControllerRef.current?.controller===controller)streamControllerRef.current=null;setSending(false);setStreamingResponse(false); }
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
          {messages.length === 0 && <div className="chat-welcome"><span>N</span><h2>What should we work on?</h2><p>{business ? `I’ll use the context for ${business.name} and won’t invent missing facts.` : "Ask NPATI Agent anything, or brainstorm ideas."}</p><div>{suggestions.map((suggestion) => <button key={suggestion} onClick={() => setInput(suggestion)}>{suggestion}</button>)}</div></div>}
          {messages.map((message, index) => <Fragment key={message.id}>
            {progressComplete && progressEvents.some((event) => !event.type.startsWith("final_generation")) && message.role === "assistant" && index === messages.length - 1 && <ResearchProgressPanel events={progressEvents} visibleCount={visibleProgressCount} presentingEvent={presentingProgressEvent} completed failed={progressFailed} />}
            <article ref={message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn) ? activeTurnRef : undefined} className={`${message.role}${message.role === "user" && messageHasImage(message) ? " image-message" : ""}`} aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}><PendingMessageAttachments value={message.attachments ?? []} /><ChatMessageContent content={message.content} /></article>
          </Fragment>)}
          {!progressComplete && progressEvents.some((event) => !event.type.startsWith("final_generation")) && <ResearchProgressPanel events={progressEvents} visibleCount={visibleProgressCount} presentingEvent={presentingProgressEvent} completed={false} failed={progressFailed} />}
          {sending && !streamingResponse && !progressEvents.some((event) => !event.type.startsWith("final_generation")) && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{businessThinkingSteps[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          <div ref={streamEndRef} aria-hidden="true" />
          <div className="chat-scroll-spacer" aria-hidden="true" />
        </div>
        {replyMeta?.memoryCandidate && <div className="memory-candidate"><div><strong>Remember this?</strong><p>{replyMeta.memoryCandidate.title}: {replyMeta.memoryCandidate.content}</p></div><button onClick={() => void remember()}>Remember</button><button onClick={() => setReplyMeta({ ...replyMeta, memoryCandidate: undefined })}>Not now</button></div>}
        <form className="onboarding-live-composer" onSubmit={(event) => void submit(event)}>
          {contextSwitcher}
          <label className={`composer-private-toggle ${noMemory ? "active" : ""}`} title="Do not read or save memory, chat history, or attachments for this request">
            <input type="checkbox" checked={noMemory} disabled={sending} onChange={(event) => setNoMemory(event.target.checked)} />
            <span className="composer-private-check" aria-hidden="true">✓</span>
            <span>Private request</span>
          </label>
          <ChatAttachments value={attachments} onChange={setAttachments} onError={setNotice} disabled={sending} />
          <AutoResizeChatTextarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} placeholder={business ? "Ask about your business, goals, audience, or next move…" : "Ask NPATI Agent anything…"} />
          <div>{sending?<button type="button" onClick={()=>{const active=streamControllerRef.current;if(active)void cancelChatStream(active.streamId).finally(()=>active.controller.abort(new DOMException("Stopped","AbortError")));}}>Stop</button>:<button disabled={!input.trim() && attachments.length === 0}>Send →</button>}</div>
        </form>
      </div>
    </>
  );
}
