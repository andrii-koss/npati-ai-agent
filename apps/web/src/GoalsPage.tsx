import { getStoredAuthToken } from "./AuthContext";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "./BusinessWorkspace";

export interface Goal {
  id: string;
  workspaceId: string;
  businessId: string;
  createdByUserId: string;
  title: string;
  description?: string;
  status: "active" | "completed" | "paused" | "cancelled";
  targetValue?: number | null;
  targetUnit?: string | null;
  currentValue?: number | null;
  targetDate?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

interface GoalFormData {
  title: string;
  description: string;
  priority: string;
  status: "active" | "completed" | "paused" | "cancelled";
  targetValue: string;
  currentValue: string;
  targetUnit: string;
  targetDate: string;
}

const initialForm: GoalFormData = {
  title: "",
  description: "",
  priority: "2",
  status: "active",
  targetValue: "",
  currentValue: "",
  targetUnit: "",
  targetDate: "",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`/api${url}`, {
    ...init,
    headers,
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("npati:unauthorized"));
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    const error = new Error(
      payload?.error?.message ?? `Request failed with HTTP ${response.status}`
    );
    throw error;
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function GoalsPage() {
  const { overview } = useWorkspace();
  const business = overview?.currentBusiness || overview?.businesses?.[0];

  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
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

  const businessId = business?.id;

  const loadGoals = async () => {
    if (!businessId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api<Goal[]>(`/businesses/${businessId}/goals`);
      setGoals(data);
    } catch (err: any) {
      setNotice(`Failed to load goals: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGoals();
  }, [businessId]);

  // Statistics calculation
  const stats = useMemo(() => {
    const total = goals.length;
    const active = goals.filter((g) => g.status === "active").length;
    const paused = goals.filter((g) => g.status === "paused").length;
    const completed = goals.filter((g) => g.status === "completed").length;
    const highPriority = goals.filter((g) => g.priority === 1).length;
    return { total, active, paused, completed, highPriority };
  }, [goals]);

  // Filtered goals
  const filteredGoals = useMemo(() => {
    return goals.filter((goal) => {
      // Status filter
      if (statusFilter !== "all" && goal.status !== statusFilter) {
        return false;
      }
      // Priority filter
      if (priorityFilter !== "all" && String(goal.priority) !== priorityFilter) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesTitle = goal.title.toLowerCase().includes(q);
        const matchesDesc = (goal.description || "").toLowerCase().includes(q);
        const matchesUnit = (goal.targetUnit || "").toLowerCase().includes(q);
        return matchesTitle || matchesDesc || matchesUnit;
      }
      return true;
    });
  }, [goals, statusFilter, priorityFilter, searchQuery]);

  // Drawer handlers
  const openCreateDrawer = () => {
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
    if (!businessId) return;

    if (!form.title.trim()) {
      setNotice("Goal title is required");
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
        await api(`/businesses/${businessId}/goals/${editingGoal.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setNotice(`Goal "${payload.title}" updated successfully.`);
      } else {
        await api(`/businesses/${businessId}/goals`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setNotice(`Goal "${payload.title}" created successfully.`);
      }
      setDrawerOpen(false);
      await loadGoals();
    } catch (err: any) {
      setNotice(`Failed to save goal: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteGoal = async (goal: Goal) => {
    if (!businessId) return;
    if (!confirm(`Are you sure you want to delete goal "${goal.title}"?`)) return;

    try {
      await api(`/businesses/${businessId}/goals/${goal.id}`, {
        method: "DELETE",
      });
      setNotice(`Goal "${goal.title}" deleted.`);
      await loadGoals();
    } catch (err: any) {
      setNotice(`Failed to delete goal: ${err.message}`);
    }
  };

  const updateGoalStatus = async (goal: Goal, newStatus: Goal["status"]) => {
    if (!businessId) return;
    try {
      await api(`/businesses/${businessId}/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setNotice(`Goal "${goal.title}" status updated to ${newStatus}.`);
      await loadGoals();
    } catch (err: any) {
      setNotice(`Status update error: ${err.message}`);
    }
  };

  // Helper for priority display
  const renderPriorityBadge = (priority: number) => {
    if (priority === 1) {
      return (
        <span className="goal-priority-badge high">
          <span className="priority-indicator red" />
          High P1
        </span>
      );
    }
    if (priority === 2) {
      return (
        <span className="goal-priority-badge normal">
          <span className="priority-indicator blue" />
          Normal P2
        </span>
      );
    }
    return (
      <span className="goal-priority-badge low">
        <span className="priority-indicator gray" />
        Low P3
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
            <p className="eyebrow">Settings · Goals</p>
            <h1>
              <Link
                to="/settings"
                className="marketplace-back-button"
                aria-label="Back to settings"
                title="Back to settings"
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
              <span>Goals & Objectives</span>
            </h1>
            <p className="hero-copy">
              Define measurable outcomes, metric targets, and priority milestones for autonomous AI agent alignment.
            </p>
          </div>
          <div className="automations-header-actions">
            <button
              type="button"
              className="button-primary automations-action-primary goals-action-primary"
              onClick={openCreateDrawer}
            >
              + New Goal
            </button>
          </div>
        </div>
      </header>

      {/* 4 Stat Overview Cards matching /automations & /settings/capabilities */}
      <section className="overview-grid inspector-stats-grid automations-stats-grid goals-stats-grid">
        <div>
          <strong>{stats.total}</strong>
          <span>total goals</span>
          <small>Defined business targets</small>
        </div>
        <div>
          <strong>{stats.active}</strong>
          <span>active outcomes</span>
          <small>In-flight agent priorities</small>
        </div>
        <div>
          <strong>{stats.completed}</strong>
          <span>completed goals</span>
          <small>Milestones achieved</small>
        </div>
        <div>
          <strong>{stats.highPriority}</strong>
          <span>high priority</span>
          <small>Critical P1 objectives</small>
        </div>
      </section>

      {/* Search & Tabs Controls bar */}
      <div className="inspector-controls automations-controls goals-controls">
        <div className="inspector-search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="text"
            role="searchbox"
            placeholder="Filter goals by title, description, or metric unit..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="inspector-search-input"
            aria-label="Filter goals"
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "all"}
            className={`inspector-tab ${statusFilter === "all" ? "active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            <span>All</span>
            <small className="tab-count">{goals.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "active"}
            className={`inspector-tab ${statusFilter === "active" ? "active" : ""}`}
            onClick={() => setStatusFilter("active")}
          >
            <span>Active</span>
            <small className="tab-count">{stats.active}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "paused"}
            className={`inspector-tab ${statusFilter === "paused" ? "active" : ""}`}
            onClick={() => setStatusFilter("paused")}
          >
            <span>Paused</span>
            <small className="tab-count">{stats.paused}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === "completed"}
            className={`inspector-tab ${statusFilter === "completed" ? "active" : ""}`}
            onClick={() => setStatusFilter("completed")}
          >
            <span>Completed</span>
            <small className="tab-count">{stats.completed}</small>
          </button>
        </div>

        <div className="goals-priority-filter">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as any)}
            className="page-size-select goals-select"
            aria-label="Filter by priority"
          >
            <option value="all">All Priorities</option>
            <option value="1">High Priority (P1)</option>
            <option value="2">Normal Priority (P2)</option>
            <option value="3">Low Priority (P3)</option>
          </select>
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
            Showing <strong>{filteredGoals.length}</strong> of <strong>{goals.length}</strong> goals
            {searchQuery ? ` matching "${searchQuery}"` : ""}
            {priorityFilter !== "all" ? ` (P${priorityFilter})` : ""}
          </span>
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="workspace-notice">Loading business goals & milestones...</div>
      ) : goals.length === 0 ? (
        <div className="automations-empty-card goals-empty-card">
          <div className="automations-empty-icon">🎯</div>
          <h3>No Goals Configured Yet</h3>
          <p>
            Define concrete business outcomes, metric targets, or strategic milestones for NPATI agents to prioritize in autonomous execution and chat recommendations.
          </p>
          <button
            type="button"
            className="button-primary automations-action-primary goals-action-primary"
            onClick={openCreateDrawer}
          >
            + Create First Goal
          </button>
        </div>
      ) : filteredGoals.length === 0 ? (
        <div className="automations-empty-card">
          <div className="automations-empty-icon">🔍</div>
          <h3>No matching goals</h3>
          <p>Try adjusting your search terms or filter selection to find what you're looking for.</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setPriorityFilter("all");
            }}
          >
            Clear Filters
          </button>
        </div>
      ) : (
        <div className="automations-table-container goals-table-container">
          <table className="automations-table goals-table">
            <thead>
              <tr>
                <th style={{ width: "90px" }}>Status</th>
                <th>Goal & Outcome</th>
                <th style={{ width: "135px" }}>Progress</th>
                <th style={{ width: "95px" }}>Priority</th>
                <th style={{ width: "100px" }}>Due Date</th>
                <th style={{ width: "155px", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredGoals.map((goal) => {
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
                            ? "Click to Pause"
                            : goal.status === "paused"
                            ? "Click to Resume"
                            : "Click to Reactivate"
                        }
                      >
                        <span className="automation-status-dot" />
                        {goal.status.toUpperCase()}
                      </button>
                    </td>
                    <td className="automation-title-cell goal-title-cell">
                      <strong
                        className="goal-title-link"
                        onClick={() => openEditDrawer(goal)}
                        title="Click to edit goal"
                      >
                        {goal.title}
                      </strong>
                      {goal.description && <p>{goal.description}</p>}
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
                        <span className="goal-metric-untracked">Qualitative goal</span>
                      )}
                    </td>
                    <td>{renderPriorityBadge(goal.priority)}</td>
                    <td>
                      {targetDate ? (
                        <span className={`goal-date-badge ${isOverdue ? "overdue" : ""}`}>
                          {targetDate.toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          {isOverdue && <span className="overdue-tag">Overdue</span>}
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
                            title="Mark goal as completed"
                          >
                            ✓ Done
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="goal-btn goal-btn-reopen"
                            onClick={() => updateGoalStatus(goal, "active")}
                            title="Reopen goal"
                          >
                            Reopen
                          </button>
                        )}
                        <button
                          type="button"
                          className="goal-btn goal-btn-edit"
                          onClick={() => openEditDrawer(goal)}
                          title="Edit goal parameters"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="goal-btn goal-btn-delete"
                          onClick={() => deleteGoal(goal)}
                          title="Delete goal"
                        >
                          Delete
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

      {/* Slide-over Drawer for Create / Edit Goal */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer automations-drawer goals-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>Goals</span>
                <h2>{editingGoal ? "Edit Goal" : "New Goal"}</h2>
              </div>
              <button
                type="button"
                className="automations-drawer-close goals-drawer-close"
                aria-label="Close"
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
                <h3>Goal Objective</h3>
                <label>
                  <span>Goal Title *</span>
                  <input
                    type="text"
                    required
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="e.g., Acquire first 100 paying customers"
                  />
                </label>
                <label>
                  <span>Description / Success Criteria</span>
                  <textarea
                    rows={3}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="What does success look like? What specific outcomes are agents striving toward?"
                  />
                </label>
              </section>

              <section>
                <h3>Priority & Status</h3>
                <div className="goals-form-grid">
                  <label>
                    <span>Priority</span>
                    <select
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: e.target.value })}
                    >
                      <option value="1">High Priority (P1)</option>
                      <option value="2">Normal Priority (P2)</option>
                      <option value="3">Low Priority (P3)</option>
                    </select>
                  </label>
                  <label>
                    <span>Status</span>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                    >
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                </div>
              </section>

              <section>
                <h3>Metric Tracking (Optional)</h3>
                <p className="goals-form-hint">
                  Specify numeric targets if this goal can be measured and tracked quantitatively.
                </p>
                <div className="goals-form-grid-3">
                  <label>
                    <span>Target Value</span>
                    <input
                      type="number"
                      step="any"
                      value={form.targetValue}
                      onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
                      placeholder="e.g. 100"
                    />
                  </label>
                  <label>
                    <span>Current Value</span>
                    <input
                      type="number"
                      step="any"
                      value={form.currentValue}
                      onChange={(e) => setForm({ ...form, currentValue: e.target.value })}
                      placeholder="e.g. 42"
                    />
                  </label>
                  <label>
                    <span>Unit</span>
                    <input
                      type="text"
                      value={form.targetUnit}
                      onChange={(e) => setForm({ ...form, targetUnit: e.target.value })}
                      placeholder="e.g. $, users, %"
                    />
                  </label>
                </div>
              </section>

              <section>
                <h3>Target Due Date</h3>
                <label>
                  <span>Milestone Deadline</span>
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
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button-primary automations-action-primary goals-action-primary"
                  disabled={saving}
                >
                  {saving ? "Saving..." : editingGoal ? "Save Goal Changes" : "Create Goal"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}
