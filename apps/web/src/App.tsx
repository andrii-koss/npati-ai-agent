import { brandConfig } from "@npati/branding";
import type { HealthResponse } from "@npati/shared";
import { ReactNode, useEffect, useRef, useState } from "react";
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
import { DashboardPage } from "./DashboardPage";

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

const actions = [
  ["Sell something", "Turn a product into a clear offer"],
  ["Start a business", "Shape an idea into a first test"],
  ["Grow my business", "Find the next practical growth move"],
  ["Improve my business", "Review what is working and what is not"],
  ["Create content", "Plan useful content for your audience"],
  ["Ask NPATI Agent", "Start with your own question"],
] as const;

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
  const location = useLocation();
  const { overview } = useWorkspace();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = overview?.user.displayName?.trim() || user?.displayName || "User";
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase() || "U";

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
        {initials}
      </button>
      {open && (
        <aside className="chat-user-popover" id="chat-user-popover" aria-label="User links">
          <div className="chat-user-summary">
            <span className="chat-user-avatar chat-user-avatar-small" aria-hidden="true">{initials}</span>
            <span><strong>{displayName}</strong><small>{overview?.workspace.name || "Workspace"}</small></span>
          </div>
          <span className="chat-user-role">{overview?.workspace.role || "member"}</span>
          <nav aria-label="Registered user links">
            <Link to="/settings/business" onClick={closeMenu}>Business profile <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/goals" onClick={closeMenu}>Goals <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/memory" onClick={closeMenu}>Memory <span aria-hidden="true">&rarr;</span></Link>
            <Link to="/settings" onClick={closeMenu}>Settings <span aria-hidden="true">&rarr;</span></Link>
            <button
              type="button"
              className="chat-user-signout"
              onClick={() => {
                closeMenu();
                void logout();
              }}
            >
              Sign out <span aria-hidden="true">&rarr;</span>
            </button>
          </nav>
        </aside>
      )}
    </div>
  );
}

function Home() {
  const navigate = useNavigate();
  const { overview } = useWorkspace();
  const { isAuthenticated, user, logout } = useAuth();
  const [authModal, setAuthModal] = useState<{ open: boolean; mode: "login" | "register" }>({ open: false, mode: "login" });

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
            <button className="button-secondary home-auth-btn" onClick={() => setAuthModal({ open: true, mode: "login" })}>Sign in</button>
            <button className="button-primary home-auth-btn" onClick={() => setAuthModal({ open: true, mode: "register" })}>Create account</button>
          </div>
        )}
      </header>
      <section className="hero">
        <div className="hero-header-block">
          <p className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Your AI Business Agent</p>
          <h1>What would you like<br />to do?</h1>
          <p className="hero-copy">Choose a starting point. We’ll use your active business, goals, and confirmed memory to build a practical next step.</p>
        </div>

        <div className="action-grid">
          {actions.map(([title, description], index) => (
            <button key={title} className="action-card" onClick={() => void startChat(title)}>
              <span className="action-number">0{index + 1}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
              <span className="action-arrow"><span className="action-arrow-glyph">→</span></span>
            </button>
          ))}
        </div>
      </section>
      <footer className="home-footer">
        Independent NPATI interface · Developed by the agent creators at{" "}
        <a href="https://www.npati.com/" target="_blank" rel="noreferrer">
          npati.com
        </a>
      </footer>
      <AuthModal
        isOpen={authModal.open}
        initialMode={authModal.mode}
        onClose={() => setAuthModal((prev) => ({ ...prev, open: false }))}
        onSuccess={() => navigate("/chat")}
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

