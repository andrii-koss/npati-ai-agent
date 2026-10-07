import { describe, expect, it } from "vitest";
import {
  CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY,
  CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER,
  CodeRunQueue,
  CodeRunRefusedError,
  DEFAULT_CODE_RUN_QUEUE_LIMITS,
  resolveCodeRunQueueLimits,
  type CodeRunLease,
  type CodeRunTicket,
} from "../apps/agent-api/src/code-run-queue";

/**
 * C10 security-gate suite (ТЗ item 6): the code-run limit and the fairness of the queue behind it.
 *
 * The properties, and the failure each one prevents:
 *
 *  - **Configured, and clamped.** The caps come from the environment; a value above the hard ceiling is clamped
 *    rather than honoured, so configuration cannot remove the limit it exists to impose, and a non-numeric value
 *    falls back instead of becoming `NaN` (an un-comparable cap is an unlimited one).
 *  - **Two independent caps.** A user limit and a company limit, because those are the two things a person can
 *    exhaust. Each is asserted alone so neither can be satisfied by the other's counter.
 *  - **Fair, not first-come-first-served.** One Company with many waiting runs cannot push another Company's single
 *    run to the back of the line: the next free slot goes to the Company that has waited longest **without** a
 *    grant (round-robin), and only then in arrival order. This is the whole point of a queue rather than a counter.
 *  - **Bounded.** A ticket that waits too long is refused with `queue_timeout`, the queue has a depth cap, and a
 *    cancellation reaches a waiting ticket without touching a run that already started.
 *  - **A released slot is reusable and the release is idempotent**, so a `finally` cannot double-count.
 *
 * A ticket is created through `hold()`, which attaches its rejection handler **at creation** and exposes the
 * outcome as a value. A promise that a failed assertion leaves behind is therefore already handled — an unhandled
 * rejection terminates the process, which would hide the very assertion that caused it.
 */

const ticket = (overrides: Partial<CodeRunTicket> = {}): CodeRunTicket => ({
  workspaceId: "workspace-1",
  userId: "user-1",
  companyId: "company-1",
  sessionId: "session-1",
  ...overrides,
});

interface Hold {
  /** Resolves with the lease, or with `null` when the ticket was refused (the reason is on `code`). */
  readonly outcome: Promise<CodeRunLease | null>;
  /** The lease once granted. Throws a readable error rather than hanging when the ticket was refused. */
  lease(): Promise<CodeRunLease>;
  /** The refusal code, or `null` when the ticket was granted. */
  code(): Promise<string | null>;
}

/**
 * A ticket with its outcome captured as a value, never as an exception on an unobserved promise.
 *
 * `per` and `user` describe which cap the ticket is expected to consume; both are mutated by the helper so the
 * suites below read as the sequence of `acquire` calls they are, without a `queue.acquire(ticket(...))` spread.
 */
function hold(queue: CodeRunQueue, overrides: Partial<CodeRunTicket> = {}, waitMs = 10_000): Hold {
  const outcome = queue.acquire(ticket(overrides), { timeoutMs: waitMs }).then(
    (lease) => ({ lease, code: null as string | null }),
    (error: unknown) => ({ lease: null, code: error instanceof CodeRunRefusedError ? error.code : `unexpected:${String(error)}` }),
  );
  return {
    outcome: outcome.then((settled) => settled.lease),
    lease: async () => {
      const settled = await outcome;
      if (!settled.lease) throw new Error(`ticket was refused with ${settled.code ?? "unknown"}`);
      return settled.lease;
    },
    code: async () => (await outcome).code,
  };
}

/** `true` when the hold has not settled yet. */
async function isPending(item: Hold): Promise<boolean> {
  return await Promise.race([item.outcome.then(() => false, () => false), Promise.resolve(true)]);
}

describe("security-gate: C10 run queue — the caps are configured and clamped", () => {
  it("reads the limits from the environment and clamps them to the hard ceiling", () => {
    const configured = resolveCodeRunQueueLimits({
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_USER: "3",
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY: "5",
      NPATI_CODE_RUN_QUEUE_TIMEOUT_MS: "45000",
      NPATI_CODE_RUN_QUEUE_MAX_DEPTH: "20",
    } as NodeJS.ProcessEnv);
    expect(configured).toEqual({
      maxConcurrentPerUser: 3,
      maxConcurrentPerCompany: 5,
      queueTimeoutMs: 45_000,
      maxQueueDepth: 20,
    });
  });

  it("falls back on nonsense and never honours a value above the ceiling", () => {
    const nonsense = resolveCodeRunQueueLimits({
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_USER: "not-a-number",
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY: "-4",
      NPATI_CODE_RUN_QUEUE_TIMEOUT_MS: "0",
      NPATI_CODE_RUN_QUEUE_MAX_DEPTH: "",
    } as NodeJS.ProcessEnv);
    expect(nonsense).toEqual(DEFAULT_CODE_RUN_QUEUE_LIMITS);

    const enormous = resolveCodeRunQueueLimits({
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_USER: "1000",
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY: "1000",
      NPATI_CODE_RUN_QUEUE_TIMEOUT_MS: String(60 * 60 * 1000),
      NPATI_CODE_RUN_QUEUE_MAX_DEPTH: "1000000",
    } as NodeJS.ProcessEnv);
    expect(enormous.maxConcurrentPerUser).toBe(CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER);
    expect(enormous.maxConcurrentPerCompany).toBe(CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY);
    expect(enormous.queueTimeoutMs).toBeLessThanOrEqual(15 * 60_000);
    expect(enormous.maxQueueDepth).toBeLessThan(1_000_000);
  });

  it("clamps a direct construction too, so the class cannot be handed an unlimited cap", () => {
    const queue = new CodeRunQueue({ maxConcurrentPerUser: 9999, maxConcurrentPerCompany: 9999, maxQueueDepth: 999999 });
    expect(queue.limits.maxConcurrentPerUser).toBe(CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER);
    expect(queue.limits.maxConcurrentPerCompany).toBe(CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY);
  });
});

