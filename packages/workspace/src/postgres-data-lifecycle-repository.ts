import { Pool } from "pg";
import type {
  CodeRetentionWindows,
  CodeDataRetentionReport,
  CodeDataErasureReport,
  CodeDataErasureTarget,
  CodeDataFamilyOutcome,
  CodeDataErasureOutcome,
  CodeDataLifecycleStore,
} from "./types";
import {
  CodeRunStateStoreError,
  CODE_RETENTION_FAMILIES,
  CODE_APPEND_ONLY_EVIDENCE_FAMILIES,
  EXPIRABLE_RETENTION_CLASSES,
} from "./types";
import {
  RETENTION_FROM,
  RETENTION_AGE_COLUMN,
  RETENTION_EXTRA_PREDICATE,
  RETENTION_WINDOW_EXPR,
  ERASE_FROM,
  ERASE_SCOPE_PREDICATE,
  ERASE_PROJECT_SCOPE_PREDICATE,
  ERASE_CLEAR_SESSION_REFERENCE,
  PROJECT_SCOPED_ERASE_TABLES,
  APPEND_ONLY_COUNTABLE,
  APPEND_ONLY_AGE_COLUMN,
  assertSqlFragment,
} from "./postgres-store-schema";

export async function planCodeDataRetention(pool: Pool, input: {
    companyId?: string;
    windows: CodeRetentionWindows;
    now: Date;
    dryRun: boolean;
  }): Promise<CodeDataRetentionReport> {
    const client = await pool.connect();
    const families: CodeDataFamilyOutcome[] = [];

    const tenant = input.companyId ?? null;
    const windowParams = () => [
      tenant,
      input.windows.ephemeralDays,
      input.windows.toolResultDays,
      input.windows.transcriptDays,
      input.windows.extendedDays,
      input.now,
      [...EXPIRABLE_RETENTION_CLASSES],
    ];
    try {
      await client.query("BEGIN");
      for (const family of CODE_RETENTION_FAMILIES) {
        const mappedFrom = RETENTION_FROM[family.table];
        const mappedAge = RETENTION_AGE_COLUMN[family.table];
        if (!mappedFrom || !mappedAge) {
          throw new CodeRunStateStoreError("code_data_lifecycle_table_unmapped", `No retention SQL is mapped for ${family.table}`);
        }
        const from = assertSqlFragment(mappedFrom, `FROM clause for ${family.table}`);
        const ageColumn = assertSqlFragment(mappedAge, `age column for ${family.table}`);
        const extra = RETENTION_EXTRA_PREDICATE[family.table];
        const where =
          `($1::text IS NULL OR t.company_id=$1) AND ${ageColumn} < ${RETENTION_WINDOW_EXPR}` +
          ` AND t.retention_class = ANY($7::text[])` +

          (extra ? ` AND ${extra}` : "");
        const params = windowParams();
        const counted = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${from} WHERE ${where}`, params);
        const expired = Number(counted.rows[0]?.n ?? 0);
        let purged = 0;
        if (!input.dryRun && expired > 0) {
          const removed = await client.query(`DELETE FROM ${from} WHERE ${where}`, params);
          purged = removed.rowCount ?? 0;
        }
        families.push({ table: family.table, scope: family.scope, expired, purged, retained: 0 });
      }
      const retainedFamilies: CodeDataFamilyOutcome[] = [];
      for (const family of CODE_APPEND_ONLY_EVIDENCE_FAMILIES) {

        const mappedFrom = APPEND_ONLY_COUNTABLE[family.table];
        const mappedAge = APPEND_ONLY_AGE_COLUMN[family.table];
        if (!mappedFrom || !mappedAge) {

          retainedFamilies.push({
            table: family.table,
            scope: family.scope,
            expired: 0,
            purged: 0,
            retained: 0,
            ...(family.retentionRefusal ? { retainedReason: family.retentionRefusal } : {}),
          });
          continue;
        }
        const from = assertSqlFragment(mappedFrom, `FROM clause for ${family.table}`);
        const ageColumn = assertSqlFragment(mappedAge, `age column for ${family.table}`);
        const where =
          `($1::text IS NULL OR t.company_id=$1) AND ${ageColumn} < ${RETENTION_WINDOW_EXPR}` +
          ` AND t.retention_class = ANY($7::text[])`;
        const counted = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${from} WHERE ${where}`, windowParams());
        const matched = Number(counted.rows[0]?.n ?? 0);
        retainedFamilies.push({
          table: family.table,
          scope: family.scope,
          expired: matched,
          purged: 0,
          retained: matched,
          ...(family.retentionRefusal ? { retainedReason: family.retentionRefusal } : {}),
        });
      }
      await client.query("COMMIT");
      const all = [...families, ...retainedFamilies];
      return {
        companyId: input.companyId ?? "*",
        windows: input.windows,
        families: all,
        expired: all.reduce((sum, entry) => sum + entry.expired, 0),
        purged: all.reduce((sum, entry) => sum + entry.purged, 0),
        retained: all.reduce((sum, entry) => sum + entry.retained, 0),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function eraseCodeData(pool: Pool, input: {
    companyId: string;
    target: CodeDataErasureTarget;
  }): Promise<CodeDataErasureReport> {
    const target = input.target;
    const key = target.kind === "session" ? target.sessionId : target.projectId;
    const client = await pool.connect();
    const families: CodeDataErasureOutcome[] = [];
    const preserved: Array<{ table: string; reason: string }> = [];
    try {
      await client.query("BEGIN");

      let projectId: string | undefined = target.kind === "project" ? target.projectId : target.projectId;
      if (target.kind === "session") {
        const session = await client.query<{ project_id: string }>(
          "SELECT project_id FROM code_sessions WHERE company_id=$1 AND id=$2",
          [input.companyId, target.sessionId],
        );
        if ((session.rowCount ?? 0) > 0) projectId = session.rows[0]!.project_id;
      }
      const projectScoped = target.kind === "project";

      const scopeKey = projectScoped ? projectId : key;
      const predicateSet = projectScoped ? ERASE_PROJECT_SCOPE_PREDICATE : ERASE_SCOPE_PREDICATE;

      const processRows = await client.query("SELECT project_id,state FROM code_process_projects WHERE company_id=$1 AND ($2::text IS NULL OR project_id=$2) FOR UPDATE", [input.companyId, projectId ?? null]);
      for (const row of processRows.rows) {
        const targeted = row.state.operations.filter((op: { sessionId: string; child?: { sessionId?: string } }) => projectScoped || op.sessionId === key || op.child?.sessionId === key);
        if (row.state.cleanupToken || targeted.some((op: { state: string }) => ["accepted","preparing","dispatching","running","interrupted","unknown_outcome"].includes(op.state))) throw new CodeRunStateStoreError("process_cleanup_blocked", "Settle tracked producers before erasing their workspace");
      }
      for (const family of CODE_RETENTION_FAMILIES) {
        if (family.table === "code_process_projects" && !projectScoped) {
          let purged = 0;
          for (const row of processRows.rows) {
            const kept = row.state.operations.filter((op: { sessionId: string }) => op.sessionId !== key);
            purged += row.state.operations.length - kept.length;
            await client.query("UPDATE code_process_projects SET state=$3 WHERE company_id=$1 AND project_id=$2", [input.companyId, row.project_id, { ...row.state, operations: kept }]);
          }
          families.push({ table: family.table, scope: family.scope, expired: purged, purged, retained: 0, remaining: 0 });
          continue;
        }
        const boundKey = family.scope === "project" && !projectScoped ? projectId : scopeKey;

        if (boundKey === undefined) continue;
        const mappedTable = ERASE_FROM[family.table];
        const mappedPredicate = predicateSet[family.table];
        if (!mappedTable || !mappedPredicate) {
          throw new CodeRunStateStoreError("code_data_lifecycle_table_unmapped", `No erasure SQL is mapped for ${family.table}`);
        }
        const table = assertSqlFragment(mappedTable, `table for ${family.table}`);
        const predicate = assertSqlFragment(mappedPredicate, `scope predicate for ${family.table}`);
        const removed = await client.query(`DELETE FROM ${table} WHERE ${predicate}`, [input.companyId, boundKey]);

        const left = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table} WHERE ${predicate}`, [input.companyId, boundKey]);
        families.push({
          table: family.table,
          scope: family.scope,
          expired: removed.rowCount ?? 0,
          purged: removed.rowCount ?? 0,
          retained: 0,
          remaining: Number(left.rows[0]?.n ?? 0),
        });
      }

      const sessionsRemoved = target.kind === "session"
        ? await client.query("DELETE FROM code_sessions WHERE company_id=$1 AND id=$2 RETURNING id", [input.companyId, key])
        : await client.query("DELETE FROM code_sessions WHERE company_id=$1 AND project_id=$2 RETURNING id", [input.companyId, target.projectId]);

      if (target.kind === "session") {
        for (const reference of Object.values(ERASE_CLEAR_SESSION_REFERENCE)) {
          await client.query(
            `UPDATE ${assertSqlFragment(reference.table, "reference table")} SET ${assertSqlFragment(reference.column, "reference column")}=NULL` +
            " WHERE company_id=$1 AND " + `${assertSqlFragment(reference.column, "reference column")}=$2`,
            [input.companyId, key],
          );
        }
      }

      if (projectScoped) {
        for (const name of PROJECT_SCOPED_ERASE_TABLES) {
          const table = assertSqlFragment(name, "project-scoped table");
          const predicate = assertSqlFragment("company_id=$1 AND project_id=$2", "project-scoped predicate");
          const removed = await client.query(`DELETE FROM ${table} WHERE ${predicate}`, [input.companyId, key]);
          const left = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table} WHERE ${predicate}`, [input.companyId, key]);
          families.push({
            table,
            scope: "project",
            expired: removed.rowCount ?? 0,
            purged: removed.rowCount ?? 0,
            retained: 0,
            remaining: Number(left.rows[0]?.n ?? 0),
          });
        }
      }

      for (const family of CODE_APPEND_ONLY_EVIDENCE_FAMILIES) {
        preserved.push({ table: family.table, reason: family.retentionRefusal ?? "append_only_evidence" });
      }
      await client.query("COMMIT");

      const sessionsLeft = await client.query<{ n: string }>(
        "SELECT count(*)::bigint AS n FROM code_sessions WHERE company_id=$1 AND " +
          (target.kind === "session" ? "id=$2" : "project_id=$2"),
        [input.companyId, key],
      );
      const outstanding = families.filter((entry) => entry.remaining > 0).map((entry) => entry.table);
      if (Number(sessionsLeft.rows[0]?.n ?? 0) > 0) outstanding.push("code_sessions");
      return {
        companyId: input.companyId,
        target,
        families,
        erased: families.reduce((sum, entry) => sum + entry.purged, 0) + (sessionsRemoved.rowCount ?? 0),
        outstanding,
        preserved,
        verified: outstanding.length === 0,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export function createPostgresDataLifecycleStore(pool: Pool): CodeDataLifecycleStore {
  return {
    planCodeDataRetention: (input) => planCodeDataRetention(pool, input),
    eraseCodeData: (input) => eraseCodeData(pool, input),
  };
}
