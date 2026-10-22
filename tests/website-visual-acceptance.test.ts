import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { CodeSessionRunExecutor, type CodeSessionRunInput } from "../apps/agent-api/src/code-session-run-executor";
import { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import { analyzeWebsiteReference, reviewWebsiteReference } from "../apps/agent-api/src/website-visual-acceptance";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAElFTkSuQmCC";
async function fixture() {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const ctx = { workspaceId: "visual", userId: "owner", permissions: ["admin:all"] };
  const company = await store.createCompany(ctx, { name: "Visual" }, "visual");
  const { project } = await store.createProject(ctx, company.id, { name: "Shop", type: "code_project" }, "shop");
  const session = await store.createCodeSession(ctx, company.id, project.id, { mode: "auto" });
  const events: unknown[] = [];
  const input: CodeSessionRunInput = { ctx, session, runId: "root", prompt: "зміни дизайн сайта як на фото", websiteEdit: true, referenceImageRequired: true, resolvedModel: "connected/vision", images: [{ mimeType: "image/png", dataBase64: png }], cancelRequested: () => false, onActivity: async event => { events.push(event); } };
  const qa = { success: true, report: { id: "actual-report" }, screenshots: [{ base64Data: png, captureMode: "visual" }] } as never;
  const run = { status: "completed", runId: "root", websitePreview: { status: "running" }, summary: { verification: { status: "passed", requestedTools: ["build"] } } };
  return { input, events, qa, run };
}
const response = (score: number, differences: string[]) => ({ content: JSON.stringify({ scores: { layout: score, colors: score, typography: score, spacing: score, imagery: score }, differences }) });
describe("pixel-evidence visual acceptance", () => {
  it("sends both actual images, requires a saved screenshot report and records hashes rather than bytes", async () => {
    const f = await fixture(), chat = vi.fn(async () => response(0.95, []));
    const r = await reviewWebsiteReference(f.input, f.run, { inspect: async () => f.qa, chat }) as any;
    expect(r.status).toBe("completed"); expect(r.visualAcceptance.evidence.reportId).toBe("actual-report");
    const sent = chat.mock.calls[0] as any;
    expect(sent[0].messages[1].content.filter((part: any) => part.type === "image_url")).toHaveLength(2);
    expect(JSON.stringify(f.events)).not.toContain(png);
    expect(r.acceptance).toMatchObject({ buildPassed: true, browserQaPassed: true, visualReferenceMatched: true, requirementsVerified: "visual_scope_only" });
  });
  it("does not equate a green build and running Preview with visual correspondence", async () => {
    const f = await fixture(); const r = await reviewWebsiteReference(f.input, f.run, { inspect: async () => f.qa, chat: async () => response(0.2, ["The screenshot still has the old two-column layout"]) }) as any;
    expect(r.status).toBe("failed"); expect(r.reason).toBe("visual_acceptance_failed");
    expect(r.acceptance).toMatchObject({ buildPassed: true, previewRunning: true, visualReferenceMatched: false });
  });
  it("fails closed without screenshot bytes or with a malformed vision response", async () => {
    const f = await fixture(); const chat = vi.fn(async () => ({ content: "Looks good" }));
    expect((await reviewWebsiteReference(f.input, f.run, { inspect: async () => ({ ...f.qa as any, screenshots: [] }), chat }) as any).visualAcceptance.status).toBe("blocked");
    expect(chat).not.toHaveBeenCalled();
    expect((await reviewWebsiteReference(f.input, f.run, { inspect: async () => ({ ...f.qa as any, screenshots: [{ base64Data: png, captureMode: "layout" }] }), chat }) as any).visualAcceptance.status).toBe("blocked");
    expect(chat).not.toHaveBeenCalled();
    expect((await reviewWebsiteReference(f.input, f.run, { inspect: async () => f.qa, chat }) as any).visualAcceptance.status).toBe("blocked");
  });
  it("runs real image-bearing analysis before implementation and refuses missing vision", async () => {
    const f = await fixture(), keys = ["layout", "colors", "typography", "spacing", "imagery", "components", "plan"];
    const chat = vi.fn(async () => ({ content: JSON.stringify(Object.fromEntries(keys.map(key => [key, ["observed " + key]]))) }));
    expect((await analyzeWebsiteReference(f.input, chat))[0]).toContain("observed layout");
    await expect(analyzeWebsiteReference({ ...f.input, resolvedModel: undefined }, chat)).rejects.toThrow("vision_model_unavailable");
    const run = vi.fn(async () => f.run);
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => undefined });
    expect((await executor.execute(f.input)).terminalStatus).toBe("failed"); expect(run).not.toHaveBeenCalled();
    expect((await executor.execute({ ...f.input, images: [] })).reason).toBe("reference_image_missing");
  });
  it("uses at most two repairs with the same session/images, and settles honest failure once", async () => {
    const f = await fixture(), run = vi.fn(async () => f.run), settle = vi.fn(async () => undefined);
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun: async (_input, result) => ({ ...result as any, status: "failed", reason: "visual_acceptance_failed", visualAcceptance: { status: "failed", differences: ["Wrong structure"] } }), settle });
    const result = await executor.execute(f.input);
    expect(run).toHaveBeenCalledTimes(3); expect(result.terminalStatus).toBe("failed"); expect(settle).toHaveBeenCalledOnce();
    for (const [input] of run.mock.calls as any) { expect(input.session).toBe(f.input.session); expect(input.images).toBe(f.input.images); }
    expect((result.result as any).visualRepairRunIds).toHaveLength(2);
  });
});
