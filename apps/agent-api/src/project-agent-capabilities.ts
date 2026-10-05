import type { CompanyAgent } from "@npati/workspace";

export const WEBSITE_FILE_TOOLS = [
  "project.files.list", "project.files.search", "project.files.read",
  "project.files.create", "project.files.write", "project.files.edit",
] as const;

/** Live Preview + terminal tools a generated app needs while it is being built (D6). */
export const PROJECT_PREVIEW_TOOLS = [
  "project.terminal.exec", "project.terminal.process", "project.preview.start", "project.preview.status",
] as const;

export function canBuildWebsite(agent: CompanyAgent): boolean {
  const tools = new Set(agent.tools ?? []);
  return WEBSITE_FILE_TOOLS.every((tool) => tools.has(tool));
}

/**
 * Mobile (Expo / React Native) projects use the same file and preview tool set as websites;
 * the difference is the generated template, not the permissions.
 */
export function canBuildMobileApp(agent: CompanyAgent): boolean {
  return canBuildWebsite(agent);
}
