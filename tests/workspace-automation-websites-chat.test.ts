import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CompanyAgentRunDetails } from "@npati/workspace";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import type { BrowserCampaignTarget, BrowserCampaignTargetInput } from "../apps/agent-api/src/browser-credentials-repository";
import { ContentLibraryStore } from "../apps/agent-api/src/content-library-store";
import { WorkspaceChatActions, type WorkspaceChatActionDependencies } from "../apps/agent-api/src/workspace-chat-actions";

const alice: AuthContext = { userId: "automation-alice", workspaceId: "automation-shared", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "automation-bob", workspaceId: "automation-shared", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => "before\n\n```workspace-action\n" + JSON.stringify(value) + "\n```";

class TargetStore {
  private sequence = 0;
  private records: Array<BrowserCampaignTarget & { workspaceId: string; userId: string; companyId: string }> = [];

  async listTargets(ctx: AuthContext, companyId: string): Promise<BrowserCampaignTarget[]> {
    return this.records.filter((item) => item.workspaceId === ctx.workspaceId && item.userId === ctx.userId && item.companyId === companyId);
  }

  async createTarget(ctx: AuthContext, companyId: string, input: BrowserCampaignTargetInput): Promise<BrowserCampaignTarget> {
    const now = new Date().toISOString();
    const url = new URL(input.registrationUrl);
    const item = {
      id: "site-" + ++this.sequence,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      companyId,
      automationId: input.automationId ?? null,
      emailAccountId: input.emailAccountId ?? null,
      credentialId: null,
      siteName: input.siteName,
      registrationUrl: input.registrationUrl,
      publishUrl: input.publishUrl ?? null,
      allowedDomain: url.hostname,
      articleTitle: input.articleTitle ?? null,
      articleBody: input.articleBody ?? null,
      status: input.status === "paused" ? "paused" as const : "pending" as const,
      resultUrl: null,
      browserJobId: null,
      lastRunId: null,
      errorMessage: null,
      attempts: 0,
      priority: input.priority ?? 100,
      lastAttemptAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(item);
    return item;
  }

  async updateTarget(ctx: AuthContext, companyId: string, id: string, input: Partial<BrowserCampaignTargetInput>): Promise<BrowserCampaignTarget> {
    const current = this.records.find((item) => item.id === id && item.workspaceId === ctx.workspaceId && item.userId === ctx.userId && item.companyId === companyId);
    if (!current) throw new Error("not found");
    Object.assign(current, input, { updatedAt: new Date().toISOString() });
    return current;
  }

  async deleteTarget(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    const index = this.records.findIndex((item) => item.id === id && item.workspaceId === ctx.workspaceId && item.userId === ctx.userId && item.companyId === companyId);
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
}

function completed(companyId: string): CompanyAgentRunDetails {
  const now = new Date().toISOString();
  return {
    run: {
      id: "run", workspaceId: alice.workspaceId, companyId, userId: alice.userId, mainAgentId: "agent",
      idempotencyKey: "key", task: "task", requestedMode: "auto", executionMode: "single", status: "completed",
      selectedAgentIds: [], result: "done", cancelRequested: false, attemptCount: 1, maxAttempts: 1,
      nextAttemptAt: now, totalDurationMs: 1, createdAt: now, updatedAt: now,
    },
    steps: [], toolAudit: [], backgroundEvents: [],
  };
}

describe("automation and Website registration/publishing from chat", () => {
  it("recognizes website and automation status requests", () => {
    expect(WorkspaceChatActions.isManagementRequest("Додай сайт для реєстрації та публікації завтра")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Покажи, який агент має які завдання і коли починає роботу")).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest("Show website publishing status")).toBe(true);
  });

  it("creates scheduled website targets and reports assigned agent work", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const targets = new TargetStore();
    const company = await store.createCompany(alice, { name: "Alice Publishing" }, "website-company");
    const agent = await store.createCompanyAgent(alice, company.id, { name: "Publisher", role: "Content publisher" }, "publisher-agent");
    const automation = await automations.create(alice, company.id, {
      name: "Website publishing", prompt: "Register and publish approved articles", cronExpression: "0 9 * * *", agentId: agent.id,
    });
    const account = { id: "mail-1", emailAddress: "test@npati.com", displayName: "Publishing", status: "connected" };
    let immediateRuns = 0;
    const deps: WorkspaceChatActionDependencies = {
      store,
      automations,
      content: new ContentLibraryStore(store),
      browserTargets: targets,
      email: {
        listAccounts: async () => [account] as any,
        getAccount: async (_ctx, _companyId, id) => id === account.id ? account as any : null,
      },
      runCompany: async (_ctx, companyId) => completed(companyId),
      cancelCompanyRun: async (_ctx, companyId) => completed(companyId),
      runAutomation: async () => { immediateRuns++; return { runId: "automation-run", result: "Processed 1 website", durationMs: 25 }; },
    };
    const startAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.create",
      companyId: company.id,
      automationId: automation.id,
      emailAccountId: account.id,
      startAt,
      intro: "Сайт додано.",
      websites: [{
        siteName: "Example Publisher",
        registrationUrl: "https://example.com/register",
        publishUrl: "https://example.com/articles/new",
        articleTitle: "Launch",
        articleBody: "Approved article body",
      }],
    }), deps, "website-create", { requestMessage: "Додай сайт і заплануй на завтра" });
    expect(created.workspaceAction).toEqual(expect.objectContaining({ action: "website.create", companyId: company.id }));
    expect(await targets.listTargets(alice, company.id)).toEqual([
      expect.objectContaining({ automationId: automation.id, emailAccountId: account.id, status: "pending" }),
    ]);
    expect(await automations.get(alice, company.id, automation.id)).toEqual(expect.objectContaining({ status: "active", nextRunAt: startAt }));

    const list = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "automation.list", companyId: company.id, intro: "Поточні завдання.",
    }), deps, "automation-list", { requestMessage: "Покажи, який агент має завдання і коли старт" });
    expect(list.cleanText).toContain("Publisher");
    expect(list.cleanText).toContain(startAt);

    const websites = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.list", companyId: company.id, intro: "Сайти.",
    }), deps, "website-list", { requestMessage: "Покажи сайти" });
    expect(websites.cleanText).toContain("Example Publisher");
    expect(websites.cleanText).toContain("test@npati.com");

    const websiteId = (await targets.listTargets(alice, company.id))[0]!.id;
    const updatedWebsite = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.update", companyId: company.id, websiteId, intro: "Сайт оновлено.",
      website: { siteName: "Example Publisher", registrationUrl: "https://example.com/register", articleTitle: "Updated launch", status: "paused" },
    }), deps, "website-update", { requestMessage: "Призупини сайт і онови заголовок" });
    expect(updatedWebsite.workspaceAction?.action).toBe("website.update");
    expect((await targets.listTargets(alice, company.id))[0]).toEqual(expect.objectContaining({ articleTitle: "Updated launch", status: "paused" }));

    const run = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "automation.run", companyId: company.id, automationId: automation.id, intro: "Запущено.",
    }), deps, "automation-run", { requestMessage: "Запусти автоматизацію зараз" });
    expect(run.cleanText).toContain("Processed 1 website");
    expect(immediateRuns).toBe(1);

    const demos = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.seed_demo", companyId: company.id, automationId: automation.id, emailAccountId: account.id, intro: "Демо-сайти додано.",
    }), deps, "website-demo", { requestMessage: "Додай 2 призупинені демо-сайти" });
    expect(demos.workspaceAction?.action).toBe("website.seed_demo");
    expect((await targets.listTargets(alice, company.id)).filter((target) => target.status === "paused")).toHaveLength(3);

    const runRecord = await automations.recordRunStart(await automations.get(alice, company.id, automation.id));
    await automations.recordRunComplete(runRecord.id, automation.id, startAt, "Published successfully", 40);
    const history = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "automation.history", companyId: company.id, automationId: automation.id, intro: "Історія запусків.",
    }), deps, "automation-history", { requestMessage: "Покажи історію запусків автоматизації" });
    expect(history.cleanText).toContain("Published successfully");

    const removed = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.delete", companyId: company.id, websiteId, intro: "Сайт видалено.",
    }), deps, "website-delete", { requestMessage: "Видали цей сайт" });
    expect(removed.workspaceAction?.action).toBe("website.delete");
    expect((await targets.listTargets(alice, company.id)).some((target) => target.id === websiteId)).toBe(false);
  });

  it("rejects another user's company, automation and website data", async () => {
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const targets = new TargetStore();
    const company = await store.createCompany(bob, { name: "Bob Publishing" }, "bob-publishing-company");
    const automation = await automations.create(bob, company.id, { name: "Bob automation", prompt: "Private", cronExpression: "0 8 * * *" });
    const deps: WorkspaceChatActionDependencies = {
      store, automations, content: new ContentLibraryStore(store), browserTargets: targets,
      email: { listAccounts: async () => [{ id: "bob-mail", emailAddress: "bob@example.com", status: "connected" }] as any, getAccount: async () => null },
      runCompany: async (_ctx, companyId) => completed(companyId),
      cancelCompanyRun: async (_ctx, companyId) => completed(companyId),
    };
    const result = await WorkspaceChatActions.extractAndExecute(alice, directive({
      action: "website.create", companyId: company.id, automationId: automation.id, emailAccountId: "bob-mail",
      website: { siteName: "Private", registrationUrl: "https://example.com/register" },
    }), deps, "cross-tenant", { requestMessage: "Add Bob website" });
    expect(result.workspaceAction).toBeUndefined();
    expect(await targets.listTargets(bob, company.id)).toEqual([]);
  });
});
