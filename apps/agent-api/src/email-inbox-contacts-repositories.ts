import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type { CompanyEmailContact, CompanyEmailRule, CompanyEmailTemplate, CompanyEmailThread } from "./email-inbox-types";

export interface EmailInboxContactsHost {
  pool?: Pool;
  memoryThreads: Map<string, CompanyEmailThread>;
  memoryContacts: Map<string, CompanyEmailContact>;
  memoryTemplates: Map<string, CompanyEmailTemplate>;
  memoryRules: Map<string, CompanyEmailRule>;
}

export async function listContacts(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string): Promise<CompanyEmailContact[]> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailContact>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                name, company_name AS "companyName", phone, is_vip AS "isVip",
                is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_contacts
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY is_vip DESC, last_activity_at DESC NULLS LAST, email ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(host.memoryContacts.values())
      .filter((contact) => contact.workspaceId === ctx.workspaceId && contact.companyId === companyId)
      .sort((a, b) => {
        if (a.isVip !== b.isVip) return a.isVip ? -1 : 1;
        const activityDelta = new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime();
        return activityDelta || a.email.localeCompare(b.email);
      });
  }

export async function getContact(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string, email: string): Promise<CompanyEmailContact | null> {

    const cleanEmail = email.trim().toLowerCase();
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailContact>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                name, company_name AS "companyName", phone, is_vip AS "isVip",
                is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_contacts
         WHERE workspace_id = $1 AND company_id = $2 AND email = $3`,
        [ctx.workspaceId, companyId, cleanEmail]
      );
      const contact = result.rows[0];
      if (!contact) return null;
      const countResult = await host.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND customer_email = $3`,
        [ctx.workspaceId, companyId, cleanEmail]
      );
      return { ...contact, previousThreadsCount: Number(countResult.rows[0]?.count || 0) };
    }

    const key = `${ctx.workspaceId}:${companyId}:${cleanEmail}`;
    const contact = host.memoryContacts.get(key);
    if (!contact) return null;
    const previousThreadsCount = Array.from(host.memoryThreads.values()).filter((thread) =>
      thread.workspaceId === ctx.workspaceId && thread.companyId === companyId && thread.customerEmail === cleanEmail).length;
    return { ...contact, previousThreadsCount };
  }

export async function upsertContact(host: EmailInboxContactsHost, 
    ctx: AuthContext,
    companyId: string,
    contactData: {
      email: string;
      name?: string | null;
      companyName?: string | null;
      phone?: string | null;
      isVip?: boolean;
      isBlacklisted?: boolean;
      notes?: string | null;
    }
  ): Promise<CompanyEmailContact> {

    const cleanEmail = contactData.email.trim().toLowerCase();
    const existing = await getContact(host, ctx, companyId, cleanEmail);
    const now = new Date().toISOString();
    const id = existing?.id || randomUUID();

    const contact: CompanyEmailContact = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      email: cleanEmail,
      name: contactData.name ?? existing?.name ?? null,
      companyName: contactData.companyName ?? existing?.companyName ?? null,
      phone: contactData.phone ?? existing?.phone ?? null,
      isVip: contactData.isVip ?? existing?.isVip ?? false,
      isBlacklisted: contactData.isBlacklisted ?? existing?.isBlacklisted ?? false,
      notes: contactData.notes ?? existing?.notes ?? null,
      lastActivityAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailContact>(
        `INSERT INTO company_email_contacts (
          id, workspace_id, company_id, email, name, company_name, phone,
          is_vip, is_blacklisted, notes, last_activity_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (workspace_id, company_id, email) DO UPDATE SET
          name = EXCLUDED.name, company_name = EXCLUDED.company_name, phone = EXCLUDED.phone,
          is_vip = EXCLUDED.is_vip, is_blacklisted = EXCLUDED.is_blacklisted,
          notes = EXCLUDED.notes, last_activity_at = EXCLUDED.last_activity_at, updated_at = EXCLUDED.updated_at
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                  name, company_name AS "companyName", phone, is_vip AS "isVip",
                  is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          contact.id,
          contact.workspaceId,
          contact.companyId,
          contact.email,
          contact.name,
          contact.companyName,
          contact.phone,
          contact.isVip,
          contact.isBlacklisted,
          contact.notes,
          contact.lastActivityAt,
          contact.createdAt,
          contact.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    const key = `${ctx.workspaceId}:${companyId}:${cleanEmail}`;
    host.memoryContacts.set(key, contact);
    return contact;
  }

  // =========================================================================
  // 6. Templates & Signatures (Item 13)
  // =========================================================================

export async function listTemplates(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string): Promise<CompanyEmailTemplate[]> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailTemplate>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId",
                email_account_id AS "emailAccountId", title, category,
                subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                created_at AS "createdAt"
         FROM company_email_templates
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY title ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(host.memoryTemplates.values()).filter(
      (t) => t.workspaceId === ctx.workspaceId && t.companyId === companyId
    );
  }

export async function createTemplate(host: EmailInboxContactsHost, 
    ctx: AuthContext,
    companyId: string,
    input: { title: string; category?: string; subjectTemplate?: string; bodyTemplate: string; emailAccountId?: string }
  ): Promise<CompanyEmailTemplate> {

    const id = randomUUID();
    const template: CompanyEmailTemplate = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      emailAccountId: input.emailAccountId || null,
      title: input.title.trim(),
      category: (input.category as any) || "general",
      subjectTemplate: input.subjectTemplate || null,
      bodyTemplate: input.bodyTemplate,
      createdAt: new Date().toISOString(),
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailTemplate>(
        `INSERT INTO company_email_templates (
          id, workspace_id, company_id, email_account_id, title, category, subject_template, body_template
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                  email_account_id AS "emailAccountId", title, category,
                  subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                  created_at AS "createdAt"`,
        [
          template.id,
          template.workspaceId,
          template.companyId,
          template.emailAccountId,
          template.title,
          template.category,
          template.subjectTemplate,
          template.bodyTemplate,
        ]
      );
      return result.rows[0]!;
    }

    host.memoryTemplates.set(id, template);
    return template;
  }

export async function deleteTemplate(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string, templateId: string): Promise<void> {

    if (host.pool) {
      await host.pool.query(
        `DELETE FROM company_email_templates WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, templateId]
      );
      return;
    }
    host.memoryTemplates.delete(templateId);
  }

