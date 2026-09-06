import { brandConfig } from "@npati/branding";
import type { HealthResponse } from "@npati/shared";
import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { AIProviderMarketplace, OAuthCallback } from "./AIProviderMarketplace";
import { AuthProvider, useAuth, getStoredAuthToken } from "./AuthContext";
import { AuthModal } from "./AuthModal";
import {
  BusinessPage, BusinessSwitcher, GoalsPage, MemoryPage,
  SkillsPage, WorkspaceProvider, useWorkspace,
} from "./BusinessWorkspace";
import { ConversationalChat } from "./ConversationalChat";
import { CompanyPage } from "./CompanyPage";

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
type SidebarConversation = { id: string; title: string; updatedAt: string; businessId: string; businessName: string };

function BrandMark() { return <span className="brand-mark" aria-hidden="true">N</span>; }

function NpatiAgentLogo() {
  return (
    <span className="npati-agent-logo" aria-label="Npati">
      <span>Npati</span><span className="npati-agent-logo-dot" aria-hidden="true">.</span>
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
            <Link to="/business" onClick={closeMenu}>Business profile <span aria-hidden="true">&rarr;</span></Link>
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

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { overview, refresh, switchBusiness } = useWorkspace();
  const [chatOpen, setChatOpen] = useState(location.pathname === "/chat" || location.pathname.startsWith("/c/"));
  const [businessOpen, setBusinessOpen] = useState(location.pathname === "/business");
  const [conversations, setConversations] = useState<SidebarConversation[]>([]);
  const currentBusiness = overview?.currentBusiness;

  async function loadConversations() {
    const businesses = overview?.businesses ?? [];
    if (businesses.length === 0) { setConversations([]); return; }
    try {
      const rows = await Promise.all(businesses.map(async (business) => {
        const response = await authFetch(`/api/businesses/${business.id}/conversations`);
        if (!response.ok) return [];
        return (await response.json() as Omit<SidebarConversation, "businessId" | "businessName">[])
          .map((conversation) => ({ ...conversation, businessId: business.id, businessName: business.name }));
      }));
      setConversations(rows.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    } catch {
      setConversations([]);
    }
  }
  useEffect(() => {
    void loadConversations();
    const reload = () => void loadConversations();
    window.addEventListener("npati:conversations-changed", reload);
    return () => window.removeEventListener("npati:conversations-changed", reload);
  }, [overview?.businesses.map((business) => business.id).join(","), location.search]);

  async function openNewChat() {
    setChatOpen(true);
    if (!currentBusiness) {
      navigate("/chat");
      return;
    }
    const response = await authFetch(`/api/businesses/${currentBusiness.id}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "New conversation" }),
    });
    if (!response.ok) return;
    const conversation = await response.json() as { id: string };
    window.dispatchEvent(new Event("npati:conversations-changed"));
    navigate(`/c/${conversation.id}`);
  }
  async function openBusiness(id: string) {
    await switchBusiness(id);
    navigate("/business");
  }
  async function openConversation(conversation: SidebarConversation) {
    if (conversation.businessId !== currentBusiness?.id) await switchBusiness(conversation.businessId);
    navigate(`/c/${conversation.id}`);
  }
  async function renameConversation(conversation: SidebarConversation) {
    const title = window.prompt("Rename chat", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    const response = await authFetch(`/api/businesses/${conversation.businessId}/conversations/${conversation.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
    });
    if (response.ok) await loadConversations();
  }
  async function deleteConversation(conversation: SidebarConversation) {
    if (!window.confirm(`Delete chat “${conversation.title}”? This cannot be undone.`)) return;
    const response = await authFetch(`/api/businesses/${conversation.businessId}/conversations/${conversation.id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      window.alert(payload?.error?.message ?? "Could not delete this chat.");
      return;
    }
    const remaining = conversations.filter((item) => item.id !== conversation.id);
    setConversations(remaining);
    window.dispatchEvent(new Event("npati:conversations-changed"));
    if (location.pathname === `/c/${conversation.id}`) {
      const next = remaining[0];
      if (!next) {
        navigate("/chat", { replace: true });
      } else {
        if (next.businessId !== currentBusiness?.id) await switchBusiness(next.businessId);
        navigate(`/c/${next.id}`, { replace: true });
      }
    }
  }
  async function deleteBusiness(id: string, name: string) {
    if (!window.confirm(`Delete business “${name}” and its chats, goals, and memory? This cannot be undone.`)) return;
    const response = await authFetch(`/api/businesses/${id}`, { method: "DELETE" });
    if (response.ok) { await refresh(); navigate("/business"); }
  }
  return (
    <aside className="sidebar">
      <Link className="brand sidebar-brand" to="/"><NpatiAgentLogo /></Link>
      <nav>
        <div className={`sidebar-group ${location.pathname === "/chat" || location.pathname.startsWith("/c/") ? "active" : ""}`}>
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => void openNewChat()}>+ New Chat</button>
            <button className="sidebar-chevron" aria-label="Show chat history" aria-expanded={chatOpen} onClick={() => setChatOpen((open) => !open)}>⌄</button>
          </div>
          {chatOpen && (
            <div className="sidebar-dropdown">
              {!currentBusiness && overview?.onboarding && <button className="sidebar-history-link" onClick={() => navigate("/chat")}><span>Business setup</span><small>Draft</small></button>}
              {overview?.businesses.length !== 0 && conversations.length === 0 && <small className="sidebar-empty">No saved chats yet</small>}
              {conversations.map((conversation) => (
                <div className="sidebar-history-row" key={conversation.id}>
                  <button className="sidebar-history-link" onClick={() => void openConversation(conversation)}><span>{conversation.title}</span><small>{conversation.businessName} · {new Date(conversation.updatedAt).toLocaleDateString()}</small></button>
                  <button className="sidebar-icon-action" aria-label={`Rename ${conversation.title}`} onClick={() => void renameConversation(conversation)}>✎</button>
                  <button className="sidebar-icon-action danger" aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={`sidebar-group ${location.pathname === "/business" ? "active" : ""}`}>
          <div className="sidebar-group-head">
            <button className="sidebar-main-action" onClick={() => navigate("/business")}>Business</button>
            <button className="sidebar-chevron" aria-label="Show businesses" aria-expanded={businessOpen} onClick={() => setBusinessOpen((open) => !open)}>⌄</button>
          </div>
          {businessOpen && (
            <div className="sidebar-dropdown">
              {overview?.businesses.length === 0 && !overview.onboarding && <small className="sidebar-empty">No businesses yet</small>}
              {overview?.onboarding && <button className="sidebar-history-link" onClick={() => navigate("/business")}><span>{overview.onboarding.business.name}</span><small>Setup draft</small></button>}
              {overview?.businesses.map((business) => (
                <div className="sidebar-history-row" key={business.id}>
                  <button className="sidebar-history-link" onClick={() => void openBusiness(business.id)}><span>{business.name}</span><small>{business.id === currentBusiness?.id ? "Current" : "Open & edit"}</small></button>
                  <button className="sidebar-icon-action" aria-label={`Edit ${business.name}`} onClick={() => void openBusiness(business.id)}>✎</button>
                  <button className="sidebar-icon-action danger" aria-label={`Delete ${business.name}`} onClick={() => void deleteBusiness(business.id, business.name)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {navigation.map((item) => { const href = `/${item.toLowerCase()}`; return <Link key={item} className={location.pathname === href || location.pathname.startsWith(`${href}/`) ? "active" : ""} to={href}>{item}</Link>; })}
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
  const isChat = location.pathname === "/chat" || location.pathname.startsWith("/c/");
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");
  const isCompany = location.pathname === "/company";
  return <div className="workspace"><Sidebar /><section className={`workspace-content ${isChat ? "chat-workspace-content" : ""} ${isSettings ? "settings-workspace-content" : ""}`}>{isChat && <ChatUserMenu />}{!isChat && !isSettings && !isCompany && <div className="workspace-topbar"><BusinessSwitcher /></div>}{children}</section></div>;
}

function ChatRoute() {
  const location = useLocation();
  return <Workspace><ConversationalChat initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} /></Workspace>;
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
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (loading || !overview || !conversationId) return;
    let cancelled = false;
    async function resolveConversation() {
      setResolved(false);
      setNotFound(false);
      if (overview?.onboarding?.conversationId === conversationId) {
        if (!cancelled) setResolved(true);
        return;
      }
      for (const business of overview?.businesses ?? []) {
        const response = await authFetch(`/api/businesses/${business.id}/conversations/${conversationId}`);
        if (!response.ok) continue;
        if (business.id !== overview?.currentBusiness?.id) await switchBusiness(business.id);
        if (!cancelled) setResolved(true);
        return;
      }
      if (!cancelled) setNotFound(true);
    }
    void resolveConversation();
    return () => { cancelled = true; };
  }, [conversationId, loading, overview?.currentBusiness?.id, overview?.onboarding?.conversationId, overview?.businesses.map((business) => business.id).join(",")]);

  if (notFound) return <Workspace><div className="workspace-notice error">This chat does not exist or is not available to your user.</div></Workspace>;
  if (!resolved) return <Workspace><div className="workspace-notice">Opening chat…</div></Workspace>;
  return <Workspace><ConversationalChat initialPrompt={(location.state as { prompt?: string } | null)?.prompt ?? ""} initialConversationId={conversationId} /></Workspace>;
}

import { AutomationsPage } from "./AutomationsPage";
import { ActivityPage } from "./ActivityPage";
import { CapabilityInspectorPage } from "./CapabilityInspectorPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { ContentPage } from "./ContentPage";

function SettingsPage() {
  const cards = [
    { to: "/settings/ai", icon: "AI", title: "AI Providers", description: "Connect providers, browse models, and choose AI routing." },
    { to: "/settings/capabilities", icon: "CP", title: "Capability Inspector", description: "Audit 306 canonical capabilities, tool visibility, and risk policies." },
    { to: "/activity", icon: "AC", title: "Activity & Run Trace", description: "Inspect live execution traces, step delegations, and tool decisions." },
    { to: "/automations", icon: "AU", title: "Automations", description: "Schedule recurring cron jobs and background agent tasks." },
    { to: "/goals", icon: "G", title: "Goals", description: "Define and track measurable business outcomes." },
    { to: "/content", icon: "C", title: "Content", description: "Plan, generate, and manage content for your audience." },
    { to: "/connections", icon: "CN", title: "Connections", description: "Monitor service health and integrations." },
    { to: "/memory", icon: "M", title: "Memory", description: "Review and edit confirmed business context." },
    { to: "/skills", icon: "S", title: "Skills", description: "Browse the capabilities NPATI Agent can use." },
    { to: "/business", icon: "B", title: "Business", description: "Analyze a business idea, market, goals and strategy." },
    { to: "/company", icon: "CO", title: "Company", description: "Build your configurable AI team and agent organization." },
    { to: "/settings/ai", icon: "MO", title: "Models", description: "Browse OmniRoute models and manage the NPATI model library." },
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
          <Route path="/company" element={<Workspace><CompanyPage /></Workspace>} />
          <Route path="/activity" element={<Workspace><ActivityPage /></Workspace>} />
          <Route path="/content" element={<Workspace><ContentPage /></Workspace>} />
          <Route path="/connections" element={<Workspace><ConnectionsPage /></Workspace>} />
          <Route path="/automations" element={<Workspace><AutomationsPage /></Workspace>} />
          <Route path="/settings/automations" element={<Workspace><AutomationsPage /></Workspace>} />
          <Route path="/settings/capabilities" element={<Workspace><CapabilityInspectorPage /></Workspace>} />
          <Route path="/capabilities" element={<Navigate to="/settings/capabilities" replace />} />
          <Route path="/goals" element={<Workspace><GoalsPage /></Workspace>} />
          <Route path="/memory" element={<Workspace><MemoryPage /></Workspace>} />
          <Route path="/skills" element={<Workspace><SkillsPage /></Workspace>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/ai" element={<Workspace><AIProviderMarketplace /></Workspace>} />
          <Route path="/settings/ai/oauth/callback" element={<OAuthCallback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </WorkspaceProvider>
    </AuthProvider>
  );
}
