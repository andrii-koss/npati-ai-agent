import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "@npati/workspace";

const PROJECT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Anything newer is left alone, so a project that is being created right now is never removed. */
export const ORPHAN_MIN_AGE_MS = 10 * 60_000;

/**
 * Removes API workspace folders (`<root>/<companyId>/<projectId>`) whose project is no longer in the database, then
 * company folders left empty. Only folders named by an id are touched, and symbolic links are never followed.
 */
export async function removeOrphanWorkspaces(root: string, keepProjectIds: ReadonlySet<string>, olderThanMs = ORPHAN_MIN_AGE_MS, now = Date.now()) {
  const removed: string[] = [];
  for (const company of await readdir(root).catch(() => [] as string[])) {
    const companyDir = path.join(root, company);
    const companyInfo = await lstat(companyDir).catch(() => null);
    if (!PROJECT_ID.test(company) || !companyInfo?.isDirectory()) continue;
    const before = removed.length;
    for (const project of await readdir(companyDir).catch(() => [] as string[])) {
      if (!PROJECT_ID.test(project) || keepProjectIds.has(project)) continue;
      const dir = path.join(companyDir, project);
      const info = await lstat(dir).catch(() => null);
      if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(project);
    }
    // rmdir only removes an empty folder, so a project created meanwhile keeps its company folder.
    if (now - companyInfo.mtimeMs >= olderThanMs || removed.length > before) await rmdir(companyDir).catch(() => undefined);
  }
  return removed;
}

export interface ProjectOrphanSweepDeps {
  /** Every project id in the database, in any state (active, archived, waiting for purge). */
  listProjectIds(): Promise<string[]>;
  workspaceRoot: string;
  runner?: { pruneProjects?(keepProjectIds: readonly string[], olderThanMs: number): Promise<{ removed: string[] }> };
  log: { info(details: object, message: string): void; warn(details: object, message: string): void };
}

/**
 * When a project is gone from the database, its files are gone too: in the API workspace and in the sandbox runner.
 * Deleting one project already removes both; this also covers what a company deletion or a failed cleanup left behind.
 */
export async function sweepOrphanProjects(deps: ProjectOrphanSweepDeps, olderThanMs = ORPHAN_MIN_AGE_MS) {
  const ids = await deps.listProjectIds();
  const workspaces = await removeOrphanWorkspaces(deps.workspaceRoot, new Set(ids), olderThanMs);
  const runner = deps.runner?.pruneProjects ? (await deps.runner.pruneProjects(ids, olderThanMs)).removed : [];
  if (workspaces.length || runner.length) deps.log.info({ workspaces: workspaces.length, runner: runner.length }, "orphan_project_files_removed");
  return { workspaces, runner };
}

/** Runs the sweep a minute after start and then every `intervalMs`. Returns a stop function. */
export function startProjectOrphanSweep(deps: ProjectOrphanSweepDeps, intervalMs: number) {
  const run = () => void sweepOrphanProjects(deps).catch((err) => deps.log.warn({ err }, "orphan_project_sweep_failed"));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

export interface CompanyProjectCleanupDeps {
  listProjects(ctx: AuthContext, companyId: string): Promise<Array<{ id: string }>>;
  /** Deletes one project the way the settings page does, which also destroys its sandbox. */
  deleteProject(ctx: AuthContext, companyId: string, projectId: string): Promise<unknown>;
  removeWorkspace(ctx: AuthContext, companyId: string, projectId: string): Promise<{ removed: boolean; reason?: string }>;
  workspaceRoot: string;
}

/**
 * Before a company is deleted, each of its projects is deleted like a single one, and the company's workspace folder
 * goes with them. A project whose files could not be removed stops the deletion, so nothing is left behind silently.
 */
export function createCompanyProjectCleanup(deps: CompanyProjectCleanupDeps) {
  return async (ctx: AuthContext, companyId: string) => {
    for (const project of await deps.listProjects(ctx, companyId)) {
      await deps.deleteProject(ctx, companyId, project.id);
      const removal = await deps.removeWorkspace(ctx, companyId, project.id);
      if (!removal.removed) throw new Error(`Files of project ${project.id} were not removed: ${removal.reason ?? "unknown reason"}`);
    }
    if (!PROJECT_ID.test(companyId)) return;
    const companyDir = path.join(deps.workspaceRoot, companyId);
    const info = await lstat(companyDir).catch(() => null);
    if (info?.isDirectory()) await rm(companyDir, { recursive: true, force: true });
  };
}
