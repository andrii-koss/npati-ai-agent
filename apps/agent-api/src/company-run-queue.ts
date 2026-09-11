import { createClient } from "redis";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { CompanyDelegationRuntime } from "./company-runtime";

const STREAM = "npati:company-runs:v1";
const GROUP = "npati-company-workers";
const CANCEL_CHANNEL = "npati:company-runs:cancel:v1";
export type CompanyRunJob = {
  context: AuthContext;
  companyId: string;
  runId: string;
  scopeId?: string;
  companyRevision?: number;
  agentConfigRevision?: number;
  capabilitySetRevision?: number;
  enqueuedAt?: string;
};
type RedisClient = ReturnType<typeof createClient>;

export class CompanyRunQueueProducer {
  private client?: RedisClient;
  private connecting?: Promise<RedisClient>;
  constructor(private readonly redisUrl: string) {}
  private async get() {
    if (this.client?.isReady) return this.client;
    if (!this.connecting) this.connecting = (async () => {
      const client = createClient({ url: this.redisUrl });
      client.on("error", () => undefined);
      await client.connect();
      try { await client.sendCommand(["XGROUP","CREATE",STREAM,GROUP,"0","MKSTREAM"]); }
      catch (error) { if (!String(error).includes("BUSYGROUP")) throw error; }
      this.client = client;
      return client;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async enqueue(job: CompanyRunJob) {
    const client = await this.get();
    await client.sendCommand(["XADD",STREAM,"*","payload",JSON.stringify(job)]);
  }
  async cancel(job: CompanyRunJob) {
    const client = await this.get();
    await client.publish(CANCEL_CHANNEL, JSON.stringify(job));
  }
  async close() { if (this.client?.isOpen) await this.client.quit(); }
}

type WorkerOptions = {
  concurrency?: number;
  leaseMs?: number;
  recoveryMs?: number;
  workerId?: string;
  maxConcurrentPerTenant?: number;
};
export class CompanyRunQueueWorker {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly recoveryMs: number;
  private readonly maxConcurrentPerTenant: number;
  private readonly activePerTenant = new Map<string, number>();
  private stopped = false;
  private client?: RedisClient;
  private subscriber?: RedisClient;
  constructor(private readonly redisUrl: string, private readonly store: WorkspaceStore,
    private readonly runtime: CompanyDelegationRuntime, options: WorkerOptions = {}) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
    this.concurrency = Math.max(1, Math.min(32, options.concurrency ?? 2));
    this.leaseMs = Math.max(30_000, options.leaseMs ?? 180_000);
    this.recoveryMs = Math.max(5_000, options.recoveryMs ?? 30_000);
    this.maxConcurrentPerTenant = Math.max(1, options.maxConcurrentPerTenant ?? 10);
  }
  async start() {
    this.client = createClient({ url: this.redisUrl });
    this.client.on("error", () => undefined);
    await this.client.connect();
    try { await this.client.sendCommand(["XGROUP","CREATE",STREAM,GROUP,"0","MKSTREAM"]); }
    catch (error) { if (!String(error).includes("BUSYGROUP")) throw error; }
    this.subscriber = this.client.duplicate();
    this.subscriber.on("error", () => undefined);
    await this.subscriber.connect();
    await this.subscriber.subscribe(CANCEL_CHANNEL, (raw) => {
      try {
        const job = JSON.parse(raw) as CompanyRunJob;
        void this.runtime.cancel(job.context, job.companyId, job.runId);
      } catch { /* malformed cancellation is ignored */ }
    });
    await this.recover();
    const recovery = setInterval(() => void this.recover(), this.recoveryMs);
    recovery.unref();
    await Promise.all(Array.from({ length: this.concurrency }, (_, index) => this.loop(index)));
    clearInterval(recovery);
  }
  async stop() {
    this.stopped = true;
    if (this.subscriber?.isOpen) await this.subscriber.quit();
    if (this.client?.isOpen) await this.client.quit();
  }
  private async recover() {
    if (!this.client?.isReady) return;
    await this.client.set('npati:company-worker:heartbeat', new Date().toISOString(), { PX: Math.max(30_000, this.recoveryMs * 3) });
    for (const job of await this.store.listRecoverableCompanyAgentRuns(500)) {
      await this.client.sendCommand(["XADD",STREAM,"*","payload",JSON.stringify(job)]);
    }
  }
  private parse(reply: unknown): Array<{ id: string; job: CompanyRunJob }> {
    if (!Array.isArray(reply)) return [];
    const streams = reply as unknown[];
    const first = streams[0];
    const messages = Array.isArray(first) && first[0] === STREAM && Array.isArray(first[1])
      ? first[1] as unknown[]
      : streams;
    return messages.flatMap((message) => {
      if (!Array.isArray(message) || typeof message[0] !== "string" || !Array.isArray(message[1])) return [];
      const fields = message[1] as unknown[];
      const at = fields.findIndex((value) => value === "payload");
      if (at < 0 || typeof fields[at + 1] !== "string") return [];
      try { return [{ id: message[0], job: JSON.parse(fields[at + 1] as string) as CompanyRunJob }]; }
      catch { return []; }
    });
  }
  private async loop(index: number) {
    const consumer = `${this.workerId}-${index}`;
    while (!this.stopped) {
      try {
        const reclaimed = await this.client!.sendCommand(["XAUTOCLAIM",STREAM,GROUP,consumer,String(this.leaseMs),"0-0","COUNT","10"]);
        const claimedMessages = Array.isArray(reclaimed) ? this.parse((reclaimed as unknown[])[1]) : [];
        const messages = claimedMessages.length ? claimedMessages : this.parse(await this.client!.sendCommand(
          ["XREADGROUP","GROUP",GROUP,consumer,"COUNT","1","BLOCK","5000","STREAMS",STREAM,">"]));
        for (const message of messages) await this.handle(message, consumer);
      } catch (error) {
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  private async handle(message: { id: string; job: CompanyRunJob }, consumer: string) {
    const { context, companyId, runId } = message.job;
    const tenantId = context.workspaceId;
    const activeCount = this.activePerTenant.get(tenantId) ?? 0;
    if (activeCount >= this.maxConcurrentPerTenant) {
      // Defer execution of this job to prevent starving other tenants
      return;
    }
    this.activePerTenant.set(tenantId, activeCount + 1);

    try {
      let claimed = false;
      try { claimed = await this.store.claimCompanyAgentRun(context, companyId, runId, consumer, this.leaseMs); }
      catch {
        await this.client!.sendCommand(["XACK",STREAM,GROUP,message.id]);
        return;
      }
      if (!claimed) { await this.client!.sendCommand(["XACK",STREAM,GROUP,message.id]); return; }
      const claimedRun = (await this.runtime.get(context, companyId, runId)).run;
      await this.runtime.recordBackgroundEvent(context, companyId, runId, {
        eventKey: `attempt:${claimedRun.attemptCount}:claimed`, eventType: "claimed", runStatus: "planning",
        workerId: consumer, attemptCount: claimedRun.attemptCount, message: "Background worker claimed the run",
        details: { leaseMs: this.leaseMs },
      });
      const heartbeat = setInterval(() => void this.store.heartbeatCompanyAgentRun(context, companyId, runId, consumer, this.leaseMs), Math.max(5000, this.leaseMs / 3));
      heartbeat.unref();
      try {
        await this.runtime.recordBackgroundEvent(context, companyId, runId, {
          eventKey: `attempt:${claimedRun.attemptCount}:started`, eventType: "started", runStatus: "running",
          workerId: consumer, attemptCount: claimedRun.attemptCount, message: "Background worker started Company execution",
        });
        const result = await this.runtime.process(context, companyId, runId);
        const nonRetryable = new Set(["TOOL_FORBIDDEN","APPROVAL_REQUIRED","APPROVAL_INVALID","APPROVAL_ALREADY_USED","APPROVAL_EXPIRED","RUN_CANCELLED","INVALID_DELEGATION_PLAN","CROSS_COMPANY_AGENT_SELECTION","PERMISSION_REVOKED","CONTEXT_DELETED","COMPANY_INACTIVE","MAIN_AGENT_INACTIVE","AGENT_DELETED"]);
        if (result.run.status === "failed" && !nonRetryable.has(result.run.errorCode ?? "")
          && result.run.attemptCount < result.run.maxAttempts) {
          const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, result.run.attemptCount - 1));
          if (await this.store.requeueCompanyAgentRun(context, companyId, runId, consumer, delay)) {
            await this.runtime.recordBackgroundEvent(context, companyId, runId, {
              eventKey: `attempt:${result.run.attemptCount}:retry`, eventType: "retry_scheduled", runStatus: "queued",
              workerId: consumer, attemptCount: result.run.attemptCount, message: "Background run scheduled for retry",
              details: { delayMs: delay, errorCode: result.run.errorCode ?? "RUN_FAILED" },
            });
          }
        } else if (["completed", "failed", "cancelled"].includes(result.run.status)) {
          const terminalStatus = result.run.status as "completed" | "failed" | "cancelled";
          await this.runtime.recordBackgroundEvent(context, companyId, runId, {
            eventKey: `terminal:${terminalStatus}`, eventType: terminalStatus, runStatus: terminalStatus,
            workerId: consumer, attemptCount: result.run.attemptCount,
            message: terminalStatus === "completed" ? "Background run completed and completion report is available"
              : terminalStatus === "cancelled" ? "Background run cancelled" : "Background run failed",
            details: { errorCode: result.run.errorCode ?? null, totalTokens: result.run.totalTokens ?? 0,
              totalCost: result.run.totalCost ?? 0, totalDurationMs: result.run.totalDurationMs ?? 0 },
          });
        }
      } finally {
        clearInterval(heartbeat);
        await this.client!.sendCommand(["XACK",STREAM,GROUP,message.id]);
      }
    } finally {
      const remaining = (this.activePerTenant.get(tenantId) ?? 1) - 1;
      if (remaining <= 0) this.activePerTenant.delete(tenantId);
      else this.activePerTenant.set(tenantId, remaining);
    }
  }
}
