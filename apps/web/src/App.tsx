import { brandConfig } from "@npati/branding";
import type { HealthResponse } from "@npati/shared";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { AIProviderMarketplace, OAuthCallback } from "./AIProviderMarketplace";
import { AuthProvider, useAuth, getStoredAuthToken } from "./AuthContext";
import { AuthModal } from "./AuthModal";
import {
  BusinessPage, BusinessSwitcher,
  SkillsPage, WorkspaceProvider, useWorkspace,
} from "./BusinessWorkspace";
import { MemoryPage } from "./MemoryPage";
import { GoalsPage } from "./GoalsPage";
import { ConversationalChat } from "./ConversationalChat";
import { CompanyPage } from "./CompanyPage";
import { ConfirmDialogContainer, confirmModal, alertModal, promptModal } from "./ConfirmDialog";
import { I18nProvider, useTranslation } from "./i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

function authHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = getStoredAuthToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
}

function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = authHeaders(init?.headers);
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      window.dispatchEvent(new Event("npati:unauthorized"));
    }
    return res;
  });
}
const NPATI_API_BASE = (import.meta.env.VITE_NPATI_BACKEND_URL || "https://api.npati.com").replace(/\/+$/, "");

function resolveNpatiAvatarUrl(value?: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.replace(/^\/+/, "");
  const path = normalized.startsWith("assets/") || normalized.startsWith("uploads/") ? normalized : `assets/${normalized}`;
  return `${NPATI_API_BASE}/${path}`;
}


const navigation = ["Settings"];
type SidebarConversation = { id: string; title: string; updatedAt: string; businessId: string | null; businessName: string };
const legacyChatStorageResetMarker = "npati_legacy_chat_storage_removed_2026_09_06_v1";
function clearLegacyLocalChatsOnce() {
  try {
    if (localStorage.getItem(legacyChatStorageResetMarker) === "done") return;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key === "npati_saved_chats" || key === "npati_free_chats" || key?.startsWith("npati_chat_messages:")) localStorage.removeItem(key);
    }
    localStorage.setItem(legacyChatStorageResetMarker, "done");
  } catch { /* storage can be unavailable in restricted browser contexts */ }
}

function BrandMark() { return <span className="brand-mark" aria-hidden="true">N</span>; }

function NpatiAgentLogo() {
  return (
    <span className="npati-agent-logo" aria-label="Npati">
      <span className="npati-agent-logo-pulse" aria-hidden="true" />
      <span>Npati</span>
    </span>
  );
}

function ChatUserMenu() {
  const { t } = useTranslation();
  const location = useLocation();
  const { overview } = useWorkspace();
  const { user, signOutEverywhere } = useAuth();
  const [open, setOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const displayName = accountName || user?.displayName?.trim() || overview?.user.displayName?.trim() || user?.username || "User";
  const email = user?.email || "";
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase() || "U";
  const avatarUrl = resolveNpatiAvatarUrl(user?.avatar);
  useEffect(() => setAvatarFailed(false), [avatarUrl]);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const closeMenu = () => setOpen(false);
  return (
    <div className="chat-user-menu" ref={menuRef}>
      <button
        type="button"
        className="chat-user-avatar"
        aria-label={`Open ${displayName} user menu`}
        aria-expanded={open}
        aria-controls="chat-user-popover"
        onClick={() => setOpen((current) => !current)}
      >
        {avatarUrl && !avatarFailed ? <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} /> : initials}
      </button>
      {open && (
        <aside className="chat-user-popover" id="chat-user-popover" aria-label="User links">
          <div className="chat-user-summary">
            <span className="chat-user-avatar chat-user-avatar-small" aria-hidden="true">
              {avatarUrl && !avatarFailed ? <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} /> : initials}
            </span>
            <span><strong>{displayName}</strong><small>{email}</small></span>
          </div>
          <span className="chat-user-role">{overview?.workspace.role || "member"}</span>
          <nav aria-label="Registered user links">
            <Link to="/settings/email/inbox" onClick={closeMenu}>{t("userMenu.emailInbox")} <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/settings/ai" onClick={closeMenu}>{t("userMenu.aiProvider")} <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/settings/company" onClick={closeMenu}>{t("userMenu.company")} <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/settings/memory" onClick={closeMenu}>{t("userMenu.memory")} <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/settings" onClick={closeMenu}>{t("userMenu.settings")} <span aria-hidden="true">&rarr;</span></Link>
            <button
              type="button"
              className="chat-user-signout"
              onClick={() => {
                closeMenu();
                void signOutEverywhere().catch((cause) => alertModal({
                  title: t("userMenu.signOutIncompleteTitle"),
                  message: cause instanceof Error ? cause.message : t("userMenu.signOutIncompleteDesc"),
                }));
              }}
            >
              {t("userMenu.signOut")} <span aria-hidden="true">&rarr;</span>
            </button>
          </nav>
        </aside>
      )}
    </div>
  );
}

