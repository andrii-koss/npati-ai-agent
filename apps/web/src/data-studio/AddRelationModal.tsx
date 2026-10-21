import React from "react";
import type { RelationCardinality } from "./types";

export interface AddRelationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  isUk: boolean;
  relationCardinality: RelationCardinality;
  setRelationCardinality: (val: RelationCardinality) => void;
  relationTarget: string;
  setRelationTarget: (val: string) => void;
  relationName: string;
  setRelationName: (val: string) => void;
  userCollections: { name: string }[];
  selectedCollection: string;
}

export function AddRelationModal({
  isOpen,
  onClose,
  onSubmit,
  isUk,
  relationCardinality,
  setRelationCardinality,
  relationTarget,
  setRelationTarget,
  relationName,
  setRelationName,
  userCollections,
  selectedCollection,
}: AddRelationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{isUk ? "Створити зв'язок між колекціями" : "Create Collection Relation"}</h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>
        <form onSubmit={onSubmit}>
          <section>
            <label>
              <span>{isUk ? "Тип зв'язку (кардинальність):" : "Cardinality:"}</span>
              <select
                value={relationCardinality}
                onChange={(e) => setRelationCardinality(e.target.value as RelationCardinality)}
              >
                <option value="many-to-one">Many-to-One (N:1, e.g. products → category)</option>
                <option value="one-to-many">One-to-Many (1:N, e.g. category → products)</option>
                <option value="many-to-many">Many-to-Many (M:N, via join table)</option>
              </select>
            </label>

            <label>
              <span>{isUk ? "Цільова колекція:" : "Target collection:"}</span>
              <select value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)} required>
                <option value="">{isUk ? "-- Оберіть колекцію --" : "-- Select target collection --"}</option>
                {userCollections
                  .filter((c) => c.name !== selectedCollection)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>

            <label>
              <span>
                {relationCardinality === "many-to-many"
                  ? isUk ? "Назва Join таблиці:" : "Join table name:"
                  : isUk ? "Назва колонки зв'язку:" : "Relation column name:"}
              </span>
              <input
                type="text"
                required
                pattern="^[a-z][a-z0-9_]{0,62}$"
                placeholder={relationCardinality === "many-to-many" ? "e.g. product_categories" : "e.g. category_id"}
                value={relationName}
                onChange={(e) => setRelationName(e.target.value)}
                maxLength={63}
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
