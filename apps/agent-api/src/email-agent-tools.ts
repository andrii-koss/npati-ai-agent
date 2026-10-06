import type { AuthContext, Company } from "@npati/workspace";
import type { EmailInboxRepository } from "./email-inbox-repository";
import { assertOutboundAllowed } from "./outbound-exfiltration-guard";

export interface LinkSecurityCheckResult {
  url: string;
  isSafe: boolean;
  domain: string;
  threatLevel: "safe" | "suspicious" | "dangerous";
  warnings: string[];
  requiresHumanApproval: boolean;
  redirectDomains?: string[];
}

export class EmailAgentTools {
  constructor(private readonly repo: EmailInboxRepository) {}

  /**
   * 1. Send Email Tool
   */
  async sendEmail(
    context: AuthContext,
    company: Company,
    input: {
      to: string;
      subject: string;
      body: string;
      fromEmail?: string;
      cc?: string[];
      replyTo?: string;
      taskRunId?: string;
    }
  ) {
    if (!input.to || !input.subject || !input.body) {
      throw new Error("to, subject, and body are required to send email");
    }

    // C5b: email leaves NPATI for a human inbox, so a secret here is a refusal (never a redaction) and
    // private repository code is an approval-class event. This runs before any quota or account lookup so
    // a refused message cannot consume quota or thread state.
    assertOutboundAllowed({
      channel: "email",
      parts: [
        { kind: "metadata", value: input.to, label: "to" },
        { kind: "metadata", value: input.cc?.join(", ") ?? "", label: "cc" },
        { kind: "text", value: input.subject, label: "subject" },
        { kind: "text", value: input.body, label: "body" },
      ],
      // C5b: the tenant is known here, so the policy is resolved for this company rather than for whatever
      // context the process-wide snapshot happens to hold.
      context: { companyId: company.id },
    });

    const accounts = await this.repo.listAccounts(context, company.id);
    const account = input.fromEmail
      ? accounts.find((a) => a.emailAddress.toLowerCase() === input.fromEmail?.toLowerCase())
      : accounts[0];

    if (!account) {
      throw new Error(`No corporate email account configured for company "${company.name}"`);
    }

    // Rate limit check
    const rateLimit = await this.repo.reserveSendQuota(company.id, account, input.to);
    if (!rateLimit.allowed) {
      throw new Error(`Rate limit exceeded: ${rateLimit.reason}`);
    }

    // Find or create thread
    let thread = (await this.repo.listThreads(context, company.id, { limit: 10 })).find(
      (t) => t.customerEmail.toLowerCase() === input.to.trim().toLowerCase()
    );

    if (!thread) {
      thread = await this.repo.createThread(context, company.id, {
        emailAccountId: account.id,
        subject: input.subject,
        customerEmail: input.to,
        status: "answered",
        folder: "sent",
      });
    }

    if (input.taskRunId) {
      thread = await this.repo.updateThread(context, company.id, thread.id, {
        metadata: {
          ...thread.metadata,
          awaitingAgentRunId: input.taskRunId,
          awaitingAgentReplySince: new Date().toISOString(),
        },
      });
    }

    const message = await this.repo.createMessage(context, company.id, {
      threadId: thread.id,
      emailAccountId: account.id,
      direction: "outbound",
      fromAddress: account.emailAddress,
      toAddresses: [input.to],
      ccAddresses: input.cc || [],
      subject: input.subject,
      bodyText: input.body,
      isDraft: false,
      isAiGenerated: true,
      deliveryStatus: account.testMode ? "delivered" : "sending",
    });

    if (!account.testMode) {
      await this.repo.enqueueJob(context, company.id, {
        jobType: "send", emailAccountId: account.id, threadId: thread.id,
        messageId: message.id, idempotencyKey: `send:${message.id}`,
      });
    }

    return {
      success: true,
      messageId: message.id,
      from: account.emailAddress,
      to: input.to,
      subject: input.subject,
      testMode: account.testMode,
      status: account.testMode ? "simulated_send" : "queued",
      awaitingReplyForTaskRunId: input.taskRunId || null,
    };
  }

