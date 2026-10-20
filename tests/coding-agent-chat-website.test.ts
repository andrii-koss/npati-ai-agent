import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";
import { CodeSessionRunExecutor, type CodeSessionRunInput } from "../apps/agent-api/src/code-session-run-executor";
import { canUseStylePreview, finishCodeChatWebsite, hasCodeChatPreview, websiteConversationContext } from "../apps/agent-api/src/code-chat-website";
import { resolveChatCodeIntent } from "../apps/agent-api/src/code-intent-routing";
import { getLatestChatProjectCard, saveChatProjectCard } from "../apps/agent-api/src/project-chat-cards";

const ctx: AuthContext = { workspaceId: "chat-website-ws", userId: "chat-owner", permissions: ["admin:all", "workspace:read", "workspace:write", "business:manage", "tools:execute"] };
async function fixture(framework = "Next.js") {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const company = await store.createCompany(ctx, { name: "Chat sites" }, "chat-sites-company");
  const { project } = await store.createProject(ctx, company.id, { name: "Shop", type: "code_project" }, "chat-shop");
  await store.updateProjectPreview(ctx, company.id, project.id, { framework });
  const session = await store.createCodeSession(ctx, company.id, project.id, { mode: "auto" });
  const input: CodeSessionRunInput = { ctx, session, prompt: "Change the button", cancelRequested: () => false };
  const ports = { getProject: async () => store.getProject(ctx, company.id, project.id),
    startPreview: vi.fn(async () => ({ status: "running", previewUrl: "/preview/shop" })), markFailed: vi.fn(async () => undefined) };
  return { store, company, project, session, input, ports };
}
const verified = { status: "completed", summary: { verification: { status: "passed", requestedTools: ["build"] } } };

