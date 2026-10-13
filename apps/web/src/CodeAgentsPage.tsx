import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "./i18n";
import { CodeSettingsPage } from "./CodeSettingsPage";

// Catalog availability is separate from the agent's runtime feature flags.
const AGENTS = [{ id: "npati", name: "NPATI Coding Agent", builtIn: true }];
const settingsUrl = (id: string) => `/settings/code?agent=${encodeURIComponent(id)}`;

function AgentIcon({ small = false }: { small?: boolean }) {
  return <span className={`provider-avatar code-agent-avatar${small ? " small" : ""}`} aria-hidden="true">{"</>"}</span>;
}

export function CodeAgentsPage() {
  const { language } = useTranslation();
  const isUk = language === "uk";
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "available" | "coming" | "builtIn">("all");
  if (params.get("agent") === "npati") return <CodeSettingsPage />;

  const visible = AGENTS.filter((agent) => tab !== "coming" && (tab !== "builtIn" || agent.builtIn)
    && `${agent.name} ${isUk ? "кодінг агент проєкти репозиторії" : "coding agent projects repositories"}`.toLowerCase().includes(search.trim().toLowerCase()));
  const builtIn = AGENTS.filter((agent) => agent.builtIn);
  const tabs = [
    { id: "all", label: isUk ? "Усі" : "All", count: AGENTS.length },
    { id: "available", label: isUk ? "Доступні" : "Available", count: AGENTS.length },
    { id: "coming", label: isUk ? "Незабаром" : "Coming soon", count: 0 },
    { id: "builtIn", label: isUk ? "Вбудовані" : "Built-in", count: builtIn.length },
  ] as const;
  const settingsLabel = isUk ? "Налаштування" : "Settings";
  return (
    <main className="ai-marketplace code-agents-catalog">
      <header className="marketplace-hero">
        <div>
          <p className="eyebrow">{isUk ? "Налаштування · Code" : "Settings · Code"}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={isUk ? "Назад до налаштувань" : "Back to settings"}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            </Link>
            <span>{isUk ? "Кодінг-агенти" : "Coding Agents"}</span>
          </h1>
          <p>{isUk ? "Обирайте агентів для роботи з кодом і керуйте їхніми проєктами, сесіями та налаштуваннями." : "Explore coding agents and manage their projects, sessions and settings."}</p>
        </div>
      </header>
      <section className="overview-grid" aria-label={isUk ? "Огляд агентів" : "Agent overview"}>
        <div><strong>{AGENTS.length}</strong><span>{isUk ? "Агентів у каталозі" : "Agents in catalog"}</span></div>
        <div><strong>{AGENTS.length}</strong><span>{isUk ? "Доступних інтеграцій" : "Available integrations"}</span></div>
        <div><strong>{builtIn.length}</strong><span>{isUk ? "Вбудованих агентів" : "Built-in agents"}</span></div>
        <div><strong>0</strong><span>{isUk ? "Незабаром" : "Coming soon"}</span></div>
      </section>
      <section className="my-models">
        <div className="section-heading">
          <div><p className="section-kicker">{isUk ? "Бібліотека" : "Library"}</p><h2>{isUk ? "Мої агенти" : "My Agents"}</h2></div>
          <span>{isUk ? `${builtIn.length} вбудований` : `${builtIn.length} built-in`}</span>
        </div>
        <div className="my-model-list">
          {builtIn.map((agent) => (
            <div className="my-model-row" key={agent.id}>
              <AgentIcon small />
              <span><strong>{agent.name}</strong><small>{isUk ? "Від NPATI · Проєкти та сесії" : "By NPATI · Projects and sessions"}</small></span>
              <span className="ai-badge">{isUk ? "Вбудований" : "Built-in"}</span>
              <Link className="button-secondary code-agent-manage" to={settingsUrl(agent.id)}>{settingsLabel}</Link>
            </div>
          ))}
        </div>
      </section>
      <section className="explore-section">
        <div className="section-heading">
          <div><p className="section-kicker">{isUk ? "Каталог" : "Discovery"}</p><h2>{isUk ? "Огляд агентів" : "Explore Agents"}</h2></div>
        </div>
        <div className="marketplace-controls">
          <div className="search-box">
            <span aria-hidden="true">⌕</span>
            <input type="search" aria-label={isUk ? "Пошук агентів" : "Search agents"} placeholder={isUk ? "Пошук кодінг-агентів…" : "Search coding agents…"} value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="marketplace-tabs" aria-label={isUk ? "Фільтри агентів" : "Agent filters"}>
            {tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}><span>{item.label}</span><small>{item.count}</small></button>)}
          </div>
        </div>
        <p className="showing-copy" role="status">{isUk ? `Показано ${visible.length} з ${AGENTS.length} агентів` : `Showing ${visible.length} of ${AGENTS.length} agents`}</p>
        {visible.length === 0 ? (
          <div className="empty-inline">
            <strong>{isUk ? "Агентів не знайдено" : "No agents found"}</strong>
            <span>{isUk ? "Спробуйте інший запит або фільтр." : "Try another search or filter."}</span>
            <button type="button" className="button-secondary" onClick={() => { setSearch(""); setTab("all"); }}>{isUk ? "Скинути фільтри" : "Reset filters"}</button>
          </div>
        ) : (
          <div className="provider-grid">
            {visible.map((agent) => (
              <article className="provider-card" key={agent.id}>
                <Link className="provider-card-main" to={settingsUrl(agent.id)}>
                  <AgentIcon /><span className="provider-title"><strong>{agent.name}</strong><small>{isUk ? "Кодінг-агент" : "Coding agent"}</small></span>
                </Link>
                <div className="provider-badges"><span className="ai-badge">{isUk ? "Вбудований" : "Built-in"}</span><span className="ai-badge red">{isUk ? "Рекомендовано" : "Recommended"}</span></div>
                <p className="provider-description">{isUk ? "Працюйте з репозиторіями, запускайте сесії агента та керуйте інструментами розробки в NPATI." : "Work with repositories, launch agent sessions and manage development tools in NPATI."}</p>
                <div className="capability-row">{(isUk ? ["Проєкти", "Репозиторії", "Сесії", "Інструменти"] : ["Projects", "Repositories", "Sessions", "Tools"]).map((item) => <span key={item}>{item}</span>)}</div>
                <div className="provider-card-footer"><span>{isUk ? "Від NPATI" : "By NPATI"}</span><Link className="button-secondary code-agent-manage" to={settingsUrl(agent.id)}>{settingsLabel}</Link></div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

