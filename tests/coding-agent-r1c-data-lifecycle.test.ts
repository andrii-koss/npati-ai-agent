import { describe, expect, it } from "vitest";
import {
  CODE_APPEND_ONLY_EVIDENCE_FAMILIES,
  CODE_RETENTION_FAMILIES,
  EXPIRABLE_RETENTION_CLASSES,
  resolveCodeRetentionWindows,
  type CodeDataErasureReport,
  type CodeDataLifecycleStore,
  type CodeDataRetentionReport,
  type AuthContext,
} from "@npati/workspace";
import { CodeReaper, type CodeReaperPorts, type ReaperActivityEvent } from "../apps/agent-api/src/code-reaper";
import { CodeRbacError } from "../apps/agent-api/src/code-rbac";
import {
  CodeDataRetention,
  RETENTION_FAMILY_TABLES,
  RETENTION_FORBIDDEN_TABLES,
} from "../apps/agent-api/src/code-data-retention";
import {
  CodeDataErasureError,
  CodeDataErasureService,
  CODE_DATA_ERASURE_CODES,
} from "../apps/agent-api/src/code-data-erasure";
import { assertErasureConfirmed, registerCodeDataErasureRoutes, toErasureResponse } from "../apps/agent-api/src/code-data-erasure-routes";
import { buildApp } from "../apps/agent-api/src/app";
import {
  extractDiffsFromSettledResult,
  renderCodeSessionMarkdown,
} from "../apps/agent-api/src/code-session-export-routes";
import { scanTextForSecrets } from "../apps/agent-api/src/code-secret-scanner";

/**
 * R1-C (items 11–13) — hermetic half.
 *
 * The defect being closed was not a missing abstraction: `toolResultRetentionDays` and
 * `transcriptRetentionDays` existed, were documented in `.env.example`, were asserted by a test, and were read
 * by **nothing**. A suite that only checked "the reaper has a retention step" would be satisfied by a step
 * that never fires, so this file measures the four things that make the step real:
 *
 *  1. the step is driven by the **configured** windows, derived once, and a dry run deletes nothing;
 *  2. the families retention reaches are a closed list that **cannot** name `audit_log`, `audit_anchors` or the
 *     append-only evidence — the negative control the audit contract needs;
 *  3. erasure is fail-closed on the journal (audit **before** apply), cannot be authorized into deleting a
 *     Website Builder project, and reports a measurement rather than a success message;
 *  4. the export's diff section travels through the **same** secret scanner, so a credential in a diff refuses
 *     the export instead of being printed.
 *
 * The database-level behaviour (rows really disappear, fresh rows survive, Website Builder rows are never
 * touched) is measured against a real PostgreSQL in `tests/coding-agent-r1c-data-lifecycle-postgres.test.ts`,
 * because a fake cannot prove a DELETE.
 */

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const ctx: AuthContext = { workspaceId: "ws-r1c", userId: "user-r1c", permissions: ["workspace:read", "business:manage"] };

/** A lifecycle port that records what it was asked and answers with the counts it was given. */
function fakeLifecycle(input: {
  preview?: Partial<CodeDataRetentionReport>;
  report?: Partial<CodeDataRetentionReport>;
} = {}) {
  const calls: Array<{ dryRun: boolean; now: number; companyId?: string }> = [];
  const base: CodeDataRetentionReport = {
    companyId: "*",
    windows: resolveCodeRetentionWindows({ toolResultRetentionDays: 30, transcriptRetentionDays: 90 }),
    families: [],
    expired: 4,
    purged: 4,
    retained: 0,
  };
  const lifecycle: CodeDataLifecycleStore = {
    planCodeDataRetention: async (request) => {
      calls.push({ dryRun: request.dryRun, now: request.now.getTime(), ...(request.companyId ? { companyId: request.companyId } : {}) });
      return { ...base, ...(request.dryRun ? input.preview : input.report), companyId: request.companyId ?? "*" };
    },
    eraseCodeData: async () => {
      throw new Error("not used");
    },
  };
  return { lifecycle, calls };
}

