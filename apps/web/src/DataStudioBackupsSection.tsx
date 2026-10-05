import React, { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";

type DataEnvironment = "dev" | "prod";
type Notify = (message: string, type?: "success" | "info" | "error") => void;

export interface BackupSnapshot {
  id: string;
  path: string;
  createdAt: string;
  kind: string;
  reason?: string | null;
  sizeBytes: number;
}

export interface BackupPolicy {
  environment: DataEnvironment;
  intervalMinutes: number;
  keep: number;
  retentionDays: number;
}

interface BackupsResponse {
  environment: DataEnvironment;
  snapshots: BackupSnapshot[];
  policy: BackupPolicy;
}

interface RestoreResult {
  restoredSnapshotId: string;
  safetySnapshotId?: string;
  fingerprint?: string | null;
}

export interface DataStudioBackupsSectionProps {
  companyId: string;
  backendId: string;
  environment: DataEnvironment;
  isUk: boolean;
  notify?: Notify;
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

export function formatSnapshotSize(bytes: number, isUk: boolean): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return isUk ? "0 Б" : "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Backups & restore for one DataBackend + environment (D7).
 * Restores are destructive, always ask for confirmation, and create a safety snapshot first.
 */
export function DataStudioBackupsSection({ companyId, backendId, environment, isUk, notify }: DataStudioBackupsSectionProps) {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("");
  const [keep, setKeep] = useState("");

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<BackupsResponse>(`${base}/backups?environment=${encodeURIComponent(environment)}`);
      setData(result);
      setIntervalMinutes(String(result.policy?.intervalMinutes ?? ""));
      setKeep(String(result.policy?.keep ?? ""));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [base, environment, request]);

  useEffect(() => { void load(); }, [load]);

  const createBackup = async () => {
    const reason = await promptModal({
      title: isUk ? "Новий бекап" : "New backup",
      message: isUk ? "Причина (необовʼязково)" : "Reason (optional)",
      placeholder: isUk ? "перед змінами" : "before changes",
      type: "prompt",
    });
    if (reason === null) return;
    setBusy(true);
    try {
      await request(`${base}/backups`, {
        method: "POST",
        body: JSON.stringify({ environment, reason: reason.trim() || undefined }),
      });
      notify?.(isUk ? "Бекап створено" : "Backup created");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      notify?.(errorMessage(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (snapshot: BackupSnapshot) => {
    const confirmed = await confirmModal({
      title: isUk ? "Відновлення з бекапу" : "Restore from backup",
      message: isUk
        ? `Відновити ${environment} зі снапшота від ${new Date(snapshot.createdAt).toLocaleString()}? Поточна схема й дані буде замінено. Перед відновленням система створить safety snapshot.`
        : `Restore ${environment} from the snapshot taken ${new Date(snapshot.createdAt).toLocaleString()}? The current schema and data will be replaced. A safety snapshot is created first.`,
      type: "confirm",
      isDanger: true,
      confirmText: isUk ? "Відновити" : "Restore",
      cancelText: isUk ? "Скасувати" : "Cancel",
    });
    if (!confirmed) return;

    if (environment === "prod") {
      const typed = await promptModal({
        title: isUk ? "Підтвердження prod" : "Confirm prod",
        message: isUk ? 'Введіть "prod", щоб підтвердити відновлення production-бази' : 'Type "prod" to confirm restoring the production database',
        placeholder: "prod",
        type: "prompt",
      });
      if ((typed ?? "").trim() !== "prod") {
        notify?.(isUk ? "Відновлення скасовано" : "Restore cancelled", "info");
        return;
      }
    }

    setBusy(true);
    try {
      const result = await request<RestoreResult>(`${base}/backups/${encodeURIComponent(snapshot.id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ environment, approved: true }),
      });
      const safety = result.safetySnapshotId ? (isUk ? ` (safety snapshot: ${result.safetySnapshotId.slice(0, 8)})` : ` (safety snapshot: ${result.safetySnapshotId.slice(0, 8)})`) : "";
      notify?.(`${isUk ? "Відновлено" : "Restored"}: ${result.restoredSnapshotId.slice(0, 8)}${safety}`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      notify?.(errorMessage(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    const interval = Number(intervalMinutes);
    const keepValue = Number(keep);
    if (!Number.isInteger(interval) || interval < 1 || !Number.isInteger(keepValue) || keepValue < 1) {
      setError(isUk ? "Інтервал і кількість бекапів мають бути цілими числами ≥ 1" : "Interval and retention count must be integers ≥ 1");
      return;
    }
    setBusy(true);
    try {
      const policy = await request<BackupPolicy>(`${base}/backup-policy?environment=${encodeURIComponent(environment)}`, {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: interval, keep: keepValue }),
      });
      setData((current) => (current ? { ...current, policy } : current));
      setIntervalMinutes(String(policy.intervalMinutes));
      setKeep(String(policy.keep));
      setError("");
      notify?.(isUk ? "Політику бекапів збережено" : "Backup policy saved");
    } catch (cause) {
      setError(errorMessage(cause));
      notify?.(errorMessage(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const snapshots = data?.snapshots ?? [];

  return (
    <div className="data-studio-pane backups-pane">
      <div className="pane-header">
        <div>
          <h2>{isUk ? "Бекапи та відновлення" : "Backups & Restore"}</h2>
          <p>
            {isUk
              ? `Снапшоти бази проєкту для середовища ${environment}. Відновлення замінює схему й дані.`
              : `Project database snapshots for the ${environment} environment. Restoring replaces the schema and data.`}
          </p>
        </div>
        <div className="pane-actions">
          <button type="button" className="button-primary" disabled={busy} onClick={() => void createBackup()}>
            {isUk ? "Створити бекап" : "Create backup"}
          </button>
          <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>
            {isUk ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="data-studio-alert error" role="alert">{error}</div>}

      <section className="settings-card">
        <h3>{isUk ? "Політика бекапів" : "Backup policy"}</h3>
        <div className="form-group">
          <label htmlFor="backup-interval">{isUk ? "Інтервал (хвилини)" : "Interval (minutes)"}</label>
          <input
            id="backup-interval"
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="backup-keep">{isUk ? "Скільки снапшотів зберігати" : "Snapshots to keep"}</label>
          <input
            id="backup-keep"
            type="number"
            min={1}
            value={keep}
            onChange={(event) => setKeep(event.target.value)}
          />
        </div>
        <p className="muted">
          {isUk
            ? `Строк зберігання: ${data?.policy?.retentionDays ?? "—"} дн.`
            : `Retention window: ${data?.policy?.retentionDays ?? "—"} days`}
        </p>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void savePolicy()}>
          {isUk ? "Зберегти політику" : "Save policy"}
        </button>
      </section>

      <section>
        <h3>{isUk ? "Снапшоти" : "Snapshots"} ({snapshots.length})</h3>
        {loading && !data ? (
          <p className="muted">{isUk ? "Завантаження…" : "Loading…"}</p>
        ) : snapshots.length === 0 ? (
          <div className="data-studio-empty-card">
            <p>{isUk ? "Снапшотів ще немає. Створіть перший бекап." : "No snapshots yet. Create the first backup."}</p>
          </div>
        ) : (
          <div className="backups-table-container">
            <table className="data-studio-table">
              <thead>
                <tr>
                  <th>{isUk ? "Створено" : "Created"}</th>
                  <th>{isUk ? "Тип" : "Kind"}</th>
                  <th>{isUk ? "Розмір" : "Size"}</th>
                  <th>{isUk ? "Причина" : "Reason"}</th>
                  <th>{isUk ? "Дії" : "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td>{new Date(snapshot.createdAt).toLocaleString()}</td>
                    <td><span className="status-pill default">{snapshot.kind}</span></td>
                    <td>{formatSnapshotSize(snapshot.sizeBytes, isUk)}</td>
                    <td>{snapshot.reason || "—"}</td>
                    <td className="table-actions">
                      <button
                        type="button"
                        className="button-secondary table-action-btn danger"
                        disabled={busy}
                        onClick={() => void restore(snapshot)}
                      >
                        {isUk ? "Відновити" : "Restore"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
