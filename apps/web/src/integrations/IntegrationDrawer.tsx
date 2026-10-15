import { useState } from "react";
import { useTranslation } from "../i18n";
import { ConnectionManager } from "./ConnectionManager";
import { ConnectForms } from "./ConnectForms";
import { Channel, Company, Connection, formatDate, getScopeLabel } from "./types";
import { Badge, ChannelIcon } from "./ui";

export interface IntegrationDrawerProps {
  channel: Channel;
  connections: Connection[];
  companies: Company[];
  initialConnectionId?: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export function IntegrationDrawer({
  channel,
  connections,
  companies,
  initialConnectionId,
  onClose,
  onChanged,
}: IntegrationDrawerProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"details" | "manage" | "connect">(
    initialConnectionId ? "manage" : connections.length ? "details" : "connect",
  );
  const [manageId, setManageId] = useState(initialConnectionId || "");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [pairing, setPairing] = useState<{ command: string; bot?: string } | null>(null);

  const hasConnected = connections.some((item) => item.status === "connected");
  const hasPending = !hasConnected && connections.some((item) => item.status === "pending");

  const handleConnected = (connectionId: string, pair?: { command: string; bot?: string }) => {
    if (pair) setPairing(pair);
    setManageId(connectionId);
    setMode("manage");
  };

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="provider-drawer" aria-label={`${channel.name} integration`}>
        <button className="drawer-close" onClick={onClose} aria-label={t("integrationsPage.drawer.closeAria")}>
          <span>×</span>
        </button>
        <header className="drawer-header">
          <ChannelIcon channel={channel} size="large" />
          <div>
            <p className="section-kicker">{t("integrationsPage.drawer.kicker")}</p>
            <h2>{channel.name}</h2>
          </div>
        </header>
        <div className="provider-badges">
          <Badge>{t("integrationsPage.badges.channel")}</Badge>
          {channel.available ? <Badge tone="connected">{t("integrationsPage.badges.available")}</Badge> : <Badge>{t("integrationsPage.badges.comingSoon")}</Badge>}
          {hasConnected ? <Badge tone="connected">{t("integrationsPage.badges.connected")}</Badge> : hasPending && <Badge tone="pending">{t("integrationsPage.badges.pendingPairing")}</Badge>}
        </div>
        <div className="drawer-tabs">
          <button className={mode === "details" ? "active" : ""} onClick={() => setMode("details")}>{t("integrationsPage.drawer.tabs.overview")}</button>
          {manageId && <button className={mode === "manage" ? "active" : ""} onClick={() => setMode("manage")}>{t("integrationsPage.drawer.tabs.manage")}</button>}
          {channel.available && <button className={mode === "connect" ? "active" : ""} onClick={() => setMode("connect")}>{connections.length ? t("integrationsPage.drawer.tabs.addConnection") : t("integrationsPage.drawer.tabs.setup")}</button>}
        </div>
        {message && <div className="inline-message">{message}</div>}
        {mode === "details" && (
          <div className="details-body">
            {!channel.available ? (
              <div className="provider-setup-note">
                <strong>{t("integrationsPage.drawer.overview.comingSoonTitle", { name: channel.name })}</strong>
              </div>
            ) : connections.length === 0 ? (
              <div className="empty-inline">
                <strong>{t("integrationsPage.drawer.overview.noConnections")}</strong>
              </div>
            ) : (
              <div className="model-list">
                {connections.map((connection) => (
                  <div className="model-row" key={connection.id}>
                    <span>
                      <strong>{connection.displayName}</strong>
                      <small>{getScopeLabel(connection.scope, t)} · {connection.status} · {t("integrationsPage.drawer.overview.lastActivity", { time: formatDate(connection.lastInboundAt || connection.lastOutboundAt, t("integrationsPage.drawer.manager.general.never")) })}</small>
                    </span>
                    <button onClick={() => { setManageId(connection.id); setMode("manage"); }}>{t("integrationsPage.drawer.tabs.manage")}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {mode === "manage" && manageId && (
          <ConnectionManager
            key={manageId}
            connectionId={manageId}
            initialConnection={connections.find((item) => item.id === manageId)}
            companies={companies}
            initialPairingCommand={pairing?.command}
            onChanged={onChanged}
            onRemoved={() => { setManageId(""); setMode("details"); void onChanged(); }}
          />
        )}
        {mode === "connect" && channel.available && (
          <ConnectForms
            channel={channel}
            companies={companies}
            onConnected={handleConnected}
            onChanged={onChanged}
            setMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
            t={t}
          />
        )}
      </aside>
    </div>
  );
}
