export type FileEntry = { path: string; name: string; type: "file" | "directory"; size?: number; revision?: string };
export type FileContent = { path: string; content: string; size: number; revision: string };
export type TerminalEvent = { id: string; commandSummary: string; riskLevel: string; status: string; output: string; errorCode?: string; createdAt: string };
export type BottomTab = "changes" | "terminal" | "checkpoints" | "deployments" | "qa" | "logs" | "activity";
export type DeviceMode = "desktop" | "tablet" | "mobile";
export type MobileView = "all" | "files" | "chat" | "preview" | "bottom";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
  oldSize?: number;
  newSize?: number;
}

export interface ChangesResult {
  summary: { added: number; modified: number; deleted: number; total: number };
  changes: FileChange[];
}

export interface PreviewStatusResponse {
  status: string;
  previewUrl?: string | null;
  port?: number | null;
  framework?: string | null;
  lastBuildStatus?: string | null;
  isRunning: boolean;
  error: string | null;
  restartCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface CheckpointItem {
  id: string;
  name: string;
  description?: string;
  commitHash?: string;
  trigger: "manual" | "pre_run" | "post_run" | "pre_restore";
  fileCount: number;
  createdAt: string;
}

export interface DeploymentItem {
  id: string;
  provider: string;
  environment: string;
  status: string;
  targetUrl?: string;
  commitHash?: string;
  branch?: string;
  errorMessage?: string;
  deployedAt?: string;
  createdAt: string;
}

export interface PreflightInfo {
  environment: string;
  branch: string;
  target: string;
  buildStatus: string;
  filesChanged: { staged: number; unstaged: number; untracked: number; total: number };
  tests: { executed: boolean; status: string; passed?: number; failed?: number };
  readyToDeploy: boolean;
  blockers: string[];
}

export interface ProjectRunItem {
  id: string;
  task: string;
  status: string;
  result?: string;
  errorMessage?: string;
  createdAt: string;
  tasks?: Array<{ id: string; title: string; role: string; agentId: string; dependsOn: string[]; status: string }>;
}
