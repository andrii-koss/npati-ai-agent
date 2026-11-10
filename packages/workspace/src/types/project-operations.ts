export type CheckpointTrigger = "manual" | "pre_run" | "post_run" | "pre_restore";

export interface ProjectCheckpoint {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  commitHash?: string;
  trigger: CheckpointTrigger;
  runId?: string;
  fileCount: number;
  createdAt: string;
}

export interface CreateCheckpointInput {
  name: string;
  description?: string;
  commitHash?: string;
  trigger: CheckpointTrigger;
  runId?: string;
  fileCount?: number;
}

export type DeploymentStatus = "queued" | "building" | "deployed" | "failed";

export interface ProjectDeployment {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  provider: string;
  environment: string;
  branch: string;
  commitHash?: string;
  status: DeploymentStatus;
  targetUrl?: string;
  externalDeploymentId?: string;
  preflightSummary?: Record<string, unknown>;
  errorMessage?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeploymentInput {
  provider: string;
  environment?: string;
  branch?: string;
  commitHash?: string;
  status?: DeploymentStatus;
  targetUrl?: string;
  externalDeploymentId?: string;
  preflightSummary?: Record<string, unknown>;
  errorMessage?: string;
  runId?: string;
}

export type BrowserQaStatus = "passed" | "warning" | "failed" | "error";

export interface BrowserQaIssue {
  id: string;
  type: "console_error" | "broken_link" | "a11y" | "performance";
  severity: "error" | "warning" | "info";
  message: string;
  selector?: string;
  context?: Record<string, unknown>;
  recommendation: string;
}

export interface BrowserQaMetrics {
  interactionTrace?: BrowserQaInteraction[];
  loadTimeMs: number;
  domContentLoadedMs: number;
  resourceCount: number;
  totalSizeBytes: number;
  brokenLinksCount: number;
  consoleErrorsCount: number;
  a11yViolationsCount: number;
  performanceIssuesCount: number;
  /** Forms the check filled and sent, and the site's Project API calls it saw (writes ran as checks and rolled back). */
  formsSubmitted?: number;
  apiCalls?: number;
  apiBridge?: boolean;
  apiLog?: string[];
}

export type BrowserQaAction = {type:"click";selector:string}|{type:"key";key:string;durationMs?:number}|{type:"wait";durationMs:number};
export interface BrowserQaObservation {text:string;buttons:Array<{label:string;disabled:boolean}>;canvasHash?:string}
export interface BrowserQaInteraction {action:BrowserQaAction;status:"completed"|"failed";before:BrowserQaObservation;after:BrowserQaObservation}

export interface BrowserQaScreenshot {
  captureMode?: "layout" | "visual";
  name: string;
  viewport: { width: number; height: number };
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
}

export interface ProjectQaReport {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  status: BrowserQaStatus;
  targetUrl: string;
  summary: string;
  issues: BrowserQaIssue[];
  metrics: BrowserQaMetrics;
  screenshots: BrowserQaScreenshot[];
  runId?: string;
  createdAt: string;
}

export interface CreateProjectQaReportInput {
  status: BrowserQaStatus;
  targetUrl: string;
  summary: string;
  issues: BrowserQaIssue[];
  metrics: BrowserQaMetrics;
  screenshots?: BrowserQaScreenshot[];
  runId?: string;
}

