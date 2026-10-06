import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { PROJECT_CARD_DATA_VERSION, type ProjectCardData } from "@npati/shared";
import {
  CODE_ACTIVE_CONTEXT_VERSION,
  clearCodeActiveContext,
  readCodeActiveContext,
  writeCodeActiveContext,
} from "../apps/agent-api/src/code-active-context-store";
import { saveChatProjectCard, getChatMessagesWithProjectCards } from "../apps/agent-api/src/project-chat-cards";
import { resolveChatCodeIntent } from "../apps/agent-api/src/code-intent-routing";

/**
 * C7 chat integration: the code card in ordinary chat and the PERSISTED active project/session.
 *
 * The property that matters for chat is not that a card renders but that the pointer chat follows is the one
 * the user actually selected, is scoped to their company, and is re-validated before it is used — otherwise
 * "continue in the active project" silently starts work in a workspace the user never chose.
 */

const companyA = "company-a";
const companyB = "company-b";

function context(userId: string, workspaceId: string): AuthContext {
  return { userId, workspaceId, companyId: null } as unknown as AuthContext;
}

const userA = context("user-a", "ws-a");
const userB = context("user-b", "ws-b");

describe("coding-agent-c7-chat-integration [security-gate]", () => {
  it("persists the active context and reads it back for the same user", async () => {
    const store = new InMemoryWorkspaceStore();
    const written = await writeCodeActiveContext(store, userA, companyA, {
      contextType: "project",
      projectId: "project-1",
      sessionId: "session-1",
    });
    expect(written.schemaVersion).toBe(CODE_ACTIVE_CONTEXT_VERSION);

    const read = await readCodeActiveContext(store, userA, companyA);
    expect(read?.projectId).toBe("project-1");
    expect(read?.sessionId).toBe("session-1");
    expect(read?.contextType).toBe("project");
  });

  it("keeps the active context tenant-scoped: another user of another company sees nothing", async () => {
    const store = new InMemoryWorkspaceStore();
    await writeCodeActiveContext(store, userA, companyA, { contextType: "project", projectId: "project-1", sessionId: null });
    expect(await readCodeActiveContext(store, userB, companyA)).toBeNull();
    expect(await readCodeActiveContext(store, userA, companyB)).toBeNull();
  });

  it("does not guess at a payload whose schema version belongs to a future release", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.setUserSetting(userA, `code-active-context:${companyA}`, {
      schemaVersion: CODE_ACTIVE_CONTEXT_VERSION + 1,
      contextType: "project",
      projectId: "project-from-the-future",
      sessionId: null,
      updatedAt: new Date().toISOString(),
    }, 0);
    // Reading an unknown shape and acting on it would point chat at a workspace nobody selected.
    expect(await readCodeActiveContext(store, userA, companyA)).toBeNull();
  });

  it("clears the active context by writing an empty one, so the revision still advances", async () => {
    const store = new InMemoryWorkspaceStore();
    await writeCodeActiveContext(store, userA, companyA, { contextType: "project", projectId: "project-1", sessionId: "session-1" });
    const before = await store.getUserSetting(userA, `code-active-context:${companyA}`);
    await clearCodeActiveContext(store, userA, companyA);
    const after = await store.getUserSetting(userA, `code-active-context:${companyA}`);
    const read = await readCodeActiveContext(store, userA, companyA);
    expect(read?.projectId).toBeNull();
    expect(read?.sessionId).toBeNull();
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
  });

  it("refuses a stored payload that is not an object instead of throwing into the chat stream", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.setUserSetting(userA, `code-active-context:${companyA}`, "not-an-object", 0);
    expect(await readCodeActiveContext(store, userA, companyA)).toBeNull();
  });

  it("stores a versioned code card and reads it back attached to the right message", async () => {
    const store = new InMemoryWorkspaceStore();
    const card: ProjectCardData = {
      id: "session-1",
      projectId: "project-1",
      companyId: companyA,
      name: "Code project",
      status: "completed",
      cardVersion: PROJECT_CARD_DATA_VERSION,
      kind: "code_project",
      sessionId: "session-1",
      codeMode: "plan",
      changesCount: 2,
      runId: "run-1",
    };
    await saveChatProjectCard(store, userA, "conversation-1", "message-1", card);
    const messages = await getChatMessagesWithProjectCards(store, userA, "conversation-1", [
      { id: "message-1", role: "assistant", content: "done", createdAt: new Date().toISOString() } as never,
      { id: "message-2", role: "assistant", content: "other", createdAt: new Date().toISOString() } as never,
    ]);
    expect(messages[0].projectCard?.kind).toBe("code_project");
    expect(messages[0].projectCard?.sessionId).toBe("session-1");
    expect(messages[0].projectCard?.cardVersion).toBe(PROJECT_CARD_DATA_VERSION);
    expect(messages[1].projectCard).toBeUndefined();
  });

  it("does not leak another user's card into this user's conversation", async () => {
    const store = new InMemoryWorkspaceStore();
    await saveChatProjectCard(store, userA, "conversation-1", "message-1", {
      id: "session-1", companyId: companyA, name: "Code project", status: "completed", kind: "code_project",
    });
    const messages = await getChatMessagesWithProjectCards(store, userB, "conversation-1", [
      { id: "message-1", role: "assistant", content: "done", createdAt: new Date().toISOString() } as never,
    ]);
    expect(messages[0].projectCard).toBeUndefined();
  });

  it("routes a code request into the runner when an active project is known, and asks otherwise", () => {
    const base = { message: "add a test for the parser and run it", codingEnabled: true, companyId: companyA };
    // With the persisted context supplying a project, the same message runs instead of falling back to chat.
    const routed = resolveChatCodeIntent({ ...base, projectId: "project-1", projectKind: "code_project" });
    expect(routed.mode).toBe("run");
    expect(typeof (routed as { intent?: unknown }).intent).toBe("string");
    // Without any project the plan requirement is to ASK, never to answer as ordinary chat.
    expect(resolveChatCodeIntent({ ...base, projectId: null, projectKind: null }).mode).toBe("clarify");
  });

  it("leaves ordinary chat untouched when the coding flag is off, even with an active project stored", () => {
    expect(resolveChatCodeIntent({
      message: "add a test for the parser and run it",
      codingEnabled: false,
      companyId: companyA,
      projectId: "project-1",
      projectKind: "code_project",
    })).toEqual({ mode: "chat" });
  });

  it("never treats a website/mobile project as a code workspace", () => {
    expect(resolveChatCodeIntent({
      message: "add a test for the parser and run it",
      codingEnabled: true,
      companyId: companyA,
      projectId: "project-1",
      projectKind: "website",
    })).toEqual({ mode: "chat" });
  });
});
