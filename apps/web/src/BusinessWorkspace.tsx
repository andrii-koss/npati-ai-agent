import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { AgentReply, ProjectCardData } from "@npati/shared";
import { FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChatMessageContent, stripInternalChatActions } from "./ChatMessageContent";
import { UserPromptMessage } from "./UserPromptMessage";
import { readActiveCompanyId, writeActiveCompanyId } from "./active-company";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { ChatAttachments, PendingMessageAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { SPEECH_VOICES } from "./speech-voices";
import { ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
import { cancelChatStream, streamChat } from "./chat-stream";
import { confirmModal, alertModal } from "./ConfirmDialog";
import { detectChatMutationOperation, mutationProgressTargets } from "./chat-mutation-progress";

type Business = {
  id: string; name: string; businessType?: string; industry?: string; niche?: string; country?: string;
  market?: string; website?: string; businessStage: string; teamType?: string; businessModel?: string;
  presenceType?: string; description?: string; audienceSummary?: string; productsServicesSummary?: string;
  legalName?: string; contactEmail?: string; contactPhone?: string; postalAddress?: string; registrationDetails?: string; logoFileId?: string;
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
type Company = { id: string; name: string; businessId?: string; revision: number; status: string };
type Skill = { id: string; name: string; description: string; capabilities: string[] };
type Conversation = { id: string; title: string; updatedAt: string };
type Message = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; attachments?: ChatAttachmentInput[]; projectCard?: ProjectCardData };
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

const WORKSPACE_OVERVIEW_STORAGE_KEY = "npati_workspace_overview_cache_v1";
let cachedWorkspaceOverview: WorkspaceOverview | null = null;

function getInitialWorkspaceOverview(): WorkspaceOverview | null {
  if (cachedWorkspaceOverview) return cachedWorkspaceOverview;
  try {
    const raw = sessionStorage.getItem(WORKSPACE_OVERVIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.businesses)) {
        cachedWorkspaceOverview = parsed as WorkspaceOverview;
        return cachedWorkspaceOverview;
      }
    }
  } catch { /* storage may be restricted */ }
  return null;
}