describe("security-gate: C10 run queue — the concurrency caps are enforced", () => {
  it("refuses to exceed the per-Company cap and admits again after a release", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 2, queueTimeoutMs: 10_000 });
    const first = hold(queue, { userId: "user-1" });
    const firstLease = await first.lease();
    expect(queue.state().active).toBe(1);
    expect(firstLease.held).toBe(true);

    // The second ticket waits: the run is not refused, it is queued.
    const waiting = hold(queue, { userId: "user-2", sessionId: "session-2" });
    expect(await isPending(waiting)).toBe(true);
    expect(queue.state().queued).toBe(1);

    firstLease.release();
    const second = await waiting.lease();
    expect(queue.state().active).toBe(1);
    expect(second.held).toBe(true);
    second.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });

  it("enforces the per-user cap independently of the per-Company cap", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 5, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const mine = await hold(queue, { userId: "user-1", sessionId: "session-1" }).lease();
    // The same user, another company: the Company cap has room, the user cap does not.
    const sameUser = hold(queue, { userId: "user-1", companyId: "company-2", sessionId: "session-2" });
    expect(await isPending(sameUser)).toBe(true);
    // A different user in the same Company is admitted, which proves the wait was the user cap, not the company one.
    const otherUser = await hold(queue, { userId: "user-2", companyId: "company-1", sessionId: "session-3" }).lease();
    expect(otherUser.held).toBe(true);

    mine.release();
    const granted = await sameUser.lease();
    expect(granted.held).toBe(true);
    granted.release();
    otherUser.release();
    expect(queue.state().active).toBe(0);
  });

  it("releases a slot exactly once even when the release is called twice", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1 });
    const lease: CodeRunLease = await hold(queue).lease();
    lease.release();
    lease.release();
    expect(lease.held).toBe(false);
    expect(queue.state().active).toBe(0);
    // If the second release had decremented again, the counter would be wrong; admitting again and then asserting
    // the counter pins the value rather than merely the absence of a throw.
    const again = await hold(queue).lease();
    expect(queue.state().active).toBe(1);
    again.release();
    expect(queue.state().active).toBe(0);
  });
});

