import { useEffect, useState } from "react";
import { api } from "../business-workspace-shared";
import { useTranslation } from "../i18n";

export type DataAutoAllowView = { autoAllow: boolean; revision: number; canChange: boolean };

export const dataAutoAllowPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/chat/data-auto-allow`;

export async function saveDataAutoAllow(companyId: string, autoAllow: boolean, expectedRevision: number) {
  return api<DataAutoAllowView>(dataAutoAllowPath(companyId), { method: "PUT", body: JSON.stringify({ autoAllow, expectedRevision }) });
}

const copy = {
  en: { title: "Confirmations in chat", label: "Let the agents act without asking for confirmation",
    on: "On: database changes, terminal commands, file deletes, risky agent tools and deleting a site from the chat run without a confirmation. A deleted site cannot be restored. Writing to git and deleting the whole company still ask. Every action is written to the audit log.",
    off: "Off: the chat asks before database changes, terminal commands, file deletes, risky agent tools and deleting a site.",
    readOnly: "Only the company owner or an admin can change this." },
  uk: { title: "Підтвердження в чаті", label: "Дозволяти агентам діяти без підтвердження",
    on: "Увімкнено: зміни бази даних, команди в терміналі, видалення файлів, ризиковані інструменти агентів і видалення сайту з чату виконуються без підтвердження. Видалений сайт не відновити. Запис у git і видалення всієї компанії і далі питають. Кожна дія записується в журнал аудиту.",
    off: "Вимкнено: чат питає перед змінами бази даних, командами в терміналі, видаленням файлів, ризикованими інструментами агентів і видаленням сайту.",
    readOnly: "Змінити це може лише власник компанії або адміністратор." },
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
      <small>{view.autoAllow ? t.on : t.off}{view.canChange ? "" : " " + t.readOnly}</small>
      {error ? <div role="alert">{error}</div> : null}
    </section>
  );
}