function reaperHarness(overrides: Partial<CodeReaperPorts> = {}) {
  const events: ReaperActivityEvent[] = [];
  const warnings: Array<{ payload: unknown; message?: string }> = [];
  const reaper = new CodeReaper({
    logger: { warn: (payload, message) => { warnings.push({ payload, message }); }, info: () => undefined },
    activity: { record: (event) => { events.push(event); } },
    ...overrides,
    intervalMs: 60_000,
    toolCallNoProgressMs: 300_000,
    maxRunMinutes: 30,
    now: () => NOW,
  });
  return { reaper, events, warnings };
}

describe("security-gate: R1-C retention — the reaper step really runs", () => {
  it("reports the real preview in a dry run and performs no mutation", async () => {
    const { lifecycle, calls } = fakeLifecycle({ preview: { expired: 7, purged: 0, retained: 3 } });
    const { reaper } = reaperHarness({
      dataRetention: {
        preview: (input) => new CodeDataRetention({ lifecycle, limits: { toolResultRetentionDays: 30, transcriptRetentionDays: 90 } }).preview(input),
        apply: async () => { throw new Error("a dry run must never call apply"); },
      },
    });

    const summary = await reaper.run({ dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.cleaned.expiredDataRows).toBe(7);
    // Rows that matched but are forbidden to delete are reported separately, so "0 purged" cannot be read as
    // "nothing was due".
    expect(summary.cleaned.retainedDataRows).toBe(3);
    expect(calls).toEqual([{ dryRun: true, now: NOW }]);
    expect(summary.errors).toEqual([]);
  });

  it("applies the sweep for real when it is not a dry run, and reports what was purged", async () => {
    const { lifecycle, calls } = fakeLifecycle({ report: { expired: 5, purged: 5, retained: 2 } });
    const { reaper } = reaperHarness({
      dataRetention: {
        preview: async () => ({ expired: 0, retained: 0, retainedReasons: [] }),
        apply: (input) => new CodeDataRetention({ lifecycle, limits: { toolResultRetentionDays: 30, transcriptRetentionDays: 90 } }).apply(input),
      },
    });

    const summary = await reaper.run();

    expect(summary.cleaned.expiredDataRows).toBe(5);
    expect(summary.cleaned.retainedDataRows).toBe(2);
    expect(calls).toEqual([{ dryRun: false, now: NOW }]);
    expect(summary.errors).toEqual([]);
  });

  it("keeps the step visible as `port_unavailable` when the deployment cannot delete code data", async () => {
    const { reaper } = reaperHarness();

    const summary = await reaper.run();

    expect(summary.skipped.some((entry) => entry.step === "data_retention" && entry.reason === "port_unavailable")).toBe(true);
    expect(summary.cleaned.expiredDataRows).toBe(0);
  });

  it("is idempotent: a second pass over already expired rows reports the second measurement, not the first", async () => {
    let remaining = 3;
    const { reaper } = reaperHarness({
      dataRetention: {
        preview: async () => ({ expired: remaining, retained: 0, retainedReasons: [] }),
        apply: async () => {
          const purged = remaining;
          remaining = 0;
          return { expired: purged, purged, retained: 0, retainedReasons: [] };
        },
      },
    });

    const first = await reaper.run();
    const second = await reaper.run();

    expect(first.cleaned.expiredDataRows).toBe(3);
    expect(second.cleaned.expiredDataRows).toBe(0);
    expect(second.errors).toEqual([]);
  });

  it("a failing retention step is reported without taking the other steps down, and its metrics carry counts only", async () => {
    const { reaper, events } = reaperHarness({
      dataRetention: {
        preview: async () => ({ expired: 0, retained: 0, retainedReasons: [] }),
        apply: async () => { throw new Error("retention store unavailable"); },
      },
    });

    const summary = await reaper.run();

    expect(summary.errors.some((entry) => entry.step === "data_retention" && entry.message === "retention store unavailable")).toBe(true);
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toMatch(/DATABASE_URL|password|ghp_|AKIA/i);
    expect(Object.keys(events[0]!)).not.toContain("content");
  });
});

describe("security-gate: R1-C retention — the windows come from the existing configuration", () => {
  it("derives every window from the two configured limits and restates nothing", () => {
    const windows = resolveCodeRetentionWindows({ toolResultRetentionDays: 30, transcriptRetentionDays: 90 });
    expect(windows.toolResultDays).toBe(30);
    expect(windows.transcriptDays).toBe(90);
    expect(windows.ephemeralDays).toBe(1);
    // `extended` is a multiple of a configured value, not a new constant that could drift from it.
    expect(windows.extendedDays).toBe(270);

    // The mapping is a function of its input: changing the configuration changes the windows.
    const other = resolveCodeRetentionWindows({ toolResultRetentionDays: 7, transcriptRetentionDays: 14 });
    expect(other).toEqual({ toolResultDays: 7, transcriptDays: 14, ephemeralDays: 1, extendedDays: 42 });
  });

  it("never expires `until_deleted`, and says so through the class list the SQL is given", () => {
    expect(EXPIRABLE_RETENTION_CLASSES).toContain("ephemeral");
    expect(EXPIRABLE_RETENTION_CLASSES).toContain("extended");
    // The one class that means "the user decides" is not in the list the retention statement filters by, so a
    // clock can never expire it — only the explicit erasure route can.
    expect(EXPIRABLE_RETENTION_CLASSES).not.toContain("until_deleted");
    expect([...EXPIRABLE_RETENTION_CLASSES].sort()).toEqual(["ephemeral", "extended", "short", "standard"]);
  });

  it("cannot name the audit journal or the append-only evidence: the negative control the audit contract needs", () => {
    for (const forbidden of ["audit_log", "audit_anchors"]) {
      expect(RETENTION_FAMILY_TABLES).not.toContain(forbidden);
      expect(CODE_RETENTION_FAMILIES.map((family) => family.table)).not.toContain(forbidden);
      expect(CODE_APPEND_ONLY_EVIDENCE_FAMILIES.map((family) => family.table)).not.toContain(forbidden);
    }
    // The append-only evidence is listed as retained **with a reason**, never as an expirable family.
    const expirable = new Set(CODE_RETENTION_FAMILIES.map((family) => family.table));
    for (const family of CODE_APPEND_ONLY_EVIDENCE_FAMILIES) {
      expect(expirable.has(family.table)).toBe(false);
      expect(family.retentionRefusal).toBe("append_only_evidence");
    }
    // And the two lists are exactly the documented boundary.
    expect([...RETENTION_FAMILY_TABLES].sort()).toEqual([...expirable].sort());
    expect(RETENTION_FORBIDDEN_TABLES).toEqual(
      expect.arrayContaining(["audit_log", "audit_anchors", "execution_snapshots", "code_replay_bundles", "code_context_summaries"]),
    );
    // The forbidden list and the erasable list are disjoint: a table cannot be both.
    expect(RETENTION_FORBIDDEN_TABLES.filter((table) => expirable.has(table))).toEqual([]);
  });

  it("reports `data_lifecycle_unavailable` instead of a silent success when there is no backend", async () => {
    const retention = new CodeDataRetention({ limits: { toolResultRetentionDays: 30, transcriptRetentionDays: 90 } });
    expect(retention.available).toBe(false);
    await expect(retention.apply({ now: NOW })).rejects.toThrow(/code_data_lifecycle_unavailable/);
  });

  it("runs the sweep cross-tenant by design and never narrows it to one Company by accident", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const retention = new CodeDataRetention({ lifecycle, limits: { toolResultRetentionDays: 30, transcriptRetentionDays: 90 } });
    await retention.apply({ now: NOW });
    // No `companyId`: the statement's own tenant predicate is what keeps the sweep from becoming a way to
    // reach one tenant's rows from another's context.
    expect(calls).toEqual([{ dryRun: false, now: NOW }]);
  });
});

