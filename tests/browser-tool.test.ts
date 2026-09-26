import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserUseClient } from "../apps/agent-api/src/browser-tool";
import { RiskApprovalService } from "../packages/shared/src/risk-approval";

const context = { workspaceId: "workspace-a", userId: "user-a", permissions: ["business:manage"] } as any;
const company = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace-a", userId: "user-a", name: "Acme" } as any;

describe("BrowserUseClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("separates vault secrets from the LLM-visible browser input and records waiting_email", async () => {
    const registerEmailWait = vi.fn(async () => undefined);
    const credentials = {
      resolve: vi.fn(async () => ({ username: "agent@example.com", password: "never-log-this" })),
      registerEmailWait,
    } as any;
    let posted: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      posted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jobId: "job-1", status: "waiting_email", trace: [] }), { status: 200 });
    }));
    const client = new BrowserUseClient("http://worker:8765", "internal-token-with-sufficient-entropy", credentials);
    await client.execute(context, company, "browser.browser_clicktype", {
      operation: "register_account",
      url: "https://example.com/register",
      task: "Register using account.username and account.password",
      credentialRefs: [{ id: "credential-1", alias: "account" }],
      profileId: "seo-profile",
      waitForEmail: true,
      emailHint: "example.com",
      __npatiTaskRunId: "22222222-2222-4222-8222-222222222222",
    }, new AbortController().signal);

    expect(posted.input.credentialRefs).toBeUndefined();
    expect(JSON.stringify(posted.input)).not.toContain("never-log-this");
    expect(posted.secrets).toEqual({ "account.username": "agent@example.com", "account.password": "never-log-this" });
    expect(posted.tenant_scope).toMatch(/^[a-f0-9]{64}$/);
    expect(posted.profile_scope).toMatch(/^[a-f0-9]{64}$/);
    expect(registerEmailWait).toHaveBeenCalledWith(context, company.id, expect.objectContaining({ jobId: "job-1", profileId: "seo-profile" }));
  });

  it("derives different opaque scopes for different tenants", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jobId: crypto.randomUUID(), status: "completed", trace: [] }), { status: 200 });
    }));
    const client = new BrowserUseClient("http://worker:8765", "internal-token-with-sufficient-entropy");
    await client.execute(context, company, "browser.browser_tab_control", { operation: "navigate", url: "https://example.com" }, new AbortController().signal);
    await client.execute({ ...context, workspaceId: "workspace-b" }, { ...company, workspaceId: "workspace-b" }, "browser.browser_tab_control", { operation: "navigate", url: "https://example.com" }, new AbortController().signal);
    expect(bodies[0].tenant_scope).not.toBe(bodies[1].tenant_scope);
    expect(bodies[0].profile_scope).not.toBe(bodies[1].profile_scope);
    expect(JSON.stringify(bodies)).not.toContain("workspace-a");
  });

  it("blocks private destinations before calling the worker", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const client = new BrowserUseClient("http://worker:8765", "internal-token-with-sufficient-entropy");
    await expect(client.execute(context, company, "browser.browser_tab_control", { operation: "navigate", url: "http://127.0.0.1/admin" }, new AbortController().signal)).rejects.toThrow(/SSRF|private|internal/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects raw secrets in autonomous LLM input", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const client = new BrowserUseClient("http://worker:8765", "internal-token-with-sufficient-entropy");
    await expect(client.execute(context, company, "browser.browser_clicktype", {
      operation: "task", url: "https://example.com", task: "Log in", password: "raw-password",
    }, new AbortController().signal)).rejects.toThrow(/Raw credentials are forbidden/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("browser approval policy", () => {
  const policy = new RiskApprovalService("test-secret");
  it.each(["browser.browser_clicktype", "browser.browser_clicktype.register_account", "browser.browser_downloads", "browser.browser_tab_control.resume"])("requires approval for %s", (tool) => {
    expect(policy.requiresApproval(tool)).toBe(true);
  });
  it("keeps read-only extraction below approval level", () => {
    expect(policy.requiresApproval("browser.browser_tab_control.extract")).toBe(false);
  });
});
