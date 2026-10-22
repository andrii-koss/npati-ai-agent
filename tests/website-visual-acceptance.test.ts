import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { CodeSessionRunExecutor, type CodeSessionRunInput } from "../apps/agent-api/src/code-session-run-executor";
import { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import { analyzeWebsiteReference, reviewWebsiteReference, visualAcceptanceScreenshot, visualRepairFindings } from "../apps/agent-api/src/website-visual-acceptance";
import { withCodingReferenceImages } from "../apps/agent-api/src/coding-agent-runner-prompt";
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
describe("reference attachment point", () => {
  it("attaches the reference to the current (last) user message, never to the original creation prompt, and never twice", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "������ ���� �������� �������" },
      { role: "assistant" as const, content: "������" },
      { role: "user" as const, content: "���� ������ �����, ����� ����� �� �� ����" },
    ];
    const image = { mimeType: "image/png", dataBase64: png };
    const attached = withCodingReferenceImages(messages, [image]);
    expect(typeof attached[1]!.content).toBe("string");
    const current = attached[3]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(current[0]).toMatchObject({ type: "text" });
    expect(current.filter(part => part.type === "image_url")).toHaveLength(1);
    expect(current[1]!.image_url!.url).toContain("data:image/png;base64," + png);
    // A second pass must not duplicate the image parts.
    const again = withCodingReferenceImages(attached, [image]);
    expect((again[3]!.content as Array<{ type: string }>).filter(part => part.type === "image_url")).toHaveLength(1);
    // No user message: the call is a no-op rather than an exception.
    expect(withCodingReferenceImages([{ role: "system", content: "s" }], [image])).toHaveLength(1);
  });
});

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
  it("never opens the inbox lease for a repair and keeps the original visual mismatch when a repair cannot start", async () => {
    const f = await fixture(), run = vi.fn(async () => f.run);
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision",
      prepareReference: async () => ["observed reference"],
      afterRun: async (_input, result) => ({ ...result as any, status: "failed", reason: "visual_acceptance_failed", visualAcceptance: { status: "failed", differences: ["Hero is still light"] } }),
      settle: async () => undefined });
    // The repair call itself is refused before it can run (lease/cancellation), exactly like the live incident.
    run.mockImplementationOnce(async () => f.run);
    run.mockImplementation(() => { throw new Error("The session inbox could not acquire this run's lease."); });
    const result = await executor.execute(f.input);
    const calls = run.mock.calls as any[];
    expect(calls[0][0].useInbox).toBeUndefined();
    expect(calls[1][0].useInbox).toBe(false);
    expect(result.terminalStatus).toBe("failed");
    const view = result.result as any;
    expect(view.visualAcceptance.status).toBe("failed");
    expect(view.visualAcceptance.differences.join(" ")).toContain("Hero is still light");
    expect(view.visualAcceptance.differences.join(" ")).toContain("could not start");
  });

  it("uses at most two repairs with the same session/images, and settles honest failure once", async () => {
    // Each repair saves a change, so each one earns a new build + screenshot review.
    const f = await fixture(), run = vi.fn(async () => ({ ...f.run, summary: { ...f.run.summary, filesChanged: ["app/page.tsx"] } })), settle = vi.fn(async () => undefined);
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun: async (_input, result) => ({ ...result as any, status: "failed", reason: "visual_acceptance_failed", visualAcceptance: { status: "failed", differences: ["Wrong structure"] } }), settle });
    const result = await executor.execute(f.input);
    expect(run).toHaveBeenCalledTimes(3); expect(result.terminalStatus).toBe("failed"); expect(settle).toHaveBeenCalledOnce();
    for (const [input] of run.mock.calls as any) { expect(input.session).toBe(f.input.session); expect(input.images).toBe(f.input.images); }
    expect((result.result as any).visualRepairRunIds).toHaveLength(2);
  });
});