function Sidebar() {
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

  async function createBusinessIdea() {
    const response = await authFetch("/api/business-onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "starting" }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      window.alert(payload?.error?.message ?? "Could not create a business idea.");
      return;
    }
    const session = await response.json() as { businessId: string };
    await refresh();
    navigate(`/b/${session.businessId}`);
  }
  async function openNewChat() {
    setChatOpen(true);
    cachedChatOpen = true;
    if (!currentBusiness) {
      const response = await authFetch("/api/conversations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "New conversation" }),
      });
      if (!response.ok) return;
      const conversation = await response.json() as { id: string };
      window.dispatchEvent(new Event("npati:conversations-changed"));
      navigate(`/c/${conversation.id}`, { state: { neutralChat: true } });
      return;
    }
    const response = await authFetch(`/api/businesses/${currentBusiness.id}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "New conversation" }),
    });
    if (!response.ok) return;
    const conversation = await response.json() as { id: string };
    window.dispatchEvent(new Event("npati:conversations-changed"));
    navigate(`/c/${conversation.id}`, { state: { businessId: currentBusiness.id } });
  }
  async function openBusiness(id: string) {
    await switchBusiness(id);
    navigate(`/b/${id}`);
  }
  function editBusiness(id: string) {
    navigate(`/settings/business/${id}`);
  }
  async function openConversation(conversation: SidebarConversation) {
    if (conversation.businessId && conversation.businessId !== currentBusiness?.id) await switchBusiness(conversation.businessId);
    navigate(`/c/${conversation.id}`, { state: conversation.businessId ? { businessId: conversation.businessId } : { neutralChat: true } });
  }
  async function renameConversation(conversation: SidebarConversation) {
    const title = window.prompt("Rename chat", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
    });
    if (response.ok) await loadConversations(true);
  }
  async function deleteConversation(conversation: SidebarConversation) {
    if (!window.confirm(`Delete chat “${conversation.title}”? This cannot be undone.`)) return;
    const endpoint = conversation.businessId
      ? `/api/businesses/${conversation.businessId}/conversations/${conversation.id}`
      : `/api/conversations/${conversation.id}`;
    const response = await authFetch(endpoint, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      window.alert(payload?.error?.message ?? "Could not delete this chat.");
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
    if (!window.confirm(`Delete business “${name}” and its chats, goals, and memory? This cannot be undone.`)) return;
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
    (c) => c.title !== "Business setup" && !onboardingConversationIds.has(c.id)
  );
  const hasSavedChats = chatConversations.length > 0;

  return (
    <aside className="sidebar">
      <Link className="brand sidebar-brand" to="/chat"><NpatiAgentLogo /></Link>
      <nav>
        <div className={`sidebar-group ${location.pathname === "/chat" || location.pathname.startsWith("/c/") ? "active" : ""}`}>
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => void openNewChat()}>+ New Chat</button>
            <button className="sidebar-chevron" aria-label="Show chat history" aria-expanded={chatOpen} onClick={() => setChatOpen((open) => { const next = !open; cachedChatOpen = next; return next; })}></button>
          </div>
          {chatOpen && (
            <div className="sidebar-dropdown">
              {!hasSavedChats && hasLoaded && <small className="sidebar-empty">No saved chats yet</small>}
              {chatConversations.map((conversation) => (
                <div className="sidebar-history-row" key={conversation.id}>
                  <button className="sidebar-history-link" onClick={() => void openConversation(conversation)}><span>{conversation.title}</span><small>{conversation.businessName ? `${conversation.businessName} · ` : ""}{new Date(conversation.updatedAt).toLocaleDateString()}</small></button>
                  <button className="sidebar-icon-action" aria-label={`Rename ${conversation.title}`} onClick={() => void renameConversation(conversation)}>✎</button>
                  <button className="sidebar-icon-action danger" aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={`sidebar-group sidebar-business-group ${location.pathname === "/business" || location.pathname.startsWith("/b/") ? "active" : ""}`}>
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => void createBusinessIdea()}>+ Business</button>
            <button className="sidebar-chevron" aria-label="Show businesses" aria-expanded={businessOpen} onClick={() => setBusinessOpen((open) => { const next = !open; cachedBusinessOpen = next; return next; })}></button>
          </div>
          {businessOpen && (
            <div className="sidebar-dropdown">
              {hasBusinessesLoaded && businesses.length === 0 && drafts.length === 0 && <small className="sidebar-empty">No businesses yet</small>}
              {drafts.map((draft) => (
                <div className="sidebar-history-row" key={draft.businessId}>
                  <button className="sidebar-history-link" onClick={() => navigate(`/b/${draft.businessId}`)}><span>{draft.business.name}</span><small>Setup draft</small></button>
                  <button className="sidebar-icon-action" aria-label={`Edit ${draft.business.name}`} onClick={() => editBusiness(draft.businessId)}>✎</button>
                  <button className="sidebar-icon-action danger" aria-label={`Delete ${draft.business.name}`} onClick={() => void deleteBusiness(draft.businessId, draft.business.name)}>×</button>
                </div>
              ))}
              {businesses.map((business) => (
                <div className="sidebar-history-row" key={business.id}>
                  <button className="sidebar-history-link" onClick={() => void openBusiness(business.id)}><span>{business.name}</span><small>{business.id === currentBusiness?.id ? "Current" : "Use in chat"}</small></button>
                  <button className="sidebar-icon-action" aria-label={`Edit ${business.name}`} onClick={() => editBusiness(business.id)}>✎</button>
                  <button className="sidebar-icon-action danger" aria-label={`Delete ${business.name}`} onClick={() => void deleteBusiness(business.id, business.name)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {navigation.map((item) => { const href = `/${item.toLowerCase()}`; return <Link key={item} className={`sidebar-settings-link ${location.pathname === href || location.pathname.startsWith(`${href}/`) ? "active" : ""}`} to={href}>{item}</Link>; })}
      </nav>
    </aside>
  );
}



function Workspace({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return <div className="workspace"><div className="workspace-notice">Loading workspace…</div></div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }
  const isChat = location.pathname === "/chat" || location.pathname.startsWith("/b/") || location.pathname.startsWith("/c/");
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");
  const isCompany = location.pathname === "/company";
  const isActivity = location.pathname === "/activity";
  const isAutomations = location.pathname === "/automations" || location.pathname.startsWith("/automations");
  const isGoals = location.pathname === "/goals" || location.pathname.startsWith("/goals");
  const isContent = location.pathname === "/content" || location.pathname.startsWith("/content");
  const isConnections = location.pathname === "/connections" || location.pathname.startsWith("/connections");
  const isMemory = location.pathname === "/memory" || location.pathname.startsWith("/memory");
  const isSkills = location.pathname === "/skills" || location.pathname.startsWith("/skills");
  return <div className="workspace"><Sidebar /><section className={`workspace-content ${isChat ? "chat-workspace-content" : ""} ${isSettings || isActivity || isAutomations || isGoals || isContent || isConnections || isMemory || isSkills ? "settings-workspace-content" : ""}`}>{isChat && <ChatUserMenu />}{!isChat && !isSettings && !isCompany && !isActivity && !isAutomations && !isGoals && !isContent && !isConnections && !isMemory && !isSkills && <div className="workspace-topbar"><BusinessSwitcher /></div>}{children}</section></div>;
}

function ChatRoute() {
  const location = useLocation();
  const newChatKey = (location.state as { newChat?: number } | null)?.newChat;
  return <Workspace><ConversationalChat key={newChatKey ? `chat-${newChatKey}` : "chat"} initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} /></Workspace>;
}

function BusinessRoute() {
  const { businessId = "" } = useParams();
  const { overview, loading, switchBusiness } = useWorkspace();
  const [error, setError] = useState("");
  const draft = overview?.onboardings.find((session) => session.businessId === businessId);
  const business = overview?.businesses.find((item) => item.id === businessId);

  useEffect(() => {
    if (loading || !business || overview?.currentBusiness?.id === businessId) return;
    void switchBusiness(businessId).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this business."));
  }, [businessId, business?.id, loading, overview?.currentBusiness?.id]);

  if (loading || (business && overview?.currentBusiness?.id !== businessId)) return <Workspace><div className="workspace-notice">Opening business…</div></Workspace>;
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
  const [resolved, setResolved] = useState(false);
  const [neutralChat, setNeutralChat] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const routeState = location.state as { businessId?: string; neutralChat?: boolean } | null;

  useEffect(() => {
    if (loading || !overview || !conversationId) return;
    let cancelled = false;
    async function resolveConversation() {
      setResolved(false);
      setNeutralChat(false);
      setNotFound(false);

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
  if (!resolved) return <Workspace><div className="workspace-notice">Opening chat…</div></Workspace>;
  return <Workspace><ConversationalChat initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} initialConversationId={conversationId} neutralChat={neutralChat} /></Workspace>;
}
import { AutomationsPage } from "./AutomationsPage";
import { ActivityPage } from "./ActivityPage";
import { CapabilityInspectorPage } from "./CapabilityInspectorPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { ContentPage } from "./ContentPage";

function SettingsPage() {
  const cards = [
    { to: "/settings/ai", icon: "AI", title: "AI Providers", description: "Connect providers, browse models, and choose AI routing." },
    { to: "/settings/business", icon: "B", title: "Business", description: "Analyze a business idea, market, goals and strategy." },
    { to: "/settings/company", icon: "CO", title: "Company", description: "Build your configurable AI team and agent organization." },
    { to: "/settings/dashboard", icon: "D", title: "Dashboard", description: "Monitor workspace activity and runtime service health." },
    { to: "/settings/capabilities", icon: "CP", title: "Capability Inspector", description: "Audit 306 canonical capabilities, tool visibility, and risk policies." },
    { to: "/settings/activity", icon: "AC", title: "Activity & Run Trace", description: "Inspect live execution traces, step delegations, and tool decisions." },
    { to: "/settings/automations", icon: "AU", title: "Automations", description: "Schedule recurring cron jobs and background agent tasks." },
    { to: "/settings/goals", icon: "G", title: "Goals", description: "Define and track measurable business outcomes." },
    { to: "/settings/content", icon: "C", title: "Content", description: "Plan, generate, and manage content for your audience." },
    { to: "/settings/connections", icon: "CN", title: "Connections", description: "Monitor service health and integrations." },
    { to: "/settings/memory", icon: "M", title: "Memory", description: "Review and edit confirmed business context." },
    { to: "/settings/skills", icon: "S", title: "Skills", description: "Browse the capabilities NPATI Agent can use." },
  ];

  return (
    <Workspace>
      <div className="page-heading settings-page-heading">
        <p className="eyebrow">NPATI workspace</p>
        <h1>Settings</h1>
        <p>Manage the services and preferences NPATI Agent uses locally.</p>
      </div>
      <div className="settings-card-grid">
        {cards.map((card) => (
          <Link className="settings-ai-card" to={card.to} key={card.title}>
            <span className="provider-avatar">{card.icon}</span>
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
  return <div className="health-card"><span className={`status-dot ${health?.status === "ok" ? "healthy" : ""}`} /><div><strong>{health?.status === "ok" ? "Agent API connected" : "Waiting for local services"}</strong><small>Database: {health?.services.database ?? "unknown"} · OmniRoute: {health?.services.omniroute ?? "unknown"} · Crawler: {health?.services.crawler ?? "unknown"} · Hub: {health?.services.hub ?? "unknown"}</small></div></div>;
}

export function App() {
  return (
    <AuthProvider>
      <WorkspaceProvider>
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
          <Route path="/dashboard" element={<Workspace><DashboardPage /></Workspace>} />
          <Route path="/settings/dashboard" element={<Workspace><DashboardPage /></Workspace>} />
          <Route path="/activity" element={<Workspace><ActivityPage /></Workspace>} />
          <Route path="/settings/activity" element={<Workspace><ActivityPage /></Workspace>} />
          <Route path="/content" element={<Workspace><ContentPage /></Workspace>} />
          <Route path="/settings/content" element={<Workspace><ContentPage /></Workspace>} />
          <Route path="/connections" element={<Workspace><ConnectionsPage /></Workspace>} />
          <Route path="/settings/connections" element={<Workspace><ConnectionsPage /></Workspace>} />
          <Route path="/automations" element={<Workspace><AutomationsPage /></Workspace>} />
          <Route path="/settings/automations" element={<Workspace><AutomationsPage /></Workspace>} />
          <Route path="/settings/capabilities" element={<Workspace><CapabilityInspectorPage /></Workspace>} />
          <Route path="/capabilities" element={<Navigate to="/settings/capabilities" replace />} />
          <Route path="/goals" element={<Workspace><GoalsPage /></Workspace>} />
          <Route path="/settings/goals" element={<Workspace><GoalsPage /></Workspace>} />
          <Route path="/memory" element={<Workspace><MemoryPage /></Workspace>} />
          <Route path="/settings/memory" element={<Workspace><MemoryPage /></Workspace>} />
          <Route path="/skills" element={<Workspace><SkillsPage /></Workspace>} />
          <Route path="/settings/skills" element={<Workspace><SkillsPage /></Workspace>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/ai" element={<Workspace><AIProviderMarketplace /></Workspace>} />
          <Route path="/settings/ai/oauth/callback" element={<OAuthCallback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </WorkspaceProvider>
    </AuthProvider>
  );
}
