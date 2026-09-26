import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { EmailInboxRepository } from "./email-inbox-repository";

type EmailActionKind =
  | "account.create" | "account.update"
  | "rule.create" | "rule.update"
  | "template.create" | "template.update"
  | "contact.upsert";

type EmailDirective = {
  action: EmailActionKind;
  companyId?: string;
  accountId?: string;
  accountEmail?: string;
  ruleId?: string;
  ruleName?: string;
  templateId?: string;
  templateTitle?: string;
  fields?: Record<string, unknown>;
};

export type EmailChatActionResult = {
  cleanText: string;
  emailAction?: { action: EmailActionKind; resourceId: string; companyId: string };
};

const accountFields = new Set([
  "emailAddress", "displayName", "agentId", "mode", "status", "testMode",
  "confidenceThreshold", "languageMode", "fallbackLanguage", "imapConfig",
  "smtpConfig", "rateLimits", "signatureConfig", "followupConfig",
]);
const ruleFields = new Set(["name", "emailAccountId", "conditions", "actions", "priorityOrder", "isActive"]);
const templateFields = new Set(["title", "category", "subjectTemplate", "bodyTemplate", "emailAccountId"]);
const contactFields = new Set(["email", "name", "companyName", "phone", "isVip", "isBlacklisted", "notes"]);

function blocks(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/```email-action\s*([\s\S]*?)```/gi)];
}

function cleanText(text: string): string {
  return text.replace(/```email-action[\s\S]*?```/gi, "").trim();
}

function validateObject(value: unknown, allowed: Set<string>): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Email action fields must be an object");
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof item === "string" && item.length > 20_000) throw new Error(`Email field ${key} is too long`);
    if (item && typeof item === "object" && JSON.stringify(item).length > 30_000) throw new Error(`Email field ${key} is too large`);
    result[key] = item;
  }
  return result;
}

function parseDirective(text: string): EmailDirective | undefined {
  const matches = blocks(text);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error("Use exactly one email action");
  const value = JSON.parse(matches[0]![1]!.trim()) as EmailDirective;
  const actions = new Set<EmailActionKind>([
    "account.create", "account.update", "rule.create", "rule.update",
    "template.create", "template.update", "contact.upsert",
  ]);
  if (!actions.has(value.action)) throw new Error("Unsupported email action");
  return value;
}

function exact<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw new Error(matches.length ? `More than one ${label} matches` : `${label} not found`);
  return matches[0]!;
}

export class EmailChatActions {
  static isManagementRequest(message: string): boolean {
    const operation = /(?:\b(?:add|create|connect|configure|set up|edit|update|change|save)\b|дод|створ|підключ|налашт|редаг|онов|змін|збереж)/iu.test(message);
    const resource = /(?:\b(?:email|mailbox|imap|smtp|autopilot|email rule|email template|signature|follow-?up|contact)\b|пошт|скринь|імейл|емейл|правил|шаблон|підпис|контакт|автопілот)/iu.test(message);
    return operation && resource;
  }

  static noActionMessage(): string {
    return "I could not safely determine the requested email setting change. Specify the mailbox, field, and exact value.";
  }

  static async buildSystemPrompt(auth: AuthContext, store: WorkspaceStore, repo: EmailInboxRepository, message: string, selectedCompanyId?: string): Promise<string> {
    if (!auth.permissions.includes("business:manage") || !this.isManagementRequest(message)) return "";
    const companies = (await store.listCompanies(auth, 100)).items;
    const company = selectedCompanyId
      ? await store.getCompany(auth, selectedCompanyId)
      : companies.length === 1 ? companies[0] : undefined;
    if (!company) {
      return "\n\nEMAIL SETTINGS MANAGEMENT: Ask the user to select the company whose email settings should be changed.";
    }
    const [accounts, rules, templates] = await Promise.all([
      repo.listAccounts(auth, company.id),
      repo.listRules(auth, company.id),
      repo.listTemplates(auth, company.id),
    ]);
    const fence = String.fromCharCode(96).repeat(3);
    return `\n\nEMAIL SETTINGS MANAGEMENT (Settings > Email):
You may update email settings only for the selected owned company. For an explicit request, emit exactly one fenced email-action JSON block at the end. Never claim success without a directive. Do not invent credentials, IDs, addresses, or server settings. Preserve unspecified fields. Ask for missing values required to connect a mailbox.
Selected company: ${JSON.stringify({ id: company.id, name: company.name })}.
Accounts: ${JSON.stringify(accounts.map((item) => ({ id: item.id, emailAddress: item.emailAddress, displayName: item.displayName, agentId: item.agentId, mode: item.mode, status: item.status, testMode: item.testMode, confidenceThreshold: item.confidenceThreshold, languageMode: item.languageMode, fallbackLanguage: item.fallbackLanguage, imapConfig: { host: item.imapConfig.host, port: item.imapConfig.port, secure: item.imapConfig.secure, username: item.imapConfig.username, authType: item.imapConfig.authType }, smtpConfig: { host: item.smtpConfig.host, port: item.smtpConfig.port, secure: item.smtpConfig.secure, username: item.smtpConfig.username, authType: item.smtpConfig.authType }, rateLimits: item.rateLimits, signatureConfig: item.signatureConfig, followupConfig: item.followupConfig })))}.
Rules: ${JSON.stringify(rules.map((item) => ({ id: item.id, name: item.name, priorityOrder: item.priorityOrder, isActive: item.isActive, conditions: item.conditions, actions: item.actions })))}.
Templates: ${JSON.stringify(templates.map((item) => ({ id: item.id, title: item.title, category: item.category, subjectTemplate: item.subjectTemplate, bodyTemplate: item.bodyTemplate })))}.
Allowed actions: account.create, account.update, rule.create, rule.update, template.create, template.update, contact.upsert.
Use companyId ${company.id}. For updates identify the resource by its ID or exact email/name/title. Put changed values in fields. Account fields: ${[...accountFields].join(", ")}. Rule fields: ${[...ruleFields].join(", ")}. Template fields: ${[...templateFields].join(", ")}. Contact fields: ${[...contactFields].join(", ")}.
Example:
${fence}email-action
{"action":"account.update","companyId":"${company.id}","accountEmail":"support@example.com","fields":{"mode":"approval","signatureConfig":{"signature":"Best regards"}}}
${fence}
Do not expose passwords, tokens, or the directive in user-facing prose. Link to /settings/email when useful.`;
  }

