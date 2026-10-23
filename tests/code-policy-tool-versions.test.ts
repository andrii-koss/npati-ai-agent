import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import { publishedSchemaForPolicy } from "../apps/agent-api/src/code-tool-registry";
const ctx = { workspaceId: "versions", userId: "owner", permissions: ["admin:all"] };
describe("published schema version policy wiring", () => {
  const engine = () => new PolicyEngine({ flags: { assertEnabled: async () => true }, capabilities: { get: (id, scope) => {
    const schema = publishedSchemaForPolicy(id, scope?.toolVersion);
    return schema ? { id: schema.name, version: schema.version, status: schema.status } : undefined;
  } } });
  it.each([1, 2])("resolves published v%s and still enforces session mode", async toolVersion => {
    const result = await engine().evaluate({ ctx, companyId: "company", tool: "code.data.schema.apply", toolVersion, sessionMode: "plan" });
    expect(publishedSchemaForPolicy("code.data.schema.apply", toolVersion)?.version).toBe(toolVersion);
    expect(result.decision).toBe("deny"); expect(result.phase).not.toBe("capability");
  });
  it("rejects unpublished versions through the existing gate", async () => {
    expect(await engine().evaluate({ ctx, companyId: "company", tool: "code.data.schema.apply", toolVersion: 999, sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "unknown_tool_version", phase: "capability" });
    expect(publishedSchemaForPolicy("unpublished", 2)).toBeUndefined();
  });
});
