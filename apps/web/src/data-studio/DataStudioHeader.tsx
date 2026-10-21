import React from "react";
import { Link } from "react-router-dom";
import type { OverviewData } from "./types";

export interface DataStudioHeaderProps {
  project: { name?: string; dataBackendId?: string | null } | null;
  overview: OverviewData | null;
  environment: "dev" | "prod";
  setEnvironment: (env: "dev" | "prod") => void;
  isUk: boolean;
  companyId: string;
  projectId: string;
  feedback: { message: string; type: "success" | "error" | "info" } | null;
  setShowDriftModal: (show: boolean) => void;
}

export function DataStudioHeader({
  project,
  overview,
  environment,
  setEnvironment,
  isUk,
  companyId,
  projectId,
  feedback,
  setShowDriftModal,
}: DataStudioHeaderProps) {
  const syncStatus = overview?.environment.syncStatus || "synced";
  const migrationLock = overview?.lock;
  const isDrift = syncStatus === "drift_detected" || syncStatus === "reconciliation_required";

  return (
    <>
      {/* Toast Feedback */}
      {feedback && (
        <div className={`data-studio-toast toast-${feedback.type}`} role="status">
          {feedback.message}
        </div>
      )}

      {/* Header matching /settings/code style */}
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
              <span>{overview?.backend.name || "Data Studio"}</span>
            </h1>
            <p className="hero-copy">
              <span className="data-studio-badge" title={isUk ? "Прив'язаний проєкт" : "Attached project"}>
                {isUk ? "Проєкт" : "Project"}: {project?.name || "Project"}
              </span>{" "}
              <span className={`status-pill status-${overview?.backend.status}`}>{overview?.backend.status}</span>{" "}
              <span className="data-studio-badge">NPATI</span>
            </p>
          </div>

          <div className="data-studio-header-right">
            {/* Environment Switcher */}
            <div className="env-switcher" role="radiogroup" aria-label="Environment">
              <button
                type="button"
                className={`env-btn ${environment === "dev" ? "active" : ""}`}
                onClick={() => setEnvironment("dev")}
              >
                dev
              </button>
              <button
                type="button"
                className={`env-btn ${environment === "prod" ? "active" : ""}`}
                onClick={() => setEnvironment("prod")}
              >
                prod
              </button>
            </div>

            {/* Sync Status Badge */}
            <div
              className={`sync-badge sync-${syncStatus} ${isDrift ? "clickable" : ""}`}
              onClick={() => isDrift && setShowDriftModal(true)}
              title={isDrift ? (isUk ? "Натисніть для перегляду розбіжностей" : "Click to view drift details") : ""}
              role={isDrift ? "button" : undefined}
            >
              <span className="dot" />
              <span>
                {syncStatus === "synced"
                  ? isUk ? "Синхронізовано" : "Synced"
                  : syncStatus === "drift_detected"
                  ? isUk ? "Розбіжність (Drift)" : "Drift Detected"
                  : isUk ? "Потрібна реконсиляція" : "Reconciliation"}
              </span>
            </div>

            {/* Migration Lock Indicator */}
            {migrationLock?.held && (
              <div className="migration-lock-pill" title={`Expires: ${migrationLock.expiresAt || "soon"}`} style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{isUk ? "Міграція виконується" : "Locked"}</span>
              </div>
            )}

            <Link
              to={`/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`}
              className="button-secondary back-project-btn"
              style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              <span>{isUk ? "Редактор сайту" : "Website Editor"}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </Link>
          </div>
        </div>
      </header>

      {/* Production Warning Banner */}
      {environment === "prod" && (
        <div className="data-studio-alert info" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>{isUk ? "Режим Production: зміни схеми дозволені лише через Promote (D7). Дані доступні лише для читання/перегляду." : "Production Mode: Schema modifications require Promote (D7). Data is read-only here."}</span>
        </div>
      )}

      {/* Drift Warning Banner */}
      {isDrift && (
        <div className="data-studio-alert warning">
          <div className="alert-content">
            <strong style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{isUk ? "Виявлено розбіжність схеми бази даних (Schema Drift)" : "Database Schema Drift Detected"}</span>
            </strong>
            <p>
              {isUk
                ? "Фактична структура бази даних відрізняється від історії міграцій NPATI. Застосування нових змін заблоковано для безпеки."
                : "The live project database schema has diverged from NPATI migrations history. New schema changes are blocked."}
            </p>
          </div>
          <button type="button" className="button-secondary" onClick={() => setShowDriftModal(true)}>
            {isUk ? "Переглянути різницю" : "View Drift Diff"}
          </button>
        </div>
      )}
    </>
  );
}
