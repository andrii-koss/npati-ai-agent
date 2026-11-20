import type { FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import { confirmModal } from "./ConfirmDialog";
import { safeExternalUrl } from "./code-workspace-page-types";
import { ProductionLimitFields, useProjectProduction, type ProductionDomainProofRecord, type ProductionDraftLimits, type ProductionLimits } from "./code-workspace/project-production";
import { ProductionDomainProof, projectDomain } from "./website-builder-production";
import {
  FrameworkIcon,
  type FrameworkStarterOption,
  FRAMEWORK_STARTERS,
  type websiteBuilderCopy,
} from "./website-builder-constants";

const validProductionHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function DomainLink({ host, publishedUrl, https }: { host: string; publishedUrl?: string; https: boolean }) {
  if (!validProductionHost.test(host)) return null;
  const href = safeExternalUrl(publishedUrl) ?? `${https && !host.endsWith(".localhost") ? "https" : "http"}://${host}`;
  return (
    <a className="website-drawer-domain-link" href={href} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={14} aria-hidden="true" />
      {host}
    </a>
  );
}

export interface CreateWebsiteDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  t: (typeof websiteBuilderCopy)["en"];
  language: string;
  companies: Array<{ id: string; name: string }>;
  companyId: string;
  setCompanyId: (id: string) => void;
  handleCreate: (e: FormEvent) => void | Promise<void>;
  error: string;
  selectedFramework: string;
  savedFramework?: string;
  handleSelectFramework: (fw: FrameworkStarterOption) => void;
  domain: string;
  setDomain: (val: string) => void;
  name: string;
  internalPath: string;
  setInternalPath: (val: string) => void;
  stripPath: boolean;
  setStripPath: (val: boolean) => void;
  defaultPort: number;
  containerPort: number;
  setContainerPort: (val: number) => void;
  useCustomEntrypoint: boolean;
  setUseCustomEntrypoint: (val: boolean) => void;
  customEntrypoint: string;
  setCustomEntrypoint: (val: string) => void;
  autoSsl: boolean;
  setAutoSsl: (val: boolean) => void;
  busy: boolean;
  loading?: boolean;
  submitPending?: boolean;
  loadError?: string;
  editing?: boolean;
  production?: {
    limits: ProductionDraftLimits;
    setLimit: (key: keyof ProductionLimits, value: number | "") => void;
    controller: ReturnType<typeof useProjectProduction>;
    automaticDomain?: string;
    canAssignDomain: boolean;
    canUseSsl: boolean;
    tlsEnabled: boolean;
    localDomain: boolean;
    projectId?: string;
    editorProofs?: Record<string, ProductionDomainProofRecord>;
    alias: { domain: string; redirect: boolean };
    setAlias: (value: { domain: string; redirect: boolean }) => void;
    runtimeEnvironment: string;
    setRuntimeEnvironment: (value: string) => void;
  };
}

