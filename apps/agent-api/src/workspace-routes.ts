import type { BusinessInput, BusinessToCompanyInput, CompanyAgentInput, CompanyInput, GoalInput, MemoryInput, OnboardingScenario, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthenticationError, type AuthProvider } from "./auth";
import type { AIPreferencesStore } from "./ai-preferences";

function errorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Workspace request failed";
  const status = /changed by another request/i.test(message) ? 409 : /required|invalid|must|circular|cannot be/i.test(message) ? 400 : 500;
  return reply.code(status).send({ error: { code: status === 409 ? "REVISION_CONFLICT" : status === 400 ? "INVALID_INPUT" : "WORKSPACE_ERROR", message } });
}

async function authorize(auth: AuthProvider, request: FastifyRequest, permission: 'workspace:read' | 'business:manage') {
  const context = await auth.authenticate(request);
  if (!context.permissions.includes(permission)) throw new WorkspaceAccessError(`Missing permission: ${permission}`);
  return context;
}

function revision(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error("A valid expectedRevision is required");
  return Number(value);
}

function idempotencyKey(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error('A valid Idempotency-Key header is required');
  return value;
}

export function registerWorkspaceRoutes(app: FastifyInstance, store: WorkspaceStore, auth: AuthProvider, aiPreferences?: AIPreferencesStore, lifecycle?: {
  beforeDeleteBusiness?(context: Awaited<ReturnType<AuthProvider["authenticate"]>>, businessId: string): Promise<void>;
  beforeDeleteCompany?(context: Awaited<ReturnType<AuthProvider["authenticate"]>>, companyId: string): Promise<void>;
  beforeDeleteConversation?(context: Awaited<ReturnType<AuthProvider["authenticate"]>>, businessId: string, conversationId: string): Promise<void>;
}) {
  async function validateAgentModels(context: Awaited<ReturnType<AuthProvider["authenticate"]>>, input: Partial<CompanyAgentInput>) {
    if (!aiPreferences) return;
    const requested = [input.modelId, input.fallbackModelId].filter((id): id is string => Boolean(id));
    if (!requested.length) return;
    const allowed = new Set((await aiPreferences.get(context)).addedModels.map((model) => model.id));
    const invalid = requested.find((id) => !allowed.has(id));
    if (invalid) throw new Error("Agent model must come from the configured NPATI My Models library");
  }
  app.get("/workspace/context", async (request, reply) => {
    try { return await store.overview(await authorize(auth, request, 'workspace:read')); } catch (error) { return errorReply(reply, error); }
  });
  app.put<{ Body: { businessId: string } }>("/workspace/current-business", async (request, reply) => {
    try { return await store.setCurrentBusiness(await authorize(auth, request, 'business:manage'), request.body.businessId); } catch (error) { return errorReply(reply, error); }
  });

  app.post<{ Body: { scenario?: OnboardingScenario } }>("/business-onboarding", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      const session = await store.startOnboarding(context, request.body?.scenario ?? "starting", { forceNew: true });
      return reply.code(201).send(session);
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/businesses", async (request, reply) => {
    try { return await store.listBusinesses(await authorize(auth, request, 'workspace:read')); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Body: BusinessInput }>("/businesses", async (request, reply) => {
    try { return reply.code(201).send(await store.createBusiness(await authorize(auth, request, 'business:manage'), request.body)); } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { businessId: string } }>("/businesses/:businessId", async (request, reply) => {
    try { return await store.getBusiness(await authorize(auth, request, 'workspace:read'), request.params.businessId); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { businessId: string }; Body: Partial<BusinessInput> }>("/businesses/:businessId", async (request, reply) => {
    try { return await store.updateBusiness(await authorize(auth, request, 'business:manage'), request.params.businessId, request.body); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { businessId: string } }>("/businesses/:businessId", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      await store.getBusiness(context, request.params.businessId);
      await lifecycle?.beforeDeleteBusiness?.(context, request.params.businessId);
      await store.deleteBusiness(context, request.params.businessId);
      return reply.code(204).send();
    } catch (error) { return errorReply(reply, error); }
  });

  app.post<{ Params: { businessId: string }; Body: BusinessToCompanyInput }>("/businesses/:businessId/convert-to-company", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      const key = idempotencyKey(request);
      const result = await store.convertBusinessToCompany(context, request.params.businessId, request.body ?? {}, key);
      return reply.code(result.created ? 201 : 200).send(result.company);
    } catch (error) { return errorReply(reply, error); }
  });


  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/companies", async (request, reply) => {
    try {
      const limit = Number(request.query.limit ?? 20);
      const page = await store.listCompanies(await authorize(auth, request, "workspace:read"), limit, request.query.cursor);
      return { companies: page.items, pagination: { limit, nextCursor: page.nextCursor } };
    } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Body: CompanyInput }>("/companies", async (request, reply) => {
    try {
      return reply.code(201).send(await store.createCompany(await authorize(auth, request, "business:manage"), request.body, idempotencyKey(request)));
    } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { companyId: string } }>("/companies/:companyId", async (request, reply) => {
    try { return await store.getCompany(await authorize(auth, request, "workspace:read"), request.params.companyId); }
    catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { companyId: string }; Body: Partial<CompanyInput> & { expectedRevision: number } }>("/companies/:companyId", async (request, reply) => {
    try {
      const { expectedRevision, ...input } = request.body;
      return await store.updateCompany(await authorize(auth, request, "business:manage"), request.params.companyId, input, revision(expectedRevision));
    } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { companyId: string } }>("/companies/:companyId", async (request, reply) => {
    try {
      const context=await authorize(auth, request, "business:manage");
      await store.getCompany(context,request.params.companyId);
      await lifecycle?.beforeDeleteCompany?.(context,request.params.companyId);
      await store.deleteCompany(context, request.params.companyId);
      return reply.code(204).send();
    } catch (error) { return errorReply(reply, error); }
  });
  app.put<{ Params: { companyId: string }; Body: { agentId: string | null; expectedRevision: number } }>("/companies/:companyId/main-agent", async (request, reply) => {
    try {
      return await store.setCompanyMainAgent(await authorize(auth, request, "business:manage"), request.params.companyId, request.body.agentId, revision(request.body.expectedRevision));
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { companyId: string }; Querystring: { limit?: string; cursor?: string } }>("/companies/:companyId/agents", async (request, reply) => {
    try {
      const limit = Number(request.query.limit ?? 50);
      const page = await store.listCompanyAgentsPage(await authorize(auth, request, "workspace:read"), request.params.companyId, limit, request.query.cursor);
      return { agents: page.items, pagination: { limit, nextCursor: page.nextCursor } };
    } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { companyId: string }; Body: CompanyAgentInput }>("/companies/:companyId/agents", async (request, reply) => {
    try {
      const context = await authorize(auth, request, "business:manage");
      await validateAgentModels(context, request.body);
      return reply.code(201).send(await store.createCompanyAgent(context, request.params.companyId, request.body, idempotencyKey(request)));
    } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { companyId: string; agentId: string } }>("/companies/:companyId/agents/:agentId", async (request, reply) => {
    try { return await store.getCompanyAgent(await authorize(auth, request, "workspace:read"), request.params.companyId, request.params.agentId); }
    catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { companyId: string; agentId: string }; Body: Partial<CompanyAgentInput> & { expectedRevision: number } }>("/companies/:companyId/agents/:agentId", async (request, reply) => {
    try {
      const { expectedRevision, ...input } = request.body;
      const context = await authorize(auth, request, "business:manage");
      await validateAgentModels(context, input);
      return await store.updateCompanyAgent(context, request.params.companyId, request.params.agentId, input, revision(expectedRevision));
    } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { companyId: string; agentId: string }; Querystring: { expectedRevision?: string } }>("/companies/:companyId/agents/:agentId", async (request, reply) => {
    try {
      await store.deleteCompanyAgent(await authorize(auth, request, "business:manage"), request.params.companyId, request.params.agentId, revision(Number(request.query.expectedRevision)));
      return reply.code(204).send();
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { companyId: string }; Querystring: { agentIds?: string } }>("/companies/:companyId/agent-edges", async (request, reply) => {
    try {
      const agentIds = request.query.agentIds?.split(",").filter(Boolean);
      if (agentIds && agentIds.length > 100) {
        return reply.code(400).send({
          error: {
            code: "AGENT_EDGE_LIMIT_EXCEEDED",
            message: "At most 100 agent IDs may be requested",
          },
        });
      }
      return await store.listCompanyAgentEdges(await authorize(auth, request, "workspace:read"), request.params.companyId, agentIds);
    } catch (error) { return errorReply(reply, error); }
  });
  app.put<{ Params: { companyId: string; agentId: string }; Body: { parentAgentId: string | null } }>("/companies/:companyId/agents/:agentId/parent", async (request, reply) => {
    try {
      return await store.setCompanyAgentParent(await authorize(auth, request, "business:manage"), request.params.companyId, request.params.agentId, request.body.parentAgentId);
    } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { businessId: string } }>("/businesses/:businessId/goals", async (request, reply) => {
    try { return await store.listGoals(await auth.authenticate(request), request.params.businessId); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessId: string }; Body: GoalInput }>("/businesses/:businessId/goals", async (request, reply) => {
    try { return reply.code(201).send(await store.createGoal(await auth.authenticate(request), request.params.businessId, request.body)); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { businessId: string; goalId: string }; Body: Partial<GoalInput> }>("/businesses/:businessId/goals/:goalId", async (request, reply) => {
    try { return await store.updateGoal(await auth.authenticate(request), request.params.businessId, request.params.goalId, request.body); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { businessId: string; goalId: string } }>("/businesses/:businessId/goals/:goalId", async (request, reply) => {
    try { await store.deleteGoal(await auth.authenticate(request), request.params.businessId, request.params.goalId); return reply.code(204).send(); } catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Params: { businessId: string }; Querystring: { search?: string; limit?: string } }>("/businesses/:businessId/memory", async (request, reply) => {
    try { return await store.listMemory(await auth.authenticate(request), request.params.businessId, request.query.search, Number(request.query.limit ?? 100)); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessId: string }; Body: MemoryInput }>("/businesses/:businessId/memory", async (request, reply) => {
    try { return reply.code(201).send(await store.createMemory(await auth.authenticate(request), request.params.businessId, request.body)); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { businessId: string; memoryId: string }; Body: Partial<MemoryInput> }>("/businesses/:businessId/memory/:memoryId", async (request, reply) => {
    try { return await store.updateMemory(await auth.authenticate(request), request.params.businessId, request.params.memoryId, request.body); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { businessId: string; memoryId: string } }>("/businesses/:businessId/memory/:memoryId", async (request, reply) => {
    try { await store.deleteMemory(await auth.authenticate(request), request.params.businessId, request.params.memoryId); return reply.code(204).send(); } catch (error) { return errorReply(reply, error); }
  });

  app.get("/conversations", async (request, reply) => {
    try { return await store.listNeutralConversations(await auth.authenticate(request)); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Body: { title?: string } }>("/conversations", async (request, reply) => {
    try { return reply.code(201).send(await store.createNeutralConversation(await auth.authenticate(request), request.body?.title ?? "New conversation")); } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { conversationId: string } }>("/conversations/:conversationId", async (request, reply) => {
    try { return await store.getNeutralConversation(await auth.authenticate(request), request.params.conversationId); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { conversationId: string }; Body: { title?: string } }>("/conversations/:conversationId", async (request, reply) => {
    try { return await store.updateNeutralConversation(await auth.authenticate(request), request.params.conversationId, request.body.title ?? "New conversation"); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { conversationId: string } }>("/conversations/:conversationId", async (request, reply) => {
    try {
      const context = await auth.authenticate(request);
      await store.getNeutralConversation(context, request.params.conversationId);
      await lifecycle?.beforeDeleteConversation?.(context, "", request.params.conversationId);
      await store.deleteNeutralConversation(context, request.params.conversationId);
      return reply.code(204).send();
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get<{ Params: { businessId: string } }>("/businesses/:businessId/conversations", async (request, reply) => {
    try { return await store.listConversations(await auth.authenticate(request), request.params.businessId); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessId: string }; Body: { title?: string } }>("/businesses/:businessId/conversations", async (request, reply) => {
    try { return reply.code(201).send(await store.createConversation(await auth.authenticate(request), request.params.businessId, request.body.title ?? "New conversation")); } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { businessId: string; conversationId: string } }>("/businesses/:businessId/conversations/:conversationId", async (request, reply) => {
    try { return await store.getConversation(await auth.authenticate(request), request.params.businessId, request.params.conversationId); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { businessId: string; conversationId: string }; Body: { title?: string } }>("/businesses/:businessId/conversations/:conversationId", async (request, reply) => {
    try { return await store.updateConversation(await auth.authenticate(request), request.params.businessId, request.params.conversationId, request.body.title ?? "New conversation"); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { businessId: string; conversationId: string } }>("/businesses/:businessId/conversations/:conversationId", async (request, reply) => {
    try { const context=await auth.authenticate(request); await store.getConversation(context,request.params.businessId,request.params.conversationId); await lifecycle?.beforeDeleteConversation?.(context,request.params.businessId,request.params.conversationId); await store.deleteConversation(context, request.params.businessId, request.params.conversationId); return reply.code(204).send(); } catch (error) { return errorReply(reply, error); }
  });
}
