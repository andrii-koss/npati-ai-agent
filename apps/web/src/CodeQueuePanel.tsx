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

  const periodMinutes = status ? Math.round(status.rateLimits.limits.periodMs / 60_000) : 0;

  return (
    <section className="code-images-panel" aria-label={isUk ? "Черга код-ранів" : "Code run queue"} data-panel="code-run-queue">
      <div className="ds-section-title">{isUk ? "Черга код-ранів" : "Code run queue"}</div>
      <p className="ds-muted">
        {isUk
          ? "Стан черги та лімітів. Панель нічого не запускає і не змінює."
          : "The state of the queue and its limits. This panel starts and changes nothing."}
      </p>
      <div className="browser-form-footer">
        <button type="button" className="button-secondary" data-action="refresh-queue" onClick={() => void load()} disabled={loading || !companyId}>
          {loading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити" : "Refresh"}
        </button>
      </div>
      {error && <div className="data-studio-alert warning" data-field="queue-error">{error}</div>}
      {status && (
        <>
          <div className="code-detail-row" data-field="queue-totals">
            <span>{isUk ? "Виконується / у черзі" : "Active / queued"}</span>
            <code>{`${status.active} / ${status.queued}`}</code>
          </div>
          <div className="code-detail-row" data-field="queue-concurrency">
            <span>{isUk ? "Паралельно (ви / компанія)" : "Parallel (you / company)"}</span>
            <code>{`${status.userActive} / ${status.limits.maxConcurrentPerUser} · ${status.companyActive} / ${status.limits.maxConcurrentPerCompany}`}</code>
          </div>
          <div className="code-detail-row" data-field="queue-rate">
            <span>{isUk ? `Запуски за ${periodMinutes} хв (ви / компанія)` : `Starts per ${periodMinutes} min (you / company)`}</span>
            <code>{`${status.rateLimits.user.used}/${status.rateLimits.user.limit} · ${status.rateLimits.company.used}/${status.rateLimits.company.limit}`}</code>
          </div>
          <div className="code-detail-row" data-field="queue-depth">
            <span>{isUk ? "Максимальна довжина черги" : "Maximum queue length"}</span>
            <code>{status.limits.maxQueueDepth}</code>
          </div>
          {status.queue.length === 0 ? (
            <p className="ds-muted" data-field="queue-empty">
              {isUk ? "У цій компанії нічого не чекає." : "Nothing from this company is waiting."}
            </p>
          ) : (
            <table className="ds-table" data-field="queue-tickets">
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
                    <td>{entry.position}</td>
                    <td><code>{entry.sessionId}</code></td>
                    <td className="ds-muted">{formatQueueWait(entry.waitedMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
