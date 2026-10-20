import { resolveCodingConversationLanguage, codingChatResponseInstruction, chatLanguageInstruction } from "./company-chat-i18n";
import { randomUUID } from "node:crypto";
import { DEVELOPMENT_PROCESS_SETTINGS_KEY, sanitizeExecutionTrace, developmentIsActive, planChatDevelopment, type DevelopmentProcess, type DevelopmentTarget } from "@npati/shared";
import { WorkspaceNotFoundError, WorkspaceAccessError, type AuthContext, type Project, type WorkspaceStore } from "@npati/workspace";
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

import { developmentTrace, sanitizeProgress, selectDevelopmentTraceRuns, executionTimestamp, executionResultDetails } from "./chat-development-trace";
import type { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { readIntentHistory } from "./chat-project-intent";

const key = DEVELOPMENT_PROCESS_SETTINGS_KEY;
type Entry = DevelopmentProcess & { requestId: string; businessId?: string; cardMessageId?: string; resultMessageId?: string };
export class DevelopmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export type DevelopmentPorts = {
  engine?: Pick<import("@npati/omniroute-adapter").AIEngine, "chat">;
  getAIContext?: (auth: AuthContext) => Promise<{ model?: string }>;
  resolveProjectIntent?: import("./chat-project-intent").ChatProjectIntentResolver;
  store: WorkspaceStore; code: CodeService; flags: FeatureFlagService; projects: ProjectService;
  preparer: Pick<ProjectOrchestrator, "prepareCodingWebsite" | "prepareCodingMobile">;
  executor: Pick<CodeSessionRunExecutor, "execute">; admission: CodeRunAdmission; background: CodeBackgroundRunRegistry;
  terminalEvents?: ProjectTerminalEventsRepository;
  inbox?: CodeSessionInboxService; sandbox?: ProjectSandboxService; preview?: ProjectPreviewService; cancellation?: CodeRunCancellationRegistry;
  log: { warn(payload: unknown, message?: string): void };
};
/** Persistent chat bindings over the existing sandbox, admission and session executor. */
export class ChatDevelopmentService {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private starts = new Map<string, Promise<unknown>>();
  private updates = new Map<string, Promise<unknown>>();
  private closing = false;
  private readonly projections = new Map<string, Promise<DevelopmentProcess[]>>();
  private listeners = new Set<() => void>();
  onUpdate(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notifyListeners() {
    for (const fn of this.listeners) {
      try { fn(); } catch {}
    }
  }
  constructor(private readonly d: DevelopmentPorts) { }
  private owner(ctx: AuthContext) { return ctx.workspaceId + ":" + ctx.userId; }
  private jobKey(ctx: AuthContext, id: string) { return this.owner(ctx) + ":" + id; }
  private async entries(ctx: AuthContext): Promise<Entry[]> {
    const value = (await this.d.store.getUserSetting(ctx, key))?.value;
    return Array.isArray(value) ? value as Entry[] : [];
  }
  private async change(ctx: AuthContext, fn: (items: Entry[]) => Entry[]): Promise<Entry[]> {
    const owner = this.owner(ctx);
    const work = (this.updates.get(owner) ?? Promise.resolve()).catch(() => {}).then(() => this.changeOwned(ctx, fn));
    this.updates.set(owner, work);
    try { return await work; } finally { if (this.updates.get(owner) === work) this.updates.delete(owner); }
  }
  private async changeOwned(ctx: AuthContext, fn: (items: Entry[]) => Entry[]) {
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
    this.notifyListeners();
  }
  async list(ctx: AuthContext): Promise<DevelopmentProcess[]> {
    const key = this.owner(ctx);
    const pending = this.projections.get(key);
    if (pending) return pending;
    const task = this.listOwned(ctx);
    this.projections.set(key, task);
    try { return await task; }
    finally { if (this.projections.get(key) === task) this.projections.delete(key); }
  }
  private async listOwned(ctx: AuthContext): Promise<DevelopmentProcess[]> {
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
    const views = await Promise.all(items.filter(p => accessible.has(p.companyId)).map(async ({ requestId: _requestId, ...stored }): Promise<DevelopmentProcess | null> => {
      try {
      const project = stored.projectId ? await this.d.projects.get(ctx, stored.companyId, stored.projectId) : null;
      const traceRuns = selectDevelopmentTraceRuns(runs.get(stored.companyId) ?? [], ctx, stored);
      const latestRun = traceRuns.roots.sort((a, b) => (executionTimestamp(b.startedAt) ?? 0) - (executionTimestamp(a.startedAt) ?? 0))[0];
      const traceProcess = latestRun ? { ...stored, runId: latestRun.runId } : stored;
      const progress = await developmentTrace(this.d.store, ctx, traceProcess, this.d.terminalEvents);
      const history = await Promise.all([...traceRuns.roots, ...traceRuns.children].filter(run => run.runId !== traceProcess.runId).map(run =>
        developmentTrace(this.d.store, ctx, { ...stored, progress: (stored.progress ?? []).filter(event => event.runId === run.runId), runId: run.runId, sessionId: run.sessionId }, this.d.terminalEvents)));
      const conversationMessages: NonNullable<DevelopmentProcess["conversationMessages"]> = [];
      const queueLanguages = new Map<string,string>();
      const chatHistory = stored.conversationId ? (await this.d.store.getNeutralConversation(ctx,stored.conversationId).catch(()=>({messages:[]}))).messages : [];
      if (stored.sessionId && this.d.inbox && inboxEnabled.get(stored.companyId)) {
        const session = await this.d.code.getSession(ctx,stored.companyId,stored.sessionId);
        const inbox = await this.d.inbox.transact(session,{kind:"read"});
        const history = [{role:"user",content:project?.description ?? "",createdAt:project?.createdAt ?? stored.createdAt}];
        for (const message of inbox.state.messages.filter(item=>!item.completion && item.authorId===ctx.userId && item.status!=="discarded")) {
          conversationMessages.push({id:"inbox:"+message.id,role:"user",content:message.text,createdAt:message.createdAt});
          const language = resolveCodingConversationLanguage(message.text,[...history,...chatHistory.filter(item=>item.role==="user" && Date.parse(item.createdAt)<Date.parse(message.createdAt))].sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0))); history.push({role:"user",content:message.text,createdAt:message.createdAt});
          if (!message.runId) continue;
          queueLanguages.set(message.runId,language);
          const bundle = await this.d.store.getReplayBundle(stored.companyId,message.runId);
          if (!bundle) continue;
          const steps = await this.d.store.listReplayBundleSteps(stored.companyId,bundle.id);
          const last = steps.filter(step=>step.kind==="model_step").at(-1);
          const response = last?.payload.response as {content?:unknown;toolCalls?:unknown[]}|undefined;
          if (typeof response?.content === "string" && response.content.trim() && !response.toolCalls?.length && !/^\s*[<{\[]/u.test(response.content)) conversationMessages.push({id:"inbox-reply:"+message.runId,role:"assistant",content:sanitizeExecutionTrace(response.content),createdAt:new Date(executionTimestamp(last!.createdAt) ?? Date.parse(message.createdAt)).toISOString()});
        }
      }
      const runLanguages = Object.fromEntries(traceRuns.roots.map(run => [run.runId, queueLanguages.get(run.runId) ?? resolveCodingConversationLanguage("",[{role:"user",content:project?.description ?? ""},...chatHistory.filter(message=>message.role==="user" && Date.parse(message.createdAt) <= (executionTimestamp(run.startedAt) ?? Infinity))]) ]));
      const merged = Array.from(new Map([...progress, ...history.flat()].map(event => [event.id, event])).values()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (const event of merged) if (event.runId && queueLanguages.has(event.runId)) event.language = queueLanguages.get(event.runId);
      const item = { ...traceProcess, previewUrl: project?.previewUrl ?? undefined, conversationMessages, initialRunId: stored.runId, runLanguages, runStartedAts: Object.fromEntries([...traceRuns.roots,...traceRuns.children].map(run=>[run.runId,new Date(executionTimestamp(run.startedAt) ?? executionTimestamp(stored.createdAt) ?? 0).toISOString()])), runStatuses: Object.fromEntries([...traceRuns.roots, ...traceRuns.children].map(run => [run.runId, run.status])), progress: merged, inboxEnabled: inboxEnabled.get(stored.companyId) ?? false };
      if (this.jobs.has(this.jobKey(ctx, item.id))) return item;
      const latest = latestRun;
      if (latest && item.projectId) {
        if (latest.runId === stored.runId && !developmentIsActive(item) && !["interrupted", "awaiting_approval"].includes(item.status)) return item;
        const live = this.d.background.isLive(latest.runId);
        const expired = latest.status === "running" && (executionTimestamp(latest.leaseExpiresAt) ?? Infinity) < Date.now();
        const previewEvent = merged.filter(event => event.runId === latest.runId && event.stage === "preview").at(-1);
        const previewReady = !!project?.previewUrl && (project.lastBuildStatus === "ready" || project.status === "previewing" && previewEvent?.status === "completed");
        const publishingPreview = previewEvent?.status === "running" || previewEvent?.status === "active";
        const status: DevelopmentProcess["status"] = expired && !live ? "interrupted" : live || latest.status === "running" ? item.status === "stopping" && item.runId === latest.runId ? "stopping" : "running" : latest.status === "waiting_for_user" ? "awaiting_approval"
          : latest.status === "completed" && publishingPreview ? "running" : latest.status === "completed" && !previewReady ? "failed" : latest.status;
        return { ...item, runId: latest.runId, status, previewUrl: project?.previewUrl ?? undefined };
      }
      // Pre-session setup has no durable lease. Do not keep an orphaned setup spinner forever.
      if (developmentIsActive(item) && Date.now() - Date.parse(item.updatedAt) > 300_000) return { ...item, status: "interrupted" as const, detail: "The API process stopped before the session started." };
      return item;
      } catch (error) {
        // Also covers a project removed between authorization and its terminal-log read.
        if (error instanceof WorkspaceNotFoundError || error instanceof WorkspaceAccessError) return null;
        throw error;
      }
    }));
    return views.filter((item): item is DevelopmentProcess => item !== null);
  }
  private async serialize<T>(ctx: AuthContext, task: () => Promise<T>): Promise<T> {
    if (this.closing) throw new DevelopmentError("Development service is shutting down", 503);
    // Serialize identity creation per authenticated owner; updates use store revisions.
    const owner = this.owner(ctx);
    const previous = this.starts.get(owner) ?? Promise.resolve();
    const work = previous.catch(() => { }).then(task);
    this.starts.set(owner, work);
    try { return await work; } finally { if (this.starts.get(owner) === work) this.starts.delete(owner); }
  }
  async start(ctx: AuthContext, input: { companyId: string; message: string; targets?: DevelopmentTarget[]; conversationId?: string; businessId?: string; requestId: string }) {
    return this.serialize(ctx, () => this.startOwned(ctx, input));
  }
  async plan(ctx: AuthContext, input: { message: string; projectId?: string; companyId?: string; conversationId?: string; businessId?: string }) {
    if (input.projectId && !input.companyId) throw new DevelopmentError("Company is required for project context");
    if (input.companyId) await this.d.store.getCompany(ctx, input.companyId);
    if (input.projectId) await this.d.projects.get(ctx, input.companyId!, input.projectId);
    const history = await readIntentHistory(this.d.store, ctx, input.conversationId, input.businessId);
    if (!this.d.resolveProjectIntent) return planChatDevelopment(input.message, input.projectId);
    return (await this.d.resolveProjectIntent(ctx, { message: input.message, activeProjectId: input.projectId,
      activeCompanyId: input.companyId, conversationHistory: history })).targets;
  }
  private async startOwned(ctx: AuthContext, input: { companyId: string; message: string; targets?: DevelopmentTarget[]; conversationId?: string; businessId?: string; requestId: string }) {
    if (!ctx.permissions.some(p => ["*", "owner", "admin:all", "business:manage", "workspace:write"].includes(p))) throw new DevelopmentError("Coding Agent write permission denied", 403);
    await this.d.store.getCompany(ctx, input.companyId);
    await this.d.flags.assertEnabled(ctx, "coding_agent.enabled", { companyId: input.companyId });
    await this.d.flags.assertEnabled(ctx, "code.write", { companyId: input.companyId });
    const mode = await this.d.flags.executionModes.get(ctx, input.companyId);
    if (mode.mode === "global") throw new DevelopmentError("Switch to Company or Sandbox to create independent sandbox projects. Global edits the NPATI source workspace.", 409);
    const existing = await this.entries(ctx);
    const duplicate = existing.filter(p => p.requestId === input.requestId);
    if (duplicate.length) return { conversationId: duplicate[0]!.parentConversationId, processes: duplicate };
    const targets = (input.targets && input.targets.length) ? input.targets : await this.plan(ctx, input);
    if (!targets.length) throw new DevelopmentError("Describe a website, blog, shop, mobile app or CRM to create.");
    const activeExisting = (await this.list(ctx)).filter(developmentIsActive);
    if (activeExisting.length + targets.length > 4) throw new DevelopmentError("Four development processes are already active. Stop or wait for a process before starting another.", 409);
    let conversationId = input.conversationId;
    if (conversationId) {
      await this.d.store.getNeutralConversation(ctx, conversationId).catch(error => {
        if (!input.businessId) throw error;
        return this.d.store.getConversation(ctx, input.businessId, conversationId!);
      });
    } else conversationId = (await this.d.store.createNeutralConversation(ctx, input.message.slice(0, 80))).id;
    const history = (await this.d.store.getNeutralConversation(ctx, conversationId!).catch(() => ({ messages: [] }))).messages;
    const responseLanguage = resolveCodingConversationLanguage(input.message, history);
    const now = new Date().toISOString();
    const created: Entry[] = targets.map((target, index) => {
      const processId = randomUUID();
      const localizedName = responseLanguage === "uk" && target.name === "Online store" ? "Інтернет-магазин"
        : responseLanguage === "uk" && target.name === "Company website" ? "Вебсайт компанії"
        : target.name;
      return {
        id: processId, requestId: input.requestId, companyId: input.companyId,
        conversationId: index === 0 ? conversationId! : undefined,
        parentConversationId: conversationId!, responseLanguage, businessId: input.businessId,
        name: localizedName, framework: target.framework,
        status: "preparing",
        hidden: false, createdAt: now, updatedAt: now
      };
    });
    await this.change(ctx, items => {
      const activeIds = new Set(activeExisting.map(p => p.id));
      if (activeIds.size + created.length > 4) throw new DevelopmentError("Four development processes are already active. Stop or wait for a process before starting another.", 409);
      // Keep four tiles visible; old projects remain in Websites and in their own chats.
      const visibleOld = created.length === 4 ? [] : items.filter(p => !p.hidden).slice(-(4 - created.length)).map(p => p.id);
      return this.bounded(ctx, [...items.map(p => ({ ...p, hidden: !visibleOld.includes(p.id) })), ...created], activeIds);
    });
    this.notifyListeners();
    const append = async (role: "user" | "assistant", text: string) => {
      try { return await this.d.store.appendNeutralMessage(ctx, conversationId!, role, text); }
      catch (error) { if (!input.businessId) throw error; return this.d.store.appendMessage(ctx, input.businessId, conversationId!, role, text); }
    };
    try {
      await append("user", input.message);
      // The coding run supplies real responses; no separate intro request or canned fallback.
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
  async recordActivity(ctx: AuthContext, companyId: string, sessionId: string, conversationId: string | undefined, event: import("@npati/shared").DevelopmentProcessProgressItem) {
    const owned = (await this.entries(ctx)).find(p => p.companyId === companyId && p.sessionId === sessionId && (!conversationId || p.conversationId === conversationId));
    if (!owned) return;
    const details = executionResultDetails(event.result);
    const safe = sanitizeProgress({ ...event, ...details, status: ["cancelled", "awaiting_approval", "waiting_for_approval"].includes(event.status ?? "") ? event.status : details.status ?? event.status, conversationId: owned.conversationId });
    await this.change(ctx, items => items.map(p => p.id !== owned.id ? p : { ...p, progress: [...(p.progress ?? []).filter(item => item.id !== safe.id), safe], updatedAt: new Date().toISOString() }));
    this.notifyListeners();
  }
  private async report(ctx: AuthContext, id: string, stage: string, title: string, details?: Record<string, unknown>) {
    await this.change(ctx, items => items.map(item => {
      if (item.id !== id) return item;
      const eventId = id + ":" + stage;
      const previous = item.progress?.find(event => event.id === eventId);
      const event = sanitizeProgress({ ...previous, id: eventId, stage, title, at: previous?.at ?? new Date().toISOString(), conversationId: item.conversationId, ...Object.fromEntries(Object.entries(details ?? {}).filter(([, value]) => value !== undefined)) });
      return { ...item, progress: [...(item.progress ?? []).filter(event => event.id !== eventId), event].slice(-200), updatedAt: new Date().toISOString() };
    }));
    this.notifyListeners();
  }
  private async settleProgress(ctx: AuthContext, id: string, status: DevelopmentProcess["status"]) {
    await this.change(ctx, items => items.map(item => item.id !== id ? item : { ...item, progress: item.progress?.map(event =>
      ["active", "running"].includes(event.status ?? "") ? { ...event, status: status === "awaiting_approval" ? "waiting_for_approval" as const : status === "completed" ? "completed" as const : status === "cancelled" ? "cancelled" as const : "failed" as const } : event) }));
  }
  private async card(ctx: AuthContext, process: Entry, project: Project, text: string) {
    const current = (await this.entries(ctx)).find(p => p.id === process.id);
    if (current?.conversationId) process.conversationId = current.conversationId;
    if (!process.conversationId) return;
    const hasConversation = async (convId: string) => {
      try { await this.d.store.getNeutralConversation(ctx, convId); return true; }
      catch { return process.businessId ? !!await this.d.store.getConversation(ctx, process.businessId, convId).catch(() => null) : false; }
    };
    if (!await hasConversation(process.conversationId)) {
      process.conversationId = (await this.d.store.createNeutralConversation(ctx, project.name)).id;
      await this.patch(ctx, process.id, { conversationId: process.conversationId });
    }
    let messageId = current?.conversationId === process.conversationId ? current.cardMessageId : undefined;
    if (!messageId) {
      const getChat = async () => {
        try { return await this.d.store.getNeutralConversation(ctx, process.conversationId!); }
        catch { return process.businessId ? this.d.store.getConversation(ctx, process.businessId, process.conversationId!).catch(() => null) : null; }
      };
      const chat = await getChat();
      // Routing metadata belongs to the existing request, not an extra overview bubble.
      messageId = chat?.messages.find(item => item.role === "user")?.id
        ?? (await this.d.store.appendNeutralMessage(ctx, process.conversationId, "assistant", process.name)).id;
      await this.patch(ctx, process.id, { cardMessageId: messageId });
    }
    const view = (await this.entries(ctx)).find(item => item.id === process.id);
    if (view && !developmentIsActive(view) && view.status !== "idle" && !view.resultMessageId && text.trim()) {
      const appendAssistant = async (content: string) => {
        try { return await this.d.store.appendNeutralMessage(ctx, process.conversationId!, "assistant", content); }
        catch { if (!process.businessId) throw new Error("Could not append message"); return this.d.store.appendMessage(ctx, process.businessId, process.conversationId!, "assistant", content); }
      };
      const result = await appendAssistant(text);
      await this.patch(ctx, process.id, { resultMessageId: result.id });
    }
    await saveChatProjectCard(this.d.store, ctx, process.conversationId, messageId, {
      id: project.id, projectId: project.id, companyId: project.companyId, name: project.name, status: view?.status ?? "preparing",
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
      if (!process.conversationId) {
        process.conversationId = (await this.d.store.createNeutralConversation(ctx, process.name)).id;
        await this.d.store.appendNeutralMessage(ctx, process.conversationId, "user", message);
      }
      await this.patch(ctx, process.id, { conversationId: process.conversationId });
      await this.report(ctx, process.id, "project", "Preparing project workspace", { tool: "code.workspace", status: "running", agentId: "System" });
      ensureActive();
      const { project: raw } = await this.d.projects.create(ctx, process.companyId, {
        name: process.name, type: target.kind === "mobile_app" ? "mobile_app" : "code_project", description: message.slice(0, 5000),
      }, "chat-development:" + process.id);
      await this.report(ctx, process.id, "project", "Project workspace prepared", { tool: "code.workspace", status: "completed", agentId: "System" });
      process.projectId = raw.id;
      await this.patch(ctx, process.id, { projectId: raw.id, conversationId: process.conversationId });
      await this.card(ctx, process, raw, "Агент готує проєкт. Стан запуску відображається над полем чату.");
      ensureActive();
      await this.report(ctx, process.id, "scaffold", "Preparing the existing " + target.framework + " template", { tool: "code.scaffold", status: "running", agentId: "System" });
      const project = target.kind === "mobile_app"
        ? await this.d.preparer.prepareCodingMobile(ctx, raw, message)
        : await this.d.preparer.prepareCodingWebsite(ctx, raw, message, target.framework);
      ensureActive();
      await this.report(ctx, process.id, "scaffold", "Project template prepared", { tool: "code.scaffold", status: "completed", agentId: "System" });
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
      if (this.d.preview) {
        await this.d.flags.assertEnabled(ctx, "code.shell", { companyId: process.companyId });
        let reports = Promise.resolve();
        await this.d.preview.buildProject(ctx, process.companyId, project.id, (stage, details) => {
          ensureActive();
          reports = reports.then(() => this.report(ctx, process.id, stage, stage === "dependencies" ? "Installing dependencies" : "Building project", {
            status: "running", agentId: "System", ...details, result: details?.stdout || details?.stderr ? [details.stdout, details.stderr].filter(Boolean).join("\n") : undefined,
          }));
        }, { dependenciesOnly: true }).finally(() => reports);
        await this.report(ctx, process.id, "dependencies", "Dependencies installed", { status: "completed", agentId: "System" });

      }
      ensureActive();
      await this.report(ctx, process.id, "agent", "Coding Agent is implementing the requested project", {
        tool: "coding_agent",
        status: "active",
        agentId: "Coding Agent",
      });
      const outcome = await this.d.executor.execute({
        responseLanguage: process.responseLanguage as import("./company-chat-i18n").CompanyChatLanguage,
        ctx, session, runId: process.runId, requireImplementation: true,
        onActivity: event => this.recordActivity(ctx, process.companyId, session!.id, process.conversationId, { ...event, language: process.responseLanguage }),
        prompt: "Begin with a brief natural acknowledgement in the user's language alongside your first tool calls, then implement the request. User request: " + message + "\nYour assigned project is " + target.name + " (" + target.kind + "). Implement ONLY this project's complete user specification, including every requested page and working interaction. Other independent requested projects have their own workspaces. The existing template has already been prepared by the system. Reuse its working auth/database SDK and routes. Implement exactly the requested features; avoid unrequested sections and speculative infrastructure. Prefer a few complete pages with working interactions. Do not regenerate shared components that you have already implemented. Start with " + (target.kind === "mobile_app" ? "App.tsx" : target.framework === "HTML/CSS" ? "index.html" : "package.json and app/page.tsx") + ", then create all required files. Do not stop after the homepage or an initial visual implementation. Keep a checklist of the requested deliverables and verify them before declaring completion. Use the configured runtime budget, reserving time for verification and repairs. CRITICAL EXECUTION RULES: 1. Do NOT execute shell commands (code.shell.exec) with pipes (|), redirects (>), or bash expansions — they are blocked by security policy. Use code.fs.tree or code.fs.list for directory structure. 2. Do NOT spend multiple turns endlessly reading or listing template files. After a quick inspection of the entry point, IMMEDIATELY proceed to write and update the necessary source files using code.fs.write or code.fs.edit. 3. Batch independent file reads and related file changes; avoid reading back full files you just wrote. Read only files needed for this request. Preserve the attached database/auth SDK. Do not re-scaffold or run create-next-app. Template dependencies are already installed by the system. Only when adding a new package, use the available code.deps.add tool. Do not start a dev server. The system starts Live Preview after successful implementation and verification. If a limit prevents completion, state which deliverables remain; never claim the site is complete." + chatLanguageInstruction(message, [], process.responseLanguage as import("./company-chat-i18n").CompanyChatLanguage) + codingChatResponseInstruction(),
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
      await this.settleProgress(ctx, process.id, status);
      await this.patch(ctx, process.id, { status, detail: outcome.reason ?? (ready ? "Build passed · Live Preview" : "Live Preview has not started"), previewUrl: ready ? finished.previewUrl ?? undefined : undefined });
      await this.report(ctx, process.id, status, result?.message || outcome.reason || (ready ? "Verified build and Live Preview are ready" : "Development stopped before verified completion"), {
        tool: "code.verification",
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "waiting_for_approval",
        result: result?.message || outcome.reason,
        agentId: "System",
      });
      if (status === "failed" || status === "cancelled") await this.d.projects.updatePreview(ctx, process.companyId, project.id, { status: "failed" });
      await this.card(ctx, process, finished, result?.message || (ready ? "Build passed. Live Preview is ready." : "Development ended: " + status));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Development failed";
      sink?.finish(controller.signal.aborted ? "cancelled" : "failed", detail);
      await this.patch(ctx, process.id, { status: controller.signal.aborted ? "cancelled" : "failed", detail });
      await this.settleProgress(ctx, process.id, controller.signal.aborted ? "cancelled" : "failed");
      await this.report(ctx, process.id, controller.signal.aborted ? "cancelled" : "failed", detail, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: detail,
        agentId: "System",
      });
      if (process.projectId && process.conversationId) {
        await this.d.projects.updatePreview(ctx, process.companyId, process.projectId, { status: "failed" });
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
      return {
        id: randomUUID(), requestId: randomUUID(), companyId: project.companyId, projectId: project.id, sessionId: session?.id,
        parentConversationId: root.id, name: project.name, framework: project.framework ?? "", status: project.previewUrl && project.lastBuildStatus === "ready" ? "completed" : project.lastBuildStatus === "failed" ? "failed" : "idle",
        hidden: true, createdAt: project.createdAt, updatedAt: new Date().toISOString()
      };
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
    await this.patch(ctx, id, { status: "cancelled", runId: process.runId, detail: "Stopped by request" });
    await this.settleProgress(ctx, id, "cancelled");
    for (const [key, job] of this.jobs.entries()) {
      if (key === id || key.endsWith(":" + id)) {
        job.controller.abort();
      }
    }
    this.jobs.get(this.jobKey(ctx, id))?.controller.abort();
    if (process.sessionId && this.d.cancellation) {
      this.d.cancellation.requestSessionCancel({ sessionId: process.sessionId, companyId: process.companyId, projectId: process.projectId, requestedBy: ctx.userId, runId: process.runId });
      this.d.cancellation.abortLiveRuns(process.sessionId);
    }
    if (process.runId) {
      this.d.background.abort(process.runId, "Stopped by request");
    }
    this.notifyListeners();
  }
  async open(ctx: AuthContext, id: string) {
    const process = await this.owned(ctx, id);
    if (!process.projectId) throw new DevelopmentError("The project is still being prepared.", 409);
    const project = await this.d.projects.get(ctx, process.companyId, process.projectId);
    let changed = false;
    const hasConversation = async (convId: string) => {
      try { await this.d.store.getNeutralConversation(ctx, convId); return true; }
      catch { return process.businessId ? !!await this.d.store.getConversation(ctx, process.businessId, convId).catch(() => null) : false; }
    };
    if (!process.conversationId || !await hasConversation(process.conversationId)) {
      process.conversationId = (await this.d.store.createNeutralConversation(ctx, project.name)).id;
      await this.patch(ctx, process.id, { conversationId: process.conversationId, cardMessageId: undefined, resultMessageId: undefined });
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
      process = {
        id: randomUUID(), requestId: randomUUID(), companyId, projectId, parentConversationId: root.id, name: project.name,
        framework: project.framework ?? "", status: project.previewUrl && project.lastBuildStatus === "ready" ? "completed" : project.lastBuildStatus === "failed" ? "failed" : "idle", hidden: true, createdAt: now, updatedAt: now
      };
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
