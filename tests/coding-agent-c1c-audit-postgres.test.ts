import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore, auditEntryHash, type AuditEntry, type AuthContext } from "@npati/workspace";
import { AuditLogService, AuditUnavailableError } from "../apps/agent-api/src/audit-log";
import { databaseDescribe, missingDatabaseSkip } from "./support/database-describe";
import { runWithCleanup } from "./support/run-with-cleanup";

/**
 * C1c database-level guarantees — the half only PostgreSQL can provide.
 *
 * G1 (D1) rewrote this suite because it proved less than its name claimed, in two separate ways:
 *
 *  1. **It ran as the migration role.** Every adversarial statement went through `new Pool({ connectionString:
 *     DATABASE_URL })`, which in the escalated run is `postgres` — a superuser and the owner of every table
 *     migration 066 creates. A superuser bypasses `REVOKE` by definition and owns the trigger, so "UPDATE is
 *     refused" said only "the trigger fires for the owner". The suite now provisions an application role
 *     (`npati_g1_app`), proves from `pg_roles`/`pg_class` that it is neither a superuser nor the table's owner,
 *     and runs every adversarial statement through a **separate pool that logs in as that role**. The role is
 *     granted `UPDATE`/`DELETE` on purpose: the refusal has to come from the trigger while the privilege is
 *     present, and the privilege layer is proven separately (grant → refuse, revoke → `permission denied`).
 *  2. **Its cleanup replaced its failures.** `finally { await pool.end(); await store.close(); }` called a
 *     method that existed nowhere, so the `TypeError` from the teardown replaced the real assertion error —
 *     which is why this suite was reported as `store.close is not a function`. `runWithCleanup` now throws the
 *     **body** error and appends the cleanup failure to it, so the two can no longer trade places.
 *     `PostgresWorkspaceStore.close()` also really exists now (it ends the pool this store owns).
 *  3. **It never made the identity its own context names.** `initialize()` took no argument, so the store
 *     skipped `if (context) await this.ensureIdentity(context)`
 *     (`packages/workspace/src/postgres-store.ts:766`) and no `users`/`workspaces`/`workspace_members` rows
 *     existed for `ws-c1c-db`/`c1c-db-user`. The first `createCompany` therefore reached `assertMember`
 *     (`packages/workspace/src/postgres-store.ts:1804`) with an empty `workspace_members` lookup and threw
 *     `Workspace access denied` — **before** any append-only statement ran, so the suite that exists to prove
 *     D1 proved nothing. `initialize(context)` is the store's supported bootstrap (the in-memory backend does
 *     the same at `packages/workspace/src/in-memory-store.ts:127`, and `tests/chat-file-service.test.ts:17`
 *     and `tests/background-run-reporting.test.ts:13` call it that way). The refusal was correct: the store
 *     refuses a member it was never told about, and the missing fact was the test's argument, not the guard.
 *  4. **It never read its own chain back.** Before G1 (item 2) no test in this file called `service.verify`
 *     on an entry the store had just written — the only `verify` call asserted `ok: false` after a deliberate
 *     edit. That is the gap this fix was hiding in: `appendAuditEntry` hashes `new Date().toISOString()` and a
 *     numeric `sequence`, while the reader returned a `Date` (which `canonicalJson` renders as `{}`) and the
 *     `bigint` `sequence` as the string `"1"`, so **every** real entry failed with
 *     `entry_hash does not match the entry content` — a false CRITICAL that `AuditLogService` then turned into
 *     a block on privileged writes. A bare `ok === true` would not even name the cause: fixing `createdAt`
 *     alone leaves the identical reason and the identical `brokenAtSequence`, which is why every test below
 *     now asserts the round trip field by field — `entryCount`, `brokenAtSequence`, `headHash`, the reader's
 *     `typeof` for both columns, and the hash recomputed from the returned row
 *     (`recomputedChainHashes`) against the hash the writer stored.
 *
 * Non-vacuity is **measured, not argued**: with the trigger disabled (an owner-only statement the application
 * role is shown to be refused) the very same `UPDATE` succeeds, so the refusal above is the trigger; the same
 * removal is applied to the chain guard for the rogue `INSERT`.
 *
 * This suite belongs to the **DB gate**, not to the hermetic `security-gate` list: a database suite there would
 * make the hermetic gate red on every machine without PostgreSQL. `npm run security-gate:db` requires
 * `DATABASE_URL` (a missing value is an immediate failure, never a skip) and sets `NPATI_SECURITY_GATE_DB=1`,
 * which this file requires too — so a plain `npm test` never runs these assertions against whatever
 * `DATABASE_URL` a developer happens to have exported (which would move the 10 files / 15 tests baseline).
 *
 * The connection must be the **administrative** one: it owns the schema (it ran the migrations) and it must be
 * allowed to `CREATE ROLE`/`DROP ROLE`, because the suite provisions the application role it measures. A role
 * without those privileges fails loudly on the first `CREATE ROLE` instead of measuring itself by accident.
 */
