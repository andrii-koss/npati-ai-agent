import type { DataClassification, RetentionClass } from "./retention";

export type ProjectType = "website" | "web_app" | "landing_page" | "mobile_app" | "code_project";
export const PROJECT_TYPES: readonly ProjectType[] = ["website", "web_app", "landing_page", "mobile_app", "code_project"] as const;
/** What the project is for; mirrors `PROJECT_KINDS` in @npati/shared. Code projects keep `type: "code_project"`. */
export type ProjectKind = "website" | "web_app" | "game" | "mobile_app" | "api";
export const PROJECT_KINDS: readonly ProjectKind[] = ["website", "web_app", "game", "mobile_app", "api"] as const;
/** The kind a new project gets when the caller does not state one. */
export function defaultProjectKind(type: ProjectType): ProjectKind {
  return type === "mobile_app" ? "mobile_app" : type === "web_app" ? "web_app" : "website";
}
export type ProjectStatus = "creating" | "ready" | "working" | "building" | "previewing" | "failed" | "archived" | "soft_deleted" | "purging" | "deleted";


/** Toolchain metadata detected from the workspace and editable by the owner (C1). */
export interface CodeVerifyCommands { test?: string; lint?: string; typecheck?: string; build?: string; }
export interface CodeToolchain {
  languages: string[];
  packageManagers: string[];
  verifyCommands: CodeVerifyCommands;
  /** Where the values came from: `detected` by the scanner or `manual` after a user edit. */
  source: "detected" | "manual";
  detectedAt: string;
  /** Files that produced the detection, for explainability in the UI. */
  evidence: string[];
}
export interface ProjectCodeSettings {
  toolchain?: CodeToolchain;
  defaultBranch?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface Project {
  id: string; companyId: string; workspaceId: string; createdBy: string;
  name: string; description?: string; type: ProjectType; kind: ProjectKind; status: ProjectStatus;
  framework?: string; runtime?: string; repositoryProvider?: string; repositoryUrl?: string; repositoryBranch?: string;
  sandboxId?: string; previewUrl?: string; previewPort?: number; lastRunId?: string; lastBuildStatus?: string;
  deploymentUrl?: string; deploymentStatus?: string; lastDeployedAt?: string;
  dataBackendId?: string;
  /** Deep link scheme of a generated mobile app (mobile_app projects). */
  appScheme?: string;
  /** C1: code project metadata, classification and retention. */
  toolchain?: CodeToolchain | null;
  defaultBranch?: string | null;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  deletedAt?: string | null;
  purgeAfter?: string | null;
  deletionReason?: string | null;
  restoredAt?: string | null;
  revision: number; createdAt: string; updatedAt: string;
}
export interface ProjectInput {
  name: string; description?: string; type: ProjectType; kind?: ProjectKind; dataBackendId?: string; appScheme?: string;
  /** C1: optional overrides; the store applies the defaults when omitted. */
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  defaultBranch?: string;
  toolchain?: CodeToolchain;
}

/** C5: scoped approval rules. `once` is the default and deliberately has no rule representation. */
export type CodeApprovalRuleScope = "session" | "project";
export const CODE_APPROVAL_RULE_SCOPES: readonly CodeApprovalRuleScope[] = ["session", "project"] as const;
export type CodeApprovalScope = "once" | CodeApprovalRuleScope;
export const CODE_APPROVAL_SCOPES: readonly CodeApprovalScope[] = ["once", "session", "project"] as const;

export interface CodeApprovalRule {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string | null;
  sessionId: string | null;
  createdBy: string;
  scope: CodeApprovalRuleScope;
  action: string;
  decision: "allow";
  reason?: string | null;
  expiresAt?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CodeApprovalRuleInput {
  scope: CodeApprovalRuleScope;
  action: string;
  projectId?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  expiresAt?: string | null;
}

