import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

/**
 * C5b: provider data policy panel (Settings -> Code).
 *
 * What this panel is for: answering, in one place, **which provider may receive this project's data and
 * why not**. Everything it shows comes from the server — the effective policy, the staleness warning, the
 * consent state and the eligibility verdict are all computed by `provider-data-policy.ts` /
 * `provider-data-policy-service.ts`, so the UI can never disagree with the guard that enforces them.
 *
 * The panel deliberately does not hide the refusal: a caller who may not change the policy sees the
 * refusal reason the server returned (`permission_denied`, `agent_cannot_change_policy`, ...) instead of a
 * disabled button with no explanation.
 */

type Classification = "public" | "internal" | "confidential" | "restricted";
type ProviderKind = "hosted_third_party" | "self_hosted" | "local";

interface ProviderPolicyView {
  id: string;
  providerId: string;
  modelPattern: string | null;
  policyVersion: number;
  kind: ProviderKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: Classification;
  allowPromptCaching: boolean;
  externalRetention: string;
  trainingPolicy: "no_training" | "may_train" | "unknown";
  region: string | null;
  jurisdiction: string | null;
  requiredRedactions: string[];
  allowedContentTypes: string[];
  termsUrl: string | null;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
  stale: boolean;
  staleReason: string | null;
  warnings: string[];
}

interface CodeProjectSummary {
  id: string;
  name: string;
  status?: string;
}

interface ProjectPolicyView {
  projectId: string;
  dataClassification: Classification;
  /** The project record's own (C1) classification. */
  projectRecordClassification?: Classification;
  /** The strictest of the two — what the guard uses. */
  effectiveClassification?: Classification;
  effectiveFromProjectRecord?: boolean;
  pathRules: { pattern: string; classification: Classification }[];
  policyVersion: number;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface EligibilityEntry {
  providerId: string;
  model: string | null;
  eligible: boolean;
  reasons: string[];
  hosted: boolean;
  hostedConsentGranted: boolean;
  dataClassification: Classification;
  maxDataClassification: Classification;
  policyVersion: number | null;
  stale: boolean;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & {
      code?: string;
      status?: number;
      details?: unknown;
    };
    error.code = result?.error?.code;
    error.status = response.status;
    error.details = result?.error?.details;
    throw error;
  }
  return result as T;
}

const CLASSIFICATIONS: Classification[] = ["public", "internal", "confidential", "restricted"];
const KINDS: ProviderKind[] = ["hosted_third_party", "self_hosted", "local"];
const CONTENT_TYPES = ["metadata", "prompt", "code", "diff", "files", "logs", "terminal", "web", "embeddings"];
const REDACTIONS = ["secrets", "tokens", "keys", "pii", "email", "internal_hostnames"];

function classificationLabel(value: Classification | undefined, isUk: boolean): string {
  switch (value) {
    case "public": return isUk ? "публічні" : "public";
    case "internal": return isUk ? "внутрішні" : "internal";
    case "confidential": return isUk ? "конфіденційні" : "confidential";
    case "restricted": return isUk ? "суворо обмежені" : "restricted";
    default: return "—";
  }
}

function kindLabel(value: ProviderKind, isUk: boolean): string {
  switch (value) {
    case "hosted_third_party": return isUk ? "зовнішній (hosted)" : "hosted third party";
    case "self_hosted": return isUk ? "self-hosted" : "self-hosted";
    case "local": return isUk ? "локальний" : "local";
    default: return value;
  }
}

