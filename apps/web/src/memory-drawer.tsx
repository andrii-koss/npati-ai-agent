import React, { FormEvent } from "react";
import type { MemoryFormData, MemoryItem, MemoryType } from "./memory-types";

export interface MemoryDrawerProps {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  editingItem: MemoryItem | null;
  form: MemoryFormData;
  setForm: React.Dispatch<React.SetStateAction<MemoryFormData>>;
  formError: string | null;
  saving: boolean;
  saveMemoryForm: (e: FormEvent) => Promise<void>;
  t: (key: string, options?: any) => string;
}

export function MemoryDrawer({
  drawerOpen,
  setDrawerOpen,
  editingItem,
  form,
  setForm,
  formError,
  saving,
  saveMemoryForm,
  t,
}: MemoryDrawerProps) {
  if (!drawerOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
      <aside className="company-drawer automations-drawer memory-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <span>{t("memoryPage.drawer.eyebrow")}</span>
            <h2>{editingItem ? t("memoryPage.drawer.editTitle") : t("memoryPage.drawer.newTitle")}</h2>
          </div>
          <button
            type="button"
            className="automations-drawer-close"
            aria-label={t("memoryPage.drawer.closeAria")}
            onClick={() => setDrawerOpen(false)}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <form onSubmit={(e) => void saveMemoryForm(e)}>
          {formError && <div className="workspace-notice error">{formError}</div>}

          <section>
            <h3>{t("memoryPage.drawer.categorySection")}</h3>
            <label>
              <span>{t("memoryPage.drawer.typeLabel")}</span>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as MemoryType })}
                className="memory-drawer-select"
              >
                <option value="business_fact">{t("memoryPage.drawer.types.businessFact")}</option>
                <option value="audience">{t("memoryPage.drawer.types.audience")}</option>
                <option value="brand">{t("memoryPage.drawer.types.brand")}</option>
                <option value="decision">{t("memoryPage.drawer.types.decision")}</option>
                <option value="product">{t("memoryPage.drawer.types.product")}</option>
                <option value="channel">{t("memoryPage.drawer.types.channel")}</option>
                <option value="preference">{t("memoryPage.drawer.types.preference")}</option>
                <option value="experiment">{t("memoryPage.drawer.types.experiment")}</option>
                <option value="result">{t("memoryPage.drawer.types.result")}</option>
                <option value="other">{t("memoryPage.drawer.types.other")}</option>
              </select>
            </label>
          </section>

          <section>
            <h3>{t("memoryPage.drawer.detailsSection")}</h3>
            <label>
              <span>{t("memoryPage.drawer.titleLabel")}</span>
              <input
                type="text"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={t("memoryPage.drawer.titlePlaceholder")}
                className="memory-drawer-input"
              />
            </label>
            <label>
              <span>{t("memoryPage.drawer.contentLabel")}</span>
              <textarea
                rows={6}
                required
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder={t("memoryPage.drawer.contentPlaceholder")}
                className="memory-drawer-textarea"
              />
            </label>
          </section>

          <section>
            <h3>{t("memoryPage.drawer.confidenceSection")}</h3>
            <label>
              <span>{t("memoryPage.drawer.confidenceLabel")}</span>
              <select
                value={form.confidence}
                onChange={(e) => setForm({ ...form, confidence: e.target.value })}
                className="memory-drawer-select"
              >
                <option value="1.0">{t("memoryPage.drawer.confidenceOptions.high100")}</option>
                <option value="0.8">{t("memoryPage.drawer.confidenceOptions.med80")}</option>
                <option value="0.5">{t("memoryPage.drawer.confidenceOptions.low50")}</option>
              </select>
            </label>
          </section>

          <footer>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setDrawerOpen(false)}
              disabled={saving}
            >
              {t("memoryPage.drawer.cancel")}
            </button>
            <button
              type="submit"
              className="button-primary automations-action-primary"
              disabled={saving}
            >
              {saving
                ? t("memoryPage.drawer.saving")
                : editingItem
                ? t("memoryPage.drawer.saveChanges")
                : t("memoryPage.drawer.saveFact")}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
