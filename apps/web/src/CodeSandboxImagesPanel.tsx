import { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal } from "./ConfirmDialog";
import { Drawer } from "./code-settings/Drawer";

/**
 * C1b: sandbox image administration panel (Settings -> Code).
 *
 * Images must be digest-pinned; the panel enforces that on the client as well as on the server, shows
 * scan and waiver state, and offers an admission check so an operator can see whether a given image
 * would be admitted before a run starts. Nothing here starts a sandbox.
 */

export type SandboxImageStatus = "unverified" | "verified" | "deprecated" | "revoked";

interface SandboxImage {
  id: string;
  variant: string;
  reference: string;
  digest: string;
  status: SandboxImageStatus;
  signature?: string | null;
  sbomPath?: string | null;
  scanTool?: string | null;
  scanAt?: string | null;
  scanCritical?: number | null;
  scanHigh?: number | null;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  previousReference?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImagesState {
  images: SandboxImage[];
  catalog: { configured: boolean; path?: string };
  policy: { maxScanAgeDays: number; allowUnverified: boolean };
}

const PINNED_REFERENCE = /@sha256:[0-9a-f]{64}$/;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `HTTP ${response.status}: Request failed`) as Error & { code?: string; status?: number; details?: unknown };
    error.code = result?.error?.code;
    error.status = response.status;
    error.details = result?.error?.details;
    throw error;
  }
  return result as T;
}

export function imageErrorMessage(error: unknown, isUk: boolean): string {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  switch (code) {
    case "image_not_pinned":
      return isUk
        ? "Образ мусить бути закріплений за digest (repo@sha256:<64 hex>), тег або :latest заборонені."
        : "The image must be digest-pinned (repo@sha256:<64 hex>); tags and :latest are refused.";
    case "image_admin_required":
      return isUk ? "Керувати образами може лише власник/адміністратор компанії." : "Only the company owner/admin can manage images.";
    case "image_not_allowed":
      return isUk ? "Образ не допущений політикою (підпис, SBOM, скан або waiver)." : "The image is not admitted by policy (signature, SBOM, scan or waiver).";
    case "image_revoked":
      return isUk ? "Образ уже відкликано; потрібен новий закріплений образ." : "The image is already revoked; a new pinned image is required.";
    case "image_signature_invalid":
      return isUk ? "Підпис образу недійсний або відсутній там, де потрібен." : "The image signature is invalid or missing where it is required.";
    case "image_digest_mismatch":
      return isUk ? "Digest запущеного образу не збігається із зареєстрованим." : "The running image digest does not match the recorded one.";
    case "image_scan_stale":
      return isUk ? "Скан застарілий (перевищено maxScanAgeDays)." : "The scan is stale (maxScanAgeDays exceeded).";
    case "image_scan_failed":
      return isUk ? "Скан не прийнято: перевірте tool, critical і high." : "The scan was rejected: check tool, critical and high.";
    case "image_waiver_expired":
      return isUk ? "Термін waiver минув." : "The waiver has expired.";
    case "image_unavailable":
      return isUk ? "Політику образів не сконфігуровано." : "The sandbox image policy is not configured.";
    default:
      return error instanceof Error ? error.message : isUk ? "Запит не вдався" : "Request failed";
  }
}

function shortReference(reference: string): string {
  const match = /^(.*)@sha256:([0-9a-f]{64})$/.exec(reference);
  if (!match) return reference;
  return `${match[1]}@sha256:${match[2]!.slice(0, 12)}…`;
}

function statusTone(status: SandboxImageStatus): string {
  if (status === "verified") return "allowed";
  if (status === "revoked") return "denied";
  if (status === "deprecated") return "partial";
  return "default";
}

function scanTone(image: SandboxImage): string {
  if ((image.scanCritical ?? 0) > 0) return "denied";
  if ((image.scanHigh ?? 0) > 0) return "partial";
  if (image.scanAt) return "allowed";
  return "default";
}