const databaseUrl = process.env.DATABASE_URL;
const databaseGateRequested = process.env.NPATI_SECURITY_GATE_DB === "1";
const databaseGateRunning = Boolean(databaseUrl) && databaseGateRequested;
const describeDatabase = databaseDescribe(
  databaseGateRunning,
  describe,
  typeof describe.skip === "function"
    ? describe.skip
    : (name: string) => missingDatabaseSkip(name),
);
const databaseNote = databaseGateRunning
  ? ""
  : " [SKIPPED: run `npm run security-gate:db`, which requires DATABASE_URL and is never skipped]";

const context: AuthContext = {
  workspaceId: "ws-c1c-db",
  userId: "c1c-db-user",
  permissions: ["workspace:read", "business:manage", "admin:all"],
};

/** The application role. Deliberately **not** the role `DATABASE_URL` names: that one owns the schema here. */
const APP_ROLE = "npati_g1_app";
/** Local test credential for a role that is dropped at the end of every test; never a deployment secret. */
const APP_ROLE_PASSWORD = "npati_g1_app_local";

const auditConfig = { verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true };

/** A unique idempotency key per call, so a rerun creates a new company instead of returning the old one. */
function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * G1 (D1): the hash the verifier must be able to recompute for every entry, built **from the fields the
 * reader returned**.
 *
 * This is the measurement the suite was missing. `appendAuditEntry` hashes a material in which `createdAt` is
 * `new Date().toISOString()` (a string) and `sequence` is a JavaScript number; `canonicalJson` renders a
 * `Date` as `{}` and a numeric string as `"1"`, so a reader that returns either of those forms silently
 * changes the hash material. Asserting only `ok === false` cannot tell that apart from a genuinely broken
 * chain, and asserting only `ok === true` cannot say which field was wrong. Walking the returned rows and
 * comparing the recomputed hash with the stored one names the answer for every field at once.
 */
function recomputedChainHashes(entries: AuditEntry[]): string[] {
  let prevHash: string | null = null;
  return entries.map((entry) => {
    const hash = auditEntryHash(prevHash, {
      id: entry.id, companyId: entry.companyId, sequence: entry.sequence, createdAt: entry.createdAt,
      actor: entry.actor, actorRole: entry.actorRole,
      requestId: entry.requestId ?? null, correlationId: entry.correlationId ?? null, snapshotId: entry.snapshotId ?? null,
      action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null, decision: entry.decision, payloadHash: entry.payloadHash,
      metadata: entry.metadata ?? {},
    });
    prevHash = entry.entryHash;
    return hash;
  });
}

/**
 * The shape a store row must have for the chain to verify: `createdAt` is the ISO-8601 string the writer
 * hashed (milliseconds, literal `Z`) and `sequence` is a number (the `bigint` column arrives from `pg` as
 * text, which is what the writer already compensates for when it reads the head).
 */
