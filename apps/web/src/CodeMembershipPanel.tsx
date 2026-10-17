import React, { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

export interface CompanyMember {
  companyId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "readonly";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CodeMembershipPanelProps {
  companyId: string;
  isUk?: boolean;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & {
      code?: string;
      status?: number;
      details?: Record<string, unknown>;
    };
    error.code = result?.error?.code;
    error.status = response.status;
    error.details = result?.error?.details;
    throw error;
  }
  return result as T;
}

export function CodeMembershipPanel({ companyId, isUk = false }: CodeMembershipPanelProps) {
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string; details?: Record<string, unknown> } | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "readonly">("member");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ members: CompanyMember[]; roles: string[] }>(
        `/companies/${encodeURIComponent(companyId)}/code/members`,
      );
      setMembers(data.members || []);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: Record<string, unknown> };
      setError({
        message: e.message || (isUk ? "Не вдалося завантажити учасників" : "Failed to load members"),
        code: e.code,
        details: e.details,
      });
    } finally {
      setLoading(false);
    }
  }, [companyId, isUk]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const handleRoleChange = async (userId: string, currentRole: string, newRole: string, revision: number) => {
    if (newRole === currentRole) return;
    setBusyUserId(userId);
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch<{ member: CompanyMember }>(
        `/companies/${encodeURIComponent(companyId)}/code/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ role: newRole, expectedRevision: revision }),
        },
      );
      setSuccessMsg(isUk ? `Роль користувача оновлено на ${newRole}` : `User role updated to ${newRole}`);
      await fetchMembers();
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: Record<string, unknown> };
      setError({
        message: e.message || (isUk ? "Не вдалося оновити роль" : "Failed to update role"),
        code: e.code,
        details: e.details,
      });
    } finally {
      setBusyUserId(null);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    setGeneratedToken(null);
    try {
      const result = await apiFetch<{ inviteToken: string }>(
        `/companies/${encodeURIComponent(companyId)}/code/members/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        },
      );
      setGeneratedToken(result.inviteToken);
      setInviteEmail("");
      setSuccessMsg(isUk ? "Запрошення створено успішно" : "Invite created successfully");
      await fetchMembers();
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: Record<string, unknown> };
      setError({
        message: e.message || (isUk ? "Не вдалося створити запрошення" : "Failed to create invite"),
        code: e.code,
        details: e.details,
      });
    } finally {
      setLoading(false);
    }
  };

  // Derive current user role from stored or first member as fallback
  const currentMember = members[0];
  const currentRole = currentMember?.role ?? "member";

  return (
    <section
      className="browser-campaign-card code-membership-panel"
      aria-label={isUk ? "Керування ролями та доступом до коду" : "Code Membership and Role Management"}
      id="code-membership-panel"
    >
      <div className="browser-campaign-card-header">
        <div className="browser-card-title-group">
          <span className="browser-card-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <div>
            <h3>{isUk ? "Ролі та доступ до коду" : "Code Membership & Roles"}</h3>
            <p>
              {isUk
                ? "Керування ролями учасників компанії (C5a) та контроль доступу до коду."
                : "Manage company member roles (C5a) and control authorization for code operations."}
            </p>
          </div>
        </div>
      </div>

      {/* C5a.L0610.02: Current role badge & permissions summary */}
      <div
        id="current-role-banner"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "var(--npati-gray-50, #f9fafb)",
          borderRadius: "8px",
          border: "1px solid var(--npati-gray-200, #e5e7eb)",
          marginBottom: "16px",
        }}
      >
        <div>
          <span style={{ fontSize: "13px", color: "var(--npati-gray-600, #4b5563)", fontWeight: 500 }}>
            {isUk ? "Ваша поточна роль:" : "Your Current Role:"}{" "}
          </span>
          <strong
            id="current-role-badge"
            style={{
              display: "inline-block",
              marginLeft: "6px",
              padding: "2px 10px",
              borderRadius: "12px",
              fontSize: "12px",
              fontWeight: 700,
              textTransform: "uppercase",
              background: currentRole === "owner" ? "#fef3c7" : currentRole === "admin" ? "#e0e7ff" : "#f3f4f6",
              color: currentRole === "owner" ? "#92400e" : currentRole === "admin" ? "#3730a3" : "#374151",
            }}
          >
            {currentRole}
          </strong>
        </div>
        <span style={{ fontSize: "12px", color: "var(--npati-gray-500, #6b7280)" }}>
          {currentRole === "owner" || currentRole === "admin"
            ? (isUk ? "Повний доступ до коду та налаштувань" : "Full access to code and settings")
            : (isUk ? "Обмежений доступ (тільки читання/виконання)" : "Limited access (read/run only)")}
        </span>
      </div>

      {/* C5a.L0610.03: Structured Denial Reason / Refusal Error */}
      {error && (
        <div
          id="membership-denial-alert"
          role="alert"
          style={{
            padding: "12px 16px",
            marginBottom: "16px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            color: "#991b1b",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "13px" }}>
              {isUk ? "Помилка авторизації / Доступ відхилено" : "Authorization Denied / Operation Refused"}
            </strong>
            {error.code && (
              <code
                id="denial-code"
                style={{
                  background: "#fee2e2",
                  padding: "1px 6px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontFamily: "ui-monospace, monospace",
                  fontWeight: 600,
                }}
              >
                {error.code}
              </code>
            )}
          </div>
          <p id="denial-message" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
            {error.message}
          </p>
        </div>
      )}

      {successMsg && (
        <div
          id="membership-success-alert"
          style={{
            padding: "10px 14px",
            marginBottom: "16px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: "8px",
            color: "#166534",
            fontSize: "13px",
          }}
        >
          {successMsg}
        </div>
      )}

      {generatedToken && (
        <div
          id="generated-token-alert"
          style={{
            padding: "12px 16px",
            marginBottom: "16px",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "8px",
          }}
        >
          <strong style={{ fontSize: "13px", color: "#92400e" }}>
            {isUk ? "Токен запрошення (показано один раз):" : "Invite Token (shown once):"}
          </strong>
          <pre
            id="invite-token-display"
            style={{
              marginTop: "6px",
              padding: "8px",
              background: "#ffffff",
              border: "1px solid #fef3c7",
              borderRadius: "4px",
              fontSize: "12px",
              fontFamily: "ui-monospace, monospace",
              overflowX: "auto",
            }}
          >
            {generatedToken}
          </pre>
        </div>
      )}

      {/* C5a.L0610.01: Members List and Role Change Controls */}
      <div style={{ overflowX: "auto" }}>
        <table
          className="ds-table"
          id="members-table"
          style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}
        >
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--npati-gray-200, #e5e7eb)" }}>
              <th style={{ padding: "10px 12px" }}>{isUk ? "Користувач" : "User"}</th>
              <th style={{ padding: "10px 12px" }}>{isUk ? "Роль" : "Role"}</th>
              <th style={{ padding: "10px 12px" }}>{isUk ? "Ревізія" : "Revision"}</th>
              <th style={{ padding: "10px 12px" }}>{isUk ? "Дії" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && !loading && (
              <tr>
                <td colSpan={4} style={{ padding: "16px", textAlign: "center", color: "var(--npati-gray-500)" }}>
                  {isUk ? "Немає призначених учасників" : "No members found"}
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr
                key={m.userId}
                id={`member-row-${m.userId}`}
                style={{ borderBottom: "1px solid var(--npati-gray-100, #f3f4f6)" }}
              >
                <td style={{ padding: "10px 12px", fontFamily: "ui-monospace, monospace", fontWeight: 500 }}>
                  {m.userId}
                </td>
                <td style={{ padding: "10px 12px" }}>
                  <select
                    id={`role-select-${m.userId}`}
                    value={m.role}
                    disabled={busyUserId === m.userId || loading}
                    onChange={(e) => void handleRoleChange(m.userId, m.role, e.target.value, m.revision)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: "6px",
                      border: "1px solid var(--npati-gray-300, #d1d5db)",
                      fontSize: "12px",
                      background: "#ffffff",
                    }}
                  >
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                    <option value="readonly">readonly</option>
                  </select>
                </td>
                <td style={{ padding: "10px 12px", color: "var(--npati-gray-500)" }}>
                  r{m.revision}
                </td>
                <td style={{ padding: "10px 12px" }}>
                  <span style={{ fontSize: "11px", color: "var(--npati-gray-400)" }}>
                    {new Date(m.updatedAt || m.createdAt).toLocaleDateString()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Invite Member Section */}
      <form
        onSubmit={handleInvite}
        id="invite-member-form"
        style={{
          marginTop: "20px",
          padding: "16px",
          background: "var(--npati-gray-50, #f9fafb)",
          borderRadius: "8px",
          display: "flex",
          gap: "10px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "13px", fontWeight: 600 }}>
          {isUk ? "Запросити до коду:" : "Invite to Code:"}
        </span>
        <input
          type="email"
          id="invite-email-input"
          placeholder={isUk ? "Електронна пошта" : "colleague@example.com"}
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          required
          style={{
            padding: "6px 10px",
            borderRadius: "6px",
            border: "1px solid var(--npati-gray-300, #d1d5db)",
            fontSize: "13px",
            minWidth: "220px",
          }}
        />
        <select
          id="invite-role-select"
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as "admin" | "member" | "readonly")}
          style={{
            padding: "6px 10px",
            borderRadius: "6px",
            border: "1px solid var(--npati-gray-300, #d1d5db)",
            fontSize: "13px",
            background: "#ffffff",
          }}
        >
          <option value="admin">admin</option>
          <option value="member">member</option>
          <option value="readonly">readonly</option>
        </select>
        <button
          type="submit"
          id="invite-submit-btn"
          disabled={loading || !inviteEmail.trim()}
          style={{
            padding: "6px 14px",
            borderRadius: "6px",
            background: "var(--npati-black, #111827)",
            color: "#ffffff",
            fontWeight: 600,
            fontSize: "13px",
            border: "none",
            cursor: "pointer",
          }}
        >
          {isUk ? "Створити запрошення" : "Create Invite"}
        </button>
      </form>
    </section>
  );
}

export default CodeMembershipPanel;
