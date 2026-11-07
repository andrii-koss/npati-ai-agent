import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompanyProjectCleanup, removeOrphanWorkspaces, sweepOrphanProjects } from "../apps/agent-api/src/project-orphan-sweep";

const company = "11111111-1111-4111-8111-111111111111";
const kept = "22222222-2222-4222-8222-222222222222";
const orphan = "33333333-3333-4333-8333-333333333333";
const fresh = "44444444-4444-4444-8444-444444444444";
const hour = 60 * 60_000;
let root: string;

async function project(id: string, ageMs: number, companyId = company) {
  const dir = path.join(root, companyId, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<h1>site</h1>");
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "orphan-sweep-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("removeOrphanWorkspaces", () => {
  it("removes old folders of projects the database no longer has and keeps the rest", async () => {
    const keptDir = await project(kept, hour);
    const orphanDir = await project(orphan, hour);
    const freshDir = await project(fresh, 0);
    await mkdir(path.join(root, company, ".locks"));
    const removed = await removeOrphanWorkspaces(root, new Set([kept]));
    expect(removed).toEqual([orphan]);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(keptDir)).toBe(true);
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(path.join(root, company, ".locks"))).toBe(true);
  });

  it("removes the company folder once its last project is gone", async () => {
    await project(orphan, hour);
    await removeOrphanWorkspaces(root, new Set());
    expect(existsSync(path.join(root, company))).toBe(false);
  });

  it("does nothing when the root is missing", async () => {
    await expect(removeOrphanWorkspaces(path.join(root, "missing"), new Set())).resolves.toEqual([]);
  });
});

describe("sweepOrphanProjects", () => {
  it("gives the runner the same list of projects to keep", async () => {
    await project(orphan, hour);
    const pruneProjects = vi.fn(async () => ({ removed: ["55555555-5555-4555-8555-555555555555"] }));
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await sweepOrphanProjects({ listProjectIds: async () => [kept], workspaceRoot: root, runner: { pruneProjects }, log });
    expect(pruneProjects).toHaveBeenCalledWith([kept], expect.any(Number));
    expect(result).toEqual({ workspaces: [orphan], runner: ["55555555-5555-4555-8555-555555555555"] });
    expect(log.info).toHaveBeenCalledWith({ workspaces: 1, runner: 1 }, "orphan_project_files_removed");
  });

  it("removes nothing when the project list cannot be read", async () => {
    const dir = await project(orphan, hour);
    const pruneProjects = vi.fn();
    await expect(sweepOrphanProjects({ listProjectIds: async () => { throw new Error("db down"); }, workspaceRoot: root, runner: { pruneProjects }, log: { info: vi.fn(), warn: vi.fn() } })).rejects.toThrow("db down");
    expect(pruneProjects).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("createCompanyProjectCleanup", () => {
  const ctx = { workspaceId: "w", userId: "u", permissions: ["business:manage"] } as never;

  it("deletes each project like a single one, then the company folder", async () => {
    await project(kept, 0);
    await project(orphan, 0);
    const deleted: string[] = [];
    const cleanup = createCompanyProjectCleanup({
      listProjects: async () => [{ id: kept }],
      deleteProject: async (_ctx, _company, id) => { deleted.push(id); },
      removeWorkspace: async () => ({ removed: true }),
      workspaceRoot: root,
    });
    await cleanup(ctx, company);
    expect(deleted).toEqual([kept]);
    // A project of another member is not listed for this user, but its folder goes with the company.
    expect(existsSync(path.join(root, company))).toBe(false);
  });

  it("stops the company deletion when a project's files survive", async () => {
    await project(kept, 0);
    const cleanup = createCompanyProjectCleanup({
      listProjects: async () => [{ id: kept }],
      deleteProject: async () => undefined,
      removeWorkspace: async () => ({ removed: false, reason: "symlink_refused" }),
      workspaceRoot: root,
    });
    await expect(cleanup(ctx, company)).rejects.toThrow("symlink_refused");
    expect((await stat(path.join(root, company))).isDirectory()).toBe(true);
  });
});
