import type { AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataEnvironmentName } from "./types";
import { OpaqueTokenManager, ProjectPasswordHasher } from "./auth-crypto";
import type { ProjectAuthHost } from "./auth-service-host";

export async function verifyAuthEmail(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  token: string,
): Promise<{ success: boolean; email: string }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "runtime");
  const tokenHash = OpaqueTokenManager.hash(token);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokenRes = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>("SELECT * FROM _npati_auth_verification_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash]);

    if (!tokenRes.rowCount) {
      throw new DataStudioError(400, "verify_email", "Invalid verification token", false, "INVALID_TOKEN");
    }

    const row = tokenRes.rows[0]!;
    if (row.used_at) {
      throw new DataStudioError(400, "verify_email", "Verification token already used", false, "TOKEN_ALREADY_USED");
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new DataStudioError(400, "verify_email", "Verification token has expired", false, "TOKEN_EXPIRED");
    }

    await client.query("UPDATE _npati_auth_verification_tokens SET used_at = now() WHERE id = $1", [row.id]);
    const userRes = await client.query<{ email: string }>(
      "UPDATE _npati_auth_users SET email_verified = true, status = 'active' WHERE id = $1 RETURNING email",
      [row.user_id],
    );

    await client.query("COMMIT");
    return { success: true, email: userRes.rows[0]!.email };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function forgotAuthPassword(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  email: string,
  ip?: string,
  redirectTo?: string,
): Promise<{ success: boolean; message: string }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const resolvedRedirect = await host.resolveAuthRedirect(backend, companyId, projectId, environment, redirectTo);
  const emailNorm = (email ?? "").trim().toLowerCase();

  if (ip) host.rateLimiter.check(`ip:${ip}`);
  host.rateLimiter.check(`email:${emailNorm}`);

  const pool = await host.getPool(backend, environment, "runtime");
  const userRes = await pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM _npati_auth_users WHERE email = $1",
    [emailNorm],
  );

  // Standard no-user-enumeration response
  const genericResponse = {
    success: true,
    message: "If this email is registered, password reset instructions have been sent.",
  };

  if (!userRes.rowCount) {
    await ProjectPasswordHasher.dummyVerify();
    return genericResponse;
  }

  const user = userRes.rows[0]!;
  const resetToken = OpaqueTokenManager.generate();
  const tokenHash = OpaqueTokenManager.hash(resetToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour TTL

  await pool.query(
    "INSERT INTO _npati_auth_reset_tokens(token_hash, user_id, expires_at) VALUES($1, $2, $3)",
    [tokenHash, user.id, expiresAt],
  );

  await host.emailProvider.sendPasswordResetEmail(user.email, resetToken, user.email, { link: host.authLink(resolvedRedirect, resetToken) });
  return genericResponse;
}

export async function resetAuthPassword(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  input: { token: string; newPassword: string },
  ip?: string,
): Promise<{ success: boolean }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);

  if (ip) host.rateLimiter.check(`ip:${ip}`);

  ProjectPasswordHasher.validatePolicy(input.newPassword, settings);
  const tokenHash = OpaqueTokenManager.hash(input.token);

  const pool = await host.getPool(backend, environment, "runtime");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokenRes = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>("SELECT * FROM _npati_auth_reset_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash]);

    if (!tokenRes.rowCount) {
      throw new DataStudioError(400, "reset_password", "Invalid or expired reset token", false, "INVALID_TOKEN");
    }

    const row = tokenRes.rows[0]!;
    if (row.used_at) {
      throw new DataStudioError(400, "reset_password", "Reset token already used", false, "TOKEN_ALREADY_USED");
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new DataStudioError(400, "reset_password", "Reset token has expired", false, "TOKEN_EXPIRED");
    }

    const newHash = await ProjectPasswordHasher.hash(input.newPassword);
    await client.query("UPDATE _npati_auth_users SET password_hash = $1 WHERE id = $2", [newHash, row.user_id]);

    // Consume this token
    await client.query("UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
    // Invalidate all other pending reset tokens for this user
    await client.query(
      "UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [row.user_id],
    );
    // Revoke all existing sessions
    await client.query(
      "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1",
      [row.user_id],
    );

    await client.query("COMMIT");
    return { success: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function changeAuthPassword(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<{ success: boolean }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);
  ProjectPasswordHasher.validatePolicy(input.newPassword, settings);

  const pool = await host.getPool(backend, environment, "runtime");
  const userRes = await pool.query<{ password_hash: string }>(
    "SELECT password_hash FROM _npati_auth_users WHERE id = $1",
    [userId],
  );
  if (!userRes.rowCount) {
    throw new DataStudioError(404, "change_password", "User not found", false, "USER_NOT_FOUND");
  }

  const isValid = await ProjectPasswordHasher.verify(input.currentPassword, userRes.rows[0]!.password_hash);
  if (!isValid) {
    throw new DataStudioError(401, "change_password", "Current password does not match", false, "INVALID_CREDENTIALS");
  }

  const newHash = await ProjectPasswordHasher.hash(input.newPassword);
  await pool.query("UPDATE _npati_auth_users SET password_hash = $1 WHERE id = $2", [newHash, userId]);
  // Invalidate pending reset tokens & sessions
  await pool.query(
    "UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  );
  await pool.query(
    "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1",
    [userId],
  );

  return { success: true };
}
