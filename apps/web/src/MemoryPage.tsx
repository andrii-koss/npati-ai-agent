import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useWorkspace } from "./BusinessWorkspace";

export type MemoryType =
  | "business_fact"
  | "audience"
  | "brand"
  | "preference"
  | "decision"
  | "product"
  | "channel"
  | "experiment"
  | "result"
  | "other";

export interface MemoryItem {
  id: string;
  workspaceId: string;
  businessId: string;
  userId: string;
  type: MemoryType;
  title: string;
  content: string;
  source: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryFormData {
  type: MemoryType;
  title: string;
  content: string;
  confidence: string;
}

const initialForm: MemoryFormData = {
  type: "business_fact",
  title: "",
  content: "",
  confidence: "1.0",
};

export const MEMORY_TYPE_META: Record<
  MemoryType,
  { label: string; icon: string; badgeClass: string; categoryGroup: string }
> = {
  business_fact: {
    label: "Business Fact",
    icon: "📌",
    badgeClass: "badge-fact",
    categoryGroup: "facts",
  },
  audience: {
    label: "Audience & ICP",
    icon: "🎯",
    badgeClass: "badge-audience",
    categoryGroup: "audience",
  },
  brand: {
    label: "Brand & Voice",
    icon: "✨",
    badgeClass: "badge-brand",
    categoryGroup: "brand",
  },
  decision: {
    label: "Strategic Decision",
    icon: "⚖️",
    badgeClass: "badge-decision",
    categoryGroup: "decisions",
  },
  product: {
    label: "Product & Service",
    icon: "📦",
    badgeClass: "badge-product",
    categoryGroup: "product",
  },
  channel: {
    label: "Marketing Channel",
    icon: "📢",
    badgeClass: "badge-channel",
    categoryGroup: "audience",
  },
  preference: {
    label: "User Preference",
    icon: "⚙️",
    badgeClass: "badge-preference",
    categoryGroup: "brand",
  },
  experiment: {
    label: "Experiment",
    icon: "🧪",
    badgeClass: "badge-experiment",
    categoryGroup: "decisions",
  },
  result: {
    label: "Result & Metric",
    icon: "📈",
    badgeClass: "badge-result",
    categoryGroup: "decisions",
  },
  other: {
    label: "Other Knowledge",
    icon: "📝",
    badgeClass: "badge-other",
    categoryGroup: "other",
  },
};

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
    throw new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function MemoryPage() {
  const { overview, loading: workspaceLoading, refresh } = useWorkspace();
  const business = overview?.currentBusiness || overview?.businesses?.[0];
  const businessId = business?.id;

  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedTab, setSelectedTab] = useState<string>("all");
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

  const loadMemory = async () => {
    if (!businessId) {
      setLoading(workspaceLoading);
      return;
    }
    setLoading(true);
    try {
      const data = await api<MemoryItem[]>(`/businesses/${businessId}/memory`);
      setItems(data);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMemory();
  }, [businessId, workspaceLoading]);