export async function updateTemplate(host: EmailInboxContactsHost, 
    ctx: AuthContext,
    companyId: string,
    templateId: string,
    patch: { title?: string; category?: string; subjectTemplate?: string | null; bodyTemplate?: string }
  ): Promise<CompanyEmailTemplate> {

    const templates = await listTemplates(host, ctx, companyId);
    const existing = templates.find((t) => t.id === templateId);
    if (!existing) throw new Error("Template not found.");

    const updated: CompanyEmailTemplate = {
      ...existing,
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      category: (patch.category as any) ?? existing.category,
      subjectTemplate: patch.subjectTemplate !== undefined ? patch.subjectTemplate : existing.subjectTemplate,
      bodyTemplate: patch.bodyTemplate !== undefined ? patch.bodyTemplate : existing.bodyTemplate,
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailTemplate>(
        `UPDATE company_email_templates SET
          title = $1, category = $2, subject_template = $3, body_template = $4
         WHERE workspace_id = $5 AND company_id = $6 AND id = $7
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                   email_account_id AS "emailAccountId", title, category,
                   subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                   created_at AS "createdAt"`,
        [
          updated.title,
          updated.category,
          updated.subjectTemplate,
          updated.bodyTemplate,
          ctx.workspaceId,
          companyId,
          templateId,
        ]
      );
      return result.rows[0]!;
    }

    host.memoryTemplates.set(templateId, updated);
    return updated;
  }

  // =========================================================================
  // 7. Email Rules (Item 25)
  // =========================================================================

export async function listRules(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string): Promise<CompanyEmailRule[]> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailRule>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId",
                email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_rules
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY priority_order ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(host.memoryRules.values())
      .filter((r) => r.workspaceId === ctx.workspaceId && r.companyId === companyId)
      .sort((a, b) => a.priorityOrder - b.priorityOrder);
  }

export async function createRule(host: EmailInboxContactsHost, 
    ctx: AuthContext,
    companyId: string,
    input: { name: string; emailAccountId?: string; conditions?: any; actions?: any; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {

    const id = randomUUID();
    const now = new Date().toISOString();
    const rule: CompanyEmailRule = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      emailAccountId: input.emailAccountId || null,
      name: input.name.trim(),
      priorityOrder: input.priorityOrder ?? 0,
      isActive: true,
      conditions: input.conditions || {},
      actions: input.actions || {},
      createdAt: now,
      updatedAt: now,
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailRule>(
        `INSERT INTO company_email_rules (
          id, workspace_id, company_id, email_account_id, name, priority_order, is_active, conditions, actions, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                  email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                  is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          rule.id,
          rule.workspaceId,
          rule.companyId,
          rule.emailAccountId,
          rule.name,
          rule.priorityOrder,
          rule.isActive,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          rule.createdAt,
          rule.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    host.memoryRules.set(id, rule);
    return rule;
  }

export async function deleteRule(host: EmailInboxContactsHost, ctx: AuthContext, companyId: string, ruleId: string): Promise<void> {

    if (host.pool) {
      await host.pool.query(
        `DELETE FROM company_email_rules WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, ruleId]
      );
      return;
    }
    host.memoryRules.delete(ruleId);
  }

export async function updateRule(host: EmailInboxContactsHost, 
    ctx: AuthContext,
    companyId: string,
    ruleId: string,
    patch: { name?: string; conditions?: any; actions?: any; isActive?: boolean; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {

    const rules = await listRules(host, ctx, companyId);
    const existing = rules.find((r) => r.id === ruleId);
    if (!existing) throw new Error("Rule not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailRule = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      conditions: patch.conditions !== undefined ? patch.conditions : existing.conditions,
      actions: patch.actions !== undefined ? patch.actions : existing.actions,
      isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
      priorityOrder: patch.priorityOrder !== undefined ? patch.priorityOrder : existing.priorityOrder,
      updatedAt: now,
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailRule>(
        `UPDATE company_email_rules SET
          name = $1, conditions = $2, actions = $3, is_active = $4, priority_order = $5, updated_at = $6
         WHERE workspace_id = $7 AND company_id = $8 AND id = $9
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                   email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                   is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          updated.name,
          JSON.stringify(updated.conditions),
          JSON.stringify(updated.actions),
          updated.isActive,
          updated.priorityOrder,
          now,
          ctx.workspaceId,
          companyId,
          ruleId,
        ]
      );
      return result.rows[0]!;
    }

    host.memoryRules.set(ruleId, updated);
    return updated;
  }

  // =========================================================================
  // 8. Rate Limits (Item 21)
  // =========================================================================

