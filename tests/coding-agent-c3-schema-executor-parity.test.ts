import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { CodeToolRuntime, sha256Hex, type CodeReadPort, type CodeWritePort } from "../apps/agent-api/src/code-tool-runtime";
import { allCanonicalExecutors, isCanonicalPatchFormat } from "../apps/agent-api/src/code-tool-executors";
import { CodeTurnTracker, type CodeApprovalPort, type CodeCheckpointPort } from "../apps/agent-api/src/code-workspace-checkpoint";
import { CODE_TOOL_SCHEMAS, type CodeToolSchema } from "../apps/agent-api/src/code-tool-registry";

/**
 * C3 schema ↔ executor parity.
 *
 * The canonical schemas (`code-tool-schemas.json`) are what the model is shown and what the runtime
 * validates against `additionalProperties: false`. This suite feeds every write tool a minimal payload
 * built **from its own schema** and requires that the runtime never answers `invalid_arguments`: the
 * executor must understand exactly the arguments the schema promises. Without it, a rename in one place
 * silently turns every model call into a validation error.
 */

const owner: AuthContext = { workspaceId: "ws-parity", userId: "user-parity", permissions: ["workspace:read", "workspace:write", "business:manage", "owner"] };
const revision = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

const WRITE_TOOLS = [
  "code.fs.edit", "code.fs.apply_patch", "code.fs.write",
  "code.fs.move", "code.fs.delete", "code.fs.diff", "code.fs.undo_last_turn",
] as const;

function toolSchema(name: string): CodeToolSchema {
  const found = CODE_TOOL_SCHEMAS.find((schema) => schema.name === name);
  if (!found) throw new Error(`Schema missing for ${name}`);
  return found;
}

/** Builds the smallest payload that satisfies the schema: required fields plus every default. */
function minimalArgs(schema: CodeToolSchema): Record<string, unknown> {
  const input = schema.inputSchema as { required?: string[]; properties?: Record<string, Record<string, unknown>> };
  const required = new Set(input.required ?? []);
  const args: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(input.properties ?? {})) {
    const hasDefault = definition.default !== undefined;
    if (!required.has(name) && !hasDefault) continue;
    if (hasDefault) { args[name] = definition.default; continue; }
    if (definition.enum) { args[name] = (definition.enum as unknown[])[0]; continue; }
    switch (definition.type) {
      case "string": {
        const min = typeof definition.minLength === "number" ? definition.minLength : 1;
        args[name] = "x".repeat(Math.max(1, min));
        break;
      }
      case "integer":
      case "number":
        args[name] = typeof definition.minimum === "number" ? definition.minimum : 1;
        break;
      case "boolean":
        args[name] = false;
        break;
      default:
        args[name] = {};
    }
  }
  return args;
}

/** Domain-specific values, so the call reaches the executor instead of failing on a missing file. */
function sampleArgs(tool: string, schema: CodeToolSchema): Record<string, unknown> {
  const args = minimalArgs(schema);
  switch (tool) {
    case "code.fs.edit":
      return { ...args, path: "src/orders.ts", old_string: "return 1;", new_string: "return 2;" };
    case "code.fs.write":
      return { ...args, path: "src/created.ts", content: "export const created = true;\n" };
    case "code.fs.apply_patch":
      return { ...args, dryRun: true, patch: ["*** Begin Patch", "*** Update File: src/orders.ts", "@@ -1,3 +1,3 @@", " export function createOrder() {", "-  return 1;", "+  return 9;", " }", "*** End Patch"].join("\n") };
    case "code.fs.move":
      return { ...args, from: "src/orders.ts", to: "src/orders-moved.ts" };
    case "code.fs.delete":
      return { ...args, path: "src/orders.ts" };
    case "code.fs.diff":
      return { ...args, turnOnly: true };
    case "code.fs.undo_last_turn":
      return { ...args, confirm: true };
    default:
      return args;
  }
}

interface Harness {
  runtime: CodeToolRuntime;
  files: Map<string, string>;
  writes: string[];
  checkpointIds: string[];
}

