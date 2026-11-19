import { ALL_COMPANIES } from "./company-scope";
import { useSettingsRecordsPage } from "./use-settings-records-page";
import { fetchMemoryPage, memoryPageKey, openMemoryPage } from "./memory-page-read";
import type { MemoryCategory, MemoryPageQuery } from "@npati/workspace";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./workspace-api";
import { useWorkspace } from "./BusinessWorkspace";
import { useLinkedBusiness } from "./linked-business";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

export * from "./memory-types";
import {
  type MemoryItem,
  type MemoryFormData,
  initialForm,
  MEMORY_TYPE_META,
} from "./memory-types";
import { MemoryDrawer } from "./memory-drawer";

const tabs = ["all", "facts", "audience", "brand", "decisions", "product", "other"] as const;

export function MemoryPage() {
  const { t, language } = useTranslation();
  const { overview, refresh, switchBusiness } = useWorkspace();
  const business = useLinkedBusiness(overview, switchBusiness);
  const [scopeParams] = useSearchParams();
  const [companyScope, setCompanyScope] = useState(() => scopeParams.get("business") || ALL_COMPANIES);
  const scopedBusinessId = companyScope === ALL_COMPANIES ? undefined : companyScope;
  const businessId = scopedBusinessId ?? business?.id;
  const businessName = scopedBusinessId
    ? overview?.businesses.find(item => item.id === scopedBusinessId)?.name
    : language === "uk" ? "Усі компанії" : "All companies";

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<"all" | MemoryCategory>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Drawer modal state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null);
  const [form, setForm] = useState<MemoryFormData>(initialForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  useEffect(() => {
    const query = search.trim();
    if (!query) { setDebouncedSearch(""); return; }
    const timer = setTimeout(() => setDebouncedSearch(query), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const query = search.trim() ? debouncedSearch : "";
  const filters: Omit<MemoryPageQuery, "after"> = {
    businessId: scopedBusinessId,
    category: selectedTab === "all" ? undefined : selectedTab,
    search: query || undefined,
    searchTypes: query ? Object.keys(MEMORY_TYPE_META).filter(type => t(`memoryPage.types.${type}`).toLowerCase().includes(query.toLowerCase())) : undefined,
  };
  const { page, counts, failed, bottom, reload: loadMemory } = useSettingsRecordsPage(filters, {
    scope: memoryPageKey(scopedBusinessId),
    unfiltered: !filters.category && !filters.search,
    open: () => openMemoryPage(scopedBusinessId),
    fetch: fetchMemoryPage,
    append: (current, next) => {
      const seen = new Set(current.items.map(item => item.id));
      return { ...current, items: [...current.items, ...next.items.filter(item => !seen.has(item.id))], nextCursor: next.nextCursor };
    },
    onError: showToast,
  });

  const openCreateDrawer = () => {
    if (companyScope === ALL_COMPANIES && businessId) setCompanyScope(businessId);
    setEditingItem(null);
    setForm(initialForm);
    setFormError("");
    setDrawerOpen(true);
  };

  const openEditDrawer = (item: MemoryItem) => {
    setEditingItem(item);
    setForm({
      type: item.type,
      title: item.title,
      content: item.content,
      confidence: item.confidence !== undefined ? String(item.confidence) : "1.0",
    });
    setFormError("");
    setDrawerOpen(true);
  };

  const handleCopyContent = (item: MemoryItem) => {
    void navigator.clipboard.writeText(`${item.title}\n\n${item.content}`);
    setCopiedId(item.id);
    showToast(t("memoryPage.toasts.copied"));
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDeleteItem = async (item: MemoryItem) => {
    if (!businessId) return;
    const confirmed = await confirmModal({
      title: t("memoryPage.dialogs.deleteTitle"),
      message: t("memoryPage.dialogs.deleteMessage", { title: item.title }),
      confirmText: t("memoryPage.dialogs.deleteConfirm"),
      cancelText: t("memoryPage.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;

    try {
      await api(`/businesses/${item.businessId}/memory/${item.id}`, { method: "DELETE" });
      showToast(t("memoryPage.toasts.deleted", { title: item.title }));
      await loadMemory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("memoryPage.toasts.deleteError");
      showToast(msg);
    }
  };

  const saveMemoryForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setFormError(t("memoryPage.drawer.errors.titleRequired"));
      return;
    }
    if (!form.content.trim()) {
      setFormError(t("memoryPage.drawer.errors.contentRequired"));
      return;
    }

    setSaving(true);
    setFormError("");

    try {
      let targetBusinessId = editingItem?.businessId || businessId;

      // If user has no business created yet, automatically initialize one
      if (!targetBusinessId) {
        const created = await api<{ id: string }>("/businesses", {
          method: "POST",
          body: JSON.stringify({
            name: t("memoryPage.drawer.defaultBusinessName"),
            businessType: "starting",
            businessStage: "idea",
          }),
        });
        targetBusinessId = created.id;
        await refresh();
      }

      const payload = {
        type: form.type,
        title: form.title.trim(),
        content: form.content.trim(),
        confidence: parseFloat(form.confidence) || 1.0,
        source: editingItem?.source || "user",
      };

      if (editingItem) {
        await api(`/businesses/${targetBusinessId}/memory/${editingItem.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        showToast(t("memoryPage.toasts.updated"));
      } else {
        await api(`/businesses/${targetBusinessId}/memory`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast(t("memoryPage.toasts.saved"));
      }

      setDrawerOpen(false);
      await loadMemory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("memoryPage.drawer.errors.saveFailed");
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const formatSourceLabel = (src: string) => {
    if (!src) return t("memoryPage.sources.manual");
    if (src === "chat_confirmed") return t("memoryPage.sources.chatConfirmed");
    if (src === "onboarding") return t("memoryPage.sources.onboarding");
    if (src === "user") return t("memoryPage.sources.userVerified");
    return src.replace(/_/g, " ");
  };

  return (
    <main className="inspector-page memory-page">
      {/* Page Header matching /settings/capabilities */}
      <header className="marketplace-hero inspector-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">
              {businessName ? `${businessName} · ` : ""}{t("memoryPage.eyebrow")}
            </p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label={t("memoryPage.backToSettings")}
                title={t("memoryPage.backToSettings")}
              >
                <svg
                  width="20"
                  height="20"
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
              <span>{t("memoryPage.title")}</span>
              <PageGuideLink guide="memory" />
            </h1>
            <p className="hero-copy">
              {t("memoryPage.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            {(
              <CompanyScopeSelect
                className="business-scope-select"
                aria-label={t("nav.business")}
                value={companyScope}
                onValueChange={(value) => { setCompanyScope(value); if (value !== ALL_COMPANIES) void switchBusiness(value); }}
              >
                {overview?.businesses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}{overview?.businesses.some((other) => other.id !== item.id && other.name === item.name) ? ` ? ${item.id.slice(0, 8)}` : ""}
                  </option>
                ))}
              </CompanyScopeSelect>
            )}
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateDrawer}
              title={t("memoryPage.addFactTitle")}
            >
              {t("memoryPage.addFactBtn")}
            </button>
          </div>
        </div>
      </header>

      {/* Search & Filter Tabs Controls Bar */}
      <div className="inspector-controls memory-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("memoryPage.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label={t("memoryPage.searchAria")}
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label={t("memoryPage.clearSearch")}
              title={t("memoryPage.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selectedTab === tab}
              className={`inspector-tab ${selectedTab === tab ? "active" : ""}`}
              onClick={() => setSelectedTab(tab)}
            >
              <span>{t(`memoryPage.tabs.${tab}`)}</span>
              <small className="tab-count">{counts?.[tab]}</small>
            </button>
          ))}
        </div>
      </div>

      {/* Empty States and Grid */}
      {!page ? !failed && (
        <div className="memory-grid" style={{ minHeight: "240px", opacity: 0.5 }}>
          {[1, 2, 3].map((n) => (
            <div key={n} className="memory-card" style={{ pointerEvents: "none", minHeight: "180px" }} />
          ))}
        </div>
      ) : counts?.all === 0 ? (
        <div className="automations-empty-card memory-empty-card">
          <div className="automations-empty-icon">🧠</div>
          <h3>{t("memoryPage.empty.title")}</h3>
          <p>{t("memoryPage.empty.description")}</p>
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={openCreateDrawer}
          >
            {t("memoryPage.empty.addFirstBtn")}
          </button>
        </div>
      ) : page.items.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{t("memoryPage.emptyFiltered.title")}</h3>
          <p>{t("memoryPage.emptyFiltered.description")}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearch("");
              setSelectedTab("all");
            }}
          >
            {t("memoryPage.emptyFiltered.resetFilters")}
          </button>
        </div>
      ) : (
        <div className="memory-grid">
          {page.items.map((item) => {
            const meta = MEMORY_TYPE_META[item.type] || MEMORY_TYPE_META.other;
            return (
              <article key={item.id} className="memory-card">
                <div className="memory-card-body">
                  <div className="memory-card-top">
                    <div className="memory-card-top-left">
                      <span className={`memory-type-badge ${meta.badgeClass}`}>
                        <span className="memory-type-icon">{meta.icon}</span>
                        <span>{t(`memoryPage.types.${item.type}`)}</span>
                      </span>
                      <span
                        className="memory-source-tag"
                        title={`${t("memoryPage.sources.sourcePrefix")}: ${item.source || "user"}`}
                      >
                        {formatSourceLabel(item.source)}
                      </span>
                    </div>
                  </div>

                  <h3 className="memory-card-title">{item.title}</h3>

                  <div className="memory-card-content">
                    <p>{item.content}</p>
                  </div>
                </div>

                <div className="memory-card-footer">
                  <div className="memory-meta-left">
                    <span className="memory-date-tag">
                      {new Date(item.updatedAt || item.createdAt).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    {item.confidence !== undefined && (
                      <span
                        className="memory-confidence-pill"
                        title={t("memoryPage.card.confidenceTooltip", { score: String(item.confidence) })}
                      >
                        {item.confidence >= 0.9 ? t("memoryPage.card.verified") : `${Math.round(item.confidence * 100)}%`}
                      </span>
                    )}
                  </div>

                  <div className="memory-actions">
                    <button
                      type="button"
                      className={`memory-action-btn copy ${copiedId === item.id ? "copied" : ""}`}
                      onClick={() => handleCopyContent(item)}
                      title={t("memoryPage.card.copyTitle")}
                    >
                      {copiedId === item.id ? t("memoryPage.card.copied") : t("memoryPage.card.copy")}
                    </button>
                    <button
                      type="button"
                      className="memory-action-btn edit"
                      onClick={() => openEditDrawer(item)}
                      title={t("memoryPage.card.editTitle")}
                    >
                      {t("memoryPage.card.edit")}
                    </button>
                    <button
                      type="button"
                      className="memory-action-btn delete"
                      onClick={() => void handleDeleteItem(item)}
                      title={t("memoryPage.card.deleteTitle")}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                      <span>{t("memoryPage.card.delete")}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Slide-over Drawer for Add / Edit Memory */}
      {page?.nextCursor && <div ref={bottom} aria-hidden="true" style={{ height: 1 }} />}
      <MemoryDrawer
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        editingItem={editingItem}
        form={form}
        setForm={setForm}
        formError={formError}
        saving={saving}
        saveMemoryForm={saveMemoryForm}
        t={t}
      />


      {/* Floating toast notification */}
      {toastMessage && <div className="content-toast">{toastMessage}</div>}
    </main>
  );
}

