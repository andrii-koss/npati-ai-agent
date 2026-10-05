import { describe, expect, it } from "vitest";
import { CODE_CAPABILITIES, CODE_TOOL_SCHEMA_MIRROR } from "@npati/shared";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";

/**
 * C2 schema parity guard.
 *
 * The Coding Agent tools are described in two places by necessity:
 * - `apps/agent-api/src/code-tool-schemas.json` is what the runtime validates against, what the CI
 *   artifact publishes and what `scripts/verify-code-tool-schemas.mjs` protects;
 * - `packages/shared/src/code-capabilities.ts` is what the Capability Inspector and the model see,
 *   and it cannot import the agent-api package (wrong dependency direction), so it mirrors the schemas.
 *
 * Two descriptions of one tool are exactly how invalid_arguments bugs happen: the model sends the
 * arguments it was told about and the runtime rejects them. This suite fails the build the moment the
 * mirror drifts — a changed field without a version bump is never acceptable (rule 13).
 */
const TOOL_NAMES = [
  "code.fs.list",
  "code.fs.read",
  "code.fs.grep",
  "code.fs.tree",
  "code.symbols.outline",
  "code.project.info",
  "code.fs.edit",
  "code.fs.apply_patch",
  "code.fs.write",
  "code.fs.move",
  "code.fs.delete",
  "code.fs.diff",
  "code.fs.undo_last_turn",
  "code.shell.exec",
  "code.shell.process.start",
  "code.shell.process.list",
  "code.shell.process.logs",
  "code.shell.process.stop",
  "code.verify.run",
  "code.deps.inspect",
  "code.deps.audit",
  "code.deps.add",
] as const;

/**
 * Tools that must never run without an explicit approval through the existing approval system:
 * destructive changes (`code.fs.delete`) and adding a dependency (`code.deps.add`, which installs
 * third-party code). Shell execution is approved by the PolicyEngine per risk class instead of a static
 * capability flag, per the owner's decision. Mirrored in the capability contract, so the test checks
 * equality.
 */
const APPROVAL_REQUIRED_TOOLS = new Set(["code.fs.delete", "code.deps.add"]);

/** C3/C4 risk contract: reads are low, mutations medium, deletion and command launch high. */
const EXPECTED_RISK: Record<string, "low" | "medium" | "high"> = {
  "code.fs.list": "low",
  "code.fs.read": "low",
  "code.fs.grep": "low",
  "code.fs.tree": "low",
  "code.symbols.outline": "low",
  "code.project.info": "low",
  "code.fs.edit": "medium",
  "code.fs.apply_patch": "medium",
  "code.fs.write": "medium",
  "code.fs.move": "medium",
  "code.fs.delete": "high",
  "code.fs.diff": "low",
  "code.fs.undo_last_turn": "medium",
  "code.shell.exec": "high",
  "code.shell.process.start": "high",
  "code.shell.process.list": "low",
  "code.shell.process.logs": "low",
  "code.shell.process.stop": "medium",
  "code.verify.run": "medium",
  "code.deps.inspect": "low",
  "code.deps.audit": "medium",
  "code.deps.add": "high",
};

const capabilityById = new Map(CODE_CAPABILITIES.map((capability) => [capability.id, capability]));
const toolByName = new Map(CODE_TOOL_SCHEMAS.map((tool) => [tool.name, tool]));

type JsonSchema = Record<string, unknown>;
const properties = (schema: JsonSchema | undefined): Record<string, JsonSchema> =>
  (schema?.properties ?? {}) as Record<string, JsonSchema>;
const required = (schema: JsonSchema | undefined): string[] =>
  ((schema?.required ?? []) as string[]).slice().sort();

