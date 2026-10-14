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

      {/* Header */}
      <header className="data-studio-header">
        <div className="data-studio-header-left">
          <div className="data-studio-breadcrumbs">
            <Link to="/company">{isUk ? "Компанія" : "Company"}</Link>
            <span>/</span>
            <Link to={`/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`}>
              {project?.name || "Project"}
            </Link>
            <span>/</span>
            <strong>Data Studio</strong>
          </div>
          <div className="data-studio-title-row">
            <h1>{overview?.backend.name || "Data Studio"}</h1>
            <span className={`status-pill status-${overview?.backend.status}`}>{overview?.backend.status}</span>
          </div>
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
                ? isUk ? "⚠️ Розбіжність (Drift)" : "⚠️ Drift Detected"
                : isUk ? "⛔ Потрібна реконсиляція" : "⛔ Reconciliation"}
            </span>
          </div>

          {/* Migration Lock Indicator */}
          {migrationLock?.held && (
            <div className="migration-lock-pill" title={`Expires: ${migrationLock.expiresAt || "soon"}`}>
              🔒 {isUk ? "Міграція виконується" : "Locked"}
            </div>
          )}

          <Link
            to={`/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`}
            className="button-secondary back-project-btn"
          >
            {isUk ? "До редактора сайту ↗" : "Website Editor ↗"}
          </Link>
        </div>
      </header>

      {/* Production Warning Banner */}
      {environment === "prod" && (
        <div className="data-studio-alert info">
          <span>{isUk ? "🛡️ Режим Production: зміни схеми дозволені лише через Promote (D7). Дані доступні лише для читання/перегляду." : "🛡️ Production Mode: Schema modifications require Promote (D7). Data is read-only here."}</span>
        </div>
      )}

      {/* Drift Warning Banner */}
      {isDrift && (
        <div className="data-studio-alert warning">
          <div className="alert-content">
            <strong>{isUk ? "⚠️ Виявлено розбіжність схеми бази даних (Schema Drift)" : "⚠️ Database Schema Drift Detected"}</strong>
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