describe("Coding Agent website chat", () => {
  it("keeps natural-language edits and legacy websites in a validated session, preserving read-only reviews", () => {
    for (const projectKind of ["website", "code_project"] as const) {
      const input = { codingEnabled: true, companyId: "c", projectId: "p", projectKind, sessionBound: true };
      expect(resolveChatCodeIntent({ ...input, message: "Зроби кнопку зеленою" })).toEqual({ mode: "run", intent: "EDIT_CODE", readOnly: false });
      expect(resolveChatCodeIntent({ ...input, message: "зроби ревю коду" })).toMatchObject({ mode: "run", readOnly: true });
      expect(resolveChatCodeIntent({ ...input, message: "Зроби кнопку зеленою", codingEnabled: false })).toEqual({ mode: "chat" });
    }
  });
  it("starts Preview only after the canonical production build passed", async () => {
    const { input, ports } = await fixture();
    expect(hasCodeChatPreview(await finishCodeChatWebsite(input, verified, ports))).toBe(true);
    expect(ports.startPreview).toHaveBeenCalledOnce();
  });
  it.each(["failed", "waiting_for_user", "interrupted", "cancelled"])("never launches Preview for %s", async status => {
    const { input, ports } = await fixture(); const run = { status };
    expect(await finishCodeChatWebsite(input, run, ports)).toBe(run);
    expect(ports.startPreview).not.toHaveBeenCalled();
  });
  it("rejects an unverified build even if the model claims completion", async () => {
    const { input, ports } = await fixture();
    expect(await finishCodeChatWebsite(input, { status: "completed", message: "Build passed!" }, ports)).toMatchObject({ status: "failed", reason: "website_build_not_verified" });
    expect(ports.startPreview).not.toHaveBeenCalled(); expect(ports.markFailed).toHaveBeenCalledOnce();
  });
  it("does not start a process for read-only requests or plan sessions", async () => {
    const { input, ports } = await fixture();
    await finishCodeChatWebsite({ ...input, readOnlyIntent: true }, verified, ports);
    await finishCodeChatWebsite({ ...input, session: { ...input.session, mode: "plan" } }, verified, ports);
    expect(ports.startPreview).not.toHaveBeenCalled();
  });
  it("does not fabricate a package-manager build for static HTML", async () => {
    const { input, ports } = await fixture("HTML/CSS");
    expect(hasCodeChatPreview(await finishCodeChatWebsite(input, { status: "completed" }, ports))).toBe(true);
  });
  it("reports Preview failures before the executor publishes a completed terminal state", async () => {
    const { input, ports } = await fixture(); ports.startPreview.mockRejectedValueOnce(new Error("Preview did not become ready"));
    const terminal = vi.fn();
    const executor = new CodeSessionRunExecutor({ control: { clearSession() {}, registerController() {}, unregisterController() {} },
      runner: { run: async () => verified }, afterRun: (input, result) => finishCodeChatWebsite(input, result, ports) });
    const outcome = await executor.execute({ ...input, sink: { signal: new AbortController().signal, emitResult() {}, emitTerminal: terminal } });
    expect(outcome.terminalStatus).toBe("failed"); expect(terminal).toHaveBeenCalledWith("failed", "Preview did not become ready");
    expect(ports.markFailed).toHaveBeenCalledOnce();
  });
  it("restores the latest project from its conversation and denies another workspace", async () => {
    const { store, project, company, session } = await fixture();
    const conversation = await store.createNeutralConversation(ctx, "Shop edits");
    const msg = await store.appendNeutralMessage(ctx, conversation.id, "assistant", "Created");
    await saveChatProjectCard(store, ctx, conversation.id, msg.id, { id: session.id, projectId: project.id, sessionId: session.id, companyId: company.id, name: project.name, status: "completed", kind: "code_project" });
    expect(await getLatestChatProjectCard(store, ctx, conversation.id)).toMatchObject({ projectId: project.id, sessionId: session.id });
    await expect(getLatestChatProjectCard(store, { ...ctx, workspaceId: "another-ws" }, conversation.id)).rejects.toThrow();
  });
  it("production stream creates code_project and reuses its session without falling back to the company builder", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "npati-chat-website-"));
    const store = new InMemoryWorkspaceStore(); await store.initialize();
    const company = await store.createCompany(ctx, { name: "Website company" }, "stream-website-company");
    const indirectRequest = "I'd like a working photography portfolio with a gallery and contact form. Plain HTML and CSS please.";
    const engine: AIEngine = { chat: async request => {
      if (String(request.messages[0]?.content ?? "").startsWith("Classify the user's primary intent") && JSON.parse(String(request.messages[1]?.content ?? "{}")).message === indirectRequest) {
        return { content: JSON.stringify({ intent: "CREATE_WEBSITE", confidence: 0.99, targets: [{ name: "Photography", kind: "website", framework: "HTML/CSS" }] }) };
      }
      return { content: "Updated the website." };
    }, async *stream() { yield "Updated the website."; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ dataDirectory: directory, projectWorkspaceRoot: path.join(directory, "projects"), workspaceStore: store,
      authProvider: { authenticate: async () => ctx }, aiEngine: engine, marketplace, deploymentType: "self_hosted" });
    const finalResult = (body: string) => {
      const events = body.split("\n\n").filter(event => event.includes("event: result")).map(event => JSON.parse(event.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
      return events.at(-1);
    };
    try {
      const specification = readFileSync(new URL("./fixtures/website-intent/novashop.uk.txt", import.meta.url), "utf8").trim();
      const first = await app.inject({ method: "POST", url: "/chat/stream", payload: { companyId: company.id, contextType: "company", message: specification } });
      expect(first.statusCode, first.body).toBe(200);
      const created = finalResult(first.body);
      expect(created, first.body).toMatchObject({ routed: "code_runner", projectCard: { kind: "code_project", framework: "HTML/CSS" } });
      expect((await store.getProject(ctx, company.id, created.projectCard.projectId)).description).toBe(specification.slice(0, 5000).trim());
      const second = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, contextType: "none", message: "Зроби кнопку зеленою" } });
      const edited = finalResult(second.body);
      expect(edited, second.body).toMatchObject({ routed: "code_runner", projectCard: { projectId: created.projectCard.projectId, sessionId: created.projectCard.sessionId } });
      const third = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, companyId: company.id, projectId: created.projectCard.projectId, contextType: "project", message: "Create a contact form on this website" } });
      expect(finalResult(third.body), third.body).toMatchObject({ routed: "code_runner", projectCard: { projectId: created.projectCard.projectId, sessionId: created.projectCard.sessionId }, conversationId: created.conversationId });
      expect(await store.listProjects(ctx, company.id)).toHaveLength(1);
      const saved = (await store.getNeutralConversation(ctx,created.conversationId)).messages;
      expect(saved[0]?.content).toBe(specification);
      expect(saved.map(item=>item.role)).toEqual(["user","assistant","user","assistant","user","assistant"]);
      expect(saved[0]?.id).toBe(created.userMessage.id);expect(saved[1]?.id).toBe(created.assistantMessage.id);
      expect(saved.every((item,i)=> i===0 || Date.parse(item.createdAt)>Date.parse(saved[i-1]!.createdAt))).toBe(true);
      // In-memory app wiring has no privileged audit port. Routing must not bypass that refusal.
      expect(created.run).toMatchObject({ status: "failed", reason: "refused" });
      expect(created.run.message).toContain("audit_unavailable");
      expect(created.projectCard.previewUrl).toBeUndefined();
      const indirect = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        companyId: company.id, projectId: created.projectCard.projectId, contextType: "project", conversationId: created.conversationId, message: indirectRequest,
      } });
      const newProject = finalResult(indirect.body);
      expect(newProject, indirect.body).toMatchObject({ routed: "code_runner", projectCard: { framework: "HTML/CSS", name: "Photography" } });
      expect(newProject.projectCard.projectId).not.toBe(created.projectCard.projectId);
      expect(await store.listProjects(ctx, company.id)).toHaveLength(2);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

