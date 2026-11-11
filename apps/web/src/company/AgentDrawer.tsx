import type { FormEvent } from "react";
import type { Model } from "../ai-marketplace-types";
import { useTranslation } from "../i18n";
import type { Agent, AgentDraft, CapabilityItem } from "./types";
import { translatedTool } from "./types";

export interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  editingAgent: Agent | null;
  agentForm: AgentDraft;
  setAgentForm: React.Dispatch<React.SetStateAction<AgentDraft>>;
  saveAgent: (e: FormEvent) => void;
  deleteAgent: () => Promise<void>;
  saving: boolean;
  models: Model[];
  modelsLoading: boolean;
  modelsError: string;
  availableTools: CapabilityItem[];
  language: string;
  agents: Agent[];
  setMainAgent: (id: string) => Promise<void>;
}

export function AgentDrawer({
  isOpen,
  onClose,
  editingAgent,
  agentForm,
  setAgentForm,
  saveAgent,
  deleteAgent,
  saving,
  models,
  modelsLoading,
  modelsError,
  availableTools,
  language,
  agents,
  setMainAgent,
}: AgentDrawerProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer agent-editor" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{t("companySettings.agentDrawer.aiAgent")}</span>
            <h2>{editingAgent ? editingAgent.name : t("companySettings.agentDrawer.addAgent")}</h2>
          </div>
          <button type="button" className="company-drawer-close" aria-label={t("companySettings.misc.closeDrawer")} onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={saveAgent}>
          <section>
            <h3>{t("companySettings.agentDrawer.general")}</h3>
            <div className="company-form-grid">
              <label><span>{t("companySettings.agentDrawer.name")}</span><input required value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} /></label>
              <label><span>{t("companySettings.agentDrawer.role")}</span><input required placeholder={t("companySettings.agentDrawer.rolePlaceholder")} value={agentForm.role} onChange={(event) => setAgentForm({ ...agentForm, role: event.target.value })} /></label>
            </div>
            <label><span>{t("companySettings.agentDrawer.description")}</span><textarea value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} /></label>
          </section>

          <section>
            <h3>{t("companySettings.agentDrawer.ai")}</h3>
            <div className="company-form-grid">
              <label><span>{t("companySettings.agentDrawer.model")}</span><select value={agentForm.modelId} onChange={(event) => setAgentForm({ ...agentForm, modelId: event.target.value })}>
                <option value="">{t("companySettings.agentDrawer.autoNpati")}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
              </select></label>
              <label><span>{t("companySettings.agentDrawer.fallbackModel")}</span><select value={agentForm.fallbackModelId} onChange={(event) => setAgentForm({ ...agentForm, fallbackModelId: event.target.value })}>
                <option value="">{t("companySettings.agentDrawer.autoNpati")}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} - {model.providerName}</option>)}
              </select></label>
            </div>
            {modelsLoading && <small className="company-field-hint">{t("companySettings.agentDrawer.loadingModels")}</small>}
            {!modelsLoading && modelsError && <small className="company-field-hint">{t("companySettings.agentDrawer.couldNotLoadModels")} {modelsError}</small>}
            {!modelsLoading && !modelsError && models.length === 0 && <small className="company-field-hint">{t("companySettings.agentDrawer.noModelsHint")}</small>}
          </section>

          <section>
            <h3>{t("companySettings.agentDrawer.instructions")}</h3>
            <label><span>{t("companySettings.agentDrawer.systemInstruction")}</span><textarea rows={5} value={agentForm.systemInstruction} onChange={(event) => setAgentForm({ ...agentForm, systemInstruction: event.target.value })} /></label>
            <label><span>{t("companySettings.agentDrawer.promptGuidelines")}</span><textarea rows={4} value={agentForm.promptGuidelines} onChange={(event) => setAgentForm({ ...agentForm, promptGuidelines: event.target.value })} /></label>
            <label><span>{t("companySettings.agentDrawer.recommendedPrompts")}</span><textarea rows={4} placeholder={t("companySettings.agentDrawer.onePerLine")} value={agentForm.recommendedPrompts} onChange={(event) => setAgentForm({ ...agentForm, recommendedPrompts: event.target.value })} /></label>
          </section>

          <section>
            <h3>{t("companySettings.agentDrawer.toolsCapabilities")}</h3>
            <small className="company-field-hint">{t("companySettings.agentDrawer.toolsHint")}</small>
            <div className="company-tool-grid">
              {([{
                label: language === "uk" ? "Читання файлів" : "Project Read",
                ids: ["project.files.list", "project.files.read", "project.files.search"],
              }, {
                label: language === "uk" ? "Запис файлів" : "Project Write",
                ids: ["project.files.create", "project.files.write", "project.files.edit", "project.files.move", "project.files.delete"],
              }, {
                label: language === "uk" ? "Термінал" : "Terminal",
                ids: ["project.terminal.exec", "project.terminal.process"],
              }, {
                label: language === "uk" ? "Попередній перегляд" : "Preview",
                ids: ["project.preview.start", "project.preview.stop", "project.preview.status"],
              }, {
                label: "Git",
                ids: ["project.git.status", "project.git.diff", "project.git.log", "project.git.branch", "project.git.stage", "project.git.commit", "project.git.restore", "project.git.checkpoint", "project.git.restore_checkpoint", "project.git.push", "project.git.pr"],
              }, {
                label: language === "uk" ? "Деплой" : "Deploy",
                ids: ["project.deploy.publish", "project.deploy.status"],
              }, {
                label: language === "uk" ? "Browser QA" : "Browser QA",
                ids: ["project.qa.inspect", "project.qa.report"],
              }]).map((permission) => <label className="company-tool" key={permission.label}>
                <input type="checkbox" checked={permission.ids.every((id) => agentForm.tools.includes(id))} onChange={(event) => setAgentForm({
                  ...agentForm,
                  tools: event.target.checked
                    ? [...new Set([...agentForm.tools, ...permission.ids])]
                    : agentForm.tools.filter((id) => !permission.ids.includes(id)),
                })} />
                <span><strong>{permission.label}</strong></span>
              </label>)}
              {availableTools.filter((tool) => !tool.id.startsWith("project.files.") && !tool.id.startsWith("project.terminal.") && !tool.id.startsWith("project.preview.") && !tool.id.startsWith("project.git.") && !tool.id.startsWith("project.deploy.") && !tool.id.startsWith("project.qa.")).map((tool) => {
                const translated = translatedTool(t, tool);
                const isChecked = agentForm.tools.includes(tool.name) || agentForm.tools.includes(tool.id);
                return (
                  <label className="company-tool" key={tool.id} title={translated.description || translated.name}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(event) => {
                        const val = tool.id;
                        setAgentForm({
                          ...agentForm,
                          tools: event.target.checked
                            ? [...agentForm.tools.filter((item) => item !== tool.name && item !== tool.id), val]
                            : agentForm.tools.filter((item) => item !== tool.name && item !== tool.id),
                        });
                      }}
                    />
                    <span>
                      <strong>{translated.name}</strong>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section>
            <h3>{t("companySettings.agentDrawer.organization")}</h3>
            <label><span>{t("companySettings.agentDrawer.parentAgent")}</span><select value={agentForm.parentAgentId} onChange={(event) => setAgentForm({ ...agentForm, parentAgentId: event.target.value })}>
              <option value="">{t("companySettings.agentDrawer.noParent")}</option>{agents.filter((agent) => agent.id !== editingAgent?.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}  -  {agent.role}</option>)}
            </select></label>
            <label className="company-switch"><input type="checkbox" checked={agentForm.isActive} onChange={(event) => setAgentForm({ ...agentForm, isActive: event.target.checked })} /><span>{t("companySettings.agentDrawer.agentActive")}</span></label>
            {editingAgent && <button type="button" className="button-secondary" onClick={() => void setMainAgent(editingAgent.id)}>{t("companySettings.agentDrawer.setMainAgent")}</button>}
          </section>

          <footer>
            {editingAgent && <button type="button" className="danger-button" onClick={() => void deleteAgent()}>{t("companySettings.agentDrawer.deleteAgent")}</button>}
            <span />
            <button type="button" className="button-secondary" onClick={onClose}>{t("companySettings.agentDrawer.cancel")}</button>
            <button className="button-primary" disabled={saving}>{saving ? t("companySettings.agentDrawer.saving") : t("companySettings.agentDrawer.save")}</button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
