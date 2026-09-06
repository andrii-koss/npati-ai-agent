import { randomUUID, createHmac } from "node:crypto";

export type BackgroundJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  companyId: string;
  agentId: string;
  taskType: string;
  payload: Record<string, unknown>;
  status: BackgroundJobStatus;
  progressPercent: number;
  currentStep?: string;
  stepsHistory: Array<{ step: string; timestamp: string }>;
  result?: Record<string, unknown>;
  error?: string;
  callbackUrl?: string;
  webhookSecret?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CompletionReportPayload {
  jobId: string;
  companyId: string;
  agentId: string;
  taskType: string;
  status: BackgroundJobStatus;
  result?: Record<string, unknown>;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export class BackgroundCompletionReporter {
  private readonly jobs = new Map<string, BackgroundJob>();

  /**
   * Start a new asynchronous background job
   */
  createJob(params: {
    companyId: string;
    agentId: string;
    taskType: string;
    payload?: Record<string, unknown>;
    callbackUrl?: string;
    webhookSecret?: string;
  }): BackgroundJob {
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const job: BackgroundJob = {
      id,
      companyId: params.companyId,
      agentId: params.agentId,
      taskType: params.taskType,
      payload: params.payload ?? {},
      status: "queued",
      progressPercent: 0,
      stepsHistory: [{ step: "Job queued for processing", timestamp: now }],
      callbackUrl: params.callbackUrl,
      webhookSecret: params.webhookSecret,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Update progress for a running background job
   */
  updateProgress(jobId: string, progressPercent: number, stepMessage: string): BackgroundJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Background job '${jobId}' does not exist.`);
    }

    job.status = "running";
    job.progressPercent = Math.min(100, Math.max(0, progressPercent));
    job.currentStep = stepMessage;
    job.updatedAt = new Date().toISOString();
    job.stepsHistory.push({ step: stepMessage, timestamp: job.updatedAt });

    return job;
  }

  /**
   * Mark job as completed and build authenticated completion report
   */
  completeJob(
    jobId: string,
    result: Record<string, unknown>
  ): { job: BackgroundJob; report: CompletionReportPayload; signature?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Background job '${jobId}' does not exist.`);
    }

    const now = new Date().toISOString();
    job.status = "completed";
    job.progressPercent = 100;
    job.currentStep = "Completed successfully";
    job.result = result;
    job.updatedAt = now;
    job.completedAt = now;
    job.stepsHistory.push({ step: "Job completed", timestamp: now });

    const durationMs = new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime();

    const report: CompletionReportPayload = {
      jobId: job.id,
      companyId: job.companyId,
      agentId: job.agentId,
      taskType: job.taskType,
      status: "completed",
      result: job.result,
      durationMs,
      timestamp: now,
    };

    let signature: string | undefined;
    if (job.webhookSecret) {
      signature = createHmac("sha256", job.webhookSecret).update(JSON.stringify(report)).digest("hex");
    }

    return { job, report, signature };
  }

  /**
   * Mark job as failed
   */
  failJob(jobId: string, error: string): BackgroundJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Background job '${jobId}' does not exist.`);
    }

    const now = new Date().toISOString();
    job.status = "failed";
    job.error = error;
    job.updatedAt = now;
    job.completedAt = now;
    job.stepsHistory.push({ step: `Job failed: ${error}`, timestamp: now });

    return job;
  }

  /**
   * Get job status
   */
  getJob(jobId: string): BackgroundJob | null {
    return this.jobs.get(jobId) || null;
  }
}
