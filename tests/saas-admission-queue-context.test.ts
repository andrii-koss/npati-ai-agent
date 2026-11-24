/**
 * The shared AI admission queue starts a waiting task from whichever task just finished. On a hosted installation the
 * async context carries the account's own AI key, so a queued task must run in the context of the request that queued
 * it — never in the context of the task that freed the slot.
 */
import { currentOmniRouteCredential, withOmniRouteCredential } from "@npati/omniroute-adapter";
import { expect, it } from "vitest";
import { AdaptiveAdmissionQueue } from "../apps/agent-api/src/resilience-admission-queue";

it("runs every queued task with the key of the account that queued it", async () => {
  const queue = new AdaptiveAdmissionQueue({ maxConcurrent: 1, maxConcurrentPerTenant: 1, maxQueueLength: 10 });
  const seen: Array<[string, string | undefined]> = [];
  const task = (account: string, ms: number) => withOmniRouteCredential({ apiKey: `key-${account}` }, () =>
    queue.enqueue(async () => {
      seen.push([account, currentOmniRouteCredential()?.apiKey]);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return account;
    }, "pro", { tenantId: account }));
  // One slot: B and C wait and are started from the .finally of the task before them.
  await Promise.all([task("A", 30), task("B", 10), task("C", 1)]);
  expect(seen).toEqual([["A", "key-A"], ["B", "key-B"], ["C", "key-C"]]);
});
