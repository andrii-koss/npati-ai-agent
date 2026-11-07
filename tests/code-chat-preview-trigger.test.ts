import { describe, expect, it } from "vitest";
import { isPreviewableChange } from "../apps/agent-api/src/code-chat-website";

describe("isPreviewableChange", () => {
  it("starts Preview for files a browser shows", () => {
    for (const file of ["index.html", "site/about.htm", "styles.css", "app.js", "src/main.tsx", "img/logo.svg"]) expect(isPreviewableChange(file), file).toBe(true);
  });
  it("does not start Preview for a text file, a manifest or installed modules", () => {
    for (const file of ["e2e-smoke/hello.txt", "package.json", "e2e-smoke/package-lock.json", "README.md", "node_modules/lodash/lodash.js"]) expect(isPreviewableChange(file), file).toBe(false);
  });
});

describe("Preview after a run in a plain HTML project", () => {
  it("starts Preview for a project Preview already marked static (follow-up edits and the warm start)", async () => {
    const { finishCodeChatWebsite } = await import("../apps/agent-api/src/code-chat-website");
    let started = 0;
    const input = { ctx: {}, session: { companyId: "c", projectId: "p", mode: "auto" }, toolContext: { userMessage: "Зміни заголовок" } } as never;
    const result = await finishCodeChatWebsite(input, { status: "completed", summary: { filesChanged: ["index.html"] } }, {
      getProject: async () => ({ id: "p", companyId: "c", type: "code_project", framework: "static" }) as never,
      startPreview: async () => { started += 1; return { status: "running", previewUrl: "/p" }; },
      markFailed: async () => undefined,
    });
    expect(started).toBe(1);
    expect((result as { websitePreview?: { status?: string } }).websitePreview?.status).toBe("running");
  });
});

describe("framework names Preview stored before", () => {
  it("treats a project marked vite as a Vite site that gets Preview and the browser check", async () => {
    const { finishCodeChatWebsite, isCodeChatWebsite } = await import("../apps/agent-api/src/code-chat-website");
    expect(isCodeChatWebsite({ type: "code_project", framework: "vite" } as never)).toBe(true);
    expect(isCodeChatWebsite({ type: "code_project", framework: "static" } as never)).toBe(true);
    let started = 0;
    const input = { ctx: {}, session: { companyId: "c", projectId: "p", mode: "auto" }, toolContext: { userMessage: "Додай куб" } } as never;
    const result = await finishCodeChatWebsite(input, { status: "completed", summary: { filesChanged: ["src/main.js"], verification: { status: "passed", requestedTools: ["build"] } } }, {
      getProject: async () => ({ id: "p", companyId: "c", type: "code_project", framework: "vite" }) as never,
      startPreview: async () => { started += 1; return { status: "running", previewUrl: "/p" }; },
      markFailed: async () => undefined,
    });
    expect(started).toBe(1);
    expect((result as { websitePreview?: { status?: string } }).websitePreview?.status).toBe("running");
  });
  it("does not ask a static site for a production build", async () => {
    const { finishCodeChatWebsite } = await import("../apps/agent-api/src/code-chat-website");
    let failed = 0;
    const input = { ctx: {}, session: { companyId: "c", projectId: "p", mode: "auto" }, toolContext: { userMessage: "Зміни заголовок" } } as never;
    await finishCodeChatWebsite(input, { status: "completed", summary: { filesChanged: ["index.html"] } }, {
      getProject: async () => ({ id: "p", companyId: "c", type: "code_project", framework: "static" }) as never,
      startPreview: async () => ({ status: "running", previewUrl: "/p" }),
      markFailed: async () => { failed += 1; },
    });
    expect(failed).toBe(0);
  });
});
