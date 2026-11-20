import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend, safeExternalUrl } from "../code-workspace-page-types";

export type ProductionLimits = { cpu: number; memoryMiB: number; requestsPerSecond: number; concurrency: number; bodyMiB: number; timeoutSeconds: number };
export type ProductionSettings = {
  domain: string; aliasDomain?: string; redirectAlias?: boolean;
  path: string; port: number; stripPath: boolean; tls: boolean; entrypoint: string; limits: ProductionLimits;
};
type Proof = { name: string; value: string };
type Release = { kind: "static" | "node"; createdAt: string; url: string; settings: ProductionSettings; certificate: string; runtime: "running" | "starting" | "unavailable" };
type Job = { state: "queued" | "building" | "ready" | "failed"; error?: string };
export type ProductionStatus = { enabled: false } | {
  enabled: true;
  automaticDomain: string;
  localEnabled: boolean;
  tlsEnabled: boolean;
  defaults: ProductionLimits;
  suggested?: Partial<ProductionSettings> | null;
  proof?: Proof | null;
  release: Release | null;
  job: Job | null;
  logs: { at: string; source: string; message: string }[];
  activity: { at: string; event: string; detail: string }[];
  traffic: { requests: number; errors: number; limited: number; averageMs: number };
};

const running = (status: ProductionStatus | null) => status?.enabled && (status.job?.state === "queued" || status.job?.state === "building");

export const productionEndpoint = (companyId: string, projectId: string) => `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/production`;

export function useProjectProduction(companyId: string, projectId: string) {
  const base = companyId && projectId ? productionEndpoint(companyId, projectId) : "";
  const [status, setStatus] = useState<ProductionStatus | null>(null);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<ProductionStatus>(base);
      setStatus(current => data.enabled && current?.enabled ? { ...data, suggested: current.suggested } : data);
      if (statusFailed) setIssue("");
      setStatusFailed(false);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
      setStatusFailed(true);
    }
  }, [base, statusFailed]);

  const jobActive = running(status);
  useEffect(() => {
    setStatus(null);
    setIssue("");
    if (!base) return;
    let mounted = true;
    void apiGet<ProductionStatus>(base).then(data => {
      if (mounted) setStatus(data);
    }, error => {
      if (mounted && !/HTTP 404|Only the company owner/.test(String(error))) setIssue(String(error));
    });
    return () => { mounted = false; };
  }, [base]);

  const periodically = running(status) || Boolean(status?.enabled && status.release);
  useEffect(() => {
    if (!base || !periodically) return;
    const interval = window.setInterval(() => { if (!document.hidden && !busy) void refresh(); }, jobActive ? 1700 : 15000);
    return () => window.clearInterval(interval);
  }, [base, periodically, jobActive, busy, refresh]);

  async function publish(settings: Omit<ProductionSettings, "limits"> & { limits?: ProductionDraftLimits; environment?: unknown }) {
    setIssue("");
    setBusy(true);
    try {
      setStatus(await apiSend<ProductionStatus>("POST", base, settings));
      return true;
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
    return false;
  }

  async function unpublish() {
    setIssue("");
    setBusy(true);
    try {
      await apiSend("DELETE", base);
      await refresh();
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return { base, status, running: running(status), issue, busy, publish, unpublish };
}

type Controller = ReturnType<typeof useProjectProduction>;
const fields: { name: keyof ProductionLimits; en: string; uk: string; min: number; max: number; step?: number }[] = [
  { name: "cpu", en: "CPU cores", uk: "Ядра CPU", min: 0.25, max: 4, step: 0.25 },
  { name: "memoryMiB", en: "Memory (MiB)", uk: "Пам’ять (МіБ)", min: 128, max: 2048 },
  { name: "requestsPerSecond", en: "Requests / second", uk: "Запитів за секунду", min: 1, max: 500 },
  { name: "concurrency", en: "Concurrent requests", uk: "Одночасних запитів", min: 1, max: 100 },
  { name: "bodyMiB", en: "Request body (MiB)", uk: "Розмір запиту (МіБ)", min: 1, max: 32 },
  { name: "timeoutSeconds", en: "Response deadline (sec)", uk: "Час відповіді (сек)", min: 1, max: 30 },
];

export type ProductionDraftLimits = { [K in keyof ProductionLimits]: number | "" };

export function ProductionLimitFields({ isUk, limits, setLimit }: {
  isUk: boolean; limits: ProductionDraftLimits; setLimit: (key: keyof ProductionLimits, value: number | "") => void;
}) {
  return (
    <fieldset className="code-production-limits">
      <legend>{isUk ? "Ліміти проєкту" : "Project limits"}</legend>
      <div className="code-production-grid">
        {fields.map(field => (
          <label key={field.name}>
            <span>{isUk ? field.uk : field.en}</span>
            <input required type="number" min={field.min} max={field.max} step={field.step ?? 1} value={limits[field.name]}
              onChange={event => setLimit(field.name, Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : "")} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ProjectProductionHeader({ controller, isUk }: { controller: Controller; isUk: boolean }) {
  const { status, issue } = controller;
  if (!status?.enabled) return issue ? <p role="status" className="ds-hint-error">{issue}</p> : null;
  const { release } = status;
  const url = safeExternalUrl(release?.url);
  const jobText = controller.running ? (isUk ? "Публікація…" : "Publishing…")
    : release?.certificate === "pending" ? (isUk ? "Очікує HTTPS" : "HTTPS pending")
    : release?.runtime === "starting" ? (isUk ? "Запускається" : "Starting")
    : release?.runtime === "unavailable" ? (isUk ? "Застосунок недоступний" : "Application unavailable")
    : release ? (isUk ? "Опубліковано" : "Published")
    : (isUk ? "Не опубліковано" : "Unpublished");
  return (
    <section className="code-production" aria-label="Production">
      <div className="code-production-bar">
        <strong>Production</strong>
        <span className="ds-muted" aria-live="polite">{jobText}</span>
        {url && <a href={url} target="_blank" rel="noopener noreferrer">{release?.settings.domain}</a>}
      </div>
      {(issue || status.job?.error) && <p role="alert" className="ds-hint-error">{issue || status.job?.error}</p>}
    </section>
  );
}

