import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { writeProjectFile } from "./project-files-client";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  createDefaultWebsiteDocument,
  createMobileAppScaffold,
  createGameScaffold,
  projectKindOf,
  type ProjectKind,
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
  writeCachedCompanies,
} from "./active-company";

import {
  type WebsiteProject,
  apiFetch,
  getCachedWebsites,
  listProjectCompanies,
  listCompanyProjects,
} from "./website-builder-cache";
import {
  websiteBuilderCopy as copy,
  FRAMEWORK_STARTERS,
  type FrameworkStarterOption,
} from "./website-builder-constants";
import { CreateWebsiteDrawer } from "./website-builder-drawer";
import { WebsiteFiltersBar } from "./website-builder-filters";
import { WebsiteProjectCard, invalidateWebsitePreviewCache } from "./website-builder-card";

export function WebsiteBuilderDashboard() {
  const navigate = useNavigate();
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;

  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>(() => readCachedCompanies());
  const [companyId, setCompanyId] = useState(""); // Empty scope means all companies; always the initial view.
  const [creationCompanyId, setCreationCompanyId] = useState("");
  const loadSequence = useRef(0);
  const selectedCompany = useRef(companyId);
  selectedCompany.current = companyId;
  const [websites, setWebsites] = useState<WebsiteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("active");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");

  // Create Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFramework, setSelectedFramework] = useState<FrameworkStarterOption["id"]>("html-css");
  const [name, setName] = useState(FRAMEWORK_STARTERS[0]?.defaultName ?? "Modern HTML/CSS Website");
  const [description, setDescription] = useState(FRAMEWORK_STARTERS[0]?.defaultDesc ?? "Clean responsive website");
  const [framework, setFramework] = useState<string>("HTML/CSS");
  const [type, setType] = useState<"website" | "landing_page" | "web_app" | "mobile_app">("website");
  const [kind, setKind] = useState<ProjectKind>("website");
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
        }

        const list = await listProjectCompanies();
        if (!active) return;
        setCompanies(list);
        writeCachedCompanies(list);
        if (list.length === 0) {
          setWebsites([]);
          setLoading(false);
          return;
        }
        const resolved = chooseAvailableCompanyId(list, { requested: readActiveCompanyId() });
        setCreationCompanyId(list.some(company => company.id === resolved) ? resolved : list[0]!.id);
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
  const loadWebsites = useCallback(async (targetCompanyId?: string) => {
    const id = targetCompanyId ?? companyId;
    if (companies.length === 0) {
      return;
    }

    const sequence = ++loadSequence.current;
    try {
      // Every project belongs here: websites, web apps, games, mobile apps and APIs, whatever the framework.
      const nextProjects = await listCompanyProjects(id ? [id] : companies.map(company => company.id));
      if (sequence !== loadSequence.current || selectedCompany.current !== id) return;
      setWebsites(nextProjects);
      setError("");
    } catch (err: any) {
      if (sequence === loadSequence.current && selectedCompany.current === id) setError(err.message || t.loadError);
    } finally {
      if (sequence === loadSequence.current && selectedCompany.current === id) setLoading(false);
    }
  }, [companyId, companies, t.loadError]);

  useEffect(() => {
    if (companies.length > 0) {
      setWebsites(companyId ? getCachedWebsites(companyId) ?? [] : []);
      setLoading(true);
      void loadWebsites(companyId);
    }
    const refresh = () => { if (companies.length > 0 && document.visibilityState !== "hidden") void loadWebsites(companyId); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++loadSequence.current;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [companyId, loadWebsites]);

  // When framework selection changes in drawer, update suggested values.
  const handleSelectFramework = (fw: FrameworkStarterOption) => {
    setSelectedFramework(fw.id);
    setFramework(fw.frameworkKey);
    setContainerPort(fw.defaultPort);
    setName(language === "uk" ? fw.defaultNameUk : fw.defaultName);
    setDescription(language === "uk" ? fw.defaultDescUk : fw.defaultDesc);
    setType(fw.defaultType);
    setKind(fw.kind);
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
      if (kindFilter !== "all" && projectKindOf(site) !== kindFilter) return false;

      if (frameworkFilter !== "all") {
        const fw = (site.framework || "").toLowerCase();
        if (frameworkFilter === "static" && !fw.includes("static") && !fw.includes("html")) return false;
        if (frameworkFilter === "nextjs" && !fw.includes("next")) return false;
        if (frameworkFilter === "vite" && !fw.includes("vite")) return false;
        if (frameworkFilter === "astro" && !fw.includes("astro")) return false;
        if (frameworkFilter === "expo" && !fw.includes("expo")) return false;
      }
      return true;
    });
  }, [websites, searchQuery, statusFilter, frameworkFilter, kindFilter]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const companyId = creationCompanyId;
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
            kind,
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
        : kind === "game"
          ? createGameScaffold({ name: name.trim() }).files
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

      const promptText = kind === "game"
        ? (language === "uk" ? "Запусти цю гру в Live Preview і запропонуй, як її розвинути" : "Start this game in Live Preview and suggest how to develop it")
        : language === "uk"
          ? `Розгорни та налаштуй проєкт на базі ${framework}`
          : `Deploy and setup ${framework} project`;

      setModalOpen(false);
      navigate(
        `/settings/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(created.id)}`,
        { state: { prompt: promptText } }
      );
    } catch (err: any) {
      setError(err.message || "Failed to create project");
    } finally {
      setBusy(false);
    }
  };

  const handleRename = useCallback(async (site: WebsiteProject) => {
    const next = await promptModal({ message: t.renamePrompt, defaultValue: site.name });
    if (!next || !next.trim() || next.trim() === site.name) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(site.companyId)}/projects/${encodeURIComponent(site.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: next.trim(), expectedRevision: site.revision }),
        }
      );
      invalidateWebsitePreviewCache(site.companyId, site.id);
      await loadWebsites(companyId);
    } catch (err: any) {
      alert(err.message || "Failed to rename website");
    }
  }, [companyId, loadWebsites, t.renamePrompt]);

  const handleDuplicate = useCallback(async (site: WebsiteProject) => {
    try {
      setLoading(true);
      const res = await apiFetch<{ project: WebsiteProject }>(
        `/companies/${encodeURIComponent(site.companyId)}/projects/${encodeURIComponent(site.id)}/duplicate`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ name: `${site.name} (Copy)` }),
        }
      );
      await loadWebsites(companyId);
      if (res?.project?.id) {
        navigate(`/settings/projects/${encodeURIComponent(site.companyId)}/${encodeURIComponent(res.project.id)}`);
      }
    } catch (err: any) {
      alert(err.message || "Failed to duplicate website");
    } finally {
      setLoading(false);
    }
  }, [companyId, loadWebsites, navigate]);

  const handleArchive = useCallback(async (site: WebsiteProject) => {
    if (!(await confirmModal({ message: t.archivePrompt }))) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(site.companyId)}/projects/${encodeURIComponent(site.id)}/archive`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: site.revision }),
        }
      );
      invalidateWebsitePreviewCache(site.companyId, site.id);
      await loadWebsites(companyId);
    } catch (err: any) {
      alert(err.message || "Failed to archive website");
    }
  }, [companyId, loadWebsites, t.archivePrompt]);

  const handleDelete = useCallback(async (site: WebsiteProject) => {
    if (!(await confirmModal({ message: t.deletePrompt, isDanger: true }))) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(site.companyId)}/projects/${encodeURIComponent(site.id)}`,
        { method: "DELETE" }
      );
      invalidateWebsitePreviewCache(site.companyId, site.id);
      await loadWebsites(companyId);
    } catch (err: any) {
      alert(err.message || "Failed to delete website");
    }
  }, [companyId, loadWebsites, t.deletePrompt]);

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
            {companies.length > 0 && (
              <select
                aria-label={language === "uk" ? "Компанія" : "Company"}
                value={companyId}
                onChange={(e) => {
                  const nextCompanyId = e.target.value;
                  setCompanyId(nextCompanyId);
                  if (nextCompanyId) {
                    writeActiveCompanyId(nextCompanyId);
                    setCreationCompanyId(nextCompanyId);
                  }
                  const cached = nextCompanyId ? getCachedWebsites(nextCompanyId) : null;
                  setWebsites(cached ?? []);
                  setLoading(true);
                }}
                className="company-select"
                title={companyId ? companies.find(c => c.id === companyId)?.name : language === "uk" ? "Усі" : "All"}
                style={{
                  width: "130px", minWidth: "130px", maxWidth: "130px", flex: "0 0 130px",
                  boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
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
                <option value="">{language === "uk" ? "Усі" : "All"}</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id} title={c.name}>{Array.from(c.name).length > 16 ? Array.from(c.name).slice(0, 15).join("") + "…" : c.name}</option>
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
        kindFilter={kindFilter}
        setKindFilter={setKindFilter}
        language={language}
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
        <div className="website-studio-grid">
          {filteredWebsites.map((site) => (
            <WebsiteProjectCard
              key={site.id}
              site={site}
              companyId={site.companyId}
              language={language}
              t={t}
              handleDuplicate={handleDuplicate}
              handleRename={handleRename}
              handleDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <CreateWebsiteDrawer
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        t={t}
        language={language}
        companies={companies}
        companyId={creationCompanyId}
        setCompanyId={setCreationCompanyId}
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
