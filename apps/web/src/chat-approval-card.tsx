import { useEffect, useState } from "react";
import { api } from "./business-workspace-shared";
import { useTranslation } from "./i18n";
import { approvalCopy, approvalToolLabel } from "./approval-i18n";
import { dataAutoAllowPath, saveDataAutoAllow, type DataAutoAllowView } from "./company/CompanyDataAutoAllow";

/** `[[npati-approval:<companyId>:<runId>:<approvalId>:<toolName>]]`, stored with the assistant reply so the card survives reloads. */
export const approvalLine = /^\[\[npati-approval:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9a-f-]{36}):([a-z0-9._-]+)\]\]$/i;

type Approval = { id: string; status: string; toolName: string; actionSummary?: string; runId?: string | null; expiresAt?: string | null; consumedAt?: string | null; inputPayload?: Record<string, unknown> };
type RunDetails = { run: { id: string; status: string; errorMessage?: string | null; result?: string | null } };


/**
 * Approves or rejects one durable approval of a chat operation, exactly as the Company page does: decide the approval,
 * then resume (or cancel) the run that waits on it. The server binds the approval to company, run, tool and payload and
 * accepts it once, so a reload, a second click or another run can never reuse it.
 */
export function ChatApprovalCard({ companyId, runId, approvalId, toolName, language: chatLanguage }: { companyId: string; runId: string; approvalId: string; toolName: string; language?: string | null }) {
  // The card speaks the language of the conversation; the interface language is the fallback.
  const { language } = useTranslation();
  const t = approvalCopy(chatLanguage || language);
  const statusText: Record<string, string> = { pending: t.pending, approved: t.approved, rejected: t.rejected, expired: t.expired, completed: t.completed, failed: t.failed, cancelled: t.cancelled };
  const [approval, setApproval] = useState<Approval | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextApproval, setNextApproval] = useState<Approval | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ approval: Approval }>(`/companies/${companyId}/approvals/${approvalId}`)
      .then((value) => { if (active) setApproval(value.approval); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    api<RunDetails>(`/companies/${companyId}/runs/${runId}`)
      .then((value) => { if (active) setRunStatus(value.run.status); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [companyId, runId, approvalId]);

  const decide = async (decision: "approved" | "rejected") => {
    if (busy || approval?.runId !== runId) return;
    setBusy(true); setError(null);
    try {
      const decided = decision === "approved" && approval.status === "approved" ? { approval } : await api<{ approval: Approval }>(`/companies/${companyId}/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
      setApproval(decided.approval);
      const next = decision === "approved"
        ? await api<RunDetails>(`/companies/${companyId}/runs/${runId}/resume`, { method: "POST", body: JSON.stringify({ approvalId }) })
        : await api<RunDetails>(`/companies/${companyId}/runs/${runId}/cancel`, { method: "POST" });
      setRunStatus(next.run.status);
      setResult(next.run.result ?? null);
      const pending = /Approval request ID: ([0-9a-f-]{36})/i.exec(next.run.errorMessage ?? "")?.[1];
      if (next.run.status === "awaiting_approval" && pending && pending !== approvalId) {
        const value = await api<{ approval: Approval }>(`/companies/${companyId}/approvals/${pending}`);
        if (value.approval.runId === runId) setNextApproval(value.approval);
      }
      if (next.run.status === "failed" && next.run.errorMessage) setError(next.run.errorMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  // The owner can stop these questions for the whole company; a git write still asks, so its card does not offer it.
  const [setting, setSetting] = useState<DataAutoAllowView | null>(null);
  const offersAlways = !/(^|\.)git(\.|$)/i.test(approval?.toolName ?? toolName);
  useEffect(() => {
    if (!offersAlways) return;
    void api<DataAutoAllowView>(dataAutoAllowPath(companyId)).then(setSetting).catch(() => undefined);
  }, [companyId, offersAlways]);
  const allowAlways = async () => {
    if (!setting || busy) return;
    try { setSetting(await saveDataAutoAllow(companyId, true, setting.revision)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    await decide("approved");
  };

  const status = runStatus && ["completed", "failed", "cancelled"].includes(runStatus) ? runStatus : approval?.status ?? "pending";
  const decidable = (approval?.status === "pending" || approval?.status === "approved") && approval.runId === runId && !approval.consumedAt && (!approval.expiresAt || Date.parse(approval.expiresAt) > Date.now()) && runStatus === "awaiting_approval" && !busy;
  return (
    <div className="chat-approval-card" data-status={status} role="group" aria-label={t.confirmTitle}>
      <div className="chat-approval-card-title">{t.confirmTitle}</div>
      <div className="chat-approval-card-action" title={approval?.toolName ?? toolName}>{approvalToolLabel(approval?.toolName ?? toolName, t)}</div>
      {approval?.inputPayload ? <pre className="chat-approval-resource">{JSON.stringify(Object.fromEntries(Object.entries(approval.inputPayload).filter(([key]) => ["projectId", "resourceId", "collection", "id", "ids", "path", "paths", "operation"].includes(key))), null, 2)}</pre> : null}
      <div className="chat-approval-card-status">{busy ? t.working : approval?.consumedAt && status === "approved" ? t.used : statusText[status] ?? status}</div>
      {decidable ? (
        <div className="chat-approval-card-actions">
          <button type="button" onClick={() => void decide("approved")}>{approval?.status === "approved" ? t.resume : t.approve}</button>
          <button type="button" className="secondary" onClick={() => void decide("rejected")}>{t.reject}</button>
          {offersAlways && setting?.canChange && !setting.autoAllow
            ? <button type="button" className="secondary" title={t.alwaysHint} onClick={() => void allowAlways()} data-testid="approval-always">{t.always}</button>
            : null}
        </div>
      ) : null}
      {result ? <pre className="chat-approval-result">{result}</pre> : null}
      {nextApproval ? <ChatApprovalCard companyId={companyId} runId={runId} approvalId={nextApproval.id} toolName={nextApproval.toolName} language={chatLanguage} /> : null}
      {error ? <div className="chat-approval-card-error" role="alert">{error}</div> : null}
    </div>
  );
}
