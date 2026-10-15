export interface ToolAuditItem {
  id: string;
  agentId: string;
  toolName: string;
  decision: "allowed" | "denied";
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  reasonCode?: string;
  createdAt: string;
}

export interface RunStep {
  id: string;
  agentId: string;
  role: string;
  status: string;
  modelId?: string;
  stepOrder?: number;
  lane?: number;
}

export interface BackgroundRunEvent {
  id: string;
  eventKey?: string;
  eventType: "queued" | "claimed" | "started" | "retry_scheduled" | "completed" | "failed" | "cancelled";
  runStatus: string;
  workerId?: string;
  attemptCount: number;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CompletionReport {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  workerId?: string;
  attemptCount: number;
  totalCost: number;
  totalTokens: number;
  totalDurationMs: number;
  completedAt: string;
}

export interface CompanyRun {
  workerId?:string;
  heartbeatAt?:string;
  leaseExpiresAt?:string;
  turnIndex?:number;
  id: string;
  companyId: string;
  projectId?: string;
  task: string;
  requestedMode: string;
  executionMode?: string;
  status: string;
  result?: string;
  errorMessage?: string;
  omnirouteComboName?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalCost?: number;
  createdAt: string;
  completedAt?: string;
}

export interface CompanyItem {
  id: string;
  name: string;
}

export type RunStatusFilter = "all" | "completed" | "running" | "failed";

export interface ProjectTaskItem {
  id: string;
  title: string;
  role: string;
  agentId: string;
  dependsOn: string[];
}

export interface ActiveRunDetails {
  run: CompanyRun;
  steps: RunStep[];
  toolAudit: ToolAuditItem[];
  backgroundEvents: BackgroundRunEvent[];
  completionReport?: CompletionReport;
}

export function visibleRunTask(task: string): string {
  return task.replace(/^\[NPATI_CONTENT:(?:article|seo_blueprint|social_post|brief|strategy|other):[A-Za-z0-9_-]+\]\s*/, "");
}

export const ACTIVITY_RUNS_CACHE_PREFIX = "npati_activity_runs_cache_v1_";
export const ACTIVITY_LATEST_RUNS_CACHE_KEY = "npati_activity_runs_latest_v1";

export function getCachedRuns(companyId?: string): CompanyRun[] {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(ACTIVITY_RUNS_CACHE_PREFIX + companyId)
        || localStorage.getItem(ACTIVITY_RUNS_CACHE_PREFIX + companyId);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    }
    const latest = sessionStorage.getItem(ACTIVITY_LATEST_RUNS_CACHE_KEY)
      || localStorage.getItem(ACTIVITY_LATEST_RUNS_CACHE_KEY);
    if (latest) {
      const parsed = JSON.parse(latest);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [];
}

export function updateCachedRuns(companyId: string, runs: CompanyRun[]) {
  try {
    const serialized = JSON.stringify(runs);
    if (companyId) {
      sessionStorage.setItem(ACTIVITY_RUNS_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(ACTIVITY_RUNS_CACHE_PREFIX + companyId, serialized);
    }
    if (runs.length > 0) {
      sessionStorage.setItem(ACTIVITY_LATEST_RUNS_CACHE_KEY, serialized);
      localStorage.setItem(ACTIVITY_LATEST_RUNS_CACHE_KEY, serialized);
    }
  } catch {}
}
