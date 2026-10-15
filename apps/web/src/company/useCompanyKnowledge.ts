import { useEffect, useState } from "react";
import { getStoredAuthToken } from "../AuthContext";
import { confirmModal } from "../ConfirmDialog";
import { useTranslation } from "../i18n";
import { api } from "./cache";
import type { Company, KnowledgeDocument, CompanyMemory } from "./types";

export function useCompanyKnowledge(selected: Company | undefined, setNotice: (msg: string) => void) {
  const { t } = useTranslation();
  const selectedId = selected?.id;

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [memories, setMemories] = useState<CompanyMemory[]>([]);
  const [memoryText, setMemoryText] = useState("");
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [knowledgeActionId, setKnowledgeActionId] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState("");
  const [editingMemoryText, setEditingMemoryText] = useState("");

  useEffect(() => {
    if (!selectedId) return;
    setMemoryText("");
    setEditingMemoryId("");
    setEditingMemoryText("");
    void api<{ documents: KnowledgeDocument[] }>(`/companies/${selectedId}/knowledge/documents`).then((value) => setDocuments(value.documents ?? [])).catch(() => setDocuments([]));
    void api<{ memories: CompanyMemory[] }>(`/companies/${selectedId}/knowledge/memory`).then((value) => setMemories(value.memories ?? [])).catch(() => setMemories([]));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !documents.some((document) => document.status === "uploaded" || document.status === "processing")) return;
    const timer = window.setInterval(() => {
      void api<{ documents: KnowledgeDocument[] }>(`/companies/${selectedId}/knowledge/documents`)
        .then((value) => setDocuments(value.documents ?? []))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedId, documents]);

  async function readFileAsBase64(file: File) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(t("companySettings.errors.couldNotReadDocument")));
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.readAsDataURL(file);
    });
  }

  async function uploadKnowledge(files: File[]) {
    if (!selected || !files.length) return;
    const companyId = selected.id;
    setKnowledgeBusy(true);
    setNotice("");
    let uploaded = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (file.size === 0) throw new Error(t("companySettings.errors.fileIsEmpty"));
        if (file.size > 25 * 1024 * 1024) throw new Error(t("companySettings.errors.fileSizeLimitExceeded"));
        const data = await readFileAsBase64(file);
        const document = await api<KnowledgeDocument>(`/companies/${companyId}/knowledge/documents`, {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", data }),
        });
        setDocuments((items) => [document, ...items.filter((item) => item.id !== document.id)]);
        uploaded++;
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : t("companySettings.errors.uploadFailed")}`);
      }
    }
    try {
      const value = await api<{ documents: KnowledgeDocument[] }>(`/companies/${companyId}/knowledge/documents`);
      setDocuments(value.documents ?? []);
    } catch {}
    setKnowledgeBusy(false);
    setNotice(
      failures.length
        ? t("companySettings.notices.uploadedWithErrors", { count: String(uploaded), errors: failures.join("; ") })
        : t("companySettings.notices.uploadedAndQueued", { count: String(uploaded) }),
    );
  }

  async function addCompanyMemory() {
    const content = memoryText.trim();
    if (!selected || !content || memoryBusy) return;
    setMemoryBusy(true);
    setNotice("");
    try {
      const created = await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      setMemoryText("");
      setMemories((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setNotice(t("companySettings.notices.memoryAdded"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.memorySaveFailed"));
    } finally {
      setMemoryBusy(false);
    }
  }

  function startEditingMemory(memory: CompanyMemory) {
    setEditingMemoryId(memory.id);
    setEditingMemoryText(memory.content);
  }

  async function updateCompanyMemory() {
    const content = editingMemoryText.trim();
    if (!selected || !editingMemoryId || !content || memoryBusy) return;
    setMemoryBusy(true);
    setNotice("");
    try {
      const updated = await api<CompanyMemory>(`/companies/${selected.id}/knowledge/memory/${editingMemoryId}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      setMemories((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setEditingMemoryId("");
      setEditingMemoryText("");
      setNotice(t("companySettings.notices.memoryUpdated"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.memoryUpdateFailed"));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function deleteKnowledge(id: string) {
    if (!selected || knowledgeActionId) return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteDocTitle"),
      message: t("companySettings.dialogs.deleteDocMessage"),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    setKnowledgeActionId(id);
    setNotice("");
    try {
      await api(`/companies/${selected.id}/knowledge/documents/${id}`, { method: "DELETE" });
      setDocuments((items) => items.filter((item) => item.id !== id));
      setNotice(t("companySettings.notices.docDeleted"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.docDeleteFailed"));
    } finally {
      setKnowledgeActionId("");
    }
  }

  async function downloadKnowledge(doc: KnowledgeDocument) {
    if (!selected || knowledgeActionId) return;
    setKnowledgeActionId(doc.id);
    setNotice("");
    try {
      const headers = new Headers();
      const token = getStoredAuthToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(`/api/companies/${selected.id}/knowledge/documents/${doc.id}/content`, { headers });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `${t("companySettings.errors.downloadFailedStatus")} (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = doc.filename || "company-document";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.docDownloadFailed"));
    } finally {
      setKnowledgeActionId("");
    }
  }

  async function reprocessKnowledge(id: string) {
    if (!selected || knowledgeActionId) return;
    setKnowledgeActionId(id);
    setNotice("");
    try {
      const document = await api<KnowledgeDocument>(`/companies/${selected.id}/knowledge/documents/${id}/reprocess`, {
        method: "POST",
      });
      setDocuments((items) => items.map((item) => (item.id === id ? document : item)));
      setNotice(t("companySettings.notices.docReprocessing"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.docRetryFailed"));
    } finally {
      setKnowledgeActionId("");
    }
  }

  async function deleteCompanyMemory(id: string) {
    if (!selected || memoryBusy) return;
    const confirmed = await confirmModal({
      title: t("companySettings.dialogs.deleteMemoryTitle"),
      message: t("companySettings.dialogs.deleteMemoryMessage"),
      confirmText: t("companySettings.dialogs.deleteConfirm"),
      cancelText: t("companySettings.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;
    setMemoryBusy(true);
    setNotice("");
    try {
      await api(`/companies/${selected.id}/knowledge/memory/${id}`, { method: "DELETE" });
      setMemories((items) => items.filter((item) => item.id !== id));
      if (editingMemoryId === id) {
        setEditingMemoryId("");
        setEditingMemoryText("");
      }
      setNotice(t("companySettings.notices.memoryDeleted"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("companySettings.errors.memoryDeleteFailed"));
    } finally {
      setMemoryBusy(false);
    }
  }

  return {
    documents,
    setDocuments,
    memories,
    setMemories,
    memoryText,
    setMemoryText,
    knowledgeBusy,
    knowledgeActionId,
    memoryBusy,
    editingMemoryId,
    setEditingMemoryId,
    editingMemoryText,
    setEditingMemoryText,
    uploadKnowledge,
    addCompanyMemory,
    startEditingMemory,
    updateCompanyMemory,
    deleteKnowledge,
    downloadKnowledge,
    reprocessKnowledge,
    deleteCompanyMemory,
  };
}
