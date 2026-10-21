import React from "react";

export interface CreateCollectionModalProps {
  isOpen: boolean;
  isUk: boolean;
  newCollectionName: string;
  setNewCollectionName: (val: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function CreateCollectionModal({
  isOpen,
  isUk,
  newCollectionName,
  setNewCollectionName,
  onClose,
  onSubmit,
}: CreateCollectionModalProps) {
  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{isUk ? "Створити нову колекцію" : "Create Collection"}</h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>
        <form onSubmit={onSubmit}>
          <section>
            <label>
              <span>{isUk ? "Назва колекції (таблиці):" : "Collection name (table):"}</span>
              <input
                type="text"
                required
                pattern="^[a-z][a-z0-9_]{0,62}$"
                placeholder="e.g. products, categories, orders"
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                maxLength={63}
              />
              <small style={{ color: "#64748b", fontSize: "12px", marginTop: "4px" }}>
                {isUk ? "Лише малі літери, цифри та підкреслення (напр. products)" : "Lowercase letters, numbers, and underscores only"}
              </small>
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
