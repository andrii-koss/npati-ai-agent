import { useEffect, useState, useMemo, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { useWorkspace } from "./BusinessWorkspace";
import {
  createDefaultWebsiteDocument,
  getWebsiteAdapter,
  type WebsiteDocument,
} from "@npati/shared";

export type WebsiteProject = {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  type: "website" | "web_app" | "landing_page";
  status: string;
  framework?: string;
  repositoryBranch?: string;
  sandboxId?: string;
  previewUrl?: string;
  previewPort?: number;
  lastBuildStatus?: string;
  deploymentStatus?: string;
  deploymentUrl?: string;
  lastDeployedAt?: string;
  revision: number;
  createdAt?: string;
  updatedAt: string;
};

const copy = {
  en: {
    title: "Website Builder",
    subtitle: "Create, customize, and manage responsive websites with Next.js and AI.",
    newWebsite: "Create Website",
    searchPlaceholder: "Search websites...",
    filterAll: "All Frameworks",
    filterStatusAll: "All Statuses",
    statusActive: "Active",
    statusArchived: "Archived",
    emptyTitle: "No websites yet",
    emptySubtitle: "Build your first modern website with Next.js using our Visual Builder or describe it to the AI Agent.",
    createNow: "Create First Website",
    openBuilder: "Open in Builder →",
    preview: "Preview ↗",
    deploy: "Deploy",
    rename: "Rename",
    duplicate: "Duplicate",
    archive: "Archive",
    delete: "Delete",
    nameLabel: "Website Name",
    descLabel: "Purpose & Description",
    frameworkLabel: "Framework",
    typeLabel: "Project Type",
    typeWebsite: "Multi-page Website",
    typeLanding: "Landing Page",
    typeWebApp: "Web Application",
    cancel: "Cancel",
    createBtn: "Create Website",
    creating: "Creating...",
    duplicating: "Duplicating...",
    renamePrompt: "Enter new website name:",
    archivePrompt: "Are you sure you want to archive this website?",
    deletePrompt: "Are you sure you want to permanently delete this website? This action cannot be undone.",
    loadError: "Could not load websites",
    liveBadge: "Live Preview Active",
    readyBadge: "Ready",
  },
  uk: {
    title: "Website Builder",
    subtitle: "Створюйте, редагуйте та публікуйте адаптивні сайти на Next.js та за допомогою AI.",
    newWebsite: "Створити сайт",
    searchPlaceholder: "Пошук сайтів за назвою...",
    filterAll: "Всі фреймворки",
    filterStatusAll: "Всі статуси",
    statusActive: "Активні",
    statusArchived: "Архівні",
    emptyTitle: "Сайтів ще немає",
    emptySubtitle: "Створіть свій перший сучасний сайт на Next.js у Візуальному Конструкторі або попросіть AI Агента в чаті.",
    createNow: "Створити перший сайт",
    openBuilder: "Відкрити в Конструкторі →",
    preview: "Прев’ю ↗",
    deploy: "Деплой",
    rename: "Перейменувати",
    duplicate: "Дублювати",
    archive: "Архівувати",
    delete: "Видалити",
    nameLabel: "Назва сайту",
    descLabel: "Опис та призначення",
    frameworkLabel: "Фреймворк",
    typeLabel: "Тип сайту",
    typeWebsite: "Багатосторінковий сайт",
    typeLanding: "Лендінг",
    typeWebApp: "Вебзастосунок",
    cancel: "Скасувати",
    createBtn: "Створити сайт",
    creating: "Створення...",
    duplicating: "Дублювання...",
    renamePrompt: "Введіть нову назву сайту:",
    archivePrompt: "Ви впевнені, що бажаєте архівувати цей сайт?",
    deletePrompt: "Ви впевнені, що бажаєте назавжди видалити цей сайт? Цю дію неможливо скасувати.",
    loadError: "Не вдалося завантажити сайти",
    liveBadge: "Live Preview активний",
    readyBadge: "Готовий",
  },
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message || "Request failed");
  return body;
}

