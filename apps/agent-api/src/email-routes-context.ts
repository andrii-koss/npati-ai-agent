import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { EmailAIProcessor, EmailAutomationHooks } from "./email-ai-processor";
import type { EmailAgentTools } from "./email-agent-tools";
import type { EmailAttachmentStorage } from "./email-attachment-storage";
import type { EmailInboxWorker } from "./email-worker";
import type { CompanyEmailAccount } from "./email-inbox-types";

export interface EmailRoutesContext {
  auth: AuthProvider;
  store: WorkspaceStore;
  repo: EmailInboxRepository;
  auditRepo?: AuditRepository;
  aiEngine?: AIEngine;
  automationHooks?: EmailAutomationHooks;
  attachmentStorage?: EmailAttachmentStorage;
  worker?: EmailInboxWorker;
  aiProcessor: EmailAIProcessor;
  agentTools: EmailAgentTools;
}

export function presentEmailAccount(account: CompanyEmailAccount): CompanyEmailAccount {
  const { password: _imapPassword, accessToken: _imapAccess, refreshToken: _imapRefresh, clientSecret: _imapSecret, ...imapConfig } = account.imapConfig;
  const { password: _smtpPassword, accessToken: _smtpAccess, refreshToken: _smtpRefresh, clientSecret: _smtpSecret, ...smtpConfig } = account.smtpConfig;
  return { ...account, imapConfig, smtpConfig };
}

interface DatabaseErrorLike {
  code?: string;
  constraint?: string;
  status?: number;
  message?: string;
}

export function err(reply: FastifyReply, error: unknown) {
  const errObj = error as DatabaseErrorLike | null;
  const duplicateMailbox = errObj?.code === "23505"
    && errObj?.constraint === "company_email_accounts_user_address_unique";
  const message = duplicateMailbox
    ? "This email address is already connected. Edit the existing account instead of adding it again."
    : error instanceof Error ? error.message : String(error);
  const status = duplicateMailbox ? 409 : errObj?.status || 400;
  return reply.code(status).send({ error: { message } });
}

export type EmailPermission =
  | "workspace:read" | "business:manage" | "email:view" | "email:manage_accounts"
  | "email:read_messages" | "email:send_messages" | "email:delete_messages"
  | "email:approve_drafts" | "email:configure_autopilot" | "email:configure_agents"
  | "email:view_analytics";

export async function ctx(auth: AuthProvider, r: FastifyRequest, permission: EmailPermission) {
  const scope = await auth.authenticate(r);
  const emailReadPermission = ["email:view", "email:read_messages", "email:view_analytics"].includes(permission);
  const hasAccess = scope.permissions.includes(permission) ||
    (permission === "workspace:read" || emailReadPermission
      ? scope.permissions.includes("workspace:read") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("business:manage") ||
      scope.permissions.includes("admin:all") ||
      scope.permissions.includes("*")
      : scope.permissions.includes("business:manage") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("admin:all") ||
      scope.permissions.includes("*"));

  if (!hasAccess) {
    throw Object.assign(new Error(`Missing required permission: ${permission}`), { status: 403 });
  }
  return scope;
}

export const PERSONAL_EMAIL_SCOPE = "personal";

export function personalEmailScopeId(context: AuthContext): string {
  return `personal:${createHash("sha256").update(`${context.workspaceId}:${context.userId}`).digest("hex").slice(0, 32)}`;
}

export async function resolveEmailScope(store: WorkspaceStore, context: AuthContext, requestedScope: string): Promise<string> {
  const personalScope = personalEmailScopeId(context);
  if (requestedScope === PERSONAL_EMAIL_SCOPE || requestedScope === personalScope) return personalScope;
  if (requestedScope.startsWith(`${PERSONAL_EMAIL_SCOPE}:`)) {
    throw Object.assign(new Error("This personal email scope belongs to another user."), { status: 403 });
  }
  await store.getCompany(context, requestedScope);
  return requestedScope;
}
