import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CompanyAutomationsRepository } from "./automations-repository";
import { computeNextCronDate, isValidCronExpression, type AutomationScheduler } from "./automation-scheduler";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!c.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: status === 404 ? "NOT_FOUND" : "AUTOMATION_ERROR",
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

export function registerCompanyAutomationsRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: CompanyAutomationsRepository;
    scheduler?: AutomationScheduler;
    triggerRun?: (autoId: string) => Promise<{ result: string }>;
  }
) {
  const { auth, store, repo, triggerRun } = deps;

  // List automations for a company
  app.get<{ Params: { companyId: string } }>(
    "/companies/:companyId/automations",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const automations = await repo.list(c, r.params.companyId);
        return { automations };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Get single automation
  app.get<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        const automation = await repo.get(c, r.params.companyId, r.params.automationId);
        return { automation };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Create new automation
  app.post<{
    Params: { companyId: string };
    Body: {
      name: string;
      description?: string;
      prompt: string;
      cronExpression: string;
      timezone?: string;
      agentId?: string;
    };
  }>(
    "/companies/:companyId/automations",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "prompt", "cronExpression"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 2000 },
            prompt: { type: "string", minLength: 1, maxLength: 20000 },
            cronExpression: { type: "string", minLength: 5, maxLength: 100 },
            timezone: { type: "string", maxLength: 100 },
            agentId: { type: "string" },
          },
        },
      },
    },
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);

        if (!isValidCronExpression(r.body.cronExpression)) {
          throw new Error(`Invalid standard cron expression: "${r.body.cronExpression}". Expected 5 fields (e.g. "0 9 * * *").`);
        }

        const nextRunAt = computeNextCronDate(r.body.cronExpression).toISOString();
        const created = await repo.create(c, r.params.companyId, {
          ...r.body,
          nextRunAt,
        });

        return reply.code(201).send(created);
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Update automation (edit / pause / resume)
  app.patch<{
    Params: { companyId: string; automationId: string };
    Body: {
      name?: string;
      description?: string;
      prompt?: string;
      cronExpression?: string;
      timezone?: string;
      agentId?: string | null;
      status?: "active" | "paused";
    };
  }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        let nextRunAt: string | undefined;

        if (r.body.cronExpression) {
          if (!isValidCronExpression(r.body.cronExpression)) {
            throw new Error(`Invalid standard cron expression: "${r.body.cronExpression}".`);
          }
          nextRunAt = computeNextCronDate(r.body.cronExpression).toISOString();
        }

        const updated = await repo.update(c, r.params.companyId, r.params.automationId, {
          ...r.body,
          nextRunAt,
        });

        return reply.send(updated);
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Delete automation
  app.delete<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await repo.delete(c, r.params.companyId, r.params.automationId);
        return reply.code(204).send();
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Trigger immediate execution (Run Now)
  app.post<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId/run",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        const auto = await repo.get(c, r.params.companyId, r.params.automationId);

        if (triggerRun) {
          const runRes = await triggerRun(auto.id);
          return reply.code(200).send({ status: "completed", result: runRes.result });
        }

        return reply.code(202).send({ message: "Automation triggered", automationId: auto.id });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Get run history for an automation
  app.get<{ Params: { companyId: string; automationId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/automations/:automationId/runs",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        const runs = await repo.listRuns(c, r.params.companyId, r.params.automationId, Number(r.query.limit ?? 20));
        return { runs };
      } catch (e) {
        return err(reply, e);
      }
    }
  );
}
