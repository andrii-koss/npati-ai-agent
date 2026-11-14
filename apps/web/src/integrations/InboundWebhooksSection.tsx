import { FormEvent, useEffect, useState } from "react";
import { confirmModal } from "../ConfirmDialog";
import { useTranslation } from "../i18n";
import { api, type Company } from "./types";

/**
 * Inbound webhooks of a company (V6 step 12, owner decision). The chat creates them and points here, but this page
 * had no webhooks, so a delivery URL could never be obtained. The URL carries the secret: the list shows only a hint,
 * and the full URL appears after "Show URL" (POST …/reveal, company managers only).
 */
type Webhook = { id: string; name: string; agentId?: string | null; promptTemplate: string; isActive: boolean; lastTriggeredAt?: string | null; secretHint: string };

const COPY = {
  en: { kicker: "Inbound webhooks", heading: "Receive events from other systems", description: "An external system posts JSON to the webhook URL and the selected company agent processes it. The URL contains a secret: share it only with the system that sends events.", company: "Company", none: "No webhooks yet. Create one below or ask the chat.", show: "Show URL", hide: "Hide URL", copy: "Copy", copied: "Copied", enable: "Enable", disable: "Disable", remove: "Delete", active: "Active", inactive: "Disabled", last: "Last event", never: "never", name: "Name", prompt: "What the agent does with the incoming data", create: "Create webhook", confirm: "Delete the webhook \"{name}\"? Systems that use its URL will get 404.", createdNotice: "Webhook created. Copy its URL now or later with Show URL." },
  uk: { kicker: "Вхідні вебхуки", heading: "Отримання подій з інших систем", description: "Зовнішня система надсилає JSON на адресу вебхука, і вибраний агент компанії обробляє його. Адреса містить секрет: передавайте її лише системі, що надсилає події.", company: "Компанія", none: "Вебхуків ще немає. Створіть тут або попросіть чат.", show: "Показати URL", hide: "Сховати URL", copy: "Копіювати", copied: "Скопійовано", enable: "Увімкнути", disable: "Вимкнути", remove: "Видалити", active: "Активний", inactive: "Вимкнено", last: "Остання подія", never: "ще не було", name: "Назва", prompt: "Що агент робить з отриманими даними", create: "Створити вебхук", confirm: "Видалити вебхук «{name}»? Системи, що використовують його адресу, отримають 404.", createdNotice: "Вебхук створено. Скопіюйте адресу зараз або пізніше кнопкою «Показати URL»." },
  ru: { kicker: "Входящие вебхуки", heading: "Получение событий из других систем", description: "Внешняя система отправляет JSON на адрес вебхука, и выбранный агент компании его обрабатывает. Адрес содержит секрет: передавайте его только системе, которая отправляет события.", company: "Компания", none: "Вебхуков пока нет. Создайте здесь или попросите чат.", show: "Показать URL", hide: "Скрыть URL", copy: "Копировать", copied: "Скопировано", enable: "Включить", disable: "Выключить", remove: "Удалить", active: "Активен", inactive: "Выключен", last: "Последнее событие", never: "ещё не было", name: "Название", prompt: "Что агент делает с полученными данными", create: "Создать вебхук", confirm: "Удалить вебхук «{name}»? Системы, использующие его адрес, получат 404.", createdNotice: "Вебхук создан. Скопируйте адрес сейчас или позже кнопкой «Показать URL»." },
};

