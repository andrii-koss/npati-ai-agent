import React from "react";
import { Link } from "react-router-dom";

export interface DataStudioEmptyBackendProps {
  project: { name?: string; dataBackendId?: string | null } | null;
  backends: { id: string; name: string; status: string }[];
  isUk: boolean;
  error: string | null;
  selectedBackendToAttach: string;
  setSelectedBackendToAttach: (val: string) => void;
  attachingBackend: boolean;
  handleAttachBackend: (id: string) => Promise<void>;
  newBackendName: string;
  setNewBackendName: (val: string) => void;
  handleCreateAndAttachBackend: () => Promise<void>;
}

export function DataStudioEmptyBackend({
  project,
  backends,
  isUk,
  error,
  selectedBackendToAttach,
  setSelectedBackendToAttach,
  attachingBackend,
  handleAttachBackend,
  newBackendName,
  setNewBackendName,
  handleCreateAndAttachBackend,
}: DataStudioEmptyBackendProps) {
  return (
    <main className="automations-container data-studio-container">
      <header className="inspector-header automations-header" style={{ marginBottom: "20px" }}>
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Компанія · Data Studio" : "Company · Data Studio"}</p>
            <h1>
              <Link
                to="/settings/data-studio"
                className="marketplace-back-button"
                aria-label={isUk ? "Назад до списку баз даних" : "Back to databases"}
                title={isUk ? "Назад до списку баз даних" : "Back to databases"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{project?.name ? `${project.name} data` : "Data Studio"}</span>
            </h1>
          </div>
        </div>
      </header>

      <section className="data-studio-empty-card" aria-label="No DataBackend Attached">
        <div className="empty-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#64748b" }}>
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
        </div>
        <h2>{isUk ? "До проєкту не підключено DataBackend" : "No DataBackend attached to this project"}</h2>
        <p>
          {isUk
            ? "Data Studio використовує окрему ізольовану базу даних (DataBackend) для збереження колекцій, зв'язків та записів вашого сайту."
            : "Data Studio uses an isolated project database (DataBackend) to store and manage your website's collections, schema, and records."}
        </p>

        {error && <div className="data-studio-alert error" role="alert">{error}</div>}

        <div className="data-studio-attach-options">
          {backends.filter((b) => b.status === "ready").length > 0 && (
            <div className="attach-existing-box">
              <h3>{isUk ? "Прикріпити існуючий DataBackend" : "Attach existing DataBackend"}</h3>
              <div className="form-row">
                <select
                  value={selectedBackendToAttach}
                  onChange={(e) => setSelectedBackendToAttach(e.target.value)}
                  disabled={attachingBackend}
                  aria-label="Select DataBackend"
                >
                  <option value="">{isUk ? "-- Оберіть DataBackend --" : "-- Select DataBackend --"}</option>
                  {backends
                    .filter((b) => b.status === "ready")
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.status})
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="button-primary"
                  disabled={!selectedBackendToAttach || attachingBackend}
                  onClick={() => void handleAttachBackend(selectedBackendToAttach)}
                >
                  {attachingBackend ? (isUk ? "Підключення…" : "Attaching…") : isUk ? "Підключити" : "Attach"}
                </button>
              </div>
            </div>
          )}

          <div className="create-new-backend-box">
            <h3>{isUk ? "Створити новий DataBackend для цього проєкту" : "Create new DataBackend for this project"}</h3>
            <div className="form-row">
              <input
                type="text"
                placeholder={isUk ? "Назва бази (напр. Store DB)" : "Backend name (e.g. Store DB)"}
                value={newBackendName}
                onChange={(e) => setNewBackendName(e.target.value)}
                maxLength={100}
                disabled={attachingBackend}
                aria-label="New DataBackend name"
              />
              <button
                type="button"
                className="button-primary"
                disabled={!newBackendName.trim() || attachingBackend}
                onClick={() => void handleCreateAndAttachBackend()}
              >
                {attachingBackend ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити й підключити" : "Create & Attach"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
