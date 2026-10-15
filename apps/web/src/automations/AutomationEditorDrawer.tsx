import type { FormEvent } from "react";
import { useTranslation } from "../i18n";
import type { Agent, CronPreset } from "./types";

export interface AutomationEditorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  editingId: string | null;
  formName: string;
  setFormName: (val: string) => void;
  formDescription: string;
  setFormDescription: (val: string) => void;
  formAgentId: string;
  setFormAgentId: (val: string) => void;
  formCron: string;
  setFormCron: (val: string) => void;
  formPrompt: string;
  setFormPrompt: (val: string) => void;
  agents: Agent[];
  presets: CronPreset[];
  saving: boolean;
  onSave: (e: FormEvent) => void;
  onDelete: (id: string) => void | Promise<void>;
}

export function AutomationEditorDrawer({
  isOpen,
  onClose,
  editingId,
  formName,
  setFormName,
  formDescription,
  setFormDescription,
  formAgentId,
  setFormAgentId,
  formCron,
  setFormCron,
  formPrompt,
  setFormPrompt,
  agents,
  presets,
  saving,
  onSave,
  onDelete,
}: AutomationEditorDrawerProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={onClose}>
      <aside className="company-drawer automations-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <span>{t("automations.editor.kicker")}</span>
            <h2>{editingId ? t("automations.editor.editTitle") : t("automations.editor.newTitle")}</h2>
          </div>
          <button
            type="button"
            className="automations-drawer-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <form onSubmit={onSave}>
          <section>
            <h3>{t("automations.editor.taskParamsHeading")}</h3>
            <label>
              <span>{t("automations.editor.taskNameLabel")}</span>
              <input
                required
                placeholder={t("automations.editor.taskNamePlaceholder")}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </label>
            <label>
              <span>{t("automations.editor.descLabel")}</span>
              <input
                placeholder={t("automations.editor.descPlaceholder")}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </label>
            <label>
              <span>{t("automations.editor.assignedAgentLabel")}</span>
              <select value={formAgentId} onChange={(e) => setFormAgentId(e.target.value)}>
                <option value="">{t("automations.editor.mainAgentDefault")}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role})
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>{t("automations.editor.schedulePresetsLabel")}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {presets.map((p) => (
                  <button
                    type="button"
                    key={p.cron}
                    className={`cron-preset-btn ${formCron === p.cron ? "active" : ""}`}
                    onClick={() => setFormCron(p.cron)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </label>

            <label>
              <span>{t("automations.editor.cronExpressionLabel")}</span>
              <input
                required
                placeholder="0 9 * * *"
                value={formCron}
                onChange={(e) => setFormCron(e.target.value)}
                style={{ fontFamily: "monospace" }}
              />
            </label>

            <label>
              <span>{t("automations.editor.agentPromptLabel")}</span>
              <textarea
                required
                rows={5}
                placeholder={t("automations.editor.agentPromptPlaceholder")}
                value={formPrompt}
                onChange={(e) => setFormPrompt(e.target.value)}
              />
            </label>
          </section>

          <footer>
            {editingId && (
              <button type="button" className="danger-button" onClick={() => onDelete(editingId)}>
                {t("automations.editor.deleteBtn")}
              </button>
            )}
            <span />
            <button type="button" className="button-secondary" onClick={onClose}>
              {t("automations.editor.cancelBtn")}
            </button>
            <button className="button-primary automations-action-primary" disabled={saving}>
              {saving ? t("automations.editor.savingBtn") : t("automations.editor.saveBtn")}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
