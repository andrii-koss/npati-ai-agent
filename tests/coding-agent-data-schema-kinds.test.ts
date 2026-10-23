import { describe, expect, it, vi } from "vitest";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { codeDataExecutors } from "../apps/agent-api/src/code-data-tools";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";

function invoke(version: number, operation: Record<string, unknown>) {
  const tools = codeDataExecutors({ projectData: { inspectSchema: vi.fn(), applySchema: vi.fn(), assertBackend: vi.fn() } as never, dataPolicy: { evaluate: vi.fn(async () => ({ decision: "allow" })) } as never });
  const input = { ctx: { userId: "owner", workspaceId: "ws", permissions: ["workspace:write"] }, companyId: "company", projectId: "project", runId: "run",
    tool: CODE_TOOL_SCHEMAS.find((tool) => tool.name === "code.data.schema.apply" && tool.version === version)!,
    args: { operation, expectedBackendId: "attached", expectedFingerprint: "current" }, approved: false } as unknown as CodeToolExecutionContext;
  return tools["code.data.schema.apply"](input);
}

describe("code.data.schema.apply unsupported operation", () => {
  it("names the operations of the called version, including create_relation on v2", async () => {
    await expect(invoke(2, { kind: "drop_collection", collection: "orders" })).rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringContaining("create_relation") });
    await expect(invoke(1, { kind: "drop_collection", collection: "orders" })).rejects.toMatchObject({ message: expect.not.stringContaining("create_relation") });
  });
});
