import type { ChatToolDefinition } from "@npati/omniroute-adapter";

/** Native transports for the existing workspace/email directive executors; validation and storage stay there. */
const tool = (name: string, description: string, properties: Record<string, unknown>): ChatToolDefinition => ({
  type: "function", function: { name, description, parameters: { type: "object", required: ["action"], additionalProperties: false,
    properties: { action: { type: "string", description: "One supported action from the authorized workspace/email context." }, ...properties } } },
});
const string = { type: "string" };
const object = { type: "object" };
/** Mirrors the memory executor's validation, so the model cannot invent fields it will reject. */
const memory = { type: "object", additionalProperties: false, description: "memory.create requires type, title and content; memory.update sends only the changed fields.", properties: {
  type: { type: "string", enum: ["business_fact", "audience", "brand", "preference", "decision", "product", "channel", "experiment", "result", "other"] },
  title: string, content: string, confidence: { type: "number", minimum: 0, maximum: 1 } } };
export const WORKSPACE_ACTION_TOOL = tool("npati_workspace_action",
  "Execute an explicitly requested Activity, Automation, Content Hub or Business Memory operation using the owned IDs from the workspace context. Read existing records before updates; do not substitute web search. The existing executor authorizes, validates, persists and returns the actual result.",
  { companyId: string, companyName: string, projectId: string, businessId: string, businessName: string,
    automationId: string, automationName: string, historyLimit: { type: "integer" }, contentId: string, contentTitle: string,
    memoryId: string, memoryTitle: string, webhookId: string, webhookName: string, intro: string, followUp: string,
    activity: object, automation: object, content: object, memory, webhook: object });
export const EMAIL_ACTION_TOOL = tool("npati_email_action",
  "Execute an explicitly requested email settings, template, rule, inbox or draft operation. Use exact owned IDs from EMAIL MANAGEMENT. Template operations use templateId or templateTitle, not credentials. Sends and approvals follow the existing email executor and its safeguards.",
  { companyId: string, accountId: string, accountEmail: string, templateId: string, templateTitle: string,
    ruleId: string, ruleName: string, threadId: string, threadSubject: string, messageId: string, contactEmail: string, permissionId: string,
    fields: object, intro: string, followUp: string });
