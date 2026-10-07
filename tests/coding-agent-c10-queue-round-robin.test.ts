import { describe, expect, it } from "vitest";
import { CodeRunQueue, type CodeRunTicket } from "../apps/agent-api/src/code-run-queue";

/**
 * C10 security-gate suite (ТЗ item 6): the **round-robin** property, isolated from the caps and the state surface
 * that `tests/coding-agent-c10-run-queue.test.ts` covers.
 *
 * The property measured here is the only one the queue exists for, and it is measured over a **sequence of grants**
 * rather than asserted on a single counter: when two Companies have runs waiting, the slot that comes free goes to
 * the Company whose turn it is — never twice in a row to a Company that merely has a longer backlog. A
 * first-come-first-served queue satisfies every counter assertion and still starves the quiet tenant, so the grant
 * order is what is measured.
 */

const ticket = (overrides: Partial<CodeRunTicket> = {}): CodeRunTicket => ({
  workspaceId: "workspace-1",
  userId: "user-1",
  companyId: "company-1",
  sessionId: "session-1",
  ...overrides,
});

describe("security-gate: C10 run queue — round-robin across Companies", () => {
  it("alternates Companies across consecutive releases when one Company has a backlog", async () => {
    /**
     * Company A holds its slot and queues two runs; Company B holds its slot and queues one. Company A's backlog
     * arrived first, and the rotation must still serve B's single run no later than A's *second* run. A
     * first-come-first-served queue would produce A1, A2, B1 — B waiting out A's whole backlog.
     */
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const granted: string[] = [];
    const record = (name: string) => (lease: { release(): void }) => { granted.push(name); return lease; };

    const holderA = await queue.acquire(ticket({ companyId: "company-A", userId: "user-A0", sessionId: "session-A0" }));
    const holderB = await queue.acquire(ticket({ companyId: "company-B", userId: "user-B0", sessionId: "session-B0" }));
    const a1 = queue.acquire(ticket({ companyId: "company-A", userId: "user-A1", sessionId: "session-A1" })).then(record("A1"));
    const a2 = queue.acquire(ticket({ companyId: "company-A", userId: "user-A2", sessionId: "session-A2" })).then(record("A2"));
    const b1 = queue.acquire(ticket({ companyId: "company-B", userId: "user-B1", sessionId: "session-B1" })).then(record("B1"));

    expect(queue.state().queue.map((entry) => entry.sessionId)).toEqual([
      "session-A1", "session-B1", "session-A2",
    ]);

    holderA.release();
    const leaseA1 = await a1;
    holderB.release();
    const leaseB1 = await b1;
    // B was served before A's second run: the backlog did not go first.
    expect(granted).toEqual(["A1", "B1"]);

    leaseA1.release();
    const leaseA2 = await a2;
    expect(granted).toEqual(["A1", "B1", "A2"]);

    leaseA2.release();
    leaseB1.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });

  it("keeps a Company alone in the rotation flowing without waiting for a turn", async () => {
    // With no other tenant waiting there is nothing to be fair to, so the single Company's backlog drains in order.
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, queueTimeoutMs: 10_000 });
    const holder = await queue.acquire(ticket({ companyId: "company-A", userId: "user-A0", sessionId: "session-A0" }));
    const first = queue.acquire(ticket({ companyId: "company-A", userId: "user-A1", sessionId: "session-A1" }));
    const second = queue.acquire(ticket({ companyId: "company-A", userId: "user-A2", sessionId: "session-A2" }));
    expect(queue.state().queued).toBe(2);

    holder.release();
    const leaseFirst = await first;
    leaseFirst.release();
    const leaseSecond = await second;
    expect(leaseSecond.held).toBe(true);
    leaseSecond.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });
});
