import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { CodeToolRuntime, sha256Hex, type CodeReadPort, type CodeWritePort } from "../apps/agent-api/src/code-tool-runtime";
import { allCanonicalExecutors } from "../apps/agent-api/src/code-tool-executors";
import { CodeTurnTracker, type CodeApprovalPort, type CodeCheckpointPort } from "../apps/agent-api/src/code-workspace-checkpoint";
import type { CodeToolSchema } from "../apps/agent-api/src/code-tool-registry";

/**
 * C3 runtime tests: read-before-write, revision retries, per-turn checkpoints, undo, approvals and the
 * untrusted-data envelope. Everything is faked at the port boundary — no sandbox, no database, no git.
 */

const owner: AuthContext = { workspaceId: "ws-c3", userId: "user-c3", permissions: ["workspace:read", "workspace:write", "business:manage", "owner"] };
const other: AuthContext = { workspaceId: "ws-c3", userId: "user-other", permissions: ["workspace:read"] };

const revision = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

function schema(name: string, extra: Record<string, unknown> = {}): CodeToolSchema {
  return {
    name, version: 1, status: "active", description: name,
    inputSchema: { type: "object", additionalProperties: true, properties: {}, ...extra },
    outputSchema: { type: "object" },
  } as unknown as CodeToolSchema;
}

const SCHEMAS: readonly CodeToolSchema[] = [
  schema("code.fs.read"), schema("code.fs.write"), schema("code.fs.edit"), schema("code.fs.move"),
  schema("code.fs.delete"), schema("code.fs.apply_patch"), schema("code.fs.diff"), schema("code.fs.undo_last_turn"),
];

interface Harness {
  runtime: CodeToolRuntime;
  files: Map<string, string>;
  checkpoints: Array<{ id: string; snapshot: Map<string, string> }>;
  approvals: Array<{ id: string; payload: Record<string, unknown>; consumed: boolean }>;
  audits: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  allowedFlags: Set<string>;
  storeThrows: { value: boolean };
  breakRevision: { value: boolean };
  writes: string[];
  attempts: string[];
}

