import { usageQuotasEnabled } from "./usage-quota-policy";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type { CompanyEmailAccount, CompanyEmailJob, CompanyEmailNotification } from "./email-inbox-types";

export interface EmailInboxJobsHost {
  pool?: Pool
  memoryJobs: Map<string, CompanyEmailJob>
  sentTimestamps: Map<string, number[]>
  memoryNotifications: Map<string, CompanyEmailNotification>
}

export async function checkRateLimit(host: EmailInboxJobsHost, 
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {

    if (!usageQuotasEnabled()) return { allowed: true };

    const normalizedRecipient = recipientEmail.trim().toLowerCase();
    if (host.pool) {
      const result = await host.pool.query<{ hour_count: string; day_count: string; recipient_count: string; company_hour_count: string; company_day_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour' AND email_account_id = $3)::text AS hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND email_account_id = $3)::text AS day_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND recipient_email = $4)::text AS recipient_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour')::text AS company_hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day')::text AS company_day_count
         FROM company_email_send_events
         WHERE workspace_id = $1 AND company_id = $2`,
        [account.workspaceId, companyId, account.id, normalizedRecipient]
      );
      const sentLastHour = Number(result.rows[0]?.hour_count || 0);
      const sentLastDay = Number(result.rows[0]?.day_count || 0);
      const sentToRecipient = Number(result.rows[0]?.recipient_count || 0);
      const companyLastHour = Number(result.rows[0]?.company_hour_count || 0);
      const companyLastDay = Number(result.rows[0]?.company_day_count || 0);
      if (companyLastHour >= (account.rateLimits.maxCompanyPerHour || 500)) {
        return { allowed: false, reason: `Company hourly email limit reached (${companyLastHour}/${account.rateLimits.maxCompanyPerHour || 500}). Increase "Company / hour" in Settings > Email > Email Accounts > Limits, or try again later.` };
      }
      if (companyLastDay >= (account.rateLimits.maxCompanyPerDay || 5000)) {
        return { allowed: false, reason: `Company daily email limit reached (${companyLastDay}/${account.rateLimits.maxCompanyPerDay || 5000}). Increase "Company / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.` };
      }
      if (sentLastHour >= (account.rateLimits.maxPerHour || 50)) {
        return { allowed: false, reason: `Hourly email-account limit reached (${sentLastHour}/${account.rateLimits.maxPerHour}). Increase "Per hour" in Settings > Email > Email Accounts > Limits, or try again later.` };
      }
      if (sentLastDay >= (account.rateLimits.maxPerDay || 500)) {
        return { allowed: false, reason: `Daily email-account limit reached (${sentLastDay}/${account.rateLimits.maxPerDay}). Increase "Per day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.` };
      }
      if (sentToRecipient >= (account.rateLimits.maxPerRecipientDaily || 100)) {
        return {
          allowed: false,
          reason: `Daily recipient limit reached for ${recipientEmail} (${sentToRecipient}/${account.rateLimits.maxPerRecipientDaily || 100}). Increase "Per recipient / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.`,
        };
      }
      return { allowed: true };
    }

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const oneDayAgo = now - 86400_000;

    const accountKey = `${companyId}:${account.id}`;
    const companyKey = `${companyId}:company`;
    const recipientKey = `${companyId}:recipient:${recipientEmail.trim().toLowerCase()}`;
    const companySent = (host.sentTimestamps.get(companyKey) || []).filter((t) => t > oneDayAgo);
    host.sentTimestamps.set(companyKey, companySent);
    const companyLastHour = companySent.filter((t) => t > oneHourAgo).length;
    if (companyLastHour >= (account.rateLimits.maxCompanyPerHour || 500)) {
      return { allowed: false, reason: `Company hourly email limit reached (${companyLastHour}/${account.rateLimits.maxCompanyPerHour || 500}). Increase "Company / hour" in Settings > Email > Email Accounts > Limits, or try again later.` };
    }
    if (companySent.length >= (account.rateLimits.maxCompanyPerDay || 5000)) {
      return { allowed: false, reason: `Company daily email limit reached (${companySent.length}/${account.rateLimits.maxCompanyPerDay || 5000}). Increase "Company / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.` };
    }

    const accountSent = (host.sentTimestamps.get(accountKey) || []).filter((t) => t > oneDayAgo);
    host.sentTimestamps.set(accountKey, accountSent);

    const sentLastHour = accountSent.filter((t) => t > oneHourAgo).length;
    if (sentLastHour >= (account.rateLimits.maxPerHour || 50)) {
      return { allowed: false, reason: `Hourly email-account limit reached (${sentLastHour}/${account.rateLimits.maxPerHour}). Increase "Per hour" in Settings > Email > Email Accounts > Limits, or try again later.` };
    }

    if (accountSent.length >= (account.rateLimits.maxPerDay || 500)) {
      return { allowed: false, reason: `Daily email-account limit reached (${accountSent.length}/${account.rateLimits.maxPerDay}). Increase "Per day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.` };
    }

    const recipientSent = (host.sentTimestamps.get(recipientKey) || []).filter((t) => t > oneDayAgo);
    host.sentTimestamps.set(recipientKey, recipientSent);

    if (recipientSent.length >= (account.rateLimits.maxPerRecipientDaily || 100)) {
      return {
        allowed: false,
        reason: `Daily recipient limit reached for ${recipientEmail} (${recipientSent.length}/${account.rateLimits.maxPerRecipientDaily || 100}). Increase "Per recipient / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.`,
      };
    }

    return { allowed: true };
  }