/** Human copy for the policy refusal codes, so a refusal explains itself. */
function policyErrorMessage(error: unknown, isUk: boolean): string {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  const fallback = error instanceof Error ? error.message : isUk ? "Запит не вдався" : "Request failed";
  switch (code) {
    case "permission_denied":
      return isUk
        ? "Змінювати політику даних може лише власник компанії (owner): потрібне право code.policy.manage."
        : "Only the company owner may change the data policy (the code.policy.manage permission is required).";
    case "agent_cannot_change_policy":
      return isUk ? "Агент або сервіс не може змінювати політику даних." : "An agent or service identity cannot change the data policy.";
    case "action_not_mapped":
      return isUk ? "Дія невідома серверу — відмовлено за замовчуванням." : "The server does not know this action; refused by default.";
    case "permission_action_mismatch":
      return isUk ? "Право не відповідає дії — запит відхилено." : "The permission does not match the action; the request was refused.";
    case "audit_unavailable":
      return isUk ? "Журнал аудиту недоступний — зміну не застосовано." : "The audit journal is unavailable, so the change was not applied.";
    case "data_policy_revision_conflict":
      return isUk ? "Політику змінено в іншій сесії. Оновіть панель." : "The policy changed elsewhere. Refresh the panel.";
    case "invalid_policy_path_rule":
      return isUk ? "Правило шляху некоректне: воно мусить лишатися всередині проєкту." : "The path rule is invalid: it must stay inside the project.";
    case "invalid_classification":
      return isUk ? "Некоректна класифікація." : "Invalid classification.";
    case "invalid_retention":
      return isUk ? "Некоректний формат зберігання (none, unknown або N_days:<n>)." : "Invalid retention format (none, unknown or N_days:<n>).";
    default:
      return fallback;
  }
}

interface ProviderDraft {
  kind: ProviderKind;
  maxDataClassification: Classification;
  allowPrivateRepoCode: boolean;
  allowPromptCaching: boolean;
  externalRetention: string;
  trainingPolicy: "no_training" | "may_train" | "unknown";
  region: string;
  jurisdiction: string;
  termsUrl: string;
  reviewedBy: string;
  lastReviewedAt: string;
  requiredRedactions: string[];
  allowedContentTypes: string[];
}

function draftFromPolicy(policy: ProviderPolicyView): ProviderDraft {
  return {
    kind: policy.kind,
    maxDataClassification: policy.maxDataClassification,
    allowPrivateRepoCode: policy.allowPrivateRepoCode,
    allowPromptCaching: policy.allowPromptCaching,
    externalRetention: policy.externalRetention,
    trainingPolicy: policy.trainingPolicy,
    region: policy.region ?? "",
    jurisdiction: policy.jurisdiction ?? "",
    termsUrl: policy.termsUrl ?? "",
    reviewedBy: policy.reviewedBy ?? "",
    lastReviewedAt: policy.lastReviewedAt ? policy.lastReviewedAt.slice(0, 10) : "",
    requiredRedactions: policy.requiredRedactions,
    allowedContentTypes: policy.allowedContentTypes,
  };
}