function harness(options: { auditFailure?: { value: boolean }; withCheckpoints?: boolean; withApprovals?: boolean; turnTracker?: CodeTurnTracker; beforeCheckpoint?: (files: Map<string, string>) => void } = {}): Harness {
  const files = new Map<string, string>([["src/orders.ts", "export function createOrder() {\n  return 1;\n}\n"]]);
  const checkpoints: Harness["checkpoints"] = [];
  const approvals: Harness["approvals"] = [];
  const audits: Harness["audits"] = [];
  const activities: Harness["activities"] = [];
  const allowedFlags = new Set(["coding_agent.enabled", "code.read", "code.write"]);
  const storeThrows = { value: false };
  const breakRevision = { value: false };
  const writes: string[] = [];
  const attempts: string[] = [];

  const readPort: CodeReadPort = {
    async listDir() { return { entries: [...files.keys()].map((path) => ({ path, type: "file" as const })) }; },
    async readFile({ path }) {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      return { path, content, revision: revision(content), sha256: sha256Hex(content), totalLines: content.split("\n").length, truncated: false };
    },
    async runSearch() { return { matches: [], truncated: false, engine: "fallback" as const }; },
  };

  const writePort: CodeWritePort = {
    async writeFile({ path, content, expectedRevision }) {
      attempts.push(path);
      const current = files.get(path);
      if (current === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      if (breakRevision.value || expectedRevision !== revision(current)) {
        // The workspace is the authority on lost updates (see ProjectFileError in project-workspace.ts).
        throw Object.assign(new Error("Project file revision changed"), { code: "revision_conflict", status: 409, currentRevision: revision(current) });
      }
      files.set(path, content);
      writes.push(path);
      return { path, revision: revision(content), sha256: sha256Hex(content) };
    },
    async createFile({ path, content }) {
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "revision_conflict", status: 409, currentRevision: revision(files.get(path)!) });
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
    async moveFile({ from, to, expectedRevision }) {
      const current = files.get(from);
      if (current === undefined) throw Object.assign(new Error("not a file"), { code: "not_a_file", status: 404 });
      if (expectedRevision !== revision(current)) throw Object.assign(new Error("Project file revision changed"), { code: "revision_conflict", status: 409, currentRevision: revision(current) });
      files.delete(from);
      files.set(to, current);
      writes.push(to);
      return { path: to, revision: revision(current), sha256: sha256Hex(current) };
    },
    async deleteFile({ path, expectedRevision }) {
      const current = files.get(path);
      if (expectedRevision !== undefined && (current === undefined || expectedRevision !== revision(current))) throw Object.assign(new Error("Project file revision changed"), { code: "revision_conflict", status: 409, currentRevision: current === undefined ? null : revision(current) });
      files.delete(path); writes.push(path);
    },
  };

  const checkpointPort: CodeCheckpointPort | undefined = options.withCheckpoints === false ? undefined : {
    async create({ turnId }) {
      options.beforeCheckpoint?.(files);
      const id = `cp-${turnId}-${checkpoints.length + 1}`;
      checkpoints.push({ id, snapshot: new Map(files) });
      return { checkpointId: id, commitHash: "deadbeef" };
    },
    async restore({ checkpointId }) {
      const found = checkpoints.find((entry) => entry.id === checkpointId);
      if (!found) throw Object.assign(new Error("no checkpoint"), { code: "CHECKPOINT_NOT_FOUND", status: 404 });
      files.clear();
      for (const [path, content] of found.snapshot) files.set(path, content);
      return { restoredCheckpointId: checkpointId, backupCheckpointId: "cp-safety" };
    },
    async diff() { return { diff: "workspace diff" }; },
  };

  const approvalPort: CodeApprovalPort | undefined = options.withApprovals === false ? undefined : {
    async request({ inputPayload }) {
      const id = `appr-${approvals.length + 1}`;
      approvals.push({ id, payload: structuredClone(inputPayload), consumed: false });
      return { approvalId: id };
    },
    async consume({ approvalId, inputPayload }) {
      const found = approvals.find((entry) => entry.id === approvalId);
      if (!found) throw Object.assign(new Error("Approval context or payload does not match"), { code: "APPROVAL_INVALID", status: 409 });
      if (JSON.stringify(found.payload) !== JSON.stringify(inputPayload)) {
        // Exactly what CompanyApprovalsRepository does with payload_hash.
        throw Object.assign(new Error("Approval context or payload does not match"), { code: "APPROVAL_INVALID", status: 409 });
      }
      if (found.consumed) throw Object.assign(new Error("Approval has already been consumed"), { code: "APPROVAL_ALREADY_USED", status: 409 });
      found.consumed = true;
    },
  };

  const runtime = new CodeToolRuntime({
    schemas: SCHEMAS,
    flags: {
      async assertEnabled(_ctx: AuthContext, key: string) {
        if (!allowedFlags.has(key)) throw Object.assign(new Error(`Feature disabled: ${key}`), { code: "feature_disabled", status: 403, flagKey: key });
      },
    } as never,
    store: {
      async getCompany() { if (storeThrows.value) throw new Error("Company is not available to this user"); return {}; },
    },
    audit: { async record(_ctx: AuthContext, entry: Record<string, unknown>) { if (options.auditFailure?.value) throw new Error("Audit journal unavailable"); audits.push(entry as Record<string, unknown>); } } as never,
    activity: { async record(event) { activities.push({ ...event }); } },
    tracker: undefined,
    turns: options.turnTracker ?? new CodeTurnTracker(),
    executors: allCanonicalExecutors(),
    checkpoints: checkpointPort,
    approvals: approvalPort,
    writePort,
    toPort: () => readPort,
    maxRevisionRetries: 2,
  });

  return { runtime, files, checkpoints, approvals, audits, activities, allowedFlags, storeThrows, breakRevision, writes, attempts };
}

const invoke = (h: Harness, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, ctx: AuthContext = owner) =>
  h.runtime.invoke(ctx, {
    companyId: "company-c3", projectId: "project-c3", sessionId: "session-c3", tool, args,
    toolCallId: `call-${Math.random().toString(36).slice(2)}`, turnId: "turn-1", ...extra,
  } as never);

const readFile = async (h: Harness, path: string, toolCallId?: string) =>
  h.runtime.invoke(owner, {
    companyId: "company-c3", projectId: "project-c3", sessionId: "session-c3",
    tool: "code.fs.read", args: { path }, toolCallId: toolCallId ?? `read-${path}`, turnId: "turn-1",
  });

