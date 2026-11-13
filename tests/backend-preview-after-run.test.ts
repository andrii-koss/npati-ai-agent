import { expect, it } from "vitest";
import { finishCodeChatWebsite, hasCodeChatPreview } from "../apps/agent-api/src/code-chat-website";
import { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";

// V6 step 10: a chat-made FastAPI service. (1) Its post-run Preview starts with verifiedBuild: false, and the Python
// setup was skipped exactly then, so .venv never existed and uvicorn exited 127. (2) That failure was thrown out of the
// run and the whole answer became "Preview server did not become HTTP-ready".
it("keeps the agent's answer and adds the reason when a backend Preview does not start", async () => {
  const failed: string[] = [];
  const result = await finishCodeChatWebsite(
    { ctx: {}, session: { companyId: "c", projectId: "p" }, responseLanguage: "uk", toolContext: { userMessage: "сделай FastAPI" }, requireImplementation: true } as never,
    { status: "completed", message: "Створено FastAPI-сервіс із формою.", summary: { filesChanged: ["main.py"] } },
    {
      getProject: async () => ({ type: "code_project", framework: "FastAPI" }) as never,
      startPreview: async () => { throw new Error("Preview server did not become HTTP-ready"); },
      markFailed: async (_c, _co, id) => { failed.push(id); },
    } as never,
  ) as { status: string; message: string; backendPreview: { status: string } };
  expect(result.status).toBe("completed");
  expect(result.message.startsWith("Створено FastAPI-сервіс із формою.")).toBe(true);
  expect(result.message).toContain("Сервер не запустився в Preview: Preview server did not become HTTP-ready");
  expect(result.backendPreview.status).toBe("failed");
  expect(failed).toEqual(["p"]);
});

// The creation flow decides "ready" with hasCodeChatPreview: a running backend counts, a failed one does not.
it("counts a running backend Preview as a ready Preview", () => {
  expect(hasCodeChatPreview({ backendPreview: { status: "running" } })).toBe(true);
  expect(hasCodeChatPreview({ websitePreview: { status: "running" } })).toBe(true);
  expect(hasCodeChatPreview({ backendPreview: { status: "failed" } })).toBe(false);
  expect(hasCodeChatPreview({ status: "completed" })).toBe(false);
});

it("prepares the Python environment even when the Preview starts in development mode", async () => {
  const commands: string[] = [];
  const project = { id: "p", companyId: "c", framework: "FastAPI", status: "active", sandboxId: "sbx" };
  const sandbox = { exposePort: async () => ({ port: 8000 }), stopRecordedPreview: async () => undefined, supportsPreviewProxy: () => false,
    execute: async (_c: unknown, _co: string, input: { command: string }) => { commands.push(input.command); return { exitCode: input.command.startsWith("test -x") ? 1 : 0 }; },
    process: async () => ({ processId: "proc" }) };
  const files: Record<string, string> = { "main.py": "from fastapi import FastAPI\napp = FastAPI()\n", "requirements.txt": "fastapi\nuvicorn\n" };
  const workspace = { listFiles: async () => Object.keys(files).map(path => ({ path, type: "file" })), readFile: async (_c: unknown, _co: string, _p: string, path: string) => ({ content: files[path] ?? "" }) };
  const preview = new ProjectPreviewService({ get: async () => project, updatePreview: async () => project } as never, {} as never, workspace as never, sandbox as never, "test");
  await preview.startPreview({ workspaceId: "w", userId: "u", permissions: [] } as never, "c", "p", { verifiedBuild: false });
  expect(commands).toEqual(["test -x .venv/bin/python", "python3 -m venv .venv", ".venv/bin/python -m pip install -r requirements.txt"]);
});

// An existing venv still gets requirements.txt installed: a package added after it was made (httpx) killed the server.
it("installs requirements.txt into an existing venv too", async () => {
  const commands: string[] = [];
  const project = { id: "p", companyId: "c", framework: "FastAPI", status: "active", sandboxId: "sbx" };
  const sandbox = { exposePort: async () => ({ port: 8000 }), stopRecordedPreview: async () => undefined, supportsPreviewProxy: () => false,
    execute: async (_c: unknown, _co: string, input: { command: string }) => { commands.push(input.command); return { exitCode: 0 }; }, process: async () => ({ processId: "proc" }) };
  const files: Record<string, string> = { "main.py": "from fastapi import FastAPI\napp = FastAPI()\n", "requirements.txt": "fastapi\nuvicorn\nhttpx\n" };
  const workspace = { listFiles: async () => Object.keys(files).map(path => ({ path, type: "file" })), readFile: async (_c: unknown, _co: string, _p: string, path: string) => ({ content: files[path] ?? "" }) };
  const preview = new ProjectPreviewService({ get: async () => project, updatePreview: async () => project } as never, {} as never, workspace as never, sandbox as never, "test");
  await preview.startPreview({ workspaceId: "w", userId: "u", permissions: [] } as never, "c", "p", { verifiedBuild: false });
  expect(commands).toEqual(["test -x .venv/bin/python", ".venv/bin/python -m pip install -r requirements.txt"]);
});
