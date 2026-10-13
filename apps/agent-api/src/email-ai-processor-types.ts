import type { AuthContext } from "@npati/workspace";
import type {
  CompanyEmailAccount,
  CompanyEmailMessage,
  CompanyEmailRule,
  CompanyEmailThread,
  EmailAttachment,
  EmailPriority,
} from "./email-inbox-types";

export interface EmailInboundTrust {
  authorized: boolean;
  authenticated: boolean;
  automated: boolean;
  reason?: string;
}

export interface InboundEmailPayload {
  from: string;
  to?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: EmailAttachment[];
  threadKey?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string | undefined>;
  authenticationResults?: string;
}

export interface InboundProcessingResult {
  thread: CompanyEmailThread;
  inboundMessage: CompanyEmailMessage;
  aiMessage?: CompanyEmailMessage | null;
  actionTaken:
    | "manual_recorded"
    | "draft_created"
    | "autopilot_queued"
    | "test_mode_simulated"
    | "blacklisted_ignored"
    | "rule_spam_filtered"
    | "collision_hold"
    | "rate_limited_draft"
    | "duplicate_ignored"
    | "gateway_dispatched"
    | "sender_rejected";
  confidenceScore: number;
  priority: EmailPriority;
  detectedLanguage: string;
  auditLogId?: string;
}

export interface EmailAutomationHooks {
  createTask?: (input: {
    ctx: AuthContext;
    companyId: string;
    thread: CompanyEmailThread;
    inboundMessage: CompanyEmailMessage;
    assignedAgentId?: string | null;
  }) => Promise<string | undefined>;
  continueTask?: (input: {
    ctx: AuthContext;
    companyId: string;
    thread: CompanyEmailThread;
    inboundMessage: CompanyEmailMessage;
    awaitingRunId: string;
  }) => Promise<string | undefined>;
  startWorkflow?: (input: {
    ctx: AuthContext;
    companyId: string;
    thread: CompanyEmailThread;
    inboundMessage: CompanyEmailMessage;
    workflowId: string;
  }) => Promise<string | undefined>;
  persistAttachments?: (input: {
    ctx: AuthContext;
    companyId: string;
    thread: CompanyEmailThread;
    attachments: EmailAttachment[];
  }) => Promise<EmailAttachment[]>;
  routeThroughGateway?: (input: {
    ctx: AuthContext;
    companyId: string;
    account: CompanyEmailAccount;
    thread: CompanyEmailThread;
    inboundMessage: CompanyEmailMessage;
    payload: InboundEmailPayload;
    trust: EmailInboundTrust;
  }) => Promise<boolean>;
}

export function matchesEmailPattern(email: string, rawPattern: string): boolean {
  const value = email.trim().toLowerCase();
  const pattern = rawPattern.trim().toLowerCase();
  if (!pattern) return false;
  if (pattern.startsWith("@")) return value.endsWith(pattern);
  if (!pattern.includes("*")) return value === pattern;

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function detectEmailIntent(text: string): string {
  const normalized = text.toLowerCase();
  if (/refund|chargeback|money back|повернен|повернути кошти/.test(normalized)) return "refund";
  if (/invoice|billing|payment|receipt|рахунок|оплат|платіж/.test(normalized)) return "billing";
  if (/cancel|cancellation|terminate|скасув|відмін/.test(normalized)) return "cancellation";
  if (/bug|error|broken|not working|issue|помил|не працю|збій/.test(normalized)) return "support";
  if (/price|pricing|quote|proposal|ціна|вартіст|пропозиці/.test(normalized)) return "sales";
  if (/unsubscribe|newsletter|promo|відписат|розсилк|реклам/.test(normalized)) return "marketing";
  return "general";
}

export function matchesAttachmentType(attachment: EmailAttachment, rawPattern: string): boolean {
  const pattern = rawPattern.trim().toLowerCase();
  const contentType = attachment.contentType.toLowerCase();
  const filename = attachment.filename.toLowerCase();
  if (!pattern) return false;
  if (pattern.startsWith(".")) return filename.endsWith(pattern);
  if (!pattern.includes("*")) return contentType === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(contentType);
}

export function evaluateInboundTrust(
  account: CompanyEmailAccount,
  payload: InboundEmailPayload,
  sender: string
): EmailInboundTrust {
  const normalized = sender.trim().toLowerCase();
  if (!payload.headers && !payload.authenticationResults) return { authorized: true, authenticated: true, automated: false };
  const domain = normalized.split("@")[1] || "";
  const headers = Object.fromEntries(
    Object.entries(payload.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value || "").toLowerCase()])
  );
  const automated =
    /auto-replied|auto-generated/.test(headers["auto-submitted"] || "") ||
    /bulk|list|junk/.test(headers.precedence || "") ||
    Boolean(headers["list-unsubscribe"]) ||
    /^(?:mailer-daemon|postmaster|no-?reply)@/.test(normalized);
  if (automated) return { authorized: false, authenticated: false, automated: true, reason: "automated_email" };
  if (normalized === account.emailAddress.toLowerCase()) {
    return { authorized: false, authenticated: false, automated: false, reason: "self_message" };
  }
  const authentication = (payload.authenticationResults || headers["authentication-results"] || "").toLowerCase();
  const authenticated = /\b(?:spf|dkim|dmarc)=pass\b/.test(authentication);
  if (account.senderPolicy === "disabled") {
    return { authorized: false, authenticated, automated: false, reason: "sender_policy_disabled" };
  }
  const exact = account.allowedSenders.includes(normalized);
  const domainAllowed = account.allowedDomains.includes(domain);
  const authorized = account.senderPolicy === "open" || exact || (account.senderPolicy === "allowlist" && domainAllowed);
  return { authorized, authenticated, automated: false, reason: authorized ? undefined : "sender_not_allowed" };
}

