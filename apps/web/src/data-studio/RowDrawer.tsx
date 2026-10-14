import React from "react";

export interface RowDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  isUk: boolean;
  currentTable: { columns: { name: string; type: string; nullable?: boolean }[] } | null | undefined;
  selectedCollection: string;
  editingRow: Record<string, unknown> | null;
  rowFormData: Record<string, unknown>;
  setRowFormData: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}

export function RowDrawer({
  isOpen,
  onClose,
  onSubmit,
  isUk,
  currentTable,
  selectedCollection,
  editingRow,
  rowFormData,
  setRowFormData,
}: RowDrawerProps) {
  if (!isOpen || !currentTable) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer row-edit-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            {editingRow
              ? isUk ? `Редагувати рядок у "${selectedCollection}"` : `Edit Row in "${selectedCollection}"`
              : isUk ? `Додати рядок до "${selectedCollection}"` : `Create Row in "${selectedCollection}"`}
          </h2>
          <button type="button" className="company-drawer-close" onClick={onClose}>×</button>
        </header>

        <form onSubmit={onSubmit}>
          {currentTable.columns.map((col) => {
            if (col.name === "id") return null;
            const val = rowFormData[col.name];
            return (
              <label key={col.name} className="row-field-label">
                <span>
                  {col.name} <small className="muted-text">({col.type})</small>
                  {!col.nullable && <span className="req">*</span>}
                </span>

                {col.type === "boolean" ? (
                  <select
                    value={val === true || val === "true" ? "true" : val === false || val === "false" ? "false" : ""}
                    onChange={(e) =>
                      setRowFormData((prev) => ({
                        ...prev,
                        [col.name]: e.target.value === "true" ? true : e.target.value === "false" ? false : null,
                      }))
                    }
                  >
                    <option value="">null</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : col.type === "text" || col.type === "jsonb" ? (
                  <textarea
                    rows={col.type === "jsonb" ? 4 : 2}
                    value={typeof val === "object" && val !== null ? JSON.stringify(val, null, 2) : String(val ?? "")}
                    onChange={(e) =>
                      setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                    }
                    placeholder={col.type === "jsonb" ? "{ ... }" : ""}
                  />
                ) : col.type.includes("int") || col.type.includes("numeric") ? (
                  <input
                    type="number"
                    step={col.type.includes("int") ? "1" : "any"}
                    value={val == null ? "" : String(val)}
                    onChange={(e) =>
                      setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                    }
                  />
                ) : col.type === "date" ? (
                  <input
                    type="date"
                    value={val ? String(val).slice(0, 10) : ""}
                    onChange={(e) =>
                      setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                    }
                  />
                ) : (
                  <input
                    type="text"
                    value={val == null ? "" : String(val)}
                    onChange={(e) =>
                      setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                    }
                  />
                )}
              </label>
            );
          })}

          <footer>
            <button type="button" className="button-secondary" onClick={onClose}>
              {isUk ? "Скасувати" : "Cancel"}
            </button>
            <button type="submit" className="button-primary">
              {editingRow ? (isUk ? "Зберегти зміни" : "Save Changes") : isUk ? "Створити рядок" : "Create Row"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
