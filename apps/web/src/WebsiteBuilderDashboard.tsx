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

function FrameworkIcon({ id }: { id: string }) {
  if (id === "html-css") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill="#E44D26" d="M19.037 113.876L9.032 1.661h109.936l-10.016 112.198-45.019 12.48z" />
        <path fill="#F16529" d="M64 116.8l36.378-10.086 8.559-95.878H64z" />
        <path fill="#EBEBEB" d="M64 52.455H45.788L44.53 38.361H64V24.599H29.489l.33 3.692 3.382 37.927H64zm0 35.743l-.061.017-15.327-4.14-.979-10.975H33.816l1.928 21.609 28.193 7.826.063-.017z" />
        <path fill="#FFFFFF" d="M63.952 52.455v13.763h16.947l-1.597 17.849-15.35 4.143v14.319l28.215-7.82.207-2.325 3.234-36.233.335-3.696h-3.708zm0-27.856v13.762h33.244l.276-3.092.628-6.978.329-3.692z" />
      </svg>
    );
  }
  if (id === "nextjs") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="64" cy="64" r="64" fill="#000000" />
        <path fill="url(#next_devicon_a)" d="M106.317 112.014 49.167 38.4H38.4v51.179h8.614v-40.24l52.54 67.884a64.216 64.216 0 0 0 6.763-5.209z" />
        <path fill="url(#next_devicon_b)" d="M81.778 38.4h8.533v51.2h-8.533z" />
        <defs>
          <linearGradient id="next_devicon_a" x1="109" x2="144.5" y1="116.5" y2="160.5" gradientTransform="scale(.71111)" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="next_devicon_b" x1="121" x2="120.799" y1="54" y2="106.875" gradientTransform="scale(.71111)" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  if (id === "vite") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="vite_devicon_a" x1="6" x2="235" y1="33" y2="344" gradientTransform="translate(0 .937) scale(.3122)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#41d1ff" />
            <stop offset="1" stopColor="#bd34fe" />
          </linearGradient>
          <linearGradient id="vite_devicon_b" x1="194.651" x2="236.076" y1="8.818" y2="292.989" gradientTransform="translate(0 .937) scale(.3122)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffea83" />
            <stop offset=".083" stopColor="#ffdd35" />
            <stop offset="1" stopColor="#ffa800" />
          </linearGradient>
        </defs>
        <path fill="url(#vite_devicon_a)" d="M124.766 19.52 67.324 122.238c-1.187 2.121-4.234 2.133-5.437.024L3.305 19.532c-1.313-2.302.652-5.087 3.261-4.622L64.07 25.187a3.09 3.09 0 0 0 1.11 0l56.3-10.261c2.598-.473 4.575 2.289 3.286 4.594Zm0 0" />
        <path fill="url(#vite_devicon_b)" d="M91.46 1.43 48.954 9.758a1.56 1.56 0 0 0-1.258 1.437l-2.617 44.168a1.563 1.563 0 0 0 1.91 1.614l11.836-2.735a1.562 1.562 0 0 1 1.88 1.836l-3.517 17.219a1.562 1.562 0 0 0 1.985 1.805l7.308-2.223c1.133-.344 2.223.652 1.985 1.812l-5.59 27.047c-.348 1.692 1.902 2.614 2.84 1.164l.625-.968 34.64-69.13c.582-1.16-.421-2.48-1.69-2.234l-12.185 2.352a1.558 1.558 0 0 1-1.793-1.965l7.95-27.562A1.56 1.56 0 0 0 91.46 1.43Zm0 0" />
      </svg>
    );
  }
  if (id === "astro") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="astro_devicon_flame" x1="1001.68" x2="790.326" y1="652.45" y2="1094.91" gradientTransform="scale(.1)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ff1639" />
            <stop offset="1" stopColor="#ff1639" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path fill="#ffffff" d="M81.504 9.465c.973 1.207 1.469 2.836 2.457 6.09l21.656 71.136a90.079 90.079 0 0 0-25.89-8.765L65.629 30.28a1.833 1.833 0 0 0-3.52.004L48.18 77.902a90.104 90.104 0 0 0-26.003 8.778l21.758-71.14c.996-3.25 1.492-4.876 2.464-6.083a8.023 8.023 0 0 1 3.243-2.398c1.433-.575 3.136-.575 6.535-.575H71.72c3.402 0 5.105 0 6.543.579a7.988 7.988 0 0 1 3.242 2.402Zm0 0" />
        <path fill="#ff5d01" d="M84.094 90.074c-3.57 3.055-10.696 5.137-18.903 5.137-10.07 0-18.515-3.137-20.754-7.356-.8 2.418-.98 5.184-.98 6.954 0 0-.527 8.675 5.508 14.71a5.671 5.671 0 0 1 5.672-5.671c5.37 0 5.367 4.683 5.363 8.488v.336c0 5.773 3.527 10.719 8.543 12.805a11.62 11.62 0 0 1-1.172-5.098c0-5.508 3.23-7.555 6.988-9.938 2.989-1.894 6.309-4 8.594-8.222a15.513 15.513 0 0 0 1.875-7.41 15.55 15.55 0 0 0-.734-4.735Zm0 0" />
        <path fill="url(#astro_devicon_flame)" d="M84.094 90.074c-3.57 3.055-10.696 5.137-18.903 5.137-10.07 0-18.515-3.137-20.754-7.356-.8 2.418-.98 5.184-.98 6.954 0 0-.527 8.675 5.508 14.71a5.671 5.671 0 0 1 5.672-5.671c5.37 0 5.367 4.683 5.363 8.488v.336c0 5.773 3.527 10.719 8.543 12.805a11.62 11.62 0 0 1-1.172-5.098c0-5.508 3.23-7.555 6.988-9.938 2.989-1.894 6.309-4 8.594-8.222a15.513 15.513 0 0 0 1.875-7.41 15.55 15.55 0 0 0-.734-4.735Zm0 0" />
      </svg>
    );
  }
  return null;
}

