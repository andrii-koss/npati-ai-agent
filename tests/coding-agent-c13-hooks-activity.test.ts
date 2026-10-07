import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { AuthContext, CreateCodeActivityEventInput } from "@npati/workspace";
import {
  CodeHooksService, type CodeHookActivityEvent, type CodeHooksDeps,
} from "../apps/agent-api/src/code-hooks";
import { AgentLifecycleHookManager } from "../apps/agent-api/src/automation-lifecycle-and-reminders";
import {
  ActivityContentRejectedError, ActivitySecretRejectedError, activitySinkForKind, createCodeRunActivitySink,
} from "../apps/agent-api/src/code-run-activity-sink";

/**
 * C13 — hook Activity events, and what is deliberately **not** Activity.
 *
 * Owner decision 2 separates the two journals: `code_activity_events` records what happened (a hook was
 * invoked, what it decided, how long it took), while the tamper-evident AuditLog records privileged
 * administrative decisions (trust changes, permission/config changes). This suite pins the Activity side:
 * the events are written through the **real** sink, so the metadata-only and no-secrets guards are the ones
 * that really run, and it asserts that the hook subsystem writes no AuditLog entry at all — a hook has no
 * privileged decision to journal, and the trust/config decisions that *are* journalled are made elsewhere
 * (`code-project-trust.ts` audits before it applies a change).
 */

const owner: AuthContext = { workspaceId: "ws-c13", userId: "user-c13", permissions: ["owner"] } as unknown as AuthContext;
const GHP = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

interface SinkHarness {
  service: CodeHooksService;
  persisted: CreateCodeActivityEventInput[];
  logged: Array<Record<string, unknown>>;
  execute: ReturnType<typeof vi.fn>;
  activityFor: (event: CodeHookActivityEvent) => Promise<unknown>;
}

