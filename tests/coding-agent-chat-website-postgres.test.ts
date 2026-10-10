import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, ChatResult, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";
import { runWithCleanup } from "./support/run-with-cleanup";

const databaseUrl = process.env.DATABASE_URL;
const liveSandbox = process.env.NPATI_CHAT_WEBSITE_LIVE_SANDBOX === "1";
describe.skipIf(!databaseUrl || process.env.NPATI_SECURITY_GATE_DB !== "1")("website chat: audited PostgreSQL execution", () => {
  it("creates a code website and changes its actual source through the same chat session", async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const name = `npati_chat_website_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    const directory = await mkdtemp(path.join(tmpdir(), "npati-chat-website-pg-"));
    let store = new PostgresWorkspaceStore(url.toString());
    const ctx: AuthContext = { userId: "site-owner", workspaceId: "site-ws", permissions: ["admin:all", "workspace:read", "workspace:write", "business:manage", "tools:execute"] };
    let script: ChatResult[] = [];
    let nextInstalled = false;
    const childCalls = new Map<string, number>();
    const engine: AIEngine = { chat: async request => {
      const task = request.messages.filter(message => message.role === "user").map(message => message.content ?? "").join("\n").match(/shared-runtime-child-[AB]/)?.[0];
      if (task) {
        const turns = childCalls.get(task) ?? 0; childCalls.set(task, turns + 1);
        return turns === 0 ? call("code.fs.read", { path: "index.html" }) : { content: '{"findings":[],"files":["index.html"],"symbols":[]}' };
      }
      if (liveSandbox && request.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("Створи тестовий сайт на Next.js"))) {
        if (!nextInstalled) { nextInstalled = true; return call("code.shell.exec", { command: "npm install", timeoutMs: 180_000 }); }
        return { content: "Next.js website ready for verification." };
      }
      return script.shift() ?? { content: "Website updated." };
    }, async *stream() { yield "Website updated."; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }) };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    let app: ReturnType<typeof buildApp> | undefined;
    const buildTestApp = () => buildApp({ databaseUrl: url.toString(), dataDirectory: directory, projectWorkspaceRoot: path.join(directory, "projects"),
      workspaceStore: store, authProvider: { authenticate: async () => ctx }, aiEngine: engine, marketplace, deploymentType: "self_hosted" });
    const finalResult = (body: string) => body.split("\n\n").filter(event => event.includes("event: result"))
      .map(event => JSON.parse(event.split("\n").find(line => line.startsWith("data: "))!.slice(6))).at(-1);
    const call = (name: string, args: Record<string, unknown>): ChatResult => ({ content: "", toolCalls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const dockerNames = () => execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n").sort();
    const baseline = liveSandbox ? dockerNames() : [];
    const count = (label: string) => {
      if (!liveSandbox) return;
      const actual = dockerNames(); expect(actual, label).toEqual(baseline);
      console.info(JSON.stringify({ label, containerCount: actual.length, containers: actual }));
    };
    await runWithCleanup(async () => {
      await admin.query(`CREATE DATABASE "${name}"`); await store.initialize(ctx);
      const company = await store.createCompany(ctx, { name: "Audited shop" }, "audited-chat-company");
      if (liveSandbox) for (const flagKey of ["code.subagents", "code.async_inbox", "code.async_processes", "code.async_subagents"]) {
        await store.setFeatureFlag(ctx, { scope: "company", scopeId: company.id, flagKey, stage: "internal", enabled: true });
      }
      app = buildTestApp();
      const first = await app.inject({ method: "POST", url: "/chat/stream", payload: { companyId: company.id, contextType: "company", message: "Створи тестовий сайт на HTML/CSS" } });
      expect(first.statusCode, first.body).toBe(200);
      const created = finalResult(first.body);
      expect(created, first.body).toMatchObject({ routed: "code_runner", projectCard: { kind: "code_project", framework: "HTML/CSS" } });
      count("create website through Coding Agent");
      script = [call("code.fs.read", { path: "index.html" }), call("code.fs.edit", { path: "index.html", old_string: "</body>", new_string: '<button style="color:green">Updated in chat</button></body>' })];
      const second = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, contextType: "none", message: "Зроби кнопку зеленою" } });
      const edited = finalResult(second.body);
      expect(edited, second.body).toMatchObject({ routed: "code_runner", projectCard: { projectId: created.projectCard.projectId, sessionId: created.projectCard.sessionId } });
      const source = await app.inject({ method: "GET", url: `/companies/${company.id}/projects/${created.projectCard.projectId}/files/read?path=index.html` });
      expect(source.json().content, second.body).toContain("Updated in chat");
      expect(await store.listProjects(ctx, company.id)).toHaveLength(1);
      // A real model is mocked; tools, RBAC, audit, conversation storage and file edits are real.
      // Preview must report its missing sandbox rather than invent a running website.
      if (!liveSandbox) {
        expect(edited.run.status).toBe("failed"); expect(edited.projectCard.previewUrl).toBeUndefined();
      } else {
        expect(edited.run.status, second.body).toBe("completed");
        const preview = await app.inject({ method: "GET", url: edited.projectCard.previewUrl.replace(/^\/api/, "") });
        expect(preview.statusCode, preview.body).toBe(200); expect(preview.body).toContain("Updated in chat");
        count("same project source edit and real HTTP preview");
        script = [call("code.agent.spawn_async", { agentType: "explore", task: "shared-runtime-child-A: inspect index.html", paths: ["index.html"] }),
          call("code.agent.spawn_async", { agentType: "explore", task: "shared-runtime-child-B: inspect index.html", paths: ["index.html"] })];
        const delegated = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, contextType: "none", message: "Перевір сайт двома асинхронними субагентами" } });
        const session = await store.getCodeSession(ctx, company.id, created.projectCard.sessionId);
        let children = [] as Awaited<ReturnType<NonNullable<typeof store.codeProcesses>["transact"]>>["operations"];
        for (let attempt = 0; attempt < 100; attempt++) {
          children = (await store.codeProcesses!.transact({ companyId: company.id, projectId: session.projectId, sessionId: session.id,
            dataClassification: session.dataClassification, retentionClass: session.retentionClass }, { kind: "read" })).operations.filter(op => op.kind === "subagent");
          if (children.length === 2 && children.every(child => child.state === "completed")) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(children.map(child => child.state), delegated.body).toEqual(["completed", "completed"]);
        expect([...childCalls.values()]).toEqual([2, 2]);
        expect(children.every(child => child.projectId === created.projectCard.projectId)).toBe(true);
        console.info("shared runtime: actual Coding Agent and two detached child runners passed");
        count("two actual detached Coding Agent child runners");
        script = [call("code.shell.exec_async", { command: "pwd", background: true, waitTimeoutMs: 1000 })];
        const background = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, contextType: "none", message: "Запусти фонову перевірку робочої директорії" } });
        let jobs = children;
        for (let attempt = 0; attempt < 100; attempt++) {
          jobs = (await store.codeProcesses!.transact({ companyId: company.id, projectId: session.projectId, sessionId: session.id,
            dataClassification: session.dataClassification, retentionClass: session.retentionClass }, { kind: "read" })).operations.filter(op => op.kind !== "subagent");
          if (jobs.length === 1 && jobs[0]?.state === "completed") break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(jobs.map(job => job.state), background.body).toEqual(["completed"]);
        expect(jobs[0]?.output.text).toContain(`/projects/${session.projectId}`);
        count("canonical async background command executes in shared project directory");
        script = [];
        const next = await app.inject({ method: "POST", url: "/chat/stream", payload: { companyId: company.id, contextType: "company", message: "Створи тестовий сайт на Next.js, запусти build і Live Preview" } });
        const built = finalResult(next.body);
        expect(built, next.body).toMatchObject({ routed: "code_runner", run: { status: "completed", summary: { verification: { status: "passed", requestedTools: ["build"] } } }, projectCard: { kind: "code_project", framework: "Next.js" } });
        const nextPreview = await app.inject({ method: "GET", url: built.projectCard.previewUrl.replace(/^\/api/, "") });
        expect(nextPreview.statusCode, nextPreview.body).toBe(200);
        count("Next.js canonical production build and real HTTP preview");
        // A new API instance restores the authenticated conversation/session and logical runtime.
        await app.close(); store = new PostgresWorkspaceStore(url.toString()); await store.initialize(ctx); app = buildTestApp();
        script = [call("code.fs.read", { path: "index.html" }), call("code.fs.edit", { path: "index.html", old_string: "color:green", new_string: "color:purple" })];
        const resumed = await app.inject({ method: "POST", url: "/chat/stream", payload: { conversationId: created.conversationId, contextType: "none", message: "Зроби кнопку фіолетовою" } });
        expect(finalResult(resumed.body), resumed.body).toMatchObject({ routed: "code_runner", run: { status: "completed" }, projectCard: { projectId: session.projectId, sessionId: session.id } });
        const resumedPreview = await app.inject({ method: "GET", url: finalResult(resumed.body).projectCard.previewUrl.replace(/^\/api/, "") });
        expect(resumedPreview.statusCode).toBe(200); expect(resumedPreview.body).toContain("color:purple");
        count("fresh API instance resumes same Coding Agent session and HTTP preview");
      }
    }, async () => {
      if (liveSandbox && app) {
        for (const project of await store.listProjects(ctx, (await store.listCompanies(ctx)).items[0]!.id)) {
          await app.inject({ method: "DELETE", url: `/companies/${project.companyId}/projects/${project.id}` });
        }
      }
      if (app) await app.close(); else await store.close();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
      await rm(directory, { recursive: true, force: true });
    });
  }, liveSandbox ? 360_000 : 90_000);
});
