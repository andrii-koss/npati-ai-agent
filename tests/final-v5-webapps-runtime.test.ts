import { describe, expect, it, vi } from "vitest";
import { canonicalAssistExecutors, type CodeAssistToolOptions } from "../apps/agent-api/src/code-tool-executors-assist";
import { canReusePreviewSession } from "../apps/agent-api/src/project-preview-reuse";
import { contextualToolMatches, WEBSITE_EDIT_TOOL_PATTERN } from "../apps/agent-api/src/code-tool-visibility";
import { isReviewSafeTool, permissionForTool, subFlagForTool } from "../apps/agent-api/src/code-policy-tools";
import { CODE_TOOL_SCHEMAS, schemasForToolManifest, resolveManifestForSession } from "../apps/agent-api/src/code-tool-registry";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { verifyWebsiteRuntime } from "../apps/agent-api/src/website-runtime-acceptance";
import type { CodeSessionRunInput } from "../apps/agent-api/src/code-session-run-executor";
import type { BrowserQaReportResult } from "../apps/agent-api/src/project-browser-qa-service";

const execution = (tool: string) => ({ ctx: { userId: "u", workspaceId: "w", permissions: ["workspace:write"] }, companyId: "c", projectId: "p", tool: CODE_TOOL_SCHEMAS.find(t => t.name === tool), args: {}, toolCallId: "call" }) as CodeToolExecutionContext;
describe("Stage 06 Preview runtime regressions", () => {
  const input = { session: { mode: "auto" } } as CodeSessionRunInput;
  const completed = { status: "completed", websitePreview: { status: "running" } };
  const qa = (success: boolean) => ({ success, report: { id: "persisted-report" }, consoleErrors: success ? [] : [{ type: "runtime", message: "Hydration failed" }], brokenLinks: [] }) as unknown as BrowserQaReportResult;
  it("fails a built preview with real hydration diagnostics and preserves the report", async () => {
    expect(await verifyWebsiteRuntime(input, completed, async () => qa(false))).toMatchObject({ status: "failed", reason: "website_preview_qa_failed", functionalAcceptance: { status: "failed", reportId: "persisted-report" } });
    expect(await verifyWebsiteRuntime(input, completed, async () => qa(true))).toMatchObject({ status: "completed", functionalAcceptance: { status: "passed" } });
  });
  it("warns when browser verification is unavailable and does not run QA for read-only or unchanged previews", async () => {
    expect(await verifyWebsiteRuntime(input, completed, async () => { throw Error("runner unavailable"); })).toMatchObject({ status: "completed", functionalAcceptance: { status: "blocked" } });
    const inspect = vi.fn(async () => qa(true));
    await verifyWebsiteRuntime({ ...input, readOnlyIntent: true }, completed, inspect);
    await verifyWebsiteRuntime(input, { status: "completed" }, inspect);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("exposes a scoped restart action and preserves old manifests", async () => {
    const restart = vi.fn(async () => ({ status: "running", port: 3010, framework: "HTML/CSS" }));
    const executors = canonicalAssistExecutors({ previewRestart: restart } as CodeAssistToolOptions);
    expect(executors["code.preview.restart"]).toBeTypeOf("function");
    await executors["code.preview.restart"]!(execution("code.preview.restart"));
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c", projectId: "p" }));
    expect(canonicalAssistExecutors()["code.preview.restart"]).toBeUndefined();
    for (let version = 1; version <= 16; version++) expect(schemasForToolManifest(version).some(t => t.name === "code.preview.restart")).toBe(false);
    expect(resolveManifestForSession(16).checksum).toBe("b2ad2fec28a1e79f67cc5cf5af03a25f3e01d524bfab334cd18b6edb972528ee"); // v19-v22 added rename_field and row/role/value-rule tools; the earlier data tools gained optional fields in place (additive only).
  });
  it("never reuses a static or development process on an explicit restart", () => {
    expect(canReusePreviewSession({ framework: "static", forceRestart: true } as Parameters<typeof canReusePreviewSession>[0])).toBe(false);
    expect(canReusePreviewSession({ framework: "next", verifiedBuild: false, forceRestart: true } as Parameters<typeof canReusePreviewSession>[0])).toBe(false);
    expect(canReusePreviewSession({ framework: "static" })).toBe(true);
  });
  it("offers restart for Preview requests with write permission and shell flag, never as a review-safe read", () => {
    expect(WEBSITE_EDIT_TOOL_PATTERN.test("code.preview.restart")).toBe(true);
    expect(contextualToolMatches({ userMessage: "Перезапусти Live Preview", sessionMode: "auto", websiteEdit: true }).has("code.preview.restart")).toBe(true);
    expect(permissionForTool("code.preview.restart")).toBe("workspace:write");
    expect(subFlagForTool("code.preview.restart")).toBe("code.shell");
    expect(isReviewSafeTool("code.preview.restart")).toBe(false);
  });
  it("returns the real persisted Browser QA report ID with its diagnostics", async () => {
    const executors = canonicalAssistExecutors({ previewScreenshot: async () => ({ mimeType: "image/png", base64Data: Buffer.from([137,80,78,71,13,10,26,10]).toString("base64"), sizeBytes: 8, reportId: "qa-real", qaSummary: { status: "warning", brokenLinksCount: 2, a11yViolationsCount: 0, warningCount: 2, errorCount: 0 }, functionalQaPassed: true, consoleDiagnostics: [] }) });
    expect(await executors["code.preview.screenshot"]!(execution("code.preview.screenshot"))).toMatchObject({ reportId: "qa-real", functionalQaPassed: true, qaSummary: { status: "warning", brokenLinksCount: 2, warningCount: 2 } });
  });
});

// V6 step 07 (D07-03): a game whose engine comes from a CDN never ran in the check, which said "passed" over a page
// that showed only "could not load Phaser". Such a page is now "not verified", and the user is told so in their language.
it("does not call a page passed when its own script was never loaded", async () => {
  const { NOT_CHECKED_SCRIPT } = await import("../apps/agent-api/src/project-browser-qa-service");
  const input = { session: { mode: "auto" }, prompt: "зроби гру на Phaser" } as CodeSessionRunInput;
  const report = { success: true, report: { id: "r", status: "passed" }, consoleErrors: [], brokenLinks: [],
    issues: [{ type: "console_error", severity: "warning", message: NOT_CHECKED_SCRIPT + "cdn.jsdelivr.net" }] } as unknown as BrowserQaReportResult;
  const out = await verifyWebsiteRuntime(input, { status: "completed", websitePreview: { status: "running" }, message: "Гру створено." }, async () => report) as { status: string; message: string; functionalAcceptance: { status: string; blockedScripts: string[] } };
  expect(out.status).toBe("completed");
  expect(out.functionalAcceptance).toMatchObject({ status: "not_verified", blockedScripts: ["cdn.jsdelivr.net"] });
  expect(out.message).toMatch(/^Гру створено\.\n\n⚠️ Не перевірено повністю: сторінка завантажує скрипт з cdn\.jsdelivr\.net/);
});
