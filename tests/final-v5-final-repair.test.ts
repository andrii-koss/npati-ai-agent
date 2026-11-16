import { expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { finishCodeChatWebsite } from "../apps/agent-api/src/code-chat-website";
import { isChatProjectCreationBatch, runChatProjectCreation } from "../apps/agent-api/src/chat-project-creation";

const auth: AuthContext = { workspaceId: "final-repair", userId: "owner", permissions: ["workspace:read", "workspace:write"] };
it("supplies the required explicit status in the automation creation example given to fallback models", async () => {
  const { WorkspaceChatActions } = await import("../apps/agent-api/src/workspace-chat-actions");
  const prompt = await WorkspaceChatActions.buildSystemPrompt({ ...auth, permissions: [...auth.permissions, "business:manage"] }, new InMemoryWorkspaceStore(), "Create an automation");
  const examples = [...prompt.matchAll(/```workspace-action\s*\n([^`]+)\n```/gu)].map(match => JSON.parse(match[1]!));
  const create = examples.find(example => example.action === "automation.create");
  expect(create.automation.status).toBe("active");
});
it("never authorizes a creation batch from fallback guesses or a clarification decision", () => {
  const input = { source: "deterministic", targets: [{}, {}, {}], decision: {} };
  expect(isChatProjectCreationBatch(input as never)).toBe(false);
  expect(isChatProjectCreationBatch({ ...input, source: "semantic" } as never)).toBe(true);
  expect(isChatProjectCreationBatch({ ...input, source: "semantic", decision: { needsClarification: true } } as never)).toBe(false);
});
it("waits for every existing development process and reports a failed sibling honestly", async () => {
  const processes = [{ id: "one", projectId: "p1", status: "completed" }, { id: "two", projectId: "p2", status: "failed" }];
  const start = vi.fn(async () => ({ conversationId: "chat", processes }));
  const list = vi.fn(async () => processes);
  const stop = vi.fn();
  const progress = vi.fn(async () => undefined);
  const result = await runChatProjectCreation({ service: { start, list, stop } as never, ctx: auth, companyId: "c", message: "Create site and game", requestId: "batch", signal: new AbortController().signal, progress });
  expect(result).toMatchObject({ status: "failed", processes: [{ projectId: "p1" }, { projectId: "p2" }] });
  expect(start).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled(); expect(progress).toHaveBeenCalledOnce();
});
it("refuses an explicitly named missing Project before writing to the active sibling", async () => {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Repair Company" }, "company");
  const { project } = await store.createProject(auth, company.id, { name: "Active Shop", type: "code_project" }, "shop");
  const resolver = new ActiveContextResolver(store);
  const current = await resolver.resolve(auth, { contextType: "project", companyId: company.id, projectId: project.id });
  await expect(resolver.resolveNamedCompany(auth, current, 'In "Deleted Vite" add keyboard navigation.', { intent: "EDIT_WEBSITE" } as never))
    // V6 step 18: the refusal is now a question in the request language, asked in the chat.
    .rejects.toThrow(/could not find an active project named “Deleted Vite”/i);
  expect((await store.listProjects(auth, company.id)).map(p => p.id)).toEqual([project.id]);
  expect(await resolver.resolveNamedCompany(auth, current, 'Change the heading to "Welcome".', { intent: "EDIT_WEBSITE" } as never)).toBeUndefined();
  expect(await resolver.resolveNamedCompany(auth, current, 'In "Active Shop" add keyboard navigation.', { intent: "EDIT_WEBSITE" } as never)).toMatchObject({ project: { id: project.id } });
});

it.each(["Express", "FastAPI"])("starts %s Preview after a completed implementation without requiring a frontend build", async framework => {
  const startPreview = vi.fn(async () => ({ status: "running", previewUrl: "/proxy" }));
  const markFailed = vi.fn();
  const result = await finishCodeChatWebsite({ ctx: auth, session: { companyId: "c", projectId: "p", mode: "auto" }, runId: "r" } as never,
    { status: "completed", summary: { filesChanged: ["server.py"] } },
    { getProject: async () => ({ type: "code_project", framework } as never), startPreview, markFailed });
  expect(result).toMatchObject({ backendPreview: { status: "running" } });
  expect(startPreview).toHaveBeenCalledOnce();
  expect(markFailed).not.toHaveBeenCalled();
});
it("does not start a backend Preview after a failed or read-only run", async () => {
  const startPreview = vi.fn();
  const ports = { getProject: async () => ({ type: "code_project", framework: "FastAPI" } as never), startPreview, markFailed: vi.fn() };
  for (const status of ["failed", "completed"]) await finishCodeChatWebsite({ ctx: auth, readOnlyIntent: true, session: { mode: "auto" } } as never, { status }, ports);
  expect(startPreview).not.toHaveBeenCalled();
});
