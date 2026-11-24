import { afterEach, describe, expect, it } from "vitest";
import { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";
import { previewHostAllowed } from "../apps/agent-api/src/project-preview-cookies";

/**
 * Security audit 2026-11-24.
 * H1: a Preview runs project JavaScript; on the app's origin it could read the session tokens in localStorage.
 * M3: an expired preview token used to be renewed whenever its signature was valid, so a leaked link never expired.
 */
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

function fakeReply() {
  const state: { status?: number; headers: Record<string, unknown>; body?: unknown } = { headers: {} };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    header(name: string, value: unknown) { state.headers[name.toLowerCase()] = value; return reply; },
    type(value: string) { state.headers["content-type"] = value; return reply; },
    send(body: unknown) { state.body = body; return reply; },
  };
  return { reply, state };
}
function service(secret = "0123456789abcdef0123456789abcdef") {
  const instance = Object.create(ProjectPreviewService.prototype) as ProjectPreviewService;
  Object.assign(instance, { secret, sessions: new Map() });
  return instance;
}
const params = { companyId: "company-1", projectId: "project-1", "*": "" };

describe("H1: preview proxy answers only on an isolated host", () => {
  it.each(["localhost:3000", "127.0.0.1:3001", "app.example.com", undefined])("refuses the app host %s", (host) => {
    delete process.env.NPATI_PREVIEW_ALLOW_APP_ORIGIN;
    expect(previewHostAllowed(host)).toBe(false);
  });

  it("accepts <project>.preview.<domain> and a configured NPATI_PREVIEW_ORIGIN", () => {
    expect(previewHostAllowed("project-1.preview.localhost:3000")).toBe(true);
    process.env.NPATI_PREVIEW_ORIGIN = "https://{project}-pv.example.com";
    expect(previewHostAllowed("project-1-pv.example.com")).toBe(true);
    expect(previewHostAllowed("example.com")).toBe(false);
  });

  it("the self-hosted opt-in is never honoured on an NPATI-hosted installation", () => {
    process.env.NPATI_PREVIEW_ALLOW_APP_ORIGIN = "true";
    process.env.NPATI_DEPLOYMENT_TYPE = "self_hosted";
    expect(previewHostAllowed("localhost:3000")).toBe(true);
    process.env.NPATI_DEPLOYMENT_TYPE = "npati_hosted";
    expect(previewHostAllowed("localhost:3000")).toBe(false);
  });

  it("a valid token on the app host gets 421 and no project content", async () => {
    delete process.env.NPATI_PREVIEW_ALLOW_APP_ORIGIN;
    const preview = service();
    const { token } = preview.generateToken({ workspaceId: "w", userId: "u", companyId: params.companyId, projectId: params.projectId, sandboxId: "s" });
    const { reply, state } = fakeReply();
    await preview.handleProxy({ params, query: { token }, headers: { host: "localhost:3000" }, url: "/x" } as never, reply as never);
    expect(state.status).toBe(421);
    expect(String(state.body)).toContain("Preview needs its own origin");
  });
});

describe("M3: expired preview tokens are refused, not renewed", () => {
  it("returns token_expired and sets no cookie", async () => {
    const preview = service();
    const { token } = preview.generateToken({ workspaceId: "w", userId: "u", companyId: params.companyId, projectId: params.projectId, sandboxId: "s" }, -1_000);
    const { reply, state } = fakeReply();
    await preview.handleProxy({ params, query: { token }, headers: { host: "project-1.preview.localhost:3000" }, url: "/x" } as never, reply as never);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ error: { code: "token_expired" } });
    expect(state.headers["set-cookie"]).toBeUndefined();
  });

  it("a tampered signature is refused", () => {
    const preview = service();
    const { token } = preview.generateToken({ workspaceId: "w", userId: "u", companyId: "c", projectId: "p", sandboxId: "s" });
    expect(() => preview.verifyToken(token.slice(0, -2) + "xx")).toThrow("signature");
  });
});
