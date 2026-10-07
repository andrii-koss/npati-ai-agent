import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  activitySinkForKind,
  createCodeRunActivitySink,
  splitActivityEvent,
} from "../apps/agent-api/src/code-run-activity-sink";
import { runMigration084 } from "../packages/workspace/src/migration-084";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { createCodeAgentSpawnExecutor, codeSubagentRunId } from "../apps/agent-api/src/code-agent-spawn-executor";

/**
 * C12 security-gate suite: the delegation tree is **visible**.
 *
 * Before this step `code_activity_events` (migration 077) had a `run_id` and a `snapshot_id` and no way to say
 * which run an event belonged *under*. Every sub-agent's tool calls, policy decisions and run transitions landed
 * in the same flat stream as its parent's, distinguishable only by reading each payload — so "what did the
 * children of this run do" was not a query anyone could write, and the owner's criterion (the tree must be
 * visible) was not met by the data model.
 *
 * Migration 084 adds `parent_run_id`, `parent_tool_call_id` and `parent_event_id` plus one partial index. This
 * suite pins:
 *
 *  - the migration is **additive** (expand only: three nullable columns and one index, no drop, no retype, no
 *    foreign key, no data rewrite) and is registered by the store;
 *  - the store round-trips the parent columns on both backends' shared contract, and `listCodeActivityEvents`
 *    filters by `parentRunId`, which is what makes one level of the tree a query;
 *  - a pre-C12 event has no parent — `NULL` is the honest reading of every row written before the tree existed;
 *  - the parent linkage is **identity, not payload**: it is split out by `splitActivityEvent` and therefore never
 *    reaches the metadata-only payload checker, and it cannot be confused with a payload key;
 *  - the delegation event the spawn executor writes really is a tree node: it belongs to the child run, names the
 *    parent run and the tool call, and carries the parent's snapshot.
 */

const COMPANY = "company-c12";
const WORKSPACE = "workspace-c12";
const SESSION = "session-c12";
const PARENT_RUN = "run-parent";
const CHILD_RUN = "sub-run-1";
const SNAPSHOT = "snapshot-1";

function makeSink(now = new Date("2026-02-02T03:04:05.000Z")) {
  const store = new InMemoryWorkspaceStore();
  const sink = createCodeRunActivitySink({
    store,
    workspaceId: WORKSPACE,
    classification: { resolve: () => ({ dataClassification: "confidential", retentionClass: "standard" }) },
    now: () => now,
  });
  return { store, sink };
}