interface FrameworkStarterOption {
  id: "html-css" | "nextjs" | "vite" | "astro";
  frameworkKey: "HTML/CSS" | "Next.js" | "Vite" | "Astro";
  name: string;
  runtimeLabel: string;
  runtimeLabelUk: string;
  verifiedLabel: string;
  tags: string[];
  defaultPort: number;
  defaultType: "website" | "landing_page" | "web_app";
  defaultName: string;
  defaultNameUk: string;
  defaultDesc: string;
  defaultDescUk: string;
}

const FRAMEWORK_STARTERS: FrameworkStarterOption[] = [
  {
    id: "html-css",
    frameworkKey: "HTML/CSS",
    name: "HTML / CSS",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["HTML5", "CSS3", "JavaScript", "Instant Preview", "Static Build"],
    defaultPort: 3000,
    defaultType: "website",
    defaultName: "Modern HTML/CSS Website",
    defaultNameUk: "Сучасний HTML/CSS сайт",
    defaultDesc: "Clean, responsive static website with modern HTML5, CSS3 layout, and instant live preview.",
    defaultDescUk: "Швидкий адаптивний статичний сайт із сучасним макетом на HTML5 та CSS3.",
  },
  {
    id: "nextjs",
    frameworkKey: "Next.js",
    name: "Next.js",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["App Router", "React 18", "TypeScript", "Server Actions", "API Routes"],
    defaultPort: 3000,
    defaultType: "website",
    defaultName: "Next.js Web Platform",
    defaultNameUk: "Веб-платформа Next.js",
    defaultDesc: "Full-stack web application powered by Next.js 14 App Router, TypeScript, and server components.",
    defaultDescUk: "Повнофункціональний веб-застосунок на Next.js 14 App Router з підтримкою TypeScript.",
  },
  {
    id: "vite",
    frameworkKey: "Vite",
    name: "Vite",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["React 18", "Vite HMR", "TypeScript", "SPA", "Tailwind CSS"],
    defaultPort: 5173,
    defaultType: "web_app",
    defaultName: "Vite React Studio",
    defaultNameUk: "Vite React Студія",
    defaultDesc: "Ultra-fast single page application with instant Vite HMR, React 18, and modular components.",
    defaultDescUk: "Ультрашвидкий SPA-застосунок з миттєвим гарячим перезавантаженням на Vite та React 18.",
  },
  {
    id: "astro",
    frameworkKey: "Astro",
    name: "Astro",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Islands", "Zero JS", "Markdown / MDX", "Content Collections", "Multi-page"],
    defaultPort: 4321,
    defaultType: "website",
    defaultName: "Astro Content Hub",
    defaultNameUk: "Контент-хаб на Astro",
    defaultDesc: "High-performance content website with Astro islands architecture and zero unnecessary JavaScript.",
    defaultDescUk: "Високопродуктивний сайт з острівною архітектурою Astro та мінімальним завантаженням JS.",
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
    drawerSubtitle: "Select a framework runtime to deploy and customize your project details.",
    sectionTemplate: "1. Choose Framework & Runtime",
    sectionDomain: "2. Domain & SSL / Network",
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
    drawerSubtitle: "Оберіть фреймворк для розгортання в ізольованому середовищі.",
    sectionTemplate: "1. Оберіть фреймворк та середовище",
    sectionDomain: "2. Домен, порт та SSL-сертифікат",
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