  static async buildActionPlannerPrompt(auth: AuthContext, store: WorkspaceStore, repo: EmailInboxRepository, message: string, selectedCompanyId?: string): Promise<string> {
    return `${await this.buildSystemPrompt(auth, store, repo, message, selectedCompanyId)}

Return ONLY one complete email-action block for the latest request. Omit every unspecified field. Return exactly NO_ACTION if the target or required value is ambiguous.`;
  }

  static async extractAndExecute(
    auth: AuthContext,
    text: string,
    store: WorkspaceStore,
    repo: EmailInboxRepository,
    options: { selectedCompanyId?: string; requestMessage?: string; onError?: (error: unknown) => void } = {},
  ): Promise<EmailChatActionResult> {
    try {
      const directive = parseDirective(text);
      if (!directive) return { cleanText: text };
      if (!auth.permissions.includes("business:manage")) throw new Error("Missing permission to manage email settings");
      const companyId = directive.companyId || options.selectedCompanyId;
      if (!companyId) throw new Error("Select a company before changing email settings");
      await store.getCompany(auth, companyId);
      let resource: { id: string; emailAddress?: string | null; name?: string | null; title?: string | null; email?: string | null };

      if (directive.action === "account.create") {
        const fields = validateObject(directive.fields, accountFields);
        if (typeof fields.emailAddress !== "string" || !fields.emailAddress.trim()) throw new Error("emailAddress is required");
        resource = await repo.createAccount(auth, companyId, fields as any);
      } else if (directive.action === "account.update") {
        const accounts = await repo.listAccounts(auth, companyId);
        const account = exact(accounts, (item) => directive.accountId ? item.id === directive.accountId : item.emailAddress.toLowerCase() === directive.accountEmail?.toLowerCase(), "Email account");
        resource = await repo.updateAccount(auth, companyId, account.id, validateObject(directive.fields, accountFields));
      } else if (directive.action === "rule.create") {
        const fields = validateObject(directive.fields, ruleFields);
        if (typeof fields.name !== "string" || !fields.name.trim()) throw new Error("Rule name is required");
        resource = await repo.createRule(auth, companyId, fields as any);
      } else if (directive.action === "rule.update") {
        const rules = await repo.listRules(auth, companyId);
        const rule = exact(rules, (item) => directive.ruleId ? item.id === directive.ruleId : item.name.toLowerCase() === directive.ruleName?.toLowerCase(), "Email rule");
        resource = await repo.updateRule(auth, companyId, rule.id, validateObject(directive.fields, ruleFields));
      } else if (directive.action === "template.create") {
        const fields = validateObject(directive.fields, templateFields);
        if (typeof fields.title !== "string" || typeof fields.bodyTemplate !== "string") throw new Error("Template title and bodyTemplate are required");
        resource = await repo.createTemplate(auth, companyId, fields as any);
      } else if (directive.action === "template.update") {
        const templates = await repo.listTemplates(auth, companyId);
        const template = exact(templates, (item) => directive.templateId ? item.id === directive.templateId : item.title.toLowerCase() === directive.templateTitle?.toLowerCase(), "Email template");
        resource = await repo.updateTemplate(auth, companyId, template.id, validateObject(directive.fields, templateFields));
      } else {
        const fields = validateObject(directive.fields, contactFields);
        if (typeof fields.email !== "string" || !fields.email.trim()) throw new Error("Contact email is required");
        resource = await repo.upsertContact(auth, companyId, fields as any);
      }

      const label = resource.emailAddress || resource.name || resource.title || resource.email || resource.id;
      const response = cleanText(text);
      return {
        cleanText: `${response ? `${response}\n\n` : ""}Email settings updated for **${String(label).replace(/[*_\[\]`]/g, "")}**. [Open Email Settings](/settings/email)`,
        emailAction: { action: directive.action, resourceId: resource.id, companyId },
      };
    } catch (error) {
      options.onError?.(error);
      return { cleanText: this.noActionMessage() };
    }
  }
}
