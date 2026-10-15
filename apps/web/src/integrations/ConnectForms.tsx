import { FormEvent, useEffect, useState } from "react";
import { Agent, api, Channel, Company, Connection, ConnectionScope } from "./types";

interface ScopeFieldsProps {
  scope: ConnectionScope;
  setScope: (scope: ConnectionScope) => void;
  companyId: string;
  setCompanyId: (id: string) => void;
  companies: Company[];
  agentId: string;
  setAgentId: (id: string) => void;
  agents: Agent[];
  t: (key: string, params?: Record<string, string | number>) => string;
}

function ScopeFields({ scope, setScope, companyId, setCompanyId, companies, agentId, setAgentId, agents, t }: ScopeFieldsProps) {
  return (
    <>
      <div className="field">
        <label>{t("integrationsPage.drawer.connect.connectionScope")}</label>
        <select value={scope} onChange={(event) => setScope(event.target.value as ConnectionScope)}>
          <option value="account">{t("integrationsPage.scopes.account")}</option>
          <option value="company">{t("integrationsPage.scopes.company")}</option>
          <option value="agent">{t("integrationsPage.scopes.agent")}</option>
        </select>
      </div>
      {scope !== "account" && (
        <div className="field">
          <label>{t("integrationsPage.drawer.connect.company")}</label>
          <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </div>
      )}
      {scope === "agent" && (
        <div className="field">
          <label>{t("integrationsPage.drawer.connect.agent")}</label>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
            <option value="">{t("integrationsPage.drawer.connect.selectAgent")}</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

export interface ConnectFormsProps {
  channel: Channel;
  companies: Company[];
  onConnected: (connectionId: string, pairing?: { command: string; bot?: string }) => void;
  onChanged: () => Promise<void>;
  setMessage: (msg: string) => void;
  busy: string;
  setBusy: (b: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ConnectForms({
  channel,
  companies,
  onConnected,
  onChanged,
  setMessage,
  busy,
  setBusy,
  t,
}: ConnectFormsProps) {
  const [scope, setScope] = useState<ConnectionScope>("account");
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState(() =>
    channel.id === "whatsapp"
      ? t("integrationsPage.drawer.connect.defaultBotNames.whatsapp")
      : channel.id === "discord"
        ? t("integrationsPage.drawer.connect.defaultBotNames.discord")
        : channel.id === "slack"
          ? t("integrationsPage.drawer.connect.defaultBotNames.slack")
          : t("integrationsPage.drawer.connect.defaultBotNames.telegram"),
  );
  const [pairing, setPairing] = useState<{ command: string; bot?: string } | null>(null);
  const [waMethod, setWaMethod] = useState<"qr" | "cloud">("qr");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [slackMethod, setSlackMethod] = useState<"socket" | "http">("socket");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  useEffect(() => {
    if (channel.id === "whatsapp") setName(t("integrationsPage.drawer.connect.defaultBotNames.whatsapp"));
    else if (channel.id === "discord") setName(t("integrationsPage.drawer.connect.defaultBotNames.discord"));
    else if (channel.id === "slack") setName(t("integrationsPage.drawer.connect.defaultBotNames.slack"));
    else setName(t("integrationsPage.drawer.connect.defaultBotNames.telegram"));
  }, [channel.id]);

  useEffect(() => {
    setAgentId("");
    if (scope !== "agent" || !companyId) {
      setAgents([]);
      return;
    }
    void api<{ agents: Agent[] }>(`/companies/${companyId}/agents`).then((result) => setAgents(result.agents.filter((agent) => agent.isActive))).catch((error) => setMessage(error.message));
  }, [companyId, scope]);

  const scopeProps: ScopeFieldsProps = {
    scope,
    setScope,
    companyId,
    setCompanyId,
    companies,
    agentId,
    setAgentId,
    agents,
    t,
  };

  async function connectTelegram(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string }>("/integrations/telegram", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, botToken: token, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      const pair = { command: result.pairingCommand, bot: result.connection.botUsername || undefined };
      setPairing(pair);
      setMessage(t("integrationsPage.drawer.connect.messages.telegramSuccess"));
      await onChanged();
      onConnected(result.connection.id, pair);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectWhatsApp(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; webhookUrl?: string }>("/integrations/whatsapp", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, method: waMethod, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}), ...(waMethod === "cloud" ? { phoneNumberId, accessToken, appSecret, verifyToken } : {}) }),
      });
      setMessage(waMethod === "qr" ? t("integrationsPage.drawer.connect.messages.whatsappQrSuccess") : t("integrationsPage.drawer.connect.messages.whatsappCloudSuccess", { url: result.webhookUrl || "public webhook URL unavailable" }));
      await onChanged();
      onConnected(result.connection.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectDiscord(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string; inviteUrl: string }>("/integrations/discord", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, botToken: token, clientId, ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      const pair = { command: result.pairingCommand, bot: result.connection.botUsername || undefined };
      setPairing(pair);
      setMessage(t("integrationsPage.drawer.connect.messages.discordSuccess"));
      await onChanged();
      onConnected(result.connection.id, pair);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function generateSlackManifest() {
    setBusy(t("integrationsPage.drawer.connect.generatingManifest"));
    setMessage("");
    try {
      const result = await api<{ manifest: unknown }>("/integrations/slack/manifest", { method: "POST", body: JSON.stringify({ method: slackMethod }) });
      const blob = new Blob([JSON.stringify(result.manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "npati-slack-app-manifest.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage(t("integrationsPage.drawer.connect.messages.manifestGenerated"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function connectSlack(event: FormEvent) {
    event.preventDefault();
    setBusy(t("integrationsPage.drawer.connect.connecting"));
    setMessage("");
    try {
      const result = await api<{ connection: Connection; pairingCommand: string; webhookUrl?: string }>("/integrations/slack", {
        method: "POST",
        body: JSON.stringify({ scope, displayName: name, method: slackMethod, botToken: token, ...(slackMethod === "socket" ? { appToken } : { signingSecret }), ...(scope !== "account" ? { companyId } : {}), ...(scope === "agent" ? { agentId } : {}) }),
      });
      setToken("");
      setAppToken("");
      setSigningSecret("");
      const pair = { command: result.pairingCommand, bot: result.connection.botUsername || undefined };
      setPairing(pair);
      setMessage(result.webhookUrl ? t("integrationsPage.drawer.connect.messages.slackHttpSuccess") : t("integrationsPage.drawer.connect.messages.slackSocketSuccess"));
      await onChanged();
      onConnected(result.connection.id, pair);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  if (channel.id === "slack") {
    return (
      <div className="connect-body">
        <p className="auth-hint">{t("integrationsPage.drawer.connect.slackHint")}</p>
        <div className="drawer-actions">
          <button type="button" className="button-secondary" disabled={!!busy} onClick={() => void generateSlackManifest()}>{busy || t("integrationsPage.drawer.connect.generateManifest")}</button>
          <a className="button-secondary" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">{t("integrationsPage.drawer.connect.createSlackApp")}</a>
        </div>
        <form onSubmit={connectSlack}>
          <ScopeFields {...scopeProps} />
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.connectionMethod")}</label>
            <select value={slackMethod} onChange={(event) => setSlackMethod(event.target.value as "socket" | "http")}>
              <option value="socket">{t("integrationsPage.drawer.connect.socketMode")}</option>
              <option value="http">{t("integrationsPage.drawer.connect.httpEvents")}</option>
            </select>
          </div>
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.botTokenSlack")}</label>
            <input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
          {slackMethod === "socket" ? (
            <div className="field">
              <label>{t("integrationsPage.drawer.connect.appLevelToken")}</label>
              <input type="password" autoComplete="new-password" value={appToken} onChange={(event) => setAppToken(event.target.value)} required />
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.signingSecret")}</label>
                <input type="password" autoComplete="new-password" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.webhookUrl")}</label>
                <input value={t("integrationsPage.drawer.connect.webhookGeneratedAfter")} readOnly />
              </div>
            </>
          )}
          <button className="button-primary wide" disabled={!!busy || !token.trim() || (slackMethod === "socket" ? !appToken.trim() : !signingSecret.trim()) || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
            {busy || t("integrationsPage.drawer.connect.connectSlack")}
          </button>
        </form>
      </div>
    );
  }

  if (channel.id === "discord") {
    return (
      <div className="connect-body">
        <p className="auth-hint">{t("integrationsPage.drawer.connect.discordHint")}</p>
        <form onSubmit={connectDiscord}>
          <ScopeFields {...scopeProps} />
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.botToken")}</label>
            <input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.clientId")}</label>
            <input value={clientId} onChange={(event) => setClientId(event.target.value)} inputMode="numeric" required />
          </div>
          <button className="button-primary wide" disabled={!!busy || !token.trim() || !clientId.trim() || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
            {busy || t("integrationsPage.drawer.connect.connectDiscord")}
          </button>
        </form>
      </div>
    );
  }

  if (channel.id === "whatsapp") {
    return (
      <div className="connect-body">
        <p className="auth-hint">{t("integrationsPage.drawer.connect.whatsAppHint")}</p>
        <form onSubmit={connectWhatsApp}>
          <ScopeFields {...scopeProps} />
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="field">
            <label>{t("integrationsPage.drawer.connect.connectionMethod")}</label>
            <select value={waMethod} onChange={(event) => setWaMethod(event.target.value as "qr" | "cloud")}>
              <option value="qr">{t("integrationsPage.drawer.connect.whatsAppMethodQr")}</option>
              <option value="cloud">{t("integrationsPage.drawer.connect.whatsAppMethodCloud")}</option>
            </select>
          </div>
          {waMethod === "cloud" && (
            <>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.phoneNumberId")}</label>
                <input value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.accessToken")}</label>
                <input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.appSecret")}</label>
                <input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.verifyToken")}</label>
                <input type="password" value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} required />
              </div>
              <div className="field">
                <label>{t("integrationsPage.drawer.connect.webhookUrl")}</label>
                <input value={t("integrationsPage.drawer.connect.webhookGeneratedAfter")} readOnly />
              </div>
            </>
          )}
          <button className="button-primary wide" disabled={!!busy || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
            {busy || t("integrationsPage.drawer.connect.connectWhatsApp")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="connect-body">
      <p className="auth-hint">{t("integrationsPage.drawer.connect.telegramHint")}</p>
      <form onSubmit={connectTelegram}>
        <ScopeFields {...scopeProps} />
        <div className="field">
          <label>{t("integrationsPage.drawer.connect.connectionName")}</label>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label>{t("integrationsPage.drawer.connect.botToken")}</label>
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} required />
        </div>
        <button className="button-primary wide" disabled={!!busy || (scope !== "account" && !companyId) || (scope === "agent" && !agentId)}>
          {busy || t("integrationsPage.drawer.connect.connectTelegram")}
        </button>
      </form>
      {pairing && (
        <div className="provider-setup-note">
          <strong>{t("integrationsPage.drawer.connect.finishPairingInBot", { bot: pairing.bot || "your bot" })}</strong>
          <code>{pairing.command}</code>
        </div>
      )}
    </div>
  );
}
