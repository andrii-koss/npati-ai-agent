import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext, CryptoVault } from "@npati/workspace";
import type { CompanyEmailAccount, CompanyEmailThread } from "./email-inbox-types";

export interface EmailInboxAccountHost {
  pool?: Pool
  vault: CryptoVault
  memoryAccounts: Map<string, CompanyEmailAccount>
  memoryOAuthStates: Map<string, { workspaceId: string; companyId: string; accountId: string; userId: string; verifier: string; tokenUrl: string; clientId: string; clientSecret?: string; redirectUri: string; expiresAt: string }>
  inboundLocks: Map<string, Promise<void>>
  accountCols: string
  getThread: (ctx: AuthContext, companyId: string, threadId: string) => Promise<CompanyEmailThread | null>
}

export async function close(host: EmailInboxAccountHost): Promise<void> {
    if (host.pool) {
      await host.pool.end().catch(() => undefined);
    }
  }

export async function claimBrowserEmailWait(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, sender: string, emailAccountId?: string): Promise<{ browserJobId: string; runId: string; profileId: string; campaignTargetId?: string | null } | null> {
    if (!host.pool) return null;
    const normalizedSender = sender.trim().toLowerCase();
    const senderDomain = normalizedSender.split("@")[1] || normalizedSender;
    const result = await host.pool.query<{ browserJobId: string; runId: string; profileId: string; campaignTargetId?: string | null }>(`
      WITH candidate AS (
        SELECT w.id FROM company_browser_email_waits w
        LEFT JOIN company_browser_campaign_targets t ON t.id=w.campaign_target_id
        WHERE w.workspace_id=$1 AND w.company_id=$2 AND w.user_id=$3 AND w.status='waiting_email'
          AND (w.sender_hint IS NULL OR w.sender_hint='' OR w.sender_hint=$4 OR w.sender_hint=$5 OR $4 LIKE ('%@' || w.sender_hint))
          AND (w.campaign_target_id IS NULL OR t.email_account_id=$6)
        ORDER BY w.created_at DESC LIMIT 1 FOR UPDATE OF w SKIP LOCKED
      )
      UPDATE company_browser_email_waits w SET status='consumed',consumed_at=now()
      FROM candidate c WHERE w.id=c.id
      RETURNING w.browser_job_id AS "browserJobId",w.run_id::text AS "runId",w.profile_id AS "profileId",
        w.campaign_target_id::text AS "campaignTargetId"`,
      [ctx.workspaceId,companyId,ctx.userId,normalizedSender,senderDomain,emailAccountId || null]);
    return result.rows[0] ?? null;
  }

export function encryptAccountSecrets(host: EmailInboxAccountHost, account: CompanyEmailAccount): CompanyEmailAccount {
    const encrypt = (value?: string) => {
      if (!value || value.startsWith("v1$")) return value;
      return host.vault.encrypt(value);
    };
    return {
      ...account,
      imapConfig: {
        ...account.imapConfig, password: encrypt(account.imapConfig.password),
        accessToken: encrypt(account.imapConfig.accessToken), refreshToken: encrypt(account.imapConfig.refreshToken),
        clientSecret: encrypt(account.imapConfig.clientSecret)
      },
      smtpConfig: {
        ...account.smtpConfig, password: encrypt(account.smtpConfig.password),
        accessToken: encrypt(account.smtpConfig.accessToken), refreshToken: encrypt(account.smtpConfig.refreshToken),
        clientSecret: encrypt(account.smtpConfig.clientSecret)
      },
    };
  }

