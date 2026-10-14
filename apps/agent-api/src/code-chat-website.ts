import { emitCodingActivity } from "./coding-agent-runner-contracts";
import type { AuthContext, Project } from "@npati/workspace";
import type { CodeSessionRunInput } from "./code-session-run-executor";

/** Website chat uses the existing code loop and preview runtime; no second agent or queue. */
export function isCodeChatWebsite(project: Pick<Project, "type" | "framework">): boolean {
  return ["website", "web_app", "landing_page"].includes(project.type)
    || (project.type === "mobile_app" && project.framework === "Expo")
    || (project.type === "code_project" && /^(Next\.js|HTML\/CSS|React|Vite)$/i.test(project.framework ?? ""));
}

export function hasCodeChatPreview(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { websitePreview?: { status?: string } }).websitePreview?.status === "running";
}

export async function finishCodeChatWebsite(input: CodeSessionRunInput, result: unknown, ports: {
  getProject(ctx: AuthContext, companyId: string, projectId: string): Promise<Project>;
  startPreview(ctx: AuthContext, companyId: string, projectId: string, signal?: AbortSignal): Promise<{ status: string; previewUrl: string }>;
  markFailed(ctx: AuthContext, companyId: string, projectId: string): Promise<unknown>;
}): Promise<unknown> {
  const run = result as { status?: string; summary?: { verification?: { status?: string; requestedTools?: string[] } } } | null;
  if (run?.status !== "completed" || input.readOnlyIntent || input.session.mode === "plan") return result;
  const { companyId, projectId } = input.session;
  const project = await ports.getProject(input.ctx, companyId, projectId);
  if (!isCodeChatWebsite(project)) return result;
  // A model's prose is never evidence of a successful production build.
  if (project.framework !== "HTML/CSS" && (run.summary?.verification?.status !== "passed"
      || !run.summary.verification.requestedTools?.includes("build"))) {
    await ports.markFailed(input.ctx, companyId, projectId);
    return { ...run, status: "failed", reason: "website_build_not_verified", message: "Production build has not passed. Live Preview was not started." };
  }
  const runId = typeof (result as { runId?: unknown })?.runId === "string" ? (result as { runId: string }).runId : input.runId;
  const activity = { id: `${runId}:website-preview`, runId, stage: "preview", title: "Starting Live Preview", at: new Date().toISOString(), agentId: "System" };
  await emitCodingActivity(input, { ...activity, status: "running" });
  try {
    const preview = await ports.startPreview(input.ctx, companyId, projectId, input.sink?.signal);
    await emitCodingActivity(input, { ...activity, status: preview.status === "running" ? "completed" : "failed", durationMs: Date.now() - Date.parse(activity.at) });
    return { ...run, websitePreview: preview };
  } catch (error) {
    await emitCodingActivity(input, { ...activity, status: input.sink?.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "Preview failed" });
    await ports.markFailed(input.ctx, companyId, projectId);
    throw error;
  }
}