function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { overview } = useWorkspace();
  const { isAuthenticated, user, logout } = useAuth();
  const [authModal, setAuthModal] = useState<{ open: boolean; mode: "login" | "register" }>({ open: false, mode: "login" });
  const closeAuthModal = useCallback(() => setAuthModal((prev) => ({ ...prev, open: false })), []);
  const handleAuthSuccess = useCallback(() => navigate("/chat"), [navigate]);

  const actionCards = [
    { title: t("home.actions.sellSomething.title"), description: t("home.actions.sellSomething.desc") },
    { title: t("home.actions.startBusiness.title"), description: t("home.actions.startBusiness.desc") },
    { title: t("home.actions.growBusiness.title"), description: t("home.actions.growBusiness.desc") },
    { title: t("home.actions.improveBusiness.title"), description: t("home.actions.improveBusiness.desc") },
    { title: t("home.actions.createContent.title"), description: t("home.actions.createContent.desc") },
    { title: t("home.actions.askAgent.title"), description: t("home.actions.askAgent.desc") },
  ];

  async function startChat(prompt: string) {
    if (!isAuthenticated) {
      setAuthModal({ open: true, mode: "login" });
      return;
    }
    const business = overview?.currentBusiness;
    if (!business) {
      navigate("/chat", { state: { prompt } });
      return;
    }
    const response = await authFetch(`/api/businesses/${business.id}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: prompt }),
    });
    if (!response.ok) {
      navigate("/chat", { state: { prompt } });
      return;
    }
    const conversation = await response.json() as { id: string };
    window.dispatchEvent(new Event("npati:conversations-changed"));
    navigate(`/c/${conversation.id}`, { state: { prompt } });
  }

  return (
    <main className="home-shell">
      <header className="home-header">
        <Link className="brand" to="/"><NpatiAgentLogo /></Link>
        {isAuthenticated ? (
          <div className="home-auth-nav">
            <ChatUserMenu />
          </div>
        ) : (
          <div className="home-auth-nav">
            <button className="button-primary home-auth-btn" onClick={() => setAuthModal({ open: true, mode: "login" })}>{t("home.signIn")}</button>
          </div>
        )}
      </header>
      <section className="hero">
        <div className="hero-header-block">
          <p className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />{t("home.eyebrow")}</p>
          <h1>{t("home.heading")}</h1>
          <p className="hero-copy">{t("home.subheading")}</p>
        </div>

        <div className="action-grid">
          {actionCards.map((card, index) => (
            <button key={card.title} className="action-card" onClick={() => void startChat(card.title)}>
              <span className="action-number">0{index + 1}</span>
              <span><strong>{card.title}</strong><small>{card.description}</small></span>
              <span className="action-arrow"><span className="action-arrow-glyph">→</span></span>
            </button>
          ))}
        </div>
      </section>
      <footer className="home-footer">
        {t("home.footerPrefix")}{" "}
        <a href="https://www.npati.com/" target="_blank" rel="noreferrer">
          {t("home.footerLink")}
        </a>
      </footer>
      <AuthModal
        isOpen={authModal.open}
        initialMode={authModal.mode}
        onClose={closeAuthModal}
        onSuccess={handleAuthSuccess}
      />
    </main>
  );
}

const SIDEBAR_CONVERSATIONS_CACHE_KEY = "npati_sidebar_conversations_cache_v1";
let cachedSidebarConversations: SidebarConversation[] | null = null;
let isSidebarConversationsLoaded = false;
let activeSidebarConversationsFetch: Promise<SidebarConversation[]> | null = null;
let cachedChatOpen = true;
let cachedBusinessOpen = true;

function getInitialSidebarConversations(): SidebarConversation[] {
  if (cachedSidebarConversations !== null) {
    return cachedSidebarConversations;
  }
  try {
    const raw = sessionStorage.getItem(SIDEBAR_CONVERSATIONS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedSidebarConversations = parsed;
        return parsed;
      }
    }
  } catch { /* storage may be restricted */ }
  return [];
}

function updateCachedSidebarConversations(items: SidebarConversation[]) {
  cachedSidebarConversations = items;
  isSidebarConversationsLoaded = true;
  try {
    sessionStorage.setItem(SIDEBAR_CONVERSATIONS_CACHE_KEY, JSON.stringify(items));
  } catch { /* storage may be restricted */ }
}

const SIDEBAR_BUSINESSES_CACHE_KEY = "npati_sidebar_businesses_cache_v1";

type CachedBusinessDraft = {
  businessId: string;
  business: { name: string };
  conversationId?: string;
};

type CachedBusinessItem = {
  id: string;
  name: string;
};

let cachedSidebarDrafts: CachedBusinessDraft[] | null = null;
let cachedSidebarBusinesses: CachedBusinessItem[] | null = null;
let isSidebarBusinessesLoaded = false;

function getInitialSidebarBusinesses(): { drafts: CachedBusinessDraft[]; businesses: CachedBusinessItem[] } {
  if (cachedSidebarDrafts !== null && cachedSidebarBusinesses !== null) {
    return { drafts: cachedSidebarDrafts, businesses: cachedSidebarBusinesses };
  }
  try {
    const raw = sessionStorage.getItem(SIDEBAR_BUSINESSES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.drafts) && Array.isArray(parsed.businesses)) {
        cachedSidebarDrafts = parsed.drafts;
        cachedSidebarBusinesses = parsed.businesses;
        return parsed;
      }
    }
  } catch { /* storage may be restricted */ }
  return { drafts: [], businesses: [] };
}

function updateCachedSidebarBusinesses(drafts: CachedBusinessDraft[], businesses: CachedBusinessItem[]) {
  cachedSidebarDrafts = drafts;
  cachedSidebarBusinesses = businesses;
  isSidebarBusinessesLoaded = true;
  try {
    sessionStorage.setItem(SIDEBAR_BUSINESSES_CACHE_KEY, JSON.stringify({ drafts, businesses }));
  } catch { /* storage may be restricted */ }
}

function areSidebarConversationsEqual(a: SidebarConversation[], b: SidebarConversation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (!itemA || !itemB) return false;
    if (
      itemA.id !== itemB.id ||
      itemA.title !== itemB.title ||
      itemA.updatedAt !== itemB.updatedAt ||
      itemA.businessId !== itemB.businessId ||
      itemA.businessName !== itemB.businessName
    ) {
      return false;
    }
  }
  return true;
}

async function fetchAllSidebarConversations(businesses: Array<{ id: string; name: string }>): Promise<SidebarConversation[]> {
  const neutralRequest = authFetch("/api/conversations");
  const businessRequests = businesses.map(async (business) => {
    const response = await authFetch(`/api/businesses/${business.id}/conversations`);
    if (!response.ok) return [] as SidebarConversation[];
    return (await response.json() as Omit<SidebarConversation, "businessId" | "businessName">[])
      .map((conversation) => ({ ...conversation, businessId: business.id, businessName: business.name }));
  });
  const [neutralResponse, ...businessRows] = await Promise.all([neutralRequest, ...businessRequests]);
  const neutralRows = neutralResponse.ok
    ? (await neutralResponse.json() as Omit<SidebarConversation, "businessId" | "businessName">[])
      .map((conversation) => ({ ...conversation, businessId: null, businessName: "" }))
    : [];
  return [...neutralRows, ...businessRows.flat()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function IconShare() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function IconRename() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function IconUnpin() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="2" x2="22" y2="22" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24V17h12" />
      <path d="M15 9.34V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v1.34" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function IconDots() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

type SidebarMenuTarget = {
  type: "chat" | "draft" | "business";
  id: string;
  title: string;
  isPinned: boolean;
  top: number;
  left: number;
  data: any;
};

function Sidebar({ isOpen = false, onClose }: { isOpen?: boolean; onClose?: () => void } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { overview, refresh, switchBusiness } = useWorkspace();
  const [chatOpen, setChatOpen] = useState(cachedChatOpen);
  const [businessOpen, setBusinessOpen] = useState(cachedBusinessOpen);
  const [conversations, setConversations] = useState<SidebarConversation[]>(getInitialSidebarConversations);
  const [hasLoaded, setHasLoaded] = useState(() => isSidebarConversationsLoaded || cachedSidebarConversations !== null);
  const initialBusinesses = useRef(getInitialSidebarBusinesses());
  const drafts = overview?.onboardings ?? cachedSidebarDrafts ?? initialBusinesses.current.drafts;
  const businesses = overview?.businesses ?? cachedSidebarBusinesses ?? initialBusinesses.current.businesses;
  const hasBusinessesLoaded = isSidebarBusinessesLoaded || overview !== null || (cachedSidebarDrafts !== null && cachedSidebarBusinesses !== null);
  const currentBusiness = overview?.currentBusiness;

  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("npati_pinned_chats") || "[]"); } catch { return []; }
  });
  const [pinnedBusinessIds, setPinnedBusinessIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("npati_pinned_businesses") || "[]"); } catch { return []; }
  });
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("npati_archived_chats") || "[]"); } catch { return []; }
  });
  const [archivedBusinessIds, setArchivedBusinessIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("npati_archived_businesses") || "[]"); } catch { return []; }
  });
  const [menuTarget, setMenuTarget] = useState<SidebarMenuTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!menuTarget) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".sidebar-action-menu") || target?.closest(".sidebar-icon-action")) {
        return;
      }
      setMenuTarget(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuTarget(null);
    };
    const onScroll = () => {
      setMenuTarget(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuTarget]);

  function togglePinChat(id: string) {
    setPinnedChatIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [id, ...prev];
      try { localStorage.setItem("npati_pinned_chats", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function togglePinBusiness(id: string) {
    setPinnedBusinessIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [id, ...prev];
      try { localStorage.setItem("npati_pinned_businesses", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function archiveChat(id: string) {
    setArchivedChatIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      try { localStorage.setItem("npati_archived_chats", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setToast("Chat archived");
  }

  function archiveBusiness(id: string) {
    setArchivedBusinessIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      try { localStorage.setItem("npati_archived_businesses", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setToast("Business archived");
  }

  async function shareLink(url: string, label: string) {
    try {
      await navigator.clipboard.writeText(url);
      setToast(`${label} link copied!`);
    } catch {
      await promptModal({
        title: `Copy ${label} link`,
        message: `Copy this ${label} link:`,
        defaultValue: url,
      });
    }
  }

  async function renameBusinessItem(id: string, currentName: string, isDraft?: boolean) {
    const res = await promptModal({
      title: "Rename business",
      message: `Enter a new name for "${currentName}":`,
      defaultValue: currentName,
      confirmText: "Rename",
    });
    const name = res?.trim();
    if (!name || name === currentName) return;
    if (isDraft) {
      const draft = drafts.find((d) => d.businessId === id);
      if (draft) {
        draft.business.name = name;
        updateCachedSidebarBusinesses(drafts, businesses);
        await refresh();
      }
      return;
    }
    const response = await authFetch(`/api/businesses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      await refresh();
    }
  }

  useEffect(() => {
    if (overview) {
      updateCachedSidebarBusinesses(overview.onboardings, overview.businesses);
    }
  }, [overview]);

  async function loadConversations(force = false) {
    const businesses = overview?.businesses ?? [];
    try {
      if (!activeSidebarConversationsFetch || force) {
        activeSidebarConversationsFetch = fetchAllSidebarConversations(businesses)
          .finally(() => {
            activeSidebarConversationsFetch = null;
          });
      }
      const nextRows = await activeSidebarConversationsFetch;
      updateCachedSidebarConversations(nextRows);
      setHasLoaded(true);
      setConversations((prev) => {
        if (areSidebarConversationsEqual(prev, nextRows)) {
          return prev;
        }
        return nextRows;
      });
    } catch {
      setHasLoaded(true);
      if (cachedSidebarConversations === null) {
        setConversations([]);
      }
    }
  }
  useEffect(() => {
    clearLegacyLocalChatsOnce();
    void loadConversations();
    const reload = () => {
      void loadConversations(true);
    };
    window.addEventListener("npati:conversations-changed", reload);
    window.addEventListener("npati:saved-chats-changed", reload);
    return () => {
      window.removeEventListener("npati:conversations-changed", reload);
      window.removeEventListener("npati:saved-chats-changed", reload);
    };
  }, [overview?.businesses.map((business) => business.id).join(",")]);

  useEffect(() => {
    if (location.pathname === "/business" || location.pathname.startsWith("/b/")) {
      setBusinessOpen(true);
      cachedBusinessOpen = true;
    }
    if (location.pathname === "/chat" || location.pathname.startsWith("/c/")) {
      setChatOpen(true);
      cachedChatOpen = true;
    }
  }, [location.pathname]);

  function createBusinessIdea() {
    onClose?.();
    setBusinessOpen(true);
    cachedBusinessOpen = true;
    navigate("/b/new", { state: { newBusiness: Date.now() } });
  }
  function openNewChat() {
    onClose?.();
    setChatOpen(true);
    cachedChatOpen = true;
    navigate("/chat", { state: { newChat: Date.now() } });
  }
  async function openBusiness(id: string) {
    onClose?.();
    await switchBusiness(id);
    navigate(`/b/${id}`);
  }
  function editBusiness(id: string) {
    navigate(`/settings/business/${id}`);
  }
  async function openConversation(conversation: SidebarConversation) {
    onClose?.();
    if (conversation.businessId && conversation.businessId !== currentBusiness?.id) await switchBusiness(conversation.businessId);
    navigate(`/c/${conversation.id}`, { state: conversation.businessId ? { businessId: conversation.businessId } : { neutralChat: true } });
  }
  async function renameConversation(conversation: SidebarConversation) {
    const res = await promptModal({
      title: "Rename chat",
      message: "Enter a new title for this chat:",
      defaultValue: conversation.title,
      confirmText: "Rename",
    });
    const title = res?.trim();
    if (!title || title === conversation.title) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
    });
    if (response.ok) await loadConversations(true);
  }
  const { t } = useTranslation();

  async function deleteConversation(conversation: SidebarConversation) {
    const confirmed = await confirmModal({
      title: t("dialogs.deleteChatTitle"),
      message: t("dialogs.deleteChatMessage", { title: conversation.title }),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      await alertModal({
        title: "Delete failed",
        message: payload?.error?.message ?? "Could not delete this chat.",
        isDanger: true,
      });
      return;
    }
    const remaining = conversations.filter((item) => item.id !== conversation.id);
    updateCachedSidebarConversations(remaining);
    setConversations(remaining);
    window.dispatchEvent(new Event("npati:conversations-changed"));
    if (location.pathname === `/c/${conversation.id}`) {
      const next = remaining[0];
      if (!next) {
        navigate("/chat", { replace: true });
      } else {
        if (next.businessId && next.businessId !== currentBusiness?.id) await switchBusiness(next.businessId);
        navigate(`/c/${next.id}`, { replace: true });
      }
    }
  }
  async function deleteBusiness(id: string, name: string) {
    const confirmed = await confirmModal({
      title: t("dialogs.deleteBusinessTitle"),
      message: t("dialogs.deleteBusinessMessage", { name }),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    const response = await authFetch(`/api/businesses/${id}`, { method: "DELETE" });
    if (response.ok) {
      const remainingDrafts = (cachedSidebarDrafts ?? drafts).filter((item) => item.businessId !== id);
      const remainingBusinesses = (cachedSidebarBusinesses ?? businesses).filter((item) => item.id !== id);
      updateCachedSidebarBusinesses(remainingDrafts, remainingBusinesses);
      await refresh();
      navigate("/chat");
    }
  }

  const onboardingConversationIds = new Set((overview?.onboardings ?? drafts).map((session) => session.conversationId).filter(Boolean));
  const chatConversations = conversations.filter(
    (c) => c.title !== "Business setup" && !onboardingConversationIds.has(c.id) && !archivedChatIds.includes(c.id)
  );
  const pinnedChats = chatConversations.filter((c) => pinnedChatIds.includes(c.id));
  const unpinnedChats = chatConversations.filter((c) => !pinnedChatIds.includes(c.id));
  const hasSavedChats = chatConversations.length > 0;

  const visibleDrafts = drafts.filter((d) => !archivedBusinessIds.includes(d.businessId));
  const visibleBusinesses = businesses.filter((b) => !archivedBusinessIds.includes(b.id));

  type BusinessListItem =
    | { kind: "draft"; id: string; name: string; subtitle: string; draft: (typeof drafts)[0] }
    | { kind: "business"; id: string; name: string; subtitle: string; business: (typeof businesses)[0] };

  const allBusinessItems: BusinessListItem[] = [
    ...visibleDrafts.map((d) => ({
      kind: "draft" as const,
      id: d.businessId,
      name: d.business.name,
      subtitle: "Setup draft",
      draft: d,
    })),
    ...visibleBusinesses.map((b) => ({
      kind: "business" as const,
      id: b.id,
      name: b.name,
      subtitle: b.id === currentBusiness?.id ? "Current" : "Use in chat",
      business: b,
    })),
  ];

  const pinnedBusinessItems = allBusinessItems.filter((item) => pinnedBusinessIds.includes(item.id));
  const unpinnedBusinessItems = allBusinessItems.filter((item) => !pinnedBusinessIds.includes(item.id));

  function renderConversationRow(conversation: SidebarConversation, isPinned: boolean) {
    const isMenuOpen = menuTarget?.type === "chat" && menuTarget.id === conversation.id;
    const isActive = location.pathname === `/c/${conversation.id}` || window.location.pathname === `/c/${conversation.id}`;
    return (
      <div className={`sidebar-history-row ${isActive ? "active" : ""} ${isPinned ? "is-pinned" : ""} ${isMenuOpen ? "menu-open" : ""}`} key={conversation.id}>
        <button className="sidebar-history-link" onClick={() => void openConversation(conversation)}>
          <span>{conversation.title}</span>
          <small>{conversation.businessName ? `${conversation.businessName} · ` : ""}{new Date(conversation.updatedAt).toLocaleDateString()}</small>
        </button>
        <button
          className={`sidebar-icon-action ${isPinned ? "pinned" : ""}`}
          aria-label={isPinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
          title={isPinned ? "Unpin chat" : "Pin chat"}
          onClick={(e) => {
            e.stopPropagation();
            togglePinChat(conversation.id);
          }}
        >
          {isPinned ? <IconUnpin /> : <IconPin />}
        </button>
        <button
          className={`sidebar-icon-action ${isMenuOpen ? "active" : ""}`}
          aria-label={`Options for ${conversation.title}`}
          title="More options"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const sidebarEl = e.currentTarget.closest(".sidebar");
            const sidebarRight = sidebarEl ? sidebarEl.getBoundingClientRect().right : 230;
            const left = Math.min(Math.max(rect.right + 10, sidebarRight + 8), window.innerWidth - 190);
            const top = Math.max(10, Math.min(rect.top - 6, window.innerHeight - 250));
            setMenuTarget(
              isMenuOpen
                ? null
                : {
                  type: "chat",
                  id: conversation.id,
                  title: conversation.title,
                  isPinned,
                  top,
                  left,
                  data: conversation,
                }
            );
          }}
        >
          <IconDots />
        </button>
      </div>
    );
  }

  function renderBusinessItemRow(item: BusinessListItem, isPinned: boolean) {
    const isMenuOpen = (menuTarget?.type === "draft" || menuTarget?.type === "business") && menuTarget.id === item.id;
    const isActive = location.pathname === `/b/${item.id}` || window.location.pathname === `/b/${item.id}` || (item.kind === "business" && (location.pathname === `/settings/business/${item.id}` || window.location.pathname === `/settings/business/${item.id}`));
    const onOpen = item.kind === "draft"
      ? () => navigate(`/b/${item.id}`)
      : () => void openBusiness(item.id);

    return (
      <div className={`sidebar-history-row ${isActive ? "active" : ""} ${isPinned ? "is-pinned" : ""} ${isMenuOpen ? "menu-open" : ""}`} key={item.id}>
        <button className="sidebar-history-link" onClick={onOpen}>
          <span>{item.name}</span>
          <small>{item.subtitle}</small>
        </button>
        <button
          className={`sidebar-icon-action ${isPinned ? "pinned" : ""}`}
          aria-label={isPinned ? `Unpin ${item.name}` : `Pin ${item.name}`}
          title={isPinned ? "Unpin business" : "Pin business"}
          onClick={(e) => {
            e.stopPropagation();
            togglePinBusiness(item.id);
          }}
        >
          {isPinned ? <IconUnpin /> : <IconPin />}
        </button>
        <button
          className={`sidebar-icon-action ${isMenuOpen ? "active" : ""}`}
          aria-label={`Options for ${item.name}`}
          title="More options"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const sidebarEl = e.currentTarget.closest(".sidebar");
            const sidebarRight = sidebarEl ? sidebarEl.getBoundingClientRect().right : 230;
            const left = Math.min(Math.max(rect.right + 10, sidebarRight + 8), window.innerWidth - 190);
            const top = Math.max(10, Math.min(rect.top - 6, window.innerHeight - 250));
            setMenuTarget(
              isMenuOpen
                ? null
                : {
                  type: item.kind,
                  id: item.id,
                  title: item.name,
                  isPinned,
                  top,
                  left,
                  data: item.kind === "draft" ? item.draft : item.business,
                }
            );
          }}
        >
          <IconDots />
        </button>
      </div>
    );
  }

  return (
    <aside className={`sidebar ${isOpen ? "mobile-open" : ""}`}>
      <div className="sidebar-mobile-head">
        <Link className="brand" to="/chat" onClick={onClose}><NpatiAgentLogo /></Link>
        <button type="button" className="sidebar-close-button" aria-label="Close menu" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <Link className="brand sidebar-brand" to="/chat"><NpatiAgentLogo /></Link>
      <nav>
        <div className={`sidebar-group ${location.pathname === "/chat" || location.pathname.startsWith("/c/") || window.location.pathname === "/chat" || window.location.pathname.startsWith("/c/") ? "active" : ""}`}>
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => void openNewChat()}>{t("sidebar.newChat")}</button>
            <button className="sidebar-chevron" aria-label="Show chat history" aria-expanded={chatOpen} onClick={() => setChatOpen((open) => { const next = !open; cachedChatOpen = next; return next; })}></button>
          </div>
          {chatOpen && (
            <div className="sidebar-dropdown">
              {!hasSavedChats && hasLoaded && <small className="sidebar-empty">{t("sidebar.noSavedChats")}</small>}
              {pinnedChats.length > 0 && (
                <>
                  <div className="sidebar-section-header">{t("sidebar.pinned")}</div>
                  {pinnedChats.map((conversation) => renderConversationRow(conversation, true))}
                </>
              )}
              {unpinnedChats.length > 0 && (
                <>
                  {pinnedChats.length > 0 && <div className="sidebar-section-header">{t("sidebar.recent")}</div>}
                  {unpinnedChats.map((conversation) => renderConversationRow(conversation, false))}
                </>
              )}
            </div>
          )}
        </div>
        {navigation.map((item) => { const href = `/${item.toLowerCase()}`; return <Link key={item} className={`sidebar-settings-link ${location.pathname === href || location.pathname.startsWith(`${href}/`) ? "active" : ""}`} to={href} onClick={onClose}>{item === "Settings" ? t("common.settings") : item}</Link>; })}
      </nav>

      {menuTarget &&
        createPortal(
          <div
            className="sidebar-action-menu"
            style={{ top: menuTarget.top, left: menuTarget.left }}
          >
            <button
              className="sidebar-action-item"
              onClick={() => {
                if (menuTarget.type === "chat") {
                  void shareLink(`${window.location.origin}/c/${menuTarget.id}`, "Chat");
                } else {
                  void shareLink(`${window.location.origin}/b/${menuTarget.id}`, "Business");
                }
                setMenuTarget(null);
              }}
            >
              <IconShare />
              <span>Share</span>
            </button>
            <button
              className="sidebar-action-item"
              onClick={() => {
                if (menuTarget.type === "chat") {
                  void renameConversation(menuTarget.data as SidebarConversation);
                } else if (menuTarget.type === "draft") {
                  void renameBusinessItem(menuTarget.id, menuTarget.title, true);
                } else {
                  void renameBusinessItem(menuTarget.id, menuTarget.title, false);
                }
                setMenuTarget(null);
              }}
            >
              <IconRename />
              <span>Rename</span>
            </button>
            <div className="sidebar-action-divider" />
            <button
              className="sidebar-action-item"
              onClick={() => {
                if (menuTarget.type === "chat") {
                  togglePinChat(menuTarget.id);
                } else {
                  togglePinBusiness(menuTarget.id);
                }
                setMenuTarget(null);
              }}
            >
              {menuTarget.isPinned ? <IconUnpin /> : <IconPin />}
              <span>
                {menuTarget.isPinned
                  ? menuTarget.type === "chat"
                    ? "Unpin chat"
                    : "Unpin business"
                  : menuTarget.type === "chat"
                    ? "Pin chat"
                    : "Pin business"}
              </span>
            </button>
            <button
              className="sidebar-action-item"
              onClick={() => {
                if (menuTarget.type === "chat") {
                  archiveChat(menuTarget.id);
                } else {
                  archiveBusiness(menuTarget.id);
                }
                setMenuTarget(null);
              }}
            >
              <IconArchive />
              <span>Archive</span>
            </button>
            <button
              className="sidebar-action-item danger"
              onClick={() => {
                if (menuTarget.type === "chat") {
                  void deleteConversation(menuTarget.data as SidebarConversation);
                } else {
                  void deleteBusiness(menuTarget.id, menuTarget.title);
                }
                setMenuTarget(null);
              }}
            >
              <IconTrash />
              <span>Delete</span>
            </button>
          </div>,
          document.body
        )}
      {toast && <div className="sidebar-toast">{toast}</div>}
      <div className="sidebar-footer-row">
        <LanguageSwitcher variant="full" />
      </div>
    </aside>
  );
}



