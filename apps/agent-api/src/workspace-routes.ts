import type { BusinessInput, GoalInput, MemoryInput, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError } from "@npati/workspace";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";

function errorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Workspace request failed";
  const status = /required|invalid|must/i.test(message) ? 400 : 500;
  return reply.code(status).send({ error: { code: status === 400 ? "INVALID_INPUT" : "WORKSPACE_ERROR", message } });
}

export function registerWorkspaceRoutes(app: FastifyInstance, store: WorkspaceStore, auth: AuthProvider) {
  app.get("/workspace/context", async (request, reply) => {
    try { return await store.overview(await auth.authenticate(request)); } catch (error) { return errorReply(reply, error); }
  });
  app.put<{ Body: { businessId: string } }>("/workspace/current-business", async (request, reply) => {
    try { return await store.setCurrentBusiness(await auth.authenticate(request), request.body.businessId); } catch (error) { return errorReply(reply, error); }
  });

  app.get("/businesses", async (request, reply) => {
    try { return await store.listBusinesses(await auth.authenticate(request)); } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Body: BusinessInput }>("/businesses", async (request, reply) => {
    try { return reply.code(201).send(await store.createBusiness(await auth.authenticate(request), request.body)); } catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { businessId: string } }>("/businesses/:businessId", async (request, reply) => {
    try { return await store.getBusiness(await auth.authenticate(request), request.params.businessId); } catch (error) { return errorReply(reply, error); }
  });
  app.patch<{ Params: { businessId: string }; Body: Partial<BusinessInput> }>("/businesses/:businessId", async (request, reply) => {
    try { return await store.updateBusiness(await auth.authenticate(request), request.params.businessId, request.body); } catch (error) { return errorReply(reply, error); }
  });
  app.delete<{ Params: { businessId: string } }>("/businesses/:businessId", async (request, reply) => {
    try { await store.deleteBusiness(await auth.authenticate(request), request.params.businessId); return reply.code(204).send(); } catch (error) { return errorReply(reply, error); }
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
    try { await store.deleteConversation(await auth.authenticate(request), request.params.businessId, request.params.conversationId); return reply.code(204).send(); } catch (error) { return errorReply(reply, error); }
  });
}
