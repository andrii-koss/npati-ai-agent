// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Security audit 2026-11-24: a 403 STEP_UP_REQUIRED is confirmed with a passkey and the request is retried once. */
const confirmStepUp = vi.fn<(purpose: string, code: string) => Promise<string | null>>();
vi.mock("./passkey-step-up", async (load) => ({ ...(await load<typeof import("./passkey-step-up")>()), confirmStepUp: (purpose: string, code: string) => confirmStepUp(purpose, code) }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("passkey step-up in the session fetch wrapper", () => {
  beforeEach(() => { confirmStepUp.mockReset(); vi.resetModules(); });

  async function wrapped(responses: Response[]) {
    const calls: Headers[] = [];
    const target = { fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { calls.push(new Headers(init?.headers)); return responses.shift()!; }), location: { origin: "https://app.example.com" } } as unknown as typeof globalThis;
    const { installSessionFetch } = await import("./session-fetch");
    installSessionFetch(target);
    return { target, calls };
  }

  it("retries with the single-use token after the confirmation", async () => {
    confirmStepUp.mockResolvedValue("step-up-token");
    const { target, calls } = await wrapped([json(403, { error: { code: "STEP_UP_REQUIRED", purpose: "api_key.create" } }), json(200, { key: "npati_live_x" })]);
    const response = await target.fetch("/api/companies/c/api-keys", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(confirmStepUp).toHaveBeenCalledWith("api_key.create", "STEP_UP_REQUIRED");
    expect(calls[0]!.get("x-npati-step-up")).toBeNull();
    expect(calls[1]!.get("x-npati-step-up")).toBe("step-up-token");
  });

  it("returns the refusal unchanged when the person cancels", async () => {
    confirmStepUp.mockResolvedValue(null);
    const { target, calls } = await wrapped([json(403, { error: { code: "PASSKEY_REQUIRED", purpose: "webhook.reveal" } })]);
    const response = await target.fetch("/api/companies/c/webhooks/w/reveal", { method: "POST" });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("leaves other 403 answers alone", async () => {
    const { target } = await wrapped([json(403, { error: { code: "FORBIDDEN" } })]);
    expect((await target.fetch("/api/companies", { method: "POST" })).status).toBe(403);
    expect(confirmStepUp).not.toHaveBeenCalled();
  });
});

describe("WebAuthn option conversion", () => {
  it("decodes base64url challenges and credential ids", async () => {
    const { requestOptionsFromJson, creationOptionsFromJson } = await import("./passkey-step-up");
    const request = requestOptionsFromJson({ challenge: "AQID", allowCredentials: [{ id: "BAUG", type: "public-key" }], userVerification: "required" });
    expect([...new Uint8Array(request.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(request.allowCredentials![0]!.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    const creation = creationOptionsFromJson({ challenge: "AQID", user: { id: "BwgJ", name: "u", displayName: "u" }, rp: { id: "x", name: "x" }, pubKeyCredParams: [] });
    expect([...new Uint8Array(creation.user.id as ArrayBuffer)]).toEqual([7, 8, 9]);
  });
});
