import { emitCodingActivity } from "./coding-agent-runner-contracts";
import type { AuthContext, Project } from "@npati/workspace";
import type { CodeSessionRunInput } from "./code-session-run-executor";

/** Website chat uses the existing code loop and preview runtime; no second agent or queue. */
export function isCodeChatWebsite(project: Pick<Project, "type" | "framework">): boolean {
  return ["website", "web_app", "landing_page"].includes(project.type)
    || (project.type === "mobile_app" && project.framework === "Expo")
    || (project.type === "code_project" && /^(Next\.js|HTML\/CSS|React|Vite)$/i.test(project.framework ?? ""));
}

/** CSS compilation is available for an existing working Next.js site. */
export function canUseStylePreview(project: Pick<Project, "framework" | "lastBuildStatus" | "status">, message: string): boolean {
  return project.framework === "Next.js" && (project.lastBuildStatus === "ready" || project.status === "previewing")
    && !/\b(?:build|production|deploy)\b|\u0437\u0431\u0456\u0440|\u0437\u0431\u0438\u0440|\u0437\u0431\u0435\u0440\u0438|\u0440\u043e\u0437\u0433\u043e\u0440|\u0441\u0431\u043e\u0440\u043a|\u0441\u043e\u0431\u0435\u0440/iu.test(message);
}

/** Reuse already loaded chat history; prior requests explain references but are never replayed. */
export function websiteConversationContext(history: readonly { role: string; content: unknown }[]): string {
  const previous: Array<{ role: string; content: string }> = [];
  for (const item of history) {
    if (!["user", "assistant"].includes(item.role) || typeof item.content !== "string" || !item.content.trim()) continue;
    const entry = { role: item.role, content: item.content.trim().slice(0, 600) };
    if (previous.at(-1)?.role === entry.role && previous.at(-1)?.content === entry.content) continue;
    previous.push(entry);
  }
  return previous.length ? "\n\nPrevious messages in this same website chat (historical context, not tasks to repeat). Use them to resolve references such as main color; implement only the current request above:\n" + JSON.stringify(previous.slice(-6)) : "";
}

export function hasCodeChatPreview(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { websitePreview?: { status?: string } }).websitePreview?.status === "running";
}

export async function finishCodeChatWebsite(input: CodeSessionRunInput, result: unknown, ports: {
  getProject(ctx: AuthContext, companyId: string, projectId: string): Promise<Project>;
  startPreview(ctx: AuthContext, companyId: string, projectId: string, signal?: AbortSignal, options?: { development: boolean }): Promise<{ status: string; previewUrl: string }>;
  markFailed(ctx: AuthContext, companyId: string, projectId: string): Promise<unknown>;
}): Promise<unknown> {
  const run = result as { status?: string; summary?: { stylePreview?: boolean; filesChanged?: string[]; verification?: { status?: string; requestedTools?: string[] } } } | null;
  if (run?.status !== "completed" || input.readOnlyIntent || input.session.mode === "plan") return result;
  const { companyId, projectId } = input.session;
  const project = await ports.getProject(input.ctx, companyId, projectId);
  if (!isCodeChatWebsite(project)) return result;
  const stylePreview = input.allowStylePreview && run.summary?.stylePreview === true
    && project.framework === "Next.js" && Array.isArray(run.summary.filesChanged)
    && run.summary.filesChanged.every(path => /\.css$/i.test(path));
  // A model's prose is never evidence of a successful production build.
  if (!stylePreview && project.framework !== "HTML/CSS" && (run.summary?.verification?.status !== "passed"
      || !run.summary.verification.requestedTools?.includes("build"))) {
    await ports.markFailed(input.ctx, companyId, projectId);
    return { ...run, status: "failed", reason: "website_build_not_verified", message: "Production build has not passed. Live Preview was not started." };
  }
  const runId = typeof (result as { runId?: unknown })?.runId === "string" ? (result as { runId: string }).runId : input.runId;
  const activity = { id: `${runId}:website-preview`, runId, stage: "preview", title: "Starting Live Preview", at: new Date().toISOString(), agentId: "System" };
  await emitCodingActivity(input, { ...activity, status: "running" });
  try {
    const preview = await ports.startPreview(input.ctx, companyId, projectId, input.sink?.signal, { development: !!stylePreview });
    await emitCodingActivity(input, { ...activity, status: preview.status === "running" ? "completed" : "failed", durationMs: Date.now() - Date.parse(activity.at) });
    return { ...run, websitePreview: preview };
  } catch (error) {
    await emitCodingActivity(input, { ...activity, status: input.sink?.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "Preview failed" });
    await ports.markFailed(input.ctx, companyId, projectId);
    throw error;
  }
}
