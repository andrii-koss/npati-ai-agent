import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";

afterEach(() => vi.useRealTimers());

describe("durable background run audit and completion reporting", () => {
  const context: AuthContext = { workspaceId: "background-ws", userId: "background-user", permissions: ["workspace:read", "business:manage"] };

  it("keeps an idempotent lifecycle and derives a terminal completion report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T17:27:42.000Z"));
    const store = new InMemoryWorkspaceStore();
    await store.initialize(context);
    const company = await store.createCompany(context, { name: "Background Audit Co" }, "background-company");
    const agent = await store.createCompanyAgent(context, company.id, { name: "Main", role: "Manager", isActive: true }, "background-agent");
    await store.setCompanyMainAgent(context, company.id, agent.id, company.revision);
    const { run } = await store.createCompanyAgentRun(context, company.id, { task: "Produce a durable report", requestedMode: "single" }, "background-run");

    const queued = await store.appendCompanyAgentRunEvent(context, company.id, run.id, {
      eventKey: "queued", eventType: "queued", runStatus: "queued", message: "Queued",
    });
    const duplicate = await store.appendCompanyAgentRunEvent(context, company.id, run.id, {
      eventKey: "queued", eventType: "queued", runStatus: "queued", message: "Duplicate delivery",
    });
    expect(duplicate.id).toBe(queued.id);

    expect(await store.claimCompanyAgentRun(context, company.id, run.id, "worker-one", 60_000)).toBe(true);
    const claimed = (await store.getCompanyAgentRun(context, company.id, run.id)).run;
    await store.appendCompanyAgentRunEvent(context, company.id, run.id, {
      eventKey: `attempt:${claimed.attemptCount}:claimed`, eventType: "claimed", runStatus: "planning",
      workerId: "worker-one", attemptCount: claimed.attemptCount, message: "Claimed",
    });
    await store.updateCompanyAgentRun(context, company.id, run.id, {
      status: "completed", result: "BACKGROUND-REPORT-OK", totalTokens: 42, totalCost: 0.0002, totalDurationMs: 250,
    });
    await store.appendCompanyAgentRunEvent(context, company.id, run.id, {
      eventKey: "terminal:completed", eventType: "completed", runStatus: "completed",
      workerId: "worker-one", attemptCount: claimed.attemptCount, message: "Completed",
    });

    const details = await store.getCompanyAgentRun(context, company.id, run.id);
    expect(details.backgroundEvents.map((event) => event.eventType)).toEqual(["queued", "claimed", "completed"]);
    expect(details.completionReport).toMatchObject({
      runId: run.id, status: "completed", result: "BACKGROUND-REPORT-OK", workerId: "worker-one",
      attemptCount: 1, totalTokens: 42, totalCost: 0.0002, totalDurationMs: 250,
    });
    await expect(store.getCompanyAgentRun({ ...context, userId: "other-user" }, company.id, run.id)).rejects.toThrow();
  });
});
