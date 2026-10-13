import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { planChatDevelopment, requestsDevelopmentRestore } from "@npati/shared";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { CodeService } from "../apps/agent-api/src/code-service";
import { CodeSessionRunExecutor, type CodeSessionRunPort } from "../apps/agent-api/src/code-session-run-executor";
import { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import { CodeBackgroundRunRegistry } from "../apps/agent-api/src/code-background-run-registry";
import { CodeRunQueue } from "../apps/agent-api/src/code-run-queue";
import { CodeRunRateLimiter } from "../apps/agent-api/src/code-run-rate-limit";
import { createCodeRunAdmission } from "../apps/agent-api/src/code-run-admission";
import { finishCodeChatWebsite } from "../apps/agent-api/src/code-chat-website";
import { ChatDevelopmentService } from "../apps/agent-api/src/chat-development-service";
import { registerChatDevelopmentRoutes } from "../apps/agent-api/src/chat-development-routes";
import { getLatestChatProjectCard } from "../apps/agent-api/src/project-chat-cards";
const owner: AuthContext = { userId: "owner", workspaceId: "ws-owner", permissions: ["workspace:write", "business:manage"] };
const bulk = "Масово створи мені сайт для компанії, блог, мобільний додаток і CRM";
const shutdown: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(shutdown.splice(0).map(close => close())); });
async function fixture(maxConcurrentPerUser = 4) {
  const store = new InMemoryWorkspaceStore(); const company = await store.createCompany(owner, { name: "Company" }, "company");
  const projects = new ProjectService(store); const flags = new FeatureFlagService(store, { record: async () => ({}) } as never, { enabledByDefault: true });
  const code = new CodeService(store, projects, { readFile: async () => ({ content: JSON.stringify({ scripts: { build: "next build" } }) }) } as never, undefined, undefined, undefined, flags);
  const cancellation = new CodeRunCancellationRegistry(); const background = new CodeBackgroundRunRegistry();
  const queue = new CodeRunQueue({ maxConcurrentPerUser, maxConcurrentPerCompany: 5 });
  const controls = new Map<string, { input: Parameters<CodeSessionRunPort["run"]>[0]; finish(result: unknown): void }>();
  const starts: string[] = [];
  const runner: CodeSessionRunPort = { run: input => new Promise(resolve => {
    starts.push(input.session.projectId);
    controls.set(input.session.projectId, { input, finish: resolve });
    input.signal.addEventListener("abort", () => resolve({ status: "cancelled", runId: input.runId }), { once: true });
  }) };
  const executor = new CodeSessionRunExecutor({ runner, control: cancellation, resolveVerificationTools: async () => ["build"],
    afterRun: (input, result) => finishCodeChatWebsite(input, result, {
      getProject: (ctx, c, p) => projects.get(ctx, c, p),
      startPreview: async (ctx, c, p) => { await projects.updatePreview(ctx, c, p, { previewUrl: "https://preview.test/" + p, lastBuildStatus: "ready", status: "ready" }); return { status: "running", previewUrl: "https://preview.test/" + p }; },
      markFailed: (ctx, c, p) => projects.updatePreview(ctx, c, p, { lastBuildStatus: "failed", status: "failed" }),
    }),
  });
  const prepare = async (ctx: AuthContext, project: Awaited<ReturnType<ProjectService["get"]>>, framework: string) => projects.updatePreview(ctx, project.companyId, project.id, { framework });
  const ports = { store, projects, flags, code, executor, cancellation, background,
    admission: createCodeRunAdmission(queue, new CodeRunRateLimiter()),
    preparer: { prepareCodingWebsite: (ctx: AuthContext, p: Awaited<ReturnType<ProjectService["get"]>>, _message: string, framework: string) => prepare(ctx, p, framework), prepareCodingMobile: (ctx: AuthContext, p: Awaited<ReturnType<ProjectService["get"]>>) => prepare(ctx, p, "Expo") }, log: { warn: vi.fn() } };
  const service = new ChatDevelopmentService(ports); shutdown.push(() => service.close());
  const start = (message = bulk, requestId = "request-1", conversationId?: string) => service.start(owner, { companyId: company.id, message, requestId, conversationId });
  const finish = (projectId: string, verified = true) => {
    const run = controls.get(projectId)!;
    run.finish({ runId: run.input.runId, status: "completed", summary: { verification: { status: verified ? "passed" : "failed", requestedTools: ["build"] } } });
  };
  return { store, company, projects, flags, code, controls, starts, service, start, finish, ports };
}
describe("development request planning", () => {
  it("routes the user's four projects and keeps a shop as one project", () => {
    expect(planChatDevelopment(bulk).map(t => t.kind)).toEqual(["website", "blog", "mobile_app", "crm"]);
    expect(planChatDevelopment("Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.")).toEqual([{ kind: "store", name: "Online store", framework: "Next.js" }]);
    expect(planChatDevelopment("Change the header of my website")).toEqual([]);
    expect(planChatDevelopment("Run build and Live Preview for my website")).toEqual([]);
    expect(planChatDevelopment("Create a page in my website")).toEqual([]);
    expect(planChatDevelopment("Create 4 websites")).toHaveLength(4);
    expect(() => planChatDevelopment("Create 5 websites")).toThrow("four");
    expect(requestsDevelopmentRestore("відкрий усі процеси розробки")).toBe(true);
  });
});
describe("chat development lifecycle with the real store, queue and executor", () => {
  it("acknowledges early, starts four distinct sessions and verifies build before Preview", async () => {
    const f = await fixture(); const result = await f.start();
    expect(result.processes).toHaveLength(4);
    await vi.waitFor(() => expect(f.controls.size).toBe(4));
    const live = await f.service.list(owner);
    expect(new Set(live.map(p => p.projectId)).size).toBe(4);
    expect(new Set(live.map(p => p.sessionId)).size).toBe(4);
    expect(live.every(p => p.status === "running")).toBe(true);
    const parent = await f.store.getNeutralConversation(owner, result.conversationId!);
    expect(parent.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    for (const run of f.controls.values()) { expect(run.input.verificationTools).toEqual(["build"]); expect(run.input.forceVerification).toBe(true); expect(run.input.prompt).toContain("ONLY this project"); }
    live.forEach((p, i) => f.finish(p.projectId!, i !== 1));
    await vi.waitFor(async () => expect((await f.service.list(owner)).map(p => p.status)).toEqual(["completed", "failed", "completed", "completed"]));
    const projects = await f.projects.list(owner, f.company.id);
    expect(projects.find(p => p.type === "mobile_app")?.framework).toBe("Expo");
    expect(projects.filter(p => p.previewUrl)).toHaveLength(3);
    expect((await getLatestChatProjectCard(f.store, owner, live[0]!.conversationId!))?.sessionId).toBe(live[0]!.sessionId);
  });
  it("isolates stop and hide, preserves projects, and restores their chats after deletion", async () => {
    const f = await fixture(); const result = await f.start();
    await vi.waitFor(() => expect(f.controls.size).toBe(4));
    const live = await f.service.list(owner); const first = live[0]!;
    await f.service.hide(owner, first.id);
    expect((await f.service.list(owner)).find(p => p.id === first.id)?.hidden).toBe(true);
    expect(await f.projects.get(owner, f.company.id, first.projectId!)).toBeTruthy();
    expect(f.controls.get(first.projectId!)!.input.signal.aborted).toBe(false);
    await f.service.stop(owner, first.id);
    await vi.waitFor(async () => expect((await f.service.list(owner)).find(p => p.id === first.id)?.status).toBe("cancelled"));
    expect(live.slice(1).every(p => !f.controls.get(p.projectId!)!.input.signal.aborted)).toBe(true);
    live.slice(1).forEach(p => f.finish(p.projectId!));
    await vi.waitFor(async () => expect((await f.service.list(owner)).filter(p => p.status === "completed")).toHaveLength(3));
    await f.store.deleteNeutralConversation(owner, first.conversationId!);
    await f.store.deleteNeutralConversation(owner, result.conversationId!);
    const recovered = await f.service.openProject(owner, f.company.id, first.projectId!);
    expect(recovered.url).toContain("project=" + first.projectId);
    const next = await f.service.list(owner);
    const restored = next.find(p => p.id === first.id)!;
    expect(restored.conversationId).not.toBe(first.conversationId);
    expect(new Set(next.map(p => p.parentConversationId)).size).toBe(1);
    expect((await getLatestChatProjectCard(f.store, owner, restored.conversationId!))?.projectId).toBe(first.projectId);
    expect((await f.service.restore(owner)).filter(p => !p.hidden)).toHaveLength(4);
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(4);
  });
  it("keeps duplicate requests idempotent and refuses a fifth live project", async () => {
    const f = await fixture(); const [one, two] = await Promise.all([f.start(), f.start()]);
    expect(two.processes.map(p => p.id)).toEqual(one.processes.map(p => p.id));
    await expect(f.start("Create a blog", "second-request")).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(f.controls.size).toBe(4));
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(4);
  });
  it("honours lower operator concurrency and cancels a queued project without starting it", async () => {
    const f = await fixture(1); await f.start();
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    await vi.waitFor(async () => expect((await f.service.list(owner)).filter(p => p.sessionId)).toHaveLength(4));
    const queued = (await f.service.list(owner)).find(p => p.status === "queued")!;
    await f.service.stop(owner, queued.id);
    await vi.waitFor(async () => expect((await f.service.list(owner)).find(p => p.id === queued.id)?.status).toBe("cancelled"));
    expect(f.starts).not.toContain(queued.projectId);
  });
  it("checks permissions and company ownership before project creation", async () => {
    const f = await fixture(); const input = { companyId: f.company.id, message: bulk, requestId: "request" };
    await expect(f.service.start({ ...owner, permissions: ["workspace:read"] }, input)).rejects.toMatchObject({ status: 403 });
    const stranger = { ...owner, userId: "stranger", workspaceId: "ws-stranger" };
    await expect(f.service.start(stranger, input)).rejects.toThrow();
    expect(await f.service.list(stranger)).toEqual([]);
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(0);
  });
  it("shows later project-chat runs and stops their live controller", async () => {
    const f = await fixture(); await f.start("Create a blog");
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    const process = (await f.service.list(owner))[0]!; f.finish(process.projectId!);
    await vi.waitFor(async () => expect((await f.service.list(owner))[0]?.status).toBe("completed"));
    const runId = "follow-up-run"; const now = new Date();
    await f.store.createCodeRunState({ runId, workspaceId: owner.workspaceId, companyId: f.company.id, projectId: process.projectId!, sessionId: process.sessionId!, owner: "api", leaseMs: 60000, now });
    const controller = new AbortController(); f.ports.cancellation.registerController(process.sessionId!, controller);
    expect((await f.service.list(owner))[0]).toMatchObject({ runId, status: "running" });
    await f.service.stop(owner, process.id); expect(controller.signal.aborted).toBe(true);
    await f.store.applyCodeRunStateEvent({ companyId: f.company.id, runId, seq: 2, status: "cancelled" });
    f.ports.cancellation.unregisterController(process.sessionId!, controller);
    expect((await f.service.list(owner))[0]?.status).toBe("cancelled");
  });
  it("preserves all projects when replacing old tiles with a new batch", async () => {
    const f = await fixture(); await f.start(); await vi.waitFor(() => expect(f.controls.size).toBe(4));
    const old = await f.service.list(owner); old.forEach(p => f.finish(p.projectId!));
    await vi.waitFor(async () => expect((await f.service.list(owner)).every(p => p.status === "completed")).toBe(true));
    await f.start(bulk, "new-batch");
    await vi.waitFor(() => expect(f.controls.size).toBe(8));
    expect((await f.service.list(owner)).filter(p => !p.hidden)).toHaveLength(4);
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(8);
  });
  it("keeps Global and disabled features from starting sandbox projects", async () => {
    const f = await fixture();
    await f.flags.executionModes.set(owner, f.company.id, "global", 0);
    await expect(f.start()).rejects.toMatchObject({ status: 409 });
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(0);
    await f.flags.executionModes.set(owner, f.company.id, "company", 1);
    await f.flags.killSwitch(owner, { companyId: f.company.id });
    await expect(f.start()).rejects.toThrow();
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(0);
  });
  it("restores existing Websites projects without creating or starting them again", async () => {
    const f = await fixture();
    const first = await f.projects.create(owner, f.company.id, { name: "Existing shop", type: "website" }, "existing-shop");
    const second = await f.projects.create(owner, f.company.id, { name: "Existing blog", type: "website" }, "existing-blog");
    await f.projects.updatePreview(owner, f.company.id, first.project.id, { framework: "Next.js", lastBuildStatus: "ready", previewUrl: "https://preview.test/shop" });
    await f.projects.updatePreview(owner, f.company.id, second.project.id, { framework: "Next.js" });
    const restored = await f.service.restore(owner);
    expect(restored.filter(p => !p.hidden)).toHaveLength(2);
    expect(new Set(restored.map(p => p.parentConversationId)).size).toBe(1);
    expect(restored.find(p => p.projectId === second.project.id)?.status).toBe("idle");
    expect((await f.service.openProject(owner, f.company.id, first.project.id)).url).toContain("project=" + first.project.id);
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(2);
    expect(f.controls.size).toBe(0);
  });
  it("authenticates and validates the HTTP entry points", async () => {
    const f = await fixture(); const app = Fastify();
    registerChatDevelopmentRoutes(app, { ...f.ports, auth: { authenticate: async () => owner } }); shutdown.push(() => app.close());
    const invalid = await app.inject({ method: "POST", url: "/chat/development/processes", payload: { companyId: f.company.id } });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: "/chat/development/processes", payload: { companyId: f.company.id, message: "Create a blog", requestId: "http-request" } });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    const hide = await app.inject({ method: "POST", url: "/chat/development/processes/" + result.processes[0].id + "/hide" });
    expect(hide.statusCode).toBe(200);
    expect(await f.projects.list(owner, f.company.id)).toHaveLength(1);
  });
});
