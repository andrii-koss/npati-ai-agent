import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type {
  ProjectAuthSession,
  ProjectAuthUser,
  ProjectAuthUserStatus,
} from "@npati/shared";
import { DataStudioError } from "./identifier";
import type { DataEnvironmentName } from "./types";
import {
  OpaqueTokenManager,
  ProjectKeyManager,
  ProjectPasswordHasher,
} from "./auth-crypto";
import type { ProjectAuthHost } from "./auth-service-host";

export async function registerAuthUser(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  input: { email: string; password: string; metadata?: Record<string, unknown>; redirectTo?: string },
  ip?: string,
): Promise<{ user: ProjectAuthUser; session: ProjectAuthSession | null; message?: string }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);
  const redirectTo = await host.resolveAuthRedirect(backend, companyId, projectId, environment, input.redirectTo);

  if (!settings.allowRegistration) {
    throw new DataStudioError(403, "auth_register", "User registration is disabled for this project", false, "REGISTRATION_DISABLED");
  }

  const emailNorm = (input.email ?? "").trim().toLowerCase();
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    throw new DataStudioError(400, "auth_register", "Invalid email address format", false, "INVALID_EMAIL");
  }

  if (ip) host.rateLimiter.check(`ip:${ip}`);
  host.rateLimiter.check(`email:${emailNorm}`);

  ProjectPasswordHasher.validatePolicy(input.password, settings);
  const bundle = await host.ensureInitialized(ctx, backend, environment);
  const passwordHash = await ProjectPasswordHasher.hash(input.password);

  const pool = await host.getPool(backend, environment, "runtime");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>("SELECT id FROM _npati_auth_users WHERE email = $1", [emailNorm]);
    if (existing.rowCount) {
      throw new DataStudioError(409, "auth_register", "A user with this email already exists", false, "EMAIL_ALREADY_EXISTS");
    }

    const initialStatus: ProjectAuthUserStatus = settings.requireEmailVerification ? "pending" : "active";
    const userRes = await client.query<{
      id: string;
      email: string;
      email_verified: boolean;
      status: ProjectAuthUserStatus;
      created_at: string;
      last_login: string | null;
      metadata: Record<string, unknown>;
    }>(
      `INSERT INTO _npati_auth_users(email, password_hash, email_verified, status, metadata)
       VALUES($1, $2, $3, $4, $5)
       RETURNING id, email, email_verified, status, created_at, last_login, metadata`,
      [emailNorm, passwordHash, !settings.requireEmailVerification, initialStatus, JSON.stringify(input.metadata ?? {})],
    );

    const userId = userRes.rows[0]!.id;
    await client.query(
      "INSERT INTO _npati_auth_user_roles(user_id, role) VALUES($1, 'user') ON CONFLICT DO NOTHING",
      [userId],
    );

    const user: ProjectAuthUser = {
      id: userId,
      email: userRes.rows[0]!.email,
      emailVerified: userRes.rows[0]!.email_verified,
      status: userRes.rows[0]!.status,
      roles: ["user"],
      createdAt: userRes.rows[0]!.created_at,
      lastLogin: userRes.rows[0]!.last_login,
      metadata: userRes.rows[0]!.metadata,
    };

    if (settings.requireEmailVerification) {
      const verifyToken = OpaqueTokenManager.generate();
      const verifyHash = OpaqueTokenManager.hash(verifyToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await client.query(
        "INSERT INTO _npati_auth_verification_tokens(token_hash, user_id, expires_at) VALUES($1, $2, $3)",
        [verifyHash, userId, expiresAt],
      );
      await client.query("COMMIT");

      // Send email (throws EMAIL_SERVICE_UNCONFIGURED if unconfigured)
      await host.emailProvider.sendVerificationEmail(emailNorm, verifyToken, emailNorm, { link: host.authLink(redirectTo, verifyToken) });

      return {
        user,
        session: null,
        message: "Registration successful. Please verify your email before logging in.",
      };
    }

    // If active immediately, issue session
    const familyId = randomUUID();
    const refreshToken = OpaqueTokenManager.generate();
    const refreshHash = OpaqueTokenManager.hash(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

    await client.query(
      "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
      [refreshHash, familyId, userId, refreshExpiresAt],
    );
    await client.query("COMMIT");

    const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
    const accessToken = ProjectKeyManager.signJwt(
      {
        iss: host.expectedIss(backend.id, environment),
        aud: host.expectedAud(backend.id, environment),
        sub: user.id,
        role: "user",
        roles: ["user"],
        exp: Math.floor(Date.now() / 1000) + ttlSec,
      },
      bundle,
    );

    return {
      user,
      session: {
        user,
        accessToken,
        refreshToken,
        expiresIn: ttlSec,
      },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function loginAuthUser(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  input: { email: string; password: string },
  ip?: string,
): Promise<ProjectAuthSession> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);
  const emailNorm = (input.email ?? "").trim().toLowerCase();

  if (ip) host.rateLimiter.check(`ip:${ip}`);
  host.rateLimiter.check(`email:${emailNorm}`);

  const bundle = await host.ensureInitialized(ctx, backend, environment);
  const pool = await host.getPool(backend, environment, "runtime");

  const userRes = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    email_verified: boolean;
    status: ProjectAuthUserStatus;
    created_at: string;
    last_login: string | null;
    metadata: Record<string, unknown>;
  }>("SELECT * FROM _npati_auth_users WHERE email = $1", [emailNorm]);

  if (!userRes.rowCount) {
    await ProjectPasswordHasher.dummyVerify();
    if (ip) host.rateLimiter.recordFailure(`ip:${ip}`);
    host.rateLimiter.recordFailure(`email:${emailNorm}`);
    throw new DataStudioError(401, "auth_login", "Invalid email or password", false, "INVALID_CREDENTIALS");
  }

  const row = userRes.rows[0]!;

  if (row.status === "suspended") {
    await ProjectPasswordHasher.dummyVerify();
    throw new DataStudioError(403, "auth_login", "Your account has been suspended", false, "ACCOUNT_SUSPENDED");
  }

  if (row.status === "pending") {
    throw new DataStudioError(403, "auth_login", "Please verify your email address before logging in", false, "EMAIL_NOT_VERIFIED");
  }

  const isValid = await ProjectPasswordHasher.verify(input.password, row.password_hash);
  if (!isValid) {
    if (ip) host.rateLimiter.recordFailure(`ip:${ip}`);
    host.rateLimiter.recordFailure(`email:${emailNorm}`);
    throw new DataStudioError(401, "auth_login", "Invalid email or password", false, "INVALID_CREDENTIALS");
  }

  // Success: clear rate limits
  if (ip) host.rateLimiter.recordSuccess(`ip:${ip}`);
  host.rateLimiter.recordSuccess(`email:${emailNorm}`);

  const rolesRes = await pool.query<{ role: string }>(
    "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
    [row.id],
  );
  const roles = rolesRes.rows.map((r) => r.role);
  if (!roles.length) roles.push("user");

  await pool.query("UPDATE _npati_auth_users SET last_login = now() WHERE id = $1", [row.id]);

  const familyId = randomUUID();
  const refreshToken = OpaqueTokenManager.generate();
  const refreshHash = OpaqueTokenManager.hash(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

  await pool.query(
    "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
    [refreshHash, familyId, row.id, refreshExpiresAt],
  );

  const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
  const accessToken = ProjectKeyManager.signJwt(
    {
      iss: host.expectedIss(backend.id, environment),
      aud: host.expectedAud(backend.id, environment),
      sub: row.id,
      // The default "user" comes first; a site checks role for admin, so the extra role is the one reported.
      role: roles.find((role) => role !== "user") ?? roles[0]!,
      roles,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    },
    bundle,
  );

  const user: ProjectAuthUser = {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    status: row.status,
    roles,
    createdAt: row.created_at,
    lastLogin: new Date().toISOString(),
    metadata: row.metadata,
  };

  return {
    user,
    accessToken,
    refreshToken,
    expiresIn: ttlSec,
  };
}

export async function refreshAuthSession(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  input: { refreshToken: string },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);
  const bundle = await host.ensureInitialized(ctx, backend, environment);
  const pool = await host.getPool(backend, environment, "runtime");

  const tokenHash = OpaqueTokenManager.hash(input.refreshToken);
  const tokenRes = await pool.query<{
    id: string;
    family_id: string;
    user_id: string;
    expires_at: string;
    rotated_at: string | null;
    revoked_at: string | null;
  }>("SELECT * FROM _npati_auth_refresh_tokens WHERE token_hash = $1", [tokenHash]);

  if (!tokenRes.rowCount) {
    throw new DataStudioError(401, "auth_refresh", "Invalid refresh token", false, "INVALID_REFRESH_TOKEN");
  }

  const token = tokenRes.rows[0]!;

  if (token.revoked_at) {
    throw new DataStudioError(401, "auth_refresh", "Refresh token has been revoked", false, "TOKEN_REVOKED");
  }

  // Reuse detection: token already rotated! Revoke entire family!
  if (token.rotated_at) {
    await pool.query("UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE family_id = $1", [token.family_id]);
    throw new DataStudioError(
      401,
      "auth_refresh",
      "Refresh token reuse detected; all sessions revoked for security. Please log in again.",
      false,
      "TOKEN_REUSE_DETECTED",
    );
  }

  if (new Date(token.expires_at).getTime() < Date.now()) {
    throw new DataStudioError(401, "auth_refresh", "Refresh token has expired", false, "TOKEN_EXPIRED");
  }

  const userRes = await pool.query<{ id: string; status: ProjectAuthUserStatus }>(
    "SELECT id, status FROM _npati_auth_users WHERE id = $1",
    [token.user_id],
  );
  if (!userRes.rowCount || userRes.rows[0]!.status !== "active") {
    throw new DataStudioError(403, "auth_refresh", "User account is no longer active", false, "ACCOUNT_INACTIVE");
  }

  const rolesRes = await pool.query<{ role: string }>(
    "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
    [token.user_id],
  );
  const roles = rolesRes.rows.map((r) => r.role);
  if (!roles.length) roles.push("user");

  // Rotate token
  await pool.query("UPDATE _npati_auth_refresh_tokens SET rotated_at = now() WHERE id = $1", [token.id]);

  const newRefreshToken = OpaqueTokenManager.generate();
  const newHash = OpaqueTokenManager.hash(newRefreshToken);
  const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

  await pool.query(
    "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
    [newHash, token.family_id, token.user_id, refreshExpiresAt],
  );

  const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
  const newAccessToken = ProjectKeyManager.signJwt(
    {
      iss: host.expectedIss(backend.id, environment),
      aud: host.expectedAud(backend.id, environment),
      sub: token.user_id,
      // The default "user" comes first; a site checks role for admin, so the extra role is the one reported.
      role: roles.find((role) => role !== "user") ?? roles[0]!,
      roles,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    },
    bundle,
  );

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: ttlSec,
  };
}

