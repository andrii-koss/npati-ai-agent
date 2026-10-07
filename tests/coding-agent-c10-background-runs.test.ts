import { describe, expect, it } from "vitest";
import {
  CODE_BACKGROUND_RUN_EVENT_LIMIT,
  CodeBackgroundRunRegistry,
} from "../apps/agent-api/src/code-background-run-registry";
import { connectionWantsNotification } from "../apps/agent-api/src/code-background-run-notifications";
import { defaultMessagingConnectionSettings } from "../apps/agent-api/src/messaging-integrations-repository";
import { isValidCodeFlagKey } from "../apps/agent-api/src/feature-flags";
import { CODE_BACKGROUND_RUN_ACTIONS } from "../apps/agent-api/src/code-background-run-routes";

/**
 * C10 security-gate suite (ТЗ item 5): a long code run outlives the tab that started it.
 *
 * What is pinned, and why each part is load-bearing:
 *
 *  - **The run owns its signal.** A background run is registered with its **own** `AbortController`, so a client
 *    disconnect cannot reach it. This is the defect the step exists to remove: the chat entry point ran the loop
 *    inside the HTTP request and aborted it from `reply.raw.once("close")`.
 *  - **Missed events are replayable.** Every event carries a monotonic `seq`, the reader filters on `fromSeq`, and
 *    the terminal event is always retained — a client that reloads gets the tail it missed instead of a gap, which
 *    is what makes "return to the stream" honest rather than approximate.
 *  - **The buffers are bounded.** A process that runs for weeks must not accumulate finished runs or unbounded
 *    event lists; a **live** run is never evicted to make room, because losing a live record would turn work that
 *    is still executing into work nobody can see or stop.
 *  - **An unknown run answers with an empty identity.** A foreign run and a nonexistent one must be
 *    indistinguishable, so the snapshot of an unknown run carries no ids at all.
 *  - **`notifications.backgroundResults` is finally read.** The switch existed in the schema, in the migration
 *    defaults and in the UI in eight locales with no server reader; this asserts the reader, including the case
 *    that matters most: an approval request is not silenced by a results switch.
 */

const ticket = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  sessionId: "session-1",
  companyId: "company-1",
  userId: "user-1",
  projectId: "project-1",
  ...overrides,
});

describe("security-gate: C10 background runs — the run owns its own signal", () => {
  it("registers a run with a signal that a client disconnect cannot reach", () => {
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start(ticket());
    // The signal the runner receives belongs to the registry, not to a transport controller.
    expect(sink.signal).toBeInstanceOf(AbortSignal);
    expect(sink.signal.aborted).toBe(false);
    expect(registry.isLive("run-1")).toBe(true);
    expect(registry.signalFor("run-1")).toBe(sink.signal);
    expect(registry.sessionFor("run-1")).toBe("session-1");
  });

  it("aborts only through the registry, and only once the run asked to stop", () => {
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start(ticket());
    expect(registry.abort("run-1", "Stopped by request")).toBe(true);
    expect(sink.signal.aborted).toBe(true);
    // The abort is a signal; the run's own `finish` writes the terminal status, so a second abort changes nothing.
    expect(registry.abort("run-1")).toBe(true);
    sink.finish("cancelled", "Stopped by request");
    expect(registry.abort("run-1")).toBe(false);
    expect(registry.read("run-1").snapshot.status).toBe("cancelled");
    expect(registry.read("run-1").snapshot.live).toBe(false);
  });

  it("reports an unknown run with no identity at all, so it cannot be an existence oracle", () => {
    const registry = new CodeBackgroundRunRegistry();
    const read = registry.read("run-foreign");
    expect(read.kind).toBe("unknown");
    expect(read.events).toEqual([]);
    expect(read.snapshot.runId).toBe("");
    expect(read.snapshot.sessionId).toBe("");
    expect(read.snapshot.companyId).toBe("");
    expect(registry.signalFor("run-foreign")).toBeNull();
    expect(registry.sessionFor("run-foreign")).toBeNull();
  });
});

