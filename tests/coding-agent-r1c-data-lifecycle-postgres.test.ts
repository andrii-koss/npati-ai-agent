import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresWorkspaceStore,
  resolveCodeRetentionWindows,
  type AuthContext,
  type CodeDataLifecycleStore,
} from "@npati/workspace";
import { CodeDataErasureService } from "../apps/agent-api/src/code-data-erasure";
import { databaseDescribe, missingDatabaseSkip } from "./support/database-describe";
import { runWithCleanup } from "./support/run-with-cleanup";

/**
 * R1-C (items 11–13) — database half.
 *
 * The hermetic suite next to this file pins the shape of the retention/erasure contract. What it cannot prove
 * is the only thing that matters about a retention step: that the rows really disappear, that the fresh ones
 * really survive, and that a table the Coding Agent **shares** with the Website Builder is not touched. A fake
 * port would make all three trivially true and mean nothing.
 *
 * Four measurements:
 *
 *  1. **Migration 087 applied.** The three families carry `data_classification`/`retention_class` with the
 *     established vocabulary, and re-running the migration is a no-op — the second half of the upgrade gate's
 *     contract, measured here as well as by the chain suite.
 *  2. **Retention expires and does not over-expire.** A row past its own class's window is deleted; a row of
 *     the same table and class that is fresh is kept; an `until_deleted` row is kept whatever its age.
 *  3. **The negative control: a Website Builder checkpoint is never expired**, even when it is the oldest row
 *     in the table and long past the window — because the retention statement proves `code_project` in the
 *     same statement as the delete. The same project is then refused by the erasure service.
 *  4. **Erasure removes everything erasable and says what it could not.** The report's `outstanding` is empty
 *     and read back from the database, the append-only evidence is named in `preserved`, and a second call is
 *     `already_erased` rather than an error.
 *
 * `code_activity_events` is deliberately **not** asserted as preserved: it is append-only by trigger, and the
 * point of the retention contract is that it is not reached at all. The suite asserts the boundary through the
 * reachable tables instead, and `preserved` names the rest.
 */
const databaseUrl = process.env.DATABASE_URL;
const databaseGateRequested = process.env.NPATI_SECURITY_GATE_DB === "1";
const databaseGateRunning = Boolean(databaseUrl) && databaseGateRequested;
const describeDatabase = databaseDescribe(
  databaseGateRunning,
  describe,
  typeof describe.skip === "function"
    ? describe.skip
    : (name: string) => missingDatabaseSkip(name),
);
const databaseNote = databaseGateRunning
  ? ""
  : " [SKIPPED: run `npm run security-gate:db` (or `npm run gate:upgrade:db`), which requires DATABASE_URL and is never skipped]";

/** The windows the sweep is given. Small on purpose: the point is the class rule, not the default numbers. */
const WINDOWS = resolveCodeRetentionWindows({ toolResultRetentionDays: 1, transcriptRetentionDays: 2 });
/** Older than every window above, so only `until_deleted` can survive it. */
const OLD = "2020-01-01T00:00:00.000Z";
const NOW = new Date("2026-03-01T12:00:00.000Z");

function againstDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function withFreshDatabase<T>(body: (input: { store: PostgresWorkspaceStore; pool: Pool; url: string }) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: String(databaseUrl) });
  const name = `npati_r1c_lifecycle_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const url = againstDatabase(String(databaseUrl), name);
  const store = new PostgresWorkspaceStore(url);
  const pool = new Pool({ connectionString: url });
  return runWithCleanup(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    return body({ store, pool, url });
  }, async () => {
    await pool.end();
    await store.close();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });
}

interface Seeded {
  ctx: AuthContext;
  companyId: string;
  codeProjectId: string;
  websiteProjectId: string;
  sessionId: string;
  runId: string;
}

/**
 * A tenant with both project types, one code session, one run with two turns, and one checkpoint per project.
 * `until_deleted` and `fresh` variants are created by the tests that need them, so each measurement stands on
 * its own.
 */
async function seed(store: PostgresWorkspaceStore): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const ctx: AuthContext = {
    workspaceId: `ws-r1c-${suffix}`,
    userId: `u-r1c-${suffix}`,
    permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
  };
  await store.initialize(ctx);
  const company = await store.createCompany(ctx, { name: `R1C Co ${suffix}` }, `r1c-${suffix}`);
  const code = await store.createProject(ctx, company.id, { name: "Code project", type: "code_project" }, `r1c-code-${suffix}`);
  const website = await store.createProject(ctx, company.id, { name: "Website project", type: "website" }, `r1c-web-${suffix}`);
  const session = await store.createCodeSession(ctx, company.id, code.project.id, { mode: "edit", retentionClass: "short" });
  const runId = `run-${suffix}`;
  await store.createCodeRunState({
    runId,
    workspaceId: ctx.workspaceId,
    companyId: company.id,
    projectId: code.project.id,
    sessionId: session.id,
    owner: "r1c-test",
    leaseMs: 60_000,
    now: NOW,
    retentionClass: "short",
  });
  for (const turnIndex of [1, 2]) {
    await store.upsertCodeRunTurn({
      runId,
      companyId: company.id,
      turnIndex,
      status: "finished",
      outcome: "ok",
      toolCalls: [{ toolCallId: `call-${turnIndex}`, tool: "code.fs.read", outcome: "ok", truncated: false }],
      startedAt: NOW,
    });
  }
  await store.createProjectCheckpoint(ctx, company.id, code.project.id, { name: "code checkpoint", trigger: "pre_run", runId });
  await store.createProjectCheckpoint(ctx, company.id, website.project.id, { name: "website checkpoint", trigger: "manual" });
  return { ctx, companyId: company.id, codeProjectId: code.project.id, websiteProjectId: website.project.id, sessionId: session.id, runId };
}

/** Backdates the rows a retention sweep is supposed to consider, so the class rule is what is measured. */
async function backdateEverything(pool: Pool, seeded: Seeded): Promise<void> {
  await pool.query("UPDATE code_run_states SET started_at=$1 WHERE company_id=$2", [OLD, seeded.companyId]);
  await pool.query("UPDATE code_run_turns SET started_at=$1, retention_class='short' WHERE company_id=$2", [OLD, seeded.companyId]);
  await pool.query("UPDATE project_checkpoints SET created_at=$1, retention_class='short' WHERE company_id=$2", [OLD, seeded.companyId]);
}

const lifecycleOf = (store: PostgresWorkspaceStore): CodeDataLifecycleStore => {
  const lifecycle = store.codeDataLifecycle;
  if (!lifecycle) throw new Error("the Postgres store must expose the data-lifecycle port");
  return lifecycle;
};

async function count(pool: Pool, sql: string, params: unknown[]): Promise<number> {
  const result = await pool.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

describeDatabase(`R1-C data lifecycle on a real database${databaseNote}`, () => {
  it("applies migration 087 with the established vocabulary, and re-running it changes nothing", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      await store.initialize();

      const applied = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version='087_code_data_retention'");
      expect(applied.rowCount).toBe(1);

      for (const table of ["code_run_turns", "project_checkpoints", "execution_snapshots"]) {
        const columns = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
          `SELECT column_name, is_nullable, column_default FROM information_schema.columns
            WHERE table_name=$1 AND column_name IN ('data_classification','retention_class') ORDER BY column_name`,
          [table],
        );
        expect(columns.rows.map((row) => row.column_name)).toEqual(["data_classification", "retention_class"]);
        // NOT NULL **with a default**: an insert from a previous application version keeps working, which is
        // what makes the change expand-only rather than a breaking one.
        expect(columns.rows.every((row) => row.is_nullable === "NO" && row.column_default !== null)).toBe(true);

        const constraints = await pool.query<{ conname: string; definition: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid = $1::regclass AND contype = 'c' AND conname LIKE '%class%' ORDER BY conname`,
          [table],
        );
        // The definition is compared by the values the vocabulary allows, not by its spelling: PostgreSQL
        // rewrites `IN (...)` into `= ANY (ARRAY[...])`, and pinning the rewritten text would make the suite a
        // test of the planner's formatting rather than of the vocabulary.
        expect(constraints.rows.map((row) => row.conname)).toEqual([
          `${table}_data_classification_check`,
          `${table}_retention_class_check`,
        ]);
        const definition = constraints.rows.map((row) => row.definition).join(" ");
        for (const value of ["'public'", "'internal'", "'confidential'", "'restricted'", "'ephemeral'", "'short'", "'standard'", "'extended'", "'until_deleted'"]) {
          expect({ table, value, present: definition.includes(value) }).toEqual({ table, value, present: true });
        }

        const index = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE tablename=$1 AND indexname=$2",
          [table, `${table}_retention_idx`],
        );
        expect(index.rowCount).toBe(1);
      }

      // Re-running the migration module against the same database really is a no-op: the DDL is idempotent
      // down to the constraints, which is what the upgrade gate's second half measures.
      const { runMigration087 } = await import("../packages/workspace/src/migration-087");
      const client = await pool.connect();
      try {
        await runMigration087(client);
        await runMigration087(client);
      } finally {
        client.release();
      }
      const stillApplied = await pool.query("SELECT 1 FROM schema_migrations WHERE version='087_code_data_retention'");
      expect(stillApplied.rowCount).toBe(1);
    });
  }, 180_000);

  it("expires rows past their own class's window, keeps fresh rows, and never expires `until_deleted`", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      const seeded = await seed(store);
      await backdateEverything(pool, seeded);
      // A second turn of the same run is fresh: same table, same class, different age.
      await store.upsertCodeRunTurn({
        runId: seeded.runId,
        companyId: seeded.companyId,
        turnIndex: 3,
        status: "finished",
        outcome: "ok",
        startedAt: NOW,
      });
      await pool.query("UPDATE code_run_turns SET retention_class='short' WHERE company_id=$1 AND turn_index=3", [seeded.companyId]);
      // …and a fourth turn that is old but asks to be kept until the user deletes it.
      await store.upsertCodeRunTurn({
        runId: seeded.runId,
        companyId: seeded.companyId,
        turnIndex: 4,
        status: "finished",
        outcome: "ok",
        startedAt: NOW,
      });
      await pool.query("UPDATE code_run_turns SET retention_class='until_deleted', started_at=$1 WHERE company_id=$2 AND turn_index=4", [OLD, seeded.companyId]);

      const before = await count(pool, "SELECT count(*)::text AS n FROM code_run_turns WHERE company_id=$1", [seeded.companyId]);
      expect(before).toBe(4);

      // A dry run measures and deletes nothing.
      const preview = await lifecycleOf(store).planCodeDataRetention({ companyId: seeded.companyId, windows: WINDOWS, now: NOW, dryRun: true });
      expect(preview.expired).toBeGreaterThan(0);
      expect(preview.purged).toBe(0);
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_run_turns WHERE company_id=$1", [seeded.companyId])).toBe(4);

      const applied = await lifecycleOf(store).planCodeDataRetention({ companyId: seeded.companyId, windows: WINDOWS, now: NOW, dryRun: false });
      expect(applied.purged).toBeGreaterThan(0);

      // What survives is exactly the fresh turn and the `until_deleted` one.
      const survivors = await pool.query<{ turn_index: number; retention_class: string }>(
        "SELECT turn_index, retention_class FROM code_run_turns WHERE company_id=$1 ORDER BY turn_index",
        [seeded.companyId],
      );
      expect(survivors.rows).toEqual([
        { turn_index: 3, retention_class: "short" },
        { turn_index: 4, retention_class: "until_deleted" },
      ]);

      // Idempotent: the second pass finds nothing left to expire.
      const second = await lifecycleOf(store).planCodeDataRetention({ companyId: seeded.companyId, windows: WINDOWS, now: NOW, dryRun: false });
      expect(second.purged).toBe(0);
    });
  }, 180_000);

  it("never expires a Website Builder checkpoint — the negative control for the shared table", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      const seeded = await seed(store);
      await backdateEverything(pool, seeded);

      const report = await lifecycleOf(store).planCodeDataRetention({ companyId: seeded.companyId, windows: WINDOWS, now: NOW, dryRun: false });

      // The code project's checkpoint is gone…
      const checkpoints = await pool.query<{ project_id: string }>(
        "SELECT project_id FROM project_checkpoints WHERE company_id=$1",
        [seeded.companyId],
      );
      expect(checkpoints.rows.map((row) => row.project_id)).toEqual([seeded.websiteProjectId]);
      // …the Website Builder's one is not, and the family reports only what it really removed.
      const family = report.families.find((entry) => entry.table === "project_checkpoints");
      expect(family?.purged).toBe(1);
      // The project rows themselves are untouched: this step never deletes a project, of either type.
      const projects = await pool.query<{ id: string }>("SELECT id FROM projects WHERE company_id=$1 ORDER BY id", [seeded.companyId]);
      expect(projects.rows.map((row) => row.id).sort()).toEqual([seeded.codeProjectId, seeded.websiteProjectId].sort());
    });
  }, 180_000);

  it("erases a session's data, verifies nothing is left, and answers `already_erased` on a second call", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      const seeded = await seed(store);
      const service = new CodeDataErasureService({
        store: {
          lifecycle: lifecycleOf(store),
          // The same wrapping the composition does, and for the same reason: a repeat erasure asks for a session
          // that no longer exists, and the store answers an unknown id with an error. Resolving it to `null` is
          // what makes the second call `already_erased` instead of a 500.
          resolveSession: async ({ companyId, sessionId }) => {
            try {
              const session = await store.getCodeSession(seeded.ctx, companyId, sessionId);
              return { projectId: session.projectId };
            } catch {
              return null;
            }
          },
          resolveProject: async ({ ctx, companyId, projectId }) => {
            try {
              const project = await store.getProject(ctx, companyId, projectId);
              return { type: project.type };
            } catch {
              return null;
            }
          },
        },
        audit: { record: async () => undefined },
        removeWorkspace: async () => ({ removed: true, alreadyAbsent: false }),
        logger: { warn: () => undefined },
      });

      const first = await service.erase({
        ctx: seeded.ctx,
        actor: seeded.ctx.userId,
        companyId: seeded.companyId,
        target: { kind: "session", sessionId: seeded.sessionId },
      });

      expect(first.verified).toBe(true);
      expect(first.outstanding).toEqual([]);
      expect(first.removed.rows).toBeGreaterThan(0);
      // The shared project directory is never removed by a session-scoped erasure.
      expect(first.workspaceReason).toBe("session_scope_preserves_project_workspace");

      // Read back from the database: the session-scoped families really are empty for this session.
      for (const table of ["code_run_states", "code_session_plans", "code_goals", "code_session_todos", "code_user_questions", "code_session_rewinds", "code_session_forks"]) {
        expect({
          table,
          rows: await count(pool, `SELECT count(*)::text AS n FROM ${table} WHERE company_id=$1 AND session_id=$2`, [seeded.companyId, seeded.sessionId]),
        }).toEqual({ table, rows: 0 });
      }
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_run_turns WHERE company_id=$1", [seeded.companyId])).toBe(0);
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_sessions WHERE company_id=$1 AND id=$2", [seeded.companyId, seeded.sessionId])).toBe(0);
      // The project itself and the other project's data survive: an erasure is scoped, not a tenant wipe.
      expect(await count(pool, "SELECT count(*)::text AS n FROM projects WHERE company_id=$1", [seeded.companyId])).toBe(2);
      expect(await count(pool, "SELECT count(*)::text AS n FROM project_checkpoints WHERE company_id=$1 AND project_id=$2", [seeded.companyId, seeded.websiteProjectId])).toBe(1);

      // The evidence the erasure may not touch is named in the answer…
      expect(first.preserved.map((entry) => entry.table)).toEqual(
        expect.arrayContaining(["execution_snapshots", "code_replay_bundles", "code_context_summaries"]),
      );
      expect(first.preserved.every((entry) => entry.reason === "append_only_evidence")).toBe(true);

      // …and a repeat call is `already_erased`, not an error and not a second deletion.
      const second = await service.erase({
        ctx: seeded.ctx,
        actor: seeded.ctx.userId,
        companyId: seeded.companyId,
        target: { kind: "session", sessionId: seeded.sessionId },
      });
      expect(second.status).toBe("already_erased");
      expect(second.verified).toBe(true);
    });
  }, 180_000);

  it("refuses to erase a Website Builder project and deletes nothing", async () => {    await withFreshDatabase(async ({ store, pool }) => {
      const seeded = await seed(store);
      const service = new CodeDataErasureService({
        store: {
          lifecycle: lifecycleOf(store),
          resolveSession: async () => null,
          resolveProject: async ({ ctx, companyId, projectId }) => {
            const project = await store.getProject(ctx, companyId, projectId);
            return { type: project.type };
          },
        },
        audit: { record: async () => undefined },
        removeWorkspace: async () => ({ removed: true, alreadyAbsent: false }),
        logger: { warn: () => undefined },
      });

      await expect(service.erase({
        ctx: seeded.ctx,
        actor: seeded.ctx.userId,
        companyId: seeded.companyId,
        target: { kind: "project", projectId: seeded.websiteProjectId },
      })).rejects.toMatchObject({ details: { reason: "not_a_code_project" } });

      // Nothing was touched: the refusal happens before any statement reaches a table.
      expect(await count(pool, "SELECT count(*)::text AS n FROM projects WHERE company_id=$1", [seeded.companyId])).toBe(2);
      expect(await count(pool, "SELECT count(*)::text AS n FROM project_checkpoints WHERE company_id=$1", [seeded.companyId])).toBe(2);
    });
  }, 180_000);

  it("erases a whole code project: its checkpoints, its sessions and every session-scoped family", async () => {
    await withFreshDatabase(async ({ store, pool }) => {
      const seeded = await seed(store);
      const service = new CodeDataErasureService({
        store: {
          lifecycle: lifecycleOf(store),
          resolveSession: async () => null,
          resolveProject: async ({ ctx, companyId, projectId }) => {
            const project = await store.getProject(ctx, companyId, projectId);
            return { type: project.type };
          },
        },
        audit: { record: async () => undefined },
        removeWorkspace: async () => ({ removed: true, alreadyAbsent: false }),
        logger: { warn: () => undefined },
      });

      const result = await service.erase({
        ctx: seeded.ctx,
        actor: seeded.ctx.userId,
        companyId: seeded.companyId,
        target: { kind: "project", projectId: seeded.codeProjectId },
      });

      expect(result.status).toBe("erased");
      expect(result.verified).toBe(true);
      expect(result.outstanding).toEqual([]);
      // A whole-project erasure is the only scope that may remove the on-disk workspace.
      expect(result.removed.workspace).toBe(true);
      expect(result.workspaceReason).toBe("workspace_removed");

      expect(await count(pool, "SELECT count(*)::text AS n FROM project_checkpoints WHERE company_id=$1 AND project_id=$2", [seeded.companyId, seeded.codeProjectId])).toBe(0);
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_sessions WHERE company_id=$1 AND project_id=$2", [seeded.companyId, seeded.codeProjectId])).toBe(0);
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_run_states WHERE company_id=$1 AND project_id=$2", [seeded.companyId, seeded.codeProjectId])).toBe(0);
      expect(await count(pool, "SELECT count(*)::text AS n FROM code_run_turns WHERE company_id=$1 AND run_id=$2", [seeded.companyId, seeded.runId])).toBe(0);
      // The other project — of another type, in the same Company — is untouched.
      expect(await count(pool, "SELECT count(*)::text AS n FROM projects WHERE company_id=$1", [seeded.companyId])).toBe(2);
      expect(await count(pool, "SELECT count(*)::text AS n FROM project_checkpoints WHERE company_id=$1 AND project_id=$2", [seeded.companyId, seeded.websiteProjectId])).toBe(1);
    });
  }, 180_000);
});
