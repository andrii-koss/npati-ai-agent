import { useState } from "react";
import type { InboxMessage, InboxSnapshot } from "./code-inbox-client";

export function CodePendingMessages({ snapshot, error, busy, t, onChange, receiptTarget }: {
  snapshot: InboxSnapshot | null; error: string; busy: boolean; t: (key: string) => string;
  receiptTarget?: "next-step" | "next-turn" | null;
  onChange: (message: InboxMessage, text?: string) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  return <section className="code-pending-messages" aria-label={t("codeInbox.title")} aria-live="polite">
    <strong>{t("codeInbox.title")}</strong>
    <span> · {snapshot ? t(`codeInbox.${snapshot.phase}`) : t("common.loading")}</span>
    {receiptTarget && <p role="status">{t("codeInbox.accepted")} · {t(receiptTarget === "next-step" ? "codeInbox.steer" : "codeInbox.queue")}</p>}
    {error && <p role="alert">{error}</p>}
    {snapshot?.lastError && <p role="alert">{t("codeInbox.dispatchError")}</p>}
    {snapshot?.messages.map((message) => <div key={message.id} className="code-pending-row">
      <small>{t(message.target === "next-step" ? "codeInbox.steer" : "codeInbox.queue")} · {t(`codeInbox.${message.status}`)}</small>
      {message.completion ? <p>{t("codeInbox.completion")}</p> : edit?.id === message.id && message.status === "pending" ? <>
        <textarea aria-label={t("common.edit")} value={edit.text} onChange={(event) => setEdit({ id: message.id, text: event.target.value })} maxLength={16_000} />
        <button type="button" disabled={busy || !edit.text.trim()} onClick={() => void onChange(message, edit.text).then((ok) => { if (ok) setEdit(null); })}>{t("common.save")}</button>
        <button type="button" onClick={() => setEdit(null)}>{t("common.cancel")}</button>
      </> : <p>{message.text}</p>}
      {!message.completion && message.status === "pending" && edit?.id !== message.id && <>
        <button type="button" disabled={busy} onClick={() => setEdit({ id: message.id, text: message.text })}>{t("common.edit")}</button>
        <button type="button" disabled={busy} onClick={() => void onChange(message)}>{t("common.delete")}</button>
      </>}
    </div>)}
  </section>;
}
