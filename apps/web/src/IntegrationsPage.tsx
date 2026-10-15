import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "./i18n";
import {
  getCachedChannels,
  getCachedCompanies,
  getCachedConnections,
  STORAGE_CHANNELS_KEY,
  STORAGE_COMPANIES_KEY,
  STORAGE_CONNECTIONS_KEY,
} from "./integrations/cache";
import { IntegrationDrawer } from "./integrations/IntegrationDrawer";
import {
  api,
  capabilityKeyMap,
  Channel,
  Company,
  Connection,
  getScopeLabel,
} from "./integrations/types";
import { Badge, ChannelIcon } from "./integrations/ui";

export function IntegrationsPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<Channel[]>(getCachedChannels);
  const [connections, setConnections] = useState<Connection[]>(getCachedConnections);
  const [companies, setCompanies] = useState<Company[]>(getCachedCompanies);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "available" | "coming" | "connected">("all");
  const [selected, setSelected] = useState<Channel | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem(STORAGE_CHANNELS_KEY));
    } catch {
      return false;
    }
  });
  const [loading, setLoading] = useState<boolean>(() => !hasLoaded);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const [catalog, companyResult] = await Promise.all([
        api<{ channels: Channel[]; connections: Connection[] }>("/integrations/channels"),
        api<{ companies: Company[] }>("/companies"),
      ]);
      setChannels((prev) => JSON.stringify(prev) === JSON.stringify(catalog.channels) ? prev : catalog.channels);
      setConnections((prev) => JSON.stringify(prev) === JSON.stringify(catalog.connections) ? prev : catalog.connections);
      setCompanies((prev) => JSON.stringify(prev) === JSON.stringify(companyResult.companies) ? prev : companyResult.companies);
      try {
        localStorage.setItem(STORAGE_CHANNELS_KEY, JSON.stringify(catalog.channels));
        localStorage.setItem(STORAGE_CONNECTIONS_KEY, JSON.stringify(catalog.connections));
        localStorage.setItem(STORAGE_COMPANIES_KEY, JSON.stringify(companyResult.companies));
      } catch {}
      setError("");
      setHasLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const connectedChannels = useMemo(() => new Set(connections.map((connection) => connection.channel)), [connections]);
  const visible = useMemo(
    () => channels.filter(
      (channel) => channel.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (tab === "all" ||
          (tab === "available" && channel.available) ||
          (tab === "coming" && !channel.available) ||
          (tab === "connected" && connectedChannels.has(channel.id))),
    ),
    [channels, search, tab, connectedChannels],
  );
  const counts = useMemo(
    () => ({
      all: channels.length,
      available: channels.filter((item) => item.available).length,
      coming: channels.filter((item) => !item.available).length,
      connected: channels.filter((item) => connectedChannels.has(item.id)).length,
    }),
    [channels, connectedChannels],
  );

  const open = (channel: Channel, connectionId?: string) => {
    if (channel.id === "email") {
      navigate("/settings/email");
      return;
    }
    setSelectedConnectionId(connectionId || null);
    setSelected(channel);
  };

  const getTabLabel = (item: "all" | "available" | "coming" | "connected") => {
    if (item === "all") return t("integrationsPage.tabs.all");
    if (item === "available") return t("integrationsPage.tabs.available");
    if (item === "coming") return t("integrationsPage.tabs.coming");
    return t("integrationsPage.tabs.connected");
  };

  const getCapabilityLabel = (cap: string) => {
    const key = capabilityKeyMap[cap];
    if (key) {
      const translated = t(`integrationsPage.capabilities.${key}`);
      if (translated) return translated;
    }
    return cap;
  };

  return (
    <main className="ai-marketplace">
      <header className="marketplace-hero">
        <div>
          <p className="eyebrow">{t("integrationsPage.eyebrow")}</p>
          <h1>
            <Link to="/settings" className="marketplace-back-button" aria-label={t("integrationsPage.backAria")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            </Link>
            <span>{t("integrationsPage.title")}</span>
          </h1>
          <p>{t("integrationsPage.description")}</p>
        </div>
      </header>
      <section className="overview-grid">
        <div><strong>{channels.length || "—"}</strong><span>{t("integrationsPage.stats.channelsAvailable")}</span></div>
        <div><strong>{counts.available}</strong><span>{t("integrationsPage.stats.readyToConnect")}</span></div>
        <div><strong>{counts.connected}</strong><span>{t("integrationsPage.stats.channelsConnected")}</span></div>
        <div><strong>{connections.length}</strong><span>{t("integrationsPage.stats.connectionsAdded")}</span></div>
      </section>
      <section className="my-models">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{t("integrationsPage.myConnections.kicker")}</p>
            <h2>{t("integrationsPage.myConnections.heading")}</h2>
          </div>
          <span>{t("integrationsPage.myConnections.addedCount", { count: connections.length })}</span>
        </div>
        {!hasLoaded && loading && connections.length === 0 ? (
          <div className="empty-inline" style={{ minHeight: "84px", display: "grid", placeItems: "center" }}>
            <span>{t("integrationsPage.myConnections.loading")}</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="empty-inline" style={{ minHeight: "84px" }}>
            <strong>{t("integrationsPage.myConnections.emptyTitle")}</strong>
            <span>{t("integrationsPage.myConnections.emptyDesc")}</span>
          </div>
        ) : (
          <div className="my-model-list">
            {connections.map((connection) => {
              const channel = channels.find((item) => item.id === connection.channel) || { id: connection.channel, name: connection.channel, available: true, capabilities: [] };
              return (
                <div className="my-model-row" key={connection.id}>
                  <ChannelIcon channel={channel} size="small" />
                  <span>
                    <strong>{connection.displayName}</strong>
                    <small>{t("integrationsPage.myConnections.via")} {channel.name} · {getScopeLabel(connection.scope, t)}</small>
                  </span>
                  {connection.status === "connected" ? (
                    <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge>
                  ) : connection.status === "pending" ? (
                    <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>
                  ) : (
                    <Badge>{connection.status.toUpperCase()}</Badge>
                  )}
                  <button onClick={() => open(channel, connection.id)}>{t("integrationsPage.myConnections.manage")}</button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="explore-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">{t("integrationsPage.explore.kicker")}</p>
            <h2>{t("integrationsPage.explore.heading")}</h2>
          </div>
        </div>
        <div className="marketplace-controls">
          <div className="search-box">
            <span>⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("integrationsPage.explore.searchPlaceholder")} />
          </div>
          <div className="marketplace-tabs">
            {(["all", "available", "coming", "connected"] as const).map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
                <span>{getTabLabel(item)}</span>
                <small>{counts[item]}</small>
              </button>
            ))}
          </div>
        </div>
        {error && channels.length === 0 ? (
          <div className="engine-error">
            <strong>{t("integrationsPage.explore.unavailable")}</strong>
            <p>{error}</p>
          </div>
        ) : loading && channels.length === 0 ? (
          <div className="loading-state">{t("integrationsPage.explore.loading")}</div>
        ) : (
          <>
            <p className="showing-copy">{t("integrationsPage.explore.showingCount", { visible: visible.length, total: channels.length })}</p>
            <div className="provider-grid">
              {visible.map((channel) => {
                const linked = connections.filter((item) => item.channel === channel.id);
                const hasConnection = linked.length > 0;
                const connected = linked.some((item) => item.status === "connected");
                const pending = !connected && linked.some((item) => item.status === "pending");
                const openChannel = () => open(channel, linked.length === 1 ? linked[0]!.id : undefined);
                return (
                  <article className={`provider-card ${hasConnection ? "is-connected" : ""}`} key={channel.id}>
                    <button className="provider-card-main" onClick={openChannel}>
                      <ChannelIcon channel={channel} />
                      <span className="provider-title">
                        <strong>{channel.name}</strong>
                        <small>{channel.available ? t("integrationsPage.explore.messagingChannel") : t("integrationsPage.explore.plannedAdapter")}</small>
                      </span>
                      <span className={`connection-light ${connected ? "on" : pending ? "pending" : ""}`} />
                    </button>
                    <div className="provider-badges">
                      <Badge>{t("integrationsPage.badges.channel")}</Badge>
                      {connected ? (
                        <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge>
                      ) : pending && (
                        <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>
                      )}
                      {channel.available ? (
                        <Badge tone="red">{t("integrationsPage.badges.recommended")}</Badge>
                      ) : (
                        <Badge>{t("integrationsPage.badges.comingSoon")}</Badge>
                      )}
                    </div>
                    <p className="provider-description">
                      {channel.available
                        ? t("integrationsPage.explore.channelDescription")
                        : t("integrationsPage.explore.futureAdapterDescription", { name: channel.name })}
                    </p>
                    <div className="capability-row">
                      {channel.available
                        ? channel.capabilities.slice(0, 4).map((item) => <span key={item}>{getCapabilityLabel(item)}</span>)
                        : <span>{t("integrationsPage.explore.adapterReady")}</span>}
                    </div>
                    <div className="provider-card-footer">
                      <span>{t("integrationsPage.explore.connectionsCount", { count: linked.length })}</span>
                      <button className={hasConnection ? "button-secondary" : "button-primary"} onClick={openChannel}>
                        {channel.available ? (hasConnection ? t("integrationsPage.explore.manage") : t("integrationsPage.explore.connect")) : t("integrationsPage.explore.view")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
      {selected && (
        <IntegrationDrawer
          key={`${selected.id}:${selectedConnectionId || "catalog"}`}
          channel={selected}
          connections={connections.filter((item) => item.channel === selected.id)}
          companies={companies}
          initialConnectionId={selectedConnectionId}
          onClose={() => { setSelected(null); setSelectedConnectionId(null); }}
          onChanged={load}
        />
      )}
    </main>
  );
}
