import type { AuthContext } from "@npati/workspace";
import type { ProjectAuthUser, ProjectAuthUserStatus } from "@npati/shared";
import { DataStudioError } from "./identifier";
import type { DataEnvironmentName } from "./types";
import type { ProjectAuthHost } from "./auth-service-host";

export async function listAuthUsers(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  query: { limit?: number; offset?: number; search?: string; status?: ProjectAuthUserStatus } = {},
): Promise<{ users: ProjectAuthUser[]; total: number }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  await host.ensureInitialized(ctx, backend, environment);
  const pool = await host.getPool(backend, environment, "migrator");

  const params: unknown[] = [];
  const where: string[] = [];

  if (query.status) {
    params.push(query.status);
    where.push(`u.status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search.toLowerCase()}%`);
    where.push(`LOWER(u.email) LIKE $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRes = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM _npati_auth_users u ${whereClause}`,
    params,
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const limit = Math.min(Math.max(1, query.limit ?? 50), 100);
  const offset = Math.max(0, query.offset ?? 0);
  params.push(limit, offset);

  const sql = `
    SELECT u.id, u.email, u.email_verified, u.status, u.created_at, u.last_login, u.metadata,
           COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') as roles
    FROM _npati_auth_users u
    LEFT JOIN _npati_auth_user_roles r ON r.user_id = u.id
    ${whereClause}
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const res = await pool.query<{
    id: string;
    email: string;
    email_verified: boolean;
    status: ProjectAuthUserStatus;
    created_at: string;
    last_login: string | null;
    metadata: Record<string, unknown>;
    roles: string[];
  }>(sql, params);

  const users: ProjectAuthUser[] = res.rows.map((row) => ({
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    status: row.status,
    roles: row.roles,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    metadata: row.metadata,
  }));

  return { users, total };
}

export async function setAuthUserStatus(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
  status: ProjectAuthUserStatus,
): Promise<void> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "migrator");

  const res = await pool.query("UPDATE _npati_auth_users SET status = $1 WHERE id = $2", [status, userId]);
  if (!res.rowCount) {
    throw new DataStudioError(404, "admin_user", "User not found", false, "USER_NOT_FOUND");
  }

  if (status === "suspended") {
    // Revoke all refresh tokens
    await pool.query("UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1", [userId]);
  }
}

export async function setAuthUserRoles(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
  roles: string[],
): Promise<void> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "migrator");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userCheck = await client.query("SELECT id FROM _npati_auth_users WHERE id = $1", [userId]);
    if (!userCheck.rowCount) {
      throw new DataStudioError(404, "admin_user", "User not found", false, "USER_NOT_FOUND");
    }

    await client.query("DELETE FROM _npati_auth_user_roles WHERE user_id = $1", [userId]);
    for (const role of roles) {
      // A role is stored as a value, not used as an SQL name, so "user" (a reserved SQL word) is a valid role.
      if (typeof role !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(role)) throw new DataStudioError(400, "admin_user", "Invalid role name", false, "INVALID_ROLE");
      await client.query(
        "INSERT INTO _npati_auth_roles(name) VALUES($1) ON CONFLICT DO NOTHING",
        [role],
      );
      await client.query(
        "INSERT INTO _npati_auth_user_roles(user_id, role) VALUES($1, $2)",
        [userId, role],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
