/**
 * C2: `code.project.info` — read-only facts about the code project.
 *
 * The model needs orientation (repository, branch, classification, detected toolchain and verify
 * commands) without reading files. Everything returned is data; nothing here can change project
 * settings, flags or permissions.
 */
import type { CodeToolchain, Project } from "@npati/workspace";

export interface ProjectInfoInput {
  project: Pick<Project,
    "id" | "name" | "type" | "description" | "status" | "repositoryUrl" | "defaultBranch" |
    "dataClassification" | "retentionClass" | "toolchain">;
  includeToolchain?: boolean;
  includeVerifyCommands?: boolean;
}

export interface ProjectInfoResult {
  projectId: string;
  name: string;
  type: string;
  description: string | null;
  status: string | null;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  dataClassification: string | null;
  retentionClass: string | null;
  languages: string[];
  packageManagers: string[];
  verifyCommands: Record<string, string>;
  toolchainSource: string | null;
  detectedAt: string | null;
}

export function projectInfo(input: ProjectInfoInput): ProjectInfoResult {
  const { project } = input;
  const toolchain: CodeToolchain | null = input.includeToolchain === false ? null : (project.toolchain ?? null);
  const verifyCommands: Record<string, string> = {};
  if (toolchain && input.includeVerifyCommands !== false) {
    for (const [name, command] of Object.entries(toolchain.verifyCommands ?? {})) {
      if (typeof command === "string" && command.trim()) verifyCommands[name] = command;
    }
  }
  return {
    projectId: project.id,
    name: project.name,
    type: project.type,
    description: project.description ?? null,
    status: project.status ?? null,
    repositoryUrl: project.repositoryUrl ?? null,
    defaultBranch: project.defaultBranch ?? null,
    dataClassification: project.dataClassification ?? null,
    retentionClass: project.retentionClass ?? null,
    languages: toolchain?.languages ?? [],
    packageManagers: toolchain?.packageManagers ?? [],
    verifyCommands,
    toolchainSource: toolchain?.source ?? null,
    detectedAt: toolchain?.detectedAt ?? null,
  };
}