describe("one central visual check, repairs only with findings", () => {
  const failing = (differences: string[]) => async (_input: unknown, result: unknown) => ({ ...result as object, status: "failed", reason: "visual_acceptance_failed", visualAcceptance: { status: "failed", differences } });

  it("does not start a repair without concrete findings", async () => {
    const f = await fixture(), run = vi.fn(async () => f.run);
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun: failing([]), settle: async () => undefined });
    const result = await executor.execute(f.input);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.terminalStatus).toBe("failed");
    expect(visualRepairFindings({ status: "failed", differences: ["visual repair 1 made no changes", "ok"] })).toEqual([]);
    expect(visualRepairFindings({ status: "passed", differences: ["Header is light"] })).toEqual([]);
  });

  it("does not rebuild and re-screenshot after a repair that changed nothing", async () => {
    const f = await fixture(), run = vi.fn(async () => f.run);
    const afterRun = vi.fn(failing(["Header is light instead of dark"]));
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun, settle: async () => undefined });
    const result = await executor.execute(f.input);
    expect(run).toHaveBeenCalledTimes(2);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect((result.result as any).visualAcceptance.differences.join(" ")).toContain("visual repair 1 made no changes");
  });

  it("shows the repair the screenshot that failed, after the reference", async () => {
    const f = await fixture(), run = vi.fn(async () => ({ ...f.run, summary: { ...f.run.summary, filesChanged: ["app/page.tsx"] } }));
    const chat = vi.fn(async () => response(0.5, ["Header is light instead of dark"]));
    const afterRun = async (input: CodeSessionRunInput, result: unknown) => reviewWebsiteReference(input, result, { inspect: async () => f.qa, chat: chat as never });
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun, settle: async () => undefined });
    await executor.execute(f.input);
    const repair = (run.mock.calls as any)[1][0];
    expect(repair.images).toHaveLength(2);
    expect(repair.images[0]).toBe(f.input.images![0]);
    expect(repair.images[1]).toMatchObject({ dataBase64: png });
    expect(repair.prompt).toContain("LAST attached image is the current Preview screenshot");
    expect(repair.prompt).toContain("Header is light instead of dark");
    // The central review keeps judging against the reference only.
    for (const call of chat.mock.calls as any) expect(call[0].messages[1].content.filter((part: any) => part.type === "image_url")).toHaveLength(2);
    expect(visualAcceptanceScreenshot(await afterRun(f.input, f.run))).toMatchObject({ dataBase64: png });
  });
});

describe("differences are graded: only major ones fail and are repaired", () => {
  const graded = (score: number, differences: Array<{ severity: string; text: string } | string>) => ({ content: JSON.stringify({ scores: { layout: score, colors: score, typography: score, spacing: score, imagery: score }, differences }) });

  it("passes with minor differences only, reports them, and starts no repair", async () => {
    const f = await fixture(), run = vi.fn(async () => f.run);
    const chat = vi.fn(async () => graded(0.92, [{ severity: "minor", text: "Button is about 6 px wider" }, { severity: "minor", text: "Gradient stop slightly warmer" }]));
    const afterRun = async (input: CodeSessionRunInput, result: unknown) => reviewWebsiteReference(input, result, { inspect: async () => f.qa, chat: chat as never });
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun, settle: async () => undefined });
    const result = await executor.execute(f.input) as any;
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.result.visualAcceptance).toMatchObject({ status: "passed", differences: [], minorDifferences: ["Button is about 6 px wider", "Gradient stop slightly warmer"] });
    expect(result.result.message).toContain("Button is about 6 px wider");
  });

  it("fails on a major difference and repairs only the major findings", async () => {
    const f = await fixture(), run = vi.fn(async () => ({ ...f.run, summary: { ...f.run.summary, filesChanged: ["app/page.tsx"] } }));
    const chat = vi.fn(async () => graded(0.9, [{ severity: "major", text: "Menu cards section is missing" }, { severity: "minor", text: "Logo letter-spacing is wider" }]));
    const afterRun = async (input: CodeSessionRunInput, result: unknown) => reviewWebsiteReference(input, result, { inspect: async () => f.qa, chat: chat as never });
    const executor = new CodeSessionRunExecutor({ runner: { run }, control: new CodeRunCancellationRegistry(), resolveModel: async () => "connected/vision", prepareReference: async () => ["observed reference"], afterRun, settle: async () => undefined });
    await executor.execute(f.input);
    const repair = (run.mock.calls as any)[1][0];
    expect(repair.prompt).toContain("Menu cards section is missing");
    expect(repair.prompt).not.toContain("Logo letter-spacing");
  });

  it("a score below threshold still fails even when every difference is minor", async () => {
    const f = await fixture();
    const reviewed = await reviewWebsiteReference(f.input, f.run, { inspect: async () => f.qa, chat: async () => graded(0.7, [{ severity: "minor", text: "Shade slightly lighter" }]) as never }) as any;
    expect(reviewed.visualAcceptance.status).toBe("failed");
  });

  it("an ungraded (string) difference counts as major", async () => {
    const f = await fixture();
    const reviewed = await reviewWebsiteReference(f.input, f.run, { inspect: async () => f.qa, chat: async () => graded(0.95, ["Header is light instead of dark"]) as never }) as any;
    expect(reviewed.visualAcceptance).toMatchObject({ status: "failed", differences: ["Header is light instead of dark"] });
  });
});
