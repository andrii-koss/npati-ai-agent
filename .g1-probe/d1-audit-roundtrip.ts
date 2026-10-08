/**
 * G1 (D1) replica on the live gate database: the round trip the DB suite never made.
 *
 * `vitest` cannot start in this sandbox (`spawn EPERM`), so this script drives the **real**
 * `PostgresWorkspaceStore`, the **real** `AuditLogService` and the **real** `audit-chain.ts` against the
 * running `npati-g1-pg` container instead. Every number printed below is copied verbatim into the report.
 *
 * It measures four things:
 *  1. byte identity — `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` equals the
 *     exact string `new Date().toISOString()` produced and the store hashed, for every string that
 *     `toISOString()` can emit (including under a non-UTC session time zone, where the naive
 *     `created_at::text` differs);
 *  2. the defect — reading with the **pre-fix** column list makes `verifyAuditEntries` reject a chain the
 *     store itself just wrote, and reading with *only* `created_at` fixed still rejects it (the second,
 *     wider half: `sequence` arrives as a string);
 *  3. the fix — the store's own read path (`verifyAuditChain`, `AuditLogService.verify`,
 *     `listAuditEntries`) verifies the same chain: `ok: true`, `brokenAtSequence: null`, `headHash` equal to
 *     the hash the store returned when it appended the last entry, and every row's hash recomputed from the
 *     row the reader returned;
 *  4. non-vacuity — an out-of-band edit of `metadata` (sequence 1) and of `actor` (sequence 2) each break
 *     verification at the named sequence, and restoring the bytes makes it verify again.
 *
 * Temporary probe; not part of the repository's test surface.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  PostgresWorkspaceStore, auditEntryHash, canonicalJson, verifyAuditEntries,
  type AuditEntry, type AuthContext,
} from "@npati/workspace";
import { AuditLogService } from "../apps/agent-api/src/audit-log";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate";
/** The one expression the fix adds, written once so every measurement below uses the same bytes. */
const ISO_TEMPLATE = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const isoOf = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO_TEMPLATE})`;

/** The column list exactly as it was before the fix (`git show HEAD:packages/workspace/src/postgres-store.ts`). */
const PRE_FIX_COLUMNS = `id, workspace_id AS "workspaceId", company_id AS "companyId", sequence,
created_at AS "createdAt", actor, actor_role AS "actorRole", request_id AS "requestId",
correlation_id AS "correlationId", snapshot_id AS "snapshotId", action, resource_type AS "resourceType",
resource_id AS "resourceId", project_id AS "projectId", decision, payload_hash AS "payloadHash",
prev_hash AS "prevHash", entry_hash AS "entryHash", metadata`;

/** The same list with **only** `created_at` fixed: the intermediate state that proves the defect has two halves. */
const TIMESTAMP_ONLY_FIXED_COLUMNS = PRE_FIX_COLUMNS.replace(`created_at AS "createdAt"`, `${isoOf("created_at")} AS "createdAt"`);

/** The same list with `sequence` fixed as well — the list the store uses after the fix. */
const FIXED_COLUMNS = TIMESTAMP_ONLY_FIXED_COLUMNS.replace(`"companyId", sequence,`, `"companyId",\nsequence::int AS "sequence",`);

const context: AuthContext = {
  workspaceId: "ws-g1-d1-probe",
  userId: "g1-d1-probe-user",
  permissions: ["workspace:read", "business:manage", "admin:all"],
};

const pool = new Pool({ connectionString: DATABASE_URL });
const store = new PostgresWorkspaceStore(DATABASE_URL);
const service = new AuditLogService(store, {
  verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true,
});

function line(title: string): void { console.log(`\n=== ${title} ===`); }
function show(label: string, value: unknown): void { console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`); }
function summarize(verification: { ok: boolean; entryCount: number; brokenAtSequence?: number; reason?: string; headHash: string | null }) {
  return {
    ok: verification.ok, entryCount: verification.entryCount,
    brokenAtSequence: verification.brokenAtSequence ?? null, reason: verification.reason ?? null,
    headHash: verification.headHash,
  };
}

