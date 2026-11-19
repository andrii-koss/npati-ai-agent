import { ALL_COMPANIES } from "./company-scope";
import { useGoalsPage } from "./use-goals-page";
import { CompanyScopeSelect } from "./CompanyScopeSelect";
import { PageGuideLink } from "./PageGuideLink";
import { FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useWorkspace } from "./BusinessWorkspace";
import { useLinkedBusiness } from "./linked-business";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  type Goal,
  type GoalFormData,
  initialForm,
  api,
} from "./goals-types";
import { GoalsDrawer } from "./goals-drawer";

export type { Goal };

export function GoalsPage() {
  const { t, language } = useTranslation();
  const { overview, switchBusiness } = useWorkspace();
  useLinkedBusiness(overview, switchBusiness);
  const [scopeParams] = useSearchParams();
  const [companyScope, setCompanyScope] = useState(() => scopeParams.get("business") || ALL_COMPANIES);
  const scopedBusinessId = companyScope === ALL_COMPANIES ? undefined : companyScope;
  const selectCompanyTitle = scopedBusinessId ? undefined : t("automations.selectCompanyAria");
  const [notice, setNotice] = useState<string | null>(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "completed">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | "1" | "2" | "3">("all");

  // Drawer State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [form, setForm] = useState<GoalFormData>(initialForm);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) { setSearch(""); return; }
    const timer = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { page, counts: stats, failed, bottom, reload: loadGoals } = useGoalsPage({
    businessId: scopedBusinessId,
    status: statusFilter === "all" ? undefined : statusFilter,
    priority: priorityFilter === "all" ? undefined : Number(priorityFilter),
    search,
  }, message => setNotice(t("goalsPage.notices.failedToLoad", { message })));
  const goals = page?.goals ?? [];

  // Drawer handlers
  const openCreateDrawer = () => {
    if (!scopedBusinessId) return;
    setEditingGoal(null);
    setForm(initialForm);
    setDrawerOpen(true);
  };

  const openEditDrawer = (goal: Goal) => {
    setEditingGoal(goal);
    setForm({
      title: goal.title,
      description: goal.description || "",
      priority: String(goal.priority ?? 2),
      status: goal.status,
      targetValue: goal.targetValue !== null && goal.targetValue !== undefined ? String(goal.targetValue) : "",
      currentValue: goal.currentValue !== null && goal.currentValue !== undefined ? String(goal.currentValue) : "",
      targetUnit: goal.targetUnit || "",
      targetDate: goal.targetDate ? goal.targetDate.slice(0, 10) : "",
    });
    setDrawerOpen(true);
  };

  const saveGoal = async (e: FormEvent) => {
    e.preventDefault();
    const targetBusinessId = editingGoal?.businessId ?? scopedBusinessId;
    if (!targetBusinessId) return;

    if (!form.title.trim()) {
      setNotice(t("goalsPage.notices.titleRequired"));
      return;
    }

    setSaving(true);
    setNotice(null);

    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      priority: Number(form.priority),
      status: form.status,
      targetValue: form.targetValue.trim() !== "" ? Number(form.targetValue) : undefined,
      currentValue: form.currentValue.trim() !== "" ? Number(form.currentValue) : undefined,
      targetUnit: form.targetUnit.trim() || undefined,
      targetDate: form.targetDate ? form.targetDate : undefined,
    };

    try {
      if (editingGoal) {
        await api(`/businesses/${targetBusinessId}/goals/${editingGoal.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setNotice(t("goalsPage.notices.updatedSuccess", { title: payload.title }));
      } else {
        await api(`/businesses/${targetBusinessId}/goals`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setNotice(t("goalsPage.notices.createdSuccess", { title: payload.title }));
      }
      setDrawerOpen(false);
      await loadGoals();
    } catch (err: any) {
      setNotice(t("goalsPage.notices.failedToSave", { message: err.message }));
    } finally {
      setSaving(false);
    }
  };

  const deleteGoal = async (goal: Goal) => {
    const confirmed = await confirmModal({
      title: t("goalsPage.dialogs.deleteTitle"),
      message: t("goalsPage.dialogs.deleteMessage", { title: goal.title }),
      confirmText: t("goalsPage.dialogs.deleteConfirm"),
      cancelText: t("goalsPage.dialogs.deleteCancel"),
      isDanger: true,
    });
    if (!confirmed) return;

    try {
      await api(`/businesses/${goal.businessId}/goals/${goal.id}`, {
        method: "DELETE",
      });
      setNotice(t("goalsPage.notices.deletedSuccess", { title: goal.title }));
      await loadGoals();
    } catch (err: any) {
      setNotice(t("goalsPage.notices.failedToDelete", { message: err.message }));
    }
  };

  const updateGoalStatus = async (goal: Goal, newStatus: Goal["status"]) => {
    const statusLabels: Record<Goal["status"], string> = {
      active: t("goalsPage.statuses.active"),
      paused: t("goalsPage.statuses.paused"),
      completed: t("goalsPage.statuses.completed"),
      cancelled: t("goalsPage.statuses.cancelled"),
    };
    try {
      await api(`/businesses/${goal.businessId}/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setNotice(
        t("goalsPage.notices.statusUpdated", {
          title: goal.title,
          status: statusLabels[newStatus] || newStatus,
        })
      );
      await loadGoals();
    } catch (err: any) {
      setNotice(t("goalsPage.notices.statusUpdateError", { message: err.message }));
    }
  };

  // Helper for priority display
  const renderPriorityBadge = (priority: number) => {
    if (priority === 1) {
      return (
        <span className="goal-priority-badge high">
          <span className="priority-indicator red" />
          {t("goalsPage.priorityBadges.high")}
        </span>
      );
    }
    if (priority === 2) {
      return (
        <span className="goal-priority-badge normal">
          <span className="priority-indicator blue" />
          {t("goalsPage.priorityBadges.normal")}
        </span>
      );
    }
    return (
      <span className="goal-priority-badge low">
        <span className="priority-indicator gray" />
        {t("goalsPage.priorityBadges.low")}
      </span>
    );
  };

  // Helper for progress calculations
  const calculateProgress = (current?: number | null, target?: number | null) => {
    if (target === undefined || target === null || target <= 0) return null;
    const curr = current ?? 0;
    const percentage = Math.min(100, Math.max(0, Math.round((curr / target) * 100)));
    return { percentage, curr, target };
  };

  return (
    <main className="goals-container automations-container">
      {/* Header matching /automations & /settings/capabilities */}
      <header className="inspector-header automations-header goals-header">
        <div className="automations-header-top">
          <div>
            <p className="eyebrow">{t("goalsPage.eyebrow")}</p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label={t("goalsPage.backToSettings")}
                title={t("goalsPage.backToSettings")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <span>{t("goalsPage.title")}</span>
              <PageGuideLink guide="goals" />
            </h1>
            <p className="hero-copy">
              {t("goalsPage.heroCopy")}
            </p>
          </div>
          <div className="automations-header-actions">
            {(
              <CompanyScopeSelect
                className="business-scope-select"
                aria-label={t("nav.business")}
                value={companyScope}
                onValueChange={(value) => { setCompanyScope(value); if (value !== ALL_COMPANIES) void switchBusiness(value); }}
              >
                {overview?.businesses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}{overview?.businesses.some((other) => other.id !== item.id && other.name === item.name) ? ` ? ${item.id.slice(0, 8)}` : ""}
                  </option>
                ))}
              </CompanyScopeSelect>
            )}
            <button
              type="button"
              className="button-primary automations-action-primary goals-action-primary"
              onClick={openCreateDrawer}
              disabled={!scopedBusinessId}
              title={selectCompanyTitle}
            >
              {t("goalsPage.newGoal")}
            </button>
          </div>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /automations & /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid goals-stats-grid">
        <div>
          <strong>{stats?.total}</strong>
          <span>{t("goalsPage.stats.totalGoals")}</span>
          <small>{t("goalsPage.stats.totalGoalsDesc")}</small>
        </div>
        <div>
          <strong>{stats?.active}</strong>
          <span>{t("goalsPage.stats.activeOutcomes")}</span>
          <small>{t("goalsPage.stats.activeOutcomesDesc")}</small>
        </div>
        <div>
          <strong>{stats?.completed}</strong>
          <span>{t("goalsPage.stats.completedGoals")}</span>
          <small>{t("goalsPage.stats.completedGoalsDesc")}</small>
        </div>
        <div>
          <strong>{stats?.highPriority}</strong>
          <span>{t("goalsPage.stats.highPriority")}</span>
          <small>{t("goalsPage.stats.highPriorityDesc")}</small>
        </div>
      </section>

      {/* Search & Tabs Controls bar */}
      <div className="inspector-controls automations-controls goals-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder={t("goalsPage.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label={t("goalsPage.searchAria")}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label={t("goalsPage.clearSearch")}
              title={t("goalsPage.clearSearch")}
            >
              ×
            </button>
          )}
        </div>

        <div className="goals-controls-row">
          <div className="inspector-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === "all"}
              className={`inspector-tab ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              <span>{t("goalsPage.tabs.all")}</span>
              <small className="tab-count">{stats?.total}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === "active"}
              className={`inspector-tab ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              <span>{t("goalsPage.tabs.active")}</span>
              <small className="tab-count">{stats?.active}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === "paused"}
              className={`inspector-tab ${statusFilter === "paused" ? "active" : ""}`}
              onClick={() => setStatusFilter("paused")}
            >
              <span>{t("goalsPage.tabs.paused")}</span>
              <small className="tab-count">{stats?.paused}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === "completed"}
              className={`inspector-tab ${statusFilter === "completed" ? "active" : ""}`}
              onClick={() => setStatusFilter("completed")}
            >
              <span>{t("goalsPage.tabs.completed")}</span>
              <small className="tab-count">{stats?.completed}</small>
            </button>
          </div>

          <div className="goals-priority-filter">
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as any)}
              className="page-size-select goals-select"
              aria-label={t("goalsPage.filterByPriority")}
            >
              <option value="all">{t("goalsPage.priorities.all")}</option>
              <option value="1">{t("goalsPage.priorities.high")}</option>
              <option value="2">{t("goalsPage.priorities.normal")}</option>
              <option value="3">{t("goalsPage.priorities.low")}</option>
            </select>
          </div>
        </div>
      </div>

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      {/* Status summary */}
      <div className="inspector-table-status">
        <div className="status-left">
          <span>
            {page && stats && t("goalsPage.showingGoals", { count: goals.length, total: stats.total })}
            {page && search ? t("goalsPage.matchingQuery", { query: search }) : ""}
            {page && priorityFilter !== "all" ? ` (P${priorityFilter})` : ""}
          </span>
        </div>
      </div>

      {/* Main Content Area */}
      {!page ? (
        failed ? null : <div className="automations-table-container goals-table-container" style={{ minHeight: "220px" }} />
      ) : stats?.total === 0 ? (
        <div className="automations-empty-card goals-empty-card">
          <div className="automations-empty-icon">🎯</div>
          <h3>{t("goalsPage.empty.noGoalsTitle")}</h3>
          <p>
            {t("goalsPage.empty.noGoalsDesc")}
          </p>
          <button
            type="button"
            className="button-primary automations-action-primary goals-action-primary"
            onClick={openCreateDrawer}
            disabled={!scopedBusinessId}
            title={selectCompanyTitle}
          >
            {t("goalsPage.empty.createFirstGoal")}
          </button>
        </div>
      ) : goals.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>{t("goalsPage.empty.noMatchingTitle")}</h3>
          <p>{t("goalsPage.empty.noMatchingDesc")}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setPriorityFilter("all");
            }}
          >
            {t("goalsPage.empty.clearFilters")}
          </button>
        </div>
      ) : (
        <div className="automations-table-container goals-table-container">
          <table className="automations-table goals-table">
            <thead>
              <tr>
                <th style={{ width: "90px" }}>{t("goalsPage.table.status")}</th>
                <th>{t("goalsPage.table.goalAndOutcome")}</th>
                <th style={{ width: "135px" }}>{t("goalsPage.table.progress")}</th>
                <th style={{ width: "95px" }}>{t("goalsPage.table.priority")}</th>
                <th style={{ width: "100px" }}>{t("goalsPage.table.dueDate")}</th>
                <th style={{ width: "155px", textAlign: "right" }}>{t("goalsPage.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((goal) => {
                const progress = calculateProgress(goal.currentValue, goal.targetValue);
                const targetDate = goal.targetDate ? new Date(goal.targetDate) : null;
                const isOverdue = targetDate && goal.status === "active" && targetDate.getTime() < Date.now();

                return (
                  <tr key={goal.id}>
                    <td>
                      <button
                        type="button"
                        className={`automation-status-btn goal-status-btn ${goal.status}`}
                        onClick={() => {
                          if (goal.status === "active") updateGoalStatus(goal, "paused");
                          else if (goal.status === "paused") updateGoalStatus(goal, "active");
                          else updateGoalStatus(goal, "active");
                        }}
                        title={
                          goal.status === "active"
                            ? t("goalsPage.statusTooltips.pause")
                            : goal.status === "paused"
                            ? t("goalsPage.statusTooltips.resume")
                            : t("goalsPage.statusTooltips.reactivate")
                        }
                      >
                        <span className="automation-status-dot" />
                        {goal.status === "active"
                          ? t("goalsPage.statuses.active")
                          : goal.status === "paused"
                          ? t("goalsPage.statuses.paused")
                          : goal.status === "completed"
                          ? t("goalsPage.statuses.completed")
                          : t("goalsPage.statuses.cancelled")}
                      </button>
                    </td>
                    <td className="automation-title-cell goal-title-cell">
                      <strong
                        className="goal-title-link"
                        onClick={() => openEditDrawer(goal)}
                        title={t("goalsPage.editGoalTooltip")}
                      >
                        {goal.title}
                      </strong>
                      {goal.description && <p>{goal.description}</p>}
                      {goal.assignedAgent && (
                        <p className="goal-assigned-agent" data-testid="goal-assigned-agent">
                          {t("goalsPage.assignedAgent")}: {goal.assignedAgent.name}{goal.assignedAgent.role ? ` (${goal.assignedAgent.role})` : ""} · {goal.assignedAgent.companyName}
                        </p>
                      )}
                    </td>
                    <td>
                      {progress ? (
                        <div className="goal-progress-container">
                          <div className="goal-progress-header">
                            <span className="goal-progress-values">
                              {progress.curr} / {progress.target} {goal.targetUnit || ""}
                            </span>
                            <span className="goal-progress-pct">{progress.percentage}%</span>
                          </div>
                          <div className="goal-progress-track">
                            <div
                              className={`goal-progress-bar ${goal.status === "completed" ? "completed" : ""}`}
                              style={{ width: `${progress.percentage}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="goal-metric-untracked">{t("goalsPage.qualitativeGoal")}</span>
                      )}
                    </td>
                    <td>{renderPriorityBadge(goal.priority)}</td>
                    <td>
                      {targetDate ? (
                        <span className={`goal-date-badge ${isOverdue ? "overdue" : ""}`}>
                          {targetDate.toLocaleDateString(language, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          {isOverdue && <span className="overdue-tag">{t("goalsPage.overdue")}</span>}
                        </span>
                      ) : (
                        <span className="goal-no-date">—</span>
                      )}
                    </td>
                    <td>
                      <div className="goals-actions-cell">
                        {goal.status !== "completed" ? (
                          <button
                            type="button"
                            className="goal-btn goal-btn-complete"
                            onClick={() => updateGoalStatus(goal, "completed")}
                            title={t("goalsPage.actions.markCompleted")}
                          >
                            {t("goalsPage.actions.done")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="goal-btn goal-btn-reopen"
                            onClick={() => updateGoalStatus(goal, "active")}
                            title={t("goalsPage.actions.reopenTitle")}
                          >
                            {t("goalsPage.actions.reopen")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="goal-btn goal-btn-edit"
                          onClick={() => openEditDrawer(goal)}
                          title={t("goalsPage.actions.editTitle")}
                        >
                          {t("goalsPage.actions.edit")}
                        </button>
                        <button
                          type="button"
                          className="goal-btn goal-btn-delete"
                          onClick={() => deleteGoal(goal)}
                          title={t("goalsPage.actions.deleteTitle")}
                        >
                          {t("goalsPage.actions.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {page?.nextCursor && <div ref={bottom} aria-hidden="true" style={{ height: 1 }} />}

      {/* Slide-over Drawer for Create / Edit Goal */}
      <GoalsDrawer
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        editingGoal={editingGoal}
        form={form}
        setForm={setForm}
        saveGoal={saveGoal}
        saving={saving}
        t={t}
      />
    </main>
  );
}
