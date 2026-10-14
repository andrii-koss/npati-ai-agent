import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { writeProjectFile } from "./project-files-client";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  createDefaultWebsiteDocument,
  createMobileAppScaffold,
  defaultAppScheme,
  slugifyProjectName,
  getWebsiteAdapter,
  type WebsiteDocument,
  type WebsiteDomainConfig,
} from "@npati/shared";
import {
  chooseAvailableCompanyId,
  readActiveCompanyId,
  readCachedCompanies,
  writeActiveCompanyId,
} from "./active-company";

export interface WebsiteProject {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  type: "website" | "web_app" | "landing_page" | "mobile_app" | "code_project";
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
}

import {
  FrameworkIcon,
  type FrameworkStarterOption,
  FRAMEWORK_STARTERS,
  websiteBuilderCopy as copy,
} from "./website-builder-constants";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch("/api" + path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `Request failed with status ${res.status}`);
  }
  return json as T;
}

const WEBSITES_CACHE_PREFIX = "npati_websites_cache_v1_";
const WEBSITES_LATEST_CACHE_KEY = "npati_websites_cache_latest_v1";

function getCachedWebsites(companyId?: string): WebsiteProject[] | null {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(WEBSITES_CACHE_PREFIX + companyId)
        || localStorage.getItem(WEBSITES_CACHE_PREFIX + companyId);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
    const latest = sessionStorage.getItem(WEBSITES_LATEST_CACHE_KEY)
      || localStorage.getItem(WEBSITES_LATEST_CACHE_KEY);
    if (latest) {
      const parsed = JSON.parse(latest);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return null;
}

function updateCachedWebsites(companyId: string, items: WebsiteProject[]) {
  try {
    const serialized = JSON.stringify(items);
    if (companyId) {
      sessionStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
    }
    sessionStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
    localStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
  } catch {}
}

export function WebsiteBuilderDashboard() {
  const navigate = useNavigate();
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;
  const projectTypeLabel = (value: WebsiteProject["type"]) =>
    value === "landing_page" ? t.typeLanding
      : value === "web_app" ? t.typeWebApp
        : value === "mobile_app" ? t.typeMobileApp
          : t.typeWebsite;

  const initialCompanyId = useMemo(() => {
    const cached = readCachedCompanies();
    const active = readActiveCompanyId();
    return chooseAvailableCompanyId(cached, { requested: active });
  }, []);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>(() => readCachedCompanies());
  const [companyId, setCompanyId] = useState<string>(initialCompanyId);
  const initialWebsites = useMemo(() => getCachedWebsites(initialCompanyId), [initialCompanyId]);
  const [websites, setWebsites] = useState<WebsiteProject[]>(() => initialWebsites ?? []);
  const [loading, setLoading] = useState(() => initialWebsites === null);
  const [error, setError] = useState("");

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("active");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");

  // Create Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFramework, setSelectedFramework] = useState<FrameworkStarterOption["id"]>("html-css");
  const [name, setName] = useState(FRAMEWORK_STARTERS[0]?.defaultName ?? "Modern HTML/CSS Website");
  const [description, setDescription] = useState(FRAMEWORK_STARTERS[0]?.defaultDesc ?? "Clean responsive website");
  const [framework, setFramework] = useState<string>("HTML/CSS");
  const [type, setType] = useState<"website" | "landing_page" | "web_app" | "mobile_app">("website");
  const [domain, setDomain] = useState("");
  const [internalPath, setInternalPath] = useState("/");
  const [stripPath, setStripPath] = useState(false);
  const [containerPort, setContainerPort] = useState(3000);
  const [useCustomEntrypoint, setUseCustomEntrypoint] = useState(false);
  const [customEntrypoint, setCustomEntrypoint] = useState("web, websecure");
  const [autoSsl, setAutoSsl] = useState(true);
  const [busy, setBusy] = useState(false);

  // Sync default container port with framework selection
  useEffect(() => {
    const fw = framework.toLowerCase();
    if (fw.includes("vite")) {
      setContainerPort(5173);
    } else if (fw.includes("astro")) {
      setContainerPort(4321);
    } else {
      setContainerPort(3000);
    }
  }, [framework]);

  // Load Companies
  useEffect(() => {
    let active = true;
    async function loadCompanies() {
      try {
        const cached = readCachedCompanies();
        if (cached.length > 0 && active) {
          setCompanies(cached);
          const initialId = chooseAvailableCompanyId(cached, { requested: readActiveCompanyId() });
          if (initialId) setCompanyId((prev) => prev || initialId);
        }

        const res = await apiFetch<{ companies: Array<{ id: string; name: string }> }>("/companies");
        if (!active) return;
        const list = res.companies || [];
        setCompanies(list);
        if (list.length === 0) {
          setWebsites([]);
          setLoading(false);
          return;
        }
        const resolved = chooseAvailableCompanyId(list, { requested: readActiveCompanyId() });
        setCompanyId(resolved);
        writeActiveCompanyId(resolved);
      } catch (err: any) {
        if (active) {
          setError(err.message || t.loadError);
          setLoading(false);
        }
      }
    }
    void loadCompanies();
    return () => {
      active = false;
    };
  }, []);

  // Load Websites for Company
  const loadWebsites = async (targetCompanyId?: string) => {
    const id = targetCompanyId ?? companyId;
    if (!id) {
      return;
    }
    try {
      const res = await apiFetch<{ projects: WebsiteProject[] }>(
        `/companies/${encodeURIComponent(id)}/projects?includeArchived=true`
      );
      const nextProjects = (res.projects || []).filter(site => site.type !== "code_project" || /^(Next\.js|HTML\/CSS|React|Vite)$/i.test(site.framework ?? ""));
      setWebsites(nextProjects);
      updateCachedWebsites(id, nextProjects);
      setError("");
    } catch (err: any) {
      setError(err.message || t.loadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyId) {
      void loadWebsites(companyId);
    }
  }, [companyId]);

  // When framework selection changes in drawer, update suggested values.
  const handleSelectFramework = (fw: FrameworkStarterOption) => {
    setSelectedFramework(fw.id);
    setFramework(fw.frameworkKey);
    setContainerPort(fw.defaultPort);
    setName(language === "uk" ? fw.defaultNameUk : fw.defaultName);
    setDescription(language === "uk" ? fw.defaultDescUk : fw.defaultDesc);
    setType((current) => current === "mobile_app" ? current : fw.defaultType);
  };

  const filteredWebsites = useMemo(() => {
    return websites.filter((site) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = site.name.toLowerCase().includes(q);
        const matchesDesc = (site.description || "").toLowerCase().includes(q);
        if (!matchesName && !matchesDesc) return false;
      }
      if (statusFilter === "active" && site.status === "archived") return false;
      if (statusFilter === "archived" && site.status !== "archived") return false;

      if (frameworkFilter !== "all") {
        const fw = (site.framework || "").toLowerCase();
        if (frameworkFilter === "static" && !fw.includes("static") && !fw.includes("html")) return false;
        if (frameworkFilter === "nextjs" && !fw.includes("next")) return false;
        if (frameworkFilter === "vite" && !fw.includes("vite")) return false;
        if (frameworkFilter === "astro" && !fw.includes("astro")) return false;
      }
      return true;
    });
  }, [websites, searchQuery, statusFilter, frameworkFilter]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !companyId || busy) return;
    setBusy(true);
    try {
      // Determine domain: use custom domain if provided, otherwise generate temporary technical preview domain
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
      const userDomainTrimmed = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const randomSuffix = Math.random().toString(36).substring(2, 6);
      const technicalDomain = `${slug}-${randomSuffix}.preview.npati.com`;
      const finalDomain = userDomainTrimmed || technicalDomain;
      const isTechnical = !userDomainTrimmed;

      const domainConfig: WebsiteDomainConfig = {
        domain: finalDomain,
        isTechnicalDomain: isTechnical,
        path: internalPath.trim() || "/",
        stripPath,
        port: Number(containerPort) || (framework.toLowerCase().includes("vite") ? 80 : 3000),
        customEntrypoint: useCustomEntrypoint,
        entrypoints: useCustomEntrypoint
          ? customEntrypoint.split(",").map((s) => s.trim()).filter(Boolean)
          : ["web", "websecure"],
        sslCertificate: autoSsl,
        certificateProvider: autoSsl ? "letsencrypt" : "none",
      };

      const created = await apiFetch<WebsiteProject>(
        `/companies/${encodeURIComponent(companyId)}/projects`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            type,
            deploymentUrl: `https://${finalDomain}`,
            previewUrl: `https://${finalDomain}`,
            previewPort: domainConfig.port,
          }),
        }
      );

      // Initialize project files. Mobile projects get the Expo template (D6) so the workspace
      // never mixes a Next.js/Vite scaffold into a React Native app.
      const fwLower = framework.toLowerCase();
      const isVite = fwLower.includes("vite");
      const isStatic = fwLower.includes("html") || fwLower.includes("static");
      const isAstro = fwLower.includes("astro");
      const isMobileApp = type === "mobile_app";

      const targetFramework: "nextjs" | "vite" | "static" | "astro" = isStatic
        ? "static"
        : isVite
          ? "vite"
          : isAstro
            ? "astro"
            : "nextjs";

      const doc: WebsiteDocument = createDefaultWebsiteDocument(
        name.trim(),
        targetFramework,
        {
          purpose: description.trim(),
          template: "blank",
          domainConfig,
        }
      );

      const files: Record<string, string> = isMobileApp
        ? createMobileAppScaffold({ name: name.trim(), slug: slugifyProjectName(name.trim()), scheme: defaultAppScheme(name.trim()) }).files
        : getWebsiteAdapter(doc.framework).scaffoldProject(doc);

      // Save domain and deployment configuration file in project files
      if (!isMobileApp) {
        files["deployment.json"] = JSON.stringify(
          {
            domain: finalDomain,
            isTechnicalDomain: isTechnical,
            path: domainConfig.path,
            stripPath: domainConfig.stripPath,
            port: domainConfig.port,
            entrypoints: domainConfig.entrypoints,
            ssl: domainConfig.sslCertificate ? "Let's Encrypt" : "Disabled",
            createdAt: new Date().toISOString(),
          },
          null,
          2
        );
      }

      // Write initial scaffold files into the workspace
      for (const [filePath, content] of Object.entries(files)) {
        try {
          // Shared adapter (C7): the scaffold write goes through the same client module as the file browser.
          await writeProjectFile({ companyId, projectId: created.id }, filePath, content);
        } catch {
          // ignore individual write fail
        }
      }

      // Automatically start framework dev / preview runtime
      void apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(created.id)}/preview/start`,
        {
          method: "POST",
          body: JSON.stringify({ port: domainConfig.port }),
        }
      ).catch(() => {});

      const promptText = language === "uk"
        ? `Розгорни та налаштуй проєкт на базі ${framework}`
        : `Deploy and setup ${framework} project`;

      setModalOpen(false);
      navigate(
        `/settings/websites/${encodeURIComponent(companyId)}/${encodeURIComponent(created.id)}`,
        { state: { prompt: promptText } }
      );
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
      setLoading(true);
      const res = await apiFetch<{ project: WebsiteProject }>(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(site.id)}/duplicate`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ name: `${site.name} (Copy)` }),
        }
      );
      await loadWebsites();
      if (res?.project?.id) {
        navigate(`/settings/websites/${encodeURIComponent(companyId)}/${encodeURIComponent(res.project.id)}`);
      }
    } catch (err: any) {
      alert(err.message || "Failed to duplicate website");
    } finally {
      setLoading(false);
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
    <main className="company-refined company-page" style={{ maxWidth: "1400px", margin: "0 auto", padding: "20px 24px" }}>
      {/* NPATI Header Standard (Matching Settings & Automations) */}
      <header className="inspector-header automations-header" style={{ marginBottom: "24px" }}>
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t.eyebrow}</p>
            <h1>
              <Link to="/settings" className="marketplace-back-button" aria-label="Settings" title="Settings">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t.title}</span>
            </h1>
            <p className="hero-copy">{t.subtitle}</p>
          </div>

          <div className="automations-header-actions" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {companies.length > 1 && (
              <select
                value={companyId}
                onChange={(e) => {
                  const nextCompanyId = e.target.value;
                  setCompanyId(nextCompanyId);
                  writeActiveCompanyId(nextCompanyId);
                  const cached = getCachedWebsites(nextCompanyId);
                  if (cached !== null) {
                    setWebsites(cached);
                  }
                }}
                className="company-select"
                style={{
                  padding: "9px 14px",
                  borderRadius: "10px",
                  border: "1px solid var(--npati-gray-200, #e2e8f0)",
                  background: "#ffffff",
                  color: "#111111",
                  fontSize: "13.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            <button
              type="button"
              className="button-primary"
              onClick={() => {
                setError("");
                setModalOpen(true);
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              <span style={{ fontSize: "16px", lineHeight: 1 }}>+</span>
              <span>{t.newWebsite}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Filter and Search Bar (Clean NPATI Controls) */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "24px",
          flexWrap: "wrap",
          alignItems: "center",
          background: "#ffffff",
          padding: "14px 18px",
          borderRadius: "14px",
          border: "1px solid #e4e4e7",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div className="inspector-search-box" style={{ flex: "1 1 260px" }}>
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label={t.searchPlaceholder}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <select
          value={frameworkFilter}
          onChange={(e) => setFrameworkFilter(e.target.value)}
          style={{
            height: "44px",
            padding: "0 14px",
            background: "var(--npati-gray-50)",
            border: "1px solid var(--npati-gray-100)",
            borderRadius: "12px",
            color: "#111111",
            fontSize: "13.5px",
            fontWeight: 500,
            cursor: "pointer",
            outline: "none",
          }}
        >
          <option value="all">{t.filterAll}</option>
          <option value="static">HTML / CSS</option>
          <option value="nextjs">Next.js</option>
          <option value="vite">Vite</option>
          <option value="astro">Astro</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          style={{
            height: "44px",
            padding: "0 14px",
            background: "var(--npati-gray-50)",
            border: "1px solid var(--npati-gray-100)",
            borderRadius: "12px",
            color: "#111111",
            fontSize: "13.5px",
            fontWeight: 500,
            cursor: "pointer",
            outline: "none",
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
      {websites.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🌐</div>
          <h3>{t.emptyTitle}</h3>
          <p>{t.emptySubtitle}</p>
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={() => setModalOpen(true)}
          >
            + {t.createNow}
          </button>
        </div>
      ) : filteredWebsites.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{language === "uk" ? "Нічого не знайдено" : "No matching websites"}</h3>
          <p>{language === "uk" ? "Спробуйте змінити пошуковий запит або скинути фільтри." : "Try adjusting your search query or clear the active filters."}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => { setSearchQuery(""); setStatusFilter("all"); setFrameworkFilter("all"); }}
          >
            {language === "uk" ? "Скинути фільтри" : "Clear filters"}
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))",
            gap: "20px",
          }}
        >
          {filteredWebsites.map((site) => {
            const editorUrl = `/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(site.id)}`;
            const isNext = (site.framework || "").toLowerCase().includes("next");
            const isPreviewing = site.status === "previewing" || Boolean(site.previewUrl);

            return (
              <article
                key={site.id}
                className="company-run-card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  background: "#ffffff",
                  borderRadius: "16px",
                  padding: "20px 22px",
                  border: "1px solid #e4e4e7",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
                  transition: "all 0.18s ease",
                  margin: 0,
                }}
              >
                <div>
                  {/* Top Bar with Icon & Status Badges */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <div
                        style={{
                          width: "42px",
                          height: "42px",
                          borderRadius: "12px",
                          background: "#eff6ff",
                          border: "1px solid #dbeafe",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "20px",
                          flexShrink: 0,
                        }}
                      >
                        🌐
                      </div>
                      <div>
                        <h3 style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: "#111111", lineHeight: 1.3 }}>
                          <Link to={editorUrl} style={{ color: "inherit", textDecoration: "none" }}>
                            {site.name}
                          </Link>
                        </h3>
                        <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: "6px",
                              background: isNext ? "#f3e8ff" : "#e0f2fe",
                              color: isNext ? "#7e22ce" : "#0369a1",
                              border: `1px solid ${isNext ? "#e9d5ff" : "#bae6fd"}`,
                            }}
                          >
                            {isNext ? "Next.js" : "Vite"}
                          </span>

                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: "6px",
                              background: isPreviewing ? "#ecfdf5" : "#f1f5f9",
                              color: isPreviewing ? "#047857" : "#475569",
                              border: `1px solid ${isPreviewing ? "#a7f3d0" : "#e2e8f0"}`,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <span
                              style={{
                                width: "6px",
                                height: "6px",
                                borderRadius: "50%",
                                background: isPreviewing ? "#10b981" : "#94a3b8",
                              }}
                            />
                            {isPreviewing ? t.liveStatus : t.readyStatus}
                          </span>

                          {(site.deploymentUrl || site.previewUrl) && (
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: "6px",
                                background: "#f8fafc",
                                color: "#0f172a",
                                border: "1px solid #e2e8f0",
                              }}
                              title="Domain"
                            >
                              🌐 {(site.deploymentUrl || site.previewUrl || "").replace(/^https?:\/\//, "")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <p
                    style={{
                      fontSize: "13.5px",
                      color: "#52525b",
                      margin: "0 0 16px 0",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {site.description || "Responsive Next.js website with visual block layout."}
                  </p>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", color: "#71717a", borderTop: "1px solid #f4f4f5", paddingTop: "12px", marginBottom: "16px" }}>
                    <span>{t.updated}: {new Date(site.updatedAt).toLocaleDateString(language)}</span>
                    <span style={{ fontWeight: 600, color: "#3f3f46" }}>
                      {projectTypeLabel(site.type)}
                    </span>
                  </div>
                </div>

                {/* Actions Toolbar */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Link
                    to={editorUrl}
                    className="button-primary"
                    style={{
                      flex: "1 1 auto",
                      textAlign: "center",
                      textDecoration: "none",
                      padding: "8px 14px",
                      fontSize: "13px",
                      fontWeight: 600,
                    }}
                  >
                    {t.openBuilder} →
                  </Link>

                  {site.previewUrl && (
                    <a
                      href={site.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="button-secondary"
                      style={{
                        padding: "8px 12px",
                        fontSize: "13px",
                        textDecoration: "none",
                        color: "#047857",
                      }}
                      title="Open Live Preview in new tab"
                    >
                      {t.preview} ↗
                    </a>
                  )}

                  {/* C7: the same project, opened in the code workspace. One link, no second service. */}
                  <Link
                    to={`/settings/code/${encodeURIComponent(companyId)}/${encodeURIComponent(site.id)}`}
                    className="button-secondary"
                    style={{ padding: "8px 12px", fontSize: "13px", textDecoration: "none" }}
                    title={language === "uk" ? "Відкрити цей самий проєкт у Code Workspace" : "Open this same project in Code Workspace"}
                  >
                    {"</>"} {language === "uk" ? "Код" : "Code"}
                  </Link>

                  <button
                    type="button"
                    className="button-secondary"
                    style={{ padding: "8px 10px", fontSize: "13px" }}
                    onClick={() => void handleDuplicate(site)}
                    title={t.duplicate}
                  >
                    📋
                  </button>

                  <button
                    type="button"
                    className="button-secondary"
                    style={{ padding: "8px 10px", fontSize: "13px" }}
                    onClick={() => void handleRename(site)}
                    title={t.rename}
                  >
                    ✏️
                  </button>

                  {site.status !== "archived" && (
                    <button
                      type="button"
                      className="button-secondary"
                      style={{ padding: "8px 10px", fontSize: "13px" }}
                      onClick={() => void handleArchive(site)}
                      title={t.archive}
                    >
                      📦
                    </button>
                  )}

                  <button
                    type="button"
                    className="danger-button"
                    style={{ padding: "8px 10px", fontSize: "13px" }}
                    onClick={() => void handleDelete(site)}
                    title={t.delete}
                  >
                    🗑️
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ========================================================
          CREATE WEBSITE DRAWER (100% NATIVE NPATI DESIGN SYSTEM)
          ======================================================== */}
      {modalOpen && (
        <div
          className="company-drawer-backdrop"
          onMouseDown={() => setModalOpen(false)}
        >
          <aside
            className="company-drawer"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <span>{t.drawerKicker}</span>
                <h2>{t.drawerTitle}</h2>
              </div>
              <button
                type="button"
                className="company-drawer-close"
                onClick={() => setModalOpen(false)}
                aria-label={t.cancel}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <form onSubmit={(e) => void handleCreate(e)}>
              {error && (
                <p role="alert" className="project-error" style={{ margin: "16px 26px 0 26px" }}>
                  {error}
                </p>
              )}

              {/* Section 1: Framework Starter Selection */}
              <section>
                <h3>{t.sectionTemplate}</h3>
                <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#64748b" }}>
                  {t.drawerSubtitle}
                </p>

                <div
                  className="provider-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "14px",
                  }}
                >
                  {FRAMEWORK_STARTERS.map((fw) => {
                    const isSelected = selectedFramework === fw.id;
                    return (
                      <article
                        key={fw.id}
                        className={`provider-card is-connected${isSelected ? " selected" : ""}`}
                        onClick={() => handleSelectFramework(fw)}
                        style={{
                          cursor: "pointer",
                          borderColor: isSelected ? "var(--npati-red, #e11d2e)" : "#f2b6bd",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          boxShadow: isSelected
                            ? "0 4px 14px rgba(225, 29, 46, 0.12)"
                            : undefined,
                          background: "#ffffff",
                          outline: "none",
                        }}
                      >
                        <div className="provider-card-main" style={{ cursor: "pointer" }}>
                          <span
                            className="provider-avatar"
                            aria-hidden="true"
                            style={{
                              width: "38px",
                              height: "38px",
                              borderRadius: "11px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                              background: fw.id === "html-css" ? "#fff5f2" : fw.id === "nextjs" ? "#000000" : fw.id === "vite" ? "#18181b" : "#0b0f19",
                              border: "1px solid rgba(0, 0, 0, 0.08)",
                              boxShadow: "0 2px 6px rgba(0, 0, 0, 0.06)",
                            }}
                          >
                            <FrameworkIcon id={fw.id} />
                          </span>
                          <span className="provider-title">
                            <strong>{fw.name}</strong>
                            <small>{language === "uk" ? fw.runtimeLabelUk : fw.runtimeLabel}</small>
                          </span>
                          <span
                            className={`connection-light ${isSelected ? "on" : ""}`}
                            aria-label={isSelected ? "Selected" : "Available"}
                            style={{ marginLeft: "auto", justifySelf: "end" }}
                          />
                        </div>
                        <div className="provider-badges" style={{ margin: "12px 0 8px" }}>
                          <span className="status-pill verified">
                            ✓ {language === "uk" ? "Перевірено" : "Verified"}
                          </span>
                        </div>
                        <div className="capability-row" style={{ marginTop: 0, gap: 6 }}>
                          {fw.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {/* Section 2: Domain, Port & SSL */}
              <section>
                <h3>{t.sectionDomain}</h3>
                <p style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#64748b" }}>
                  {t.domainDesc}
                </p>


                {/* 1. Domain */}
                <label>
                  <span>{t.domainLabel}</span>
                  <input
                    type="text"
                    placeholder="ai.npati.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                  <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                    {domain.trim()
                      ? `Target domain: https://${domain.trim().replace(/^https?:\/\//, "")}`
                      : `${t.technicalDomainNotice} (${(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mysite") + "-temp.preview.npati.com"})`}
                  </span>
                </label>

                {/* 2. Path */}
                <div style={{ marginTop: "12px" }}>
                  <label>
                    <span>{t.pathLabel}</span>
                    <input
                      type="text"
                      placeholder="/"
                      value={internalPath}
                      onChange={(e) => setInternalPath(e.target.value)}
                    />
                    <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                      {t.pathDesc}
                    </span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginTop: "8px" }}>
                    <input
                      type="checkbox"
                      checked={stripPath}
                      onChange={(e) => setStripPath(e.target.checked)}
                      style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                    />
                    <span style={{ fontSize: "12.5px", color: "#334155", fontWeight: 500 }}>
                      {t.stripPathLabel}
                    </span>
                  </label>
                </div>

                {/* 3. Port */}
                <div style={{ marginTop: "12px" }}>
                  <label>
                    <span>{t.portLabel}</span>
                    <input
                      type="number"
                      placeholder={framework.toLowerCase().includes("vite") ? "80" : "3000"}
                      value={containerPort}
                      onChange={(e) => setContainerPort(Number(e.target.value) || 0)}
                    />
                    <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                      {t.portDesc}
                    </span>
                  </label>
                </div>

                {/* 4. Custom Entrypoint */}
                <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={useCustomEntrypoint}
                      onChange={(e) => setUseCustomEntrypoint(e.target.checked)}
                      style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                    />
                    <span style={{ fontSize: "13px", color: "#0f172a", fontWeight: 600 }}>
                      {t.customEntrypointLabel}
                    </span>
                  </label>
                  <span style={{ fontSize: "11.5px", color: "#64748b", marginLeft: "24px" }}>
                    {t.customEntrypointDesc}
                  </span>

                  {useCustomEntrypoint && (
                    <input
                      type="text"
                      placeholder="web, websecure"
                      value={customEntrypoint}
                      onChange={(e) => setCustomEntrypoint(e.target.value)}
                      style={{ marginLeft: "24px", marginTop: "4px" }}
                    />
                  )}
                </div>

                {/* 5. SSL Certificate */}
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "14px",
                    background: "#f8fafc",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    marginTop: "14px",
                  }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={autoSsl}
                      onChange={(e) => setAutoSsl(e.target.checked)}
                      style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                    />
                    <span style={{ fontSize: "13px", color: "#0f172a", fontWeight: 700 }}>
                      {t.sslLabel}
                    </span>
                  </label>

                  {autoSsl && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        padding: "10px 12px",
                        background: "#ffffff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "6px",
                          background: "#ecfdf5",
                          color: "#059669",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          fontWeight: 700,
                          fontSize: "14px",
                        }}
                      >
                        🔒
                      </div>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                          {t.letsEncryptTitle}
                        </div>
                        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                          {t.letsEncryptDesc}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <footer style={{ justifyContent: "flex-end" }}>
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
              </footer>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}
