import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EmailPermissionKey } from "./EmailSettingsPage";
import { EMAIL_PERMISSION_OPTIONS } from "./EmailSettingsPage";

export interface EmailSettingsFooterBlockProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  createPermissionKey: any;
  permissionKeyName: string;
  setPermissionKeyName: Dispatch<SetStateAction<string>>;
  selectedEmailPermissions: string[];
  setSelectedEmailPermissions: Dispatch<SetStateAction<string[]>>;
  getPermissionLabel: any;
  savingPermissionKey: boolean;
  createdPermissionToken: string | null;
  notice: string | null;
  permissionKeys: EmailPermissionKey[];
  language: any;
  revokePermissionKey: any;
}

export function EmailSettingsFooterBlock({ t, createPermissionKey, permissionKeyName, setPermissionKeyName, selectedEmailPermissions, setSelectedEmailPermissions, getPermissionLabel, savingPermissionKey, createdPermissionToken, notice, permissionKeys, language, revokePermissionKey }: EmailSettingsFooterBlockProps) {
  return (
<div className="automations-table-container">
          <div style={{ padding: "20px", borderBottom: "1px solid #f1f5f9" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>{t("emailSettings.permissionsTab.scopedAccessTitle")}</h3>
            <p style={{ margin: "0 0 18px", color: "#64748b", fontSize: 12 }}>
              {t("emailSettings.permissionsTab.scopedAccessDesc")}
            </p>
            <form onSubmit={createPermissionKey} style={{ display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6, maxWidth: 460 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{t("emailSettings.permissionsTab.profileNameLabel")}</span>
                <input value={permissionKeyName} onChange={(event) => setPermissionKeyName(event.target.value)} required maxLength={120} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
                {EMAIL_PERMISSION_OPTIONS.map(([scope]) => (
                  <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selectedEmailPermissions.includes(scope)}
                      onChange={(event) => setSelectedEmailPermissions((current) => event.target.checked
                        ? [...current, scope]
                        : current.filter((permission) => permission !== scope))}
                    />
                    <span>{getPermissionLabel(scope)} <code style={{ color: "#64748b" }}>{scope}</code></span>
                  </label>
                ))}
              </div>
              <div>
                <button className="button-primary" disabled={savingPermissionKey || selectedEmailPermissions.length === 0}>
                  {savingPermissionKey ? t("emailSettings.permissionsTab.creatingKeyBtn") : t("emailSettings.permissionsTab.createKeyBtn")}
                </button>
              </div>
            </form>
            {createdPermissionToken && (
              <div className="workspace-notice" style={{ marginTop: 16 }}>
                {t("emailSettings.permissionsTab.tokenNotice")} <code style={{ wordBreak: "break-all" }}>{createdPermissionToken}</code>
              </div>
            )}
          </div>
          <table className="automations-table">
            <thead>
              <tr>
                <th>{t("emailSettings.permissionsTab.colName")}</th>
                <th>{t("emailSettings.permissionsTab.colGranted")}</th>
                <th>{t("emailSettings.permissionsTab.colLastUsed")}</th>
                <th style={{ textAlign: "right" }}>{t("emailSettings.permissionsTab.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {permissionKeys.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: 36, color: "#64748b" }}>{t("emailSettings.permissionsTab.empty")}</td></tr>
              ) : permissionKeys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><div><code>{key.keyPrefix}…</code></div></td>
                  <td>{key.scopes.map((scope) => <span key={scope} className="record-status" style={{ margin: "2px 4px 2px 0" }}>{scope.replace("email:", "")}</span>)}</td>
                  <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString(language === "uk" ? "uk-UA" : language) : t("emailSettings.permissionsTab.neverUsed")}</td>
                  <td style={{ textAlign: "right" }}><button type="button" className="automation-action-btn" onClick={() => void revokePermissionKey(key.id)}>{t("emailSettings.permissionsTab.actionRevoke")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
}