function harness(): Harness {
  const files = new Map<string, string>([["src/orders.ts", "export function createOrder() {\n  return 1;\n}\n"]]);
  const writes: string[] = [];
  const checkpointIds: string[] = [];

  const readPort: CodeReadPort = {
    async listDir({ path }) {
      return {
        entries: [...files.keys()].map((file) => ({
          path: file,
          type: "file" as const,
          target: file === path ? file : null,
        })),
      };
    },
    async readFile({ path }) {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      return { path, content, revision: revision(content), sha256: sha256Hex(content), totalLines: content.split("\n").length, truncated: false };
    },
    async runSearch() { return { matches: [], truncated: false, engine: "fallback" as const }; },
  };

  const writePort: CodeWritePort = {
    async writeFile({ path, content, expectedRevision }) {
      const current = files.get(path);
      if (current === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      if (expectedRevision !== revision(current)) throw Object.assign(new Error("Project file revision changed"), { code: "revision_conflict", status: 409, currentRevision: revision(current) });
      files.set(path, content);
      writes.push(path);
      return { path, revision: revision(content), sha256: sha256Hex(content) };
    },
    async createFile({ path, content }) {
      files.set(path, content);
      writes.push(path);
      return { path, revision: revision(content), sha256: sha256Hex(content) };
    },
    async editFile({ path, find, replacement, expectedRevision }) {
      const current = files.get(path) ?? "";
      if (expectedRevision !== revision(current)) throw Object.assign(new Error("Project file revision changed"), { code: "revision_conflict", status: 409, currentRevision: revision(current) });
      const next = current.replace(find, replacement);
      files.set(path, next);
      writes.push(path);
      return { path, revision: revision(next), sha256: sha256Hex(next) };
    },
    async moveFile({ from, to }) {
      const current = files.get(from);
      if (current === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      files.delete(from);
      files.set(to, current);
      writes.push(to);
      return { path: to, revision: revision(current), sha256: sha256Hex(current) };
    },
    async deleteFile({ path }) { files.delete(path); writes.push(path); },
  };

  const checkpoints: CodeCheckpointPort = {
    async create({ turnId }) {
      const id = `cp-${turnId}-${checkpointIds.length + 1}`;
      checkpointIds.push(id);
      return { checkpointId: id, commitHash: "deadbeef" };
    },
    async restore({ checkpointId }) { return { restoredCheckpointId: checkpointId, backupCheckpointId: "cp-safety" }; },
    async diff() { return { diff: "" }; },
  };

  const approvals: CodeApprovalPort = {
    async request() { return { approvalId: "appr-1" }; },
    async consume() { return undefined; },
  };

  const runtime = new CodeToolRuntime({
    schemas: CODE_TOOL_SCHEMAS,
    flags: { async assertEnabled() { return true; } } as never,
    store: { async getCompany() { return {}; } },
    audit: { async record() { return undefined; } } as never,
    activity: { async record() { return undefined; } },
    turns: new CodeTurnTracker(),
    executors: allCanonicalExecutors(),
    checkpoints,
    approvals,
    writePort,
    toPort: () => readPort,
    maxRevisionRetries: 2,
  });

  return { runtime, files, writes, checkpointIds };
}

const invoke = (h: Harness, tool: string, args: Record<string, unknown>, toolCallId = `call-${Math.random().toString(36).slice(2)}`) =>
  h.runtime.invoke(owner, {
    companyId: "company-parity", projectId: "project-parity", sessionId: "session-parity",
    tool, args, toolCallId, turnId: "turn-parity",
  } as never);

const read = (h: Harness, path: string, toolCallId: string) =>
  invoke(h, "code.fs.read", { path }, toolCallId);

describe("security-gate: C3 schema → executor parity", () => {
  it("publishes a canonical schema for every write tool", () => {
    for (const name of WRITE_TOOLS) expect(toolSchema(name).inputSchema).toMatchObject({ additionalProperties: false });
  });

  it("never rejects schema-shaped arguments as invalid_arguments", async () => {
    for (const name of WRITE_TOOLS) {
      const h = harness();
      await read(h, "src/orders.ts", `read-${name}`);
      const result = await invoke(h, name, sampleArgs(name, toolSchema(name)));
      if (!result.ok) {
        // A domain refusal (approval, revision, checkpoint) is fine; a validation refusal is not.
        expect({ tool: name, code: result.error.code }).not.toMatchObject({ code: "invalid_arguments" });
      }
    }
  });

  it("runs the canonical edit and honours replace_all for a non-unique match", async () => {
    const h = harness();
    h.files.set("src/dup.ts", "const a = 1;\nconst b = 1;\n");
    await read(h, "src/dup.ts", "read-dup");

    // Ambiguity is checked while both occurrences are still present.
    const ambiguous = await invoke(h, "code.fs.edit", { path: "src/dup.ts", old_string: "= 1;", new_string: "= 3;" });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.code).toBe("edit_not_unique");

    // `replace_all` is the canonical name and must actually replace every occurrence.
    const all = await invoke(h, "code.fs.edit", { path: "src/dup.ts", old_string: "= 1;", new_string: "= 3;", replace_all: true });
    expect(all.ok).toBe(true);
    expect(h.files.get("src/dup.ts")).toBe("const a = 3;\nconst b = 3;\n");

    // A unique match needs no replace_all.
    await read(h, "src/dup.ts", "read-dup-2");
    const unique = await invoke(h, "code.fs.edit", { path: "src/dup.ts", old_string: "const a = 3;", new_string: "const a = 4;" });
    expect(unique.ok).toBe(true);
    expect(h.files.get("src/dup.ts")).toBe("const a = 4;\nconst b = 3;\n");
  });

  it("applies the canonical patch format and never writes on a dry run", async () => {
    const h = harness();
    await read(h, "src/orders.ts", "read-patch");
    const patch = ["*** Begin Patch", "*** Update File: src/orders.ts", "@@ -1,3 +1,3 @@", " export function createOrder() {", "-  return 1;", "+  return 5;", " }", "*** End Patch"].join("\n");
    expect(isCanonicalPatchFormat(patch)).toBe(true);

    const dry = await invoke(h, "code.fs.apply_patch", { patch, dryRun: true });
    expect(dry.ok).toBe(true);
    // The whole point of dryRun: no write of any kind reached the workspace.
    expect(h.writes).toEqual([]);
    expect(h.files.get("src/orders.ts")).toContain("return 1;");

    const applied = await invoke(h, "code.fs.apply_patch", { patch });
    expect(applied.ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toContain("return 5;");
    expect(h.writes).toEqual(["src/orders.ts"]);
  });

  it("refuses to overwrite when overwrite is false and to create an existing file", async () => {
    const h = harness();
    await read(h, "src/orders.ts", "read-write");
    const refused = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "changed", overwrite: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("already_exists");
    expect(h.files.get("src/orders.ts")).toContain("return 1;");

    const created = await invoke(h, "code.fs.write", { path: "src/fresh.ts", content: "export const fresh = 1;\n" });
    expect(created.ok).toBe(true);
    expect(h.files.get("src/fresh.ts")).toContain("fresh");
  });

  it("requires confirm for undo and keeps the flag gate in front of every write tool", async () => {
    const h = harness();
    const undo = await invoke(h, "code.fs.undo_last_turn", { confirm: false });
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.error.code).toBe("invalid_arguments");

    const denied = new CodeToolRuntime({
      schemas: CODE_TOOL_SCHEMAS,
      flags: { async assertEnabled(_ctx: AuthContext, key: string) { throw Object.assign(new Error(`disabled ${key}`), { code: "feature_disabled", status: 403, flagKey: key }); } } as never,
      store: { async getCompany() { return {}; } },
      executors: allCanonicalExecutors(),
      writePort: undefined,
      toPort: () => ({ listDir: async () => ({ entries: [] }), readFile: async () => { throw Object.assign(new Error("nope"), { code: "not_a_file" }); }, runSearch: async () => ({ matches: [], truncated: false }) }) as never,
    });
    const gated = await denied.invoke(owner, { companyId: "c", projectId: "p", tool: "code.fs.edit", args: { path: "src/orders.ts", old_string: "a", new_string: "b" }, toolCallId: "gate" } as never);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error.code).toBe("feature_disabled");
  });
});
