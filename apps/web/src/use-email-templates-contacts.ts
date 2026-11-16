import { useState, FormEvent } from "react";
import { confirmModal } from "./ConfirmDialog";
import { api, type EmailTemplate, type ContactItem } from "./email-settings-types";

export function useEmailTemplatesContacts(
  selectedCompanyId: string,
  t: (key: string) => string,
  setNotice: (msg: string | null) => void
) {
  // Templates Drawer & State
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateCategory, setTemplateCategory] = useState("general");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Contacts Drawer & State
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [editingContactEmail, setEditingContactEmail] = useState<string | null>(null);
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactCompanyName, setContactCompanyName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactIsVip, setContactIsVip] = useState(false);
  const [contactIsBlacklisted, setContactIsBlacklisted] = useState(false);
  const [contactNotes, setContactNotes] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  // --- Template Drawer Handlers ---
  function openCreateTemplateDrawer() {
    setEditingTemplateId(null);
    setTemplateTitle("");
    setTemplateCategory("general");
    setTemplateSubject("");
    setTemplateBody("Hello {{customer_name}},\n\nThank you for reaching out to {{company_name}}.\n\nBest regards,\n{{agent_name}}");
    setTemplateDrawerOpen(true);
  }

  function openEditTemplateDrawer(tItem: EmailTemplate) {
    setEditingTemplateId(tItem.id);
    setTemplateTitle(tItem.title);
    setTemplateCategory(tItem.category);
    setTemplateSubject(tItem.subjectTemplate || "");
    setTemplateBody(tItem.bodyTemplate);
    setTemplateDrawerOpen(true);
  }

  async function handleSaveTemplate(e: FormEvent) {
    e.preventDefault();
    if (!templateTitle.trim() || !templateBody.trim()) {
      setNotice(t("emailSettings.messages.templateFieldsReq"));
      return;
    }
    setSavingTemplate(true);
    try {
      if (editingTemplateId) {
        const res = await api<{ template: EmailTemplate }>(`/companies/${selectedCompanyId}/email-inbox/templates/${editingTemplateId}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: templateTitle.trim(),
            category: templateCategory,
            subjectTemplate: templateSubject.trim() || null,
            bodyTemplate: templateBody,
          }),
        });
        setTemplates((prev) => prev.map((item) => (item.id === editingTemplateId ? res.template : item)));
      } else {
        const res = await api<{ template: EmailTemplate }>(`/companies/${selectedCompanyId}/email-inbox/templates`, {
          method: "POST",
          body: JSON.stringify({
            title: templateTitle.trim(),
            category: templateCategory,
            subjectTemplate: templateSubject.trim() || undefined,
            bodyTemplate: templateBody,
          }),
        });
        setTemplates((prev) => [...prev, res.template]);
      }
      setTemplateDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteTemplate(id: string) {
    const ok = await confirmModal({
      title: t("emailSettings.dialogs.deleteTemplateTitle"),
      message: t("emailSettings.dialogs.deleteTemplateMsg"),
      isDanger: true,
    });
    if (!ok) return;
    try {
      await api(`/companies/${templates.find(template => template.id === id)?.companyId || selectedCompanyId}/email-inbox/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((item) => item.id !== id));
    } catch (err: any) {
      setNotice(err.message);
    }
  }

  // --- Contact Drawer Handlers ---
  function openCreateContactDrawer(isVip = true) {
    setEditingContactEmail(null);
    setContactEmail("");
    setContactName("");
    setContactCompanyName("");
    setContactPhone("");
    setContactIsVip(isVip);
    setContactIsBlacklisted(false);
    setContactNotes("");
    setContactDrawerOpen(true);
  }

  function openEditContactDrawer(c: ContactItem) {
    setEditingContactEmail(c.email);
    setContactEmail(c.email);
    setContactName(c.name || "");
    setContactCompanyName(c.companyName || "");
    setContactPhone(c.phone || "");
    setContactIsVip(c.isVip);
    setContactIsBlacklisted(c.isBlacklisted);
    setContactNotes(c.notes || "");
    setContactDrawerOpen(true);
  }

  async function handleSaveContact(e: FormEvent) {
    e.preventDefault();
    if (!contactEmail.includes("@")) {
      setNotice(t("emailSettings.messages.validContactEmailReq"));
      return;
    }
    setSavingContact(true);
    try {
      const res = await api<{ contact: ContactItem }>(`/companies/${selectedCompanyId}/email-inbox/contacts/${encodeURIComponent(contactEmail.trim().toLowerCase())}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: contactName.trim() || undefined,
          companyName: contactCompanyName.trim() || undefined,
          phone: contactPhone.trim() || undefined,
          isVip: contactIsVip,
          isBlacklisted: contactIsBlacklisted,
          notes: contactNotes.trim() || undefined,
        }),
      });
      setContacts((prev) => [...prev.filter((c) => c.email !== res.contact.email), res.contact]);
      setContactDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSavingContact(false);
    }
  }

  return {
    templates,
    setTemplates,
    templateDrawerOpen,
    setTemplateDrawerOpen,
    editingTemplateId,
    templateTitle,
    setTemplateTitle,
    templateCategory,
    setTemplateCategory,
    templateSubject,
    setTemplateSubject,
    templateBody,
    setTemplateBody,
    savingTemplate,
    openCreateTemplateDrawer,
    openEditTemplateDrawer,
    handleSaveTemplate,
    handleDeleteTemplate,
    contacts,
    setContacts,
    contactDrawerOpen,
    setContactDrawerOpen,
    editingContactEmail,
    contactEmail,
    setContactEmail,
    contactName,
    setContactName,
    contactCompanyName,
    setContactCompanyName,
    contactPhone,
    setContactPhone,
    contactIsVip,
    setContactIsVip,
    contactIsBlacklisted,
    setContactIsBlacklisted,
    contactNotes,
    setContactNotes,
    savingContact,
    openCreateContactDrawer,
    openEditContactDrawer,
    handleSaveContact,
  };
}