describe("security-gate: C3 read-before-write", () => {
  it("binds cached tool results to project identity and exact arguments", async () => {
    const h = harness();
    const first = await invoke(h, "code.fs.read", { path: "src/orders.ts" }, { toolCallId: "same-id" });
    expect(first.ok).toBe(true);
    const swapped = await invoke(h, "code.fs.read", { path: "other.ts" }, { toolCallId: "same-id" });
    expect(swapped).toMatchObject({ ok: false, error: { code: "invalid_arguments", step: "idempotency" } });
    const otherProject = await invoke(h, "code.fs.read", { path: "src/orders.ts" }, { toolCallId: "same-id", projectId: "other-project" });
    expect(otherProject.ok).toBe(true);
    if (otherProject.ok) expect(otherProject.cached).not.toBe(true);
  });

  it.each([
    "*** Begin Patch\n*** Delete File: src/orders.ts\n*** End Patch",
    "--- a/src/orders.ts\n+++ b/src/orders.ts\n@@ -1 +1 @@\n-old\n+new",
  ])("requires prior reads for patch targets in both formats", async patch => {
    const h = harness();
    const result = await invoke(h, "code.fs.apply_patch", { patch });
    expect(result).toMatchObject({ ok: false, error: { code: "read_before_write_required" } });
    expect(h.writes).toEqual([]);
  });

  it("requires approval for patch deletion and binds approval to the exact operation", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    const patch = "*** Begin Patch\n*** Delete File: src/orders.ts\n*** End Patch";
    const requested = await invoke(h, "code.fs.apply_patch", { patch });
    expect(requested).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(h.files.has("src/orders.ts")).toBe(true);
    expect(h.approvals).toHaveLength(1);
    const changed = "*** Begin Patch\n*** Delete File: src/orders.ts\n*** Add File: injected.txt\n+injected\n*** End Patch";
    const swapped = await invoke(h, "code.fs.apply_patch", { patch: changed }, { approvalId: h.approvals[0]!.id });
    expect(swapped).toMatchObject({ ok: false, error: { code: "approval_invalid" } });
    expect(h.writes).toEqual([]);
    const approved = await invoke(h, "code.fs.apply_patch", { patch }, { approvalId: h.approvals[0]!.id });
    expect(approved.ok).toBe(true);
    expect(h.files.has("src/orders.ts")).toBe(false);
  });

  it("refuses a write to an existing file that was never read in this session", async () => {
    const h = harness();
    const result = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "changed" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("read_before_write_required");
    expect(result.error.status).toBe(409);
    expect(result.error.details).toMatchObject({ reason: "not_read", path: "src/orders.ts" });
    expect(h.writes).toHaveLength(0);
    expect(h.files.get("src/orders.ts")).toContain("createOrder");
  });

  it("allows the write after a read and refreshes the tracked hash for the next edit", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    const written = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "export const x = 1;\n" });
    expect(written.ok).toBe(true);
    expect(h.writes).toEqual(["src/orders.ts"]);
    // The tracker now holds the new hash, so a second edit needs no second read.
    const edited = await invoke(h, "code.fs.edit", { path: "src/orders.ts", find: "export const x = 1;", replacement: "export const x = 2;" });
    expect(edited.ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toContain("export const x = 2;");
  });

  it("refuses the write when the file changed after it was read", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    h.files.set("src/orders.ts", "// someone else edited this\n");
    const result = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "mine" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("read_before_write_required");
    expect(result.error.details).toMatchObject({ reason: "changed" });
    expect(h.files.get("src/orders.ts")).toBe("// someone else edited this\n");
  });

  it("creates a new file without a prior read but still takes a checkpoint", async () => {
    const h = harness();
    const result = await invoke(h, "code.fs.write", { path: "src/new.ts", content: "export {};\n" });
    expect(result.ok).toBe(true);
    expect(h.checkpoints).toHaveLength(1);
    expect(h.files.get("src/new.ts")).toBe("export {};\n");
  });
});

describe("security-gate: C3 revision control and retries", () => {
  it("surfaces a revision conflict with the current revision, allows two retries and then refuses", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    h.breakRevision.value = true;
    const conflicts = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      conflicts.push(await invoke(h, "code.fs.write", { path: "src/orders.ts", content: `v${attempt}` }, { toolCallId: `conflict-${attempt}` }));
    }
    expect(conflicts.map((entry) => (entry.ok ? "ok" : entry.error.code))).toEqual([
      "revision_conflict", "revision_conflict", "revision_conflict_exhausted",
    ]);
    const first = conflicts[0];
    if (first && !first.ok) expect(first.error.details).toMatchObject({ currentRevision: revision(h.files.get("src/orders.ts")!) });
    expect(h.writes).toHaveLength(0);
  });
});

