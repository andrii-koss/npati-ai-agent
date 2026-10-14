import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BackendSummary, CompanySummary } from "./types";
import { errorCode, transferErrorMessage } from "./helpers";

export interface TransferDatabaseDrawerProps {
  isUk: boolean;
  backend: BackendSummary;
  /** Companies the database can move to (every company except the current one). */
  companies: CompanySummary[];
  /** Projects of the current company attached to this database: they stay behind. */
  attachedProjects: number;
  busy: boolean;
  onClose: () => void;
  onTransfer: (input: { targetCompanyId: string; confirmName: string }) => Promise<void>;
}

export function TransferDatabaseDrawer({ isUk, backend, companies, attachedProjects, busy, onClose, onTransfer }: TransferDatabaseDrawerProps) {
  const [targetCompanyId, setTargetCompanyId] = useState(() => companies[0]?.id ?? "");
  const [confirmName, setConfirmName] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const targetRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => targetRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, []);

  const nameMatches = confirmName.trim() === backend.name;
  const canSubmit = Boolean(targetCompanyId) && nameMatches && targetCompanyId !== backend.companyId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onTransfer({ targetCompanyId, confirmName: confirmName.trim() });
    } catch (cause) {
      setLocalError(transferErrorMessage(isUk, errorCode(cause), cause instanceof Error ? cause.message : "Could not transfer the database"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => onClose()}>
      <aside className="company-drawer automations-drawer" role="dialog" aria-modal="true" aria-label={isUk ? "Перенести базу даних" : "Move the database"} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>Data Studio</span>
            <h2>{isUk ? "Перенести базу даних" : "Move the database"}</h2>
          </div>
          <button type="button" className="automations-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {companies.length === 0 ? (
          <section>
            <h3>{isUk ? "Немає куди переносити" : "No target company"}</h3>
            <p className="ds-muted">
              {isUk
                ? "У робочому просторі лише одна компанія. Створіть другу — і базу можна буде перенести разом з усіма даними."
                : "The workspace has a single company. Create another one — then the database can move together with all of its data."}
            </p>
            <div className="browser-form-footer">
              <div className="browser-form-footer-hint">
                <Link to="/settings/company">{isUk ? "створити компанію" : "create a company"}</Link>
              </div>
              <button type="button" className="button-secondary" onClick={onClose}>{isUk ? "Закрити" : "Close"}</button>
            </div>
          </section>
        ) : (
          <form onSubmit={submit}>
            <section>
              <h3>{isUk ? "Куди перенести" : "Where to move"}</h3>
              <label className="browser-form-field">
                <span>{isUk ? "Цільова компанія" : "Target company"} <i className="required-star">*</i></span>
                <select ref={targetRef} value={targetCompanyId} onChange={(event) => { setTargetCompanyId(event.target.value); setLocalError(null); }}>
                  {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>

              <div className="data-studio-alert info" role="status">
                {isUk
                  ? "База переїде разом з усіма даними: таблиці, ключі API, налаштування Auth, бекапи. Фізична база та ролі не перестворюються — дані не втрачаються."
                  : "The database moves with all of its data: tables, API keys, Auth settings and backups. The physical database and its roles are not recreated — nothing is lost."}
              </div>

              {attachedProjects > 0 && (
                <div className="data-studio-alert warning" role="alert">
                  {isUk
                    ? `Буде від'єднано проєктів: ${attachedProjects} — вони залишаться в старій компанії без бази; після перенесення прикріпіть базу до проєктів нової компанії.`
                    : `Projects to detach: ${attachedProjects} — they stay in the old company without a database; after the move attach the database to the new company's projects.`}
                </div>
              )}

              <label className="browser-form-field">
                <span>
                  {isUk
                    ? <>Введіть назву бази <code>{backend.name}</code> для підтвердження <i className="required-star">*</i></>
                    : <>Type the database name <code>{backend.name}</code> to confirm <i className="required-star">*</i></>}
                </span>
                <input
                  value={confirmName}
                  placeholder={backend.name}
                  onChange={(event) => { setConfirmName(event.target.value); setLocalError(null); }}
                />
                {confirmName.trim() && !nameMatches && (
                  <small className="ds-hint-error">{isUk ? "Назва не збігається" : "Name does not match"}</small>
                )}
              </label>
            </section>

            {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

            <div className="browser-form-footer">
              <div className="browser-form-footer-hint">
                {isUk
                  ? "Після перенесення стару компанію можна видалити — база даних і дані залишаться в новій компанії."
                  : "After the move the old company can be deleted — the database and its data stay in the new company."}
              </div>
              <button type="submit" className="button-primary automations-action-primary browser-submit-btn" disabled={!canSubmit || working || busy}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
                {working || busy ? (isUk ? "Переносимо…" : "Moving…") : isUk ? "Перенести базу" : "Move database"}
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
