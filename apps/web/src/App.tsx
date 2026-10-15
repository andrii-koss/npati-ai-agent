import { brandConfig } from "@npati/branding";
import type { HealthResponse } from "@npati/shared";
import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ActivityPage } from "./ActivityPage";
import { AIProviderMarketplace, OAuthCallback } from "./AIProviderMarketplace";
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
import { AuthProvider, useAuth } from "./AuthContext";
import { AutomationsPage } from "./AutomationsPage";
import {
  BusinessPage,
  BusinessSwitcher,
  SkillsPage,
  useWorkspace,
  WorkspaceProvider,
} from "./BusinessWorkspace";
import { CapabilityInspectorPage } from "./CapabilityInspectorPage";
import { CodeAgentsPage } from "./CodeAgentsPage";
import { CodeWorkspacePage } from "./CodeWorkspacePage";
import { CompanyPage } from "./CompanyPage";
import { ConfirmDialogContainer, alertModal } from "./ConfirmDialog";
import { ConnectionsPage } from "./ConnectionsPage";
import { ContentPage } from "./ContentPage";
import { ConversationalChat } from "./ConversationalChat";
import { DataStudioPage } from "./DataStudioPage";
import { DataStudioSettingsPage } from "./DataStudioSettingsPage";
import { EmailInboxPage } from "./EmailInboxPage";
import { EmailSettingsPage } from "./EmailSettingsPage";
import { GoalsPage } from "./GoalsPage";
import { I18nProvider, useTranslation } from "./i18n";
import { IntegrationsPage } from "./IntegrationsPage";
import { MemoryPage } from "./MemoryPage";
import { ProjectPage } from "./ProjectPage";
import { WebsiteBuilderDashboard } from "./WebsiteBuilderDashboard";

export { authFetch, authHeaders, BrandMark, NpatiAgentLogo };

function resolveNpatiAvatarUrl(value?: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.replace(/^\/+/, "");
  const path = normalized.startsWith("assets/") || normalized.startsWith("uploads/") ? normalized : `assets/${normalized}`;
  return `${NPATI_API_BASE}/${path}`;
}

export function ChatUserMenu() {
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
  const isCompany = location.pathname === "/company";
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
      <section className={`workspace-content ${isChat ? "chat-workspace-content" : ""} ${isSettings || isProjects || isActivity || isAutomations || isGoals || isContent || isConnections || isMemory || isSkills || isInbox ? "settings-workspace-content" : ""}`}>
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
          <path d="M3 21h18" />
          <path d="M5 21V7l8-4v18" />
          <path d="M19 21V11l-6-3" />
          <path d="M9 9v.01" />
          <path d="M9 12v.01" />
          <path d="M9 15v.01" />
          <path d="M9 18v.01" />
        </svg>
      ),
      title: t("settings.cards.businessProfile.title"),
      description: t("settings.cards.businessProfile.desc"),
    },
    {
      to: "/settings/websites",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
      title: t("settings.cards.websites.title"),
      description: t("settings.cards.websites.desc"),
    },
    {
      to: "/settings/data-studio",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      ),
      title: "Data Studio",
      description: "Project databases, visual schema designer, row editors, migration logs, and secure public read/write endpoints.",
    },
    {
      to: "/settings/code",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      ),
      title: "Coding Agents",
      description: "Full-stack dev workspace, git worktrees, task runner, and sandbox runtime environments.",
    },
    {
      to: "/settings/company",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
          <line x1="9" y1="22" x2="9" y2="22.01" />
          <line x1="15" y1="22" x2="15" y2="22.01" />
          <line x1="8" y1="6" x2="8" y2="6.01" />
          <line x1="16" y1="6" x2="16" y2="6.01" />
          <line x1="8" y1="10" x2="8" y2="10.01" />
          <line x1="16" y1="10" x2="16" y2="10.01" />
          <line x1="8" y1="14" x2="8" y2="14.01" />
          <line x1="16" y1="14" x2="16" y2="14.01" />
          <line x1="8" y1="18" x2="8" y2="18.01" />
          <line x1="16" y1="18" x2="16" y2="18.01" />
        </svg>
      ),
      title: t("settings.cards.company.title"),
      description: t("settings.cards.company.desc"),
    },
    {
      to: "/settings/activity",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      title: t("settings.cards.activity.title"),
      description: t("settings.cards.activity.desc"),
    },
    {
      to: "/settings/content",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
      title: t("settings.cards.content.title"),
      description: t("settings.cards.content.desc"),
    },
    {
      to: "/settings/connections",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      ),
      title: t("settings.cards.connections.title"),
      description: t("settings.cards.connections.desc"),
    },
    {
      to: "/settings/automations",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      title: t("settings.cards.automations.title"),
      description: t("settings.cards.automations.desc"),
    },
    {
      to: "/settings/email",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      ),
      title: t("settings.cards.email.title"),
      description: t("settings.cards.email.desc"),
    },
    {
      to: "/settings/capabilities",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      ),
      title: t("settings.cards.capabilities.title"),
      description: t("settings.cards.capabilities.desc"),
    },
    {
      to: "/settings/memory",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
          <line x1="9" y1="21" x2="15" y2="21" />
        </svg>
      ),
      title: t("settings.cards.memory.title"),
      description: t("settings.cards.memory.desc"),
    },
    {
      to: "/settings/skills",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
      title: t("settings.cards.skills.title"),
      description: t("settings.cards.skills.desc"),
    },
  ];

  return (
    <Workspace>
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

function LegacyProjectRedirect() {
  const { projectId = "" } = useParams();
  const { overview } = useWorkspace();
  const companyId = overview?.currentBusiness?.id || overview?.businesses[0]?.id || "";
  if (!companyId) return <Navigate to="/settings/websites" replace />;
  return <Navigate to={`/settings/websites/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`} replace />;
}

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <WorkspaceProvider>
          <ConfirmDialogContainer />
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
            <Route path="/settings/websites" element={<Workspace><WebsiteBuilderDashboard /></Workspace>} />
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
            <Route path="/settings/data-studio" element={<Workspace><DataStudioSettingsPage /></Workspace>} />
            <Route path="/settings/code" element={<Workspace><CodeAgentsPage /></Workspace>} />
            <Route path="/settings/code/:companyId/:projectId" element={<FullscreenRoute><CodeWorkspacePage /></FullscreenRoute>} />
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
