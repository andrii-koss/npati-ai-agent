import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import { AuditLogService, AuditUnavailableError } from "../apps/agent-api/src/audit-log";

/**
 * C1c database-level guarantees.
 *
 * These tests prove the properties that only PostgreSQL can provide (the append-only trigger, the
 * chain guard on INSERT and the REVOKE) and they therefore require a real database. They run in the
 * DB-backed job (`npm run gate:upgrade`, the Docker CI job and `SG-*` checkpoints). Without
 * `DATABASE_URL` the suite reports itself as skipped with a loud name so a security-gate run can see
 * that the DB portion was not executed — the in-memory security-gate suite
 * (`tests/coding-agent-c1c-audit-log.test.ts`) always runs and covers chain/hash/fail-closed/redaction.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const databaseNote = databaseUrl ? "" : " [SKIPPED: set DATABASE_URL to run the database-level audit guarantees]";

const context: AuthContext = { workspaceId: "ws-c1c-db", userId: "c1c-db-user", permissions: ["workspace:read", "business:manage", "admin:all"] };

describeDatabase(`security-gate: C1c database-level audit guarantees${databaseNote}`, () => {
  it("rejects UPDATE and DELETE on the journal even for the application role", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const store = new PostgresWorkspaceStore(databaseUrl!);
    try {
      await store.initialize();
      const company = await store.createCompany(context, { name: "C1c DB Co" }, `c1c-${Date.now()}`);
      const service = new AuditLogService(store, { verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true });
      const entry = await service.record(context, {
        companyId: company.id, actor: context.userId, actorRole: "admin", action: "db.test", resourceType: "test", decision: "allowed",
      });
      await expect(pool.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [entry.id])).rejects.toThrow(/append-only/i);
      await expect(pool.query("DELETE FROM audit_log WHERE id=$1", [entry.id])).rejects.toThrow(/append-only/i);
    } finally {
      await pool.end();
      await store.close();
    }
  });

  it("rejects a rogue INSERT that would fork or reorder the chain", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const store = new PostgresWorkspaceStore(databaseUrl!);
    try {
      await store.initialize();
      const company = await store.createCompany(context, { name: "C1c Fork Co" }, `c1c-fork-${Date.now()}`);
      const service = new AuditLogService(store, { verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true });
      await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "first", resourceType: "test", decision: "allowed" });
      const rogue = `INSERT INTO audit_log
        (id, workspace_id, company_id, sequence, actor, actor_role, action, resource_type, decision, payload_hash, prev_hash, entry_hash, metadata)
        VALUES('rogue-1',$1,$2,5,'attacker','admin','rogue','test','allowed','x','y','z','{}'::jsonb)`;
      await expect(pool.query(rogue, [context.workspaceId, company.id])).rejects.toThrow(/chain violation/i);
    } finally {
      await pool.end();
      await store.close();
    }
  });

  it("detects a raw out-of-band edit through verifyChain (simulated by disabling the trigger)", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const store = new PostgresWorkspaceStore(databaseUrl!);
    try {
      await store.initialize();
      const company = await store.createCompany(context, { name: "C1c Tamper Co" }, `c1c-tamper-${Date.now()}`);
      const service = new AuditLogService(store, { verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true });
      const first = await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "first", resourceType: "test", decision: "allowed" });
      await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "second", resourceType: "test", decision: "allowed" });

      // Only a superuser can do this: it simulates an administrator bypassing the application.
      await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
      await pool.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [first.id]);
      await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");

      const report = await service.verify(context, company.id);
      expect(report.ok).toBe(false);
      expect(report.brokenAtSequence).toBe(1);
      expect(report.alert).toContain("CRITICAL");
      // Fail closed: with a broken chain the service refuses new privileged writes.
      await expect(service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "third", resourceType: "test", decision: "allowed" }))
        .rejects.toBeInstanceOf(AuditUnavailableError);
    } finally {
      await pool.end();
      await store.close();
    }
  });
});
