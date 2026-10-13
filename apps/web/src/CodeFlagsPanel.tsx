import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";

/**
 * C1a: Coding Agent feature-flag panel.
 *
 * Self-hosted installations enable the agent by default; hosted deployments retain dark launch. Every
 * mutation goes through the server (which enforces the owner/admin role, the security gate for stage
 * promotion and the audit journal). The UI never caches a decision: it re-reads the server state
 * after every change so a rolled-back or refused change is visible immediately.
 */

export type FlagStage = "off" | "internal" | "allowlist" | "percent" | "ga";
export type FlagScope = "global" | "company" | "user";

export interface CodeFlag {
  key: string;
  enabled: boolean;
  stage?: FlagStage;
  scope?: FlagScope;
  scopeId?: string | null;
  source?: string;
  rolloutPercent?: number;
  allowlist?: string[];
}

export interface CodeFlagsState {
  master: CodeFlag;
  flags: CodeFlag[];
  darkLaunch?: boolean;
  management?: { company: boolean; global: boolean };
}

export interface FlagHistoryEntry {
  id: string;
  flagKey: string;
  scope: FlagScope;
  scopeId?: string | null;
  previousValue?: unknown;
  nextValue?: unknown;
  actor?: string;
  createdAt?: string;
}

/** Sub-flags the plan defines; the server remains the source of truth for their state. */
export const CODE_SUB_FLAGS: readonly string[] = [
  "code.read", "code.write", "code.shell", "code.git", "code.subagents",
  "code.background_runs", "code.mounted_folder", "code.hooks", "code.mcp", "code.full_auto_sandbox",
  // C13: slash commands (stored prompt templates) and lazily loaded Skills. Added here as well as on the
  // server because `CODE_FLAG_KEY_PATTERN` is an allowlist and this panel's list is what an operator sees.
  "code.commands", "code.skills",
  "code.async_inbox", "code.async_processes",
  // Step 5: detached async sub-agents. Listed here as well as on the server because `CODE_FLAG_KEY_PATTERN` is
  // an allowlist and this list is what an operator can see and set.
  "code.async_subagents",
  "code.async_agent_control",
  "code.async_collect_barrier",
  "code.async_workspace",
  "code.repo_map", "code.session_resume", "code.rewind", "code.session_fork", "code.export",
  "code.model_profile.hosted-native-tools", "code.model_profile.hosted-native-tools-small-context", "code.model_profile.local-text-tools",
];

const STAGE_LABELS: Record<FlagStage, string> = { off: "off", internal: "internal", allowlist: "allowlist", percent: "percent", ga: "ga" };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & { code?: string; status?: number };
    error.code = result?.error?.code;
    error.status = response.status;
    throw error;
  }
  return result as T;
}