describe("security-gate: C10 run queue — fair service across Companies", () => {
  it("serves the quiet Company before the backlog of a busy one", async () => {
    /**
     * Company A queues **two** runs and Company B queues one while both Companies' slots are taken, and the two
     * slots then come free. The rotation serves one run per Company: A's first and B's single run start together,
     * and A's *second* run waits behind them even though both of A's runs arrived first. A first-come-first-served
     * queue would have started A's second run instead of B's — the starvation this prevents.
     */
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const holderA = await hold(queue, { companyId: "company-A", userId: "user-A0", sessionId: "session-A0" }).lease();
    const holderB = await hold(queue, { companyId: "company-B", userId: "user-B0", sessionId: "session-B0" }).lease();

    const a1 = hold(queue, { companyId: "company-A", userId: "user-A1", sessionId: "session-A1" });
    const a2 = hold(queue, { companyId: "company-A", userId: "user-A2", sessionId: "session-A2" });
    const quiet = hold(queue, { companyId: "company-B", userId: "user-B1", sessionId: "session-B1" });

    expect(queue.state().queued).toBe(3);
    // Arrival order is A1, A2, B1; the rotation interleaves B1 ahead of A's *second* run.
    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual([
      "session-A1", "session-B1", "session-A2",
    ]);

    // One grant per release, and the release that frees a *user* slot is what lets that user's second run through:
    // A's second run shares user-A1 with A's first run, so it can only start once the first one has finished.
    holderA.release();
    const servedA1 = await a1.lease();
    holderB.release();
    const servedB = await quiet.lease();
    expect(servedA1.held).toBe(true);
    expect(servedB.held).toBe(true);
    expect(queue.state().queued).toBe(1);
    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual(["session-A2"]);

    // A's first run finishes; its Company and user slots are free, and the rotation serves the remaining run.
    servedA1.release();
    const servedA2 = await a2.lease();
    expect(servedA2.held).toBe(true);
    servedA2.release();
    servedB.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });

  it("reports the waiting tickets in the order it will serve them", async () => {
    /**
     * One holder per Company and a per-user cap of one: each Company's slot is taken *and* each holder holds its own
     * user, so the three new tickets are genuinely queued rather than admitted. Both caps being exactly full is what
     * makes the queue observable at all.
     */
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const holderA = await hold(queue, { companyId: "company-A", userId: "user-A0", sessionId: "session-A0" }).lease();
    const holderB = await hold(queue, { companyId: "company-B", userId: "user-B0", sessionId: "session-B0" }).lease();
    const holderC = await hold(queue, { companyId: "company-C", userId: "user-C0", sessionId: "session-C0" }).lease();
    const a1 = hold(queue, { companyId: "company-A", userId: "user-A1", sessionId: "session-A1" });
    const b1 = hold(queue, { companyId: "company-B", userId: "user-B1", sessionId: "session-B1" });
    const c1 = hold(queue, { companyId: "company-C", userId: "user-C1", sessionId: "session-C1" });

    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual(["session-A1", "session-B1", "session-C1"]);
    expect(queue.state().queue.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(queue.state().activePerCompany).toContainEqual({ companyId: "company-A", active: 1 });

    // Each release hands the slot to the next Company in the rotation, and the rendered order follows the grant:
    // after A1 is served, Company A goes behind B and C, so B1 is next in line.
    holderA.release();
    const grantedA = await a1.lease();
    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual(["session-B1", "session-C1"]);
    grantedA.release();
    holderB.release();
    const grantedB = await b1.lease();
    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual(["session-C1"]);
    grantedB.release();
    holderC.release();
    const grantedC = await c1.lease();
    grantedC.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });
});

describe("security-gate: C10 run queue — the wait is bounded and cancellable", () => {
  it("refuses a ticket that waited too long, with its own code, and leaves the queue clean", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 1_000 });
    const holder = await hold(queue).lease();
    const waiting = hold(queue, { userId: "user-2", sessionId: "session-2" }, 1_000);
    expect(await waiting.code()).toBe("queue_timeout");
    // The refused ticket is gone: a timeout must not leave a ghost that later steals a slot.
    expect(queue.state().queued).toBe(0);
    holder.release();
    expect(queue.state().active).toBe(0);
  }, 20_000);

  it("refuses a ticket whose client disconnected while it was queued", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const holder = await hold(queue).lease();
    const controller = new AbortController();
    const waiting = queue.acquire(
      ticket({ userId: "user-2", sessionId: "session-2" }),
      { signal: controller.signal, timeoutMs: 10_000 },
    ).then(() => null, (error: unknown) => (error instanceof CodeRunRefusedError ? error.code : `unexpected:${String(error)}`));
    expect(queue.state().queued).toBe(1);
    controller.abort(new Error("Client disconnected while queued"));
    expect(await waiting).toBe("queue_cancelled");
    expect(queue.state().queued).toBe(0);
    holder.release();
  });

  it("cancels every waiting ticket of a session without touching a run that already started", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 4, queueTimeoutMs: 10_000 });
    const holder = await hold(queue, { companyId: "company-A", userId: "user-A", sessionId: "session-running" }).lease();
    const sameSession = hold(queue, { companyId: "company-A", userId: "user-A1", sessionId: "session-running" });
    const otherSession = hold(queue, { companyId: "company-A", userId: "user-A2", sessionId: "session-other" });
    expect(queue.state().queued).toBe(2);

    const cancelled = queue.cancelSession("session-running");
    expect(cancelled).toBe(1);
    expect(await sameSession.code()).toBe("queue_cancelled");
    // The running ticket is untouched — stopping a run is the Stop route's job, not the queue's.
    expect(holder.held).toBe(true);
    holder.release();
    (await otherSession.lease()).release();
    expect(queue.state().active).toBe(0);
  });

  it("refuses a new ticket when the queue is already at its depth cap", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, maxQueueDepth: 1, queueTimeoutMs: 10_000 });
    const holder = await hold(queue).lease();
    const waiting = hold(queue, { userId: "user-2", sessionId: "session-2" });
    expect(queue.state().queued).toBe(1);
    const refused = hold(queue, { userId: "user-3", sessionId: "session-3" });
    expect(await refused.code()).toBe("queue_timeout");
    holder.release();
    (await waiting.lease()).release();
    expect(queue.state().queued).toBe(0);
    expect(queue.state().active).toBe(0);
  });

  it("refuses a ticket handed an already-aborted signal instead of running it", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 2, maxConcurrentPerUser: 2 });
    const controller = new AbortController();
    controller.abort();
    const refused = await queue.acquire(ticket(), { signal: controller.signal })
      .then(() => null, (thrown: unknown) => (thrown instanceof CodeRunRefusedError ? thrown.code : `unexpected:${String(thrown)}`));
    expect(refused).toBe("queue_cancelled");
    expect(queue.state().active).toBe(0);
  });
});
