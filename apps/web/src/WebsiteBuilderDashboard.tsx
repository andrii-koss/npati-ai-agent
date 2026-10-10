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

interface TemplateOption {
  id: "hosting" | "saas" | "ecommerce" | "portfolio" | "landing" | "blank";
  icon: string;
  title: string;
  titleUk: string;
  desc: string;
  descUk: string;
  badge: string;
  pagesCount: number;
  blocks: string[];
  defaultName: string;
  defaultDesc: string;
}

const TEMPLATES: TemplateOption[] = [
  {
    id: "hosting",
    icon: "⚡",
    title: "Cloud & Web Hosting",
    titleUk: "Хмарний хостинг та домени",
    desc: "Complete 5-page setup with domain search, NVMe specs, server tiers, and FAQ.",
    descUk: "Готовий сайт на 5 сторінок з пошуком доменів, характеристиками NVMe, тарифами та FAQ.",
    badge: "Recommended",
    pagesCount: 5,
    blocks: ["Navbar", "Hero", "Features", "Pricing", "FAQ", "CTA", "Contact", "Footer"],
    defaultName: "CloudScale Hosting",
    defaultDesc: "Modern cloud hosting company with domain registration, VPS tiers, and 24/7 support.",
  },
  {
    id: "saas",
    icon: "🚀",
    title: "SaaS & AI Platform",
    titleUk: "SaaS та AI Платформа",
    desc: "High-impact tech startup landing with live metrics, feature grid, and pricing cards.",
    descUk: "Ефективний лендінг для технологічного стартапу з метриками, блоками фіч та тарифами.",
    badge: "Popular",
    pagesCount: 3,
    blocks: ["Navbar", "Hero", "Features", "Stats", "Pricing", "Testimonials", "CTA", "Footer"],
    defaultName: "Cognitive AI Studio",
    defaultDesc: "Autonomous AI agents and intelligent workflows for modern engineering teams.",
  },
  {
    id: "ecommerce",
    icon: "🛍️",
    title: "E-Commerce & Store",
    titleUk: "Інтернет-магазин",
    desc: "Showcase physical or digital products with featured grid, reviews, and promo banners.",
    descUk: "Вітрина товарів чи цифрових послуг із сіткою товарів, відгуками та промо-блоками.",
    badge: "Store",
    pagesCount: 3,
    blocks: ["Navbar", "Hero", "Gallery", "Features", "Testimonials", "CTA", "Footer"],
    defaultName: "Nordic Minimal Goods",
    defaultDesc: "Curated collection of premium everyday essentials and sustainable accessories.",
  },
  {
    id: "portfolio",
    icon: "💼",
    title: "Agency & Portfolio",
    titleUk: "Агенція та портфоліо",
    desc: "Modern creative showcase with case studies gallery, team members, and contact form.",
    descUk: "Сучасна презентація робіт із галереєю кейсів, командою та формою зв'язку.",
    badge: "Creative",
    pagesCount: 4,
    blocks: ["Navbar", "Hero", "Gallery", "Team", "Testimonials", "Contact", "Footer"],
    defaultName: "Apex Design Agency",
    defaultDesc: "Award-winning digital experience design and full-stack software development.",
  },
  {
    id: "landing",
    icon: "📄",
    title: "High-Converting Landing",
    titleUk: "Конверсійний лендінг",
    desc: "Focused single-page site optimized for lead generation, waiting lists, or event launch.",
    descUk: "Фокусована сторінка, оптимізована під збір лідів, список очікування або презентацію продукту.",
    badge: "Single Page",
    pagesCount: 1,
    blocks: ["Navbar", "Hero", "Features", "Pricing", "CTA", "Footer"],
    defaultName: "Product Launch Pro",
    defaultDesc: "Transform your daily productivity with our next-generation browser extension.",
  },
  {
    id: "blank",
    icon: "✏️",
    title: "Clean Blank Canvas",
    titleUk: "Чистий аркуш",
    desc: "Minimal starter with Navbar, Hero and Footer. Build your layout block by block.",
    descUk: "Мінімальний старт з меню, hero та футером. Додавайте власні блоки один за одним.",
    badge: "Custom",
    pagesCount: 1,
    blocks: ["Navbar", "Hero", "Footer"],
    defaultName: "My Custom Website",
    defaultDesc: "Custom website edited with NPATI Coding Agent in chat.",
  },
];

