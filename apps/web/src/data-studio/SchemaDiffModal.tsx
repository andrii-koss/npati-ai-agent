import React from "react";
import type { PreviewDiff } from "./types";

export interface SchemaDiffModalProps {
  pendingDiff: PreviewDiff | null;
  onClose: () => void;
  isUk: boolean;
  confirmDestructive: boolean;
  setConfirmDestructive: (val: boolean) => void;
  applyingSchema: boolean;
  onApply: () => void | Promise<void>;
}

export function SchemaDiffModal({
  pendingDiff,
  onClose,
  isUk,
  confirmDestructive,
  setConfirmDestructive,
  applyingSchema,
  onApply,
}: SchemaDiffModalProps) {
  if (!pendingDiff) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer diff-preview-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>🔍 {isUk ? "Перевірка змін схеми (Dry Run Diff)" : "Schema Diff Preview (Dry Run)"}</h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>

        <div className="diff-preview-content">
          <div className="diff-flags-row">
            <span className={`diff-pill ${pendingDiff.reversible ? "green" : "gray"}`}>
              {pendingDiff.reversible ? "✓ Reversible" : "✗ Irreversible"}
            </span>
            {pendingDiff.destructive && <span className="diff-pill red">⚠️ Destructive</span>}
            {pendingDiff.requiresSnapshot && <span className="diff-pill blue">📸 Requires Snapshot</span>}
          </div>

          {pendingDiff.destructive && (
            <div className="data-studio-alert warning">
              <p>
                <strong>{isUk ? "Увага: це деструктивна операція!" : "Caution: This operation is destructive!"}</strong>{" "}
                {isUk
                  ? "Дані можуть бути частково або повністю втрачені. Перед застосуванням автоматично створиться snapshot бази даних."
                  : "Existing data in affected columns or tables may be permanently lost. A snapshot will be captured before executing."}
              </p>
              <label className="checkbox-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={confirmDestructive}
                  onChange={(e) => setConfirmDestructive(e.target.checked)}
                />
                <span>{isUk ? "Я розумію ризики і підтверджую застосування" : "I understand and confirm this destructive change"}</span>
              </label>
            </div>
          )}

          <div className="sql-preview-box">
            <p><strong>{isUk ? "Згенерований SQL (виконується роль migrator):" : "Generated SQL (applied by migrator role):"}</strong></p>
            <pre><code>{pendingDiff.upSql}</code></pre>
          </div>

          {pendingDiff.downSql && (
            <div className="sql-preview-box">
              <p><small>{isUk ? "SQL відкату (down):" : "Rollback SQL (down):"}</small></p>
              <pre><code>{pendingDiff.downSql}</code></pre>
            </div>
          )}
        </div>

        <footer style={{ justifyContent: "flex-end" }}>
          <button type="button" className="button-secondary" onClick={onClose}>
            {isUk ? "Скасувати" : "Cancel"}
          </button>
          <button
            type="button"
            className="button-primary apply-btn"
            disabled={applyingSchema || ((pendingDiff.destructive || pendingDiff.requiresSnapshot) && !confirmDestructive)}
            onClick={() => void onApply()}
          >
            {applyingSchema ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати зміни (Apply)" : "Apply Changes"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
