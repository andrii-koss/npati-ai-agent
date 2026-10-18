import React, { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

/**
 * R1 (section A, item 3): the code-run **queue** panel of Settings → Code.
 *
 * `CodeRunQueue.state()` was implemented in C10 and had no caller, so the limits existed but were invisible:
 * a user whose run did not start could not tell "the deployment is at capacity" from "something is stuck", and
 * an operator could not see which Company was holding the capacity. This panel renders the read-only answer of
 * `GET /companies/:companyId/code/runs/queue` — active/queued counts, the served order of the waiting tickets
 * **of this Company**, and the periodic (windowed) counters that refuse a start before the queue is even
 * consulted.
 *
 * It performs no mutation and takes no queue slot: the endpoint it reads is read-only by construction, which is
 * why the panel stays useful while the Coding Agent's feature flags are off. The response is projected
 * server-side onto the caller's own Company, so nothing here can display another tenant's runs.
 */

export interface CodeQueueStatusView {
  active: number;
  queued: number;
  limits: { maxConcurrentPerUser: number; maxConcurrentPerCompany: number; queueTimeoutMs: number; maxQueueDepth: number };
  companyId: string;
  companyActive: number;
  userActive: number;
  queue: Array<{ sessionId: string; companyId: string; userId: string; position: number; waitedMs: number }>;
  rateLimits: {
    limits: { maxRunsPerUserPerPeriod: number; maxRunsPerCompanyPerPeriod: number; periodMs: number };
    user: { used: number; limit: number; resetAt: string | null };
    company: { used: number; limit: number; resetAt: string | null };
  };
}

async function apiFetch<T>(path: string): Promise<T> {
  const headers = new Headers();
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch("/api" + path, { headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & { code?: string; status?: number };
    error.code = result?.error?.code;
    error.status = response.status;
    throw error;
  }
  return result as T;
}

/** Seconds into a short, locale-independent duration. Bounded so a huge wait cannot render as a wall of digits. */
export function formatQueueWait(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function CodeQueuePanel({ companyId, isUk }: { companyId: string; isUk: boolean }): React.ReactElement {
  const [status, setStatus] = useState<CodeQueueStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      setStatus(await apiFetch<CodeQueueStatusView>(`/companies/${encodeURIComponent(companyId)}/code/runs/queue`));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isUk ? "Запит не вдався" : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [companyId, isUk]);

  useEffect(() => { void load(); }, [load]);

  const periodMinutes = status?.rateLimits?.limits?.periodMs
    ? Math.round(status.rateLimits.limits.periodMs / 60_000)
    : 0;

  return (
    <section className="browser-campaign-card code-run-queue-panel" aria-label={isUk ? "Черга код-ранів" : "Code run queue"} data-panel="code-run-queue">
      <div className="browser-campaign-card-header">
        <div className="browser-card-title-group">
          <span className="browser-card-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </span>
          <div>
            <h3>{isUk ? "Черга код-ранів" : "Code run queue"}</h3>
            <p>
              {isUk
                ? "Стан черги та лімітів. Панель нічого не запускає і не змінює."
                : "The state of the queue and its limits. This panel starts and changes nothing."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="button-secondary"
          data-action="refresh-queue"
          onClick={() => void load()}
          disabled={loading || !companyId}
        >
          {loading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити" : "Refresh"}
        </button>
      </div>

      {error && <div className="data-studio-alert warning" data-field="queue-error">{error}</div>}
      {status && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "12px",
              marginBottom: "18px",
            }}
          >
            <div
              style={{
                padding: "16px 20px",
                background: "#ffffff",
                border: "1px solid var(--npati-gray-100)",
                borderRadius: "14px",
                boxShadow: "0 2px 8px rgba(17, 17, 17, 0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--npati-black)" }}>
                  {isUk ? "Виконується / у черзі" : "Active / queued"}
                </div>
                <small style={{ fontSize: "11.5px", color: "#64748b", display: "block", marginTop: "2px" }}>
                  {isUk ? "Поточний стан черги" : "Current queue status"}
                </small>
              </div>
              <span
                data-field="queue-totals"
                style={{
                  fontSize: "15px",
                  fontWeight: 800,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--npati-black)",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "5px 12px",
                  whiteSpace: "nowrap",
                }}
              >
                {`${status.active ?? 0} / ${status.queued ?? 0}`}
              </span>
            </div>

            <div
              style={{
                padding: "16px 20px",
                background: "#ffffff",
                border: "1px solid var(--npati-gray-100)",
                borderRadius: "14px",
                boxShadow: "0 2px 8px rgba(17, 17, 17, 0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--npati-black)" }}>
                  {isUk ? "Паралельно (ви / компанія)" : "Parallel (you / company)"}
                </div>
                <small style={{ fontSize: "11.5px", color: "#64748b", display: "block", marginTop: "2px" }}>
                  {isUk ? "Ліміт одночасних запусків" : "Current concurrency"}
                </small>
              </div>
              <span
                data-field="queue-concurrency"
                style={{
                  fontSize: "15px",
                  fontWeight: 800,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--npati-black)",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "5px 12px",
                  whiteSpace: "nowrap",
                }}
              >
                {`${status.userActive ?? 0} / ${status.limits?.maxConcurrentPerUser ?? 0} · ${status.companyActive ?? 0} / ${status.limits?.maxConcurrentPerCompany ?? 0}`}
              </span>
            </div>

            <div
              style={{
                padding: "16px 20px",
                background: "#ffffff",
                border: "1px solid var(--npati-gray-100)",
                borderRadius: "14px",
                boxShadow: "0 2px 8px rgba(17, 17, 17, 0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--npati-black)" }}>
                  {isUk ? `Запуски за ${periodMinutes} хв (ви / компанія)` : `Starts per ${periodMinutes} min`}
                </div>
                <small style={{ fontSize: "11.5px", color: "#64748b", display: "block", marginTop: "2px" }}>
                  {isUk ? "Періодичний ліміт запусків" : "You / company"}
                </small>
              </div>
              <span
                data-field="queue-rate"
                style={{
                  fontSize: "15px",
                  fontWeight: 800,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--npati-black)",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "5px 12px",
                  whiteSpace: "nowrap",
                }}
              >
                {`${status.rateLimits?.user?.used ?? 0}/${status.rateLimits?.user?.limit ?? 0} · ${status.rateLimits?.company?.used ?? 0}/${status.rateLimits?.company?.limit ?? 0}`}
              </span>
            </div>

            <div
              style={{
                padding: "16px 20px",
                background: "#ffffff",
                border: "1px solid var(--npati-gray-100)",
                borderRadius: "14px",
                boxShadow: "0 2px 8px rgba(17, 17, 17, 0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--npati-black)" }}>
                  {isUk ? "Максимальна довжина черги" : "Maximum queue length"}
                </div>
                <small style={{ fontSize: "11.5px", color: "#64748b", display: "block", marginTop: "2px" }}>
                  {isUk ? "Обмеження місткості черги" : "Company depth limit"}
                </small>
              </div>
              <span
                data-field="queue-depth"
                style={{
                  fontSize: "15px",
                  fontWeight: 800,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--npati-black)",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "5px 12px",
                  whiteSpace: "nowrap",
                }}
              >
                {status.limits?.maxQueueDepth ?? 0}
              </span>
            </div>
          </div>

          {Array.isArray(status.queue) && status.queue.length > 0 && (
            <div className="automations-table-container">
              <table className="automations-table" data-field="queue-tickets">
                <thead>
                  <tr>
                    <th>{isUk ? "Місце" : "Position"}</th>
                    <th>{isUk ? "Сесія" : "Session"}</th>
                    <th>{isUk ? "Очікування" : "Waiting"}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.queue.map((entry) => (
                    <tr key={entry.sessionId}>
                      <td><strong>#{entry.position}</strong></td>
                      <td><code>{entry.sessionId}</code></td>
                      <td className="ds-muted">{formatQueueWait(entry.waitedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
