import { useEffect, useState } from "react";
import { api } from "./business-workspace-shared";
import { useTranslation } from "./i18n";
import { dataAutoAllowPath, saveDataAutoAllow, type DataAutoAllowView } from "./company/CompanyDataAutoAllow";

/** `[[npati-approval:<companyId>:<runId>:<approvalId>:<toolName>]]`, stored with the assistant reply so the card survives reloads. */
export const approvalLine = /^\[\[npati-approval:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9a-f-]{36}):([a-z0-9._-]+)\]\]$/i;

type Approval = { id: string; status: string; toolName: string; actionSummary?: string; runId?: string | null; expiresAt?: string | null; consumedAt?: string | null; inputPayload?: Record<string, unknown> };
type RunDetails = { run: { id: string; status: string; errorMessage?: string | null; result?: string | null } };

const copy: Record<string, Record<string, string>> = {
  en: { title: "Confirmation required", approve: "Approve", resume: "Continue", reject: "Reject", pending: "Waiting for your decision", approved: "Approved", rejected: "Rejected", expired: "Expired", completed: "Done", failed: "Failed", cancelled: "Cancelled", working: "Working…", used: "This confirmation was already used", always: "Allow and don't ask again", alwaysHint: "The agents of this company will act without asking (git writes still ask). You can turn this off in the company settings." },
  uk: { title: "Потрібне підтвердження", approve: "Підтвердити", reject: "Відхилити", pending: "Очікує вашого рішення", approved: "Підтверджено", rejected: "Відхилено", expired: "Термін минув", completed: "Виконано", failed: "Помилка", cancelled: "Скасовано", working: "Виконується…", used: "Це підтвердження вже використано", always: "Дозволити і більше не питати", alwaysHint: "Агенти цієї компанії діятимуть без підтвердження (запис у git і далі питатиме). Вимкнути можна в налаштуваннях компанії." },
  de: { title: "Bestätigung erforderlich", approve: "Bestätigen", reject: "Ablehnen", pending: "Wartet auf Ihre Entscheidung", approved: "Bestätigt", rejected: "Abgelehnt", expired: "Abgelaufen", completed: "Erledigt", failed: "Fehlgeschlagen", cancelled: "Abgebrochen", working: "Wird ausgeführt…", used: "Diese Bestätigung wurde bereits verwendet" },
  es: { title: "Se requiere confirmación", approve: "Aprobar", reject: "Rechazar", pending: "Esperando tu decisión", approved: "Aprobado", rejected: "Rechazado", expired: "Caducado", completed: "Hecho", failed: "Error", cancelled: "Cancelado", working: "Ejecutando…", used: "Esta confirmación ya se usó" },
  pt: { title: "Confirmação necessária", approve: "Aprovar", reject: "Rejeitar", pending: "Aguardando sua decisão", approved: "Aprovado", rejected: "Rejeitado", expired: "Expirado", completed: "Concluído", failed: "Falhou", cancelled: "Cancelado", working: "Executando…", used: "Esta confirmação já foi usada" },
};

/**
 * Approves or rejects one durable approval of a chat operation, exactly as the Company page does: decide the approval,
 * then resume (or cancel) the run that waits on it. The server binds the approval to company, run, tool and payload and
 * accepts it once, so a reload, a second click or another run can never reuse it.
 */
export function ChatApprovalCard({ companyId, runId, approvalId, toolName }: { companyId: string; runId: string; approvalId: string; toolName: string }) {
  const { language } = useTranslation();
  const t = copy[language] ?? copy.en!;
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
    <div className="chat-approval-card" data-status={status} role="group" aria-label={t.title}>
      <div className="chat-approval-card-title">{t.title}</div>
      <div className="chat-approval-card-action"><code>{approval?.toolName ?? toolName}</code>{approval?.actionSummary ? <span> {approval.actionSummary}</span> : null}</div>
      {approval?.inputPayload ? <pre className="chat-approval-resource">{JSON.stringify(Object.fromEntries(Object.entries(approval.inputPayload).filter(([key]) => ["projectId", "resourceId", "collection", "id", "ids", "path", "paths", "operation"].includes(key))), null, 2)}</pre> : null}
      <div className="chat-approval-card-status">{busy ? t.working : approval?.consumedAt && status === "approved" ? t.used : t[status] ?? status}</div>
      {decidable ? (
        <div className="chat-approval-card-actions">
          <button type="button" onClick={() => void decide("approved")}>{approval?.status === "approved" ? t.resume ?? copy.en!.resume : t.approve}</button>
          <button type="button" className="secondary" onClick={() => void decide("rejected")}>{t.reject}</button>
          {offersAlways && setting?.canChange && !setting.autoAllow
            ? <button type="button" className="secondary" title={t.alwaysHint ?? copy.en!.alwaysHint} onClick={() => void allowAlways()} data-testid="approval-always">{t.always ?? copy.en!.always}</button>
            : null}
        </div>
      ) : null}
      {result ? <pre className="chat-approval-result">{result}</pre> : null}
      {nextApproval ? <ChatApprovalCard companyId={companyId} runId={runId} approvalId={nextApproval.id} toolName={nextApproval.toolName} /> : null}
      {error ? <div className="chat-approval-card-error" role="alert">{error}</div> : null}
    </div>
  );
}
