import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { OmniRouteError, type OmniRouteMarketplace } from "@npati/omniroute-adapter";
import type { AuthProvider } from "./auth";
import type { AIPreferencesStore } from "./ai-preferences";
import type { CodePreferences, CodePreferencesStore } from "./code-preferences";

class CodeAccessError extends Error {
  readonly code = "CODE_ACCESS_DENIED";
  readonly statusCode = 403;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof OmniRouteError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message.replace(/OmniRoute/gi, "NPATI AI") } });
  }
  if (error instanceof CodeAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message.replace(/OmniRoute/gi, "NPATI AI") : "Unexpected coding agent error";
  const explicitStatus = Number((error as { status?: unknown; statusCode?: unknown } | undefined)?.status ?? (error as { statusCode?: unknown } | undefined)?.statusCode);
  const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus
    : (/must|required|not found/i.test(message) ? 400 : 500);
  const code = typeof (error as { code?: unknown } | undefined)?.code === "string"
    ? (error as { code: string }).code
    : "CODE_AGENT_ERROR";
  return reply.code(status).send({ error: { code, message } });
}

async function authorize(auth: AuthProvider, request: FastifyRequest, permission: "workspace:read" | "workspace:write" | "chat:use"): Promise<AuthContext> {
  const scope = await auth.authenticate(request);
  if (!scope.permissions.includes(permission) && !scope.permissions.includes("*") && !scope.permissions.includes("admin:all")) {
    throw new CodeAccessError(`Missing permission: ${permission}`);
  }
  return scope;
}

export function registerCodeAgentRoutes(
  app: FastifyInstance,
  marketplace: OmniRouteMarketplace,
  codePreferences: CodePreferencesStore,
  aiPreferences: AIPreferencesStore,
  auth: AuthProvider,
) {
  app.get("/code/preferences", async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:read");
      return await codePreferences.get(scope);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Body: Partial<CodePreferences> }>("/code/preferences", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          activeAgentId: { type: "string", minLength: 1, maxLength: 200 },
          activeAgentName: { type: "string", minLength: 1, maxLength: 200 },
          activeModelId: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
          enabledAgentIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const scope = await authorize(auth, request, "workspace:write");
      return await codePreferences.set(scope, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { search?: string; tab?: string; refresh?: string; offset?: string; limit?: string } }>(
    "/code/agents",
    async (request, reply) => {
      try {
        const scope = await authorize(auth, request, "workspace:read");
        const prefs = await codePreferences.get(scope);
        const storedAI = await aiPreferences.get(scope);
        const tab = request.query.tab;
        const marketplaceData = await marketplace.marketplace(
          {
            scope: "code",
            tab: tab === "connected" || tab === "recommended" || tab === "free" || tab === "local" || tab === "all" ? tab : undefined,
            search: request.query.search,
            offset: Number.parseInt(request.query.offset ?? "0", 10) || 0,
            limit: Number.parseInt(request.query.limit ?? "100", 10) || 100,
            refresh: request.query.refresh === "true",
          },
          storedAI.addedModels.map((m) => m.id),
        );
        return {
          preferences: prefs,
          builtIn: {
            id: "npati",
            name: "Npati Code",
            builtIn: true,
            connected: true,
            category: "built-in",
            description: "Built-in NPATI coding agent with full workspace, repository, sandbox, browser, website builder and tool access.",
            capabilities: ["code", "projects", "repositories", "sessions", "terminal", "sandbox", "preview", "browser", "datastudio"],
          },
          ...marketplaceData,
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { agentId: string }; Body: { enabled?: boolean } }>(
    "/code/agents/:agentId/toggle",
    async (request, reply) => {
      try {
        const scope = await authorize(auth, request, "workspace:write");
        return await codePreferences.toggleAgent(scope, request.params.agentId, request.body?.enabled !== false);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { agentId: string }; Body: { name?: string; modelId?: string | null } }>(
    "/code/agents/:agentId/active",
    async (request, reply) => {
      try {
        const scope = await authorize(auth, request, "workspace:write");
        return await codePreferences.setActiveAgent(scope, request.params.agentId, request.body?.name, request.body?.modelId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
