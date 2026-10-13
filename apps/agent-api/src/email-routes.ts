import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";
import type { EmailInboxRepository } from "./email-inbox-repository";
import { EmailAIProcessor, type EmailAutomationHooks } from "./email-ai-processor";
import { EmailAgentTools } from "./email-agent-tools";
import type { EmailAttachmentStorage } from "./email-attachment-storage";
import type { EmailInboxWorker } from "./email-worker";
import {
  type EmailRoutesContext,
} from "./email-routes-context";
import { registerEmailManagementRoutes } from "./email-management-routes";
import { registerEmailThreadRoutes } from "./email-thread-routes";

export * from "./email-routes-context";
export * from "./email-management-routes";
export * from "./email-thread-routes";

export function registerEmailInboxRoutes(
  app: FastifyInstance,
  options: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: EmailInboxRepository;
    auditRepo?: AuditRepository;
    aiEngine?: AIEngine;
    automationHooks?: EmailAutomationHooks;
    attachmentStorage?: EmailAttachmentStorage;
    worker?: EmailInboxWorker;
  }
) {
  const { repo, auditRepo, aiEngine, automationHooks } = options;
  const aiProcessor = new EmailAIProcessor(repo, auditRepo, aiEngine, automationHooks);
  const agentTools = new EmailAgentTools(repo);
  const context: EmailRoutesContext = {
    ...options,
    aiProcessor,
    agentTools,
  };

  registerEmailManagementRoutes(app, context);
  registerEmailThreadRoutes(app, context);
}