function sinkHarness(options: { config?: unknown; stdout?: string; hookFlag?: boolean; trusted?: boolean } = {}): SinkHarness {
  const persisted: CreateCodeActivityEventInput[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const sink = createCodeRunActivitySink({
    store: {
      async createCodeActivityEvent(input: CreateCodeActivityEventInput) {
        persisted.push(input);
        return { id: `evt-${persisted.length}` };
      },
    },
    workspaceId: "ws-c13",
    log: (event) => { logged.push(event); },
  });
  const activityFor = (event: CodeHookActivityEvent) => {
    // The same adaptation the composition root uses: one family per event, chosen by the event itself.
    const target = event.kind === "run_activity"
      ? activitySinkForKind(sink, "run_activity")
      : activitySinkForKind(sink, "code_tool_activity");
    return target.record(event);
  };
  const execute = vi.fn(async () => ({ stdout: options.stdout ?? "", exitCode: 0 }));
  const deps: CodeHooksDeps = {
    bus: new AgentLifecycleHookManager(),
    flags: { isEnabled: async () => options.hookFlag !== false },
    trust: { isTrusted: async () => options.trusted !== false },
    readConfig: async () => options.config ?? null,
    sandbox: { execute: execute as unknown as NonNullable<CodeHooksDeps["sandbox"]>["execute"] },
    activity: { record: (event) => activityFor(event) },
  };
  return { service: new CodeHooksService(deps), persisted, logged, execute, activityFor };
}

describe("[C13] [security-gate] hook Activity is metadata only", () => {
  it("persists an invocation and its result without the config body, the command line or any output", async () => {
    const h = sinkHarness({
      config: { hooks: [{ id: "gate", event: "PreToolUse", type: "command", command: "node .npati/gate.js --strict" }] },
      stdout: JSON.stringify({ warnings: ["3 files would be reformatted"] }),
    });
    const outcome = await h.service.preToolUse({
      ctx: owner, companyId: "company-c13", projectId: "project-c13", sessionId: "session-c13",
      runId: "run-1", snapshotId: "snap-1", tool: "code.fs.read", toolCallId: "call-1",
    });
    expect(outcome.executed).toBe(true);
    expect(h.persisted).toHaveLength(1);
    const event = h.persisted[0]!;
    expect(event.kind).toBe("code_tool_activity");
    expect(event.snapshotId).toBe("snap-1");
    expect(event.payload).toMatchObject({
      hookEvent: "PreToolUse", hookId: "gate", transport: "command", result: "ok", warnings: 1,
    });
    expect(typeof event.payload.durationMs).toBe("number");
    // No content, anywhere: not the command line the hook ran, not its output, not the config body.
    const serialized = JSON.stringify({ persisted: h.persisted, logged: h.logged });
    expect(serialized).not.toContain("gate.js");
    expect(serialized).not.toContain("reformatted");
    expect(serialized).not.toContain("--strict");
    // The AuditLog vocabulary is absent: an Activity event is not a decision record.
    for (const key of ["actor", "actorRole", "decision", "resourceType", "resourceId"]) {
      expect(Object.keys(event.payload)).not.toContain(key);
    }
  });

  it("records a blocked hook as a result code, never as the reason text", async () => {
    const h = sinkHarness({
      config: { hooks: [{ id: "gate", event: "PreToolUse", type: "command", command: "node gate.js" }] },
      stdout: JSON.stringify({ block: true, reason: "release freeze: do not touch src/orders.ts" }),
    });
    const outcome = await h.service.preToolUse({
      ctx: owner, companyId: "company-c13", projectId: "project-c13", tool: "code.fs.write", toolCallId: "call-2",
    });
    expect(outcome.blocked).toBe(true);
    expect(h.persisted[0]?.payload).toMatchObject({ result: "blocked", hookId: "gate" });
    expect(JSON.stringify({ persisted: h.persisted, logged: h.logged })).not.toContain("release freeze");
  });

  it("records the trust and flag skips with codes, so a silently ignored repository is visible", async () => {
    const untrusted = sinkHarness({ trusted: false, config: { hooks: [{ id: "g", event: "PreToolUse", type: "command", command: "x" }] } });
    await untrusted.service.preToolUse({ ctx: owner, companyId: "c", projectId: "p", tool: "code.fs.read", toolCallId: "t1" });
    expect(untrusted.persisted[0]?.payload).toMatchObject({ result: "skipped", code: "hook_project_untrusted" });
    expect(untrusted.execute).toHaveBeenCalledTimes(0);

    const disabled = sinkHarness({ hookFlag: false, config: { hooks: [{ id: "g", event: "PreToolUse", type: "command", command: "x" }] } });
    await disabled.service.preToolUse({ ctx: owner, companyId: "c", projectId: "p", tool: "code.fs.read", toolCallId: "t2" });
    expect(disabled.persisted[0]?.payload).toMatchObject({ result: "skipped", code: "hook_flag_disabled" });
  });

  it("records SessionStart and Stop in the run family, with no tool and no model-visible text", async () => {
    const h = sinkHarness({
      config: {
        hooks: [
          { id: "boot", event: "SessionStart", type: "command", command: "node warm.js" },
          { id: "bye", event: "Stop", type: "command", command: "node report.js" },
        ],
      },
      stdout: JSON.stringify({ context: "the repository uses pnpm", trust: "untrusted_data" }),
    });
    const started = await h.service.sessionStart({ ctx: owner, companyId: "c", projectId: "p", sessionId: "s", runId: "run-1" });
    const stopped = await h.service.stop({ ctx: owner, companyId: "c", projectId: "p", sessionId: "s", runId: "run-1", status: "completed", reason: "completed" });
    expect(started.event).toBe("SessionStart");
    expect(stopped.event).toBe("Stop");
    // The hook's model-visible context is returned to the caller, but the Activity event stores only its size.
    expect(started.context).toHaveLength(1);
    expect(h.persisted.map((event) => event.kind)).toEqual(["run_activity", "run_activity"]);
    const serialized = JSON.stringify({ persisted: h.persisted, logged: h.logged });
    expect(serialized).not.toContain("the repository uses pnpm");
    expect(serialized).toContain("contextChars");
  });

  it("never lets a credential reach Activity or the log, even from the hook's own output", async () => {
    const h = sinkHarness({
      config: { hooks: [{ id: "leaky", event: "PreToolUse", type: "command", command: "node leaky.js" }] },
      stdout: JSON.stringify({ warnings: [`export TOKEN=${GHP}`] }),
    });
    const outcome = await h.service.preToolUse({ ctx: owner, companyId: "c", projectId: "p", tool: "code.fs.read", toolCallId: "t" });
    // The result is refused outright (never scrubbed), so neither the model nor the journal sees it.
    expect(outcome.warnings).toEqual([]);
    expect(outcome.refusals).toContain("hook_result_secret");
    expect(h.persisted[0]?.payload).toMatchObject({ result: "refused", code: "hook_result_secret" });
    expect(JSON.stringify({ persisted: h.persisted, logged: h.logged })).not.toContain(GHP);
    expect(JSON.stringify({ persisted: h.persisted, logged: h.logged })).not.toContain("leaky.js");
  });
});

describe("[C13] [security-gate] the Activity guards are the ones that really run", () => {
  it("rejects content-like keys and secret-shaped values (negative control for the two guards)", async () => {
    const h = sinkHarness();
    // The positive direction: the shape the hook service emits passes the real guard.
    await h.activityFor({
      kind: "code_tool_activity", companyId: "c", projectId: "p", hookEvent: "PreToolUse",
      hookId: "gate", transport: "command", result: "ok", warnings: 0, contextChars: 0, durationMs: 3,
    });
    expect(h.persisted).toHaveLength(1);
    // A content key is refused loudly rather than stripped …
    let contentCode = "";
    try {
      await h.activityFor({ kind: "code_tool_activity", companyId: "c", hookEvent: "PreToolUse", command: "node gate.js" });
    } catch (error) {
      contentCode = (error as ActivityContentRejectedError).code;
    }
    expect(contentCode).toBe("activity_payload_must_not_carry_content");
    // … and a secret in an innocuous key is caught by value.
    let secretCode = "";
    try {
      await h.activityFor({ kind: "code_tool_activity", companyId: "c", hookEvent: "PreToolUse", note: GHP });
    } catch (error) {
      secretCode = (error as ActivitySecretRejectedError).code;
    }
    expect(secretCode).toBe("activity_payload_must_not_carry_secrets");
    // Nothing was written by either refusal.
    expect(h.persisted).toHaveLength(1);
  });

  it("code_activity_events is not the AuditLog: the hook subsystem holds no audit port", () => {
    const source = readFileSync(new URL("../apps/agent-api/src/code-hooks.ts", import.meta.url), "utf8");
    // No journal dependency exists, so a hook invocation cannot be mistaken for an administrative decision.
    expect(/audit/i.test(source)).toBe(false);
    // The privileged decisions that *are* journalled live in the trust service, and they are audited before
    // they are applied — that is the boundary the owner drew, and it is unchanged by C13.
    const trust = readFileSync(new URL("../apps/agent-api/src/code-project-trust.ts", import.meta.url), "utf8");
    const auditCall = trust.indexOf("await this.deps.audit.record({");
    const writeCall = trust.indexOf("return this.deps.store.setProjectCodeTrust(");
    expect(auditCall).toBeGreaterThan(0);
    expect(writeCall).toBeGreaterThan(auditCall);
  });
});
