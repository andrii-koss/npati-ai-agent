import { useEffect, useRef, useState } from "react";
import { InboxSubmission, requestCodeInbox, type InboxSnapshot } from "../code-inbox-client";
import { AsyncControlSubmission, asyncRequest, createAsyncObserver, readAsyncWorkspace, sessionPath,
  type AsyncScope, type AsyncOperation, type AsyncWorkspaceSnapshot } from "./async-workspace-client";

export function AsyncOperationsView({ snapshot, stale, busy, isUk, onControl, onProcess }: {
  snapshot: AsyncWorkspaceSnapshot; stale: boolean; busy: boolean; isUk: boolean;
  onControl(op: AsyncOperation, action: "continue" | "interrupt" | "send_message"): void;
  onProcess(op: AsyncOperation, action: "output" | "stop"): void;
}) {
  return <section aria-label={isUk ? "Асинхронна робота" : "Async work"}>
    <h2>{isUk ? "Процеси та дочірні агенти" : "Processes and child agents"}</h2>
    {stale && <p role="status">{isUk ? "З’єднання втрачено. Керування призупинено." : "Connection unavailable. Controls paused."}</p>}
    {!snapshot.operations.length && <p>{isUk ? "Немає операцій." : "No operations."}</p>}
    <ul>{snapshot.operations.map(op => <li key={op.operationId}>
      <code>{op.childRunId ?? op.processId}</code> · {op.agentType ?? op.kind} · {op.state}
      {op.cancelRequested && op.state !== "interrupted" && <span> · {isUk ? "зупинка запитана" : "stop requested"}</span>}
      {op.collected && <span> · {isUk ? "результат зібрано" : "result collected"}</span>}
      {op.kind === "process" && snapshot.capabilities.processes && <div>
        <button type="button" disabled={stale || busy || ["accepted", "preparing"].includes(op.state)} onClick={() => onProcess(op, "output")}>{isUk ? "Вивід процесу" : "Process output"}</button>
        <button type="button" disabled={stale || busy || op.cancelRequested || !["accepted", "preparing", "dispatching", "running", "unknown_outcome"].includes(op.state)} onClick={() => onProcess(op, "stop")}>{isUk ? "Зупинити процес" : "Stop process"}</button>
      </div>}
      {op.state === "unknown_outcome" && <p>{isUk ? "Результат невідомий. Потрібна перевірка перед відновленням." : "Outcome unknown. Review before recovery."}</p>}
      {op.childRunId && snapshot.capabilities.controls && <div>
        <button type="button" disabled={stale || busy || !snapshot.capabilities.resume || op.stopRequested || op.state !== "interrupted"} onClick={() => onControl(op, "continue")}>{isUk ? "Продовжити" : "Continue"}</button>
        <button type="button" disabled={stale || busy || !snapshot.capabilities.inbox || op.cancelRequested || !["accepted", "running"].includes(op.state)} onClick={() => onControl(op, "send_message")}>{isUk ? "Надіслати повідомлення" : "Send message"}</button>
        <button type="button" disabled={stale || busy || op.cancelRequested || !["accepted", "running"].includes(op.state)} onClick={() => onControl(op, "interrupt")}>{isUk ? "Перервати" : "Interrupt"}</button>
      </div>}
    </li>)}</ul>
  </section>;
}

