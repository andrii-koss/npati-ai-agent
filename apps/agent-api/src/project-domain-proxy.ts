import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ProjectPreviewService } from "./project-preview-service";
import type { ProjectWorkspace } from "./project-workspace";

interface CachedDomainTarget {
  workspaceId: string;
  userId: string;
  companyId: string;
  projectId: string;
  port?: number;
  pathPrefix: string;
  stripPath: boolean;
  expiresAt: number;
}

function extractHostname(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return trimmed.replace(/:\d+$/, "");
}

export function createCustomDomainHandler(
  previewService: ProjectPreviewService,
  workspace: ProjectWorkspace,
  workspaceStore?: WorkspaceStore,
) {
  const domainCache = new Map<string, CachedDomainTarget>();

  return async function handleCustomDomainRequest(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (!workspaceStore?.findProjectByDomain) return false;
    const rawUrl = request.url ?? "/";
    if (rawUrl.startsWith("/api/") || rawUrl.startsWith("/companies/") || rawUrl.startsWith("/health")) {
      return false;
    }

    const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
      ? request.headers["x-forwarded-host"].split(",")[0]
      : undefined;
    const hostname = extractHostname(forwardedHost || request.headers.host);
    if (!hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return false;
    }

    const platformHosts = [
      extractHostname(process.env.NPATI_AGENT_PUBLIC_DOMAIN),
      extractHostname(process.env.NPATI_WEB_ORIGIN),
      extractHostname(process.env.NPATI_BACKEND_URL),
    ].filter(Boolean);
    if (platformHosts.includes(hostname)) {
      return false;
    }

    const now = Date.now();
    let target = domainCache.get(hostname);
    if (!target || target.expiresAt < now) {
      const found = await workspaceStore.findProjectByDomain(hostname).catch(() => null);
      if (!found) {
        domainCache.delete(hostname);
        return false;
      }
      const ownerCtx: AuthContext = {
        workspaceId: found.workspaceId,
        userId: found.userId,
        permissions: ["workspace:read", "business:manage"],
      };
      let pathPrefix = "/";
      let stripPath = false;
      let port = found.previewPort ?? undefined;
      try {
        const depFile = await workspace.readFile(ownerCtx, found.companyId, found.projectId, "deployment.json");
        const parsed = JSON.parse(depFile.content) as { path?: string; stripPath?: boolean; port?: number };
        if (typeof parsed.path === "string" && parsed.path.trim()) {
          pathPrefix = parsed.path.trim().startsWith("/") ? parsed.path.trim() : "/" + parsed.path.trim();
        }
        if (typeof parsed.stripPath === "boolean") stripPath = parsed.stripPath;
        if (typeof parsed.port === "number" && parsed.port > 0) port = parsed.port;
      } catch {
        // deployment.json is optional
      }
      target = {
        workspaceId: found.workspaceId,
        userId: found.userId,
        companyId: found.companyId,
        projectId: found.projectId,
        port,
        pathPrefix,
        stripPath,
        expiresAt: now + 5_000,
      };
      domainCache.set(hostname, target);
    }

    const [pathname = "/", queryString = ""] = rawUrl.split("?");
    if (target.pathPrefix !== "/" && !pathname.startsWith(target.pathPrefix)) {
      return false;
    }

    let forwardedPath = pathname;
    if (target.stripPath && target.pathPrefix !== "/" && forwardedPath.startsWith(target.pathPrefix)) {
      forwardedPath = forwardedPath.slice(target.pathPrefix.length) || "/";
    }
    const subpath = forwardedPath.replace(/^\/+/, "");

    const ownerCtx: AuthContext = {
      workspaceId: target.workspaceId,
      userId: target.userId,
      permissions: ["workspace:read", "business:manage"],
    };

    let session = previewService.getSession(target.projectId);
    if (!session || session.status !== "running") {
      try {
        await previewService.startPreview(ownerCtx, target.companyId, target.projectId, {
          port: target.port,
        });
        session = previewService.getSession(target.projectId);
      } catch {
        // handleProxy will render the appropriate status page if start fails
      }
    }

    const sandboxId = session?.sandboxId || (await previewService.assertProjectAccess(ownerCtx, target.companyId, target.projectId).then(p => p.sandboxId).catch(() => undefined)) || "default";
    const { token } = previewService.generateToken({
      workspaceId: target.workspaceId,
      userId: target.userId,
      companyId: target.companyId,
      projectId: target.projectId,
      sandboxId,
    });

    const proxyReq = Object.create(request) as FastifyRequest<{
      Params: { companyId: string; projectId: string; "*": string };
      Querystring: { token?: string };
    }>;
    proxyReq.params = {
      companyId: target.companyId,
      projectId: target.projectId,
      "*": subpath,
    };
    proxyReq.query = { ...(request.query as Record<string, unknown>), token };
    Object.defineProperty(proxyReq, "url", {
      value: "/" + subpath + (queryString ? "?" + queryString : ""),
      configurable: true,
    });

    await previewService.handleProxy(proxyReq, reply);
    return true;
  };
}

