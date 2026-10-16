import React, { useEffect, useRef, useState } from "react";

export interface CreateDatabaseDrawerProps {
  isUk: boolean;
  busy: boolean;
  /** Shown in the footer so the owner knows which company receives the database. */
  companyName?: string;
  onClose: () => void;
  onCreate: (input: { name: string; provider: "shared_postgres" | "external_postgres"; connectionString?: string }) => Promise<void>;
}

export function CreateDatabaseDrawer({ isUk, busy, companyName, onClose, onCreate }: CreateDatabaseDrawerProps) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"shared_postgres" | "external_postgres">("shared_postgres");
  const [connectionString, setConnectionString] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, []);

  const connectionValid = provider === "shared_postgres" || /^postgres(ql)?:\/\/\S+/.test(connectionString.trim());
  const canSubmit = name.trim().length > 0 && name.trim().length <= 200 && connectionValid;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onCreate({ name: name.trim(), provider, connectionString: provider === "external_postgres" ? connectionString.trim() : undefined });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Could not create the database");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => onClose()}>
      <aside className="company-drawer automations-drawer" role="dialog" aria-modal="true" aria-label={isUk ? "Нова база даних" : "New database"} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>Data Studio</span>
            <h2>{isUk ? "Нова база даних" : "New database"}</h2>
          </div>
          <button type="button" className="automations-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <form onSubmit={submit}>
          <section>
            <h3>{isUk ? "Параметри бази" : "Database settings"}</h3>
            <label className="browser-form-field">
              <span>{isUk ? "Назва" : "Name"} <i className="required-star">*</i></span>
              <input
                ref={nameRef}
                value={name}
                maxLength={200}
                placeholder={isUk ? "Наприклад: Магазин — дані" : "For example: Shop data"}
                onChange={(event) => { setName(event.target.value); setLocalError(null); }}
              />
            </label>
            <label className="browser-form-field">
              <span>{isUk ? "Провайдер" : "Provider"}</span>
              <select
                value={provider}
                onChange={(event) => { setProvider(event.target.value as "shared_postgres" | "external_postgres"); setLocalError(null); }}
              >
                <option value="shared_postgres">{isUk ? "Керована NPATI (рекомендовано)" : "NPATI managed (recommended)"}</option>
                <option value="external_postgres">{isUk ? "Зовнішня (Neon / Supabase / RDS)" : "External (Neon / Supabase / RDS)"}</option>
              </select>
            </label>
            {provider === "external_postgres" && (
              <label className="browser-form-field">
                <span>Connection string <i className="required-star">*</i></span>
                <input
                  value={connectionString}
                  placeholder="postgres://user:password@host:5432/database"
                  onChange={(event) => { setConnectionString(event.target.value); setLocalError(null); }}
                />
                {connectionString.trim() && !connectionValid && (
                  <small className="ds-hint-error">{isUk ? "Рядок має починатися з postgres://" : "The string must start with postgres://"}</small>
                )}
                <small>{isUk ? "Рядок шифрується й ніколи не повертається API." : "The string is encrypted and never returned by the API."}</small>
              </label>
            )}
          </section>

          {localError && (
            <div className="data-studio-alert error" role="alert" style={{ margin: "14px 26px 0" }}>
              {localError}
            </div>
          )}

          <footer style={{ justifyContent: "flex-end" }}>
            <button
              type="submit"
              className="button-primary automations-action-primary"
              disabled={!canSubmit || working || busy}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px", whiteSpace: "nowrap" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{working || busy ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити базу" : "Create database"}</span>
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
