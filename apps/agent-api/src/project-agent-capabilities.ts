import type { CompanyAgent } from "@npati/workspace";

export const WEBSITE_FILE_TOOLS = [
  "project.files.list", "project.files.search", "project.files.read",
  "project.files.create", "project.files.write", "project.files.edit",
] as const;

export function canBuildWebsite(agent: CompanyAgent): boolean {
  const tools = new Set(agent.tools ?? []);
  return WEBSITE_FILE_TOOLS.every((tool) => tools.has(tool));
}