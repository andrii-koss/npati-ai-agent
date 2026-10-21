import React from "react";
import { Link } from "react-router-dom";
import type { MigrationItem } from "./types";

export interface MigrationsPaneProps {
  isUk: boolean;
  environment: "dev" | "prod";
  migrations: MigrationItem[];
  onRevertMigration: (id: string, version: number) => Promise<void>;
}

export function MigrationsPane({
  isUk,
  environment,
  migrations,
  onRevertMigration,
}: MigrationsPaneProps) {
  return (
    <div className="data-studio-pane migrations-pane">
      <div className="pane-header">
        <div>
          <h2>{isUk ? "Історія міграцій схеми" : "Schema Migration History"}</h2>
          <p>{isUk ? "Версії та зміни структури бази даних проєкту" : "Track all schema version migrations applied to this database"}</p>
        </div>
      </div>

      <div className="migrations-table-container">
        <table className="data-studio-table">
          <thead>
            <tr>
              <th>v#</th>
              <th>{isUk ? "Операція" : "Operation"}</th>
              <th>{isUk ? "Автор" : "Author"}</th>
              <th>{isUk ? "Властивості" : "Flags"}</th>
              <th>{isUk ? "Статус" : "Status"}</th>
              <th>{isUk ? "Дата" : "Date"}</th>
              {environment === "dev" && <th>{isUk ? "Дії" : "Actions"}</th>}
            </tr>
          </thead>
          <tbody>
            {migrations.map((m) => {
              const isAgent = m.authorId.startsWith("agent:") || Boolean(m.runId);
              return (
                <tr key={m.id}>
                  <td><strong>#{m.version}</strong></td>
                  <td>
                    <code>{m.operation?.kind || "custom"}</code>
                    {m.operation && "collection" in m.operation && (
                      <span className="muted-table-text"> ({m.operation.collection})</span>
                    )}
                  </td>
                  <td>
                    {isAgent ? (
                      <span className="author-agent-badge" style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="16" height="16" x="4" y="4" rx="2" />
                          <rect width="6" height="6" x="9" y="9" rx="1" />
                          <path d="M15 2v2M9 2v2M20 15h2M20 9h2M9 20v2M15 20v2M2 15h2M2 9h2" />
                        </svg>
                        <span>Agent</span>
                        {m.runId && (
                          <Link to={`/activity?runId=${encodeURIComponent(m.runId)}`} className="run-link">
                            View Run ↗
                          </Link>
                        )}
                      </span>
                    ) : (
                      <span className="author-user-badge" style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span>User</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flags-row">
                      {m.reversible ? (
                        <span className="flag-pill reversible">reversible</span>
                      ) : (
                        <span className="flag-pill not-reversible">irreversible</span>
                      )}
                      {m.destructive && <span className="flag-pill destructive">destructive</span>}
                      {m.requiresSnapshot && <span className="flag-pill snapshot">snapshot</span>}
                    </div>
                  </td>
                  <td>
                    <span className={`status-pill status-${m.status}`}>{m.status}</span>
                  </td>
                  <td><small>{new Date(m.createdAt).toLocaleString()}</small></td>
                  {environment === "dev" && (
                    <td>
                      {m.reversible && m.status === "applied" && (
                        <button
                          type="button"
                          className="button-secondary table-action-btn danger"
                          onClick={() => void onRevertMigration(m.id, m.version)}
                          title={isUk ? "Відкотити міграцію" : "Rollback migration"}
                        >
                          {isUk ? "Відкотити" : "Revert"}
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
  );
}
