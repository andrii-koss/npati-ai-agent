import React, { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";

type DataEnvironment = "dev" | "prod";
type Notify = (message: string, type?: "success" | "info" | "error") => void;
type SyncStatus = "synced" | "drift_detected" | "reconciliation_required";

export interface PromoteOperation {
  version: number;
  kind: string;
  collection?: string | null;
  sql: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
}

export interface PromotePreview {
  backendId: string;
  backendName: string;
  targetEnvironment: string;
  approvalRequired: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  reversible: boolean;
  operations: PromoteOperation[];
  pendingVersions: number[];
  alreadyApplied: number[];
  addedCollections: string[];
  removedCollections: string[];
  changedCollections: string[];
  dataPreview: Array<{ collection: string; rows: number }>;
  withData: boolean;
  drift: { status: string; actual?: string | null; expected?: string | null };
}

export interface PromotionRecord {
  id: string;
  status: string;
  targetEnvironment: string;
  flags: { destructive?: boolean; requiresSnapshot?: boolean; reversible?: boolean; withData?: boolean } | null;
  snapshotRef?: string | null;
  createdAt: string;
  appliedAt?: string | null;
  error?: string | null;
}

export interface QuotaReport {
  environment: DataEnvironment;
  usage: { bytes: number; connections: number };
  limits: {
    maxDatabaseBytes: number;
    maxConnections: number;
    maxCollections: number;
    maxFields: number;
    maxQueriesPerMinute: number;
  };
  state: "ok" | "warning" | "exceeded";
  databasePercent: number;
  writesBlocked: boolean;
  message?: string;
}

export interface DataStudioOperationsSectionProps {
  companyId: string;
  backendId: string;
  environment: DataEnvironment;
  isUk: boolean;
  notify?: Notify;
  /** Sync status from the Data Studio overview; drift blocks promote. */
  syncStatus?: SyncStatus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the Data Studio error envelope, tolerating `{ error: { code, message } }`, `{ error: "CODE" }` and `{ message }`. */
function apiError(body: any, status: number): string {
  const envelope = body?.error;
  const code = typeof envelope === "string" ? envelope : envelope?.code;
  const message =
    (typeof envelope === "object" && envelope ? envelope.message : undefined)
    ?? body?.message
    ?? code;
  if (!message) return `HTTP ${status}: Request failed`;
  return code && !String(message).includes(String(code)) ? `${message} (${code})` : String(message);
}

function formatBytes(bytes: number, isUk: boolean): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return isUk ? "0 Б" : "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function collectionList(items: string[], isUk: boolean, emptyLabel: string): React.ReactNode {
  if (!items.length) return <span className="muted">{emptyLabel}</span>;
  return (
    <span className="data-studio-chip-row">
      {items.map((item) => <span key={item} className="data-studio-chip">{item}</span>)}
    </span>
  );
}

/**
 * Promote (dev → prod) with approval, promotion history and quotas (D7).
 */
export function DataStudioOperationsSection({ companyId, backendId, environment, isUk, notify, syncStatus }: DataStudioOperationsSectionProps) {
  const [preview, setPreview] = useState<PromotePreview | null>(null);
  const [promotions, setPromotions] = useState<PromotionRecord[]>([]);
  const [quota, setQuota] = useState<QuotaReport | null>(null);
  const [withData, setWithData] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});

  const base = `/companies/${encodeURIComponent(companyId)}/data-backends/${encodeURIComponent(backendId)}`;
  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    const token = getStoredAuthToken();
    if (token) headers.set("Authorization", "Bearer " + token);
    if (init?.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
    const response = await fetch("/api" + path, { ...init, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(apiError(body, response.status));
    }
    return body as T;
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const result = await request<{ promotions: PromotionRecord[] }>(`${base}/promotions`);
      setPromotions(result.promotions ?? []);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [base, request]);

  const loadQuotas = useCallback(async () => {
    try {
      const result = await request<QuotaReport>(`${base}/quotas?environment=${encodeURIComponent(environment)}`);
      setQuota(result);
      setQuotaDraft({
        maxDatabaseBytes: String(result.limits.maxDatabaseBytes),
        maxConnections: String(result.limits.maxConnections),
        maxCollections: String(result.limits.maxCollections),
        maxFields: String(result.limits.maxFields),
        maxQueriesPerMinute: String(result.limits.maxQueriesPerMinute),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [base, environment, request]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    await Promise.all([loadHistory(), loadQuotas()]);
    setLoading(false);
  }, [loadHistory, loadQuotas]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const openPromotePreview = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request<PromotePreview>(`${base}/promote/preview`, {
        method: "POST",
        body: JSON.stringify({ withData }),
      });
      setPreview(result);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(
        /DRIFT_BLOCKED|drift/i.test(message)
          ? (isUk
            ? `Promote заблоковано через schema drift: спершу приведіть prod у відповідність. ${message}`
            : `Promote is blocked by schema drift: reconcile prod first. ${message}`)
          : message,
      );
      notify?.(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const approvePromote = async () => {
    if (!preview) return;
    const destructive = preview.operations.some((operation) => operation.destructive || operation.requiresSnapshot);
    const confirmed = await confirmModal({
      title: isUk ? "Підтвердити promote" : "Confirm promote",
      message: isUk
        ? `Застосувати ${preview.operations.length} операцій до ${preview.targetEnvironment}${withData ? " разом із dev-даними (seed)" : ""}?${destructive ? " Серед операцій є destructive/потребують снапшота — перед застосуванням буде створено бекап." : ""}`
        : `Apply ${preview.operations.length} operations to ${preview.targetEnvironment}${withData ? " including dev data (seed)" : ""}?${destructive ? " Some operations are destructive or require a snapshot — a backup is created first." : ""}`,
      type: "confirm",
      isDanger: destructive,
      confirmText: isUk ? "Застосувати" : "Apply",
      cancelText: isUk ? "Скасувати" : "Cancel",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await request<{ promotionId: string; status: string; appliedOperations: number; copiedRows?: number; snapshotId?: string | null }>(`${base}/promote`, {
        method: "POST",
        body: JSON.stringify({ approved: true, withData }),
      });
      notify?.(
        isUk
          ? `Promote застосовано: ${result.appliedOperations} операцій${typeof result.copiedRows === "number" ? `, ${result.copiedRows} рядків` : ""}`
          : `Promote applied: ${result.appliedOperations} operations${typeof result.copiedRows === "number" ? `, ${result.copiedRows} rows` : ""}`,
      );
      setPreview(null);
      await loadHistory();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      notify?.(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const rejectPromote = async () => {
    const reason = await promptModal({
      title: isUk ? "Відхилити promote" : "Reject promote",
      message: isUk ? "Причина відхилення (необовʼязково)" : "Rejection reason (optional)",
      placeholder: isUk ? "не зараз" : "not now",
      type: "prompt",
    });
    if (reason === null) return;
    setBusy(true);
    try {
      await request(`${base}/promote/reject`, { method: "POST", body: JSON.stringify({ reason: reason.trim() || undefined }) });
      notify?.(isUk ? "Promote відхилено" : "Promote rejected", "info");
      setPreview(null);
      await loadHistory();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      notify?.(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const saveQuotas = async () => {
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(quotaDraft)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError(isUk ? "Ліміти мають бути невідʼємними числами" : "Limits must be non-negative numbers");
        return;
      }
      limits[key] = parsed;
    }
    setBusy(true);
    try {
      const result = await request<QuotaReport>(`${base}/quotas?environment=${encodeURIComponent(environment)}`, {
        method: "PUT",
        body: JSON.stringify(limits),
      });
      setQuota(result);
      setError("");
      notify?.(isUk ? "Ліміти збережено" : "Limits saved");
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      notify?.(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const driftBlocked = syncStatus === "drift_detected" || syncStatus === "reconciliation_required" || (preview ? preview.drift.status !== "synced" : false);
  const quotaState = quota?.state ?? "ok";

  return (
    <div className="data-studio-pane operations-pane">
      <div className="pane-header">
        <div>
          <h2>{isUk ? "Promote та квоти" : "Promote & Quotas"}</h2>
          <p>
            {isUk
              ? "Перенесення схеми (і за потреби dev-даних) у prod з підтвердженням, історія promote та ліміти бази."
              : "Promote schema (and optionally dev data) to prod with approval, promotion history and database limits."}
          </p>
        </div>
        <div className="pane-actions">
          <button type="button" className="button-primary" disabled={busy || driftBlocked} onClick={() => void openPromotePreview()}>
            {isUk ? "Preview promote" : "Preview promote"}
          </button>
          <button type="button" className="button-secondary" disabled={loading} onClick={() => void loadAll()}>
            {isUk ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="data-studio-alert error" role="alert">{error}</div>}

      {driftBlocked && (
        <div className="data-studio-alert warning" role="status">
          <span>
            {isUk
              ? "Promote заблоковано: схема prod має drift. Спершу приведіть середовища у відповідність (Migrations / Schema)."
              : "Promote is blocked: the prod schema has drifted. Reconcile the environments first (Migrations / Schema)."}
          </span>
        </div>
      )}

      <section className="settings-card">
        <h3>{isUk ? "Параметри перенесення" : "Promotion options"}</h3>
        <label className="toggle-row">
          <input type="checkbox" checked={withData} onChange={(event) => setWithData(event.target.checked)} />
          <div>
            <strong>{isUk ? "Копіювати dev-дані (seed)" : "Copy dev data (seed)"}</strong>
            <p>
              {isUk
                ? "Перенесе рядки з dev у prod. Для owner-колекцій попередньо перегляньте кількість рядків у preview."
                : "Copies rows from dev into prod. Review the row preview for owner-based collections first."}
            </p>
          </div>
        </label>
      </section>

      <section>
        <h3>{isUk ? "Історія promote" : "Promotion history"} ({promotions.length})</h3>
        {promotions.length === 0 ? (
          <div className="data-studio-empty-card">
            <p>{isUk ? "Promote ще не запускали." : "No promotions yet."}</p>
          </div>
        ) : (
          <div className="promotions-table-container">
            <table className="data-studio-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{isUk ? "Статус" : "Status"}</th>
                  <th>{isUk ? "Ціль" : "Target"}</th>
                  <th>{isUk ? "Прапорці" : "Flags"}</th>
                  <th>{isUk ? "Снапшот" : "Snapshot"}</th>
                  <th>{isUk ? "Створено" : "Created"}</th>
                  <th>{isUk ? "Застосовано" : "Applied"}</th>
                  <th>{isUk ? "Помилка" : "Error"}</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map((promotion) => (
                  <tr key={promotion.id}>
                    <td><code>{promotion.id.slice(0, 8)}</code></td>
                    <td>
                      <span className={`status-pill ${promotion.status === "applied" ? "completed" : promotion.status === "rejected" ? "denied" : promotion.status === "failed" ? "failed" : "queued"}`}>
                        {promotion.status}
                      </span>
                    </td>
                    <td>{promotion.targetEnvironment}</td>
                    <td>
                      {promotion.flags?.destructive ? <span className="status-pill failed">destructive</span> : null}
                      {promotion.flags?.requiresSnapshot ? <span className="status-pill requires-approval">snapshot</span> : null}
                      {promotion.flags?.withData ? <span className="status-pill default">with data</span> : null}
                      {promotion.flags?.reversible ? <span className="status-pill allowed">reversible</span> : null}
                    </td>
                    <td>{promotion.snapshotRef ? <code>{promotion.snapshotRef.slice(0, 8)}</code> : "—"}</td>
                    <td>{new Date(promotion.createdAt).toLocaleString()}</td>
                    <td>{promotion.appliedAt ? new Date(promotion.appliedAt).toLocaleString() : "—"}</td>
                    <td>{promotion.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="settings-card">
        <h3>{isUk ? "Квоти та ліміти" : "Quotas & limits"}</h3>
        {!quota ? (
          <p className="muted">{isUk ? "Завантаження…" : "Loading…"}</p>
        ) : (
          <>
            {quotaState !== "ok" && (
              <div className={`data-studio-alert ${quotaState === "exceeded" ? "error" : "warning"}`} role="status">
                <span>
                  {quota.message
                    || (quotaState === "exceeded"
                      ? (isUk ? "Ліміт вичерпано — записи заблоковано." : "Quota exceeded — writes are blocked.")
                      : (isUk ? "Наближаєтесь до ліміту бази." : "Approaching the database limit."))}
                </span>
              </div>
            )}
            {quota.writesBlocked && (
              <div className="data-studio-alert error" role="alert">
                <span>{isUk ? "Записи в цю базу заблоковані через квоту." : "Writes to this database are blocked by the quota."}</span>
              </div>
            )}

            <div className="quota-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(quota.databasePercent)}>
              <div
                className={`quota-progress-bar quota-${quotaState}`}
                style={{ width: `${Math.min(100, Math.max(0, quota.databasePercent))}%` }}
              />
            </div>
            <p className="muted">
              {formatBytes(quota.usage.bytes, isUk)} / {formatBytes(quota.limits.maxDatabaseBytes, isUk)}
              {" · "}{quota.databasePercent.toFixed(1)}%
              {" · "}{isUk ? "зʼєднань" : "connections"}: {quota.usage.connections} / {quota.limits.maxConnections}
            </p>

            <div className="quota-grid">
              {([
                ["maxDatabaseBytes", isUk ? "Макс. розмір бази (байти)" : "Max database bytes"],
                ["maxConnections", isUk ? "Макс. зʼєднань" : "Max connections"],
                ["maxCollections", isUk ? "Макс. колекцій" : "Max collections"],
                ["maxFields", isUk ? "Макс. полів" : "Max fields"],
                ["maxQueriesPerMinute", isUk ? "Макс. запитів/хв" : "Max queries/min"],
              ] as Array<[string, string]>).map(([key, label]) => (
                <div className="form-group" key={key}>
                  <label htmlFor={`quota-${key}`}>{label}</label>
                  <input
                    id={`quota-${key}`}
                    type="number"
                    min={0}
                    value={quotaDraft[key] ?? ""}
                    onChange={(event) => setQuotaDraft((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void saveQuotas()}>
              {isUk ? "Зберегти ліміти" : "Save limits"}
            </button>
          </>
        )}
      </section>

      {preview && (
        <div className="npati-dialog-backdrop" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <div className="npati-dialog-card wide" onClick={(event) => event.stopPropagation()}>
            <button className="npati-dialog-close" type="button" onClick={() => setPreview(null)} aria-label={isUk ? "Закрити" : "Close"}>&times;</button>
            <div className="npati-dialog-header">
              <div className="npati-dialog-icon accent">⇪</div>
              <div className="npati-dialog-headings">
                <h3 className="npati-dialog-title">{isUk ? "Preview promote" : "Promote preview"}</h3>
                <p className="npati-dialog-message">
                  {preview.backendName} → {preview.targetEnvironment}
                  {" · "}{preview.operations.length} {isUk ? "операцій" : "operations"}
                  {preview.approvalRequired ? ` · ${isUk ? "потрібне підтвердження" : "approval required"}` : ""}
                </p>
              </div>
            </div>

            <div className="data-studio-modal-body">
              <div className="preview-flags">
                <span className={`status-pill ${preview.destructive ? "failed" : "allowed"}`}>destructive: {String(preview.destructive)}</span>
                <span className={`status-pill ${preview.requiresSnapshot ? "requires-approval" : "allowed"}`}>snapshot: {String(preview.requiresSnapshot)}</span>
                <span className={`status-pill ${preview.reversible ? "allowed" : "denied"}`}>reversible: {String(preview.reversible)}</span>
                <span className={`status-pill ${preview.drift.status === "synced" ? "allowed" : "failed"}`}>drift: {preview.drift.status}</span>
                {preview.pendingVersions.length > 0 && (
                  <span className="status-pill default">
                    {isUk ? "версії" : "versions"}: {preview.pendingVersions.join(", ")}
                  </span>
                )}
              </div>

              <div className="preview-collections">
                <div>
                  <strong>{isUk ? "Додані колекції" : "Added collections"}</strong>
                  <div>{collectionList(preview.addedCollections, isUk, isUk ? "немає" : "none")}</div>
                </div>
                <div>
                  <strong>{isUk ? "Змінені" : "Changed"}</strong>
                  <div>{collectionList(preview.changedCollections, isUk, isUk ? "немає" : "none")}</div>
                </div>
                <div>
                  <strong>{isUk ? "Видалені" : "Removed"}</strong>
                  <div>{collectionList(preview.removedCollections, isUk, isUk ? "немає" : "none")}</div>
                </div>
              </div>

              {withData && (
                <div className="data-preview">
                  <strong>{isUk ? "Дані для копіювання (seed)" : "Data to copy (seed)"}</strong>
                  {preview.dataPreview.length === 0 ? (
                    <p className="muted">{isUk ? "Немає рядків для копіювання." : "No rows to copy."}</p>
                  ) : (
                    <table className="data-studio-table">
                      <thead>
                        <tr><th>{isUk ? "Колекція" : "Collection"}</th><th>{isUk ? "Рядків" : "Rows"}</th></tr>
                      </thead>
                      <tbody>
                        {preview.dataPreview.map((entry) => (
                          <tr key={entry.collection}><td>{entry.collection}</td><td>{entry.rows}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              <table className="data-studio-table operations-table">
                <thead>
                  <tr>
                    <th>v#</th>
                    <th>{isUk ? "Операція" : "Kind"}</th>
                    <th>{isUk ? "Колекція" : "Collection"}</th>
                    <th>SQL</th>
                    <th>{isUk ? "Прапорці" : "Flags"}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.operations.map((operation) => (
                    <tr key={`${operation.version}-${operation.kind}-${operation.collection ?? ""}`}>
                      <td>{operation.version}</td>
                      <td>{operation.kind}</td>
                      <td>{operation.collection || "—"}</td>
                      <td><code className="sql-cell">{operation.sql}</code></td>
                      <td>
                        {operation.destructive ? <span className="status-pill failed">destructive</span> : null}
                        {operation.requiresSnapshot ? <span className="status-pill requires-approval">snapshot</span> : null}
                        {operation.reversible ? <span className="status-pill allowed">reversible</span> : <span className="status-pill denied">no rollback</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="npati-dialog-actions">
              <button type="button" className="npati-dialog-btn npati-dialog-btn-cancel" disabled={busy} onClick={() => void rejectPromote()}>
                {isUk ? "Відхилити" : "Reject"}
              </button>
              <button type="button" className="npati-dialog-btn npati-dialog-btn-primary" disabled={busy || preview.drift.status !== "synced"} onClick={() => void approvePromote()}>
                {isUk ? "Підтвердити й promote" : "Approve & promote"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