export function decryptAccountSecrets(host: EmailInboxAccountHost, account: CompanyEmailAccount): CompanyEmailAccount {
    const decrypt = (value?: string) => {
      if (!value || !value.startsWith("v1$")) return value;
      return host.vault.decrypt(value);
    };
    return {
      ...account,
      imapConfig: {
        ...account.imapConfig, password: decrypt(account.imapConfig.password),
        accessToken: decrypt(account.imapConfig.accessToken), refreshToken: decrypt(account.imapConfig.refreshToken),
        clientSecret: decrypt(account.imapConfig.clientSecret)
      },
      smtpConfig: {
        ...account.smtpConfig, password: decrypt(account.smtpConfig.password),
        accessToken: decrypt(account.smtpConfig.accessToken), refreshToken: decrypt(account.smtpConfig.refreshToken),
        clientSecret: decrypt(account.smtpConfig.clientSecret)
      },
    };
  }

export async function encryptLegacyAccountCredentials(host: EmailInboxAccountHost): Promise<number> {
    if (!host.pool) {
      let changed = 0;
      for (const [id, account] of host.memoryAccounts) {
        const protectedAccount = encryptAccountSecrets(host, account);
        if (JSON.stringify(protectedAccount) !== JSON.stringify(account)) {
          host.memoryAccounts.set(id, protectedAccount);
          changed++;
        }
      }
      return changed;
    }
    const result = await host.pool.query<CompanyEmailAccount>(
      `SELECT ${host.accountCols} FROM company_email_accounts WHERE deleted_at IS NULL`
    );
    let changed = 0;
    for (const account of result.rows) {
      const protectedAccount = encryptAccountSecrets(host, account);
      if (JSON.stringify(protectedAccount.imapConfig) === JSON.stringify(account.imapConfig)
        && JSON.stringify(protectedAccount.smtpConfig) === JSON.stringify(account.smtpConfig)) continue;
      await host.pool.query(
        "UPDATE company_email_accounts SET imap_config=$1, smtp_config=$2, updated_at=now() WHERE id=$3",
        [JSON.stringify(protectedAccount.imapConfig), JSON.stringify(protectedAccount.smtpConfig), account.id]
      );
      changed++;
    }
    return changed;
  }

export async function withInboundMessageLock<T>(host: EmailInboxAccountHost, workspaceId: string, companyId: string, externalMessageId: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${workspaceId}:${companyId}:${externalMessageId.trim()}`;
    if (host.pool) {
      const client = await host.pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
        return await operation();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
        client.release();
      }
    }

    const previous = host.inboundLocks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    host.inboundLocks.set(lockKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (host.inboundLocks.get(lockKey) === tail) host.inboundLocks.delete(lockKey);
    }
  }

export async function createOAuthState(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, accountId: string, input: {
    stateHash: string; verifier: string; tokenUrl: string; clientId: string; clientSecret?: string;
    redirectUri: string; expiresAt: string;
  }): Promise<void> {
    if (host.pool) {
      await host.pool.query("DELETE FROM company_email_oauth_states WHERE expires_at <= now()");
      await host.pool.query(
        `INSERT INTO company_email_oauth_states
          (state_hash, workspace_id, company_id, account_id, user_id, encrypted_verifier, token_url,
           client_id, encrypted_client_secret, redirect_uri, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.stateHash, ctx.workspaceId, companyId, accountId, ctx.userId, host.vault.encrypt(input.verifier),
        input.tokenUrl, input.clientId, input.clientSecret ? host.vault.encrypt(input.clientSecret) : null,
        input.redirectUri, input.expiresAt]
      );
      return;
    }
    host.memoryOAuthStates.set(input.stateHash, {
      workspaceId: ctx.workspaceId, companyId, accountId, userId: ctx.userId,
      verifier: input.verifier, tokenUrl: input.tokenUrl, clientId: input.clientId, clientSecret: input.clientSecret,
      redirectUri: input.redirectUri, expiresAt: input.expiresAt
    });
  }

