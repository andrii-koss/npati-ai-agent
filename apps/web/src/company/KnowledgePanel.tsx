import type { Company, Agent, KnowledgeDocument, CompanyMemory } from "./types";
import { translatedStatus } from "./types";
import { useTranslation } from "../i18n";

export interface KnowledgePanelProps {
  selected: Company;
  agents: Agent[];
  documents: KnowledgeDocument[];
  knowledgeBusy: boolean;
  uploadKnowledge: (files: File[]) => void | Promise<void>;
  enableMainAgentKnowledge: () => void | Promise<void>;
  knowledgeActionId: string;
  downloadKnowledge: (doc: KnowledgeDocument) => void | Promise<void>;
  reprocessKnowledge: (id: string) => void | Promise<void>;
  deleteKnowledge: (id: string) => void | Promise<void>;
  memories: CompanyMemory[];
  memoryText: string;
  setMemoryText: (val: string) => void;
  memoryBusy: boolean;
  addCompanyMemory: () => void | Promise<void>;
  editingMemoryId: string;
  setEditingMemoryId: (id: string) => void;
  editingMemoryText: string;
  setEditingMemoryText: (val: string) => void;
  updateCompanyMemory: () => void | Promise<void>;
  startEditingMemory: (memory: CompanyMemory) => void;
  deleteCompanyMemory: (id: string) => void | Promise<void>;
}

