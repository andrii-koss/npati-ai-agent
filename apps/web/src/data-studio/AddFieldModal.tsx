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
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>
        <form onSubmit={onSubmit}>
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

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={newFieldRequired}
              onChange={(e) => setNewFieldRequired(e.target.checked)}
            />
            <span>{isUk ? "Обов'язкове поле (NOT NULL)" : "Required field (NOT NULL)"}</span>
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

          <footer>
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
