import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { CodeTrustPanel } from "./CodeTrustPanel";

/**
 * C6b: read-only "why did the agent act this way".
 *
 * This panel answers three questions about a run and nothing else:
 *  1. **in which environment and with which policies did it execute** — the immutable ExecutionSnapshot;
 *  2. **how did two runs differ** — the server's content-safe structural diff (component paths, never values);
 *  3. **can it be reproduced** — replay metadata, with the best-effort notice shown verbatim for a live replay.
 *
 * Two rules it deliberately follows:
 *  - a run recorded before C6b has no snapshot, so the panel says `legacy_no_snapshot` and renders nothing
 *    else — an old run is a normal state, not an error;
 *  - a field the server could not read is shown as unreadable (`{unavailable: …}`) rather than as empty,
 *    because "we could not tell" and "nothing was configured" are different answers.
 *
 * It is read-only by construction: it calls only GET routes, so it can never widen what an agent may do.
 * The full Code Workspace UI is C7; this is the minimum the existing Run Trace needs.
 */

interface SnapshotView {
  snapshotId: string;
  snapshotVersion: number;
  runId: string | null;
  sessionId: string;
  projectId: string;
  trigger: string;
  legacy: boolean;
  payloadHash: string;
  prevPayloadHash: string | null;
  createdBy: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface ReplayView {
  bundleId: string;
  bundleVersion: number;
  replayMode: string;
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  terminalStatus: string | null;
  terminalReason: string | null;
  provider: string | null;
  model: string | null;
  runnerVersion: string | null;
  systemPromptVersion: number | null;
  modelProfileVersion: number | null;
  replayInputHash: string;
  stepCount: number;
  bestEffort: boolean;
  notice?: string;
}

interface FieldRow {
  label: string;
  value: string;
  unreadable?: boolean;
}

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  return fetch("/api" + path, { ...init, headers });
}

/** A source that could not be read is recorded as `{ unavailable: reason }` — surface it as such. */
function asUnavailable(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const marker = (value as { unavailable?: unknown }).unavailable;
  return typeof marker === "string" ? marker : null;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((entry) => text(entry)).join(", ") : "—";
  return JSON.stringify(value);
}

function snapshotFields(payload: Record<string, unknown>, isUk: boolean): FieldRow[] {
  const selection = (payload.modelSelection ?? {}) as Record<string, unknown>;
  const sandbox = (payload.sandboxImage ?? {}) as Record<string, unknown>;
  const flags = (payload.featureFlags ?? {}) as Record<string, unknown>;
  const dataPolicy = (payload.providerDataPolicy ?? {}) as Record<string, unknown>;
  const commit = (payload.baseCommit ?? {}) as Record<string, unknown>;
  const trust = (payload.projectInstructions ?? {}) as Record<string, unknown>;
  const prompt = (payload.systemPrompt ?? {}) as Record<string, unknown>;
  const toolchain = (payload.toolchain ?? {}) as Record<string, unknown>;
  const composition = (payload.policyComposition ?? {}) as Record<string, unknown>;

  const row = (label: string, source: unknown, render: (value: Record<string, unknown>) => string): FieldRow => {
    const unavailable = asUnavailable(source);
    if (unavailable) return { label, value: `${isUk ? "не вдалося прочитати" : "could not be read"}: ${unavailable}`, unreadable: true };
    return { label, value: render((source ?? {}) as Record<string, unknown>) };
  };

  const flagList = Object.entries((flags.flags ?? {}) as Record<string, unknown>)
    .map(([key, value]) => `${key}=${text((value as Record<string, unknown>)?.enabled ?? value)}`)
    .join(", ");

  return [
    row(isUk ? "Модель і провайдер" : "Model and provider", payload.modelSelection, (v) => `${text(v.provider)} / ${text(v.model)}`),
    row(isUk ? "Профіль моделі" : "Model profile", payload.modelProfileVersion, (v) => `v${text(v)}`),
    row(isUk ? "System prompt" : "System prompt", payload.systemPrompt, (v) => `v${text(v.version)} · ${text(v.contentHash)}`),
    row(isUk ? "Версія раннера" : "Runner version", payload.runnerVersion, (v) => text(v)),
    row(isUk ? "Маніфест інструментів" : "Tool manifest", payload.toolManifestVersion, (v) => text(v)),
    row(isUk ? "Образ sandbox" : "Sandbox image", payload.sandboxImage, (v) => `${text(v.digest)}${v.sbomRef ? ` · SBOM ${text(v.sbomRef)}` : ""}`),
    row(isUk ? "Політика даних провайдера" : "Provider data policy", payload.providerDataPolicy, (v) => `v${text(v.version)} · ${text(v.classification)}`),
    row(isUk ? "Прапорці (розв'язані)" : "Feature flags (resolved)", payload.featureFlags, (v) => `${isUk ? "master" : "master"}=${text((v.master as Record<string, unknown>)?.enabled)}${flagList ? ` · ${flagList}` : ""}`),
    row(isUk ? "Базовий коміт" : "Base commit", payload.baseCommit, (v) => `${text(v.branch)} @ ${text(v.commit)}${v.dirty ? ` (${isUk ? "є незафіксовані зміни" : "dirty"})` : ""}`),
    row(isUk ? "Довіра до проєкту" : "Project trust", payload.projectInstructions, (v) => text(v.trustStatus)),
    row(isUk ? "Toolchain" : "Toolchain", payload.toolchain, (v) => text(v.languages ?? v)),
    row(isUk ? "Складові політики" : "Policy composition", payload.policyComposition, (v) => Object.entries(v).map(([k, val]) => `${k}=${text(val)}`).join(" · ")),
  ].map((entry) => ({ ...entry, value: entry.value }));
}

