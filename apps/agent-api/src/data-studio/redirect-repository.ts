import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { isAuthRedirectAllowed, normalizeAuthRedirectUrl } from "@npati/shared";
import { DataStudioError } from "./identifier";
import type { DataEnvironmentName } from "./types";
import type { ProjectService } from "../project-service";

export const MAX_AUTH_REDIRECTS = 20;

/**
 * Per-project Project Auth redirect URLs (D6).
 *
 * Mobile apps come back from email verification / password reset through their own deep link
 * scheme, so every redirect target must be registered for the project before the Project API
 * will build a link with it. Entries are validated and normalized; query strings and fragments
 * are rejected because the one-time token is appended by the server.
 */
export class ProjectRedirectRepository {
  private readonly memory = new Map<string, string[]>();

  constructor(
    private readonly projects: Pick<ProjectService, "get">,
    private readonly pool?: Pool,
  ) {}

  private async authorize(ctx: AuthContext, companyId: string, projectId: string) {
    await this.projects.get(ctx, companyId, projectId);
  }

  async list(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName): Promise<string[]> {
    await this.authorize(ctx, companyId, projectId);
    if (!this.pool) return [...(this.memory.get(`${projectId}:${environment}`) ?? [])];
    const result = await this.pool.query<{ url: string }>(
      `SELECT url FROM project_redirect_urls
       WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3 AND environment=$4
       ORDER BY url`,
      [ctx.workspaceId, companyId, projectId, environment],
    );
    return result.rows.map((row) => row.url);
  }

  async replace(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    urls: string[],
  ): Promise<string[]> {
    await this.authorize(ctx, companyId, projectId);
    if (!Array.isArray(urls)) throw new DataStudioError(400, "redirect", "redirectUrls must be an array", false, "INVALID_REDIRECT_URL");
    if (urls.length > MAX_AUTH_REDIRECTS) {
      throw new DataStudioError(400, "redirect", `At most ${MAX_AUTH_REDIRECTS} redirect URLs are allowed`, false, "TOO_MANY_REDIRECT_URLS");
    }
    const normalized: string[] = [];
    for (const candidate of urls) {
      const url = normalizeAuthRedirectUrl(String(candidate ?? ""));
      if (!url) {
        throw new DataStudioError(400, "redirect", `Invalid redirect URL: ${String(candidate).slice(0, 120)}`, false, "INVALID_REDIRECT_URL");
      }
      if (!normalized.includes(url)) normalized.push(url);
    }
    normalized.sort();
    const key = `${projectId}:${environment}`;
    if (!this.pool) {
      this.memory.set(key, normalized);
      return normalized;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM project_redirect_urls WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3 AND environment=$4`,
        [ctx.workspaceId, companyId, projectId, environment],
      );
      for (const url of normalized) {
        await client.query(
          `INSERT INTO project_redirect_urls (id, workspace_id, company_id, project_id, environment, url)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, environment, url) DO NOTHING`,
          [randomUUID(), ctx.workspaceId, companyId, projectId, environment, url],
        );
      }
      await client.query("COMMIT");
      return normalized;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Rejects redirect targets that are not registered for this project and environment. */
  async assertAllowed(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    redirectTo: string,
  ): Promise<string> {
    const allowed = await this.list(ctx, companyId, projectId, environment);
    if (!isAuthRedirectAllowed(redirectTo, allowed)) {
      throw new DataStudioError(400, "redirect", "Redirect URL is not registered for this project", false, "REDIRECT_NOT_ALLOWED");
    }
    return normalizeAuthRedirectUrl(redirectTo)!;
  }
}
