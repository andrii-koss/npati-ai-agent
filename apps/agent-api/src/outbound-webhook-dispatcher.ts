import { randomUUID, createHmac } from "node:crypto";
import type { Pool } from "pg";

export interface WebhookSubscription {
  id: string;
  companyId: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDispatchResult {
  subscriptionId: string;
  url: string;
  event: string;
  statusCode?: number;
  delivered: boolean;
  signature: string;
  durationMs: number;
  error?: string;
}

export class OutboundWebhookDispatcher {
  private readonly inMemorySubs = new Map<string, WebhookSubscription>();

  constructor(private readonly pool?: Pool) {}

  /**
   * Register a new outbound webhook subscription
   */
  async registerSubscription(params: {
    companyId: string;
    url: string;
    secret: string;
    events?: string[];
  }): Promise<WebhookSubscription> {
    const id = `whsub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const sub: WebhookSubscription = {
      id,
      companyId: params.companyId,
      url: params.url,
      secret: params.secret,
      events: params.events && params.events.length > 0 ? params.events : ["*"],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_webhook_subscriptions (id, company_id, url, secret, events, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sub.id, sub.companyId, sub.url, sub.secret, sub.events, sub.isActive, sub.createdAt, sub.updatedAt]
      );
      return sub;
    }

    this.inMemorySubs.set(id, sub);
    return sub;
  }

  /**
   * Dispatch an outbound event to all matching active company subscriptions
   */
  async dispatchEvent(
    companyId: string,
    event: string,
    data: Record<string, unknown>,
    mockSender?: (url: string, payload: string, headers: Record<string, string>) => Promise<number>
  ): Promise<WebhookDispatchResult[]> {
    let activeSubs: WebhookSubscription[] = [];

    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, company_id AS "companyId", url, secret, events, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_webhook_subscriptions
         WHERE company_id = $1 AND is_active = true`,
        [companyId]
      );
      activeSubs = res.rows;
    } else {
      activeSubs = Array.from(this.inMemorySubs.values()).filter(
        (s) => s.companyId === companyId && s.isActive
      );
    }

    const matching = activeSubs.filter(
      (s) => s.events.includes("*") || s.events.includes(event)
    );

    const payloadString = JSON.stringify({
      id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      event,
      companyId,
      timestamp: new Date().toISOString(),
      data,
    });

    const results: WebhookDispatchResult[] = [];

    for (const sub of matching) {
      const start = Date.now();
      const signature = createHmac("sha256", sub.secret).update(payloadString).digest("hex");

      try {
        let statusCode = 200;
        if (mockSender) {
          statusCode = await mockSender(sub.url, payloadString, {
            "Content-Type": "application/json",
            "X-NPATI-Signature": `sha256=${signature}`,
            "X-NPATI-Event": event,
          });
        }

        results.push({
          subscriptionId: sub.id,
          url: sub.url,
          event,
          statusCode,
          delivered: statusCode >= 200 && statusCode < 300,
          signature,
          durationMs: Date.now() - start,
        });
      } catch (err: any) {
        results.push({
          subscriptionId: sub.id,
          url: sub.url,
          event,
          delivered: false,
          signature,
          durationMs: Date.now() - start,
          error: err.message,
        });
      }
    }

    return results;
  }
}
