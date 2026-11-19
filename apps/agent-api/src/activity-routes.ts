import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEVELOPMENT_PROCESS_SETTINGS_KEY, sanitizeExecutionTrace, type DevelopmentProcess } from "@npati/shared";
import { WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { DevelopmentPorts } from "./chat-development-service";
import { requiredPermissionForAction, type CodeRbac } from "./code-rbac";
import { CODE_SNAPSHOT_ACTIONS, readRunReplay, readRunSnapshot } from "./code-snapshot-routes";
import { CODE_PROJECT_TRUST_ACTIONS, presentProjectTrust, type CodeProjectTrustRouteDeps } from "./code-project-trust-routes";
import { activityCodeRun, readCodeRunMonitor } from "./code-monitor-routes";
import { bulkDeleteSchema, type BulkDeleteBody, type BulkRecord } from "./bulk-records";

const deletedActivitySetting = "activity.deleted.v1";
const pageSize = 20;
const activeStatuses = new Set(["running", "planning", "queued", "cancelling", "preparing", "stopping"]);
const recordKey = (ownerId: string, id: string) => JSON.stringify([ownerId, id]);
const deletedKeys = (value: unknown) => new Set<string>(Array.isArray(value) ? value.filter(item => typeof item === "string") : []);
const statusMatches = (status: string, filter?: string) =>
  !filter || filter === "all" || (filter === "running" ? activeStatuses.has(status) : status === filter);

type ActivityQuery = {
  company?: string;
  runId?: string;
  status?: string;
  search?: string;
  cursor?: string;
  select?: string;
};

function parseCursor(value: string) {
  try {
    const [time, id] = JSON.parse(Buffer.from(value, "base64url").toString()) as [unknown, unknown];
    if (typeof time === "number" && Number.isFinite(time) && typeof id === "string") return { time, id };
  } catch { /* Invalid tokens are handled below. */ }
  throw Object.assign(new Error("Invalid activity cursor"), { status: 400 });
}

export function registerActivityRoutes(app: FastifyInstance, deps: Pick<DevelopmentPorts, "store" | "projects" | "terminalEvents"> & {
  auth: AuthProvider;
  codeRbac: Pick<CodeRbac, "authorize">;
  projectTrust: Pick<CodeProjectTrustRouteDeps["trust"], "get">;
}) {
  async function authorize(request: FastifyRequest) {
    const context = await deps.auth.authenticate(request);
    if (!context.permissions.includes("workspace:read")) throw new WorkspaceAccessError("Missing permission: workspace:read");
    return context;
  }

  function fail(reply: FastifyReply, error: unknown) {
    const status = (error as { status?: number; httpStatus?: number }).status ??
      (error as { httpStatus?: number }).httpStatus ?? 500;
    return reply.code(status).send({ error: { message: status >= 500 ? "Activity request failed" : (error as Error).message } });
  }

  async function readRecords(context: AuthContext, companyId?: string) {
    const [catalog, processes] = await Promise.all([
      deps.store.readActivityCatalog(context, companyId),
      deps.store.getUserSetting(context, DEVELOPMENT_PROCESS_SETTINGS_KEY),
    ]);
    if (companyId && !catalog.companies.some(company => company.id === companyId)) {
      throw new WorkspaceAccessError("Company is not available");
    }
    const companyIds = new Set(catalog.companies.map(company => company.id));
    const projects = new Set(catalog.projects.map(project => recordKey(project.companyId, project.id)));
    const codeRuns = catalog.codeRuns.map(activityCodeRun);
    const knownCodeRuns = new Set(codeRuns.map(run => recordKey(run.companyId, run.id)));
    const settings = Array.isArray(processes?.value) ? processes.value as DevelopmentProcess[] : [];
    const setupRuns = settings.flatMap(process => {
      const { companyId: ownerId, projectId } = process;
      const id = process.runId ?? process.id;
      if (!companyIds.has(ownerId) || companyId && ownerId !== companyId ||
        knownCodeRuns.has(recordKey(ownerId, id)) || projectId && !projects.has(recordKey(ownerId, projectId))) return [];
      return [{
        id, companyId: ownerId, projectId, requestedMode: "coding_setup", status: process.status,
        task: "Preparation · " + sanitizeExecutionTrace(process.name), createdAt: process.createdAt,
        completedAt: ["completed", "failed", "cancelled", "interrupted"].includes(process.status) ? process.updatedAt : undefined,
      }];
    });
    return { companies: catalog.companies, runs: [...catalog.agentRuns, ...codeRuns, ...setupRuns] };
  }

  async function detail(context: AuthContext, run: { id: string; companyId: string; requestedMode: string }) {
    const { id, companyId } = run;
    const snapshotRead = async () => {
      await deps.codeRbac.authorize(context, companyId, {
        action: CODE_SNAPSHOT_ACTIONS.snapshotRead, permission: requiredPermissionForAction(CODE_SNAPSHOT_ACTIONS.snapshotRead) ?? "",
      });
      const snapshot = await readRunSnapshot(deps.store, companyId, id);
      const projectId = "snapshot" in snapshot ? snapshot.snapshot.projectId : undefined;
      let trust = null;
      if (projectId) {
        try {
          await deps.codeRbac.authorize(context, companyId, {
            action: CODE_PROJECT_TRUST_ACTIONS.read, permission: requiredPermissionForAction(CODE_PROJECT_TRUST_ACTIONS.read) ?? "",
          });
          trust = presentProjectTrust(await deps.projectTrust.get(context, companyId, projectId));
        } catch { /* The snapshot is still available to readers without trust access. */ }
      }
      return { snapshot, trust };
    };
    const replayRead = async () => {
      await deps.codeRbac.authorize(context, companyId, {
        action: CODE_SNAPSHOT_ACTIONS.replayRead, permission: requiredPermissionForAction(CODE_SNAPSHOT_ACTIONS.replayRead) ?? "",
      });
      return readRunReplay(deps.store, companyId, id);
    };
    const coding = run.requestedMode.startsWith("coding");
    const [trace, snapshot, replay] = await Promise.allSettled([
      coding ? readCodeRunMonitor(deps, context, companyId, id) : deps.store.getCompanyAgentRun(context, companyId, id),
      snapshotRead(), replayRead(),
    ]);
    const value = trace.status === "fulfilled" ? trace.value : null;
    return {
      runId: id,
      agent: value && "toolAudit" in value ? value : null,
      code: value && "events" in value ? value : null,
      snapshot: {
        snapshot: snapshot.status === "fulfilled" ? snapshot.value.snapshot : null,
        trust: snapshot.status === "fulfilled" ? snapshot.value.trust : null,
        replay: replay.status === "fulfilled" ? replay.value : null,
      },
    };
  }

  app.get<{ Querystring: ActivityQuery }>("/activity/page", {
    schema: { querystring: { type: "object", properties: {
      company: { type: "string", maxLength: 200 }, runId: { type: "string", maxLength: 200 },
      status: { type: "string", enum: ["all", "running", "completed", "failed"] },
      search: { type: "string", maxLength: 1000 }, cursor: { type: "string", maxLength: 500 },
      select: { type: "string", enum: ["1"] },
    } } },
  }, async (request, reply) => {
    try {
      const context = await authorize(request);
      const { company, runId, status, search, cursor, select } = request.query;
      const [catalog, settings] = await Promise.all([
        readRecords(context, company), deps.store.getUserSetting(context, deletedActivitySetting),
      ]);
      const deleted = deletedKeys(settings?.value);
      const runs = catalog.runs.filter(run => !deleted.has(recordKey(run.companyId, run.id)));
      const query = search?.trim().toLowerCase();
      const matching = runs.filter(run => statusMatches(run.status, status) && (!query ||
        [run.task, run.id, "executionMode" in run ? run.executionMode ?? run.requestedMode : run.requestedMode]
          .some(value => value.toLowerCase().includes(query))));
      reply.header("Cache-Control", "private, no-store");
      if (select) return { records: matching.map(run => ({ id: run.id, ownerId: run.companyId })) };
      const ordered = matching.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
      const after = cursor ? parseCursor(cursor) : null;
      const remaining = after ? ordered.filter(run => {
        const time = Date.parse(run.createdAt);
        return time < after.time || time === after.time && run.id.localeCompare(after.id) > 0;
      }) : ordered;
      const items = remaining.slice(0, pageSize);
      const last = items.at(-1);
      const nextCursor = last && remaining.length > pageSize
        ? Buffer.from(JSON.stringify([Date.parse(last.createdAt), last.id])).toString("base64url")
        : null;
      const selected = cursor ? undefined : (runId ? runs.find(run => run.id === runId) : undefined) ?? items[0];
      const counts = { total: runs.length, completed: 0, running: 0, failed: 0 };
      for (const run of runs) {
        if (run.status === "completed") counts.completed++;
        else if (run.status === "failed") counts.failed++;
        else if (activeStatuses.has(run.status)) counts.running++;
      }
      return {
        companies: catalog.companies, items, matchingTotal: matching.length, nextCursor, counts,
        selected: selected ?? null, detail: selected ? await detail(context, selected) : null,
      };
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: { companyId: string; runId: string } }>("/activity/:companyId/runs/:runId", async (request, reply) => {
    try {
      const context = await authorize(request);
      const { companyId, runId } = request.params;
      const [catalog, settings] = await Promise.all([
        readRecords(context, companyId), deps.store.getUserSetting(context, deletedActivitySetting),
      ]);
      const run = catalog.runs.find(run => run.id === runId);
      if (!run || deletedKeys(settings?.value).has(recordKey(companyId, runId))) {
        return reply.code(404).send({ error: { message: "Activity record not found" } });
      }
      return reply.header("Cache-Control", "private, no-store").send(await detail(context, run));
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Body: BulkDeleteBody }>("/activity/bulk-delete", { schema: bulkDeleteSchema }, async (request, reply) => {
    try {
      const context = await authorize(request);
      if (!context.permissions.some(permission => permission === "workspace:write" || permission === "business:manage")) {
        throw new WorkspaceAccessError("Missing permission to delete Activity entries");
      }
      const { runs } = await readRecords(context);
      const allowed = new Set(runs.map(run => recordKey(run.companyId, run.id)));
      const requested = new Map(request.body.records.map(record => [recordKey(record.ownerId, record.id), record]));
      const failed: BulkRecord[] = [];
      for (const [key, record] of requested) {
        if (allowed.has(key)) continue;
        failed.push(record);
        requested.delete(key);
      }
      // Activity is a user's history view. Run data can still be referenced by projects and conversations.
      for (let attempt = 0; attempt < 5; attempt++) {
        const setting = await deps.store.getUserSetting(context, deletedActivitySetting);
        const deleted = deletedKeys(setting?.value);
        const additions = [...requested.keys()].filter(key => !deleted.has(key));
        if (!additions.length) return { deleted: 0, failed };
        additions.forEach(key => deleted.add(key));
        if (await deps.store.setUserSetting(context, deletedActivitySetting, [...deleted], setting?.revision ?? 0)) {
          return { deleted: additions.length, failed };
        }
      }
      return reply.code(409).send({ error: { message: "Activity changed during deletion" } });
    } catch (error) { return fail(reply, error); }
  });
}