function readerShape(entries: AuditEntry[]): Array<{ sequence: number; sequenceType: string; createdAtType: string }> {
  return entries.map((entry) => ({ sequence: entry.sequence, sequenceType: typeof entry.sequence, createdAtType: typeof entry.createdAt }));
}

/** The same connection with the application role's credentials substituted — no other field is touched. */
function applicationRoleUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_ROLE_PASSWORD;
  return parsed.toString();
}

interface DatabaseFixture {
  /** The administrative connection: migrations, role provisioning and the owner-only bypass operations. */
  admin: Pool;
  /** A separate pool that really authenticates as `APP_ROLE`, not as the administrative role. */
  app: Pool;
  store: PostgresWorkspaceStore;
}

function openFixture(): DatabaseFixture {
  const url = String(databaseUrl);
  return {
    admin: new Pool({ connectionString: url }),
    app: new Pool({ connectionString: applicationRoleUrl(url) }),
    store: new PostgresWorkspaceStore(url),
  };
}

/**
 * Creates (or recreates) the application role, granting it everything a *legitimate* appender needs and
 * `UPDATE`/`DELETE` on top so the trigger — not a missing grant — is what the suite measures. `DROP OWNED BY`
 * first makes the provision idempotent across reruns.
 */
async function provisionApplicationRole(admin: Pool): Promise<void> {
  await admin.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      EXECUTE 'DROP OWNED BY ${APP_ROLE}';
      EXECUTE 'DROP ROLE ${APP_ROLE}';
    END IF;
  END $$`);
  await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
  const database = await admin.query<{ name: string }>("SELECT current_database() AS name");
  await admin.query(`GRANT CONNECT ON DATABASE "${database.rows[0]!.name}" TO ${APP_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO ${APP_ROLE}`);
}

/** Removes the role again, including anything granted to it. Idempotent, so a half-run test still cleans up. */
async function dropApplicationRole(admin: Pool): Promise<void> {
  await admin.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      EXECUTE 'DROP OWNED BY ${APP_ROLE}';
      EXECUTE 'DROP ROLE ${APP_ROLE}';
    END IF;
  END $$`);
}

/**
 * Releases the fixture in the only order that works: the application role's own connections first (a role
 * cannot be dropped out from under a live session), then the role, then the store's pool.
 */
async function closeFixture(fixture: DatabaseFixture): Promise<void> {
  await fixture.app.end();
  await dropApplicationRole(fixture.admin);
  await fixture.store.close();
  await fixture.admin.end();
}

/** The facts that make "the application role" a real restriction rather than a second name for the superuser. */
async function applicationRoleFacts(app: Pool): Promise<{ currentUser: string; isSuperuser: boolean; tableOwner: string }> {
  const result = await app.query<{ current_user: string; rolsuper: boolean | null; owner: string | null }>(
    `SELECT current_user AS current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
            (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'audit_log' AND relnamespace = 'public'::regnamespace) AS owner`,
  );
  const row = result.rows[0]!;
  return { currentUser: row.current_user, isSuperuser: Boolean(row.rolsuper), tableOwner: String(row.owner) };
}

/** Turns both triggers of the append-only journal off (owner-only) and returns the restorer. */
async function withoutTriggers<T>(admin: Pool, body: () => Promise<T>): Promise<T> {
  await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_chain_guard");
  try {
    return await body();
  } finally {
    await admin.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_chain_guard");
    await admin.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
  }
}

