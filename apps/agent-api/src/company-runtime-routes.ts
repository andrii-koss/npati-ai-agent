import { WorkspaceAccessError, type CompanyRunMode } from "@npati/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthProvider } from "./auth";
import { CompanyDelegationRuntime, CompanyRuntimeError, companyRunTelemetryHeaders } from "./company-runtime";
import type { CompanyRunQueueProducer } from "./company-run-queue";
import {RouteGuardTiers} from "./route-guard-tiers";

async function context(auth: AuthProvider, request: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const value = await auth.authenticate(request);
  if (!value.permissions.includes(permission)) throw new WorkspaceAccessError(`Missing permission: ${permission}`);
  return value;
}
function key(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error("A valid Idempotency-Key header is required");
  return value;
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CompanyRuntimeError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Company runtime request failed";
  const status = /required|invalid|must/i.test(message) ? 400 : 500;
  return reply.code(status).send({ error: { code: status === 400 ? "INVALID_INPUT" : "COMPANY_RUNTIME_ERROR", message } });
}
function runtimeStatus(code?: string) {
  if (code === "SECURITY_GUARDRAIL_BLOCKED") return 400;
  if (code === "APPROVAL_REQUIRED") return 202;
  if (code === "TOOL_FORBIDDEN" || code === "INVALID_APPROVAL_TOKEN") return 403;
  if (code === "APPROVAL_ALREADY_USED" || code === "APPROVAL_INVALID" || code === "APPROVAL_EXPIRED") return 409;
  if (code === "CIRCULAR_DELEGATION" || code === "TOOL_LOOP_DETECTED") return 400;
  if (code === "RUN_TIMEOUT") return 504;
  if (code === "RUN_FAILED") return 502;
  if (code === "model_unavailable" || code === "model_routing_failed") return 503;
  if (code === "OMNIROUTE_ORCHESTRATION_UNAVAILABLE" || code === "OMNIROUTE_COMBOS_UNAVAILABLE") return 503;
  return 200;
}
function applyTelemetry(reply: FastifyReply, result: Awaited<ReturnType<CompanyDelegationRuntime["get"]>>) {
  for (const [name, value] of Object.entries(companyRunTelemetryHeaders(result))) reply.header(name, value);
}

export function registerCompanyRuntimeRoutes(app: FastifyInstance, runtime: CompanyDelegationRuntime, auth: AuthProvider, queue?: CompanyRunQueueProducer,routeGuard=new RouteGuardTiers()) {
  function guardRoute(ctx:{workspaceId:string;userId:string;permissions:string[];apiKeyId?:string},reply:FastifyReply){
    const tier=ctx.permissions.includes("*")||ctx.permissions.includes("owner")?"enterprise":ctx.permissions.includes("business:manage")?"pro":"free";
    const status=routeGuard.checkRateLimit(`${ctx.workspaceId}:${ctx.apiKeyId??ctx.userId}`,tier);
    for(const [name,value] of Object.entries(RouteGuardTiers.formatHeaders(status)))reply.header(name,value);
    if(!status.allowed){reply.code(429).send({error:{code:"ROUTE_RATE_LIMITED",message:"Too many Company runtime requests. Retry after the indicated interval."}});return false;}
    return true;
  }
  app.post<{ Params: { companyId: string }; Body: { task: string; mode?: CompanyRunMode } }>("/companies/:companyId/runs", {
    schema: { body: { type: "object", additionalProperties: false, required: ["task"], properties: {
      task: { type: "string", minLength: 1, maxLength: 20_000 },
      mode: { type: "string", enum: ["auto", "single", "pipeline", "fusion"] },
    } } },
  }, async (request, reply) => {
    try {
      const ctx = await context(auth, request, "business:manage");
      if(!guardRoute(ctx,reply))return;
      if (queue) {
        const created = await runtime.create(ctx, request.params.companyId, request.body, key(request));
        if (created.created || created.run.status === "queued") {
          await runtime.recordBackgroundEvent(ctx, request.params.companyId, created.run.id, {
            eventKey: "queued", eventType: "queued", runStatus: "queued", attemptCount: created.run.attemptCount,
            message: "Background run queued for worker processing",
          });
          await queue.enqueue({ context: ctx, companyId: request.params.companyId, runId: created.run.id });
        }
        return reply.code(202).send(await runtime.get(ctx, request.params.companyId, created.run.id));
      }
      const result = await runtime.execute(ctx, request.params.companyId, request.body, key(request));
      applyTelemetry(reply, result);
      return reply.code(runtimeStatus(result.run.errorCode)).send(result);
    } catch (error) { return failure(reply, error); }
  });
  app.get<{ Params: { companyId: string }; Querystring: { limit?: string } }>("/companies/:companyId/runs", async (request, reply) => {
    try {
      const ctx = await context(auth, request, "workspace:read");
      if(!guardRoute(ctx,reply))return;
      const limit = Number(request.query.limit) || 30;
      const runs = await runtime.list(ctx, request.params.companyId, limit);
      return { runs };
    } catch (error) { return failure(reply, error); }
  });
  app.get<{ Params: { companyId: string; runId: string } }>("/companies/:companyId/runs/:runId", async (request, reply) => {
    try {
      const ctx = await context(auth, request, "workspace:read");
      if(!guardRoute(ctx,reply))return;
      return await runtime.get(ctx, request.params.companyId, request.params.runId);
    } catch (error) { return failure(reply, error); }
  });
  app.get<{ Params: { companyId: string; runId: string } }>("/companies/:companyId/runs/:runId/report", async (request, reply) => {
    try {
      const ctx = await context(auth, request, "workspace:read");
      if(!guardRoute(ctx,reply))return;
      const details = await runtime.get(ctx, request.params.companyId, request.params.runId);
      if (!details.completionReport) return reply.code(202).send({ report: null, status: details.run.status });
      return { report: details.completionReport };
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { companyId: string; runId: string } }>("/companies/:companyId/runs/:runId/cancel", async (request, reply) => {
    try {
      const ctx = await context(auth, request, "business:manage");
      if(!guardRoute(ctx,reply))return;
      const result = await runtime.cancel(ctx, request.params.companyId, request.params.runId);
      if (queue) await queue.cancel({ context: ctx, companyId: request.params.companyId, runId: request.params.runId });
      return result;
    } catch (error) { return failure(reply, error); }
  });
  app.post<{Params:{companyId:string;runId:string};Body:{approvalId:string}}>(
    "/companies/:companyId/runs/:runId/resume",
    {schema:{body:{type:"object",additionalProperties:false,required:["approvalId"],properties:{
      approvalId:{type:"string",format:"uuid"},
    }}}},
    async(request,reply)=>{
      try{
        const ctx=await context(auth,request,"business:manage");
        if(!guardRoute(ctx,reply))return;
        const result=await runtime.process(ctx,request.params.companyId,request.params.runId,{approvalId:request.body.approvalId});
        applyTelemetry(reply,result);
        return reply.code(runtimeStatus(result.run.errorCode)).send(result);
      }catch(error){return failure(reply,error);}
    },
  );
}