function updateCachedWorkspaceOverview(data: WorkspaceOverview) {
  cachedWorkspaceOverview = data;
  try {
    sessionStorage.setItem(WORKSPACE_OVERVIEW_STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage may be restricted */ }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<WorkspaceOverview | null>(getInitialWorkspaceOverview);
  const [loading, setLoading] = useState(() => getInitialWorkspaceOverview() === null);
  const [error, setError] = useState("");
  async function refresh() {
    if (!overview && !cachedWorkspaceOverview) {
      setLoading(true);
    }
    try {
      const nextOverview = await api<WorkspaceOverview>("/workspace/context");
      updateCachedWorkspaceOverview(nextOverview);
      setOverview((prev) => {
        if (prev && JSON.stringify(prev) === JSON.stringify(nextOverview)) {
          return prev;
        }
        return nextOverview;
      });
      setError("");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Workspace is unavailable"); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    const handleBusinessChanged = () => { void refresh(); };
    window.addEventListener("npati:business-changed", handleBusinessChanged);
    return () => window.removeEventListener("npati:business-changed", handleBusinessChanged);
  }, []);
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

const blankBusiness = {
  name: "", businessType: "", industry: "", niche: "", country: "", market: "", website: "",
  businessStage: "starting", teamType: "solo", businessModel: "", presenceType: "online",
  description: "", audienceSummary: "", productsServicesSummary: "", legalName: "", contactEmail: "",
  contactPhone: "", postalAddress: "", registrationDetails: "", logoFileId: "",
};

function PageIntro({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <div className="workspace-page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>{action}</div>;
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "error" | "success" }) {
  return <div className={`workspace-notice ${tone}`}>{children}</div>;
}

export function FloatingNotice({
  message,
  tone = "neutral",
  onClose,
  action,
}: {
  message: string;
  tone?: "neutral" | "error" | "success";
  onClose?: () => void;
  action?: ReactNode;
}) {
  useEffect(() => {
    if (!onClose) return;
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  if (!message) return null;

  return (
    <div className={`chat-floating-notice ${tone}`} role="alert">
      <div className="chat-floating-notice-icon">
        {tone === "error" ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : tone === "success" ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        )}
      </div>
      <div className="chat-floating-notice-content">
        <span className="chat-floating-notice-text">{message}</span>
        {action && <div className="chat-floating-notice-action">{action}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          className="chat-floating-notice-close"
          onClick={onClose}
          aria-label="Close notification"
          title="Dismiss"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function BusinessForm({ initial, mode, onCancel, onSaved }: { initial?: Business; mode: string; onCancel?: () => void; onSaved(): Promise<void> }) {
  const [form, setForm] = useState({ ...blankBusiness, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);

  // Cross-linking state: Goals, Memory
  const [availableGoals, setAvailableGoals] = useState<Goal[]>([]);
  const [availableMemories, setAvailableMemories] = useState<MemoryItem[]>([]);

  const [selectedGoalId, setSelectedGoalId] = useState<string>("");
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [newGoalDescription, setNewGoalDescription] = useState("");

  const [selectedMemoryId, setSelectedMemoryId] = useState<string>("");
  const [newMemoryType, setNewMemoryType] = useState("business_fact");
  const [newMemoryTitle, setNewMemoryTitle] = useState("");
  const [newMemoryContent, setNewMemoryContent] = useState("");

  useEffect(() => {
    let active = true;
    async function fetchLinkedData() {
      try {
        const [goalsRes, memoriesRes] = await Promise.all([
          api<Goal[]>("/goals").catch(() => []),
          api<MemoryItem[]>("/memory").catch(() => []),
        ]);
        if (!active) return;
        setAvailableGoals(goalsRes || []);
        setAvailableMemories(memoriesRes || []);

        if (initial?.id) {
          const [bGoals, bMemories] = await Promise.all([
            api<Goal[]>(`/businesses/${initial.id}/goals`).catch(() => []),
            api<MemoryItem[]>(`/businesses/${initial.id}/memory`).catch(() => []),
          ]);
          if (!active) return;
          if (bGoals.length > 0 && bGoals[0]?.id) {
            setSelectedGoalId(bGoals[0].id);
          }
          if (bMemories.length > 0 && bMemories[0]?.id) {
            setSelectedMemoryId(bMemories[0].id);
          }
        }
      } catch {}
    }
    void fetchLinkedData();
    return () => { active = false; };
  }, [initial?.id]);

  function field(name: keyof typeof blankBusiness) {
    return { value: form[name] ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [name]: event.target.value }) };
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const fallbackName = mode === "starting" ? "New Business Idea" : mode === "seller" ? "My Selling Business" : "";
    try {
      const saved = await api<Business>(initial ? `/businesses/${initial.id}` : "/businesses", {
        method: initial ? "PATCH" : "POST",
        body: JSON.stringify({
          ...form,
          name: form.name.trim() || fallbackName,
          businessType: form.businessType || mode,
          businessStage: !initial && mode === "starting" ? "idea" : !initial && mode === "seller" ? "starting" : form.businessStage,
        }),
      });

      const targetBusinessId = saved.id || initial?.id;

      if (targetBusinessId) {
        if (logoFile) {
          if (logoFile.size > 5 * 1024 * 1024) throw new Error("Logo must be 5 MB or smaller");
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error ?? new Error("Could not read logo"));
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.readAsDataURL(logoFile);
          });
          await api(`/businesses/${targetBusinessId}/logo`, {
            method: "POST",
            body: JSON.stringify({ filename: logoFile.name, mimeType: logoFile.type, data }),
          });
        }
        // 1. Goal: link selected or create new
        if (selectedGoalId === "create_new" && newGoalTitle.trim()) {
          await api(`/businesses/${targetBusinessId}/goals`, {
            method: "POST",
            body: JSON.stringify({
              title: newGoalTitle.trim(),
              description: newGoalDescription.trim() || undefined,
              status: "active",
              priority: 1,
            }),
          }).catch(() => {});
        } else if (selectedGoalId && selectedGoalId !== "none" && selectedGoalId !== "create_new") {
          await api(`/businesses/${targetBusinessId}/goals/${selectedGoalId}/link`, {
            method: "POST",
          }).catch(() => {});
        }

        // 2. Memory: link selected or create new
        if (selectedMemoryId === "create_new" && newMemoryTitle.trim() && newMemoryContent.trim()) {
          await api(`/businesses/${targetBusinessId}/memory`, {
            method: "POST",
            body: JSON.stringify({
              type: newMemoryType || "business_fact",
              title: newMemoryTitle.trim(),
              content: newMemoryContent.trim(),
              source: "user",
            }),
          }).catch(() => {});
        } else if (selectedMemoryId && selectedMemoryId !== "none" && selectedMemoryId !== "create_new") {
          await api(`/businesses/${targetBusinessId}/memory/${selectedMemoryId}/link`, {
            method: "POST",
          }).catch(() => {});
        }
      }

      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("businessSettings.form.couldNotSave")); }
    finally { setSaving(false); }
  }

  const { t } = useTranslation();
  return (
    <form className="workspace-form business-profile-form" onSubmit={submit}>
      <div className="form-section-title"><span>{t("businessSettings.form.sectionTitle")}</span><p>{t("businessSettings.form.sectionDesc")}</p></div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="field-grid">
        <label className="field"><span>{t("businessSettings.form.businessName")}</span><input {...field("name")} required={mode === "existing"} placeholder={mode === "starting" ? t("businessSettings.form.optionalForNow") : t("businessSettings.form.businessNamePlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.stage")}</span><select {...field("businessStage")}><option value="idea">{t("businessSettings.form.stageIdea")}</option><option value="starting">{t("businessSettings.form.stageStarting")}</option><option value="operating">{t("businessSettings.form.stageOperating")}</option><option value="growing">{t("businessSettings.form.stageGrowing")}</option><option value="scaling">{t("businessSettings.form.stageScaling")}</option></select></label>
        <label className="field"><span>{t("businessSettings.form.industry")}</span><input {...field("industry")} placeholder={t("businessSettings.form.industryPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.niche")}</span><input {...field("niche")} placeholder={t("businessSettings.form.nichePlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.country")}</span><input {...field("country")} placeholder={t("businessSettings.form.countryPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.market")}</span><input {...field("market")} placeholder={t("businessSettings.form.marketPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.team")}</span><select {...field("teamType")}><option value="solo">{t("businessSettings.form.teamSolo")}</option><option value="team">{t("businessSettings.form.teamTeam")}</option></select></label>
        <label className="field"><span>{t("businessSettings.form.presence")}</span><select {...field("presenceType")}><option value="online">{t("businessSettings.form.presenceOnline")}</option><option value="local">{t("businessSettings.form.presenceLocal")}</option><option value="both">{t("businessSettings.form.presenceBoth")}</option></select></label>
        <label className="field"><span>{t("businessSettings.form.businessModel")}</span><input {...field("businessModel")} placeholder={t("businessSettings.form.businessModelPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.website")}</span><input {...field("website")} type="url" placeholder="https://" /></label>
        <label className="field"><span>Legal company name</span><input {...field("legalName")} placeholder="Registered legal name" /></label>
        <label className="field"><span>Contact email</span><input {...field("contactEmail")} type="email" placeholder="company@example.com" /></label>
        <label className="field"><span>Contact phone</span><input {...field("contactPhone")} type="tel" placeholder="+380…" /></label>
        <label className="field"><span>Postal address</span><input {...field("postalAddress")} placeholder="Street, city, country" /></label>
        <label className="field"><span>Company logo</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)} />{initial?.logoFileId && !logoFile ? <small>Logo already uploaded</small> : null}</label>
      </div>

      <div className="form-section-title" style={{ marginTop: "1.5rem" }}>
        <span>{t("businessSettings.form.alignmentTitle")}</span>
        <p>{t("businessSettings.form.alignmentDesc")}</p>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>{t("businessSettings.form.userGoal")}</span>
          <select value={selectedGoalId} onChange={(e) => setSelectedGoalId(e.target.value)}>
            <option value="none">{t("businessSettings.form.noGoal")}</option>
            {availableGoals.map((g) => (
              <option key={g.id} value={g.id}>
                [{g.status}] {g.title}
              </option>
            ))}
            <option value="create_new">{t("businessSettings.form.createNewGoal")}</option>
          </select>
        </label>

        <label className="field">
          <span>{t("businessSettings.form.memoryForIdea")}</span>
          <select value={selectedMemoryId} onChange={(e) => setSelectedMemoryId(e.target.value)}>
            <option value="none">{t("businessSettings.form.noMemory")}</option>
            {availableMemories.map((m) => (
              <option key={m.id} value={m.id}>
                [{m.type}] {m.title}: {m.content.slice(0, 35)}...
              </option>
            ))}
            <option value="create_new">{t("businessSettings.form.addNewMemory")}</option>
          </select>
        </label>
      </div>

      {selectedGoalId === "create_new" && (
        <div className="field-grid" style={{ marginTop: "0.5rem" }}>
          <label className="field">
            <span>{t("businessSettings.form.newGoalTitle")}</span>
            <input
              value={newGoalTitle}
              onChange={(e) => setNewGoalTitle(e.target.value)}
              placeholder={t("businessSettings.form.newGoalTitlePlaceholder")}
              required
            />
          </label>
          <label className="field">
            <span>{t("businessSettings.form.goalDescription")}</span>
            <input
              value={newGoalDescription}
              onChange={(e) => setNewGoalDescription(e.target.value)}
              placeholder={t("businessSettings.form.goalDescPlaceholder")}
            />
          </label>
        </div>
      )}

      {selectedMemoryId === "create_new" && (
        <div className="business-narrative-fields" style={{ marginTop: "0.5rem" }}>
          <div className="field-grid">
            <label className="field">
              <span>{t("businessSettings.form.memoryCategory")}</span>
              <select value={newMemoryType} onChange={(e) => setNewMemoryType(e.target.value)}>
                <option value="business_fact">{t("businessSettings.form.memBusinessFact")}</option>
                <option value="audience">{t("businessSettings.form.memAudience")}</option>
                <option value="brand">{t("businessSettings.form.memBrand")}</option>
                <option value="preference">{t("businessSettings.form.memPreference")}</option>
                <option value="decision">{t("businessSettings.form.memDecision")}</option>
                <option value="product">{t("businessSettings.form.memProduct")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("businessSettings.form.factTitle")}</span>
              <input
                value={newMemoryTitle}
                onChange={(e) => setNewMemoryTitle(e.target.value)}
                placeholder={t("businessSettings.form.factTitlePlaceholder")}
                required
              />
            </label>
          </div>
          <label className="field">
            <span>{t("businessSettings.form.memoryContent")}</span>
            <textarea
              value={newMemoryContent}
              onChange={(e) => setNewMemoryContent(e.target.value)}
              placeholder={t("businessSettings.form.memoryContentPlaceholder")}
              required
            />
          </label>
        </div>
      )}

      <div className="business-narrative-fields">
        <label className="field"><span>{t("businessSettings.form.whatDoes")}</span><textarea {...field("description")} placeholder={t("businessSettings.form.whatDoesPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.productsServices")}</span><textarea {...field("productsServicesSummary")} placeholder={t("businessSettings.form.productsPlaceholder")} /></label>
        <label className="field"><span>{t("businessSettings.form.targetAudience")}</span><textarea {...field("audienceSummary")} placeholder={t("businessSettings.form.audiencePlaceholder")} /></label>
        <label className="field"><span>Registration details</span><textarea {...field("registrationDetails")} placeholder="Company number, tax/VAT ID, preferred username, profile instructions, and other data the agent may enter on approved sites." /></label>
      </div>
      <div className="form-actions">{onCancel && <button type="button" className="button-secondary" onClick={onCancel} disabled={saving}>{t("common.cancel")}</button>}<button className="button-primary" disabled={saving}>{saving ? t("businessSettings.form.saving") : initial ? t("businessSettings.form.saveChanges") : t("businessSettings.form.createBusiness")}</button></div>
    </form>
  );
}

