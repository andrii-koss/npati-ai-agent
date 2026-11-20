import { createHash } from "node:crypto";
import { WorkspaceAccessError, WorkspaceNotFoundError, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthenticationError, type AuthProvider } from "./auth";
import { ProjectFileError, type ProjectWorkspace } from "./project-workspace";
import { authorizeProjectFileRead } from "./project-file-routes";

interface Params { companyId: string; projectId: string }
interface Query { domain?: string; defaults?: string; metrics?: string; editor?: string }
const snapshotLimit = 24 * 1024 * 1024;
const inactive = new Set(["archived", "soft_deleted", "purging", "deleted"]);
const runtimeExcluded = new Set(["node_modules", "dist", "build", "coverage"]);

class ProductionRouteError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function serviceConfig() {
  const url = process.env.NPATI_PRODUCTION_URL?.replace(/\/$/, "");
  const token = process.env.NPATI_PRODUCTION_TOKEN;
  return url && token && token.length >= 32 ? { url, token } : null;
}

async function productionRequest(ctx: AuthContext, params: Params, method: "GET" | "POST" | "DELETE" | "PATCH", body?: unknown, query = "") {
  const service = serviceConfig();
  if (!service) throw new ProductionRouteError(503, "Project Production is disabled on this installation.");
  const key = createHash("sha256").update(JSON.stringify([ctx.workspaceId, params.companyId, params.projectId])).digest("hex");
  try {
    const response = await fetch(`${service.url}/${key}${query}`, {
      method,
      headers: { Authorization: `Bearer ${service.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new ProductionRouteError(response.status === 401 ? 503 : response.status, response.status === 401 ? "Production control credentials are invalid." : data.error || "Production request failed.");
    return data;
  } catch (error) {
    if (error instanceof ProductionRouteError) throw error;
    throw new ProductionRouteError(503, "Production service is unavailable.");
  }
}

export async function removeProjectProduction(ctx: AuthContext, companyId: string, projectId: string) {
  if (serviceConfig()) await productionRequest(ctx, { companyId, projectId }, "DELETE", undefined, "?purge=1");
}

async function snapshot(workspace: ProjectWorkspace, ctx: AuthContext, { companyId, projectId }: Params) {
  const capture = async () => {
    const tree = await workspace.listFiles(ctx, companyId, projectId);
    const candidates = tree.filter(entry => {
      if (entry.path === "deployment.json") return false;
      const parts = entry.path.split("/");
      return !parts.some(part => part.startsWith(".") || runtimeExcluded.has(part.toLowerCase()));
    });
    if (!candidates.length) throw new ProductionRouteError(400, "Add project files before publishing.");
    if (candidates.length > 4000 || candidates.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > snapshotLimit) {
      throw new ProductionRouteError(413, "Production source is limited to 4,000 files and 24 MiB.");
    }
    let size = 0;
    const files = [];
    for (const entry of candidates) {
      const file = await workspace.readFile(ctx, companyId, projectId, entry.path);
      if (entry.revision && entry.revision !== file.revision) throw new ProductionRouteError(409, "Project files changed. Publish again when edits are saved.");
      const bytes = file.contentBase64 ? Buffer.from(file.contentBase64, "base64") : Buffer.from(file.content);
      size += bytes.length;
      if (size > snapshotLimit) throw new ProductionRouteError(413, "Production source is limited to 24 MiB.");
      files.push({ path: entry.path, data: bytes.toString("base64") });
    }
    return files;
  };
  return workspace.withFileLease ? workspace.withFileLease(ctx, companyId, projectId, capture) : capture();
}

async function readDeploymentFile(workspace: ProjectWorkspace, ctx: AuthContext, { companyId, projectId }: Params) {
  try {
    const { content, revision } = await workspace.readFile(ctx, companyId, projectId, "deployment.json");
    return { content, revision };
  } catch (error) {
    if (error instanceof ProjectFileError && error.status === 404) return null;
    throw error;
  }
}

function parseDeployment(content: string | undefined) {
  try {
    const data = content ? JSON.parse(content) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readDeploymentSettings(workspace: ProjectWorkspace, ctx: AuthContext, params: Params) {
  const data = parseDeployment((await readDeploymentFile(workspace, ctx, params))?.content);
  if (!data) return null;
  const options = String(data.entrypoints ?? "").trim();
  return {
    domain: data.isTechnicalDomain === true || typeof data.domain !== "string" ? "" : data.domain,
    aliasDomain: typeof data.aliasDomain === "string" ? data.aliasDomain : "",
    redirectAlias: data.redirectAlias !== false,
    path: typeof data.path === "string" ? data.path : "/",
    stripPath: data.stripPath === true,
    port: Number.isInteger(Number(data.port)) && Number(data.port) > 0 ? Number(data.port) : 3000,
    entrypoint: options === "web" || options === "websecure" ? options : "auto",
    tls: data.ssl !== "Disabled",
  };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  const status = error instanceof ProductionRouteError || error instanceof ProjectFileError ? error.status
    : error instanceof WorkspaceNotFoundError ? 404
    : error instanceof WorkspaceAccessError ? 403 : 500;
  const message = error instanceof Error && status < 500 ? error.message
    : error instanceof ProductionRouteError ? error.message : "Production request failed.";
  return reply.code(status).send({ error: { message } });
}

export function registerProjectProductionRoutes(app: FastifyInstance, workspace: ProjectWorkspace, auth: AuthProvider, store: WorkspaceStore) {
  const base = "/companies/:companyId/projects/:projectId/production";
  const canManage = (ctx: AuthContext) => ctx.permissions.includes("workspace:write") && !ctx.apiKeyId;
  const owner = async (request: FastifyRequest, companyId: string) => {
    const ctx = await auth.authenticate(request);
    const company = await store.getCompany(ctx, companyId);
    if (ctx.userId !== company.userId || !canManage(ctx)) {
      throw new ProductionRouteError(403, "Only the company owner can access self-hosted project Production.");
    }
    return ctx;
  };
  const authorize = async (request: FastifyRequest<{ Params: Params }>) => {
    const { companyId, projectId } = request.params;
    const ctx = await owner(request, companyId);
    const project = await store.getProject(ctx, companyId, projectId);
    return { ctx, project };
  };

  app.get<{ Params: Pick<Params, "companyId"> }>("/companies/:companyId/projects/production/capabilities", async (request, reply) => {
    try {
      if (!serviceConfig()) return { enabled: false };
      const { companyId } = request.params;
      const ctx = await owner(request, companyId);
      const data = await productionRequest(ctx, { companyId, projectId: "__capabilities__" }, "GET") as {
        tlsEnabled?: boolean; localEnabled?: boolean; defaults?: unknown; automaticDomain?: string;
      };
      return { enabled: true, tlsEnabled: data.tlsEnabled, defaults: data.defaults, automaticDomain: Boolean(data.automaticDomain),
        automaticDomainIsLocal: data.automaticDomain?.endsWith(".localhost") === true };
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: Params; Querystring: Query }>(base, async (request, reply) => {
    try {
      if (request.query.editor === "1") {
        const { companyId, projectId } = request.params;
        const ctx = await authorizeProjectFileRead(auth, request, companyId, projectId);
        const [project, deployment] = await Promise.all([
          store.getProject(ctx, companyId, projectId),
          readDeploymentFile(workspace, ctx, request.params),
        ]);
        reply.header("Cache-Control", "private, no-store");
        const disabled = { deployment, production: { enabled: false } };
        if (!serviceConfig() || !canManage(ctx) || inactive.has(project.status) || project.type === "mobile_app") return disabled;
        const company = await store.getCompany(ctx, companyId);
        if (ctx.userId !== company.userId) return disabled;

        const draft = parseDeployment(deployment?.content);
        const fallback = (project.deploymentUrl || project.previewUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
        const domains = [draft?.isTechnicalDomain !== true && draft?.domain, draft?.aliasDomain,
          fallback.endsWith(".preview.npati.com") ? "" : fallback];
        const query = new URLSearchParams();
        for (const domain of domains) {
          if (typeof domain === "string" && domain && domain.length <= 253) query.append("proofDomain", domain);
        }
        const production = await productionRequest(ctx, request.params, "GET", undefined, query.size ? `?${query}` : "");
        return { deployment, production };
      }
      if (!serviceConfig()) return { enabled: false };
      const { ctx, project } = await authorize(request);
      if (inactive.has(project.status)) return { enabled: false };
      const query = request.query.metrics
        ? `?metrics=${encodeURIComponent(request.query.metrics)}`
        : request.query.domain ? `?domain=${encodeURIComponent(request.query.domain)}` : "";
      const data = await productionRequest(ctx, request.params, "GET", undefined, query);
      const suggested = request.query.defaults === "1" ? await readDeploymentSettings(workspace, ctx, request.params) : undefined;
      return { ...data, suggested };
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: Params; Body: Record<string, unknown> }>(base, { bodyLimit: 73728 }, async (request, reply) => {
    try {
      const { ctx, project } = await authorize(request);
      if (inactive.has(project.status)) throw new ProductionRouteError(409, "Restore this project before publishing it.");
      if (project.type === "mobile_app") throw new ProductionRouteError(400, "Publish a web export of this mobile project as a website.");
      const files = await snapshot(workspace, ctx, request.params);
      const current = await store.getProject(ctx, request.params.companyId, request.params.projectId);
      if (inactive.has(current.status)) throw new ProductionRouteError(409, "Restore this project before publishing it.");
      return reply.code(202).send(await productionRequest(ctx, request.params, "POST", { settings: request.body ?? {}, files }));
    } catch (error) { return sendError(reply, error); }
  });

  app.patch<{ Params: Params; Body: Record<string, unknown> }>(base, { bodyLimit: 16384 }, async (request, reply) => {
    try {
      const { ctx, project } = await authorize(request);
      if (inactive.has(project.status)) throw new ProductionRouteError(409, "Restore this project before managing Production.");
      return await productionRequest(ctx, request.params, "PATCH", request.body);
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: Params }>(base, async (request, reply) => {
    try {
      const { ctx } = await authorize(request);
      return await productionRequest(ctx, request.params, "DELETE");
    } catch (error) { return sendError(reply, error); }
  });
}
