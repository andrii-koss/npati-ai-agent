import type { AuthContext } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import { ImapEmailTrigger } from "./automation-flow-engine";
import { CredentialMasker, PromptInjectionGuard } from "./security-guardrails";
import { detectCompanyChatLanguage } from "./company-chat-i18n";
import { extractDocumentText } from "./document-extractor";
import type { AuditRepository } from "./audit-repository";
import { normalizeEmailSubject, type EmailInboxRepository } from "./email-inbox-repository";
import type {
  CompanyEmailAccount,
  CompanyEmailMessage,
  EmailPriority,
} from "./email-inbox-types";
import {
  type EmailAutomationHooks,
  type InboundEmailPayload,
  type InboundProcessingResult,
  detectEmailIntent,
  evaluateEmailRoutingRules,
  evaluateInboundTrust,
} from "./email-ai-processor-types";
import { generateEmailDraftResponse } from "./email-ai-draft-generator";

export * from "./email-ai-processor-types";

export class EmailAIProcessor {
  private activeAiRequests = 0;
  private readonly aiWaiters: Array<() => void> = [];
  private readonly maxAiConcurrency = Math.max(1, Math.min(64, Number(process.env.EMAIL_AI_MAX_CONCURRENCY) || 8));

  constructor(
    private readonly repo: EmailInboxRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly aiEngine?: AIEngine,
    private readonly hooks: EmailAutomationHooks = {}
  ) { }

