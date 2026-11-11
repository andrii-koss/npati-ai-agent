import { useEffect, useState } from "react";
import { api } from "./business-workspace-shared";
import { useTranslation } from "./i18n";
import { approvalCopy, approvalToolLabel } from "./approval-i18n";
import { dataAutoAllowPath, saveDataAutoAllow, type DataAutoAllowView } from "./company/CompanyDataAutoAllow";

type PendingApproval = { id: string; toolName: string; actionSummary?: string; runId?: string | null; inputPayload?: { projectId?: string; targets?: { path?: string }[]; args?: { policies?: { collection?: string; rule?: string; actions?: string[] }[]; targetProjectId?: string; useTargetDatabase?: boolean; email?: string; roles?: string[]; collection?: string; values?: Record<string, unknown>; filters?: { field?: string; operator?: string; value?: unknown }[]; operation?: { kind?: string; collection?: string; field?: string | { name?: string }; next?: string; min?: number; max?: number; values?: unknown[] } } } };


type SchemaOperation = { kind?: string; collection?: string; field?: string | { name?: string }; next?: string; min?: number; max?: number; values?: unknown[] };

/** "Add a value rule: products.price 1-10000", so the person sees the change itself, not a tool name. */
function describeSchemaChange(operation: SchemaOperation, labels: Record<string, string>): string {
  const field = typeof operation.field === "string" ? operation.field : operation.field?.name;
  const target = [operation.collection, field].filter(Boolean).join(".");
  const range = operation.min !== undefined || operation.max !== undefined ? ` ${operation.min ?? "…"}–${operation.max ?? "…"}` : "";
  const values = operation.values?.length ? ` (${operation.values.join(", ")})` : "";
  const next = operation.next ? ` → ${operation.next}` : "";
  return `${labels[operation.kind ?? ""] ?? operation.kind}: ${target}${range}${values}${next}.`;
}

/**
 * A run can stop to wait for a person inside a tool call, long before it has a reply to carry a confirmation card. This
 * shows that request while the agent waits; the decision goes through the same audited route the run is polling.
 */