/** Reads the company's chain through an explicit column list and runs the real verifier over the rows. */
async function verifyWithColumns(columns: string, companyId: string) {
  const rows = await pool.query<AuditEntry>(`SELECT ${columns} FROM audit_log WHERE workspace_id=$1 AND company_id=$2 ORDER BY sequence ASC`,
    [context.workspaceId, companyId]);
  const first = rows.rows[0];
  return {
    rowTypes: first ? {
      createdAt: `${typeof first.createdAt}${first.createdAt instanceof Date ? " (a Date)" : ""}`,
      sequence: typeof first.sequence,
      canonicalJsonOfCreatedAt: canonicalJson(first.createdAt),
      canonicalJsonOfSequence: canonicalJson(first.sequence),
    } : null,
    verification: summarize(verifyAuditEntries(rows.rows)),
  };
}

/** Recomputes every row's hash from the fields the reader returned, the way the verifier does. */
function recomputeHashes(entries: AuditEntry[]) {
  let prev: string | null = null;
  return entries.map((entry) => {
    const recomputed = auditEntryHash(prev, {
      id: entry.id, companyId: entry.companyId, sequence: entry.sequence, createdAt: entry.createdAt,
      actor: entry.actor, actorRole: entry.actorRole,
      requestId: entry.requestId ?? null, correlationId: entry.correlationId ?? null, snapshotId: entry.snapshotId ?? null,
      action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null, decision: entry.decision, payloadHash: entry.payloadHash,
      metadata: entry.metadata ?? {},
    });
    prev = entry.entryHash;
    return { sequence: entry.sequence, recomputed, stored: entry.entryHash, equal: recomputed === entry.entryHash };
  });
}

async function withoutTriggers<T>(body: () => Promise<T>): Promise<T> {
  await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_chain_guard");
  try { return await body(); } finally {
    await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_chain_guard");
    await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
  }
}

const result: Record<string, unknown> = {};