function Workspace({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  if (isLoading && !isAuthenticated) {
    return <div className="workspace" />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }
  const isChat = location.pathname === "/chat" || location.pathname.startsWith("/b/") || location.pathname.startsWith("/c/") || window.location.pathname === "/chat" || window.location.pathname.startsWith("/b/") || window.location.pathname.startsWith("/c/");
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");
  const isCompany = location.pathname === "/company";
  const isActivity = location.pathname === "/activity";
  const isAutomations = location.pathname === "/automations" || location.pathname.startsWith("/automations");
  const isGoals = location.pathname === "/goals" || location.pathname.startsWith("/goals");
  const isContent = location.pathname === "/content" || location.pathname.startsWith("/content");
  const isConnections = location.pathname === "/connections" || location.pathname.startsWith("/connections");
  const isMemory = location.pathname === "/memory" || location.pathname.startsWith("/memory");
  const isSkills = location.pathname === "/skills" || location.pathname.startsWith("/skills");
  const isInbox = location.pathname.startsWith("/inbox") || location.pathname.startsWith("/settings/email/inbox");
  return (
    <div className={`workspace ${mobileNavOpen ? "mobile-nav-open" : ""}`}>
      <header className="workspace-mobile-header">
        <button
          type="button"
          className="mobile-header-menu-button"
          aria-label="Open navigation menu"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <IconMenu />
        </button>
        <Link className="mobile-header-brand" to="/chat" onClick={() => setMobileNavOpen(false)}>
          <NpatiAgentLogo />
        </Link>
        <div className="mobile-header-right">
          <ChatUserMenu />
        </div>
      </header>
      {mobileNavOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <Sidebar isOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <section className={`workspace-content ${isChat ? "chat-workspace-content" : ""} ${isSettings || isActivity || isAutomations || isGoals || isContent || isConnections || isMemory || isSkills || isInbox ? "settings-workspace-content" : ""}`}>
        {isChat && <ChatUserMenu />}
        {!isChat && !isSettings && !isCompany && !isActivity && !isAutomations && !isGoals && !isContent && !isConnections && !isMemory && !isSkills && !isInbox && <div className="workspace-topbar"><BusinessSwitcher /></div>}
        {children}
      </section>
    </div>
  );
}

function ChatRoute() {
  const location = useLocation();
  const newChatKey = (location.state as { newChat?: number } | null)?.newChat;
  return <Workspace><ConversationalChat key={newChatKey ? `chat-${newChatKey}` : "chat"} initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} /></Workspace>;
}

function BusinessRoute() {
  const { businessId = "" } = useParams();
  const location = useLocation();
  const { overview, loading, switchBusiness } = useWorkspace();
  const [error, setError] = useState("");
  const draft = overview?.onboardings.find((session) => session.businessId === businessId);
  const business = overview?.businesses.find((item) => item.id === businessId);
  const newBusinessKey = (location.state as { newBusiness?: number } | null)?.newBusiness;

  useEffect(() => {
    if (loading || !business || overview?.currentBusiness?.id === businessId) return;
    void switchBusiness(businessId).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this business."));
  }, [businessId, business?.id, loading, overview?.currentBusiness?.id]);

  if (loading || (business && overview?.currentBusiness?.id !== businessId)) return <Workspace>{null}</Workspace>;
  if (businessId === "new") {
    return (
      <Workspace>
        <ConversationalChat
          key={newBusinessKey ? `new-business-${newBusinessKey}` : "new-business"}
          businessRoute
          businessSetup
        />
      </Workspace>
    );
  }
  if (!draft && !business) return <Workspace><div className="workspace-notice error">This business does not exist or is not available to your user.</div></Workspace>;
  if (error) return <Workspace><div className="workspace-notice error">{error}</div></Workspace>;
  return <Workspace><ConversationalChat key={businessId} businessId={businessId} businessRoute businessSetup={Boolean(draft)} /></Workspace>;
}
function LegacyChatRoute() {
  const location = useLocation();
  const conversationId = new URLSearchParams(location.search).get("conversation");
  return conversationId ? <Navigate to={`/c/${conversationId}`} replace /> : <ChatRoute />;
}

function CanonicalChatRoute() {
  const { conversationId = "" } = useParams();
  const location = useLocation();
  const { overview, loading, switchBusiness } = useWorkspace();
  const routeState = location.state as { businessId?: string; neutralChat?: boolean } | null;
  const isKnownNeutral = Boolean(routeState?.neutralChat);
  const isKnownBusiness = Boolean(routeState?.businessId && overview?.currentBusiness?.id === routeState.businessId);
  const [neutralChat, setNeutralChat] = useState(() => isKnownNeutral);
  const [resolved, setResolved] = useState(() => isKnownNeutral || isKnownBusiness);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (loading || !overview || !conversationId) return;
    setNotFound(false);
    let cancelled = false;
    async function resolveConversation() {
      if (routeState?.neutralChat) {
        setNeutralChat(true);
        setResolved(true);
        return;
      }
      const neutralResponse = await authFetch(`/api/conversations/${conversationId}`);
      if (neutralResponse.ok) {
        if (!cancelled) {
          setNeutralChat(true);
          setResolved(true);
        }
        return;
      }

      if (overview?.onboarding?.conversationId === conversationId) {
        if (!cancelled) setResolved(true);
        return;
      }
      const businessIds = [...new Set([routeState?.businessId, ...(overview?.businesses ?? []).map((business) => business.id)].filter((id): id is string => Boolean(id)))];
      for (const businessId of businessIds) {
        const response = await authFetch(`/api/businesses/${businessId}/conversations/${conversationId}`);
        if (!response.ok) continue;
        if (businessId !== overview?.currentBusiness?.id) await switchBusiness(businessId);
        if (!cancelled) setResolved(true);
        return;
      }
      if (!cancelled) setNotFound(true);
    }
    void resolveConversation();
    return () => { cancelled = true; };
  }, [conversationId, loading, routeState?.businessId, routeState?.neutralChat, overview?.currentBusiness?.id, overview?.onboarding?.conversationId, overview?.businesses.map((business) => business.id).join(",")]);

  if (notFound) return <Workspace><div className="workspace-notice error">This chat does not exist or is not available to your user.</div></Workspace>;
  if (!resolved) {
    return (
      <Workspace>
        <div className="chat-workspace-content">
          <div className="standard-live-chat">
            <div className="message-stream" />
          </div>
        </div>
      </Workspace>
    );
  }
  return (
    <Workspace>
      <ConversationalChat
        key={conversationId}
        initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""}
        initialConversationId={conversationId}
        neutralChat={neutralChat}
      />
    </Workspace>
  );
}
import { AutomationsPage } from "./AutomationsPage";
import { ActivityPage } from "./ActivityPage";
import { CapabilityInspectorPage } from "./CapabilityInspectorPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { ContentPage } from "./ContentPage";
import { EmailSettingsPage } from "./EmailSettingsPage";
import { EmailInboxPage } from "./EmailInboxPage";
import { IntegrationsPage } from "./IntegrationsPage";

