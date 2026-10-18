import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "./i18n";
import { CodeSettingsPage } from "./CodeSettingsPage";
import type { Provider } from "./ai-marketplace-types";
import {
  api,
  Badge,
  ProviderCard,
  ProviderDrawer,
  ProviderIcon,
} from "./AIProviderMarketplace";

interface CodePreferences {
  activeAgentId: string;
  activeAgentName: string;
  activeModelId?: string | null;
  enabledAgentIds: string[];
}

interface BuiltInAgent {
  id: string;
  name: string;
  builtIn: boolean;
  connected: boolean;
  category: string;
  description: string;
  capabilities: string[];
}

const DEFAULT_BUILTIN: BuiltInAgent = {
  id: "npati",
  name: "Npati Code",
  builtIn: true,
  connected: true,
  category: "built-in",
  description: "Built-in NPATI coding agent with full workspace, repository, sandbox, browser, website builder and tool access.",
  capabilities: ["code", "projects", "repositories", "sessions", "terminal", "sandbox", "preview", "browser", "datastudio"],
};

const settingsUrl = (id: string) => `/settings/code?agent=${encodeURIComponent(id)}`;

function AgentIcon({ size, small = false }: { size?: "small" | "large"; small?: boolean }) {
  const isSmall = size === "small" || small;
  const isLarge = size === "large";
  return (
    <span
      className={`provider-avatar code-agent-avatar${isSmall ? " small" : ""}${isLarge ? " large" : ""}`}
      aria-hidden="true"
    >
      <img src="/npati-auto.png" alt="NPATI" />
    </span>
  );
}

export function CodeAgentsPage() {
  const [params] = useSearchParams();
  if (params.get("agent") === "npati") {
    return <CodeSettingsPage />;
  }
  return <CodeAgentsCatalog />;
}

