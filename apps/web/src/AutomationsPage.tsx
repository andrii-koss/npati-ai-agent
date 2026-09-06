import { getStoredAuthToken } from "./AuthContext";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "./BusinessWorkspace";

interface Company {
  id: string;
  name: string;
  mainAgentId?: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface CompanyAutomation {
  id: string;
  workspaceId: string;
  companyId: string;
  agentId?: string | null;
  name: string;
  description?: string | null;
  prompt: string;
  cronExpression: string;
  timezone: string;
  status: "active" | "paused";
  lastRunAt?: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

interface CompanyAutomationRun {
  id: string;
  automationId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  startedAt: string;
  completedAt?: string | null;
}

const PRESETS = [
  { label: "Щодня о 09:00", cron: "0 9 * * *" },
  { label: "Щодня о 18:00", cron: "0 18 * * *" },
  { label: "Щопонеділка о 09:00", cron: "0 9 * * 1" },
  { label: "Щоп'ятниці о 17:00", cron: "0 17 * * 5" },
  { label: "Щогодини", cron: "0 * * * *" },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export function AutomationsPage() {
  const { overview } = useWorkspace();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [automations, setAutomations] = useState<CompanyAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // Editor Drawer State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formCron, setFormCron] = useState("0 9 * * *");
  const [formAgentId, setFormAgentId] = useState("");
  const [saving, setSaving] = useState(false);

  // Run History Drawer State
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyAutomation, setHistoryAutomation] = useState<CompanyAutomation | null>(null);
  const [runs, setRuns] = useState<CompanyAutomationRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningNowId, setRunningNowId] = useState<string | null>(null);

  // Load companies
  useEffect(() => {
    api<{ companies: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.companies);
        if (res.companies.length > 0 && !selectedCompanyId) {
          setSelectedCompanyId(res.companies[0]!.id);
        }
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load automations & agents when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    Promise.all([
      api<{ automations: CompanyAutomation[] }>(`/companies/${selectedCompanyId}/automations`),
      api<{ agents: Agent[] }>(`/companies/${selectedCompanyId}/agents`),
    ])
      .then(([autoRes, agentsRes]) => {
        setAutomations(autoRes.automations);
        setAgents(agentsRes.agents);
      })
      .catch((e) => setNotice(e.message))
      .finally(() => setLoading(false));
  }, [selectedCompanyId]);

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === selectedCompanyId),
    [companies, selectedCompanyId]
  );

  const openCreateDrawer = () => {
    setEditingId(null);
    setFormName("");
    setFormDescription("");
    setFormPrompt("");
    setFormCron("0 9 * * *");
    setFormAgentId(selectedCompany?.mainAgentId || "");
    setDrawerOpen(true);
  };

  const openEditDrawer = (auto: CompanyAutomation) => {
    setEditingId(auto.id);
    setFormName(auto.name);
    setFormDescription(auto.description || "");
    setFormPrompt(auto.prompt);
    setFormCron(auto.cronExpression);
    setFormAgentId(auto.agentId || "");
    setDrawerOpen(true);
  };

  const saveAutomation = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setSaving(true);
    setNotice(null);

    try {
      if (editingId) {
        const updated = await api<CompanyAutomation>(
          `/companies/${selectedCompanyId}/automations/${editingId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || null,
            }),
          }
        );
        setAutomations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      } else {
        const created = await api<CompanyAutomation>(
          `/companies/${selectedCompanyId}/automations`,
          {
            method: "POST",
            body: JSON.stringify({
              name: formName,
              description: formDescription,
              prompt: formPrompt,
              cronExpression: formCron,
              agentId: formAgentId || undefined,
            }),
          }
        );
        setAutomations((prev) => [created, ...prev]);
      }
      setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (auto: CompanyAutomation) => {
    const nextStatus = auto.status === "active" ? "paused" : "active";
    try {
      const updated = await api<CompanyAutomation>(
        `/companies/${selectedCompanyId}/automations/${auto.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      setAutomations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const deleteAutomation = async (id: string) => {
    if (!confirm("Ви впевнені, що хочете видалити цю автоматизацію?")) return;
    try {
      await api(`/companies/${selectedCompanyId}/automations/${id}`, { method: "DELETE" });
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      if (editingId === id) setDrawerOpen(false);
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const triggerRunNow = async (auto: CompanyAutomation) => {
    setRunningNowId(auto.id);
    setNotice(null);
    try {
      const res = await api<{ message?: string; result?: string }>(
        `/companies/${selectedCompanyId}/automations/${auto.id}/run`,
        { method: "POST" }
      );
      setNotice(`Запуск ініційовано для "${auto.name}". ${res.result ? "Результат отримано!" : ""}`);
    } catch (err: any) {
      setNotice(`Помилка запуску: ${err.message}`);
    } finally {
      setRunningNowId(null);
    }
  };

  const openHistory = async (auto: CompanyAutomation) => {
    setHistoryAutomation(auto);
    setHistoryDrawerOpen(true);
    setHistoryLoading(true);
    try {
      const res = await api<{ runs: CompanyAutomationRun[] }>(
        `/companies/${selectedCompanyId}/automations/${auto.id}/runs`
      );
      setRuns(res.runs);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <main className="company-page">
      <header className="company-page-header">
        <div className="page-heading settings-page-heading">
          <p className="eyebrow">Settings · Automations</p>
          <h1>Automations & Scheduled Tasks</h1>
          <p>Налаштуйте регулярні фонові задачі та cron-розклад для AI-агентів вашої компанії.</p>
        </div>
        <div className="company-header-actions">
          {companies.length > 1 && (
            <select
              aria-label="Select company"
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button className="button-primary" onClick={openCreateDrawer}>
            + New Automation
          </button>
        </div>
      </header>

      {notice && (
        <div className="workspace-notice" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      {loading ? (
        <div className="workspace-notice">Завантаження задач розкладу...</div>
      ) : (
        <div className="company-grid">
          <section className="company-run-card company-knowledge-card" style={{ gridColumn: "1 / -1" }}>
            <div className="company-section-heading">
              <div>
                <span>Background Tasks</span>
                <h2>Активні розклади та тригери</h2>
              </div>
              <small>Задачі виконуються у фоновому воркері через Main Agent або спеціалізованих агентів.</small>
            </div>

            {automations.length === 0 ? (
              <div style={{ padding: "32px 0", textAlign: "center", color: "var(--npati-gray-500)" }}>
                <p>Немає налаштованих автоматизацій для цієї компанії.</p>
                <button className="button-secondary" style={{ marginTop: 12 }} onClick={openCreateDrawer}>
                  Створити першу задачу
                </button>
              </div>
            ) : (
              <div className="company-knowledge-list">
                {automations.map((auto) => {
                  const assignedAgent = agents.find((a) => a.id === auto.agentId);
                  return (
                    <div
                      key={auto.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto auto auto auto auto",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <button
                        type="button"
                        className={`company-agent-avatar small ${auto.status === "active" ? "" : "inactive"}`}
                        onClick={() => toggleStatus(auto)}
                        title={auto.status === "active" ? "Поставити на паузу" : "Активувати"}
                        style={{
                          cursor: "pointer",
                          background: auto.status === "active" ? "#10b981" : "#9ca3af",
                          color: "white",
                          fontSize: 10,
                          fontWeight: "bold",
                        }}
                      >
                        {auto.status === "active" ? "ON" : "OFF"}
                      </button>

                      <div>
                        <strong>{auto.name}</strong>
                        {auto.description && <small style={{ display: "block" }}>{auto.description}</small>}
                        <small style={{ color: "var(--npati-gray-500)" }}>
                          Розклад: <code>{auto.cronExpression}</code> · Агент:{" "}
                          {assignedAgent ? assignedAgent.name : "Main Agent"} · Наступний запуск:{" "}
                          {new Date(auto.nextRunAt).toLocaleString()}
                        </small>
                      </div>

                      <button
                        className="button-secondary"
                        disabled={runningNowId === auto.id}
                        onClick={() => triggerRunNow(auto)}
                        title="Запустити негайно"
                      >
                        {runningNowId === auto.id ? "Running..." : "▶ Run Now"}
                      </button>

                      <button className="button-secondary" onClick={() => openHistory(auto)}>
                        History
                      </button>

                      <button className="button-secondary" onClick={() => openEditDrawer(auto)}>
                        Edit
                      </button>

                      <button className="danger-button" onClick={() => deleteAutomation(auto.id)}>
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Editor Drawer */}
      {drawerOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="company-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span>Automations</span>
                <h2>{editingId ? "Edit Automation" : "New Automation"}</h2>
              </div>
              <button aria-label="Close" onClick={() => setDrawerOpen(false)}>
                x
              </button>
            </header>
            <form onSubmit={saveAutomation}>
              <section>
                <h3>Параметри задачі</h3>
                <label>
                  <span>Назва задачі</span>
                  <input
                    required
                    placeholder="Наприклад: Щоденний аналіз конкурентів"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Короткий опис</span>
                  <input
                    placeholder="Для чого призначена задача"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                  />
                </label>
                <label>
                  <span>Призначений агент</span>
                  <select value={formAgentId} onChange={(e) => setFormAgentId(e.target.value)}>
                    <option value="">Main Agent (За замовчуванням)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.role})
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Швидкі пресети розкладу</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {PRESETS.map((p) => (
                      <button
                        type="button"
                        key={p.cron}
                        className={`button-secondary ${formCron === p.cron ? "active" : ""}`}
                        style={{ fontSize: 11, padding: "4px 8px" }}
                        onClick={() => setFormCron(p.cron)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </label>

                <label>
                  <span>Cron Expression (5 полів: хв год день місяць день_тижня)</span>
                  <input
                    required
                    placeholder="0 9 * * *"
                    value={formCron}
                    onChange={(e) => setFormCron(e.target.value)}
                  />
                </label>

                <label>
                  <span>Промпт завдання для агента</span>
                  <textarea
                    required
                    rows={5}
                    placeholder="Опишіть, що саме агент має зробити під час виконання..."
                    value={formPrompt}
                    onChange={(e) => setFormPrompt(e.target.value)}
                  />
                </label>
              </section>

              <footer>
                {editingId && (
                  <button type="button" className="danger-button" onClick={() => deleteAutomation(editingId)}>
                    Delete
                  </button>
                )}
                <span />
                <button type="button" onClick={() => setDrawerOpen(false)}>
                  Cancel
                </button>
                <button className="button-primary" disabled={saving}>
                  {saving ? "Saving..." : "Save Automation"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* Run History Drawer */}
      {historyDrawerOpen && historyAutomation && (
        <div className="company-drawer-backdrop" onMouseDown={() => setHistoryDrawerOpen(false)}>
          <aside className="company-drawer" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <header>
              <div>
                <span>Run History</span>
                <h2>{historyAutomation.name}</h2>
              </div>
              <button aria-label="Close" onClick={() => setHistoryDrawerOpen(false)}>
                x
              </button>
            </header>
            <section>
              {historyLoading ? (
                <p>Завантаження історії...</p>
              ) : runs.length === 0 ? (
                <p>Запусків ще не було.</p>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        padding: 12,
                        background: "#f9fafb",
                        borderRadius: 8,
                        border: "1px solid #e5e7eb",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <strong>
                          Статус: <span style={{ color: r.status === "completed" ? "#10b981" : "#ef4444" }}>{r.status}</span>
                        </strong>
                        <small>{new Date(r.startedAt).toLocaleString()}</small>
                      </div>
                      <small>Тривалість: {r.durationMs}ms</small>
                      {r.result && (
                        <div style={{ marginTop: 8, background: "white", padding: 8, borderRadius: 6, fontSize: 12 }}>
                          <strong>Результат:</strong>
                          <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{r.result}</p>
                        </div>
                      )}
                      {r.errorMessage && (
                        <div style={{ marginTop: 8, color: "#dc2626", fontSize: 12 }}>
                          <strong>Помилка:</strong> {r.errorMessage}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