export function CodeDataPolicyPanel({ companyId, isUk, notify }: {
  companyId: string;
  isUk: boolean;
  notify: (type: "success" | "error", message: string) => void;
}) {
  const [policies, setPolicies] = useState<ProviderPolicyView[]>([]);
  const [platformDefaults, setPlatformDefaults] = useState<ProviderPolicyView[]>([]);
  const [projects, setProjects] = useState<CodeProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [projectPolicy, setProjectPolicy] = useState<ProjectPolicyView | null>(null);
  const [pathRulesText, setPathRulesText] = useState<string>("");
  const [eligibility, setEligibility] = useState<EligibilityEntry[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = "/companies/" + encodeURIComponent(companyId) + "/code/data-policy";

  const loadProviders = useCallback(async () => {
    const body = await apiFetch<{ policies: ProviderPolicyView[]; platformDefaults: ProviderPolicyView[] }>(`${base}/providers`);
    setPolicies(body.policies ?? []);
    setPlatformDefaults(body.platformDefaults ?? []);
  }, [base]);

  const loadProject = useCallback(async (id: string) => {
    if (!id) {
      setProjectPolicy(null);
      setEligibility(null);
      return;
    }
    const body = await apiFetch<{ projectPolicy: ProjectPolicyView }>(`${base}/projects/${encodeURIComponent(id)}`);
    setProjectPolicy(body.projectPolicy);
    setPathRulesText((body.projectPolicy.pathRules ?? []).map((rule) => `${rule.pattern} = ${rule.classification}`).join("\n"));
  }, [base]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      loadProviders(),
      apiFetch<{ projects: CodeProjectSummary[] }>(`/companies/${encodeURIComponent(companyId)}/code/projects?includeArchived=true`)
        .then((body) => body.projects ?? []),
    ])
      .then(([, projectList]) => {
        if (cancelled) return;
        setProjects(projectList);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(policyErrorMessage(cause, isUk));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, isUk, loadProviders]);

  useEffect(() => {
    if (!projectId) return;
    void loadProject(projectId).catch((cause) => setError(policyErrorMessage(cause, isUk)));
  }, [projectId, isUk, loadProject]);

  const saveProvider = useCallback(async (providerId: string, modelPattern: string | null, value: ProviderDraft) => {
    setSaving(true);
    try {
      const current = policies.find((policy) => policy.providerId === providerId && policy.modelPattern === modelPattern);
      await apiFetch(`${base}/providers/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: JSON.stringify({
          modelPattern,
          kind: value.kind,
          maxDataClassification: value.maxDataClassification,
          allowPrivateRepoCode: value.allowPrivateRepoCode,
          allowPromptCaching: value.allowPromptCaching,
          externalRetention: value.externalRetention,
          trainingPolicy: value.trainingPolicy,
          region: value.region || null,
          jurisdiction: value.jurisdiction || null,
          termsUrl: value.termsUrl || null,
          reviewedBy: value.reviewedBy || null,
          lastReviewedAt: value.lastReviewedAt ? new Date(value.lastReviewedAt).toISOString() : null,
          requiredRedactions: value.requiredRedactions,
          allowedContentTypes: value.allowedContentTypes,
          ...(current ? { expectedPolicyVersion: current.policyVersion } : {}),
        }),
      });
      setEditing(null);
      setDraft(null);
      await loadProviders();
      notify("success", isUk ? "Політику провайдера збережено (нова версія)." : "Provider policy saved (new version).");
    } catch (cause) {
      notify("error", policyErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  }, [base, isUk, loadProviders, notify, policies]);

  const saveProject = useCallback(async () => {
    if (!projectId || !projectPolicy) return;
    const pathRules: { pattern: string; classification: Classification }[] = [];
    for (const rawLine of pathRulesText.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const [pattern, classification] = line.split("=").map((part) => part.trim());
      if (!pattern || !classification || !CLASSIFICATIONS.includes(classification as Classification)) {
        notify("error", isUk
          ? `Некоректний рядок правила: «${line}». Формат: pattern = classification`
          : `Invalid path rule line: “${line}”. Format: pattern = classification`);
        return;
      }
      pathRules.push({ pattern, classification: classification as Classification });
    }
    setSaving(true);
    try {
      await apiFetch(`${base}/projects/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        body: JSON.stringify({ pathRules, expectedPolicyVersion: projectPolicy.configured ? projectPolicy.policyVersion : null }),
      });
      await loadProject(projectId);
      notify("success", isUk ? "Політику проєкту збережено." : "Project policy saved.");
    } catch (cause) {
      notify("error", policyErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  }, [base, isUk, loadProject, notify, pathRulesText, projectId, projectPolicy]);

  const changeClassification = useCallback(async (classification: Classification) => {
    if (!projectId || !projectPolicy) return;
    setSaving(true);
    try {
      await apiFetch(`${base}/projects/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        body: JSON.stringify({
          dataClassification: classification,
          expectedPolicyVersion: projectPolicy.configured ? projectPolicy.policyVersion : null,
        }),
      });
      await loadProject(projectId);
      notify("success", isUk ? "Класифікацію проєкту оновлено." : "Project classification updated.");
    } catch (cause) {
      notify("error", policyErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  }, [base, isUk, loadProject, notify, projectId, projectPolicy]);

  const setConsent = useCallback(async (providerId: string, granted: boolean) => {
    if (!projectId) return;
    setSaving(true);
    try {
      await apiFetch(
        `${base}/projects/${encodeURIComponent(projectId)}/hosted-consent${granted ? "" : `?providerId=${encodeURIComponent(providerId)}`}`,
        granted
          ? { method: "POST", body: JSON.stringify({ providerId }) }
          : { method: "DELETE" },
      );
      await loadProject(projectId);
      notify("success", isUk
        ? (granted ? `Згоду на hosted-провайдера ${providerId} збережено.` : `Згоду на ${providerId} відкликано.`)
        : (granted ? `Consent for hosted provider ${providerId} recorded.` : `Consent for ${providerId} withdrawn.`));
    } catch (cause) {
      notify("error", policyErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  }, [base, isUk, loadProject, notify, projectId]);

  const loadEligibility = useCallback(async () => {
    if (!projectId) return;
    try {
      const body = await apiFetch<{ entries: EligibilityEntry[] }>(`${base}/projects/${encodeURIComponent(projectId)}/eligibility?contentTypes=code`);
      setEligibility(body.entries ?? []);
    } catch (cause) {
      notify("error", policyErrorMessage(cause, isUk));
    }
  }, [base, isUk, notify, projectId]);

  const staleCount = useMemo(() => policies.filter((policy) => policy.stale).length, [policies]);

  return (
    <section className="ds-section-title" aria-label={isUk ? "Політика даних провайдерів" : "Provider data policy"}>
      <div>
        <h2>{isUk ? "Політика даних провайдерів (C5b)" : "Provider data policy (C5b)"}</h2>
        <p className="ds-muted">
          {isUk
            ? "Що саме можна надсилати кожному AI-провайдеру. Невідомий hosted-провайдер за замовчуванням отримує лише public-дані без коду й без кешування; змінювати політику може лише власник компанії."
            : "What may be sent to each AI provider. An unknown hosted provider defaults to public data only, with no code and no caching; only the company owner may change the policy."}
        </p>
      </div>

      {loading && <p className="ds-muted">{isUk ? "Завантаження…" : "Loading…"}</p>}
      {error && <div className="data-studio-alert error" role="alert">{error}</div>}

      {!loading && !error && (
        <>
          {staleCount > 0 && (
            <div className="data-studio-alert warning" role="status">
              {isUk
                ? `${staleCount} політик(и) не переглядалися понад 180 днів — перегляньте умови провайдера й оновіть дату.`
                : `${staleCount} policy/policies have not been reviewed for more than 180 days — re-check the provider terms and refresh the date.`}
            </div>
          )}

          {policies.length === 0 ? (
            <div className="data-studio-alert info" role="status">
              {isUk
                ? "Політик ще немає: кожен провайдер вважається зовнішнім і обмежений public-даними, доки власник не налаштує політику."
                : "No policies yet: every provider is treated as a hosted third party limited to public data until an owner configures one."}
            </div>
          ) : (
            <div className="automations-table-container">
              <table className="automations-table">
                <thead>
                  <tr>
                    <th>{isUk ? "Провайдер" : "Provider"}</th>
                    <th>{isUk ? "Тип" : "Kind"}</th>
                    <th>{isUk ? "Макс. клас" : "Max class"}</th>
                    <th>{isUk ? "Приватний код" : "Private code"}</th>
                    <th>Caching</th>
                    <th>Retention</th>
                    <th>Training</th>
                    <th>{isUk ? "Перегляд" : "Reviewed"}</th>
                    <th aria-label={isUk ? "Дії" : "Actions"} />
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <React.Fragment key={policy.id}>
                      <tr>
                        <td className="automation-title-cell">
                          <strong>{policy.providerId}</strong>
                          <span className="ds-muted">{policy.modelPattern ?? (isUk ? "усі моделі" : "all models")}</span>
                          <span className="data-studio-badge">v{policy.policyVersion}</span>
                        </td>
                        <td>{kindLabel(policy.kind, isUk)}</td>
                        <td><span className="data-studio-badge">{classificationLabel(policy.maxDataClassification, isUk)}</span></td>
                        <td>{policy.allowPrivateRepoCode ? "✓" : "✗"}</td>
                        <td>{policy.allowPromptCaching ? "✓" : "✗"}</td>
                        <td><code>{policy.externalRetention}</code></td>
                        <td><code>{policy.trainingPolicy}</code></td>
                        <td className="ds-muted">
                          {policy.lastReviewedAt ? policy.lastReviewedAt.slice(0, 10) : (isUk ? "ніколи" : "never")}
                          {policy.stale && <span className="status-pill blocked">{isUk ? "застаріла" : "stale"}</span>}
                        </td>
                        <td className="automation-actions-cell">
                          <button
                            type="button"
                            className="automation-action-btn"
                            onClick={() => {
                              setEditing(policy.id);
                              setDraft(draftFromPolicy(policy));
                            }}
                          >
                            {isUk ? "Редагувати" : "Edit"}
                          </button>
                        </td>
                      </tr>
                      {policy.warnings.length > 0 && (
                        <tr>
                          <td colSpan={9} className="ds-muted">{policy.warnings.join(" · ")}</td>
                        </tr>
                      )}
                      {editing === policy.id && draft && (
                        <tr>
                          <td colSpan={9}>
                            <ProviderPolicyEditor
                              isUk={isUk}
                              draft={draft}
                              saving={saving}
                              onChange={setDraft}
                              onCancel={() => { setEditing(null); setDraft(null); }}
                              onSave={() => void saveProvider(policy.providerId, policy.modelPattern, draft)}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {platformDefaults.length > 0 && (
            <details className="code-limits">
              <summary>{isUk ? "Платформенні дефолти (усі компанії)" : "Platform defaults (all companies)"}</summary>
              <ul>
                {platformDefaults.map((policy) => (
                  <li key={policy.id}>
                    <code>{policy.providerId}</code>
                    <span>{kindLabel(policy.kind, isUk)} · {classificationLabel(policy.maxDataClassification, isUk)} · v{policy.policyVersion}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <section className="ds-section-title">
            <div>
              <h3>{isUk ? "Проєкт" : "Project"}</h3>
              <p className="ds-muted">
                {isUk
                  ? "Класифікація проєкту та правила за шляхами. Зниження класу вимагає ролі власника; підвищення — звичайний запис."
                  : "Project classification and path rules. Lowering the class requires the owner role; raising it is an ordinary write."}
              </p>
            </div>
          </section>

          <label className="browser-form-field">
            <span>{isUk ? "Код-проєкт" : "Code project"}</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">{isUk ? "— оберіть проєкт —" : "— select a project —"}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>

          {projectPolicy && (
            <>
              <div className="code-detail-row">
                <span>{isUk ? "Ефективна класифікація (для передачі)" : "Effective classification (for transfer)"}</span>
                <span>
                  <span className="data-studio-badge">
                    {classificationLabel(projectPolicy.effectiveClassification ?? projectPolicy.dataClassification, isUk)}
                  </span>
                  {projectPolicy.effectiveFromProjectRecord && (
                    <small className="ds-muted">
                      {" "}
                      {isUk
                        ? `(піднята класифікацією проєкту: ${classificationLabel(projectPolicy.projectRecordClassification, isUk)})`
                        : `(raised by the project classification: ${classificationLabel(projectPolicy.projectRecordClassification, isUk)})`}
                    </small>
                  )}
                </span>
              </div>
              <div className="code-detail-row">
                <span>{isUk ? "Класифікація" : "Classification"}</span>
                <select
                  value={projectPolicy.dataClassification}
                  disabled={saving}
                  onChange={(event) => void changeClassification(event.target.value as Classification)}
                >
                  {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{classificationLabel(value, isUk)}</option>)}
                </select>
              </div>
              <label className="browser-form-field">
                <span>{isUk ? "Правила за шляхами (по одному на рядок)" : "Path rules (one per line)"}</span>
                <textarea
                  rows={4}
                  value={pathRulesText}
                  placeholder={"**/secrets/** = restricted\nvendor/** = public"}
                  onChange={(event) => setPathRulesText(event.target.value)}
                />
                <small>
                  {isUk
                    ? "Формат: pattern = classification. Правило з «..» або абсолютним шляхом відхиляється сервером."
                    : "Format: pattern = classification. A rule using “..” or an absolute path is refused by the server."}
                </small>
              </label>
              <div className="browser-form-footer">
                <button type="button" className="button-secondary" disabled={saving} onClick={() => void saveProject()}>
                  {isUk ? "Зберегти політику проєкту" : "Save project policy"}
                </button>
                <button type="button" className="button-secondary" disabled={saving} onClick={() => void loadEligibility()}>
                  {isUk ? "Перевірити, хто отримає код" : "Check who receives the code"}
                </button>
              </div>

              {eligibility && (
                <div className="automations-table-container">
                  <table className="automations-table">
                    <thead>
                      <tr>
                        <th>{isUk ? "Провайдер" : "Provider"}</th>
                        <th>{isUk ? "Доступний" : "Eligible"}</th>
                        <th>{isUk ? "Причина" : "Reason"}</th>
                        <th>{isUk ? "Згода" : "Consent"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eligibility.length === 0 && (
                        <tr><td colSpan={4} className="ds-muted">
                          {isUk
                            ? "Жодного налаштованого провайдера: політика за замовчуванням не дозволяє передавати код."
                            : "No configured provider: the default policy does not allow sending code."}
                        </td></tr>
                      )}
                      {eligibility.map((entry) => (
                        <tr key={`${entry.providerId}:${entry.model ?? "*"}`}>
                          <td><strong>{entry.providerId}</strong> <span className="ds-muted">{entry.model ?? (isUk ? "усі моделі" : "all models")}</span></td>
                          <td>
                            <span className={`status-pill ${entry.eligible ? "verified" : "blocked"}`}>
                              {entry.eligible ? (isUk ? "так" : "yes") : (isUk ? "ні" : "no")}
                            </span>
                          </td>
                          <td className="ds-muted">{entry.reasons.length ? entry.reasons.join(", ") : "—"}</td>
                          <td>
                            {entry.hosted ? (
                              <>
                                <span className="data-studio-badge">{entry.hostedConsentGranted ? (isUk ? "надано" : "granted") : (isUk ? "потрібна" : "required")}</span>
                                <button
                                  type="button"
                                  className="automation-action-btn"
                                  disabled={saving}
                                  onClick={() => void setConsent(entry.providerId, !entry.hostedConsentGranted)}
                                >
                                  {entry.hostedConsentGranted ? (isUk ? "Відкликати" : "Withdraw") : (isUk ? "Дати згоду" : "Grant")}
                                </button>
                              </>
                            ) : <span className="ds-muted">{isUk ? "не потрібна" : "not required"}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ProviderPolicyEditor({ isUk, draft, saving, onChange, onCancel, onSave }: {
  isUk: boolean;
  draft: ProviderDraft;
  saving: boolean;
  onChange: (draft: ProviderDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return (
    <div className="code-detail-row" style={{ display: "grid", gap: 8 }}>
      <label className="browser-form-field">
        <span>{isUk ? "Тип провайдера" : "Provider kind"}</span>
        <select value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as ProviderKind })}>
          {KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel(kind, isUk)}</option>)}
        </select>
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Максимальна класифікація" : "Maximum classification"}</span>
        <select
          value={draft.maxDataClassification}
          onChange={(event) => onChange({ ...draft, maxDataClassification: event.target.value as Classification })}
        >
          {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{classificationLabel(value, isUk)}</option>)}
        </select>
      </label>
      <label className="ds-checkbox">
        <input
          type="checkbox"
          checked={draft.allowPrivateRepoCode}
          onChange={(event) => onChange({ ...draft, allowPrivateRepoCode: event.target.checked })}
        />
        <span>{isUk ? "Дозволити приватний код репозиторію" : "Allow private repository code"}</span>
      </label>
      <label className="ds-checkbox">
        <input
          type="checkbox"
          checked={draft.allowPromptCaching}
          onChange={(event) => onChange({ ...draft, allowPromptCaching: event.target.checked })}
        />
        <span>{isUk ? "Дозволити prompt caching" : "Allow prompt caching"}</span>
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Зберігання назовні (none / unknown / N_days:<n>)" : "External retention (none / unknown / N_days:<n>)"}</span>
        <input value={draft.externalRetention} onChange={(event) => onChange({ ...draft, externalRetention: event.target.value })} />
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Політика навчання" : "Training policy"}</span>
        <select
          value={draft.trainingPolicy}
          onChange={(event) => onChange({ ...draft, trainingPolicy: event.target.value as ProviderDraft["trainingPolicy"] })}
        >
          {["no_training", "may_train", "unknown"].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <div>
        <span className="ds-muted">{isUk ? "Обов'язкова редакція (secrets/tokens/keys не можна вимкнути)" : "Mandatory redaction (secrets/tokens/keys cannot be switched off)"}</span>
        <div>
          {REDACTIONS.map((kind) => (
            <label className="ds-checkbox" key={kind}>
              <input
                type="checkbox"
                checked={draft.requiredRedactions.includes(kind)}
                disabled={["secrets", "tokens", "keys"].includes(kind)}
                onChange={() => onChange({ ...draft, requiredRedactions: toggle(draft.requiredRedactions, kind) })}
              />
              <span>{kind}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <span className="ds-muted">{isUk ? "Дозволені типи вмісту" : "Allowed content types"}</span>
        <div>
          {CONTENT_TYPES.map((contentType) => (
            <label className="ds-checkbox" key={contentType}>
              <input
                type="checkbox"
                checked={draft.allowedContentTypes.includes(contentType)}
                onChange={() => onChange({ ...draft, allowedContentTypes: toggle(draft.allowedContentTypes, contentType) })}
              />
              <span>{contentType}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="browser-form-field">
        <span>{isUk ? "Регіон" : "Region"}</span>
        <input value={draft.region} onChange={(event) => onChange({ ...draft, region: event.target.value })} />
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Юрисдикція" : "Jurisdiction"}</span>
        <input value={draft.jurisdiction} onChange={(event) => onChange({ ...draft, jurisdiction: event.target.value })} />
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Умови провайдера (URL)" : "Provider terms (URL)"}</span>
        <input value={draft.termsUrl} onChange={(event) => onChange({ ...draft, termsUrl: event.target.value })} />
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Переглянув" : "Reviewed by"}</span>
        <input value={draft.reviewedBy} onChange={(event) => onChange({ ...draft, reviewedBy: event.target.value })} />
      </label>
      <label className="browser-form-field">
        <span>{isUk ? "Дата перегляду" : "Review date"}</span>
        <input type="date" value={draft.lastReviewedAt} onChange={(event) => onChange({ ...draft, lastReviewedAt: event.target.value })} />
      </label>
      <div className="browser-form-footer">
        <button type="button" className="button-secondary" disabled={saving} onClick={onCancel}>
          {isUk ? "Скасувати" : "Cancel"}
        </button>
        <button type="button" className="button-primary automations-action-primary" disabled={saving} onClick={onSave}>
          {saving ? (isUk ? "Збереження…" : "Saving…") : (isUk ? "Зберегти (нова версія)" : "Save (new version)")}
        </button>
      </div>
    </div>
  );
}
