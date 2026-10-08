/**
 * R1 (section A, items 1, 3 and 5) — **the one function that admits a code run.**
 *
 * Every code-run entry point in the deployment — the chat/Workspace stream, the CLI/IDE run-start route, and
 * any surface added later — reaches the queue through this module and through no other door. That is the whole
 * point: "the quotas are not bypassed" is not a claim about the queue's arithmetic (which was already correct)
 * but about the number of ways a run can start. Two of those ways existed and each called `queue.acquire`
 * itself, so the periodic limit added in R1 would have had to be remembered at each call site; a third would
 * have had to remember it again.
 *
 * The order is deliberate: the **periodic** check runs first (it is cheap, it needs no wait, and a client that
 * has spent its allowance must be refused rather than made to occupy a queue slot), and the **concurrency**
 * check runs second, because it is the one that may legitimately wait. `record` happens only once the slot was
 * really granted, so a run that was refused or that never started does not spend the period's allowance.
 *
 * A structural proof accompanies this file: `tests/coding-agent-r1a-limits-and-quotas.test.ts` reads `app.ts`
 * and fails if any call to `queue.acquire(` survives outside this module, which is what keeps the next surface
 * from quietly reintroducing the bypass.
 */

import type { CodeRunQueue, CodeRunLease, CodeRunTicket } from "./code-run-queue";
import type { CodeRunRateLimiter } from "./code-run-rate-limit";

export interface CodeRunAdmissionOptions {
  signal?: AbortSignal;
  onQueued?: (position: number) => void;
  timeoutMs?: number;
}

export interface CodeRunAdmission {
  /**
   * Takes a run slot: the periodic limit first, then the queue's own per-user/per-Company caps and its fair
   * queue. Throws `CodeRunRateLimitedError` when the period is spent, or the queue's `CodeRunRefusedError`
   * (`queue_timeout` / `queue_cancelled`) when the queue itself refuses.
   */
  admit(ticket: CodeRunTicket, options?: CodeRunAdmissionOptions): Promise<CodeRunLease>;
  /**
   * True when a ticket could start **right now** without waiting. Both limits are consulted, so a caller that
   * is past the point where it could report an honest HTTP refusal refuses for the same reasons the queue
   * would — the period as well as the concurrency.
   */
  canAdmit(ticket: Pick<CodeRunTicket, "userId" | "companyId">): boolean;
}

export function createCodeRunAdmission(queue: CodeRunQueue, rateLimiter: CodeRunRateLimiter): CodeRunAdmission {
  return {
    canAdmit(ticket) {
      return rateLimiter.check(ticket).allowed && queue.canAdmit(ticket);
    },
    async admit(ticket, options = {}) {
      rateLimiter.assertWithinLimit(ticket);
      const lease = await queue.acquire(ticket, options);
      rateLimiter.record(ticket);
      return lease;
    },
  };
}
