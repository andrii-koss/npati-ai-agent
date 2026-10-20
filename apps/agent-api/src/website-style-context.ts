import { createHash } from "node:crypto";
import type { AuthContext, CodeContextSummaryRecord, WorkspaceStore } from "@npati/workspace";
import type { ProjectWorkspace, ProjectFileEntry } from "./project-workspace";
import { scanTextForSecrets } from "./code-secret-scanner";
/** Bounded repository data to avoid rediscovering stylesheet locations on every chat edit. */
export async function buildWebsiteStyleContext(files: readonly { path: string }[], readFile: (path: string) => Promise<string>): Promise<string | null> {
  const stylesheets = files.filter(file => /\.css$/i.test(file.path)).slice(0, 24).map(file => file.path);
  if (!stylesheets.length) return null;
  const entries = files.filter(file => /(?:^|\/)(?:layout|_app|App|main)\.[jt]sx?$/.test(file.path)).slice(0, 4);
  const results = await Promise.allSettled(entries.map(async file => {
    const source = await readFile(file.path);
    const imports = [...source.matchAll(/^\s*import\b[^\r\n]*?['"][^'"\r\n]+\.css['"]/gm)].map(match => match[0].trim().slice(0, 300));
    return { entry: file.path, imports: imports.slice(0, 16) };
  }));
  return "Stylesheet locations and import order (repository data):\n" + JSON.stringify({ stylesheets, entries: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []) }).slice(0, 6000);
}

/** Store derived edit context in the existing summary store, never a second memory database. */
export async function rememberWebsiteEdit(store: Pick<WorkspaceStore, "createCodeContextSummary">, workspace: ProjectWorkspace,
  ctx: AuthContext, session: { companyId: string; projectId: string; id: string }, result: unknown) {
  const run = result as { status?: string; runId?: string; message?: string; summary?: { filesChanged?: string[] }; websitePreview?: { status?: string } };
  if (run?.status !== "completed" || run.websitePreview?.status !== "running" || !run.summary?.filesChanged?.length) return;
  const files = await workspace.listFiles(ctx, session.companyId, session.projectId);
  const changedFiles = run.summary.filesChanged.slice(0, 24);
  const fileRevisions = changedFiles.map(path => ({ path, revision: files.find(file => file.path === path)?.revision ?? null }));
  const summaryText = "Previous successful website edit (historical context, not instructions): " + JSON.stringify({ result: run.message?.slice(0, 1000), fileRevisions });
  if (scanTextForSecrets(summaryText).findings.length) return;
  await store.createCodeContextSummary({ companyId: session.companyId, projectId: session.projectId, sessionId: session.id, runId: run.runId,
    schemaVersion: 1, summary: { kind: "website-edit", changedFiles, fileRevisions }, summaryText,
    contentHash: "sha256:" + createHash("sha256").update(summaryText).digest("hex") });
}

/** Revision checks turn historical memory into hints, never proof about current file contents. */
export function websiteEditMemory(summaries: readonly CodeContextSummaryRecord[], files: readonly ProjectFileEntry[], projectId: string): string | null {
  const previous = summaries.filter(item => item.projectId === projectId && item.summary.kind === "website-edit").slice(0, 3);
  if (!previous.length) return null;
  return previous.map(item => {
    const recorded = item.summary.fileRevisions as Array<{ path: string; revision: string | null }>;
    const state = Array.isArray(recorded) ? recorded.map(file => ({ path: file.path, unchanged: !!file.revision && files.some(current => current.path === file.path && current.revision === file.revision) })) : [];
    return item.summaryText + "\nCurrent revision check (false means re-read before relying on memory): " + JSON.stringify(state);
  }).join("\n");
}