function BusinessSettingsHeader({ title, copy, action, backTo = "/settings", onBack }: { title?: string; copy: string; action?: ReactNode; backTo?: string; onBack?: () => void }) {
  const { t } = useTranslation();
  const displayTitle = title || t("businessSettings.title");
  return (
    <header className="inspector-header automations-header business-settings-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">{t("businessSettings.eyebrow")}</p>
          <h1>
            {onBack ? <button type="button" className="marketplace-back-button" aria-label={t("businessSettings.backToProfiles")} title={t("businessSettings.backToProfiles")} onClick={onBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button> : <Link to={backTo} className="marketplace-back-button" aria-label={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")} title={backTo === "/settings" ? t("businessSettings.backToSettings") : t("businessSettings.backToProfiles")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>}
            <span>{displayTitle}</span>
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
  const { t } = useTranslation();

  useEffect(() => {
    if (!editTarget || current?.id === editTarget.id) return;
    void switchBusiness(editTarget.id);
  }, [editTarget?.id, current?.id]);

  function createBusinessIdea() {
    navigate("/b/new", { state: { newBusiness: Date.now() } });
  }

  async function removeBusiness(id: string, name: string) {
    if (!await confirmModal({
      title: t("businessSettings.dialogs.deleteTitle"),
      message: t("businessSettings.dialogs.deleteMessage", { name }),
      confirmText: t("businessSettings.dialogs.deleteConfirm"),
      cancelText: t("businessSettings.dialogs.deleteCancel"),
      isDanger: true,
    })) return;
    await api(`/businesses/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function convertToCompany(business: Business) {
    if (!await confirmModal({
      title: t("businessSettings.dialogs.createCompanyTitle"),
      message: t("businessSettings.dialogs.createCompanyMessage", { name: business.name }),
      confirmText: t("businessSettings.dialogs.createCompanyConfirm"),
      cancelText: t("businessSettings.dialogs.createCompanyCancel"),
      isDanger: false,
    })) return;
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
      await alertModal({
        title: t("businessSettings.dialogs.companyCreationFailed"),
        message: reason instanceof Error ? reason.message : t("businessSettings.dialogs.companyCreationError"),
        isDanger: true,
      });
    } finally {
      setConvertingId(null);
    }
  }

  if (loading && editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo="/settings/business" /></main>;
  if (error) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo={editBusinessId ? "/settings/business" : "/settings"} /><Notice tone="error">{error}</Notice></main>;

  if (creatingManually) {
    return (
      <main className="automations-container business-settings-page">
        <BusinessSettingsHeader title={t("businessSettings.newBusinessTitle")} copy={t("businessSettings.newBusinessCopy")} onBack={() => setCreatingManually(false)} />
        <BusinessForm
          mode="existing"
          onCancel={() => setCreatingManually(false)}
          onSaved={async () => { await refresh(); setCreatingManually(false); }}
        />
      </main>
    );
  }

  if (editDraft) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editDraft.business.name} copy={t("businessSettings.editDraftCopy")} backTo="/settings/business" /><BusinessForm initial={editDraft.business} mode={editDraft.scenario} onSaved={refresh} /></main>;
  }
  if (editTarget && current?.id !== editTarget.id) return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy={t("businessSettings.openingCopy")} backTo="/settings/business" /><div className="workspace-loading">{t("businessSettings.openingProfile")}</div></main>;
  if (editTarget) {
    return <main className="automations-container business-settings-page"><BusinessSettingsHeader title={editTarget.name} copy={t("businessSettings.editCopy")} backTo="/settings/business" /><BusinessForm initial={editTarget} mode={editTarget.businessType ?? "existing"} onSaved={refresh} /></main>;
  }
  if (editBusinessId) return <main className="automations-container business-settings-page"><BusinessSettingsHeader copy={t("businessSettings.loadingCopy")} backTo="/settings/business" /><Notice tone="error">{t("businessSettings.notFoundError")}</Notice></main>;

  const businesses = overview?.businesses ?? [];
  const drafts = overview?.onboardings ?? [];
  const ideaCount = businesses.length + drafts.length;
  return (
    <main className="automations-container business-settings-page">
      <BusinessSettingsHeader
        copy={t("businessSettings.description")}
        action={<button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>{t("businessSettings.addBusiness")}</button>}
      />

      <section className="overview-grid inspector-stats-grid business-stats-grid">
        <div><strong>{ideaCount}</strong><span>{t("businessSettings.stats.businessProfiles")}</span><small>{t("businessSettings.stats.allActiveDesc")}</small></div>
        <div><strong>{businesses.length}</strong><span>{t("businessSettings.stats.activeBusinesses")}</span><small>{t("businessSettings.stats.readyToUse")}</small></div>
        <div><strong>{drafts.length}</strong><span>{t("businessSettings.stats.setupDrafts")}</span><small>{t("businessSettings.stats.awaitingCompletion")}</small></div>
        <div><strong>{current ? 1 : 0}</strong><span>{t("businessSettings.stats.currentContext")}</span><small>{current?.name || t("businessSettings.stats.noBusinessSelected")}</small></div>
      </section>

      <div className="inspector-table-status business-list-status">
        <div className="status-left"><span>{t("businessSettings.list.showingProfiles")} <strong>{ideaCount}</strong> {ideaCount === 1 ? t("businessSettings.list.profile") : t("businessSettings.list.profiles")}</span></div>
      </div>

      {ideaCount === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">B</div>
          <h3>{t("businessSettings.empty.title")}</h3>
          <p>{t("businessSettings.empty.description")}</p>
          <button className="button-primary automations-action-primary" onClick={() => setCreatingManually(true)}>{t("businessSettings.createFirstBusiness")}</button>
        </div>
      ) : (
        <div className="record-list business-profile-list">
          {drafts.map((draft) => (
            <article className="record-card business-profile-card" key={draft.businessId} onClick={() => navigate(`/b/${draft.businessId}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{draft.business.name.charAt(0).toUpperCase() || "B"}</span>
                <div><span className="record-status">{t("businessSettings.card.setupDraft")}</span><h3>{draft.business.name}</h3><p>{t("businessSettings.card.stepsCompleted", { completed: String(draft.completedFields.length), total: String(draft.totalFields) })}</p></div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/b/${draft.businessId}`); }}>{t("businessSettings.card.continueSetup")}</button>
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${draft.businessId}`); }}>{t("businessSettings.card.edit")}</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(draft.businessId, draft.business.name); }}>{t("businessSettings.card.delete")}</button>
              </div>
            </article>
          ))}
          {businesses.map((business) => (
            <article className="record-card business-profile-card" key={business.id} onClick={() => navigate(`/settings/business/${business.id}`)}>
              <div className="business-card-main">
                <span className="business-card-icon">{business.name.charAt(0).toUpperCase() || "B"}</span>
                <div>
                  <span className={`record-status${business.id === current?.id ? " active" : ""}`}>{business.id === current?.id ? t("businessSettings.card.current") : business.businessStage}</span>
                  <h3>{business.name}</h3>
                  <p>{business.description || business.industry || t("businessSettings.card.businessProfile")}</p>
                  <div className="business-card-meta">
                    {business.industry && <span>{business.industry}</span>}
                    {business.market && <span>{business.market}</span>}
                    {business.country && <span>{business.country}</span>}
                  </div>
                </div>
              </div>
              <div className="record-actions">
                <button onClick={(event) => { event.stopPropagation(); navigate(`/settings/business/${business.id}`); }}>{t("businessSettings.card.edit")}</button>
                <button disabled={convertingId === business.id} onClick={(event) => { event.stopPropagation(); void convertToCompany(business); }}>{convertingId === business.id ? t("businessSettings.card.converting") : t("businessSettings.card.createCompany")}</button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); void removeBusiness(business.id, business.name); }}>{t("businessSettings.card.delete")}</button>
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
  useEffect(() => {
    void load().catch((reason) => setError(String(reason)));
    const handleGoalsChanged = () => { void load().catch(() => {}); };
    window.addEventListener("npati:goals-changed", handleGoalsChanged);
    return () => window.removeEventListener("npati:goals-changed", handleGoalsChanged);
  }, [business?.id]);
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