describe("security-gate: C3 per-turn checkpoint and undo", () => {
  it("creates exactly one checkpoint before the first write of a turn and restores it on undo", async () => {
    const h = harness();
    const before = h.files.get("src/orders.ts");
    await readFile(h, "src/orders.ts");
    await invoke(h, "code.fs.edit", { path: "src/orders.ts", find: "return 1;", replacement: "return 42;" }, { toolCallId: "edit-1" });
    await invoke(h, "code.fs.edit", { path: "src/orders.ts", find: "return 42;", replacement: "return 43;" }, { toolCallId: "edit-2" });
    expect(h.checkpoints).toHaveLength(1);
    const undone = await invoke(h, "code.fs.undo_last_turn", { confirm: true }, { toolCallId: "undo-1" });
    expect(undone.ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toBe(before);
    expect(h.runtime.turnSummary("session-c3", "turn-1").changes).toHaveLength(0);
  });

  it("refuses to write at all when the checkpoint mechanism is unavailable", async () => {
    const h = harness({ withCheckpoints: false });
    await readFile(h, "src/orders.ts");
    const result = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("checkpoint_unavailable");
    expect(result.error.status).toBe(503);
    expect(h.writes).toHaveLength(0);
  });

  it("requires confirm: true for undo and reports a missing checkpoint", async () => {
    const h = harness();
    const unconfirmed = await invoke(h, "code.fs.undo_last_turn", {});
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) expect(unconfirmed.error.code).toBe("invalid_arguments");
    const missing = await invoke(h, "code.fs.undo_last_turn", { confirm: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("checkpoint_not_found");
  });
});

describe("security-gate: C3 approvals", () => {
  it("refuses a delete without an approval, then executes it with the approval for the same payload", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    const demanded = await invoke(h, "code.fs.delete", { path: "src/orders.ts" }, { toolCallId: "del-1" });
    expect(demanded.ok).toBe(false);
    if (demanded.ok) return;
    expect(demanded.error.code).toBe("approval_required");
    expect(demanded.error.status).toBe(403);
    const approvalId = (demanded.error.details as { approvalId?: string })?.approvalId;
    expect(approvalId).toBeTruthy();
    expect(h.files.has("src/orders.ts")).toBe(true);

    const approved = await invoke(h, "code.fs.delete", { path: "src/orders.ts" }, { toolCallId: "del-2", approvalId });
    expect(approved.ok).toBe(true);
    expect(h.files.has("src/orders.ts")).toBe(false);
    expect(h.approvals[0]?.consumed).toBe(true);
  });

  it("rejects a payload substituted between approval and execution", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    const demanded = await invoke(h, "code.fs.delete", { path: "src/orders.ts" }, { toolCallId: "del-1" });
    const approvalId = (!demanded.ok && (demanded.error.details as { approvalId?: string })?.approvalId) || "";
    // Same approval id, different target: the payload hash cannot match, so nothing is deleted.
    const substituted = await invoke(h, "code.fs.delete", { path: "src/other.ts" }, { toolCallId: "del-2", approvalId });
    expect(substituted.ok).toBe(false);
    if (substituted.ok) return;
    expect(substituted.error.code).toBe("approval_invalid");
    expect(h.files.has("src/orders.ts")).toBe(true);
  });

  it("refuses a destructive change when the approval system is not configured", async () => {
    const h = harness({ withApprovals: false });
    await readFile(h, "src/orders.ts");
    const result = await invoke(h, "code.fs.delete", { path: "src/orders.ts" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("approval_unavailable");
    expect(result.error.status).toBe(503);
    expect(h.files.has("src/orders.ts")).toBe(true);
  });
});

describe("security-gate: C3 flags, isolation and data handling", () => {
  it("refuses write tools, diff and undo while code.write is disabled", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    h.allowedFlags.delete("code.write");
    for (const [tool, args] of [["code.fs.write", { path: "src/orders.ts", content: "x" }], ["code.fs.diff", { turnOnly: true }], ["code.fs.undo_last_turn", { confirm: true }]] as const) {
      const result = await invoke(h, tool, args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("feature_disabled");
    }
    expect(h.writes).toHaveLength(0);
    expect(h.checkpoints).toHaveLength(0);
  });

  it("keeps tenants apart even for writes", async () => {
    const h = harness();
    h.storeThrows.value = true;
    await readFile(h, "src/orders.ts", "read-1");
    const result = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "x" }, {}, other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("company_access_denied");
    expect(h.writes).toHaveLength(0);
  });

  it("keeps file content and secrets out of the audit entries and activity events", async () => {
    const h = harness();
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";
    h.files.set("src/config.ts", `export const TOKEN = "${secret}";\n`);
    await readFile(h, "src/config.ts");
    await invoke(h, "code.fs.edit", { path: "src/config.ts", find: "abcdefghijklmnopqrstuvwxyz", replacement: "redacted" }, { toolCallId: "edit-secret" });
    const serialized = JSON.stringify({ audits: h.audits, activities: h.activities });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("export const TOKEN");
    expect(JSON.stringify(h.audits)).toContain("src/config.ts");
  });

  it("reports the turn diff with statistics and keeps results wrapped as untrusted data", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    await invoke(h, "code.fs.edit", { path: "src/orders.ts", find: "return 1;", replacement: "return 2;" }, { toolCallId: "edit-1" });
    const diff = await invoke(h, "code.fs.diff", { turnOnly: true }, { toolCallId: "diff-1" });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    const envelope = diff.result as { kind?: string; trust?: string; data?: { scope?: string; stats?: { files?: number; linesAdded?: number; linesRemoved?: number } } };
    expect(envelope.kind).toBe("code_tool_result");
    expect(envelope.trust).toBe("untrusted_data");
    expect(envelope.data?.scope).toBe("turn");
    expect(envelope.data?.stats?.files).toBe(1);
    expect(envelope.data?.stats?.linesAdded).toBeGreaterThan(0);
  });
});

