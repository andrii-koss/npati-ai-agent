import type { BackendSummary, BackendEnvironment, ProjectSummary } from "./types";
import { getStoredAuthToken } from "../AuthContext";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & { code?: string; status?: number };
    error.code = result?.error?.code;
    error.status = response.status;
    throw error;
  }
  return result as T;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

/** Shared copy for the installation-level failure of the Data Studio module. */
export function dataStudioUnavailableMessage(isUk: boolean): string {
  return isUk
    ? "Data Studio вимкнено на цій інсталяції (немає контейнера postgres-projects або provisioner)."
    : "Data Studio is disabled on this installation (no postgres-projects container / provisioner).";
}

/** Copy for the transfer drawer errors returned by the backend. */
export function transferErrorMessage(isUk: boolean, code: string | undefined, fallback: string): string {
  if (code === "CONFIRMATION_REQUIRED") return isUk ? "Назва не збігається" : "Name does not match";
  if (code === "INVALID_TARGET_COMPANY") return isUk ? "Оберіть іншу компанію" : "Choose another company";
  if (code === "TARGET_COMPANY_NOT_OWNED") return isUk ? "Немає доступу до цієї компанії" : "No access to that company";
  if (code === "DATA_BACKEND_NOT_FOUND") return isUk ? "Базу не знайдено" : "Database not found";
  return fallback;
}

export function statusPillClass(status: string): string {
  if (status === "ready") return "allowed";
  if (status === "error" || status === "deleted") return "denied";
  return "requires-approval";
}

export function syncPillClass(syncStatus: string | undefined): string {
  return syncStatus === "synced" ? "allowed" : "requires-approval";
}

export function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || bytes === undefined) return "—";
  const value = bytes as number;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Aggregate the visible company databases without treating unknown table counts as zero. */
export function summarizeDatabaseStats(companyBackends: BackendSummary[], companyProjects: ProjectSummary[], environments: Record<string, BackendEnvironment[]>, tableCounts: Record<string, number | null>) {
  const readyEnvironments = companyBackends.reduce((total, backend) => {
    const list = environments[backend.id] ?? [];
    return total + list.filter((env) => env.status === "ready").length;
  }, 0);
  const totalEnvironments = companyBackends.reduce((total, backend) => total + Math.max((environments[backend.id] ?? []).length, 0), 0);
  const known = companyBackends
    .map((backend) => tableCounts[backend.id])
    .filter((count): count is number => typeof count === "number");
  return {
    total: companyBackends.length,
    ready: companyBackends.filter((backend) => backend.status === "ready").length,
    attention: companyBackends.filter((backend) => backend.status !== "ready").length,
    readyEnvironments,
    totalEnvironments: totalEnvironments || companyBackends.length * 2,
    tables: known.length ? known.reduce((total, count) => total + count, 0) : null,
    attachedProjects: companyProjects.filter((item) => item.dataBackendId).length,
  };
}