const copy = {
  en: {
    eyebrow: "Website Studio",
    title: "Websites",
    subtitle: "Create and edit websites with Coding Agent in chat and view changes in Live Preview.",
    newWebsite: "Create Website",
    searchPlaceholder: "Search websites by name or purpose...",
    filterAll: "All Frameworks",
    filterStatusAll: "All Statuses",
    statusActive: "Active Only",
    statusArchived: "Archived Only",
    emptyTitle: "No websites created yet",
    emptySubtitle: "Create your first website with our pre-built Next.js block templates or ask the AI agent in Chat.",
    createNow: "Create Your First Website",
    openBuilder: "Edit in chat",
    preview: "Live Preview",
    duplicate: "Duplicate",
    rename: "Rename",
    archive: "Archive",
    delete: "Delete",
    restore: "Restore",
    loadError: "Failed to load website projects",
    renamePrompt: "Enter new website name:",
    archivePrompt: "Archive this website? It will remain accessible under archived filter.",
    deletePrompt: "Permanently delete this website project and all its files? This action cannot be undone.",
    drawerKicker: "WEBSITE STARTER",
    drawerTitle: "Create New Website",
    drawerSubtitle: "Select a starter block template and customize your project details.",
    sectionTemplate: "1. Choose Starter Blocks & Template",
    sectionDetails: "2. Website Details",
    sectionDomain: "3. Domain & SSL / Network",
    domainTitle: "Domain",
    domainDesc: "In this section you can edit a domain",
    domainWarning: "Whenever you make changes to domains, remember to redeploy your compose to apply the changes.",
    domainLabel: "Domain",
    domainPlaceholder: "ai.npati.com",
    technicalDomainNotice: "If no domain is entered, a temporary technical domain will be assigned automatically",
    pathLabel: "Path",
    pathDesc: 'The path where your application expects to receive requests internally (defaults to "/")',
    stripPathLabel: "Remove the external path from the request before forwarding to the application",
    portLabel: "Port",
    portDesc: "The port where your application is running inside the container (e.g., 3000 for Node.js, 80 for Nginx, 8080 for Java)",
    customEntrypointLabel: "Use custom entrypoint for domain",
    customEntrypointDesc: '"web" and/or "websecure" is used by default.',
    sslLabel: "Automatically provision SSL Certificate.",
    letsEncryptTitle: "Let's Encrypt",
    letsEncryptDesc: "Let's Encrypt auto-provisions a certificate automatically for this host.",
    nameLabel: "Website Name",
    descLabel: "Purpose & Description",
    frameworkLabel: "Framework",
    typeLabel: "Project Type",
    typeWebsite: "Multi-page Website",
    typeLanding: "Single-page Landing",
    typeWebApp: "Web Application",
    typeMobileApp: "Mobile app (Expo / React Native)",
    cancel: "Cancel",
    createBtn: "Create Website & Edit in chat →",
    creating: "Creating Project & Files...",
    pages: "pages",
    updated: "Updated",
    liveStatus: "Live Preview",
    readyStatus: "Ready",
    buildingStatus: "Building...",
  },
  uk: {
    eyebrow: "Студія сайтів",
    title: "Сайти",
    subtitle: "Створюйте й редагуйте сайти через Coding Agent у чаті та переглядайте зміни в Live Preview.",
    newWebsite: "Створити сайт",
    searchPlaceholder: "Пошук сайтів за назвою чи описом...",
    filterAll: "Усі фреймворки",
    filterStatusAll: "Усі статуси",
    statusActive: "Тільки активні",
    statusArchived: "Тільки архівні",
    emptyTitle: "Сайтів ще не створено",
    emptySubtitle: "Створіть свій перший сайт із готових блоків Next.js або попросіть AI агента у Chat командою «Створи сайт».",
    createNow: "Створити перший сайт",
    openBuilder: "Редагувати в чаті",
    preview: "Live Preview",
    duplicate: "Дублювати",
    rename: "Перейменувати",
    archive: "Архівувати",
    delete: "Видалити",
    restore: "Відновити",
    loadError: "Не вдалося завантажити проєкти сайтів",
    renamePrompt: "Введіть нову назву сайту:",
    archivePrompt: "Архівувати цей сайт? Його можна буде переглянути через фільтр архівних.",
    deletePrompt: "Назавжди видалити цей сайт і всі його файли? Цю дію неможливо скасувати.",
    drawerKicker: "СТАРТОВИЙ САЙТ",
    drawerTitle: "Створити новий сайт",
    drawerSubtitle: "Оберіть структуру блоків та вкажіть назву сайту.",
    sectionTemplate: "1. Оберіть структуру блоків та шаблон",
    sectionDetails: "2. Налаштування проєкту",
    sectionDomain: "3. Домен, порт та SSL-сертифікат",
    domainTitle: "Домен",
    domainDesc: "У цьому розділі ви можете налаштувати прив'язку домену",
    domainWarning: "Кожного разу при зміні доменів не забудьте перерозгорнути compose, щоб застосувати зміни.",
    domainLabel: "Домен",
    domainPlaceholder: "ai.npati.com",
    technicalDomainNotice: "Якщо домен не вказано, автоматично буде створено технічний домен",
    pathLabel: "Шлях (Path)",
    pathDesc: 'Шлях, за яким застосунок очікує отримувати внутрішні запити (за замовчуванням "/")',
    stripPathLabel: "Видалити зовнішній шлях із запиту перед перенаправленням до застосунку",
    portLabel: "Порт (Port)",
    portDesc: "Порт, на якому працює застосунок усередині контейнера (наприклад, 3000 для Node.js, 80 для Nginx, 8080 для Java)",
    customEntrypointLabel: "Використовувати власну точку входу для домену",
    customEntrypointDesc: 'За замовчуванням використовуються "web" та/або "websecure".',
    sslLabel: "Автоматично згенерувати SSL-сертифікат.",
    letsEncryptTitle: "Let's Encrypt",
    letsEncryptDesc: "Let's Encrypt автоматично генерує та оновлює сертифікат для цього хоста.",
    nameLabel: "Назва сайту",
    descLabel: "Призначення та опис",
    frameworkLabel: "Фреймворк",
    typeLabel: "Тип проєкту",
    typeWebsite: "Багатосторінковий сайт",
    typeLanding: "Односторінковий лендінг",
    typeWebApp: "Вебзастосунок",
    typeMobileApp: "Мобільний застосунок (Expo / React Native)",
    cancel: "Скасувати",
    createBtn: "Створити сайт і редагувати в чаті →",
    creating: "Створення проєкту та файлів...",
    pages: "стор.",
    updated: "Оновлено",
    liveStatus: "Live Preview",
    readyStatus: "Готовий",
    buildingStatus: "Збірка...",
  },
};

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