  private async withAiSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeAiRequests >= this.maxAiConcurrency) {
      await new Promise<void>((resolve) => this.aiWaiters.push(resolve));
    } else {
      this.activeAiRequests += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.aiWaiters.shift();
      if (next) {
        next();
      } else {
        this.activeAiRequests -= 1;
      }
    }
  }

  setGatewayHook(hook: NonNullable<EmailAutomationHooks["routeThroughGateway"]>): void {
    this.hooks.routeThroughGateway = hook;
  }

  /**
   * Process inbound email through AI Inbox pipeline
   */
  async processInbound(
    ctx: AuthContext,
    companyId: string,
    payload: InboundEmailPayload
  ): Promise<InboundProcessingResult> {
    const attachments = payload.attachments || [];
    const bodyBytes = Buffer.byteLength(payload.body || "", "utf8");
    const attachmentSizes = attachments.map((attachment) => Math.max(
      Number(attachment.sizeBytes || 0),
      attachment.contentBase64 ? Buffer.byteLength(attachment.contentBase64, "base64") : 0,
    ));
    const totalAttachmentBytes = attachmentSizes.reduce((sum, size) => sum + size, 0);
    if ((payload.subject || "").length > 998 || bodyBytes > 2 * 1024 * 1024) {
      throw Object.assign(new Error("Email subject or body exceeds safe processing limits"), { status: 413 });
    }
    if (attachments.length > 20
      || attachmentSizes.some((size) => size > 10 * 1024 * 1024)
      || totalAttachmentBytes > 25 * 1024 * 1024) {
      throw Object.assign(new Error("Email attachments exceed safe processing limits"), { status: 413 });
    }

    const externalMessageId = payload.messageId?.trim();
    if (!externalMessageId) return this.processInboundUnlocked(ctx, companyId, payload);
    return this.repo.withInboundMessageLock(ctx.workspaceId, companyId, externalMessageId, () =>
      this.processInboundUnlocked(ctx, companyId, payload)
    );
  }

  private async processInboundUnlocked(
    ctx: AuthContext,
    companyId: string,
    payload: InboundEmailPayload
  ): Promise<InboundProcessingResult> {
    const rawFrom = (payload.from || "").trim().toLowerCase();
    const rawSubject = (payload.subject || "No Subject").trim();
    const rawBody = (payload.body || "").trim();

    // 1. Sanitize text
    const cleanBody = CredentialMasker.mask(rawBody);
    const injectionAnalysis = PromptInjectionGuard.analyze(cleanBody);

    // 2. Parse email with existing ImapEmailTrigger (#136)
    const parsed = ImapEmailTrigger.parseEmail({
      from: rawFrom,
      to: payload.to || `support@${companyId}.company.com`,
      subject: rawSubject,
      body: cleanBody,
      attachments: (payload.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      })),
    });

    // 3. Find matching account
    const accounts = await this.repo.listAccounts(ctx, companyId);
    let account = accounts.find(
      (a) => a.emailAddress.toLowerCase() === parsed.to.toLowerCase()
    );
    if (!account && accounts.length > 0) {
      account = accounts[0];
    }

    // Threads and messages reference a real mailbox; a placeholder id failed in PostgreSQL ("default_account" is not a
    // uuid). Without a mailbox the request is refused explicitly.
    if (!account) {
      throw Object.assign(new Error("Connect a mailbox for this company before processing inbound email."), { status: 409, code: "EMAIL_ACCOUNT_REQUIRED" });
    }
    const effectiveAccount: CompanyEmailAccount = account;

    // IMAP retries and reconnects can deliver the same provider message more
    // than once. Treat a provider Message-ID as an idempotency key before any
    // contact, thread, AI, or outbound side effects are executed.
    const externalMessageId = payload.messageId?.trim();
    if (externalMessageId) {
      const existingMessage = await this.repo.findMessageByExternalId(ctx, companyId, externalMessageId);
      if (existingMessage) {
        const existingThread = await this.repo.getThread(ctx, companyId, existingMessage.threadId);
        if (existingThread) {
          return {
            thread: existingThread,
            inboundMessage: existingMessage,
            aiMessage: null,
            actionTaken: "duplicate_ignored",
            confidenceScore: existingThread.aiConfidenceScore ?? 0,
            priority: existingThread.priority,
            detectedLanguage: existingThread.detectedLanguage || effectiveAccount.fallbackLanguage,
          };
        }
      }
    }

    // 4. Contact & VIP / Blacklist Check (Items 10 & 20)
    let contact = await this.repo.getContact(ctx, companyId, parsed.from);
    if (!contact) {
      contact = await this.repo.upsertContact(ctx, companyId, {
        email: parsed.from,
        name: parsed.from.split("@")[0]?.replace(/[._]/g, " ") || "Customer",
      });
    }

    const isBlacklisted = contact.isBlacklisted || false;
    const isVip = contact.isVip || false;
    const customerHistory = (await this.repo.listThreads(ctx, companyId, { search: parsed.from, limit: 100 }))
      .filter((item) => item.customerEmail.toLowerCase() === parsed.from.toLowerCase());
    const hasRecentEscalation = customerHistory.some((item) =>
      item.status === "failed" || item.status === "waiting_human" || item.priority === "urgent");

    // 5. Language Detection (Item 14)
    const detectedLanguage =
      effectiveAccount.languageMode !== "auto" && effectiveAccount.languageMode
        ? effectiveAccount.languageMode
        : detectCompanyChatLanguage(parsed.subject + " " + parsed.bodyText);

    // 6. Attachment analysis (Item 17)
    let attachmentNotes = "";
    let attachmentAnalysisPerformed = false;
    if (payload.attachments && payload.attachments.length > 0) {
      const notes: string[] = [];
      for (const attachment of payload.attachments) {
        const label = `[Attachment: ${attachment.filename} (${attachment.contentType}, ${Math.round(attachment.sizeBytes / 1024)} KB)]`;
        if (!attachment.contentBase64) {
          notes.push(label + " Content was not included for analysis.");
          continue;
        }
        try {
          const data = Buffer.from(attachment.contentBase64, "base64");
          if (!data.length || data.length > 10 * 1024 * 1024) {
            notes.push(label + " Content skipped because it is empty or exceeds the 10 MB analysis limit.");
          } else if (attachment.contentType.startsWith("image/")) {
            notes.push(label + " Image received and eligible for multimodal vision analysis.");
          } else {
            const extracted = await extractDocumentText(data, attachment.contentType, attachment.filename);
            attachmentAnalysisPerformed = attachmentAnalysisPerformed || extracted.trim().length > 0;
            notes.push(`${label}\nExtracted content:\n${extracted.slice(0, 20_000)}`);
          }
        } catch (error) {
          notes.push(`${label} Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      attachmentNotes = notes.join("\n\n");
    }

    // 7. Priority Analysis (Item 9)
    let priority: EmailPriority = isVip ? "urgent" : "normal";
    const textForAnalysis = (parsed.subject + " " + parsed.bodyText).toLowerCase();
    const detectedIntent = detectEmailIntent(textForAnalysis);
    if (
      /urgent|critical|asap|terrible|emergency|down|broken|негайно|срочно|помилка|збій|блоку|швидко/i.test(
        textForAnalysis
      )
    ) {
      priority = isVip ? "urgent" : "high";
    } else if (/billing|payment|invoice|refund|гроші|оплата|рахунок|повернення/i.test(textForAnalysis)) {
      priority = "high";
    } else if (/newsletter|unsubscribe|promo|знижка|реклама|digest/i.test(textForAnalysis)) {
      priority = "low";
    }
    if (!isVip && priority === "normal" && hasRecentEscalation) priority = "high";

    // 8. Find or create Thread (Item 6)
    let thread = await this.repo.findMatchingThread(ctx, companyId, {
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      customerEmail: parsed.from,
      subject: parsed.subject,
      threadKey: payload.threadKey,
    });

    if (!thread) {
      const cleanSubject = normalizeEmailSubject(parsed.subject);
      const normalizedKey = `th_${parsed.from.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent((cleanSubject || parsed.subject).slice(0, 50).toLowerCase())}`;
      thread = await this.repo.createThread(ctx, companyId, {
        emailAccountId: effectiveAccount.id,
        threadKey: payload.threadKey || normalizedKey,
        subject: parsed.subject,
        customerEmail: parsed.from,
        customerName: contact.name,
        customerCompany: contact.companyName,
        customerPhone: contact.phone,
        status: isBlacklisted ? "closed" : "new",
        priority,
        folder: isBlacklisted ? "spam" : "inbox",
        assignedAgentId: effectiveAccount.agentId,
        isVip,
        isBlacklisted,
        detectedLanguage,
      });
    } else {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        lastMessageAt: new Date().toISOString(),
        unreadCount: (thread.unreadCount || 0) + 1,
        priority: priority === "urgent" ? "urgent" : thread.priority,
        isVip: isVip || thread.isVip,
        status: "new",
        folder: "inbox",
      });
    }

    // 9. Save Inbound Message. Keep the decoded payload for AI analysis, while
    // persisting the durable message copy through the shared object lifecycle.
    const storedAttachments = payload.attachments?.length && this.hooks.persistAttachments
      ? await this.hooks.persistAttachments({ ctx, companyId, thread, attachments: payload.attachments })
      : payload.attachments || [];
    const inboundMessage = await this.repo.createMessage(ctx, companyId, {
      threadId: thread.id,
      emailAccountId: effectiveAccount.id,
      direction: "inbound",
      fromAddress: parsed.from,
      toAddresses: [parsed.to],
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      bodyHtml: payload.bodyHtml,
      messageId: externalMessageId,
      inReplyTo: payload.inReplyTo,
      attachments: storedAttachments,
      deliveryStatus: "delivered",
    });
    // A generated reply is tied to the inbound message it answers. Once a
    // newer customer message arrives, keep the conversation history but drop
    // any stale, unsent AI reply before generating the replacement.
    await this.repo.deletePendingAiDrafts(ctx, companyId, thread.id);
    const conversationHistory = (await this.repo.listMessages(ctx, companyId, thread.id))
      .filter((message) => !message.isDraft)
      .map((message) => {
        const speaker = message.direction === "inbound" ? "Customer" : "Company";
        return `[${message.createdAt}] ${speaker}: ${message.bodyText}`;
      })
      .join("\n\n");
    await this.repo.cancelPendingFollowups(thread.id);
    if (this.auditRepo) {
      await this.auditRepo.log(ctx, companyId, {
        action: "email.received", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
        details: {
          messageId: inboundMessage.id, providerMessageId: externalMessageId, from: parsed.from,
          subject: parsed.subject, priority, attachments: payload.attachments?.length || 0
        },
      }).catch(() => undefined);
    }

    // If blacklisted, stop here
    if (isBlacklisted) {
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.spam_filtered", category: "security", resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: inboundMessage.id, from: parsed.from, reason: "blacklisted_contact" },
        }).catch(() => undefined);
      }
      return {
        thread,
        inboundMessage,
        aiMessage: null,
        actionTaken: "blacklisted_ignored",
        confidenceScore: 0.99,
        priority: "low",
        detectedLanguage,
      };
    }

    if (!injectionAnalysis.safe) {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        status: "waiting_human",
        metadata: { ...thread.metadata, externalUntrustedContent: true, promptInjectionRisk: injectionAnalysis.riskScore },
      });
      if (this.auditRepo) await this.auditRepo.log(ctx, companyId, {
        action: "email.prompt_injection_blocked", category: "security", resourceType: "company_email_thread", resourceId: thread.id,
        details: { messageId: inboundMessage.id, from: parsed.from, riskScore: injectionAnalysis.riskScore, matchedPatterns: injectionAnalysis.matchedPatterns },
      }).catch(() => undefined);
      return {
        thread,
        inboundMessage,
        aiMessage: null,
        actionTaken: "sender_rejected",
        confidenceScore: 1,
        priority,
        detectedLanguage,
      };
    }

    const trust = evaluateInboundTrust(effectiveAccount, payload, parsed.from);
    const authenticatedEnough = !effectiveAccount.requireAuthenticatedSender || trust.authenticated;
    if (!trust.authorized || !authenticatedEnough) {
      const reason = trust.reason || "sender_authentication_required";
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        status: "waiting_human",
        folder: trust.automated ? "archived" : "inbox",
        metadata: { ...thread.metadata, inboundRejectedReason: reason, senderAuthenticated: trust.authenticated },
      });
      if (this.auditRepo) await this.auditRepo.log(ctx, companyId, {
        action: "email.sender_rejected", category: "security", resourceType: "company_email_thread", resourceId: thread.id,
        details: { messageId: inboundMessage.id, from: parsed.from, reason, authenticated: trust.authenticated },
      }).catch(() => undefined);
      return {
        thread,
        inboundMessage,
        aiMessage: null,
        actionTaken: "sender_rejected",
        confidenceScore: 1,
        priority,
        detectedLanguage,
      };
    }

    if (priority === "urgent") {
      await this.repo.createNotification(ctx, companyId, {
        userId: thread.assignedUserId, threadId: thread.id, notificationType: "urgent_email",
        title: `Urgent email: ${thread.subject}`,
        body: `Urgent message received from ${thread.customerEmail}.`,
      });
    }

    const browserWait = await this.repo.claimBrowserEmailWait(ctx, companyId, parsed.from, effectiveAccount.id).catch(() => null);
    if (browserWait) {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, { metadata: {
        ...thread.metadata,
        awaitingAgentRunId: browserWait.runId,
        awaitingBrowserJobId: browserWait.browserJobId,
        awaitingBrowserProfileId: browserWait.profileId,
        awaitingBrowserCampaignTargetId: browserWait.campaignTargetId || null,
      }});
    }
    const awaitingRunId = typeof thread.metadata.awaitingAgentRunId === "string"
      ? thread.metadata.awaitingAgentRunId
      : undefined;
    if (awaitingRunId && this.hooks.continueTask) {
      const continuationRunId = await this.hooks.continueTask({
        ctx, companyId, thread, inboundMessage, awaitingRunId,
      });
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        metadata: {
          ...thread.metadata,
          awaitingAgentRunId: null,
          continuedFromAgentRunId: awaitingRunId,
          continuationRunId: continuationRunId || null,
          continuedAt: new Date().toISOString(),
        },
      });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.agent_task_continued", category: "automation",
          resourceType: "company_email_thread", resourceId: thread.id,
          details: { awaitingRunId, continuationRunId, messageId: inboundMessage.id },
        }).catch(() => undefined);
      }
    }

    // 10. Check Rules (Item 25)
    const rules = await this.repo.listRules(ctx, companyId);
    const analyzedPriority = priority;
    const evaluatedRules = evaluateEmailRoutingRules({
      rules,
      effectiveAccount,
      from: parsed.from,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      attachments: payload.attachments,
      priority,
      detectedLanguage,
      isVip,
      detectedIntent,
    });
    let effectiveMode = evaluatedRules.effectiveMode;
    let overrideAgentId = evaluatedRules.overrideAgentId;
    let autoReplyTemplateId = evaluatedRules.autoReplyTemplateId;
    let shouldCreateTask = evaluatedRules.shouldCreateTask;
    let workflowId = evaluatedRules.workflowId;
    let shouldTagSpam = evaluatedRules.shouldTagSpam;
    priority = evaluatedRules.priority;

    if (priority !== analyzedPriority && this.auditRepo) {
      await this.auditRepo.log(ctx, companyId, {
        action: "email.priority_changed", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
        details: { from: analyzedPriority, to: priority, source: "routing_rule", detectedIntent },
      }).catch(() => undefined);
    }

    if (shouldTagSpam) {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        folder: "spam", status: "closed", priority: "low", isBlacklisted: true,
      });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.spam_filtered", category: "security",
          resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: inboundMessage.id, reason: "email_rule", from: parsed.from },
        }).catch(() => undefined);
      }
      return {
        thread, inboundMessage, aiMessage: null, actionTaken: "rule_spam_filtered",
        confidenceScore: 0.99, priority: "low", detectedLanguage,
      };
    }

    const hasCompanyScope = !companyId.startsWith("personal:");
    if (hasCompanyScope && shouldCreateTask && this.hooks.createTask) {
      const taskId = await this.hooks.createTask({ ctx, companyId, thread, inboundMessage, assignedAgentId: overrideAgentId });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.task_created", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
          details: { taskId, messageId: inboundMessage.id, assignedAgentId: overrideAgentId, detectedIntent },
        }).catch(() => undefined);
      }
    }

    if (hasCompanyScope && workflowId && this.hooks.startWorkflow) {
      const workflowRunId = await this.hooks.startWorkflow({
        ctx, companyId, thread, inboundMessage, workflowId,
      });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.workflow_started", category: "automation",
          resourceType: "company_email_thread", resourceId: thread.id,
          details: { workflowId, workflowRunId, messageId: inboundMessage.id },
        }).catch(() => undefined);
      }
    }

    // 11. Check Collision Lock & Takeover (Items 11 & 26)
    const collision = await this.repo.isCollisionLocked(ctx, companyId, thread.id);
    if (collision.locked) {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        status: "waiting_human",
        priority,
        assignedAgentId: overrideAgentId,
      });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.collision_hold", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: inboundMessage.id, reason: collision.reason },
        }).catch(() => undefined);
      }
      return {
        thread,
        inboundMessage,
        aiMessage: null,
        actionTaken: "collision_hold",
        confidenceScore: 0.9,
        priority,
        detectedLanguage,
      };
    }

    if (this.hooks.routeThroughGateway) {
      const routed = await this.hooks.routeThroughGateway({
        ctx, companyId, account: effectiveAccount, thread, inboundMessage, payload, trust,
      });
      if (routed) {
        thread = await this.repo.updateThread(ctx, companyId, thread.id, { status: "ai_processing", priority, assignedAgentId: overrideAgentId });
        return {
          thread,
          inboundMessage,
          aiMessage: null,
          actionTaken: "gateway_dispatched",
          confidenceScore: 1,
          priority,
          detectedLanguage,
        };
      }
    }
    // If mode is manual, do not generate draft or auto-reply
    if (effectiveMode === "manual") {
      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        status: "waiting_human",
        priority,
        assignedAgentId: overrideAgentId,
      });
      if (this.auditRepo) {
        await this.auditRepo.log(ctx, companyId, {
          action: "email.agent_escalated", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: inboundMessage.id, reason: "manual_mode", mode: effectiveMode, detectedIntent },
        }).catch(() => undefined);
      }
      return {
        thread,
        inboundMessage,
        aiMessage: null,
        actionTaken: "manual_recorded",
        confidenceScore: 0.85,
        priority,
        detectedLanguage,
      };
    }

    if (this.auditRepo) {
      await this.auditRepo.log(ctx, companyId, {
        action: "email.agent_started", category: "automation", resourceType: "company_email_thread", resourceId: thread.id,
        details: { messageId: inboundMessage.id, agentId: overrideAgentId, mode: effectiveMode, detectedIntent },
      }).catch(() => undefined);
    }

    // 12 & 13. Calculate Confidence Score and Generate Draft Response
    const draftResult = await generateEmailDraftResponse({
      repo: this.repo,
      aiEngine: this.aiEngine,
      withAiSlot: (op) => this.withAiSlot(op),
      ctx,
      companyId,
      payload,
      from: parsed.from,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      effectiveAccount,
      contact,
      isVip,
      customerHistory,
      hasRecentEscalation,
      conversationHistory,
      inboundMessage,
      externalMessageId,
      textForAnalysis,
      detectedLanguage,
      priority,
      effectiveMode,
      autoReplyTemplateId,
      overrideAgentId,
      attachmentNotes,
      attachmentAnalysisPerformed,
    });
    const confidenceScore = draftResult.confidenceScore;
    const responseContent = draftResult.responseContent;
    const responseSubject = draftResult.responseSubject;

    // 14. Check Mode Execution: Autopilot vs Approval
    const meetsConfidence = confidenceScore >= (effectiveAccount.confidenceThreshold || 0.8);
    const isAutopilot = effectiveMode === "autopilot" && meetsConfidence;

    // Rate Limit Check (Item 21)
    if (isAutopilot) {
      const rateLimit = await this.repo.reserveSendQuota(companyId, effectiveAccount, parsed.from);
      if (!rateLimit.allowed) {
        // Fallback to draft when rate limited
        const draftMsg = await this.repo.createMessage(ctx, companyId, {
          threadId: thread.id,
          emailAccountId: effectiveAccount.id,
          direction: "outbound",
          fromAddress: effectiveAccount.emailAddress,
          toAddresses: [parsed.from],
          subject: responseSubject,
          bodyText: responseContent,
          isDraft: true,
          isAiGenerated: true,
          inReplyTo: externalMessageId || inboundMessage.messageId,
          deliveryStatus: "sending",
        });

        thread = await this.repo.updateThread(ctx, companyId, thread.id, {
          status: "waiting_approval",
          priority,
          assignedAgentId: overrideAgentId,
          aiConfidenceScore: confidenceScore,
          aiClassificationSummary: `Rate limit triggered: ${rateLimit.reason}. Converted to draft.`,
        });

        if (this.auditRepo) {
          await this.auditRepo.log(ctx, companyId, {
            action: "email.rate_limited", category: "security", resourceType: "company_email_thread", resourceId: thread.id,
            details: { messageId: draftMsg.id, recipient: parsed.from, reason: rateLimit.reason },
          }).catch(() => undefined);
        }

        return {
          thread,
          inboundMessage,
          aiMessage: draftMsg,
          actionTaken: "rate_limited_draft",
          confidenceScore,
          priority,
          detectedLanguage,
        };
      }
    }

    // 15. Create Draft or Autopilot Sent Message
    let aiMessage: CompanyEmailMessage;
    let actionTaken: InboundProcessingResult["actionTaken"] = "draft_created";

    if (isAutopilot) {
      if (effectiveAccount.testMode) {
        // Test Mode (Item 22)
        aiMessage = await this.repo.createMessage(ctx, companyId, {
          threadId: thread.id,
          emailAccountId: effectiveAccount.id,
          direction: "outbound",
          fromAddress: effectiveAccount.emailAddress,
          toAddresses: [parsed.from],
          subject: responseSubject,
          bodyText: responseContent,
          isDraft: true,
          isAiGenerated: true,
          inReplyTo: externalMessageId || inboundMessage.messageId,
          deliveryStatus: "delivered",
        });

        thread = await this.repo.updateThread(ctx, companyId, thread.id, {
          status: "draft_ready",
          priority,
          assignedAgentId: overrideAgentId,
          aiConfidenceScore: confidenceScore,
          aiClassificationSummary: "Test Mode: Autopilot simulated answer without external sending.",
        });

        actionTaken = "test_mode_simulated";
      } else {
        // Live Autopilot Send
        aiMessage = await this.repo.createMessage(ctx, companyId, {
          threadId: thread.id,
          emailAccountId: effectiveAccount.id,
          direction: "outbound",
          fromAddress: effectiveAccount.emailAddress,
          toAddresses: [parsed.from],
          subject: responseSubject,
          bodyText: responseContent,
          isDraft: false,
          isAiGenerated: true,
          inReplyTo: externalMessageId || inboundMessage.messageId,
          deliveryStatus: "sending",
        });

        await this.repo.enqueueJob(ctx, companyId, {
          jobType: "send",
          emailAccountId: effectiveAccount.id,
          threadId: thread.id,
          messageId: aiMessage.id,
          idempotencyKey: `send:${aiMessage.id}`,
        });

        thread = await this.repo.updateThread(ctx, companyId, thread.id, {
          status: "ai_processing",
          priority,
          assignedAgentId: overrideAgentId,
          aiConfidenceScore: confidenceScore,
          aiClassificationSummary: "AI Autopilot response queued for SMTP delivery.",
        });

        actionTaken = "autopilot_queued";
      }
    } else {
      // Approval Mode (Item 5 & 7)
      aiMessage = await this.repo.createMessage(ctx, companyId, {
        threadId: thread.id,
        emailAccountId: effectiveAccount.id,
        direction: "outbound",
        fromAddress: effectiveAccount.emailAddress,
        toAddresses: [parsed.from],
        subject: responseSubject,
        bodyText: responseContent,
        isDraft: true,
        isAiGenerated: true,
        inReplyTo: externalMessageId || inboundMessage.messageId,
        deliveryStatus: "sending",
      });

      thread = await this.repo.updateThread(ctx, companyId, thread.id, {
        status: meetsConfidence ? "draft_ready" : "waiting_approval",
        priority,
        assignedAgentId: overrideAgentId,
        aiConfidenceScore: confidenceScore,
        aiClassificationSummary: meetsConfidence
          ? "AI response draft prepared and ready for human review."
          : `Low confidence (${confidenceScore} < ${effectiveAccount.confidenceThreshold}): Human approval required.`,
      });

      actionTaken = "draft_created";
    }

    // 16. Audit Log (Item 24)
    if (this.auditRepo) {
      await this.auditRepo
        .log(ctx, companyId, {
          action: actionTaken === "autopilot_queued"
            ? "email.auto_reply_queued"
            : actionTaken === "test_mode_simulated"
              ? "email.test_mode_simulated"
              : "email.draft_generated",
          category: "automation",
          resourceType: "company_email_thread",
          resourceId: thread.id,
          details: {
            from: parsed.from,
            subject: parsed.subject,
            actionTaken,
            confidenceScore,
            priority,
            account: effectiveAccount.emailAddress,
            testMode: effectiveAccount.testMode,
            detectedIntent,
          },
        })
        .catch(() => undefined);
    }

    return {
      thread,
      inboundMessage,
      aiMessage,
      actionTaken,
      confidenceScore,
      priority,
      detectedLanguage,
    };
  }
}