export async function recordSentEmail(host: EmailInboxJobsHost, companyId: string, accountId: string, recipientEmail: string): Promise<void> {

    if (host.pool) {
      await host.pool.query(
        `INSERT INTO company_email_send_events (
           id, workspace_id, company_id, email_account_id, recipient_email, sent_at
         )
         SELECT $1, workspace_id, company_id, id, $3, now()
         FROM company_email_accounts
         WHERE id = $2 AND company_id = $4 AND deleted_at IS NULL`,
        [randomUUID(), accountId, recipientEmail.trim().toLowerCase(), companyId]
      );
      return;
    }

    const now = Date.now();
    const accountKey = `${companyId}:${accountId}`;
    const companyKey = `${companyId}:company`;
    const recipientKey = `${companyId}:recipient:${recipientEmail.trim().toLowerCase()}`;

    const companyEvents = host.sentTimestamps.get(companyKey) || [];
    companyEvents.push(now);
    host.sentTimestamps.set(companyKey, companyEvents);

    const acc = host.sentTimestamps.get(accountKey) || [];
    acc.push(now);
    host.sentTimestamps.set(accountKey, acc);

    const rec = host.sentTimestamps.get(recipientKey) || [];
    rec.push(now);
    host.sentTimestamps.set(recipientKey, rec);
  }