export async function consumeOAuthState(host: EmailInboxAccountHost, stateHash: string): Promise<{
    workspaceId: string; companyId: string; accountId: string; userId: string; verifier: string;
    tokenUrl: string; clientId: string; clientSecret?: string; redirectUri: string;
  } | null> {
    if (host.pool) {
      const result = await host.pool.query<any>(
        `DELETE FROM company_email_oauth_states WHERE state_hash=$1 AND expires_at > now()
         RETURNING workspace_id AS "workspaceId", company_id AS "companyId", account_id AS "accountId",
           user_id AS "userId", encrypted_verifier AS "encryptedVerifier", token_url AS "tokenUrl",
           client_id AS "clientId", encrypted_client_secret AS "encryptedClientSecret", redirect_uri AS "redirectUri"`,
        [stateHash]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...row, verifier: host.vault.decrypt(row.encryptedVerifier),
        clientSecret: row.encryptedClientSecret ? host.vault.decrypt(row.encryptedClientSecret) : undefined
      };
    }
    const item = host.memoryOAuthStates.get(stateHash);
    host.memoryOAuthStates.delete(stateHash);
    if (!item || new Date(item.expiresAt).getTime() <= Date.now()) return null;
    const { expiresAt: _expiresAt, ...state } = item;
    return state;
  }

export async function listAccounts(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string): Promise<CompanyEmailAccount[]> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND company_id = $2 AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows.map((account) => decryptAccountSecrets(host, account));
    }

    return Array.from(host.memoryAccounts.values())
      .filter((a) => a.workspaceId === ctx.workspaceId && a.companyId === companyId)
      .map((account) => decryptAccountSecrets(host, account));
  }

export async function listUserAccounts(host: EmailInboxAccountHost, ctx: AuthContext): Promise<CompanyEmailAccount[]> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [ctx.workspaceId, ctx.userId]
      );
      return result.rows.map((account) => decryptAccountSecrets(host, account));
    }
    return [...host.memoryAccounts.values()]
      .filter((account) => account.workspaceId === ctx.workspaceId && account.userId === ctx.userId)
      .map((account) => decryptAccountSecrets(host, account));
  }

export async function getAccount(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, accountId: string): Promise<CompanyEmailAccount | null> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3 AND deleted_at IS NULL`,
        [ctx.workspaceId, companyId, accountId]
      );
      return result.rows[0] ? decryptAccountSecrets(host, result.rows[0]) : null;
    }

    const item = host.memoryAccounts.get(accountId);
    return item && item.workspaceId === ctx.workspaceId && item.companyId === companyId
      ? decryptAccountSecrets(host, item)
      : null;
  }

export async function getAccountInternal(host: EmailInboxAccountHost, accountId: string): Promise<CompanyEmailAccount | null> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts WHERE id = $1 AND deleted_at IS NULL`,
        [accountId]
      );
      return result.rows[0] ? decryptAccountSecrets(host, result.rows[0]) : null;
    }
    const account = host.memoryAccounts.get(accountId);
    return account ? decryptAccountSecrets(host, account) : null;

  }

export async function findAccountByEmail(host: EmailInboxAccountHost, companyId: string, emailAddress: string): Promise<CompanyEmailAccount | null> {
    const normalized = emailAddress.trim().toLowerCase();
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE company_id = $1 AND LOWER(email_address) = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [companyId, normalized]
      );
      return result.rows[0] ? decryptAccountSecrets(host, result.rows[0]) : null;
    }

    for (const a of host.memoryAccounts.values()) {
      if (a.companyId === companyId && a.emailAddress.toLowerCase() === normalized) {
        return decryptAccountSecrets(host, a);
      }
    }
    return null;
  }

