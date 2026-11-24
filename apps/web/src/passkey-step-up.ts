/**
 * Passkey confirmation for sensitive actions (security audit 2026-11-24, residual XSS risk). When an API request is
 * answered with 403 STEP_UP_REQUIRED, the session fetch wrapper calls `confirmStepUp(purpose)`: a small dialog asks the
 * person to confirm with their passkey (the click is the user gesture WebAuthn needs on every browser), the browser
 * asks for the fingerprint/face/PIN, the server verifies the signature and returns a single-use token, and the
 * request is retried with it. Without a passkey the dialog points to Settings > Security.
 */
export const STEP_UP_HEADER = "x-npati-step-up";

const toBytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const toB64url = (buffer: ArrayBuffer | ArrayBufferView | null | undefined) => {
  if (!buffer) return undefined;
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let text = ""; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Json = Record<string, unknown>;
type Descriptor = { id: string; type?: string; transports?: string[] };

/** Server options (base64url strings) to the browser API's binary form. Exported for tests. */
export function requestOptionsFromJson(options: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(options as object),
    challenge: toBytes(String(options.challenge)),
    allowCredentials: ((options.allowCredentials as Descriptor[] | undefined) ?? []).map((c) => ({ ...c, type: "public-key", id: toBytes(c.id) })) as PublicKeyCredentialDescriptor[],
  } as unknown as PublicKeyCredentialRequestOptions;
}

export function creationOptionsFromJson(options: Json): PublicKeyCredentialCreationOptions {
  const user = options.user as { id: string; name: string; displayName: string };
  return {
    ...(options as object),
    challenge: toBytes(String(options.challenge)),
    user: { ...user, id: toBytes(user.id) },
    excludeCredentials: ((options.excludeCredentials as Descriptor[] | undefined) ?? []).map((c) => ({ ...c, type: "public-key", id: toBytes(c.id) })) as PublicKeyCredentialDescriptor[],
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function credentialToJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  return {
    id: credential.id, rawId: toB64url(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      ...("attestationObject" in response ? { attestationObject: toB64url(response.attestationObject), transports: response.getTransports?.() ?? [] } : {}),
      ...("authenticatorData" in response ? { authenticatorData: toB64url(response.authenticatorData), signature: toB64url(response.signature), userHandle: toB64url(response.userHandle) } : {}),
    },
  };
}

async function postJson(fetcher: typeof fetch, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Json> {
  const response = await fetcher(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Json;
  if (!response.ok) {
    const error = (payload.error ?? {}) as { code?: string; message?: string; purpose?: string };
    throw Object.assign(new Error(error.message || `Request failed (${response.status})`), { code: error.code, purpose: error.purpose, status: response.status });
  }
  return payload;
}

/** Signs a step-up challenge for `purpose` and returns the single-use token. */
export async function signStepUp(purpose: string, fetcher: typeof fetch = fetch): Promise<string> {
  const options = await postJson(fetcher, "/api/auth/step-up/options", { purpose });
  const credential = await navigator.credentials.get({ publicKey: requestOptionsFromJson(options) }) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey confirmation was cancelled");
  const verified = await postJson(fetcher, "/api/auth/step-up/verify", { purpose, response: credentialToJson(credential) });
  return String(verified.stepUpToken);
}

/** Registers a new passkey. When the account already has one, the server first asks for its confirmation. */
export async function registerPasskey(name: string, fetcher: typeof fetch = fetch): Promise<void> {
  const options = await postJson(fetcher, "/api/auth/passkeys/registration/options", {});
  const credential = await navigator.credentials.create({ publicKey: creationOptionsFromJson(options) }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled");
  await postJson(fetcher, "/api/auth/passkeys/registration/verify", { name, response: credentialToJson(credential) });
}

const LABELS: Record<string, { en: string; uk: string }> = {
  "api_key.create": { en: "Create an API key", uk: "Створити API-ключ" },
  "remote_token.create": { en: "Create a remote access token", uk: "Створити токен віддаленого доступу" },
  "browser_credential.reveal": { en: "Show a saved password", uk: "Показати збережений пароль" },
  "webhook.reveal": { en: "Show a webhook URL with its secret", uk: "Показати URL вебхука із секретом" },
  "data_studio_keys.reveal": { en: "Show database API keys", uk: "Показати API-ключі бази даних" },
  "data_studio_keys.rotate": { en: "Rotate database API keys", uk: "Замінити API-ключі бази даних" },
  "passkey.register": { en: "Add another passkey", uk: "Додати ще один passkey" },
  "passkey.delete": { en: "Remove a passkey", uk: "Видалити passkey" },
};
const uk = () => { try { return (localStorage.getItem("npati_language") || document.documentElement.lang || "").startsWith("uk"); } catch { return false; } };

/**
 * Shows the confirmation dialog and resolves with a step-up token, or null when the person cancels or has no passkey.
 * One dialog at a time; concurrent requests for the same purpose share it.
 */
const pending = new Map<string, Promise<string | null>>();
export function confirmStepUp(purpose: string, code: "STEP_UP_REQUIRED" | "PASSKEY_REQUIRED", fetcher: typeof fetch = fetch): Promise<string | null> {
  const existing = pending.get(purpose);
  if (existing) return existing;
  const result = new Promise<string | null>((resolve) => {
    const isUk = uk();
    const label = LABELS[purpose]?.[isUk ? "uk" : "en"] ?? purpose;
    const dialog = document.createElement("dialog");
    dialog.className = "npati-step-up-dialog";
    const title = document.createElement("h2");
    title.textContent = isUk ? "Підтвердіть дію" : "Confirm this action";
    const text = document.createElement("p");
    text.textContent = code === "PASSKEY_REQUIRED"
      ? (isUk ? `«${label}» потребує підтвердження passkey. Додайте passkey у Налаштування → Безпека.` : `"${label}" needs a passkey confirmation. Add a passkey in Settings → Security.`)
      : (isUk ? `«${label}». Підтвердіть своїм passkey (відбиток, обличчя або PIN пристрою).` : `"${label}". Confirm with your passkey (fingerprint, face or device PIN).`);
    const error = document.createElement("p");
    error.className = "npati-step-up-error";
    error.hidden = true;
    const actions = document.createElement("div");
    actions.className = "npati-step-up-actions";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "button-secondary";
    cancel.textContent = isUk ? "Скасувати" : "Cancel";
    const primary = document.createElement(code === "PASSKEY_REQUIRED" ? "a" : "button") as HTMLButtonElement | HTMLAnchorElement;
    primary.className = "button-primary";
    primary.textContent = code === "PASSKEY_REQUIRED" ? (isUk ? "Відкрити налаштування безпеки" : "Open security settings") : (isUk ? "Підтвердити passkey" : "Confirm with passkey");
    actions.append(cancel, primary);
    dialog.append(title, text, error, actions);
    document.body.append(dialog);
    const finish = (value: string | null) => { dialog.close(); dialog.remove(); pending.delete(purpose); resolve(value); };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    if (code === "PASSKEY_REQUIRED") {
      (primary as HTMLAnchorElement).href = "/settings/security";
      primary.addEventListener("click", () => finish(null));
    } else {
      primary.addEventListener("click", () => {
        (primary as HTMLButtonElement).disabled = true; error.hidden = true;
        signStepUp(purpose, fetcher).then(finish).catch((cause: unknown) => {
          (primary as HTMLButtonElement).disabled = false;
          error.textContent = cause instanceof Error ? cause.message : String(cause);
          error.hidden = false;
        });
      });
    }
    dialog.showModal();
  });
  pending.set(purpose, result);
  return result;
}