export interface EvaluatedRoutingRules {
  priority: EmailPriority;
  effectiveMode: CompanyEmailAccount["mode"];
  overrideAgentId?: string | null;
  autoReplyTemplateId?: string;
  shouldCreateTask: boolean;
  workflowId?: string;
  shouldTagSpam: boolean;
}

export function evaluateEmailRoutingRules(options: {
  rules: CompanyEmailRule[];
  effectiveAccount: CompanyEmailAccount;
  from: string;
  subject: string;
  bodyText: string;
  attachments?: EmailAttachment[];
  priority: EmailPriority;
  detectedLanguage: string;
  isVip: boolean;
  detectedIntent: string;
}): EvaluatedRoutingRules {
  const { rules, effectiveAccount, from, subject, bodyText, attachments, detectedLanguage, isVip, detectedIntent } = options;
  let priority = options.priority;
  let effectiveMode = effectiveAccount.mode;
  let overrideAgentId = effectiveAccount.agentId;
  let autoReplyTemplateId: string | undefined;
  let shouldCreateTask = false;
  let workflowId: string | undefined;
  let shouldTagSpam = false;

  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.emailAccountId && rule.emailAccountId !== effectiveAccount.id) continue;
    const cond = rule.conditions;
    let matched = true;

    if (cond.senders && cond.senders.length > 0) {
      if (!cond.senders.some((senderPattern) => matchesEmailPattern(from, senderPattern))) matched = false;
    }
    if (cond.domains && cond.domains.length > 0) {
      const senderDomain = from.split("@")[1]?.toLowerCase();
      if (!senderDomain || !cond.domains.some((domain) => matchesEmailPattern(senderDomain, domain))) matched = false;
    }
    if (cond.subjectKeywords && cond.subjectKeywords.length > 0) {
      const normalizedSubject = subject.toLowerCase();
      if (!cond.subjectKeywords.some((keyword) => normalizedSubject.includes(keyword.toLowerCase()))) matched = false;
    }
    if (cond.bodyKeywords && cond.bodyKeywords.length > 0) {
      const normalizedBody = bodyText.toLowerCase();
      if (!cond.bodyKeywords.some((keyword) => normalizedBody.includes(keyword.toLowerCase()))) matched = false;
    }
    if (cond.priority && cond.priority !== priority) matched = false;
    if (cond.hasAttachments !== undefined && cond.hasAttachments !== ((attachments?.length || 0) > 0)) matched = false;
    if (
      cond.attachmentTypes?.length &&
      !attachments?.some((attachment) => cond.attachmentTypes!.some((pattern) => matchesAttachmentType(attachment, pattern)))
    ) {
      matched = false;
    }
    if (cond.language && cond.language.toLowerCase() !== detectedLanguage.toLowerCase()) matched = false;
    if (cond.isVip !== undefined && cond.isVip !== isVip) matched = false;
    if (cond.detectedIntent && cond.detectedIntent.toLowerCase() !== detectedIntent) matched = false;

    if (matched) {
      if (rule.actions.setMode) effectiveMode = rule.actions.setMode;
      if (rule.actions.requireApproval) effectiveMode = "approval";
      if (rule.actions.setPriority) priority = rule.actions.setPriority;
      if (rule.actions.setAgentId) overrideAgentId = rule.actions.setAgentId;
      if (rule.actions.autoReplyTemplateId) autoReplyTemplateId = rule.actions.autoReplyTemplateId;
      if (rule.actions.createTask) shouldCreateTask = true;
      if (rule.actions.startWorkflowId) workflowId = rule.actions.startWorkflowId;
      if (rule.actions.autoTagSpam) shouldTagSpam = true;
      break;
    }
  }

  return {
    priority,
    effectiveMode,
    overrideAgentId,
    autoReplyTemplateId,
    shouldCreateTask,
    workflowId,
    shouldTagSpam,
  };
}