export async function reserveSendQuota(host: EmailInboxJobsHost, 
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {

    if (!usageQuotasEnabled()) return { allowed: true };

    if (!host.pool) {
      const result = await checkRateLimit(host, companyId, account, recipientEmail);
      if (result.allowed) await recordSentEmail(host, companyId, account.id, recipientEmail);
      return result;
    }

    const client = await host.pool.connect();
    const recipient = recipientEmail.trim().toLowerCase();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `email-rate:${account.workspaceId}:${companyId}`,
      ]);
      const counts = await client.query<{ hour_count: string; day_count: string; recipient_count: string; company_hour_count: string; company_day_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour' AND email_account_id = $3)::text AS hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND email_account_id = $3)::text AS day_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND recipient_email = $4)::text AS recipient_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour')::text AS company_hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day')::text AS company_day_count
         FROM company_email_send_events
         WHERE workspace_id = $1 AND company_id = $2`,
        [account.workspaceId, companyId, account.id, recipient]
      );
      const hourCount = Number(counts.rows[0]?.hour_count || 0);
      const dayCount = Number(counts.rows[0]?.day_count || 0);
      const recipientCount = Number(counts.rows[0]?.recipient_count || 0);
      const companyHourCount = Number(counts.rows[0]?.company_hour_count || 0);
      const companyDayCount = Number(counts.rows[0]?.company_day_count || 0);
      let deniedReason: string | undefined;
      if (companyHourCount >= (account.rateLimits.maxCompanyPerHour || 500)) {
        deniedReason = `Company hourly email limit reached (${companyHourCount}/${account.rateLimits.maxCompanyPerHour || 500}). Increase "Company / hour" in Settings > Email > Email Accounts > Limits, or try again later.`;
      } else if (companyDayCount >= (account.rateLimits.maxCompanyPerDay || 5000)) {
        deniedReason = `Company daily email limit reached (${companyDayCount}/${account.rateLimits.maxCompanyPerDay || 5000}). Increase "Company / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.`;
      } else if (hourCount >= (account.rateLimits.maxPerHour || 50)) {
        deniedReason = `Hourly email-account limit reached (${hourCount}/${account.rateLimits.maxPerHour}). Increase "Per hour" in Settings > Email > Email Accounts > Limits, or try again later.`;
      } else if (dayCount >= (account.rateLimits.maxPerDay || 500)) {
        deniedReason = `Daily email-account limit reached (${dayCount}/${account.rateLimits.maxPerDay}). Increase "Per day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.`;
      } else if (recipientCount >= (account.rateLimits.maxPerRecipientDaily || 100)) {
        deniedReason = `Daily recipient limit reached for ${recipientEmail} (${recipientCount}/${account.rateLimits.maxPerRecipientDaily || 100}). Increase "Per recipient / day" in Settings > Email > Email Accounts > Limits, or try again tomorrow.`;
      }
      if (deniedReason) {
        await client.query("COMMIT");
        return { allowed: false, reason: deniedReason };
      }

      await client.query(
        `INSERT INTO company_email_send_events
          (id, workspace_id, company_id, email_account_id, recipient_email, sent_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [randomUUID(), account.workspaceId, companyId, account.id, recipient]
      );
      await client.query("COMMIT");
      return { allowed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function enqueueJob(host: EmailInboxJobsHost, 
    ctx: AuthContext,
    companyId: string,
    input: {
      jobType: CompanyEmailJob["jobType"];
      emailAccountId?: string | null;
      threadId?: string | null;
      messageId?: string | null;
      payload?: Record<string, unknown>;
      runAfter?: string;
      maxAttempts?: number;
      idempotencyKey?: string | null;
    }
  ): Promise<CompanyEmailJob> {

    const now = new Date().toISOString();
    const job: CompanyEmailJob = {
      id: randomUUID(), workspaceId: ctx.workspaceId, companyId,
      emailAccountId: input.emailAccountId || null, threadId: input.threadId || null,
      messageId: input.messageId || null, jobType: input.jobType, status: "queued",
      payload: input.payload || {}, attemptCount: 0, maxAttempts: input.maxAttempts ?? 5,
      runAfter: input.runAfter || now, lockedAt: null, lockedBy: null, lastError: null,
      idempotencyKey: input.idempotencyKey || null, createdAt: now, updatedAt: now,
    };
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailJob>(
        `INSERT INTO company_email_jobs (
           id, workspace_id, company_id, email_account_id, thread_id, message_id,
           job_type, status, payload, attempt_count, max_attempts, run_after,
           idempotency_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,0,$9,$10,$11,$12,$12)
         ON CONFLICT (workspace_id, company_id, idempotency_key) DO UPDATE
           SET updated_at = company_email_jobs.updated_at
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
           email_account_id AS "emailAccountId", thread_id AS "threadId", message_id AS "messageId",
           job_type AS "jobType", status, payload, attempt_count AS "attemptCount",
           max_attempts AS "maxAttempts", run_after AS "runAfter", locked_at AS "lockedAt",
           locked_by AS "lockedBy", last_error AS "lastError", idempotency_key AS "idempotencyKey",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [job.id, job.workspaceId, job.companyId, job.emailAccountId, job.threadId, job.messageId,
        job.jobType, JSON.stringify(job.payload), job.maxAttempts, job.runAfter,
        job.idempotencyKey, now]
      );
      return result.rows[0]!;
    }
    if (job.idempotencyKey) {
      const existing = Array.from(host.memoryJobs.values()).find((item) =>
        item.workspaceId === ctx.workspaceId && item.companyId === companyId && item.idempotencyKey === job.idempotencyKey);
      if (existing) return existing;
    }
    host.memoryJobs.set(job.id, job);
    return job;
  }

