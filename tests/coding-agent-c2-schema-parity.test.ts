import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODE_CAPABILITIES, CODE_TOOL_SCHEMA_MIRROR } from "@npati/shared";
import {
  CODE_TOOL_MANIFEST_VERSION,
  CODE_TOOL_SCHEMAS,
  KNOWN_TOOL_MANIFESTS,
  PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM,
  V5_TOOL_SCHEMAS,
  V6_TOOL_SCHEMAS,
  toolSchemaChecksum,
} from "../apps/agent-api/src/code-tool-registry";

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
  // C9 planning metadata: a plan draft and the session todo list. They mutate session state, never the
  // workspace — which is why the policy classifies them read-only.
  "code.plan.propose",
  "code.plan.update",
  // C9: the user question. It pauses the run as `waiting_for_user`; a person answers it, and neither the model
  // nor a timeout ever does.
  "code.ask_user",
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
  // C9: planning metadata only, so both are low risk and never approve-gated.
  "code.plan.propose": "low",
  "code.plan.update": "low",
  // C9: a question touches session metadata and nothing else. It is *not* approve-gated: asking the user is the
  // alternative to guessing, so gating it would push the agent to guess.
  "code.ask_user": "low",
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

  it("lists every tool exactly once in the parity list and a risk for each", () => {
    // A duplicate would mask a missing tool: 25 entries with one duplicate are 24 unique names, so the
    // comparison against a 25-tool source still passes while one tool is never actually checked.
    expect(new Set(TOOL_NAMES).size, "TOOL_NAMES must not contain duplicates").toBe(TOOL_NAMES.length);
    // A tool added here without a risk entry would make `EXPECTED_RISK[name]` undefined and silently
    // weaken the risk assertion below, so the two lists must stay in step.
    expect(Object.keys(EXPECTED_RISK).sort(), "every tool needs a pinned risk").toEqual([...TOOL_NAMES].sort());
  });

  it("keeps the registry constants in step with the published manifest artifact", () => {
    // `scripts/verify-code-tool-schemas.mjs --check` compares the artifacts with each other, so it cannot
    // see a stale constant in the code. That gap was real: the artifact reported `manifest v6` while the
    // registry still held `CODE_TOOL_MANIFEST_VERSION = 5`, and a session resolving v5 would simply not
    // see the newly published tools while the artifact guard stayed green.
    const published = JSON.parse(
      readFileSync(new URL("../apps/agent-api/src/code-tool-schemas.published.json", import.meta.url), "utf8"),
    ) as { manifestVersion: number; checksum: string; tools: { name: string }[] };

    expect(CODE_TOOL_MANIFEST_VERSION, "registry manifest version must equal the published manifest").toBe(published.manifestVersion);
    expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM, "registry checksum must equal the published manifest").toBe(published.checksum);
    // Reuse the registry's own hasher instead of a second implementation: two hashers would be two truths
    // and could disagree exactly when it matters.
    expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM, "registry checksum must match the schemas it pins").toBe(toolSchemaChecksum(CODE_TOOL_SCHEMAS));
    expect(published.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("serves exactly one manifest for the published version and keeps the frozen v5 and v6 sets intact", () => {
    const publishedVersions = KNOWN_TOOL_MANIFESTS.map((manifest) => manifest.version).filter(
      (version) => version === CODE_TOOL_MANIFEST_VERSION,
    );
    expect(publishedVersions, "exactly one manifest per published version").toHaveLength(1);

    const current = KNOWN_TOOL_MANIFESTS.find((manifest) => manifest.version === CODE_TOOL_MANIFEST_VERSION)!;
    expect(current.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    // Rule 13: an already published version is never rewritten, so a tool published later cannot leak
    // into v5 — a session created before C9 must keep resolving exactly the 22 tools it started with.
    const v5 = KNOWN_TOOL_MANIFESTS.find((manifest) => manifest.version === 5)!;
    expect(v5.tools, "v5 is frozen at 22 tools").toHaveLength(22);
    expect(v5.tools.map((tool) => tool.name).sort()).toEqual(
      TOOL_NAMES.filter((name) => name !== "code.plan.propose" && name !== "code.plan.update" && name !== "code.ask_user").sort(),
    );
    expect(v5.tools.map((tool) => tool.name)).not.toContain("code.plan.propose");
    expect(v5.tools.map((tool) => tool.name)).not.toContain("code.plan.update");
    expect(v5.tools.map((tool) => tool.name)).not.toContain("code.ask_user");
    expect(v5.checksum, "v5 checksum is frozen").toBe(PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM);
    expect(toolSchemaChecksum(V5_TOOL_SCHEMAS)).toBe(PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM);

    /**
     * v6 is the set sessions were pinned to before `code.ask_user` existed, and it is frozen **explicitly**: the
     * registry lists the 24 names rather than filtering the current schemas, so the newest publication cannot
     * retroactively join a manifest that was already served. A "everything except the newest tool" rule would
     * have looked equivalent today and silently rewritten v6 the next time a tool was added.
     */
    const v6 = KNOWN_TOOL_MANIFESTS.find((manifest) => manifest.version === 6)!;
    expect(v6.tools, "v6 is frozen at 24 tools").toHaveLength(24);
    expect(v6.tools.map((tool) => tool.name).sort()).toEqual(
      [...TOOL_NAMES].filter((name) => name !== "code.ask_user").sort(),
    );
    expect(v6.tools.map((tool) => tool.name), "the v7 tool must not leak into v6").not.toContain("code.ask_user");
    expect(v6.checksum, "v6 checksum is frozen").toBe(PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM);
    expect(toolSchemaChecksum(V6_TOOL_SCHEMAS)).toBe(PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM);
    // The three frozen sets are distinct, so a checksum copy-paste cannot make two of them look equal.
    expect(new Set([PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM, PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM, toolSchemaChecksum(CODE_TOOL_SCHEMAS)]).size).toBe(3);
    expect(V6_TOOL_SCHEMAS.map((tool) => tool.name)).not.toContain("code.ask_user");
  });
});
