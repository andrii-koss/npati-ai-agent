import { useCallback, useEffect, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

/**
 * C8 — project trust control.
 *
 * This component exists because trust was unreachable: the service, the RBAC actions and the audit path were all
 * implemented, but nothing exposed a way to grant or revoke trust, so every "after the user trusts the project"
 * behaviour was dead in production while looking finished in the source.
 *
 * Two details are deliberate:
 *
 * - **The revision is read, shown and echoed.** `expectedRevision` is not decoration: trust that silently
 *   survives a change to the instruction file is trust given to content nobody reviewed. The endpoint refuses a
 *   stale revision with 409, and this panel shows that refusal rather than retrying blindly.
 * - **Only `http(s)` is ever rendered as text.** Everything from the server (reason, actor) is placed in a text
 *   node — never `dangerouslySetInnerHTML` — because the trust record is data about a repository the user may
 *   not control.
 */

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getStoredAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

interface TrustState {
  trusted: boolean;
  revision: number;
  trustedBy?: string;
  trustedAt?: string;
}

export function CodeTrustPanel({ companyId, projectId, isUk }: { companyId: string; projectId: string; isUk: boolean }) {
  const [state, setState] = useState<TrustState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/code/trust`;

  const load = useCallback(async () => {
    if (!companyId || !projectId) return;
    setError(null);
    try {
      const response = await apiFetch(base);
      const body = (await response.json()) as { trust?: TrustState; error?: { message?: string; code?: string } };
      if (!response.ok) {
        setError(body?.error?.message ?? body?.error?.code ?? (isUk ? "Не вдалося прочитати довіру" : "Could not read trust"));
        setState(null);
        return;
      }
      setState(body.trust ?? { trusted: false, revision: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : isUk ? "Помилка мережі" : "Network error");
      setState(null);
    }
  }, [base, companyId, projectId, isUk]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (verb: "grant" | "revoke") => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(verb === "grant" ? base : `${base}/revoke`, {
        method: "POST",
        // The revision we inspected is what we echo back: if the project moved on, the server refuses instead of
        // applying a decision made about different content.
        body: JSON.stringify({ expectedRevision: state.revision }),
      });
      const body = (await response.json()) as { trust?: TrustState; error?: { message?: string; code?: string } };
      if (!response.ok) {
        setError(body?.error?.message ?? body?.error?.code ?? (isUk ? "Відмовлено" : "Refused"));
        // A revision conflict means our view is stale: re-read rather than retry the same write.
        await load();
        return;
      }
      setState(body.trust ?? state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : isUk ? "Помилка мережі" : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const trusted = state?.trusted === true;
  return (
    <div className="code-detail-row" data-testid="code-trust-panel">
      <div className="ds-section-title">{isUk ? "Довіра до проєкту" : "Project trust"}</div>
      <div className="code-detail-row">
        <span className={`data-studio-badge ${trusted ? "data-studio-badge-ok" : "data-studio-badge-warn"}`} data-testid="code-trust-status">
          {trusted ? (isUk ? "довірений" : "trusted") : isUk ? "не довірений" : "untrusted"}
        </span>
        <span className="code-detail-row-meta" data-testid="code-trust-revision">revision {state?.revision ?? 0}</span>
      </div>
      <p className="code-detail-row-meta">
        {isUk
          ? "Інструкції проєкту не можуть змінювати права, режим, список інструментів, політики чи hooks — ні до, ні після довіри."
          : "Project instructions can never change permissions, the session mode, the tool list, policies or hooks — before or after trust."}
      </p>
      <div className="code-detail-row">
        <button type="button" className="button-secondary" disabled={busy || trusted} onClick={() => void mutate("grant")}>
          {isUk ? "Довіряти проєкту" : "Trust this project"}
        </button>
        <button type="button" className="button-secondary" disabled={busy || !trusted} onClick={() => void mutate("revoke")}>
          {isUk ? "Відкликати довіру" : "Revoke trust"}
        </button>
      </div>
      {error ? <div className="data-studio-alert" data-testid="code-trust-error">{error}</div> : null}
    </div>
  );
}

export default CodeTrustPanel;
