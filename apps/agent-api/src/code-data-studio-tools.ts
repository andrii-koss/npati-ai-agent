import type { AgentDataStudioService } from "./data-studio/agent-data-service";
import { DataStudioError } from "./data-studio/identifier";
import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { PolicyEngine } from "./code-policy-engine";
import type { ProjectAccessPolicy } from "@npati/shared";

/**
 * Manifest v15 Data Studio additions. Each one is a thin adapter over the existing `AgentDataStudioService` (the
 * same service the chat agent's `project.data.*` tools call):
 *  - every call is evaluated by the coding PolicyEngine first, then checked against the attached backend;
 *  - the service only ever addresses the `dev` environment (production goes through the approval-gated promote);
 *  - writes need a human approval recorded by the runtime (`input.approved`) unless they are a dry run;
 *  - arguments are structured; no SQL reaches the service.
 */
export interface CodeDataStudioToolOptions {
  projectData?: Partial<Pick<AgentDataStudioService, "assertBackend" | "listRows" | "createRow" | "listMigrations" | "inspectAuth" | "configureAuth" | "listSiteUsers" | "setSiteUserRoles">>;
  dataPolicy?: Pick<PolicyEngine, "evaluate">;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const RULES = new Set(["public", "authenticated", "owner", "role"]);
const ACTIONS = new Set(["select", "insert", "update", "delete", "all"]);
const ROLES = new Set(["admin", "member", "user"]);

function invalid(input: CodeToolExecutionContext, message: string): never {
  throw new CodeToolError("invalid_arguments", message, 400, "validate_arguments", true, input.tool.name);
}

function identifier(input: CodeToolExecutionContext, value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(input, `${label} must be a lower-case identifier`);
  return value;
}

export function codeDataStudioExecutors(options: CodeDataStudioToolOptions): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const run = async <T>(input: CodeToolExecutionContext, write: boolean, body: (service: NonNullable<CodeDataStudioToolOptions["projectData"]>) => Promise<T>): Promise<T> => {
    const service = options.projectData;
    if (!service?.assertBackend || !options.dataPolicy) throw new CodeToolError("tool_not_configured", "Project Data Studio is not configured", 503, "configure", false, input.tool.name);
    const decision = await options.dataPolicy.evaluate({
      ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, runId: input.runId,
      agentId: input.agentId, tool: input.tool.name, toolVersion: input.tool.version, toolCallId: input.toolCallId,
    });
    if (decision.decision !== "allow") throw new CodeToolError("policy_denied", "Project database operation was refused by coding policy", decision.status ?? 403, "policy", false, input.tool.name, { decision: decision.decision, code: decision.code });
    if (write && input.args.dryRun !== true && !input.approved) throw new CodeToolError("approval_required", "Confirm this database operation before execution", 403, "approval", false, input.tool.name);
    try {
      if (!input.args.expectedBackendId) invalid(input, "expectedBackendId is required: pass the id of this project's database");
      await service.assertBackend(input.ctx, input.companyId, input.projectId, String(input.args.expectedBackendId));
      return await body(service);
    } catch (error) {
      // A policy naming a column the table lacks is the caller's to correct, so it gets the reason rather than a generic failure.
      const missingColumn = input.tool.name === "code.data.policies.apply" ? /column "([^"]+)" does not exist/.exec(error instanceof Error ? error.message : "")?.[1] : undefined;
      if (missingColumn) invalid(input, `The table has no column "${missingColumn}". Add it with code.data.schema.apply, or use a rule that does not need it; no policy was applied.`);
      if (error instanceof DataStudioError) throw new CodeToolError("project_data_error", error.message, error.status, error.step, error.retryable, input.tool.name, { dataCode: error.code });
      throw error;
    }
  };
  const unavailable = (input: CodeToolExecutionContext): never => {
    throw new CodeToolError("tool_not_configured", "This project database operation is unavailable", 503, "configure", false, input.tool.name);
  };

  return {
    "code.data.query.read": async (input) => {
      const collection = identifier(input, input.args.collection, "collection");
      const rawFilters = input.args.filters === undefined ? [] : input.args.filters;
      if (!Array.isArray(rawFilters) || rawFilters.length > 10) invalid(input, "filters must be an array of at most 10 conditions");
      const filters = rawFilters.map((filter) => {
        const entry = filter as { field?: unknown; operator?: unknown; value?: unknown };
        if (!entry || typeof entry !== "object" || !OPERATORS.has(String(entry.operator))) invalid(input, "each filter needs field, operator (eq/ne/gt/gte/lt/lte) and value");
        if (entry.value !== null && !["string", "number", "boolean"].includes(typeof entry.value)) invalid(input, "filter values must be scalars");
        return { field: identifier(input, entry.field, "filter field"), operator: entry.operator as "eq", value: entry.value };
      });
      const sortArg = input.args.sort as { field?: unknown; direction?: unknown } | undefined;
      const sort = sortArg ? { field: identifier(input, sortArg.field, "sort field"), direction: sortArg.direction === "desc" ? "desc" as const : "asc" as const } : undefined;
      const search = typeof input.args.search === "string" ? input.args.search.slice(0, 200) : undefined;
      return run(input, false, async (service) => {
        if (!service.listRows) return unavailable(input);
        return service.listRows(input.ctx, input.companyId, input.projectId, collection, {
          filters, ...(sort ? { sort } : {}), ...(search ? { search } : {}),
          limit: typeof input.args.limit === "number" ? input.args.limit : 50,
          ...(typeof input.args.offset === "number" ? { offset: input.args.offset } : {}),
        });
      });
    },

    "code.data.users.list": async (input) => {
      const email = typeof input.args.email === "string" ? input.args.email.trim().toLowerCase() : undefined;
      return run(input, false, async (service) => {
        if (!service.listSiteUsers) return unavailable(input);
        return service.listSiteUsers(input.ctx, input.companyId, input.projectId, email);
      });
    },

    "code.data.users.roles.set": async (input) => {
      const email = typeof input.args.email === "string" ? input.args.email.trim().toLowerCase() : "";
      const roles = input.args.roles;
      if (!email.includes("@")) invalid(input, "email must be the address the person signed up with");
      if (!Array.isArray(roles) || !roles.length || roles.length > 8 || roles.some((role) => typeof role !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) invalid(input, "roles must be 1-8 lower-case role names such as admin or user");
      return run(input, true, async (service) => {
        if (!service.setSiteUserRoles) return unavailable(input);
        return service.setSiteUserRoles(input.ctx, input.companyId, input.projectId, { email, roles: [...new Set(roles as string[])], dryRun: input.args.dryRun === true });
      });
    },

    "code.data.rows.seed": async (input) => {
      const collection = identifier(input, input.args.collection, "collection");
      const rows = input.args.rows;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) invalid(input, "rows must contain 1-50 objects");
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) invalid(input, "every row must be an object");
        const keys = Object.keys(row as Record<string, unknown>);
        if (keys.length > 100 || keys.includes("id") || keys.some((key) => !IDENTIFIER.test(key))) invalid(input, "row fields must be lower-case identifiers (no id, at most 100)");
      }
      return run(input, true, async (service) => {
        if (input.args.dryRun === true) return { dryRun: true, collection, rowCount: rows.length, environment: "dev" };
        if (!service.createRow) return unavailable(input);
        const inserted: unknown[] = [];
        for (const row of rows as Record<string, unknown>[]) inserted.push((await service.createRow(input.ctx, input.companyId, input.projectId, collection, row)).row);
        return { applied: true, collection, rowCount: inserted.length, environment: "dev", rows: inserted };
      });
    },

    "code.data.migrations.list": (input) => run(input, false, async (service) => {
      if (!service.listMigrations) return unavailable(input);
      return service.listMigrations(input.ctx, input.companyId, input.projectId);
    }),

    "code.data.policies.inspect": (input) => run(input, false, async (service) => {
      if (!service.inspectAuth) return unavailable(input);
      return service.inspectAuth(input.ctx, input.companyId, input.projectId);
    }),

    "code.data.policies.apply": async (input) => {
      const raw = input.args.policies;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) invalid(input, "policies must contain 1-50 entries");
      const policies: ProjectAccessPolicy[] = raw.map((entry) => {
        const policy = entry as { collection?: unknown; rule?: unknown; ownerField?: unknown; role?: unknown; actions?: unknown };
        if (!policy || typeof policy !== "object" || !RULES.has(String(policy.rule))) invalid(input, "rule must be public, authenticated, owner or role");
        if (!Array.isArray(policy.actions) || !policy.actions.length || policy.actions.some((action) => !ACTIONS.has(String(action)))) invalid(input, "actions must list select/insert/update/delete/all");
        if (policy.rule === "owner" && policy.ownerField === undefined) invalid(input, "an owner policy needs ownerField");
        if (policy.rule === "role" && !ROLES.has(String(policy.role))) invalid(input, "a role policy needs role admin, member or user");
        return {
          collection: identifier(input, policy.collection, "collection"),
          rule: policy.rule as ProjectAccessPolicy["rule"],
          ...(policy.ownerField !== undefined ? { ownerField: identifier(input, policy.ownerField, "ownerField") } : {}),
          ...(policy.rule === "role" ? { role: String(policy.role) } : {}),
          actions: policy.actions as ProjectAccessPolicy["actions"],
        };
      });
      return run(input, true, async (service) => {
        if (input.args.dryRun === true) return { dryRun: true, environment: "dev", policies, compiledBy: "data_studio_rls_compiler" };
        if (!service.configureAuth) return unavailable(input);
        // The runtime only reaches this line with a recorded human approval for these exact arguments.
        return service.configureAuth(input.ctx, input.companyId, input.projectId, { policies }, { approved: input.approved === true });
      });
    },
  };
}