function CodeAgentsCatalog() {
  const { language, t } = useTranslation();
  const translate = typeof t === "function" ? t : ((_path: string, _params?: Record<string, string | number>) => "");
  const isUk = language === "uk";

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "recommended" | "connected" | "builtIn">("all");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [builtIn, setBuiltIn] = useState<BuiltInAgent>(DEFAULT_BUILTIN);
  const [preferences, setPreferences] = useState<CodePreferences>({
    activeAgentId: "npati",
    activeAgentName: "Npati Code",
    activeModelId: null,
    enabledAgentIds: ["npati"],
  });
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [builtinDrawerOpen, setBuiltinDrawerOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");

  const loadData = useCallback(async () => {
    try {
      const res = await api<{
        preferences: CodePreferences;
        builtIn: BuiltInAgent;
        providers: Provider[];
      }>("/api/code/agents");
      if (res.preferences) setPreferences(res.preferences);
      if (res.builtIn) setBuiltIn(res.builtIn);
      if (Array.isArray(res.providers)) setProviders(res.providers);
    } catch {
      // In SSR or static render tests, gracefully retain default state
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 3500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const handleSetActive = async (agentId: string, name: string) => {
    setBusy(agentId);
    try {
      const updated = await api<CodePreferences>(`/api/code/agents/${encodeURIComponent(agentId)}/active`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setPreferences(updated);
      setFeedback(isUk ? `Активним агентом обрано ${name}` : `Active agent switched to ${name}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : isUk ? "Помилка зміни активного агента" : "Failed to switch active agent");
    } finally {
      setBusy("");
    }
  };

  const handleToggle = async (agentId: string, currentEnabled: boolean) => {
    setBusy(agentId);
    try {
      const updated = await api<CodePreferences>(`/api/code/agents/${encodeURIComponent(agentId)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      setPreferences(updated);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : isUk ? "Помилка перемикання агента" : "Failed to toggle agent");
    } finally {
      setBusy("");
    }
  };

  const handleRemove = async (agentId: string, agentName: string) => {
    setBusy(agentId);
    setFeedback("");
    try {
      const updated = await api<CodePreferences>(`/api/code/agents/${encodeURIComponent(agentId)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      });
      setPreferences(updated);
      setFeedback(isUk ? `Агента «${agentName}» видалено з бібліотеки.` : `Agent "${agentName}" removed from library.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : isUk ? "Помилка видалення агента" : "Failed to remove agent");
    } finally {
      setBusy("");
    }
  };

  // Connected agents for filters
  const connectedProviders = useMemo(() => {
    return providers.filter((p) => p.connected);
  }, [providers]);

  // Enabled / added agents for "My Agents" (Library)
  const myAgents = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      providerName: string;
      description?: string;
      isBuiltIn: boolean;
    }> = [];
    if (preferences.enabledAgentIds.includes("npati")) {
      list.push({
        id: "npati",
        name: builtIn.name,
        providerName: "NPATI",
        description: builtIn.description,
        isBuiltIn: true,
      });
    }
    for (const p of providers) {
      if (p.connected && preferences.enabledAgentIds.includes(p.id)) {
        list.push({
          id: p.id,
          name: p.name,
          providerName: p.name,
          description: p.description,
          isBuiltIn: false,
        });
      }
    }
    return list;
  }, [preferences.enabledAgentIds, builtIn.name, builtIn.description, providers]);

  const isNpatiEnabled = preferences.enabledAgentIds.includes("npati");
  const builtInCount = isNpatiEnabled ? 1 : 0;

  // Total agents count includes builtIn + providers
  const totalAgentsCount = 1 + providers.length;
  const connectedAgentsCount = builtInCount + connectedProviders.length;

  // Filtered providers for explore grid
  const visibleProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (tab === "connected" && !p.connected) return false;
      if (tab === "recommended" && !p.recommended) return false;
      if (tab === "builtIn") return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.capabilities?.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [providers, tab, search]);

  const showBuiltInInGrid = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || (
      builtIn.name.toLowerCase().includes(q) ||
      builtIn.description.toLowerCase().includes(q) ||
      (isUk ? "кодінг агент проєкти репозиторії" : "coding agent projects repositories").includes(q)
    );
    if (!matchesSearch) return false;

    if (tab === "builtIn") {
      return isNpatiEnabled;
    }
    if (tab === "connected") {
      return isNpatiEnabled && builtIn.connected;
    }
    if (tab === "recommended") {
      return isNpatiEnabled;
    }
    if (tab === "all") {
      return true;
    }
    return false;
  }, [tab, search, builtIn, isUk, isNpatiEnabled]);

  const filterTabs = [
    { id: "all", label: isUk ? "Усі" : "All", count: totalAgentsCount },
    { id: "recommended", label: isUk ? "Рекомендовані" : "Recommended", count: builtInCount + providers.filter((p) => p.recommended).length },
    { id: "connected", label: isUk ? "Підключені" : "Connected", count: connectedAgentsCount },
    { id: "builtIn", label: isUk ? "Вбудовані" : "Built-in", count: builtInCount },
  ] as const;

  const activeAgentIsNpati = preferences.activeAgentId === "npati";
  const activeAgent = activeAgentIsNpati
    ? builtIn
    : providers.find((p) => p.id === preferences.activeAgentId) || {
        id: preferences.activeAgentId,
        name: preferences.activeAgentName,
        connected: true,
        category: "external",
        description: isUk ? "Підключений зовнішній Coding Agent через OmniRoute." : "Connected external Coding Agent via OmniRoute.",
        capabilities: ["code", "projects", "sandbox", "terminal"],
      };

  const defaultBadgeLabel = translate("aiMarketplace.myModels.defaultBadge") || "DEFAULT";
  const setDefaultLabel = translate("aiMarketplace.myModels.setDefault") || (isUk ? "Зробити основним" : "Set as default");
  const removeLabel = translate("aiMarketplace.myModels.remove") || (isUk ? "Видалити" : "Remove");
  const settingsLabel = isUk ? "Налаштування" : "Settings";
  const activeLabel = isUk ? "АКТИВНИЙ" : "ACTIVE";

  return (
    <main className="ai-marketplace code-agents-catalog">
      <header className="marketplace-hero">
        <div>
          <p className="eyebrow">{isUk ? "Налаштування · Code" : "Settings · Code"}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={isUk ? "Назад до налаштувань" : "Back to settings"}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>{isUk ? "Кодінг-агенти" : "Coding Agents"}</span>
          </h1>
          <p>
            {isUk
              ? "Обирайте активного кодінг-агента для NPATI Chat, підключайте зовнішніх агентів (Claude Code, OpenAI Codex тощо) та керуйте доступом до інструментів."
              : "Select the active coding agent for NPATI Chat, connect external agents (Claude Code, OpenAI Codex, etc.), and manage access to development tools."}
          </p>
        </div>
      </header>

      {feedback && <div className="inline-message" role="status" style={{ margin: "16px 0" }}>{feedback}</div>}

      <section className="overview-grid" aria-label={isUk ? "Огляд агентів" : "Agent overview"}>
        <div><strong>{totalAgentsCount}</strong><span>{isUk ? "Агентів у каталозі" : "Agents in catalog"}</span></div>
        <div><strong>{providers.length + 1}</strong><span>{isUk ? "Доступних інтеграцій" : "Available integrations"}</span></div>
        <div><strong>{myAgents.length}</strong><span>{isUk ? "Доданих агентів" : "Added agents"}</span></div>
        <div><strong>{builtInCount}</strong><span>{isUk ? "Вбудованих агентів" : "Built-in agents"}</span></div>
      </section>

      {/* My Agents / Library */}
      <section className="my-models">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{translate("aiMarketplace.myModels.kicker") || (isUk ? "Бібліотека" : "Library")}</p>
            <h2>{isUk ? "Мої агенти" : "My Agents"}</h2>
          </div>
          <span>
            {translate("aiMarketplace.myModels.addedCount", { count: String(myAgents.length) }) ||
              (isUk ? `${myAgents.length} додано` : `${myAgents.length} added`)}
          </span>
        </div>
        {myAgents.length === 0 ? (
          <div className="empty-inline">
            <strong>{isUk ? "Ще не додано жодного агента." : "No agents added yet."}</strong>
            <span>{isUk ? "Увімкніть Npati Code або додайте агента з каталогу нижче." : "Enable Npati Code or add an agent from the catalog below."}</span>
          </div>
        ) : (
          <div className="my-model-list">
            {myAgents.map((agent) => {
              const isDefault = preferences.activeAgentId === agent.id;
              return (
                <div key={agent.id} className="my-model-row">
                  {agent.isBuiltIn ? (
                    <AgentIcon small />
                  ) : (
                    <ProviderIcon providerId={agent.id} name={agent.name} size="small" />
                  )}
                  <span>
                    <strong>{agent.name}</strong>
                    <small>via {agent.providerName}</small>
                  </span>
                  {isDefault && <Badge tone="red">{defaultBadgeLabel}</Badge>}
                  <button
                    type="button"
                    disabled={isDefault || busy === agent.id}
                    onClick={() => handleSetActive(agent.id, agent.name)}
                  >
                    {setDefaultLabel}
                  </button>
                  <button
                    type="button"
                    className="text-danger"
                    disabled={busy === agent.id}
                    onClick={() => handleRemove(agent.id, agent.name)}
                  >
                    {removeLabel}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Explore Agents / Catalog */}
      <section className="explore-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{isUk ? "Каталог" : "Discovery"}</p>
            <h2>{isUk ? "Огляд агентів" : "Explore Agents"}</h2>
          </div>
        </div>
        <div className="marketplace-controls">
          <div className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label={isUk ? "Пошук агентів" : "Search agents"}
              placeholder={isUk ? "Пошук кодінг-агентів…" : "Search coding agents…"}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="marketplace-tabs" aria-label={isUk ? "Фільтри агентів" : "Agent filters"}>
            {filterTabs.map((item) => (
              <button
                type="button"
                key={item.id}
                className={tab === item.id ? "active" : ""}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.count}</small>
              </button>
            ))}
          </div>
        </div>

        <p className="showing-copy" role="status">
          {isUk
            ? `Показано ${visibleProviders.length + (showBuiltInInGrid ? 1 : 0)} з ${totalAgentsCount} агентів`
            : `Showing ${visibleProviders.length + (showBuiltInInGrid ? 1 : 0)} of ${totalAgentsCount} agents`}
        </p>

        {visibleProviders.length === 0 && !showBuiltInInGrid ? (
          <div className="empty-inline">
            <strong>{isUk ? "Агентів не знайдено" : "No agents found"}</strong>
            <span>{isUk ? "Спробуйте інший запит або фільтр." : "Try another search or filter."}</span>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setSearch("");
                setTab("all");
              }}
            >
              {isUk ? "Скинути фільтри" : "Reset filters"}
            </button>
          </div>
        ) : (
          <div className="provider-grid">
            {/* Built-in NPATI Card in Explore Grid */}
            {showBuiltInInGrid && (
              <article className="provider-card is-connected" key="npati-card">
                <div
                  className="provider-card-main"
                  role="button"
                  tabIndex={0}
                  onClick={() => setBuiltinDrawerOpen(true)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setBuiltinDrawerOpen(true); }}
                  style={{ cursor: "pointer" }}
                >
                  <AgentIcon />
                  <span className="provider-title">
                    <strong>{builtIn.name}</strong>
                    <small>{isUk ? "Вбудований агент" : "Built-in agent"}</small>
                  </span>
                  <span
                    className={`connection-light ${preferences.enabledAgentIds.includes("npati") ? "on" : "off"}`}
                    aria-label={preferences.enabledAgentIds.includes("npati") ? (isUk ? "Увімкнено" : "Enabled") : (isUk ? "Вимкнено" : "Disabled")}
                  />
                </div>
                <div className="provider-badges">
                  <span className="ai-badge">{isUk ? "Вбудований" : "Built-in"}</span>
                  <span className="ai-badge red">{isUk ? "Рекомендовано" : "Recommended"}</span>
                  {activeAgentIsNpati && <span className="ai-badge connected">{activeLabel}</span>}
                  {!preferences.enabledAgentIds.includes("npati") && <span className="ai-badge">{isUk ? "Вимкнено" : "Disabled"}</span>}
                </div>
                <p className="provider-description">
                  {isUk
                    ? "Працюйте з репозиторіями, запускайте сесії агента та керуйте інструментами розробки в NPATI."
                    : "Work with repositories, launch agent sessions and manage development tools in NPATI."}
                </p>
                <div className="capability-row">
                  {(isUk
                    ? ["Проєкти", "Репозиторії", "Сесії", "Інструменти"]
                    : ["Projects", "Repositories", "Sessions", "Tools"]
                  ).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                <div className="provider-card-footer">
                  <span>{isUk ? "Від NPATI" : "By NPATI"}</span>
                  <button
                    type="button"
                    className={preferences.enabledAgentIds.includes("npati") ? "button-secondary code-agent-manage" : "button-primary"}
                    onClick={() => setBuiltinDrawerOpen(true)}
                  >
                    {preferences.enabledAgentIds.includes("npati")
                      ? (isUk ? "Керувати" : "Manage")
                      : (isUk ? "Підключити" : "Connect")}
                  </button>
                </div>
              </article>
            )}

            {/* External Coding Agents via ProviderCard */}
            {visibleProviders.map((provider) => {
              const isActive = preferences.activeAgentId === provider.id;
              const isEnabled = preferences.enabledAgentIds.includes(provider.id);
              return (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  busy={busy === provider.id ? (isUk ? "Оновлення…" : "Updating…") : undefined}
                  onOpen={() => setSelectedProvider(provider)}
                  onConnect={() => {
                    if (provider.connected) {
                      if (!isEnabled) {
                        void handleToggle(provider.id, false);
                      } else if (!isActive) {
                        void handleSetActive(provider.id, provider.name);
                      } else {
                        setSelectedProvider(provider);
                      }
                    } else {
                      setSelectedProvider(provider);
                    }
                  }}
                  actionLabel={
                    provider.connected
                      ? !isEnabled
                        ? `+ ${isUk ? "Додати" : "Add"}`
                        : isActive
                        ? settingsLabel
                        : setDefaultLabel
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Provider Drawer Modal */}
      {selectedProvider && (
        <ProviderDrawer
          provider={selectedProvider}
          onClose={() => setSelectedProvider(null)}
          onChanged={() => {
            void loadData();
          }}
        />
      )}

      {/* Npati Code Built-in Drawer Modal */}
      {builtinDrawerOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setBuiltinDrawerOpen(false)}>
          <aside className="provider-drawer code-builtin-drawer" aria-label="Npati Code details">
            <button className="drawer-close" onClick={() => setBuiltinDrawerOpen(false)} aria-label={isUk ? "Закрити" : "Close"}>
              <span>×</span>
            </button>
            <header className="drawer-header">
              <AgentIcon size="large" />
              <div>
                <p className="section-kicker">{isUk ? "Вбудований агент" : "Built-in Agent"}</p>
                <h2>{builtIn.name}</h2>
              </div>
            </header>

            <div className="provider-badges">
              <span className="ai-badge">{isUk ? "Вбудований" : "Built-in"}</span>
              <span className="ai-badge red">{isUk ? "Рекомендовано" : "Recommended"}</span>
              {preferences.enabledAgentIds.includes("npati") ? (
                <span className="ai-badge connected">{isUk ? "Увімкнено" : "Enabled"}</span>
              ) : (
                <span className="ai-badge">{isUk ? "Вимкнено" : "Disabled"}</span>
              )}
              {activeAgentIsNpati && <span className="ai-badge connected">{activeLabel}</span>}
            </div>

            {feedback && <div className="inline-message" role="status" style={{ margin: "14px 0" }}>{feedback}</div>}

            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Enable / Disable toggle */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "16px",
                  background: "#f8fafc",
                  borderRadius: "12px",
                  border: "1px solid #e2e8f0",
                }}
              >
                <div>
                  <strong style={{ fontSize: 14, color: "var(--npati-black)" }}>
                    {isUk ? "Статус агента" : "Agent status"}
                  </strong>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>
                    {preferences.enabledAgentIds.includes("npati")
                      ? (isUk ? "Агент увімкнений і готовий до виконання завдань." : "Agent is enabled and available for coding tasks.")
                      : (isUk ? "Агент вимкнений. Ви можете увімкнути його знову." : "Agent is disabled. You can re-enable it anytime.")}
                  </p>
                </div>
                <button
                  type="button"
                  className={preferences.enabledAgentIds.includes("npati") ? "button-secondary" : "button-primary"}
                  disabled={busy === "npati"}
                  onClick={() => handleToggle("npati", preferences.enabledAgentIds.includes("npati"))}
                  style={{ minWidth: 110 }}
                >
                  {preferences.enabledAgentIds.includes("npati")
                    ? (isUk ? "Вимкнути" : "Disable")
                    : (isUk ? "Увімкнути" : "Enable")}
                </button>
              </div>

              {/* Set active agent button */}
              {preferences.enabledAgentIds.includes("npati") && !activeAgentIsNpati && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px 16px",
                    background: "#ffffff",
                    borderRadius: "12px",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  <div>
                    <strong style={{ fontSize: 13, color: "var(--npati-black)" }}>
                      {isUk ? "Призначити основним" : "Set as primary"}
                    </strong>
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
                      {isUk ? "Використовувати Npati Code за замовчуванням у чаті" : "Use Npati Code by default for all chat coding tasks"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button-primary"
                    disabled={busy === "npati"}
                    onClick={() => handleSetActive("npati", builtIn.name)}
                  >
                    {setDefaultLabel}
                  </button>
                </div>
              )}

              {/* Settings navigation button */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "16px",
                  background: "linear-gradient(135deg, rgba(225, 29, 46, 0.05), rgba(225, 29, 46, 0.02))",
                  borderRadius: "12px",
                  border: "1px solid rgba(225, 29, 46, 0.2)",
                }}
              >
                <div>
                  <strong style={{ fontSize: 14, color: "var(--npati-black)" }}>
                    {isUk ? "Налаштування агента" : "Agent Settings"}
                  </strong>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>
                    {isUk
                      ? "Код-проєкти, сесії, Docker sandbox, черга виконання та політики безпеки."
                      : "Code projects, sessions, Docker sandbox, execution queue and security policies."}
                  </p>
                </div>
                <Link
                  to="/settings/code?agent=npati"
                  className="button-primary"
                  onClick={() => setBuiltinDrawerOpen(false)}
                  style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <span>{isUk ? "Налаштування" : "Settings"}</span>
                  <span aria-hidden="true">&rarr;</span>
                </Link>
              </div>

              {/* Capabilities & Information */}
              <div className="details-body" style={{ marginTop: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 10px 0" }}>
                  {isUk ? "Можливості та інструменти" : "Capabilities & Tools"}
                </h3>
                <div className="capability-row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {(builtIn.capabilities || []).map((cap) => (
                    <span key={cap} className="data-studio-badge">{cap}</span>
                  ))}
                </div>
                <dl style={{ marginTop: 16 }}>
                  <div>
                    <dt>{isUk ? "Тип" : "Type"}</dt>
                    <dd>{isUk ? "Вбудований виконавець (Native)" : "Built-in runner (Native)"}</dd>
                  </div>
                  <div>
                    <dt>{isUk ? "Середовище" : "Environment"}</dt>
                    <dd>Docker Sandbox · Host Terminal · File System</dd>
                  </div>
                  <div>
                    <dt>{isUk ? "Доступ до інструментів" : "Tools"}</dt>
                    <dd>Workspace, Sandbox, Terminal, Live Preview, Git, Browser, Website Builder, Data Studio</dd>
                  </div>
                  <div>
                    <dt>{isUk ? "Підтримувані мови" : "Languages"}</dt>
                    <dd>TypeScript, JavaScript, Python, Go, Rust, Bash, PHP, Java, C/C++</dd>
                  </div>
                </dl>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