export function CodeSandboxImagesPanel({ companyId, isUk, notify }: {
  companyId: string;
  isUk: boolean;
  notify: (type: "success" | "error", message: string) => void;
}) {
  const [state, setState] = useState<ImagesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [admissionReference, setAdmissionReference] = useState("");
  const [admission, setAdmission] = useState<{ ok: boolean; message: string } | null>(null);
  const [form, setForm] = useState({
    variant: "base", reference: "", sbomPath: "", status: "unverified" as SandboxImageStatus,
    scanTool: "", scanCritical: "0", scanHigh: "0", waiverOwner: "",
  });

  const base = `/companies/${companyId}`;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ImagesState>(`${base}/code/sandbox-images`);
      setState(data);
      setError(null);
    } catch (requestError) {
      setError(imageErrorMessage(requestError, isUk));
    } finally {
      setLoading(false);
    }
  }, [base, isUk]);

  useEffect(() => { void reload(); }, [reload]);

  const stats = useMemo(() => {
    const images = state?.images ?? [];
    return {
      total: images.length,
      verified: images.filter((image) => image.status === "verified").length,
      revoked: images.filter((image) => image.status === "revoked").length,
      critical: images.reduce((sum, image) => sum + (image.scanCritical ?? 0), 0),
    };
  }, [state]);

  const referenceError = form.reference && !PINNED_REFERENCE.test(form.reference.trim())
    ? (isUk ? "Потрібен repo@sha256:<64 hex> без тегів і :latest" : "Requires repo@sha256:<64 hex>, no tags or :latest")
    : null;

  async function submitImage() {
    if (!form.reference.trim() || referenceError) return;
    setBusy("create");
    try {
      await apiFetch(`${base}/code/sandbox-images`, {
        method: "POST",
        body: JSON.stringify({
          variant: form.variant,
          reference: form.reference.trim(),
          status: form.status,
          sbomPath: form.sbomPath.trim() || undefined,
          scan: form.scanTool.trim()
            ? { tool: form.scanTool.trim(), critical: Number(form.scanCritical || 0), high: Number(form.scanHigh || 0) }
            : undefined,
          waiver: form.waiverOwner.trim() ? { owner: form.waiverOwner.trim() } : undefined,
        }),
      });
      notify("success", isUk ? "Образ додано" : "Image added");
      setDrawerOpen(false);
      setForm({ variant: "base", reference: "", sbomPath: "", status: "unverified", scanTool: "", scanCritical: "0", scanHigh: "0", waiverOwner: "" });
      await reload();
    } catch (requestError) {
      notify("error", imageErrorMessage(requestError, isUk));
    } finally {
      setBusy(null);
    }
  }

  async function revokeImage(image: SandboxImage) {
    const confirmed = await confirmModal({
      title: isUk ? "Відкликати образ?" : "Revoke image?",
      message: isUk
        ? "Сесії на цьому digest будуть примусово переведені на заміну, а нові запуски з ним — заблоковані."
        : "Sessions on this digest will be forced onto a replacement and new runs with it are blocked.",
      confirmText: isUk ? "Відкликати" : "Revoke",
      isDanger: true,
    });
    if (!confirmed) return;
    setBusy(image.id);
    try {
      await apiFetch(`${base}/code/sandbox-images/revoke`, {
        method: "POST",
        body: JSON.stringify({ reference: image.reference, reason: isUk ? "Відкликано оператором зі сторінки Code" : "Revoked by an operator from the Code page" }),
      });
      notify("success", isUk ? "Образ відкликано" : "Image revoked");
      await reload();
    } catch (requestError) {
      notify("error", imageErrorMessage(requestError, isUk));
    } finally {
      setBusy(null);
    }
  }

  async function recordScan(image: SandboxImage) {
    setBusy(image.id);
    try {
      await apiFetch(`${base}/code/sandbox-images/${image.id}/scan`, {
        method: "POST",
        body: JSON.stringify({ tool: "trivy", critical: 0, high: 0 }),
      });
      notify("success", isUk ? "Скан записано" : "Scan recorded");
      await reload();
    } catch (requestError) {
      notify("error", imageErrorMessage(requestError, isUk));
    } finally {
      setBusy(null);
    }
  }

  async function runAdmissionCheck() {
    setAdmission(null);
    setBusy("admission");
    try {
      const result = await apiFetch<{ allowed: boolean; reference?: string; digest?: string }>(`${base}/code/sandbox-images/admission-check`, {
        method: "POST",
        body: JSON.stringify({ reference: admissionReference.trim() || undefined }),
      });
      setAdmission({ ok: true, message: (isUk ? "Допущено: " : "Admitted: ") + (result.reference ?? "") });
    } catch (requestError) {
      const code = (requestError as Error & { code?: string }).code;
      setAdmission({ ok: false, message: `${code ?? "error"} — ${imageErrorMessage(requestError, isUk)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="browser-campaign-card code-sandbox-images-panel" aria-label={isUk ? "Образи sandbox" : "Sandbox images"}>
      <div className="browser-campaign-card-header">
        <div className="browser-card-title-group">
          <span className="browser-card-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
          </span>
          <div>
            <h3>{isUk ? "Образи sandbox" : "Sandbox images"}</h3>
            <p>
              {isUk
                ? "Лише образи, закріплені за digest, допускаються до запуску. Скани, SBOM і waiver враховуються політикою."
                : "Only digest-pinned images are admitted. Scans, SBOM and waivers are enforced by policy."}
            </p>
          </div>
        </div>
        <div className="code-images-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button type="button" className="button-secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? (isUk ? "Оновлення…" : "Refreshing…") : (isUk ? "Оновити" : "Refresh")}
          </button>
          <button type="button" className="button-primary" onClick={() => setDrawerOpen(true)}>
            {isUk ? "＋ Додати образ" : "＋ Add image"}
          </button>
        </div>
      </div>

      {error && <div className="data-studio-alert error">{error}</div>}


      <div className="overview-grid inspector-stats-grid" style={{ marginBottom: "20px" }}>
        <div>
          <strong>{stats.total}</strong>
          <span>{isUk ? "Усього" : "Total"}</span>
          <small>{isUk ? "Зареєстровані образи" : "Registered sandbox images"}</small>
        </div>
        <div>
          <strong>{stats.verified}</strong>
          <span>{isUk ? "Перевірено" : "Verified"}</span>
          <small>{isUk ? "Допущені політикою" : "Admitted by policy"}</small>
        </div>
        <div>
          <strong>{stats.revoked}</strong>
          <span>{isUk ? "Відкликано" : "Revoked"}</span>
          <small>{isUk ? "Заблоковані образи" : "Blocked references"}</small>
        </div>
        <div>
          <strong>{stats.critical}</strong>
          <span>Critical</span>
          <small>maxScanAge: {state?.policy?.maxScanAgeDays ?? 14}d</small>
        </div>
      </div>

      {state && state.images.length === 0 && !loading ? (
        <div className="automations-empty-card" style={{ padding: "36px 20px", marginBottom: "18px" }}>
          <div className="automations-empty-icon">🐳</div>
          <p>{isUk ? "Жодного образу не зареєстровано." : "No images registered yet."}</p>
        </div>
      ) : (
        <div className="automations-table-container" style={{ marginBottom: "18px" }}>
          <table className="automations-table">
            <thead>
              <tr>
                <th>{isUk ? "Варіант" : "Variant"}</th>
                <th>{isUk ? "Референс" : "Reference"}</th>
                <th>{isUk ? "Статус" : "Status"}</th>
                <th>{isUk ? "Підпис" : "Signature"}</th>
                <th>SBOM</th>
                <th>{isUk ? "Скан" : "Scan"}</th>
                <th>Waiver</th>
                <th>{isUk ? "Оновлено" : "Updated"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(state?.images ?? []).map((image) => (
                <tr key={image.id}>
                  <td>{image.variant}</td>
                  <td><span className="code-repository" title={image.reference}>{shortReference(image.reference)}</span></td>
                  <td><span className={`status-pill ${statusTone(image.status)}`}>{image.status}</span></td>
                  <td>{image.signature ? <span className="status-pill allowed">{image.signature.slice(0, 20)}</span> : <span className="ds-muted">—</span>}</td>
                  <td>{image.sbomPath ? <span className="ds-muted" title={image.sbomPath}>yes</span> : <span className="ds-muted">—</span>}</td>
                  <td>
                    <span className={`status-pill ${scanTone(image)}`} title={image.scanTool ?? ""}>
                      {image.scanAt ? `${image.scanCritical ?? 0}C / ${image.scanHigh ?? 0}H` : (isUk ? "немає" : "none")}
                    </span>
                  </td>
                  <td>{image.waiverOwner ? <span className="ds-muted">{image.waiverOwner}{image.waiverExpiresAt ? ` · ${image.waiverExpiresAt.slice(0, 10)}` : ""}</span> : <span className="ds-muted">—</span>}</td>
                  <td>{image.updatedAt ? new Date(image.updatedAt).toLocaleString(isUk ? "uk-UA" : "en-US") : "—"}</td>
                  <td className="automation-actions-cell">
                    <button type="button" className="automation-action-btn" disabled={busy === image.id} onClick={() => void recordScan(image)}>
                      {isUk ? "Записати скан" : "Record scan"}
                    </button>
                    <button type="button" className="automation-action-btn danger" disabled={busy === image.id || image.status === "revoked"} onClick={() => void revokeImage(image)}>
                      {isUk ? "Відкликати" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="browser-campaign-card-header" style={{ marginTop: "18px", paddingTop: "20px", borderTop: "1px solid var(--npati-gray-100)" }}>
        <div className="browser-card-title-group">
          <span className="browser-card-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <polyline points="9 12 12 15 16 10" />
            </svg>
          </span>
          <div>
            <h3>{isUk ? "Перевірка допуску (Admission check)" : "Admission check"}</h3>
            <p>
              {isUk
                ? "Перевіряє, чи буде образ допущено до запуску. Нічого не запускає."
                : "Checks whether an image would be admitted to a run. Starts nothing."}
            </p>
          </div>
        </div>
      </div>
      <div className="code-images-admission-row" style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "12px", flexWrap: "wrap" }}>
        <input
          className="inspector-search-input"
          style={{ flex: 1, minWidth: "260px", height: "42px", padding: "0 14px", border: "1px solid #d9d9d9", borderRadius: "10px", fontSize: "13px" }}
          placeholder="ghcr.io/npati/code-sandbox-node@sha256:…"
          value={admissionReference}
          onChange={(event) => setAdmissionReference(event.target.value)}
        />
        <button type="button" className="button-secondary" style={{ height: "42px", padding: "0 18px", borderRadius: "10px" }} onClick={() => void runAdmissionCheck()} disabled={busy === "admission"}>
          {isUk ? "Перевірити" : "Check"}
        </button>
      </div>
      {admission && (
        <div className={`data-studio-alert ${admission.ok ? "info" : "warning"}`} style={{ marginTop: "12px" }}>
          {admission.message}
        </div>
      )}

      {drawerOpen && (
        <Drawer
          title={isUk ? "Додати образ sandbox" : "Add a sandbox image"}
          subtitle={isUk ? "Code · sandbox" : "Code · sandbox"}
          closeLabel={isUk ? "Закрити" : "Close"}
          isUk={isUk}
          onClose={() => setDrawerOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitImage();
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: "calc(100% - 88px)",
            }}
          >
            <section style={{ flex: 1, padding: "22px 26px", display: "grid", gap: "16px" }}>
              <label className="browser-form-field">
                <span>{isUk ? "Варіант" : "Variant"}</span>
                <select
                  value={form.variant}
                  onChange={(event) => setForm({ ...form, variant: event.target.value })}
                >
                  {["base", "node", "python", "php", "go", "rust", "java", "full"].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="browser-form-field">
                <span>
                  {isUk ? "Референс (digest)" : "Reference (digest)"} <i className="required-star">*</i>
                </span>
                <input
                  value={form.reference}
                  onChange={(event) => setForm({ ...form, reference: event.target.value })}
                  placeholder="repo@sha256:…"
                />
                {referenceError && <div className="ds-hint-error">{referenceError}</div>}
              </label>

              <label className="browser-form-field">
                <span>{isUk ? "Статус" : "Status"}</span>
                <select
                  value={form.status}
                  onChange={(event) => setForm({ ...form, status: event.target.value as SandboxImageStatus })}
                >
                  {["unverified", "verified", "deprecated"].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="browser-form-field">
                <span>SBOM</span>
                <input
                  value={form.sbomPath}
                  onChange={(event) => setForm({ ...form, sbomPath: event.target.value })}
                  placeholder="sbom/code-sandbox-node.json"
                />
              </label>

              <div className="browser-form-field">
                <span>{isUk ? "Скан (tool / critical / high)" : "Scan (tool / critical / high)"}</span>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "10px" }}>
                  <input
                    value={form.scanTool}
                    onChange={(event) => setForm({ ...form, scanTool: event.target.value })}
                    placeholder="trivy"
                  />
                  <input
                    type="number"
                    min={0}
                    value={form.scanCritical}
                    onChange={(event) => setForm({ ...form, scanCritical: event.target.value })}
                    placeholder="Critical"
                    title={isUk ? "Кількість критичних" : "Critical count"}
                  />
                  <input
                    type="number"
                    min={0}
                    value={form.scanHigh}
                    onChange={(event) => setForm({ ...form, scanHigh: event.target.value })}
                    placeholder="High"
                    title={isUk ? "Кількість високих" : "High count"}
                  />
                </div>
              </div>

              <label className="browser-form-field">
                <span>{isUk ? "Waiver (власник)" : "Waiver (owner)"}</span>
                <input
                  value={form.waiverOwner}
                  onChange={(event) => setForm({ ...form, waiverOwner: event.target.value })}
                  placeholder="security@company"
                />
              </label>
            </section>

            <footer>
              <span
                className="browser-form-footer-hint"
                style={{ fontSize: "12.5px", color: "var(--npati-gray-500, #64748b)", fontWeight: 500, lineHeight: 1.4 }}
              >
                {isUk ? "Лише закріплені за digest образи; тег або :latest буде відхилено сервером." : "Digest-pinned images only; tags and :latest are refused by the server."}
              </span>
              <button
                type="submit"
                className="button-primary automations-action-primary"
                disabled={busy === "create" || !form.reference.trim() || Boolean(referenceError)}
              >
                {busy === "create"
                  ? isUk
                    ? "Додавання…"
                    : "Adding…"
                  : isUk
                    ? "Додати"
                    : "Add"}
              </button>
            </footer>
          </form>
        </Drawer>
      )}
    </section>
  );
}
