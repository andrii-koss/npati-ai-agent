import { PageGuideLink } from "./PageGuideLink";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  type ContentItem,
  STORAGE_DELETED_KEY,
  STORAGE_EDITS_KEY,
  getDeletedIds,
  getEditsMap,
} from "./content-page-types";
import { ContentPageViewer } from "./content-page-viewer";
import { getCachedContentItems, readContentItems, updateCachedContentItems } from "./content-page-read";

export type { ContentItem };

/** Download name of a Content Hub document; keeps letters of every script ("Хліб дня" must not become "-.md"). */
export function contentExportFileName(title: string): string {
  const safeTitle = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${safeTitle || "content-draft"}.md`;
}

export function ContentPage() {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<ContentItem[]>(getCachedContentItems);
  const [loading, setLoading] = useState(() => getCachedContentItems().length === 0);
  const [loadError, setLoadError] = useState("");
  const contentVersion = useRef(0);
  const [search, setSearch] = useState("");
  const [selectedType, setSelectedType] = useState<"all" | "article" | "seo_structure" | "social_post" | "brief">("all");
  const [selectedItem, setSelectedItem] = useState<ContentItem | null>(() => getCachedContentItems()[0] || null);
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
    let active = true;
    const token = getStoredAuthToken();
    const version = contentVersion.current;
    void readContentItems().then(rows => {
      if (!active || getStoredAuthToken() !== token || version !== contentVersion.current) return;
      setItems(rows);
      updateCachedContentItems(rows);
      setSelectedItem(current => rows.find(row => row.id === current?.id) ?? rows[0] ?? null);
    }).catch(error => {
      if (active && getStoredAuthToken() === token) setLoadError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
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

  const showCounts = items.length > 0 || (!loading && !loadError);

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
    link.href = url;
    link.download = contentExportFileName(selectedItem.title);
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
      contentVersion.current++;
      setItems((prev) => {
        const next = prev.map((i) => (i.id === selectedItem.id ? updated : i));
        updateCachedContentItems(next);
        return next;
      });
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
      contentVersion.current++;
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

    setItems((prev) => {
      const remaining = prev.filter((i) => i.id !== targetId);
      updateCachedContentItems(remaining);
      return remaining;
    });
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
    <main className="content-hub-container" aria-busy={loading}>
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
              <PageGuideLink guide="content" />
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
            {t("contentPage.tabs.all")} {showCounts && <span className="pill-counter">{categoryCounts.all}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "article"}
            className={`content-type-pill ${selectedType === "article" ? "active" : ""}`}
            onClick={() => setSelectedType("article")}
          >
            {t("contentPage.tabs.articles")} {showCounts && <span className="pill-counter">{categoryCounts.article}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "seo_structure"}
            className={`content-type-pill ${selectedType === "seo_structure" ? "active" : ""}`}
            onClick={() => setSelectedType("seo_structure")}
          >
            {t("contentPage.tabs.seoBlueprints")} {showCounts && <span className="pill-counter">{categoryCounts.seo_structure}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "social_post"}
            className={`content-type-pill ${selectedType === "social_post" ? "active" : ""}`}
            onClick={() => setSelectedType("social_post")}
          >
            {t("contentPage.tabs.socialPosts")} {showCounts && <span className="pill-counter">{categoryCounts.social_post}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedType === "brief"}
            className={`content-type-pill ${selectedType === "brief" ? "active" : ""}`}
            onClick={() => setSelectedType("brief")}
          >
            {t("contentPage.tabs.briefsPlans")} {showCounts && <span className="pill-counter">{categoryCounts.brief}</span>}
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

      {loadError && <div className="workspace-notice error" role="alert">{loadError}</div>}
      {items.length === 0 && (loading || loadError) ? null : items.length === 0 ? (
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
      ) : filtered.length === 0 ? (
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
      ) : (
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
          <ContentPageViewer
            selectedItem={selectedItem}
            isExpanded={isExpanded}
            setIsExpanded={setIsExpanded}
            isEditing={isEditing}
            setIsEditing={setIsEditing}
            editTitle={editTitle}
            setEditTitle={setEditTitle}
            editType={editType}
            setEditType={setEditType}
            editContent={editContent}
            setEditContent={setEditContent}
            viewMode={viewMode}
            setViewMode={setViewMode}
            copied={copied}
            copyDocument={copyDocument}
            downloadDocument={downloadDocument}
            handleDeleteItem={handleDeleteItem}
            handleSaveEdit={handleSaveEdit}
            getBadgeLabel={getBadgeLabel}
            documentMetrics={documentMetrics}
            language={language}
            t={t}
          />
        </div>
      )}
    </main>
  );
}