/** Durable reads reconnect to the same operations. Execution stays in the existing server dispatcher. */
export function AsyncWorkspacePanel({ scope, runId, isUk, onAvailability, onRun }: {
  scope: AsyncScope; runId: string; isUk: boolean; onAvailability(enabled: boolean): void; onRun(runId: string): void;
}) {
  const [snapshot, setSnapshot] = useState<AsyncWorkspaceSnapshot | null>(null);
  const [inbox, setInbox] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(""); const [edits, setEdits] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<AsyncOperation | null>(null);
  const [notice, setNotice] = useState("");
  const [output, setOutput] = useState<{ processId: string; text: string; lossy: boolean } | null>(null);
  const cursors = useRef(new Map<string, number>());
  const lifecycle = useRef<AbortController | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const submission = useRef(new InboxSubmission()); const controls = useRef(new AsyncControlSubmission());
  const lock = useRef(false);
  const { companyId, projectId, sessionId } = scope;
  const key = JSON.stringify([companyId, projectId, sessionId]);
  const currentRun = useRef({ runId, onRun }); currentRun.current = { runId, onRun };
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    setSnapshot(null); setInbox(null); setError(""); setDraft(""); setEdits({}); setTarget(null); setNotice(""); setBusy(false); lock.current = false;
    submission.current = new InboxSubmission(); controls.current = new AsyncControlSubmission();
    cursors.current = new Map(); setOutput(null);
    const observer = createAsyncObserver(async signal => {
      const next = await readAsyncWorkspace(scope, signal);
      const messages = next.capabilities.inbox ? await requestCodeInbox({ ...scope, inboxEnabled: true }, "GET", undefined, undefined, signal) : null;
      return { next, messages };
    }, ({ next, messages }) => {
      setSnapshot(next); setInbox(previous => messages && previous && previous.revision > messages.revision ? previous : messages);
      setError(""); onAvailability(next.capabilities.inbox);
      if (messages?.runId && messages.runId !== currentRun.current.runId && (!currentRun.current.runId || ["reserved", "running", "sealed"].includes(messages.phase))) currentRun.current.onRun(messages.runId);
    }, reason => {
      if ((reason as { code?: string }).code === "feature_disabled") { setSnapshot(null); setInbox(null); onAvailability(false); observer.close(); }
      else setError(reason instanceof Error ? reason.message : "async_workspace_unavailable");
    });
    refresh.current = observer.refresh; void observer.refresh();
    const reconnect = () => { if (document.visibilityState !== "hidden") void observer.refresh(); };
    const timer = window.setInterval(reconnect, 3000);
    window.addEventListener("focus", reconnect); window.addEventListener("online", reconnect); document.addEventListener("visibilitychange", reconnect);
    return () => { controller.abort(); observer.close(); window.clearInterval(timer); window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", reconnect); };
    // The scope is the identity. New run query parameters must not reset pending request identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onAvailability]);
  const act = async (work: (signal: AbortSignal) => Promise<string | void>) => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || lock.current || error) return;
    lock.current = true; setBusy(true);
    try { const message = await work(controller.signal); if (!controller.signal.aborted) { setNotice(message ?? ""); await refresh.current(); } }
    catch (reason) { if (!controller.signal.aborted) setNotice(reason instanceof Error ? reason.message : "request_failed"); }
    finally { if (!controller.signal.aborted) { lock.current = false; setBusy(false); } }
  };
  const childControl = (op: AsyncOperation, action: "continue" | "interrupt" | "send_message") => {
    if (action === "send_message") { setTarget(op); return; }
    void act(async signal => {
      const attempt = controls.current; const requestId = attempt.begin(JSON.stringify([key, op.childRunId, action])); if (!requestId) return;
      let accepted = false;
      try { await asyncRequest(`${sessionPath(scope)}/runs/${encodeURIComponent(op.runId)}/children/${encodeURIComponent(op.childRunId!)}/${action}`, signal,
        action === "interrupt" ? {} : { requestId }); accepted = true; return isUk ? "Запит прийнято." : "Request accepted."; }
      finally { attempt.finish(accepted); }
    });
  };
  if (!snapshot) return error ? <p role="alert">{error}</p> : null;
  return <div className="project-panel" data-async-session={sessionId}>
    <AsyncOperationsView snapshot={snapshot} stale={!!error} busy={busy} isUk={isUk} onControl={childControl} onProcess={(op, action) => void act(async signal => {
      const offset = cursors.current.get(op.processId) ?? 0;
      const attempt = controls.current, toolCallId = attempt.begin(JSON.stringify([key, op.processId, action, offset])); if (!toolCallId) return;
      let accepted = false;
      try {
        // Existing canonical runtime owns policy, RBAC, audit, bounded output and cancellation.
        const response = await asyncRequest<{ truncated?: boolean; result: { data: { output?: string; nextOffset?: number; lossy?: boolean; truncated?: boolean; result?: { output?: string; nextOffset?: number; lossy?: boolean; truncated?: boolean } } } }>(
          `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/code/tools/invoke`, signal,
          { tool: action === "output" ? "code.shell.process.wait" : "code.shell.process.stop", sessionId, toolCallId,
            args: action === "output" ? { processId: op.processId, waitTimeoutMs: 0, offset } : { processId: op.processId } });
        accepted = true;
        if (!signal.aborted && action === "output") {
          const result = response.result.data.result ?? response.result.data;
          if (typeof result.output !== "string" || !Number.isSafeInteger(result.nextOffset)) throw new Error("invalid_process_output");
          cursors.current.set(op.processId, result.nextOffset!);
          setOutput({ processId: op.processId, text: result.output.slice(-64_000), lossy: !!result.lossy || !!result.truncated || !!response.truncated || result.output.length > 64_000 });
        }
        return action === "stop" ? (isUk ? "Запит зупинки прийнято." : "Stop request accepted.") : undefined;
      } finally { attempt.finish(accepted); }
    })} />
    {output && <section aria-label={isUk ? "Вивід процесу" : "Process output"}><code>{output.processId}</code>
      {output.lossy && <p>{isUk ? "Вивід скорочено або частково втрачено." : "Output truncated or partially lost."}</p>}<pre>{output.text}</pre></section>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {snapshot.capabilities.inbox && <section aria-label={isUk ? "Черга повідомлень" : "Message queue"}>
      <label>{target ? `${isUk ? "Повідомлення агенту" : "Message to agent"} ${target.childRunId}` : isUk ? "Завдання або уточнення" : "Task or steering message"}
        <textarea value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} disabled={busy || !!error} />
      </label>
      {target ? <>
        <button type="button" disabled={busy || !!error || !snapshot.capabilities.controls || !draft.trim() || !snapshot.operations.some(op => op.operationId === target.operationId && !op.cancelRequested && ["accepted", "running"].includes(op.state))} onClick={() => void act(async signal => {
          const text = draft, attempt = controls.current; const requestId = attempt.begin(JSON.stringify([key, target.childRunId, text])); if (!requestId) return;
          let accepted = false;
          try { await asyncRequest(`${sessionPath(scope)}/runs/${encodeURIComponent(target.runId)}/children/${encodeURIComponent(target.childRunId!)}/send_message`, signal, { requestId, text });
            accepted = true; if (!signal.aborted) { setDraft(""); setTarget(null); } return isUk ? "Повідомлення прийнято." : "Message accepted."; }
          finally { attempt.finish(accepted); }
        })}>{isUk ? "Надіслати" : "Send"}</button>
        <button type="button" disabled={busy} onClick={() => setTarget(null)}>{isUk ? "До головного агента" : "Back to parent"}</button>
      </> : (["queue", "steer"] as const).map(mode => <button type="button" key={mode} disabled={busy || !!error || !inbox || !draft.trim()} onClick={() => void act(async signal => {
        const attempt = submission.current; const request = attempt.begin({ ...scope, inboxEnabled: true }, draft, mode); if (!request) return;
        let accepted = false;
        try { const next = await requestCodeInbox({ ...scope, inboxEnabled: true }, "POST", request, undefined, signal); accepted = true;
          if (!signal.aborted) { setInbox(next); setDraft(""); } return next.receipt?.target === "next-step" ? (isUk ? "Прийнято для наступного кроку." : "Accepted for the next step.") : (isUk ? "Додано до наступного завдання." : "Queued for the next task."); }
        finally { attempt.finish(accepted); }
      })}>{mode === "queue" ? (isUk ? "У чергу" : "Queue") : (isUk ? "Уточнити" : "Steer")}</button>)}
      <ul>{inbox?.messages.map(message => <li key={message.id}>
        {message.completion ? <span>{isUk ? "Результат очікує збору" : "Result awaiting collection"} · {message.completion.status}</span> : <>
          <input aria-label={isUk ? "Повідомлення в черзі" : "Queued message"} value={edits[message.id] ?? message.text} disabled={message.status !== "pending" || busy || !!error} onChange={e => setEdits(current => ({ ...current, [message.id]: e.target.value }))} />
          {(["PUT", "DELETE"] as const).map(method => <button type="button" key={method} disabled={message.status !== "pending" || busy || !!error} onClick={() => void act(async signal => {
            const next = await requestCodeInbox({ ...scope, inboxEnabled: true }, method, { expectedRevision: message.revision,
              ...(method === "PUT" ? { text: edits[message.id] ?? message.text } : {}) }, message.id, signal);
            if (!signal.aborted) setInbox(next);
          })}>{method === "PUT" ? (isUk ? "Зберегти" : "Save") : (isUk ? "Відкинути" : "Discard")}</button>)}
        </>} · {message.target} · {message.status}
      </li>)}</ul>
    </section>}
    {snapshot.capabilities.resume && runId && <button type="button" disabled={busy || !!error} onClick={() => void act(async signal => {
      const result = await asyncRequest<{ status: string }>(`/api/companies/${encodeURIComponent(companyId)}/code/runs/${encodeURIComponent(runId)}/recovery`, signal);
      return result.status === "none" ? (isUk ? "Запису про відновлення немає." : "No recovery notice recorded.") : (isUk ? "Run був перерваний. Перевірте Activity перед відновленням." : "Run was interrupted. Review Activity before recovery.");
    })}>{isUk ? "Перевірити відновлення run" : "Check run recovery"}</button>}
  </div>;
}
