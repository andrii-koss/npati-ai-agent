export type EmailAccountMode = "manual" | "approval" | "autopilot";
export type EmailAccountStatus =
  | "connected"
  | "pending"
  | "auth_error"
  | "imap_error"
  | "smtp_error"
  | "dns_error"
  | "disabled";

export interface ImapConfig {
  authType?: "password" | "oauth2";
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  tls?: boolean;
  mailbox?: string;
  lastUid?: number;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

export interface SmtpConfig {
  authType?: "password" | "oauth2";
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  lastError?: string | null;
}

export interface EmailRateLimits {
  maxPerHour: number;
  maxPerDay: number;
  maxPerRecipientDaily: number;
  maxFollowups: number;
  maxCompanyPerHour?: number;
  maxCompanyPerDay?: number;
}

export interface EmailSignatureConfig {
  greeting?: string;
  signature?: string;
  footer?: string;
  disclaimer?: string;
}

export interface EmailFollowupConfig {
  enabled: boolean;
  delayDays: number;
  maxFollowups: number;
  action: "draft" | "auto_send" | "create_task" | "notify_user";
}

export interface CompanyEmailAccount {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  emailAddress: string;
  displayName?: string | null;
  agentId?: string | null;
  mode: EmailAccountMode;
  status: EmailAccountStatus;
  testMode: boolean;
  confidenceThreshold: number;
  languageMode: string;
  fallbackLanguage: string;
  imapConfig: ImapConfig;
  smtpConfig: SmtpConfig;
  rateLimits: EmailRateLimits;
  signatureConfig: EmailSignatureConfig;
  followupConfig: EmailFollowupConfig;
  createdAt: string;
  updatedAt: string;
}

export type EmailPriority = "low" | "normal" | "high" | "urgent";

export type EmailThreadStatus =
  | "new"
  | "ai_processing"
  | "draft_ready"
  | "waiting_approval"
  | "waiting_customer"
  | "waiting_human"
  | "answered"
  | "closed"
  | "failed";

export type EmailFolder = "inbox" | "sent" | "drafts" | "archived" | "spam";

export interface CompanyEmailThread {
  id: string;
  workspaceId: string;
  companyId: string;
  emailAccountId?: string | null;
  threadKey: string;
  subject: string;
  customerEmail: string;
  customerName?: string | null;
  customerCompany?: string | null;
  customerPhone?: string | null;
  status: EmailThreadStatus;
  priority: EmailPriority;
  folder: EmailFolder;
  assignedAgentId?: string | null;
  assignedUserId?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  isHumanTakeover: boolean;
  lockedByUserId?: string | null;
  lockedAt?: string | null;
  lastMessageAt: string;
  unreadCount: number;
  aiConfidenceScore?: number | null;
  aiClassificationSummary?: string | null;
  detectedLanguage?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  messagesCount?: number;
  latestMessageSnippet?: string;
  latestInboundSnippet?: string;
  latestOutboundSnippet?: string;
}

export type EmailDeliveryStatus = "sending" | "sent" | "delivered" | "bounced" | "rejected" | "failed";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  url?: string;
  contentBase64?: string;
}

export interface CompanyEmailMessage {
  id: string;
  workspaceId: string;
  companyId: string;
  threadId: string;
  emailAccountId?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  direction: "inbound" | "outbound";
  fromAddress: string;
  fromName?: string | null;
  toAddresses: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments: EmailAttachment[];
  deliveryStatus: EmailDeliveryStatus;
  deliveryError?: string | null;
  isDraft: boolean;
  isAiGenerated: boolean;
  aiDraftApprovedBy?: string | null;
  sentByUserId?: string | null;
  sentByAgentId?: string | null;
  createdAt: string;
}

export interface CompanyEmailContact {
  id: string;
  workspaceId: string;
  companyId: string;
  email: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  isVip: boolean;
  isBlacklisted: boolean;
  notes?: string | null;
  lastActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
  previousThreadsCount?: number;
}

export interface CompanyEmailTemplate {
  id: string;
  workspaceId: string;
  companyId: string;
  emailAccountId?: string | null;
  title: string;
  category: "support" | "sales" | "billing" | "information" | "general";
  subjectTemplate?: string | null;
  bodyTemplate: string;
  createdAt: string;
}

export interface EmailRuleConditions {
  senders?: string[];
  domains?: string[];
  subjectKeywords?: string[];
  bodyKeywords?: string[];
  detectedIntent?: string;
  attachmentTypes?: string[];
  priority?: EmailPriority;
  hasAttachments?: boolean;
  isVip?: boolean;
  language?: string;
}

export interface EmailRuleActions {
  setAgentId?: string;
  setMode?: EmailAccountMode;
  setPriority?: EmailPriority;
  requireApproval?: boolean;
  autoTagSpam?: boolean;
  createTask?: boolean;
  autoReplyTemplateId?: string;
  startWorkflowId?: string;
}

export interface CompanyEmailRule {
  id: string;
  workspaceId: string;
  companyId: string;
  emailAccountId?: string | null;
  name: string;
  priorityOrder: number;
  isActive: boolean;
  conditions: EmailRuleConditions;
  actions: EmailRuleActions;
  createdAt: string;
  updatedAt: string;
}

export interface DnsRecordCheck {
  recordType: "MX" | "SPF" | "DKIM" | "DMARC";
  name: string;
  found: boolean;
  valid: boolean;
  currentValue?: string | string[];
  expectedValueHint?: string;
  recommendation?: string;
}

export interface DnsVerificationResult {
  domain: string;
  verified: boolean;
  checkedAt: string;
  records: DnsRecordCheck[];
  summary: string;
}

export interface ConnectionTestResult {
  service: "imap" | "smtp" | "all";
  success: boolean;
  testedAt: string;
  imapStatus?: { ok: boolean; message: string; latencyMs?: number };
  smtpStatus?: { ok: boolean; message: string; latencyMs?: number };
  error?: string;
}

export interface EmailAnalytics {
  receivedEmails: number;
  sentEmails: number;
  aiAnswered: number;
  humanAnswered: number;
  draftedByAi: number;
  approvedByHuman: number;
  escalatedToHuman: number;
  failedEmails: number;
  bouncedEmails: number;
  averageResponseTimeMinutes: number;
  averageFirstResponseTimeMinutes: number;
  editedAiResponsesCount: number;
  automationRate: number; // percentage 0 - 100
  confidenceDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  volumeByDay: Array<{ date: string; received: number; sent: number }>;
  volumeByAgent: Array<{ agentId: string; agentName: string; count: number }>;
  volumeByAccount: Array<{ accountId: string; email: string; count: number }>;
}

export type EmailJobType = "send" | "followup" | "sync" | "delivery_check" | "attachment_analysis";
export type EmailJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface CompanyEmailJob {
  id: string;
  workspaceId: string;
  companyId: string;
  emailAccountId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  jobType: EmailJobType;
  status: EmailJobStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt?: string | null;
  lockedBy?: string | null;
  lastError?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyEmailNotification {
  id: string;
  workspaceId: string;
  companyId: string;
  userId?: string | null;
  threadId?: string | null;
  notificationType: "urgent_email" | "followup_due" | "delivery_failed";
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}
