import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { ProjectBrowserQaService, BrowserQaError } from "../apps/agent-api/src/project-browser-qa-service";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { SandboxProviderError, type SandboxBrowserQaOptions, type SandboxBrowserQaResult, type SandboxProvider, type SandboxScope } from "../apps/agent-api/src/sandbox-provider";
import type { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";

const owner: AuthContext = { workspaceId: "qa-tenant", userId: "qa-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const stranger: AuthContext = { ...owner, userId: "other-user" };
const sandboxId = "33333333-3333-4333-8333-333333333333";
const result: SandboxBrowserQaResult = {
  statusCode: 200, loadTimeMs: 240, domContentLoadedMs: 110, resourceCount: 3, totalSizeBytes: 2400,
  consoleErrorCount: 1, brokenLinks: [{ href: "/secret-token-123456", status: 404 }],
  accessibility: [{ rule: "image-alt", impact: "critical", selector: "#secret-token-123456" }],
};

async function fixture() {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "QA Company" }, "qa-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Site", type: "website" }, "qa-project");
  await store.setProjectSandbox(owner, company.id, project.id, sandboxId, null);
  const inspect = vi.fn(async (_scope: SandboxScope, _sandboxId: string, _options: SandboxBrowserQaOptions): Promise<SandboxBrowserQaResult> =>
    structuredClone({ ...result, consoleMessages: ["SECRET_IN_CONSOLE"] }));
  const getStatus = vi.fn(async () => ({ id: sandboxId, state: "running" as const, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }));
  const provider = { inspectBrowser: inspect, getStatus } as unknown as SandboxProvider;
  const sandbox = new ProjectSandboxService(projects, store, {} as any, provider, {} as any);
  const preview = { getPreviewStatus: vi.fn(async () => ({ isRunning: true, port: 3000 })) } as unknown as ProjectPreviewService;
  const qa = new ProjectBrowserQaService(projects, store, preview, sandbox);
  return { store, company, project, qa, inspect, getStatus };
}

describe("project browser QA", () => {
  it("parses the isolated browser runner script", () => {
    const source = readFileSync(new URL("../apps/agent-api/browser-qa-runner.mjs", import.meta.url), "utf8");
    expect(() => transformSync(source, { loader: "js" })).not.toThrow();
  });
  it("scopes the runner and report to the authorized project", async () => {
    const f = await fixture();
    const report = await f.qa.inspect(owner, f.company.id, { projectId: f.project.id, path: "/about", timeoutMs: 90000 });
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.inspect.mock.calls[0]?.[0]).toMatchObject({ workspaceId: owner.workspaceId, userId: owner.userId, companyId: f.company.id, projectId: f.project.id });
    expect(f.inspect.mock.calls[0]?.[2]).toMatchObject({ port: 3000, path: "/about", timeoutMs: 60000 });
    expect(report.report.projectId).toBe(f.project.id);
    expect(report.issues.some(item => item.type === "console_error")).toBe(true);
    expect(report.issues.some(item => item.type === "broken_link")).toBe(true);
    expect(report.issues.some(item => item.type === "a11y")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-token-123456");
    expect(JSON.stringify(report)).not.toContain("SECRET_IN_CONSOLE");
    await expect(f.qa.getReport(stranger, f.company.id, f.project.id, report.report.id)).rejects.toThrow();
  });

  it("rejects cross-tenant access and unsafe paths before running browser", async () => {
    const f = await fixture();
    await expect(f.qa.inspect(stranger, f.company.id, { projectId: f.project.id })).rejects.toThrow();
    await expect(f.qa.inspect(owner, f.company.id, { projectId: f.project.id, path: "//metadata" })).rejects.toBeInstanceOf(BrowserQaError);
    await expect(f.qa.inspect(owner, f.company.id, { projectId: f.project.id, path: "/../../secret" })).rejects.toBeInstanceOf(BrowserQaError);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("does not persist a report after runner timeout", async () => {
    const f = await fixture();
    f.inspect.mockRejectedValueOnce(new SandboxProviderError("qa_timeout", "Browser QA timed out", 504));
    await expect(f.qa.inspect(owner, f.company.id, { projectId: f.project.id, timeoutMs: 1000 })).rejects.toMatchObject({ code: "qa_timeout" });
    expect(await f.qa.listReports(owner, f.company.id, f.project.id)).toEqual([]);
  });

  it("drops screenshots without a redaction attestation", async () => {
    const f = await fixture();
    const unsafe = { ...result, screenshot: { mimeType: "image/png" as const, base64Data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Buffer.from("SECRET")]).toString("base64"), sizeBytes: 14 } } as unknown as SandboxBrowserQaResult;
    f.inspect.mockResolvedValueOnce(unsafe);
    const report = await f.qa.inspect(owner, f.company.id, { projectId: f.project.id });
    expect(report.screenshots).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
});

it("refuses layout-only captures when actual visual pixels were requested", async () => {
  const f = await fixture();
  await expect(f.qa.inspect(owner, f.company.id, { projectId: f.project.id, screenshotMode: "visual" })).rejects.toMatchObject({ code: "visual_screenshot_unavailable" });
  expect(await f.qa.listReports(owner, f.company.id, f.project.id)).toEqual([]);
});
