export interface Company {
  id: string;
  name: string;
  mainAgentId?: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
}

export interface CompanyAutomation {
  id: string;
  workspaceId: string;
  companyId: string;
  agentId?: string | null;
  agentName?: string | null;
  name: string;
  description?: string | null;
  prompt: string;
  cronExpression: string;
  timezone: string;
  status: "active" | "paused";
  lastRunAt?: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  /** A run of this automation is in progress (scheduled or started from here); the page offers Stop. */
  isRunning?: boolean;
}

export interface CompanyAutomationRun {
  id: string;
  automationId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  startedAt: string;
  completedAt?: string | null;
}

export interface BrowserCampaignTarget {
  id: string;
  automationId?: string | null;
  emailAccountId?: string | null;
  credentialId?: string | null;
  siteName: string;
  registrationUrl: string;
  publishUrl?: string | null;
  status: "pending" | "processing" | "waiting_email" | "registered" | "published" | "failed" | "paused";
  resultUrl?: string | null;
  errorMessage?: string | null;
  attempts: number;
}

export interface BrowserEmailAccount {
  id: string;
  emailAddress: string;
  displayName?: string | null;
  status: string;
}

export interface TargetFormState {
  siteName: string;
  registrationUrl: string;
  publishUrl: string;
  automationId: string;
  emailAccountId: string;
  articleTitle: string;
  articleBody: string;
}

export const PRESET_CRONS = [
  { key: "daily9", cron: "0 9 * * *" },
  { key: "daily18", cron: "0 18 * * *" },
  { key: "mondays9", cron: "0 9 * * 1" },
  { key: "fridays17", cron: "0 17 * * 5" },
  { key: "hourly", cron: "0 * * * *" },
] as const;

export interface CronPreset {
  cron: string;
  label: string;
}