try {
  line("0. live database");
  show("connection", (await pool.query("SELECT current_user, current_database(), version() AS version")).rows[0]);

  // ---------------------------------------------------------------------------------------------
  line("1. byte identity: does the reader reproduce the string the writer hashed?");
  // Every shape `Date.prototype.toISOString()` can emit: 4-digit year, literal T, HH24:MI:SS,
  // three-digit milliseconds, literal Z. Edge cases plus 20 000 random millisecond timestamps.
  const samples: string[] = [
    "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.001Z", "2026-01-01T00:00:00.999Z",
    "2026-12-31T23:59:59.999Z", "2026-02-28T23:59:59.000Z", "2028-02-29T12:00:00.500Z",
    "2026-03-29T01:59:59.999Z", "2026-10-08T13:51:09.288Z", "1970-01-01T00:00:00.000Z",
    "2038-01-19T03:14:08.000Z", "2000-02-29T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
    "0001-01-01T00:00:00.000Z", "2026-06-30T23:59:59.123Z", "2026-07-01T00:00:00.000Z",
  ];
  for (let i = 0; i < 20_000; i += 1) samples.push(new Date(Date.UTC(1970, 0, 1) + Math.floor(Math.random() * 1_700_000_000_000)).toISOString());
  samples.push(new Date().toISOString());
  show("samples", samples.length);
  const client = await pool.connect();
  try {
    for (const zone of ["Etc/UTC", "America/New_York", "Asia/Tokyo"]) {
      await client.query(`SET TIME ZONE '${zone}'`);
      const probe = await client.query(
        `WITH input(s) AS (SELECT unnest($1::text[]))
         SELECT current_setting('TimeZone') AS session_timezone,
                bool_and(${isoOf("s::timestamptz")} = s) AS formatted_equals_hashed_string,
                count(*) FILTER (WHERE ${isoOf("s::timestamptz")} <> s)::int AS mismatches,
                count(*) FILTER (WHERE s::timestamptz::text = s)::int AS naive_cast_equals_hashed_string
         FROM input`, [samples]);
      show(`session TimeZone=${zone}`, probe.rows[0]);
    }
    // The boundary the fix cannot cover, stated rather than hidden: a microsecond value was never hashed by
    // `toISOString()` (it emits milliseconds only) and `to_char(..., 'MS')` truncates it.
    show("microsecond input (cannot be produced by toISOString)",
      (await client.query(`SELECT '2026-10-08T13:51:09.288123Z' AS input, ${isoOf("'2026-10-08T13:51:09.288123Z'::timestamptz")} AS formatted`)).rows[0]);
  } finally { client.release(); }

  // ---------------------------------------------------------------------------------------------
  line("2. a real chain, written through the real store");
  await store.initialize(context);
  const company = await store.createCompany(context, { name: "G1 D1 Probe Co" }, `d1-probe-${randomUUID()}`);
  const richMetadata = { nested: { zeta: [1, "two", null, true], alpha: { deep: "значення" } }, count: 3, ratio: 0.5, empty: {}, list: [] };
  const first = await service.record(context, {
    companyId: company.id, actor: context.userId, actorRole: "admin", action: "probe.first", resourceType: "probe",
    decision: "allowed", payload: { action: "probe.first", nested: { b: 2, a: 1 } }, metadata: richMetadata,
  });
  const second = await service.record(context, {
    companyId: company.id, actor: context.userId, actorRole: "admin", action: "probe.second", resourceType: "probe",
    decision: "allowed", metadata: { injected: false },
  });
  show("companyId", company.id);
  show("appended entry 1 (RETURNING through the fixed column list)", { sequence: first.sequence, sequenceType: typeof first.sequence, createdAt: first.createdAt, createdAtType: typeof first.createdAt, entryHash: first.entryHash });
  show("appended entry 2", { sequence: second.sequence, createdAt: second.createdAt, entryHash: second.entryHash, prevHash: second.prevHash });

  line("3. DEFECT: the pre-fix reader rejects the chain the store just wrote");
  const preFix = await verifyWithColumns(PRE_FIX_COLUMNS, company.id);
  show("pre-fix row types as `pg` returned them", preFix.rowTypes);
  show("pre-fix verifyAuditEntries", preFix.verification);
  result.preFix = { rowTypes: preFix.rowTypes, verification: preFix.verification };

  line("4. WIDER DEFECT: with only `created_at` fixed the same chain still fails");
  const timestampOnly = await verifyWithColumns(TIMESTAMP_ONLY_FIXED_COLUMNS, company.id);
  show("half-fixed row types", timestampOnly.rowTypes);
  show("half-fixed verifyAuditEntries", timestampOnly.verification);
  result.halfFixed = { rowTypes: timestampOnly.rowTypes, verification: timestampOnly.verification };

  // The column list the store really uses is read out of the module's own source, so this replica cannot
  // pass by measuring a string the store does not use.
  const storeSource = await readFile(new URL("../packages/workspace/src/postgres-store.ts", import.meta.url), "utf8");
  const afterMarker = storeSource.slice(storeSource.indexOf("const auditEntryColumns = `") + "const auditEntryColumns = `".length);
  const storeColumnList = afterMarker.slice(0, afterMarker.indexOf("`")).replace(/\s+/g, " ").trim();
  show("store column list (read from source)", storeColumnList);
  show("replica's FIXED_COLUMNS equals the store's list", storeColumnList === FIXED_COLUMNS.replace(/\s+/g, " ").trim());
  result.storeColumnListMatchesSource = storeColumnList === FIXED_COLUMNS.replace(/\s+/g, " ").trim();

  line("5. FIX: the store's own read path verifies the same chain");
  const realList = await store.listAuditEntries(context, company.id);
  show("listAuditEntries row types", realList.map((entry) => ({ sequence: entry.sequence, sequenceType: typeof entry.sequence, createdAt: entry.createdAt, createdAtType: typeof entry.createdAt })));
  show("recomputed hash == stored hash (per row)", recomputeHashes(realList));
  const viaStore = await store.verifyAuditChain(context, company.id);
  show("store.verifyAuditChain", summarize(viaStore));
  const viaService = await service.verify(context, company.id);
  show("AuditLogService.verify", { ok: viaService.ok, entryCount: viaService.entryCount, brokenAtSequence: viaService.brokenAtSequence ?? null, reason: viaService.reason ?? null, headHash: viaService.headHash, anchorMismatch: viaService.anchorMismatch, alert: viaService.alert ?? null });
  show("headHash equals the hash returned when entry 2 was appended", viaStore.headHash === second.entryHash);
  show("metadata round-tripped byte for byte", canonicalJson(realList[0]!.metadata) === canonicalJson(richMetadata));
  result.fixed = summarize(viaStore);
  result.headMatchesAppend = viaStore.headHash === second.entryHash;
  result.metadataRoundTrip = canonicalJson(realList[0]!.metadata) === canonicalJson(richMetadata);
  result.recomputedHashes = recomputeHashes(realList);

  // ---------------------------------------------------------------------------------------------
  line("6. NON-VACUITY: an out-of-band edit breaks verification at the named sequence");
  show("trigger enabled -> the same UPDATE is refused by the append-only trigger",
    await pool.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [first.id]).then(() => "NOT REFUSED (unexpected)").catch((error: Error) => error.message));

  const nonVacuity = await withoutTriggers(async () => {
    await pool.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [first.id]);
    const tampered = await service.verify(context, company.id);
    show("metadata tampered on sequence 1", { ok: tampered.ok, entryCount: tampered.entryCount, brokenAtSequence: tampered.brokenAtSequence ?? null, reason: tampered.reason ?? null, alert: tampered.alert ?? null });
    await pool.query("UPDATE audit_log SET metadata=$1::jsonb WHERE id=$2", [JSON.stringify(first.metadata), first.id]);
    const repaired = await service.verify(context, company.id);
    show("metadata restored", summarize(repaired));
    await pool.query("UPDATE audit_log SET actor='attacker' WHERE id=$1", [second.id]);
    const actorTampered = await service.verify(context, company.id);
    show("actor tampered on sequence 2", { ok: actorTampered.ok, brokenAtSequence: actorTampered.brokenAtSequence ?? null, reason: actorTampered.reason ?? null });
    await pool.query("UPDATE audit_log SET actor=$1 WHERE id=$2", [second.actor, second.id]);
    const afterRestore = await store.verifyAuditChain(context, company.id);
    show("actor restored", summarize(afterRestore));
    return { tampered, repaired, actorTampered, afterRestore };
  });
  result.nonVacuity = {
    metadataTamper: { rowTypes: "see above", ok: nonVacuity.tampered.ok, brokenAtSequence: nonVacuity.tampered.brokenAtSequence ?? null, reason: nonVacuity.tampered.reason ?? null },
    metadataRestored: summarize(nonVacuity.repaired),
    actorTamper: { ok: nonVacuity.actorTampered.ok, brokenAtSequence: nonVacuity.actorTampered.brokenAtSequence ?? null, reason: nonVacuity.actorTampered.reason ?? null },
    actorRestored: summarize(nonVacuity.afterRestore),
  };

  line("7. fail closed after a detected break");
  await withoutTriggers(async () => { await pool.query("UPDATE audit_log SET metadata='{\"injected\":true}'::jsonb WHERE id=$1", [first.id]); });
  const detected = await service.verify(context, company.id);
  show("break detected (this is what the background verifier does)", { ok: detected.ok, brokenAtSequence: detected.brokenAtSequence ?? null, alert: detected.alert ?? null });
  result.failClosed = {
    detected: { ok: detected.ok, brokenAtSequence: detected.brokenAtSequence ?? null },
    write: await service.record(context, { companyId: company.id, actor: context.userId, actorRole: "admin", action: "probe.third", resourceType: "probe", decision: "allowed" })
      .then(() => "NOT BLOCKED (unexpected)").catch((error: Error) => `${error.name}: ${error.message}`),
  };
  show("privileged write after a detected break", result.failClosed.write);
  await withoutTriggers(async () => { await pool.query("UPDATE audit_log SET metadata=$1::jsonb WHERE id=$2", [JSON.stringify(first.metadata), first.id]); });
  show("after repair", summarize(await store.verifyAuditChain(context, company.id)));

  // ---------------------------------------------------------------------------------------------
  line("8. cleanup (only the rows this probe created)");
  show("cleanup", await withoutTriggers(async () => ({
    auditRowsDeleted: (await pool.query("DELETE FROM audit_log WHERE workspace_id=$1 AND company_id=$2", [context.workspaceId, company.id])).rowCount,
    anchorRowsDeleted: (await pool.query("DELETE FROM audit_anchors WHERE workspace_id=$1 AND company_id=$2", [context.workspaceId, company.id])).rowCount,
  })));
  show("rows left for the probe company", (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1", [company.id])).rows[0]);
  show("trigger state", (await pool.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND NOT tgisinternal ORDER BY tgname")).rows);
} catch (error) {
  console.log("\nPROBE FAILED:", error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error));
  process.exitCode = 1;
} finally {
  console.log("\n=== MACHINE-READABLE SUMMARY ===");
  console.log(JSON.stringify(result, null, 2));
  await store.close();
  await pool.end();
}
