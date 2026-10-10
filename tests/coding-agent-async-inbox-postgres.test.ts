import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore, resolveCodeRetentionWindows, type AuthContext } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodeAsyncProcessService } from "../apps/agent-api/src/code-async-process";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import { CodeProcessCompletionService } from "../apps/agent-api/src/code-process-completions";
import { runMigration088 } from "../packages/workspace/src/migration-088";
import { runMigration089 } from "../packages/workspace/src/migration-089";
import { runWithCleanup } from "./support/run-with-cleanup";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl || process.env.NPATI_SECURITY_GATE_DB !== "1")("async inbox: PostgreSQL durability", () => {
  it("migrates additively, serializes admission across pools and survives a store restart", async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const name = `npati_inbox_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    const store = new PostgresWorkspaceStore(url.toString());
    const other = new PostgresWorkspaceStore(url.toString());
    const restarted = new PostgresWorkspaceStore(url.toString());
    const pool = new Pool({ connectionString: url.toString() });
    let storeClosed = false;
    let collector: CodeProcessCompletionService | undefined;
    let observer: CodeAsyncProcessService | undefined;
    let rootInbox: CodeSessionInboxService | undefined;
    await runWithCleanup(async () => {
      await admin.query(`CREATE DATABASE "${name}"`);
      const ctx: AuthContext = { userId: "inbox-user", workspaceId: "inbox-workspace", permissions: ["admin:all", "workspace:read", "workspace:write", "business:manage"] };
      await store.initialize(ctx);
      // Upgrade an installation that already committed 088: 089 must have its own migration gate.
      await pool.query("DROP TABLE code_process_projects");
      await pool.query("DELETE FROM schema_migrations WHERE version='089_code_process_projects'");
      await other.initialize(ctx);
      const company = await store.createCompany(ctx, { name: "Inbox DB test" }, "inbox-db-company");
      const project = await store.createProject(ctx, company.id, { name: "Inbox DB test", type: "code_project" }, "inbox-db-project");
      const session = await store.createCodeSession(ctx, company.id, project.project.id, { mode: "edit" });
      const scope = { companyId: company.id, projectId: project.project.id, sessionId: session.id,
        dataClassification: session.dataClassification, retentionClass: session.retentionClass };
      const log = new CodeRunStateLog({ store });
      for (const runId of ["a", "b"]) await log.startRun({ ctx, ...scope, owner: runId, runId });
      const reserve = { kind: "reserve" as const, operationId: randomUUID(), processId: randomUUID(), executionKey: JSON.stringify([scope.companyId, scope.projectId, scope.sessionId, "a", "process-call"]), payloadHash: "same-payload", runId: "a", owner: "a", agentId: "system", startedRevision: session.revision };
      const processes = await Promise.all([
        store.codeProcesses.transact(scope, reserve),
        other.codeProcesses.transact(scope, { ...reserve, operationId: randomUUID(), processId: randomUUID() }),
      ]);
      expect(processes[0].operations[0]!.processId).toBe(processes[1].operations[0]!.processId);
      // Either pool may win admission; subsequent controls must use the committed identity.
      const process = processes[0].operations[0]!;
      expect(process.operationId).toBe(processes[1].operations[0]!.operationId);
      await expect(other.codeProcesses.transact(scope, { ...reserve, payloadHash: "different" })).rejects.toMatchObject({ code: "process_request_conflict" });
      await store.codeProcesses.transact(scope, { kind: "claim", operationId: process.operationId, owner: "a" });
      await pool.query("UPDATE code_run_states SET status='completed' WHERE company_id=$1 AND run_id='a'", [scope.companyId]);
      await expect(store.codeProcesses.transact(scope, { kind: "update", operationId: process.operationId, owner: "a", generation: 1, state: "dispatching", sandboxId: "sandbox" }))
        .rejects.toMatchObject({ code: "process_lease_lost" });
      await pool.query("UPDATE code_run_states SET status='running' WHERE company_id=$1 AND run_id='a'", [scope.companyId]);
      await store.codeProcesses.transact(scope, { kind: "update", operationId: process.operationId, owner: "a", generation: 1, state: "dispatching", sandboxId: "sandbox",
        workspaceSnapshot: { version: 2, sandboxId: "sandbox", mounted: true, files: [{ path: "src/a.ts", hash: "baseline-hash", revision: "1" }] } });
      expect((await other.codeProcesses.transact(scope, { kind: "read" })).operations[0]!.workspaceSnapshot).toMatchObject({ version: 2, mounted: true, files: [{ hash: "baseline-hash" }] });
      expect((await other.codeProcesses.transact(scope, { kind: "cleanup-acquire", token: "cleanup" })).cleanupAcquired).toBe(false);
      await pool.query("UPDATE code_run_states SET lease_owner='replacement' WHERE company_id=$1 AND run_id='a'", [scope.companyId]);
      const adoptedProcess = await other.codeProcesses.transact(scope, { kind: "adopt", operationId: process.operationId, owner: "replacement" });
      expect(adoptedProcess.operations[0]!.generation).toBe(2);
      await expect(store.codeProcesses.transact(scope, { kind: "update", operationId: process.operationId, owner: "a", generation: 1, state: "running" })).rejects.toMatchObject({ code: "process_lease_lost" });
      await other.codeProcesses.transact(scope, { kind: "update", operationId: process.operationId, owner: "replacement", generation: 2, state: "running" });
      await other.codeProcesses.transact(scope, { kind: "update", operationId: process.operationId, owner: "replacement", generation: 2, state: "completed", exitCode: 0, output: "database process output" });
      const completion = (await store.codeProcesses.transact(scope, { kind: "read" })).operations[0]!.completion!;
      expect(completion).toMatchObject({ deliveredAt: null, notice: { generation: 2 }, result: { output: "database process output", exitCode: 0 } });
      await pool.query("UPDATE code_process_projects SET updated_at='2020-01-01', retention_class='short' WHERE company_id=$1", [scope.companyId]);
      await other.codeDataLifecycle!.planCodeDataRetention({ companyId: scope.companyId, windows: resolveCodeRetentionWindows({ toolResultRetentionDays: 1, transcriptRetentionDays: 1 }), now: new Date(), dryRun: false });
      expect((await store.codeProcesses.transact(scope, { kind: "read" })).operations[0]!.completion?.notice.eventId).toBe(completion.notice.eventId);
      await Promise.all([store, other].map(s => s.codeProcesses.transact(scope, { kind: "completion-delivered", operationId: process.operationId, eventId: completion.notice.eventId, generation: 2 })));
      await Promise.all([store, other].map(s => s.codeProcesses.transact(scope, { kind: "completion-admit", operationId: process.operationId, eventId: completion.notice.eventId, generation: 2, runId: "a", owner: "replacement", turnIndex: 1, source: "wait", canonicalResult: "database process output" })));
      const recorded = (await store.codeProcesses.transact(scope, { kind: "read" })).operations[0]!;
      expect(recorded.events.filter(e => e.type === "completion.delivered")).toHaveLength(1);
      expect(recorded.events.filter(e => e.type === "result.admitted")).toHaveLength(1);
      await pool.query("UPDATE code_run_states SET lease_owner='a' WHERE company_id=$1 AND run_id='a'", [scope.companyId]);
      const admissions = await Promise.allSettled([
        store.codeInbox.transact(scope, { kind: "open", runId: "a", owner: "a" }),
        other.codeInbox.transact(scope, { kind: "open", runId: "b", owner: "b" }),
      ]);
      expect(admissions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const current = (await store.codeInbox.transact(scope, { kind: "read" })).state.runId!;
      const accepts = await Promise.all([
        store.codeInbox.transact(scope, { kind: "submit", id: "db-message-a", requestId: "db-request", authorId: ctx.userId, text: "database", mode: "steer" }),
        other.codeInbox.transact(scope, { kind: "submit", id: "db-message-b", requestId: "db-request", authorId: ctx.userId, text: "database", mode: "steer" }),
      ]);
      expect(accepts[0].messages[0]!.id).toBe(accepts[1].messages[0]!.id);
      await expect(other.codeInbox.transact(scope, { kind: "submit", id: "changed-mode", requestId: "db-request", authorId: ctx.userId, text: "database", mode: "queue" }))
        .rejects.toMatchObject({ code: "inbox_request_conflict" });
      const admitted = await store.codeInbox.transact(scope, { kind: "drain", runId: current, owner: current, turnIndex: 2 });
      expect(admitted.messages).toHaveLength(1);
      await store.close();
      storeClosed = true;
      expect((await other.codeProcesses.transact(scope, { kind: "read", processId: process.processId })).operations[0])
        .toMatchObject({ operationId: process.operationId, state: "completed", generation: 2, output: { text: "database process output" } });
      const restored = await other.codeInbox.transact(scope, { kind: "open", runId: current, owner: current });
      expect(restored.messages[0]!).toMatchObject({ text: "database", status: "admitted", turnIndex: 2 });
      await expect(other.codeInbox.transact(scope, { kind: "submit", id: "changed-mode-after-restart", requestId: "db-request", authorId: ctx.userId, text: "database", mode: "queue" }))
        .rejects.toMatchObject({ code: "inbox_request_conflict" });
      const before = restored.state.revision;
      await expect(other.codeInbox.transact(scope, { kind: "drain", runId: current, owner: "stale", turnIndex: 3 })).rejects.toMatchObject({ code: "inbox_lease_lost" });
      expect((await other.codeInbox.transact(scope, { kind: "read" })).state.revision).toBe(before);
      await other.codeInbox.transact({ ...scope, dataClassification: "restricted", retentionClass: "until_deleted" },
        { kind: "submit", id: "classified-message", requestId: "classified-request", authorId: ctx.userId, text: "Check private database schema", mode: "queue" });
      await other.codeInbox.transact(scope, { kind: "submit", id: "later-message", requestId: "later-request", authorId: ctx.userId, text: "Check indexes", mode: "queue" });
      expect((await pool.query("SELECT data_classification,retention_class FROM code_session_inboxes WHERE company_id=$1 AND session_id=$2", [scope.companyId, scope.sessionId])).rows[0])
        .toEqual({ data_classification: "restricted", retention_class: "until_deleted" });
      const client = await pool.connect();
      try { await runMigration088(client); await runMigration088(client); await runMigration089(client); await runMigration089(client); } finally { client.release(); }
      expect((await other.codeInbox.transact(scope, { kind: "read" })).state.messages).toHaveLength(3);
      const sibling = await other.createCodeSession(ctx, company.id, project.project.id, { mode: "edit" });
      const siblingScope = { ...scope, sessionId: sibling.id };
      await new CodeRunStateLog({ store: other }).startRun({ ctx, ...siblingScope, owner: "sibling", runId: "sibling" });
      const siblingOp = { ...reserve, operationId: randomUUID(), processId: randomUUID(), runId: "sibling", owner: "sibling", executionKey: JSON.stringify([scope.companyId, scope.projectId, sibling.id, "sibling", "call"]) };
      await other.codeProcesses.transact(siblingScope, siblingOp);
      await expect(other.codeDataLifecycle!.eraseCodeData({ companyId: company.id, target: { kind: "project", projectId: project.project.id } })).rejects.toMatchObject({ code: "process_cleanup_blocked" });
      await other.codeProcesses.transact(siblingScope, { kind: "cancel", operationId: siblingOp.operationId });
      // Step 6: the child session and control state survive a fresh pool, with a distinct child lease.
      await restarted.initialize(ctx);
      const childInput = { mode: "edit" as const, parentSessionId: sibling.id, childKey: "control-child" };
      const [child, sameChild] = await Promise.all([
        other.createCodeSession(ctx, company.id, project.project.id, childInput),
        restarted.createCodeSession(ctx, company.id, project.project.id, childInput),
      ]);
      expect(child.id).toBe(sameChild.id);
      expect(child.id).not.toBe(sibling.id);
      const childScope = { ...scope, sessionId: child.id };
      const controlOperationId = randomUUID();
      await other.codeProcesses.transact(siblingScope, { kind: "reserve-child", operationId: controlOperationId,
        childRunId: "control-child", toolCallId: "control-call", agentType: "explore", runId: "sibling", owner: "sibling" });
      await other.codeProcesses.transact(siblingScope, { kind: "bind-child-session", childRunId: "control-child", childSessionId: child.id });
      await other.codeProcesses.transact(siblingScope, { kind: "update-child", childRunId: "control-child", state: "running", owner: "sibling" });
      const childLog = new CodeRunStateLog({ store: other });
      await childLog.startRun({ ctx, ...childScope, runId: "control-child", owner: "child-worker" });
      await other.codeInbox.transact(childScope, { kind: "open", runId: "control-child", owner: "child-worker" });
      await restarted.codeProcesses.transact(siblingScope, { kind: "cancel", operationId: controlOperationId });
      await childLog.markInterrupted({ companyId: company.id, runId: "control-child", reason: "subagent_interrupt", owner: "child-worker" });
      await other.codeProcesses.transact(siblingScope, { kind: "update-child", childRunId: "control-child", owner: "child-worker", state: "interrupted" });
      await expect(restarted.codeDataLifecycle!.eraseCodeData({ companyId: company.id, target: { kind: "session", sessionId: child.id } })).rejects.toMatchObject({ code: "process_cleanup_blocked" });
      await pool.query("UPDATE code_process_projects SET updated_at='2020-01-01',retention_class='short' WHERE company_id=$1", [company.id]);
      await pool.query("UPDATE code_run_states SET started_at='2020-01-01',retention_class='short' WHERE company_id=$1 AND run_id='control-child'", [company.id]);
      await restarted.codeDataLifecycle!.planCodeDataRetention({ companyId: company.id, windows: resolveCodeRetentionWindows({ toolResultRetentionDays: 1, transcriptRetentionDays: 1 }), now: new Date(), dryRun: false });
      expect((await childLog.loadRunState(company.id, "control-child"))?.status).toBe("interrupted");
      expect((await restarted.codeProcesses.transact(siblingScope, { kind: "read" })).operations.find(op => op.child?.runId === "control-child")?.state).toBe("interrupted");
      await restarted.codeInbox.transact(childScope, { kind: "submit", id: "paused-message", requestId: "paused-request", authorId: ctx.userId, text: "Inspect constraints", mode: "steer" });
      const resumedLog = new CodeRunStateLog({ store: restarted });
      expect((await resumedLog.resumeRun({ companyId: company.id, runId: "control-child", owner: "resumed-child" })).held).toBe(true);
      expect((await restarted.codeProcesses.transact(siblingScope, { kind: "continue-child", childRunId: "control-child", owner: "resumed-child", requestId: "continue-control" })).claimed).toBe(true);
      expect((await other.codeProcesses.transact(siblingScope, { kind: "continue-child", childRunId: "control-child", owner: "resumed-child", requestId: "continue-control" })).claimed).toBe(false);
      await restarted.codeInbox.transact(childScope, { kind: "resume-inputs", runId: "control-child", owner: "resumed-child" });
      await restarted.codeInbox.transact(childScope, { kind: "open", runId: "control-child", owner: "resumed-child" });
      expect((await restarted.codeInbox.transact(childScope, { kind: "drain", runId: "control-child", owner: "resumed-child", turnIndex: 2 })).messages[0]?.text).toBe("Inspect constraints");
      await resumedLog.markFinished({ companyId: company.id, runId: "control-child", status: "completed" });
      await expect(other.codeProcesses.transact(siblingScope, { kind: "update-child", childRunId: "control-child", owner: "child-worker", state: "failed" })).rejects.toMatchObject({ code: "process_lease_lost" });
      await restarted.codeProcesses.transact(siblingScope, { kind: "update-child", childRunId: "control-child", owner: "resumed-child", state: "completed" });
      // Step 7: a fresh collector joins durable PG operations, withholds readiness until result admission,
      // and ignores the cancelled reservation that never dispatched a producer.
      rootInbox = new CodeSessionInboxService({ store: restarted.codeInbox, flags: { assertEnabled: async () => true, isEnabled: async () => true },
        loadSession: (ctx, companyId, sessionId) => restarted.getCodeSession(ctx, companyId, sessionId),
        loadRunState: (companyId, runId) => restarted.getCodeRunState(companyId, runId), audit: async () => {} });
      const unexpected = async (): Promise<never> => { throw new Error("Child must not enter the shell process manager"); };
      observer = new CodeAsyncProcessService({ store: restarted.codeProcesses, flags: { assertEnabled: async () => true },
        session: (ctx, companyId, sessionId) => restarted.getCodeSession(ctx, companyId, sessionId), run: (companyId, runId) => restarted.getCodeRunState(companyId, runId),
        port: { supported: async () => true, start: unexpected, status: unexpected, output: unexpected, stop: unexpected, sync: unexpected } });
      collector = new CodeProcessCompletionService({ store: restarted.codeProcesses, processes: observer, inbox: rootInbox,
        loadSession: (ctx, companyId, sessionId) => restarted.getCodeSession(ctx, companyId, sessionId), enabled: async () => true, progress: () => {}, warn: () => {} });
      expect((await collector.barrier(ctx, sibling, "sibling")).ready).toBe(false);
      expect((await rootInbox.transact(sibling, { kind: "read" })).state.messages[0]?.target).toBe("next-turn");
      await rootInbox.transact(sibling, { kind: "open", runId: "sibling", owner: "sibling" });
      await other.codeInbox.transact(siblingScope, { kind: "collect-completions", runId: "sibling", owner: "sibling" });
      const notices = (await rootInbox.transact(sibling, { kind: "drain", runId: "sibling", owner: "sibling", turnIndex: 1 })).messages;
      const collected = (await collector.collect(ctx, sibling, notices[0]!, "sibling"))!;
      await collector.admitted(sibling, collected.notice, { runId: "sibling", owner: "sibling", turnIndex: 1, text: collected.text, source: "inbox" });
      expect((await collector.barrier(ctx, sibling, "sibling")).ready).toBe(true);
      expect((await other.codeProcesses.transact(siblingScope, { kind: "read" })).operations.find(op => op.child?.runId === "control-child")?.completion?.admission?.runId).toBe("sibling");
      const erased = await other.codeDataLifecycle!.eraseCodeData({ companyId: company.id, target: { kind: "session", sessionId: session.id } });
      expect(erased.verified).toBe(true);
      expect((await other.codeProcesses.transact(siblingScope, { kind: "read" })).operations[0]!.operationId).toBe(siblingOp.operationId);
      expect((await other.codeProcesses.transact(scope, { kind: "read" })).operations).toEqual([]);
    }, async () => {
      await collector?.close(); await observer?.close(); await rootInbox?.close(() => {});
      const resources = await Promise.allSettled([storeClosed ? Promise.resolve() : store.close(), other.close(), restarted.close(), pool.end()]);
      const failures = resources.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
      try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } catch (error) { failures.push(error); }
      try { await admin.end(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Inbox database cleanup failed");
    });
  }, 90_000);
});