  // Tab definitions
  const tabs = useMemo(() => {
    return [
      { id: "all", label: "All Items", count: items.length },
      {
        id: "facts",
        label: "Business Facts",
        count: items.filter((i) => i.type === "business_fact").length,
      },
      {
        id: "audience",
        label: "Audience & ICP",
        count: items.filter((i) => i.type === "audience" || i.type === "channel").length,
      },
      {
        id: "brand",
        label: "Brand & Voice",
        count: items.filter((i) => i.type === "brand" || i.type === "preference").length,
      },
      {
        id: "decisions",
        label: "Decisions & Strategy",
        count: items.filter((i) => i.type === "decision" || i.type === "experiment" || i.type === "result").length,
      },
      {
        id: "product",
        label: "Products & Services",
        count: items.filter((i) => i.type === "product").length,
      },
      {
        id: "other",
        label: "Other",
        count: items.filter((i) => i.type === "other").length,
      },
    ];
  }, [items]);

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
        const typeLabel = MEMORY_TYPE_META[item.type]?.label.toLowerCase() || "";
        return (
          item.title.toLowerCase().includes(q) ||
          item.content.toLowerCase().includes(q) ||
          typeLabel.includes(q) ||
          (item.source && item.source.toLowerCase().includes(q))
        );
      }

      return true;
    });
  }, [items, selectedTab, search]);

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
    showToast("Memory fact copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDeleteItem = async (item: MemoryItem) => {
    if (!businessId) return;
    if (!window.confirm(`Видалити цей факт пам'яті "${item.title}"? Цю дію неможливо скасувати.`)) return;

    try {
      await api(`/businesses/${businessId}/memory/${item.id}`, { method: "DELETE" });
      showToast(`Видалено: "${item.title}"`);
      await loadMemory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not delete memory item";
      showToast(msg);
    }
  };

  const saveMemoryForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setFormError("Title is required");
      return;
    }
    if (!form.content.trim()) {
      setFormError("Fact content description is required");
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
            name: "My Business",
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
        showToast("Memory item updated");
      } else {
        await api(`/businesses/${targetBusinessId}/memory`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("New memory item saved");
      }

      setDrawerOpen(false);
      await loadMemory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save memory item";
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const formatSourceLabel = (src: string) => {
    if (!src) return "Manual";
    if (src === "chat_confirmed") return "Chat Confirmed";
    if (src === "onboarding") return "Onboarding";
    if (src === "user") return "User Verified";
    return src.replace(/_/g, " ");
  };

  return (
    <main className="inspector-page memory-page">
      {/* Page Header matching /settings/capabilities */}
      <header className="marketplace-hero inspector-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">
              {business ? `${business.name} · ` : ""}Business Context & Knowledge
            </p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label="Back to settings"
                title="Back to settings"
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
              <span>Business Memory</span>
            </h1>
            <p className="hero-copy">
              Curate durable facts, verified audience profiles, brand voice rules, and strategic decisions that NPATI Agent leverages across all chats and tasks.
            </p>
          </div>
          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary"
              onClick={openCreateDrawer}
              title="Add a new business fact or decision"
            >
              + Add Memory Fact
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
            placeholder="Search memory by keyword, title, fact content or source..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inspector-search-input"
            aria-label="Filter memory items"
          />
          {search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
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

      {loading && <div className="workspace-notice">Loading business memory...</div>}

      {/* Empty States */}
      {!loading && items.length === 0 && (
        <div className="automations-empty-card memory-empty-card">
          <div className="automations-empty-icon">🧠</div>
          <h3>No Durable Memory Items Yet</h3>
          <p>
            Add core facts about your business, target audience, brand tone, or agreed decisions.
            NPATI Agent will automatically recall these during chat reasoning without hallucinating.
          </p>
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={openCreateDrawer}
          >
            + Add First Fact
          </button>
        </div>
      )}

      {!loading && items.length > 0 && filteredItems.length === 0 && (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>No matching memories</h3>
          <p>Try adjusting your search keywords or switching category filters.</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearch("");
              setSelectedTab("all");
            }}
          >
            Reset Filters
          </button>
        </div>
      )}

      {/* Memory Cards Grid */}
      {!loading && filteredItems.length > 0 && (
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
                        <span>{meta.label}</span>
                      </span>
                      <span className="memory-source-tag" title={`Source: ${item.source || "user"}`}>
                        {formatSourceLabel(item.source)}
                      </span>
                    </div>

                    {false && <button
                      type="button"
                      className="memory-card-top-delete"
                      onClick={() => void handleDeleteItem(item)}
                      title="Delete memory fact"
                      aria-label="Delete memory fact"
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
                      <span>Delete</span>
                    </button>}
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
                      <span className="memory-confidence-pill" title={`Confidence score: ${item.confidence}`}>
                        {item.confidence >= 0.9 ? "✓ Verified" : `${Math.round(item.confidence * 100)}%`}
                      </span>
                    )}
                  </div>

                  <div className="memory-actions">
                    <button
                      type="button"
                      className={`memory-action-btn copy ${copiedId === item.id ? "copied" : ""}`}
                      onClick={() => handleCopyContent(item)}
                      title="Copy fact content"
                    >
                      {copiedId === item.id ? "✓ Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="memory-action-btn edit"
                      onClick={() => openEditDrawer(item)}
                      title="Edit this memory fact"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="memory-action-btn delete"
                      onClick={() => void handleDeleteItem(item)}
                      title="Delete this memory fact"
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
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Slide-over Drawer for Add / Edit Memory */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer memory-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>Business Knowledge</span>
                <h2>{editingItem ? "Edit Memory Fact" : "New Memory Fact"}</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close"
                aria-label="Close"
                onClick={() => setDrawerOpen(false)}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={(e) => void saveMemoryForm(e)}>
              {formError && <div className="workspace-notice error">{formError}</div>}

              <section>
                <h3>Category & Classification</h3>
                <label>
                  <span>Memory Type *</span>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as MemoryType })}
                    className="memory-drawer-select"
                  >
                    <option value="business_fact">📌 Business Fact (Operating rules, pricing, facts)</option>
                    <option value="audience">🎯 Target Audience & ICP (Personas, demographics, pains)</option>
                    <option value="brand">✨ Brand & Voice (Tone, voice, positioning rules)</option>
                    <option value="decision">⚖️ Strategic Decision (Confirmed roadmap, choices)</option>
                    <option value="product">📦 Product & Service (Offerings, specs, features)</option>
                    <option value="channel">📢 Marketing Channel (Distribution, platforms)</option>
                    <option value="preference">⚙️ User Preference (Format, prompt instructions)</option>
                    <option value="experiment">🧪 Experiment (Growth tests, active hypotheses)</option>
                    <option value="result">📈 Result & Metric (Outcomes, verified findings)</option>
                    <option value="other">📝 Other Knowledge</option>
                  </select>
                </label>
              </section>

              <section>
                <h3>Memory Details</h3>
                <label>
                  <span>Title *</span>
                  <input
                    type="text"
                    required
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="e.g. Primary Target Customer: B2B Founders in Europe"
                    className="memory-drawer-input"
                  />
                </label>
                <label>
                  <span>Fact Content / Guidelines *</span>
                  <textarea
                    rows={6}
                    required
                    value={form.content}
                    onChange={(e) => setForm({ ...form, content: e.target.value })}
                    placeholder="Detail the verified facts, numbers, boundaries or rules that NPATI Agent must adhere to..."
                    className="memory-drawer-textarea"
                  />
                </label>
              </section>

              <section>
                <h3>Confidence Level</h3>
                <label>
                  <span>Verification Level</span>
                  <select
                    value={form.confidence}
                    onChange={(e) => setForm({ ...form, confidence: e.target.value })}
                    className="memory-drawer-select"
                  >
                    <option value="1.0">Verified Fact (100% - Ground truth rule)</option>
                    <option value="0.8">High Confidence (80% - Strongly observed)</option>
                    <option value="0.5">Hypothesis (50% - Under exploration)</option>
                  </select>
                </label>
              </section>

              <footer>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setDrawerOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary"
                  disabled={saving}
                >
                  {saving ? "Saving Fact..." : editingItem ? "Save Changes" : "Save Memory Fact"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* Floating toast notification */}
      {toastMessage && <div className="content-toast">{toastMessage}</div>}
    </main>
  );
}
