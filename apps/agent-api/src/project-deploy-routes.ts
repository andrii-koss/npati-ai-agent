import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import {
  ProjectDeployService,
  DeployApprovalRequiredError,
} from "./project-deploy-service";
import type { DeployTargetConfig } from "./deploy-provider";
import { DeployError } from "./deploy-provider";

interface ProjectParams {
  companyId: string;
  projectId: string;
}

interface DeploymentParams extends ProjectParams {
  deploymentId: string;
}

export function registerProjectDeployRoutes(
  app: FastifyInstance,
  deployService: ProjectDeployService,
  auth: AuthProvider
) {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> => {
    try {
      return await auth.authenticate(request);
    } catch (error) {
      const known = error instanceof AuthenticationError ? error : new AuthenticationError("Unauthorized", 401, "UNAUTHORIZED");
      reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      return null;
    }
  };

  const handleError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof DeployApprovalRequiredError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
        },
        preflight: error.preflight,
        approvalPayload: error.approvalPayload,
      });
    }
    if (error instanceof DeployError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message } });
  };

  // POST /companies/:companyId/projects/:projectId/deploy/preflight
  app.post<{ Params: ProjectParams; Body: { target?: DeployTargetConfig; branch?: string } }>(
    "/companies/:companyId/projects/:projectId/deploy/preflight",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const preflight = await deployService.preflight(
          ctx,
          request.params.companyId,
          request.params.projectId,
          request.body || {}
        );
        return reply.code(200).send({ preflight });
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // POST /companies/:companyId/projects/:projectId/deploy
  app.post<{
    Params: ProjectParams;
    Body: {
      target?: DeployTargetConfig;
      credentialId?: string;
      branch?: string;
      approved?: boolean;
      token?: string;
      apiKey?: string;
    };
  }>("/companies/:companyId/projects/:projectId/deploy", async (request, reply) => {
    const ctx = await authenticate(request, reply);
    if (!ctx) return;
    if (!ctx.permissions.includes("workspace:write")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
    }

    // Explicitly reject raw tokens in request body
    if (request.body?.token !== undefined || request.body?.apiKey !== undefined) {
      return reply.code(400).send({
        error: {
          code: "raw_credential_forbidden",
          message: "Raw credentials are not allowed. Provide a Company vault credentialId.",
        },
      });
    }

    try {
      const result = await deployService.deploy(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.body || {}
      );
      return reply.code(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // GET /companies/:companyId/projects/:projectId/deployments
  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>(
    "/companies/:companyId/projects/:projectId/deployments",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
        const items = await deployService.listDeployments(
          ctx,
          request.params.companyId,
          request.params.projectId,
          limit
        );
        return reply.code(200).send({ items });
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // GET /companies/:companyId/projects/:projectId/deployments/:deploymentId
  app.get<{ Params: DeploymentParams }>(
    "/companies/:companyId/projects/:projectId/deployments/:deploymentId",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const deployment = await deployService.getDeployment(
          ctx,
          request.params.companyId,
          request.params.projectId,
          request.params.deploymentId
        );
        return reply.code(200).send({ deployment });
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );
}