describe("security-gate: C12 migration 084 is additive and indexed", () => {
  const source = readFileSync("packages/workspace/src/migration-084.ts", "utf8");
  /**
   * The SQL alone, with the comments removed: the prose legitimately explains what is *not* here ("not a foreign
   * key", "`WHERE parent_run_id IS NOT NULL`"), and a scan that read the comments would fail on its own
   * documentation instead of on the statements.
   */
  const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("only adds three nullable columns and one partial index", () => {
    // The whole migration is expand-only: an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block and a
    // `CREATE INDEX IF NOT EXISTS`. Anything destructive would have to appear here.
    expect(sql).toMatch(/ALTER TABLE code_activity_events/);
    for (const column of ["parent_run_id", "parent_tool_call_id", "parent_event_id"]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} text`));
    }
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS code_activity_events_parent_idx/);
    // Partial, so it holds one entry per delegated event and nothing for the main runs.
    expect(sql).toMatch(/WHERE parent_run_id IS NOT NULL/);
    // Every added column is nullable and defaultless: an existing row gets `NULL`, which is the honest reading of
    // "this event has no parent". `ADD COLUMN ... NOT NULL` without a default would fail on a non-empty table.
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS parent_\w+ text NOT NULL/);
    // Nothing destructive, and no foreign key: Activity events are append-only and are pruned independently by
    // retention, so a hard reference would make retention fail or cascade a child's evidence away with its parent.
    for (const forbidden of ["DROP ", "DELETE ", "UPDATE ", "TRUNCATE", "REFERENCES ", "FOREIGN KEY"]) {
      expect(sql, `migration 084 must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Exactly two statements, so a later edit cannot hide a third one behind the two that are asserted.
    expect(sql.match(/client\.query\(/g)).toHaveLength(2);
  });

  it("is registered by the postgres store, which is what makes it run at all", () => {
    const store = readFileSync("packages/workspace/src/postgres-store.ts", "utf8");
    expect(store).toMatch(/await import\("\.\/migration-084"\)/);
    expect(store).toMatch(/INSERT INTO schema_migrations\(version\) VALUES \('084_code_activity_parents'\)/);
    expect(store).toMatch(/SELECT 1 FROM schema_migrations WHERE version='084_code_activity_parents'/);
  });

  it("runs against a client as three column additions and one index, in that order", async () => {
    const statements: string[] = [];
    const client = { async query(sql: string) { statements.push(sql); return { rows: [] }; } };
    await runMigration084(client as never);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("parent_run_id");
    expect(statements[1]).toContain("code_activity_events_parent_idx");
  });

  it("carries the three columns in the store's own select list, aliased the way the record reads them", () => {
    const store = readFileSync("packages/workspace/src/postgres-store.ts", "utf8");
    expect(store).toMatch(/parent_run_id AS "parentRunId", parent_tool_call_id AS "parentToolCallId", parent_event_id AS "parentEventId"/);
    // And the row mapper reads exactly those aliases, so a missing column cannot silently become `undefined`.
    expect(store).toMatch(/parentRunId: row\.parentRunId/);
    expect(store).toMatch(/parentToolCallId: row\.parentToolCallId/);
    expect(store).toMatch(/parentEventId: row\.parentEventId/);
  });
});

describe("security-gate: C12 the delegation tree is queryable", () => {
  async function seedTree() {
    const { store, sink } = makeSink();
    // The parent's own event: a root of the tree.
    await sink.record(
      { kind: "run_activity", companyId: COMPANY, sessionId: SESSION, runId: PARENT_RUN, snapshotId: SNAPSHOT },
      { action: "run_started" },
    );
    // Two delegations, i.e. two children of the same parent.
    for (const [index, toolCallId] of ["call-1", "call-2"].entries()) {
      await sink.record(
        {
          kind: "run_activity", companyId: COMPANY, sessionId: SESSION, runId: `sub-run-${index + 1}`,
          snapshotId: SNAPSHOT, parentRunId: PARENT_RUN, parentToolCallId: toolCallId,
        },
        { action: "subagent_delegated", agentType: index === 0 ? "explore" : "implement" },
      );
    }
    // A grandchild would be a depth-2 node. The store can express one (it is a reference, not a policy), and the
    // fact that the **tool** cannot create one is pinned by the scope suite; the store is asserted to hold only
    // what it is given.
    await sink.record(
      {
        kind: "run_activity", companyId: COMPANY, sessionId: SESSION, runId: "sub-run-3",
        parentRunId: "sub-run-1", parentToolCallId: "call-3",
      },
      { action: "subagent_delegated", agentType: "test" },
    );
    return { store, sink };
  }

  it("returns exactly one level of the tree for a parent run, and the parent not at all", async () => {
    const { store } = await seedTree();
    const children = await store.listCodeActivityEvents({ companyId: COMPANY, parentRunId: PARENT_RUN });
    expect(children).toHaveLength(2);
    expect(children.map((event) => event.runId).sort()).toEqual(["sub-run-1", "sub-run-2"]);
    for (const child of children) {
      expect(child.parentRunId).toBe(PARENT_RUN);
      expect(child.parentToolCallId).toMatch(/^call-[12]$/);
      // One level: the grandchild hangs under a child, not under the parent.
      expect(child.runId).not.toBe("sub-run-3");
    }
    // The parent's own event is not a child of itself: the tree is not "every event of the session".
    expect(children.map((event) => event.runId)).not.toContain(PARENT_RUN);

    // And the parent's own stream still reads by run id, unchanged.
    const parentEvents = await store.listCodeActivityEvents({ companyId: COMPANY, runId: PARENT_RUN });
    expect(parentEvents).toHaveLength(1);
    expect(parentEvents[0]!.parentRunId).toBeNull();

    // The grandchild is reachable from its own parent.
    const grandchildren = await store.listCodeActivityEvents({ companyId: COMPANY, parentRunId: "sub-run-1" });
    expect(grandchildren.map((event) => event.runId)).toEqual(["sub-run-3"]);
  });

  it("keeps a pre-C12 event parentless instead of inventing a relationship", async () => {
    const { store, sink } = makeSink();
    // No parent fields at all: exactly how every event written before this migration looks.
    await sink.record({ kind: "code_tool_activity", companyId: COMPANY, runId: PARENT_RUN }, { tool: "code.fs.read" });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event!.parentRunId).toBeNull();
    expect(event!.parentToolCallId).toBeNull();
    expect(event!.parentEventId).toBeNull();
    // `NULL` is not a wildcard: a parent filter does not match it.
    expect(await store.listCodeActivityEvents({ companyId: COMPANY, parentRunId: PARENT_RUN })).toEqual([]);
  });

  it("never lets another company see a delegation", async () => {
    const { store } = await seedTree();
    expect(await store.listCodeActivityEvents({ companyId: "company-other", parentRunId: PARENT_RUN })).toEqual([]);
  });

  it("treats the parent linkage as identity, so it can never be mistaken for payload", async () => {
    const { identity, payload } = splitActivityEvent({
      kind: "run_activity",
      companyId: COMPANY,
      runId: CHILD_RUN,
      parentRunId: PARENT_RUN,
      parentToolCallId: "call-1",
      parentEventId: "evt-parent",
      action: "subagent_delegated",
    });
    expect(identity).toMatchObject({ parentRunId: PARENT_RUN, parentToolCallId: "call-1", parentEventId: "evt-parent" });
    // Not in the payload: the metadata-only checker is never asked about a field it would reject.
    expect(payload).toEqual({ action: "subagent_delegated" });
    expect(Object.keys(payload)).not.toContain("parentRunId");
  });

  it("still refuses a content payload on a delegation event", async () => {
    const { store, sink } = makeSink();
    await expect(sink.record(
      {
        kind: "run_activity", companyId: COMPANY, runId: CHILD_RUN,
        parentRunId: PARENT_RUN, parentToolCallId: "call-1",
      },
      { action: "subagent_delegated", content: "a file body the child read" },
    )).rejects.toMatchObject({ code: "activity_payload_must_not_carry_content" });
    expect(await store.listCodeActivityEvents({ companyId: COMPANY })).toEqual([]);
  });

  it("shows a real delegation, written by the spawn executor, as a tree node", async () => {
    // End to end on the real sink and the real store: the event the delegation executor records is what the tree
    // query finds, with its parent, its tool call and its snapshot. This is the assertion behind "the tree is
    // visible" — not a hand-written row, but the row the tool actually writes.
    const { store, sink } = makeSink();
    const executor = createCodeAgentSpawnExecutor({
      childRunner: () => ({
        async run(request) {
          return { runId: request.runId, status: "completed", answer: JSON.stringify({ findings: [{ kind: "file", path: "src/index.ts", name: null, detail: "the entry point" }], files: ["src/index.ts"], symbols: [] }) };
        },
      }),
      canonicalTools: () => CODE_TOOL_SCHEMAS.map((tool) => tool.name),
      activity: sink,
    });
    await executor({
      ctx: { userId: "user-c12", workspaceId: WORKSPACE, permissions: ["workspace:write"] },
      companyId: COMPANY, projectId: "project-c12", sessionId: SESSION,
      runId: PARENT_RUN, toolCallId: "call-1", snapshotId: SNAPSHOT,
      tool: { name: "code.agent.spawn", version: 1, status: "active", description: "", inputSchema: {}, outputSchema: {} },
      args: { agentType: "explore", task: "find the entry point", paths: ["src"] },
      limits: {} as never,
      port: { async listDir() { return { entries: [] }; }, async readFile() { throw new Error("unused"); }, async runSearch() { return { matches: [], truncated: false }; } },
    } as never);

    const children = await store.listCodeActivityEvents({ companyId: COMPANY, parentRunId: PARENT_RUN });
    expect(children).toHaveLength(1);
    const [child] = children;
    expect(child!.parentRunId).toBe(PARENT_RUN);
    expect(child!.parentToolCallId).toBe("call-1");
    expect(child!.snapshotId).toBe(SNAPSHOT);
    expect(child!.runId).toBe(codeSubagentRunId(PARENT_RUN, "call-1"));
    expect(child!.payload).toMatchObject({ action: "subagent_delegated", agentType: "explore", status: "completed" });
    // The metadata invariant held on the way in: no task text, no finding text, no file body.
    expect(JSON.stringify(child!.payload)).not.toContain("find the entry point");
    expect(JSON.stringify(child!.payload)).not.toContain("the entry point");
  });
});