function flagErrorMessage(error: unknown, isUk: boolean): string {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  switch (code) {
    case "flag_admin_required":
      return isUk ? "Змінювати флаги може лише власник/адміністратор компанії." : "Only the company owner/admin can change flags.";
    case "gate_not_passed":
      return isUk
        ? "Просування етапу за межі internal заблоковано до проходження G1 і R1."
        : "Promoting a stage beyond internal is blocked until G1 and R1 pass.";
    case "flag_revision_conflict":
      return isUk ? "Флаг змінився в іншій сесії. Оновіть панель і спробуйте ще раз." : "The flag changed elsewhere. Refresh and retry.";
    case "invalid_flag_key":
      return isUk ? "Невідомий ключ флага." : "Unknown flag key.";
    case "feature_disabled":
      return isUk
        ? "Coding Agent вимкнено (History read-only): мутації недоступні, історія лишається доступною."
        : "Coding Agent is disabled (History read-only): mutations are unavailable, history stays available.";
    default:
      return error instanceof Error ? error.message : isUk ? "Запит не вдався" : "Request failed";
  }
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatWhen(value: string | undefined, isUk: boolean): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(isUk ? "uk-UA" : "en-US", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Reuses the existing `.status-pill` modifiers so the panel matches the rest of the app. */
function stagePillClass(stage: FlagStage | undefined): string {
  if (stage === "off" || stage === undefined) return "default";
  if (stage === "ga") return "verified";
  return "partial";
}

function enabledPillClass(enabled: boolean): string {
  return enabled ? "allowed" : "denied";
}

export function CodeFlagsPanel({ companyId, isUk, notify, onMasterEnabledChange, onSessionsSuspended }: {
  companyId: string;
  isUk: boolean;
  notify: (type: "success" | "error", message: string) => void;
  /** Reports the master flag upward so the page can switch to History read-only mode. */
  onMasterEnabledChange?: (enabled: boolean | null) => void;
  /** Called after a kill switch so the page reloads the session list. */
  onSessionsSuspended?: (count: number) => void;
}) {
  const [state, setState] = useState<CodeFlagsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<FlagScope>("global");
  const [history, setHistory] = useState<FlagHistoryEntry[]>([]);
  const [historyKey, setHistoryKey] = useState<string>("coding_agent.enabled");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const base = "/companies/" + encodeURIComponent(companyId);

  const load = useCallback(async () => {
    if (!companyId) { setState(null); onMasterEnabledChange?.(null); return; }
    setLoading(true);
    try {
      const body = await apiFetch<CodeFlagsState>(`${base}/code/flags`);
      setState(body);
      if (body.management && !body.management.global) setScope("company");
      setError(null);
      onMasterEnabledChange?.(body.master?.enabled ?? null);
    } catch (cause) {
      setError(flagErrorMessage(cause, isUk));
      onMasterEnabledChange?.(null);
    } finally { setLoading(false); }
  }, [base, companyId, isUk, onMasterEnabledChange]);

  useEffect(() => { void load(); }, [load]);

  const loadHistory = useCallback(async (key: string) => {
    if (!companyId) return;
    setHistoryLoading(true);
    try {
      const body = await apiFetch<{ history: FlagHistoryEntry[] }>(`${base}/code/flags/history?flagKey=${encodeURIComponent(key)}`);
      setHistory(body.history ?? []);
      setHistoryError(null);
    } catch (cause) {
      setHistoryError(flagErrorMessage(cause, isUk));
    } finally { setHistoryLoading(false); }
  }, [base, companyId, isUk]);

  const rows = useMemo(() => {
    const known = new Map((state?.flags ?? []).map((flag) => [flag.key, flag]));
    // Show every planned sub-flag even before the server has a row for it, plus any extra server rows.
    const keys = [...CODE_SUB_FLAGS, ...[...known.keys()].filter((key) => !CODE_SUB_FLAGS.includes(key))];
    return keys.map((key) => known.get(key) ?? { key, enabled: false, stage: "off" as FlagStage, scope: "global" as FlagScope, scopeId: null });
  }, [state]);

  const toggleFlag = useCallback(async (flag: CodeFlag, nextEnabled: boolean) => {
    setBusyKey(flag.key);
    try {
      await apiFetch(`${base}/code/flags`, {
        method: "PUT",
        body: JSON.stringify({
          scope, scopeId: scope === "company" ? companyId : undefined,
          flagKey: flag.key, enabled: nextEnabled,
          stage: nextEnabled ? (flag.stage && flag.stage !== "off" ? flag.stage : "internal") : "off",
        }),
      });
      notify("success", isUk
        ? `Флаг ${flag.key} ${nextEnabled ? "увімкнено" : "вимкнено"}.`
        : `Flag ${flag.key} ${nextEnabled ? "enabled" : "disabled"}.`);
      await load();
    } catch (cause) {
      notify("error", flagErrorMessage(cause, isUk));
    } finally { setBusyKey(null); }
  }, [base, companyId, isUk, load, notify, scope]);

  const killSwitch = useCallback(async () => {
    const agreed = await confirmModal({
      message: isUk
        ? "Вимикає Coding Agent, зупиняє активні сесії (suspended_by_flag) і очищає sandbox. Історія, Activity, Changes/diff, Export і Delete лишаються доступними."
        : "Disables the Coding Agent, stops active sessions (suspended_by_flag) and cleans up sandboxes. History, Activity, Changes/diff, Export and Delete stay available.",
      isDanger: true,
      confirmText: isUk ? "Kill switch" : "Kill switch",
    });
    if (!agreed) return;
    setBusyKey("coding_agent.enabled");
    try {
      const body = await apiFetch<{ flag: CodeFlag; suspendedSessions: number }>(`${base}/code/flags/kill-switch`, {
        method: "POST",
        body: JSON.stringify({ scope }),
      });
      notify("success", isUk
        ? `Coding Agent вимкнено. Зупинено сесій: ${body.suspendedSessions ?? 0}.`
        : `Coding Agent disabled. Sessions suspended: ${body.suspendedSessions ?? 0}.`);
      onSessionsSuspended?.(body.suspendedSessions ?? 0);
      await load();
    } catch (cause) {
      notify("error", flagErrorMessage(cause, isUk));
    } finally { setBusyKey(null); }
  }, [base, companyId, isUk, load, notify, onSessionsSuspended, scope]);

  const canManage = state?.management ? (scope === "global" ? state.management.global : state.management.company) : true;
  const master = state?.master;
  const darkLaunch = state?.darkLaunch === true || state?.master?.enabled === false;

  return (
    <section className="ds-section-title code-flags">
      <div>
        <h2>{isUk ? "Feature flags (експериментально)" : "Feature flags (experimental)"}</h2>
        <p className="ds-muted">
          {isUk
            ? "У self-hosted інсталяції Coding Agent ввімкнений відразу. Тут можна змінити доступність функцій."
            : "Coding Agent is enabled automatically on self-hosted installations. Manage feature availability here."}
        </p>
      </div>

      {error && <div className="data-studio-alert error" role="alert">{error}</div>}

      {darkLaunch && !error && (
        <div className="data-studio-alert info" role="status">
          {isUk
            ? "Coding Agent у dark launch: розділ прихований для користувачів, мутації повертають feature_disabled."
            : "The Coding Agent is in dark launch: the section is hidden from users and mutations return feature_disabled."}
        </div>
      )}

      <div className="code-flags-scope">
        <label className="ds-toolbar-field">
          <span>{isUk ? "Область зміни" : "Change scope"}</span>
          <select className="page-size-select" value={scope} onChange={(event) => setScope(event.target.value as FlagScope)}>
            <option value="company">{isUk ? "Компанія" : "Company"}</option>
            <option value="global" disabled={state?.management?.global === false}>{isUk ? "Глобально" : "Global"}</option>
          </select>
        </label>
        {scope === "global" && (
          <span className="code-flags-warning">
            {isUk ? "Глобальна зміна впливає на всі компанії." : "A global change affects every company."}
          </span>
        )}
        <button type="button" className="button-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? (isUk ? "Оновлення…" : "Refreshing…") : isUk ? "Оновити флаги" : "Refresh flags"}
        </button>
      </div>

      <div className="code-flags-master">
        <div className="code-flags-master-main">
          <strong><code>{master?.key ?? "coding_agent.enabled"}</code></strong>
          <span className="ds-muted">
            {isUk ? "Master kill switch для всього Coding Agent" : "Master kill switch for the whole Coding Agent"}
          </span>
          <div className="code-flags-pills">
            <span className={`status-pill ${enabledPillClass(master?.enabled === true)}`}>
              {master?.enabled ? (isUk ? "увімкнено" : "enabled") : isUk ? "вимкнено" : "disabled"}
            </span>
            {master?.stage && <span className={`status-pill ${stagePillClass(master.stage)}`}>{STAGE_LABELS[master.stage]}</span>}
            {master?.scope && <span className="data-studio-badge">{master.scope}</span>}
            {master?.source && <span className="ds-muted">{master.source}</span>}
          </div>
        </div>
        <div className="code-flags-master-actions">
          <label className="code-switch" title={isUk ? "Увімкнути або вимкнути Coding Agent" : "Enable or disable the Coding Agent"}>
            <input
              type="checkbox"
              checked={master?.enabled === true}
              disabled={busyKey === "coding_agent.enabled" || !master || !canManage}
              onChange={(event) => master && void toggleFlag(master, event.target.checked)}
            />
            <span>{isUk ? "Master" : "Master"}</span>
          </label>
          <button
            type="button"
            className="automation-action-btn danger"
            disabled={busyKey === "coding_agent.enabled" || !companyId || !canManage}
            onClick={() => void killSwitch()}
          >
            {isUk ? "Kill switch" : "Kill switch"}
          </button>
        </div>
      </div>

      <div className="automations-table-container">
        <table className="automations-table">
          <thead>
            <tr>
              <th>{isUk ? "Флаг" : "Flag"}</th>
              <th>{isUk ? "Стан" : "State"}</th>
              <th>{isUk ? "Етап" : "Stage"}</th>
              <th>{isUk ? "Область" : "Scope"}</th>
              <th>{isUk ? "Джерело" : "Source"}</th>
              <th aria-label={isUk ? "Перемикач" : "Toggle"} />
            </tr>
          </thead>
          <tbody>
            {rows.map((flag) => (
              <tr key={flag.key}>
                <td><code>{flag.key}</code></td>
                <td>
                  <span className={`status-pill ${enabledPillClass(flag.enabled)}`}>
                    {flag.enabled ? (isUk ? "увімкнено" : "enabled") : isUk ? "вимкнено" : "disabled"}
                  </span>
                </td>
                <td><span className={`status-pill ${stagePillClass(flag.stage)}`}>{flag.stage ? STAGE_LABELS[flag.stage] : "off"}</span></td>
                <td className="ds-muted">{flag.scope ?? "global"}{flag.scopeId ? ` · ${String(flag.scopeId).slice(0, 8)}` : ""}</td>
                <td className="ds-muted">{flag.source ?? "default"}</td>
                <td className="automation-actions-cell">
                  <label className="code-switch" title={flag.enabled ? (isUk ? "Вимкнути" : "Disable") : isUk ? "Увімкнути" : "Enable"}>
                    <input
                      type="checkbox"
                      checked={flag.enabled}
                      disabled={busyKey === flag.key || !canManage}
                      onChange={(event) => void toggleFlag(flag, event.target.checked)}
                    />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details
        className="code-limits"
        onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadHistory(historyKey); }}
      >
        <summary>{isUk ? "Історія змін флагів" : "Flag change history"}</summary>
        <div className="code-flags-scope">
          <label className="ds-toolbar-field">
            <span>{isUk ? "Флаг" : "Flag"}</span>
            <select className="page-size-select" value={historyKey} onChange={(event) => { setHistoryKey(event.target.value); void loadHistory(event.target.value); }}>
              <option value="coding_agent.enabled">coding_agent.enabled</option>
              {rows.map((flag) => <option key={flag.key} value={flag.key}>{flag.key}</option>)}
            </select>
          </label>
        </div>
        {historyError && <p className="ds-hint-error">{historyError}</p>}
        {historyLoading && <p className="ds-muted">{isUk ? "Завантаження…" : "Loading…"}</p>}
        {!historyLoading && history.length === 0 && !historyError && (
          <p className="ds-muted">{isUk ? "Змін ще не було." : "No changes recorded yet."}</p>
        )}
        {history.length > 0 && (
          <div className="automations-table-container">
            <table className="automations-table">
              <thead>
                <tr>
                  <th>{isUk ? "Хто" : "Actor"}</th>
                  <th>{isUk ? "Флаг" : "Flag"}</th>
                  <th>{isUk ? "Область" : "Scope"}</th>
                  <th>{isUk ? "Було → стало" : "Previous → next"}</th>
                  <th>{isUk ? "Коли" : "When"}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td><code>{entry.actor ?? "—"}</code></td>
                    <td>{entry.flagKey}</td>
                    <td className="ds-muted">{entry.scope}{entry.scopeId ? ` · ${String(entry.scopeId).slice(0, 8)}` : ""}</td>
                    <td><code>{valueSummary(entry.previousValue)}</code> → <code>{valueSummary(entry.nextValue)}</code></td>
                    <td className="ds-muted">{formatWhen(entry.createdAt, isUk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

export default CodeFlagsPanel;
