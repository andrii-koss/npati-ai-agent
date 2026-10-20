import { Monitor } from "lucide-react";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { ProjectCardData } from "@npati/shared";
import { FormEvent, ReactNode, SyntheticEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { type ChatAttachmentInput } from "./ChatAttachments";
import { persistedModeLabel } from "./code-workspace/actions";
import { Business, Goal, MemoryItem, Company, api, blankBusiness, Notice } from "./business-workspace-shared";

export function BusinessForm({ initial, mode, onCancel, onSaved }: { initial?: Business; mode: string; onCancel?: () => void; onSaved(): Promise<void> }) {
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
export function ProjectChatCard({ card, onActivate, previewOnly = false, showPreviewTrigger = true }: { card: ProjectCardData; onActivate?: (card: ProjectCardData) => void; previewOnly?: boolean; showPreviewTrigger?: boolean }) {
  const navigate = useNavigate();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(card.previewUrl ?? "");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // C7: a code project opens the Code Workspace instead of the Website Builder. `tab=changes` is the same
  // convention the builder link uses, so the Changes action lands on the tab the user asked for.
  const isCodeProject = card.kind === "code_project";
  const codeWorkspaceUrl = card.companyId && card.projectId
    ? `/settings/code/${encodeURIComponent(card.companyId)}/${encodeURIComponent(card.projectId)}${card.sessionId ? `?session=${encodeURIComponent(card.sessionId)}` : ""}`
    : null;
  const codeChangesUrl = codeWorkspaceUrl
    ? `${codeWorkspaceUrl}${codeWorkspaceUrl.includes("?") ? "&" : "?"}tab=changes`
    : null;

  useEffect(() => {
    if (!previewOpen) return;
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === (card.projectId ?? card.id)) void openPreview();
    };
    window.addEventListener("npati-code-project-updated", refresh);
    return () => window.removeEventListener("npati-code-project-updated", refresh);
  }, [previewOpen, card.companyId, card.projectId, card.id]);

  useEffect(() => {
    if (!previewOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewOpen]);

  async function loadStaticPreviewPage(filePath: string) {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) {
      throw new Error("Invalid preview page.");
    }
    const token = getStoredAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const filesUrl = `/api/companies/${encodeURIComponent(card.companyId)}/projects/${encodeURIComponent(card.projectId ?? card.id)}/files/read?path=${encodeURIComponent(filePath)}`;
    const response = await fetch(filesUrl, { headers });
    const file = await response.json().catch(() => null) as { content?: string; error?: { message?: string } } | null;
    if (!response.ok || !file?.content) throw new Error(file?.error?.message || `${filePath} is unavailable.`);
    setPreviewHtml(file.content);
  }

  function handleStaticPreviewLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    event.currentTarget.contentDocument?.addEventListener("click", (clickEvent) => {
      const target = clickEvent.target as Element | null;
      const link = typeof target?.closest === "function" ? target.closest("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!href || href.startsWith("#") || /^[a-z]+:\/\//i.test(href)) return;
      const filePath = href.startsWith("/") ? `${href.slice(1).replace(/\/$/, "") || "index"}.html` : href;
      if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) return;
      clickEvent.preventDefault();
      void loadStaticPreviewPage(filePath).catch((error) => {
        setPreviewHtml("");
        setPreviewError(error instanceof Error ? error.message : "Preview page is unavailable.");
      });
    });
  }
  async function openPreview() {
    setPreviewOpen(true);
    setPreviewError("");
    setPreviewUrl("");
    setPreviewHtml("");
    if (!card.companyId) {
      setPreviewError("Project company is unavailable.");
      return;
    }
    setPreviewLoading(true);
    try {
      const token = getStoredAuthToken();
      const endpoint = `/api/companies/${encodeURIComponent(card.companyId)}/projects/${encodeURIComponent(card.projectId ?? card.id)}/preview`;
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (card.framework === "HTML/CSS" && !isCodeProject) {
        await loadStaticPreviewPage("index.html");
        return;
      }
      const statusResponse = await fetch(`${endpoint}/status`, { headers });
      const status = await statusResponse.json().catch(() => null) as
        | { isRunning?: boolean }
        | null;
      if (statusResponse.ok && status?.isRunning) {
        const tokenResponse = await fetch(`${endpoint}/token`, { headers });
        const freshToken = await tokenResponse.json().catch(() => null) as { token?: string } | null;
        if (tokenResponse.ok && freshToken?.token) {
          setPreviewUrl(`${endpoint}/proxy/?token=${encodeURIComponent(freshToken.token)}`);
          return;
        }
      }
      const response = await fetch(`${endpoint}/start`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      const payload = await response.json().catch(() => null) as
        | { previewUrl?: string; error?: string | { message?: string } }
        | null;
      if (!response.ok || !payload?.previewUrl) {
        const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
        throw new Error(message || "Preview is unavailable.");
      }
      setPreviewUrl(payload.previewUrl);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Preview is unavailable.");
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="project-chat-card-container">
      {previewOnly ? (showPreviewTrigger ? <button type="button" className="button-primary coding-preview-trigger" onClick={() => void openPreview()}><Monitor size={16} aria-hidden="true" />{card.framework && <span className="coding-preview-framework">{card.framework}</span>}<span>Preview</span></button> : null) : <div className="project-chat-card">
        <div className="project-chat-card-top">
          <div className="project-chat-card-info">
            <span className="project-chat-card-icon">{isCodeProject ? "⌨️" : "🌐"}</span>
            <div>
              <h4 className="project-chat-card-title">{card.name}</h4>
              <span className="project-chat-card-sub">
                {isCodeProject
                  ? `Code · ${card.agentName ? `${card.agentName} (${card.agentRole})` : "Developer Agent"}`
                  : `${card.framework || "Website"} · ${card.agentName ? `${card.agentName} (${card.agentRole})` : "Developer Agent"}`}
              </span>
            </div>
          </div>
          <span className={`status-pill status-${card.status}`}>{card.status}</span>
        </div>
        <div className="project-chat-card-meta">
          <span>Build: <strong className={`build-${card.lastBuildStatus || "not-run"}`}>{card.lastBuildStatus || "not run"}</strong></span>
          {card.previewUrl && <span className="preview-live-badge">● Live Preview Active</span>}
        </div>
        <div className="project-chat-card-actions">
          <button type="button" className="button-primary" disabled={isCodeProject && !card.previewUrl && ["stopped", "failed", "cancelled", "waiting_for_user"].includes(card.status)} onClick={() => { void openPreview(); }}>Preview</button>
          <button type="button" className="button-secondary" onClick={() => onActivate?.(card)}>Edit in chat</button>
          {isCodeProject && codeWorkspaceUrl && <button type="button" className="button-secondary" onClick={() => navigate(codeChangesUrl!)}>Changes{typeof card.changesCount === "number" ? ` (${card.changesCount})` : ""}</button>}
          {isCodeProject && card.codeMode && persistedModeLabel(card.codeMode, false) && (
            <span className="project-chat-card-meta-note">Mode: {persistedModeLabel(card.codeMode, false)}</span>
          )}
          {card.runId && (
            <Link to={`/activity?runId=${card.runId}`} className="button-secondary project-view-run-link">
              View Run
            </Link>
          )}
        </div>
      </div>}
      {previewOpen && createPortal(
        <div className="project-chat-preview-layer">
          <aside className="project-chat-preview-drawer" role="complementary" aria-label={`Preview of ${card.name}`}>
            <header className="project-chat-preview-header">
              <div>
                <strong>{card.name}</strong>
                <span>Preview</span>
              </div>
              <div className="project-chat-preview-header-actions">
                {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer">Open in new tab ↗</a>}
                <button type="button" aria-label="Close preview" onClick={() => setPreviewOpen(false)}>×</button>
              </div>
            </header>
            {previewHtml ? (
              <iframe title={`${card.name} preview`} srcDoc={previewHtml} sandbox="allow-same-origin" onLoad={handleStaticPreviewLoad} className="project-chat-preview-frame" />
            ) : previewUrl ? (
              <iframe title={`${card.name} preview`} src={previewUrl} className="project-chat-preview-frame" />
            ) : (
              <div className="project-chat-preview-empty" role="status">
                {previewLoading ? "Starting preview…" : previewError || "Preview is unavailable."}
              </div>
            )}
          </aside>
        </div>, document.body
      )}
    </div>
  );
}
export function AssistantMessageToolbar({
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
export type Message = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; attachments?: ChatAttachmentInput[]; projectCard?: ProjectCardData };
