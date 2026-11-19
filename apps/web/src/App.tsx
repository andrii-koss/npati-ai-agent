import { brandConfig } from "@npati/branding";
import { chatOpenData } from "./chat-open";
import type { HealthResponse } from "@npati/shared";
import { ComponentType, ReactNode, Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  authFetch,
  authHeaders,
  BrandMark,
  Home,
  IconMenu,
  NpatiAgentLogo,
  NPATI_API_BASE,
  Sidebar,
} from "./shell";
import { AuthProvider, getStoredAuthToken, useAuth } from "./AuthContext";
import {
  BusinessPage,
  BusinessSwitcher,
  SkillsPage,
  useWorkspace,
  WorkspaceProvider,
} from "./BusinessWorkspace";
import { ConfirmDialogContainer, alertModal } from "./ConfirmDialog";
import { ConversationalChat } from "./ConversationalChat";
import { prefetchProjectCatalog } from "./project-catalog-client";
import { prefetchSettingsPage } from "./settings-prefetch";
import { I18nProvider, useTranslation } from "./i18n";
import { ChatAvatarImage } from "./ChatAvatarImage";

// Pages other than the chat load when first opened: the chat page does not download and parse their code.
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}
const ActivityPage = lazyPage(() => import("./ActivityPage"), "ActivityPage");
const AutomationsPage = lazyPage(() => import("./AutomationsPage"), "AutomationsPage");
const CapabilityInspectorPage = lazyPage(() => import("./CapabilityInspectorPage"), "CapabilityInspectorPage");
const CodeAgentsPage = lazyPage(() => import("./CodeAgentsPage"), "CodeAgentsPage");
const CodeWorkspacePage = lazyPage(() => import("./CodeWorkspacePage"), "CodeWorkspacePage");
const CompanyPage = lazyPage(() => import("./CompanyPage"), "CompanyPage");
const ConnectionsPage = lazyPage(() => import("./ConnectionsPage"), "ConnectionsPage");
const ContentPage = lazyPage(() => import("./ContentPage"), "ContentPage");
const DataStudioPage = lazyPage(() => import("./DataStudioPage"), "DataStudioPage");
const DataStudioSettingsPage = lazyPage(() => import("./DataStudioSettingsPage"), "DataStudioSettingsPage");
const EmailInboxPage = lazyPage(() => import("./EmailInboxPage"), "EmailInboxPage");
const EmailSettingsPage = lazyPage(() => import("./EmailSettingsPage"), "EmailSettingsPage");
const GoalsPage = lazyPage(() => import("./GoalsPage"), "GoalsPage");
const IntegrationsPage = lazyPage(() => import("./IntegrationsPage"), "IntegrationsPage");
const MemoryPage = lazyPage(() => import("./MemoryPage"), "MemoryPage");
const ProjectPage = lazyPage(() => import("./ProjectPage"), "ProjectPage");
const WebsiteBuilderDashboard = lazyPage(() => import("./WebsiteBuilderDashboard"), "WebsiteBuilderDashboard");
const AIProviderMarketplace = lazyPage(() => import("./AIProviderMarketplace"), "AIProviderMarketplace");
const OAuthCallback = lazyPage(() => import("./AIProviderMarketplace"), "OAuthCallback");

export { authFetch, authHeaders, BrandMark, NpatiAgentLogo };

function resolveNpatiAvatarUrl(value?: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.replace(/^\/+/, "");
  const path = normalized.startsWith("assets/") || normalized.startsWith("uploads/") ? normalized : `assets/${normalized}`;
  return `${NPATI_API_BASE}/${path}`;
}

