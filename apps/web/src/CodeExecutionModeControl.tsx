import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";

export type CodeExecutionMode = "global" | "company" | "sandbox";
export interface CodeExecutionModeView {
  mode: CodeExecutionMode; revision: number; canSelectGlobal: boolean; creatorConfigured: boolean;
  creatorProjectId?: string; creatorSessionId?: string; sourceAccessGranted?: boolean;
}

export function CodeExecutionModeControl({ companyId, isUk, value, canManage, onChanged, notify }: {
  companyId: string; isUk: boolean; value?: CodeExecutionModeView; canManage: boolean;
  onChanged: () => Promise<void>; notify: (type: "success" | "error", message: string) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const mode = value?.mode ?? "company";
  const copy = isUk ? {
    global: "Вихідний код NPATI та інтерфейс усіх вкладок у Creator Workspace.",
    company: "Агенти компанії, чат, код-проєкти, sandbox і Data Studio.",
    sandbox: "Лише sandbox і Data Studio вибраного проєкту.",
  } : {
    global: "NPATI source code and the interface of every tab in Creator Workspace.",
    company: "Company agents, chat, code projects, sandbox and Data Studio.",
    sandbox: "Only the selected project's sandbox and Data Studio.",
  };
  const request = async (path: string, body?: unknown) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const token = getStoredAuthToken();
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetch("/api/companies/" + encodeURIComponent(companyId) + path,
      { method: body ? "PUT" : "POST", headers, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message ?? "Request failed");
    return result;
  };
  const change = async (next: CodeExecutionMode) => {
    if (!value || busy) return;
    setBusy(true);
    try {
      await request("/code/execution-mode", { mode: next, expectedRevision: value.revision });
      await onChanged();
      if (next === "global" && value.creatorConfigured && value.sourceAccessGranted) {
        await request("/code/creator-workspace");
        await onChanged();
      }
    } catch (error) { notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const openCreator = async () => {
    setBusy(true);
    try {
      const result = await request("/code/creator-workspace");
      navigate(result.workspaceUrl);
    } catch (error) { notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="code-execution-control">
      <label className="ds-toolbar-field">
        <span>{isUk ? "Режим доступу" : "Change scope"}</span>
        <select className="page-size-select" value={mode} disabled={busy || !value || !canManage}
          onChange={(event) => void change(event.target.value as CodeExecutionMode)}>
          <option value="global">Global</option>
          <option value="company">Company</option>
          <option value="sandbox">Sandbox / Data Studio</option>
        </select>
      </label>
      <p className="ds-muted">{copy[mode]}</p>
      {mode === "global" && (
        <div>
          {value?.creatorConfigured && !value.sourceAccessGranted && <p className="ds-muted">{isUk
            ? "Для роботи з вихідним кодом NPATI потрібен доступ власника цієї інсталяції."
            : "Access to NPATI source code requires authorization from this installation's owner."}</p>}
          {!value?.creatorConfigured && <p className="ds-muted">{isUk
            ? "Підключіть копію репозиторію NPATI до цієї інсталяції, щоб відкрити Creator Workspace."
            : "Connect an NPATI source checkout to this installation to open Creator Workspace."}</p>}
          <button type="button" className="button-primary" disabled={busy || !value?.creatorConfigured || !value.sourceAccessGranted}
            onClick={() => void openCreator()}>{busy ? (isUk ? "Відкриття…" : "Opening…") : (isUk ? "Відкрити Creator Workspace" : "Open Creator Workspace")}</button>
        </div>
      )}
    </div>
  );
}