describe("security-gate: C3 acceptance path", () => {
  it("reads, edits and patches two files in one turn, then undoes the whole turn", async () => {
    const h = harness();
    h.files.set("src/cart.ts", "export const total = () => 0;\n");
    const originalOrders = h.files.get("src/orders.ts");
    const originalCart = h.files.get("src/cart.ts");

    await readFile(h, "src/orders.ts");
    await readFile(h, "src/cart.ts");
    const edited = await invoke(h, "code.fs.edit", { path: "src/orders.ts", find: "return 1;", replacement: "return 10;" }, { toolCallId: "edit-1" });
    expect(edited.ok).toBe(true);
    const patched = await invoke(h, "code.fs.apply_patch", {
      edits: [
        { path: "src/cart.ts", find: "() => 0", replacement: "() => 5" },
        { path: "src/orders.ts", find: "return 10;", replacement: "return 11;" },
      ],
    }, { toolCallId: "patch-1" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const data = (patched.result as { data?: { files?: unknown[]; linesAdded?: number; diff?: string } }).data;
    expect(data?.files).toHaveLength(2);
    expect(data?.diff).toContain("--- a/src/cart.ts");
    expect(data?.diff).toContain("+++ b/src/orders.ts");

    const summary = h.runtime.turnSummary("session-c3", "turn-1");
    expect(summary.files).toBe(2);
    expect(summary.linesAdded).toBeGreaterThan(0);

    const undone = await invoke(h, "code.fs.undo_last_turn", { confirm: true }, { toolCallId: "undo-1" });
    expect(undone.ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toBe(originalOrders);
    expect(h.files.get("src/cart.ts")).toBe(originalCart);
  });
});

describe("security-gate: C3 checkpoint-time concurrency regression", () => {
  it.each(["code.fs.move", "code.fs.delete", "code.fs.apply_patch"])("refuses stale %s after checkpoint creation", async (tool) => {
    const original = "export function createOrder() {\n  return 1;\n}\n";
    const external = original + "// concurrent change\n";
    const h = harness({ beforeCheckpoint: files => files.set("src/orders.ts", external) });
    await readFile(h, "src/orders.ts");
    const args = tool === "code.fs.move" ? { from: "src/orders.ts", to: "src/moved.ts" }
      : tool === "code.fs.delete" ? { path: "src/orders.ts" }
      : { patch: "*** Begin Patch\n*** Update File: src/orders.ts\n@@ -1,3 +1,3 @@\n export function createOrder() {\n-  return 1;\n+  return 2;\n }\n*** End Patch" };
    let result = await invoke(h, tool, args);
    if (!result.ok && result.error.code === "approval_required") {
      result = await invoke(h, tool, args, { approvalId: h.approvals[0]!.id });
    }
    expect(result).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    expect(h.files.get("src/orders.ts")).toBe(external);
    expect(h.files.has("src/moved.ts")).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it.each(["$&", "$$", "$" + String.fromCharCode(96), "$'"])("keeps legacy patch replacement %s literal", async replacement => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    const result = await invoke(h, "code.fs.apply_patch", { edits: [{ path: "src/orders.ts", find: "return 1", replacement }] });
    expect(result.ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toBe("export function createOrder() {\n  " + replacement + ";\n}\n");
  });
});

describe("security-gate: C3 revision retry accounting regression", () => {
  it("keeps retry budgets independent for separate file paths", async () => {
    const h = harness();
    h.files.set("src/other.ts", "old\n");
    await readFile(h, "src/orders.ts");
    await readFile(h, "src/other.ts");
    h.breakRevision.value = true;
    for (let attempt = 0; attempt < 3; attempt++) await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "new\n" });
    const result = await invoke(h, "code.fs.write", { path: "src/other.ts", content: "new\n" });
    expect(result).toMatchObject({ ok: false, error: { code: "revision_conflict", details: { attempts: 1 } } });
  });
  it("resets the file conflict budget after a successful write", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    h.breakRevision.value = true;
    await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "new\n" });
    h.breakRevision.value = false;
    expect((await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "new\n" })).ok).toBe(true);
    h.breakRevision.value = true;
    const result = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "other\n" });
    expect(result).toMatchObject({ ok: false, error: { code: "revision_conflict", details: { attempts: 1 } } });
  });
});

