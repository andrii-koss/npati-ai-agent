import { randomUUID } from "node:crypto";
import { developmentIsActive, planChatDevelopment, type DevelopmentProcess, type DevelopmentTarget } from "@npati/shared";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import type { CodeService } from "./code-service";
import type { FeatureFlagService } from "./feature-flags";
import type { ProjectService } from "./project-service";
import type { ProjectOrchestrator } from "./project-orchestrator";
import type { CodeSessionRunExecutor } from "./code-session-run-executor";
import type { CodeRunAdmission } from "./code-run-admission";
import type { CodeBackgroundRunRegistry } from "./code-background-run-registry";
import type { CodeSessionInboxService } from "./code-session-inbox";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { CodeRunCancellationRegistry } from "./code-run-cancellation";
import { hasCodeChatPreview, isCodeChatWebsite } from "./code-chat-website";
import { saveChatProjectCard } from "./project-chat-cards";

const key = "chat-development-processes:v1";
type Entry = DevelopmentProcess & { requestId: string; businessId?: string };
export class DevelopmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export type DevelopmentPorts = {
  store: WorkspaceStore; code: CodeService; flags: FeatureFlagService; projects: ProjectService;
  preparer: Pick<ProjectOrchestrator, "prepareCodingWebsite" | "prepareCodingMobile">;
  executor: Pick<CodeSessionRunExecutor, "execute">; admission: CodeRunAdmission; background: CodeBackgroundRunRegistry;
  inbox?: CodeSessionInboxService; sandbox?: ProjectSandboxService; preview?: ProjectPreviewService; cancellation?: CodeRunCancellationRegistry;
  log: { warn(payload: unknown, message?: string): void };
};
/** Persistent chat bindings over the existing sandbox, admission and session executor. */
export class ChatDevelopmentService {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private starts = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(private readonly d: DevelopmentPorts) {}
  private owner(ctx: AuthContext) { return ctx.workspaceId + ":" + ctx.userId; }
  private jobKey(ctx: AuthContext, id: string) { return this.owner(ctx) + ":" + id; }
  private async entries(ctx: AuthContext): Promise<Entry[]> {
    const value = (await this.d.store.getUserSetting(ctx, key))?.value;
    return Array.isArray(value) ? value as Entry[] : [];
  }
  private async change(ctx: AuthContext, fn: (items: Entry[]) => Entry[]) {
    for (let n = 0; n < 12; n++) {
      const setting = await this.d.store.getUserSetting(ctx, key);
      const items = Array.isArray(setting?.value) ? setting.value as Entry[] : [];
      const next = fn(items);
      if (await this.d.store.setUserSetting(ctx, key, next, setting?.revision ?? 0)) return next;
    }
    throw new DevelopmentError("Development processes changed. Please retry.", 409);
  }
  private bounded(ctx: AuthContext, items: Entry[], activeIds = new Set<string>()) {
    const keep = new Set(items.filter(p => developmentIsActive(p) || activeIds.has(p.id) || this.jobs.has(this.jobKey(ctx, p.id))).map(p => p.id));
    const remaining = Math.max(0, 128 - keep.size);
    const recent = remaining ? items.filter(p => !keep.has(p.id)).slice(-remaining) : [];
    recent.forEach(p => keep.add(p.id));
    return items.filter(p => keep.has(p.id));
  }
  private async patch(ctx: AuthContext, id: string, patch: Partial<Entry>) {
    await this.change(ctx, items => items.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
  }
  async list(ctx: AuthContext): Promise<DevelopmentProcess[]> {
    const items = await this.entries(ctx);
    const companyIds = [...new Set(items.map(p => p.companyId))];
    const accessible = new Set((await Promise.all(companyIds.map(async companyId => {
      return await this.d.store.getCompany(ctx, companyId).then(() => companyId, () => null);
    }))).filter((id): id is string => id !== null));
    const companies = [...accessible];
    const runs = new Map(await Promise.all(companies.map(async companyId => {
      return [companyId, await this.d.store.listCodeRunStates({ companyId, limit: 200 })] as const;
    })));
    const inboxEnabled = new Map(await Promise.all(companies.map(async companyId => [companyId, this.d.inbox ? await this.d.inbox.isEnabled(ctx, companyId) : false] as const)));
    return Promise.all(items.filter(p => accessible.has(p.companyId)).map(async ({ requestId: _requestId, ...stored }) => {
      const item = { ...stored, inboxEnabled: inboxEnabled.get(stored.companyId) ?? false };
      if (this.jobs.has(this.jobKey(ctx, item.id))) return item;
      const latest = runs.get(item.companyId)?.filter(r => r.sessionId === item.sessionId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      if (latest && item.projectId) {
        if (latest.runId === item.runId && !developmentIsActive(item) && !["interrupted", "awaiting_approval"].includes(item.status)) return item;
        const project = await this.d.projects.get(ctx, item.companyId, item.projectId).catch(() => null);
        const live = this.d.background.isLive(latest.runId);
        const status: DevelopmentProcess["status"] = live || latest.status === "running" ? item.status === "stopping" && item.runId === latest.runId ? "stopping" : "running" : latest.status === "waiting_for_user" ? "awaiting_approval"
          : latest.status === "completed" && (!project?.previewUrl || project.lastBuildStatus !== "ready") ? "failed" : latest.status;
        return { ...item, runId: latest.runId, status, previewUrl: project?.previewUrl ?? undefined };
      }
      // Pre-session setup has no durable lease. Do not keep an orphaned setup spinner forever.
      if (developmentIsActive(item) && Date.now() - Date.parse(item.updatedAt) > 300_000) return { ...item, status: "interrupted" as const, detail: "The API process stopped before the session started." };
      return item;
    }));
  }
  private async serialize<T>(ctx: AuthContext, task: () => Promise<T>): Promise<T> {
    if (this.closing) throw new DevelopmentError("Development service is shutting down", 503);
    // Serialize identity creation per authenticated owner; updates use store revisions.
    const owner = this.owner(ctx);
    const previous = this.starts.get(owner) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(task);
    this.starts.set(owner, work);
    try { return await work; } finally { if (this.starts.get(owner) === work) this.starts.delete(owner); }
  }
  async start(ctx: AuthContext, input: { companyId: string; message: string; conversationId?: string; businessId?: string; requestId: string }) {
    return this.serialize(ctx, () => this.startOwned(ctx, input));
  }
  private async startOwned(ctx: AuthContext, input: { companyId: string; message: string; conversationId?: string; businessId?: string; requestId: string }) {
    if (!ctx.permissions.some(p => ["*", "owner", "admin:all", "business:manage", "workspace:write"].includes(p))) throw new DevelopmentError("Coding Agent write permission denied", 403);
    await this.d.store.getCompany(ctx, input.companyId);
    await this.d.flags.assertEnabled(ctx, "coding_agent.enabled", { companyId: input.companyId });
    await this.d.flags.assertEnabled(ctx, "code.write", { companyId: input.companyId });
    const mode = await this.d.flags.executionModes.get(ctx, input.companyId);
    if (mode.mode === "global") throw new DevelopmentError("Switch to Company or Sandbox to create independent sandbox projects. Global edits the NPATI source workspace.", 409);
    const existing = await this.entries(ctx);
    const duplicate = existing.filter(p => p.requestId === input.requestId);
    if (duplicate.length) return { conversationId: duplicate[0]!.parentConversationId, processes: duplicate };
    const targets = planChatDevelopment(input.message);
    if (!targets.length) throw new DevelopmentError("Describe a website, blog, shop, mobile app or CRM to create.");
    const currentViews = new Map((await this.list(ctx)).map(p => [p.id, p]));
    if ([...currentViews.values()].filter(developmentIsActive).length + targets.length > 4) throw new DevelopmentError("Four development processes are already active. Stop or wait for a process before starting another.", 409);
    let conversationId = input.conversationId;
    if (conversationId) {
      await this.d.store.getNeutralConversation(ctx, conversationId).catch(error => {
        if (!input.businessId) throw error;
        return this.d.store.getConversation(ctx, input.businessId, conversationId!);
      });
    } else conversationId = (await this.d.store.createNeutralConversation(ctx, input.message.slice(0, 80))).id;
    const now = new Date().toISOString();
    const created: Entry[] = targets.map(target => ({ id: randomUUID(), requestId: input.requestId, companyId: input.companyId,
      parentConversationId: conversationId!, businessId: input.businessId, name: target.name, framework: target.framework, status: "queued", hidden: false, createdAt: now, updatedAt: now }));
    await this.change(ctx, items => {
      if (items.filter(p => developmentIsActive(currentViews.get(p.id) ?? p)).length + created.length > 4) throw new DevelopmentError("Four development processes are already active. Stop or wait for a process before starting another.", 409);
      // Keep four tiles visible; old projects remain in Websites and in their own chats.
      const visibleOld = created.length === 4 ? [] : items.filter(p => !p.hidden).slice(-(4 - created.length)).map(p => p.id);
      return this.bounded(ctx, [...items.map(p => ({ ...p, hidden: !visibleOld.includes(p.id) })), ...created], new Set([...currentViews.values()].filter(developmentIsActive).map(p => p.id)));
    });
    const append = async (role: "user" | "assistant", text: string) => {
      try { return await this.d.store.appendNeutralMessage(ctx, conversationId!, role, text); }
      catch (error) { if (!input.businessId) throw error; return this.d.store.appendMessage(ctx, input.businessId, conversationId!, role, text); }
    };
    try {
      await append("user", input.message);
      await append("assistant", "Підключаю агента кодування. Починаю розробку в sandbox: " + targets.map(t => t.name + " (" + t.framework + ")").join(", ") + ". Після змін система перевірить build і запустить Live Preview.");
    } catch (error) {
      for (const process of created) await this.patch(ctx, process.id, { status: "failed", detail: "Could not save the chat." });
      throw error;
    }
    created.forEach((process, index) => {
      const controller = new AbortController();
      const jobKey = this.jobKey(ctx, process.id);
      const promise = this.run(ctx, process, targets[index]!, input.message, controller).catch(error => {
        this.d.log.warn({ err: error, processId: process.id }, "chat_development_run_failed");
      }).finally(() => this.jobs.delete(jobKey));
      this.jobs.set(jobKey, { controller, promise });
    });
    return { conversationId, processes: created };
  }
  private async card(ctx: AuthContext, process: Entry, project: Project, text: string) {
    const current = (await this.entries(ctx)).find(p => p.id === process.id);
    if (current?.conversationId) process.conversationId = current.conversationId;
    if (!process.conversationId) return;
    if (!await this.d.store.getNeutralConversation(ctx, process.conversationId).catch(() => null)) {
      process.conversationId = (await this.d.store.createNeutralConversation(ctx, project.name)).id;
      await this.patch(ctx, process.id, { conversationId: process.conversationId });
    }
    const message = await this.d.store.appendNeutralMessage(ctx, process.conversationId, "assistant", text);
    await saveChatProjectCard(this.d.store, ctx, process.conversationId, message.id, {
      id: project.id, projectId: project.id, companyId: project.companyId, name: project.name, status: project.status,
      framework: project.framework, previewUrl: project.previewUrl ?? undefined, lastBuildStatus: project.lastBuildStatus ?? undefined,
      kind: "code_project", sessionId: process.sessionId, runId: process.runId,
    });
  }
  private async run(ctx: AuthContext, process: Entry, target: DevelopmentTarget, message: string, controller: AbortController) {
    let lease: Awaited<ReturnType<CodeRunAdmission["admit"]>> | undefined;
    let sink: ReturnType<CodeBackgroundRunRegistry["start"]> | undefined;
    let runResult: unknown;
    let session: Awaited<ReturnType<CodeService["createSession"]>> | undefined;
    const ensureActive = () => { if (controller.signal.aborted) throw new DevelopmentError("Stopped by request"); };
    try {
      await this.patch(ctx, process.id, { status: "preparing" });
      ensureActive();
      const { project: raw } = await this.d.projects.create(ctx, process.companyId, {
        name: process.name, type: target.kind === "mobile_app" ? "mobile_app" : "code_project", description: message.slice(0, 5000),
      }, "chat-development:" + process.id);
      process.projectId = raw.id;
      process.conversationId = (await this.d.store.createNeutralConversation(ctx, process.name)).id;
      await this.patch(ctx, process.id, { projectId: raw.id, conversationId: process.conversationId });
      await this.card(ctx, process, raw, "Агент готує проєкт. Стан запуску відображається над полем чату.");
      ensureActive();
      const project = target.kind === "mobile_app"
        ? await this.d.preparer.prepareCodingMobile(ctx, raw, message)
        : await this.d.preparer.prepareCodingWebsite(ctx, raw, message, target.framework);
      ensureActive();
      await this.d.code.detectAndPersist(ctx, process.companyId, project.id);
      session = await this.d.code.createSession(ctx, process.companyId, project.id, { mode: "auto" });
      process.sessionId = session.id; process.runId = randomUUID();
      await this.card(ctx, process, project, "Coding Agent session started.");
      await this.patch(ctx, process.id, { sessionId: session.id, runId: process.runId, status: "queued" });
      lease = await this.d.admission.admit({ workspaceId: ctx.workspaceId, userId: ctx.userId, companyId: process.companyId, sessionId: session.id }, { signal: controller.signal });
      ensureActive();
      sink = this.d.background.start({ runId: process.runId, sessionId: session.id, companyId: process.companyId, userId: ctx.userId, projectId: project.id });
      controller.signal.addEventListener("abort", () => this.d.background.abort(process.runId!, "Stopped by request"), { once: true });
      await this.patch(ctx, process.id, { status: "running" });
      const outcome = await this.d.executor.execute({ ctx, session, runId: process.runId,
        prompt: "User request: " + message + "\nYour assigned project is " + target.name + " (" + target.kind + "). Implement ONLY this project, not the other requested projects. Work in the existing scaffold; read package.json and the main page before editing. Preserve the attached database/auth SDK. Do not re-scaffold or run create-next-app. Use code.deps.install to install dependencies. Do not start a dev server. Finish implementation; the system will verify the production build and start Live Preview.",
        cancelRequested: () => controller.signal.aborted,
        abort: () => this.d.background.abort(process.runId!, "Stopped by request"),
        sink: { signal: sink.signal, emitResult: result => sink!.emit("result", result), emitTerminal: (status, reason) => sink!.finish(status, reason) },
      });
      runResult = outcome.result;
      const finished = await this.d.projects.get(ctx, process.companyId, project.id);
      const ready = hasCodeChatPreview(outcome.result);
      const result = outcome.result as { message?: string } | null;
      const status = controller.signal.aborted ? "cancelled" : outcome.needsApproval ? "awaiting_approval"
        : outcome.terminalStatus === "completed" && !ready ? "failed" : outcome.terminalStatus;
      await this.patch(ctx, process.id, { status, detail: outcome.reason ?? (ready ? "Build passed ? Live Preview" : "Live Preview has not started"), previewUrl: ready ? finished.previewUrl ?? undefined : undefined });
      await this.card(ctx, process, finished, result?.message || (ready ? "Build passed. Live Preview is ready." : "Development ended: " + status));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Development failed";
      sink?.finish(controller.signal.aborted ? "cancelled" : "failed", detail);
      await this.patch(ctx, process.id, { status: controller.signal.aborted ? "cancelled" : "failed", detail });
      if (process.projectId && process.conversationId) {
        try { await this.card(ctx, process, await this.d.projects.get(ctx, process.companyId, process.projectId), detail); }
        catch (saveError) { this.d.log.warn({ err: saveError }, "development_error_card_failed"); }
      }
    } finally {
      try {
        if (process.projectId && this.d.sandbox && !hasCodeChatPreview(runResult)
            && this.d.preview?.getSession(process.projectId)?.status !== "running"
            && (!session || !this.d.inbox || await this.d.inbox.mayCleanup(ctx, session, runResult))) {
          await this.d.sandbox.releaseAfterRun(ctx, await this.d.projects.get(ctx, process.companyId, process.projectId));
        }
      } catch (error) { this.d.log.warn({ err: error }, "development_sandbox_cleanup_failed"); }
      lease?.release();
      if (session && this.d.inbox) await this.d.inbox.settled(ctx, session, runResult).catch(error => this.d.log.warn({ err: error }, "development_inbox_settle_failed"));
    }
  }
  private async owned(ctx: AuthContext, id: string) {
    const entry = (await this.entries(ctx)).find(p => p.id === id);
    if (!entry) throw new DevelopmentError("Process not found", 404);
    await this.d.store.getCompany(ctx, entry.companyId);
    const view = (await this.list(ctx)).find(p => p.id === id);
    return { ...entry, ...view };
  }
  async hide(ctx: AuthContext, id: string) { await this.owned(ctx, id); await this.patch(ctx, id, { hidden: true }); }
  private async adoptWebsites(ctx: AuthContext, available: number) {
    const known = new Set((await this.entries(ctx)).map(p => p.projectId));
    const companies = (await this.d.store.listCompanies(ctx, 100)).items;
    const projects = (await Promise.all(companies.map(c => this.d.projects.list(ctx, c.id)))).flat()
      .filter(p => p.status !== "archived" && isCodeChatWebsite(p) && !known.has(p.id))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, available);
    if (!projects.length) return;
    const root = await this.d.store.createNeutralConversation(ctx, "Development projects");
    const adopted: Entry[] = await Promise.all(projects.map(async project => {
      const sessions = await this.d.code.listSessions(ctx, project.companyId, project.id, { limit: 20 });
      const session = sessions.find(s => s.status === "active");
      return { id: randomUUID(), requestId: randomUUID(), companyId: project.companyId, projectId: project.id, sessionId: session?.id,
        parentConversationId: root.id, name: project.name, framework: project.framework ?? "", status: project.previewUrl && project.lastBuildStatus === "ready" ? "completed" : project.lastBuildStatus === "failed" ? "failed" : "idle",
        hidden: true, createdAt: project.createdAt, updatedAt: new Date().toISOString() };
    }));
    await this.change(ctx, items => this.bounded(ctx, [...items, ...adopted.filter(p => !items.some(existing => existing.projectId === p.projectId))]));
  }
  async restore(ctx: AuthContext) { return this.serialize(ctx, () => this.restoreOwned(ctx)); }
  private async restoreOwned(ctx: AuthContext) {
    let entries = await this.list(ctx);
    if (entries.length < 4) { await this.adoptWebsites(ctx, 4 - entries.length); entries = await this.list(ctx); }
    const chosen = [...entries.filter(developmentIsActive), ...entries.filter(p => !developmentIsActive(p)).reverse()].slice(0, 4).map(p => p.id);
    const roots = [...new Set(entries.filter(p => chosen.includes(p.id)).map(p => p.parentConversationId))];
    let root = roots.length === 1 ? roots[0] : undefined;
    if (chosen.length && (!root || !await this.d.store.getNeutralConversation(ctx, root).catch(() => null))) root = (await this.d.store.createNeutralConversation(ctx, "Development projects")).id;
    await this.change(ctx, items => items.map(p => ({ ...p, hidden: !chosen.includes(p.id), ...(root && chosen.includes(p.id) ? { parentConversationId: root } : {}) })));
    if (root) await this.d.store.appendNeutralMessage(ctx, root, "assistant", "Процеси розробки відновлено над полем чату.");
    return this.list(ctx);
  }
  async stop(ctx: AuthContext, id: string) {
    const process = await this.owned(ctx, id);
    if (!developmentIsActive(process)) return;
    const local = this.jobs.has(this.jobKey(ctx, id)) || this.d.cancellation?.hasLiveRun(process.sessionId ?? "") || this.d.background.isLive(process.runId ?? "");
    if (local) await this.patch(ctx, id, { status: "stopping", runId: process.runId, detail: "Stop requested" });
    this.jobs.get(this.jobKey(ctx, id))?.controller.abort();
    if (process.sessionId && this.d.cancellation) {
      this.d.cancellation.requestSessionCancel({ sessionId: process.sessionId, companyId: process.companyId, projectId: process.projectId, requestedBy: ctx.userId, runId: process.runId });
      this.d.cancellation.abortLiveRuns(process.sessionId);
    }
    if (process.runId) this.d.background.abort(process.runId, "Stopped by request");
    if (!this.jobs.has(this.jobKey(ctx, id)) && !this.d.cancellation?.hasLiveRun(process.sessionId ?? "") && !this.d.background.isLive(process.runId ?? "")) throw new DevelopmentError("Cancellation recorded, but this API instance does not own the run. Reconnect to the instance running it.", 409);
  }
  async open(ctx: AuthContext, id: string) {
    const process = await this.owned(ctx, id);
    if (!process.projectId) throw new DevelopmentError("The project is still being prepared.", 409);
    const project = await this.d.projects.get(ctx, process.companyId, process.projectId);
    let changed = false;
    if (!process.conversationId || !await this.d.store.getNeutralConversation(ctx, process.conversationId).catch(() => null)) {
      process.conversationId = (await this.d.store.createNeutralConversation(ctx, project.name)).id;
      await this.patch(ctx, process.id, { conversationId: process.conversationId });
      await this.card(ctx, process, project, "Project development restored from Websites."); changed = true;
    }
    const parent = await this.d.store.getNeutralConversation(ctx, process.parentConversationId).catch(() => process.businessId ? this.d.store.getConversation(ctx, process.businessId, process.parentConversationId).catch(() => null) : null);
    if (!parent) {
      const oldRoot = process.parentConversationId;
      process.parentConversationId = (await this.d.store.createNeutralConversation(ctx, "Development projects")).id; changed = true;
      await this.change(ctx, items => items.map(p => p.parentConversationId === oldRoot ? { ...p, parentConversationId: process.parentConversationId } : p));
    }
    if (changed) await this.patch(ctx, id, { conversationId: process.conversationId, parentConversationId: process.parentConversationId });
    return { url: "/c/" + process.conversationId + "?company=" + encodeURIComponent(process.companyId) + "&project=" + encodeURIComponent(project.id) + "&developmentRoot=" + process.parentConversationId };
  }
  async openProject(ctx: AuthContext, companyId: string, projectId: string) {
    return this.serialize(ctx, () => this.openProjectOwned(ctx, companyId, projectId));
  }
  private async openProjectOwned(ctx: AuthContext, companyId: string, projectId: string) {
    const project = await this.d.projects.get(ctx, companyId, projectId);
    let process = (await this.entries(ctx)).find(p => p.companyId === companyId && p.projectId === projectId);
    if (!process) {
      const root = await this.d.store.createNeutralConversation(ctx, "Development projects");
      const now = new Date().toISOString();
      process = { id: randomUUID(), requestId: randomUUID(), companyId, projectId, parentConversationId: root.id, name: project.name,
        framework: project.framework ?? "", status: project.previewUrl && project.lastBuildStatus === "ready" ? "completed" : project.lastBuildStatus === "failed" ? "failed" : "idle", hidden: true, createdAt: now, updatedAt: now };
      const activeIds = new Set((await this.list(ctx)).filter(developmentIsActive).map(p => p.id));
      await this.change(ctx, items => this.bounded(ctx, [...items, process!], activeIds));
    }
    return this.open(ctx, process.id);
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.starts.values()]);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
  }
}