export function WebsiteBuilderDashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { overview } = useWorkspace();
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;

  const companyId = searchParams.get("companyId") || overview?.currentBusiness?.id || overview?.businesses[0]?.id || "";

  const [websites, setWebsites] = useState<WebsiteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [framework, setFramework] = useState("Next.js");
  const [type, setType] = useState<WebsiteProject["type"]>("website");
  const [busy, setBusy] = useState(false);

  const loadWebsites = async () => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ projects: WebsiteProject[] }>(
        `/companies/${encodeURIComponent(companyId)}/projects?includeArchived=true`
      );
      setWebsites(res.projects || []);
      setError("");
    } catch (err: any) {
      setError(err.message || t.loadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWebsites();
  }, [companyId]);

  const filteredWebsites = useMemo(() => {
    return websites.filter((site) => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = site.name.toLowerCase().includes(q);
        const matchesDesc = (site.description || "").toLowerCase().includes(q);
        if (!matchesName && !matchesDesc) return false;
      }
      // Status
      if (statusFilter === "active" && site.status === "archived") return false;
      if (statusFilter === "archived" && site.status !== "archived") return false;
      // Framework
      if (frameworkFilter !== "all") {
        const fw = (site.framework || "").toLowerCase();
        if (frameworkFilter === "nextjs" && !fw.includes("next")) return false;
        if (frameworkFilter === "vite" && !fw.includes("vite")) return false;
      }
      return true;
    });
  }, [websites, searchQuery, statusFilter, frameworkFilter]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !companyId || busy) return;
    setBusy(true);
    try {
      const created = await apiFetch<WebsiteProject>(
        `/companies/${encodeURIComponent(companyId)}/projects`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            type,
          }),
        }
      );

      // Initialize website document & scaffold Next.js / Vite files
      const doc: WebsiteDocument = createDefaultWebsiteDocument(
        name.trim(),
        framework.toLowerCase().includes("vite") ? "vite" : "nextjs",
        { purpose: description.trim() }
      );
      const adapter = getWebsiteAdapter(doc.framework);
      const files = adapter.scaffoldProject(doc);

      // Write initial files into the new project workspace
      for (const [filePath, content] of Object.entries(files)) {
        try {
          await apiFetch(
            `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(created.id)}/files/write`,
            {
              method: "POST",
              body: JSON.stringify({ path: filePath, content }),
            }
          );
        } catch {
          // ignore individual file write error
        }
      }

      setModalOpen(false);
      setName("");
      setDescription("");
      navigate(`/settings/websites/${encodeURIComponent(companyId)}/${encodeURIComponent(created.id)}`);
    } catch (err: any) {
      setError(err.message || "Failed to create website");
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (site: WebsiteProject) => {
    const next = await promptModal({ message: t.renamePrompt, defaultValue: site.name });
    if (!next || !next.trim() || next.trim() === site.name) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: next.trim(), expectedRevision: site.revision }),
        }
      );
      await loadWebsites();
    } catch (err: any) {
      alert(err.message || "Failed to rename website");
    }
  };

  const handleDuplicate = async (site: WebsiteProject) => {
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/duplicate`,
        {
          method: "POST",
          body: JSON.stringify({ name: `${site.name} (Copy)` }),
        }
      );
      await loadWebsites();
    } catch (err: any) {
      alert(err.message || "Failed to duplicate website");
    }
  };

  const handleArchive = async (site: WebsiteProject) => {
    if (!(await confirmModal({ message: t.archivePrompt }))) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/archive`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: site.revision }),
        }
      );
      await loadWebsites();
    } catch (err: any) {
      alert(err.message || "Failed to archive website");
    }
  };

  const handleDelete = async (site: WebsiteProject) => {
    if (!(await confirmModal({ message: t.deletePrompt, isDanger: true }))) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}`,
        { method: "DELETE" }
      );
      await loadWebsites();
    } catch (err: any) {
      alert(err.message || "Failed to delete website");
    }
  };

  return (
    <div className="website-builder-dashboard company-page" style={{ padding: "1.5rem", maxWidth: "1400px", margin: "0 auto" }}>
      {/* Top Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span>🌐</span> {t.title}
          </h1>
          <p style={{ color: "var(--muted-color, #8b949e)", margin: "0.35rem 0 0 0", fontSize: "0.95rem" }}>
            {t.subtitle}
          </p>
        </div>
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            setError("");
            setModalOpen(true);
          }}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <span>+</span> {t.newWebsite}
        </button>
      </header>

      {/* Filters and Search Bar */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="search"
          placeholder={t.searchPlaceholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: "1 1 280px",
            padding: "0.6rem 1rem",
            background: "var(--surface-color, rgba(255,255,255,0.04))",
            border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
            borderRadius: "8px",
            color: "inherit",
            fontSize: "0.9rem",
          }}
        />

        <select
          value={frameworkFilter}
          onChange={(e) => setFrameworkFilter(e.target.value)}
          style={{
            padding: "0.6rem 1rem",
            background: "var(--surface-color, rgba(255,255,255,0.04))",
            border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
            borderRadius: "8px",
            color: "inherit",
            fontSize: "0.9rem",
          }}
        >
          <option value="all">{t.filterAll}</option>
          <option value="nextjs">Next.js</option>
          <option value="vite">Vite + React</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: "0.6rem 1rem",
            background: "var(--surface-color, rgba(255,255,255,0.04))",
            border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
            borderRadius: "8px",
            color: "inherit",
            fontSize: "0.9rem",
          }}
        >
          <option value="active">{t.statusActive}</option>
          <option value="all">{t.filterStatusAll}</option>
          <option value="archived">{t.statusArchived}</option>
        </select>
      </div>

      {error && (
        <div role="alert" className="project-error" style={{ marginBottom: "1.5rem" }}>
          ⚠️ {error}
        </div>
      )}

      {/* Grid of Website Projects */}
      {loading ? (
        <p style={{ color: "var(--muted-color, #8b949e)" }}>Loading websites...</p>
      ) : filteredWebsites.length === 0 ? (
        <div
          className="company-run-card"
          style={{
            textAlign: "center",
            padding: "4rem 2rem",
            borderRadius: "12px",
            border: "1px dashed var(--border-color, rgba(255,255,255,0.15))",
          }}
        >
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🌐</div>
          <h3 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>{t.emptyTitle}</h3>
          <p style={{ color: "var(--muted-color, #8b949e)", maxWidth: "480px", margin: "0 auto 1.5rem auto", fontSize: "0.95rem" }}>
            {t.emptySubtitle}
          </p>
          <button
            type="button"
            className="button-primary"
            onClick={() => setModalOpen(true)}
          >
            {t.createNow}
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: "1.5rem",
          }}
        >
          {filteredWebsites.map((site) => {
            const editorUrl = `/settings/websites/${encodeURIComponent(companyId)}/${encodeURIComponent(site.id)}`;
            const isNext = (site.framework || "").toLowerCase().includes("next");

            return (
              <article
                key={site.id}
                className="project-card company-run-card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  borderRadius: "12px",
                  padding: "1.25rem",
                  border: "1px solid var(--border-color, rgba(255,255,255,0.1))",
                  position: "relative",
                  transition: "transform 0.2s ease, border-color 0.2s ease",
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                      <span style={{ fontSize: "1.5rem" }}>🌐</span>
                      <div>
                        <h3 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0 }}>
                          <Link to={editorUrl} style={{ color: "inherit" }}>
                            {site.name}
                          </Link>
                        </h3>
                        <span style={{ fontSize: "0.8rem", color: "var(--muted-color, #8b949e)" }}>
                          {site.type === "landing_page" ? t.typeLanding : site.type === "web_app" ? t.typeWebApp : t.typeWebsite}
                        </span>
                      </div>
                    </div>
                    <span className={`status-pill status-${site.status}`}>{site.status}</span>
                  </div>

                  {site.description && (
                    <p style={{ fontSize: "0.85rem", color: "var(--muted-color, #8b949e)", margin: "0.5rem 0 1rem 0", lineClamp: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {site.description}
                    </p>
                  )}

                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.78rem", marginBottom: "1.25rem" }}>
                    <span style={{ background: isNext ? "rgba(0,0,0,0.4)" : "rgba(100,108,255,0.15)", border: "1px solid rgba(255,255,255,0.1)", padding: "0.15rem 0.5rem", borderRadius: "4px" }}>
                      ⚡ {site.framework || "Next.js"}
                    </span>
                    {site.previewUrl && (
                      <span style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "0.15rem 0.5rem", borderRadius: "4px" }}>
                        ● {t.liveBadge}
                      </span>
                    )}
                    {site.deploymentUrl && (
                      <span style={{ background: "rgba(59, 130, 246, 0.15)", color: "#60a5fa", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "0.15rem 0.5rem", borderRadius: "4px" }}>
                        🚀 Live
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "1rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                    <Link
                      to={editorUrl}
                      className="button-primary"
                      style={{ fontSize: "0.85rem", padding: "0.45rem 0.85rem", textDecoration: "none" }}
                    >
                      {t.openBuilder}
                    </Link>

                    {site.previewUrl && (
                      <a
                        href={site.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="button-secondary"
                        style={{ fontSize: "0.85rem", padding: "0.45rem 0.75rem", textDecoration: "none" }}
                      >
                        {t.preview}
                      </a>
                    )}

                    <button
                      type="button"
                      className="button-secondary"
                      style={{ fontSize: "0.85rem", padding: "0.45rem 0.65rem" }}
                      onClick={() => void handleDuplicate(site)}
                      title={t.duplicate}
                    >
                      📋
                    </button>

                    <button
                      type="button"
                      className="button-secondary"
                      style={{ fontSize: "0.85rem", padding: "0.45rem 0.65rem" }}
                      onClick={() => void handleRename(site)}
                      title={t.rename}
                    >
                      ✏️
                    </button>

                    {site.status !== "archived" && (
                      <button
                        type="button"
                        className="button-secondary"
                        style={{ fontSize: "0.85rem", padding: "0.45rem 0.65rem" }}
                        onClick={() => void handleArchive(site)}
                        title={t.archive}
                      >
                        📦
                      </button>
                    )}

                    <button
                      type="button"
                      className="danger-button"
                      style={{ fontSize: "0.85rem", padding: "0.45rem 0.65rem" }}
                      onClick={() => void handleDelete(site)}
                      title={t.delete}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Create Website Modal / Drawer */}
      {modalOpen && (
        <div
          className="company-drawer-backdrop"
          onMouseDown={() => setModalOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", justifyContent: "center", alignItems: "center" }}
        >
          <div
            className="company-drawer"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: "var(--background-color, #0f141c)",
              border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
              borderRadius: "16px",
              padding: "2rem",
              width: "100%",
              maxWidth: "540px",
              boxShadow: "0 25px 50px rgba(0,0,0,0.8)",
            }}
          >
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1.35rem", fontWeight: 700, margin: 0 }}>🌐 {t.newWebsite}</h2>
              <button
                type="button"
                className="company-drawer-close"
                onClick={() => setModalOpen(false)}
                aria-label={t.cancel}
                style={{ background: "transparent", border: "none", fontSize: "1.5rem", color: "inherit", cursor: "pointer" }}
              >
                ×
              </button>
            </header>

            <form onSubmit={(e) => void handleCreate(e)}>
              {error && <p role="alert" className="project-error" style={{ marginBottom: "1rem" }}>{error}</p>}

              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
                  {t.nameLabel} *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. CloudScale Hosting"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ width: "100%", padding: "0.65rem 0.85rem", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                />
              </div>

              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
                  {t.descLabel}
                </label>
                <textarea
                  rows={3}
                  placeholder="Describe your site (e.g. Modern cloud hosting company with domain registration, pricing tiers, and contact form)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{ width: "100%", padding: "0.65rem 0.85rem", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
                    {t.frameworkLabel}
                  </label>
                  <select
                    value={framework}
                    onChange={(e) => setFramework(e.target.value)}
                    style={{ width: "100%", padding: "0.65rem 0.85rem", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                  >
                    <option value="Next.js">Next.js (App Router)</option>
                    <option value="Vite">Vite + React</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
                    {t.typeLabel}
                  </label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as any)}
                    style={{ width: "100%", padding: "0.65rem 0.85rem", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                  >
                    <option value="website">{t.typeWebsite}</option>
                    <option value="landing_page">{t.typeLanding}</option>
                    <option value="web_app">{t.typeWebApp}</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setModalOpen(false)}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button-primary"
                  disabled={busy || !name.trim()}
                >
                  {busy ? t.creating : t.createBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