export function KnowledgePanel({
  selected,
  agents,
  documents,
  knowledgeBusy,
  uploadKnowledge,
  enableMainAgentKnowledge,
  knowledgeActionId,
  downloadKnowledge,
  reprocessKnowledge,
  deleteKnowledge,
  memories,
  memoryText,
  setMemoryText,
  memoryBusy,
  addCompanyMemory,
  editingMemoryId,
  setEditingMemoryId,
  editingMemoryText,
  setEditingMemoryText,
  updateCompanyMemory,
  startEditingMemory,
  deleteCompanyMemory,
}: KnowledgePanelProps) {
  const { t } = useTranslation();

  return (
    <section className="company-run-card company-knowledge-card">
      <div className="company-section-heading">
        <div>
          <span>{t("companySettings.knowledge.kicker")}</span>
          <h2>{t("companySettings.knowledge.title")}</h2>
        </div>
        <small>{t("companySettings.knowledge.subtitle")}</small>
      </div>

      {/* Sub-block 1: Document Knowledge */}
      <div className="company-knowledge-block">
        <div className="company-knowledge-subhead">
          <div className="company-subhead-title">
            <span className="company-subhead-icon" aria-hidden="true">📁</span>
            <h3>{t("companySettings.knowledge.documentsTitle")}</h3>
            <small className="tab-count">{documents.length}</small>
          </div>

          <label className="button-secondary company-upload-label">
            <input
              hidden
              type="file"
              multiple
              disabled={knowledgeBusy}
              accept=".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.xml"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void uploadKnowledge(files);
                e.currentTarget.value = "";
              }}
            />
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span>{t(knowledgeBusy ? "companySettings.knowledge.uploading" : "companySettings.knowledge.uploadDoc")}</span>
          </label>
        </div>

        {documents.some((document) => document.status === "ready") && selected.mainAgentId && !agents.find((agent) => agent.id === selected.mainAgentId)?.tools.some((tool) => tool === "Knowledge" || tool === "storage.agent_knowledge_retrieval" || tool.toLowerCase() === "knowledge") && (
          <div className="company-knowledge-permission-alert" role="alert">
            <div>
              <strong>{t("companySettings.knowledge.mainAgentCannotSearch")}</strong>
              <small>{t("companySettings.knowledge.enableKnowledgeDesc")}</small>
            </div>
            <button type="button" disabled={knowledgeBusy} onClick={() => void enableMainAgentKnowledge()}>
              {knowledgeBusy ? t("companySettings.knowledge.enabling") : t("companySettings.knowledge.enableKnowledge")}
            </button>
          </div>
        )}

        <div className="company-knowledge-list">
          {documents.map((doc) => (
            <div key={doc.id} className="company-doc-item">
              <div className="company-doc-item-left">
                <span className="company-doc-icon">📄</span>
                <div className="company-doc-details">
                  <strong title={doc.filename}>{doc.filename||t("companySettings.knowledge.companyDocument")}</strong>
                  <div className="company-doc-meta">
                    <span className={`connection-status-pill status-${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`}>
                      <span className={`status-indicator-dot ${doc.status === "ready" ? "ok" : doc.status === "failed" ? "error" : "standby"}`} />
                      {translatedStatus(t, doc.status)}
                    </span>
                    <span className="company-chunk-badge">{t("companySettings.knowledge.chunks", { count: String(doc.chunkCount) })}</span>
                    {typeof doc.sizeBytes==="number"&&<span className="company-doc-size">{doc.sizeBytes<1024*1024?`${Math.max(1,Math.round(doc.sizeBytes/1024))} KB`:`${(doc.sizeBytes/1024/1024).toFixed(1)} MB`}</span>}
                  </div>
                </div>
              </div>
              {doc.errorMessage && <small className="company-doc-error">{doc.errorMessage}</small>}
              <div className="company-doc-actions">
                <button type="button" className="company-doc-link" disabled={knowledgeActionId===doc.id} onClick={()=>void downloadKnowledge(doc)}>{t("companySettings.knowledge.download")}</button>
                {doc.status === "failed" && (
                  <button
                    type="button"
                    className="button-secondary company-doc-btn"
                    disabled={knowledgeActionId===doc.id}
                    onClick={() => void reprocessKnowledge(doc.id)}
                  >
                    {t("companySettings.knowledge.retry")}
                  </button>
                )}
                <button
                  type="button"
                  className="content-action-btn delete-btn company-doc-btn"
                  disabled={knowledgeActionId===doc.id}
                  onClick={() => void deleteKnowledge(doc.id)}
                >
                  {t("companySettings.knowledge.delete")}
                </button>
              </div>
            </div>
          ))}

          {!documents.length && (
            <div className="company-empty-docs-box">
              <span className="company-empty-icon" aria-hidden="true">📄</span>
              <strong>{t("companySettings.knowledge.noDocsTitle")}</strong>
              <p>{t("companySettings.knowledge.noDocsDesc")}</p>
            </div>
          )}
        </div>
      </div>

      {/* Sub-block 2: Durable Memory / Facts */}
      <div className="company-knowledge-block company-memory-block">
        <div className="company-knowledge-subhead">
          <div className="company-subhead-title">
            <span className="company-subhead-icon" aria-hidden="true">💡</span>
            <h3>{t("companySettings.memory.durableTitle")}</h3>
            <small className="tab-count">{memories.length}</small>
          </div>
        </div>

        <div className="company-memory-editor-row">
          <textarea
            rows={2}
            placeholder={t("companySettings.memory.addPlaceholder")}
            value={memoryText}
            onChange={(e) => setMemoryText(e.target.value)}
            disabled={memoryBusy}
            className="company-memory-textarea"
          />
          <button
            type="button"
            className="button-primary automations-action-primary company-add-memory-btn"
            onClick={() => void addCompanyMemory()}
            disabled={!memoryText.trim()||memoryBusy}
          >
            {memoryBusy?t("companySettings.memory.saving"):t("companySettings.memory.addMemory")}
          </button>
        </div>

        {memories.length > 0 && (
          <ul className="company-memory-list">
            {memories.map((memory) => (
              <li key={memory.id} className="company-memory-item">
                {editingMemoryId===memory.id?<textarea rows={2} className="company-memory-textarea" value={editingMemoryText} disabled={memoryBusy} onChange={(event)=>setEditingMemoryText(event.target.value)}/>:<div className="company-memory-item-content"><span className="memory-bullet" aria-hidden="true">📌</span><p>{memory.content}</p></div>}
                <div className="company-memory-actions">
                  {editingMemoryId===memory.id?<><button type="button" className="button-primary company-memory-edit-btn" disabled={!editingMemoryText.trim()||memoryBusy} onClick={()=>void updateCompanyMemory()}>{t("companySettings.memory.save")}</button><button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>{setEditingMemoryId("");setEditingMemoryText("");}}>{t("companySettings.memory.cancel")}</button></>:<button type="button" className="button-secondary company-memory-edit-btn" disabled={memoryBusy} onClick={()=>startEditingMemory(memory)}>{t("companySettings.memory.edit")}</button>}
                  <button type="button" className="content-action-btn delete-btn company-memory-delete-btn" disabled={memoryBusy} onClick={() => void deleteCompanyMemory(memory.id)} title={t("companySettings.memory.deleteFact")}>{t("companySettings.memory.delete")}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