export function ChatUserMenu() {
  const { t, language } = useTranslation();
  const location = useLocation();
  const { overview } = useWorkspace();
  const { user, signOutEverywhere } = useAuth();
  const [open, setOpen] = useState(false);
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
        <ChatAvatarImage key={user?.id} url={avatarUrl} initials={initials} />
      </button>
      {open && (
        <aside className="chat-user-popover" id="chat-user-popover" aria-label="User links">
          <div className="chat-user-summary">
            <span className="chat-user-avatar chat-user-avatar-small" aria-hidden="true">
              <ChatAvatarImage key={user?.id} url={avatarUrl} initials={initials} />
            </span>
            <span><strong>{displayName}</strong><small>{email}</small></span>
          </div>
          <div className="chat-user-role-row">
            <span className="chat-user-role">{overview?.workspace.role || "member"}</span>
            <a className="chat-user-support" href="https://www.npati.com/support" target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
              {language === "uk" ? "Підтримка" : "Support"}
            </a>
          </div>
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
            <button
              type="button"
              className="chat-user-signout chat-user-signout-all"
              onClick={() => {
                closeMenu();
                void signOutEverywhere(true).catch((cause) => alertModal({
                  title: t("userMenu.signOutIncompleteTitle"),
                  message: cause instanceof Error ? cause.message : t("userMenu.signOutIncompleteDesc"),
                }));
              }}
            >
              {t("userMenu.signOutAllDevices")} <span aria-hidden="true">&rarr;</span>
            </button>
          </nav>
        </aside>
      )}
    </div>
  );
}

function FullscreenRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading && !isAuthenticated) {
    return <div className="workspace" />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }
  return <div className="npati-fullscreen-editor-shell">{children}</div>;
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
  const isCompany = location.pathname === "/company" || location.pathname.startsWith("/companies");
  const isActivity = location.pathname === "/activity";
  const isAutomations = location.pathname === "/automations" || location.pathname.startsWith("/automations");
  const isGoals = location.pathname === "/goals" || location.pathname.startsWith("/goals");
  const isContent = location.pathname === "/content" || location.pathname.startsWith("/content");
  const isConnections = location.pathname === "/connections" || location.pathname.startsWith("/connections");
  const isMemory = location.pathname === "/memory" || location.pathname.startsWith("/memory");
  const isSkills = location.pathname === "/skills" || location.pathname.startsWith("/skills");
  const isInbox = location.pathname.startsWith("/inbox") || location.pathname.startsWith("/settings/email/inbox");
  const isProjects = location.pathname.startsWith("/projects");
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
      <section className={`workspace-content ${isChat ? "chat-workspace-content" : ""} ${isSettings || isProjects || isCompany || isActivity || isAutomations || isGoals || isContent || isConnections || isMemory || isSkills || isInbox ? "settings-workspace-content" : ""}`}>
        {isChat && <ChatUserMenu />}
        {!isChat && !isSettings && !isProjects && !isCompany && !isActivity && !isAutomations && !isGoals && !isContent && !isConnections && !isMemory && !isSkills && !isInbox && <div className="workspace-topbar"><BusinessSwitcher /></div>}
        {children}
      </section>
    </div>
  );
}

function ChatRoute() {
  const location = useLocation();
  const newChatKey = (location.state as { newChat?: number } | null)?.newChat;
  return <Workspace><ConversationalChat key={newChatKey ? `chat-${newChatKey}` : `chat${location.search}`} initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} /></Workspace>;
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

