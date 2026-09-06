import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface AllowlistRules {
  allowedSenders: string[];
  blockedSenders: string[];
  allowAnonymous?: boolean;
}

export interface ChannelPairingRecord {
  id: string;
  companyId: string;
  tenantId: string;
  channelType: string; // e.g. "telegram", "slack", "discord", "direct", "web"
  senderId?: string;
  pairingCode: string;
  pairedAgentId?: string;
  isApproved: boolean;
  allowlistRules: AllowlistRules;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class DmPairingManager {
  private readonly inMemoryPairings = new Map<string, ChannelPairingRecord>();

  constructor(private readonly pool?: Pool) {}

  /**
   * Generate a human-friendly pairing code (e.g. "PAIR-8492-AB")
   */
  generatePairingCode(): string {
    const digits = Math.floor(1000 + Math.random() * 9000);
    const alpha = randomBytes(2).toString("hex").toUpperCase();
    return `PAIR-${digits}-${alpha}`;
  }

  /**
   * Create a new pending pairing code for an agent on a channel
   */
  async createPairing(params: {
    companyId: string;
    tenantId: string;
    channelType: string;
    agentId?: string;
    allowlistRules?: AllowlistRules;
    expiresInMinutes?: number;
  }): Promise<ChannelPairingRecord> {
    const id = randomUUID();
    const pairingCode = this.generatePairingCode();
    const now = new Date();
    const expiresAt = params.expiresInMinutes
      ? new Date(now.getTime() + params.expiresInMinutes * 60 * 1000).toISOString()
      : new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1 hour default

    const record: ChannelPairingRecord = {
      id,
      companyId: params.companyId,
      tenantId: params.tenantId,
      channelType: params.channelType.toLowerCase(),
      pairingCode,
      pairedAgentId: params.agentId,
      isApproved: false,
      allowlistRules: params.allowlistRules ?? { allowedSenders: [], blockedSenders: [] },
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_channel_pairings (
          id, company_id, tenant_id, channel_type, pairing_code, paired_agent_id, is_approved, allowlist_rules, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          record.companyId,
          record.tenantId,
          record.channelType,
          record.pairingCode,
          record.pairedAgentId,
          record.isApproved,
          JSON.stringify(record.allowlistRules),
          record.expiresAt,
          record.createdAt,
          record.updatedAt,
        ]
      );
    } else {
      this.inMemoryPairings.set(pairingCode, record);
    }

    return record;
  }

  /**
   * Complete pairing by sender using the pairing code
   */
  async verifyAndPair(pairingCode: string, senderId: string): Promise<{ success: true; pairing: ChannelPairingRecord } | { success: false; error: string }> {
    let record: ChannelPairingRecord | null = null;

    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, company_id AS "companyId", tenant_id AS "tenantId", channel_type AS "channelType",
                sender_id AS "senderId", pairing_code AS "pairingCode", paired_agent_id AS "pairedAgentId",
                is_approved AS "isApproved", allowlist_rules AS "allowlistRules", expires_at AS "expiresAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_channel_pairings
         WHERE pairing_code = $1`,
        [pairingCode]
      );
      if (res.rows.length > 0) record = res.rows[0];
    } else {
      record = this.inMemoryPairings.get(pairingCode) || null;
    }

    if (!record) {
      return { success: false, error: "PAIRING_CODE_NOT_FOUND" };
    }

    if (record.isApproved) {
      return { success: false, error: "PAIRING_CODE_ALREADY_USED" };
    }

    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      return { success: false, error: "PAIRING_CODE_EXPIRED" };
    }

    record.senderId = senderId;
    record.isApproved = true;
    record.allowlistRules.allowedSenders.push(senderId);
    record.updatedAt = new Date().toISOString();

    if (this.pool) {
      await this.pool.query(
        `UPDATE company_channel_pairings
         SET sender_id = $1, is_approved = true, allowlist_rules = $2, updated_at = $3
         WHERE id = $4`,
        [senderId, JSON.stringify(record.allowlistRules), record.updatedAt, record.id]
      );
    }

    return { success: true, pairing: record };
  }

  /**
   * Check if an incoming direct message sender is authorized to talk to the agent
   */
  async isSenderAllowed(params: {
    companyId: string;
    tenantId: string;
    channelType: string;
    senderId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const { companyId, tenantId, channelType, senderId } = params;

    let rules: AllowlistRules[] = [];
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT allowlist_rules AS "allowlistRules", is_approved AS "isApproved"
         FROM company_channel_pairings
         WHERE company_id = $1 AND tenant_id = $2 AND channel_type = $3`,
        [companyId, tenantId, channelType.toLowerCase()]
      );
      rules = res.rows.map((r) => r.allowlistRules);
    } else {
      rules = Array.from(this.inMemoryPairings.values())
        .filter((p) => p.companyId === companyId && p.tenantId === tenantId && p.channelType === channelType.toLowerCase())
        .map((p) => p.allowlistRules);
    }

    // If no channel pairings/rules configured, allow default
    if (rules.length === 0) {
      return { allowed: true };
    }

    for (const rule of rules) {
      // Check blocklist first
      if (rule.blockedSenders?.includes(senderId) || rule.blockedSenders?.includes("*")) {
        return { allowed: false, reason: `Sender '${senderId}' is in the channel blocklist.` };
      }

      // Check allowlist
      if (rule.allowedSenders?.includes(senderId) || rule.allowedSenders?.includes("*") || rule.allowAnonymous) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Sender '${senderId}' is not paired or allowlisted for channel '${channelType}'.`,
    };
  }
}
