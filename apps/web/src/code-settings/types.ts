export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type RetentionClass = "ephemeral" | "short" | "standard" | "extended" | "until_deleted";
export type SessionMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";
export type SessionStatus = "active" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "archived";

export interface CompanySummary {
  id: string;
  name: string;
}

export interface VerifyCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
  build?: string;
}

export interface Toolchain {
  languages?: string[];
  packageManagers?: string[];
  verifyCommands?: VerifyCommands;
  source?: "detected" | "manual";
  detectedAt?: string;
  evidence?: string[];
}

export interface CodeProject {
  companyId?: string;
  companyName?: string;
  id: string;
  name: string;
  type?: string;
  status?: string;
  repositoryUrl?: string | null;
  repositoryBranch?: string | null;
  defaultBranch?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  toolchain?: Toolchain | null;
  revision: number;
  updatedAt?: string;
}

export interface CodeSession {
  companyId?: string;
  companyName?: string;
  id: string;
  projectId: string;
  projectName?: string;
  mode?: SessionMode;
  modelProfile?: string | null;
  status?: SessionStatus;
  summary?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  agentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CodeLimits {
  [key: string]: unknown;
}

export interface Feedback {
  type: "success" | "error";
  message: string;
}

export const CLASSIFICATIONS: DataClassification[] = ["public", "internal", "confidential", "restricted"];
export const RETENTIONS: RetentionClass[] = ["ephemeral", "short", "standard", "extended", "until_deleted"];
export const SESSION_MODES: SessionMode[] = ["plan", "ask", "auto_edit", "full_auto_sandbox"];
