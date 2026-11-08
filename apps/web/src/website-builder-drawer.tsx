import type { FormEvent } from "react";
import {
  FrameworkIcon,
  type FrameworkStarterOption,
  FRAMEWORK_STARTERS,
  type websiteBuilderCopy,
} from "./website-builder-constants";

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
  handleSelectFramework: (fw: FrameworkStarterOption) => void;
  domain: string;
  setDomain: (val: string) => void;
  name: string;
  internalPath: string;
  setInternalPath: (val: string) => void;
  stripPath: boolean;
  setStripPath: (val: boolean) => void;
  framework: string;
  containerPort: number;
  setContainerPort: (val: number) => void;
  useCustomEntrypoint: boolean;
  setUseCustomEntrypoint: (val: boolean) => void;
  customEntrypoint: string;
  setCustomEntrypoint: (val: string) => void;
  autoSsl: boolean;
  setAutoSsl: (val: boolean) => void;
  busy: boolean;
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
  handleSelectFramework,
  domain,
  setDomain,
  name,
  internalPath,
  setInternalPath,
  stripPath,
  setStripPath,
  framework,
  containerPort,
  setContainerPort,
  useCustomEntrypoint,
  setUseCustomEntrypoint,
  customEntrypoint,
  setCustomEntrypoint,
  autoSsl,
  setAutoSsl,
  busy,
}: CreateWebsiteDrawerProps) {
  if (!isOpen) return null;

  return (
    <div
      className="company-drawer-backdrop"
      onMouseDown={onClose}
    >
      <aside
        className="company-drawer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span>{t.drawerKicker}</span>
            <h2>{t.drawerTitle}</h2>
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

        <form onSubmit={(e) => void handleCreate(e)}>
          <section>
            <label>{language === "uk" ? "Компанія" : "Company"}
              <select value={companyId} onChange={event => setCompanyId(event.target.value)}>
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
              {t.drawerSubtitle}
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
                    onClick={() => handleSelectFramework(fw)}
                    style={{
                      cursor: "pointer",
                      borderColor: isSelected ? "var(--npati-red, #e11d2e)" : "#f2b6bd",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      boxShadow: isSelected
                        ? "0 4px 14px rgba(225, 29, 46, 0.12)"
                        : undefined,
                      background: "#ffffff",
                      outline: "none",
                    }}
                  >
                    <div className="provider-card-main" style={{ cursor: "pointer" }}>
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
                        aria-label={isSelected ? "Selected" : "Available"}
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
            <label>
              <span>{t.domainLabel}</span>
              <input
                type="text"
                placeholder="ai.npati.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
              <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                {domain.trim()
                  ? `Target domain: https://${domain.trim().replace(/^https?:\/\//, "")}`
                  : `${t.technicalDomainNotice} (${(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mysite") + "-temp.preview.npati.com"})`}
              </span>
            </label>

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
                  placeholder={framework.toLowerCase().includes("vite") ? "80" : "3000"}
                  value={containerPort}
                  onChange={(e) => setContainerPort(Number(e.target.value) || 0)}
                />
                <span style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                  {t.portDesc}
                </span>
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
                {t.customEntrypointDesc}
              </span>

              {useCustomEntrypoint && (
                <input
                  type="text"
                  placeholder="web, websecure"
                  value={customEntrypoint}
                  onChange={(e) => setCustomEntrypoint(e.target.value)}
                  style={{ marginLeft: "24px", marginTop: "4px" }}
                />
              )}
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
                  checked={autoSsl}
                  onChange={(e) => setAutoSsl(e.target.checked)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--npati-red, #d83438)" }}
                />
                <span style={{ fontSize: "13px", color: "#0f172a", fontWeight: 700 }}>
                  {t.sslLabel}
                </span>
              </label>

              {autoSsl && (
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
          </section>

          <footer style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={busy || !name.trim()}
            >
              {busy ? t.creating : t.createBtn}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
