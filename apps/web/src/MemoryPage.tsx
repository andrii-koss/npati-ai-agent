import { PageGuideLink } from "./PageGuideLink";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useWorkspace } from "./BusinessWorkspace";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";

export * from "./memory-types";
import {
  type MemoryType,
  type MemoryItem,
  type MemoryFormData,
  initialForm,
  MEMORY_TYPE_META,
} from "./memory-types";
import { MemoryDrawer } from "./memory-drawer";

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
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

const MEMORY_CACHE_PREFIX = "npati_memory_cache_v1_";
const MEMORY_LATEST_CACHE_KEY = "npati_memory_cache_latest_v1";

function getCachedMemory(businessId?: string): MemoryItem[] {
  if (!businessId) return [];
  try {
    const raw = sessionStorage.getItem(MEMORY_CACHE_PREFIX + businessId) || localStorage.getItem(MEMORY_CACHE_PREFIX + businessId);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((item) => item.businessId === businessId);
    }
  } catch { /* storage may be restricted */ }
  return [];
}

function updateCachedMemory(businessId: string, items: MemoryItem[]) {
  try {
    const serialized = JSON.stringify(items);
    if (businessId) {
      sessionStorage.setItem(MEMORY_CACHE_PREFIX + businessId, serialized);
      localStorage.setItem(MEMORY_CACHE_PREFIX + businessId, serialized);
    }
    if (items.length > 0) {
      sessionStorage.setItem(MEMORY_LATEST_CACHE_KEY, serialized);
      localStorage.setItem(MEMORY_LATEST_CACHE_KEY, serialized);
    } else {
      sessionStorage.removeItem(MEMORY_LATEST_CACHE_KEY);
      localStorage.removeItem(MEMORY_LATEST_CACHE_KEY);
    }
  } catch { /* storage may be restricted */ }
}

function getInitialBusinessId(): string {
  try {
    const raw = sessionStorage.getItem("npati_workspace_overview_cache_v1")
      || localStorage.getItem("npati_workspace_overview_cache_v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.currentBusiness?.id || parsed?.businesses?.[0]?.id || "";
    }
  } catch {}
  return "";
}

function getInitialBusinessName(): string {
  try {
    const raw = sessionStorage.getItem("npati_workspace_overview_cache_v1")
      || localStorage.getItem("npati_workspace_overview_cache_v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.currentBusiness?.name || parsed?.businesses?.[0]?.name || "";
    }
  } catch {}
  return "";
}

export function MemoryPage() {
  const { t } = useTranslation();
  const { overview, loading: workspaceLoading, refresh, switchBusiness } = useWorkspace();
  const business = overview?.currentBusiness || overview?.businesses?.[0];
  const businessId = business?.id ?? (overview ? "" : getInitialBusinessId());
  const businessName = business?.name ?? (overview ? "" : getInitialBusinessName());

  const [items, setItems] = useState<MemoryItem[]>(() => getCachedMemory(businessId));
  const [loading, setLoading] = useState(() => getCachedMemory(businessId).length === 0);
  const [search, setSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<string>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const loadVersion = useRef(0);

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

  const loadMemory = async () => {
    const version = ++loadVersion.current;
    if (!businessId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setItems(getCachedMemory(businessId));
    try {
      const data = await api<MemoryItem[]>(`/businesses/${businessId}/memory`);
      if (version !== loadVersion.current) return;
      setItems(data);
      updateCachedMemory(businessId, data);
    } catch (error) {
      if (version !== loadVersion.current) return;
      if ([403, 404].includes((error as Error & { status?: number }).status ?? 0)) {
        setItems([]);
        updateCachedMemory(businessId, []);
        void refresh();
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadMemory();
  }, [businessId, workspaceLoading]);

  // Tab definitions
  const tabs = useMemo(() => {
    return [
      { id: "all", label: t("memoryPage.tabs.all"), count: items.length },
      {
        id: "facts",
        label: t("memoryPage.tabs.facts"),
        count: items.filter((i) => i.type === "business_fact").length,
      },
      {
        id: "audience",
        label: t("memoryPage.tabs.audience"),
        count: items.filter((i) => i.type === "audience" || i.type === "channel").length,
      },
      {
        id: "brand",
        label: t("memoryPage.tabs.brand"),
        count: items.filter((i) => i.type === "brand" || i.type === "preference").length,
      },
      {
        id: "decisions",
        label: t("memoryPage.tabs.decisions"),
        count: items.filter((i) => i.type === "decision" || i.type === "experiment" || i.type === "result").length,
      },
      {
        id: "product",
        label: t("memoryPage.tabs.product"),
        count: items.filter((i) => i.type === "product").length,
      },
      {
        id: "other",
        label: t("memoryPage.tabs.other"),
        count: items.filter((i) => i.type === "other").length,
      },
    ];
  }, [items, t]);

  // Filtering
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Tab filter
      if (selectedTab !== "all") {
        if (selectedTab === "facts" && item.type !== "business_fact") return false;
        if (selectedTab === "audience" && item.type !== "audience" && item.type !== "channel") return false;
        if (selectedTab === "brand" && item.type !== "brand" && item.type !== "preference") return false;
        if (
          selectedTab === "decisions" &&
          item.type !== "decision" &&
          item.type !== "experiment" &&
          item.type !== "result"
        )
          return false;
        if (selectedTab === "product" && item.type !== "product") return false;
        if (selectedTab === "other" && item.type !== "other") return false;
      }

      // Search filter
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const typeLabel = t(`memoryPage.types.${item.type}`).toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.content.toLowerCase().includes(q) ||
          typeLabel.includes(q) ||
          (item.source && item.source.toLowerCase().includes(q))
        );
      }

      return true;
    });
  }, [items, selectedTab, search, t]);

  const openCreateDrawer = () => {
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
      await api(`/businesses/${businessId}/memory/${item.id}`, { method: "DELETE" });
      showToast(t("memoryPage.toasts.deleted", { title: item.title }));
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== item.id);
        if (businessId) updateCachedMemory(businessId, next);
        return next;
      });
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
      let targetBusinessId = businessId;

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
            {(overview?.businesses.length ?? 0) > 1 && (
              <select
                className="business-scope-select"
                aria-label={t("nav.business")}
                value={businessId}
                onChange={(event) => void switchBusiness(event.target.value)}
              >
                {overview?.businesses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}{overview?.businesses.some((other) => other.id !== item.id && other.name === item.name) ? ` ? ${item.id.slice(0, 8)}` : ""}
                  </option>
                ))}
              </select>
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
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selectedTab === tab.id}
              className={`inspector-tab ${selectedTab === tab.id ? "active" : ""}`}
              onClick={() => setSelectedTab(tab.id)}
            >
              <span>{tab.label}</span>
              <small className="tab-count">{tab.count}</small>
            </button>
          ))}
        </div>
      </div>

      {/* Empty States and Grid */}
      {items.length === 0 && loading ? (
        <div className="memory-grid" style={{ minHeight: "240px", opacity: 0.5 }}>
          {[1, 2, 3].map((n) => (
            <div key={n} className="memory-card" style={{ pointerEvents: "none", minHeight: "180px" }} />
          ))}
        </div>
      ) : items.length === 0 ? (
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
      ) : filteredItems.length === 0 ? (
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
          {filteredItems.map((item) => {
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

