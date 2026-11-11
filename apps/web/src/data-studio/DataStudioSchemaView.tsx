import React from "react";

export interface DataStudioSchemaViewProps {
  isUk: boolean;
  environment: "dev" | "prod";
  isDrift: boolean;
  currentTable: {
    columns: { name: string; type: string; nullable?: boolean }[];
    constraints: string[];
  };
  onOpenAddField: () => void;
  onOpenAddRelation: () => void;
  handleDeleteField: (fieldName: string) => Promise<void>;
}

export function DataStudioSchemaView({
  isUk,
  environment,
  isDrift,
  currentTable,
  onOpenAddField,
  onOpenAddRelation,
  handleDeleteField,
}: DataStudioSchemaViewProps) {
  return (
    <div className="schema-editor-content">
      <div className="schema-section">
        <div className="schema-section-header">
          <h3>{isUk ? "Поля колекції" : "Fields & Columns"}</h3>
          {environment === "dev" && !isDrift && (
            <button
              type="button"
              className="button-primary"
              onClick={onOpenAddField}
            >
              + {isUk ? "Додати поле" : "Add Field"}
            </button>
          )}
        </div>

        <div className="schema-table-scroll">
        <table className="data-studio-table schema-table">
          <thead>
            <tr>
              <th>{isUk ? "Назва" : "Name"}</th>
              <th>{isUk ? "Тип" : "Type"}</th>
              <th>{isUk ? "Обов'язкове" : "Required"}</th>
              {environment === "dev" && <th>{isUk ? "Дії" : "Actions"}</th>}
            </tr>
          </thead>
          <tbody>
            {currentTable.columns.map((col) => {
              const isPk = col.name === "id";
              return (
                <tr key={col.name}>
                  <td>
                    <strong>{col.name}</strong>
                    {isPk && <span className="pk-badge">PRIMARY KEY</span>}
                  </td>
                  <td><code>{col.type}</code></td>
                  <td>{col.nullable ? isUk ? "Ні" : "No" : <strong>{isUk ? "Так" : "Yes"}</strong>}</td>
                  {environment === "dev" && (
                    <td>
                      {!isPk && !isDrift && (
                        <button
                          type="button"
                          className="button-secondary table-action-btn danger"
                          onClick={() => void handleDeleteField(col.name)}
                        >
                          {isUk ? "Видалити" : "Delete"}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Relations Section */}
      <div className="schema-section relations-section">
        <div className="schema-section-header">
          <h3>{isUk ? "Зв'язки між колекціями" : "Relations"}</h3>
          {environment === "dev" && !isDrift && (
            <button
              type="button"
              className="button-secondary"
              onClick={onOpenAddRelation}
            >
              + {isUk ? "Додати зв'язок" : "Add Relation"}
            </button>
          )}
        </div>

        {currentTable.constraints.filter((c) => c.includes("FOREIGN KEY") || c.includes("REFERENCES")).length === 0 ? (
          <p className="muted-text">
            {isUk ? "Прямих зовнішніх ключів для цієї таблиці немає." : "No explicit foreign key relations defined for this table."}
          </p>
        ) : (
          <ul className="relations-list">
            {currentTable.constraints
              .filter((c) => c.includes("FOREIGN KEY") || c.includes("REFERENCES"))
              .map((c, i) => (
                <li key={i} className="relation-item">
                  <code>{c}</code>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
