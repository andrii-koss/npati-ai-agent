import React from "react";

export interface ImportRowsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  isUk: boolean;
  selectedCollection: string;
  importFormat: "csv" | "json";
  setImportFormat: (val: "csv" | "json") => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  importContent: string;
  setImportContent: (val: string) => void;
  importing: boolean;
}

export function ImportRowsModal({
  isOpen,
  onClose,
  onSubmit,
  isUk,
  selectedCollection,
  importFormat,
  setImportFormat,
  handleFileUpload,
  importContent,
  setImportContent,
  importing,
}: ImportRowsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>📤 {isUk ? `Імпорт у "${selectedCollection}"` : `Import into "${selectedCollection}"`}</h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>

        <form onSubmit={onSubmit}>
          <div className="import-format-toggle">
            <label>
              <span>{isUk ? "Формат даних:" : "Data format:"}</span>
              <select value={importFormat} onChange={(e) => setImportFormat(e.target.value as "csv" | "json")}>
                <option value="csv">CSV (Comma-separated)</option>
                <option value="json">JSON Array</option>
              </select>
            </label>

            <label>
              <span>{isUk ? "Завантажити файл (< 1 МБ):" : "Upload file (< 1 MB):"}</span>
              <input type="file" accept=".csv,.json" onChange={handleFileUpload} />
            </label>
          </div>

          <label>
            <span>{isUk ? "Або вставте вміст:" : "Or paste content directly:"}</span>
            <textarea
              rows={8}
              placeholder={importFormat === "csv" ? "title,price,is_active\nProduct A,100,true" : '[{"title": "Product A", "price": 100}]'}
              value={importContent}
              onChange={(e) => setImportContent(e.target.value)}
              required
            />
          </label>

          <footer>
            <button type="button" className="button-secondary" onClick={onClose}>
              {isUk ? "Скасувати" : "Cancel"}
            </button>
            <button type="submit" className="button-primary" disabled={importing || !importContent.trim()}>
              {importing ? (isUk ? "Імпортування…" : "Importing…") : isUk ? "Імпортувати" : "Import Rows"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