function SettingsPage() {
  const { t } = useTranslation();
  const cards: Array<{
    to: string;
    icon: React.ReactNode;
    title: string;
    description: string;
  }> = [
    {
      to: "/settings/ai",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
          <path d="M19 4v4" />
          <path d="M21 6h-4" />
        </svg>
      ),
      title: t("settings.cards.aiProviders.title"),
      description: t("settings.cards.aiProviders.desc"),
    },
    {
      to: "/settings/integrations",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 12h8M12 8v8" /><circle cx="5" cy="12" r="3" /><circle cx="19" cy="12" r="3" />
        </svg>
      ),
      title: "Integrations",
      description: "Connect Telegram or WhatsApp to the shared NPATI Messaging Gateway.",
    },
    {
      to: "/settings/business",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          <rect width="20" height="14" x="2" y="6" rx="2" />
          <path d="M2 13h20" />
        </svg>
      ),
      title: t("settings.cards.business.title"),
      description: t("settings.cards.business.desc"),
    },
    {
      to: "/settings/company",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="5" rx="1.5" />
          <rect x="3" y="15" width="6" height="5" rx="1.5" />
          <rect x="15" y="15" width="6" height="5" rx="1.5" />
          <path d="M12 8v4M6 12h12v3M6 12v3" />
        </svg>
      ),
      title: t("settings.cards.company.title"),
      description: t("settings.cards.company.desc"),
    },
    {
      to: "/settings/capabilities",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      ),
      title: t("settings.cards.capabilities.title"),
      description: t("settings.cards.capabilities.desc"),
    },
    {
      to: "/settings/activity",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      ),
      title: t("settings.cards.activity.title"),
      description: t("settings.cards.activity.desc"),
    },
    {
      to: "/settings/automations",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      ),
      title: t("settings.cards.automations.title"),
      description: t("settings.cards.automations.desc"),
    },
    {
      to: "/settings/email",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      ),
      title: t("settings.cards.email.title"),
      description: t("settings.cards.email.desc"),
    },
    {
      to: "/settings/goals",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      ),
      title: t("settings.cards.goals.title"),
      description: t("settings.cards.goals.desc"),
    },
    {
      to: "/settings/content",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" x2="8" y1="13" y2="13" />
          <line x1="16" x2="8" y1="17" y2="17" />
          <line x1="10" x2="8" y1="9" y2="9" />
        </svg>
      ),
      title: t("settings.cards.content.title"),
      description: t("settings.cards.content.desc"),
    },
    {
      to: "/settings/connections",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z" />
        </svg>
      ),
      title: t("settings.cards.connections.title"),
      description: t("settings.cards.connections.desc"),
    },
    {
      to: "/settings/memory",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04" />
        </svg>
      ),
      title: t("settings.cards.memory.title"),
      description: t("settings.cards.memory.desc"),
    },
    {
      to: "/settings/skills",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      ),
      title: t("settings.cards.skills.title"),
      description: t("settings.cards.skills.desc"),
    },
  ];

  return (
    <Workspace>
      <div className="page-heading settings-page-heading">
        <p className="eyebrow">{t("settings.eyebrow")}</p>
        <h1>{t("settings.title")}</h1>
        <p>{t("settings.description")}</p>
      </div>

      <div className="settings-card-grid">
        {cards.map((card) => (
          <Link className="settings-ai-card" to={card.to} key={card.to}>
            <span className="provider-avatar" aria-hidden="true">{card.icon}</span>
            <span>
              <strong>{card.title}</strong>
              <small>{card.description}</small>
            </span>
            <b aria-hidden="true">&rarr;</b>
          </Link>
        ))}
      </div>
    </Workspace>
  );
}

function HealthBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => { fetch("/api/health").then((response) => response.json()).then(setHealth).catch(() => setHealth(null)); }, []);
  return <div className="health-card"><span className={`status-dot ${health?.status === "ok" ? "healthy" : ""}`} /><div><strong>{health?.status === "ok" ? "Agent API connected" : "Waiting for local services"}</strong><small>Database: {health?.services.database ?? "unknown"} · AI routing: {health?.services.omniroute ?? "unknown"} · Crawler: {health?.services.crawler ?? "unknown"} · Hub: {health?.services.hub ?? "unknown"}</small></div></div>;
}

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <WorkspaceProvider>
          <ConfirmDialogContainer />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/chat" element={<LegacyChatRoute />} />
            <Route path="/c/:conversationId" element={<CanonicalChatRoute />} />
            <Route path="/business" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/b/:businessId" element={<BusinessRoute />} />
            <Route path="/settings/business" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/settings/business/:businessId" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/company" element={<Workspace><CompanyPage /></Workspace>} />
            <Route path="/settings/company" element={<Workspace><CompanyPage /></Workspace>} />
            <Route path="/dashboard" element={<Navigate to="/settings/connections" replace />} />
            <Route path="/settings/dashboard" element={<Navigate to="/settings/connections" replace />} />
            <Route path="/activity" element={<Workspace><ActivityPage /></Workspace>} />
            <Route path="/settings/activity" element={<Workspace><ActivityPage /></Workspace>} />
            <Route path="/content" element={<Workspace><ContentPage /></Workspace>} />
            <Route path="/settings/content" element={<Workspace><ContentPage /></Workspace>} />
            <Route path="/connections" element={<Workspace><ConnectionsPage /></Workspace>} />
            <Route path="/settings/connections" element={<Workspace><ConnectionsPage /></Workspace>} />
            <Route path="/automations" element={<Workspace><AutomationsPage /></Workspace>} />
            <Route path="/settings/automations" element={<Workspace><AutomationsPage /></Workspace>} />
            <Route path="/settings/email" element={<Workspace><EmailSettingsPage /></Workspace>} />
            <Route path="/settings/email/inbox" element={<Workspace><EmailInboxPage /></Workspace>} />
            <Route path="/inbox" element={<Navigate to="/settings/email/inbox" replace />} />
            <Route path="/email" element={<Navigate to="/settings/email/inbox" replace />} />
            <Route path="/settings/capabilities" element={<Workspace><CapabilityInspectorPage /></Workspace>} />
            <Route path="/capabilities" element={<Navigate to="/settings/capabilities" replace />} />
            <Route path="/goals" element={<Workspace><GoalsPage /></Workspace>} />
            <Route path="/settings/goals" element={<Workspace><GoalsPage /></Workspace>} />
            <Route path="/memory" element={<Workspace><MemoryPage /></Workspace>} />
            <Route path="/settings/memory" element={<Workspace><MemoryPage /></Workspace>} />
            <Route path="/skills" element={<Workspace><SkillsPage /></Workspace>} />
            <Route path="/settings/skills" element={<Workspace><SkillsPage /></Workspace>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/integrations" element={<Workspace><IntegrationsPage /></Workspace>} />
            <Route path="/settings/ai" element={<Workspace><AIProviderMarketplace /></Workspace>} />
            <Route path="/settings/ai/oauth/callback" element={<OAuthCallback />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </WorkspaceProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