export function ChatRunApprovals({ companyId, runId, projectIds = [], language: chatLanguage }: { companyId: string; runId: string | null; projectIds?: string[]; language?: string | null }) {
  // The card speaks the language the person writes in; the interface language is the fallback.
  const { language } = useTranslation();
  const t = approvalCopy(chatLanguage || language);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  // Connecting a database names the two projects, so the person sees which one changes before allowing it.
  useEffect(() => {
    if (!pending.some(item => item.toolName === "code.data.backend.attach")) return;
    void api<{ projects: { id: string; name: string }[] }>(`/companies/${encodeURIComponent(companyId)}/projects`)
      .then(value => setNames(Object.fromEntries(value.projects.map(project => [project.id, project.name])))).catch(() => undefined);
  }, [companyId, pending]);

  useEffect(() => {
    let active = true;
    const read = () => void api<{ approvals: PendingApproval[] }>(`/companies/${encodeURIComponent(companyId)}/approvals?status=pending`)
      .then(value => { if (active) setPending(value.approvals.filter(item => (runId && item.runId === runId) || (item.runId && item.inputPayload?.projectId && projectIds.includes(item.inputPayload.projectId)))); })
      .catch(() => undefined);
    read();
    const timer = window.setInterval(read, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [companyId, runId, projectIds.join(",")]);

  async function decide(id: string, decision: "approved" | "rejected") {
    setDeciding(id); setError("");
    try {
      await api(`/companies/${encodeURIComponent(companyId)}/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
      setPending(list => list.filter(item => item.id !== id));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setDeciding(null);
  }

  // A company owner or admin can stop these questions; the server then allows the actions itself (and audits each one), so
  // no card is created for them at all. A git write still asks, so its card does not offer this.
  const [setting, setSetting] = useState<DataAutoAllowView | null>(null);
  const coverable = (toolName: string) => !toolName.startsWith("code.git.");
  const hasCoverableCard = pending.some(item => coverable(item.toolName));
  useEffect(() => {
    if (!hasCoverableCard) return;
    void api<DataAutoAllowView>(dataAutoAllowPath(companyId)).then(setSetting).catch(() => undefined);
  }, [companyId, hasCoverableCard]);

  async function allowAlways(id: string) {
    if (!setting) return;
    setDeciding(id); setError("");
    try {
      setSetting(await saveDataAutoAllow(companyId, true, setting.revision));
      await api(`/companies/${encodeURIComponent(companyId)}/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
      setPending(list => list.filter(item => item.id !== id));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setDeciding(null);
  }
  const shown = pending;

  return <>{shown.map(item => {
    const policies = item.inputPayload?.args?.policies;
    const current = item.inputPayload?.projectId, target = item.inputPayload?.args?.targetProjectId;
    const attach = item.toolName === "code.data.backend.attach" && current && target
      ? (item.inputPayload?.args?.useTargetDatabase ? t.attach(names[target] ?? target, names[current] ?? current) : t.attach(names[current] ?? current, names[target] ?? target))
      : item.toolName === "code.data.schema.modify" && item.inputPayload?.args?.operation?.kind
        ? describeSchemaChange(item.inputPayload.args.operation, t.schema as Record<string, string>)
      : item.toolName === "code.data.rows.delete" && item.inputPayload?.args?.collection
        ? t.rowsDelete(item.inputPayload.args.collection, (item.inputPayload.args.filters ?? []).map(filter => `${filter.field} ${filter.operator} ${JSON.stringify(filter.value)}`).join(", "))
      : item.toolName === "code.fs.delete" && item.inputPayload?.targets?.length
        ? t.filesDelete(item.inputPayload.targets.map(target => target.path).filter(Boolean).join(", "))
      : item.toolName === "code.data.rows.update" && item.inputPayload?.args?.collection
        ? t.rowsUpdate(item.inputPayload.args.collection, Object.entries(item.inputPayload.args.values ?? {}).map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(", "),
          (item.inputPayload.args.filters ?? []).map(filter => `${filter.field} ${filter.operator} ${JSON.stringify(filter.value)}`).join(", "))
      : item.toolName === "code.data.users.roles.set" && item.inputPayload?.args?.email
        ? t.roles(item.inputPayload.args.email, (item.inputPayload.args.roles ?? []).join(", "))
        : "";
    return (
      <article className="assistant" key={item.id}>
        <div className="chat-approval-card" role="group" aria-label={t.permissionTitle} data-testid="run-approval">
          <div className="chat-approval-card-title">{t.permissionTitle}</div>
          <div className="chat-approval-card-action">{policies?.length ? t.policies : t.wantsToRun}</div>
          {policies?.length
            ? <ul className="chat-run-approval-list">{policies.map((policy, index) => <li key={index}><code>{policy.collection}</code> {policy.actions?.join(", ")} — {(t.rule as Record<string, string>)[policy.rule ?? ""] ?? policy.rule}</li>)}</ul>
            : <div className="chat-approval-card-action">{attach || approvalToolLabel(item.toolName, t)}</div>}
          <div className="chat-approval-card-actions">
            <button type="button" disabled={deciding !== null} onClick={() => void decide(item.id, "approved")}>{deciding === item.id ? t.saving : t.allow}</button>
            <button type="button" className="secondary" disabled={deciding !== null} onClick={() => void decide(item.id, "rejected")}>{t.reject}</button>
            {coverable(item.toolName) && setting?.canChange && !setting.autoAllow
              ? <button type="button" className="secondary" title={t.alwaysHint} disabled={deciding !== null} onClick={() => void allowAlways(item.id)} data-testid="run-approval-always">{t.always}</button>
              : null}
          </div>
          {error ? <div className="chat-approval-card-error" role="alert">{error}</div> : null}
        </div>
      </article>
    );
  })}</>;
}