describe("security-gate: C10 background runs — replayable events with a bounded buffer", () => {
  it("numbers every event monotonically and returns only what a reconnecting client missed", () => {
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start(ticket());
    sink.emit("progress", { step: 1 });
    sink.emit("delta", { text: "a" });
    sink.emit("progress", { step: 2 });

    const all = registry.read("run-1");
    expect(all.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(all.snapshot.lastSeq).toBe(3);

    const missed = registry.read("run-1", 2);
    expect(missed.events.map((event) => event.seq)).toEqual([3]);
    expect(registry.read("run-1", 3).events).toEqual([]);
  });

  it("delivers live events to a subscriber and always keeps the terminal event", () => {
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start(ticket());
    const seen: string[] = [];
    const detach = registry.subscribe("run-1", (event) => seen.push(`${event.seq}:${event.event}`));
    expect(detach).not.toBeNull();

    sink.emit("progress", { step: 1 });
    sink.finish("completed", null);
    // The subscriber saw the live progress and the terminal event; the terminal event is retained for a reader
    // that attaches afterwards, which is what makes a reload after completion still honest.
    expect(seen).toEqual(["1:progress", "2:terminal"]);
    const late = registry.read("run-1");
    expect(late.kind).toBe("finished");
    expect(late.snapshot.status).toBe("completed");
    expect(late.events[late.events.length - 1]!.event).toBe("terminal");
    // An event emitted after the terminal event is refused rather than appended: a finished run has one ending.
    sink.emit("progress", { step: 9 });
    expect(registry.read("run-1").events.length).toBe(late.events.length);
  });

  it("bounds the per-run event list but never drops the terminal event", () => {
    const registry = new CodeBackgroundRunRegistry({ eventLimit: 5 });
    const sink = registry.start(ticket());
    for (let index = 0; index < 20; index += 1) sink.emit("delta", { index });
    sink.finish("completed", null);
    const read = registry.read("run-1");
    expect(read.events.length).toBeLessThanOrEqual(5);
    expect(read.events[read.events.length - 1]!.event).toBe("terminal");
    // The sequence is still monotonic and the last number is the terminal one, so `fromSeq` stays meaningful even
    // after the buffer overflowed.
    expect(read.snapshot.lastSeq).toBe(read.events[read.events.length - 1]!.seq);
  });

  it("declares the caps it enforces", () => {
    expect(CODE_BACKGROUND_RUN_EVENT_LIMIT).toBeGreaterThanOrEqual(100);
  });

  it("evicts finished runs at the cap and never evicts a live one", () => {
    const registry = new CodeBackgroundRunRegistry({ trackedLimit: 2 });
    const live = registry.start(ticket({ runId: "run-live", sessionId: "session-live" }));
    const first = registry.start(ticket({ runId: "run-first" }));
    first.finish("completed", null);
    // Registering a third run evicts the finished one, not the live one.
    registry.start(ticket({ runId: "run-third" }));
    expect(registry.startSnapshot("run-first")).toBeNull();
    expect(registry.isLive("run-live")).toBe(true);
    expect(registry.list().length).toBeGreaterThan(0);
    // `forget` refuses a live run: dropping it would hide work that is still executing.
    expect(registry.forget("run-live")).toBe(false);
    live.finish("failed", "boom");
    expect(registry.forget("run-live")).toBe(true);
    expect(registry.startSnapshot("run-live")).toBeNull();
  });

  it("calls the terminal hook exactly once, with the status the run actually ended in", async () => {
    const terminal: string[] = [];
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start(ticket({ onTerminal: (snapshot) => { terminal.push(`${snapshot.status}:${snapshot.reason}`); } }));
    sink.finish("failed", "tool_failure");
    sink.finish("completed", null);
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal).toEqual(["failed:tool_failure"]);
  });

  it("reuses the existing C7 stop action for the abort route instead of inventing a permission", () => {
    expect(CODE_BACKGROUND_RUN_ACTIONS).toEqual({ read: "code.changes.read", abort: "code.session.stop" });
    // `code.background_runs` is the flag the surface reads; the allowlist must keep accepting it.
    expect(isValidCodeFlagKey("code.background_runs")).toBe(true);
  });
});

describe("security-gate: C10 background runs — the notifications switch is read", () => {
  it("reads notifications.backgroundResults and defaults it to on", () => {
    const defaults = defaultMessagingConnectionSettings();
    expect(defaults.notifications.backgroundResults).toBe(true);
    expect(connectionWantsNotification("background_run", defaults)).toBe(true);
    const muted = defaultMessagingConnectionSettings();
    muted.notifications.backgroundResults = false;
    expect(connectionWantsNotification("background_run", muted)).toBe(false);
    // The other switches stay independent: turning background results off must not silence automations.
    expect(connectionWantsNotification("automation", muted)).toBe(true);
  });

  it("never silences an approval request by a results switch", () => {
    const resultsOff = defaultMessagingConnectionSettings();
    resultsOff.notifications.backgroundResults = false;
    resultsOff.notifications.automationResults = false;
    expect(connectionWantsNotification("background_run", resultsOff)).toBe(false);
    expect(connectionWantsNotification("approval", resultsOff)).toBe(true);

    const everythingOff = defaultMessagingConnectionSettings();
    everythingOff.notifications.backgroundResults = false;
    everythingOff.notifications.automationResults = false;
    everythingOff.notifications.errors = false;
    everythingOff.notifications.status = false;
    // A run blocked on an unanswered approval must still reach its owner, or it is stuck forever with nobody told.
    expect(connectionWantsNotification("approval", everythingOff)).toBe(true);
  });

  it("keeps the automation switch meaningful", () => {
    const muted = defaultMessagingConnectionSettings();
    muted.notifications.automationResults = false;
    expect(connectionWantsNotification("automation", muted)).toBe(false);
  });
});