const DEFAULT_SKILLS: Skill[] = [
  {
    id: "competitor-analysis",
    name: "Competitor Analysis",
    description: "Finds relevant competitors and compares public evidence with the current Business context.",
    capabilities: ["competitors.discover", "competitors.compare", "web.search", "web.fetch", "web.crawl"],
  },
  {
    id: "web-research",
    name: "Web Research",
    description: "Searches and reads public web sources through the protected NPATI Web Research boundary.",
    capabilities: ["web.search", "web.fetch", "web.crawl"],
  },
  {
    id: "business-startup",
    name: "Business Startup",
    description: "Shape a business idea, audience, offer, and first validation plan.",
    capabilities: ["business-idea", "niche", "audience", "validation"],
  },
  {
    id: "business-growth",
    name: "Business Growth",
    description: "Find practical acquisition, retention, positioning, and growth opportunities.",
    capabilities: ["growth-plan", "customer-acquisition", "retention", "metrics"],
  },
  {
    id: "sell-product",
    name: "Sell Product",
    description: "Turn a product or service into a clear offer and sales plan.",
    capabilities: ["offer", "positioning", "pricing", "sales-channel"],
  },
];

const STORAGE_SKILLS_KEY = "npati_skills_cache_v1";

function getCachedSkills(): Skill[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_SKILLS_KEY) || localStorage.getItem(STORAGE_SKILLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_SKILLS;
}