export async function claimJobs(host: EmailInboxJobsHost, workerId: string, limit = 10): Promise<CompanyEmailJob[]> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailJob>(
        `WITH candidates AS (
           SELECT id FROM company_email_jobs
           WHERE ((status = 'queued' AND run_after <= now())
              OR (status = 'processing' AND locked_at < now() - interval '5 minutes'))
           ORDER BY run_after ASC, created_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE company_email_jobs j SET status='processing', locked_at=now(), locked_by=$1,
           attempt_count=j.attempt_count+1, updated_at=now()
         FROM candidates c WHERE j.id=c.id
         RETURNING j.id, j.workspace_id AS "workspaceId", j.company_id AS "companyId",
           j.email_account_id AS "emailAccountId", j.thread_id AS "threadId", j.message_id AS "messageId",
           j.job_type AS "jobType", j.status, j.payload, j.attempt_count AS "attemptCount",
           j.max_attempts AS "maxAttempts", j.run_after AS "runAfter", j.locked_at AS "lockedAt",
           j.locked_by AS "lockedBy", j.last_error AS "lastError", j.idempotency_key AS "idempotencyKey",
           j.created_at AS "createdAt", j.updated_at AS "updatedAt"`,
        [workerId, Math.max(1, Math.min(limit, 100))]
      );
      return result.rows;
    }
    const now = Date.now();
    const jobs = Array.from(host.memoryJobs.values())
      .filter((job) => job.status === "queued" && new Date(job.runAfter).getTime() <= now)
      .sort((a, b) => new Date(a.runAfter).getTime() - new Date(b.runAfter).getTime())
      .slice(0, limit);
    return jobs.map((job) => {
      const claimed = {
        ...job, status: "processing" as const, lockedAt: new Date().toISOString(), lockedBy: workerId,
        attemptCount: job.attemptCount + 1, updatedAt: new Date().toISOString()
      };
      host.memoryJobs.set(job.id, claimed);
      return claimed;
    });
  }

export async function completeJob(host: EmailInboxJobsHost, jobId: string): Promise<void> {

    if (host.pool) {
      await host.pool.query("UPDATE company_email_jobs SET status='completed', locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$1", [jobId]);
      return;
    }
    const job = host.memoryJobs.get(jobId);
    if (job) host.memoryJobs.set(jobId, { ...job, status: "completed", lockedAt: null, lockedBy: null, updatedAt: new Date().toISOString() });
  }

export async function failJob(host: EmailInboxJobsHost, job: CompanyEmailJob, error: unknown): Promise<void> {

    const message = error instanceof Error ? error.message : String(error);
    const terminal = job.attemptCount >= job.maxAttempts;
    const delaySeconds = Math.min(300, 2 ** Math.max(0, job.attemptCount - 1));
    if (host.pool) {
      await host.pool.query(
        `UPDATE company_email_jobs SET status=$2, last_error=$3, locked_at=NULL, locked_by=NULL,
           run_after=CASE WHEN $2='queued' THEN now() + ($4 * interval '1 second') ELSE run_after END,
           updated_at=now() WHERE id=$1`,
        [job.id, terminal ? "failed" : "queued", message.slice(0, 2000), delaySeconds]
      );
      return;
    }
    host.memoryJobs.set(job.id, {
      ...job, status: terminal ? "failed" : "queued",
      lastError: message.slice(0, 2000), lockedAt: null, lockedBy: null,
      runAfter: new Date(Date.now() + delaySeconds * 1000).toISOString(), updatedAt: new Date().toISOString()
    });
  }

