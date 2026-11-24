import { useCallback, useContext, useEffect, useState } from "react";
import { I18nContextRef } from "./i18n";
import { registerPasskey } from "./passkey-step-up";

/**
 * Settings > Security: the passkeys that confirm sensitive actions (creating API keys and remote tokens, revealing
 * stored secrets). Every passkey of the account is listed, so one the person did not add is visible and can be
 * removed (removing needs a confirmation with a passkey too).
 */
type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; transports: string[] };

export function SecurityPage() {
  const isUk = useContext(I18nContextRef)?.language === "uk";
  const [items, setItems] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  const load = useCallback(async () => {
    const response = await fetch("/api/auth/passkeys");
    if (!response.ok) { setMessage(isUk ? "Не вдалося завантажити passkey." : "Could not load passkeys."); setItems([]); return; }
    setItems(((await response.json()) as { passkeys: Passkey[] }).passkeys);
  }, [isUk]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true); setMessage("");
    try {
      await registerPasskey(name.trim() || (isUk ? "Мій пристрій" : "My device"));
      setName("");
      setMessage(isUk ? "Passkey додано." : "Passkey added.");
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const remove = async (passkey: Passkey) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(isUk ? "Passkey не видалено." : "The passkey was not removed.");
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const date = (value: string | null) => value ? new Date(value).toLocaleString(isUk ? "uk-UA" : undefined) : "—";
  return (
    <section className="settings-page security-settings-page">
      <header>
        <h1>{isUk ? "Безпека" : "Security"}</h1>
        <p>{isUk
          ? "Passkey підтверджує дії, після яких лишаються довготривалі доступи: створення API-ключів і токенів, показ збережених паролів і секретів. Без нього ці дії недоступні з браузера."
          : "A passkey confirms actions that leave long-lived access behind: creating API keys and tokens, revealing saved passwords and secrets. Without one, these actions are unavailable in the browser."}</p>
      </header>
      {!supported && <p className="settings-warning">{isUk ? "Цей браузер не підтримує passkey." : "This browser does not support passkeys."}</p>}
      <div className="security-passkey-add">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={isUk ? "Назва (наприклад, «Ноутбук»)" : "Name (for example, \"Laptop\")"} aria-label={isUk ? "Назва passkey" : "Passkey name"} />
        <button type="button" className="button-primary" disabled={busy || !supported} onClick={() => void add()}>{isUk ? "Додати passkey" : "Add a passkey"}</button>
      </div>
      {message && <p role="status">{message}</p>}
      {items === null ? <p>{isUk ? "Завантаження…" : "Loading…"}</p> : items.length === 0 ? (
        <p>{isUk ? "Passkey ще не додано." : "No passkey yet."}</p>
      ) : (
        <table className="security-passkey-table">
          <thead><tr><th>{isUk ? "Назва" : "Name"}</th><th>{isUk ? "Додано" : "Added"}</th><th>{isUk ? "Останнє використання" : "Last used"}</th><th /></tr></thead>
          <tbody>
            {items.map((passkey) => (
              <tr key={passkey.id}>
                <td>{passkey.name}</td><td>{date(passkey.createdAt)}</td><td>{date(passkey.lastUsedAt)}</td>
                <td><button type="button" className="button-secondary" disabled={busy} onClick={() => void remove(passkey)}>{isUk ? "Видалити" : "Remove"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
