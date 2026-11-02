import type { CodeService } from "./code-service";
import type { CodeSessionRunInput } from "./code-session-run-executor";
import type { ProjectService } from "./project-service";
import { isCodeChatWebsite } from "./code-chat-website";

/** Metadata may predate newly generated manifests; static projects can acquire real checks. */
export async function resolveProjectVerificationTools(input: CodeSessionRunInput,
  projects: Pick<ProjectService, "get">, code: Pick<CodeService, "resolveVerifyCommands">): Promise<string[] | undefined> {
  const project = await projects.get(input.ctx, input.session.companyId, input.session.projectId);
  if (input.readOnlyIntent || input.session.mode === "plan") return undefined;
  const commands = await code.resolveVerifyCommands(input.ctx, input.session.companyId, input.session.projectId);
  if (!isCodeChatWebsite(project) || project.framework === "HTML/CSS") {
    return Object.keys(commands).filter(tool => commands[tool as keyof typeof commands]?.trim());
  }
  // Framework websites still require their build even when its command is missing.
  return commands.test?.trim() ? ["build", "test"] : ["build"];
}