export function WebsiteBuilderDashboard() {
  const navigate = useNavigate();
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;
  const projectTypeLabel = (value: WebsiteProject["type"]) =>
    value === "landing_page" ? t.typeLanding
      : value === "web_app" ? t.typeWebApp
        : value === "mobile_app" ? t.typeMobileApp
          : t.typeWebsite;

  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [companyId, setCompanyId] = useState<string>("");
  const [websites, setWebsites] = useState<WebsiteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("active");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");

  // Create Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateOption["id"]>("hosting");
  const [name, setName] = useState(TEMPLATES[0]?.defaultName ?? "CloudScale Hosting");
  const [description, setDescription] = useState(TEMPLATES[0]?.defaultDesc ?? "Modern cloud hosting company");
  const [framework, setFramework] = useState("Next.js");
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
    if (framework.toLowerCase().includes("vite")) {
      setContainerPort(80);
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
          const initialId = chooseAvailableCompanyId(cached);
          setCompanyId(initialId);
        }

        const res = await apiFetch<{ companies: Array<{ id: string; name: string }> }>("/companies");
        if (!active) return;
        const list = res.companies || [];
        setCompanies(list);
        const resolved = chooseAvailableCompanyId(list);
        setCompanyId(resolved);
        writeActiveCompanyId(resolved);
      } catch (err: any) {
        if (active) setError(err.message || t.loadError);
      }
    }
    void loadCompanies();
    return () => {
      active = false;
    };
  }, []);

  // Load Websites for Company
  const loadWebsites = async () => {
    if (!companyId) {
      setWebsites([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ projects: WebsiteProject[] }>(
        `/companies/${encodeURIComponent(companyId)}/projects?includeArchived=true`
      );
      setWebsites((res.projects || []).filter(site => site.type !== "code_project" || /^(Next\.js|HTML\/CSS|React|Vite)$/i.test(site.framework ?? "")));
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

  // When template selection changes in drawer, update suggested values.
  // Mobile app projects pick their own templates, so the page-count heuristic must not reset them.
  const handleSelectTemplate = (tpl: TemplateOption) => {
    setSelectedTemplate(tpl.id);
    setName(tpl.defaultName);
    setDescription(language === "uk" ? tpl.descUk : tpl.desc);
    setType((current) => current === "mobile_app" ? current : tpl.pagesCount > 1 ? "website" : "landing_page");
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
      const isVite = framework.toLowerCase().includes("vite");
      const isMobileApp = type === "mobile_app";
      const doc: WebsiteDocument = createDefaultWebsiteDocument(
        name.trim(),
        isVite ? "vite" : "nextjs",
        {
          purpose: description.trim(),
          template: selectedTemplate,
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

      setModalOpen(false);
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
                  setCompanyId(e.target.value);
                  writeActiveCompanyId(e.target.value);
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
        <div style={{ flex: "1 1 260px", position: "relative" }}>
          <input
            type="search"
            placeholder={t.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "9px 12px 9px 36px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              color: "#111111",
              fontSize: "14px",
              boxSizing: "border-box",
            }}
          />
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        <select
          value={frameworkFilter}
          onChange={(e) => setFrameworkFilter(e.target.value)}
          style={{
            padding: "9px 14px",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            color: "#111111",
            fontSize: "13.5px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <option value="all">{t.filterAll}</option>
          <option value="nextjs">Next.js 14</option>
          <option value="vite">Vite + React</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          style={{
            padding: "9px 14px",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            color: "#111111",
            fontSize: "13.5px",
            fontWeight: 500,
            cursor: "pointer",
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
        <div style={{ textAlign: "center", padding: "4rem", color: "#64748b" }}>
          <p>Loading website projects...</p>
        </div>
      ) : filteredWebsites.length === 0 ? (
        <div
          className="company-run-card"
          style={{
            textAlign: "center",
            padding: "4rem 2rem",
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px dashed #cbd5e1",
          }}
        >
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🌐</div>
          <h3 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.5rem 0", color: "#111111" }}>
            {t.emptyTitle}
          </h3>
          <p style={{ color: "#64748b", maxWidth: "500px", margin: "0 auto 1.75rem auto", fontSize: "14px", lineHeight: 1.6 }}>
            {t.emptySubtitle}
          </p>
          <button
            type="button"
            className="button-primary"
            onClick={() => setModalOpen(true)}
          >
            + {t.createNow}
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

              {/* Section 1: Template & Block Starter Selection */}
              <section>
                <h3>{t.sectionTemplate}</h3>
                <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#64748b" }}>
                  {t.drawerSubtitle}
                </p>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "12px",
                  }}
                >
                  {TEMPLATES.map((tpl) => {
                    const isSelected = selectedTemplate === tpl.id;
                    return (
                      <div
                        key={tpl.id}
                        onClick={() => handleSelectTemplate(tpl)}
                        style={{
                          border: isSelected
                            ? "2px solid var(--npati-red, #e11d2e)"
                            : "1.5px solid #e2e8f0",
                          background: isSelected ? "#fff5f5" : "#ffffff",
                          borderRadius: "14px",
                          padding: "14px 16px",
                          cursor: "pointer",
                          transition: "all 0.16s ease",
                          position: "relative",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                        }}
                      >
                        <div>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "6px" }}>
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: 700,
                                padding: "2px 7px",
                                borderRadius: "6px",
                                background: isSelected ? "var(--npati-red, #e11d2e)" : "#f1f5f9",
                                color: isSelected ? "#ffffff" : "#475569",
                              }}
                            >
                              {tpl.badge}
                            </span>
                          </div>

                          <h4 style={{ margin: "0 0 4px 0", fontSize: "14px", fontWeight: 700, color: "#111111" }}>
                            {language === "uk" ? tpl.titleUk : tpl.title}
                          </h4>

                          <p style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#64748b", lineHeight: 1.4 }}>
                            {language === "uk" ? tpl.descUk : tpl.desc}
                          </p>
                        </div>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "auto" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: isSelected ? "var(--npati-red, #e11d2e)" : "#0284c7",
                            }}
                          >
                            ✓ {tpl.pagesCount} {t.pages} · {tpl.blocks.slice(0, 3).join(", ")}...
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Section 2: Project Details */}
              <section>
                <h3>{t.sectionDetails}</h3>

                <label>
                  <span>{t.nameLabel} *</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. CloudScale Hosting"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>

                <label>
                  <span>{t.descLabel}</span>
                  <textarea
                    rows={3}
                    placeholder="Describe your website purpose, products, and target audience..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>

                <div className="company-form-grid">
                  <label>
                    <span>{t.frameworkLabel}</span>
                    <select
                      value={framework}
                      onChange={(e) => setFramework(e.target.value)}
                    >
                      <option value="Next.js">Next.js 14 App Router (Recommended)</option>
                      <option value="Vite">Vite + React</option>
                    </select>
                  </label>

                  <label>
                    <span>{t.typeLabel}</span>
                    <select
                      value={type}
                      onChange={(e) => setType(e.target.value as any)}
                    >
                      <option value="website">{t.typeWebsite}</option>
                      <option value="landing_page">{t.typeLanding}</option>
                      <option value="web_app">{t.typeWebApp}</option>
                      <option value="mobile_app">{t.typeMobileApp}</option>
                    </select>
                  </label>
                </div>
              </section>

              {/* Section 3: Domain, Port & SSL */}
              <section>
                <h3>{t.sectionDomain}</h3>
                <p style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#64748b" }}>
                  {t.domainDesc}
                </p>

                {/* Info / Notice Banner */}
                <div
                  style={{
                    background: "#f0f9ff",
                    border: "1px solid #bae6fd",
                    borderRadius: "8px",
                    padding: "10px 14px",
                    fontSize: "12.5px",
                    color: "#0369a1",
                    lineHeight: 1.45,
                    marginBottom: "16px",
                    display: "flex",
                    gap: "8px",
                    alignItems: "flex-start",
                  }}
                >
                  <span style={{ fontSize: "15px" }}>ℹ️</span>
                  <div>{t.domainWarning}</div>
                </div>

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

              <footer>
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