function updateCachedSkills(items: Skill[]) {
  try {
    const serialized = JSON.stringify(items);
    sessionStorage.setItem(STORAGE_SKILLS_KEY, serialized);
    localStorage.setItem(STORAGE_SKILLS_KEY, serialized);
  } catch {}
}

export function SkillsPage() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>(getCachedSkills);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<Skill[]>("/skills")
      .then((data) => {
        setSkills(data);
        updateCachedSkills(data);
        setError("");
      })
      .catch((reason) => {
        if (skills.length === 0) {
          setError(reason instanceof Error ? reason.message : t("skillsPage.errorLoading"));
        }
      })
      .finally(() => setLoading(false));
  }, [t]);

  const getSkillInfo = useCallback((skill: Skill) => {
    switch (skill.id) {
      case "competitor-analysis":
        return {
          name: t("skillsPage.skills.competitorAnalysis.name"),
          description: t("skillsPage.skills.competitorAnalysis.desc"),
        };
      case "web-research":
        return {
          name: t("skillsPage.skills.webResearch.name"),
          description: t("skillsPage.skills.webResearch.desc"),
        };
      case "business-startup":
        return {
          name: t("skillsPage.skills.businessStartup.name"),
          description: t("skillsPage.skills.businessStartup.desc"),
        };
      case "business-growth":
        return {
          name: t("skillsPage.skills.businessGrowth.name"),
          description: t("skillsPage.skills.businessGrowth.desc"),
        };
      case "sell-product":
        return {
          name: t("skillsPage.skills.sellProduct.name"),
          description: t("skillsPage.skills.sellProduct.desc"),
        };
      default:
        return {
          name: skill.name,
          description: skill.description,
        };
    }
  }, [t]);

  const localizedSkills = useMemo(() => {
    return skills.map((skill) => {
      const info = getSkillInfo(skill);
      return {
        ...skill,
        name: info.name,
        description: info.description,
      };
    });
  }, [skills, getSkillInfo]);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return localizedSkills;
    return localizedSkills.filter((skill) => skill.name.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.capabilities.some((capability) => capability.toLowerCase().includes(query)));
  }, [search, localizedSkills]);
  const capabilityCount = useMemo(() => new Set(skills.flatMap((skill) => skill.capabilities)).size, [skills]);

  return (
    <main className="automations-container skills-container">
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("skillsPage.eyebrow")}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label={t("skillsPage.backToSettings")} title={t("skillsPage.backToSettings")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("skillsPage.title")}</span>
            </h1>
            <p className="hero-copy">{t("skillsPage.heroCopy")}</p>
          </div>
          <span className="skills-readonly-badge">{t("skillsPage.badgeBuiltin")}</span>
        </div>
      </header>

      <section className="overview-grid inspector-stats-grid skills-stats-grid">
        <div><strong>{skills.length}</strong><span>{t("skillsPage.stats.availableSkills")}</span><small>{t("skillsPage.stats.availableSkillsDesc")}</small></div>
        <div><strong>{capabilityCount}</strong><span>{t("skillsPage.stats.capabilities")}</span><small>{t("skillsPage.stats.capabilitiesDesc")}</small></div>
        <div><strong>{t("skillsPage.stats.autoValue")}</strong><span>{t("skillsPage.stats.skillSelection")}</span><small>{t("skillsPage.stats.skillSelectionDesc")}</small></div>
      </section>

      <div className="inspector-controls skills-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input type="text" role="searchbox" placeholder={t("skillsPage.searchPlaceholder")} value={search}
            onChange={(event) => setSearch(event.target.value)} className="inspector-search-input" aria-label={t("skillsPage.searchAria")} />
          {search && <button type="button" className="search-clear-btn" onClick={() => setSearch("")} aria-label={t("skillsPage.clearSearch")}>×</button>}
        </div>
      </div>

      <div className="inspector-table-status">
        <div className="status-left"><span>{t("skillsPage.statusShowing.showing")} <strong>{filteredSkills.length}</strong> {t("skillsPage.statusShowing.of")} <strong>{skills.length}</strong> {t("skillsPage.statusShowing.skills")}</span></div>
      </div>

      {error ? <div className="workspace-notice error">{error}</div> : filteredSkills.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">⌕</div><h3>{t("skillsPage.empty.title")}</h3>
          <p>{t("skillsPage.empty.description")}</p>
          <button type="button" className="button-secondary" onClick={() => setSearch("")}>{t("skillsPage.empty.clearSearch")}</button>
        </div>
      ) : (
        <div className="skill-grid skills-catalog-grid">
          {filteredSkills.map((skill, index) => (
            <article key={skill.id} className="skills-catalog-card">
              <div className="skills-card-head">
                <span className="skills-card-icon" aria-hidden="true">{index + 1}</span>
                <span className="skills-card-status"><i /> {t("skillsPage.card.available")}</span>
              </div>
              <div className="skills-card-type">{t("skillsPage.card.builtinType")}</div>
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

function expandDeleteConfirmationReply(message: string, history: Message[]): string {
  if (!/^(?:так|так,|підтверджую|да|да,|подтверждаю|yes|yes,|confirm)$/iu.test(message.trim())) return message;
  const previous = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
  const command = /(?:Для підтвердження напишіть|Для подтверждения напишите|To confirm, write):\s*\*\*([^*]+)\*\*/iu.exec(previous)?.[1]?.trim();
  return command || message;
}

function isWebsiteAnalysisRequest(message: string) {
  return /https?:\/\/|www\.|\b(?:website|webpage|site|scan|crawl)\b|сайт|вебсторінк|проскануй/iu.test(message);
}

const PAGE_PROGRESS_PRESENTATION_MS = 1200;

function AssistantMessageToolbar({
  content,
  onRegenerate,
}: {
  content: string;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);

  const handleCopy = async () => {
    const clean = content
      .replace(/^```card:[^\n]*\n([\s\S]*?)\n```$/gm, "$1")
      .trim();
    try {
      await navigator.clipboard.writeText(clean);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = clean;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "NPATI Agent",
          text: content,
        });
        return;
      } catch {}
    }
    handleCopy();
  };

  return (
    <div className="assistant-message-toolbar" aria-label="Message actions">
      <button
        type="button"
        className={`assistant-toolbar-btn ${copied ? "copied" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy entire response"}
        aria-label="Copy entire response"
      >
        {copied ? (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={`assistant-toolbar-btn ${liked === true ? "active" : ""}`}
        onClick={() => setLiked((prev) => (prev === true ? null : true))}
        title="Helpful response"
        aria-label="Helpful response"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill={liked === true ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button
        type="button"
        className={`assistant-toolbar-btn ${liked === false ? "active" : ""}`}
        onClick={() => setLiked((prev) => (prev === false ? null : false))}
        title="Not helpful response"
        aria-label="Not helpful response"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill={liked === false ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
        </svg>
      </button>
      <button
        type="button"
        className="assistant-toolbar-btn"
        onClick={handleShare}
        title="Share response"
        aria-label="Share response"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
      </button>
      {onRegenerate && (
        <button
          type="button"
          className="assistant-toolbar-btn"
          onClick={onRegenerate}
          title="Regenerate"
          aria-label="Regenerate"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
        </button>
      )}
    </div>
  );
}


function ProjectChatCard({ card }: { card: ProjectCardData }) {
  const navigate = useNavigate();
  const builderUrl = card.companyId
    ? `/settings/websites/${encodeURIComponent(card.companyId)}/${encodeURIComponent(card.id)}`
    : `/projects/${encodeURIComponent(card.id)}`;

  return (
    <div className="project-chat-card-container">
      <div className="project-chat-card">
        <div className="project-chat-card-top">
          <div className="project-chat-card-info">
            <span className="project-chat-card-icon">🌐</span>
            <div>
              <h4 className="project-chat-card-title">{card.name}</h4>
              <span className="project-chat-card-sub">
                {card.framework || "Website"} · {card.agentName ? `${card.agentName} (${card.agentRole})` : "Developer Agent"}
              </span>
            </div>
          </div>
          <span className={`status-pill status-${card.status}`}>{card.status}</span>
        </div>
        <div className="project-chat-card-meta">
          <span>Build: <strong className={`build-${card.lastBuildStatus || "ready"}`}>{card.lastBuildStatus || "ready"}</strong></span>
          {card.previewUrl && <span className="preview-live-badge">● Live Preview Active</span>}
        </div>
        <div className="project-chat-card-actions">
          <button
            type="button"
            className="button-primary"
            onClick={() => navigate(builderUrl)}
          >
            Open in Website Builder →
          </button>
          {card.previewUrl ? (
            <a
              href={card.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="button-secondary"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              Preview ↗
            </a>
          ) : (
            <button
              type="button"
              className="button-secondary"
              onClick={() => navigate(`${builderUrl}?tab=preview`)}
            >
              Preview
            </button>
          )}
          <button
            type="button"
            className="button-secondary"
            onClick={() => navigate(`${builderUrl}?tab=changes`)}
          >
            Changes
          </button>
          {card.runId && (
            <Link to={`/activity?runId=${card.runId}`} className="button-secondary project-view-run-link">
              View Run
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export function BusinessChatPage({ initialPrompt = "", initialConversationId, neutralChat = false, companyId }: { initialPrompt?: string; initialConversationId?: string; neutralChat?: boolean; companyId?: string }) {
  const { t } = useTranslation();
  const { overview } = useWorkspace(); const business = neutralChat || companyId ? null : overview?.currentBusiness;
  const contextSwitcher = useContext(ChatContextSwitcherContext);
  const navigate = useNavigate();
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
  const [streamingResponse,setStreamingResponse]=useState(false);
  const [notice, setNotice] = useState(""); const [replyMeta, setReplyMeta] = useState<AgentReply | null>(null);
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (messageStreamRef.current) {
      messageStreamRef.current.scrollTo({
        top: messageStreamRef.current.scrollHeight,
        behavior,
      });
    }
    streamEndRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const scrollToLatestMessageStart = useCallback((behavior: ScrollBehavior = "auto") => {
    if (latestMessageRef.current) {
      latestMessageRef.current.scrollIntoView({ behavior, block: "start" });
    } else if (messageStreamRef.current) {
      messageStreamRef.current.scrollTo({
        top: messageStreamRef.current.scrollHeight,
        behavior,
      });
    }
  }, []);
  const [progressEvents, setProgressEvents] = useState<ChatProgressEvent[]>([]);
  const [visibleProgressCount, setVisibleProgressCount] = useState(0);
  const [presentingProgressEvent, setPresentingProgressEvent] = useState<ChatProgressEvent | null>(null);
  const [progressComplete, setProgressComplete] = useState(false);
  const [progressFailed, setProgressFailed] = useState(false);
  const progressCompleteRef = useRef(false);
  const flushDeltasRef = useRef<(() => void) | null>(null);
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
        setMessages((current) => {
          if (current.length === loaded.length) {
            const allMatch = current.every((cur, i) => loaded[i]?.role === cur.role);
            if (allMatch) {
              return current.map((cur, i) => {
                const lod = loaded[i]!;
                return cur.id === lod.id && cur.content === lod.content ? cur : { ...cur, id: lod.id, content: lod.content };
              });
            }
          }
          return loaded;
        });
        if (!preserveActiveTurn && !activeTurn) {
          window.requestAnimationFrame(() => {
            scrollToLatestMessageStart("auto");
            setTimeout(() => scrollToLatestMessageStart("auto"), 50);
            setTimeout(() => scrollToLatestMessageStart("auto"), 150);
            setTimeout(() => scrollToLatestMessageStart("auto"), 300);
          });
        } else if (activeTurn && activeTurnRef.current) {
          window.requestAnimationFrame(() => {
            activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    // When there is an active turn (user just sent a message or assistant is replying),
    // do NOT scroll to the bottom of the long message!
    // The user must always see the beginning of the conversation turn.
    if (activeTurn) {
      return;
    }
    if (!sending) {
      const frame = window.requestAnimationFrame(() => {
        scrollToBottom("smooth");
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages, sending, activeTurn, scrollToBottom]);
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
        if (progressEventsRef.current.some((e) => !e.type.startsWith("final_generation"))) {
          progressCompleteRef.current = true;
          setProgressComplete(true);
          flushDeltasRef.current?.();
        }
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
          if (progressQueueRef.current.length > 0) {
            drainProgressQueue();
          } else {
            progressCompleteRef.current = true;
            setProgressComplete(true);
            flushDeltasRef.current?.();
          }
        }, PAGE_PROGRESS_PRESENTATION_MS);
        return;
      }
      progressQueueRef.current.shift();
      setVisibleProgressCount((count) => count + 1);
      nextProgressRevealRef.current = Date.now() + (next.type === "search_results_received" ? 0 : 800);
      progressTimerRef.current = null;
      if (progressQueueRef.current.length > 0) {
        drainProgressQueue();
      } else {
        progressCompleteRef.current = true;
        setProgressComplete(true);
        flushDeltasRef.current?.();
      }
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
    if (event.type === "source_discovered") return;
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
    if (event.type === "page_fetch_started") {
      // Web research emits transient duplicate starts while navigating. File
      // attachments are distinct user inputs and every filename must remain
      // visible in the shared progress panel.
      if (pageStartPendingRef.current && event.domain !== "file") return;
      if (event.domain !== "file") pageStartPendingRef.current = true;
    }
    if (event.type === "page_fetch_completed" || event.type === "page_fetch_failed" || event.type === "research_completed") {
      pageStartPendingRef.current = false;
    }
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
    progressCompleteRef.current = false;
    flushDeltasRef.current = null;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); const message = input.trim(); if ((!message && attachments.length === 0) || sending) return;
    const requestMessage = expandDeleteConfirmationReply(message, messages);
    const conversationAtSubmit = selected;
    // An earlier history request must not replace the optimistic turn after it starts.
    historyLoadVersionRef.current += 1;
    const privateRequest = noMemory;
    const optimisticId = `pending-${Date.now()}`;
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
    for (const mutationTarget of mutationTargets) enqueueProgress({ type: "action_started", ...mutationTarget, timestamp: new Date().toISOString() });
    setSending(true); setStreamingResponse(false); setNotice(""); setInput(""); setAttachments([]); setReplyMeta(null);
    window.requestAnimationFrame(() => {
      activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      setTimeout(() => activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    });
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
        activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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

    const activeCompanyForRequest = companyId ?? readActiveCompanyId();
    let activeProjectId: string | undefined;
    try {
      const stored = sessionStorage.getItem("npati_active_project");
      if (stored) {
        const active = JSON.parse(stored) as { companyId?: string; projectId?: string };
        if (active.companyId === activeCompanyForRequest) activeProjectId = active.projectId;
      }
    } catch {}
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
        try {
          sessionStorage.setItem("npati_active_project", JSON.stringify({ companyId: result.activeContext.companyId, projectId: result.activeContext.projectId }));
          if (!readActiveCompanyId() && result.activeContext.companyId) writeActiveCompanyId(result.activeContext.companyId);
        } catch {}
      }
      setMessages((current) => {
        const found = current.some((item) => item.id === assistantId);
        if (!cleanedMessage) return current.filter((item) => item.id !== assistantId);
        return found
          ? current.map((item) => item.id === assistantId ? { ...item, content: cleanedMessage, projectCard: result.projectCard } : item)
          : [...current, { id: assistantId, role: "assistant", content: cleanedMessage, projectCard: result.projectCard, createdAt: new Date().toISOString() }];
      });
      if (!privateRequest && result.conversationId) {
        setSelected(result.conversationId);
        window.history.replaceState(
          { ...window.history.state, usr: business ? { businessId: business.id } : { neutralChat: true } },
          "",
          `/c/${result.conversationId}`
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
      progressCompleteRef.current = true;
      setProgressComplete(true);
    } catch (reason) {
      flushDeltas();
      const typed = reason as Error & { code?: string };
      if (typed.name === "AbortError") {
        window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "refresh" } }));
        progressCompleteRef.current = true;
        setProgressComplete(true);
        setNotice("");
        return;
      }
      setProgressFailed(true);
      setNotice(typed.message);
      window.dispatchEvent(new CustomEvent("npati:company-changed", { detail: { action: "refresh" } }));
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
    } finally {
      flushDeltas();
      if (streamControllerRef.current?.controller === controller) streamControllerRef.current = null;
      setSending(false);
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
        <div className="message-stream" ref={messageStreamRef}>
          {messages.length === 0 && !selected && !initialConversationId && !loadingHistory && (
            <div className="chat-welcome">
              <h2>{t("chat.emptyTitle")}</h2>
              <p>{business ? t("chat.businessEmptySubtitle", { name: business.name }) : t("chat.emptySubtitle")}</p>
            </div>
          )}
          {messages.map((message, index) => {
            const isLatestAssistant = message.role === "assistant" && index === messages.length - 1;
            const hasResearch = progressEvents.some((event) => !event.type.startsWith("final_generation"));
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
                    if (index === messages.length - 1) {
                      latestMessageRef.current = el;
                    }
                    if (message.role === "user" && message.content === activeTurn && !messages.slice(index + 1).some((item) => item.role === "user" && item.content === activeTurn)) {
                      activeTurnRef.current = el;
                    }
                  }}
                  className={`${message.role}${message.role === "user" && messageHasImage(message) ? " image-message" : ""}`}
                  aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}
                >
                  <PendingMessageAttachments value={message.attachments ?? []} />
                  {message.role === "user" ? <UserPromptMessage content={message.content} onEdit={(prompt) => { setInput(prompt); window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".onboarding-live-composer textarea")?.focus()); }} /> : <ChatMessageContent content={message.content} />}
                  {message.projectCard && <ProjectChatCard card={message.projectCard} />}
                  {message.role === "assistant" && !sending && (
                    <AssistantMessageToolbar
                      content={message.content}
                      onRegenerate={() => {
                        for (let k = index - 1; k >= 0; k--) {
                          if (messages[k]?.role === "user") {
                            setInput(messages[k]!.content);
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
          {!messages.some((m, idx) => m.role === "assistant" && idx === messages.length - 1) && progressEvents.some((event) => !event.type.startsWith("final_generation")) && (
            <ResearchProgressPanel
              events={progressEvents}
              visibleCount={visibleProgressCount}
              presentingEvent={presentingProgressEvent}
              completed={!sending && progressComplete}
              failed={!sending && progressFailed}
            />
          )}
          {sending && !streamingResponse && !progressEvents.some((event) => !event.type.startsWith("final_generation")) && <article className="assistant thinking thinking-status" aria-label="NPATI Agent is working"><p>{isWebsiteAnalysisRequest(activeTurn) ? "Analyzing website and sources…" : businessThinkingSteps[thinkingStep]}</p><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article>}
          {messages.length > 0 && <div className="chat-scroll-spacer" aria-hidden="true" />}
          <div ref={streamEndRef} aria-hidden="true" />
        </div>
        {replyMeta?.memoryCandidate && <div className="memory-candidate"><div><strong>Remember this?</strong><p>{replyMeta.memoryCandidate.title}: {replyMeta.memoryCandidate.content}</p></div><button onClick={() => void remember()}>Remember</button><button onClick={() => setReplyMeta({ ...replyMeta, memoryCandidate: undefined })}>Not now</button></div>}
        <form className="onboarding-live-composer" onSubmit={(event) => void submit(event)}>
          {contextSwitcher}
          {noMemory && (
            <span className="composer-private-badge" title="Private request active: memory, chat history, and attachments are not saved">
              <span className="composer-private-dot" aria-hidden="true" />
              <span>Private request</span>
            </span>
          )}
          {ttsEnabled && (
            <span className="composer-tts-badge" title={`Text-to-Speech active (Voice: ${SPEECH_VOICES.find((v) => v.id === ttsVoice)?.label ?? ttsVoice})`}>
              <span className="composer-tts-dot" aria-hidden="true" />
              <span>TTS: {SPEECH_VOICES.find((v) => v.id === ttsVoice)?.label ?? ttsVoice}</span>
            </span>
          )}
          <ChatAttachments
            value={attachments}
            onChange={setAttachments}
            onError={setNotice}
            disabled={sending}
            privateRequestEnabled={chatMode === "private"}
            onPrivateRequestChange={(enabled) => handleModeChange(enabled ? "private" : "none")}
            ttsEnabled={chatMode === "tts"}
            onTtsEnabledChange={(enabled) => handleModeChange(enabled ? "tts" : "none")}
            ttsVoice={ttsVoice}
            onTtsVoiceChange={handleTtsVoiceChange}
            inputText={input}
            onGenerateSpeech={generateSpeechForInput}
            isGeneratingSpeech={isGeneratingSpeech}
          />
          <AutoResizeChatTextarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} placeholder={business ? t("chat.businessPlaceholder") : t("chat.placeholder")} />
          <div>
            {sending ? (
              <button
                type="button"
                className="chat-stop-btn"
                onClick={() => {
                  const active = streamControllerRef.current;
                  if (active) void cancelChatStream(active.streamId).finally(() => active.controller.abort(new DOMException("Stopped", "AbortError")));
                }}
                aria-label="Stop generating"
                title="Stop generating"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2.5" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="chat-send-btn"
                disabled={!input.trim() && attachments.length === 0}
                aria-label="Send"
                title="Send"
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <polyline points="14 6 20 12 14 18" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
