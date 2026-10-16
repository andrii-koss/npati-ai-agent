import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SharedProjectRuntimeProvider } from "../apps/agent-api/src/shared-project-runtime-provider";
import { assertBrowserQaOptions, parseBrowserQaResult, browserQaFailure } from "../apps/agent-api/src/sandbox-browser-qa";
import type { SandboxBrowserQaOptions, SandboxScope } from "../apps/agent-api/src/sandbox-provider";

const scope: SandboxScope = { workspaceId: "ws", userId: "owner", companyId: "company", projectId: "project" };
const options: SandboxBrowserQaOptions = { port: 3002, path: "/", viewport: { width: 375, height: 667 },
  timeoutMs: 30000, maxScreenshotBytes: 500000, maxBrokenLinks: 20, screenshot: false };
const result = { statusCode: 200, loadTimeMs: 10, domContentLoadedMs: 5, resourceCount: 1, totalSizeBytes: 100,
  consoleErrorCount: 0, brokenLinks: [], accessibility: [] };

function fixture() {
  // Exercise the actual provider method without invoking Linux namespaces on a Windows test host.
  const provider = Object.create(SharedProjectRuntimeProvider.prototype) as SharedProjectRuntimeProvider;
  const entry = vi.fn(async () => ({ port: 3002, scope }));
  const collect = vi.fn(async (..._args: unknown[]) => ({ status: "completed", exitCode: 0, stdout: JSON.stringify(result) }));
  Object.assign(provider, { entry, collect });
  return { provider, entry, collect };
}

describe("security-gate: shared Browser QA", () => {
  it("exposes only known browser failure stages, never private output", () => {
    expect(browserQaFailure('{"stage":"launch","detail":"PRIVATE_PAGE"}').message).toBe("Browser QA runner failed during launch");
    expect(browserQaFailure('{"stage":"PRIVATE_PAGE"}').message).toBe("Browser QA runner failed");
    expect(browserQaFailure("PRIVATE_PAGE").message).toBe("Browser QA runner failed");
  });

  it("runs the existing browser script through the project launcher and bounded collection", async () => {
    const f = fixture();
    expect(await f.provider.inspectBrowser(scope, "sandbox", options)).toEqual(result);
    expect(f.entry).toHaveBeenCalledWith(scope, "sandbox");
    const call = f.collect.mock.calls[0] as unknown as [unknown, string, string[], string, unknown];
    expect(call[1]).toBe("node");
    expect(call[2]).toEqual(["/opt/npati-qa/browser-qa-runner.mjs", "--shared-runtime"]);
    expect(JSON.parse(call[3])).toEqual({ ...options, host: "10.0.2.2" });
    expect(call[4]).toEqual({ timeoutMs: 35000, outputLimitBytes: 3000000 });
  });

  it("refuses another project's port before launching a browser", async () => {
    const f = fixture();
    await expect(f.provider.inspectBrowser(scope, "sandbox", { ...options, port: 3003 })).rejects.toMatchObject({ code: "project_port_denied" });
    expect(f.collect).not.toHaveBeenCalled();
  });

  it("keeps ownership refusal authoritative", async () => {
    const f = fixture();
    f.entry.mockRejectedValueOnce(Object.assign(new Error("foreign project"), { code: "scope_mismatch" }));
    await expect(f.provider.inspectBrowser(scope, "foreign", options)).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(f.collect).not.toHaveBeenCalled();
  });

  it.each([{ path: "//internal" }, { path: "/../secret" }, { timeoutMs: 60001 }, { viewport: { width: 1, height: 667 } },
    { maxScreenshotBytes: 3000000 }, { maxBrokenLinks: 100 }])("rejects unsafe or unbounded options: %j", invalid => {
    expect(() => assertBrowserQaOptions({ ...options, ...invalid })).toThrow();
  });

  it.each(["not json", "{}", JSON.stringify({ ...result, statusCode: 0 }), JSON.stringify({ ...result, loadTimeMs: -1 })])(
    "refuses malformed browser output without echoing it: %s", raw => {
      expect(() => parseBrowserQaResult(raw)).toThrow("Browser QA runner returned invalid output");
    });

  it("returns a bounded timeout without retaining raw browser output", async () => {
    const f = fixture();
    f.collect.mockResolvedValueOnce({ status: "timed_out", exitCode: 137, stdout: "PRIVATE_PAGE" });
    await expect(f.provider.inspectBrowser(scope, "sandbox", options)).rejects.toMatchObject({ code: "qa_timeout" });
  });

  it("uses the private namespace temp directory to avoid Chromium Unix socket path overflow", () => {
    const source = readFileSync(new URL("../apps/agent-api/browser-qa-runner.mjs", import.meta.url), "utf8");
    expect(source).toContain('if (shared) process.env.TMPDIR = "/tmp";');
    expect(source).toContain('shared ? ["--no-proxy-server"] : []');
  });

  it("ships a read-only browser toolchain through the same namespace boundary", () => {
    const docker = readFileSync(new URL("../apps/agent-api/Dockerfile", import.meta.url), "utf8");
    const launcher = readFileSync(new URL("../apps/agent-api/project-runtime-launcher.mjs", import.meta.url), "utf8");
    const server = readFileSync(new URL("../apps/agent-api/src/shared-project-runtime-server.ts", import.meta.url), "utf8");
    expect(docker).toContain("playwright@1.63.0");
    expect(launcher).toContain("'/opt/npati-qa'");
    expect(launcher).toContain("['--ro-bind', p, p]");
    expect(server).toContain('case "inspectBrowser": result = await provider.inspectBrowser(scope, id,');
  });
});