export function CodeSnapshotPanel({ companyId, runId, isUk }: { companyId: string; runId: string; isUk: boolean }) {
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [noBundle, setNoBundle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [compareRunId, setCompareRunId] = useState("");
  const [diff, setDiff] = useState<{ changed: string[]; unchanged: string[] } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId || !runId) return;
    setLoading(true);
    setError(null);
    setCompareError(null);
    setDiff(null);
    try {
      const snapshotResponse = await apiFetch(`/companies/${companyId}/code/runs/${runId}/snapshot`);
      const snapshotBody = (await snapshotResponse.json()) as { status?: string; snapshot?: SnapshotView; error?: { message?: string } };
      if (!snapshotResponse.ok) throw new Error(snapshotBody.error?.message ?? "snapshot request failed");
      if (snapshotBody.status === "legacy_no_snapshot") {
        setLegacy(true);
        setSnapshot(null);
      } else {
        setLegacy(false);
        setSnapshot(snapshotBody.snapshot ?? null);
      }
      const replayResponse = await apiFetch(`/companies/${companyId}/code/runs/${runId}/replay`);
      const replayBody = (await replayResponse.json()) as { status?: string; replay?: ReplayView };
      if (replayResponse.ok && replayBody.status === "bundle") {
        setNoBundle(false);
        setReplay(replayBody.replay ?? null);
      } else {
        setNoBundle(true);
        setReplay(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isUk ? "Запит не вдався" : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [companyId, runId, isUk]);

  useEffect(() => {
    void load();
  }, [load]);

  const fields = useMemo(() => (snapshot ? snapshotFields(snapshot.payload, isUk) : []), [snapshot, isUk]);
  const missingSources = useMemo(() => fields.filter((field) => field.unreadable).map((field) => field.label), [fields]);

  /** Compare the current run's snapshot with another run's: the server computes the diff. */
  const compare = useCallback(async () => {
    if (!snapshot || !compareRunId.trim()) return;
    setCompareError(null);
    setDiff(null);
    try {
      const other = await apiFetch(`/companies/${companyId}/code/runs/${compareRunId.trim()}/snapshot`);
      const otherBody = (await other.json()) as { status?: string; snapshot?: SnapshotView; error?: { message?: string } };
      if (!other.ok) throw new Error(otherBody.error?.message ?? "snapshot request failed");
      if (otherBody.status !== "snapshot" || !otherBody.snapshot) {
        setCompareError(isUk ? "У вказаного run-у немає снапшота (legacy_no_snapshot)." : "That run has no snapshot (legacy_no_snapshot).");
        return;
      }
      const response = await apiFetch(
        `/companies/${companyId}/code/snapshots/compare?a=${encodeURIComponent(snapshot.snapshotId)}&b=${encodeURIComponent(otherBody.snapshot.snapshotId)}`,
      );
      const body = (await response.json()) as { diff?: { changed?: string[]; unchanged?: string[] }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "compare failed");
      setDiff({ changed: body.diff?.changed ?? [], unchanged: body.diff?.unchanged ?? [] });
    } catch (cause) {
      setCompareError(cause instanceof Error ? cause.message : isUk ? "Порівняння не вдалося" : "Comparison failed");
    }
  }, [companyId, compareRunId, isUk, snapshot]);

  return (
    <section className="ds-section-title" aria-label={isUk ? "Чому агент так діяв" : "Why did the agent act this way"}>
      <header>
        <h3>{isUk ? "Чому агент так діяв (C6b)" : "Why did the agent act this way (C6b)"}</h3>
        <p className="ds-muted">
          {isUk
            ? "Незмінний снапшот середовища й політик цього run-у, порівняння з іншим run-ом і статус відтворення."
            : "The immutable environment/policy snapshot of this run, a comparison with another run, and the replay status."}
        </p>
      </header>

      {loading && <p className="ds-muted">{isUk ? "Завантаження…" : "Loading…"}</p>}
      {error && <div className="data-studio-alert error" role="alert">{error}</div>}

      {legacy && (
        <div className="data-studio-alert info" role="status">
          {isUk
            ? "Цей run записано до появи снапшотів (legacy_no_snapshot) — пояснити середовище неможливо, помилки немає."
            : "This run was recorded before execution snapshots existed (legacy_no_snapshot) — the environment cannot be explained, and that is not an error."}
        </div>
      )}

      {snapshot && (
        <div className="automations-table-container">
          <table className="automations-table">
            <tbody>
              {fields.map((field) => (
                <tr key={field.label}>
                  <td className="automation-title-cell">{field.label}</td>
                  <td className={field.unreadable ? "ds-muted" : undefined}>
                    <code>{field.value}</code>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="automation-title-cell">{isUk ? "Снапшот" : "Snapshot"}</td>
                <td className="ds-muted">
                  v{snapshot.snapshotVersion} · {snapshot.trigger} · {snapshot.payloadHash.slice(0, 18)}… · {snapshot.createdBy}
                </td>
              </tr>
            </tbody>
          </table>
          {missingSources.length > 0 && (
            <div className="data-studio-alert warning" role="status">
              {isUk ? "Не вдалося прочитати: " : "Could not be read: "}
              {missingSources.join(", ")}
            </div>
          )}
        </div>
      )}

      {snapshot && (
        <div className="code-detail-row">
          <label className="browser-form-field">
            <span>{isUk ? "Порівняти з іншим run (id)" : "Compare with another run (id)"}</span>
            <input
              type="text"
              value={compareRunId}
              onChange={(event) => setCompareRunId(event.target.value)}
              placeholder={isUk ? "run id" : "run id"}
            />
          </label>
          <div className="browser-form-footer">
            <button type="button" className="button-secondary" disabled={!compareRunId.trim()} onClick={() => void compare()}>
              {isUk ? "Порівняти снапшот" : "Compare snapshot"}
            </button>
          </div>
          {compareError && <div className="data-studio-alert error" role="alert">{compareError}</div>}
          {diff && (
            <div className="data-studio-alert info" role="status">
              <div>
                {isUk ? "Змінилось: " : "Changed: "}
                {diff.changed.length ? diff.changed.map((path) => <code key={path}>{path} </code>) : isUk ? "нічого" : "nothing"}
              </div>
              <div className="ds-muted">
                {isUk ? "Без змін: " : "Unchanged: "}
                {diff.unchanged.join(", ") || "—"}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="code-detail-row">
        <span>{isUk ? "Replay" : "Replay"}</span>
        {noBundle ? (
          <span className="ds-muted">
            {isUk ? "Запису для відтворення немає (no_bundle)." : "No recorded replay bundle (no_bundle)."}
          </span>
        ) : replay ? (
          <>
            <span className="data-studio-badge">{replay.replayMode}</span>
            <span className="ds-muted">
              {isUk ? "кроків" : "steps"}: {replay.stepCount} · {isUk ? "термінальний статус" : "terminal status"}:{" "}
              {replay.terminalStatus ?? "—"} · {isUk ? "раннер" : "runner"} {replay.runnerVersion ?? "—"}
            </span>
            {replay.bestEffort && (
              <div className="data-studio-alert warning" role="status">
                {replay.notice ?? "Best-effort reproducibility. External models, registries and services may have changed."}
              </div>
            )}
          </>
        ) : (
          <span className="ds-muted">—</span>
        )}
      </div>

      {/*
        C8: the trust control sits with the trust *fact* the snapshot already shows. It is mounted only when the
        snapshot names a project, because `expectedRevision` is read from the trust endpoint per project — and
        without a project there is nothing to grant trust to. Without this control `trust()` was unreachable, so
        the trust-gated behaviour could never have been exercised in production.
      */}
      {snapshot?.projectId ? (
        <CodeTrustPanel companyId={companyId} projectId={snapshot.projectId} isUk={isUk} />
      ) : null}
    </section>
  );
}

export default CodeSnapshotPanel;
