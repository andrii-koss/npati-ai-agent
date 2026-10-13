import React, { FormEvent } from "react";
import type { Goal, GoalFormData } from "./goals-types";

export interface GoalsDrawerProps {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  editingGoal: Goal | null;
  form: GoalFormData;
  setForm: React.Dispatch<React.SetStateAction<GoalFormData>>;
  saveGoal: (e: FormEvent) => void;
  saving: boolean;
  t: (key: string, options?: Record<string, string | number>) => string;
}

export function GoalsDrawer({
  drawerOpen,
  setDrawerOpen,
  editingGoal,
  form,
  setForm,
  saveGoal,
  saving,
  t,
}: GoalsDrawerProps) {
  if (!drawerOpen) return null;

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
      <aside className="company-drawer automations-drawer goals-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <span>{t("goalsPage.drawer.kicker")}</span>
            <h2>{editingGoal ? t("goalsPage.drawer.editGoal") : t("goalsPage.drawer.newGoal")}</h2>
          </div>
          <button
            type="button"
            className="automations-drawer-close goals-drawer-close"
            aria-label={t("goalsPage.drawer.close")}
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

        <form onSubmit={saveGoal}>
          <section>
            <h3>{t("goalsPage.drawer.objectiveSection")}</h3>
            <label>
              <span>{t("goalsPage.drawer.titleLabel")}</span>
              <input
                type="text"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={t("goalsPage.drawer.titlePlaceholder")}
              />
            </label>
            <label>
              <span>{t("goalsPage.drawer.descLabel")}</span>
              <textarea
                rows={3}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t("goalsPage.drawer.descPlaceholder")}
              />
            </label>
          </section>

          <section>
            <h3>{t("goalsPage.drawer.priorityStatusSection")}</h3>
            <div className="goals-form-grid">
              <label>
                <span>{t("goalsPage.drawer.priorityLabel")}</span>
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                >
                  <option value="1">{t("goalsPage.priorities.high")}</option>
                  <option value="2">{t("goalsPage.priorities.normal")}</option>
                  <option value="3">{t("goalsPage.priorities.low")}</option>
                </select>
              </label>
              <label>
                <span>{t("goalsPage.drawer.statusLabel")}</span>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as GoalFormData["status"] })}
                >
                  <option value="active">{t("goalsPage.statuses.active")}</option>
                  <option value="paused">{t("goalsPage.statuses.paused")}</option>
                  <option value="completed">{t("goalsPage.statuses.completed")}</option>
                  <option value="cancelled">{t("goalsPage.statuses.cancelled")}</option>
                </select>
              </label>
            </div>
          </section>

          <section>
            <h3>{t("goalsPage.drawer.metricSection")}</h3>
            <p className="goals-form-hint">
              {t("goalsPage.drawer.metricHint")}
            </p>
            <div className="goals-form-grid-3">
              <label>
                <span>{t("goalsPage.drawer.targetValueLabel")}</span>
                <input
                  type="number"
                  step="any"
                  value={form.targetValue}
                  onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
                  placeholder={t("goalsPage.drawer.targetValuePlaceholder")}
                />
              </label>
              <label>
                <span>{t("goalsPage.drawer.currentValueLabel")}</span>
                <input
                  type="number"
                  step="any"
                  value={form.currentValue}
                  onChange={(e) => setForm({ ...form, currentValue: e.target.value })}
                  placeholder={t("goalsPage.drawer.currentValuePlaceholder")}
                />
              </label>
              <label>
                <span>{t("goalsPage.drawer.unitLabel")}</span>
                <input
                  type="text"
                  value={form.targetUnit}
                  onChange={(e) => setForm({ ...form, targetUnit: e.target.value })}
                  placeholder={t("goalsPage.drawer.unitPlaceholder")}
                />
              </label>
            </div>
          </section>

          <section>
            <h3>{t("goalsPage.drawer.dueDateSection")}</h3>
            <label>
              <span>{t("goalsPage.drawer.deadlineLabel")}</span>
              <input
                type="date"
                value={form.targetDate}
                onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
              />
            </label>
          </section>

          <footer className="goals-drawer-footer" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setDrawerOpen(false)}
            >
              {t("goalsPage.drawer.cancel")}
            </button>
            <button
              type="submit"
              className="button-primary automations-action-primary goals-action-primary"
              disabled={saving}
            >
              {saving ? t("goalsPage.drawer.saving") : editingGoal ? t("goalsPage.drawer.saveChanges") : t("goalsPage.drawer.createGoal")}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
