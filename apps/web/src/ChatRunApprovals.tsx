import { useEffect, useState } from "react";
import { api } from "./business-workspace-shared";
import { useTranslation } from "./i18n";

type PendingApproval = { id: string; toolName: string; actionSummary?: string; runId?: string | null; inputPayload?: { args?: { policies?: { collection?: string; rule?: string; actions?: string[] }[] } } };

const copy = {
  en: { title: "Your permission is needed", policies: "The agent wants to set who can use these database tables:", other: "The agent wants to run this action:", allow: "Allow", reject: "Reject", working: "Saving…", rule: { public: "anyone", authenticated: "signed-in users", owner: "the owner of the row", role: "a set role" } as Record<string, string> },
  uk: { title: "Потрібен ваш дозвіл", policies: "Агент хоче встановити, хто може користуватися цими таблицями бази даних:", other: "Агент хоче виконати цю дію:", allow: "Дозволити", reject: "Відхилити", working: "Зберігаю…", rule: { public: "будь-хто", authenticated: "зареєстровані користувачі", owner: "власник запису", role: "певна роль" } as Record<string, string> },
};

/**
 * A run can stop to wait for a person inside a tool call, long before it has a reply to carry a confirmation card. This
 * shows that request while the agent waits; the decision goes through the same audited route the run is polling.
 */
export function ChatRunApprovals({ companyId, runId }: { companyId: string; runId: string }) {
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const read = () => void api<{ approvals: PendingApproval[] }>(`/companies/${encodeURIComponent(companyId)}/approvals?status=pending`)
      .then(value => { if (active) setPending(value.approvals.filter(item => item.runId === runId)); })
      .catch(() => undefined);
    read();
    const timer = window.setInterval(read, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [companyId, runId]);

  async function decide(id: string, decision: "approved" | "rejected") {
    setDeciding(id); setError("");
    try {
      await api(`/companies/${encodeURIComponent(companyId)}/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
      setPending(list => list.filter(item => item.id !== id));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setDeciding(null);
  }

  return <>{pending.map(item => {
    const policies = item.inputPayload?.args?.policies;
    return (
      <article className="assistant" key={item.id}>
        <div className="chat-approval-card" role="group" aria-label={t.title} data-testid="run-approval">
          <div className="chat-approval-card-title">{t.title}</div>
          <div className="chat-approval-card-action">{policies?.length ? t.policies : t.other}</div>
          {policies?.length
            ? <ul className="chat-run-approval-list">{policies.map((policy, index) => <li key={index}><code>{policy.collection}</code> {policy.actions?.join(", ")} — {t.rule[policy.rule ?? ""] ?? policy.rule}</li>)}</ul>
            : <div className="chat-approval-card-action"><code>{item.toolName}</code></div>}
          <div className="chat-approval-card-actions">
            <button type="button" disabled={deciding !== null} onClick={() => void decide(item.id, "approved")}>{deciding === item.id ? t.working : t.allow}</button>
            <button type="button" className="secondary" disabled={deciding !== null} onClick={() => void decide(item.id, "rejected")}>{t.reject}</button>
          </div>
          {error ? <div className="chat-approval-card-error" role="alert">{error}</div> : null}
        </div>
      </article>
    );
  })}</>;
}