describe("security-gate: C3 retry exhaustion is enforced before dispatch", () => {
  it("does not dispatch a fourth single-file write after the retry budget is exhausted", async () => {
    const h = harness();
    await readFile(h, "src/orders.ts");
    h.breakRevision.value = true;
    for (let index = 0; index < 3; index++) await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "changed\n" });
    assertExhausted(await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "changed\n" }));
    expect(h.attempts).toHaveLength(3);
    h.breakRevision.value = false;
    const next = await invoke(h, "code.fs.write", { path: "src/orders.ts", content: "next turn\n" }, { turnId: "next-turn" });
    expect(next.ok).toBe(true);
  });
  it("bounds retries for a multi-file patch before another partial commit is attempted", async () => {
    const h = harness();
    h.files.set("other.ts", "old\n");
    await readFile(h, "src/orders.ts");
    await readFile(h, "other.ts");
    const patch = "*** Begin Patch\n*** Update File: src/orders.ts\n@@ -1,3 +1,3 @@\n export function createOrder() {\n-  return 1;\n+  return 2;\n }\n*** Update File: other.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch";
    h.breakRevision.value = true;
    for (let index = 0; index < 3; index++) await invoke(h, "code.fs.apply_patch", { patch });
    assertExhausted(await invoke(h, "code.fs.apply_patch", { patch }));
    expect(h.attempts).toHaveLength(3);
  });
});
function assertExhausted(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result).toMatchObject({ ok: false, error: { code: "revision_conflict_exhausted" } });
}

describe("security-gate: C3 undo audit failure is fail closed", () => {
  it.each(["canonical tool", "public undo"] as const)("keeps files and checkpoint intact when the journal fails through %s", async entry => {
    const failure = { value: false };
    const h = harness({ auditFailure: failure });
    const original = h.files.get("src/orders.ts");
    await readFile(h, "src/orders.ts");
    expect((await invoke(h, "code.fs.edit", { path: "src/orders.ts", old_string: "return 1;", new_string: "return 2;" })).ok).toBe(true);
    const changed = h.files.get("src/orders.ts");
    failure.value = true;
    const undo = () => entry === "canonical tool"
      ? invoke(h, "code.fs.undo_last_turn", { confirm: true })
      : h.runtime.undoTurn(owner, { companyId: "company-c3", projectId: "project-c3", sessionId: "session-c3", turnId: "turn-1", toolCallId: "public-undo" });
    expect((await undo()).ok).toBe(false);
    expect(h.files.get("src/orders.ts")).toBe(changed);
    expect(h.runtime.turnSummary("session-c3", "turn-1").checkpointId).toBeTruthy();
    failure.value = false;
    expect((await undo()).ok).toBe(true);
    expect(h.files.get("src/orders.ts")).toBe(original);
  });
});