export function InboundWebhooksSection({ companies }: { companies: Company[] }) {
  const { language } = useTranslation();
  const copy = COPY[language as keyof typeof COPY] ?? COPY.en;
  const [companyId, setCompanyId] = useState<string>(() => {
    try { return localStorage.getItem("npati_selected_company_id_v1") ?? ""; } catch { return ""; }
  });
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", promptTemplate: "" });
  const company = companies.find((item) => item.id === companyId) ?? companies[0];

  const load = async (id: string) => {
    try { setWebhooks((await api<{ webhooks: Webhook[] }>(`/companies/${id}/webhooks`)).webhooks); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { setUrls({}); if (company) void load(company.id); }, [company?.id]);

  const urlFor = (path: string) => `${window.location.origin}${path}`;
  const reveal = async (hook: Webhook) => {
    if (urls[hook.id]) { setUrls(({ [hook.id]: _hidden, ...rest }) => rest); return; }
    try {
      const { path } = await api<{ path: string }>(`/companies/${company!.id}/webhooks/${hook.id}/reveal`, { method: "POST" });
      setUrls((current) => ({ ...current, [hook.id]: urlFor(path) }));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const copyUrl = async (hook: Webhook) => {
    try {
      const url = urls[hook.id] ?? urlFor((await api<{ path: string }>(`/companies/${company!.id}/webhooks/${hook.id}/reveal`, { method: "POST" })).path);
      await navigator.clipboard.writeText(url);
      setCopiedId(hook.id); setTimeout(() => setCopiedId(null), 2000);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const toggle = async (hook: Webhook) => {
    try { await api(`/companies/${company!.id}/webhooks/${hook.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !hook.isActive }) }); await load(company!.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const remove = async (hook: Webhook) => {
    if (!await confirmModal({ message: copy.confirm.replace("{name}", hook.name), isDanger: true })) return;
    try { await api(`/companies/${company!.id}/webhooks/${hook.id}`, { method: "DELETE" }); await load(company!.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!company || !form.name.trim() || !form.promptTemplate.trim()) return;
    try {
      const created = await api<{ webhook: { id: string; secret: string } }>(`/companies/${company.id}/webhooks`, { method: "POST", body: JSON.stringify({ name: form.name.trim(), promptTemplate: form.promptTemplate.trim() }) });
      setForm({ name: "", promptTemplate: "" });
      await load(company.id);
      setUrls((current) => ({ ...current, [created.webhook.id]: urlFor(`/api/v1/webhooks/${created.webhook.secret}`) }));
      setNotice(copy.createdNotice);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <section className="explore-section inbound-webhooks-section" data-testid="inbound-webhooks">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{copy.kicker}</p>
          <h2>{copy.heading}</h2>
          <p className="showing-copy">{copy.description}</p>
        </div>
        {companies.length > 0 && (
          <label className="inbound-webhooks-company">
            <span>{copy.company}</span>
            <select value={company?.id ?? ""} onChange={(event) => setCompanyId(event.target.value)} aria-label={copy.company}>
              {companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {notice && <div className="workspace-notice" role="status">{notice}</div>}
      {webhooks.length === 0 ? <p className="showing-copy">{copy.none}</p> : (
        <div className="inbound-webhooks-list">
          {webhooks.map((hook) => (
            <article className="provider-card" key={hook.id} data-testid="inbound-webhook">
              <div className="provider-title">
                <strong>{hook.name}</strong>
                <small>{hook.isActive ? copy.active : copy.inactive} · {copy.last}: {hook.lastTriggeredAt ? new Date(hook.lastTriggeredAt).toLocaleString(language) : copy.never}</small>
              </div>
              <p className="provider-description">{hook.promptTemplate}</p>
              <code className="inbound-webhook-url" data-testid="inbound-webhook-url">{urls[hook.id] ?? `${window.location.origin}/api/v1/webhooks/${hook.secretHint}`}</code>
              <div className="provider-card-footer">
                <button type="button" className="button-secondary" onClick={() => void reveal(hook)}>{urls[hook.id] ? copy.hide : copy.show}</button>
                <button type="button" className="button-secondary" onClick={() => void copyUrl(hook)}>{copiedId === hook.id ? copy.copied : copy.copy}</button>
                <button type="button" className="button-secondary" onClick={() => void toggle(hook)}>{hook.isActive ? copy.disable : copy.enable}</button>
                <button type="button" className="button-secondary" onClick={() => void remove(hook)}>{copy.remove}</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {company && (
        <form className="inbound-webhooks-form" onSubmit={(event) => void create(event)}>
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={copy.name} aria-label={copy.name} maxLength={200} />
          <input value={form.promptTemplate} onChange={(event) => setForm({ ...form, promptTemplate: event.target.value })} placeholder={copy.prompt} aria-label={copy.prompt} />
          <button type="submit" className="button-primary" disabled={!form.name.trim() || !form.promptTemplate.trim()}>{copy.create}</button>
        </form>
      )}
    </section>
  );
}