export async function cancelPendingFollowups(host: EmailInboxJobsHost, threadId: string): Promise<void> {

    if (host.pool) {
      await host.pool.query(
        "UPDATE company_email_jobs SET status='cancelled', updated_at=now() WHERE thread_id=$1 AND job_type='followup' AND status IN ('queued','processing')",
        [threadId]
      );
      return;
    }
    for (const [id, job] of host.memoryJobs) {
      if (job.threadId === threadId && job.jobType === "followup" && (job.status === "queued" || job.status === "processing")) {
        host.memoryJobs.set(id, { ...job, status: "cancelled", updatedAt: new Date().toISOString() });
      }
    }
  }

export async function createNotification(host: EmailInboxJobsHost, ctx: AuthContext, companyId: string, input: {
    userId?: string | null; threadId?: string | null;
    notificationType: CompanyEmailNotification["notificationType"]; title: string; body: string;
  }): Promise<CompanyEmailNotification> {

    const notification: CompanyEmailNotification = {
      id: randomUUID(), workspaceId: ctx.workspaceId, companyId, userId: input.userId || null,
      threadId: input.threadId || null, notificationType: input.notificationType,
      title: input.title.trim().slice(0, 300), body: input.body.trim().slice(0, 4000),
      isRead: false, createdAt: new Date().toISOString(),
    };
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailNotification>(
        `INSERT INTO company_email_notifications
          (id, workspace_id, company_id, user_id, thread_id, notification_type, title, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
           thread_id AS "threadId", notification_type AS "notificationType", title, body,
           is_read AS "isRead", created_at AS "createdAt"`,
        [notification.id, notification.workspaceId, companyId, notification.userId, notification.threadId,
        notification.notificationType, notification.title, notification.body]
      );
      return result.rows[0]!;
    }
    host.memoryNotifications.set(notification.id, notification);
    return notification;
  }

export async function listNotifications(host: EmailInboxJobsHost, ctx: AuthContext, companyId: string | string[], limit = 50): Promise<CompanyEmailNotification[]> {
    const companyIds = typeof companyId === "string" ? [companyId] : companyId;
    if (!companyIds.length) return [];

    if (host.pool) {
      return (await host.pool.query<CompanyEmailNotification>(
        `SELECT latest.* FROM unnest($2::text[]) AS scope(id) CROSS JOIN LATERAL (
           SELECT notifications.id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
             thread_id AS "threadId", notification_type AS "notificationType", title, body,
             is_read AS "isRead", created_at AS "createdAt"
           FROM company_email_notifications AS notifications
           WHERE workspace_id=$1 AND company_id=scope.id AND (user_id IS NULL OR user_id=$3)
           ORDER BY created_at DESC, notifications.id LIMIT $4
         ) AS latest`,
        [ctx.workspaceId, companyIds, ctx.userId, Math.max(1, Math.min(limit, 100))]
      )).rows;
    }

    const notifications = Array.from(host.memoryNotifications.values()).filter(item => item.workspaceId === ctx.workspaceId
      && companyIds.includes(item.companyId) && (!item.userId || item.userId === ctx.userId));
    return companyIds.flatMap(id => notifications.filter(item => item.companyId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

export async function markNotificationRead(host: EmailInboxJobsHost, ctx: AuthContext, companyId: string, notificationId: string): Promise<void> {

    if (host.pool) {
      await host.pool.query(
        `UPDATE company_email_notifications SET is_read=true
         WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND (user_id IS NULL OR user_id=$4)`,
        [notificationId, ctx.workspaceId, companyId, ctx.userId]
      );
      return;
    }
    const item = host.memoryNotifications.get(notificationId);
    if (item && item.workspaceId === ctx.workspaceId && item.companyId === companyId && (!item.userId || item.userId === ctx.userId)) {
      host.memoryNotifications.set(notificationId, { ...item, isRead: true });
    }
  }

  // =========================================================================
  // 9. Analytics (Item 23)
  // =========================================================================