  /**
   * 2. Read / Search Email Tool (e.g. search for verification email)
   */
  async readEmail(
    context: AuthContext,
    company: Company,
    input: {
      query?: string;
      sender?: string;
      limit?: number;
      unreadOnly?: boolean;
    }
  ) {
    const threads = await this.repo.listThreads(context, company.id, {
      search: input.query,
      limit: input.limit || 10,
    });

    const results = [];
    for (const thread of threads) {
      if (input.sender && !thread.customerEmail.toLowerCase().includes(input.sender.toLowerCase())) {
        continue;
      }
      const messages = await this.repo.listMessages(context, company.id, thread.id);
      results.push({
        threadId: thread.id,
        subject: thread.subject,
        customerEmail: thread.customerEmail,
        customerName: thread.customerName,
        status: thread.status,
        priority: thread.priority,
        lastMessageAt: thread.lastMessageAt,
        messages: messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          from: m.fromAddress,
          subject: m.subject,
          snippet: m.bodyText.slice(0, 300),
          createdAt: m.createdAt,
        })),
      });
    }

    return {
      count: results.length,
      threads: results,
    };
  }

  /**
   * 3. Extract Verification Code / OTP / Link from email text
   */
  extractVerification(bodyText: string) {
    // 6-8 digit numeric code
    const numericCodeMatch =
      bodyText.match(/(?:code|otp|код|пароль|pin|verification)\s*(?:is|є|це|:)?\s*([0-9]{4,8})\b/i) ||
      bodyText.match(/\b([0-9]{6})\b/);
    const code = numericCodeMatch ? numericCodeMatch[1] : null;

    // Alphanumeric security token
    const tokenMatch = bodyText.match(/(?:token|key|токен)\s*(?:is|:)?\s*([A-Za-z0-9_-]{12,64})/i);
    const token = tokenMatch ? tokenMatch[1] : null;

    // Verification or confirmation links
    const linkMatches = bodyText.match(/https?:\/\/[^\s<>"')]+/gi) || [];
    const verificationLinks = linkMatches.filter((url) =>
      /(?:verify|confirm|activate|validation|підтверд|активув|token=|code=)/i.test(url)
    );

    return {
      verificationCode: code,
      token,
      verificationLinks,
      allLinks: linkMatches,
    };
  }

  /**
   * 4. Security Inspector for Links & Verification (Item 19)
   */
  inspectLinkSecurity(rawUrl: string, senderEmail?: string, senderBlacklisted = false): LinkSecurityCheckResult {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return {
        url: rawUrl,
        isSafe: false,
        domain: "invalid",
        threatLevel: "dangerous",
        warnings: ["Malformed or invalid URL string."],
        requiresHumanApproval: true,
      };
    }

    const domain = parsedUrl.hostname.toLowerCase();
    const warnings: string[] = [];
    let threatLevel: "safe" | "suspicious" | "dangerous" = "safe";

    if (senderBlacklisted) {
      warnings.push("The email sender is on the company blacklist.");
      threatLevel = "dangerous";
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      warnings.push(`Unsupported URL protocol: ${parsedUrl.protocol}`);
      threatLevel = "dangerous";
    }

    // Suspicious TLDs or IP hosts
    const isPrivateHost = domain === "localhost" || domain === "0.0.0.0" || domain === "127.0.0.1"
      || /^10\./.test(domain) || /^192\.168\./.test(domain)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(domain) || domain === "::1";
    if (isPrivateHost) {
      warnings.push("Link targets a local or private network address.");
      threatLevel = "dangerous";
    } else if (/^[0-9.]+$/.test(domain) || domain.endsWith(".xyz") || domain.endsWith(".top") || domain.endsWith(".click")) {
      warnings.push("Domain uses suspicious TLD or raw IP address.");
      threatLevel = "suspicious";
    }

    // Suspicious keywords in pathname
    if (/(login|signin|credential|wallet|account-recovery)/i.test(parsedUrl.pathname)) {
      warnings.push("Link leads to sensitive login or authentication form.");
      if (threatLevel === "safe") threatLevel = "suspicious";
    }

    // Check sender domain vs link domain mismatch
    if (senderEmail && senderEmail.includes("@")) {
      const senderDomain = senderEmail.split("@")[1]?.toLowerCase();
      if (senderDomain && !domain.endsWith(senderDomain) && !senderDomain.endsWith(domain)) {
        warnings.push(`Link domain (${domain}) differs from email sender domain (${senderDomain}).`);
        if (threatLevel === "safe") threatLevel = "suspicious";
      }
    }

    const redirectDomains: string[] = [];
    for (const key of ["url", "redirect", "redirect_url", "redirect_uri", "continue", "next", "return", "return_to"]) {
      const target = parsedUrl.searchParams.get(key);
      if (!target) continue;
      try {
        const redirect = new URL(target, parsedUrl);
        const redirectDomain = redirect.hostname.toLowerCase();
        if (!redirectDomains.includes(redirectDomain)) redirectDomains.push(redirectDomain);
        if (redirect.protocol !== "https:" || (redirectDomain !== domain && !redirectDomain.endsWith(`.${domain}`))) {
          warnings.push(`Redirect parameter leads to a different or insecure domain (${redirectDomain || redirect.protocol}).`);
          if (threatLevel === "safe") threatLevel = "suspicious";
        }
      } catch {
        warnings.push(`Redirect parameter "${key}" is malformed.`);
        if (threatLevel === "safe") threatLevel = "suspicious";
      }
    }

    const requiresHumanApproval = threatLevel !== "safe";
    return {
      url: rawUrl,
      isSafe: threatLevel === "safe",
      domain,
      threatLevel,
      warnings,
      requiresHumanApproval,
      redirectDomains,
    };
  }
}
