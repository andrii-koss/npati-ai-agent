import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";

// Delivery and DNS are replaced; the destination policy itself stays real for the blocked-target case.
const delivered: Array<{ url: string; body: unknown }> = [];
let status = 204;
vi.mock("../apps/agent-api/src/webhook-destination-policy", async (original) => ({
  ...(await original<typeof import("../apps/agent-api/src/webhook-destination-policy")>()),
  validateWebhookDestination: vi.fn(async (url: string) => { if (/169\.254|localhost/.test(url)) throw new Error("[webhook_destination_blocked:forbidden_host]"); }),
  deliverWebhook: vi.fn(async (url: string, options: { body?: string }) => { delivered.push({ url, body: JSON.parse(String(options.body)) }); return { ok: status < 300, status } as never; }),
}));
const { registerCompanyAutomationsRoutes } = await import("../apps/agent-api/src/automations-routes");
const { CompanyAutomationsRepository } = await import("../apps/agent-api/src/automations-repository");

const auth: AuthContext = { userId: "fv5-12-dispatch", workspaceId: "fv5-12-dispatch", permissions: ["workspace:read", "business:manage"] };

describe("Final V5 stage 12: outbound webhook dispatch", () => {
  it("V5-D72: success means a real 2xx delivery; a failed delivery and a foreign DLQ item are reported honestly", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Hook Shop" }, "hook-shop");
    const other = await store.createCompany(auth, { name: "Other Shop" }, "other-shop");
    const app = Fastify();
    registerCompanyAutomationsRoutes(app, { auth: { authenticate: async () => auth } as never, store, repo: new CompanyAutomationsRepository() } as never);
    const dispatch = (url: string) => app.inject({ method: "POST", url: `/companies/${company.id}/webhooks/dispatch`, payload: { url, eventType: "order.created", data: { order: 7 }, maxRetries: 1 } });

    const ok = (await dispatch("https://hooks.example.test/a")).json();
    expect(ok.result).toMatchObject({ success: true, attempts: 1 });
    expect(delivered).toEqual([{ url: "https://hooks.example.test/a", body: { eventType: "order.created", data: { order: 7 } } }]);

    status = 500;
    const failed = (await dispatch("https://hooks.example.test/b")).json();
    expect(failed.result.success).toBe(false);
    expect(failed.result.dlqEntry.lastError).toMatch(/HTTP_ERROR/);

    const blocked = (await dispatch("https://169.254.169.254/latest")).json();
    expect(blocked.result.success).toBe(false);
    expect(delivered.map((item) => item.url)).not.toContain("https://169.254.169.254/latest");

    const foreign = await app.inject({ method: "POST", url: `/companies/${other.id}/webhooks/dlq/${failed.result.dlqEntry.dlqId}/replay` });
    expect(foreign.statusCode).toBe(404);
    status = 200;
    const replay = (await app.inject({ method: "POST", url: `/companies/${company.id}/webhooks/dlq/${failed.result.dlqEntry.dlqId}/replay` })).json();
    expect(replay.replayed).toBe(true);
    expect(delivered.at(-1)?.url).toBe("https://hooks.example.test/b");
    await app.close();
  });
});
