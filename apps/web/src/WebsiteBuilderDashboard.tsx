import { CompanyScopeSelect } from "./CompanyScopeSelect";
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
  createStackStarterScaffold,
  isStackStarterId,
  type ProjectKind,
  projectKindOf,
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
  listProjectCompanies,
} from "./website-builder-cache";
import {
  websiteBuilderCopy as copy,
  FRAMEWORK_STARTERS,
  frameworkStarterForProject,
  type FrameworkStarterOption,
} from "./website-builder-constants";
import { CreateWebsiteDrawer } from "./website-builder-drawer";
import { WebsiteFiltersBar } from "./website-builder-filters";
import { WebsiteProjectCard } from "./website-builder-card";
import { cachedCatalog, invalidateProjectCatalog, mergeCatalogRefresh, removeProjectFromCatalog, requestCatalog } from "./project-catalog-client";
import { CatalogScrollToTop } from "./CatalogScrollToTop";
import { apiGet, apiSend } from "./code-workspace-page-types";
import { productionEndpoint, useProjectProduction, type ProductionDraftLimits, type ProductionStatus } from "./code-workspace/project-production";
import { projectDomain, useProductionCapabilities } from "./website-builder-production";

export function WebsiteBuilderDashboard() {
  const navigate = useNavigate();
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;

  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>(() => readCachedCompanies());
  const [companiesReady, setCompaniesReady] = useState(false);
  const [companyId, setCompanyId] = useState(""); // Empty scope means all companies; always the initial view.
  const [creationCompanyId, setCreationCompanyId] = useState("");
  const [websites, setWebsites] = useState<WebsiteProject[]>(() => cachedCatalog({ companyId: "", search: "", status: "all", framework: "all", kind: "all" })?.projects ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("all");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSearch(searchQuery.trim()), 250); return () => clearTimeout(timer); }, [searchQuery]);
  const filters = useMemo(() => ({ companyId, search, status: statusFilter, framework: frameworkFilter, kind: kindFilter }), [companyId, search, statusFilter, frameworkFilter, kindFilter]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const loadedProjects = useRef(websites);
  loadedProjects.current = websites;
  const catalogGeneration = useRef(0);
  const lastCatalogFetchAt = useRef(0);
  const requests = useRef(new Set<ReturnType<typeof requestCatalog>>());
  const paginationTarget = useRef<HTMLDivElement>(null);
  const [scrollStarted, setScrollStarted] = useState(false);

  // Create Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<WebsiteProject | null>(null);
  const [selectedFramework, setSelectedFramework] = useState<FrameworkStarterOption["id"] | "">("html-css");
  const [name, setName] = useState(FRAMEWORK_STARTERS[0]?.defaultName ?? "Modern HTML/CSS Website");
  const [description, setDescription] = useState(FRAMEWORK_STARTERS[0]?.defaultDesc ?? "Clean responsive website");
  const [framework, setFramework] = useState<string>("HTML/CSS");
  const [type, setType] = useState<"website" | "landing_page" | "web_app" | "mobile_app">("website");
  const [kind, setKind] = useState<ProjectKind>("website");
  const [domain, setDomain] = useState("");
  const [alias, setAlias] = useState({ domain: "", redirect: true });
  const [internalPath, setInternalPath] = useState("/");
  const [stripPath, setStripPath] = useState(false);
  const [containerPort, setContainerPort] = useState(3000);
  const [useCustomEntrypoint, setUseCustomEntrypoint] = useState(false);
  const [customEntrypoint, setCustomEntrypoint] = useState("web, websecure");
  const [autoSsl, setAutoSsl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingDeployment, setLoadingDeployment] = useState(false);
  const [deploymentLoadError, setDeploymentLoadError] = useState("");
  const [editorProduction, setEditorProduction] = useState<ProductionStatus | null>(null);
  const draftRequest = useRef(0);
  const deploymentRevision = useRef<string | undefined>(undefined);
  const originalDomains = useRef<{ primary: string; alias: string; redirect: boolean } | null>(null);
  const [savedLimits, setSavedLimits] = useState<Partial<ProductionDraftLimits>>({});
  const [runtimeEnvironment, setRuntimeEnvironment] = useState("");
  const drawerCompanyId = editingProject?.companyId ?? creationCompanyId;
  const production = useProjectProduction(modalOpen ? editingProject?.companyId ?? "" : "", editingProject?.id ?? "", false, editorProduction);
  const { capabilities: createCapabilities, pending: createCapabilitiesPending } = useProductionCapabilities(
    modalOpen && !editingProject ? drawerCompanyId : "", draftRequest.current,
  );
  const loadingCreate = drawerCompanyId ? createCapabilitiesPending && !createCapabilities : !companiesReady;
  const editorStatus = production.status;
  const capabilities = editingProject ? (editorStatus?.enabled ? {
    enabled: true as const, defaults: editorStatus.defaults, tlsEnabled: editorStatus.tlsEnabled,
    automaticDomain: Boolean(editorStatus.automaticDomain),
    automaticDomainIsLocal: editorStatus.automaticDomain.endsWith(".localhost"),
  } : null) : type === "mobile_app" ? null : createCapabilities;
  const release = production.status?.enabled ? production.status.release : null;
  const productionEnabled = capabilities?.enabled === true && (!editingProject || production.status?.enabled === true);
  const limits = capabilities?.enabled ? { ...capabilities.defaults, ...release?.settings.limits, ...savedLimits } : undefined;
  const automaticDomain = production.status?.enabled ? production.status.automaticDomain : undefined;
  const targetDomain = projectDomain(domain) || automaticDomain;
  const localDomain = targetDomain ? targetDomain.endsWith(".localhost") : capabilities?.enabled && capabilities.automaticDomainIsLocal;
  const canUseSsl = !capabilities?.enabled || (capabilities.tlsEnabled && !localDomain && !(useCustomEntrypoint && customEntrypoint.trim() === "web"));

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
        if (list.length === 0) return;
        const resolved = chooseAvailableCompanyId(list, { requested: readActiveCompanyId() });
        const defaultCompany = list.some(company => company.id === resolved) ? resolved : list[0]!.id;
        setCreationCompanyId(current => list.some(company => company.id === current) ? current : defaultCompany);
      } catch (err: any) {
        if (active) {
          setError(err.message || t.loadError);
          setLoading(false);
        }
      } finally {
        if (active) setCompaniesReady(true);
      }
    }
    void loadCompanies();
    return () => {
      active = false;
    };
  }, []);

  const loadWebsites = useCallback(async (_companyId?: string, cursor?: string, background = false) => {
    if (cursor && requests.current.size) return;
    if (!cursor) {
      ++catalogGeneration.current;
      for (const request of requests.current) request.release();
      requests.current.clear();
    }
    const generation = catalogGeneration.current;
    lastCatalogFetchAt.current = Date.now();
    const keepCursor = background && loadedProjects.current.length > 6;
    const request = requestCatalog(filters, cursor, background);
    requests.current.add(request);
    setLoading(true);
    try {
      const page = await request.promise;
      if (generation !== catalogGeneration.current) return;
      setWebsites(previous => cursor ? [...new Map([...previous, ...page.projects].map(item => [item.id, item])).values()] : background ? mergeCatalogRefresh(previous, page) : page.projects);
      if (!keepCursor || !page.pagination?.nextCursor) setNextCursor(page.pagination?.nextCursor ?? null);
      setError("");
    } catch (err: any) {
      if (generation === catalogGeneration.current && err.name !== "AbortError") setError(err.message || t.loadError);
    } finally {
      requests.current.delete(request); request.release();
      if (generation === catalogGeneration.current) setLoading(false);
    }
  }, [filters, t.loadError]);

  useEffect(() => {
    const cached = cachedCatalog(filters);
    setScrollStarted(false);
    setWebsites(cached?.projects ?? []);
    setNextCursor(cached?.pagination?.nextCursor ?? null);
    void loadWebsites();
    const refresh = () => { if (document.visibilityState !== "hidden" && requests.current.size === 0 && Date.now() - lastCatalogFetchAt.current > 3000) void loadWebsites(undefined, undefined, true); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++catalogGeneration.current;
      for (const request of requests.current) request.release();
      requests.current.clear();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [filters, loadWebsites]);

  useEffect(() => {
    const onScrollIntent = () => setScrollStarted(true);
    const onKey = (event: KeyboardEvent) => { if (["PageDown", "End", "ArrowDown", " "].includes(event.key)) onScrollIntent(); };
    const onScroll = (event: Event) => {
      const target = event.target;
      if ((target instanceof HTMLElement && target.scrollTop > 0) || (document.scrollingElement?.scrollTop ?? 0) > 0) setScrollStarted(true);
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onScrollIntent, { passive: true });
    document.addEventListener("touchmove", onScrollIntent, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onScrollIntent);
      document.removeEventListener("touchmove", onScrollIntent);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (websites.length === 0 && nextCursor && !loading && !error) void loadWebsites(undefined, nextCursor);
  }, [websites.length, nextCursor, loading, error, loadWebsites]);

  useEffect(() => {
    if (!nextCursor || loading || error || !scrollStarted) return;
    const request = requestCatalog(filters, nextCursor);
    void request.promise.catch(() => {}).finally(() => request.release());
    return () => request.release();
  }, [filters, nextCursor, loading, error, scrollStarted]);

  useEffect(() => {
    if (!nextCursor || loading || error || !scrollStarted || !globalThis.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        void loadWebsites(undefined, nextCursor);
      }
    }, { rootMargin: "0px 0px 600px 0px" });
    if (paginationTarget.current) observer.observe(paginationTarget.current);
    return () => observer.disconnect();
  }, [nextCursor, loading, error, scrollStarted, loadWebsites]);

  // When framework selection changes in drawer, update suggested values.
  const handleSelectFramework = (fw: FrameworkStarterOption) => {
    if (editingProject) return;
    setSelectedFramework(fw.id);
    setFramework(fw.frameworkKey);
    setContainerPort(fw.defaultPort);
    setName(language === "uk" ? fw.defaultNameUk : fw.defaultName);
    setDescription(language === "uk" ? fw.defaultDescUk : fw.defaultDesc);
    setType(fw.defaultType);
    setKind(fw.kind);
  };

  const filteredWebsites = websites;

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const companyId = drawerCompanyId;
    const publish = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "publish";
    if (!name.trim() || !companyId || busy || loadingDeployment || createCapabilitiesPending || (publish && (!productionEnabled || production.running))) return;
    setBusy(true);
    setError("");
    let createdForPublication: WebsiteProject | null = null;
    try {
      // Determine domain: use custom domain if provided, otherwise generate temporary technical preview domain
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
      const userDomainTrimmed = projectDomain(domain);
      const randomSuffix = Math.random().toString(36).substring(2, 6);
      const technicalDomain = `${slug}-${randomSuffix}.preview.npati.com`;
      const finalDomain = userDomainTrimmed || technicalDomain;
      const isTechnical = !userDomainTrimmed;
      const aliasDomain = projectDomain(alias.domain);

      const domainConfig: WebsiteDomainConfig = {
        domain: finalDomain,
        isTechnicalDomain: isTechnical,
        path: internalPath.trim() || "/",
        stripPath,
        port: containerPort,
        customEntrypoint: useCustomEntrypoint,
        entrypoints: useCustomEntrypoint
          ? customEntrypoint.split(",").map((s) => s.trim()).filter(Boolean)
          : ["web", "websecure"],
        sslCertificate: autoSsl && canUseSsl,
        certificateProvider: autoSsl && canUseSsl ? "letsencrypt" : "none",
      };
      const entrypoints = [...new Set(domainConfig.entrypoints)].sort().join(",");
      const entrypoint = !useCustomEntrypoint || entrypoints === "web,websecure" ? "auto" : entrypoints;
      let environment: unknown;
      if (publish && runtimeEnvironment.trim()) {
        try { environment = JSON.parse(runtimeEnvironment); }
        catch { throw new Error(language === "uk" ? "Введіть змінні середовища як об’єкт JSON." : "Enter runtime environment variables as a JSON object."); }
      }
      const settings = {
        domain: userDomainTrimmed, aliasDomain, redirectAlias: alias.redirect,
        path: domainConfig.path ?? "/", stripPath, port: domainConfig.port,
        entrypoint, tls: domainConfig.sslCertificate, limits,
        environment,
      };
      const deploymentConfigData = JSON.stringify({
        domain: finalDomain, isTechnicalDomain: isTechnical, path: domainConfig.path, stripPath,
        port: domainConfig.port, entrypoints: domainConfig.entrypoints, customEntrypoint: useCustomEntrypoint,
        ssl: domainConfig.sslCertificate ? "Let's Encrypt" : "Disabled",
        ...(productionEnabled ? { productionLimits: limits, aliasDomain, redirectAlias: alias.redirect } : {}),
      }, null, 2);
      const publishProject = (project: WebsiteProject) => apiSend<ProductionStatus>("POST",
        productionEndpoint(project.companyId, project.id), settings);

      if (editingProject) {
        const original = originalDomains.current;
        const primaryChanged = !publish && productionEnabled && release && original &&
          userDomainTrimmed !== original.primary && (userDomainTrimmed || automaticDomain) !== release.settings.domain;
        const aliasChanged = !publish && productionEnabled && release && original &&
          (aliasDomain !== original.alias || alias.redirect !== original.redirect) &&
          (aliasDomain !== (release.settings.aliasDomain ?? "") ||
            Boolean(aliasDomain) && alias.redirect !== (release.settings.redirectAlias !== false));
        if ((primaryChanged || aliasChanged) && (production.running || production.busy)) {
          throw new Error(language === "uk" ? "Дочекайтеся завершення поточної операції продакшену." : "Wait for the current Production operation to finish.");
        }
        const stored = await writeProjectFile(
          { companyId: editingProject.companyId, projectId: editingProject.id },
          "deployment.json",
          deploymentConfigData,
          deploymentRevision.current,
        );
        deploymentRevision.current = stored.revision;

        const updated = productionEnabled && name.trim() === editingProject.name
          ? editingProject : await apiFetch<WebsiteProject>(
          `/companies/${encodeURIComponent(editingProject.companyId)}/projects/${encodeURIComponent(editingProject.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: name.trim() || editingProject.name,
              expectedRevision: editingProject.revision,
              ...(!productionEnabled ? { deploymentUrl: `https://${finalDomain}`, deploymentStatus: "deployed", previewUrl: `https://${finalDomain}`, previewPort: domainConfig.port } : {}),
            }),
          }
        );

        setEditingProject(updated);
        if (publish) {
          if (!(await production.publish(settings))) return;
          setRuntimeEnvironment("");
          return;
        }
        if ((primaryChanged || aliasChanged) && !(await production.control({
          action: "domains",
          ...(primaryChanged ? { domain: userDomainTrimmed, tls: settings.tls, entrypoint } : {}),
          ...(aliasChanged ? { aliasDomain, redirectAlias: alias.redirect } : {}),
        }, setError))) return;
        if (!productionEnabled) void apiFetch(
          `/companies/${encodeURIComponent(editingProject.companyId)}/projects/${encodeURIComponent(editingProject.id)}/preview/start`,
          {
            method: "POST",
            body: JSON.stringify({ port: domainConfig.port }),
          }
        ).catch(() => {});

        invalidateProjectCatalog();
        await loadWebsites(companyId);
        setModalOpen(false);
        setEditingProject(null);
        return;
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
            ...(!productionEnabled ? { deploymentUrl: `https://${finalDomain}`, previewUrl: `https://${finalDomain}` } : {}),
            previewPort: domainConfig.port,
          }),
        }
      );
      if (publish) createdForPublication = created;

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

      const serverScaffold = ["nuxt", "sveltekit", "angular", "nestjs", "fastapi"].includes(selectedFramework);
      const files: Record<string, string> = serverScaffold
        ? (await apiFetch<{ files: Record<string, string> }>(
            `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(created.id)}/framework-scaffold`,
            { method: "POST", body: JSON.stringify({ framework, name: name.trim() }) },
          )).files
        : isStackStarterId(selectedFramework)
        ? createStackStarterScaffold(selectedFramework, { name: name.trim() }).files
        : isMobileApp
        ? createMobileAppScaffold({ name: name.trim(), slug: slugifyProjectName(name.trim()), scheme: defaultAppScheme(name.trim()) }).files
        : kind === "game"
          ? createGameScaffold({ name: name.trim() }).files
          : getWebsiteAdapter(doc.framework).scaffoldProject(doc);

      // Save domain and deployment configuration file in project files
      if (!isMobileApp) {
        files["deployment.json"] = deploymentConfigData;
      }

      // Write initial scaffold files into the workspace
      for (const [filePath, content] of Object.entries(files)) {
        try {
          // Shared adapter (C7): the scaffold write goes through the same client module as the file browser.
          const stored = await writeProjectFile({ companyId, projectId: created.id }, filePath, content);
          if (filePath === "deployment.json") deploymentRevision.current = stored.revision;
        } catch (error) {
          if (publish) throw error;
          // ignore individual write fail
        }
      }

      if (publish) {
        await publishProject(created);
        setRuntimeEnvironment("");
        return;
      }

      // Automatically start framework dev / preview runtime
      void apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(created.id)}/preview/start`,
        {
          method: "POST",
          body: JSON.stringify({ port: domainConfig.port, ...(serverScaffold ? { build: true } : {}) }),
        }
      ).then(() => apiFetch(
        `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(created.id)}/qa/thumbnail`,
        { method: "POST", body: "{}" },
      )).catch(() => {});

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
      if (createdForPublication) {
        setEditingProject(createdForPublication);
        invalidateProjectCatalog();
        void loadWebsites(companyId);
      }
      setBusy(false);
    }
  };

  const handleRename = useCallback((site: WebsiteProject) => {
    const requestId = ++draftRequest.current;
    setLoadingDeployment(true);
    setDeploymentLoadError("");
    setEditorProduction(null);
    deploymentRevision.current = undefined;
    originalDomains.current = null;
    setSavedLimits({});
    setRuntimeEnvironment("");
    setEditingProject(site);
    setCreationCompanyId(site.companyId);
    setName(site.name);
    setDescription(site.description ?? "");
    const starter = frameworkStarterForProject(site);
    setSelectedFramework(starter?.id ?? "");
    setFramework(site.framework || starter?.frameworkKey || "");
    const resolvedType = (site.type === "code_project" ? "web_app" : site.type) || starter?.defaultType || "website";
    setType(resolvedType);
    setKind(projectKindOf(site));
    const rawDomain = (site.deploymentUrl || site.previewUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
    const isTechnical = !rawDomain || rawDomain.endsWith(".preview.npati.com");
    setDomain(isTechnical ? "" : rawDomain);
    setAlias({ domain: "", redirect: true });
    setInternalPath("/");
    setStripPath(false);
    setContainerPort(site.previewPort || starter?.defaultPort || 3000);
    setUseCustomEntrypoint(false);
    setCustomEntrypoint("web, websecure");
    setAutoSsl(true);
    setError("");
    setModalOpen(true);
    void apiGet<{ deployment: { content: string; revision?: string } | null; production: ProductionStatus }>(
      `${productionEndpoint(site.companyId, site.id)}?editor=1`,
    ).then(({ deployment: file, production: published }) => {
      if (requestId !== draftRequest.current) return;
      setEditorProduction(published);
      deploymentRevision.current = file?.revision;
      const active = published?.enabled ? published.release?.settings : undefined;
      if (active) {
        const primary = published?.enabled && active.domain === published.automaticDomain ? "" : active.domain;
        const savedAlias = { domain: active.aliasDomain ?? "", redirect: active.redirectAlias !== false };
        originalDomains.current = { primary, alias: savedAlias.domain, redirect: savedAlias.redirect };
        setDomain(primary);
        setAlias(savedAlias);
      }
      try {
        const parsed = file?.content ? JSON.parse(file.content) : {};
        if (!active) {
          if (parsed.domain && !parsed.isTechnicalDomain) setDomain(parsed.domain);
          if (typeof parsed.aliasDomain === "string") setAlias({ domain: parsed.aliasDomain, redirect: parsed.redirectAlias !== false });
        }
        if (active && !parsed.productionLimits) {
          setInternalPath(active.path);
          setStripPath(active.stripPath);
          setContainerPort(active.port);
          setUseCustomEntrypoint(active.entrypoint !== "auto");
          setCustomEntrypoint(active.entrypoint === "auto" ? "web, websecure" : active.entrypoint);
          setAutoSsl(active.tls);
          return;
        }
        if (parsed.path) setInternalPath(parsed.path);
        if (typeof parsed.stripPath === "boolean") setStripPath(parsed.stripPath);
        if (parsed.port) setContainerPort(Number(parsed.port));
        if (Array.isArray(parsed.entrypoints) && parsed.entrypoints.length > 0) {
          setCustomEntrypoint(parsed.entrypoints.join(", "));
          setUseCustomEntrypoint(parsed.customEntrypoint ?? parsed.entrypoints.join(",") !== "web,websecure");
        }
        if (parsed.ssl) setAutoSsl(parsed.ssl !== "Disabled");
        if (parsed.productionLimits && typeof parsed.productionLimits === "object") setSavedLimits(parsed.productionLimits);
      } catch {}
    }).catch(error => {
      if (requestId === draftRequest.current) setDeploymentLoadError(error.message);
    }).finally(() => { if (requestId === draftRequest.current) setLoadingDeployment(false); });
  }, []);

  const handleOpenCreateModal = useCallback(() => {
    draftRequest.current++;
    setLoadingDeployment(false);
    setDeploymentLoadError("");
    setEditorProduction(null);
    deploymentRevision.current = undefined;
    setSavedLimits({});
    setRuntimeEnvironment("");
    setEditingProject(null);
    setCreationCompanyId(current => {
      if (companies.some(company => company.id === current)) return current;
      const preferred = chooseAvailableCompanyId(companies, { requested: readActiveCompanyId() });
      return companies.some(company => company.id === preferred) ? preferred : companies[0]?.id ?? "";
    });
    setError("");
    const initial = FRAMEWORK_STARTERS[0]!;
    setSelectedFramework(initial.id);
    setName(language === "uk" ? initial.defaultNameUk : initial.defaultName);
    setDescription(language === "uk" ? initial.defaultDescUk : initial.defaultDesc);
    setFramework(initial.frameworkKey);
    setType(initial.defaultType);
    setKind(initial.kind);
    setDomain("");
    setAlias({ domain: "", redirect: true });
    setInternalPath("/");
    setStripPath(false);
    setContainerPort(initial.defaultPort);
    setUseCustomEntrypoint(false);
    setCustomEntrypoint("web, websecure");
    setAutoSsl(true);
    setModalOpen(true);
  }, [companies, language]);

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
      await loadWebsites(companyId);
    } catch (err: any) {
      alert(err.message || "Failed to archive website");
    }
  }, [companyId, loadWebsites, t.archivePrompt]);

  const handleDelete = useCallback(async (site: WebsiteProject) => {
    const owner = getStoredAuthToken();
    // The dialog names the project, so the user confirms this one and not "this project" in general.
    if (!(await confirmModal({ title: site.name, message: t.deletePrompt, isDanger: true })) || owner !== getStoredAuthToken()) return;
    try {
      await apiFetch(
        `/companies/${encodeURIComponent(site.companyId)}/projects/${encodeURIComponent(site.id)}`,
        { method: "DELETE" }
      );
      if (owner !== getStoredAuthToken()) return;
      removeProjectFromCatalog(site.id);
      setWebsites(previous => previous.filter(project => project.id !== site.id));
    } catch (err: any) {
      alert(err.message || "Failed to delete website");
    }
  }, [t.deletePrompt]);

  return (
    <main className="company-refined company-page">
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
              <CompanyScopeSelect
                aria-label={language === "uk" ? "Компанія" : "Company"}
                value={companyId}
                onValueChange={(value) => {
                  const nextCompanyId = value;
                  setCompanyId(nextCompanyId);
                  if (nextCompanyId) {
                    writeActiveCompanyId(nextCompanyId);
                    setCreationCompanyId(nextCompanyId);
                  }
                }}
                className="company-select"
                title={companyId ? companies.find(c => c.id === companyId)?.name : language === "uk" ? "Усі" : "All"}
              >
                <option value="">{language === "uk" ? "Усі компанії" : "All companies"}</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id} title={c.name}>{c.name}</option>
                ))}
              </CompanyScopeSelect>
            )}

            <button
              type="button"
              className="button-primary"
              onClick={handleOpenCreateModal}
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
      {loading && websites.length === 0 ? null : websites.length === 0 && !search && statusFilter === "all" && frameworkFilter === "all" && kindFilter === "all" ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🌐</div>
          <h3>{t.emptyTitle}</h3>
          <p>{t.emptySubtitle}</p>
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={handleOpenCreateModal}
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
            onClick={() => { setSearchQuery(""); setStatusFilter("all"); setFrameworkFilter("all"); setKindFilter("all"); }}
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
              drawerProductionStatus={modalOpen && editingProject?.id === site.id ? production.status : undefined}
              handleDuplicate={handleDuplicate}
              handleRename={handleRename}
              handleDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {nextCursor && <div ref={paginationTarget} className="website-catalog-pagination" aria-hidden="true" style={{ height: 1, margin: 0 }} />}
      <CatalogScrollToTop anchorSelector=".website-studio-grid > :nth-child(9)" items={websites} />

      <CreateWebsiteDrawer
        isOpen={modalOpen}
        onClose={() => { if (!busy && !production.busy) { draftRequest.current++; setModalOpen(false); setEditingProject(null); } }}
        t={t}
        language={language}
        companies={companies}
        companyId={drawerCompanyId}
        setCompanyId={setCreationCompanyId}
        handleCreate={handleCreate}
        error={error}
        selectedFramework={selectedFramework}
        savedFramework={editingProject?.framework}
        handleSelectFramework={handleSelectFramework}
        domain={domain}
        setDomain={setDomain}
        name={name}
        internalPath={internalPath}
        setInternalPath={setInternalPath}
        stripPath={stripPath}
        setStripPath={setStripPath}
        defaultPort={(FRAMEWORK_STARTERS.find(starter => starter.id === selectedFramework) ?? FRAMEWORK_STARTERS[0]!).defaultPort}
        containerPort={containerPort}
        setContainerPort={setContainerPort}
        useCustomEntrypoint={useCustomEntrypoint}
        setUseCustomEntrypoint={setUseCustomEntrypoint}
        customEntrypoint={customEntrypoint}
        setCustomEntrypoint={setCustomEntrypoint}
        autoSsl={autoSsl}
        setAutoSsl={setAutoSsl}
        busy={busy}
        loading={editingProject ? loadingDeployment : loadingCreate}
        submitPending={createCapabilitiesPending}
        loadError={editingProject ? deploymentLoadError : ""}
        editing={Boolean(editingProject)}
        production={productionEnabled && limits ? {
          limits, setLimit: (key, value) => setSavedLimits(previous => ({ ...previous, [key]: value })),
          controller: production, automaticDomain, canUseSsl, localDomain: Boolean(localDomain), runtimeEnvironment, setRuntimeEnvironment,
          canAssignDomain: capabilities.automaticDomain, tlsEnabled: capabilities.tlsEnabled,
          projectId: editingProject?.id,
          editorProofs: editorProduction?.enabled ? editorProduction.proofs ?? {} : undefined,
          alias, setAlias,
        } : undefined}
      />
    </main>
  );
}
