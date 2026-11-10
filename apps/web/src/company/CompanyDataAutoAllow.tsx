import { useEffect, useState } from "react";
import { api } from "../business-workspace-shared";
import { useTranslation } from "../i18n";

export type DataAutoAllowView = { autoAllow: boolean; revision: number; canChange: boolean };

export const dataAutoAllowPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/chat/data-auto-allow`;

export async function saveDataAutoAllow(companyId: string, autoAllow: boolean, expectedRevision: number) {
  return api<DataAutoAllowView>(dataAutoAllowPath(companyId), { method: "PUT", body: JSON.stringify({ autoAllow, expectedRevision }) });
}

const copy = {
  en: { title: "Database changes", label: "Let the agent change this company's databases without asking", hint: "Off: the chat asks before each change to tables, columns, rows, roles or links. Every change is still written to the audit log.", readOnly: "Only the company owner or an admin can change this." },
  uk: { title: "Зміни бази даних", label: "Дозволяти агенту змінювати бази даних цієї компанії без підтвердження", hint: "Вимкнено: чат питає перед кожною зміною таблиць, колонок, рядків, ролей чи зв'язків. Кожна зміна все одно записується в журнал аудиту.", readOnly: "Змінити це може лише власник компанії або адміністратор." },
};

/** The company setting shown in the company drawer; it saves on its own, apart from the company form. */
export function CompanyDataAutoAllow({ companyId }: { companyId: string }) {
  const { language } = useTranslation();
  const t = language === "uk" ? copy.uk : copy.en;
  const [view, setView] = useState<DataAutoAllowView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<DataAutoAllowView>(dataAutoAllowPath(companyId)).then(value => { if (active) setView(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [companyId]);
  if (!view) return null;
  async function toggle(next: boolean) {
    if (!view) return;
    setSaving(true); setError("");
    try { setView(await saveDataAutoAllow(companyId, next, view.revision)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setSaving(false);
  }
  return (
    <section data-testid="company-data-auto-allow">
      <h3>{t.title}</h3>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={view.autoAllow} disabled={!view.canChange || saving} onChange={event => void toggle(event.target.checked)} style={{ width: "auto", marginTop: 3 }} />
        <span>{t.label}</span>
      </label>
      <small>{view.canChange ? t.hint : t.readOnly}</small>
      {error ? <div role="alert">{error}</div> : null}
    </section>
  );
}
