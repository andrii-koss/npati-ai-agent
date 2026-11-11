import React from "react";
import type { FieldType } from "./types";

export interface AddFieldModalProps {
  isOpen: boolean;
  isUk: boolean;
  selectedCollection: string;
  newFieldName: string;
  setNewFieldName: (val: string) => void;
  newFieldType: FieldType;
  setNewFieldType: (val: FieldType) => void;
  newFieldRequired: boolean;
  setNewFieldRequired: (val: boolean) => void;
  newFieldDefault: string;
  setNewFieldDefault: (val: string) => void;
  newFieldEnumOptions: string;
  setNewFieldEnumOptions: (val: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function AddFieldModal({
  isOpen,
  isUk,
  selectedCollection,
  newFieldName,
  setNewFieldName,
  newFieldType,
  setNewFieldType,
  newFieldRequired,
  setNewFieldRequired,
  newFieldDefault,
  setNewFieldDefault,
  newFieldEnumOptions,
  setNewFieldEnumOptions,
  onClose,
  onSubmit,
}: AddFieldModalProps) {
  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{isUk ? `Додати поле до "${selectedCollection}"` : `Add Field to "${selectedCollection}"`}</h2>
          <button type="button" className="company-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <section>
            <label>
              <span>{isUk ? "Назва поля (колонки):" : "Field name:"}</span>
              <input
                type="text"
                required
                pattern="^[a-z][a-z0-9_]{0,62}$"
                placeholder="e.g. price, title, is_active"
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value)}
                maxLength={63}
              />
            </label>

            <label>
              <span>{isUk ? "Тип поля:" : "Field type:"}</span>
              <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value as FieldType)}>
                <option value="string">String (varchar 255)</option>
                <option value="text">Text (multiline)</option>
                <option value="integer">Integer (bigint)</option>
                <option value="decimal">Decimal (numeric 20,6)</option>
                <option value="boolean">Boolean (true/false)</option>
                <option value="date">Date</option>
                <option value="datetime">Datetime (timestamptz)</option>
                <option value="json">JSON (jsonb)</option>
                <option value="uuid">UUID</option>
                <option value="enum">Enum (choice)</option>
                <option value="file_reference">File Reference (uuid)</option>
              </select>
            </label>

            {newFieldType === "enum" && (
              <label>
                <span>{isUk ? "Варіанти Enum (через кому):" : "Enum options (comma-separated):"}</span>
                <input
                  type="text"
                  required
                  placeholder="active, draft, archived"
                  value={newFieldEnumOptions}
                  onChange={(e) => setNewFieldEnumOptions(e.target.value)}
                />
              </label>
            )}

            <label className="checkbox-label" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", margin: "4px 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={newFieldRequired}
                onChange={(e) => setNewFieldRequired(e.target.checked)}
              />
              <span style={{ fontSize: "13px", fontWeight: "normal", color: "inherit" }}>{isUk ? "Обов'язкове поле (NOT NULL)" : "Required field (NOT NULL)"}</span>
            </label>

            <label>
              <span>{isUk ? "Значення за замовчуванням (опційно):" : "Default value (optional):"}</span>
              <input
                type="text"
                placeholder="e.g. 0, active, true"
                value={newFieldDefault}
                onChange={(e) => setNewFieldDefault(e.target.value)}
              />
            </label>
          </section>

          <footer style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button-secondary" onClick={onClose}>
              {isUk ? "Скасувати" : "Cancel"}
            </button>
            <button type="submit" className="button-primary">
              {isUk ? "Переглянути зміну →" : "Preview Diff →"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
