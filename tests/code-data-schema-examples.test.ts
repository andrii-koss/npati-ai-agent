import { expect, it } from "vitest";
import schemas from "../apps/agent-api/src/code-tool-schemas.json";
import { SCHEMA_OPERATION_EXAMPLES } from "../apps/agent-api/src/code-data-tools";
import { validateArguments } from "../apps/agent-api/src/code-tool-runtime-guards";

type Tool = { name: string; version: number; inputSchema: { properties: { operation: { oneOf: Record<string, unknown>[] } } } };
const list = (Array.isArray(schemas) ? schemas : (schemas as { tools?: unknown[] }).tools ?? Object.values(schemas)) as Tool[];
const apply = list.filter((tool) => tool.name === "code.data.schema.apply").sort((a, b) => b.version - a.version)[0]!;

it("quotes only schema-valid operations when refusing schema.apply arguments", () => {
  const [plain, relation] = apply.inputSchema.properties.operation.oneOf;
  expect(SCHEMA_OPERATION_EXAMPLES.map(([kind]) => kind)).toEqual(["create_collection", "add_field", "create_index", "create_relation"]);
  for (const [kind, example] of SCHEMA_OPERATION_EXAMPLES) {
    expect(example.kind).toBe(kind);
    expect(() => validateArguments(kind === "create_relation" ? relation! : plain!, example, apply.name), kind).not.toThrow();
  }
});