export async function findUserAccountByEmail(host: EmailInboxAccountHost, ctx: AuthContext, emailAddress: string): Promise<CompanyEmailAccount | null> {
    const normalized = emailAddress.trim().toLowerCase();
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND user_id = $2 AND LOWER(email_address) = $3 AND deleted_at IS NULL
         LIMIT 1`,
        [ctx.workspaceId, ctx.userId, normalized]
      );
      return result.rows[0] ? decryptAccountSecrets(host, result.rows[0]) : null;
    }
    for (const account of host.memoryAccounts.values()) {
      if (account.workspaceId === ctx.workspaceId && account.userId === ctx.userId
        && account.emailAddress.toLowerCase() === normalized) return decryptAccountSecrets(host, account);
    }
    return null;
  }

export async function listAccountsForWorker(host: EmailInboxAccountHost): Promise<CompanyEmailAccount[]> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `SELECT ${host.accountCols} FROM company_email_accounts
         WHERE deleted_at IS NULL AND status <> 'disabled'
         ORDER BY created_at ASC`
      );
      return result.rows.map((account) => decryptAccountSecrets(host, account));
    }
    return Array.from(host.memoryAccounts.values())
      .filter((account) => account.status !== "disabled")
      .map((account) => decryptAccountSecrets(host, account));
  }

export async function createAccount(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, input: Partial<CompanyEmailAccount> & { emailAddress: string }): Promise<CompanyEmailAccount> {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const account: CompanyEmailAccount = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      emailAddress: input.emailAddress.trim().toLowerCase(),
      displayName: input.displayName || null,
      agentId: input.agentId || null,
      provider: input.provider || "imap_smtp",
      connectionScope: input.connectionScope || (input.agentId ? "agent" : companyId.startsWith("personal:") ? "account" : "company"),
      senderPolicy: input.senderPolicy || "allowlist",
      allowedSenders: [...new Set((input.allowedSenders || []).map((value) => value.trim().toLowerCase()).filter(Boolean))],
      allowedDomains: [...new Set((input.allowedDomains || []).map((value) => value.trim().toLowerCase().replace(/^\*?@/, "")).filter(Boolean))],
      requireAuthenticatedSender: input.requireAuthenticatedSender ?? true,
      outboundPolicy: input.outboundPolicy || "approval_required",
      mode: input.mode || "approval",
      status: input.status || "pending",
      testMode: input.testMode ?? false,
      confidenceThreshold: input.confidenceThreshold ?? 0.8,
      languageMode: input.languageMode || "auto",
      fallbackLanguage: input.fallbackLanguage || "en",
      imapConfig: input.imapConfig || {},
      smtpConfig: input.smtpConfig || {},
      rateLimits: input.rateLimits || {
        maxPerHour: 50,
        maxPerDay: 500,
        maxPerRecipientDaily: 100,
        maxFollowups: 3,
        maxCompanyPerHour: 500,
        maxCompanyPerDay: 5000,
      },
      signatureConfig: input.signatureConfig || {},
      followupConfig: input.followupConfig || {
        enabled: false,
        delayDays: 2,
        maxFollowups: 2,
        action: "draft",
      },
      createdAt: now,
      updatedAt: now,
    };

    const storedAccount = encryptAccountSecrets(host, account);
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `INSERT INTO company_email_accounts (
          id, workspace_id, company_id, user_id, email_address, display_name,
          agent_id, provider, connection_scope, sender_policy, allowed_senders,
          allowed_domains, require_authenticated_sender, outbound_policy,
          mode, status, test_mode, confidence_threshold, language_mode,
          fallback_language, imap_config, smtp_config, rate_limits,
          signature_config, followup_config, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
        ) RETURNING ${host.accountCols}`,
        [
          account.id,
          account.workspaceId,
          account.companyId,
          account.userId,
          account.emailAddress,
          account.displayName,
          account.agentId,
          account.provider,
          account.connectionScope,
          account.senderPolicy,
          account.allowedSenders,
          account.allowedDomains,
          account.requireAuthenticatedSender,
          account.outboundPolicy,
          account.mode,
          account.status,
          account.testMode,
          account.confidenceThreshold,
          account.languageMode,
          account.fallbackLanguage,
          JSON.stringify(storedAccount.imapConfig),
          JSON.stringify(storedAccount.smtpConfig),
          JSON.stringify(account.rateLimits),
          JSON.stringify(account.signatureConfig),
          JSON.stringify(account.followupConfig),
          account.createdAt,
          account.updatedAt,
        ]
      );
      return decryptAccountSecrets(host, result.rows[0]!);
    }

    host.memoryAccounts.set(id, storedAccount);
    return account;
  }

export async function updateAccount(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, accountId: string, patch: Partial<CompanyEmailAccount>): Promise<CompanyEmailAccount> {
    const existing = await getAccount(host, ctx, companyId, accountId);
    if (!existing) throw new Error("Email account not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailAccount = {
      ...existing,
      ...patch,
      imapConfig: { ...existing.imapConfig, ...(patch.imapConfig || {}) },
      smtpConfig: { ...existing.smtpConfig, ...(patch.smtpConfig || {}) },
      rateLimits: { ...existing.rateLimits, ...(patch.rateLimits || {}) },
      signatureConfig: { ...existing.signatureConfig, ...(patch.signatureConfig || {}) },
      followupConfig: { ...existing.followupConfig, ...(patch.followupConfig || {}) },
      updatedAt: now,
    };

    const storedAccount = encryptAccountSecrets(host, updated);
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailAccount>(
        `UPDATE company_email_accounts SET
          display_name = $1, agent_id = $2, provider = $3, connection_scope = $4,
          sender_policy = $5, allowed_senders = $6, allowed_domains = $7,
          require_authenticated_sender = $8, outbound_policy = $9,
          mode = $10, status = $11, test_mode = $12, confidence_threshold = $13,
          language_mode = $14, fallback_language = $15, imap_config = $16, smtp_config = $17,
          rate_limits = $18, signature_config = $19, followup_config = $20,
          updated_at = $21
        WHERE workspace_id = $22 AND company_id = $23 AND id = $24
        RETURNING ${host.accountCols}`,
        [
          updated.displayName,
          updated.agentId,
          updated.provider,
          updated.connectionScope,
          updated.senderPolicy,
          updated.allowedSenders,
          updated.allowedDomains,
          updated.requireAuthenticatedSender,
          updated.outboundPolicy,
          updated.mode,
          updated.status,
          updated.testMode,
          updated.confidenceThreshold,
          updated.languageMode,
          updated.fallbackLanguage,
          JSON.stringify(storedAccount.imapConfig),
          JSON.stringify(storedAccount.smtpConfig),
          JSON.stringify(updated.rateLimits),
          JSON.stringify(updated.signatureConfig),
          JSON.stringify(updated.followupConfig),
          now,
          ctx.workspaceId,
          companyId,
          accountId,
        ]
      );
      return decryptAccountSecrets(host, result.rows[0]!);
    }

    host.memoryAccounts.set(accountId, storedAccount);
    return updated;
  }

export async function deleteAccount(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, accountId: string): Promise<void> {
    if (host.pool) {
      await host.pool.query(
        `UPDATE company_email_accounts SET deleted_at = now()
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, accountId]
      );
      return;
    }

    host.memoryAccounts.delete(accountId);
  }

export async function isCollisionLocked(host: EmailInboxAccountHost, ctx: AuthContext, companyId: string, threadId: string): Promise<{ locked: boolean; reason?: string }> {
    const thread = await host.getThread(ctx, companyId, threadId);
    if (!thread) return { locked: false };

    if (thread.isHumanTakeover) {
      return { locked: true, reason: "Human takeover is currently active on this thread." };
    }

    if (thread.lockedByUserId && thread.lockedAt) {
      const lockAgeMs = Date.now() - new Date(thread.lockedAt).getTime();
      if (lockAgeMs < 300_000) {
        return { locked: true, reason: `Thread is locked by user (${Math.round(lockAgeMs / 1000)}s ago).` };
      }
    }

    return { locked: false };
  }

