import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiSend } from "../code-workspace-page-types";

export type ProductionLimits = { cpu: number; memoryMiB: number; requestsPerSecond: number; concurrency: number; bodyMiB: number; timeoutSeconds: number };
export type ProductionSettings = {
  domain: string; aliasDomain?: string; redirectAlias?: boolean;
  path: string; port: number; stripPath: boolean; tls: boolean; entrypoint: string; limits: ProductionLimits;
};
type Proof = { name: string; value: string };
export type ProductionDomain = { host: string; url: string; primary: boolean; certificate: "disabled" | "pending" | "issued" };
type Release = {
  id?: string; kind: "static" | "node"; createdAt: string; url: string; settings: ProductionSettings;
  certificate: string; domains?: ProductionDomain[]; runtime: "running" | "starting" | "unavailable" | "stopped";
};
type Control = { action: "start" | "stop" | "restart" } | { action: "domain"; domain: string };
type ReportError = (message: string) => void;
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

export function useProjectProduction(companyId: string, projectId: string, includeDefaults = false) {
  const base = companyId && projectId ? productionEndpoint(companyId, projectId) : "";
  const [status, setStatus] = useState<ProductionStatus | null>(null);
  const [issue, setIssue] = useState("");
  const [readIssue, setReadIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const mutating = useRef(false);
  const refresh = useCallback(async (request = ++version.current) => {
    try {
      const data = await apiGet<ProductionStatus>(base + (includeDefaults ? "?defaults=1" : ""));
      if (request !== version.current) return;
      setStatus(data);
      setReadIssue("");
    } catch (error) {
      if (request === version.current && (includeDefaults || !/HTTP 404|Only the company owner/.test(String(error)))) {
        setReadIssue(error instanceof Error ? error.message : String(error));
      }
    }
  }, [base, includeDefaults]);

  const jobActive = running(status);
  useEffect(() => {
    setStatus(null);
    setIssue("");
    setReadIssue("");
    setBusy(false);
    mutating.current = false;
    if (base) void refresh();
    return () => { version.current++; };
  }, [base, refresh]);

  const starting = status?.enabled && status.release?.runtime === "starting";
  const periodically = jobActive || Boolean(status?.enabled && status.release);
  useEffect(() => {
    if (!base || !periodically) return;
    const interval = window.setInterval(() => { if (!document.hidden && !mutating.current) void refresh(); }, jobActive || starting ? 1700 : 15000);
    return () => window.clearInterval(interval);
  }, [base, periodically, jobActive, starting, refresh]);

  async function mutate(method: "POST" | "PATCH" | "DELETE", body?: unknown, reportError: ReportError = setIssue) {
    if (!base || mutating.current) return false;
    const request = ++version.current;
    mutating.current = true;
    setIssue("");
    setReadIssue("");
    setBusy(true);
    try {
      const data = await apiSend<ProductionStatus>(method, base, body);
      if (request !== version.current) return false;
      if (method === "DELETE") await refresh(request);
      else setStatus(data);
      return true;
    } catch (error) {
      if (request === version.current) reportError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (request === version.current) {
        mutating.current = false;
        setBusy(false);
      }
    }
  }
  const publish = (settings: Omit<ProductionSettings, "limits"> & { limits?: ProductionDraftLimits; environment?: unknown }, reportError?: ReportError) =>
    mutate("POST", settings, reportError);
  const unpublish = () => mutate("DELETE");
  async function control(input: Control, reportError?: ReportError) {
    const releaseId = status?.enabled ? status.release?.id : undefined;
    if (!releaseId || jobActive) return false;
    return mutate("PATCH", { ...input, releaseId }, reportError);
  }
  return { base, status, running: jobActive, issue: issue || readIssue, busy, publish, unpublish, control };
}
export type ProductionController = ReturnType<typeof useProjectProduction>;
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

