import React from "react";
import type { OverviewData } from "./types";

export interface DriftModalProps {
  isOpen: boolean;
  onClose: () => void;
  isUk: boolean;
  drift?: OverviewData["drift"];
}

export function DriftModal({ isOpen, onClose, isUk, drift }: DriftModalProps) {
  if (!isOpen || !drift) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer drift-modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>⚠️ {isUk ? "Деталі розбіжності схеми (Schema Drift)" : "Schema Drift Inspection"}</h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>

        <div className="drift-modal-content">
          <p>
            {isUk
              ? "Схема реальної бази даних не збігається з очікуваною історією міграцій. Авто-застосування заблоковано."
              : "The live database schema fingerprint differs from expected migrations. Schema migrations are paused."}
          </p>

          <div className="drift-fingerprints">
            <div>
              <small>{isUk ? "Очікуваний Fingerprint (Core):" : "Expected Fingerprint (Core):"}</small>
              <code>{drift.expected || "none"}</code>
            </div>
            <div>
              <small>{isUk ? "Фактичний Fingerprint (Live DB):" : "Actual Fingerprint (Live DB):"}</small>
              <code>{drift.actual || "none"}</code>
            </div>
          </div>

          <div className="drift-tables-diff">
            <h4>{isUk ? "Розбіжності по таблицях:" : "Tables Diff:"}</h4>
            {drift.tables.added.length > 0 && (
              <div className="diff-item added">
                <strong>+ Added outside migrations:</strong> {drift.tables.added.join(", ")}
              </div>
            )}
            {drift.tables.removed.length > 0 && (
              <div className="diff-item removed">
                <strong>- Removed outside migrations:</strong> {drift.tables.removed.join(", ")}
              </div>
            )}
            {drift.tables.changed.length > 0 && (
              <div className="diff-item changed">
                <strong>~ Changed outside migrations:</strong> {drift.tables.changed.join(", ")}
              </div>
            )}
            {drift.tables.added.length === 0 &&
              drift.tables.removed.length === 0 &&
              drift.tables.changed.length === 0 && (
                <p className="muted-text">{isUk ? "Зміни стосуються внутрішніх обмежень, типів або індексів." : "Differences are in internal constraints, types, or indexes."}</p>
              )}
          </div>
        </div>

        <footer>
          <button type="button" className="button-secondary" onClick={onClose}>
            {isUk ? "Закрити" : "Close"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
