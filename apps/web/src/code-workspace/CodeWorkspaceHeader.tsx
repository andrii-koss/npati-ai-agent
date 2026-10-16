import { Link } from "react-router-dom";
import type { SessionMode, UsageResponse } from "../code-workspace-page-types";
interface Props {
  isUk: boolean;
  sessionId: string;
  runId: string;
  selectSession: (id: string) => void;
  sessions: Array<{ id: string; mode: SessionMode }>;
  deleteCurrentSession: () => Promise<void>;
  createNewSession: () => Promise<void>;
  taskBusy: boolean;
  mode: SessionMode;
  tree: { length: number };
  events: { length: number };
  changedFiles: { length: number };
  usage: UsageResponse | null;
}

export function CodeWorkspaceHeader({ isUk, sessionId, runId, selectSession, sessions, deleteCurrentSession, createNewSession, taskBusy, mode, tree, events, changedFiles, usage }: Props) {
  return (
    <>
      {/* Hero Header matching /settings/email and /settings/automations */}
      <header className="inspector-header automations-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{isUk ? "Кодовий агент та розробка" : "Code Agent & Workspace"}</p>
            <h1>
              <Link
                to="/settings/websites"
                className="marketplace-back-button"
                aria-label={isUk ? "Назад" : "Back"}
                title={isUk ? "Повернутися назад" : "Go back"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{isUk ? "Робочий простір кодового агента" : "Coding agent workspace"}</span>
            </h1>
            <p className="hero-copy">
              {isUk
                ? "Автономне середовище AI-розробника для аналізу вихідних файлів, внесення правок та виконання завдань вашого сайту чи проєкту."
                : "Autonomous AI developer environment to inspect, edit, and test website or project source code."}
            </p>
          </div>
        </div>
      </header>

      {/* Scope & Status Toolbar Card matching EmailSettingsOverviewBlock */}
      <div className="email-scope-toolbar">
        <div className="email-scope-left">
          <div className="email-scope-pill">
            <span className="email-scope-badge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>{isUk ? "Сесія:" : "Session:"}</span>
            </span>
            <div className="email-scope-select-wrap">
              <select
                className="email-scope-select"
                value={sessionId}
                onChange={(e) => selectSession(e.target.value)}
                aria-label={isUk ? "Вибрати сесію" : "Select session"}
              >
                {sessions.length > 0 ? (
                  sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      #{s.id.slice(0, 8)} ({s.mode})
                    </option>
                  ))
                ) : (
                  <option value="">{isUk ? "Нова сесія" : "New session"}</option>
                )}
              </select>
              <span className="email-scope-select-arrow" aria-hidden="true">▾</span>
            </div>
            {sessionId && (
              <button
                type="button"
                className="email-scope-delete-btn"
                onClick={() => void deleteCurrentSession()}
                disabled={taskBusy}
                title={isUk ? "Видалити поточну сесію" : "Delete current session"}
                aria-label={isUk ? "Видалити сесію" : "Delete session"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 6px",
                  borderRadius: "6px",
                  color: "#94a3b8",
                  transition: "color 0.15s, background 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#dc2626";
                  e.currentTarget.style.background = "#fee2e2";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "#94a3b8";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            )}
          </div>

          <span className="data-studio-badge info" style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 700, fontSize: "11px", letterSpacing: "0.06em" }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
            CODE WORKSPACE
          </span>
          <span className="data-studio-badge" style={{ background: "#f1f5f9", color: "#475569" }}>
            {isUk ? `Режим: ${mode}` : `Mode: ${mode}`}
          </span>
        </div>

        <div className="email-scope-right">
          <button
            type="button"
            className="button-primary automations-action-primary"
            onClick={() => void createNewSession()}
            disabled={taskBusy}
            title={isUk ? "Створити нову сесію розробки" : "Create new coding session"}
            style={{ padding: "7px 16px", fontSize: "13px" }}
          >
            + {isUk ? "Нова сесія" : "New session"}
          </button>
        </div>
      </div>

      {/* 4 Stat Overview Cards matching EmailSettingsStatsCards */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid" style={{ marginBottom: 20 }}>
        <div>
          <strong>{tree.length}</strong>
          <span>{isUk ? "Файлів проєкту" : "Project files"}</span>
          <small>{isUk ? "Вихідний код сайту" : "Source code files"}</small>
        </div>
        <div>
          <strong>{events.length}</strong>
          <span>{isUk ? "Подій у стрімі" : "Stream events"}</span>
          <small>{isUk ? (runId ? `Активний run #${runId.slice(0, 6)}` : "Очікування запуску") : (runId ? `Active run #${runId.slice(0, 6)}` : "Idle")}</small>
        </div>
        <div>
          <strong>{changedFiles.length}</strong>
          <span>{isUk ? "Змінених файлів" : "Changed files"}</span>
          <small>{isUk ? "Внесено правки" : "Modified by agent"}</small>
        </div>
        <div>
          <strong>{typeof usage?.usage?.costUsd === "number" ? `$${usage.usage.costUsd.toFixed(4)}` : "$0.00"}</strong>
          <span>{isUk ? "Витрати токенів" : "Token cost"}</span>
          <small>{usage?.usage?.totalTokens ? `${usage.usage.totalTokens} tokens` : (isUk ? "0 токенів" : "0 tokens")}</small>
        </div>
      </section>


    </>
  );
}