function WebsiteChatRoute() {
  const { companyId = "", projectId = "" } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`/chat?company=${encodeURIComponent(companyId)}&project=${encodeURIComponent(projectId)}`}
      state={location.state}
      replace
    />
  );
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
      // The chat page's single open request tells whether this is a neutral chat (it carries its latest messages).
      const opened = chatOpenData(conversationId);
      const neutral = opened
        ? Boolean((await opened.catch(() => null))?.conversation)
        : (await authFetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=1`)).ok;
      if (neutral) {
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
        businessRoute={!neutralChat}
      />
    </Workspace>
  );
}

function SettingsPage() {
  const { t, language } = useTranslation();
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
      to: "/settings/projects",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
      title: language === "uk" ? "Проєкти" : "Projects",
      description: language === "uk" ? "Сайти, вебзастосунки, ігри та мобільні застосунки, які створює й редагує AI." : "Websites, web apps, games and mobile apps created and edited with AI.",
    },
    {
      to: "/settings/code",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      ),
      title: language === "uk" ? "Код" : "Code",
      description: language === "uk"
        ? "Код-проєкти та сесії Coding Agent (експериментально, за feature flags)."
        : "Code projects and Coding Agent sessions (experimental, behind feature flags).",
    },
    {
      to: "/settings/data-studio",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
        </svg>
      ),
      title: "Data Studio",
      description: language === "uk" ? "Таблиці, схеми та дані ваших проєктів" : "Tables, schemas and data for your projects",
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
          <Link className="settings-ai-card" to={card.to} key={card.to} onMouseEnter={() => { if (card.to === "/settings/projects") prefetchProjectCatalog(); else prefetchSettingsPage(card.to); }} onFocus={() => { if (card.to === "/settings/projects") prefetchProjectCatalog(); else prefetchSettingsPage(card.to); }}>
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

/**
 * An old "/projects/:projectId" link names no company. The project's own company is found among the user's companies;
 * the link used a Business ID as the company before, so the project was never found and the catalog opened instead.
 */
function LegacyProjectRedirect() {
  const { projectId = "" } = useParams();
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const found = await findProjectCompany(projectId).catch(() => null);
      if (active) setTarget(found ? `/settings/projects/${encodeURIComponent(found)}/${encodeURIComponent(projectId)}` : "/settings/projects");
    })();
    return () => { active = false; };
  }, [projectId]);
  return target ? <Navigate to={target} replace /> : null;
}

async function findProjectCompany(projectId: string): Promise<string | null> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const list = await fetch("/api/companies?limit=100", { headers }).then((response) => response.ok ? response.json() : { companies: [] }) as { companies?: Array<{ id: string }> };
  for (const company of list.companies ?? []) {
    const response = await fetch(`/api/companies/${encodeURIComponent(company.id)}/projects/${encodeURIComponent(projectId)}`, { headers });
    if (response.ok) return company.id;
  }
  return null;
}

export function App() {
  const { pathname } = useLocation();
  const route = pathname.replace(/\/$/, "");
  return (
    <I18nProvider>
      <AuthProvider>
        <WorkspaceProvider deferInitialOverview={route === "/settings/content" || route === "/content" || route === "/settings/email"}>
          <ConfirmDialogContainer />
          <Suspense fallback={<div className="workspace" />}>
          <Routes>
            <Route path="/" element={<Home userMenu={<ChatUserMenu />} logo={<NpatiAgentLogo />} />} />
            <Route path="/chat" element={<LegacyChatRoute />} />
            <Route path="/c/:conversationId" element={<CanonicalChatRoute />} />
            <Route path="/business" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/b/:businessId" element={<BusinessRoute />} />
            <Route path="/settings/business" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/settings/business/:businessId" element={<Workspace><BusinessPage /></Workspace>} />
            <Route path="/company" element={<Workspace><CompanyPage /></Workspace>} />
            <Route path="/settings/company" element={<Workspace><CompanyPage /></Workspace>} />
            <Route path="/settings/projects" element={<Workspace><WebsiteBuilderDashboard /></Workspace>} />
            <Route path="/settings/projects/:companyId/:projectId" element={<WebsiteChatRoute />} />
            {/* Websites became Projects; old bookmarks and chat links keep working. */}
            <Route path="/settings/websites" element={<Navigate to="/settings/projects" replace />} />
            <Route path="/settings/websites/:companyId/:projectId" element={<WebsiteChatRoute />} />
            <Route path="/projects/:companyId/:projectId" element={<WebsiteChatRoute />} />
            <Route path="/companies/:companyId/projects/:projectId/data" element={<Workspace><DataStudioPage /></Workspace>} />
            <Route path="/projects/:companyId/:projectId/data" element={<Workspace><DataStudioPage /></Workspace>} />
            <Route path="/projects/:projectId" element={<LegacyProjectRedirect />} />
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
            <Route path="/settings/data-studio/:databaseName?" element={<Workspace><DataStudioSettingsPage /></Workspace>} />
            <Route path="/settings/code" element={<Workspace><CodeAgentsPage /></Workspace>} />
            <Route path="/settings/code/:companyId/:projectId" element={<Workspace><CodeWorkspacePage /></Workspace>} />
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
          </Suspense>
        </WorkspaceProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
