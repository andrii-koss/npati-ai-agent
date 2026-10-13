import React, { useEffect, useState, useCallback } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { DataStudioAuthSettingsTab } from "./data-studio-auth-settings-tab";
import type {
  GdprAffectedData,
  ProjectAccessPolicy,
  ProjectAuthSettings,
  ProjectAuthUser,
  ProjectAuthUserStatus,
} from "@npati/shared";

interface Props {
  companyId: string;
  projectId: string;
  environment: "dev" | "prod";
  collections: string[];
  isUk: boolean;
  notify: (msg: string, type?: "success" | "info" | "error") => void;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (!headers.has("Content-Type") && init?.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch("/api" + path, { ...init, headers });
  if (!res.ok) {
    let errMessage = `Request failed: ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error?.message) errMessage = body.error.message;
      else if (body?.message) errMessage = body.message;
    } catch {
      // ignore
    }
    throw new Error(errMessage);
  }
  return res.json() as Promise<T>;
}

export const DataStudioAuthSection: React.FC<Props> = ({
  companyId,
  projectId,
  environment,
  collections,
  isUk,
  notify,
}) => {
  const [subTab, setSubTab] = useState<"users" | "settings" | "permissions">("users");

  // Users State
  const [users, setUsers] = useState<ProjectAuthUser[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  // Settings State
  const [settings, setSettings] = useState<ProjectAuthSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [redirectUrls, setRedirectUrls] = useState("");
  const [savingRedirects, setSavingRedirects] = useState(false);
  const [rotatingKeys, setRotatingKeys] = useState(false);

  // Policies State
  const [policies, setPolicies] = useState<ProjectAccessPolicy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [applyingPolicies, setApplyingPolicies] = useState(false);

  // GDPR Delete Preview Modal State
  const [deleteModalUser, setDeleteModalUser] = useState<ProjectAuthUser | null>(null);
  const [deletePreview, setDeletePreview] = useState<GdprAffectedData | null>(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingUser, setDeletingUser] = useState(false);

  const basePath = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}/auth`;

  // --- Loaders ---
  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const q = new URLSearchParams();
      if (search.trim()) q.set("search", search.trim());
      if (statusFilter) q.set("status", statusFilter);
      const res = await apiFetch<{ users: ProjectAuthUser[]; total: number }>(`${basePath}/users?${q.toString()}`);
      setUsers(res.users);
      setUsersTotal(res.total);
    } catch (err: any) {
      notify(err.message || "Failed to load users", "error");
    } finally {
      setUsersLoading(false);
    }
  }, [basePath, search, statusFilter, notify]);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await apiFetch<ProjectAuthSettings>(`${basePath}/settings`);
      setSettings(res);
    } catch (err: any) {
      notify(err.message || "Failed to load settings", "error");
    } finally {
      setSettingsLoading(false);
    }
  }, [basePath, notify]);

  const loadRedirectUrls = useCallback(async () => {
    try {
      const res = await apiFetch<{ redirectUrls: string[] }>(`${basePath}/redirects`);
      setRedirectUrls((res.redirectUrls ?? []).join("\n"));
    } catch {
      setRedirectUrls("");
    }
  }, [basePath]);

  const loadPolicies = useCallback(async () => {
    setPoliciesLoading(true);
    try {
      const res = await apiFetch<ProjectAccessPolicy[]>(`${basePath}/policies`);
      // Ensure all collections have at least an entry
      const existingMap = new Map(res.map((p) => [p.collection, p]));
      const fullList: ProjectAccessPolicy[] = collections.map((col) => {
        return (
          existingMap.get(col) ?? {
            collection: col,
            rule: "public",
            ownerField: "owner_id",
            actions: ["all"],
          }
        );
      });
      setPolicies(fullList);
    } catch (err: any) {
      notify(err.message || "Failed to load policies", "error");
    } finally {
      setPoliciesLoading(false);
    }
  }, [basePath, collections, notify]);

  useEffect(() => {
    if (subTab === "users") void loadUsers();
    else if (subTab === "settings") { void loadSettings(); void loadRedirectUrls(); }
    else if (subTab === "permissions") void loadPolicies();
  }, [subTab, loadUsers, loadSettings, loadRedirectUrls, loadPolicies]);

  // --- User Handlers ---
  const handleToggleStatus = async (user: ProjectAuthUser) => {
    const nextStatus: ProjectAuthUserStatus = user.status === "active" ? "suspended" : "active";
    const ok = await confirmModal({
      title: isUk ? "Зміна статусу користувача" : "Change User Status",
      message: isUk
        ? `Ви впевнені, що хочете ${nextStatus === "suspended" ? "заблокувати" : "активувати"} ${user.email}?`
        : `Are you sure you want to ${nextStatus === "suspended" ? "suspend" : "activate"} ${user.email}?`,
      confirmText: isUk ? "Підтвердити" : "Confirm",
      isDanger: nextStatus === "suspended",
    });
    if (!ok) return;

    try {
      await apiFetch(`${basePath}/users/${encodeURIComponent(user.id)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      notify(isUk ? "Статус оновлено" : "Status updated");
      void loadUsers();
    } catch (err: any) {
      notify(err.message || "Failed to update status", "error");
    }
  };

  const handleEditRoles = async (user: ProjectAuthUser) => {
    const rolesStr = await promptModal({
      title: isUk ? "Редагування ролей" : "Edit User Roles",
      message: isUk
        ? "Введіть ролі користувача через кому (наприклад: user, member, admin):"
        : "Enter comma-separated roles (e.g. user, member, admin):",
      defaultValue: user.roles.join(", "),
      confirmText: isUk ? "Зберегти" : "Save",
    });
    if (rolesStr === null) return;

    const newRoles = rolesStr
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    try {
      await apiFetch(`${basePath}/users/${encodeURIComponent(user.id)}/roles`, {
        method: "PATCH",
        body: JSON.stringify({ roles: newRoles }),
      });
      notify(isUk ? "Ролі оновлено" : "Roles updated");
      void loadUsers();
    } catch (err: any) {
      notify(err.message || "Failed to update roles", "error");
    }
  };

  const handleExportData = async (user: ProjectAuthUser) => {
    try {
      const data = await apiFetch<any>(`${basePath}/users/${encodeURIComponent(user.id)}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `user-export-${user.id}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify(isUk ? "Дані експортовано" : "User data exported");
    } catch (err: any) {
      notify(err.message || "Failed to export data", "error");
    }
  };

  const handleOpenDeleteModal = async (user: ProjectAuthUser) => {
    setDeleteModalUser(user);
    setDeletePreview(null);
    setDeleteConfirmText("");
    setDeletePreviewLoading(true);
    try {
      const preview = await apiFetch<GdprAffectedData>(
        `${basePath}/users/${encodeURIComponent(user.id)}/delete/preview`,
        { method: "POST" },
      );
      setDeletePreview(preview);
    } catch (err: any) {
      notify(err.message || "Failed to load deletion preview", "error");
    } finally {
      setDeletePreviewLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteModalUser) return;
    if (deleteConfirmText.toLowerCase() !== "delete") {
      notify(isUk ? "Введіть 'delete' для підтвердження" : "Type 'delete' to confirm", "error");
      return;
    }
    setDeletingUser(true);
    try {
      await apiFetch(`${basePath}/users/${encodeURIComponent(deleteModalUser.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmed: true }),
      });
      notify(isUk ? "Користувача видалено згідно з GDPR" : "User deleted according to GDPR");
      setDeleteModalUser(null);
      void loadUsers();
    } catch (err: any) {
      notify(err.message || "Failed to delete user", "error");
    } finally {
      setDeletingUser(false);
    }
  };

  // --- Settings Handlers ---
  const handleSaveRedirectUrls = async () => {
    setSavingRedirects(true);
    try {
      await apiFetch(`${basePath}/redirects`, {
        method: "PUT",
        body: JSON.stringify({ redirectUrls: redirectUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }),
      });
      notify(isUk ? "Redirect URLs збережено" : "Redirect URLs saved");
      await loadRedirectUrls();
    } catch (err: any) {
      notify(err.message || "Failed to save redirect URLs", "error");
    } finally {
      setSavingRedirects(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      await apiFetch(`${basePath}/settings`, {
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      notify(isUk ? "Налаштування збережено" : "Settings saved");
    } catch (err: any) {
      notify(err.message || "Failed to save settings", "error");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRotateSigningKey = async () => {
    const ok = await confirmModal({
      title: isUk ? "Ротація ключів підпису JWT" : "Rotate JWT Signing Keys",
      message: isUk
        ? "Нові токени будуть підписуватися новим ключем. Старі сесії залишаться дійсними до закінчення TTL. Продовжити?"
        : "New tokens will be signed with the new key. Existing tokens will remain valid until TTL expiration. Proceed?",
      confirmText: isUk ? "Ротувати" : "Rotate",
    });
    if (!ok) return;

    setRotatingKeys(true);
    try {
      const res = await apiFetch<{ activeKid: string }>(`${basePath}/keys/rotate`, { method: "POST" });
      notify(isUk ? `Ключі оновлено (новий kid: ${res.activeKid})` : `Keys rotated (new kid: ${res.activeKid})`);
    } catch (err: any) {
      notify(err.message || "Failed to rotate keys", "error");
    } finally {
      setRotatingKeys(false);
    }
  };

  // --- Policies Handlers ---
  const handlePolicyChange = (index: number, patch: Partial<ProjectAccessPolicy>) => {
    setPolicies((prev) => {
      const next = [...prev];
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
  };

  const handleApplyPolicies = async () => {
    setApplyingPolicies(true);
    try {
      const res = await apiFetch<{ compiled: number; fingerprint: string }>(`${basePath}/policies`, {
        method: "PUT",
        body: JSON.stringify({ policies }),
      });
      notify(
        isUk
          ? `RLS-політики скомпільовано для ${res.compiled} колекцій`
          : `RLS policies compiled for ${res.compiled} collections`,
      );
    } catch (err: any) {
      notify(err.message || "Failed to apply policies", "error");
    } finally {
      setApplyingPolicies(false);
    }
  };

  return (
    <div className="data-studio-pane auth-pane">
      {/* Pane Subheader & Navigation */}
      <div className="pane-header">
        <div>
          <h2>🔐 {isUk ? "Керування автентифікацією (Project Auth)" : "Project Authentication"}</h2>
          <p>
            {isUk
              ? "Користувачі, ролі, налаштування входу та правила доступу (RLS) для створеного сайту"
              : "Manage end-users, roles, authentication policies, and PostgreSQL RLS permissions"}
          </p>
        </div>

        <div className="auth-subtabs" role="tablist">
          <button
            type="button"
            className={`subtab-btn ${subTab === "users" ? "active" : ""}`}
            onClick={() => setSubTab("users")}
          >
            👥 {isUk ? "Користувачі" : "Users"} ({usersTotal})
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "settings" ? "active" : ""}`}
            onClick={() => setSubTab("settings")}
          >
            ⚙️ {isUk ? "Налаштування" : "Settings"}
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "permissions" ? "active" : ""}`}
            onClick={() => setSubTab("permissions")}
          >
            🛡️ {isUk ? "Правила доступу (RLS)" : "Permissions (RLS)"}
          </button>
        </div>
      </div>

      {/* --- Tab 1: Users --- */}
      {subTab === "users" && (
        <div className="auth-content">
          <div className="auth-filters-bar">
            <div className="search-box">
              <input
                type="text"
                placeholder={isUk ? "Пошук за email…" : "Search users by email…"}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{isUk ? "Усі статуси" : "All statuses"}</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
            </select>
            <button type="button" className="button-secondary" onClick={() => void loadUsers()}>
              🔄 {isUk ? "Оновити" : "Refresh"}
            </button>
          </div>

          {usersLoading ? (
            <div className="auth-loading-state">
              <p>{isUk ? "Завантаження користувачів…" : "Loading users…"}</p>
            </div>
          ) : users.length === 0 ? (
            <div className="auth-empty-state">
              <p>{isUk ? "Користувачів ще немає." : "No project users found."}</p>
            </div>
          ) : (
            <div className="users-table-container">
              <table className="data-studio-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>{isUk ? "Статус" : "Status"}</th>
                    <th>{isUk ? "Ролі" : "Roles"}</th>
                    <th>{isUk ? "Верифікація" : "Verified"}</th>
                    <th>{isUk ? "Останній вхід" : "Last Login"}</th>
                    <th>{isUk ? "Дата реєстрації" : "Created"}</th>
                    <th>{isUk ? "Дії" : "Actions"}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.email}</strong>
                        <div className="user-id-sub">{u.id}</div>
                      </td>
                      <td>
                        <span className={`status-pill status-${u.status}`}>{u.status}</span>
                      </td>
                      <td>
                        <div className="role-pills">
                          {u.roles.map((r) => (
                            <span key={r} className="role-pill">
                              {r}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${u.emailVerified ? "badge-success" : "badge-warning"}`}>
                          {u.emailVerified ? "✓ Verified" : "Unverified"}
                        </span>
                      </td>
                      <td>
                        <small>{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "Never"}</small>
                      </td>
                      <td>
                        <small>{new Date(u.createdAt).toLocaleDateString()}</small>
                      </td>
                      <td>
                        <div className="table-actions">
                          <button
                            type="button"
                            className="button-secondary table-action-btn"
                            onClick={() => void handleToggleStatus(u)}
                            title={u.status === "active" ? "Suspend user" : "Activate user"}
                          >
                            {u.status === "active" ? "🚫" : "✅"}
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn"
                            onClick={() => void handleEditRoles(u)}
                            title={isUk ? "Змінити ролі" : "Edit roles"}
                          >
                            🏷️
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn"
                            onClick={() => void handleExportData(u)}
                            title={isUk ? "GDPR Експорт" : "GDPR Export"}
                          >
                            📥
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn danger"
                            onClick={() => void handleOpenDeleteModal(u)}
                            title={isUk ? "GDPR Видалення" : "GDPR Delete"}
                          >
                            🗑️
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* --- Tab 2: Settings --- */}
      {subTab === "settings" && (
        <DataStudioAuthSettingsTab
          settingsLoading={settingsLoading}
          settings={settings}
          setSettings={setSettings}
          isUk={isUk}
          rotatingKeys={rotatingKeys}
          handleRotateSigningKey={handleRotateSigningKey}
          redirectUrls={redirectUrls}
          setRedirectUrls={setRedirectUrls}
          savingRedirects={savingRedirects}
          handleSaveRedirectUrls={handleSaveRedirectUrls}
          savingSettings={savingSettings}
          handleSaveSettings={handleSaveSettings}
        />
      )}


      {/* --- Tab 3: Permissions (RLS Policies) --- */}
      {subTab === "permissions" && (
        <div className="auth-content">
          <div className="policies-header">
            <div>
              <h3>{isUk ? "Політики доступу на рівні рядків (PostgreSQL RLS)" : "Row-Level Security Policies"}</h3>
              <p>
                {isUk
                  ? "Налаштуйте, хто може читати та змінювати записи кожної колекції. Політики компілюються у PostgreSQL RLS з обов'язковими USING та WITH CHECK."
                  : "Configure who can read and modify rows in each collection. Policies are compiled into PostgreSQL RLS with strict USING and WITH CHECK constraints."}
              </p>
            </div>
            <button
              type="button"
              className="button-primary"
              disabled={applyingPolicies || policies.length === 0}
              onClick={() => void handleApplyPolicies()}
            >
              {applyingPolicies
                ? isUk
                  ? "Компіляція…"
                  : "Compiling…"
                : isUk
                ? "🛡️ Застосувати RLS-політики"
                : "🛡️ Apply & Compile RLS"}
            </button>
          </div>

          {policiesLoading ? (
            <div className="auth-loading-state">
              <p>{isUk ? "Завантаження політик…" : "Loading policies…"}</p>
            </div>
          ) : policies.length === 0 ? (
            <div className="auth-empty-state">
              <p>{isUk ? "У проєкті ще немає колекцій для налаштування політик." : "No collections in this project yet."}</p>
            </div>
          ) : (
            <div className="policies-list">
              {policies.map((p, idx) => (
                <div key={p.collection} className="policy-item-card">
                  <div className="policy-item-header">
                    <h4>📁 {p.collection}</h4>
                    <span className="policy-rule-badge">{p.rule}</span>
                  </div>

                  <div className="policy-controls-row">
                    <div className="form-group">
                      <label>{isUk ? "Рівень доступу" : "Access Rule"}</label>
                      <select
                        value={p.rule}
                        onChange={(e) => handlePolicyChange(idx, { rule: e.target.value as any })}
                      >
                        <option value="public">{isUk ? "Public (Публічний)" : "Public"}</option>
                        <option value="authenticated">{isUk ? "Authenticated (Будь-який увійшовший)" : "Authenticated"}</option>
                        <option value="owner">{isUk ? "Owner-based (Лише власник запису)" : "Owner-based"}</option>
                        <option value="role">{isUk ? "Role-based (За конкретною роллю)" : "Role-based"}</option>
                      </select>
                    </div>

                    {p.rule === "owner" && (
                      <div className="form-group">
                        <label>{isUk ? "Поле власника" : "Owner Field"}</label>
                        <input
                          type="text"
                          value={p.ownerField ?? "owner_id"}
                          onChange={(e) => handlePolicyChange(idx, { ownerField: e.target.value })}
                          placeholder="owner_id"
                        />
                      </div>
                    )}

                    {p.rule === "role" && (
                      <div className="form-group">
                        <label>{isUk ? "Необхідна роль" : "Required Role"}</label>
                        <input
                          type="text"
                          value={p.role ?? "admin"}
                          onChange={(e) => handlePolicyChange(idx, { role: e.target.value })}
                          placeholder="admin"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- GDPR Delete Preview Modal --- */}
      {deleteModalUser && (
        <div className="data-studio-modal-backdrop" role="dialog" aria-modal="true">
          <div className="data-studio-modal delete-modal">
            <h3>⚠️ {isUk ? "Видалення користувача за стандартом GDPR" : "GDPR User Deletion"}</h3>
            <p>
              {isUk
                ? `Видалення облікового запису ${deleteModalUser.email}. Перевірте дані, на які це вплине:`
                : `Deleting account for ${deleteModalUser.email}. Review the affected data summary:`}
            </p>

            {deletePreviewLoading ? (
              <p>{isUk ? "Аналіз залежностей…" : "Analyzing user dependencies…"}</p>
            ) : deletePreview ? (
              <div className="gdpr-affected-summary">
                <p>
                  <strong>{isUk ? "Загальна кількість пов'язаних записів:" : "Total Affected Records:"}</strong>{" "}
                  {deletePreview.totalAffectedRows}
                </p>
                {deletePreview.collections.length > 0 ? (
                  <ul className="affected-collections-list">
                    {deletePreview.collections.map((c) => (
                      <li key={c.collection}>
                        <code>{c.collection}</code>: <strong>{c.affectedRows}</strong> records &rarr; strategy:{" "}
                        <span className="strategy-tag">{c.strategy}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="no-affected-hint">
                    {isUk ? "Не знайдено пов'язаних записів у колекціях." : "No linked records in user collections."}
                  </p>
                )}
              </div>
            ) : null}

            <div className="confirm-delete-box">
              <label>
                {isUk
                  ? "Для підтвердження введіть слово 'delete':"
                  : "Type 'delete' to confirm deletion:"}
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="delete"
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={deletingUser}
                onClick={() => setDeleteModalUser(null)}
              >
                {isUk ? "Скасувати" : "Cancel"}
              </button>
              <button
                type="button"
                className="button-primary danger"
                disabled={deleteConfirmText.toLowerCase() !== "delete" || deletingUser}
                onClick={() => void handleConfirmDelete()}
              >
                {deletingUser ? (isUk ? "Видалення…" : "Deleting…") : isUk ? "Підтвердити видалення" : "Confirm Deletion"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
