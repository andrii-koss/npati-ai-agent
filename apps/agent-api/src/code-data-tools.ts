import type { AgentDataStudioService } from "./data-studio/agent-data-service";
import type { SchemaOperation } from "./data-studio/data-provider";
import { DataStudioError } from "./data-studio/identifier";
import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { PolicyEngine } from "./code-policy-engine";
import type { RowTransferInput } from "./data-studio/row-transfer";

export interface CodeDataToolOptions {
  projectData?: Pick<AgentDataStudioService, "inspectSchema" | "applySchema"> & Partial<Pick<AgentDataStudioService, "assertBackend" | "transferRows" | "attachToProject" | "listRows">>;
  dataPolicy?: Pick<PolicyEngine, "evaluate">;
}

export function codeDataExecutors(options: CodeDataToolOptions) {
  async function extended(input: CodeToolExecutionContext) {
    const service = options.projectData;
    if (!service || !options.dataPolicy) throw new CodeToolError("tool_not_configured", "Project Data Studio is not configured", 503, "configure", false, input.tool.name);
    const decision = await options.dataPolicy.evaluate({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, runId: input.runId, agentId: input.agentId, tool: input.tool.name, toolVersion: input.tool.version, toolCallId: input.toolCallId });
    if (decision.decision !== "allow") throw new CodeToolError("policy_denied", "Project database operation was refused by coding policy", 403, "policy", false, input.tool.name);
    const args = input.args;
    if (input.tool.name !== "code.data.rows.list" && args.dryRun !== true && !input.approved) throw new CodeToolError("approval_required", "Confirm this database operation before execution", 403, "approval", false, input.tool.name);
    try {
      if (!service.assertBackend) throw new CodeToolError("tool_not_configured", "Project database tools are unavailable", 503, "configure", false, input.tool.name);
      await service.assertBackend(input.ctx, input.companyId, input.projectId, args.expectedBackendId as string);
      switch (input.tool.name) {
        case "code.data.schema.modify": {
          const operation = args.operation as SchemaOperation;
          if (!["rename_collection", "alter_field", "drop_field", "drop_collection"].includes(operation.kind)) throw new CodeToolError("invalid_arguments", "Unsupported schema modification", 400, "schema", false, input.tool.name);
          return await service.applySchema(input.ctx, input.companyId, input.projectId, operation, { expectedBackendId: args.expectedBackendId as string, expectedFingerprint: args.expectedFingerprint as string, dryRunOnly: args.dryRun === true, approved: input.approved === true, runId: input.runId, agentId: input.agentId });
        }
        case "code.data.rows.list":
          if (service.listRows) return await service.listRows(input.ctx, input.companyId, input.projectId, args.collection as string, { limit: args.limit as number | undefined, offset: args.offset as number | undefined });
          break;
        case "code.data.rows.transfer":
          if (service.transferRows) return await service.transferRows(input.ctx, input.companyId, input.projectId, args.expectedBackendId as string, { source: args.source as string, target: args.target as string, ids: args.ids as string[], fields: args.fields as RowTransferInput["fields"], mode: args.mode as RowTransferInput["mode"], expectedFingerprint: args.expectedFingerprint as string, dryRun: args.dryRun === true });
          break;
        case "code.data.backend.attach":
          if (service.attachToProject) return await service.attachToProject(input.ctx, input.companyId, input.projectId, { expectedBackendId: args.expectedBackendId as string, targetProjectId: args.targetProjectId as string, expectedTargetBackendId: args.expectedTargetBackendId as string | null, dryRun: args.dryRun === true });
      }
      throw new CodeToolError("tool_not_configured", "Project database operation is unavailable", 503, "configure", false, input.tool.name);
    } catch (error) {
      if (error instanceof DataStudioError) throw new CodeToolError("project_data_error", error.message, error.status, error.step, error.retryable, input.tool.name, { dataCode: error.code });
      throw error;
    }
  }
  async function execute(input: CodeToolExecutionContext, apply: boolean) {
    if (!options.projectData || !options.dataPolicy) throw new CodeToolError("tool_not_configured", "Project Data Studio is not configured", 503, "configure", false, input.tool.name);
    const decision = await options.dataPolicy.evaluate({
      ctx: input.ctx, companyId: input.companyId, projectId: input.projectId,
      sessionId: input.sessionId, runId: input.runId, agentId: input.agentId,
      tool: input.tool.name, toolVersion: input.tool.version, toolCallId: input.toolCallId,
    });
    if (decision.decision !== "allow") throw new CodeToolError("policy_denied", "Project database operation was refused by coding policy", decision.status ?? 403, "policy", false, input.tool.name, { decision: decision.decision, code: decision.code });
    try {
      if (!apply) return await options.projectData.inspectSchema(input.ctx, input.companyId, input.projectId);
      const operation = input.args.operation as SchemaOperation;
      if (!operation || !["create_collection", "add_field", "create_index"].includes(operation.kind)) throw new CodeToolError("invalid_arguments", "Only create_collection, add_field and create_index are available; destructive changes and raw SQL are not supported", 400, "schema", false, input.tool.name);
      const fingerprint = input.args.expectedFingerprint;
      if (typeof fingerprint !== "string" || !fingerprint.trim()) throw new CodeToolError("invalid_arguments", "Inspect the schema and provide its current fingerprint before applying a change", 400, "schema", false, input.tool.name);
      const result = await options.projectData.applySchema(input.ctx, input.companyId, input.projectId, operation, {
        expectedFingerprint: fingerprint, dryRunOnly: input.args.dryRun === true,
        runId: input.runId, agentId: input.agentId,
        // Model arguments and filesystem approvals never grant database approval.
        approved: false,
      });
      if ("approvalRequired" in result && result.approvalRequired) throw new CodeToolError("approval_required", "This schema operation requires review in Data Studio", 409, "approval", false, input.tool.name);
      return result;
    } catch (error) {
      if (error instanceof DataStudioError) throw new CodeToolError("project_data_error", error.message, error.status, error.step, error.retryable, input.tool.name, { dataCode: error.code });
      throw error;
    }
  }
  return {
    "code.data.schema.modify": extended,
    "code.data.rows.list": extended,
    "code.data.rows.transfer": extended,
    "code.data.backend.attach": extended,
    "code.data.schema.inspect": (input: CodeToolExecutionContext) => execute(input, false),
    "code.data.schema.apply": (input: CodeToolExecutionContext) => execute(input, true),
  };
}
