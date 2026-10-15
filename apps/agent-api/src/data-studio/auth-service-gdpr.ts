import type { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type {
  GdprAffectedCollection,
  GdprAffectedData,
  GdprExportResult,
  GdprStrategy,
  ProjectAuthUser,
  ProjectAuthUserStatus,
} from "@npati/shared";
import { DataStudioError, quoteIdentifier } from "./identifier";
import type { DataEnvironmentName } from "./types";
import type { ProjectAuthHost } from "./auth-service-host";

export async function findUserReferenceCollections(
  pool: Pool,
): Promise<Array<{ collection: string; field: string }>> {
  // Find all public tables (not starting with _npati_) that have a column owner_id or user_id
  const colsRes = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name NOT LIKE '_npati_%'
       AND column_name IN ('owner_id', 'user_id', 'author_id', 'account_id', 'created_by')
     ORDER BY table_name`,
  );

  return colsRes.rows.map((r) => ({ collection: r.table_name, field: r.column_name }));
}

export async function exportAuthUserData(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
): Promise<GdprExportResult> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "migrator");

  const userRes = await pool.query<{
    id: string;
    email: string;
    email_verified: boolean;
    status: ProjectAuthUserStatus;
    created_at: string;
    last_login: string | null;
    metadata: Record<string, unknown>;
  }>(
    "SELECT id, email, email_verified, status, created_at, last_login, metadata FROM _npati_auth_users WHERE id = $1",
    [userId],
  );

  if (!userRes.rowCount) {
    throw new DataStudioError(404, "gdpr_export", "User not found", false, "USER_NOT_FOUND");
  }

  const row = userRes.rows[0]!;
  const rolesRes = await pool.query<{ role: string }>(
    "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
    [userId],
  );

  const user: ProjectAuthUser = {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    status: row.status,
    roles: rolesRes.rows.map((r) => r.role),
    createdAt: row.created_at,
    lastLogin: row.last_login,
    metadata: row.metadata,
  };

  const collections = await findUserReferenceCollections(pool);
  const data: Record<string, Record<string, unknown>[]> = {};

  for (const ref of collections) {
    const qRes = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdentifier(ref.collection)} WHERE ${quoteIdentifier(ref.field)} = $1`,
      [userId],
    );
    data[ref.collection] = qRes.rows;
  }

  return {
    user,
    data,
    exportedAt: new Date().toISOString(),
  };
}

export async function previewDeleteAuthUser(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
  customStrategies: Record<string, GdprStrategy> = {},
): Promise<GdprAffectedData> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.repository.environment(ctx, companyId, backend.id, environment);
  const effectiveStrategies: Record<string, GdprStrategy> = {
    ...((settings.providerConfig.gdprStrategies as Record<string, GdprStrategy> | undefined) ?? {}),
    ...customStrategies,
  };
  const pool = await host.getPool(backend, environment, "migrator");

  const userRes = await pool.query("SELECT id FROM _npati_auth_users WHERE id = $1", [userId]);
  if (!userRes.rowCount) {
    throw new DataStudioError(404, "gdpr_delete", "User not found", false, "USER_NOT_FOUND");
  }

  const refs = await findUserReferenceCollections(pool);
  const affected: GdprAffectedCollection[] = [];
  let total = 0;

  for (const ref of refs) {
    // Default strategies for known patterns
    let strategy: GdprStrategy = effectiveStrategies[ref.collection] ?? "delete";
    if (["orders", "order_items", "payments", "invoices"].includes(ref.collection)) {
      strategy = effectiveStrategies[ref.collection] ?? "anonymize";
    }

    const countRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM ${quoteIdentifier(ref.collection)} WHERE ${quoteIdentifier(ref.field)} = $1`,
      [userId],
    );
    const count = Number(countRes.rows[0]?.count ?? 0);
    if (count > 0) {
      affected.push({
        collection: ref.collection,
        strategy,
        affectedRows: count,
      });
      total += count;
    }
  }

  return {
    userId,
    collections: affected,
    totalAffectedRows: total,
  };
}

export async function deleteAuthUser(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
  options: { confirmed: boolean; strategies?: Record<string, GdprStrategy> },
): Promise<{ success: boolean; deletedUserId: string }> {
  if (!options.confirmed) {
    throw new DataStudioError(400, "gdpr_delete", "CONFIRMATION_REQUIRED: User deletion requires explicit confirmation", false, "CONFIRMATION_REQUIRED");
  }

  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "migrator");
  const refs = await findUserReferenceCollections(pool);

  const env = await host.repository.environment(ctx, companyId, backend.id, environment);
  const strategies: Record<string, GdprStrategy> = {
    ...((env.providerConfig.gdprStrategies as Record<string, GdprStrategy> | undefined) ?? {}),
    ...options.strategies,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const ref of refs) {
      const strat = strategies[ref.collection] ?? (
        ["orders", "order_items", "payments", "invoices"].includes(ref.collection) ? "anonymize" : "delete"
      );

      const tbl = quoteIdentifier(ref.collection);
      const col = quoteIdentifier(ref.field);

      switch (strat) {
        case "delete":
          await client.query(`DELETE FROM ${tbl} WHERE ${col} = $1`, [userId]);
          break;
        case "detach":
          await client.query(`UPDATE ${tbl} SET ${col} = NULL WHERE ${col} = $1`, [userId]);
          break;
        case "anonymize": {
          const columns = await client.query<{ column_name: string; data_type: string }>(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
            [ref.collection],
          );
          const personalFields = new Set(["email", "phone", "name", "first_name", "last_name", "recipient_name", "city", "street", "postal_code", "address", "shipping_address"]);
          const assignments = [`${col} = NULL`];
          for (const field of columns.rows) {
            if (!personalFields.has(field.column_name) || field.column_name === ref.field) continue;
            if (["text", "character varying", "character"].includes(field.data_type)) assignments.push(`${quoteIdentifier(field.column_name)} = '[deleted]'`);
            else if (["json", "jsonb"].includes(field.data_type)) assignments.push(`${quoteIdentifier(field.column_name)} = '{}'`);
          }
          await client.query(`UPDATE ${tbl} SET ${assignments.join(", ")} WHERE ${col} = $1`, [userId]);
          break;
        }
        case "retain":
          // Keep rows as-is (audit requirement)
          break;
      }
    }

    await client.query("DELETE FROM _npati_auth_users WHERE id = $1", [userId]);
    await client.query("COMMIT");
    return { success: true, deletedUserId: userId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