describe("security-gate: R1-C erasure — audit before apply, scoped to code entities", () => {
  const report = (input: Partial<CodeDataErasureReport> = {}): CodeDataErasureReport => ({
    companyId: "c-1",
    target: { kind: "session", sessionId: "s-1" },
    families: [{ table: "code_run_turns", scope: "run", expired: 2, purged: 2, retained: 0, remaining: 0 }],
    erased: 2,
    outstanding: [],
    preserved: [{ table: "execution_snapshots", reason: "append_only_evidence" }],
    verified: true,
    ...input,
  });

  function service(input: {
    projectType?: string;
    session?: { projectId: string } | null;
    report?: CodeDataErasureReport;
    audit?: boolean;
    auditFails?: boolean;
    withWorkspace?: boolean;
  } = {}) {
    const order: string[] = [];
    const erasedTargets: unknown[] = [];
    const eraseReport = input.report ?? report();
    const erasure = new CodeDataErasureService({
      store: {
        lifecycle: {
          planCodeDataRetention: async () => { throw new Error("not used"); },
          eraseCodeData: async () => { order.push("erase"); return eraseReport; },
        },
        resolveSession: async () => input.session === undefined ? { projectId: "p-1" } : input.session,
        resolveProject: async () => (input.projectType === undefined ? null : { type: input.projectType }),
      },
      ...(input.audit === false ? {} : {
        audit: {
          record: async (entry) => {
            order.push("audit");
            if (input.auditFails) throw new Error("journal down");
            erasedTargets.push({ action: entry.action, resourceType: entry.resourceType, metadata: entry.metadata });
          },
        },
      }),
      ...(input.withWorkspace ? { removeWorkspace: async () => ({ removed: true, alreadyAbsent: false }) } : {}),
      logger: { warn: () => undefined },
    });
    return { erasure, order, erasedTargets };
  }

  it("writes the journal entry before it deletes anything, and fails closed when it cannot", async () => {
    const ok = service();
    await ok.erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-1" } });
    expect(ok.order).toEqual(["audit", "erase"]);
    expect(ok.erasedTargets[0]).toMatchObject({ action: "code.session.data_erase", resourceType: "code_session" });

    // A journal that cannot be written refuses the erasure: a destructive act that happened is exactly the
    // moment its record must already exist.
    const denied = service({ auditFails: true });
    await expect(denied.erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-1" } }))
      .rejects.toMatchObject({ code: CODE_DATA_ERASURE_CODES.auditUnavailable });
    expect(denied.order).toEqual(["audit"]);

    const unwired = service({ audit: false });
    await expect(unwired.erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-1" } }))
      .rejects.toMatchObject({ code: CODE_DATA_ERASURE_CODES.auditUnavailable });
    expect(unwired.order).toEqual([]);
  });

  it("refuses a Website Builder project by name and never reaches the erasure", async () => {
    const { erasure, order } = service({ projectType: "website" });
    await expect(erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "project", projectId: "p-web" } }))
      .rejects.toMatchObject({ code: CODE_DATA_ERASURE_CODES.notFound, details: { reason: "not_a_code_project" } });
    // The refusal comes first: no journal entry claims an erasure that will not happen, and nothing is deleted.
    expect(order).toEqual([]);
    expect(erasure.available).toBe(true);
  });

  it("erases a code project and reports the measurement the store returned", async () => {
    const { erasure, order } = service({ projectType: "code_project", withWorkspace: true });
    const result = await erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "project", projectId: "p-1" } });
    expect(order).toEqual(["audit", "erase"]);
    expect(result.status).toBe("erased");
    expect(result.verified).toBe(true);
    expect(result.outstanding).toEqual([]);
    expect(result.removed.workspace).toBe(true);
    // The append-only evidence is named in the answer, so "nothing left" is scoped to what can be removed.
    expect(result.preserved).toEqual([{ table: "execution_snapshots", reason: "append_only_evidence" }]);
  });

  it("never removes a shared project workspace for a session erasure", async () => {
    const { erasure } = service({ withWorkspace: true });
    const result = await erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-1" } });
    expect(result.removed.workspace).toBe("unknown");
    expect(result.workspaceReason).toBe("session_scope_preserves_project_workspace");
    // …and it is not a failure: erasing one session of a project must not turn a complete row erasure into a
    // partial answer.
    expect(result.failures).toEqual([]);
  });

  it("reports `partial` with the outstanding families instead of claiming a verified erasure", async () => {
    const { erasure } = service({
      report: report({ outstanding: ["code_run_turns"], verified: false, families: [{ table: "code_run_turns", scope: "run", expired: 2, purged: 2, retained: 0, remaining: 2 }] }),
    });
    const result = await erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-1" } });
    expect(result.status).toBe("partial");
    expect(result.verified).toBe(false);
    expect(result.outstanding).toEqual(["code_run_turns"]);
  });

  it("answers `already_erased` on a repeat call without inventing a delete it did not perform", async () => {
    const { erasure, order } = service({ session: null, report: report({ erased: 0, families: [], outstanding: [] }), withWorkspace: true });
    const result = await erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "session", sessionId: "s-gone" } });
    expect(result.status).toBe("already_erased");
    // The rows are gone and the target no longer resolves, so the sweep is **not** issued at all: the project id
    // that would stand in for the gone session is unknown, and a checkpoint belongs to a project rather than to
    // the session-scoped erase that was refused. What remains is the journal entry and the workspace check.
    expect(order).toEqual(["audit"]);
    expect(result.verified).toBe(true);
    expect(result.removed.rows).toBe(0);
    // The evidence boundary is still stated, so an empty report cannot be read as "nothing was preserved".
    expect(result.preserved.map((entry) => entry.table)).toContain("execution_snapshots");
  });

  it("requires an explicit confirmation and refuses without it", () => {
    expect(() => assertErasureConfirmed({})).toThrow(CodeDataErasureError);
    expect(() => assertErasureConfirmed({ confirm: "true" })).toThrow(CodeDataErasureError);
    expect(() => assertErasureConfirmed({ confirm: true })).not.toThrow();
  });

  it("serialises counts and reasons only — no transcript, path or row content", async () => {
    const { erasure } = service({ projectType: "code_project", withWorkspace: true });
    const result = await erasure.erase({ ctx, actor: "u", companyId: "c-1", target: { kind: "project", projectId: "p-1" } });
    const body = toErasureResponse(result);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/transcript|workspace\/|\.ts|\.tsx|TOKEN|password/i);
    expect(body).toMatchObject({ status: "erased", scope: "project", verified: true, outstanding: [] });
  });
});