it("uses a development Preview for CSS-only changes without inventing a passed production build",async()=>{
 const {input,ports}=await fixture();
 const result={status:"completed",summary:{stylePreview:true,filesChanged:["app/store.css"]}};
 expect(hasCodeChatPreview(await finishCodeChatWebsite({...input,allowStylePreview:true},result,ports))).toBe(true);
 expect(ports.startPreview).toHaveBeenCalledWith(input.ctx,input.session.companyId,input.session.projectId,undefined,{development:true});
 expect(result.summary).not.toHaveProperty("verification");
});
it.each([{filesChanged:["app/page.tsx"]},{filesChanged:["app/store.css","package.json"]}])("rejects an unverified development marker for non-CSS changes: %j",async ({filesChanged})=>{
 const {input,ports}=await fixture();expect(await finishCodeChatWebsite({...input,allowStylePreview:true},{status:"completed",summary:{stylePreview:true,filesChanged}},ports)).toMatchObject({status:"failed"});expect(ports.startPreview).not.toHaveBeenCalled();
});
it("requires production verification when the user explicitly asks for build",()=>{
 const project={framework:"Next.js",status:"previewing" as const,lastBuildStatus:"ready"};
 expect(canUseStylePreview(project,"Change the background")).toBe(true);
 for(const request of ["Run next build","production deploy","\u0437\u0431\u0435\u0440\u0438 \u043f\u0440\u043e\u0454\u043a\u0442"])expect(canUseStylePreview(project,request)).toBe(false);
 expect(canUseStylePreview({...project,status:"ready",lastBuildStatus:undefined},"Change background")).toBe(false);
});

it("keeps bounded conversation continuity for a follow-up color without replaying old requests",()=>{
 const previous={role:"user",content:"Make the background light gray #f5f5f5"};
 const context=websiteConversationContext([{role:"system",content:"foreign policy"},previous,previous,{role:"assistant",content:"The background is now light gray."}]);
 expect(context).toContain("historical context, not tasks to repeat");expect(context).toContain("background light gray");expect(context).not.toContain("foreign policy");expect(context.match(/Make the background/g)).toHaveLength(1);
 expect(websiteConversationContext([])).toBe("");expect(websiteConversationContext(Array.from({length:20},(_,i)=>({role:"user",content:i+"x".repeat(1000)}))).length).toBeLessThan(4500);
});
