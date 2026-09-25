import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { ChatMessageContent } from "./ChatMessageContent";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

export interface ContentItem {
  id: string;
  title: string;
  type: "article" | "seo_structure" | "social_post" | "brief";
  content: string;
  sourceRunId?: string;
  companyId?: string;
  companyName?: string;
  createdAt: string;
}

const STORAGE_DELETED_KEY = "npati_content_deleted_ids_v1";
const STORAGE_EDITS_KEY = "npati_content_edits_v1";

function getDeletedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_DELETED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function getEditsMap(): Record<string, Partial<ContentItem>> {
  try {
    const raw = localStorage.getItem(STORAGE_EDITS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parseChatContentTask(task: string): { title?: string; type?: ContentItem["type"]; task: string } {
  const match = task.match(/^\[NPATI_CONTENT:(article|seo_blueprint|social_post|brief|strategy|other):([A-Za-z0-9_-]+)\]\s*/);
  if (!match) return { task };
  let title: string | undefined;
  try {
    const base64 = match[2]!.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    title = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    title = undefined;
  }
  const mappedType: ContentItem["type"] = match[1] === "seo_blueprint"
    ? "seo_structure"
    : match[1] === "social_post"
      ? "social_post"
      : match[1] === "brief" || match[1] === "strategy"
        ? "brief"
        : "article";
  return { title, type: mappedType, task: task.slice(match[0].length) };
}

export function ContentPage() {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedType, setSelectedType] = useState<"all" | "article" | "seo_structure" | "social_post" | "brief">("all");
  const [selectedItem, setSelectedItem] = useState<ContentItem | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Edit states
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editType, setEditType] = useState<ContentItem["type"]>("article");
  const [editContent, setEditContent] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const headers: HeadersInit = {};
    const token = getStoredAuthToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    fetch("/api/companies?limit=10", { headers })
      .then((res) => (res.ok ? res.json() : { companies: [] }))
      .then(async (data: { companies?: Array<{ id: string; name: string }> }) => {
        const companies = data.companies ?? [];
        const contentRows: ContentItem[] = [];
        const deletedIds = new Set(getDeletedIds());
        const editsMap = getEditsMap();
        const overridesResponse = await fetch("/api/content/overrides", { headers });
        const overrides = overridesResponse.ok
          ? ((await overridesResponse.json()) as { overrides?: Record<string, { title?: string; type?: ContentItem["type"]; content?: string; deleted?: boolean }> }).overrides ?? {}
          : {};

        for (const company of companies.slice(0, 5)) {
          const runRes = await fetch(`/api/companies/${company.id}/runs?limit=20`, { headers });
          if (runRes.ok) {
            const runData = (await runRes.json()) as {
              runs?: Array<{ id: string; task: string; result?: string; createdAt: string; status: string }>;
            };
            for (const r of runData.runs ?? []) {
              if (r.result && r.status === "completed") {
                if (deletedIds.has(r.id) || overrides[r.id]?.deleted) continue;

                const chatContent = parseChatContentTask(r.task);
                let type: ContentItem["type"] = chatContent.type ?? "article";
                const lowerTask = chatContent.task.toLowerCase();
                if (lowerTask.includes("seo") || lowerTask.includes("keyword") || lowerTask.includes("structure")) {
                  type = "seo_structure";
                } else if (lowerTask.includes("social") || lowerTask.includes("post") || lowerTask.includes("tweet") || lowerTask.includes("linkedin")) {
                  type = "social_post";
                } else if (lowerTask.includes("brief") || lowerTask.includes("plan") || lowerTask.includes("strategy") || lowerTask.includes("roadmap")) {
                  type = "brief";
                }

                const edited = { ...editsMap[r.id], ...overrides[r.id] };
                contentRows.push({
                  id: r.id,
                  title: edited?.title || chatContent.title || (chatContent.task.length > 70 ? `${chatContent.task.slice(0, 70)}…` : chatContent.task),
                  type: (edited?.type as ContentItem["type"]) || type,
                  content: edited?.content !== undefined ? edited.content : r.result,
                  sourceRunId: r.id,
                  companyId: company.id,
                  companyName: company.name,
                  createdAt: r.createdAt,
                });
              }
            }
          }
        }

        setItems(contentRows);
        if (contentRows.length > 0 && contentRows[0]) {
          setSelectedItem(contentRows[0]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Synchronize edit fields when selectedItem changes
  useEffect(() => {
    if (selectedItem) {
      setEditTitle(selectedItem.title);
      setEditType(selectedItem.type);
      setEditContent(selectedItem.content);
    }
    setIsEditing(false);
    setIsExpanded(false);
  }, [selectedItem?.id]);

  // Category counts
  const categoryCounts = useMemo(() => {
    return {
      all: items.length,
      article: items.filter((i) => i.type === "article").length,
      seo_structure: items.filter((i) => i.type === "seo_structure").length,
      social_post: items.filter((i) => i.type === "social_post").length,
      brief: items.filter((i) => i.type === "brief").length,
    };
  }, [items]);

  // Filtered items
  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (selectedType !== "all" && item.type !== selectedType) {
        return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchesTitle = item.title.toLowerCase().includes(q);
        const matchesContent = item.content.toLowerCase().includes(q);
        const matchesType = item.type.toLowerCase().includes(q);
        return matchesTitle || matchesContent || matchesType;
      }
      return true;
    });
  }, [items, selectedType, search]);

  // Keep selected item valid when filtered
  useEffect(() => {
    if (selectedItem && !filtered.some((i) => i.id === selectedItem.id)) {
      setSelectedItem(filtered[0] || null);
    } else if (!selectedItem && filtered.length > 0) {
      setSelectedItem(filtered[0] || null);
    }
  }, [filtered, selectedItem]);

  // Document metrics calculation
  const documentMetrics = useMemo(() => {
    if (!selectedItem) return null;
    const text = isEditing ? editContent.trim() : selectedItem.content.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const characters = text.length;
    const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));
    return { words, characters, readingTimeMinutes };
  }, [selectedItem, isEditing, editContent]);

  const copyDocument = () => {
    if (!selectedItem) return;
    void navigator.clipboard.writeText(selectedItem.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadDocument = () => {
    if (!selectedItem) return;
    const blob = new Blob([selectedItem.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeTitle = selectedItem.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    link.href = url;
    link.download = `${safeTitle || "content-draft"}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSaveEdit = async () => {
    if (!selectedItem) return;
    const trimmedTitle = editTitle.trim() || selectedItem.title;
    const updated: ContentItem = {
      ...selectedItem,
      title: trimmedTitle,
      type: editType,
      content: editContent,
    };

    try {
      const response = await fetch(`/api/companies/${selectedItem.companyId}/content/${selectedItem.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(getStoredAuthToken() ? { authorization: `Bearer ${getStoredAuthToken()}` } : {}) },
        body: JSON.stringify({ title: trimmedTitle, type: editType, content: editContent }),
      });
      if (!response.ok) throw new Error("Could not save content changes");
      setItems((prev) => prev.map((i) => (i.id === selectedItem.id ? updated : i)));
      setSelectedItem(updated);
      setIsEditing(false);

      const edits = getEditsMap();
      edits[selectedItem.id] = { title: trimmedTitle, type: editType, content: editContent };
      localStorage.setItem(STORAGE_EDITS_KEY, JSON.stringify(edits));

      setToast(t("contentPage.toast.saved"));
    } catch {
      setToast(t("contentPage.toast.saveError"));
    }
    setTimeout(() => setToast(null), 2500);
  };

  const handleDeleteItem = async (idToDelete?: string) => {
    const targetId = idToDelete || selectedItem?.id;
    if (!targetId) return;
    const targetItem = items.find((i) => i.id === targetId);
    const title = targetItem?.title || t("contentPage.dialogs.thisDocumentFallback");

    const confirmed = await confirmModal({
      title: t("contentPage.dialogs.deleteTitle"),
      message: t("contentPage.dialogs.deleteMessage", { title }),
      confirmText: t("contentPage.dialogs.deleteConfirm"),
      cancelText: t("contentPage.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/companies/${targetItem?.companyId}/content/${targetId}`, {
        method: "DELETE",
        headers: getStoredAuthToken() ? { authorization: `Bearer ${getStoredAuthToken()}` } : {},
      });
      if (!response.ok) throw new Error("Could not delete content");
    } catch {
      setToast(t("contentPage.toast.deleteError"));
      setTimeout(() => setToast(null), 2500);
      return;
    }

    const deletedIds = getDeletedIds();
    if (!deletedIds.includes(targetId)) {
      deletedIds.push(targetId);
      localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(deletedIds));
    }

    const edits = getEditsMap();
    delete edits[targetId];
    localStorage.setItem(STORAGE_EDITS_KEY, JSON.stringify(edits));

    setItems((prev) => prev.filter((i) => i.id !== targetId));
    if (selectedItem?.id === targetId) {
      const remaining = items.filter((i) => i.id !== targetId);
      setSelectedItem(remaining[0] || null);
    }
    setIsEditing(false);

    setToast(t("contentPage.toast.deleted"));
    setTimeout(() => setToast(null), 2500);
  };

  const getBadgeLabel = (type: ContentItem["type"]) => {
    switch (type) {
      case "article":
        return t("contentPage.types.article");
      case "seo_structure":
        return t("contentPage.types.seoBlueprint");
      case "social_post":
        return t("contentPage.types.socialMedia");
      case "brief":
        return t("contentPage.types.briefPlan");
      default:
        return type;
    }
  };

  return (
    <main className="content-hub-container">
      {/* Toast Notification */}
      {toast && (
        <div className="content-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      {/* Header with back arrow to Settings */}
      <header className="inspector-header content-hub-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("contentPage.eyebrow")}</p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label={t("contentPage.backToSettings")}
                title={t("contentPage.backToSettings")}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("contentPage.title")}</span>
            </h1>
            <p className="hero-copy">
              {t("contentPage.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary content-new-btn"
              onClick={() => navigate("/chat", { state: { prompt: t("contentPage.newContentPrompt") } })}
            >
              {t("contentPage.newContentDraft")}
            </button>
          </div>
        </div>
      </header>

      {/* Content Type Filter Tabs & Search Bar */}
      <div className="content-toolbar-panel">
        <div className="content-type-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "all"}
            className={`content-type-pill ${selectedType === "all" ? "active" : ""}`}
            onClick={() => setSelectedType("all")}
          >
            {t("contentPage.tabs.all")} <span className="pill-counter">{categoryCounts.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "article"}
            className={`content-type-pill ${selectedType === "article" ? "active" : ""}`}
            onClick={() => setSelectedType("article")}
          >
            {t("contentPage.tabs.articles")} <span className="pill-counter">{categoryCounts.article}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "seo_structure"}
            className={`content-type-pill ${selectedType === "seo_structure" ? "active" : ""}`}
            onClick={() => setSelectedType("seo_structure")}
          >
            {t("contentPage.tabs.seoBlueprints")} <span className="pill-counter">{categoryCounts.seo_structure}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "social_post"}
            className={`content-type-pill ${selectedType === "social_post" ? "active" : ""}`}
            onClick={() => setSelectedType("social_post")}
          >
            {t("contentPage.tabs.socialPosts")} <span className="pill-counter">{categoryCounts.social_post}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "brief"}
            className={`content-type-pill ${selectedType === "brief" ? "active" : ""}`}
            onClick={() => setSelectedType("brief")}
          >
            {t("contentPage.tabs.briefsPlans")} <span className="pill-counter">{categoryCounts.brief}</span>
          </button>
        </div>

        <div className="inspector-search-box content-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("contentPage.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label={t("contentPage.searchAria")}
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label={t("contentPage.clearSearch")}
              title={t("contentPage.clearSearch")}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {!loading && items.length === 0 && (
        <div className="automations-empty-card content-empty-card">
          <div className="automations-empty-icon">📝</div>
          <h3>{t("contentPage.empty.readyTitle")}</h3>
          <p>
            {t("contentPage.empty.readyDesc")}
          </p>
          <div style={{ display: "flex", gap: "10px", justifyContent: "center", marginTop: "12px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={() => navigate("/chat", { state: { prompt: t("contentPage.empty.chatPrompt") } })}
            >
              {t("contentPage.empty.generateFirstDraft")}
            </button>
            {getDeletedIds().length > 0 && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  localStorage.removeItem(STORAGE_DELETED_KEY);
                  window.location.reload();
                }}
              >
                {t("contentPage.empty.restoreDeleted")}
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && items.length > 0 && filtered.length === 0 && (
        <div className="automations-empty-card content-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{t("contentPage.empty.noMatchingTitle")}</h3>
          <p>{t("contentPage.empty.noMatchingDesc")}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearch("");
              setSelectedType("all");
            }}
          >
            {t("contentPage.empty.resetFilters")}
          </button>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="content-studio-layout">
          {/* Left Column: Content Cards List (4 cards visible on first screen) */}
          <aside className="content-sidebar-list" aria-label={t("contentPage.cards.listAria")}>
            <div className="content-cards-container">
              {filtered.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                const snippet = item.content.slice(0, 110).replace(/^[#\s*-]+/g, "").trim();
                return (
                  <article
                    key={item.id}
                    className={`content-summary-card ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      setSelectedItem(item);
                      setIsEditing(false);
                    }}
                    tabIndex={0}
                    role="button"
                    aria-selected={isSelected}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        setSelectedItem(item);
                        setIsEditing(false);
                      }
                    }}
                  >
                    <div className="content-card-top">
                      <span className={`content-badge badge-${item.type}`}>
                        {getBadgeLabel(item.type)}
                      </span>
                      <div className="content-card-top-right">
                        <time className="content-card-date">
                          {new Date(item.createdAt).toLocaleDateString(language, { month: "short", day: "numeric" })}
                        </time>
                        <button
                          type="button"
                          className="card-quick-delete-btn"
                          title={t("contentPage.cards.deleteDocumentTitle")}
                          aria-label={t("contentPage.cards.deleteDocumentTitle")}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteItem(item.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    <h3 className="content-card-title" title={item.title}>{item.title}</h3>
                    <p className="content-card-snippet">{snippet}…</p>
                    <div className="content-card-footer">
                      {item.companyName && <span className="content-company-tag">🏢 {item.companyName}</span>}
                      <span className="content-read-time">
                        {t("contentPage.cards.minRead", { count: Math.max(1, Math.ceil(item.content.split(/\s+/).length / 200)) })}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          </aside>

          {/* Right Column: Active Document Reader & Studio */}
          <section className="content-main-viewer" aria-label="Document reader">
            {selectedItem ? (
              <div className={`content-viewer-card ${isExpanded ? "expanded" : ""}`}>
                {/* Document Reader Header */}
                <header className="document-reader-header">
                  {/* Top Row: Category Badge on left, Expand/Collapse toggle in top-right corner */}
                  <div className="document-header-top-row">
                    <span className={`content-badge badge-${isEditing ? editType : selectedItem.type}`}>
                      {getBadgeLabel(isEditing ? editType : selectedItem.type)}
                    </span>
                    {!isEditing && (
                      <button
                        type="button"
                        className={`content-action-btn expand-btn ${isExpanded ? "expanded" : ""}`}
                        onClick={() => setIsExpanded((prev) => !prev)}
                        title={isExpanded ? t("contentPage.viewer.collapseTitle") : t("contentPage.viewer.expandTitle")}
                      >
                        {isExpanded ? (
                          <>
                            <span aria-hidden="true">⤡</span> {t("contentPage.viewer.collapse")}
                          </>
                        ) : (
                          <>
                            <span aria-hidden="true">⤢</span> {t("contentPage.viewer.expand")}
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Main Row: Document Title and Actions toolbar */}
                  <div className="document-header-main-row">
                    <h2>{isEditing ? t("contentPage.viewer.editDocument") : selectedItem.title}</h2>

                    {/* Actions toolbar */}
                    <div className="document-header-actions">
                      {!isEditing ? (
                        <>
                          <div className="document-view-toggle">
                            <button
                              type="button"
                              className={`view-toggle-btn ${viewMode === "preview" ? "active" : ""}`}
                              onClick={() => setViewMode("preview")}
                              title={t("contentPage.viewer.views.previewTitle")}
                            >
                              {t("contentPage.viewer.views.preview")}
                            </button>
                            <button
                              type="button"
                              className={`view-toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                              onClick={() => setViewMode("raw")}
                              title={t("contentPage.viewer.views.rawTitle")}
                            >
                              {t("contentPage.viewer.views.raw")}
                            </button>
                          </div>

                          <button
                            type="button"
                            className="content-action-btn edit-btn"
                            onClick={() => setIsEditing(true)}
                            title={t("contentPage.viewer.actions.editTitle")}
                          >
                            {t("contentPage.viewer.actions.edit")}
                          </button>

                          <button
                            type="button"
                            className="content-action-btn delete-btn"
                            onClick={() => handleDeleteItem()}
                            title={t("contentPage.viewer.actions.deleteTitle")}
                          >
                            {t("contentPage.viewer.actions.delete")}
                          </button>

                          <button
                            type="button"
                            className={`content-action-btn copy-btn ${copied ? "copied" : ""}`}
                            onClick={copyDocument}
                            title={t("contentPage.viewer.actions.copyTitle")}
                          >
                            {copied ? t("contentPage.viewer.actions.copied") : t("contentPage.viewer.actions.copy")}
                          </button>

                          <button
                            type="button"
                            className="content-action-btn download-btn"
                            onClick={downloadDocument}
                            title={t("contentPage.viewer.actions.downloadTitle")}
                          >
                            {t("contentPage.viewer.actions.download")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button-primary automations-action-primary content-save-btn"
                            onClick={handleSaveEdit}
                            title={t("contentPage.viewer.actions.saveChangesTitle")}
                          >
                            {t("contentPage.viewer.actions.saveChanges")}
                          </button>
                          <button
                            type="button"
                            className="button-secondary content-cancel-btn"
                            onClick={() => {
                              if (selectedItem) {
                                setEditTitle(selectedItem.title);
                                setEditType(selectedItem.type);
                                setEditContent(selectedItem.content);
                              }
                              setIsEditing(false);
                            }}
                            title={t("contentPage.viewer.actions.cancelTitle")}
                          >
                            {t("contentPage.viewer.actions.cancel")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </header>

                {/* Document Reading Metrics Ribbon */}
                {documentMetrics && (
                  <div className="document-metrics-ribbon">
                    <div className="metric-chip">
                      <strong>{documentMetrics.words.toLocaleString()}</strong>
                      <span>{t("contentPage.viewer.metrics.words")}</span>
                    </div>
                    <div className="metric-chip">
                      <strong>{documentMetrics.characters.toLocaleString()}</strong>
                      <span>{t("contentPage.viewer.metrics.characters")}</span>
                    </div>
                    <div className="metric-chip">
                      <strong>~{documentMetrics.readingTimeMinutes} min</strong>
                      <span>{t("contentPage.viewer.metrics.readTime")}</span>
                    </div>
                    <div className="metric-chip">
                      <strong>{new Date(selectedItem.createdAt).toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" })}</strong>
                      <span>{t("contentPage.viewer.metrics.generatedDate")}</span>
                    </div>
                  </div>
                )}

                {/* Document Content View / Editor */}
                <div className={`document-content-area ${isExpanded ? "expanded" : ""}`}>
                  {isEditing ? (
                    <div className="document-edit-form">
                      <div className="document-edit-meta-row">
                        <div className="document-edit-field flex-1">
                          <label htmlFor="content-edit-title">{t("contentPage.viewer.editor.titleLabel")}</label>
                          <input
                            id="content-edit-title"
                            type="text"
                            className="document-edit-input"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            placeholder={t("contentPage.viewer.editor.titlePlaceholder")}
                          />
                        </div>
                        <div className="document-edit-field">
                          <label htmlFor="content-edit-type">{t("contentPage.viewer.editor.typeLabel")}</label>
                          <select
                            id="content-edit-type"
                            className="document-edit-select"
                            value={editType}
                            onChange={(e) => setEditType(e.target.value as ContentItem["type"])}
                          >
                            <option value="article">{t("contentPage.types.article")}</option>
                            <option value="seo_structure">{t("contentPage.types.seoBlueprint")}</option>
                            <option value="social_post">{t("contentPage.types.socialMedia")}</option>
                            <option value="brief">{t("contentPage.types.briefPlan")}</option>
                          </select>
                        </div>
                      </div>

                      <div className="document-edit-field full-height">
                        <div className="document-edit-label-row">
                          <label htmlFor="content-edit-body">{t("contentPage.viewer.editor.bodyLabel")}</label>
                          <span className="document-edit-hint">{t("contentPage.viewer.editor.saveHint")}</span>
                        </div>
                        <textarea
                          id="content-edit-body"
                          className="document-edit-textarea"
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                              e.preventDefault();
                              handleSaveEdit();
                            }
                          }}
                          rows={14}
                          placeholder={t("contentPage.viewer.editor.bodyPlaceholder")}
                        />
                      </div>
                    </div>
                  ) : viewMode === "preview" ? (
                    <div className="document-preview-body">
                      <ChatMessageContent content={selectedItem.content} />
                    </div>
                  ) : (
                    <div className="document-raw-body">
                      <pre><code>{selectedItem.content}</code></pre>
                    </div>
                  )}

                  {!isEditing && !isExpanded && (
                    <div className="document-expand-overlay">
                      <button
                        type="button"
                        className="document-expand-banner-btn"
                        onClick={() => setIsExpanded(true)}
                        title={t("contentPage.viewer.expandTitle")}
                      >
                        <span className="expand-icon" aria-hidden="true">⤢</span>
                        <span>{t("contentPage.viewer.overlay.expand")}</span>
                      </button>
                    </div>
                  )}

                  {!isEditing && isExpanded && (
                    <div className="document-collapse-footer">
                      <button
                        type="button"
                        className="document-collapse-banner-btn"
                        onClick={() => {
                          setIsExpanded(false);
                          window.scrollTo({ top: 180, behavior: "smooth" });
                        }}
                        title={t("contentPage.viewer.collapseTitle")}
                      >
                        <span className="collapse-icon" aria-hidden="true">⤡</span>
                        <span>{t("contentPage.viewer.overlay.collapse")}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="content-viewer-card empty-selection">
                <p>{t("contentPage.empty.selectDoc")}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