describe("security-gate: R1-C export — the diff section travels through the same secret scan", () => {
  const turn = (resultText: string) => [{
    turnIndex: 0,
    toolCalls: [{
      toolCallId: "call-1", tool: "code.fs.edit", toolVersion: 1, outcome: "ok",
      truncated: false, resultText, resultTruncated: false,
    }],
  }];

  const markdownFor = (resultText: string) => renderCodeSessionMarkdown({
    runId: "run-1", companyId: "c-1", projectId: "p-1", sessionId: "s-1", status: "completed",
    exportedAt: "2026-03-01T12:00:00.000Z", source: "replay_bundle", limit: 50,
    turns: turn(resultText), totalTurns: 1, rewoundToTurn: null, turnsOmittedByRewind: 0,
  });

  it("renders the diff of a settled tool result as a patch", () => {
    const settled = JSON.stringify({
      ok: true, tool: "code.fs.edit", truncated: false,
      result: { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
    });
    expect(extractDiffsFromSettledResult(settled)).toEqual(["--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"]);
    const markdown = markdownFor(settled);
    expect(markdown).toContain("#### `code.fs.edit` diff");
    expect(markdown).toContain("```diff");
    expect(markdown).toContain("+new");
  });

  it("adds no diff section for a result that carries none, and invents nothing from a failed call", () => {
    expect(extractDiffsFromSettledResult(null)).toEqual([]);
    expect(extractDiffsFromSettledResult("not json")).toEqual([]);
    expect(extractDiffsFromSettledResult(JSON.stringify({ ok: true, tool: "code.fs.read", result: { content: "x" } }))).toEqual([]);
    // A failed call has no result at all, so there is nothing to render — and a `diff` beside `ok: false` is not
    // a change that happened.
    expect(extractDiffsFromSettledResult(JSON.stringify({ ok: false, error: { diff: "--- a\n+++ b\n" } }))).toEqual([]);
  });

  it("bounds the rendered diff with the same explicit truncation marker as every other result", () => {
    const huge = `--- a/x\n+++ b/x\n${"+x".repeat(10_000)}`;
    const settled = JSON.stringify({ ok: true, tool: "code.fs.edit", result: { diff: huge } });
    const [extracted] = extractDiffsFromSettledResult(settled);
    expect(extracted!.length).toBeLessThanOrEqual(4_000 + 1);
    expect(extracted!.endsWith("…")).toBe(true);
  });

  it("keeps the diff inside the material the export's secret scan reads, so a credential refuses it", () => {
    const settled = JSON.stringify({
      ok: true, tool: "code.fs.edit", truncated: false,
      result: { path: ".env", diff: "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" },
    });
    const markdown = markdownFor(settled);
    // The same scanner the route runs on the finished document: it finds the value, which is what makes the
    // route answer 422 `export_secret_detected` instead of printing it.
    const findings = scanTextForSecrets(markdown).findings;
    expect(findings.map((finding) => finding.kind)).toContain("github_token");
    // The markdown block itself still contains the literal (the refusal is the contract, not a redaction), and
    // the finding's preview is the redacted form — so a log of the finding cannot leak it either.
    expect(findings.every((finding) => !finding.preview.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"))).toBe(true);
  });
});

/** The route handlers, driven directly — the same shape `tests/coding-agent-c10-session-export.test.ts` uses. */
interface Route { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<unknown> }

function fakeInstance(routes: Route[]) {
  return {
    delete: (url: string, handler: Route["handler"]) => routes.push({ method: "delete", url, handler }),
  } as unknown as Parameters<typeof registerCodeDataErasureRoutes>[0];
}

function fakeReply() {
  const state: { status: number; body: unknown } = { status: 200, body: undefined };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply: reply as never, state };
}

describe("security-gate: R1-C erasure — the HTTP contract", () => {
  const routes: Route[] = [];
  const calls: Array<{ action: string; permission: string }> = [];
  const auditEntries: unknown[] = [];
  let authorised = true;
  let authenticated = true;

  async function harness() {
    routes.length = 0;
    calls.length = 0;
    auditEntries.length = 0;
    const { CodeDataErasureService: Service } = await import("../apps/agent-api/src/code-data-erasure");
    const erasure = new Service({
      store: {
        lifecycle: {
          planCodeDataRetention: async () => { throw new Error("not used"); },
          eraseCodeData: async ({ companyId, target }) => ({
            companyId,
            target,
            families: [{ table: "code_run_turns", scope: "run", expired: 1, purged: 1, retained: 0, remaining: 0 }],
            erased: 1,
            outstanding: [],
            preserved: [{ table: "execution_snapshots", reason: "append_only_evidence" }],
            verified: true,
          }),
        },
        resolveSession: async () => ({ projectId: "p-1" }),
        resolveProject: async () => ({ type: "code_project" }),
      },
      audit: { record: async (entry) => { auditEntries.push(entry); } },
      logger: { warn: () => undefined },
    });
    await registerCodeDataErasureRoutes(fakeInstance(routes), {
      erasure,
      authorize: async (_ctx, _companyId, input) => {
        calls.push({ action: input.action, permission: input.permission });
        if (!authorised) throw new CodeRbacError("permission_denied", "Missing permission", 403, {});
        return {};
      },
      getAuthContext: () => (authenticated ? ctx : null),
      logger: { warn: () => undefined },
    });
    return erasure;
  }

  it("registers one route per scope and neither of them is a second lifecycle path", async () => {
    await harness();
    expect(routes.map((route) => `${route.method} ${route.url}`)).toEqual([
      "delete /companies/:companyId/code/sessions/:sessionId/data",
      "delete /companies/:companyId/code/projects/:projectId/data",
    ]);
  });

  it("derives the permission from the named action, so a read label cannot authorise an erasure", async () => {
    await harness();
    const route = routes[0]!;
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: "c-1", sessionId: "s-1" }, body: { confirm: true } }, reply);
    expect(calls).toEqual([{ action: "code.session.data_erase", permission: "business:manage" }]);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ status: "erased", scope: "session", verified: true, outstanding: [] });
    // The journal is written before the erasure, and its metadata carries no row content.
    expect(auditEntries).toHaveLength(1);
    expect(JSON.stringify(auditEntries)).not.toMatch(/transcript|diff|content/i);
  });

  it("answers 401 without a context, 400 without the confirmation, and 403 when the gate denies", async () => {
    await harness();
    const route = routes[0]!;

    authenticated = false;
    const unauth = fakeReply();
    await route.handler({ params: { companyId: "c-1", sessionId: "s-1" }, body: { confirm: true } }, unauth.reply);
    expect(unauth.state.status).toBe(401);
    authenticated = true;

    const unconfirmed = fakeReply();
    await route.handler({ params: { companyId: "c-1", sessionId: "s-1" }, body: {} }, unconfirmed.reply);
    expect(unconfirmed.state.status).toBe(400);
    expect(unconfirmed.state.body).toMatchObject({ error: { code: "invalid_arguments", details: { field: "confirm" } } });
    // The refusal happens before the journal: nothing claims an erasure that will not happen.
    expect(auditEntries).toEqual([]);

    authorised = false;
    const denied = fakeReply();
    await route.handler({ params: { companyId: "c-1", sessionId: "s-1" }, body: { confirm: true } }, denied.reply);
    expect(denied.state.status).toBe(403);
    expect(denied.state.body).toMatchObject({ error: { code: "permission_denied" } });
    expect(auditEntries).toEqual([]);
    authorised = true;
  });

  it("answers the project scope on its own route and reports the workspace outcome honestly", async () => {
    await harness();
    const route = routes[1]!;
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: "c-1", projectId: "p-1" }, body: { confirm: true } }, reply);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      scope: "project",
      // No `removeWorkspace` is wired in this harness, so the answer says so instead of claiming the bytes are
      // gone — and the erasure of the rows is still verified.
      verified: true,
      workspaceReason: "workspace_removal_not_configured",
    });
    expect((state.body as { failures?: unknown[] }).failures).toHaveLength(1);
  });
});

describe("security-gate: R1-C erasure — the routes are really registered in the composed app", () => {
  /**
   * A route module that satisfies its own unit tests can still fail to register: a duplicated path makes
   * Fastify refuse at `ready()`, and a dependency referenced before it is defined throws during composition.
   * Only building the application answers that, so this is measured rather than assumed.
   */
  it("builds the composed app, serves both erasure routes, and closes cleanly", async () => {
    process.env.NODE_ENV = "test";
    const app = buildApp();
    try {
      await app.ready();
      for (const url of [
        "/companies/company-1/code/sessions/session-1/data",
        "/companies/company-1/code/projects/project-1/data",
      ]) {
        const response = await app.inject({ method: "DELETE", url, payload: { confirm: true } });
        // An unregistered path answers 404; a deployment with no auth provider refuses earlier with its own
        // named status. Either way the route exists, which is the only thing this test claims.
        expect({ url, status: response.statusCode === 404 ? "missing" : "registered" }).toEqual({ url, status: "registered" });
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
