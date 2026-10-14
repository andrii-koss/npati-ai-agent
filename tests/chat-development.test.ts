import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceNotFoundError, type AuthContext } from "@npati/workspace";
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
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
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
  const previews = new Set<string>();
  const preview = {
    buildProject: vi.fn(async (_ctx: AuthContext, _companyId: string, _projectId: string, onStage?: (stage: "dependencies" | "build") => void) => { onStage?.("dependencies"); onStage?.("build"); }),
    startPreview: vi.fn(async (ctx: AuthContext, companyId: string, projectId: string) => { previews.add(projectId); await projects.updatePreview(ctx, companyId, projectId, { lastBuildStatus: "ready", previewUrl: "https://preview.test/" + projectId }); return { status: "running", previewUrl: "https://preview.test/" + projectId }; }),
    getSession: (projectId: string) => previews.has(projectId) ? { status: "running" } : undefined,
  };
  const ports = { terminalEvents: new ProjectTerminalEventsRepository(projects), store, projects, flags, code, executor, cancellation, background, preview: preview as never,
    admission: createCodeRunAdmission(queue, new CodeRunRateLimiter()),
    preparer: { prepareCodingWebsite: (ctx: AuthContext, p: Awaited<ReturnType<ProjectService["get"]>>, _message: string, framework: string) => prepare(ctx, p, framework), prepareCodingMobile: (ctx: AuthContext, p: Awaited<ReturnType<ProjectService["get"]>>) => prepare(ctx, p, "Expo") }, log: { warn: vi.fn() } };
  const service = new ChatDevelopmentService(ports); shutdown.push(() => service.close());
  const start = (message = bulk, requestId = "request-1", conversationId?: string) => service.start(owner, { companyId: company.id, message, requestId, conversationId });
  const finish = (projectId: string, verified = true) => {
    const run = controls.get(projectId)!;
    run.finish({ runId: run.input.runId, status: "completed", summary: { verification: { status: verified ? "passed" : "failed", requestedTools: ["build"] } } });
  };
  return { store, company, projects, flags, code, controls, starts, service, start, finish, ports, preview };
}
describe("durable coding activity", () => {
  it("adds the original request language to the coding prompt rather than the English orchestration wrapper", async () => {
    const f=await fixture();await f.start("\u0421\u0442\u0432\u043e\u0440\u0438 \u0442\u0435\u0441\u0442\u043e\u0432\u0438\u0439 \u0441\u0430\u0439\u0442 \u043d\u0430 Next.js, \u0437\u0430\u043f\u0443\u0441\u0442\u0438 build \u0456 Live Preview");
    await vi.waitFor(()=>expect(f.controls.size).toBe(1));
    const process=(await f.service.list(owner))[0]!;expect(process.responseLanguage).toBe("uk");expect(f.controls.get(process.projectId!)!.input.prompt).toContain("Reply entirely in Ukrainian");
  });
  it("projects accepted queue messages and real replies from existing inbox and replay after refresh",async()=>{
    const f=await fixture();await f.start("Create a Next.js website");await vi.waitFor(()=>expect(f.controls.size).toBe(1));const process=(await f.service.list(owner))[0]!;
    const inbox={isEnabled:async()=>true,transact:async()=>({state:{messages:[{id:"queued",authorId:owner.userId,text:"Please change the footer to green",status:"admitted",runId:"queued-run",createdAt:new Date().toISOString()},{id:"foreign",authorId:"other",text:"foreign",status:"admitted",runId:"foreign-run",createdAt:new Date().toISOString()}]}})};
    vi.spyOn(f.store,"getReplayBundle").mockImplementation(async(_company,run)=>run==="queued-run" ? {id:"bundle"} as never : null);
    vi.spyOn(f.store,"listReplayBundleSteps").mockResolvedValue([{kind:"model_step",createdAt:new Date(),payload:{response:{content:"Changed the footer to green.",toolCalls:[]}}}] as never);
    const reader=new ChatDevelopmentService({...f.ports,inbox:inbox as never});
    const first=(await reader.list(owner))[0]!.conversationMessages!;expect(first.map(item=>item.role)).toEqual(["user","assistant"]);expect(first[1]?.content).toBe("Changed the footer to green.");
    expect((await reader.list(owner))[0]!.conversationMessages!.map(item=>item.id)).toEqual(first.map(item=>item.id));expect(JSON.stringify(first)).not.toContain("foreign");await reader.close();
  });
  it("stores the child user before execution, recovers operation updates and appends the true result", async () => {
    const f = await fixture(); const request = "Create a website on Next.js";
    const started = await f.start(request); await vi.waitFor(() => expect(f.controls.size).toBe(1));
    const process = (await f.service.list(owner))[0]!; const before = await f.store.getNeutralConversation(owner,process.conversationId!);
    expect(before.messages[0]).toMatchObject({role:"user",content:request});
    const callback = f.controls.get(process.projectId!)!.input.onActivity!;
    const event = {id: process.runId + ":build-call",runId:process.runId,stage:"tool",title:"Build",at:new Date().toISOString(),command:"npm run build token=secret",status:"running" as const};
    await callback(event); await callback({...event,status:"completed",result:JSON.stringify({stdout:"built password=p",exitCode:0,tests:{passed:24,failed:0,skipped:0,total:24}})});
    const restored = new ChatDevelopmentService(f.ports);
    const progress = (await restored.list(owner))[0]!.progress!.filter(x=>x.id===event.id);
    expect(progress).toHaveLength(1);expect(progress[0]).toMatchObject({status:"completed",command:"npm run build token=[REDACTED]",exitCode:0,tests:{passed:24,total:24}});expect(progress[0]?.stdout).toContain("password=[REDACTED]");
    await f.service.recordActivity({...owner,userId:"other"},f.company.id,process.sessionId!,process.conversationId,event);
    expect((await f.service.list(owner))[0]!.progress!.filter(x=>x.id===event.id)).toHaveLength(1);
    f.controls.get(process.projectId!)!.finish({status:"completed",runId:process.runId,message:"Implemented the requested storefront.",summary:{verification:{status:"passed",requestedTools:["build"]}}});
    await vi.waitFor(async () => expect((await f.store.getNeutralConversation(owner,process.conversationId!)).messages.at(-1)?.content).toBe("Implemented the requested storefront."));
    expect((await f.store.getNeutralConversation(owner,started.conversationId)).messages[0]?.role).toBe("user");
    await restored.close();
  });
});
describe("development request planning", () => {
  it("routes the user's four projects and keeps a shop as one project", () => {
    expect(planChatDevelopment(bulk).map(t => t.kind)).toEqual(["website", "blog", "mobile_app", "crm"]);
    expect(planChatDevelopment("Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.")).toEqual([{ kind: "store", name: "Online store", framework: "Next.js" }]);
    expect(planChatDevelopment("Change the header of my website")).toEqual([]);
    expect(planChatDevelopment("Run build and Live Preview for my website")).toEqual([]);
    expect(planChatDevelopment("Create a page in my website")).toEqual([]);
    expect(planChatDevelopment("Create a contact form on this website", "existing")).toEqual([]);
    expect(planChatDevelopment("Create a new website with a contact form", "existing")).toHaveLength(1);
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
    expect(projects.filter(p => p.previewUrl)).toHaveLength(4); // Failed AI work retains the already-built template preview.
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
  it("ignores deleted projects in persisted history and accepts a new creation request", async () => {
    const f = await fixture();
    await f.start("Create a website", "first");
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    const first = (await f.service.list(owner))[0]!;
    f.finish(first.projectId!);
    await vi.waitFor(async () => expect((await f.service.list(owner))[0]?.status).toBe("completed"));
    await f.projects.delete(owner, f.company.id, first.projectId!);
    expect(await f.service.list(owner)).toEqual([]);
    const result = await f.start("Create a Next.js website", "second");
    expect(result.processes).toHaveLength(1);
    await vi.waitFor(() => expect(f.controls.size).toBe(2));
    expect((await f.service.list(owner)).map(p => p.projectId)).not.toContain(first.projectId);
  });
  it("does not count stale running entries for deleted projects against the four-project limit", async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await f.store.setUserSetting(owner, "chat-development-processes:v1", Array.from({ length: 4 }, (_, i) => ({ id: "stale-" + i, requestId: "stale-" + i, projectId: "deleted-" + i, companyId: f.company.id, parentConversationId: "old", name: "Old", framework: "Next.js", status: "running", hidden: false, createdAt: now, updatedAt: now })), 0);
    expect(await f.service.list(owner)).toEqual([]);
    const result = await f.start("Create a Next.js website", "new-request");
    expect(result.processes).toHaveLength(1);
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
  });
  it("filters inaccessible projects before reading their terminal trace and propagates infrastructure errors", async () => {
    const f = await fixture(); const now = new Date().toISOString();
    await f.store.setUserSetting(owner, "chat-development-processes:v1", [{ id: "foreign", projectId: "foreign", companyId: f.company.id, parentConversationId: "old", name: "Old", framework: "Next.js", status: "completed", hidden: false, createdAt: now, updatedAt: now }], 0);
    const get = vi.spyOn(f.projects, "get").mockRejectedValue(new WorkspaceNotFoundError("Project not found"));
    const terminal = vi.spyOn(f.ports.terminalEvents, "list");
    expect(await f.service.list(owner)).toEqual([]); expect(terminal).not.toHaveBeenCalled();
    get.mockRejectedValue(new Error("Database unavailable"));
    await expect(f.service.list(owner)).rejects.toThrow("Database unavailable");
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
  it("deploys the template before calling the model and keeps one honest project card on quota failure", async () => {
    const f = await fixture(); const result = await f.start("Create an online store on Next.js");
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    const process = (await f.service.list(owner))[0]!;
    expect(f.preview.buildProject).toHaveBeenCalledOnce(); expect(f.preview.startPreview).toHaveBeenCalledOnce();
    expect(process.progress?.map(p => p.stage)).toEqual(expect.arrayContaining(["scaffold", "dependencies", "build", "preview", "template_ready", "agent"]));
    const runner = f.controls.get(process.projectId!)!; expect(runner.input.maxTurns).toBe(16); expect(runner.input.prompt).not.toContain("code.deps.install"); expect(runner.input.prompt).toContain("code.deps.add");
    const child = await f.store.getNeutralConversation(owner, process.conversationId!); expect(child.messages).toHaveLength(1);
    expect((await getLatestChatProjectCard(f.store, owner, process.conversationId!))?.status).not.toBe("ready");
    runner.finish({ status: "stopped", reason: "budget_exhausted", message: "A2A_TOKEN_QUOTA_EXCEEDED", runId: runner.input.runId });
    await vi.waitFor(async () => expect((await f.service.list(owner))[0]?.status).toBe("failed"));
    await vi.waitFor(async () => expect((await getLatestChatProjectCard(f.store, owner, process.conversationId!))?.status).toBe("failed"));
    const finishedChat = await f.store.getNeutralConversation(owner, process.conversationId!);
    expect(finishedChat.messages.map(item=>item.role)).toEqual(["user","assistant"]);
    expect(finishedChat.messages.at(-1)?.content).toBe("A2A_TOKEN_QUOTA_EXCEEDED");
    expect((await f.store.getNeutralConversation(owner, result.conversationId!)).messages).toHaveLength(2);
  });
  it("reports a template build failure without spending model tokens", async () => {
    const f = await fixture(); f.preview.buildProject.mockRejectedValueOnce(new Error("Dependency install failed"));
    await f.start("Create a Next.js website");
    await vi.waitFor(async () => expect((await f.service.list(owner))[0]?.status).toBe("failed"));
    expect(f.controls.size).toBe(0); expect(f.preview.startPreview).not.toHaveBeenCalled();
    const process = (await f.service.list(owner))[0]!;
    expect(process.progress?.at(-1)?.title).toContain("Dependency install failed");
  });
  it("streams real persisted changes over HTTP and recovers the same history on reconnect", async () => {
    const f = await fixture(); const app = Fastify(); shutdown.push(() => app.close());
    registerChatDevelopmentRoutes(app, { ...f.ports, auth: { authenticate: async () => owner } });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const response = await fetch(base + "/chat/development/processes/stream", { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(), decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toContain("event: change");
    await f.start("Create a Next.js website");
    await vi.waitFor(() => expect(f.controls.size).toBe(1));
    let frame = "";
    while (!frame.includes("event: change")) frame += decode.decode((await reader.read()).value);
    controller.abort(); await reader.cancel().catch(() => {});
    const snapshot = await (await fetch(base + "/chat/development/processes")).json();
    expect(snapshot.processes[0].progress.some((event: { stage: string }) => event.stage === "agent")).toBe(true);
    const reconnect = new AbortController();
    const resumed = await fetch(base + "/chat/development/processes/stream", { signal: reconnect.signal });
    const resumedReader = resumed.body!.getReader();
    expect(decode.decode((await resumedReader.read()).value)).toContain("event: change");
    reconnect.abort(); await resumedReader.cancel().catch(() => {});
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