describeDatabase(`security-gate: C1c database-level audit guarantees${databaseNote}`, () => {
  it("rejects UPDATE and DELETE under the application role even while that role holds the privileges", async () => {
    const fixture = openFixture();
    await runWithCleanup(async () => {
      await fixture.store.initialize(context);
      await provisionApplicationRole(fixture.admin);

      // The role is a restriction, not the same connection under another name. Without this the rest of the
      // test would be a superuser test with extra steps.
      const facts = await applicationRoleFacts(fixture.app);
      expect(facts.currentUser).toBe(APP_ROLE);
      expect(facts.isSuperuser).toBe(false);
      expect(facts.tableOwner).not.toBe(APP_ROLE);
      // …and the owner-only escape hatch is closed to it: the bypass needs more privilege than the app has.
      await expect(fixture.app.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only"))
        .rejects.toThrow(/must be owner of table|permission denied/i);

      const company = await fixture.store.createCompany(context, { name: "C1c DB Co" }, uniqueKey("c1c-db"));
      const service = new AuditLogService(fixture.store, auditConfig);
      const entry = await service.record(context, {
        companyId: company.id, actor: context.userId, actorRole: "admin", action: "db.test", resourceType: "test", decision: "allowed",
        // Non-empty metadata on purpose: it travels through `jsonb`, whose key order is not the insertion
        // order, so the canonical form has to survive the round trip as well.
        metadata: { nested: { beta: 2, alpha: [1, "two", null] }, count: 3 },
      });
      const before = await fixture.admin.query<{ metadata: unknown }>("SELECT metadata FROM audit_log WHERE id=$1", [entry.id]);

      // The refusal is the trigger, not a missing grant: `provisionApplicationRole` granted UPDATE and DELETE.
      await expect(fixture.app.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [entry.id]))
        .rejects.toThrow(/append-only/i);
      await expect(fixture.app.query("DELETE FROM audit_log WHERE id=$1", [entry.id]))
        .rejects.toThrow(/append-only/i);
      // The migration's `REVOKE … FROM PUBLIC` is in force as well: no explicit ACL entry hands a privilege to
      // the pseudo-role. (A revoke that had nothing to revoke leaves `relacl` NULL and is therefore invisible
      // here — what makes the privilege layer load-bearing is the REVOKE test below, which takes a real grant
      // away and watches the same statement become `permission denied`.)
      const publicAcl = await fixture.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relname = 'audit_log' AND c.relnamespace = 'public'::regnamespace
            AND a.grantee = 0 AND a.privilege_type IN ('UPDATE','DELETE','TRUNCATE')`,
      );
      expect(publicAcl.rows[0]!.n).toBe(0);

      // Non-vacuity, measured: remove the trigger and the identical statement **succeeds**, so the refusal
      // above cannot be an accident of privileges, of a missing row or of a typo in the SQL.
      const tamperError = await withoutTriggers(fixture.admin, async () => {
        try {
          await fixture.app.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [entry.id]);
          return null;
        } catch (error) {
          return error;
        }
      });
      expect(tamperError).toBeNull();
      // …and with the trigger back the same statement is refused again, which is what makes the control above
      // a statement about the trigger rather than about the window in which it was disabled.
      await expect(fixture.app.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [entry.id]))
        .rejects.toThrow(/append-only/i);

      // The privilege layer on its own: revoking the grant makes even a trigger-free UPDATE fail.
      const privilegeError = await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${APP_ROLE}`);
        try {
          await fixture.app.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [entry.id]);
          return null;
        } catch (error) {
          return error;
        }
      });
      expect(String(privilegeError)).toMatch(/permission denied/i);
      await fixture.admin.query(`GRANT UPDATE, DELETE ON audit_log TO ${APP_ROLE}`);

      // Repair: the row is restored to its original bytes (metadata participates in `entry_hash`, so this also
      // restores the chain) and the journal verifies again.
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("UPDATE audit_log SET metadata=$1::jsonb WHERE id=$2", [JSON.stringify(before.rows[0]!.metadata), entry.id]);
      });

      /**
       * G1 (D1) round trip — `appendAuditEntry` writes, the store's own reader reads, the real verifier
       * recomputes. Every field the reader returns participates in the hash, so a row that verifies is a row
       * whose bytes the reader reproduced exactly; before the fix this failed for *every* entry, which is what
       * the suite never checked.
       */
      const listed = await fixture.store.listAuditEntries(context, company.id);
      expect(readerShape(listed)).toEqual([{ sequence: 1, sequenceType: "number", createdAtType: "string" }]);
      expect(listed[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // The metadata survives `jsonb` in its canonical form (the hash is over the canonical form, not the
      // insertion order of its keys).
      expect(listed[0]!.metadata).toEqual({ nested: { beta: 2, alpha: [1, "two", null] }, count: 3 });
      expect(recomputedChainHashes(listed)).toEqual(listed.map((row) => row.entryHash));

      const verified = await service.verify(context, company.id);
      expect(verified.ok).toBe(true);
      expect(verified.entryCount).toBe(1);
      expect(verified.brokenAtSequence).toBeUndefined();
      expect(verified.reason).toBeUndefined();
      expect(verified.alert).toBeUndefined();
      // The head is the hash the store itself returned from the INSERT, not a hash invented by the reader.
      expect(verified.headHash).toBe(entry.entryHash);
      expect(await fixture.store.verifyAuditChain(context, company.id)).toEqual({
        companyId: company.id, ok: true, entryCount: 1, headHash: entry.entryHash,
      });
    }, () => closeFixture(fixture));
  }, 60_000);

  it("rejects a rogue INSERT that would fork the chain under the application role", async () => {
    const fixture = openFixture();
    await runWithCleanup(async () => {
      await fixture.store.initialize(context);
      await provisionApplicationRole(fixture.admin);
      const company = await fixture.store.createCompany(context, { name: "C1c Fork Co" }, uniqueKey("c1c-fork"));
      const service = new AuditLogService(fixture.store, auditConfig);
      const first = await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "first", resourceType: "test", decision: "allowed" });

      const rogueId = uniqueKey("rogue");
      const rogue = `INSERT INTO audit_log
        (id, workspace_id, company_id, sequence, actor, actor_role, action, resource_type, decision, payload_hash, prev_hash, entry_hash, metadata)
        VALUES($1,$2,$3,5,'attacker','admin','rogue','test','allowed','x','y','z','{}'::jsonb)`;
      // The message is specific to the chain guard, which is what distinguishes this refusal from a privilege
      // error: the application role holds INSERT (`provisionApplicationRole`), so the insert really reaches the
      // trigger and is refused by the chain rule.
      await expect(fixture.app.query(rogue, [rogueId, context.workspaceId, company.id]))
        .rejects.toThrow(/chain violation/i);

      // Non-vacuity: with the chain guard removed the identical statement succeeds, so the refusal above is
      // that trigger. The forged row is deleted again inside the same disabled window, which leaves the test
      // company's chain exactly as it was.
      const forgedError = await withoutTriggers(fixture.admin, async () => {
        try {
          await fixture.app.query(rogue, [rogueId, context.workspaceId, company.id]);
          return null;
        } catch (error) {
          return error;
        }
      });
      expect(forgedError).toBeNull();
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("DELETE FROM audit_log WHERE id=$1", [rogueId]);
      });

      // …and the guard is back.
      await expect(fixture.app.query(rogue, [rogueId, context.workspaceId, company.id]))
        .rejects.toThrow(/chain violation/i);

      /**
       * G1 (D1) round trip over a two-entry chain the store wrote: the refused rogue INSERT left no trace, so
       * the legitimate chain continues at the very next sequence and the real reader reproduces both entries.
       * `sequence` arrives from `pg` as a string unless the read list casts it, and that alone changes the
       * hash material — which is why the shape and the recomputed hash are asserted, not only `ok`.
       */
      const second = await service.record(context, {
        companyId: company.id, actor: context.userId, actorRole: "admin", action: "second", resourceType: "test", decision: "allowed",
      });
      expect(second.sequence).toBe(2);
      expect(second.prevHash).toBe(first.entryHash);
      const listed = await fixture.store.listAuditEntries(context, company.id);
      expect(listed.map((row) => row.action)).toEqual(["first", "second"]);
      expect(readerShape(listed)).toEqual([
        { sequence: 1, sequenceType: "number", createdAtType: "string" },
        { sequence: 2, sequenceType: "number", createdAtType: "string" },
      ]);
      expect(recomputedChainHashes(listed)).toEqual([first.entryHash, second.entryHash]);
      const verified = await service.verify(context, company.id);
      expect(verified.ok).toBe(true);
      expect(verified.entryCount).toBe(2);
      expect(verified.brokenAtSequence).toBeUndefined();
      expect(verified.headHash).toBe(second.entryHash);
      expect(await fixture.store.verifyAuditChain(context, company.id)).toEqual({
        companyId: company.id, ok: true, entryCount: 2, headHash: second.entryHash,
      });
    }, () => closeFixture(fixture));
  }, 60_000);

  it("detects a raw out-of-band edit through verifyChain (simulated by disabling the trigger)", async () => {
    const fixture = openFixture();
    await runWithCleanup(async () => {
      await fixture.store.initialize(context);
      await provisionApplicationRole(fixture.admin);
      const facts = await applicationRoleFacts(fixture.app);
      // The bypass below is owner-only, and the application role is proven unable to perform it (see the first
      // test): the tamper models an administrator reaching around the application, not the application itself.
      expect(facts.isSuperuser).toBe(false);
      expect(facts.tableOwner).not.toBe(APP_ROLE);

      const company = await fixture.store.createCompany(context, { name: "C1c Tamper Co" }, uniqueKey("c1c-tamper"));
      const service = new AuditLogService(fixture.store, auditConfig);
      const first = await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "first", resourceType: "test", decision: "allowed" });
      const second = await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "second", resourceType: "test", decision: "allowed" });

      /**
       * G1 (D1) round trip **before** any tampering: the untampered chain verifies *and* the reader returns the
       * material the writer hashed. Without it the two are indistinguishable — a reader that mangles
       * `createdAt`/`sequence` and the deliberate edit below both answer `ok: false` with the same
       * `entry_hash does not match the entry content`, so the old suite could not say which one it had found.
       */
      const clean = await fixture.store.listAuditEntries(context, company.id);
      expect(readerShape(clean)).toEqual([
        { sequence: 1, sequenceType: "number", createdAtType: "string" },
        { sequence: 2, sequenceType: "number", createdAtType: "string" },
      ]);
      expect(recomputedChainHashes(clean)).toEqual([first.entryHash, second.entryHash]);
      const cleanReport = await service.verify(context, company.id);
      expect(cleanReport.ok).toBe(true);
      expect(cleanReport.entryCount).toBe(2);
      expect(cleanReport.headHash).toBe(second.entryHash);
      expect(cleanReport.brokenAtSequence).toBeUndefined();
      expect(cleanReport.alert).toBeUndefined();

      // The bytes before the edits, read back from the journal itself, so the restores are byte-exact.
      const originals = await fixture.admin.query<{ actor: string; metadata: unknown }>(
        "SELECT actor, metadata FROM audit_log WHERE company_id=$1 ORDER BY sequence", [company.id]);
      expect(originals.rowCount).toBe(2);

      // Non-vacuity, measured: an out-of-band edit of `metadata` breaks the chain at the edited sequence…
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [first.id]);
      });

      const report = await service.verify(context, company.id);
      expect(report.ok).toBe(false);
      expect(report.brokenAtSequence).toBe(1);
      expect(report.reason).toBe("entry_hash does not match the entry content");
      expect(report.alert).toContain("CRITICAL");
      // Fail closed: with a broken chain the service refuses new privileged writes.
      await expect(service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "third", resourceType: "test", decision: "allowed" }))
        .rejects.toBeInstanceOf(AuditUnavailableError);

      // …restoring the exact bytes clears it, so the failure above is the edit and not the read path…
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("UPDATE audit_log SET metadata=$1::jsonb WHERE id=$2", [JSON.stringify(originals.rows[0]!.metadata), first.id]);
      });
      const afterMetadataRestore = await service.verify(context, company.id);
      expect(afterMetadataRestore.ok).toBe(true);
      expect(afterMetadataRestore.headHash).toBe(second.entryHash);

      // …and a second, unrelated hashed field (`actor`) breaks it at **its own** sequence number, which is what
      // makes `brokenAtSequence` a location an operator can investigate rather than a constant.
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [second.id]);
      });
      const actorReport = await service.verify(context, company.id);
      expect(actorReport.ok).toBe(false);
      expect(actorReport.brokenAtSequence).toBe(2);
      expect(actorReport.reason).toBe("entry_hash does not match the entry content");

      // The suite restores the journal before it ends: this database is shared with the other gate runs, and a
      // suite that leaves a tampered row behind makes the next reader's failure look like its own.
      await withoutTriggers(fixture.admin, async () => {
        await fixture.admin.query("UPDATE audit_log SET actor=$1 WHERE id=$2", [originals.rows[1]!.actor, second.id]);
      });
      const finalReport = await service.verify(context, company.id);
      expect(finalReport.ok).toBe(true);
      expect(finalReport.entryCount).toBe(2);
      expect(finalReport.brokenAtSequence).toBeUndefined();
      expect(finalReport.headHash).toBe(second.entryHash);
    }, () => closeFixture(fixture));
  }, 60_000);
  it("round trips numeric anchor fields, accepts later appends and verifies a selected range", async () => {
    const store = new PostgresWorkspaceStore(String(databaseUrl));
    const testContext: AuthContext = { ...context, workspaceId: uniqueKey("ws-c1c-anchor") };
    try {
      await store.initialize(testContext);
      const company = await store.createCompany(testContext, { name: "C1c Anchor Round Trip" }, uniqueKey("anchor"));
      const service = new AuditLogService(store, auditConfig);
      const input = { companyId: company.id, actor: testContext.userId, actorRole: "admin", action: "first", resourceType: "test", decision: "allowed" as const };
      await service.record(testContext, input);
      const anchors = await service.writeDailyAnchors(testContext.workspaceId);
      const anchor = anchors.find(value => value.companyId === company.id)!;
      expect(typeof anchor.sequence).toBe("number");
      expect(typeof anchor.entryCount).toBe("number");
      expect(await store.latestAuditAnchor(testContext, company.id)).toEqual(anchor);
      const last = await service.record(testContext, { ...input, action: "second" });
      expect(await service.verify(testContext, company.id)).toMatchObject({ ok: true, anchorMismatch: false });
      expect(await service.verify(testContext, company.id, { fromSequence: 2, toSequence: 2 }))
        .toMatchObject({ ok: true, entryCount: 1, headHash: last.entryHash });
      expect(await service.verifyAll(testContext.workspaceId)).toEqual([]);
    } finally { await store.close(); }
  }, 60_000);

  it("serializes concurrent multi-worker appends without chain forks using advisory locks", async () => {
    const store = new PostgresWorkspaceStore(String(databaseUrl));
    const testContext: AuthContext = { ...context, workspaceId: uniqueKey("ws-c1c-conc") };
    try {
      await store.initialize(testContext);
      const company = await store.createCompany(testContext, { name: "C1c Concurrency Co" }, uniqueKey("concurrency"));
      const service = new AuditLogService(store, auditConfig);

      const actions = Array.from({ length: 10 }, (_, i) => `concurrent.action.${i}`);
      const entries = await Promise.all(
        actions.map((act) =>
          service.record(testContext, {
            companyId: company.id, actor: testContext.userId, actorRole: "admin",
            action: act, resourceType: "test", decision: "allowed"
          })
        )
      );

      expect(entries).toHaveLength(10);
      const listed = await store.listAuditEntries(testContext, company.id, { limit: 100 });
      expect(listed).toHaveLength(10);
      expect(listed.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const verified = await service.verify(testContext, company.id);
      expect(verified.ok).toBe(true);
      expect(verified.entryCount).toBe(10);
      expect(verified.brokenAtSequence).toBeUndefined();
    } finally {
      await store.close();
    }
  }, 60_000);

  it("preserves audit log records when an associated disposable project is physically deleted", async () => {
    const store = new PostgresWorkspaceStore(String(databaseUrl));
    const adminPool = new Pool({ connectionString: String(databaseUrl) });
    const testContext: AuthContext = { ...context, workspaceId: uniqueKey("ws-c1c-ret") };
    try {
      await store.initialize(testContext);
      const company = await store.createCompany(testContext, { name: "C1c Retention Co" }, uniqueKey("retention"));
      const service = new AuditLogService(store, auditConfig);

      const projectId = uniqueKey("proj");
      await adminPool.query(
        "INSERT INTO projects (id, workspace_id, company_id, name, type, created_by, create_request_key) VALUES ($1, $2, $3, $4, 'code_project', $5, $6)",
        [projectId, testContext.workspaceId, company.id, "Disposable Project", testContext.userId, uniqueKey("req")]
      );

      const entry = await service.record(testContext, {
        companyId: company.id, actor: testContext.userId, actorRole: "admin",
        action: "project.created", resourceType: "code_project", resourceId: projectId,
        projectId: projectId, decision: "allowed"
      });

      // Physically delete the project row from projects
      await adminPool.query("DELETE FROM projects WHERE id=$1", [projectId]);

      // Verify the audit entry survived and chain is valid
      const listed = await store.listAuditEntries(testContext, company.id);
      expect(listed.some((e) => e.id === entry.id && e.projectId === projectId)).toBe(true);
      const verification = await service.verify(testContext, company.id);
      expect(verification.ok).toBe(true);
    } finally {
      await adminPool.end();
      await store.close();
    }
  }, 60_000);

  it("allows privileged writes when blockOnBreak is explicitly false even after tampering is detected", async () => {
    const store = new PostgresWorkspaceStore(String(databaseUrl));
    const adminPool = new Pool({ connectionString: String(databaseUrl) });
    const testContext: AuthContext = { ...context, workspaceId: uniqueKey("ws-c1c-nb") };
    try {
      await store.initialize(testContext);
      const company = await store.createCompany(testContext, { name: "C1c NonBlocking Co" }, uniqueKey("nonblocking"));
      const nonBlockingConfig = { ...auditConfig, blockOnBreak: false };
      const service = new AuditLogService(store, nonBlockingConfig);

      const first = await service.record(testContext, {
        companyId: company.id, actor: testContext.userId, actorRole: "admin",
        action: "first", resourceType: "test", decision: "allowed"
      });

      await withoutTriggers(adminPool, async () => {
        await adminPool.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [first.id]);
      });

      const report = await service.verify(testContext, company.id);
      expect(report.ok).toBe(false);
      expect(report.brokenAtSequence).toBe(1);

      // Even though the chain is broken, blockOnBreak=false allows privileged writes without throwing AuditUnavailableError
      const next = await service.record(testContext, {
        companyId: company.id, actor: testContext.userId, actorRole: "admin",
        action: "second", resourceType: "test", decision: "allowed"
      });
      expect(next.action).toBe("second");

      await withoutTriggers(adminPool, async () => {
        await adminPool.query("DELETE FROM audit_log WHERE company_id=$1", [company.id]);
      });
    } finally {
      await adminPool.end();
      await store.close();
    }
  }, 60_000);
});