export function CreateWebsiteDrawer({
  isOpen,
  onClose,
  t,
  language,
  companies,
  companyId,
  setCompanyId,
  handleCreate,
  error,
  selectedFramework,
  savedFramework,
  handleSelectFramework,
  domain,
  setDomain,
  name,
  internalPath,
  setInternalPath,
  stripPath,
  setStripPath,
  defaultPort,
  containerPort,
  setContainerPort,
  useCustomEntrypoint,
  setUseCustomEntrypoint,
  customEntrypoint,
  setCustomEntrypoint,
  autoSsl,
  setAutoSsl,
  busy,
  loading,
  submitPending,
  loadError,
  editing,
  production,
}: CreateWebsiteDrawerProps) {
  if (!isOpen) return null;
  const isUk = language === "uk";
  const release = production?.controller.status?.enabled ? production.controller.status.release : null;
  const primaryHost = projectDomain(domain) || production?.automaticDomain || release?.settings.domain || "";
  const aliasHost = projectDomain(production?.alias.domain ?? "");
  const primaryUrl = release?.domains?.find(item => item.primary && item.host === primaryHost)?.url ??
    (release?.settings.domain === primaryHost ? release?.url : undefined);
  const aliasUrl = release?.domains?.find(item => !item.primary && item.host === aliasHost)?.url;
  const useHttps = autoSsl && production?.canUseSsl !== false;
  const aliasUsesHttps = primaryHost.endsWith(".localhost") ? production?.tlsEnabled === true : useHttps;
  const publicationBusy = Boolean(production?.controller.running || production?.controller.busy);
  const productionError = production?.controller.issue || (production?.controller.status?.enabled && production.controller.status.job?.error);

  return (
    <div
      className="company-drawer-backdrop"
      onMouseDown={onClose}
    >
      <aside
        className="company-drawer"
        aria-busy={loading || undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span>{t.drawerKicker}</span>
            <h2>{editing ? (isUk ? "Налаштування проєкту" : "Project settings") : t.drawerTitle}</h2>
          </div>
          <button
            type="button"
            className="company-drawer-close"
            onClick={onClose}
            aria-label={t.cancel}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {loading ? null : loadError ? <p className="website-drawer-load-error" role="alert">{loadError}</p> : (
        <form onSubmit={(e) => void handleCreate(e)}>
          <section>
            <label>{language === "uk" ? "Компанія" : "Company"}
              <select disabled={editing || busy} value={companyId} onChange={event => setCompanyId(event.target.value)}>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          </section>
          {error && (
            <p role="alert" className="project-error" style={{ margin: "16px 26px 0 26px" }}>
              {error}
            </p>
          )}

          {/* Section 1: Framework Starter Selection */}
          <section>
            <h3>{t.sectionTemplate}</h3>
            <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#64748b" }}>
              {editing && savedFramework ? <>
                {isUk ? "Поточний фреймворк" : "Current framework"} <strong>{savedFramework}</strong>
              </> : t.drawerSubtitle}
            </p>

            <div
              className="provider-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "14px",
              }}
            >
              {FRAMEWORK_STARTERS.map((fw) => {
                const isSelected = selectedFramework === fw.id;
                return (
                  <article
                    key={fw.id}
                    className={`provider-card is-connected${isSelected ? " selected" : ""}`}
                    aria-disabled={editing || undefined}
                    onClick={editing ? undefined : () => handleSelectFramework(fw)}
                    style={{
                      cursor: editing ? "default" : "pointer",
                      transform: editing ? "none" : undefined,
                      borderColor: isSelected ? "var(--npati-red, #e11d2e)" : "#f2b6bd",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      boxShadow: isSelected
                        ? "0 4px 14px rgba(225, 29, 46, 0.12)"
                        : editing ? "var(--npati-shadow)" : undefined,
                      background: "#ffffff",
                      outline: "none",
                    }}
                  >
                    <div className="provider-card-main" style={{ cursor: "inherit" }}>
                      <span
                        className="provider-avatar"
                        aria-hidden="true"
                        style={{
                          width: "38px",
                          height: "38px",
                          borderRadius: "11px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          background: fw.id === "html-css" ? "#fff5f2" : fw.id === "nextjs" ? "#000000" : fw.id === "vite" ? "#18181b" : fw.id === "vue" || fw.id === "flutter" ? "#ffffff" : "#0b0f19",
                          border: "1px solid rgba(0, 0, 0, 0.08)",
                          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.06)",
                        }}
                      >
                        <FrameworkIcon id={fw.id} />
                      </span>
                      <span className="provider-title">
                        <strong>{fw.name}</strong>
                        <small>{language === "uk" ? fw.runtimeLabelUk : fw.runtimeLabel}</small>
                      </span>
                      <span
                        className={`connection-light ${isSelected ? "on" : ""}`}
                        aria-label={isSelected ? "Selected" : editing ? undefined : "Available"}
                        style={{ marginLeft: "auto", justifySelf: "end" }}
                      />
                    </div>
                    <div className="provider-badges" style={{ margin: "12px 0 8px" }}>
                      <span className="status-pill verified">
                        ✓ {language === "uk" ? "Перевірено" : "Verified"}
                      </span>
                    </div>
                    <div className="capability-row" style={{ marginTop: 0, gap: 6 }}>
                      {fw.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {/* Section 2: Domain, Port & SSL */}
          <section>
            <h3>{t.sectionDomain}</h3>
            <p style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#64748b" }}>
              {t.domainDesc}
            </p>

            {/* 1. Domain */}
            <div>
              <label>
                <span>{t.domainLabel}</span>
                <input
                  type="text"
                  placeholder="ai.npati.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                />
              </label>
              {primaryHost ? <DomainLink host={primaryHost} publishedUrl={primaryUrl} https={useHttps} /> : (
                <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                  {production ? (production.canAssignDomain
                      ? (isUk ? "Домен буде призначено автоматично." : "A domain will be assigned automatically.")
                      : (isUk ? "Вкажіть домен для публікації." : "Enter a domain to publish."))
                    : `${t.technicalDomainNotice} (${(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mysite") + "-temp.preview.npati.com"})`}
                </span>
              )}
            </div>
            {production?.projectId && <ProductionDomainProof companyId={companyId} projectId={production.projectId}
              domain={domain} automaticDomain={production.automaticDomain} currentDomains={[release?.settings.domain, release?.settings.aliasDomain]} isUk={isUk} editorProofs={production.editorProofs} />}
            {production && (
              <div style={{ marginTop: 12 }}>
                <label>
                  <span>{isUk ? "Додатковий домен" : "Additional domain"}</span>
                  <input type="text" placeholder="www.example.com" value={production.alias.domain}
                    onChange={event => production.setAlias({ ...production.alias, domain: event.target.value })} />
                </label>
                <DomainLink host={aliasHost} publishedUrl={aliasUrl} https={aliasUsesHttps} />
                {production.alias.domain.trim() && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <input type="checkbox" checked={production.alias.redirect}
                      onChange={event => production.setAlias({ ...production.alias, redirect: event.target.checked })} />
                    <span>{isUk ? "Перенаправляти на основний домен" : "Redirect to the primary domain"}</span>
                  </label>
                )}
                {production.projectId && <ProductionDomainProof companyId={companyId} projectId={production.projectId}
                  domain={production.alias.domain} automaticDomain={production.automaticDomain}
                  currentDomains={[release?.settings.domain, release?.settings.aliasDomain]} isUk={isUk} editorProofs={production.editorProofs} />}
              </div>
            )}

            {/* 2. Path */}
            <div style={{ marginTop: "12px" }}>
              <label>
                <span>{t.pathLabel}</span>
                <input
                  type="text"
                  placeholder="/"
                  value={internalPath}
                  onChange={(e) => setInternalPath(e.target.value)}
                />
                <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                  {t.pathDesc}
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginTop: "8px" }}>
                <input
                  type="checkbox"
                  checked={stripPath}
                  onChange={(e) => setStripPath(e.target.checked)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                />
                <span style={{ fontSize: "12.5px", color: "#334155", fontWeight: 500 }}>
                  {t.stripPathLabel}
                </span>
              </label>
            </div>

            {/* 3. Port */}
            <div style={{ marginTop: "12px" }}>
              <label>
                <span>{t.portLabel}</span>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  placeholder={String(defaultPort)}
                  value={containerPort || ""}
                  onChange={(e) => setContainerPort(Number(e.target.value) || 0)}
                />
                <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                  {t.portDesc}
                </span>
                {production && <span className="ds-muted">{isUk
                  ? `Порт шаблону: ${defaultPort}. На сервері Traefik приймає HTTP на 80 і HTTPS на 443.`
                  : `Template default: ${defaultPort}. On the server, Traefik listens on 80 for HTTP and 443 for HTTPS.`}</span>}
              </label>
            </div>

            {/* 4. Custom Entrypoint */}
            <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={useCustomEntrypoint}
                  onChange={(e) => setUseCustomEntrypoint(e.target.checked)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                />
                <span style={{ fontSize: "13px", color: "#0f172a", fontWeight: 600 }}>
                  {t.customEntrypointLabel}
                </span>
              </label>
              <span style={{ fontSize: "11.5px", color: "#64748b", marginLeft: "24px" }}>
                {production ? (isUk
                  ? "Залиште вимкненим для автоматичного налаштування. web — HTTP (80), websecure — HTTPS (443)."
                  : "Leave off to use automatic routing. web is HTTP (80), and websecure is HTTPS (443).") : t.customEntrypointDesc}
              </span>

              {useCustomEntrypoint && (production ? (
                <select aria-label={isUk ? "Точки входу Traefik" : "Traefik entrypoints"}
                  value={["web", "websecure"].includes(customEntrypoint.trim()) ? customEntrypoint.trim() : "web, websecure"}
                  onChange={event => setCustomEntrypoint(event.target.value)}>
                  <option value="web, websecure">{isUk ? "Автоматично (web і websecure)" : "Automatic (web and websecure)"}</option>
                  <option value="web">{isUk ? "Тільки HTTP (web)" : "HTTP only (web)"}</option>
                  <option value="websecure">{isUk ? "Тільки HTTPS (websecure)" : "HTTPS only (websecure)"}</option>
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="web, websecure"
                  value={customEntrypoint}
                  onChange={(e) => setCustomEntrypoint(e.target.value)}
                  style={{ marginLeft: "24px", marginTop: "4px" }}
                />
              ))}
            </div>

            {/* 5. SSL Certificate */}
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "14px",
                background: "#f8fafc",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                marginTop: "14px",
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", margin: 0 }}>
                <input
                  type="checkbox"
                  checked={autoSsl && production?.canUseSsl !== false}
                  disabled={production?.canUseSsl === false}
                  onChange={(e) => setAutoSsl(e.target.checked)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                />
                <span style={{ fontSize: "13px", color: "#0f172a", fontWeight: 700 }}>
                  {t.sslLabel}
                </span>
              </label>

              {production?.canUseSsl === false && (
                <span className="ds-muted">{production.localDomain ? (isUk ? "Локальні домени використовують HTTP." : "Local domains use HTTP.")
                  : useCustomEntrypoint && customEntrypoint.trim() === "web" ? (isUk ? "Точка входу web використовує HTTP." : "The web entrypoint uses HTTP.")
                  : (isUk ? "HTTPS потребує налаштованого Let's Encrypt." : "HTTPS requires Let's Encrypt to be configured.")}</span>
              )}
              {autoSsl && production?.canUseSsl !== false && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "8px",
                  }}
                >
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "6px",
                      background: "#ecfdf5",
                      color: "#059669",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      fontWeight: 700,
                      fontSize: "14px",
                    }}
                  >
                    🔒
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                      {t.letsEncryptTitle}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                      {t.letsEncryptDesc}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {production && (
              <>
                <ProductionLimitFields isUk={isUk} limits={production.limits} setLimit={production.setLimit} />
                <details>
                  <summary>{isUk ? "Змінні середовища Node.js" : "Node.js runtime environment"}</summary>
                  <label>
                    <span>{isUk ? "Об’єкт JSON. Порожнє поле зберігає попередні значення, {} очищає їх." : "JSON object. Leave blank to keep existing values, or enter {} to clear them."}</span>
                    <textarea rows={3} value={production.runtimeEnvironment} onChange={event => production.setRuntimeEnvironment(event.target.value)}
                      autoComplete="off" spellCheck={false} maxLength={68000} />
                  </label>
                </details>
                {productionError && <p role="alert" className="ds-hint-error">{productionError}</p>}
                {publicationBusy && <p aria-live="polite">{isUk ? "Публікація…" : "Publishing…"}</p>}
              </>
            )}
          </section>

          <footer style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              className={production ? "button-secondary" : "button-primary"}
              disabled={busy || submitPending || !companyId || !name.trim()}
            >
              {editing ? (isUk ? "Зберегти" : "Save") : busy ? t.creating : t.createBtn}
            </button>
            {production && <>
              {release && <button type="button" className="button-secondary" disabled={busy || publicationBusy}
                onClick={() => { void confirmModal({ message: isUk ? "Припинити публікацію цього проєкту?" : "Unpublish this project?", isDanger: true })
                  .then(ok => { if (ok) void production.controller.unpublish(); }); }}>
                {isUk ? "Зняти з публікації" : "Unpublish"}
              </button>}
              <button type="submit" value="publish" className="button-primary"
                disabled={busy || submitPending || publicationBusy || !companyId || !name.trim() || (!production.canAssignDomain && !projectDomain(domain))}>
                {editing ? (isUk ? "Опублікувати" : "Publish") : (isUk ? "Створити й опублікувати" : "Create and publish")}
              </button>
            </>}
          </footer>
        </form>
        )}
      </aside>
    </div>
  );
}