export async function logoutAuthSession(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  input: { refreshToken: string },
): Promise<{ success: boolean }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const pool = await host.getPool(backend, environment, "runtime");

  const tokenHash = OpaqueTokenManager.hash(input.refreshToken);
  const tokenRes = await pool.query<{ family_id: string }>(
    "SELECT family_id FROM _npati_auth_refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );

  if (tokenRes.rowCount) {
    await pool.query(
      "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE family_id = $1",
      [tokenRes.rows[0]!.family_id],
    );
  }

  return { success: true };
}

export async function getAuthUserMe(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  accessToken: string,
): Promise<ProjectAuthUser> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const bundle = await host.ensureInitialized(ctx, backend, environment);

  const claims = ProjectKeyManager.verifyJwt(
    accessToken,
    bundle,
    host.expectedIss(backend.id, environment),
    host.expectedAud(backend.id, environment),
  );

  const pool = await host.getPool(backend, environment, "runtime");
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
    [claims.sub],
  );

  if (!userRes.rowCount) {
    throw new DataStudioError(404, "auth_me", "User not found", false, "USER_NOT_FOUND");
  }

  const row = userRes.rows[0]!;
  const rolesRes = await pool.query<{ role: string }>(
    "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
    [row.id],
  );
  const roles = rolesRes.rows.map((r) => r.role);

  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    status: row.status,
    roles,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    metadata: row.metadata,
  };
}