describe("security-gate: C2 tool schema parity", () => {
  it("describes exactly the same tools in the registry and in the capability catalogue", () => {
    expect([...toolByName.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    expect([...capabilityById.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    // No hardcoded count: the three sources must agree, whichever step published the last tool.
    expect(CODE_CAPABILITIES).toHaveLength(TOOL_NAMES.length);
    expect(CODE_TOOL_SCHEMAS).toHaveLength(TOOL_NAMES.length);
  });

  it("keeps argument schemas identical field by field for every tool", () => {
    for (const name of TOOL_NAMES) {
      const tool = toolByName.get(name);
      const capability = capabilityById.get(name);
      expect(tool, `registry is missing ${name}`).toBeTruthy();
      expect(capability, `capability catalogue is missing ${name}`).toBeTruthy();

      // Same required set, same field names, same types and constraints.
      expect(required(capability!.inputSchema as JsonSchema), `${name} required`).toEqual(required(tool!.inputSchema as JsonSchema));
      expect(Object.keys(properties(capability!.inputSchema as JsonSchema)).sort(), `${name} argument names`)
        .toEqual(Object.keys(properties(tool!.inputSchema as JsonSchema)).sort());
      for (const [field, schema] of Object.entries(properties(tool!.inputSchema as JsonSchema))) {
        expect(properties(capability!.inputSchema as JsonSchema)[field], `${name}.${field} must match the registry exactly`).toEqual(schema);
      }
      // A tool may not silently accept extra arguments on either side.
      expect((capability!.inputSchema as JsonSchema).additionalProperties, `${name} additionalProperties`).toBe(false);
      expect((tool!.inputSchema as JsonSchema).additionalProperties, `${name} additionalProperties`).toBe(false);
    }
  });

  it("keeps result schemas identical, including the untrusted-data envelope", () => {
    for (const name of TOOL_NAMES) {
      const tool = toolByName.get(name)!;
      const capability = capabilityById.get(name)!;
      expect(capability.outputSchema, `${name} output schema must mirror the registry exactly`).toEqual(tool.outputSchema);
      const envelopeProperties = properties(tool.outputSchema as JsonSchema);
      expect(envelopeProperties.trust, `${name} must mark results as untrusted data`).toEqual({ const: "untrusted_data" });
      expect(envelopeProperties.kind).toEqual({ const: "code_tool_result" });
      expect(envelopeProperties.tool).toEqual({ const: name });
    }
  });

  it("pins one published version per tool and keeps the mirror keyed by tool name", () => {
    for (const name of TOOL_NAMES) {
      const tool = toolByName.get(name)!;
      const capability = capabilityById.get(name)!;
      expect(tool.version, `${name} registry version`).toBe(1);
      expect(tool.status).toBe("active");
      expect(capability.version, `${name} capability version must equal the tool version`).toBe(tool.version);
      expect(capability.domain).toBe("code");
      expect(capability.risk, `${name} risk`).toBe(EXPECTED_RISK[name]);
      expect(capability.requiresConfirmation, `${name} approval requirement`).toBe(APPROVAL_REQUIRED_TOOLS.has(name));
      expect(capability.agentCallable).toBe(true);
      expect(CODE_TOOL_SCHEMA_MIRROR[name], `${name} must be present in the mirror`).toBeTruthy();
      expect(CODE_TOOL_SCHEMA_MIRROR[name]!.inputSchema).toEqual(tool.inputSchema);
      expect(CODE_TOOL_SCHEMA_MIRROR[name]!.outputSchema).toEqual(tool.outputSchema);
    }
    expect(Object.keys(CODE_TOOL_SCHEMA_MIRROR).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("never lets the model choose the project through tool arguments", () => {
    // The project comes from the invocation envelope and is authorised against the caller's tenant,
    // so a `projectId` argument would be a tenant-isolation hole.
    for (const name of TOOL_NAMES) {
      const fields = Object.keys(properties(capabilityById.get(name)!.inputSchema as JsonSchema));
      expect(fields, `${name} must not take projectId`).not.toContain("projectId");
      expect(fields).not.toContain("companyId");
      expect(fields).not.toContain("sessionId");
      expect(fields).not.toContain("workspaceId");
    }
  });
});
