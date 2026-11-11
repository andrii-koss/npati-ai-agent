import React, { useEffect, useState, useCallback } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { DataStudioAuthSettingsTab } from "./data-studio-auth-settings-tab";
import { AuthUserBulkToolbar, useAuthUserBulkActions } from "./data-studio-auth-bulk-actions";
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
  const [usersLoading, setUsersLoading] = useState(true);
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

  const bulk = useAuthUserBulkActions({ basePath, search, statusFilter, users, usersTotal,
    isUk, api: apiFetch, reload: loadUsers, notify });

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
          <h2 style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span>{isUk ? "Керування автентифікацією (Project Auth)" : "Project Authentication"}</span>
          </h2>
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
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>{isUk ? "Користувачі" : "Users"} ({usersTotal})</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "settings" ? "active" : ""}`}
            onClick={() => setSubTab("settings")}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{isUk ? "Налаштування" : "Settings"}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "permissions" ? "active" : ""}`}
            onClick={() => setSubTab("permissions")}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>{isUk ? "Правила доступу (RLS)" : "Permissions (RLS)"}</span>
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
                disabled={bulk.busy}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select value={statusFilter} disabled={bulk.busy} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{isUk ? "Усі статуси" : "All statuses"}</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
            </select>
            <button type="button" className="button-secondary" disabled={bulk.busy || usersLoading} onClick={() => void loadUsers()} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
              <span>{isUk ? "Оновити" : "Refresh"}</span>
            </button>
          </div>

          <AuthUserBulkToolbar bulk={bulk} total={usersTotal} isUk={isUk} disabled={usersLoading} />
          {usersLoading ? (
            <div className="auth-loading-state" role="status" aria-label={isUk ? "Завантаження користувачів" : "Loading users"}>
              <div className="ds-table-spinner" aria-hidden="true" />
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
                    <th className="auth-user-selection-cell">
                      <input type="checkbox" aria-label={isUk ? "Вибрати видимих користувачів" : "Select displayed users"}
                        checked={bulk.allVisible} disabled={bulk.busy}
                        ref={input => { if (input) input.indeterminate = bulk.someVisible && !bulk.allVisible; }}
                        onChange={bulk.toggleVisible} />
                    </th>
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
                      <td className="auth-user-selection-cell">
                        <input type="checkbox" aria-label={`${isUk ? "Вибрати" : "Select"} ${u.email}`}
                          checked={bulk.selected.has(u.id)} disabled={bulk.busy} onChange={() => bulk.toggle(u.id)} />
                      </td>
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
                        <span className={u.emailVerified ? "auth-user-verified" : "badge badge-warning"}
                          aria-label={u.emailVerified ? (isUk ? "Email підтверджено" : "Email verified") : undefined}>
                          {u.emailVerified ? "✓" : "Unverified"}
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
                            disabled={bulk.busy}
                            title={u.status === "active" ? "Suspend user" : "Activate user"}
                            style={{ fontSize: "12px", padding: "4px 8px" }}
                          >
                            {u.status === "active" ? (isUk ? "Блок" : "Suspend") : (isUk ? "Актив" : "Activate")}
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn"
                            onClick={() => void handleEditRoles(u)}
                            disabled={bulk.busy}
                            title={isUk ? "Змінити ролі" : "Edit roles"}
                            style={{ fontSize: "12px", padding: "4px 8px" }}
                          >
                            {isUk ? "Ролі" : "Roles"}
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn"
                            onClick={() => void handleExportData(u)}
                            disabled={bulk.busy}
                            title={isUk ? "GDPR Експорт" : "GDPR Export"}
                            style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", padding: "4px 8px" }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            <span>GDPR</span>
                          </button>
                          <button
                            type="button"
                            className="button-secondary table-action-btn danger"
                            onClick={() => void handleOpenDeleteModal(u)}
                            disabled={bulk.busy}
                            title={isUk ? "GDPR Видалення" : "GDPR Delete"}
                            style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", padding: "4px 8px" }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
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
                ? "Застосувати RLS-політики"
                : "Apply & Compile RLS"}
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
                    <h4 style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#64748b" }}>
                        <rect width="18" height="18" x="3" y="3" rx="2" />
                        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                      </svg>
                      <span>{p.collection}</span>
                    </h4>
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
            <h3 style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#dc2626" }}>
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{isUk ? "Видалення користувача за стандартом GDPR" : "GDPR User Deletion"}</span>
            </h3>
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
