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

import {
  type WebsiteProject,
  apiFetch,
  getCachedWebsites,
  updateCachedWebsites,
} from "./website-builder-cache";
import {
  websiteBuilderCopy as copy,
  FRAMEWORK_STARTERS,
  type FrameworkStarterOption,
} from "./website-builder-constants";
import { CreateWebsiteDrawer } from "./website-builder-drawer";
import { WebsiteFiltersBar } from "./website-builder-filters";

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

      <WebsiteFiltersBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        frameworkFilter={frameworkFilter}
        setFrameworkFilter={setFrameworkFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        t={t}
      />

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

      <CreateWebsiteDrawer
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        t={t}
        language={language}
        handleCreate={handleCreate}
        error={error}
        selectedFramework={selectedFramework}
        handleSelectFramework={handleSelectFramework}
        domain={domain}
        setDomain={setDomain}
        name={name}
        internalPath={internalPath}
        setInternalPath={setInternalPath}
        stripPath={stripPath}
        setStripPath={setStripPath}
        framework={framework}
        containerPort={containerPort}
        setContainerPort={setContainerPort}
        useCustomEntrypoint={useCustomEntrypoint}
        setUseCustomEntrypoint={setUseCustomEntrypoint}
        customEntrypoint={customEntrypoint}
        setCustomEntrypoint={setCustomEntrypoint}
        autoSsl={autoSsl}
        setAutoSsl={setAutoSsl}
        busy={busy}
      />
    </main>
  );
}
